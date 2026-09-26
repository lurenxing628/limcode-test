import * as fs from 'node:fs/promises';
import { RUNTIME_KERNEL_EPOCH, createRuntimeRootPaths } from './contracts';
import type { RuntimeDataSetSummary } from './runtimeDataSetContent';
import { readRuntimeDataSetFacts, runtimeDataSetFileState } from './runtimeDataSetFacts';
import type { VscodeRuntimeDataSetCandidate } from './vscodeRootAuthority';

export type { RuntimeDataSetSummary } from './runtimeDataSetContent';

/** Why a data set cannot be opened or merged as it is; `code` is stable for records. */
export interface RuntimeDataSetPreflightProblem {
  code: string;
  message: string;
}

/**
 * Read-only check that a data set can be opened (after the exact published 3/4 upgrade when
 * needed): recognized epoch, complete binding, the exact schema and physical fingerprint opening
 * checks, and for the published 3/4 formats the upgrade's own checks (quick_check included). A
 * pending recovery window passes to its gate. Nothing is written; a worker reads a private copy.
 * Never call it for a database this process has open: copying its files would release this
 * process's POSIX locks.
 */
export async function preflightRuntimeDataSet(
  candidate: VscodeRuntimeDataSetCandidate
): Promise<RuntimeDataSetPreflightProblem | undefined> {
  const epoch = candidate.runtimeKernelEpoch;
  if (!candidate.dataSetId || epoch === undefined) return { code: 'runtime-data-set-empty', message: '这个历史库还没有数据。' };
  if (epoch !== 3 && epoch !== 4 && epoch !== RUNTIME_KERNEL_EPOCH) {
    return { code: 'runtime-data-set-epoch-unsupported', message: `这个历史库是不受支持的第 ${epoch} 代格式。` };
  }
  // An interrupted archive/cutover or root transition is an exact published recovery window: the
  // existing offline startup gate completes or rolls it back before anything opens, and judges it.
  if (candidate.requiresRecovery || await pathExists(createRuntimeRootPaths(candidate.runtimeDataRootPath).rootPendingPath)) {
    return undefined;
  }
  try {
    await readRuntimeDataSetFacts(candidate, { openable: true });
  } catch (error) {
    return {
      code: typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'runtime-data-set-preflight-failed',
      message: `这个历史库的结构或完整性核验未通过：${error instanceof Error ? error.message : String(error)}`
    };
  }
  return undefined;
}

/**
 * Names, conversation count and last activity of a data set, read in the facts worker from a
 * private copy and kept per exact file state for this process, so opening a picker again reads
 * nothing. Undefined for a data set without data; a failed read rejects. Same POSIX lock rule as
 * the preflight.
 */
export async function summarizeRuntimeDataSet(candidate: VscodeRuntimeDataSetCandidate): Promise<RuntimeDataSetSummary | undefined> {
  if (!candidate.dataSetId) return undefined;
  const databasePath = createRuntimeRootPaths(candidate.runtimeDataRootPath).databasePath;
  const files = await runtimeDataSetFileState(databasePath);
  const key = `${candidate.dataSetId}\0${candidate.rootInstanceId ?? ''}\0${files}`;
  const known = summaries.get(candidate.runtimeDataRootPath);
  if (known?.key === key) return known.summary;
  const facts = await readRuntimeDataSetFacts(candidate, { summary: true });
  // Kept only when nothing moved while the copy was taken.
  if (await runtimeDataSetFileState(databasePath).catch(() => undefined) === files) {
    summaries.set(candidate.runtimeDataRootPath, { key, summary: facts.summary! });
  }
  return facts.summary;
}

const summaries = new Map<string, { key: string; summary: RuntimeDataSetSummary }>();

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
