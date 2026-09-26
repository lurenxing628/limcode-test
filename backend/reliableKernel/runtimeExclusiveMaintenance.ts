import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import type { RuntimeRootPaths } from './contracts';
import { classifyRecordedProcess, delay, ownProcessStartIdentity } from './runtimeClaimPrimitives';
import {
  assertRuntimeHostsOffline, isRuntimeHostsActiveError, type RuntimeHostActiveDescriptor
} from './runtimeHostControl';

/**
 * Cooperative exclusivity for offline maintenance on one Runtime root (historical merge, data-root
 * migration, a future epoch upgrade or offline GC). The requester holds configuration admission and
 * the root's maintenance claim, so no Host can register meanwhile; it publishes a request in the
 * root's control directory and waits, bounded, until every registered Host is offline. Participating
 * Hosts finish their running work, then reload; their next startup waits on the same admission.
 * The request is advisory only: exclusivity is still proven by the Host liveness records.
 */
export const RUNTIME_EXCLUSIVE_MAINTENANCE_DIRECTORY = 'exclusive-maintenance';

const REQUEST_FILE = 'request.json';
const PARTICIPANTS_DIRECTORY = 'hosts';
const REQUEST_KIND = 'limcode-runtime-exclusive-maintenance-request';
const PARTICIPANT_KIND = 'limcode-runtime-exclusive-maintenance-participant';

export interface RuntimeExclusiveMaintenanceRequest {
  kind: typeof REQUEST_KIND;
  requestId: string;
  /** Stable operation key, e.g. historical-merge, data-root-migration. */
  operation: string;
  /** Short user-facing reason shown by the other windows before they reload. */
  message: string;
  requesterProcessId: number;
  requesterProcessStartIdentity?: string;
  createdAt: string;
  expiresAt: string;
}

export interface RuntimeExclusiveMaintenanceInput {
  operation: string;
  message: string;
  /** Upper bound for waiting on other Hosts; the operation itself is not bounded here. */
  timeoutMs: number;
  pollMs?: number;
  isCancelled?(): boolean;
  /** Called once when the request is published and waiting starts (e.g. to show progress). */
  onWaitStart?(hosts: readonly RuntimeHostActiveDescriptor[]): void;
  /** Called once when waiting ends, whatever the outcome. */
  onWaitEnd?(): void;
  /** The caller's own registered Host, when it requests exclusivity before closing itself. */
  exceptHostBootId?: string;
}

export type RuntimeExclusiveMaintenanceOutcome<T> =
  | { state: 'completed'; result: T; waited: boolean }
  | { state: 'not-coordinatable' | 'timed-out' | 'cancelled'; hosts: RuntimeHostActiveDescriptor[] };

export function runtimeExclusiveMaintenanceDirectory(paths: RuntimeRootPaths): string {
  return path.join(path.dirname(path.resolve(paths.dataRootPath)), RUNTIME_EXCLUSIVE_MAINTENANCE_DIRECTORY);
}

/**
 * Call inside configuration admission and the root's maintenance claim. Runs the operation at once
 * when no other Host is registered; otherwise waits only if every live Host participates in this
 * protocol (older builds never reload on request, so waiting for them would only delay startup).
 */
export async function requestExclusiveRuntimeMaintenance<T>(
  paths: RuntimeRootPaths,
  input: RuntimeExclusiveMaintenanceInput,
  operation: () => Promise<T>
): Promise<RuntimeExclusiveMaintenanceOutcome<T>> {
  let hosts = await activeHosts(paths, input.exceptHostBootId);
  if (hosts.length === 0) return { state: 'completed', result: await operation(), waited: false };
  if (!await participantsCover(paths, hosts)) return { state: 'not-coordinatable', hosts };
  const request: RuntimeExclusiveMaintenanceRequest = {
    kind: REQUEST_KIND,
    requestId: randomUUID(),
    operation: requireText(input.operation, 'operation'),
    message: requireText(input.message, 'message'),
    requesterProcessId: process.pid,
    ...(ownProcessStartIdentity() !== undefined ? { requesterProcessStartIdentity: ownProcessStartIdentity() } : {}),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + input.timeoutMs).toISOString()
  };
  await writeDurableJson(requestPath(paths), request);
  input.onWaitStart?.(hosts);
  let waiting = true;
  const endWait = (): void => {
    if (!waiting) return;
    waiting = false;
    input.onWaitEnd?.();
  };
  try {
    const deadline = Date.now() + input.timeoutMs;
    for (;;) {
      if (input.isCancelled?.()) return { state: 'cancelled', hosts };
      hosts = await activeHosts(paths, input.exceptHostBootId);
      if (hosts.length === 0) {
        endWait();
        return { state: 'completed', result: await operation(), waited: true };
      }
      if (Date.now() >= deadline) return { state: 'timed-out', hosts };
      await delay(input.pollMs ?? 250);
    }
  } finally {
    endWait();
    await removeRequest(paths, request.requestId);
  }
}

