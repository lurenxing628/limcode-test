import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileDescriptorMatchesPathState, fileStateIdentity } from './fileTargetBoundary';

const MAX_IDENTITIES = 128;
const MAX_ACTIVE_READS = 8;
const HASH_CHUNK_BYTES = 1024 * 1024;

/** Metadata only: paging does not depend on retaining entire objects in the byte cache. */
export class VerifiedContentRanges {
  private readonly verified = new Map<string, string>();
  private readonly flights = new Map<string, Promise<void>>();
  private verifications = 0;
  private activeHandles = 0;
  private activeReads = 0;
  private readonly waiting: Array<() => void> = [];

  public inspect(): { entries: number; inflight: number; verifications: number; activeHandles: number; maxEntries: number } {
    return { entries: this.verified.size, inflight: this.flights.size, verifications: this.verifications,
      activeHandles: this.activeHandles, maxEntries: MAX_IDENTITIES };
  }

  public async read(root: string, file: string, digest: string, length: bigint, offset: number, count: number): Promise<Buffer> {
    if (this.activeReads >= MAX_ACTIVE_READS) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.activeReads += 1;
    try {
      return await this.readRange(root, file, digest, length, offset, count);
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.activeReads -= 1;
    }
  }

  private async readRange(root: string, file: string, digest: string, length: bigint, offset: number, count: number): Promise<Buffer> {
    assertContainedPath(root, file);
    // Local CAS historically permits symbolic storage paths. Pin their canonical target instead
    // of changing that policy; every phase checks that the logical path still names this target.
    const canonical = await fs.realpath(file);
    const pathname = await fs.lstat(canonical, { bigint: true });
    if (!pathname.isFile() || pathname.size !== length) throw new Error('CAS object byte length mismatch.');
    const pathnameIdentity = fileStateIdentity(pathname);
    const handle = await fs.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    this.activeHandles += 1;
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size !== length) throw new Error('CAS object byte length mismatch.');
      if (!fileDescriptorMatchesPathState(pathname, before)) throw new Error('CAS object was replaced before range read.');
      // Only the pathname-to-descriptor bridge admits Windows volume-serial differences. Cache
      // and later same-interface fences retain both complete, original identities independently.
      const descriptorIdentity = fileStateIdentity(before);
      const identity = `${canonical}\0${pathnameIdentity}\0${descriptorIdentity}`;
      const key = `${file}\0${digest}\0${length}`;
      await assertCurrentFile(file, canonical, pathnameIdentity);
      if (this.verified.get(key) !== identity) {
        this.verified.delete(key);
        // Sharing only an exact identity prevents a replacement from borrowing an old verification.
        const flightKey = `${key}\0${identity}`;
        let flight = this.flights.get(flightKey);
        if (!flight) {
          flight = this.verify(handle, length, digest).then(async () => {
            if (fileStateIdentity(await handle.stat({ bigint: true })) !== descriptorIdentity) throw new Error('CAS object changed during verification.');
            await assertCurrentFile(file, canonical, pathnameIdentity);
            this.verified.delete(key);
            this.verified.set(key, identity);
            while (this.verified.size > MAX_IDENTITIES) this.verified.delete(this.verified.keys().next().value!);
          }).finally(() => { this.flights.delete(flightKey); });
          this.flights.set(flightKey, flight);
        }
        await flight;
      } else {
        this.verified.delete(key);
        this.verified.set(key, identity);
      }
      const bytes = Buffer.alloc(count);
      let read = 0;
      while (read < count) {
        const part = await handle.read(bytes, read, count - read, offset + read);
        if (part.bytesRead === 0) throw new Error('CAS object truncated during range read.');
        read += part.bytesRead;
      }
      if (fileStateIdentity(await handle.stat({ bigint: true })) !== descriptorIdentity) throw new Error('CAS object changed during range read.');
      await assertCurrentFile(file, canonical, pathnameIdentity);
      return bytes;
    } finally {
      try { await handle.close(); } finally { this.activeHandles -= 1; }
    }
  }

  private async verify(handle: fs.FileHandle, length: bigint, digest: string): Promise<void> {
    this.verifications += 1;
    const hash = createHash('sha256');
    const bytes = Buffer.alloc(HASH_CHUNK_BYTES);
    let offset = 0;
    while (BigInt(offset) < length) {
      const count = Math.min(bytes.length, Number(length - BigInt(offset)));
      const part = await handle.read(bytes, 0, count, offset);
      if (part.bytesRead === 0) throw new Error('CAS object truncated during verification.');
      hash.update(bytes.subarray(0, part.bytesRead));
      offset += part.bytesRead;
    }
    if (hash.digest('hex') !== digest) throw new Error('CAS object digest mismatch.');
  }
}

async function assertCurrentFile(file: string, canonical: string, identity: string): Promise<void> {
  if (await fs.realpath(file) !== canonical) throw new Error('CAS object target changed during range read.');
  const current = await fs.lstat(canonical, { bigint: true });
  if (!current.isFile() || fileStateIdentity(current) !== identity) {
    throw new Error('CAS object was replaced during range read.');
  }
}

function assertContainedPath(root: string, file: string): void {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('CAS range path escapes its active root.');
  }
}
