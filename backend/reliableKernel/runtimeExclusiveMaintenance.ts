import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import type { RuntimeRootPaths } from './contracts';
import {
  createCachedProcessClassifier, delay, ownProcessStartIdentity, type RecordedProcessClassifier
} from './runtimeClaimPrimitives';
import {
  assertRuntimeHostsOffline, isRuntimeDataRootAdmissionHeld, isRuntimeMaintenanceHeld, listActiveRuntimeHosts,
  type RuntimeHostActiveDescriptor
} from './runtimeHostControl';

/**
 * Cooperative exclusivity for offline maintenance on one Runtime root while other windows use it
 * (a data-root migration the user started, an oversized historical merge, a future offline GC).
 *
 * Two-phase, so no window yields unless all of them can:
 *   prepare — every participating Host answers ready / busy / declined, nobody acts yet;
 *   confirm — only when all are ready: each shows its countdown or notice, then answers confirmed;
 *   go      — only when all confirmed: each yields (reloads) and its next startup waits on the
 *             requester's configuration admission until the maintenance ends.
 * Any busy (unless the requester chose to wait), declined, unknown/legacy Host, timeout or cancel
 * withdraws the request before anybody yields. Abandoned attempts back off per operation key and a
 * coordinated round starts a cooldown per operation, so windows can never keep reloading each other.
 * The request is advisory: exclusivity is still proven by the Host liveness records alone.
 */
export const RUNTIME_EXCLUSIVE_MAINTENANCE_DIRECTORY = 'exclusive-maintenance';

const REQUEST_FILE = 'request.json';
const PARTICIPANTS_DIRECTORY = 'hosts';
const RESPONSES_DIRECTORY = 'responses';
const LEDGER_DIRECTORY = 'ledger';
const REQUEST_KIND = 'limcode-runtime-exclusive-maintenance-request';
const RESPONSE_KIND = 'limcode-runtime-exclusive-maintenance-response';
const PARTICIPANT_KIND = 'limcode-runtime-exclusive-maintenance-participant';
const LEDGER_KIND = 'limcode-runtime-exclusive-maintenance-ledger';
const RETRYABLE_REMOVE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** A Host registers as a participant right after its Runtime opened; until then it is not taken for an old version. */
const PARTICIPANT_REGISTRATION_GRACE_MS = 15_000;

export const EXCLUSIVE_MAINTENANCE_DEFAULTS = Object.freeze({
  pollMs: 250,
  participantPollMs: 1_000,
  /** Every participant answers within a few of its polls. */
  prepareTimeoutMs: 8_000,
  /** Only with whenBusy 'wait': how long running work in other windows may delay the operation. */
  busyWaitTimeoutMs: 10 * 60_000,
  /** Countdown (5 s) plus participant poll latency. */
  confirmTimeoutMs: 20_000,
  /** A window reload closes its Runtime and Host liveness record. */
  releaseTimeoutMs: 30_000,
  backoffBaseMs: 5 * 60_000,
  backoffMaxMs: 6 * 60 * 60_000,
  cooldownAfterCoordinatedMs: 10 * 60_000
});

export type ExclusiveMaintenancePhase = 'prepare' | 'confirm' | 'go';
/** countdown: 5 s cancellable countdown in each other window; notice: announce only (user already confirmed). */
export type ExclusiveMaintenanceConfirmation = 'countdown' | 'notice';
/** abandon: any busy window withdraws the request; wait: wait (bounded) until busy windows are idle. */
export type ExclusiveMaintenanceBusyPolicy = 'abandon' | 'wait';

export interface RuntimeExclusiveMaintenanceRequest {
  kind: typeof REQUEST_KIND;
  requestId: string;
  /** A wait-mode request goes back to prepare in a new round when a window became busy again. */
  round: number;
  phase: ExclusiveMaintenancePhase;
  /** Stable operation name, e.g. data-root-migration, historical-merge. */
  operation: string;
  /** Identity of this particular work, e.g. the set of sources; backoff is keyed by it. */
  operationKey: string;
  /** Short user-facing reason shown by the other windows. */
  message: string;
  confirmation: ExclusiveMaintenanceConfirmation;
  whenBusy: ExclusiveMaintenanceBusyPolicy;
  requesterProcessId: number;
  requesterProcessStartIdentity?: string;
  /** Present when the requester's own window stays registered on this root while it requests. */
  requesterHostBootId?: string;
  createdAt: string;
  expiresAt: string;
}

export type ExclusiveMaintenanceAnswer = 'ready' | 'busy' | 'declined' | 'confirmed';

export interface RuntimeExclusiveMaintenanceResponse {
  kind: typeof RESPONSE_KIND;
  requestId: string;
  round: number;
  hostBootId: string;
  stage: ExclusiveMaintenancePhase;
  answer: ExclusiveMaintenanceAnswer;
  reason?: string;
  respondedAt: string;
}

