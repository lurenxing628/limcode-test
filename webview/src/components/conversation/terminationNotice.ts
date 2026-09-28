import type { RunTerminationRecord } from '@shared/protocol';

/** The placeholder text a terminated model message shows instead of its unfinished content. */
export function terminationNotice(
  termination: Pick<RunTerminationRecord, 'kind' | 'reasonCode' | 'detail'> | undefined,
  runHadCompletedTools: boolean | undefined
): string {
  const detail = termination?.detail?.trim().replace(/[。.!！?？]+$/, '');
  if (termination?.reasonCode === 'empty_model_result') {
    return runHadCompletedTools
      ? '工具调用已完成，但 LLM 没有返回可显示的最终说明。本轮已明确失败，工具结果仍会保留。'
      : 'LLM 调用已结束，但没有返回可显示的正文。本轮已明确失败，不会以空回复静默完成。';
  }
  if (runHadCompletedTools) {
    if (!detail) return '本轮在工具调用后被终止，未生成最终说明；工具结果已保留，未完成回复不会计入后续 LLM 上下文。';
    // A detail that already says the tool results are kept (e.g. Provider quota exhausted) is not repeated.
    return /工具结果(?:已保留|仍会保留|还在上下文)/.test(detail)
      ? `本轮在工具调用后未正常完成：${detail}。`
      : `本轮在工具调用后未正常完成：${detail}。工具结果已保留。`;
  }
  if (detail) return `本次回复未正常完成：${detail}`;
  return termination?.kind === 'failed'
    ? '本次回复未正常完成。未完成的回复正文不会进入后续 LLM 上下文；已完成的工具结果和中断位置仍会保留。'
    : '本次回复已终止。未完成的回复正文不会进入后续 LLM 上下文；已完成的工具结果和中断位置仍会保留。';
}
