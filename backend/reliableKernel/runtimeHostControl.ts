import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { RuntimeRootPaths } from './contracts';
import {
  classifyRecordedProcess,
  delay,
  inspectRecordedProcess,
  isolateDeadClaimRecord,
  ownProcessStartIdentity,
  readClaimRecord,
  releaseClaimRecord,
  requireNonEmptyText,
  tryPublishClaimRecord,
  type RecordedProcessClassifier,
  type RecordedProcessInspection
} from './runtimeClaimPrimitives';

export const RUNTIME_HOST_LIVENESS_DIRECTORY = 'host-liveness';
export const RUNTIME_MAINTENANCE_RECORD_FILE = 'owner.json';

const RUNTIME_MAINTENANCE_SUFFIX = '.runtime-maintenance';
const RUNTIME_ADMISSION_SUFFIX = '.runtime-admission';
const RUNTIME_MAINTENANCE_ACTIVITY_FILE = 'activity.json';
const RUNTIME_MAINTENANCE_ACTIVITY_KIND = 'limcode-runtime-maintenance-activity';

/**
 * Waiting for a claim polls quickly while a holder is new, then backs off (a maintenance can take
 * minutes); every new holder (another claim token) starts the quick phase again, so windows queued
 * behind each other follow one another closely.
 */
export const RUNTIME_CLAIM_WAIT = Object.freeze({
  firstPollMs: 50,
  /** After firstPhaseMs of waiting for the same holder. */
  laterPollMs: 250,
  firstPhaseMs: 2_000,
  /** After laterPhaseMs of waiting for the same holder. */
  slowPollMs: 1_000,
  laterPhaseMs: 10_000,
  /** onWait is called only once a wait lasted this long. */
  reportAfterMs: 1_000,
  /** A holder refreshes its activity this often while it works. */
  activityHeartbeatMs: 2_000,
  /** An activity not refreshed this long is reported as stale: the holder is alive but makes no progress. */
  activityStaleMs: 15_000
});

/** What a maintenance holder is doing, as published by {@link withRuntimeMaintenanceActivity}. */
export interface RuntimeMaintenanceActivity {
  /** Stable operation name, e.g. data-root-migration. */
  operation: string;
  /** User-facing, completes “另一个窗口正在…”, e.g. 迁移数据目录. */
  description: string;
  /** User-facing stage or progress, e.g. 正在复制正文（3/10）. */
  stage?: string;
}

export interface RuntimeMaintenanceActivityHandle {
  /** Replaces the stage shown to waiting windows (written at once, and with every heartbeat). */
  report(stage: string | undefined): void;
}

/** The holder's published activity as seen by a waiter. */
export interface RuntimeClaimWaitActivity extends RuntimeMaintenanceActivity {
  runningMs: number;
  heartbeatAgeMs: number;
  /** Not refreshed for activityStaleMs: the holder process is alive but makes no progress (never taken over). */
  stale: boolean;
}

export interface RuntimeClaimWait {
  /** How long this caller has been waiting for the claim (monotonic). */
  waitedMs: number;
  /** How long the current holder (its claim token) has been seen holding it; long waits are judged by this. */
  holderWaitedMs: number;
  /** Absent when the holder published nothing, e.g. another window that is opening. */
  activity?: RuntimeClaimWaitActivity;
}

export interface RuntimeClaimWaitOptions {
  /** Called on every poll once a wait lasted reportAfterMs; the wait itself never ends early. */
  onWait?(wait: RuntimeClaimWait): void;
  /**
   * Called once the claim was taken, before the operation runs (whether or not it had to wait):
   * whatever the window showed about waiting for it is over. Further claims may follow.
   */
  onAcquired?(): void;
}

export interface RuntimeMaintenanceMetadata {
  claimToken: string;
  processId: number;
  processStartIdentity?: string;
  startedAt: string;
  rootPointerPath: string;
}

export class RuntimeMaintenanceBusyError extends Error {
  public readonly code = 'runtime-maintenance-busy';

