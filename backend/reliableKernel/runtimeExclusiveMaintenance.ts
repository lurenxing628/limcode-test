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
 * Three phases, so no window yields unless all of them can:
 *   prepare — every participating Host answers ready / busy / declined, nobody acts yet;
 *   confirm — only when all are ready: each shows its countdown or notice, then answers confirmed;
 *   go      — only when all confirmed: each yields (reloads) and its next startup waits on the
 *             requester's configuration admission until the maintenance ends.
 * Waiting for busy windows happens only outside the locks ({@link runExclusiveRuntimeMaintenance});
 * the locked round (admission and maintenance held) is short and bounded: prepare, confirm and
 * release each have a limit, and a window that became busy meanwhile sends the requester back
 * outside (a bounded number of times). Any busy (unless the requester waits), declined,
 * unknown/legacy Host, timeout or cancel withdraws the request before anybody yields. Abandoned
 * attempts and failures after go back off per operation key, a deterministic failure blocks the key,
 * and a coordinated round starts a cooldown per operation, so windows can never keep reloading each
 * other. The requests are advisory: exclusivity is still proven by the Host liveness records alone.
 */
export const RUNTIME_EXCLUSIVE_MAINTENANCE_DIRECTORY = 'exclusive-maintenance';

const REQUESTS_DIRECTORY = 'requests';
const PARTICIPANTS_DIRECTORY = 'hosts';
const RESPONSES_DIRECTORY = 'responses';
const LEDGER_DIRECTORY = 'ledger';
const REQUEST_KIND = 'limcode-runtime-exclusive-maintenance-request';
const RESPONSE_KIND = 'limcode-runtime-exclusive-maintenance-response';
const PARTICIPANT_KIND = 'limcode-runtime-exclusive-maintenance-participant';
const LEDGER_KIND = 'limcode-runtime-exclusive-maintenance-ledger';
const RETRYABLE_REMOVE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

export const EXCLUSIVE_MAINTENANCE_DEFAULTS = Object.freeze({
  pollMs: 250,
  participantPollMs: 1_000,
  /**
   * Every participant answers within a few of its polls. Also the registration grace: a window
   * registers right after its Runtime opened, and one still unregistered this long is an older version.
   */
  prepareTimeoutMs: 8_000,
  /** Only with whenBusy 'wait', only outside the locks: how long other windows' work may delay it. */
  busyWaitTimeoutMs: 10 * 60_000,
  /** Countdown (5 s) plus participant poll latency. */
  confirmTimeoutMs: 20_000,
  /** A window reload closes its Runtime and Host liveness record. */
  releaseTimeoutMs: 30_000,
  /** Locked rounds after waiting outside; the locks are released between them. */
  maxLockedAttempts: 3,
  /** The requester refreshes its request this often; participants ignore one not refreshed for staleRequestMs. */
  heartbeatMs: 2_000,
  staleRequestMs: 15_000,
  backoffBaseMs: 5 * 60_000,
  backoffMaxMs: 6 * 60 * 60_000,
  cooldownAfterCoordinatedMs: 10 * 60_000
});

export type ExclusiveMaintenancePhase = 'prepare' | 'confirm' | 'go';
/**
 * countdown: 5 s countdown each other window can cancel (which withdraws the request);
 * final-countdown: the user already confirmed — a countdown that cannot be cancelled;
 * notice: the user already confirmed — announce only.
 */
export type ExclusiveMaintenanceConfirmation = 'countdown' | 'final-countdown' | 'notice';
/** abandon: any busy window withdraws the request; wait: wait (bounded, outside the locks) until busy windows are idle. */
export type ExclusiveMaintenanceBusyPolicy = 'abandon' | 'wait';
/** work: running or pending work a reload would interrupt; focus: the user is in that window. */
export type ExclusiveMaintenanceBusyKind = 'work' | 'focus';

export interface ExclusiveMaintenanceBusy {
  kind: ExclusiveMaintenanceBusyKind;
  /** Short user-facing reason in Chinese. */
  reason: string;
}

export interface RuntimeExclusiveMaintenanceRequest {
  kind: typeof REQUEST_KIND;
  requestId: string;
  /** A new round starts for every locked attempt and whenever a window became busy again. */
  round: number;
  /** withdrawn: the requester gave up; participants ignore it even when it could not be removed. */
  phase: ExclusiveMaintenancePhase | 'withdrawn';
  /** Stable operation name, e.g. data-root-migration, historical-merge. */
  operation: string;
  /** Identity of this particular work, e.g. a source and its file state; backoff is keyed by it. */
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
  /** Refreshed while the requester is active; a request not refreshed for staleRequestMs is ignored. */
  heartbeatAt: string;
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
  busyKind?: ExclusiveMaintenanceBusyKind;
  reason?: string;
  respondedAt: string;
}

export interface ExclusiveMaintenanceBusyHost extends ExclusiveMaintenanceBusy {
  hostBootId: string;
}