export interface ExclusiveMaintenanceProgress {
  stage: 'prepare' | 'waiting-busy' | 'confirm' | 'release';
  hosts: readonly RuntimeHostActiveDescriptor[];
  busy: readonly { hostBootId: string; reason?: string }[];
}

export interface RuntimeExclusiveMaintenanceInput {
  operation: string;
  /** Defaults to `operation`; pass the identity of the work so a different work is not delayed. */
  operationKey?: string;
  message: string;
  /** The requester's own registered Host when it stays open while requesting (e.g. a migration). */
  requesterHostBootId?: string;
  /** When given, the configuration admission of this root must be held as well. */
  configurationRootPath?: string;
  participantConfirmation?: ExclusiveMaintenanceConfirmation;
  whenBusy?: ExclusiveMaintenanceBusyPolicy;
  /**
   * Required on every call, never inferred from stored state: true only for the one call made for
   * an explicit user action. It skips the per-key backoff, never the per-operation cooldown or a
   * blocked key.
   */
  ignoreBackoff: boolean;
  /** A failure of the operation that will fail the same way again: the key is blocked for good. */
  isDeterministicFailure?(error: unknown): boolean;
  pollMs?: number;
  prepareTimeoutMs?: number;
  busyWaitTimeoutMs?: number;
  confirmTimeoutMs?: number;
  releaseTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  cooldownAfterCoordinatedMs?: number;
  isCancelled?(): boolean;
  /** Called once when the request is published (other windows are involved). */
  onWaitStart?(hosts: readonly RuntimeHostActiveDescriptor[]): void;
  onProgress?(progress: ExclusiveMaintenanceProgress): void;
  /** Called once when coordination ends, before the operation runs or after it was abandoned. */
  onWaitEnd?(): void;
  /** Monotonic clock in milliseconds; defaults to performance.now(). */
  now?(): number;
}

export type RuntimeExclusiveMaintenanceAbandonState =
  'busy' | 'declined' | 'legacy-host' | 'timed-out' | 'cancelled' | 'backoff' | 'blocked';

export type RuntimeExclusiveMaintenanceOutcome<T> =
  | { state: 'completed'; result: T; coordinated: boolean }
  | {
    state: RuntimeExclusiveMaintenanceAbandonState;
    hosts: RuntimeHostActiveDescriptor[];
    /** User-facing reason in Chinese. */
    reason: string;
    /** For backoff: when an automatic retry is allowed again. */
    retryAfter?: string;
  };

export function runtimeExclusiveMaintenanceDirectory(paths: RuntimeRootPaths): string {
  return path.join(path.dirname(path.resolve(paths.dataRootPath)), RUNTIME_EXCLUSIVE_MAINTENANCE_DIRECTORY);
}

/**
 * Call inside the root's maintenance claim (and configuration admission when configurationRootPath
 * is given), so no Host can register meanwhile. Runs `operation` at once when no other Host is
 * registered. Otherwise coordinates the two phases and runs `operation` only after every other Host
 * is proven offline; the caller's own window (requesterHostBootId) must close its Runtime inside
 * `operation` when the operation needs the root offline, and reload afterwards when required.
 */