  public constructor(
    public readonly claimPath: string,
    public readonly owner: RuntimeMaintenanceMetadata,
    public readonly reason: string
  ) {
    super(
      `Runtime maintenance cannot verify the holder process ${owner.processId} for ${claimPath} (${reason}); ` +
      'failing closed instead of taking over an unknown Runtime Host.'
    );
    this.name = 'RuntimeMaintenanceBusyError';
  }
}

export class RuntimeMaintenanceClaimError extends Error {
  public constructor(
    public readonly code: 'runtime-maintenance-invalid' | 'runtime-maintenance-mismatch',
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.name = 'RuntimeMaintenanceClaimError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export function isRuntimeMaintenanceBusyError(error: unknown): error is RuntimeMaintenanceBusyError {
  return error instanceof RuntimeMaintenanceBusyError
    || (error instanceof Error && (error as Error & { code?: unknown }).code === 'runtime-maintenance-busy');
}

export function isRuntimeMaintenanceClaimError(error: unknown): error is RuntimeMaintenanceClaimError {
  return error instanceof RuntimeMaintenanceClaimError;
}

export interface RuntimeHostActiveDescriptor {
  hostBootId: string;
  processId: number | null;
  processStartIdentity?: string;
  startedAt?: string;
  heartbeatAt?: string;
  state: 'live' | 'unknown' | 'malformed';
}

export class RuntimeHostsActiveError extends Error {
  public readonly code = 'runtime-hosts-active';