export interface ExclusiveMaintenanceProgress {
  stage: 'prepare' | 'waiting-busy' | 'confirm' | 'release';
  hosts: readonly RuntimeHostActiveDescriptor[];
  busy: readonly ExclusiveMaintenanceBusyHost[];
  /** The requester's own window is busy (see requesterBusy). */
  requesterBusy?: ExclusiveMaintenanceBusy;
}

export interface RuntimeExclusiveMaintenanceInput {
  operation: string;
  /** Defaults to `operation`; pass the identity of the work so a different work is not delayed. */
  operationKey?: string;
  message: string;
  /**
   * Required on every call, never inferred from stored state: true only for the one call made for
   * an explicit user action. It skips the per-key backoff, never the per-operation cooldown or a
   * blocked key.
   */
  ignoreBackoff: boolean;
  /** The requester's own registered Host when it stays open while requesting (e.g. a migration). */
  requesterHostBootId?: string;
  /**
   * The requester's own window: work that the operation would interrupt (its own Runtime closes
   * for a migration). Checked while preparing and confirming, like another window's busy answer.
   */
  requesterBusy?(): Promise<ExclusiveMaintenanceBusy | undefined>;
  /** When given, the configuration admission of this root is part of the locks. */
  configurationRootPath?: string;
  participantConfirmation?: ExclusiveMaintenanceConfirmation;
  whenBusy?: ExclusiveMaintenanceBusyPolicy;
  /** A failure of the operation that will fail the same way again: the key is blocked for good. */
  isDeterministicFailure?(error: unknown): boolean;
  pollMs?: number;
  prepareTimeoutMs?: number;
  busyWaitTimeoutMs?: number;
  confirmTimeoutMs?: number;
  releaseTimeoutMs?: number;
  maxLockedAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  cooldownAfterCoordinatedMs?: number;
  isCancelled?(): boolean;
  /** Called once when a request is first published (other windows are involved). */
  onWaitStart?(hosts: readonly RuntimeHostActiveDescriptor[]): void;
  onProgress?(progress: ExclusiveMaintenanceProgress): void;
  /** Called once when coordination ends, before the operation runs or after it was abandoned. */
  onWaitEnd?(): void;
  /** Monotonic clock in milliseconds; defaults to performance.now(). */
  now?(): number;
}

export interface RuntimeExclusiveMaintenanceRunInput extends RuntimeExclusiveMaintenanceInput {
  /**
   * Takes the locks around `body`: the configuration admission (when configurationRootPath is
   * given) and then the target maintenance claim. Called only once every window is ready.
   */
  withLocks<R>(body: () => Promise<R>): Promise<R>;
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
 * The locked round alone, for a caller that already holds the target maintenance claim (and the
 * configuration admission when configurationRootPath is given) and must not wait: a busy window
 * abandons at once. Runs `operation` at once when no other Host is registered. Otherwise runs it
 * only after every other Host is proven offline; the requester's own window (requesterHostBootId)
 * closes its Runtime inside `operation` when the operation needs the root offline. A failure of the
 * operation after other windows yielded is rethrown after it was recorded (backoff, or blocked).
 */
export async function requestExclusiveRuntimeMaintenance<T>(
  paths: RuntimeRootPaths,
  input: RuntimeExclusiveMaintenanceInput,
  operation: () => Promise<T>
): Promise<RuntimeExclusiveMaintenanceOutcome<T>> {
  assertLocksHeld(paths, input);
  if ((input.whenBusy ?? 'abandon') === 'wait') {
    throw new TypeError('等待忙窗口只能在锁外进行：请改用 runExclusiveRuntimeMaintenance 并传入 withLocks。');
  }
  return new ExclusiveMaintenanceRequester(paths, input, operation).run(undefined);
}

/**
 * Called outside the locks. Waits (bounded, with whenBusy 'wait') without any lock until every
 * other window and the requester itself are ready, then takes the locks through `withLocks` for
 * one short locked round. When a window became busy in between, the locks are released and it
 * waits outside again, at most maxLockedAttempts times. Windows keep opening meanwhile.
 */
export async function runExclusiveRuntimeMaintenance<T>(
  paths: RuntimeRootPaths,
  input: RuntimeExclusiveMaintenanceRunInput,
  operation: () => Promise<T>
): Promise<RuntimeExclusiveMaintenanceOutcome<T>> {
  if (typeof input.withLocks !== 'function') throw new TypeError('withLocks must be a function.');
  if (isRuntimeMaintenanceHeld(paths)
    || (input.configurationRootPath !== undefined && isRuntimeDataRootAdmissionHeld(input.configurationRootPath))) {
    throw new Error('等待其它窗口空闲必须在 admission 与 maintenance 之外进行；锁内请用 requestExclusiveRuntimeMaintenance。');
  }
  return new ExclusiveMaintenanceRequester(paths, input, operation).run(input.withLocks);
}

function assertLocksHeld(paths: RuntimeRootPaths, input: RuntimeExclusiveMaintenanceInput): void {
  if (!isRuntimeMaintenanceHeld(paths)) {
    throw new Error('独占维护必须在目标数据集的 maintenance 锁内发起。');
  }
  if (input.configurationRootPath !== undefined && !isRuntimeDataRootAdmissionHeld(input.configurationRootPath)) {
    throw new Error('独占维护必须在配置根的 admission 内发起。');
  }
}

type Outcome<T> = RuntimeExclusiveMaintenanceOutcome<T>;
type AbandonOutcome = Extract<Outcome<never>, { hosts: RuntimeHostActiveDescriptor[] }>;
/** A window became busy during the locked round in wait mode: release the locks and wait outside. */
const RETRY = Symbol('retry-outside-the-locks');
type Step = 'ready' | typeof RETRY | AbandonOutcome;

class ExclusiveMaintenanceRequester<T> {
  private readonly operationName: string;
  private readonly operationKey: string;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly prepareTimeoutMs: number;
  private readonly whenBusy: ExclusiveMaintenanceBusyPolicy;
  private readonly classify = createCachedProcessClassifier();
  private readonly busyDeadline: number;
  private hosts: RuntimeHostActiveDescriptor[] = [];
  private request: RuntimeExclusiveMaintenanceRequest | undefined;
  private lastWrite = Number.NEGATIVE_INFINITY;
  private waiting = false;
  private gated = false;

