import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

const NODE_FS_STORAGE_SCHEMES = new Set(['file', 'vscode-userdata']);

/** 默认用户数据 URI 在部分桌面/远程宿主中仍对应扩展宿主可直接访问的本地路径。 */
export function isNodeFsStorageUri(uri: vscode.Uri): boolean {
  return NODE_FS_STORAGE_SCHEMES.has(uri.scheme) && !!normalizeStorageFsPath(uri.fsPath);
}

export function nodeFsStoragePath(uri: vscode.Uri): string {
  const resolved = normalizeStorageFsPath(uri.fsPath);
  if (!NODE_FS_STORAGE_SCHEMES.has(uri.scheme) || !resolved) {
    throw new Error(`Storage URI is not backed by local node fs: ${uri.toString()}`);
  }
  return resolved;
}

/**
 * Whether a storage directory exists (never creates it). Reads use it to leave a missing settings
 * directory missing: a new data directory, or the mount point of an unmounted data drive. Only
 * "not there" (ENOENT/ENOTDIR, FileNotFound) counts as missing: any other failure (no permission,
 * an I/O error of a failing drive) is raised, never taken for an empty directory.
 */
export async function storageDirectoryExists(uri: vscode.Uri): Promise<boolean> {
  try {
    if (isNodeFsStorageUri(uri)) return (await fs.stat(nodeFsStoragePath(uri))).isDirectory();
    return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0;
  } catch (error) {
    if (isNotThere(error)) return false;
    throw error;
  }
}

/** ENOENT/ENOTDIR from node, FileNotFound (provider code EntryNotFound) from the VS Code file system. */
function isNotThere(error: unknown): boolean {
  const { code, name } = (error ?? {}) as { code?: unknown; name?: unknown };
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'FileNotFound' || code === 'EntryNotFound' || code === 'FileNotADirectory'
    || (typeof name === 'string' && /^(FileNotFound|EntryNotFound|FileNotADirectory|EntryNotADirectory)\b/.test(name));
}

export function normalizeStorageFsPath(value: string): string {
  if (!value) return '';
  const candidate = process.platform === 'win32' && /^[\\/][a-zA-Z]:[\\/]/.test(value)
    ? value.slice(1)
    : value;
  return path.isAbsolute(candidate) ? path.resolve(candidate) : '';
}
