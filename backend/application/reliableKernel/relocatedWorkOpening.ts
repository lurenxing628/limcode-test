import * as path from 'node:path';
import { ReliableKernelApplication, type ReliableKernelApplicationDependencies } from '../../reliableKernel/runtimeApplication';
import {
  DataRootRelocationError,
  DataRootUnavailableError,
  dataRootMovedNoticeUnderWay,
  dataRootReadFailureReason,
  inspectDataRootMovedNotice,
  recordDataRootMovedWorkLeft,
  recordDataRootMovedWorkSettled,
  type DataRootCarriedDataSet,
  type DataRootCarriedWorkLeftItem,
  type DataRootMovedNotice
} from '../../reliableKernel/runtimeDataRootRelocation';
import { DOMAIN_REPOSITORIES } from '../../reliableKernel/repositories';
import {
  createVscodeRootAuthority,
  resolveVscodeRuntimeDataSet,
  resolveVscodeRuntimeDataSetScopeRoot,
  type VscodeWorkspaceRuntimePlacement
} from '../../reliableKernel/vscodeRootAuthority';
import { settleRelocatedWork, type RelocatedWorkSettlementResult } from './relocatedWorkSettlement';

/** Where a data set of a directory is (the placement of a Runtime that opens it). */
type DataSetPlacement = Pick<VscodeWorkspaceRuntimePlacement, 'configurationRootPath' | 'runtimeScopeRootPath'>;

/**
 * Opening a data set of an old directory whose data a relocation moved away with unfinished work
 * (DataRootMovedNotice.carriedWork): that work must not simply resume here, it would run a second
 * time. The user decides first; once they chose to keep using the old directory, the work is
 * settled (closed as aborted) right after the Runtime opens and before anything runs, and the open
 * goes ahead only once all of it is settled.
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
 * settleRelocatedWorkOnOpen (again after a crash, or after an open that could not settle all of it).
 * A notice that cannot be read refuses the open (the read's reason), one that cannot be understood
 * too ('moved-notice-invalid': it might name this data set), and so does one whose relocation is
 * still under way ('relocating': it may yet be undone, see dataRootMovedNoticeUnderWay) or whose
 * target's record of it cannot be read now (the read's reason). `unswitchedRelocationId`: the
 * relocation this installation's in-progress record names (its pointer never switched to it, the
 * pointer still names this directory): its notice moved nothing away for this installation, and
 * the notice it replaced had nothing left unsettled here (settleEarlierMovedWork runs first).
 */
export async function relocatedWorkBeforeOpen(
  placement: DataSetPlacement,
  options: { unswitchedRelocationId?: string } = {}
): Promise<RelocatedWorkOpening | undefined> {
  const root = placement.configurationRootPath;
  let read: Awaited<ReturnType<typeof inspectDataRootMovedNotice>>;
  try {
    read = await inspectDataRootMovedNotice(root);
  } catch (error) {
    // Unreadable proves nothing: never opened past carried work that might be there.
    throw new DataRootUnavailableError(root, dataRootReadFailureReason(error), error);
  }
  if ('invalid' in read) {
    throw new DataRootUnavailableError(root, 'moved-notice-invalid', new DataRootRelocationError('data-root-moved-notice-invalid', read.invalid));
  }
  if (!('notice' in read)) return undefined;
  const { notice } = read;
  if (notice.relocationId === options.unswitchedRelocationId) return undefined;
  const dataSet = notice.carriedWork?.dataSets.find((item) => item.settlement.state !== 'settled'
    && samePath(resolveVscodeRuntimeDataSetScopeRoot(root, item.id), placement.runtimeScopeRootPath));
  if (!dataSet) return undefined;
  // Another data set under that id now (reset or replaced since): none of that work is in it.
  const candidate = await resolveVscodeRuntimeDataSet({ globalStoragePath: root }, dataSet.id).catch(() => undefined);
  if (candidate && candidate.dataSetId !== dataSet.dataSetId) return undefined;
  const underWay = await dataRootMovedNoticeUnderWay(notice).catch((error: unknown) => {
    throw new DataRootUnavailableError(root, dataRootReadFailureReason(error), error);
  });
  if (underWay) throw new DataRootUnavailableError(root, 'relocating');
  if (dataSet.settlement.state === 'pending') throw new DataRootUnavailableError(root, 'moved-work');
  return { root, notice, dataSet };
}

