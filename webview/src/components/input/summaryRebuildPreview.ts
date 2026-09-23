import type {
  CompressionRebuildPreviewOutcome,
  CompressionRebuildPreviewResultPayload
} from '@shared/protocol';
import { formatCompactTokenNumber } from '@webview/components/conversation/tokenUsageModel';

/** What the rebuild dialog knows about the read-only estimate it requested. */
export type SummaryRebuildPreviewState =
  | { status: 'loading' }
  | { status: 'loaded'; result: CompressionRebuildPreviewResultPayload }
  /** The request itself failed before any estimate came back. */
  | { status: 'failed'; message: string };

export interface SummaryRebuildPreviewView {
  tone: 'pending' | 'ready' | 'blocked' | 'unknown';
  rows: Array<{ label: string; value: string }>;
  notice?: string;
  canConfirm: boolean;
}

/** Hover explanation of the rebuild button. */
export function summaryRebuildTooltipRows(): Array<{ label: string; value: string }> {
  return [
    { label: '作用', value: '把当前上下文里的摘要展开成原始对话和工具记录，再重新总结一次' },
    { label: '适用', value: '旧摘要漏了内容或写错时' },
    { label: '保留', value: '原始记录和旧摘要都不会删除' },
    { label: '确认前', value: '先估算原始记录大小和要发几次请求' }
  ];
}

export const SUMMARY_REBUILD_DESCRIPTION = '把当前上下文里的摘要全部展开成原始对话和工具记录，再按现在的压缩设置重新总结。原始记录和旧摘要都会保留。';

export const SUMMARY_REBUILD_COST_NOTE = '原始记录超过压缩模型的窗口时会分段总结（最多 32 段），输入 token 大约等于原始记录的总量。';

const METHOD_LABELS: Record<Extract<CompressionRebuildPreviewOutcome, { kind: 'ready' }>['methodKind'], string> = {
  provider_native: '服务商原生压缩',
  llm_summary: '一次总结',
  segmented_summary: '分段总结',
  deterministic_summary: '本地机械摘要',
  manual_summary: '本地可编辑摘要'
};

/** Turns the estimate into short plain-Chinese lines; every number is labeled as an estimate. */
export function summaryRebuildPreviewView(state: SummaryRebuildPreviewState | undefined): SummaryRebuildPreviewView {
  if (!state || state.status === 'loading') {
    return { tone: 'pending', rows: [], notice: '正在估算原始记录的大小…', canConfirm: false };
  }
  if (state.status === 'failed') return unknown(state.message);
  const { estimate, outcome } = state.result;
  const rows: SummaryRebuildPreviewView['rows'] = [];
  if (estimate) {
    rows.push({ label: '原始记录', value: `约 ${formatCompactTokenNumber(estimate.sourceTokens)} tokens（本地估算）` });
    if (estimate.summaryCount > 0) rows.push({ label: '要展开的摘要', value: `${estimate.summaryCount} 份` });
    rows.push({ label: '压缩模型窗口', value: `${formatCompactTokenNumber(estimate.contextWindowTokens)} tokens` });
  }
  switch (outcome.kind) {
    case 'ready':
      rows.push({ label: '预计请求', value: requestText(outcome) });
      return { tone: 'ready', rows, canConfirm: true };
    case 'blocked':
      return { tone: 'blocked', rows, notice: blockedText(outcome), canConfirm: false };
    case 'stale':
      return { tone: 'blocked', rows, notice: '当前上下文已经变了，请关闭后重新打开。', canConfirm: false };
    case 'error':
      return unknown(outcome.message, rows);
  }
}

function unknown(message: string, rows: SummaryRebuildPreviewView['rows'] = []): SummaryRebuildPreviewView {
  const reason = message.trim().replace(/[。.]$/, '');
  return {
    tone: 'unknown',
    rows,
    notice: `暂时无法估算${reason ? `：${reason}` : ''}。仍可重建，但可能失败或消耗大量 token。`,
    canConfirm: true
  };
}

function requestText(outcome: Extract<CompressionRebuildPreviewOutcome, { kind: 'ready' }>): string {
  const method = METHOD_LABELS[outcome.methodKind];
  if (outcome.providerRequests === 0) return `不调用模型（${method}）`;
  const parts: string[] = [];
  if (outcome.methodKind === 'segmented_summary' && outcome.summaryRequests > 1) {
    parts.push(`分 ${outcome.summaryRequests} 段总结`);
    if (outcome.mergeRequests > 0) parts.push(`合并 ${outcome.mergeRequests} 次`);
  } else {
    parts.push(method);
  }
  if (outcome.attachmentRequests > 0) parts.push(`分析附件 ${outcome.attachmentRequests} 次`);
  const approximate = outcome.mergeRequests > 0 ? '约 ' : '';
  return `${approximate}${outcome.providerRequests} 次（${parts.join('，')}）`;
}

function blockedText(outcome: Extract<CompressionRebuildPreviewOutcome, { kind: 'blocked' }>): string {
  switch (outcome.reason) {
    case 'compression_disabled':
      return '无法重建：当前模型的压缩已关闭。请先在压缩设置里打开。';
    case 'replay_limit_exceeded': {
      const limit = outcome.replayLimit;
      if (limit?.kind === 'bytes') return `无法重建：原始记录超过 ${Math.round(limit.value / 1024 / 1024)} MB 的上限。`;
      if (limit?.kind === 'depth') return `无法重建：摘要套摘要超过 ${limit.value} 层的上限。`;
      return `无法重建：原始记录超过 ${limit?.value ?? 32768} 条的上限。`;
    }
    case 'leaf_budget_exceeded':
      return `无法重建：原始记录太长，要分成超过 ${outcome.leafRequestLimit ?? 32} 段才能总结，超出上限。可以换一个窗口更大的压缩模型。`;
    case 'no_chunking_method':
      return '无法重建：原始记录超过压缩模型的窗口，而当前压缩方式不能分段。可以在压缩设置里加上“分段摘要”。';
    case 'request_too_large':
      return '无法重建：压缩模型的窗口太小，放不下一次摘要请求。';
  }
}
