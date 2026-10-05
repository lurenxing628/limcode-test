import { createHash } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  requireCasObjectIdentity, type CasByteAccess, type CasObjectIdentity, type SynchronousCasByteAccess
} from './casObjectAccess';
import { VerifiedContentRanges } from './verifiedContentRanges';

/** Physical capability for the loose transfer/publisher adapters, not an object read contract. */
export interface LooseCasObjectLocation {
  kind: 'loose';
  absolutePath: string;
}

export function looseCasObjectLocation(casRoot: string, object: CasObjectIdentity): LooseCasObjectLocation {
  return { kind: 'loose', absolutePath: resolvedLooseCasPath(path.resolve(casRoot), object) };
}

function resolvedLooseCasPath(root: string, object: CasObjectIdentity): string {
  const identity = requireCasObjectIdentity(object);
  // Every segment comes from a validated digest. Resolve the root once per reader, not per worker
  // context record; symbolic local roots retain their existing policy.
  return path.join(root, 'sha256', identity.sha256.slice(0, 2), identity.sha256);
}

export function verifyCasObjectBytes(object: CasObjectIdentity, bytes: Buffer): Buffer {
  if (BigInt(bytes.length) !== object.byte_length) throw new Error('CAS object byte length mismatch.');
  if (createHash('sha256').update(bytes).digest('hex') !== object.sha256) throw new Error('CAS object digest mismatch.');
  return bytes;
}

/** Local root policy permits symbolic CAS paths; the owner retains its RootBinding fence. */
export class LocalCasByteAccess implements CasByteAccess {
  private readonly root: string;
  private readonly ranges = new VerifiedContentRanges();

  public constructor(casRoot: string) { this.root = path.resolve(casRoot); }

  public async readBytes(object: CasObjectIdentity): Promise<Buffer> {
    return verifyCasObjectBytes(object, await fs.readFile(resolvedLooseCasPath(this.root, object)));
  }

  public async readRange(object: CasObjectIdentity, offset: number, length: number): Promise<Buffer> {
    return this.ranges.read(this.root, resolvedLooseCasPath(this.root, object), object.sha256, object.byte_length, offset, length);
  }

  /** Backup coverage has always rejected a symbolic leaf and never opened/hashed its body. */
  public async inspectByteLength(object: CasObjectIdentity): Promise<bigint | undefined> {
    const info = await fs.lstat(resolvedLooseCasPath(this.root, object), { bigint: true }).catch(() => undefined);
    return info?.isFile() === true ? info.size : undefined;
  }

  public async containsExactLength(object: CasObjectIdentity): Promise<boolean> {
    return await this.inspectByteLength(object) === object.byte_length;
  }

  public inspectRanges(): ReturnType<VerifiedContentRanges['inspect']> { return this.ranges.inspect(); }
}

/** Bounded worker callers keep their existing caches and request limits outside the byte adapter. */
export class LocalSynchronousCasByteAccess implements SynchronousCasByteAccess {
  private readonly root: string;

  public constructor(casRoot: string) { this.root = path.resolve(casRoot); }

  public readBytes(object: CasObjectIdentity): Buffer {
    return verifyCasObjectBytes(object, fsSync.readFileSync(resolvedLooseCasPath(this.root, object)));
  }

  public assertPublished(object: CasObjectIdentity): void {
    const info = fsSync.statSync(resolvedLooseCasPath(this.root, object));
    if (!info.isFile() || BigInt(info.size) !== object.byte_length) {
      throw new Error('ContentObject CAS file is missing or has the wrong length.');
    }
  }
}