/**
 * The open of the old directory's Runtime with its carried work (see VscodeReliableKernelApplicationFacade):
 * `open` opens the Runtime with its convergence held when there is carried work to settle; the work
 * is settled before the hold is released. When not all of it could be settled, the Runtime is
 * closed again without having run anything and the open fails ('moved-work-unsettled').
 */
export interface RelocatedWorkHoldingRuntime {
  readonly application: ReliableKernelApplication;
  releaseRelocatedWorkHold(): void;
  close(): Promise<void>;
}

export async function openSettlingRelocatedWork<T extends RelocatedWorkHoldingRuntime>(
  placement: DataSetPlacement,
  by: string,
  open: (holdForRelocatedWork: boolean) => Promise<T>,
  options: { unswitchedRelocationId?: string } = {}
): Promise<T> {
  const carried = await relocatedWorkBeforeOpen(placement, options);
  const product = await open(carried !== undefined);
  if (carried) {
    try {
      await settleRelocatedWorkOnOpen(product.application, carried, by);
    } catch (error) {
      await product.close().catch((closeError: unknown) => console.warn('[LimCode] 关闭没有放行的运行时失败。', closeError));
      throw error;
    }
  }
  product.releaseRelocatedWorkHold();
  return product;
}

/**
 * Right after the Runtime opened with its convergence held and before its recovery (see
 * VscodeReliableKernelProductRuntime.releaseRelocatedWorkHold): settles the carried work with the
 * user's stop transitions (`by`: this installation). Only when nothing is left is it recorded as
 * settled (once, never again), and only once the settlement is on disk (the durability barrier
 * RuntimeDatabase.durabilityCheckpoint: the stop transitions commit with synchronous = NORMAL, a crash
 * could lose them after the record said settled). Anything left, whatever the reason (work a live
 * window runs or holds, an item that failed, one that needs a person, new work still coming after the
 * last round, a settlement that stopped or could not be made durable), keeps it consented, is recorded
 * as what this open left (for the prompt) and fails the open ('moved-work-unsettled'): none of it may
 * run here, and the next open settles the whole data set again.
 */
export async function settleRelocatedWorkOnOpen(application: ReliableKernelApplication, opening: RelocatedWorkOpening, by: string): Promise<void> {
  if (application.database.binding.dataSetId !== opening.dataSet.dataSetId) return;
  let result: RelocatedWorkSettlementResult | undefined;
  let stopped: unknown;
  try {
    result = await settleRelocatedWork({
      application, inventory: opening.dataSet.inventory, targetRootPath: opening.notice.targetRootPath
    });
  } catch (error) {
    // Not an item that failed (those are in the result): the settlement itself stopped. Nothing ran;
    // it is left like any other item, so the refusal names it and a retry settles the rest.
    stopped = error;
  }
  let left = result ? [
    ...result.live.map((item) => ({ ...item, why: 'live' as const, detail: '' })),
    ...result.unsettled.map((item) => ({ ...item, why: item.kind, detail: item.detail }))
  ] : [settlementFailed(`收尾中途出错：${errorMessage(stopped)}`)];
  if (result && left.length === 0) {
    try {
      await application.database.durabilityCheckpoint();
    } catch (error) {
      left = [settlementFailed(`收尾没能写回磁盘：${errorMessage(error)}`)];
    }
  }
  if (result && left.length === 0) {
    await recordDataRootMovedWorkSettled(opening.root, opening.notice.relocationId, opening.dataSet.id, by, { counts: { ...result.counts } });
    return;
  }
  const titles = await conversationTitles(application, opening.dataSet, left.map((item) => item.conversationId))
    .catch(() => conversationTitles(undefined, opening.dataSet, []));
  const items: DataRootCarriedWorkLeftItem[] = left.map((item) => ({
    conversationId: item.conversationId, title: titles.get(item.conversationId) ?? '', list: item.list, id: item.id, why: item.why, detail: item.detail
  }));
  console.warn('[LimCode] 迁走的任务没有全部收尾，这次不打开。', JSON.stringify(items));
  await recordDataRootMovedWorkLeft(opening.root, opening.notice.relocationId, opening.dataSet.id, by, items)
    .catch((error: unknown) => console.warn('[LimCode] 记下没有收尾的迁走任务失败。', error));
  throw new DataRootUnavailableError(opening.root, 'moved-work-unsettled', new RelocatedWorkLeftError(items));
}

