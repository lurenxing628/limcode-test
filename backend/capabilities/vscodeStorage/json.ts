import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { writeFileAtomicDurable } from './durableWrite';
import { isNodeFsStorageUri, nodeFsStoragePath } from './localStorageUri';
import { storageWriteObserver } from './storageFilePublications';

export interface ReadJsonOptions {
  /** @deprecated JSON corruption and I/O failures are always thrown. */
  throwOnError?: boolean;
}

export type StrictJsonReadStatus = 'missing' | 'invalid' | 'ioError' | 'ok';

export type StrictJsonReadResult<T> =
  | { status: 'ok'; uri: vscode.Uri; value: T }
  | { status: 'missing'; uri: vscode.Uri; error: unknown }
  | { status: 'invalid'; uri: vscode.Uri; error: unknown }
  | { status: 'ioError'; uri: vscode.Uri; error: unknown };

/** Distinguishes a missing file from damaged JSON and real storage failures. */
export async function readJsonStrict<T = unknown>(uri: vscode.Uri): Promise<StrictJsonReadResult<T>> {
  let raw: Uint8Array;
  try {
    raw = isNodeFsStorageUri(uri)
      ? await fs.readFile(nodeFsStoragePath(uri))
      : await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    return isFileNotFoundError(error)
      ? { status: 'missing', uri, error }
      : { status: 'ioError', uri, error };
  }

  const text = Buffer.from(raw).toString('utf8').trim();
  if (!text) {
    return { status: 'invalid', uri, error: new Error(`JSON file is empty: ${uri.fsPath}`) };
  }

  try {
    return { status: 'ok', uri, value: JSON.parse(text) as T };
  } catch (error) {
    return { status: 'invalid', uri, error };
  }
}

export async function readJson<T>(uri: vscode.Uri, _options: ReadJsonOptions = {}): Promise<T | undefined> {
  const result = await readJsonStrict<T>(uri);
  if (result.status === 'ok') return result.value;
  if (result.status === 'missing') return undefined;
  throw result.error;
}

export async function writeJson(uri: vscode.Uri, value: unknown): Promise<void> {
  const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (isNodeFsStorageUri(uri)) {
    const filePath = nodeFsStoragePath(uri);
    await writeFileAtomicDurable(filePath, data, storageWriteObserver(filePath));
    return;
  }
  await vscode.workspace.fs.writeFile(uri, data);
}

interface FileSystemLikeError {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  stack?: unknown;
}

export function isFileNotFoundError(error: unknown): boolean {
  const candidate = error as FileSystemLikeError;
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  return code === 'ENOENT'
    || code === 'ENOTDIR'
    || code === 'FileNotFound'
    || code === 'EntryNotFound'
    || /^(FileNotFound|EntryNotFound)(?:\b|\s|\()/i.test(name);
}
