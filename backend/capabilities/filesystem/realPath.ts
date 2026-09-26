import * as fs from 'node:fs';
import { promisify } from 'node:util';

const portableRealpath = promisify(fs.realpath);

/**
 * Native realpath on Windows goes through GetFinalPathNameByHandleW, which some RAM-disk and
 * virtual-disk drivers (ImDisk and similar) reject; libuv surfaces that as EISDIR/ENOTSUP/EINVAL.
 * Those volumes still support lstat/readlink, so Node's portable implementation resolves them.
 */
const NATIVE_REALPATH_UNSUPPORTED_CODES = new Set(['EISDIR', 'ENOTSUP', 'EINVAL']);

export async function realPath(
  target: string,
  nativeRealpath: (target: string) => Promise<string> = fs.promises.realpath
): Promise<string> {
  try {
    return await nativeRealpath(target);
  } catch (error) {
    if (!NATIVE_REALPATH_UNSUPPORTED_CODES.has((error as NodeJS.ErrnoException)?.code ?? '')) throw error;
    return portableRealpath(target);
  }
}