  public constructor(
    private readonly paths: RuntimeRootPaths,
    private readonly input: RuntimeExclusiveMaintenanceInput,
    private readonly operation: () => Promise<T>
  ) {
    if (typeof input.ignoreBackoff !== 'boolean') {
      throw new TypeError('ignoreBackoff must be passed explicitly on every call.');
    }
    this.operationName = requireText(input.operation, 'operation');
    this.operationKey = requireText(input.operationKey ?? input.operation, 'operationKey');
    requireText(input.message, 'message');
    this.now = input.now ?? (() => performance.now());
    this.pollMs = input.pollMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.pollMs;
    this.prepareTimeoutMs = input.prepareTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.prepareTimeoutMs;
    this.whenBusy = input.whenBusy ?? 'abandon';
    this.busyDeadline = this.now() + (input.busyWaitTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.busyWaitTimeoutMs);
  }

  public async run(withLocks: RuntimeExclusiveMaintenanceRunInput['withLocks'] | undefined): Promise<Outcome<T>> {
    try {
      const blocked = await readKeyBlock(this.paths, this.operationName, this.operationKey);
      if (blocked) return { state: 'blocked', hosts: [], reason: blocked };
      await sweepAbandonedRequests(this.paths, this.classify).catch(() => undefined);
      if (!withLocks) return await this.lockedRound() as Outcome<T>;
      const maxAttempts = Math.max(1, this.input.maxLockedAttempts ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.maxLockedAttempts);
      for (let attempt = 1; ; attempt += 1) {
        this.hosts = await this.hostsNow();
        if (this.hosts.length > 0 || await this.requesterBusy()) {
          const refused = await this.gate();
          if (refused) return refused;
          await this.publish({ phase: 'prepare', round: (this.request?.round ?? 0) + 1 });
          const ready = await this.prepare(false);
          if (ready !== 'ready') return ready as AbandonOutcome;
        }
        const locked = await withLocks(async () => {
          assertLocksHeld(this.paths, this.input);
          return this.lockedRound();
        });
        if (locked !== RETRY) return locked;
        if (attempt >= maxAttempts) {
          return await this.abandon('busy', this.hosts, '其它窗口在准备期间反复开始新的任务，稍后再试。');
        }
      }
    } finally {
      this.endWait();
      await this.withdraw();
    }
  }

  /** The short part under the locks: prepare, confirm, go, operation. Every step has a limit. */
  private async lockedRound(): Promise<Outcome<T> | typeof RETRY> {
    this.hosts = await this.hostsNow();
    if (this.hosts.length === 0 && !await this.requesterBusy()) {
      return this.completed(await this.execute(this.request !== undefined), this.request !== undefined);
    }
    const refused = await this.gate();
    if (refused) return refused;
    await this.publish({ phase: 'prepare', round: (this.request?.round ?? 0) + 1 });
    const prepared = await this.prepare(true);
    if (prepared !== 'ready') return prepared;
    if (this.hosts.length > 0) {
      const confirmed = await this.confirm();
      if (confirmed !== 'ready') return confirmed;
      const released = await this.release();
      if (released !== 'ready') return released;
    }
    this.endWait();
    return this.completed(await this.execute(true), true);
  }