export async function requestExclusiveRuntimeMaintenance<T>(
  paths: RuntimeRootPaths,
  input: RuntimeExclusiveMaintenanceInput,
  operation: () => Promise<T>
): Promise<RuntimeExclusiveMaintenanceOutcome<T>> {
  if (!isRuntimeMaintenanceHeld(paths)) {
    throw new Error('独占维护必须在目标数据集的 maintenance 锁内发起。');
  }
  if (input.configurationRootPath !== undefined && !isRuntimeDataRootAdmissionHeld(input.configurationRootPath)) {
    throw new Error('独占维护必须在配置根的 admission 内发起。');
  }
  if (typeof input.ignoreBackoff !== 'boolean') {
    throw new TypeError('ignoreBackoff must be passed explicitly on every call.');
  }
  const operationName = requireText(input.operation, 'operation');
  const operationKey = requireText(input.operationKey ?? input.operation, 'operationKey');
  const message = requireText(input.message, 'message');
  const now = input.now ?? (() => performance.now());
  const pollMs = input.pollMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.pollMs;
  const whenBusy = input.whenBusy ?? 'abandon';
  const except = input.requesterHostBootId;
  const classify = createCachedProcessClassifier();
  const hostsNow = () => listActiveRuntimeHosts(paths, { exceptHostBootId: except, classify });
  // The final decision never trusts the poll cache.
  const runExclusive = async (coordinated: boolean): Promise<T> => {
    await assertRuntimeHostsOffline(paths, except);
    try {
      const result = await operation();
      await clearKeyBackoff(paths, operationName, operationKey);
      return result;
    } catch (error) {
      const reason = `上次${coordinated ? '其它窗口让出后' : ''}操作失败：${describeError(error)}`;
      if (input.isDeterministicFailure?.(error)) {
        await recordKeyBlocked(paths, operationName, operationKey, reason);
      } else if (coordinated) {
        // Other windows reloaded for nothing: the same work backs off like an abandoned attempt.
        await recordKeyBackoff(paths, operationName, operationKey, reason, input);
      }
      throw error;
    }
  };

  const blocked = await readKeyBlock(paths, operationName, operationKey);
  if (blocked) return { state: 'blocked', hosts: [], reason: blocked };
  let hosts = await hostsNow();
  if (hosts.length === 0) return { state: 'completed', result: await runExclusive(false), coordinated: false };
  const backoff = await readActiveBackoff(paths, operationName, operationKey, input);
  if (backoff) return { state: 'backoff', hosts, reason: backoff.reason, retryAfter: backoff.until };
  const outsiders = await hostsOutsideProtocol(paths, hosts);
  if (outsiders.length > 0) {
    const reason = outsideProtocolReason(outsiders);
    await recordKeyBackoff(paths, operationName, operationKey, reason, input);
    return { state: 'legacy-host', hosts: outsiders, reason };
  }

  const budgetMs = (whenBusy === 'wait' ? input.busyWaitTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.busyWaitTimeoutMs : 0)
    + (input.prepareTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.prepareTimeoutMs)
    + (input.confirmTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.confirmTimeoutMs)
    + (input.releaseTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.releaseTimeoutMs);
  const ownIdentity = ownProcessStartIdentity();
  let request: RuntimeExclusiveMaintenanceRequest = {
    kind: REQUEST_KIND,
    requestId: randomUUID(),
    round: 1,
    phase: 'prepare',
    operation: operationName,
    operationKey,
    message,
    confirmation: input.participantConfirmation ?? 'countdown',
    whenBusy,
    requesterProcessId: process.pid,
    ...(ownIdentity !== undefined ? { requesterProcessStartIdentity: ownIdentity } : {}),
    ...(except !== undefined ? { requesterHostBootId: except } : {}),
    createdAt: new Date().toISOString(),
    // Advisory staleness bound for other processes; the requester's liveness is checked as well.
    expiresAt: new Date(Date.now() + budgetMs + 10 * 60_000).toISOString()
  };
  const publish = async (next: Partial<RuntimeExclusiveMaintenanceRequest>): Promise<void> => {
    request = { ...request, ...next };
    await writeDurableJson(requestPath(paths), request);
  };
  let waiting = true;
  const endWait = (): void => {
    if (!waiting) return;
    waiting = false;
    input.onWaitEnd?.();
  };
  const abandon = async (
    state: Exclude<RuntimeExclusiveMaintenanceAbandonState, 'backoff'>,
    affected: RuntimeHostActiveDescriptor[],
    reason: string
  ): Promise<RuntimeExclusiveMaintenanceOutcome<T>> => {
    // The requester's own cancel is not a reason to delay a later attempt.
    if (state !== 'cancelled') await recordKeyBackoff(paths, operationName, operationKey, reason, input);
    return { state, hosts: affected, reason };
  };

  await publish({});
  input.onWaitStart?.(hosts);
  const busyDeadline = now() + (input.busyWaitTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.busyWaitTimeoutMs);
  try {
    for (;;) {
      // Phase 1: prepare. Nobody acts; every Host only answers.
      const prepareDeadline = now() + (input.prepareTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.prepareTimeoutMs);
      let allReady = false;
      while (!allReady) {
        if (input.isCancelled?.()) return await abandon('cancelled', hosts, '已取消。');
        hosts = await hostsNow();
        if (hosts.length === 0) break;
        // A window that opened just before the request registers and answers within its grace;
        // one that is still unregistered afterwards is an older version.
        const late = await hostsOutsideProtocol(paths, hosts);
        if (late.length > 0) return await abandon('legacy-host', late, outsideProtocolReason(late));
        const answers = await readAnswers(paths, request, hosts);
        const declined = hosts.filter((host) => answers.get(host.hostBootId)?.answer === 'declined');
        if (declined.length > 0) return await abandon('declined', declined, '其它窗口的用户选择了保留窗口。');
        const busy = hosts.filter((host) => answers.get(host.hostBootId)?.answer === 'busy');
        const missing = hosts.filter((host) => !answers.has(host.hostBootId));
        if (busy.length > 0 && whenBusy === 'abandon') {
          return await abandon('busy', busy, busyReason(busy, answers));
        }
        if (busy.length === 0 && missing.length === 0) {
          allReady = true;
          break;
        }
        if (missing.length > 0 && now() >= prepareDeadline) {
          return await abandon('timed-out', missing, '其它窗口没有及时回应。');
        }
        if (busy.length > 0 && now() >= busyDeadline) {
          return await abandon('busy', busy, busyReason(busy, answers));
        }
        input.onProgress?.({
          stage: busy.length > 0 ? 'waiting-busy' : 'prepare',
          hosts,
          busy: busy.map((host) => ({ hostBootId: host.hostBootId, reason: answers.get(host.hostBootId)?.reason }))
        });
        await delay(pollMs);
      }
      if (hosts.length === 0) break;

      // Phase 2: confirm. Each window shows its countdown or notice; still nobody yields.
      await publish({ phase: 'confirm' });
      const confirmDeadline = now() + (input.confirmTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.confirmTimeoutMs);
      let restart = false;
      for (;;) {
        if (input.isCancelled?.()) return await abandon('cancelled', hosts, '已取消。');
        hosts = await hostsNow();
        if (hosts.length === 0) break;
        const answers = await readAnswers(paths, request, hosts);
        const declined = hosts.filter((host) => answers.get(host.hostBootId)?.answer === 'declined');
        if (declined.length > 0) return await abandon('declined', declined, '其它窗口的用户选择了保留窗口。');
        const busy = hosts.filter((host) => answers.get(host.hostBootId)?.answer === 'busy');
        if (busy.length > 0) {
          if (whenBusy === 'abandon' || now() >= busyDeadline) return await abandon('busy', busy, busyReason(busy, answers));
          restart = true;
          break;
        }
        if (hosts.every((host) => answers.get(host.hostBootId)?.answer === 'confirmed')) break;
        if (now() >= confirmDeadline) {
          const pending = hosts.filter((host) => answers.get(host.hostBootId)?.answer !== 'confirmed');
          return await abandon('timed-out', pending, '其它窗口没有及时确认。');
        }
        input.onProgress?.({ stage: 'confirm', hosts, busy: [] });
        await delay(pollMs);
      }
      if (restart) {
        await publish({ round: request.round + 1, phase: 'prepare' });
        continue;
      }
      if (hosts.length === 0) break;

      // Phase 3: go. Every window confirmed; each now yields its Runtime.
      await publish({ phase: 'go' });
      // From here windows reload: a later startup must not ask them to reload again right away.
      await recordOperationCooldown(paths, operationName, input);
      const releaseDeadline = now() + (input.releaseTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.releaseTimeoutMs);
      for (;;) {
        if (input.isCancelled?.()) return await abandon('cancelled', hosts, '已取消。');
        hosts = await hostsNow();
        if (hosts.length === 0) break;
        const answers = await readAnswers(paths, request, hosts);
        const busy = hosts.filter((host) => answers.get(host.hostBootId)?.answer === 'busy');
        if (busy.length > 0) {
          if (whenBusy === 'abandon' || now() >= busyDeadline) return await abandon('busy', busy, busyReason(busy, answers));
          restart = true;
          break;
        }
        if (now() >= releaseDeadline) return await abandon('timed-out', hosts, '其它窗口没有及时让出数据目录。');
        input.onProgress?.({ stage: 'release', hosts, busy: [] });
        await delay(pollMs);
      }
      if (restart) {
        await publish({ round: request.round + 1, phase: 'prepare' });
        continue;
      }
      break;
    }
    endWait();
    const result = await runExclusive(true);
    return { state: 'completed', result, coordinated: true };
  } finally {
    endWait();
    await removeRequestFiles(paths, request.requestId);
  }
}

