import type { RootBinding } from './contracts';
import { ExecutionHandoffError } from './executionLeaseFence';
import { requireCasObjectIdentity, type CasByteAccess, type CasObjectIdentity } from './casObjectAccess';
import { LocalCasByteAccess, looseCasObjectLocation, type LooseCasObjectLocation } from './looseCasObjectAccess';
import { publishLooseCasObject } from './looseCasObjectPublication';
import { PackedCasWorkerClient } from './packedCasWorkerClient';
import { PACKED_CAS_MAX_BODY_BYTES } from './packedCasWorkerProtocol';

export const SMALL_CAS_MAX_BYTES = PACKED_CAS_MAX_BODY_BYTES;
export type CasPublicationLocation = LooseCasObjectLocation | { kind: 'packed' };
export type CasPublicationMetric = 'temp-write' | 'file-fsync' | 'directory-fsync';
export interface CasPublicationInput { object: CasObjectIdentity; bytes: Buffer }

/** Borrowed by facades; RuntimeDatabase owns the worker and awaits its close before releasing roots. */
export interface CasStoreAccess extends CasByteAccess {
  assertUsable(): void;
  readPackedBytes(object: CasObjectIdentity): Promise<Buffer | undefined>;
  inspectPackedByteLength(object: CasObjectIdentity): Promise<bigint | undefined>;
  publishBatch(inputs: readonly CasPublicationInput[], metric: (metric: CasPublicationMetric) => void): Promise<CasPublicationLocation[]>;
  inspectRanges(): ReturnType<LocalCasByteAccess['inspectRanges']>;
}

/** Explicit old-format adapter for historical fixtures and tests of loose-file semantics. */
export class LooseCasStoreAccess extends LocalCasByteAccess implements CasStoreAccess {
  public constructor(private readonly casRoot: string) { super(casRoot); }
  public assertUsable(): void {}
  public async readPackedBytes(_object: CasObjectIdentity): Promise<undefined> { return undefined; }
  public async inspectPackedByteLength(_object: CasObjectIdentity): Promise<undefined> { return undefined; }
  public async publishBatch(inputs: readonly CasPublicationInput[], metric: (metric: CasPublicationMetric) => void): Promise<CasPublicationLocation[]> {
    return Promise.all(inputs.map(async ({ object, bytes }) => {
      await publishLooseCasObject(this.casRoot, bytes, object, metric);
      return looseCasObjectLocation(this.casRoot, object);
    }));
  }
}

/** One root-scoped owner. Small SQLite work is performed only in its separate bounded worker. */
export class RuntimeCasAccess implements CasStoreAccess {
  private readonly loose: LocalCasByteAccess;
  private readonly active = new Set<Promise<unknown>>();
  private fenced: Error | undefined;
  private closeTask: Promise<void> | undefined;

  private constructor(public readonly binding: RootBinding, private readonly packed: PackedCasWorkerClient) {
    this.loose = new LocalCasByteAccess(binding.paths.casRootPath);
  }

  public static async open(binding: RootBinding): Promise<RuntimeCasAccess> {
    return new RuntimeCasAccess(binding, await PackedCasWorkerClient.open(binding));
  }

  public assertUsable(): void { if (this.fenced) throw this.fenced; this.packed.assertUsable(); }

  public onFailure(listener: (error: Error) => void): () => void { return this.packed.onFailure(listener); }

  public readPackedBytes(object: CasObjectIdentity): Promise<Buffer | undefined> {
    return this.operation(() => this.packed.readBytes(requireCasObjectIdentity(object)));
  }

  public inspectPackedByteLength(object: CasObjectIdentity): Promise<bigint | undefined> {
    return this.operation(() => this.packed.inspectByteLength(requireCasObjectIdentity(object)));
  }

  public fence(error: Error = new ExecutionHandoffError('CAS root owner is closing.')): void {
    this.fenced ??= error;
    this.packed.fence(this.fenced);
  }

  public readBytes(object: CasObjectIdentity): Promise<Buffer> {
    return this.operation(async () => {
      const identity = requireCasObjectIdentity(object);
      const bytes = identity.byte_length <= BigInt(SMALL_CAS_MAX_BYTES) ? await this.packed.readBytes(identity) : undefined;
      return bytes ?? this.loose.readBytes(identity);
    });
  }

  public readRange(object: CasObjectIdentity, offset: number, length: number): Promise<Buffer> {
    return this.operation(async () => {
      const identity = requireCasObjectIdentity(object);
      if (identity.byte_length <= BigInt(SMALL_CAS_MAX_BYTES)) {
        const bytes = await this.packed.readBytes(identity);
        if (bytes !== undefined) return Buffer.from(bytes.subarray(offset, offset + length));
      }
      return this.loose.readRange(identity, offset, length);
    });
  }

  public inspectByteLength(object: CasObjectIdentity): Promise<bigint | undefined> {
    return this.operation(async () => {
      const identity = requireCasObjectIdentity(object);
      const length = identity.byte_length <= BigInt(SMALL_CAS_MAX_BYTES) ? await this.packed.inspectByteLength(identity) : undefined;
      return length ?? this.loose.inspectByteLength(identity);
    });
  }

  public async containsExactLength(object: CasObjectIdentity): Promise<boolean> {
    return await this.inspectByteLength(object) === object.byte_length;
  }

  public publishBatch(inputs: readonly CasPublicationInput[], metric: (metric: CasPublicationMetric) => void): Promise<CasPublicationLocation[]> {
    return this.operation(async () => {
      const result: CasPublicationLocation[] = new Array(inputs.length);
      const small: CasPublicationInput[] = [];
      const indexes: number[] = [];
      // The caller has already copied and identified the input before yielding. This preserves that
      // batch, with no timer or cross-call accumulation. Large bodies retain their loose publisher.
      for (let index = 0; index < inputs.length; index += 1) {
        const input = inputs[index];
        requireCasObjectIdentity(input.object);
        if (input.object.byte_length !== BigInt(input.bytes.length)) throw new Error('CAS publication length mismatch.');
        if (input.bytes.length <= SMALL_CAS_MAX_BYTES) { small.push(input); indexes.push(index); }
        else {
          await publishLooseCasObject(this.binding.paths.casRootPath, input.bytes, input.object, metric);
          result[index] = looseCasObjectLocation(this.binding.paths.casRootPath, input.object);
        }
      }
      if (small.length) {
        const locations = await this.packed.publishBatch(small);
        if (locations.length !== small.length) throw new Error('CAS publication batch lost an input.');
        locations.forEach((kind, index) => {
          result[indexes[index]] = kind === 'loose'
            ? looseCasObjectLocation(this.binding.paths.casRootPath, small[index].object) : { kind: 'packed' };
        });
      }
      return result;
    });
  }

  public inspectRanges(): ReturnType<LocalCasByteAccess['inspectRanges']> { return this.loose.inspectRanges(); }

  public close(): Promise<void> {
    this.fence();
    if (!this.closeTask) {
      const task = (async () => {
        await Promise.allSettled([...this.active]);
        await this.packed.close();
      })();
      this.closeTask = task;
      void task.catch(() => { if (this.closeTask === task) this.closeTask = undefined; });
    }
    return this.closeTask;
  }

  private operation<T>(run: () => Promise<T>): Promise<T> {
    this.assertUsable();
    const task = run();
    this.active.add(task);
    void task.finally(() => this.active.delete(task)).catch(() => undefined);
    return task;
  }
}
