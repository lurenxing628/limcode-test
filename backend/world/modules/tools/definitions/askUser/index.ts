import { ASK_USER_MIN_OPTIONS, ASK_USER_MAX_OPTIONS, askUserOutputFromResult, normalizeAskUserToolRequest } from '../../../../../../shared/askUser';
import { ASK_USER_TOOL_NAME } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../schedulingContract';
import { defineToolDefinitionModule } from '../types';

const OPTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    label: {
      type: 'string',
      description: 'Short user-facing option label.'
    },
    description: {
      type: 'string',
      description: 'Optional explanation of the outcome or trade-off for this option.'
    }
  },
  required: ['label']
};

export const askUserToolModule = defineToolDefinitionModule({
  id: ASK_USER_TOOL_NAME,
  create() {
    return askUserTool;
  }
});

export const askUserTool: ToolDefinition = {
  declaration: {
    name: ASK_USER_TOOL_NAME,
    description: `Ask the user one blocking question and wait for their answer before continuing.

Provide 1-8 concise options using only user-facing labels and optional descriptions. The user can always write a custom answer. Questions are single-choice by default; set multiple=true only when selecting more than one option is meaningful. Use this tool only when the next action genuinely depends on a user decision; do not ask rhetorical or informational questions with it.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: {
          type: 'string',
          description: 'The question shown to the user.'
        },
        options: {
          type: 'array',
          minItems: ASK_USER_MIN_OPTIONS,
          maxItems: ASK_USER_MAX_OPTIONS,
          items: OPTION_SCHEMA,
          description: 'The choices offered to the user. Each label must be unique within the question.'
        },
        multiple: {
          type: 'boolean',
          description: 'Enable multiple selection. Optional; defaults to false (single choice).'
        }
      },
      required: ['question', 'options']
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
        label: '自动回应 Ask',
        type: 'boolean',
        description: '收到提问后自动回复“根据现有上下文自行选择最优方案并继续”，不代选具体选项。仅在允许 LLM 自主决策时开启。',
        defaultValue: false
      }]
    },
    defaultConfig: { autoApprove: false }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('parallel', 'await_user_answer'),
  summary: summarizeAskUserToolCall,
  async execute() {
    // 该工具由可靠 Interaction 控制面创建请求，并以身份围栏接收唯一响应。
    return { ok: false, output: 'ask_user 必须由可靠 Interaction 控制面处理。' };
  }
};

function summarizeAskUserToolCall(rawArgs: unknown, context: { result?: unknown }): string | undefined {
  let request;
  try {
    request = normalizeAskUserToolRequest(rawArgs);
  } catch {
    return '询问用户';
  }

  const question = compact(request.question, 100);
  const output = askUserOutputFromResult(context.result);
  if (!output) return `询问用户 · ${question}`;
  const answers = [
    ...output.selectedOptions.map((option) => option.label),
    ...(output.customText ? [output.customText] : [])
  ];
  return `询问用户 · ${question} · 已回答：${compact(answers.join('、'), 80)}`;
}

function compact(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