export interface ExclusiveMaintenanceParticipantHandlers {
  /** Why this Host cannot yield now (running work, a focused window…), or undefined when idle. */
  busyReason(request: RuntimeExclusiveMaintenanceRequest): Promise<string | undefined>;
  /** Countdown or notice before confirming; false when the user kept the window. */
  confirm(request: RuntimeExclusiveMaintenanceRequest): Promise<boolean>;
  /** Yields the root: reload the window (its next startup waits on the admission). */
  release(request: RuntimeExclusiveMaintenanceRequest): Promise<void>;
  /** Wait-mode requests: told once that this Host keeps the requester waiting. */
  notifyWaiting?(request: RuntimeExclusiveMaintenanceRequest, reason: string): void;
}

export interface ExclusiveMaintenanceParticipantOptions {
  pollMs?: number;
  isCurrent?(): boolean;
  /** The process that identifies this window; tests running several windows in one process override it. */
  processId?: number;
  onError?(error: unknown): void;
}

export interface ExclusiveMaintenanceParticipant {
  checkNow(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * One window's side of the protocol. Registers the Host as a participant (call once its Runtime is
 * open), then answers each phase of other windows' requests. It skips requests of its own window.
 */
export function startExclusiveMaintenanceParticipant(
  paths: RuntimeRootPaths,
  hostBootId: string,
  handlers: ExclusiveMaintenanceParticipantHandlers,
  options: ExclusiveMaintenanceParticipantOptions = {}
): ExclusiveMaintenanceParticipant {
  const ownProcessId = options.processId ?? process.pid;
  const classify = createCachedProcessClassifier();
  const answered = new Map<string, string>();
  const declinedRequests = new Set<string>();
  const notified = new Set<string>();
  const released = new Set<string>();
  let disposed = false;
  let checking: Promise<void> | undefined;
  let registration: { unregister(): Promise<void> } | undefined;
  const registered = registerExclusiveMaintenanceParticipant(paths, hostBootId).then(
    (result) => { registration = result; },
    (error) => { options.onError?.(error); }
  );
  const current = (): boolean => !disposed && options.isCurrent?.() !== false;
  const respond = async (
    request: RuntimeExclusiveMaintenanceRequest,
    stage: ExclusiveMaintenancePhase,
    answer: ExclusiveMaintenanceAnswer,
    reason?: string
  ): Promise<void> => {
    await writeResponse(paths, request, hostBootId, stage, answer, reason);
    answered.set(`${request.requestId}#${request.round}:${stage}`, `${answer}\0${reason ?? ''}`);
  };
  const check = async (): Promise<void> => {
    await registered;
    if (!current()) return;
    const request = await readExclusiveMaintenanceRequest(paths, { classify });
    if (!request || !current()) return;
    if (request.requesterHostBootId === hostBootId
      || (request.requesterHostBootId === undefined && request.requesterProcessId === ownProcessId)) return;
    const round = `${request.requestId}#${request.round}`;
    if (request.phase === 'prepare') {
      const busy = await handlers.busyReason(request);
      const answer: ExclusiveMaintenanceAnswer = declinedRequests.has(request.requestId)
        ? 'declined' : busy ? 'busy' : 'ready';
      if (answered.get(`${round}:prepare`) === `${answer}\0${busy ?? ''}`) return;
      if (answer === 'busy' && request.whenBusy === 'wait' && !notified.has(request.requestId)) {
        notified.add(request.requestId);
        handlers.notifyWaiting?.(request, busy!);
      }
      await respond(request, 'prepare', answer, answer === 'busy' ? busy : undefined);
      return;
    }
    if (request.phase === 'confirm') {
      if (answered.has(`${round}:confirm`)) return;
      if (!answered.get(`${round}:prepare`)?.startsWith('ready\0')) return;
      const busy = await handlers.busyReason(request);
      if (busy) {
        await respond(request, 'confirm', 'busy', busy);
        return;
      }
      const confirmed = await handlers.confirm(request);
      const still = await readExclusiveMaintenanceRequest(paths, { classify });
      // Withdrawn (another window declined, a timeout) or restarted while the countdown ran.
      if (!current() || still?.requestId !== request.requestId || still.round !== request.round) return;
      if (!confirmed) {
        declinedRequests.add(request.requestId);
        await respond(request, 'confirm', 'declined', '用户选择保留本窗口');
        return;
      }
      const busyAfter = await handlers.busyReason(request);
      await respond(request, 'confirm', busyAfter ? 'busy' : 'confirmed', busyAfter);
      return;
    }
    if (request.phase === 'go') {
      if (!answered.get(`${round}:confirm`)?.startsWith('confirmed\0') || released.has(round)) return;
      const busy = await handlers.busyReason(request);
      if (busy) {
        // Work started after this window confirmed: never interrupt it; the requester withdraws.
        if (!answered.has(`${round}:go`)) await respond(request, 'go', 'busy', busy);
        return;
      }
      released.add(round);
      await handlers.release(request);
    }
  };
  const checkNow = (): Promise<void> => {
    checking ??= check().catch((error) => options.onError?.(error)).finally(() => { checking = undefined; });
    return checking;
  };
  const timer = setInterval(() => { void checkNow(); }, options.pollMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.participantPollMs);
  timer.unref?.();
  return {
    checkNow,
    async dispose() {
      disposed = true;
      clearInterval(timer);
      await registered;
      await registration?.unregister().catch(() => undefined);
    }
  };
}

/** A participating Host announces that it answers requests; call once its Runtime is open. */
export async function registerExclusiveMaintenanceParticipant(
  paths: RuntimeRootPaths,
  hostBootId: string
): Promise<{ unregister(): Promise<void> }> {
  const directory = path.join(runtimeExclusiveMaintenanceDirectory(paths), PARTICIPANTS_DIRECTORY);
  const file = path.join(directory, `${safeName(hostBootId)}.json`);
  await removeDeadParticipants(directory);
  const identity = ownProcessStartIdentity();
  await writeDurableJson(file, {
    kind: PARTICIPANT_KIND,
    hostBootId,
    processId: process.pid,
    ...(identity !== undefined ? { processStartIdentity: identity } : {}),
    registeredAt: new Date().toISOString()
  });
  let removed = false;
  return {
    async unregister() {
      if (removed) return;
      removed = true;
      await removeWithRetry(file);
    }
  };
}

/** The current request, only while it is unexpired and its requester process is still alive. */
export async function readExclusiveMaintenanceRequest(
  paths: RuntimeRootPaths,
  options: { classify?: RecordedProcessClassifier } = {}
): Promise<RuntimeExclusiveMaintenanceRequest | undefined> {
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(requestPath(paths), 'utf8')) as unknown; }
  catch { return undefined; }
  const request = value as Partial<RuntimeExclusiveMaintenanceRequest> | undefined;
  if (!request || request.kind !== REQUEST_KIND
    || typeof request.requestId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(request.requestId)
    || !Number.isSafeInteger(request.round) || (request.round as number) < 1
    || (request.phase !== 'prepare' && request.phase !== 'confirm' && request.phase !== 'go')
    || typeof request.operation !== 'string' || typeof request.operationKey !== 'string'
    || typeof request.message !== 'string'
    || (request.confirmation !== 'countdown' && request.confirmation !== 'notice')
    || (request.whenBusy !== 'abandon' && request.whenBusy !== 'wait')
    || !Number.isSafeInteger(request.requesterProcessId) || (request.requesterProcessId as number) <= 0
    || (request.requesterHostBootId !== undefined && typeof request.requesterHostBootId !== 'string')
    || typeof request.expiresAt !== 'string') return undefined;
  const expiresAt = Date.parse(request.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return undefined;
  const classify = options.classify ?? createCachedProcessClassifier();
  if (classify(request.requesterProcessId as number, request.requesterProcessStartIdentity) !== 'alive') return undefined;
  return request as RuntimeExclusiveMaintenanceRequest;
}

