import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, lstatSync, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import { requireCasObjectIdentity, type CasObjectIdentity } from './casObjectAccess';
import { looseCasObjectLocation } from './looseCasObjectAccess';
import { RUNTIME_KERNEL_EPOCH, type RootBinding } from './contracts';
import type { HistoricalRootBinding } from './rootAuthority';
import type { CasStoreAccess } from './runtimeCasAccess';
import { PackedCasWorkerClient } from './packedCasWorkerClient';
import { PACKED_CAS_FILE } from './packedCasWorkerProtocol';
import type { RuntimeCasVerifier as CasVerification } from './runtimeCasVerificationCache';
import { knownDiskDevice } from './runtimeDataSetLargeMergeSpace';

/** Sequential bytes, without requiring a consumer to own or name a filesystem object. */
export interface CasObjectReadHandle {
  read(buffer: Buffer, offset: number, length: number, position: null): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/** Copy-only capability: safe located readers never expose a hard-link optimization. */
export interface CasTransferSource {
  /** Explicit packed capability; absence denotes the historical loose-only source contract. */
  readPackedBytes?(object: CasObjectIdentity): Promise<Buffer | undefined>;
  size(object: CasObjectIdentity): Promise<bigint | undefined>;
  open(object: CasObjectIdentity): Promise<CasObjectReadHandle>;
}

export interface CasTransferOptions {
  verified: CasVerification;
  verifyOnly?: boolean;
  sourceObjects?: CasTransferSource;
  sourceAccess?: CasStoreAccess;
  /** Borrowed private packed reader, owned by the metadata snapshot being transferred. */
  sourcePacked?: CasPackedSource;
  targetAccess?: CasStoreAccess;
  linkFile?: (from: string, to: string) => Promise<void>;
}

export interface CasPackedSource {
  readBytes(object: CasObjectIdentity): Promise<Buffer | undefined>;
}

export class CasTransferError extends Error {
  public constructor(public readonly outcome: {
    kind: 'failed' | 'blocked'; code: string; message: string;
  }) { super(outcome.message); }
}

/** Suffix of a private temporary copy under the loose target's tmp directory. */
export const RUNTIME_DATA_SET_CAS_COPY_SUFFIX = '.merge.tmp';
const CAS_COPY_SUFFIX = RUNTIME_DATA_SET_CAS_COPY_SUFFIX;

/**
 * Logical transfer boundary. Packed bodies use the root worker; legacy loose publication, link
 * optimization and physical verification-cache identities remain inside this adapter.
 */
export class LocalCasTransferSession {
  private readonly sourceCas: string;
  private readonly targetCas: string;
  private readonly temporaryRoot: string;
  private readonly touchedDirectories = new Set<string>();
  private temporaryUsed = false;
  private readonly verified: CasVerification;
  private readonly link: (from: string, to: string) => Promise<void>;
  private targetPacked?: PackedCasWorkerClient;
  private closed = false;
  private closing = false;

  private constructor(sourceCas: string, targetCas: string, private readonly options: CasTransferOptions) {
    this.sourceCas = path.resolve(sourceCas);
    this.targetCas = path.resolve(targetCas);
    this.temporaryRoot = path.join(this.targetCas, 'tmp');
    this.verified = options.verified;
    this.link = options.linkFile ?? ((from, to) => fs.link(from, to));
  }

