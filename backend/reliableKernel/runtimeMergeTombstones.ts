import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import { resolveVscodeRuntimeMergeLedgerRoot } from './vscodeRootAuthority';

/**
 * What a merge into a data set must never bring back, kept beside the merge ledger of its
 * configuration root (never inside a data set, so resetting or replacing one does not lose it):
 *
 * - Deleted-conversation records ("墓碑"): the ids of every conversation the user deleted from a data set
 *   (the whole Subagent tree), one file per deletion, written durably before the deletion commits.
 * - Identity continuations ("身份延续"): the data set of this identity continues the listed earlier
 *   identities (their content went into it, e.g. by a data-root relocation), so a copy of one of them
 *   is an old copy of it, and what the user deleted there stays deleted here. The writer expands chains.
 *
 * Both are read strictly: a record that cannot be read or has an unknown form throws, and the merge
 * waits (never "no record"). A merge reads them for the target and every identity it continues.
 */
export const RUNTIME_DELETED_CONVERSATIONS_DIRECTORY = 'deleted-conversations';
export const RUNTIME_IDENTITY_ALIASES_DIRECTORY = 'aliases';
const RECORD_VERSION = 1;
/** `<UTC time to the millisecond>-<8 hex>.json`, as written by recordRuntimeDeletedConversations. */
const DELETION_RECORD_NAME = /^\d{8}T\d{9}Z-[0-9a-f]{8}\.json$/;
/** A data set identity part, as RootAuthority creates it (a UUID); nothing else names a directory here. */
const IDENTITY_PART = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** More than any real deletion (a Subagent tree of many thousand conversations) takes. */
const MAX_RECORD_BYTES = 64 * 1024 * 1024;

export interface RuntimeMergeIdentity {
  dataSetId: string;
  rootInstanceId: string;
}

export interface RuntimeDeletedConversationsRecord {
  version: 1;
  conversationIds: string[];
  deletedAt: string;
}

/** One earlier identity a data set continues (aliases/<identity>.json, written by a data-root relocation). */
export interface RuntimeIdentityContinuation extends RuntimeMergeIdentity {
  relocationId: string;
  at: string;
}

export interface RuntimeIdentityAliases {
  version: 1;
  continues: RuntimeIdentityContinuation[];
}

/** A deleted-conversation record or an identity continuation that cannot be read: merges wait. */
export class RuntimeMergeRecordUnreadableError extends Error {
  public readonly code = 'runtime-merge-records-unreadable';

  public constructor(message: string) {
    super(message);
    this.name = 'RuntimeMergeRecordUnreadableError';
  }
}

/**
 * Records, durably, that the user deleted these conversations from the data set of `identity`:
 * a new file (temporary file, fsync, rename, directory fsync) under the configuration root. Call it
 * before the deletion commits; a deletion that does not commit leaves a record that names
 * conversations still there, which no merge leaves out (only absent ones are).
 */
