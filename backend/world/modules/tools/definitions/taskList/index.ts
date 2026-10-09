import {
  TASK_LIST_ITEM_STATUSES,
  TASK_LIST_TOOL_NAME
} from '../../../../../../shared/protocol';
import { requireTaskListOperation } from '../../../../../../shared/taskListProjection';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../schedulingContract';
import { defineToolDefinitionModule } from '../types';

export const TASK_LIST_ITEM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: {
      type: 'string',
      description: 'Task title. In update mode this is also used as the key to match existing tasks; prefer a short verb-object phrase.'
    },
    description: {
      type: 'string',
      description: 'Additional notes, acceptance criteria, or context for the task. Also shown as the current-activity line while the task is in progress.'
    },
    status: {
      type: 'string',
      enum: [...TASK_LIST_ITEM_STATUSES],
      description: 'Task status: pending, in_progress, completed, blocked, or cancelled.'
    },
    delete: {
      type: 'boolean',
      description: 'Only used in update mode. Set to true to delete the task with the same title; status and description are then unused. Ignored in rewrite mode.'
    }
  },
  required: ['title']
};

export const TASK_LIST_OPERATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: {
      type: 'string',
      enum: ['rewrite', 'update'],
      description: 'rewrite = replace the full task list; update = apply incremental changes to the task list.'
    },
    items: {
      type: 'array',
      items: TASK_LIST_ITEM_SCHEMA,
      description: 'Task entries. In rewrite mode this is the full list; in update mode these are the changed entries.'
    }
  },
  required: ['mode', 'items']
};


export const taskListToolModule = defineToolDefinitionModule({
  id: TASK_LIST_TOOL_NAME,
  create() {
    return taskListTool;
  }
});

export const taskListTool: ToolDefinition = {
  declaration: {
    name: TASK_LIST_TOOL_NAME,
    description: `Update the structured task list for the current conversation. This tool only records structured task list operations; it does not modify workspace files.

Modes:
- mode="rewrite": the items are the full task list that should currently be shown for the task/plan, and they replace the previous task list.
- mode="update": the items are incremental changes; existing tasks are matched and updated by title, new titles are added, and delete=true removes the task with the same title.
- Task state continues across Turns in the same conversation. Use update when continuing the same work instead of recreating a rewrite baseline.
- Titles are update keys. Repeated titles are applied in input order, with later entries updating the same task.
- Only the selected mode's controls are used. rewrite ignores delete fields; update delete=true uses the title and ignores status/description. Unused controls are reported.

Usage rules:
- For complex, multi-step, cross-file work, or when the user explicitly asks to track progress, first use rewrite to create 3-8 tasks.
- Before starting a piece of work, set it to in_progress; mark it completed as soon as it is done.
- Keep only one in_progress task at a time; the frontend automatically moves the previous in_progress task back to pending.
- When a new, clearly separate user task / new plan / new phase comes up, use rewrite so unrelated tasks are not mixed into one list.
- When continuing the same batch of work, use update and only submit the entries that changed.
- This is not the final reply text; the frontend renders the task list dynamically from the tool calls in the current conversation.`,
    parameters: TASK_LIST_OPERATION_SCHEMA,
    metadata: {
      category: 'general',
      scope: 'task',
      riskLevel: 'read',
      readonly: true,
      defaultEnabled: true,
      defaultAutoExpand: true,
      checkpoint: { before: false, after: false }
    }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('serial', 'task_list_state_update'),
  summary: summarizeTaskListToolCall,
  async execute() {
    return { ok: false, output: 'update_task_list 必须由可靠 Interaction 控制面处理。' };
  }
};

function summarizeTaskListToolCall(rawArgs: unknown): string | undefined {
  try {
    const operation = requireTaskListOperation(rawArgs);
    const modeLabel = operation.mode === 'rewrite' ? '重写任务清单' : '更新任务清单';
    const count = operation.items.length;
    const active = operation.items.find((item) => item.status === 'in_progress' && item.delete !== true);
    return `${modeLabel} · ${count} 项${active ? ` · 当前：${active.title}` : ''}`;
  } catch {
    return undefined;
  }
}