  public static async open(source: HistoricalRootBinding, target: HistoricalRootBinding, options: CasTransferOptions): Promise<LocalCasTransferSession> {
    const session = new LocalCasTransferSession(source.paths.casRootPath, target.paths.casRootPath, options);
    try {
      // A source without a Runtime Host must provide a private snapshot owner. Opening its real
      // sidecar here could outlive the source claim and race root relocation or removal.
      if (!options.sourceObjects && !options.sourceAccess && !options.sourcePacked && source.runtimeKernelEpoch === RUNTIME_KERNEL_EPOCH) {
        throw new Error('Current-epoch CAS transfer requires a source Runtime owner or private packed snapshot.');
      }
      if (!options.targetAccess && target.runtimeKernelEpoch === RUNTIME_KERNEL_EPOCH) {
        session.targetPacked = await PackedCasWorkerClient.open(target as RootBinding, { readOnly: options.verifyOnly });
      }
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  /** The pre-copy space proof never reads or hashes a body, and counts only absent locations. */
  public async needsCopy(object: CasObjectIdentity): Promise<boolean> {
    this.assertOpen();
    if (await this.targetPackedLength(object) !== undefined) return false;
    return lstatSync(looseCasObjectLocation(this.targetCas, object).absolutePath, { throwIfNoEntry: false }) === undefined;
  }

  public async transfer(object: CasObjectIdentity): Promise<'reused' | 'copied' | 'linked' | 'verified'> {
    this.assertOpen();
    const row = requireCasObjectIdentity(object);
    // A present packed row is authoritative and verifies only this bounded body. Corruption must
    // not fall through to an unrelated loose copy or overwrite the row.
    const packedTarget = this.options.targetAccess
      ? await this.options.targetAccess.readPackedBytes(row) : await this.targetPacked?.readBytes(row);
    if (packedTarget !== undefined) return 'reused';
    const target = looseCasObjectLocation(this.targetCas, row);
    const targetFile = target.absolutePath;
    const verified = this.verified;
    // One metadata check: unchanged objects verified by this or a prior pass are never rehashed.
    const existing = lstatSync(targetFile, { bigint: true, throwIfNoEntry: false });
    if (existing !== undefined) {
      if (!existing.isFile()) {
        throw new CasTransferError({ kind: 'blocked', code: 'runtime-data-set-merge-target-cas-damaged', message: `当前历史库里的正文位置不是普通文件：${row.storage_key}。为免覆盖，暂不合并。` });
      }
      if (existing.size !== row.byte_length
        || (verified.get(targetFile) !== fileIdentity(existing) && !await hasDigest(targetFile, row.sha256, verified))) {
        throw new CasTransferError({ kind: 'blocked', code: 'runtime-data-set-merge-target-cas-damaged', message: `当前历史库里的正文文件已损坏：${row.storage_key}。为免覆盖，暂不合并。` });
      }
      return 'reused';
    }
    const invalid = (): CasTransferError => new CasTransferError({
      kind: 'failed', code: 'runtime-data-set-merge-source-cas-invalid', message: `来源缺少正文文件或内容与摘要不符：${row.storage_key}。`
    });
    const objects = this.options.sourceObjects;
    const packedSource = objects ? await objects.readPackedBytes?.(row)
      : this.options.sourceAccess ? await this.options.sourceAccess.readPackedBytes(row) : await this.options.sourcePacked?.readBytes(row);
    if (packedSource !== undefined) {
      if (this.options.verifyOnly) return 'verified';
      if (this.options.targetAccess) await this.options.targetAccess.publishBatch([{ object: row, bytes: packedSource }], () => undefined);
      else if (this.targetPacked) await this.targetPacked.publishBatch([{ object: row, bytes: packedSource }]);
      else throw new Error('A packed CAS body requires a current-epoch target owner.');
      return 'copied';
    }
    if (objects) {
      if (await objects.size(row) !== row.byte_length) throw invalid();
      if (this.options.verifyOnly) {
        if (await objectDigest(objects, row, row.byte_length) !== row.sha256) throw invalid();
        return 'verified';
      }
      await this.prepareTarget(targetFile);
      await this.prepareTemporary();
      if (!await copyObjectIntoCas(objects, this.temporaryRoot, row, targetFile, row.sha256, row.byte_length, verified)) throw invalid();
      this.touchedDirectories.add(path.dirname(targetFile));
      return 'copied';
    }
    // A loose location is an explicit backend capability. Copy-only sources never enter this path.
    const source = looseCasObjectLocation(this.sourceCas, row);
    const sourceFile = source.absolutePath;
    const sourceSize = await regularFileSize(sourceFile).catch((error: unknown) => {
      if (error instanceof NotRegularFile) return undefined;
      throw error;
    });
    if (sourceSize !== row.byte_length || !await hasDigest(sourceFile, row.sha256, verified)) throw invalid();
    if (this.options.verifyOnly) return 'verified';
    await this.prepareTarget(targetFile);
    let copied = false;
    try {
      await this.link(sourceFile, targetFile);
      await rememberLinked(sourceFile, targetFile, verified);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        if (await regularFileSize(targetFile) !== row.byte_length || await sha256File(targetFile) !== row.sha256) throw error;
      } else if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EMLINK') {
        await this.prepareTemporary();
        await copyIntoCas(this.temporaryRoot, sourceFile, targetFile, row.sha256, verified);
        copied = true;
      } else {
        throw error;
      }
    }
    this.touchedDirectories.add(path.dirname(targetFile));
    return copied ? 'copied' : 'linked';
  }

