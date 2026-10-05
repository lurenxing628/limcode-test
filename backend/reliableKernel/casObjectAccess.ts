/** Logical immutable CAS identity. storage_key is a digest key, never a consumer filename. */
export interface CasObjectIdentity {
  sha256: string;
  byte_length: bigint;
  storage_key: string;
}

export interface CasByteAccess {
  readBytes(object: CasObjectIdentity): Promise<Buffer>;
  readRange(object: CasObjectIdentity, offset: number, length: number): Promise<Buffer>;
  /** Observed regular-body length, for bounded caller-owned presence caches. No digest proof. */
  inspectByteLength(object: CasObjectIdentity): Promise<bigint | undefined>;
  /** Presence/length proof only; does not introduce a digest read into backup coverage. */
  containsExactLength(object: CasObjectIdentity): Promise<boolean>;
}

/** Owned by the Runtime worker; never used for synchronous extension-host body I/O. */
export interface SynchronousCasByteAccess {
  readBytes(object: CasObjectIdentity): Buffer;
  /** Admission retains its existing regular-file/length proof, without hashing every commit. */
  assertPublished(object: CasObjectIdentity): void;
}

export function storageKeyForDigest(sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new TypeError('CAS digest must be lowercase SHA-256.');
  return `sha256/${sha256.slice(0, 2)}/${sha256}`;
}

export function requireCasObjectIdentity(object: {
  sha256?: unknown;
  byte_length?: unknown;
  storage_key?: unknown;
}): CasObjectIdentity {
  if (typeof object.sha256 !== 'string') throw new TypeError('CAS digest must be lowercase SHA-256.');
  const key = storageKeyForDigest(object.sha256);
  if (object.storage_key !== key) throw new Error('ContentObject storage key does not match sha256.');
  if (typeof object.byte_length !== 'bigint' || object.byte_length < 0n) {
    throw new TypeError('ContentObject byte length must be non-negative.');
  }
  return { sha256: object.sha256, byte_length: object.byte_length, storage_key: key };
}

export function casObjectFromStorageKey(storageKey: string, byteLength: bigint): CasObjectIdentity {
  return requireCasObjectIdentity({ sha256: storageKey.slice('sha256/00/'.length), storage_key: storageKey, byte_length: byteLength });
}
