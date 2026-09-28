import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import type { RuntimeRootPaths } from './contracts';
import {
  classifyRecordedProcess, createCachedProcessClassifier, delay, ownProcessStartIdentity, type RecordedProcessClassifier
} from './runtimeClaimPrimitives';
import {
  assertRuntimeHostsOffline, isRuntimeDataRootAdmissionHeld, isRuntimeMaintenanceHeld, listActiveRuntimeHosts,
  withRuntimeMaintenanceActivity, type RuntimeHostActiveDescriptor, type RuntimeMaintenanceActivityHandle
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
 * unknown/legacy Host, timeout or cancel withdraws the request before anybody yields; once go was
 * published a busy window ends the call, so a window reloads at most once per call. A window that
 * is closing or reloading meanwhile is absent, never an older version: the requester waits (bounded)
 * until its Runtime closed. Two requesters
 * never wait for each other: a window with a running request answers busy to the others, and the
 * later request gives way to an earlier one. Abandoned attempts and failures after go back off per
 * operation key, a deterministic failure blocks the key for automatic calls, and a coordinated round
 * starts a cooldown per operation, so windows can never keep reloading each other. While it holds
 * the locks the requester publishes what it does (withRuntimeMaintenanceActivity), so windows waiting
 * to open can say why. The requests are advisory: exclusivity is still proven by the Host liveness
 * records alone.
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
  /**
   * A window that is closing or reloading (its registration says leaving, or it answered in this
   * call and then unregistered) is absent: the requester waits this long for its Host liveness
   * record to go instead of taking it for an older version.
   */
  leavingGraceMs: 30_000,
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
 * With final-countdown and notice only work keeps a window from confirming or yielding, not focus.
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
  /** Busy with its own exclusive maintenance request (which work: other requesters tell same work apart). */
  maintenance?: ExclusiveMaintenanceWork;
}

/** Which work a request is for. */
export interface ExclusiveMaintenanceWork {
  operation: string;
  operationKey: string;
  activity: string;
  /** How that request treats busy windows (absent: not published yet, or an earlier build). */
  whenBusy?: ExclusiveMaintenanceBusyPolicy;
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
  /** User-facing name of the work, completing “另一个窗口正在…” and “本窗口正在等待执行…”. */
  activity: string;
  confirmation: ExclusiveMaintenanceConfirmation;
  whenBusy: ExclusiveMaintenanceBusyPolicy;
  requesterProcessId: number;
  requesterProcessStartIdentity?: string;
  /** Present when the requester's own window stays registered on this root while it requests. */
  requesterHostBootId?: string;
  /** With requestId, the order between requesters: the earlier one goes on, a later one gives way. */
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
  /** Busy because this window's own request runs, for this work. */
  maintenance?: ExclusiveMaintenanceWork;
  respondedAt: string;
}

export interface ExclusiveMaintenanceBusyHost extends ExclusiveMaintenanceBusy {
  hostBootId: string;
  /** Registered while its Runtime opened, not answering yet (see registerExclusiveMaintenanceParticipant). */
  opening?: boolean;
}

export interface ExclusiveMaintenanceProgress {
  stage: 'prepare' | 'waiting-busy' | 'confirm' | 'release';
  hosts: readonly RuntimeHostActiveDescriptor[];
  busy: readonly ExclusiveMaintenanceBusyHost[];
  /** The requester's own window is busy (see requesterBusy). */
  requesterBusy?: ExclusiveMaintenanceBusy;
  /** Windows closing or reloading on their own, waited for until their Runtime closed. */
  leaving?: readonly RuntimeHostActiveDescriptor[];
}

/** What beforeGo found: the requester's own window froze (thaw undoes it) and is idle, or is busy. */
export interface ExclusiveMaintenanceGoCheck {
  /** The requester's own window is not idle: no window yields in this round. */
  busy?: ExclusiveMaintenanceBusy;
  /** Undoes the freeze; called once when the locked round ends, whether or not the operation ran. */
  thaw?(): void | Promise<void>;
}

export interface ExclusiveMaintenanceOperationContext {
  /** Replaces the stage that windows waiting to open show (the maintenance activity marker). */
  reportStage(stage: string | undefined): void;
  /**
   * When the operation expects to be done (ISO time; undefined clears it), in the same marker:
   * waiting windows show it and, while its heartbeat stays fresh, warn only well after it.
   */
  reportExpectedEnd(at: string | undefined): void;
}