  public constructor(public readonly hosts: RuntimeHostActiveDescriptor[]) {
    super(
      `此数据目录仍被 ${hosts.length} 个窗口或宿主记录占用` +
      `${formatHostProcesses(hosts)}；请先关闭其他打开此数据目录的窗口后再执行此操作。`
    );
    this.name = 'RuntimeHostsActiveError';
  }
}

export function isRuntimeHostsActiveError(error: unknown): error is RuntimeHostsActiveError {
  return error instanceof RuntimeHostsActiveError
    || (error instanceof Error && (error as Error & { code?: unknown }).code === 'runtime-hosts-active');
}

/**
 * The maintenance claim directory is a sibling of the Runtime control root, so archiving or
 * renaming the whole control root never carries the claim (or its tombstones) along.
 */
export function runtimeMaintenanceClaimPath(paths: RuntimeRootPaths): string {
  const controlRoot = path.dirname(requireNonEmptyText(paths.rootPointerPath, 'RuntimeRootPaths.rootPointerPath'));
  return path.join(path.dirname(controlRoot), `${path.basename(controlRoot)}${RUNTIME_MAINTENANCE_SUFFIX}`);
}

/** Directory where RuntimeDatabase publishes one liveness record per Runtime Host boot. */
export function runtimeHostLivenessDirectory(paths: RuntimeRootPaths): string {
  return path.join(
    requireNonEmptyText(paths.dataRootPath, 'RuntimeRootPaths.dataRootPath'),
    RUNTIME_HOST_LIVENESS_DIRECTORY
  );
}

/**
 * The global admission claim for one shared configuration root, intentionally a distinct stable
 * suffix from per-scope maintenance but with the identical record format and reentrancy keying,
 * so a standalone authority whose admission path aliases a maintenance path still joins cleanly.
 */
export function runtimeDataRootAdmissionClaimPath(configurationRootPath: string): string {
  const configurationRoot = path.resolve(
    requireNonEmptyText(configurationRootPath, 'configurationRootPath')
  );
  return path.join(
    path.dirname(configurationRoot),
    `${path.basename(configurationRoot)}${RUNTIME_ADMISSION_SUFFIX}`
  );
}

interface AcquiredRuntimeMaintenance {
  readonly claimPath: string;
  readonly metadata: RuntimeMaintenanceMetadata;
  /** False once the owning withRuntimeClaim body settled; escaped continuations must reacquire. */
  active: boolean;
  released: boolean;
}

const RUNTIME_MAINTENANCE_SCOPE = new AsyncLocalStorage<ReadonlyMap<string, AcquiredRuntimeMaintenance>>();

/**
 * Serializes root maintenance (reset/archive/cutover/data-root switch) against RuntimeDatabase
 * opens on the same control root. The claim is an atomic non-empty directory publication with a
 * process-start fingerprint; a live or unverifiable holder is never stolen after a timeout —
 * live holders are awaited, unknown holders fail closed, and only a proven dead/reused process
 * identity is isolated to its deterministic tombstone. Nested calls inside the same async scope
 * join the outer claim instead of deadlocking on their own publication.
 */
export async function withRuntimeMaintenance<T>(
  paths: RuntimeRootPaths,
  operation: () => Promise<T>,
  wait?: RuntimeClaimWaitOptions
): Promise<T> {
  return withRuntimeClaim(runtimeMaintenanceClaimPath(paths), paths.rootPointerPath, operation, wait);
}

/**
 * Canonical global admission for one shared configuration root (the parent of every Runtime
 * scope control root). Legacy physical cutover deletes records across the whole configuration
 * root while sibling scopes may be live, so scope maintenance and Host registration must join
 * this admission first: global admission, then per-scope maintenance — always in this order.
 * Same robust identity mutex as {@link withRuntimeMaintenance}, claimed as a sibling of the
 * configuration root so the claim survives deletion of the configuration tree itself.
 */
export async function withRuntimeDataRootAdmission<T>(
  configurationRootPath: string,
  operation: () => Promise<T>,
  wait?: RuntimeClaimWaitOptions
): Promise<T> {
  const configurationRoot = path.resolve(
    requireNonEmptyText(configurationRootPath, 'configurationRootPath')
  );
  return withRuntimeClaim(
    runtimeDataRootAdmissionClaimPath(configurationRoot),
    configurationRoot,
    operation,
    wait
  );
}

/**
 * Runs `open` under the configuration-root admission of the root that is current once that
 * admission is held. A data-root migration can publish a new root while this Host waits on the old
 * root's admission (its window was reloaded for that migration): the root is read again under the
 * admission, and when it moved the old admission is released and the new root's taken instead, so a
 * Host never registers on a root that was just migrated away. `wait.onWait` reports a long wait
 * (and what the holder is doing) so the window can explain it; the wait never ends early.
 */
export async function openUnderCurrentDataRootAdmission<T>(
  readConfigurationRoot: () => Promise<string>,
  open: () => Promise<T>,
  maxAttempts = 5,
  wait?: RuntimeClaimWaitOptions
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const admissionRoot = path.resolve(await readConfigurationRoot());
    const opened = await withRuntimeDataRootAdmission(admissionRoot, async () => {
      if (comparablePath(await readConfigurationRoot()) !== comparablePath(admissionRoot)) return { moved: true } as const;
      return { moved: false, value: await open() } as const;
    }, wait);
    if (!opened.moved) return opened.value;
    if (attempt >= maxAttempts) {
      throw new Error('数据目录在打开期间反复变化，本窗口没有打开运行时；请重载窗口后再试。');
    }
  }
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function withRuntimeClaim<T>(
  claimPath: string,
  targetPath: string,
  operation: () => Promise<T>,
  wait?: RuntimeClaimWaitOptions
): Promise<T> {
  const scope = RUNTIME_MAINTENANCE_SCOPE.getStore();
  const inherited = scope?.get(claimPath);
  // Only a live claim joins reentrantly. An async callback that escaped its originating scope
  // inherits the context map but finds the claim inactive, so it reacquires the mutex instead
  // of running unprotected after the outer scope already released it.
  if (inherited?.active) return operation();
  const acquired = await acquireMaintenanceClaim(claimPath, targetPath, wait);
  if (wait?.onAcquired) {
    try { wait.onAcquired(); }
    catch (error) { console.warn('[LimCode] Runtime claim wait observer failed.', error); }
  }
  const nextScope = new Map(scope);
  nextScope.set(claimPath, acquired);
  let operationFailed = false;
  try {
    return await RUNTIME_MAINTENANCE_SCOPE.run(nextScope, operation);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    acquired.active = false;
    // A failed release after a failed operation must not mask the original error; a failed
    // release after success is reported because it leaves the root locked for every peer.
    if (operationFailed) await releaseMaintenanceClaim(acquired).catch(() => undefined);
    else await releaseMaintenanceClaim(acquired);
  }
}

/**
 * Destructive-maintenance gate: every Host liveness record published for this data root must
 * belong to a proven dead or reused process. Live, unknown and even malformed records reject —
 * an unreadable record can never prove that its writer is gone. Call inside
 * {@link withRuntimeMaintenance} so the scan is serialized against new Host registration.
 * exceptHostBootId skips the caller's own record for a pre-shutdown preflight only.
 */
export async function assertRuntimeHostsOffline(
  paths: RuntimeRootPaths,
  exceptHostBootId?: string
): Promise<void> {
  const active = await listActiveRuntimeHosts(paths, { exceptHostBootId });
  if (active.length > 0) throw new RuntimeHostsActiveError(active);
}

/**
 * Every Host liveness record not proven dead: live, unknown or malformed. The same classification
 * as {@link assertRuntimeHostsOffline}; bounded polling loops pass a cached classifier so the
 * platform identity probe does not run on every poll. A final exclusivity decision must still use
 * {@link assertRuntimeHostsOffline} itself.
 */
export async function listActiveRuntimeHosts(
  paths: RuntimeRootPaths,
  options: { exceptHostBootId?: string; classify?: RecordedProcessClassifier } = {}
): Promise<RuntimeHostActiveDescriptor[]> {
  const { exceptHostBootId } = options;
  const classify = options.classify ?? classifyRecordedProcess;
  const directory = runtimeHostLivenessDirectory(paths);
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  const active: RuntimeHostActiveDescriptor[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let raw: string;
    try {
      raw = await fs.readFile(path.join(directory, name), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      active.push(malformedDescriptor(name, undefined));
      continue;
    }
    const record = parseHostLivenessRecord(value);
    if (!record) {
      active.push(malformedDescriptor(name, value));
      continue;
    }
    if (exceptHostBootId !== undefined && record.hostBootId === exceptHostBootId) continue;
    const state = classify(record.processId, record.processStartIdentity);
    if (state === 'dead') continue;
    active.push({
      hostBootId: record.hostBootId,
      processId: record.processId,
      ...(record.processStartIdentity !== undefined ? { processStartIdentity: record.processStartIdentity } : {}),
      startedAt: record.startedAt,
      heartbeatAt: record.heartbeatAt,
      state: state === 'alive' ? 'live' : 'unknown'
    });
  }
  return active;
}

/** True only inside a live {@link withRuntimeMaintenance} scope for exactly this root. */
export function isRuntimeMaintenanceHeld(paths: RuntimeRootPaths): boolean {
  return RUNTIME_MAINTENANCE_SCOPE.getStore()?.get(runtimeMaintenanceClaimPath(paths))?.active === true;
}

/** True only inside a live {@link withRuntimeDataRootAdmission} scope for this configuration root. */
export function isRuntimeDataRootAdmissionHeld(configurationRootPath: string): boolean {
  const claimPath = runtimeDataRootAdmissionClaimPath(path.resolve(
    requireNonEmptyText(configurationRootPath, 'configurationRootPath')
  ));
  return RUNTIME_MAINTENANCE_SCOPE.getStore()?.get(claimPath)?.active === true;
}

/**
 * Publishes what this holder does inside every claim it holds in this async scope (the configuration
 * admission and/or maintenance claims), refreshed every activityHeartbeatMs while `body` runs and
 * gone with the claim. Windows waiting on one of these claims show it (RuntimeClaimWaitOptions).
 * Advisory only: it is bound to the holder's claim token and lives inside the claim directory, so a
 * crashed holder's leftover never describes a later holder, and a stale heartbeat never lets a waiter
 * take the claim over.
 */
export async function withRuntimeMaintenanceActivity<T>(
  activity: RuntimeMaintenanceActivity,
  body: (handle: RuntimeMaintenanceActivityHandle) => Promise<T>
): Promise<T> {
  const claims = [...(RUNTIME_MAINTENANCE_SCOPE.getStore()?.values() ?? [])].filter((claim) => claim.active);
  if (claims.length === 0) throw new Error('维护进行中标记只能在持有 admission 或 maintenance 时发布。');
  requireNonEmptyText(activity.operation, 'activity.operation');
  requireNonEmptyText(activity.description, 'activity.description');
  const startedAt = new Date().toISOString();
  let stage = activity.stage;
  let writing: Promise<void> | undefined;
  let again = false;
  let stopped = false;
  const writeAll = async (): Promise<void> => {
    for (const claim of claims) {
      if (!claim.active || stopped) return;
      await writeMaintenanceActivity(claim, {
        kind: RUNTIME_MAINTENANCE_ACTIVITY_KIND,
        claimToken: claim.metadata.claimToken,
        operation: activity.operation,
        description: activity.description,
        ...(stage ? { stage } : {}),
        processId: process.pid,
        startedAt,
        heartbeatAt: new Date().toISOString()
      }).catch(() => undefined);
    }
  };
  const flush = (): Promise<void> => {
    if (writing) {
      again = true;
      return writing;
    }
    writing = (async () => {
      do {
        again = false;
        await writeAll();
      } while (again && !stopped);
    })().finally(() => { writing = undefined; });
    return writing;
  };
  await flush();
  const timer = setInterval(() => { void flush(); }, RUNTIME_CLAIM_WAIT.activityHeartbeatMs);
  timer.unref?.();
  try {
    return await body({
      report(next) {
        if (next === stage) return;
        stage = next;
        void flush();
      }
    });
  } finally {
    stopped = true;
    clearInterval(timer);
    await writing;
    for (const claim of claims) {
      if (claim.active) await fs.rm(path.join(claim.claimPath, RUNTIME_MAINTENANCE_ACTIVITY_FILE), { force: true }).catch(() => undefined);
    }
  }
}

interface RuntimeMaintenanceActivityRecord extends RuntimeMaintenanceActivity {
  kind: typeof RUNTIME_MAINTENANCE_ACTIVITY_KIND;
  claimToken: string;
  processId: number;
  startedAt: string;
  heartbeatAt: string;
}

async function writeMaintenanceActivity(claim: AcquiredRuntimeMaintenance, record: RuntimeMaintenanceActivityRecord): Promise<void> {
  const file = path.join(claim.claimPath, RUNTIME_MAINTENANCE_ACTIVITY_FILE);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** The activity published inside a claim, only when it belongs to the holder with this token. */
async function readMaintenanceActivity(claimPath: string, holderToken: string): Promise<RuntimeClaimWaitActivity | undefined> {
  let record: Partial<RuntimeMaintenanceActivityRecord>;
  try { record = JSON.parse(await fs.readFile(path.join(claimPath, RUNTIME_MAINTENANCE_ACTIVITY_FILE), 'utf8')) as Partial<RuntimeMaintenanceActivityRecord>; }
  catch { return undefined; }
  if (record.kind !== RUNTIME_MAINTENANCE_ACTIVITY_KIND || record.claimToken !== holderToken
    || typeof record.operation !== 'string' || typeof record.description !== 'string'
    || (record.stage !== undefined && typeof record.stage !== 'string')) return undefined;
  const started = Date.parse(String(record.startedAt));
  const heartbeat = Date.parse(String(record.heartbeatAt));
  if (!Number.isFinite(started) || !Number.isFinite(heartbeat)) return undefined;
  const now = Date.now();
  const heartbeatAgeMs = Math.max(0, now - heartbeat);
  return {
    operation: record.operation,
    description: record.description,
    ...(record.stage ? { stage: record.stage } : {}),
    runningMs: Math.max(0, now - started),
    heartbeatAgeMs,
    stale: heartbeatAgeMs > RUNTIME_CLAIM_WAIT.activityStaleMs
  };
}

function claimRetryDelayMs(waitedMs: number): number {
  if (waitedMs < RUNTIME_CLAIM_WAIT.firstPhaseMs) return RUNTIME_CLAIM_WAIT.firstPollMs;
  return waitedMs < RUNTIME_CLAIM_WAIT.laterPhaseMs ? RUNTIME_CLAIM_WAIT.laterPollMs : RUNTIME_CLAIM_WAIT.slowPollMs;
}

interface RuntimeHostLivenessRecord {
  dataSetId: string;
  rootInstanceId: string;
  rootGeneration: number;
  hostBootId: string;
  livenessId: string;
  processId: number;
  processStartIdentity?: string;
  startedAt: string;
  heartbeatAt: string;
}

async function acquireMaintenanceClaim(
  claimPath: string,
  rootPointerPath: string,
  wait?: RuntimeClaimWaitOptions
): Promise<AcquiredRuntimeMaintenance> {
  const ownIdentity = ownProcessStartIdentity();
  const metadata: RuntimeMaintenanceMetadata = {
    claimToken: randomUUID(),
    processId: process.pid,
    ...(ownIdentity !== undefined ? { processStartIdentity: ownIdentity } : {}),
    startedAt: new Date().toISOString(),
    rootPointerPath
  };
  await fs.mkdir(path.dirname(claimPath), { recursive: true, mode: 0o700 });
  let observedToken: string | undefined;
  let observed: RecordedProcessInspection | undefined;
  const waitStarted = performance.now();
  let holder: { token: string; since: number } | undefined;
  // A live holder: tell the observer (after a while) what it does, then poll again, backing off
  // per holder (a new holder starts the quick phase again).
  const pause = async (holderToken: string): Promise<void> => {
    const now = performance.now();
    if (holder?.token !== holderToken) holder = { token: holderToken, since: now };
    const waitedMs = now - waitStarted;
    const holderWaitedMs = now - holder.since;
    if (wait?.onWait && waitedMs >= RUNTIME_CLAIM_WAIT.reportAfterMs) {
      const activity = await readMaintenanceActivity(claimPath, holderToken);
      try { wait.onWait({ waitedMs, holderWaitedMs, ...(activity ? { activity } : {}) }); }
      catch (error) { console.warn('[LimCode] Runtime claim wait observer failed.', error); }
    }
    await delay(claimRetryDelayMs(holderWaitedMs));
  };
  for (;;) {
    if (await tryPublishClaimRecord(claimPath, RUNTIME_MAINTENANCE_RECORD_FILE, `${JSON.stringify(metadata)}\n`)) {
      return { claimPath, metadata, active: true, released: false };
    }
    const record = await readMaintenanceRecord(claimPath);
    if (!record) continue;
    if (record.processId === process.pid && record.processStartIdentity === ownIdentity) {
      // Another async scope in this same process holds the claim; wait for its release.
      await pause(record.claimToken);
      continue;
    }
    if (record.claimToken !== observedToken) {
      // One platform identity probe per observed claim token; liveness re-checks below are cheap.
      observedToken = record.claimToken;
      observed = inspectRecordedProcess(record.processId, record.processStartIdentity);
    }
    if (observed!.state === 'dead') {
      await isolateMaintenanceRecord(claimPath, record.claimToken);
      observedToken = undefined;
      continue;
    }
    if (observed!.state === 'unknown') {
      throw new RuntimeMaintenanceBusyError(claimPath, record, observed!.reason ?? 'holder state unknown');
    }
    try {
      process.kill(record.processId, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ESRCH') {
        await isolateMaintenanceRecord(claimPath, record.claimToken);
        observedToken = undefined;
        continue;
      }
      // EPERM on a holder whose start identity was verified alive is still that live holder.
      if (code !== 'EPERM') {
        throw new RuntimeMaintenanceBusyError(
          claimPath,
          record,
          `liveness re-check failed with ${code ?? String(error)}`
        );
      }
    }
    await pause(record.claimToken);
  }
}

async function releaseMaintenanceClaim(acquired: AcquiredRuntimeMaintenance): Promise<void> {
  if (acquired.released) return;
  await releaseClaimRecord(
    acquired.claimPath,
    RUNTIME_MAINTENANCE_RECORD_FILE,
    acquired.metadata.claimToken,
    parseMaintenanceToken,
    (cause) => new RuntimeMaintenanceClaimError(
      'runtime-maintenance-invalid',
      `Runtime maintenance claim record is invalid: ${acquired.claimPath}`,
      cause
    ),
    () => new RuntimeMaintenanceClaimError(
      'runtime-maintenance-mismatch',
      `Runtime maintenance claim is no longer held by token ${acquired.metadata.claimToken}: ${acquired.claimPath}`
    )
  );
  acquired.released = true;
}

function readMaintenanceRecord(claimPath: string): Promise<RuntimeMaintenanceMetadata | undefined> {
  return readClaimRecord(claimPath, RUNTIME_MAINTENANCE_RECORD_FILE, parseMaintenanceMetadata, (cause) =>
    new RuntimeMaintenanceClaimError(
      'runtime-maintenance-invalid',
      `Runtime maintenance claim record is invalid: ${claimPath}`,
      cause
    ));
}

function isolateMaintenanceRecord(claimPath: string, claimToken: string): Promise<void> {
  return isolateDeadClaimRecord(
    claimPath,
    RUNTIME_MAINTENANCE_RECORD_FILE,
    claimToken,
    parseMaintenanceToken,
    (cause) => new RuntimeMaintenanceClaimError(
      'runtime-maintenance-invalid',
      `Runtime maintenance claim record is invalid: ${claimPath}`,
      cause
    )
  );
}

function parseMaintenanceToken(value: unknown): { ownerToken: string } | undefined {
  const record = parseMaintenanceMetadata(value);
  return record ? { ownerToken: record.claimToken } : undefined;
}

function parseMaintenanceMetadata(value: unknown): RuntimeMaintenanceMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== (record.processStartIdentity === undefined ? 4 : 5)
    || !keys.includes('claimToken')
    || !keys.includes('processId')
    || !keys.includes('rootPointerPath')
    || !keys.includes('startedAt')
    || (record.processStartIdentity !== undefined && !keys.includes('processStartIdentity'))
  ) return undefined;
  if (
    typeof record.claimToken !== 'string' || record.claimToken.length === 0
    || !Number.isSafeInteger(record.processId) || (record.processId as number) <= 0
    || (record.processStartIdentity !== undefined
      && (typeof record.processStartIdentity !== 'string' || record.processStartIdentity.length === 0))
    || typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))
    || typeof record.rootPointerPath !== 'string' || record.rootPointerPath.length === 0
  ) return undefined;
  return value as unknown as RuntimeMaintenanceMetadata;
}

