import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

const NODE_FS_STORAGE_SCHEMES = new Set(['file', 'vscode-userdata']);

/** 默认用户数据 URI 在部分桌面/远程宿主中仍对应扩展宿主可直接访问的本地路径。 */
export function isNodeFsStorageUri(uri: vscode.Uri): boolean {
  return NODE_FS_STORAGE_SCHEMES.has(uri.scheme) && !!normalizedFsPath(uri.fsPath);
}

export function nodeFsStoragePath(uri: vscode.Uri): string {
  const resolved = normalizedFsPath(uri.fsPath);
  if (!NODE_FS_STORAGE_SCHEMES.has(uri.scheme) || !resolved) {
    throw new Error(`Storage URI is not backed by local node fs: ${uri.toString()}`);
  }
  return resolved;
}

/**
 * Whether a storage directory exists (never creates it). Reads use it to leave a missing settings
 * directory missing: a new data directory, or the mount point of an unmounted data drive.
 */
export async function storageDirectoryExists(uri: vscode.Uri): Promise<boolean> {
  if (isNodeFsStorageUri(uri)) return (await fs.stat(nodeFsStoragePath(uri)).catch(() => undefined))?.isDirectory() === true;
  const stat = await Promise.resolve(vscode.workspace.fs.stat(uri)).catch(() => undefined);
  return stat !== undefined && (stat.type & vscode.FileType.Directory) !== 0;
}

function normalizedFsPath(value: string): string {
  if (!value) return '';
  const candidate = process.platform === 'win32' && /^[\\/][a-zA-Z]:[\\/]/.test(value)
    ? value.slice(1)
    : value;
  return path.isAbsolute(candidate) ? path.resolve(candidate) : '';
}
