/** UNC 路径：两个反斜杠后跟主机名和共享名（\\server\share…，也包括 \\?\C:\…）。 */
const UNC_SHARE_PREFIX = /^\\\\[^\\/]+[\\/]+[^\\/]/;

/**
 * 工具参数里的文件路径统一成 `/` 分隔，用于显示和本地读取。重复的反斜杠合并成一个 `/`，
 * 但 UNC 开头的两个反斜杠属于路径本身，保留为 `//`（\\server\share\a → //server/share/a），
 * 否则会被当成当前盘根下的 \server\share\a。
 */
export function normalizeDisplayPath(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return `${UNC_SHARE_PREFIX.test(trimmed) ? '/' : ''}${trimmed.replace(/\\+/g, '/')}`;
}
