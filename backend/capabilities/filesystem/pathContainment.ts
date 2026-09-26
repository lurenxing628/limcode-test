import * as path from 'node:path';

export type PathApi = Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'>;

/**
 * Whether `candidate` is `root` itself or lies below it.
 *
 * Decided through `path.relative` rather than a `${root}${sep}` string prefix: roots keep their
 * trailing separator (`G:\`, `\\srv\share\`, `/`), Windows compares drive letters and components
 * case-insensitively, and names such as `..env` are ordinary children. Tests pass `path.win32`.
 */
export function isPathInside(root: string, candidate: string, pathApi: PathApi = path): boolean {
  const relative = pathApi.relative(root, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

/** Like {@link isPathInside}, but `root` itself does not count. */
export function isPathBelow(root: string, candidate: string, pathApi: PathApi = path): boolean {
  return pathApi.relative(root, candidate) !== '' && isPathInside(root, candidate, pathApi);
}

/**
 * Exact containment for two paths that both come from realpath of the same root. No case folding:
 * JS lower-casing is not NTFS's upcase table, and case-sensitive directories exist, so a sibling
 * that differs only by case or Unicode folding (K vs U+212A) must stay outside. Still handles roots
 * that keep their trailing separator (`G:\`, `\\srv\share\`, `/`).
 */
export function isCanonicalPathInside(root: string, candidate: string, pathApi: Pick<PathApi, 'sep'> = path): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(pathApi.sep) ? root : `${root}${pathApi.sep}`);
}

/** Whether both paths name the same location under the platform's path comparison rules. */
export function isSamePath(left: string, right: string, pathApi: PathApi = path): boolean {
  return pathApi.relative(left, right) === '';
}
