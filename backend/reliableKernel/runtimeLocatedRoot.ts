import { createRuntimeRootPaths, type RuntimeRootPaths } from './contracts';
import type { HistoricalRootBinding } from './rootAuthority';
import { requireCompleteRuntimeDataSet } from './runtimeStorageInspection';
import { resolveVscodeRuntimeDataSet } from './vscodeRootAuthority';

/**
 * A Runtime root found at one place whose records may name another.
 *
 * Location and identity are separate. `located` comes only from getPaths (the configuration root),
 * fixed directory names and strictly matched entry names; every filesystem and SQLite read uses it.
 * `recorded` is what the root says about itself (pointer file, epoch manifest and SQLite
 * root_binding row, which must agree exactly); it is only an identity fence (assertDatabaseBinding,
 * assertCurrentSchema) and display text, and none of its paths is ever handed to any I/O. A local
 * data set records its own location. A reset archive records the place a newer root now occupies,
 * and a copied data directory records a path elsewhere, where the original may still exist.
 */
export interface LocatedRuntimeRoot {
  /** The local candidate id, or `foreign:<archive|copied>:<16 hex>` (runtimeForeignHistory). */
  readonly id: string;
  readonly origin: LocatedRuntimeRootOrigin;
  /** Every located path lies below this directory with no symbolic link on the way. */
  readonly containerRoot: string;
  readonly located: RuntimeRootPaths;
  readonly recorded: HistoricalRootBinding;
  /**
   * Foreign roots of an exact published epoch 3/4/5 only: their private snapshot copies are upgraded
   * to the current epoch (copyLocatedRuntimeDatabase), and the few bodies that upgrade converts (old
   * Child continuations) live in this private content-addressed directory below the current
   * configuration root, never in the foreign directory. Readers look here before the located CAS.
   */
  readonly upgradeCasOverlayRoot?: string;
}

export type LocatedRuntimeRootOrigin =
  | { readonly kind: 'local'; readonly candidateId: string }
  | { readonly kind: 'foreign'; readonly location: ForeignRuntimeRootLocation };

/** Where a foreign history root was found (see runtimeForeignHistory for the discovery rules). */
export interface ForeignRuntimeRootLocation {
  /** A reset archive of this configuration root, or anything inside a copied data directory. */
  readonly kind: 'archive' | 'copied';
  /** Copied only: beside the current data directory, or beside the previous one (lastMigration.fromPath). */
  readonly side?: 'current' | 'previous';
  /** Copied only: the data directory it lies beside; its name is `<that name>.limcode-copied-<time>-<id8>`. */
  readonly baseDataRootPath?: string;
  /** Absolute: the archive directory, or the copied data directory. */
  readonly containerPath: string;
  /** Identity input: an archive's path below the configuration root, or a copied directory's name ('/' separated). */
  readonly containerName: string;
  /** The data root inside the container, '/' separated: `active`, `.limcode-runtime/active`, … */
  readonly dataRootRelativePath: string;
}

/**
 * A complete, unselected local data set as a located root: its recorded paths were proven equal to
 * the paths getPaths derives for its candidate id (requireCompleteRuntimeDataSet), and the located
 * paths are those derived ones. The selected data set is read only through its own open Runtime.
 */
export async function locateLocalRuntimeDataSet(
  paths: { globalStoragePath: string },
  candidateId: string
): Promise<LocatedRuntimeRoot> {
  const candidate = await resolveVscodeRuntimeDataSet(paths, candidateId);
  if (candidate.selected) {
    throw Object.assign(new Error('Use the active conversation view for the selected Runtime data set.'), {
      code: 'runtime-history-selected'
    });
  }
  const recorded = await requireCompleteRuntimeDataSet(candidate);
  return Object.freeze({
    id: candidate.id,
    origin: Object.freeze({ kind: 'local' as const, candidateId: candidate.id }),
    containerRoot: candidate.configurationRootPath,
    located: Object.freeze(createRuntimeRootPaths(candidate.runtimeDataRootPath)),
    recorded
  });
}

/** Same place, same records: a reader stays valid only while its root still locates identically. */
export function sameLocatedRuntimeRoot(left: LocatedRuntimeRoot, right: LocatedRuntimeRoot): boolean {
  return left.id === right.id && left.containerRoot === right.containerRoot
    && JSON.stringify(left.origin) === JSON.stringify(right.origin)
    && JSON.stringify(left.located) === JSON.stringify(right.located)
    && JSON.stringify(left.recorded) === JSON.stringify(right.recorded);
}