/**
 * Every Host must be live and registered as a participant with the same process. One that started
 * moments ago without a registration yet is not counted: it is waited for like a missing answer.
 */
async function hostsOutsideProtocol(
  paths: RuntimeRootPaths,
  hosts: readonly RuntimeHostActiveDescriptor[]
): Promise<RuntimeHostActiveDescriptor[]> {
  const directory = path.join(runtimeExclusiveMaintenanceDirectory(paths), PARTICIPANTS_DIRECTORY);
  const outsiders: RuntimeHostActiveDescriptor[] = [];
  for (const host of hosts) {
    if (host.state !== 'live' || host.processId === null || !/^[A-Za-z0-9._-]{1,128}$/.test(host.hostBootId)) {
      outsiders.push(host);
      continue;
    }
    let record: Record<string, unknown>;
    try { record = JSON.parse(await fs.readFile(path.join(directory, `${host.hostBootId}.json`), 'utf8')) as Record<string, unknown>; }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' || !startedMomentsAgo(host)) outsiders.push(host);
      continue;
    }
    if (record.kind !== PARTICIPANT_KIND || record.hostBootId !== host.hostBootId || record.processId !== host.processId
      || (host.processStartIdentity !== undefined && record.processStartIdentity !== host.processStartIdentity)) {
      outsiders.push(host);
    }
  }
  return outsiders;
}

