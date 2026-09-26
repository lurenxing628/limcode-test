import path from 'node:path';

// 与 backend/capabilities/filesystem/pathContainment.ts 同一规则：用 path.relative 判断，
// 不拼 `${root}${path.sep}` 前缀，盘符根目录（G:\）、UNC 共享根和 / 都能正确判断。
export function isPathBelow(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}