export async function recordRuntimeDeletedConversations(
  configurationRootPath: string,
  identity: RuntimeMergeIdentity,
  conversationIds: readonly string[],
  now: Date = new Date()
): Promise<void> {
  const ids = [...new Set(conversationIds)];
  if (ids.length === 0) return;
  if (!ids.every(isConversationId)) throw new TypeError('A deleted-conversation record names only conversation ids.');
  const root = path.resolve(configurationRootPath);
  const directory = deletionDirectory(root, identity);
  await ensureDirectory(root, directory);
  const name = `${now.toISOString().replace(/[-:.]/g, '')}-${randomBytes(4).toString('hex')}.json`;
  if (!DELETION_RECORD_NAME.test(name)) throw new TypeError(`Unexpected deleted-conversation record name ${name}.`);
  const record: RuntimeDeletedConversationsRecord = { version: RECORD_VERSION, conversationIds: ids, deletedAt: now.toISOString() };
  const temporary = path.join(directory, `.${name}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, path.join(directory, name));
  } finally {
    await fs.rm(temporary, { force: true });
  }
  await syncDirectoryDurably(directory);
}

/**
 * Every conversation the user deleted from the data sets of these identities. Throws
 * RuntimeMergeRecordUnreadableError for a record that cannot be read or has an unknown form (a
 * `.json` file of another name, another version or shape, a link or a directory); temporary files
 * of an unfinished write and files other than `.json` are no records.
 */
export async function readRuntimeDeletedConversations(
  configurationRootPath: string,
  identities: readonly RuntimeMergeIdentity[]
): Promise<Set<string>> {
  const root = path.resolve(configurationRootPath);
  const result = new Set<string>();
  for (const identity of identities) {
    const directory = deletionDirectory(root, identity);
    await readable(() => assertNoSymbolicPrefix(root, directory), '删除记录');
    let names: string[];
    try {
      names = (await fs.readdir(directory)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw unreadable('删除记录', error);
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      if (!DELETION_RECORD_NAME.test(name)) throw new RuntimeMergeRecordUnreadableError(`删除记录里有不认识的文件 ${name}`);
      const value = await readRecordJson(path.join(directory, name), '删除记录');
      const record = value as Partial<RuntimeDeletedConversationsRecord> | null;
      if (!exactKeys(record, ['version', 'conversationIds', 'deletedAt']) || record!.version !== RECORD_VERSION
        || !Array.isArray(record!.conversationIds) || record!.conversationIds.length === 0 || !record!.conversationIds.every(isConversationId)
        || !isTime(record!.deletedAt)) {
        throw new RuntimeMergeRecordUnreadableError(`删除记录 ${name} 的格式不认识`);
      }
      for (const id of record!.conversationIds) result.add(id);
    }
  }
  return result;
}

/**
 * The earlier identities the data set of `identity` continues (none without a file). Throws
 * RuntimeMergeRecordUnreadableError for a file that cannot be read or has an unknown form.
 */
export async function readRuntimeIdentityAliases(
  configurationRootPath: string,
  identity: RuntimeMergeIdentity
): Promise<RuntimeIdentityContinuation[]> {
  const root = path.resolve(configurationRootPath);
  const file = path.join(resolveVscodeRuntimeMergeLedgerRoot({ globalStoragePath: root }), RUNTIME_IDENTITY_ALIASES_DIRECTORY, `${identityName(identity)}.json`);
  await readable(() => assertNoSymbolicPrefix(root, path.dirname(file)), '身份延续记录');
  try {
    await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw unreadable('身份延续记录', error);
  }
  const value = await readRecordJson(file, '身份延续记录');
  const aliases = value as Partial<RuntimeIdentityAliases> | null;
  if (!exactKeys(aliases, ['version', 'continues']) || aliases!.version !== RECORD_VERSION || !Array.isArray(aliases!.continues)
    || !aliases!.continues.every((entry: Partial<RuntimeIdentityContinuation> | null) =>
      exactKeys(entry, ['dataSetId', 'rootInstanceId', 'relocationId', 'at']) && isIdentityPart(entry!.dataSetId)
      && isIdentityPart(entry!.rootInstanceId) && typeof entry!.relocationId === 'string' && entry!.relocationId.length > 0
      && isTime(entry!.at))) {
    throw new RuntimeMergeRecordUnreadableError(`身份延续记录 ${path.basename(file)} 的格式不认识`);
  }
  return aliases!.continues.map((entry) => ({ ...entry }));
}

/** The target and every identity it continues: what a merge into it reads records and deletions of. */
export async function readRuntimeMergeTargetIdentities(
  configurationRootPath: string,
  identity: RuntimeMergeIdentity
): Promise<RuntimeMergeIdentity[]> {
  const result: RuntimeMergeIdentity[] = [{ dataSetId: identity.dataSetId, rootInstanceId: identity.rootInstanceId }];
  for (const { dataSetId, rootInstanceId } of await readRuntimeIdentityAliases(configurationRootPath, identity)) {
    if (!result.some((known) => known.dataSetId === dataSetId && known.rootInstanceId === rootInstanceId)) result.push({ dataSetId, rootInstanceId });
  }
  return result;
}

/** `<dataSetId>.<rootInstanceId>`: the name of an identity's records. */
export function runtimeMergeIdentityName(identity: RuntimeMergeIdentity): string {
  return identityName(identity);
}

function identityName(identity: RuntimeMergeIdentity): string {
  if (!isIdentityPart(identity.dataSetId) || !isIdentityPart(identity.rootInstanceId)) {
    throw new RuntimeMergeRecordUnreadableError('这个历史库的身份不是本版本能记录的格式');
  }
  return `${identity.dataSetId}.${identity.rootInstanceId}`;
}

function deletionDirectory(root: string, identity: RuntimeMergeIdentity): string {
  return path.join(resolveVscodeRuntimeMergeLedgerRoot({ globalStoragePath: root }), RUNTIME_DELETED_CONVERSATIONS_DIRECTORY, identityName(identity));
}

function isIdentityPart(value: unknown): value is string {
  return typeof value === 'string' && IDENTITY_PART.test(value);
}

function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

/** A regular file of this directory (never a link), parsed. */
async function readRecordJson(file: string, what: string): Promise<unknown> {
  let text: string;
  try {
    const info = await fs.lstat(file);
    if (!info.isFile()) throw new RuntimeMergeRecordUnreadableError(`${what} ${path.basename(file)} 不是普通文件`);
    if (info.size > MAX_RECORD_BYTES) throw new RuntimeMergeRecordUnreadableError(`${what} ${path.basename(file)} 过大`);
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    throw unreadable(what, error);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RuntimeMergeRecordUnreadableError(`${what} ${path.basename(file)} 不是完整的 JSON`);
  }
}

async function readable(check: () => Promise<void>, what: string): Promise<void> {
  try {
    await check();
  } catch (error) {
    throw unreadable(what, error);
  }
}

function unreadable(what: string, error: unknown): RuntimeMergeRecordUnreadableError {
  if (error instanceof RuntimeMergeRecordUnreadableError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return new RuntimeMergeRecordUnreadableError(`${what}读不出（${typeof code === 'string' ? `${code}：` : ''}${message}）`);
}

/** No symbolic link from the configuration root down to `target` (a missing tail is allowed). */
async function assertNoSymbolicPrefix(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Merge records escape their configuration root.');
  }
  let current = root;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, segment);
    let info;
    try { info = await fs.lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`合并记录的路径是符号链接：${current}`);
    if (!info.isDirectory()) throw new Error(`合并记录的路径不是目录：${current}`);
  }
}

/** Creates the missing directories down to `directory`, each made durable in its parent; never through a link. */
async function ensureDirectory(root: string, directory: string): Promise<void> {
  await assertNoSymbolicPrefix(root, directory);
  let current = root;
  for (const segment of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    const parent = current;
    current = path.join(current, segment);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await fs.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`合并记录的路径不是目录：${current}`);
      continue;
    }
    await syncDirectoryDurably(parent);
  }
}