function startedMomentsAgo(host: RuntimeHostActiveDescriptor): boolean {
  const age = Date.now() - (host.startedAt === undefined ? Number.NaN : Date.parse(host.startedAt));
  return Number.isFinite(age) && age > -60_000 && age < PARTICIPANT_REGISTRATION_GRACE_MS;
}

function outsideProtocolReason(outsiders: readonly RuntimeHostActiveDescriptor[]): string {
  return outsiders.some((host) => host.state !== 'live')
    ? '有窗口的运行状态无法确认，暂不打扰其它窗口。'
    : '还有未参与协作的窗口（可能是旧版本）在使用这个数据目录，重载或关闭它后再试。';
}

async function readAnswers(
  paths: RuntimeRootPaths,
  request: RuntimeExclusiveMaintenanceRequest,
  hosts: readonly RuntimeHostActiveDescriptor[]
): Promise<Map<string, RuntimeExclusiveMaintenanceResponse>> {
  const answers = new Map<string, RuntimeExclusiveMaintenanceResponse>();
  for (const host of hosts) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(host.hostBootId)) continue;
    let value: Partial<RuntimeExclusiveMaintenanceResponse>;
    try {
      value = JSON.parse(await fs.readFile(responsePath(paths, request.requestId, host.hostBootId), 'utf8')) as Partial<RuntimeExclusiveMaintenanceResponse>;
    } catch { continue; }
    if (value.kind !== RESPONSE_KIND || value.requestId !== request.requestId || value.round !== request.round
      || value.hostBootId !== host.hostBootId) continue;
    // Only answers to the current phase count; a go-stage busy is always relevant.
    const relevant = value.stage === request.phase || (request.phase !== 'prepare' && value.answer === 'busy');
    if (!relevant) continue;
    answers.set(host.hostBootId, value as RuntimeExclusiveMaintenanceResponse);
  }
  return answers;
}