  /** Once per requester while other windows are involved: blocked, backoff, cooldown, older windows. */
  private async gate(): Promise<AbandonOutcome | undefined> {
    if (this.gated || this.hosts.length === 0) return undefined;
    this.gated = true;
    const refusal = await readActiveBackoff(this.paths, this.operationName, this.operationKey, this.input);
    if (refusal) return { state: 'backoff', hosts: this.hosts, reason: refusal.reason, retryAfter: refusal.until };
    const outsiders = await hostsOutsideProtocol(this.paths, this.hosts, this.prepareTimeoutMs);
    if (outsiders.length > 0) return this.abandon('legacy-host', outsiders, outsideProtocolReason(outsiders));
    return undefined;
  }

  /** Until everyone (and the requester itself) answered ready. Locked: a busy one is never waited for here. */
  private async prepare(locked: boolean): Promise<Step> {
    const started = this.now();
    const firstSeen = new Map<string, number>();
    for (;;) {
      if (this.input.isCancelled?.()) return this.abandon('cancelled', this.hosts, '已取消。');
      await this.heartbeat();
      this.hosts = await this.hostsNow();
      const own = await this.requesterBusy();
      if (this.hosts.length === 0 && !own) return 'ready';
      // A window that opened just before (or, outside the locks, during) the request registers and
      // answers within the prepare timeout; one still unregistered afterwards is an older version.
      const outsiders = await hostsOutsideProtocol(this.paths, this.hosts, this.prepareTimeoutMs);
      if (outsiders.length > 0) return this.abandon('legacy-host', outsiders, outsideProtocolReason(outsiders));
      const answers = await this.answers();
      const declined = this.hosts.filter((host) => answers.get(host.hostBootId)?.answer === 'declined');
      if (declined.length > 0) return this.abandon('declined', declined, '其它窗口的用户选择了保留窗口。');
      const busy = busyHosts(this.hosts, answers);
      const missing = this.hosts.filter((host) => !answers.has(host.hostBootId));
      for (const host of this.hosts) if (!firstSeen.has(host.hostBootId)) firstSeen.set(host.hostBootId, this.now());
      if (busy.length === 0 && !own && missing.length === 0) return 'ready';
      if (busy.length > 0 || own) {
        const step = await this.whenBusyStep(busy, own, locked);
        if (step) return step;
      }
      const overdue = missing.filter((host) => this.now() - Math.max(started, firstSeen.get(host.hostBootId)!) >= this.prepareTimeoutMs);
      if (overdue.length > 0) return this.abandon('timed-out', overdue, '其它窗口没有及时回应。');
      this.input.onProgress?.({
        stage: busy.length > 0 || own ? 'waiting-busy' : 'prepare',
        hosts: this.hosts,
        busy,
        ...(own ? { requesterBusy: own } : {})
      });
      await delay(this.pollMs);
    }
  }

  private async confirm(): Promise<Step> {
    await this.publish({ phase: 'confirm' });
    const deadline = this.now() + (this.input.confirmTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.confirmTimeoutMs);
    for (;;) {
      if (this.input.isCancelled?.()) return this.abandon('cancelled', this.hosts, '已取消。');
      await this.heartbeat();
      this.hosts = await this.hostsNow();
      if (this.hosts.length === 0) return 'ready';
      const answers = await this.answers();
      const declined = this.hosts.filter((host) => answers.get(host.hostBootId)?.answer === 'declined');
      if (declined.length > 0) return this.abandon('declined', declined, '其它窗口的用户选择了保留窗口。');
      const busy = busyHosts(this.hosts, answers);
      const own = await this.requesterBusy();
      if (busy.length > 0 || own) return (await this.whenBusyStep(busy, own, true))!;
      if (this.hosts.every((host) => answers.get(host.hostBootId)?.answer === 'confirmed')) return 'ready';
      if (this.now() >= deadline) {
        const pending = this.hosts.filter((host) => answers.get(host.hostBootId)?.answer !== 'confirmed');
        return this.abandon('timed-out', pending, '其它窗口没有及时确认。');
      }
      this.input.onProgress?.({ stage: 'confirm', hosts: this.hosts, busy: [] });
      await delay(this.pollMs);
    }
  }

  /**
   * Every window confirmed; each now yields. A window that answers busy here yields nothing this
   * round, but windows that already reloaded did so in vain: their next startup waits on the
   * admission until this requester lets go, and their unsent input is kept.
   */
  private async release(): Promise<Step> {
    await this.publish({ phase: 'go' });
    // From here windows reload: a later request of this operation must not make them reload again soon.
    await recordOperationCooldown(this.paths, this.operationName, this.input);
    const deadline = this.now() + (this.input.releaseTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.releaseTimeoutMs);
    for (;;) {
      if (this.input.isCancelled?.()) return this.abandon('cancelled', this.hosts, '已取消。');
      await this.heartbeat();
      this.hosts = await this.hostsNow();
      if (this.hosts.length === 0) return 'ready';
      const busy = busyHosts(this.hosts, await this.answers());
      if (busy.length > 0) return (await this.whenBusyStep(busy, undefined, true))!;
      if (this.now() >= deadline) return this.abandon('timed-out', this.hosts, '其它窗口没有及时让出数据目录。');
      this.input.onProgress?.({ stage: 'release', hosts: this.hosts, busy: [] });
      await delay(this.pollMs);
    }
  }