/**
 * Settles the work an earlier relocation carried away from data set `id` of this old directory
 * without opening it for use, before a new relocation moves it on (see
 * DataRootRelocationOptions.settleEarlierMovedWork, its consent recorded first): its Runtime opens
 * with its convergence held and with nothing that could run work (no model, tool or MCP call, no
 * Turn compiled), is settled exactly as at an open (settleRelocatedWorkOnOpen) and closes again; it
 * is never recovered and its convergence never released. Throws what that throws when not all of it
 * could be settled (what was left is recorded, the consent stays: a retry settles the rest).
 */
export async function settleEarlierMovedWorkOffline(configurationRootPath: string, id: string, by: string): Promise<void> {
  const opening = await relocatedWorkBeforeOpen({
    configurationRootPath, runtimeScopeRootPath: resolveVscodeRuntimeDataSetScopeRoot(configurationRootPath, id)
  });
  if (!opening) return;
  const { runtimeDataRootPath } = await resolveVscodeRuntimeDataSet({ globalStoragePath: configurationRootPath }, id);
  const application = await ReliableKernelApplication.open(
    createVscodeRootAuthority({ configurationRootPath, runtimeDataRootPath }), SETTLING_ONLY
  );
  try {
    await settleRelocatedWorkOnOpen(application, opening, by);
  } finally {
    await application.close();
  }
}

/** Everything that could run work refuses: the Runtime above only takes the stop transitions. */
const SETTLING_ONLY: ReliableKernelApplicationDependencies = (() => {
  const refuse = (what: string) => (): never => {
    throw new Error(`迁移前收尾迁走的任务时不执行任何工作（${what}）。`);
  };
  return {
    holdRuntimeConvergence: true,
    authorityCompiler: { compile: async () => refuse('开始回合')() },
    resolveWorkEnvironment: () => undefined,
    mcpConnections: { toolAnnotations: async () => refuse('MCP')(), callTool: async () => refuse('MCP')() },
    mcpPolicyGate: { authorize: async () => refuse('MCP')() },
    attachmentSettings: { loadGlobalSettings: async () => refuse('附件')() },
    providers: { resolve: refuse('模型') },
    toolDispatcher: { definitions: () => [], dispatch: async () => refuse('工具')() }
  };
})();

/** The settlement itself did not finish (not an item that failed): left like one, a retry settles the rest. */
function settlementFailed(detail: string) {
  return { conversationId: '', list: 'round', id: 'settlement', why: 'failed' as const, detail };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The cause of a 'moved-work-unsettled' refusal: what that open could not settle, for the prompt. */
export class RelocatedWorkLeftError extends DataRootRelocationError {
  public constructor(public readonly items: readonly DataRootCarriedWorkLeftItem[]) {
    super('data-root-relocation-moved-work-unsettled', describeLeft(items));
  }
}

const LEFT_KINDS: ReadonlyArray<readonly [DataRootCarriedWorkLeftItem['why'], string]> = [
  ['live', '另一个窗口正在执行或占着'],
  ['failed', '收尾时出错'],
  ['needs_human', '需要人工处理'],
  ['rounds_exhausted', '收尾几轮后仍有新产生的工作']
];

/** How many are left and why, for the message (the prompt lists every item from the notice). */
function describeLeft(items: readonly DataRootCarriedWorkLeftItem[]): string {
  const parts = LEFT_KINDS.map(([why, label]) => [label, items.filter((item) => item.why === why).length] as const)
    .filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count} 项`);
  return `还剩 ${items.length} 项：${parts.join('，')}`;
}

/** Titles for the prompt: the Conversation as it is now, else as the inventory named it. */
async function conversationTitles(
  application: ReliableKernelApplication | undefined, dataSet: DataRootCarriedDataSet, ids: readonly string[]
): Promise<Map<string, string>> {
  const titles = new Map(dataSet.inventory.conversations.map((conversation) => [conversation.conversationId, conversation.title] as const));
  for (const id of new Set(ids)) {
    if (!id || !application) continue;
    const snapshot = await application.database.snapshot([DOMAIN_REPOSITORIES.domain('Conversation').get(id)]);
    const row = snapshot.snapshot[0];
    if (row && !Array.isArray(row) && typeof row.title === 'string' && row.title) titles.set(id, row.title);
  }
  return titles;
}

function samePath(left: string, right: string): boolean {
  const [a, b] = [path.resolve(left), path.resolve(right)];
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
