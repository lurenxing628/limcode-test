import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import { inspectRecordedProcess, ownProcessStartIdentity } from './runtimeClaimPrimitives';
import { resolveVscodeRuntimeMergeLedgerRoot } from './vscodeRootAuthority';

/**
 * Read-only views of foreign history roots that are open. A view (runtimeDataSetHistory) holds the
 * root's foreign claim only while it opens; afterwards it reads message bodies from the located CAS
 * on demand, for as long as it is open. So that 清理备份 never deletes a root under an open view, the
 * view keeps one record in the current configuration root for its whole life
 * (`.limcode-runtime-merges/foreign-views/<id>/<token>.json`, never anything in the foreign
 * directory) naming its process. It is written under the root's claim: a cleanup holding that claim
 * sees every view that could still read the root. A view whose process is proven gone does not count
 * (its record is removed); one whose process cannot be judged counts as open (fail closed).
 */

const VIEWS_DIRECTORY = 'foreign-views';
const VIEW_KIND = 'limcode-foreign-history-view';
const FOREIGN_ID = /^foreign:(archive|copied):[0-9a-f]{16}$/;
const RECORD_NAME = /^[0-9a-f-]{36}\.json$/;
const MAX_RECORD_BYTES = 64 * 1024;

export interface ForeignRuntimeHistoryViewRegistration {
  /** Removes the record (the view closed); safe to call more than once. */
  release(): Promise<void>;
}

interface ViewRecord {
  kind: typeof VIEW_KIND;
  foreignId: string;
  token: string;
  processId: number;
  processStartIdentity?: string;
  openedAt: string;
}

/** Records an open view of foreign root `id` for this process until `release()`. Call under the root's claim. */
export async function registerForeignRuntimeHistoryView(
  configurationRootPath: string,
  id: string
): Promise<ForeignRuntimeHistoryViewRegistration> {
  const directory = await viewsDirectory(configurationRootPath, id);
  const token = randomUUID();
  const identity = ownProcessStartIdentity();
  const record: ViewRecord = {
    kind: VIEW_KIND, foreignId: id, token, processId: process.pid,
    ...(identity !== undefined ? { processStartIdentity: identity } : {}),
    openedAt: new Date().toISOString()
  };
  const file = path.join(directory, `${token}.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await createIn(directory, temporary);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    await syncDirectoryDurably(directory);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await fs.rm(file, { force: true });
      await syncDirectoryDurably(directory).catch(() => undefined);
      // The last view of this root takes its (empty) directory along; another one may be opening.
      await fs.rmdir(directory).catch(() => undefined);
    }
  };
}

/**
 * How many views of foreign root `id` are open: records whose process is alive or cannot be judged
 * (an unreadable record counts too). Records of processes proven gone are removed here.
 */
export async function liveForeignRuntimeHistoryViews(configurationRootPath: string, id: string): Promise<number> {
  const directory = await viewsDirectory(configurationRootPath, id);
  let names: string[];
  try { names = await fs.readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let live = 0;
  for (const name of names) {
    // A writer's temporary is not a record yet (the rename publishes it); anything else is judged.
    if (name.endsWith('.tmp')) continue;
    const file = path.join(directory, name);
    const record = RECORD_NAME.test(name) ? await readRecord(file, id, name) : undefined;
    if (!record) {
      live += 1;
      continue;
    }
    const state = inspectRecordedProcess(record.processId, record.processStartIdentity).state;
    if (state === 'dead') await fs.rm(file, { force: true }).catch(() => undefined);
    else live += 1;
  }
  return live;
}

/**
 * Creates `file` in `directory`, making the directory first. The last view of the same root closing
 * meanwhile (outside the claim) takes the then empty directory away: it is made again.
 */
async function createIn(directory: string, file: string): Promise<FileHandle> {
  for (let attempt = 1; ; attempt += 1) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      return await fs.open(file, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= 3) throw error;
    }
  }
}

async function readRecord(file: string, id: string, name: string): Promise<ViewRecord | undefined> {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.size > MAX_RECORD_BYTES) return undefined;
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<ViewRecord> | null;
    if (value?.kind !== VIEW_KIND || value.foreignId !== id || `${String(value.token)}.json` !== name
      || !Number.isSafeInteger(value.processId) || (value.processId as number) <= 0
      || (value.processStartIdentity !== undefined && (typeof value.processStartIdentity !== 'string' || !value.processStartIdentity))) {
      return undefined;
    }
    return value as ViewRecord;
  } catch {
    return undefined;
  }
}

async function viewsDirectory(configurationRootPath: string, id: string): Promise<string> {
  if (!FOREIGN_ID.test(id)) throw new TypeError(`Not a foreign history id: ${id}`);
  const configurationRoot = path.resolve(configurationRootPath);
  const directory = path.join(resolveVscodeRuntimeMergeLedgerRoot({ globalStoragePath: configurationRoot }), VIEWS_DIRECTORY, id.replace(/:/g, '-'));
  // Nothing below the configuration root is reached through a link.
  let current = configurationRoot;
  for (const segment of path.relative(configurationRoot, directory).split(path.sep)) {
    current = path.join(current, segment);
    let info;
    try { info = await fs.lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Foreign history view path is a symbolic link: ${current}`);
  }
  return directory;
}