  /** Abandon, go back outside the locks, or (outside, still within the budget) keep waiting. */
  private async whenBusyStep(
    busy: readonly ExclusiveMaintenanceBusyHost[],
    own: ExclusiveMaintenanceBusy | undefined,
    locked: boolean
  ): Promise<Step | undefined> {
    const affected = this.hosts.filter((host) => busy.some((item) => item.hostBootId === host.hostBootId));
    if (this.whenBusy === 'abandon' || this.now() >= this.busyDeadline) {
      return this.abandon('busy', affected, busyReasonText(busy, own));
    }
    return locked ? RETRY : undefined;
  }

  private async abandon(
    state: Exclude<RuntimeExclusiveMaintenanceAbandonState, 'backoff' | 'blocked'>,
    hosts: RuntimeHostActiveDescriptor[],
    reason: string
  ): Promise<AbandonOutcome> {
    // The requester's own cancel is not a reason to delay a later attempt.
    if (state !== 'cancelled') await recordKeyBackoff(this.paths, this.operationName, this.operationKey, reason, this.input);
    return { state, hosts, reason };
  }

  private async execute(coordinated: boolean): Promise<T> {
    // The final decision never trusts the poll cache.
    await assertRuntimeHostsOffline(this.paths, this.input.requesterHostBootId);
    try {
      const result = await this.operation();
      await clearKeyBackoff(this.paths, this.operationName, this.operationKey);
      return result;
    } catch (error) {
      const reason = `上次${coordinated ? '其它窗口让出后' : ''}操作失败：${describeError(error)}`;
      if (this.input.isDeterministicFailure?.(error)) {
        await recordKeyBlocked(this.paths, this.operationName, this.operationKey, reason);
      } else if (coordinated) {
        // Other windows reloaded for nothing: the same work backs off like an abandoned attempt.
        await recordKeyBackoff(this.paths, this.operationName, this.operationKey, reason, this.input);
      }
      throw error;
    }
  }

  private completed(result: T, coordinated: boolean): Outcome<T> {
    return { state: 'completed', result, coordinated };
  }

  private async requesterBusy(): Promise<ExclusiveMaintenanceBusy | undefined> {
    return this.input.requesterBusy ? await this.input.requesterBusy() : undefined;
  }

  private hostsNow(): Promise<RuntimeHostActiveDescriptor[]> {
    return listActiveRuntimeHosts(this.paths, { exceptHostBootId: this.input.requesterHostBootId, classify: this.classify });
  }

  private answers(): Promise<Map<string, RuntimeExclusiveMaintenanceResponse>> {
    return readAnswers(this.paths, this.request!, this.hosts);
  }

  private async publish(next: Partial<RuntimeExclusiveMaintenanceRequest>): Promise<void> {
    if (!this.request) {
      const ownIdentity = ownProcessStartIdentity();
      const budgetMs = (this.whenBusy === 'wait' ? this.input.busyWaitTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.busyWaitTimeoutMs : 0)
        + (this.input.maxLockedAttempts ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.maxLockedAttempts) * (
          this.prepareTimeoutMs
          + (this.input.confirmTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.confirmTimeoutMs)
          + (this.input.releaseTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.releaseTimeoutMs));
      this.request = {
        kind: REQUEST_KIND,
        requestId: randomUUID(),
        round: 0,
        phase: 'prepare',
        operation: this.operationName,
        operationKey: this.operationKey,
        message: this.input.message,
        confirmation: this.input.participantConfirmation ?? 'countdown',
        whenBusy: this.whenBusy,
        requesterProcessId: process.pid,
        ...(ownIdentity !== undefined ? { requesterProcessStartIdentity: ownIdentity } : {}),
        ...(this.input.requesterHostBootId !== undefined ? { requesterHostBootId: this.input.requesterHostBootId } : {}),
        createdAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        // Advisory staleness bound for other processes; liveness and the heartbeat are checked as well.
        expiresAt: new Date(Date.now() + budgetMs + 10 * 60_000).toISOString()
      };
    }
    this.request = { ...this.request, ...next, heartbeatAt: new Date().toISOString() };
    await writeDurableJson(requestPath(this.paths, this.request.requestId), this.request);
    this.lastWrite = this.now();
    if (!this.waiting) {
      this.waiting = true;
      this.input.onWaitStart?.(this.hosts);
    }
  }

  private async heartbeat(): Promise<void> {
    if (!this.request || this.now() - this.lastWrite < EXCLUSIVE_MAINTENANCE_DEFAULTS.heartbeatMs) return;
    await this.publish({});
  }

  private endWait(): void {
    if (!this.waiting) return;
    this.waiting = false;
    this.input.onWaitEnd?.();
  }