async function writeResponse(
  paths: RuntimeRootPaths,
  request: RuntimeExclusiveMaintenanceRequest,
  hostBootId: string,
  stage: ExclusiveMaintenancePhase,
  answer: ExclusiveMaintenanceAnswer,
  reason?: string
): Promise<void> {
  const response: RuntimeExclusiveMaintenanceResponse = {
    kind: RESPONSE_KIND,
    requestId: request.requestId,
    round: request.round,
    hostBootId: safeName(hostBootId),
    stage,
    answer,
    ...(reason !== undefined ? { reason } : {}),
    respondedAt: new Date().toISOString()
  };
  await writeDurableJson(responsePath(paths, request.requestId, hostBootId), response);
}

function busyReason(
  busy: readonly RuntimeHostActiveDescriptor[],
  answers: ReadonlyMap<string, RuntimeExclusiveMaintenanceResponse>
): string {
  const reasons = [...new Set(busy.map((host) => answers.get(host.hostBootId)?.reason).filter(Boolean))];
  return `其它窗口正在忙${reasons.length ? `（${reasons.join('；')}）` : ''}，暂不打扰。`;
}

interface LedgerEntry {
  kind: typeof LEDGER_KIND;
  scope: 'operation' | 'key';
  operation: string;
  operationKey?: string;
  attempts: number;
  until: string;
  /** A deterministic failure: this key is never run again (its identity must change first). */
  blocked?: true;
  reason: string;
  recordedAt: string;
}

async function readKeyBlock(paths: RuntimeRootPaths, operation: string, operationKey: string): Promise<string | undefined> {
  const entry = await readLedger(paths, keyLedgerName(operation, operationKey));
  return entry?.blocked === true ? `这项维护此前确定无法完成，不再自动重试：${entry.reason}` : undefined;
}

async function readActiveBackoff(
  paths: RuntimeRootPaths,
  operation: string,
  operationKey: string,
  input: RuntimeExclusiveMaintenanceInput
): Promise<{ until: string; reason: string } | undefined> {
  const maxMs = Math.max(
    input.backoffMaxMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.backoffMaxMs,
    input.cooldownAfterCoordinatedMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.cooldownAfterCoordinatedMs
  );
  // An explicit user request skips the key's backoff, never the operation's cooldown.
  const entries = [await readLedger(paths, operationLedgerName(operation))];
  if (!input.ignoreBackoff) entries.push(await readLedger(paths, keyLedgerName(operation, operationKey)));
  let latest: { until: string; reason: string; at: number } | undefined;
  for (const entry of entries) {
    if (!entry || entry.blocked) continue;
    const until = Date.parse(entry.until);
    // A clock set back must not freeze retries far beyond the longest backoff.
    if (!Number.isFinite(until) || until <= Date.now() || until > Date.now() + maxMs + 60_000) continue;
    if (!latest || until > latest.at) latest = { until: entry.until, reason: entry.reason, at: until };
  }
  return latest ? { until: latest.until, reason: latest.reason } : undefined;
}

async function recordKeyBackoff(
  paths: RuntimeRootPaths,
  operation: string,
  operationKey: string,
  reason: string,
  input: RuntimeExclusiveMaintenanceInput
): Promise<void> {
  const name = keyLedgerName(operation, operationKey);
  const previous = await readLedger(paths, name);
  if (previous?.blocked) return;
  const baseMs = input.backoffBaseMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.backoffBaseMs;
  const maxMs = input.backoffMaxMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.backoffMaxMs;
  const attempts = Math.min(30, (previous?.attempts ?? 0) + 1);
  const durationMs = Math.min(maxMs, baseMs * 2 ** (attempts - 1));
  await writeLedger(paths, name, {
    kind: LEDGER_KIND, scope: 'key', operation, operationKey, attempts,
    until: new Date(Date.now() + durationMs).toISOString(), reason, recordedAt: new Date().toISOString()
  }).catch((error) => console.warn('[LimCode] 无法记录独占维护的退避。', error));
}

