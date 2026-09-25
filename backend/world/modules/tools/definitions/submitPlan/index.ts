import { normalizeSubmitPlanToolRequest, submitPlanOutputFromResult } from '../../../../../../shared/planReview';
import { SUBMIT_PLAN_TOOL_NAME } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../schedulingContract';
import { TASK_LIST_ITEM_SCHEMA } from '../taskList';
import { defineToolDefinitionModule } from '../types';

const SUBMIT_PLAN_TASK_LIST_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: {
      type: 'string',
      enum: ['rewrite'],
      description: 'submit_plan always provides a complete replacement task list.'
    },
    items: {
      type: 'array',
      minItems: 1,
      items: TASK_LIST_ITEM_SCHEMA,
      description: 'Non-empty complete ordered execution task list. Titles must be unique.'
    }
  },
  required: ['mode', 'items']
};

export const submitPlanToolModule = defineToolDefinitionModule({
  id: SUBMIT_PLAN_TOOL_NAME,
  create() {
    return submitPlanTool;
  }
});

export const submitPlanTool: ToolDefinition = {
  declaration: {
    name: SUBMIT_PLAN_TOOL_NAME,
    description: `Submit an implementation plan for user review before making changes.

Use this tool when the active workflow requires plan approval, or when a task involves non-trivial file edits, commands, or child agents. The plan field is the user-facing plan body. taskList is the required non-empty structured execution contract and must use mode="rewrite" with unique task titles. In a root conversation, wait for the user's decision after calling submit_plan. In a delegated child Agent conversation, the reliable control plane automatically approves the Plan under the existing parent delegation and returns the decision directly. If the user requests changes in a root conversation, revise and resubmit both the plan and its complete taskList.

Approval can execute in the current conversation or delegate the approved Plan to a new child Agent conversation. When executionTarget is current_conversation, continue with the approved plan as usual. When executionTarget is new_conversation, the model-facing result includes the selected agentType and answerBridgeId; the child Agent is already executing the Plan in the background, so do not duplicate that work. Tell the user the Plan has been dispatched; the executor's final reply arrives as its answer automatically, or use read_agent_answer/run_agent with the returned answerBridgeId when needed.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        plan: {
          type: 'string',
          description: 'The complete plan body. Include steps, scope, validation, and any risks directly in this text.'
        },
        taskList: {
          ...SUBMIT_PLAN_TASK_LIST_SCHEMA,
          description: 'Required non-empty complete ordered execution task list. mode must be "rewrite" and titles must be unique.'
        }
      },
      required: ['plan', 'taskList']
    },
    metadata: {
      category: 'general',
      scope: 'conversation',
      riskLevel: 'read',
      readonly: true,
      requiresApproval: false,
      defaultEnabled: true,
      defaultAutoExpand: true,
      defaultAutoApproveExecution: true,
      defaultAutoSubmitResult: true,
      checkpoint: { before: false, after: false }
    },
    configSchema: {
      fields: [{
        key: 'autoApprove',
        label: '自动批准 Plan',
        type: 'boolean',
        description: '自动同意 LLM 提交的计划，在当前会话继续执行，不另建子 Agent。子 Agent 已有的计划自动批准行为保持不变。',
        defaultValue: false
      }]
    },
    defaultConfig: { autoApprove: false }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('serial', 'await_plan_review'),
  summary: summarizeSubmitPlanToolCall,
  async execute() {
    // 该工具由可靠 Interaction 控制面创建可审计请求并等待显式决策。
    return { ok: false, output: 'submit_plan 必须由可靠 Interaction 控制面处理。' };
  }
};

function summarizeSubmitPlanToolCall(rawArgs: unknown, context: { result?: unknown }): string | undefined {
  const output = submitPlanOutputFromResult(context.result);
  if (output) return `Plan · ${statusLabel(output.status)}`;
  try {
    const request = normalizeSubmitPlanToolRequest(rawArgs);
    const taskCount = request.taskList?.items.length ?? 0;
    return `提交 Plan · ${compact(request.plan, 100)}${taskCount > 0 ? ` · ${taskCount} 项任务` : ''}`;
  } catch {
    return '提交 Plan';
  }
}

function statusLabel(status: 'approved' | 'change_requested' | 'rejected' | 'cancelled'): string {
  switch (status) {
    case 'approved': return '已批准';
    case 'change_requested': return '要求修改';
    case 'rejected': return '已拒绝';
    case 'cancelled': return '已取消';
  }
}

function compact(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