  /** Cleanup never replaces the outcome: a failure is logged; a stale request is ignored later. */
  private async withdraw(): Promise<void> {
    const request = this.request;
    if (!request) return;
    const file = requestPath(this.paths, request.requestId);
    // Marked first, so a request that cannot be removed never makes a window count down again.
    await writeDurableJson(file, { ...request, phase: 'withdrawn', heartbeatAt: new Date().toISOString() }).catch(() => undefined);
    try {
      await removeWithRetry(file);
      await syncDirectoryDurably(path.dirname(file));
    } catch (error) {
      console.warn('[LimCode] 无法撤回独占维护请求；它已标记为撤回，稍后会被清理。', error);
    }
    await removeWithRetry(path.join(runtimeExclusiveMaintenanceDirectory(this.paths), RESPONSES_DIRECTORY, request.requestId), true)
      .catch((error) => console.warn('[LimCode] 无法清理独占维护的回应记录。', error));
  }
}

function busyHosts(
  hosts: readonly RuntimeHostActiveDescriptor[],
  answers: ReadonlyMap<string, RuntimeExclusiveMaintenanceResponse>
): ExclusiveMaintenanceBusyHost[] {
  return hosts.flatMap((host) => {
    const answer = answers.get(host.hostBootId);
    return answer?.answer === 'busy'
      ? [{ hostBootId: host.hostBootId, kind: answer.busyKind ?? 'work', reason: answer.reason ?? '有任务正在进行' }]
      : [];
  });
}

function busyReasonText(busy: readonly ExclusiveMaintenanceBusyHost[], own: ExclusiveMaintenanceBusy | undefined): string {
  const parts: string[] = [];
  if (own) parts.push(`本窗口${own.kind === 'focus' ? '正在使用' : '还有任务正在进行'}`);
  const working = busy.filter((item) => item.kind === 'work').length;
  const focused = busy.filter((item) => item.kind === 'focus').length;
  if (working > 0) parts.push(`${working} 个其它窗口有任务正在进行`);
  if (focused > 0) parts.push(`${focused} 个其它窗口正在使用`);
  return `${parts.join('，')}，暂不打扰。`;
}

export interface ExclusiveMaintenanceParticipantHandlers {
  /** Why this Host cannot yield now (running work, the user in this window…), or undefined when idle. */
  busyReason(request: RuntimeExclusiveMaintenanceRequest): Promise<ExclusiveMaintenanceBusy | undefined>;
  /** Countdown or notice before confirming; false only when the user cancelled a cancellable countdown. */
  confirm(request: RuntimeExclusiveMaintenanceRequest): Promise<boolean>;
  /** Yields the root: reload the window (its next startup waits on the admission). */
  release(request: RuntimeExclusiveMaintenanceRequest): Promise<void>;
  /** Wait-mode requests: told once, in advance, that this Host keeps the requester waiting and why. */
  notifyWaiting?(request: RuntimeExclusiveMaintenanceRequest, busy: ExclusiveMaintenanceBusy): void;
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
  const settledRounds = new Set<string>();
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
    busy?: ExclusiveMaintenanceBusy,
    reason?: string
  ): Promise<void> => {
    await writeResponse(paths, request, hostBootId, stage, answer, busy?.kind, busy?.reason ?? reason);
    answered.set(`${request.requestId}#${request.round}:${stage}`, `${answer}\0${busy?.kind ?? ''}\0${busy?.reason ?? ''}`);
  };
  const stillCurrentRequest = async (request: RuntimeExclusiveMaintenanceRequest): Promise<boolean> => {
    const still = (await readExclusiveMaintenanceRequests(paths, { classify })).find((item) => item.requestId === request.requestId);
    return current() && still?.round === request.round && still.phase === request.phase;
  };
  const handle = async (request: RuntimeExclusiveMaintenanceRequest): Promise<void> => {
    const round = `${request.requestId}#${request.round}`;
    if (request.phase === 'prepare') {
      const busy = await handlers.busyReason(request);
      const answer: ExclusiveMaintenanceAnswer = declinedRequests.has(request.requestId)
        ? 'declined' : busy ? 'busy' : 'ready';
      if (answered.get(`${round}:prepare`) === `${answer}\0${busy?.kind ?? ''}\0${busy?.reason ?? ''}`) return;
      if (busy && answer === 'busy' && request.whenBusy === 'wait' && !notified.has(request.requestId)) {
        notified.add(request.requestId);
        handlers.notifyWaiting?.(request, busy);
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
      // Withdrawn (another window declined, a timeout) or restarted while the countdown ran.
      if (!await stillCurrentRequest(request)) return;
      if (!confirmed && request.confirmation === 'countdown') {
        declinedRequests.add(request.requestId);
        await respond(request, 'confirm', 'declined', undefined, '用户选择保留本窗口');
        return;
      }
      const busyAfter = await handlers.busyReason(request);
      await respond(request, 'confirm', busyAfter ? 'busy' : 'confirmed', busyAfter);
      return;
    }
    if (request.phase === 'go') {
      // A round this window answered busy in (or already yielded in) never makes it reload.
      if (!answered.get(`${round}:confirm`)?.startsWith('confirmed\0') || settledRounds.has(round)) return;
      const busy = await handlers.busyReason(request);
      settledRounds.add(round);
      if (busy) {
        // Work started after this window confirmed: never interrupt it; the requester goes back.
        await respond(request, 'go', 'busy', busy);
        return;
      }
      await handlers.release(request);
    }
  };
  const check = async (): Promise<void> => {
    await registered;
    if (!current()) return;
    const requests = await readExclusiveMaintenanceRequests(paths, { classify });
    // Forget requests that are gone, so the bookkeeping stays bounded.
    const live = new Set(requests.map((request) => request.requestId));
    for (const key of [...answered.keys()]) if (!live.has(key.slice(0, key.indexOf('#')))) answered.delete(key);
    for (const key of [...settledRounds]) if (!live.has(key.slice(0, key.indexOf('#')))) settledRounds.delete(key);
    for (const set of [declinedRequests, notified]) for (const id of [...set]) if (!live.has(id)) set.delete(id);
    for (const request of requests) {
      if (!current()) return;
      if (request.requesterHostBootId === hostBootId
        || (request.requesterHostBootId === undefined && request.requesterProcessId === ownProcessId)) continue;
      await handle(request);
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
  await removeGoneParticipants(directory);
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

/**
 * The live requests: unexpired, not withdrawn, refreshed within staleRequestMs, and whose requester
 * process is still alive. Oldest first.
 */
export async function readExclusiveMaintenanceRequests(
  paths: RuntimeRootPaths,
  options: { classify?: RecordedProcessClassifier; staleRequestMs?: number } = {}
): Promise<RuntimeExclusiveMaintenanceRequest[]> {
  const directory = path.join(runtimeExclusiveMaintenanceDirectory(paths), REQUESTS_DIRECTORY);
  let names: string[];
  try { names = await fs.readdir(directory); }
  catch { return []; }
  const classify = options.classify ?? createCachedProcessClassifier();
  const staleMs = options.staleRequestMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.staleRequestMs;
  const requests: RuntimeExclusiveMaintenanceRequest[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const request = await readRequestFile(path.join(directory, name));
    if (!request || request.phase === 'withdrawn' || `${request.requestId}.json` !== name) continue;
    const now = Date.now();
    if (Date.parse(request.expiresAt) <= now) continue;
    const heartbeat = Date.parse(request.heartbeatAt);
    if (!Number.isFinite(heartbeat) || now - heartbeat > staleMs) continue;
    if (classify(request.requesterProcessId, request.requesterProcessStartIdentity) !== 'alive') continue;
    requests.push(request);
  }
  return requests.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.requestId.localeCompare(right.requestId));
}

async function readRequestFile(file: string): Promise<RuntimeExclusiveMaintenanceRequest | undefined> {
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown; }
  catch { return undefined; }
  const request = value as Partial<RuntimeExclusiveMaintenanceRequest> | undefined;
  if (!request || request.kind !== REQUEST_KIND
    || typeof request.requestId !== 'string' || !REQUEST_ID.test(request.requestId)
    || !Number.isSafeInteger(request.round) || (request.round as number) < 1
    || !['prepare', 'confirm', 'go', 'withdrawn'].includes(request.phase as string)
    || typeof request.operation !== 'string' || typeof request.operationKey !== 'string'
    || typeof request.message !== 'string'
    || !['countdown', 'final-countdown', 'notice'].includes(request.confirmation as string)
    || (request.whenBusy !== 'abandon' && request.whenBusy !== 'wait')
    || !Number.isSafeInteger(request.requesterProcessId) || (request.requesterProcessId as number) <= 0
    || (request.requesterHostBootId !== undefined && typeof request.requesterHostBootId !== 'string')
    || typeof request.createdAt !== 'string' || typeof request.heartbeatAt !== 'string'
    || typeof request.expiresAt !== 'string' || !Number.isFinite(Date.parse(request.expiresAt))) return undefined;
  return request as RuntimeExclusiveMaintenanceRequest;
}

/**
 * Leftovers of requesters that crashed or could not clean up: requests of dead requesters or past
 * their expiry, withdrawn ones, and response directories without a request.
 */
async function sweepAbandonedRequests(paths: RuntimeRootPaths, classify: RecordedProcessClassifier): Promise<void> {
  const root = runtimeExclusiveMaintenanceDirectory(paths);
  const requestsDirectory = path.join(root, REQUESTS_DIRECTORY);
  const present = new Set<string>();
  for (const name of await fs.readdir(requestsDirectory).catch(() => [] as string[])) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(requestsDirectory, name);
    const request = await readRequestFile(file);
    const abandoned = !request || request.phase === 'withdrawn' || Date.parse(request.expiresAt) <= Date.now()
      || classify(request.requesterProcessId, request.requesterProcessStartIdentity) === 'dead';
    if (abandoned) await removeWithRetry(file).catch(() => undefined);
    else present.add(request.requestId);
  }
  const responses = path.join(root, RESPONSES_DIRECTORY);
  for (const name of await fs.readdir(responses).catch(() => [] as string[])) {
    if (!present.has(name)) await removeWithRetry(path.join(responses, name), true).catch(() => undefined);
  }
}

/**
 * Every Host must be live and registered as a participant with the same process. One that started
 * within the grace (the prepare timeout) without a registration yet is waited for like a missing answer.
 */
async function hostsOutsideProtocol(
  paths: RuntimeRootPaths,
  hosts: readonly RuntimeHostActiveDescriptor[],
  graceMs: number
): Promise<RuntimeHostActiveDescriptor[]> {
  const directory = path.join(runtimeExclusiveMaintenanceDirectory(paths), PARTICIPANTS_DIRECTORY);
  const outsiders: RuntimeHostActiveDescriptor[] = [];
  for (const host of hosts) {
    if (host.state !== 'live' || host.processId === null || !SAFE_ID.test(host.hostBootId)) {
      outsiders.push(host);
      continue;
    }
    let record: Record<string, unknown>;
    try { record = JSON.parse(await fs.readFile(path.join(directory, `${host.hostBootId}.json`), 'utf8')) as Record<string, unknown>; }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' || !startedWithin(host, graceMs)) outsiders.push(host);
      continue;
    }
    if (record.kind !== PARTICIPANT_KIND || record.hostBootId !== host.hostBootId || record.processId !== host.processId
      || (host.processStartIdentity !== undefined && record.processStartIdentity !== host.processStartIdentity)) {
      outsiders.push(host);
    }
  }
  return outsiders;
}