  /** Complete durable publication before the caller commits any referencing metadata. */
  public async finish(): Promise<void> {
    for (const directory of this.touchedDirectories) await syncDirectoryDurably(directory);
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    if (this.temporaryUsed) await syncDirectoryDurably(this.temporaryRoot).catch(() => undefined);
    // Borrowed Runtime owners remain open. A failed close keeps this session retryable and fenced.
    await this.targetPacked?.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closing || this.closed) throw new Error('CAS transfer session is closed.');
    this.options.sourceAccess?.assertUsable();
    this.options.targetAccess?.assertUsable();
  }

  private targetPackedLength(object: CasObjectIdentity): Promise<bigint | undefined> {
    return this.options.targetAccess ? this.options.targetAccess.inspectPackedByteLength(object)
      : this.targetPacked?.inspectByteLength(object) ?? Promise.resolve(undefined);
  }

  private async prepareTarget(targetFile: string): Promise<void> {
    const digestRoot = path.join(this.targetCas, 'sha256');
    await ensureDirectory(this.targetCas, digestRoot, this.touchedDirectories);
    await ensureDirectory(digestRoot, path.dirname(targetFile), this.touchedDirectories);
  }

  private async prepareTemporary(): Promise<void> {
    if (this.temporaryUsed) return;
    await fs.mkdir(this.temporaryRoot, { recursive: true });
    this.temporaryUsed = true;
  }
}

/** Loose stores may link on the same known disk; copy-only sources bypass this optimization. */
export async function casTransferCanLinkRoots(sourceCas: string, targetCas: string): Promise<boolean> {
  // A mutable SQLite container is never linked. Counting every logical body as a copy is a
  // conservative estimate for mixed roots and does not inventory or hash packed objects.
  if (await fs.lstat(path.join(sourceCas, PACKED_CAS_FILE)).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  })) return false;
  const [source, target] = await Promise.all([sourceCas, targetCas]
    .map((directory) => fs.stat(directory).then((info) => knownDiskDevice(info.dev), () => undefined)));
  return source !== undefined && source === target;
}

/** Physical packed-copy allowance, including SQLite staging files; never reads or hashes bodies. */
export async function casTransferPackedStorageBytes(casRoot: string): Promise<number> {
  let bytes = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    const info = await fs.lstat(path.join(casRoot, `${PACKED_CAS_FILE}${suffix}`)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info) continue;
    if (!info.isFile()) throw new Error('Packed CAS storage must consist of regular files.');
    bytes += info.size;
  }
  return bytes;
}

/**
 * Copy, fsync and verify a private temporary file; only verified bytes are linked into the CAS.
 * The temporary directory is synced once by the caller, not per object.
 */
