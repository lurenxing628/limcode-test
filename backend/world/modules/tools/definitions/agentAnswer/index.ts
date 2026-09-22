import { READ_AGENT_ANSWER_TOOL_NAME, SUBMIT_AGENT_ANSWER_TOOL_NAME } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../schedulingContract';
import { defineToolDefinitionModule } from '../types';

export const submitAgentAnswerToolModule = defineToolDefinitionModule({
  id: SUBMIT_AGENT_ANSWER_TOOL_NAME,
  create() {
    return submitAgentAnswerTool;
  }
});

export const readAgentAnswerToolModule = defineToolDefinitionModule({
  id: READ_AGENT_ANSWER_TOOL_NAME,
  create() {
    return readAgentAnswerTool;
  }
});

export const submitAgentAnswerTool: ToolDefinition = {
  declaration: {
    name: SUBMIT_AGENT_ANSWER_TOOL_NAME,
    description: "Submit an interim conclusion or final answer through the current child task's own answer bridge. Omit answerBridgeId to use its default bridge; an explicit bridge must belong to this exact child execution. The parent absorbs delivery at a safe input boundary. Use send_agent_message for peer communication and followup_agent_task for a new assignment to an existing peer; neither changes the original parent answer channel.",
    parameters: {
      type: 'object',
      properties: {
        answerBridgeId: { type: 'string', description: 'Optional. Target answerBridgeId. Defaults to the answerBridgeId of the current run_agent task when omitted.' },
        title: { type: 'string', description: 'Title of the submitted content. Lets the parent agent quickly grasp the topic of this answer.' },
        content: { type: 'string', description: 'The full content submitted to the parent agent.' }
      },
      required: ['title', 'content']
    },
    metadata: {
      category: 'agent',
      scope: 'agent',
      riskLevel: 'agent',
      readonly: false,
      defaultEnabled: true,
      checkpoint: { before: false, after: false }
    }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('serial', 'agent_answer_submit'),
  summary: summarizeSubmitAgentAnswerToolCall,
  async execute() {
    return { ok: false, output: 'submit_agent_answer 必须由可靠 AnswerBridge/RuntimeInbox 控制面处理。' };
  }
};

export const readAgentAnswerTool: ToolDefinition = {
  declaration: {
    name: READ_AGENT_ANSWER_TOOL_NAME,
    description: 'Read a saved AgentAnswer body by the answerBridgeId returned in a run_agent or submit_agent_answer response. Does not read the regular conversation transcript. When no submitted answer is available yet, the response distinguishes these cases via a "status" field: "running" — the child conversation is still active (including after a manual retry) and has not submitted yet. This is NOT a failure: do not poll repeatedly in the same response and do not interrupt just because it is slow; continue independent work, then end the current turn when waiting for submit_agent_answer notification is all that remains. "failed" — the child Run ended with the returned error. "interrupted" — the child conversation exists but has no active Run or submitted answer; call run_agent({ operation: "send", answerBridgeId, prompt }) to continue/append that same child conversation and keep the same default submit_agent_answer bridge. "not_found" — the answerBridgeId does not match any answer or child conversation.',
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

function summarizeSubmitAgentAnswerToolCall(rawArgs: unknown): string | undefined {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? rawArgs as { title?: unknown }
    : undefined;
  const title = typeof args?.title === 'string' ? args.title.trim().replace(/\s+/g, ' ') : '';
  return title ? `提交 Agent 回答 · ${title.slice(0, 80)}` : '提交 Agent 回答';
}

function summarizeReadAgentAnswerToolCall(rawArgs: unknown): string | undefined {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? rawArgs as { answerBridgeId?: unknown }
    : undefined;
  const answerBridgeId = typeof args?.answerBridgeId === 'string' ? args.answerBridgeId.trim() : '';
  return answerBridgeId ? `读取 Agent 回答 · ${answerBridgeId}` : '读取 Agent 回答';
}
