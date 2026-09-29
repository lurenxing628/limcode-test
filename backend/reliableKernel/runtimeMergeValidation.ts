/** Derived decisions expire when these rules change; content fingerprints and commit facts do not. */
export const RUNTIME_MERGE_VALIDATION_REVISION = '2026-09-30-process-exit-consistency-model-ownership';

const REVISIONED_REFUSALS = new Set([
  'runtime-data-set-merge-invariant',
  'runtime-data-set-merge-unfinished-work',
  'runtime-data-set-merge-foreign-unfinished-work'
]);

type Decision = { state?: string; code?: string; validationRevision?: string };
export function revisionedRuntimeMergeRefusal(record: Decision): boolean {
  return record.state === 'blocked' && typeof record.code === 'string' && REVISIONED_REFUSALS.has(record.code);
}

/** Old unrelated failures, successful commits, deletion closures and in-flight commits are untouched. */
export function reusableRuntimeMergeRefusal(record: Decision): boolean {
  return !revisionedRuntimeMergeRefusal(record) || record.validationRevision === RUNTIME_MERGE_VALIDATION_REVISION;
}