async function recordKeyBlocked(paths: RuntimeRootPaths, operation: string, operationKey: string, reason: string): Promise<void> {
  const recordedAt = new Date().toISOString();
  await writeLedger(paths, keyLedgerName(operation, operationKey), {
    kind: LEDGER_KIND, scope: 'key', operation, operationKey, attempts: 1, until: recordedAt, blocked: true, reason, recordedAt
  }).catch((error) => console.warn('[LimCode] 无法记录独占维护的确定性失败。', error));
}

async function recordOperationCooldown(
  paths: RuntimeRootPaths,
  operation: string,
  input: RuntimeExclusiveMaintenanceInput
): Promise<void> {
  const durationMs = input.cooldownAfterCoordinatedMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.cooldownAfterCoordinatedMs;
  await writeLedger(paths, operationLedgerName(operation), {
    kind: LEDGER_KIND, scope: 'operation', operation, attempts: 1,
    until: new Date(Date.now() + durationMs).toISOString(),
    reason: '刚刚已经让其它窗口重载过一次，稍后再自动尝试。', recordedAt: new Date().toISOString()
  }).catch((error) => console.warn('[LimCode] 无法记录独占维护的冷却期。', error));
}

/** Success resets the key: a later failure starts again from the shortest backoff. */
async function clearKeyBackoff(paths: RuntimeRootPaths, operation: string, operationKey: string): Promise<void> {
  await removeWithRetry(path.join(ledgerDirectory(paths), keyLedgerName(operation, operationKey)))
    .catch((error) => console.warn('[LimCode] 无法清除独占维护的退避记录。', error));
}

async function readLedger(paths: RuntimeRootPaths, name: string): Promise<LedgerEntry | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(ledgerDirectory(paths), name), 'utf8')) as Partial<LedgerEntry>;
    if (value.kind !== LEDGER_KIND || typeof value.until !== 'string' || typeof value.reason !== 'string'
      || !Number.isSafeInteger(value.attempts) || (value.blocked !== undefined && value.blocked !== true)) return undefined;
    return value as LedgerEntry;
  } catch {
    return undefined;
  }
}

async function writeLedger(paths: RuntimeRootPaths, name: string, entry: LedgerEntry): Promise<void> {
  await writeDurableJson(path.join(ledgerDirectory(paths), name), entry);
}

function operationLedgerName(operation: string): string {
  return `operation-${digest(operation)}.json`;
}

function keyLedgerName(operation: string, operationKey: string): string {
  return `key-${digest(`${operation}\0${operationKey}`)}.json`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

async function removeDeadParticipants(directory: string): Promise<void> {
  let names: string[];
  try { names = await fs.readdir(directory); }
  catch { return; }
  const classify = createCachedProcessClassifier();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(directory, name);
    try {
      const record = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      if (typeof record.processId === 'number' && classify(
        record.processId, typeof record.processStartIdentity === 'string' ? record.processStartIdentity : undefined
      ) === 'dead') await removeWithRetry(file);
    } catch { /* A concurrently replaced record is left for its owner. */ }
  }
}

/** Cleanup never replaces the outcome: a failure is logged and the stale files are ignored later. */
async function removeRequestFiles(paths: RuntimeRootPaths, requestId: string): Promise<void> {
  const file = requestPath(paths);
  try {
    const current = JSON.parse(await fs.readFile(file, 'utf8')) as { requestId?: unknown };
    if (current.requestId === requestId) {
      await removeWithRetry(file);
      await syncDirectoryDurably(path.dirname(file));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[LimCode] 无法撤回独占维护请求；请求方进程结束后它会自动失效。', error);
    }
  }
  await removeWithRetry(path.join(runtimeExclusiveMaintenanceDirectory(paths), RESPONSES_DIRECTORY, requestId), true)
    .catch((error) => console.warn('[LimCode] 无法清理独占维护的回应记录。', error));
}

async function removeWithRetry(target: string, recursive = false): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rm(target, { force: true, recursive });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!code || !RETRYABLE_REMOVE_CODES.has(code) || attempt >= 6) throw error;
      await delay(25 * 2 ** attempt);
    }
  }
}

function requestPath(paths: RuntimeRootPaths): string {
  return path.join(runtimeExclusiveMaintenanceDirectory(paths), REQUEST_FILE);
}

function responsePath(paths: RuntimeRootPaths, requestId: string, hostBootId: string): string {
  return path.join(runtimeExclusiveMaintenanceDirectory(paths), RESPONSES_DIRECTORY, requestId, `${safeName(hostBootId)}.json`);
}

function ledgerDirectory(paths: RuntimeRootPaths): string {
  return path.join(runtimeExclusiveMaintenanceDirectory(paths), LEDGER_DIRECTORY);
}

function safeName(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new TypeError('Host boot id is not a safe file name.');
  return value;
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function requireText(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

async function writeDurableJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try { await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
  await syncDirectoryDurably(path.dirname(file));
}