/** A participating Host announces that it reloads on request; call once its Runtime is open. */
export async function registerExclusiveMaintenanceParticipant(
  paths: RuntimeRootPaths,
  hostBootId: string
): Promise<{ unregister(): Promise<void> }> {
  const directory = path.join(runtimeExclusiveMaintenanceDirectory(paths), PARTICIPANTS_DIRECTORY);
  const file = path.join(directory, `${safeName(hostBootId)}.json`);
  await removeDeadParticipants(directory);
  await writeDurableJson(file, {
    kind: PARTICIPANT_KIND,
    hostBootId,
    processId: process.pid,
    ...(ownProcessStartIdentity() !== undefined ? { processStartIdentity: ownProcessStartIdentity() } : {}),
    registeredAt: new Date().toISOString()
  });
  let removed = false;
  return {
    async unregister() {
      if (removed) return;
      removed = true;
      await fs.rm(file, { force: true });
    }
  };
}

/** The current request, only while it is unexpired and its requester process is still alive. */
export async function readExclusiveMaintenanceRequest(
  paths: RuntimeRootPaths
): Promise<RuntimeExclusiveMaintenanceRequest | undefined> {
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(requestPath(paths), 'utf8')) as unknown; }
  catch { return undefined; }
  const request = value as Partial<RuntimeExclusiveMaintenanceRequest> | undefined;
  if (!request || request.kind !== REQUEST_KIND || typeof request.requestId !== 'string'
    || typeof request.operation !== 'string' || typeof request.message !== 'string'
    || typeof request.requesterProcessId !== 'number' || typeof request.expiresAt !== 'string') return undefined;
  const expiresAt = Date.parse(request.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return undefined;
  if (classifyRecordedProcess(request.requesterProcessId, request.requesterProcessStartIdentity) !== 'alive') return undefined;
  return request as RuntimeExclusiveMaintenanceRequest;
}

async function activeHosts(paths: RuntimeRootPaths, exceptHostBootId?: string): Promise<RuntimeHostActiveDescriptor[]> {
  try {
    await assertRuntimeHostsOffline(paths, exceptHostBootId);
    return [];
  } catch (error) {
    if (!isRuntimeHostsActiveError(error)) throw error;
    return [...(error as { hosts: RuntimeHostActiveDescriptor[] }).hosts];
  }
}

async function participantsCover(paths: RuntimeRootPaths, hosts: readonly RuntimeHostActiveDescriptor[]): Promise<boolean> {
  const directory = path.join(runtimeExclusiveMaintenanceDirectory(paths), PARTICIPANTS_DIRECTORY);
  for (const host of hosts) {
    if (host.state !== 'live' || host.processId === null) return false;
    let record: Record<string, unknown>;
    try { record = JSON.parse(await fs.readFile(path.join(directory, `${safeName(host.hostBootId)}.json`), 'utf8')) as Record<string, unknown>; }
    catch { return false; }
    if (record.kind !== PARTICIPANT_KIND || record.hostBootId !== host.hostBootId || record.processId !== host.processId
      || (host.processStartIdentity !== undefined && record.processStartIdentity !== host.processStartIdentity)) return false;
  }
  return true;
}

async function removeDeadParticipants(directory: string): Promise<void> {
  let names: string[];
  try { names = await fs.readdir(directory); }
  catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(directory, name);
    try {
      const record = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      if (typeof record.processId === 'number' && classifyRecordedProcess(
        record.processId, typeof record.processStartIdentity === 'string' ? record.processStartIdentity : undefined
      ) === 'dead') await fs.rm(file, { force: true });
    } catch { /* A concurrently replaced record is left for its owner. */ }
  }
}

async function removeRequest(paths: RuntimeRootPaths, requestId: string): Promise<void> {
  const file = requestPath(paths);
  try {
    const current = JSON.parse(await fs.readFile(file, 'utf8')) as { requestId?: unknown };
    if (current.requestId !== requestId) return;
    await fs.rm(file, { force: true });
    await syncDirectoryDurably(path.dirname(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function requestPath(paths: RuntimeRootPaths): string {
  return path.join(runtimeExclusiveMaintenanceDirectory(paths), REQUEST_FILE);
}

function safeName(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new TypeError('Host boot id is not a safe file name.');
  return value;
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