function startedWithin(host: RuntimeHostActiveDescriptor, graceMs: number): boolean {
  const age = Date.now() - (host.startedAt === undefined ? Number.NaN : Date.parse(host.startedAt));
  return Number.isFinite(age) && age > -60_000 && age < graceMs;
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
    if (!SAFE_ID.test(host.hostBootId)) continue;
    let value: Partial<RuntimeExclusiveMaintenanceResponse>;
    try {
      value = JSON.parse(await fs.readFile(responsePath(paths, request.requestId, host.hostBootId), 'utf8')) as Partial<RuntimeExclusiveMaintenanceResponse>;
    } catch { continue; }
    if (value.kind !== RESPONSE_KIND || value.requestId !== request.requestId || value.round !== request.round
      || value.hostBootId !== host.hostBootId) continue;
    // Only answers to the current phase count; a busy answer at a later stage is always relevant.
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
  busyKind?: ExclusiveMaintenanceBusyKind,
  reason?: string
): Promise<void> {
  const response: RuntimeExclusiveMaintenanceResponse = {
    kind: RESPONSE_KIND,
    requestId: request.requestId,
    round: request.round,
    hostBootId: safeName(hostBootId),
    stage,
    answer,
    ...(busyKind !== undefined ? { busyKind } : {}),
    ...(reason !== undefined ? { reason } : {}),
    respondedAt: new Date().toISOString()
  };
  await writeDurableJson(responsePath(paths, request.requestId, hostBootId), response);
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

/**
 * Registrations of processes that are proven gone (`kill(pid, 0)` finds nothing). No platform
 * identity probe here: a record of a reused pid is harmless (Hosts are matched by their liveness
 * record) and is removed once that pid is gone too.
 */
async function removeGoneParticipants(directory: string): Promise<void> {
  let names: string[];
  try { names = await fs.readdir(directory); }
  catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(directory, name);
    try {
      const record = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      if (typeof record.processId === 'number' && processGone(record.processId)) await removeWithRetry(file);
    } catch { /* A concurrently replaced record is left for its owner. */ }
  }
}

function processGone(processId: number): boolean {
  if (!Number.isSafeInteger(processId) || processId <= 0) return true;
  try {
    process.kill(processId, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ESRCH';
  }
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

function requestPath(paths: RuntimeRootPaths, requestId: string): string {
  return path.join(runtimeExclusiveMaintenanceDirectory(paths), REQUESTS_DIRECTORY, `${requestId}.json`);
}

function responsePath(paths: RuntimeRootPaths, requestId: string, hostBootId: string): string {
  return path.join(runtimeExclusiveMaintenanceDirectory(paths), RESPONSES_DIRECTORY, requestId, `${safeName(hostBootId)}.json`);
}

function ledgerDirectory(paths: RuntimeRootPaths): string {
  return path.join(runtimeExclusiveMaintenanceDirectory(paths), LEDGER_DIRECTORY);
}

function safeName(value: string): string {
  if (!SAFE_ID.test(value)) throw new TypeError('Host boot id is not a safe file name.');
  return value;
}

function requireText(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
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