async function copyIntoCas(
  temporaryRoot: string,
  sourceFile: string,
  targetFile: string,
  digest: string,
  verified: CasVerification
): Promise<void> {
  const temporary = path.join(temporaryRoot, `${process.pid}-${randomUUID()}${CAS_COPY_SUFFIX}`);
  let published = false;
  try {
    await fs.copyFile(sourceFile, temporary, constants.COPYFILE_EXCL);
    await fs.chmod(temporary, 0o600);
    const handle = await fs.open(temporary, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    if (await sha256File(temporary) !== digest) {
      throw new CasTransferError({ kind: 'failed', code: 'runtime-data-set-merge-source-cas-invalid', message: `复制出的正文文件摘要不符：${path.basename(targetFile)}。` });
    }
    try {
      await fs.link(temporary, targetFile);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await sha256File(targetFile) !== digest) throw error;
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
  // The published inode is the verified private copy; recorded once its temporary name is gone
  // (every link count change moves the ctime).
  if (published) {
    verified.delete(sourceFile);
    verified.set(targetFile, fileIdentity(await fs.lstat(targetFile, { bigint: true })));
  }
}

/**
 * One object of a copy-only source: read through its descriptor into a private temporary file while
 * hashed (never more than its recorded length), fsynced, and linked into the CAS only when exactly
 * those bytes. False when the bytes are not the recorded ones (nothing is published then).
 */
async function copyObjectIntoCas(
  objects: CasTransferSource,
  temporaryRoot: string,
  object: CasObjectIdentity,
  targetFile: string,
  digest: string,
  length: bigint,
  verified: CasVerification
): Promise<boolean> {
  const temporary = path.join(temporaryRoot, `${process.pid}-${randomUUID()}${CAS_COPY_SUFFIX}`);
  let published = false;
  try {
    const hash = createHash('sha256');
    let copied = 0n;
    const input = await objects.open(object);
    try {
      const output = await fs.open(temporary, 'wx', 0o600);
      try {
        const buffer = Buffer.allocUnsafe(objectBufferSize(length));
        while (copied <= length) {
          const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          hash.update(buffer.subarray(0, bytesRead));
          for (let written = 0; written < bytesRead;) written += (await output.write(buffer, written, bytesRead - written)).bytesWritten;
          copied += BigInt(bytesRead);
        }
        await output.sync();
      } finally { await output.close(); }
    } finally { await input.close(); }
    if (copied !== length || hash.digest('hex') !== digest) return false;
    try {
      await fs.link(temporary, targetFile);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await sha256File(targetFile) !== digest) throw error;
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
  if (published) verified.set(targetFile, fileIdentity(await fs.lstat(targetFile, { bigint: true })));
  return true;
}

/** One read holds a small object and one byte more (a longer file shows at once); at most 1 MiB. */
function objectBufferSize(length: bigint): number {
  return Number(length < 1024n * 1024n ? length + 1n : 1024n * 1024n);
}

/** sha256 of an object read through its safe descriptor (never more than its recorded length). */
async function objectDigest(objects: CasTransferSource, object: CasObjectIdentity, length: bigint): Promise<string | undefined> {
  const hash = createHash('sha256');
  let read = 0n;
  const input = await objects.open(object);
  try {
    const buffer = Buffer.allocUnsafe(objectBufferSize(length));
    while (read <= length) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      read += BigInt(bytesRead);
    }
  } finally { await input.close(); }
  return read === length ? hash.digest('hex') : undefined;
}

/**
 * A hard link changes the shared inode's ctime. When the inode is still the one whose bytes were
 * just verified (same device, inode, size and mtime), the published name is recorded with its new
 * identity, so a later pass (the exclusive phase after an online pre-copy) does not hash it again.
 */
async function rememberLinked(sourceFile: string, targetFile: string, verified: CasVerification): Promise<void> {
  const before = verified.get(sourceFile);
  if (before === undefined) return;
  const after = await fs.lstat(targetFile, { bigint: true }).then(fileIdentity, () => undefined);
  if (after === undefined) return;
  // Only the published name is kept: a later pass checks the target object, and the source name
  // is needed again only after the target was discarded (which changes the ctime anyway).
  verified.delete(sourceFile);
  if (sameContentIdentity(before, after)) verified.set(targetFile, after);
}

class NotRegularFile extends Error {}

async function regularFileSize(file: string): Promise<bigint | undefined> {
  try {
    const info = await fs.lstat(file, { bigint: true });
    if (!info.isFile()) throw new NotRegularFile(`CAS entry is not a regular file: ${file}`);
    return info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function ensureDirectory(parent: string, directory: string, touched: Set<string>): Promise<void> {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    touched.add(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`CAS path is not a directory: ${directory}`);
  }
}

/** sha256 of a file; one verified before and unchanged since (same device, inode, size, times) is not read again. */
async function hasDigest(file: string, digest: string, verified: CasVerification): Promise<boolean> {
  const identity = fileIdentity(await fs.lstat(file, { bigint: true }));
  if (verified.get(file) === identity) return true;
  if (await sha256File(file) !== digest) return false;
  verified.set(file, identity);
  return true;
}

function fileIdentity(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

/** Same device, inode, size and mtime (the ctime may differ: a link count change). */
function sameContentIdentity(left: string, right: string): boolean {
  return left.slice(0, left.lastIndexOf(':')) === right.slice(0, right.lastIndexOf(':'));
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
