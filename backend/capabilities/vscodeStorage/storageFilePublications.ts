import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { DurableFileIdentity } from './durableWrite';
import { INDEX_FILE, RECORDS_DIR } from './constants';
import { isNodeFsStorageUri, nodeFsStoragePath, normalizeStorageFsPath } from './localStorageUri';

interface StoragePublication {
  resource: Promise<string | undefined>;
  files: Set<string>;
}

interface PublishedStorageFile {
  publication: StoragePublication;
  /** null records a deletion published by the same settings mutation. */
  identity: DurableFileIdentity | null;
}

const activePublication = new AsyncLocalStorage<StoragePublication>();
const publishedFiles = new Map<string, PublishedStorageFile>();
const MAX_PUBLISHED_FILES = 4096;

/** Connect the files actually written by one mutation to the snapshot its clients received. */
export async function withPublishedStorageWrites<T extends { filePath: string }>(
  change: () => Promise<T>,
  publish: (committed: T) => void
): Promise<T> {
  let finish!: (resource: string | undefined) => void;
  const publication: StoragePublication = {
    resource: new Promise(resolve => { finish = resolve; }),
    files: new Set()
  };
  try {
    const committed = await activePublication.run(publication, change);
    publish(committed);
    finish(normalizeStorageFsPath(committed.filePath) || undefined);
    publication.files.clear();
    return committed;
  } catch (error) {
    finish(undefined);
    for (const file of publication.files) {
      if (publishedFiles.get(file)?.publication === publication) publishedFiles.delete(file);
    }
    publication.files.clear();
    throw error;
  }
}

/** Only configuration mutations with a matching published snapshot collect these identities. */
export function storageWriteObserver(filePath: string): ((identity: DurableFileIdentity) => void) | undefined {
  const publication = activePublication.getStore();
  if (!publication) return undefined;
  const file = path.resolve(filePath);
  return identity => remember(file, { publication, identity });
}

export function recordStorageFileRemoval(filePath: string): void {
  const publication = activePublication.getStore();
  if (publication) remember(path.resolve(filePath), { publication, identity: null });
}

/** No file content is read when an event still names our already-published write. */
export async function isPublishedStorageFileUnchanged(uri: vscode.Uri): Promise<boolean> {
  if (!isNodeFsStorageUri(uri)) return false;
  const file = nodeFsStoragePath(uri);
  const known = publishedFiles.get(file);
  if (!known) return false;
  // A watcher can fire before a slow save finishes. Wait for that mutation's publication;
  // a failed or partial save still requires the ordinary refresh. Check the final file identity
  // after waiting, so a peer write during the wait cannot be mistaken for ours.
  const resource = await known.publication.resource;
  if (resource === undefined || file !== resource && !(path.basename(resource) === INDEX_FILE
    && path.dirname(file) === path.join(path.dirname(resource), RECORDS_DIR))) return false;
  let current: DurableFileIdentity | null;
  try {
    current = await fs.stat(file, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    current = null;
  }
  return sameIdentity(current, known.identity);
}

function remember(file: string, fact: PublishedStorageFile): void {
  fact.publication.files.add(file);
  publishedFiles.delete(file);
  publishedFiles.set(file, fact);
  while (publishedFiles.size > MAX_PUBLISHED_FILES) publishedFiles.delete(publishedFiles.keys().next().value!);
}

function sameIdentity(left: DurableFileIdentity | null, right: DurableFileIdentity | null): boolean {
  if (!left || !right) return left === right;
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