export interface RuntimeExclusiveMaintenanceInput {
  operation: string;
  /**
   * Defaults to `operation`; pass the identity of the work so a different work is not delayed. It
   * should include what changes once the cause of a failure is fixed (a source's content state, the
   * target directory's identity), so a fixed problem is a new key; see clearExclusiveMaintenanceKey.
   */
  operationKey?: string;
  message: string;
  /** User-facing name of the work (“迁移数据目录”); defaults to `message` without a leading “为”. */
  activity?: string;
  /**
   * Required on every call, never inferred from stored state: true only for the one call made for
   * an explicit user action. It skips the per-key backoff and a blocked key. The cooldown after a go
   * holds off every call of the operation, whatever its key (a key may carry the attempt's own id);
   * only an explicit call carrying the requesterToken of the call that published that go passes
   * (the user retrying in the window that asked, also after it reloaded, on any target). Windows
   * that yielded never make the others yield right back.
   */
  ignoreBackoff: boolean;
  /**
   * Identifies the requesting window's user operation (this operation name) across its reloads; the
   * VS Code layer keeps it in workspaceState until the operation completes. Recorded with the
   * cooldown when go is published.
   */
  requesterToken?: string;
  /** The requester's own registered Host when it stays open while requesting (e.g. a migration). */
  requesterHostBootId?: string;
  /**
   * The requester's own window: work that the operation would interrupt (its own Runtime closes
   * for a migration). Checked while preparing and confirming, like another window's busy answer, and
   * again while other windows yield and right before the operation.
   */
  requesterBusy?(): Promise<ExclusiveMaintenanceBusy | undefined>;
  /**
   * Called once everything is ready (every other window confirmed, or none is left), before go is
   * published and before the operation: check that the requester's own window is idle first, then
   * freeze it (no new work starts) doing only what cannot fail afterwards, and return the thaw.
   * Busy sends the requester back outside the locks (wait) or abandons, before any window reloads;
   * a hook that throws counts as busy (whatever it froze before throwing it must undo itself).
   */
  beforeGo?(): Promise<ExclusiveMaintenanceGoCheck>;
  /** When given, the configuration admission of this root is part of the locks. */
  configurationRootPath?: string;
  participantConfirmation?: ExclusiveMaintenanceConfirmation;
  whenBusy?: ExclusiveMaintenanceBusyPolicy;
  /** A failure of the operation that will fail the same way again: automatic calls of the key are blocked. */
  isDeterministicFailure?(error: unknown): boolean;
  pollMs?: number;
  prepareTimeoutMs?: number;
  busyWaitTimeoutMs?: number;
  confirmTimeoutMs?: number;
  releaseTimeoutMs?: number;
  leavingGraceMs?: number;
  maxLockedAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  cooldownAfterCoordinatedMs?: number;
  /**
   * Checked until go is published. From then on other windows reload whatever happens here, so a
   * cancel is ignored and the operation goes on.
   */
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

/** superseded: another request (asked earlier) is for the same work and does it; no backoff, nothing to announce. */
export type RuntimeExclusiveMaintenanceAbandonState =
  'busy' | 'declined' | 'legacy-host' | 'timed-out' | 'cancelled' | 'backoff' | 'blocked' | 'superseded';

export type RuntimeExclusiveMaintenanceOutcome<T> =
  /** coordinated: go was published, so other windows reloaded for this operation (a request alone is not). */
  | { state: 'completed'; result: T; coordinated: boolean }
  | {
    state: RuntimeExclusiveMaintenanceAbandonState;
    hosts: RuntimeHostActiveDescriptor[];
    /** User-facing reason in Chinese. */
    reason: string;
    /** For backoff: when a retry is allowed again (also written in the reason). */
    retryAfter?: string;
    /** This request gave way to that earlier request (its requestId). */
    gaveWayTo?: string;
  };

export type ExclusiveMaintenanceOperation<T> = (context: ExclusiveMaintenanceOperationContext) => Promise<T>;

/** A failed platform probe ('unknown') is trusted this long before that process is probed again. */
export const UNKNOWN_PROCESS_RECHECK_MS = 5_000;

/**
 * The process classifier of the protocol's long-lived loops (a participant runs as long as its
 * window): cached like createCachedProcessClassifier, except that 'unknown' (e.g. a start-identity
 * probe that failed once) is kept only briefly and then probed again, so one failed probe never
 * leaves a window deaf to a requester, or a requester blind to a window, until it reloads.
 */
export function createProtocolProcessClassifier(
  probe: RecordedProcessClassifier = classifyRecordedProcess,
  unknownRecheckMs = UNKNOWN_PROCESS_RECHECK_MS,
  now: () => number = () => performance.now()
): RecordedProcessClassifier {
  const perProcess = new Map<string, { classify: RecordedProcessClassifier; unknownSince?: number }>();
  return (processId, processStartIdentity) => {
    const key = `${processId}\0${processStartIdentity ?? ''}`;
    let entry = perProcess.get(key);
    if (!entry || (entry.unknownSince !== undefined && now() - entry.unknownSince >= unknownRecheckMs)) {
      entry = { classify: createCachedProcessClassifier(probe) };
      perProcess.set(key, entry);
    }
    const state = entry.classify(processId, processStartIdentity);
    if (state === 'unknown') entry.unknownSince ??= now();
    return state;
  };
}

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
  operation: ExclusiveMaintenanceOperation<T>
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
 * one short locked round. When a window became busy before go, the locks are released and it
 * waits outside again, at most maxLockedAttempts times. Windows keep opening meanwhile.
 */
export async function runExclusiveRuntimeMaintenance<T>(
  paths: RuntimeRootPaths,
  input: RuntimeExclusiveMaintenanceRunInput,
  operation: ExclusiveMaintenanceOperation<T>
): Promise<RuntimeExclusiveMaintenanceOutcome<T>> {
  if (typeof input.withLocks !== 'function') throw new TypeError('withLocks must be a function.');
  if (isRuntimeMaintenanceHeld(paths)
    || (input.configurationRootPath !== undefined && isRuntimeDataRootAdmissionHeld(input.configurationRootPath))) {
    throw new Error('等待其它窗口空闲必须在 admission 与 maintenance 之外进行；锁内请用 requestExclusiveRuntimeMaintenance。');
  }
  return new ExclusiveMaintenanceRequester(paths, input, operation).run(input.withLocks);
}

/**
 * Forgets the backoff and a blocked mark of one operation key, e.g. once the user fixed the cause.
 * An explicit call (ignoreBackoff) runs a blocked key anyway and clears it when it succeeds.
 */
export async function clearExclusiveMaintenanceKey(paths: RuntimeRootPaths, operation: string, operationKey: string): Promise<void> {
  await removeWithRetry(path.join(ledgerDirectory(paths), keyLedgerName(requireText(operation, 'operation'), requireText(operationKey, 'operationKey'))));
}

/** Why a call made now would be refused before any window is asked (readExclusiveMaintenanceRefusal). */
export interface ExclusiveMaintenanceRefusal {
  state: 'backoff' | 'blocked' | 'legacy-host';
  /** The reason the call would give, with when it can be tried again. */
  reason: string;
  /** When the backoff or cooldown runs out (ISO); absent for a blocked key. */
  retryAfter?: string;
}

/**
 * Read-only; it records and decides nothing: whether a call of this operation made now would be
 * refused before it asks any window — a key blocked for automatic calls, or, while other windows
 * are open, the operation's cooldown or the key's backoff (automatic calls), or a window outside
 * the protocol (an older version, or one whose state cannot be told: 'legacy-host', the same
 * registration grace as the call's prepare timeout) — with the reason the call would give, so a
 * caller can say so before asking the user anything or preparing anything (a countdown). Without
 * an operationKey only the cooldown and the windows are looked at. The call itself checks all of
 * it again.
 */
export async function readExclusiveMaintenanceRefusal(
  paths: RuntimeRootPaths,
  input: Pick<RuntimeExclusiveMaintenanceInput,
    'operation' | 'operationKey' | 'ignoreBackoff' | 'requesterToken' | 'requesterHostBootId' | 'backoffMaxMs' | 'cooldownAfterCoordinatedMs'
    | 'prepareTimeoutMs'>
): Promise<ExclusiveMaintenanceRefusal | undefined> {
  const operation = requireText(input.operation, 'operation');
  const operationKey = input.operationKey === undefined ? undefined : requireText(input.operationKey, 'operationKey');
  if (operationKey !== undefined && !input.ignoreBackoff) {
    const blocked = await readKeyBlock(paths, operation, operationKey);
    if (blocked) return { state: 'blocked', reason: blocked };
  }
  // As the call's gate: backoff and cooldown hold only while other windows would be asked.
  const others = await listActiveRuntimeHosts(paths, input.requesterHostBootId !== undefined ? { exceptHostBootId: input.requesterHostBootId } : {});
  if (others.length === 0) return undefined;
  const refusal = await readActiveBackoff(paths, operation, operationKey, input);
  if (refusal) return { state: 'backoff', reason: refusal.reason, retryAfter: refusal.until };
  // As the call's gate, right after the backoff: a window outside the protocol ends it at once.
  const { outsiders } = await hostStandings(paths, others, input.prepareTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.prepareTimeoutMs, undefined);
  return outsiders.length > 0 ? { state: 'legacy-host', reason: outsideProtocolReason(outsiders) } : undefined;
}

function assertLocksHeld(paths: RuntimeRootPaths, input: RuntimeExclusiveMaintenanceInput): void {
  if (!isRuntimeMaintenanceHeld(paths)) {
    throw new Error('独占维护必须在目标数据集的 maintenance 锁内发起。');
  }
  if (input.configurationRootPath !== undefined && !isRuntimeDataRootAdmissionHeld(input.configurationRootPath)) {
    throw new Error('独占维护必须在配置根的 admission 内发起。');
  }
}

/**
 * Requests of this process by requester window. A window's own participant answers busy to other
 * requests while one is running (a reload would drop it silently), also before it is published.
 */
interface LocalRequest extends ExclusiveMaintenanceWork {
  request?: RuntimeExclusiveMaintenanceRequest;
}
const LOCAL_REQUESTS = new Map<string, LocalRequest[]>();

function registerLocalRequest(hostBootId: string | undefined, local: LocalRequest): () => void {
  if (hostBootId === undefined) return () => undefined;
  LOCAL_REQUESTS.set(hostBootId, [...(LOCAL_REQUESTS.get(hostBootId) ?? []), local]);
  return () => {
    const rest = (LOCAL_REQUESTS.get(hostBootId) ?? []).filter((item) => item !== local);
    if (rest.length > 0) LOCAL_REQUESTS.set(hostBootId, rest);
    else LOCAL_REQUESTS.delete(hostBootId);
  };
}

/**
 * Holds this window's own exclusive operation from before it asks: once the user agreed to it and
 * while it prepares (which may take minutes) until it ended. Meanwhile this window's participant
 * answers busy to other requests and never yields, as while the request itself runs (“本窗口正在
 * 等待执行…”), so another window's maintenance cannot reload it in the middle of the preparation.
 * Returns the release (idempotent).
 */
export function holdExclusiveMaintenanceWork(hostBootId: string, work: ExclusiveMaintenanceWork): () => void {
  const release = registerLocalRequest(hostBootId, {
    operation: requireText(work.operation, 'operation'), operationKey: requireText(work.operationKey, 'operationKey'),
    activity: requireText(work.activity, 'activity')
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

/** The order between two live requests: createdAt, then requestId. */
function precedes(left: Pick<RuntimeExclusiveMaintenanceRequest, 'createdAt' | 'requestId'>, right: Pick<RuntimeExclusiveMaintenanceRequest, 'createdAt' | 'requestId'>): boolean {
  return left.createdAt < right.createdAt || (left.createdAt === right.createdAt && left.requestId < right.requestId);
}

/**
 * Of two requests for the same work, whether the later one gives way to the earlier: at once,
 * unless only the later one would wait for busy windows while the earlier one, still in prepare,
 * abandons on busy — it would end at the first busy window and neither of them did the work.
 */
function laterGivesWayToSameWork(later: { whenBusy?: ExclusiveMaintenanceBusyPolicy }, earlier: RuntimeExclusiveMaintenanceRequest): boolean {
  return earlier.whenBusy === 'wait' || earlier.phase !== 'prepare' || later.whenBusy !== 'wait';
}

/**
 * A later request gives way to an earlier one that will not give up by itself: one that waits for
 * busy windows, or one already past prepare (it holds the locks and windows confirmed it). An
 * earlier request that abandons on busy ends as soon as it sees the later requester's window busy.
 */
function givesWayTo(own: LocalRequest, other: RuntimeExclusiveMaintenanceRequest): boolean {
  return (own.request === undefined || precedes(other, own.request)) && (other.whenBusy === 'wait' || other.phase !== 'prepare');
}

function activityOf(message: string): string {
  return message.replace(/^为/, '');
}

type Outcome<T> = RuntimeExclusiveMaintenanceOutcome<T>;
type AbandonOutcome = Extract<Outcome<never>, { hosts: RuntimeHostActiveDescriptor[] }>;
/** A window became busy during the locked round in wait mode: release the locks and wait outside. */
const RETRY = Symbol('retry-outside-the-locks');
type Step = 'ready' | typeof RETRY | AbandonOutcome;

interface BusyObservation {
  busy: readonly ExclusiveMaintenanceBusyHost[];
  own?: ExclusiveMaintenanceBusy;
}

class ExclusiveMaintenanceRequester<T> {
  private readonly operationName: string;
  private readonly operationKey: string;
  private readonly activity: string;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly prepareTimeoutMs: number;
  private readonly whenBusy: ExclusiveMaintenanceBusyPolicy;
  private readonly classify = createProtocolProcessClassifier();
  private readonly busyDeadline: number;
  private readonly local: LocalRequest;
  private readonly leavingGraceMs: number;
  /** The other windows that answer (see refreshHosts). */
  private hosts: RuntimeHostActiveDescriptor[] = [];
  /** Other windows closing or reloading: absent, only their Host liveness record has to go. */
  private leaving: RuntimeHostActiveDescriptor[] = [];
  /** Answering windows outside the protocol, as of the last refreshHosts. */
  private outsiders: RuntimeHostActiveDescriptor[] = [];
  /** Present windows still opening (registered, not answering yet), as of the last refreshHosts. */
  private opening = new Set<string>();
  /** When each leaving window was first seen leaving: the grace runs from then. */
  private readonly leavingSince = new Map<string, number>();
  private request: RuntimeExclusiveMaintenanceRequest | undefined;
  private lastWrite = Number.NEGATIVE_INFINITY;
  private waiting = false;
  private gated = false;
  /** Why the last locked round went back outside; the reason when the attempts run out. */
  private lastBusy: BusyObservation | undefined;
  private thawFreeze: (() => void | Promise<void>) | undefined;

  public constructor(
    private readonly paths: RuntimeRootPaths,
    private readonly input: RuntimeExclusiveMaintenanceInput,
    private readonly operation: ExclusiveMaintenanceOperation<T>
  ) {
    if (typeof input.ignoreBackoff !== 'boolean') {
      throw new TypeError('ignoreBackoff must be passed explicitly on every call.');
    }
    this.operationName = requireText(input.operation, 'operation');
    this.operationKey = requireText(input.operationKey ?? input.operation, 'operationKey');
    requireText(input.message, 'message');
    this.activity = requireText(input.activity ?? activityOf(input.message), 'activity');
    this.now = input.now ?? (() => performance.now());
    this.pollMs = input.pollMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.pollMs;
    this.prepareTimeoutMs = input.prepareTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.prepareTimeoutMs;
    this.whenBusy = input.whenBusy ?? 'abandon';
    this.busyDeadline = this.now() + (input.busyWaitTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.busyWaitTimeoutMs);
    this.leavingGraceMs = input.leavingGraceMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.leavingGraceMs;
    this.local = { operation: this.operationName, operationKey: this.operationKey, activity: this.activity, whenBusy: this.whenBusy };
  }

  public async run(withLocks: RuntimeExclusiveMaintenanceRunInput['withLocks'] | undefined): Promise<Outcome<T>> {
    const unregister = registerLocalRequest(this.input.requesterHostBootId, this.local);
    try {
      // A blocked key stops automatic calls only; the user's explicit call runs it and clears it on success.
      if (!this.input.ignoreBackoff) {
        const blocked = await readKeyBlock(this.paths, this.operationName, this.operationKey);
        if (blocked) return { state: 'blocked', hosts: [], reason: blocked };
      }
      await sweepAbandonedRequests(this.paths, this.classify).catch(() => undefined);
      if (!withLocks) return await this.lockedRound() as Outcome<T>;
      const maxAttempts = Math.max(1, this.input.maxLockedAttempts ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.maxLockedAttempts);
      for (let attempt = 1; ; attempt += 1) {
        await this.refreshHosts();
        if (this.hosts.length > 0 || this.leaving.length > 0 || await this.requesterBusy()) {
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
          return await this.abandon('busy', this.hosts, repeatedBusyReason(this.lastBusy));
        }
      }
    } finally {
      this.endWait();
      await this.withdraw();
      unregister();
    }
  }

  /**
   * The short part under the locks: prepare, confirm, beforeGo, go, operation. Every step has a
   * limit. Windows waiting to open meanwhile see what it does (the maintenance activity marker).
   */
  private lockedRound(): Promise<Outcome<T> | typeof RETRY> {
    return withRuntimeMaintenanceActivity({
      operation: this.operationName, description: this.activity, stage: '正在请其它窗口让出'
    }, async (activity): Promise<Outcome<T> | typeof RETRY> => {
      await this.refreshHosts();
      if (this.hosts.length > 0 || this.leaving.length > 0 || await this.requesterBusy()) {
        const refused = await this.gate();
        if (refused) return refused;
        await this.publish({ phase: 'prepare', round: (this.request?.round ?? 0) + 1 });
        const prepared = await this.prepare(true);
        if (prepared !== 'ready') return prepared;
        if (this.hosts.length > 0) {
          const confirmed = await this.confirm();
          if (confirmed !== 'ready') return confirmed;
        }
      }
      const frozen = await this.freeze();
      if (frozen !== 'ready') return frozen;
      try {
        // Only a published go makes windows reload: until then a busy requester goes back outside.
        // Windows closing or reloading on their own are not told to go; they only have to be gone.
        const goPublished = this.hosts.length > 0;
        if (goPublished || this.leaving.length > 0) {
          const released = await this.release(goPublished);
          if (released !== 'ready') return released;
        }
        // Last check: the requester's own window started nothing since beforeGo.
        const own = await this.requesterBusy();
        if (own) {
          return goPublished
            ? await this.abandon('busy', [], goBusyReason([], own))
            : (await this.whenBusyStep([], own, true)) as AbandonOutcome | typeof RETRY;
        }
        this.endWait();
        activity.report(undefined);
        return this.completed(await this.execute(goPublished, activity), goPublished);
      } finally {
        await this.thaw();
      }
    });
  }

  /** Once per requester while other windows are involved: backoff, cooldown, older windows. */
  private async gate(): Promise<AbandonOutcome | undefined> {
    if (this.gated || (this.hosts.length === 0 && this.leaving.length === 0)) return undefined;
    this.gated = true;
    const refusal = await readActiveBackoff(this.paths, this.operationName, this.operationKey, this.input);
    if (refusal) return { state: 'backoff', hosts: this.hosts, reason: refusal.reason, retryAfter: refusal.until };
    if (this.outsiders.length > 0) return this.abandon('legacy-host', this.outsiders, outsideProtocolReason(this.outsiders));
    return undefined;
  }

  /**
   * Until everyone (and the requester itself) answered ready. Locked: a busy one is never waited for
   * here. Outside the locks a window closing or reloading is waited for (bounded) until its Runtime
   * closed; in the locked round it is absent and only has to be gone before the operation (release).
   */
  private async prepare(locked: boolean): Promise<Step> {
    const started = this.now();
    const firstSeen = new Map<string, number>();
    for (;;) {
      if (this.input.isCancelled?.()) return this.abandon('cancelled', this.hosts, '已取消。');
      await this.heartbeat();
      // Two requesters never wait for each other: the later one gives way, with the reason (this
      // window's own earlier request, e.g. a large merge still waiting, is named as such).
      const { earlier, earlierSameWork } = await this.earlierRequests();
      if (earlier && this.sameWork(earlier)) {
        // The same work, asked for earlier: that request does it. Nothing to announce, no backoff.
        return {
          state: 'superseded', hosts: [], gaveWayTo: earlier.requestId,
          reason: `${this.isOwnWindow(earlier) ? '本窗口' : '另一个窗口'}正在进行同一项维护（${earlier.activity}），这次由它完成。`
        };
      }
      if (earlier) {
        const outcome = await this.abandon('busy', this.hosts, this.isOwnWindow(earlier)
          ? `本窗口正在等待执行${earlier.activity}，这次没有进行，完成后再试。`
          : `另一个窗口先发起了${earlier.activity}，这次让它先完成，没有进行；之后可以再试。`);
        return { ...outcome, gaveWayTo: earlier.requestId };
      }
      await this.refreshHosts();
      const own = await this.requesterBusy();
      const leaving = locked ? [] : this.leaving;
      if (this.hosts.length === 0 && leaving.length === 0 && !own) return 'ready';
      // A window that opened just before (or, outside the locks, during) the request registers and
      // answers within the prepare timeout; one still unregistered afterwards is an older version.
      if (this.outsiders.length > 0) return this.abandon('legacy-host', this.outsiders, outsideProtocolReason(this.outsiders));
      const answers = await this.answers();
      const declined = this.hosts.filter((host) => answers.get(host.hostBootId)?.answer === 'declined');
      if (declined.length > 0) return this.abandon('declined', declined, '其它窗口的用户选择了保留窗口。');
      // A window busy with its own later request for this same work that gives way to this one (see
      // superseded) is waited for like a missing answer, never counted as busy. One that does not
      // give way (it waits, this one abandons and is still in prepare) or whose request is earlier is busy.
      const pendingSameWork = new Set(busyHosts(this.hosts, answers)
        .filter((item) => item.maintenance && this.sameWork(item.maintenance) && !earlierSameWork.has(item.hostBootId)
          && laterGivesWayToSameWork(item.maintenance, this.request!))
        .map((item) => item.hostBootId));
      const busy = this.busyOf(answers).filter((item) => !pendingSameWork.has(item.hostBootId));
      // A window still opening is busy (it answers once its participant started), never missing.
      const missing = this.hosts.filter((host) => !this.opening.has(host.hostBootId)
        && (!answers.has(host.hostBootId) || pendingSameWork.has(host.hostBootId)));
      for (const host of this.hosts) if (!firstSeen.has(host.hostBootId)) firstSeen.set(host.hostBootId, this.now());
      if (busy.length === 0 && !own && missing.length === 0 && leaving.length === 0) return 'ready';
      if (busy.length > 0 || own) {
        const step = await this.whenBusyStep(busy, own, locked);
        if (step) return step;
      }
      const overdue = missing.filter((host) => this.now() - Math.max(started, firstSeen.get(host.hostBootId)!) >= this.prepareTimeoutMs);
      if (overdue.length > 0) return this.abandon('timed-out', overdue, '其它窗口没有及时回应。');
      const stuck = locked ? [] : this.stuckLeaving();
      if (stuck.length > 0) return this.abandon('timed-out', stuck, LEAVING_TIMEOUT_REASON);
      this.input.onProgress?.({
        stage: busy.length > 0 || own ? 'waiting-busy' : 'prepare',
        hosts: this.hosts,
        busy,
        ...(own ? { requesterBusy: own } : {}),
        ...(leaving.length > 0 ? { leaving } : {})
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
      // A window closing or reloading meanwhile no longer confirms; release waits until it is gone.
      await this.refreshHosts();
      if (this.hosts.length === 0) return 'ready';
      const answers = await this.answers();
      const declined = this.hosts.filter((host) => answers.get(host.hostBootId)?.answer === 'declined');
      if (declined.length > 0) return this.abandon('declined', declined, '其它窗口的用户选择了保留窗口。');
      const busy = this.busyOf(answers);
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

  /** beforeGo: the requester freezes its own window and says whether it is idle; nobody yielded yet. */
  private async freeze(): Promise<Step> {
    if (!this.input.beforeGo) return 'ready';
    let check: ExclusiveMaintenanceGoCheck | undefined;
    try {
      check = await this.input.beforeGo();
    } catch (error) {
      // The requester could not tell whether its window is idle: nobody yields this round.
      console.warn('[LimCode] 独占维护发布 go 前检查本窗口失败，按忙处理。', error);
      return (await this.whenBusyStep([], { kind: 'work', reason: `无法确认本窗口是否空闲：${describeError(error)}` }, true))!;
    }
    this.thawFreeze = check?.thaw ? () => check!.thaw!() : undefined;
    if (!check?.busy) return 'ready';
    await this.thaw();
    return (await this.whenBusyStep([], check.busy, true))!;
  }

  private async thaw(): Promise<void> {
    const thaw = this.thawFreeze;
    this.thawFreeze = undefined;
    if (!thaw) return;
    try { await thaw(); }
    catch (error) { console.warn('[LimCode] 独占维护结束后恢复本窗口失败。', error); }
  }

  /**
   * Every window confirmed; each now yields (goPublished; without it only windows closing or
   * reloading on their own are left, and they are waited for). A window (or the requester itself)
   * that is busy after go ends this call: no second round, so no window reloads twice for one
   * operation. Windows that already reloaded did so in vain: their next startup waits on the
   * admission until this requester lets go, their unsent input is kept, and the cooldown holds off
   * automatic retries.
   */
  private async release(goPublished: boolean): Promise<Step> {
    if (goPublished) {
      await this.publish({ phase: 'go' });
      // From here windows reload: a later request of this operation must not make them reload again soon.
      await recordOperationCooldown(this.paths, this.operationName, this.operationKey, this.input);
    }
    const deadline = this.now() + (this.input.releaseTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.releaseTimeoutMs);
    for (;;) {
      // Once go is published windows reload anyway: a cancel would only make that in vain.
      if (!goPublished && this.input.isCancelled?.()) return this.abandon('cancelled', this.leaving, '已取消。');
      await this.heartbeat();
      await this.refreshHosts();
      const busy = this.hosts.length > 0 ? this.busyOf(await this.answers()) : [];
      const own = await this.requesterBusy();
      if (busy.length > 0 || own) {
        if (!goPublished) return (await this.whenBusyStep(busy, own, true))!;
        return this.abandon('busy', this.hosts.filter((host) => busy.some((item) => item.hostBootId === host.hostBootId)), goBusyReason(busy, own));
      }
      // Windows that yielded are leaving until their Runtime closed.
      if (this.hosts.length === 0 && this.leaving.length === 0) return 'ready';
      const stuck = this.stuckLeaving();
      if (stuck.length > 0) return this.abandon('timed-out', stuck, LEAVING_TIMEOUT_REASON);
      if (this.hosts.length > 0 && this.now() >= deadline) return this.abandon('timed-out', this.hosts, '其它窗口没有及时让出数据目录。');
      this.input.onProgress?.({ stage: 'release', hosts: [...this.hosts, ...this.leaving], busy: [] });
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
    if (!locked) return undefined;
    this.lastBusy = { busy, ...(own ? { own } : {}) };
    return RETRY;
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

  /** `coordinated`: go was published, so other windows reloaded for this operation. */
  private async execute(coordinated: boolean, activity: RuntimeMaintenanceActivityHandle): Promise<T> {
    // The final decision never trusts the poll cache.
    await assertRuntimeHostsOffline(this.paths, this.input.requesterHostBootId);
    // The request stays fresh however long the operation runs.
    let beat: Promise<void> | undefined;
    const keepAlive = this.request === undefined ? undefined : setInterval(() => {
      beat ??= this.publish({}).catch(() => undefined).finally(() => { beat = undefined; });
    }, EXCLUSIVE_MAINTENANCE_DEFAULTS.heartbeatMs);
    keepAlive?.unref?.();
    try {
      const result = await this.operation({
        reportStage: (stage) => activity.report(stage),
        reportExpectedEnd: (at) => activity.expectEnd(at)
      });
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
    } finally {
      if (keepAlive !== undefined) clearInterval(keepAlive);
      await beat;
    }
  }

  private completed(result: T, coordinated: boolean): Outcome<T> {
    return { state: 'completed', result, coordinated };
  }

  private async requesterBusy(): Promise<ExclusiveMaintenanceBusy | undefined> {
    return this.input.requesterBusy ? await this.input.requesterBusy() : undefined;
  }

  private sameWork(work: Pick<ExclusiveMaintenanceWork, 'operation' | 'operationKey'>): boolean {
    return work.operation === this.operationName && work.operationKey === this.operationKey;
  }

  /** A request made by the requester's own window (its registered Host, else its process). */
  private isOwnWindow(request: RuntimeExclusiveMaintenanceRequest): boolean {
    return this.input.requesterHostBootId !== undefined
      ? request.requesterHostBootId === this.input.requesterHostBootId
      : request.requesterHostBootId === undefined && request.requesterProcessId === process.pid;
  }

  /**
   * `earlier`: a live request of another requester (possibly of this same window) that this one
   * gives way to. `earlierSameWork`: the windows that asked for this same work earlier (they never
   * give way to this one, so they are busy for it, not about to yield).
   */
  private async earlierRequests(): Promise<{ earlier?: RuntimeExclusiveMaintenanceRequest; earlierSameWork: ReadonlySet<string> }> {
    if (!this.request) return { earlierSameWork: new Set() };
    const own = this.request;
    const others = (await readExclusiveMaintenanceRequests(this.paths, { classify: this.classify }))
      .filter((request) => request.requestId !== own.requestId);
    const earlierSameWork = others.filter((request) => this.sameWork(request) && precedes(request, own));
    // The same work asked for earlier is left to that request unless only this one would wait.
    const earlier = others.find((request) => (this.sameWork(request)
      ? precedes(request, own) && laterGivesWayToSameWork(this.local, request)
      : givesWayTo(this.local, request)));
    return {
      ...(earlier ? { earlier } : {}),
      earlierSameWork: new Set(earlierSameWork.flatMap((request) => request.requesterHostBootId !== undefined ? [request.requesterHostBootId] : []))
    };
  }

  /**
   * The other live Hosts, sorted out by their registration: present ones answer (outsiders among
   * them end the call where that is checked); leaving ones (closing or reloading: registered as
   * leaving, or answered in this call and unregistered since) are absent and only have to go offline.
   */
  private async refreshHosts(): Promise<void> {
    const all = await listActiveRuntimeHosts(this.paths, { exceptHostBootId: this.input.requesterHostBootId, classify: this.classify });
    const standings = await hostStandings(this.paths, all, this.prepareTimeoutMs, this.request?.requestId);
    this.hosts = standings.present;
    this.leaving = standings.leaving;
    this.outsiders = standings.outsiders;
    this.opening = new Set(standings.opening.map((host) => host.hostBootId));
    for (const host of this.leaving) if (!this.leavingSince.has(host.hostBootId)) this.leavingSince.set(host.hostBootId, this.now());
  }

  /** Leaving windows still open after the grace: they never finished closing. */
  private stuckLeaving(): RuntimeHostActiveDescriptor[] {
    return this.leaving.filter((host) => this.now() - this.leavingSince.get(host.hostBootId)! >= this.leavingGraceMs);
  }

  private answers(): Promise<Map<string, RuntimeExclusiveMaintenanceResponse>> {
    return readAnswers(this.paths, this.request!, this.hosts);
  }

  /** The busy answers, and the windows still opening (not answering yet): busy, “窗口正在打开”. */
  private busyOf(answers: ReadonlyMap<string, RuntimeExclusiveMaintenanceResponse>): ExclusiveMaintenanceBusyHost[] {
    return [
      ...busyHosts(this.hosts, answers),
      ...this.hosts.filter((host) => this.opening.has(host.hostBootId) && !answers.has(host.hostBootId))
        .map((host): ExclusiveMaintenanceBusyHost => ({ hostBootId: host.hostBootId, kind: 'work', reason: '窗口正在打开', opening: true }))
    ];
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
        activity: this.activity,
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
    this.local.request = this.request;
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
      ? [{
        hostBootId: host.hostBootId, kind: answer.busyKind ?? 'work', reason: answer.reason ?? '有任务正在进行',
        ...(answer.maintenance ? { maintenance: answer.maintenance } : {})
      }]
      : [];
  });
}

/** Names who is busy: the requester's own window, other windows' work, other windows in use. */
function busyParts(busy: readonly ExclusiveMaintenanceBusyHost[], own: ExclusiveMaintenanceBusy | undefined): string {
  const parts: string[] = [];
  if (own) parts.push(`本窗口${own.kind === 'focus' ? '正在使用' : '还有任务正在进行'}`);
  const maintaining = busy.filter((item) => item.maintenance);
  const working = busy.filter((item) => item.kind === 'work' && !item.maintenance && !item.opening).length;
  const opening = busy.filter((item) => item.opening).length;
  const focused = busy.filter((item) => item.kind === 'focus').length;
  if (maintaining.length > 0) {
    const activities = [...new Set(maintaining.map((item) => item.maintenance!.activity))].join('、');
    parts.push(`${maintaining.length} 个其它窗口正在进行自己的维护（${activities}）`);
  }
  if (working > 0) parts.push(`${working} 个其它窗口有任务正在进行`);
  if (opening > 0) parts.push(`${opening} 个其它窗口正在打开`);
  if (focused > 0) parts.push(`${focused} 个其它窗口正在使用`);
  return parts.join('，');
}

function busyReasonText(busy: readonly ExclusiveMaintenanceBusyHost[], own: ExclusiveMaintenanceBusy | undefined): string {
  return `${busyParts(busy, own)}，暂不打扰。`;
}

function repeatedBusyReason(last: BusyObservation | undefined): string {
  // Only the requester's own window: no other window was involved.
  if (last && last.busy.length === 0 && last.own) {
    return `准备期间本窗口一再变忙（最后一次：${last.own.kind === 'focus' ? '本窗口正在使用' : last.own.reason}），这次没有进行，稍后再试。`;
  }
  const detail = last ? busyParts(last.busy, last.own) : '';
  return `准备期间反复有窗口变忙${detail ? `（最后一次：${detail}）` : ''}，这次没有进行，稍后再试。`;
}

const LEAVING_TIMEOUT_REASON = '有窗口正在关闭或重载，但一直没有关完，这次没有进行；稍后再试。';

function goBusyReason(busy: readonly ExclusiveMaintenanceBusyHost[], own: ExclusiveMaintenanceBusy | undefined): string {
  return `其它窗口开始让出后${busyParts(busy, own)}，这次没有进行；已经重载的窗口会照常重新打开。`;
}

export interface ExclusiveMaintenanceParticipantHandlers {
  /** Why this Host cannot yield now (running work, the user in this window…), or undefined when idle. */
  busyReason(request: RuntimeExclusiveMaintenanceRequest): Promise<ExclusiveMaintenanceBusy | undefined>;
  /**
   * Countdown or notice before confirming; false only when the user cancelled a cancellable
   * countdown. `context.requestState` tells whether the request still waits for this answer: a
   * countdown for a request withdrawn meanwhile (another window declined, a timeout) closes and says
   * this window will not reload; one that moved on (a new round asks again) closes silently.
   */
  confirm(request: RuntimeExclusiveMaintenanceRequest, context: ExclusiveMaintenanceConfirmContext): Promise<boolean>;
  /** Yields the root: reload the window (its next startup waits on the admission). */
  release(request: RuntimeExclusiveMaintenanceRequest): Promise<void>;
  /**
   * Wait-mode requests: told once, in advance, that this Host keeps the requester waiting and why.
   * `context.requestState` tells when the request was withdrawn (this window will not reload for it).
   */
  notifyWaiting?(request: RuntimeExclusiveMaintenanceRequest, busy: ExclusiveMaintenanceBusy, context: ExclusiveMaintenanceConfirmContext): void;
}

export interface ExclusiveMaintenanceConfirmContext {
  /**
   * 'current' while the request waits for this answer; 'withdrawn' once it was withdrawn or is gone
   * (this window will not reload for it); 'moved-on' when it went on without this answer (a new
   * round asks again) or this window no longer takes part.
   */
  requestState(): Promise<ExclusiveMaintenanceRequestState>;
}

export type ExclusiveMaintenanceRequestState = 'current' | 'withdrawn' | 'moved-on';

export interface ExclusiveMaintenanceParticipantOptions {
  pollMs?: number;
  isCurrent?(): boolean;
  /** The process that identifies this window; tests running several windows in one process override it. */
  processId?: number;
  onError?(error: unknown): void;
}

export interface ExclusiveMaintenanceParticipant {
  checkNow(): Promise<void>;
  /**
   * Stops answering and marks the registration leaving: this window is closing or reloading, and
   * requesters wait for its Host liveness record to go instead of taking it for an older version.
   * Call before the Runtime closes; call unregister once it closed.
   */
  dispose(): Promise<void>;
  /** Removes the registration (and stops answering); call once the Runtime and its liveness record closed. */
  unregister(): Promise<void>;
}

/**
 * One window's side of the protocol. Registers the Host as a participant (call once its Runtime is
 * open), then answers each phase of other windows' requests. It skips requests of its own window;
 * while its own window has a request running it answers busy (and never yields), except that it
 * holds back its answer to an earlier request that its own request gives way to, until that ended.
 */
export function startExclusiveMaintenanceParticipant(
  paths: RuntimeRootPaths,
  hostBootId: string,
  handlers: ExclusiveMaintenanceParticipantHandlers,
  options: ExclusiveMaintenanceParticipantOptions = {}
): ExclusiveMaintenanceParticipant {
  const ownProcessId = options.processId ?? process.pid;
  const classify = createProtocolProcessClassifier();
  const answered = new Map<string, string>();
  const declinedRequests = new Set<string>();
  const notified = new Set<string>();
  const settledRounds = new Set<string>();
  let disposed = false;
  let checking: Promise<void> | undefined;
  let registration: ExclusiveMaintenanceRegistration | undefined;
  let leaving: Promise<void> | undefined;
  const registered = registerExclusiveMaintenanceParticipant(paths, hostBootId).then(
    (result) => { registration = result; },
    (error) => { options.onError?.(error); }
  );
  const current = (): boolean => !disposed && options.isCurrent?.() !== false;
  const isOwn = (request: RuntimeExclusiveMaintenanceRequest): boolean => request.requesterHostBootId === hostBootId
    || (request.requesterHostBootId === undefined && request.requesterProcessId === ownProcessId);
  // This window's own running request: requests are made in the window's own process (also before
  // the request file is published, and while its operation is held before it asks: see
  // holdExclusiveMaintenanceWork). A published one comes first: it names the work being coordinated.
  const ownRequest = (): LocalRequest | undefined => {
    const own = LOCAL_REQUESTS.get(hostBootId);
    return own?.find((item) => item.request !== undefined) ?? own?.[0];
  };
  const respond = async (
    request: RuntimeExclusiveMaintenanceRequest,
    stage: ExclusiveMaintenancePhase,
    answer: ExclusiveMaintenanceAnswer,
    busy?: ExclusiveMaintenanceBusy,
    reason?: string
  ): Promise<void> => {
    await writeResponse(paths, request, hostBootId, stage, answer, busy?.kind, busy?.reason ?? reason, busy?.maintenance);
    answered.set(`${request.requestId}#${request.round}:${stage}`, `${answer}\0${busy?.kind ?? ''}\0${busy?.reason ?? ''}`);
  };
  const requestState = async (request: RuntimeExclusiveMaintenanceRequest): Promise<ExclusiveMaintenanceRequestState> => {
    if (!current()) return 'moved-on';
    const still = (await readExclusiveMaintenanceRequests(paths, { classify })).find((item) => item.requestId === request.requestId);
    if (!still) return 'withdrawn';
    return still.round === request.round && still.phase === request.phase ? 'current' : 'moved-on';
  };
  const stillCurrentRequest = async (request: RuntimeExclusiveMaintenanceRequest): Promise<boolean> =>
    await requestState(request) === 'current';
  const handle = async (request: RuntimeExclusiveMaintenanceRequest, ownRequest: () => LocalRequest | undefined): Promise<void> => {
    const round = `${request.requestId}#${request.round}`;
    // This window's own request is running: answer busy, never yield (a reload would drop it).
    const busyNow = async (stage: ExclusiveMaintenancePhase): Promise<ExclusiveMaintenanceBusy | undefined> => {
      const own = ownRequest();
      if (own) {
        return {
          kind: 'work', reason: `本窗口正在等待执行${own.activity}`,
          maintenance: {
            operation: own.operation, operationKey: own.operationKey, activity: own.activity, ...(own.whenBusy ? { whenBusy: own.whenBusy } : {})
          }
        };
      }
      const busy = await handlers.busyReason(request);
      // The user already confirmed the operation elsewhere: past prepare only work counts, not focus.
      return stage !== 'prepare' && request.confirmation !== 'countdown' && busy?.kind === 'focus' ? undefined : busy;
    };
    // Its own request gives way to this earlier one: hold the answer until the own request ended.
    const holdBack = (): boolean => {
      const own = ownRequest();
      return own !== undefined && givesWayTo(own, request);
    };
    if (request.phase === 'prepare') {
      const busy = await busyNow('prepare');
      const answer: ExclusiveMaintenanceAnswer = declinedRequests.has(request.requestId)
        ? 'declined' : busy ? 'busy' : 'ready';
      if (answered.get(`${round}:prepare`) === `${answer}\0${busy?.kind ?? ''}\0${busy?.reason ?? ''}`) return;
      if (busy && answer === 'busy' && request.whenBusy === 'wait' && !notified.has(request.requestId) && !ownRequest()) {
        notified.add(request.requestId);
        handlers.notifyWaiting?.(request, busy, { requestState: () => requestState(request) });
      }
      await respond(request, 'prepare', answer, answer === 'busy' ? busy : undefined);
      return;
    }
    if (request.phase === 'confirm') {
      if (answered.has(`${round}:confirm`)) return;
      if (!answered.get(`${round}:prepare`)?.startsWith('ready\0')) return;
      if (holdBack()) return;
      const busy = await busyNow('confirm');
      if (busy) {
        await respond(request, 'confirm', 'busy', busy);
        return;
      }
      const confirmed = await handlers.confirm(request, { requestState: () => requestState(request) });
      // Withdrawn (another window declined, a timeout) or restarted while the countdown ran.
      if (!await stillCurrentRequest(request)) return;
      if (!confirmed && request.confirmation === 'countdown') {
        declinedRequests.add(request.requestId);
        await respond(request, 'confirm', 'declined', undefined, '用户选择保留本窗口');
        return;
      }
      if (holdBack()) return;
      const busyAfter = await busyNow('confirm');
      await respond(request, 'confirm', busyAfter ? 'busy' : 'confirmed', busyAfter);
      return;
    }
    if (request.phase === 'go') {
      // A round this window answered busy in (or already yielded in) never makes it reload.
      if (!answered.get(`${round}:confirm`)?.startsWith('confirmed\0') || settledRounds.has(round)) return;
      if (holdBack()) return;
      const busy = await busyNow('go');
      settledRounds.add(round);
      if (busy) {
        // Work started after this window confirmed: never interrupt it; this call of the requester ends.
        await respond(request, 'go', 'busy', busy);
        return;
      }
      // The call may have ended meanwhile (another window was busy at go): never reload in vain.
      if (!await stillCurrentRequest(request)) return;
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
      if (isOwn(request)) continue;
      await handle(request, ownRequest);
    }
  };
  const checkNow = (): Promise<void> => {
    checking ??= check().catch((error) => options.onError?.(error)).finally(() => { checking = undefined; });
    return checking;
  };
  const timer = setInterval(() => { void checkNow(); }, options.pollMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.participantPollMs);
  timer.unref?.();
  const stop = (): void => {
    disposed = true;
    clearInterval(timer);
  };
  return {
    checkNow,
    dispose() {
      stop();
      leaving ??= registered.then(() => registration?.markLeaving()).catch(() => undefined);
      return leaving;
    },
    async unregister() {
      stop();
      await registered;
      await leaving;
      await registration?.unregister().catch(() => undefined);
    }
  };
}

export interface ExclusiveMaintenanceRegistration {
  /** The window is closing or reloading: requesters wait for its Runtime to close (see hostStandings). */
  markLeaving(): Promise<void>;
  unregister(): Promise<void>;
}

/**
 * A participating Host announces that it answers requests; call once its Runtime is open. With
 * `opening` it is registered right as its Runtime opened, before it answers (the rest of its
 * opening, the participant's start): requesters count it busy (“窗口正在打开”) instead of taking it
 * for an older version, for at most OPENING_REGISTRATION_MS; the participant's own registration
 * replaces it.
 */
export async function registerExclusiveMaintenanceParticipant(
  paths: RuntimeRootPaths,
  hostBootId: string,
  options: { opening?: boolean } = {}
): Promise<ExclusiveMaintenanceRegistration> {
  const directory = path.join(runtimeExclusiveMaintenanceDirectory(paths), PARTICIPANTS_DIRECTORY);
  const file = path.join(directory, `${safeName(hostBootId)}.json`);
  await removeGoneParticipants(directory);
  const identity = ownProcessStartIdentity();
  const record = {
    kind: PARTICIPANT_KIND,
    hostBootId,
    processId: process.pid,
    ...(identity !== undefined ? { processStartIdentity: identity } : {}),
    registeredAt: new Date().toISOString(),
    ...(options.opening ? { openingAt: new Date().toISOString() } : {})
  };
  await writeDurableJson(file, record);
  let removed = false;
  return {
    async markLeaving() {
      if (!removed) await writeDurableJson(file, { ...record, leavingAt: new Date().toISOString() });
    },
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
    || typeof request.message !== 'string' || typeof request.activity !== 'string'
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
 * their expiry, withdrawn ones, and response directories without a request not written to for
 * staleRequestMs.
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
  const answered = await fs.readdir(responses).catch(() => [] as string[]);
  // A request published after the listing above may already have answers: list the requests again,
  // and remove only answers that neither listing knows and that nobody wrote to lately.
  for (const name of await fs.readdir(requestsDirectory).catch(() => [] as string[])) {
    if (name.endsWith('.json')) present.add(name.slice(0, -'.json'.length));
  }
  for (const name of answered) {
    if (present.has(name)) continue;
    const directory = path.join(responses, name);
    const modified = (await fs.stat(directory).catch(() => undefined))?.mtimeMs;
    if (modified === undefined || Date.now() - modified < EXCLUSIVE_MAINTENANCE_DEFAULTS.staleRequestMs) continue;
    await removeWithRetry(directory, true).catch(() => undefined);
  }
}

/** A window registered as opening longer than this is outside the protocol (it never started answering). */
const OPENING_REGISTRATION_MS = 2 * 60_000;

interface HostStandings {
  /** Hosts that answer: registered participants, and ones that opened within the registration grace. */
  present: RuntimeHostActiveDescriptor[];
  /** Present hosts registered as opening: busy until their participant answers. */
  opening: RuntimeHostActiveDescriptor[];
  /** Participants closing or reloading: absent, only their Host liveness record has to go. */
  leaving: RuntimeHostActiveDescriptor[];
  /** Present hosts outside the protocol: not live, unregistered past the grace, or another process's registration. */
  outsiders: RuntimeHostActiveDescriptor[];
}

/**
 * Every Host must be live and registered as a participant with the same process. One that started
 * within the grace (the prepare timeout) without a registration yet is waited for like a missing
 * answer. A window closing or reloading is leaving, never an older version: its participant marks
 * its registration leaving and removes it only after its Runtime closed; one that answered
 * `requestId` and unregistered since (an earlier build unregisters first) is leaving as well.
 */
async function hostStandings(
  paths: RuntimeRootPaths,
  hosts: readonly RuntimeHostActiveDescriptor[],
  graceMs: number,
  requestId: string | undefined
): Promise<HostStandings> {
  const directory = path.join(runtimeExclusiveMaintenanceDirectory(paths), PARTICIPANTS_DIRECTORY);
  const standings: HostStandings = { present: [], opening: [], leaving: [], outsiders: [] };
  const outside = (host: RuntimeHostActiveDescriptor): void => {
    standings.present.push(host);
    standings.outsiders.push(host);
  };
  for (const host of hosts) {
    if (host.state !== 'live' || host.processId === null || !SAFE_ID.test(host.hostBootId)) {
      outside(host);
      continue;
    }
    let record: Record<string, unknown>;
    try { record = JSON.parse(await fs.readFile(path.join(directory, `${host.hostBootId}.json`), 'utf8')) as Record<string, unknown>; }
    catch (error) {
      const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
      if (missing && requestId !== undefined && await answeredRequest(paths, requestId, host.hostBootId)) standings.leaving.push(host);
      else if (!missing || !startedWithin(host, graceMs)) outside(host);
      else standings.present.push(host);
      continue;
    }
    // Start identities are compared only when both sides have one: the registration and the Host
    // liveness record read it apart, and a probe that failed once for one of them proves nothing.
    if (record.kind !== PARTICIPANT_KIND || record.hostBootId !== host.hostBootId || record.processId !== host.processId
      || (host.processStartIdentity !== undefined && typeof record.processStartIdentity === 'string'
        && record.processStartIdentity !== host.processStartIdentity)) {
      outside(host);
    } else if (typeof record.leavingAt === 'string') {
      standings.leaving.push(host);
    } else if (typeof record.openingAt === 'string') {
      const age = Date.now() - Date.parse(record.openingAt);
      if (Number.isFinite(age) && age > -60_000 && age < OPENING_REGISTRATION_MS) {
        standings.present.push(host);
        standings.opening.push(host);
      } else {
        outside(host);
      }
    } else {
      standings.present.push(host);
    }
  }
  return standings;
}

/** Whether the Host answered any round or stage of the request. */
async function answeredRequest(paths: RuntimeRootPaths, requestId: string, hostBootId: string): Promise<boolean> {
  try {
    const value = JSON.parse(await fs.readFile(responsePath(paths, requestId, hostBootId), 'utf8')) as Partial<RuntimeExclusiveMaintenanceResponse>;
    return value.kind === RESPONSE_KIND && value.requestId === requestId && value.hostBootId === hostBootId;
  } catch {
    return false;
  }
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
    const { maintenance, ...answer } = value as RuntimeExclusiveMaintenanceResponse;
    const work = maintenance && typeof maintenance.operation === 'string' && typeof maintenance.operationKey === 'string'
      && typeof maintenance.activity === 'string'
      ? {
        operation: maintenance.operation, operationKey: maintenance.operationKey, activity: maintenance.activity,
        ...(maintenance.whenBusy === 'wait' || maintenance.whenBusy === 'abandon' ? { whenBusy: maintenance.whenBusy } : {})
      }
      : undefined;
    answers.set(host.hostBootId, { ...answer, ...(work ? { maintenance: work } : {}) });
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
  reason?: string,
  maintenance?: ExclusiveMaintenanceWork
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
    ...(maintenance !== undefined
      ? {
        maintenance: {
          operation: maintenance.operation, operationKey: maintenance.operationKey, activity: maintenance.activity,
          ...(maintenance.whenBusy ? { whenBusy: maintenance.whenBusy } : {})
        }
      }
      : {}),
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
  /** A deterministic failure: automatic calls of this key never run again (an explicit call may). */
  blocked?: true;
  /** Cooldown: the call that published go (see RuntimeExclusiveMaintenanceInput.requesterToken). */
  requesterToken?: string;
  reason: string;
  recordedAt: string;
}

async function readKeyBlock(paths: RuntimeRootPaths, operation: string, operationKey: string): Promise<string | undefined> {
  const entry = await readLedger(paths, keyLedgerName(operation, operationKey));
  return entry?.blocked === true ? `这项维护此前确定无法完成，不再自动重试：${entry.reason}；排除原因后可以手动再试。` : undefined;
}

async function readActiveBackoff(
  paths: RuntimeRootPaths,
  operation: string,
  /** Undefined: only the operation's cooldown (readExclusiveMaintenanceRefusal before the key is known). */
  operationKey: string | undefined,
  input: Pick<RuntimeExclusiveMaintenanceInput, 'ignoreBackoff' | 'requesterToken' | 'backoffMaxMs' | 'cooldownAfterCoordinatedMs'>
): Promise<{ until: string; reason: string } | undefined> {
  const maxMs = Math.max(
    input.backoffMaxMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.backoffMaxMs,
    input.cooldownAfterCoordinatedMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.cooldownAfterCoordinatedMs
  );
  const entries: LedgerEntry[] = [];
  const cooldown = await readLedger(paths, operationLedgerName(operation));
  if (cooldown) {
    // Every call of the operation waits for the cooldown whatever its key (a new key per attempt
    // must not get around it), except an explicit call with the token of the call that published
    // the go: the user retrying in the window that asked, also after the failure reloaded it.
    // Windows that yielded have no such token and never make the others yield right back.
    const sameRequester = input.requesterToken !== undefined && cooldown.requesterToken === input.requesterToken;
    if (!input.ignoreBackoff || !sameRequester) entries.push(cooldown);
  }
  // An explicit user request skips the key's backoff.
  if (!input.ignoreBackoff && operationKey !== undefined) {
    const key = await readLedger(paths, keyLedgerName(operation, operationKey));
    if (key) entries.push(key);
  }
  let latest: { until: string; reason: string; at: number } | undefined;
  for (const entry of entries) {
    if (entry.blocked) continue;
    const until = Date.parse(entry.until);
    // A clock set back must not freeze retries far beyond the longest backoff.
    if (!Number.isFinite(until) || until <= Date.now() || until > Date.now() + maxMs + 60_000) continue;
    if (!latest || until > latest.at) latest = { until: entry.until, reason: entry.reason, at: until };
  }
  return latest ? { until: latest.until, reason: withRetryTime(latest.reason, latest.at) } : undefined;
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
  operationKey: string,
  input: RuntimeExclusiveMaintenanceInput
): Promise<void> {
  const durationMs = input.cooldownAfterCoordinatedMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.cooldownAfterCoordinatedMs;
  await writeLedger(paths, operationLedgerName(operation), {
    kind: LEDGER_KIND, scope: 'operation', operation, operationKey, attempts: 1,
    until: new Date(Date.now() + durationMs).toISOString(),
    ...(input.requesterToken !== undefined ? { requesterToken: input.requesterToken } : {}),
    reason: '刚刚已经为这项维护让其它窗口重载过一次，暂不再次要求其它窗口重载。', recordedAt: new Date().toISOString()
  }).catch((error) => console.warn('[LimCode] 无法记录独占维护的冷却期。', error));
}

/** A recorded reason that ends with “try again later” says when instead. */
function withRetryTime(reason: string, untilMs: number): string {
  return `${reason.replace(/[，；]?(?:之后可以再试|稍后再试|完成后再试)。$/, '。')}${retryText(untilMs)}`;
}

/** When a refused call may be made again, in the user's words: about how long, and the local time. */
function retryText(untilMs: number): string {
  const minutes = Math.max(1, Math.ceil((untilMs - Date.now()) / 60_000));
  const at = new Date(untilMs);
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return `约 ${minutes} 分钟后（${clock} 以后）可以再试。`;
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
