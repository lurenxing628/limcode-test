import type { RootBinding } from './contracts';
import { requireCasObjectIdentity, type CasObjectIdentity, type SynchronousCasByteAccess } from './casObjectAccess';
import { LocalSynchronousCasByteAccess } from './looseCasObjectAccess';
import { PackedCasStore } from './packedCasStore';

/** Owned only by the Runtime worker. No sidecar read transaction outlives one indexed lookup. */
export class RuntimeSynchronousCasByteAccess implements SynchronousCasByteAccess {
  private readonly packed: PackedCasStore;
  private readonly loose: LocalSynchronousCasByteAccess;
  public constructor(binding: RootBinding) {
    this.packed = new PackedCasStore(binding, { readOnly: true });
    this.loose = new LocalSynchronousCasByteAccess(binding.paths.casRootPath);
  }
  public readBytes(object: CasObjectIdentity): Buffer {
    const identity = requireCasObjectIdentity(object);
    const bytes = identity.byte_length <= 8192n ? this.packed.readBytes(identity) : undefined;
    return bytes ?? this.loose.readBytes(identity);
  }
  public assertPublished(object: CasObjectIdentity): void {
    const identity = requireCasObjectIdentity(object);
    const size = identity.byte_length <= 8192n ? this.packed.inspectByteLength(identity) : undefined;
    if (size === undefined) this.loose.assertPublished(identity);
    else if (size !== identity.byte_length) throw new Error('ContentObject packed body has the wrong length.');
  }
  public close(): void { this.packed.close(); }
}
