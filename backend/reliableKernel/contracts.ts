import * as path from 'node:path';

export const RUNTIME_KERNEL_EPOCH = 5;
export const RUNTIME_DATABASE_FILE = 'limcode.sqlite';
export const RUNTIME_CAS_DIRECTORY = 'cas';
export const ROOT_BINDING_POINTER_FILE = 'root-binding.json';
export const ROOT_BINDING_PENDING_FILE = 'root-binding.pending.json';
export const RUNTIME_EPOCH_FILE = 'runtime-kernel-epoch.json';

export interface RuntimeRootPaths {
  dataRootPath: string;
  databasePath: string;
  casRootPath: string;
  rootPointerPath: string;
  rootPendingPath: string;
  runtimeEpochPath: string;
}

export interface RootBinding {
  paths: RuntimeRootPaths;
  dataSetId: string;
  rootInstanceId: string;
  rootGeneration: number;
  pointerRevision: number;
  runtimeKernelEpoch: typeof RUNTIME_KERNEL_EPOCH;
}

export interface RuntimeEpochManifest {
  kind: 'limcode-runtime-kernel-epoch';
  runtimeKernelEpoch: typeof RUNTIME_KERNEL_EPOCH;
  dataSetId: string;
  rootInstanceId: string;
  rootGeneration: number;
  initializedAt: string;
}

export type RuntimeDomainMutation = 'insert' | 'update' | 'delete';
export type RuntimeClientMapping = 'none' | 'summary' | 'detail' | 'window';

export interface RuntimeChange {
  domain: string;
  kind: 'upsert' | 'remove';
  id: string;
  /** Final committed row projection for upsert; removals carry identity only. */
  record?: Record<string, unknown>;
}

export interface RuntimeAllocatedSequence {
  domain: string;
  id: string;
  column: string;
  value: string;
}

export interface RuntimeCommitResult {
  commitSeq: string;
  changes: RuntimeChange[];
  allocatedSequences: RuntimeAllocatedSequence[];
}

export interface SnapshotBarrier<T> {
  snapshotCommitSeq: string;
  snapshot: T;
}

export function createRuntimeRootPaths(dataRootPath: string): RuntimeRootPaths {
  const resolvedRoot = path.resolve(dataRootPath);
  const controlRoot = path.dirname(resolvedRoot);
  return {
    dataRootPath: resolvedRoot,
    databasePath: path.join(resolvedRoot, RUNTIME_DATABASE_FILE),
    casRootPath: path.join(resolvedRoot, RUNTIME_CAS_DIRECTORY),
    rootPointerPath: path.join(controlRoot, ROOT_BINDING_POINTER_FILE),
    rootPendingPath: path.join(controlRoot, ROOT_BINDING_PENDING_FILE),
    runtimeEpochPath: path.join(resolvedRoot, RUNTIME_EPOCH_FILE)
  };
}

export function freezeRootBinding(binding: RootBinding): RootBinding {
  const paths = Object.freeze({ ...binding.paths });
  return Object.freeze({ ...binding, paths });
}
