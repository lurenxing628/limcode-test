import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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
  type RecordedProcessInspection
} from './runtimeClaimPrimitives';

export const RUNTIME_HOST_LIVENESS_DIRECTORY = 'host-liveness';
export const RUNTIME_MAINTENANCE_RECORD_FILE = 'owner.json';

const RUNTIME_MAINTENANCE_SUFFIX = '.runtime-maintenance';
const RUNTIME_ADMISSION_SUFFIX = '.runtime-admission';
const MAINTENANCE_RETRY_DELAY_MS = 50;

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
  operation: () => Promise<T>
): Promise<T> {
  return withRuntimeClaim(runtimeMaintenanceClaimPath(paths), paths.rootPointerPath, operation);
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
  operation: () => Promise<T>
): Promise<T> {
  const configurationRoot = path.resolve(
    requireNonEmptyText(configurationRootPath, 'configurationRootPath')
  );
  return withRuntimeClaim(
    runtimeDataRootAdmissionClaimPath(configurationRoot),
    configurationRoot,
    operation
  );
}

async function withRuntimeClaim<T>(
  claimPath: string,
  targetPath: string,
  operation: () => Promise<T>
): Promise<T> {
  const scope = RUNTIME_MAINTENANCE_SCOPE.getStore();
  const inherited = scope?.get(claimPath);
  // Only a live claim joins reentrantly. An async callback that escaped its originating scope
  // inherits the context map but finds the claim inactive, so it reacquires the mutex instead
  // of running unprotected after the outer scope already released it.
  if (inherited?.active) return operation();
  const acquired = await acquireMaintenanceClaim(claimPath, targetPath);
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
  const directory = runtimeHostLivenessDirectory(paths);
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
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
    const state = classifyRecordedProcess(record.processId, record.processStartIdentity);
    if (state === 'dead') continue;
    active.push({
      hostBootId: record.hostBootId,
      processId: record.processId,
      ...(record.processStartIdentity !== undefined ? { processStartIdentity: record.processStartIdentity } : {}),
      heartbeatAt: record.heartbeatAt,
      state: state === 'alive' ? 'live' : 'unknown'
    });
  }
  if (active.length > 0) throw new RuntimeHostsActiveError(active);
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
  rootPointerPath: string
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
  for (;;) {
    if (await tryPublishClaimRecord(claimPath, RUNTIME_MAINTENANCE_RECORD_FILE, `${JSON.stringify(metadata)}\n`)) {
      return { claimPath, metadata, active: true, released: false };
    }
    const record = await readMaintenanceRecord(claimPath);
    if (!record) continue;
    if (record.processId === process.pid && record.processStartIdentity === ownIdentity) {
      // Another async scope in this same process holds the claim; wait for its release.
      await delay(MAINTENANCE_RETRY_DELAY_MS);
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
      throw new RuntimeMaintenanceBusyError(
        claimPath,
        record,
        `liveness re-check failed with ${code ?? String(error)}`
      );
    }
    await delay(MAINTENANCE_RETRY_DELAY_MS);
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
