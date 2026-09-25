import { READ_AGENT_ANSWER_TOOL_NAME } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../schedulingContract';
import { defineToolDefinitionModule } from '../types';

export const readAgentAnswerToolModule = defineToolDefinitionModule({
  id: READ_AGENT_ANSWER_TOOL_NAME,
  create() {
    return readAgentAnswerTool;
  }
});

export const readAgentAnswerTool: ToolDefinition = {
  declaration: {
    name: READ_AGENT_ANSWER_TOOL_NAME,
    description: 'Read the latest answer of a child task by the answerBridgeId returned from run_agent. A child answers with the final reply of its Turn; that answer is also delivered to you automatically. Does not read the regular conversation transcript. When no answer is available yet, the response distinguishes these cases via a "status" field: "running" — the child conversation is still active (including after a manual retry) and has not finished a Turn yet. This is NOT a failure: do not poll repeatedly in the same response and do not interrupt just because it is slow; continue independent work, then end the current turn when waiting for the answer is all that remains. "failed" — the child Run ended with the returned error. "interrupted" — the child conversation exists but has no active Run or answer; call run_agent({ operation: "send", answerBridgeId, prompt }) to continue that same child conversation. "not_found" — the answerBridgeId does not match any answer or child conversation.',
    parameters: {
      type: 'object',
      properties: {
        answerBridgeId: { type: 'string', description: 'A child reference within the current conversation parent lineage.' },
        scope: { type: 'string', enum: ['direct', 'tree'], description: 'Defaults to direct children. tree permits verified descendants.' }
      },
      required: ['answerBridgeId']
    },
    metadata: {
      category: 'agent',
      scope: 'agent',
      riskLevel: 'read',
      readonly: true,
      defaultEnabled: true,
      checkpoint: { before: false, after: false }
    }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('parallel', 'agent_answer_read'),
  summary: summarizeReadAgentAnswerToolCall,
  async execute() {
    return { ok: false, output: 'read_agent_answer 必须由可靠 AnswerBridge 控制面处理。' };
  }
};

function summarizeReadAgentAnswerToolCall(rawArgs: unknown): string | undefined {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? rawArgs as { answerBridgeId?: unknown }
    : undefined;
  const answerBridgeId = typeof args?.answerBridgeId === 'string' ? args.answerBridgeId.trim() : '';
  return answerBridgeId ? `读取 Agent 回答 · ${answerBridgeId}` : '读取 Agent 回答';
}