function parseHostLivenessRecord(value: unknown): RuntimeHostLivenessRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.kind !== 'limcode-runtime-host-liveness'
    || typeof record.dataSetId !== 'string' || record.dataSetId.length === 0
    || typeof record.rootInstanceId !== 'string' || record.rootInstanceId.length === 0
    || !Number.isSafeInteger(record.rootGeneration) || (record.rootGeneration as number) <= 0
    || typeof record.hostBootId !== 'string' || record.hostBootId.length === 0
    || typeof record.livenessId !== 'string' || record.livenessId.length === 0
    || !Number.isSafeInteger(record.processId) || (record.processId as number) <= 0
    || (record.processStartIdentity !== undefined
      && (typeof record.processStartIdentity !== 'string' || record.processStartIdentity.length === 0))
    || typeof record.startedAt !== 'string'
    || typeof record.heartbeatAt !== 'string'
  ) return undefined;
  return value as unknown as RuntimeHostLivenessRecord;
}

function malformedDescriptor(name: string, value: unknown): RuntimeHostActiveDescriptor {
  const partial = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  return {
    hostBootId: typeof partial?.hostBootId === 'string' && partial.hostBootId.length > 0
      ? partial.hostBootId
      : name,
    processId: typeof partial?.processId === 'number' && Number.isSafeInteger(partial.processId)
      ? partial.processId
      : null,
    state: 'malformed'
  };
}

function formatHostProcesses(hosts: RuntimeHostActiveDescriptor[]): string {
  const processIds = hosts
    .map((host) => host.processId)
    .filter((processId): processId is number => processId !== null);
  return processIds.length > 0 ? `（进程 ${processIds.join('、')}）` : '';
}
