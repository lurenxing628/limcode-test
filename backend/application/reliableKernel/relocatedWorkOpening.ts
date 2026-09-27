import * as path from 'node:path';
import type { ReliableKernelApplication } from '../../reliableKernel/runtimeApplication';
import {
  DataRootUnavailableError,
  dataRootReadFailureReason,
  readDataRootMovedNotice,
  recordDataRootMovedWorkSettled,
  type DataRootCarriedDataSet,
  type DataRootMovedNotice
} from '../../reliableKernel/runtimeDataRootRelocation';
import {
  resolveVscodeRuntimeDataSet,
  resolveVscodeRuntimeDataSetScopeRoot,
  type VscodeWorkspaceRuntimePlacement
} from '../../reliableKernel/vscodeRootAuthority';
import { settleRelocatedWork } from './relocatedWorkSettlement';

/**
 * Opening a data set of an old directory whose data a relocation moved away with unfinished work
 * (DataRootMovedNotice.carriedWork): that work must not simply resume here, it would run a second
 * time. The user decides first; once they chose to keep using the old directory, the work is
 * settled (closed as aborted) right after the Runtime opens and before anything runs.
 */
export interface RelocatedWorkOpening {
  root: string;
  notice: DataRootMovedNotice;
  dataSet: DataRootCarriedDataSet;
}

/**
 * Before the Runtime of `placement` opens (inside the configuration admission): its data set's
 * carried work not settled yet. Without the user's consent the open is refused ('moved-work': the
 * prompt offers continuing here, the new directory, or not opening); with it, returned for
 * settleRelocatedWorkOnOpen (also after a crash in the middle of settling: it is idempotent).
 */
export async function relocatedWorkBeforeOpen(placement: VscodeWorkspaceRuntimePlacement): Promise<RelocatedWorkOpening | undefined> {
  const root = placement.configurationRootPath;
  let notice: DataRootMovedNotice | undefined;
  try {
    notice = await readDataRootMovedNotice(root);
  } catch (error) {
    // Unreadable proves nothing: never opened past carried work that might be there.
    throw new DataRootUnavailableError(root, dataRootReadFailureReason(error), error);
  }
  const dataSet = notice?.carriedWork?.dataSets.find((item) => item.settlement.state !== 'settled'
    && samePath(resolveVscodeRuntimeDataSetScopeRoot(root, item.id), placement.runtimeScopeRootPath));
  if (!notice || !dataSet) return undefined;
  // Another data set under that id now (reset or replaced since): none of that work is in it.
  const candidate = await resolveVscodeRuntimeDataSet({ globalStoragePath: root }, dataSet.id).catch(() => undefined);
  if (candidate && candidate.dataSetId !== dataSet.dataSetId) return undefined;
  if (dataSet.settlement.state === 'pending') throw new DataRootUnavailableError(root, 'moved-work');
  return { root, notice, dataSet };
}

/**
 * Right after the Runtime opened with its convergence held and before its recovery (see
 * VscodeReliableKernelProductRuntime.releaseRelocatedWorkHold): settles the carried work with the
 * user's stop transitions and records the result once in the notice (`by`: this installation).
 */
export async function settleRelocatedWorkOnOpen(application: ReliableKernelApplication, opening: RelocatedWorkOpening, by: string): Promise<void> {
  if (application.database.binding.dataSetId !== opening.dataSet.dataSetId) return;
  const result = await settleRelocatedWork({ application, inventory: opening.dataSet.inventory, targetRootPath: opening.notice.targetRootPath });
  await recordDataRootMovedWorkSettled(opening.root, opening.notice.relocationId, opening.dataSet.id, by, {
    counts: { ...result.counts }, live: result.live, unsettled: result.unsettled
  });
  if (result.live.length > 0 || result.unsettled.length > 0) {
    console.warn('[LimCode] 已迁走的任务没有全部收尾。', JSON.stringify({ live: result.live, unsettled: result.unsettled }));
  }
}

function samePath(left: string, right: string): boolean {
  const [a, b] = [path.resolve(left), path.resolve(right)];
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
