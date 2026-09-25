import { IconPlaylistAdd } from '@tabler/icons-vue';
import type { TaskListToolOperationRecord } from '@shared/protocol';
import {
  taskListDisplayItemsFromOperation,
  taskListOperationFromArgs,
  taskListOperationFromToolCall
} from '@webview/components/taskList/taskListModel';
import type { ToolDisplayResolver, ToolDisplaySection } from './types';

export const taskListToolDisplay: ToolDisplayResolver = (context) => {
  const detail = plainRecord(context.result);
  // A completed ToolOutcome AND its hydrated, canonical result are required for an output card.
  // Pending/failed calls may show their arguments, but arguments cannot establish task state.
  const settled = context.toolCall?.status === 'success' && detail?.kind === 'task-list'
    ? taskListOperationFromArgs(detail.operation)
    : undefined;
  const proposed = taskListOperationFromToolCall(context.toolCall, { allowArgsFallback: true })
    ?? taskListOperationFromArgs(context.args);
  const operation = settled ?? proposed;
  if (!operation) return undefined;

  return {
    headerIcon: IconPlaylistAdd,
    inputSections: inputSections(operation, !settled),
    outputSections: settled ? outputSections(settled) : []
  };
};

function inputSections(operation: TaskListToolOperationRecord, preview: boolean): ToolDisplaySection[] {
  return [{
    kind: 'input',
    title: preview ? '任务清单参数预览（未确认完成）' : '任务清单操作',
    rows: [
      { label: '操作方式', value: operation.mode === 'rewrite' ? '重建完整任务清单' : '更新现有任务清单' },
      { label: '任务数', value: `${operation.items.length} 项` },
      ...(preview ? operation.items.map((item) => ({
        label: item.delete ? '拟删除' : '拟设置',
        value: `${item.title}${item.delete ? '' : ` · 目标状态：${item.status ?? 'pending'}`}`
      })) : [])
    ],
    rowStyle: 'keyValue'
  }];
}

function outputSections(operation: TaskListToolOperationRecord): ToolDisplaySection[] {
  // The timeline reconstructs state from ToolCall arguments, which can disagree with the actual
  // result (or omit earlier artifacts). Never let that speculative replay replace settled output.
  const items = taskListDisplayItemsFromOperation(operation);
  const title = operation.mode === 'rewrite' ? '完整任务清单' : '任务清单变更';
  const emptyText = operation.mode === 'rewrite' ? '任务清单已清空。' : '没有可显示的变更。';

  return [{
    kind: 'output',
    title,
    taskList: {
      items,
      showChange: operation.mode === 'update',
      emptyText
    }
  }];
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
