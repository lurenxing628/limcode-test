import { MAX_CONCURRENT_CHILD_AGENT_STARTS_PER_TURN } from '../../../../../../shared/agentScheduling';
import type { ToolConfigRecord } from '../../../../../../shared/protocol';
import type { ToolCallSummaryContext, ToolDefinition } from '../../registry';
import { defineToolDefinitionModule } from '../types';

export const RUN_AGENT_TOOL_NAME = 'run_agent';
export const DEFAULT_RUN_AGENT_TYPE = 'worker';
export const MAX_CHILD_AGENT_DEPTH_CONFIG_KEY = 'maxChildAgentDepth';
export const DEFAULT_MAX_CHILD_AGENT_DEPTH = 1;
export const RUN_AGENT_OPERATIONS = ['spawn', 'send', 'list', 'read', 'wait', 'interrupt_subtree'] as const;
export type RunAgentOperation = typeof RUN_AGENT_OPERATIONS[number];

export function isReadonlyRunAgentOperation(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return ['list', 'read', 'wait'].includes(String((value as { operation?: unknown }).operation));
}

export function maxChildAgentDepthFromConfig(
  config: ToolConfigRecord | undefined,
  defaultValue = DEFAULT_MAX_CHILD_AGENT_DEPTH
): number {
  const value = config?.[MAX_CHILD_AGENT_DEPTH_CONFIG_KEY];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : defaultValue;
}

export function runAgentToolAvailableAtDepth(
  currentDepth: number,
  config: ToolConfigRecord | undefined
): boolean {
  if (!Number.isSafeInteger(currentDepth) || currentDepth < 0) {
    throw new TypeError('currentDepth must be a non-negative safe integer.');
  }
  return currentDepth < maxChildAgentDepthFromConfig(config);
}

export const runAgentToolModule = defineToolDefinitionModule({
  id: RUN_AGENT_TOOL_NAME,
  create() {
    return runAgentTool;
  }
});

export const runAgentTool: ToolDefinition = {
  execution: 'agentRun',
  declaration: {
    name: RUN_AGENT_TOOL_NAME,
    description: `Inspect and control child tasks using an explicit operation.
- Before spawn, inspect the conversation roster. Use list for omitted tasks and read for the original assignment, current inputs and queued work. These operations never create or resume a child.
- spawn requires taskName and prompt. Give the complete objective, context, constraints, expected result, verification and editing permission. agent.type chooses a configuration, never an existing child identity.
- send requires answerBridgeId and prompt, reusing that child conversation and answer channel. It queues after the current child turn unless interrupt=true explicitly redirects current work. An unknown or missing reference fails; it never creates a replacement child.
- read/list/wait default to direct children; scope="tree" also permits verified descendants. send and interrupt_subtree only control direct children. Inherited history references are not authority to control another conversation's children.
- wait observes one answerBridgeId or 1 to 32 answerBridgeIds until a status/task/result change or the bounded timeout. It never resumes, cancels or sends work. Do not repeatedly poll; continue independent work, then wait or finish the turn when only a child answer remains.
- interrupt_subtree explicitly stops a direct child and its descendants without assigning a new task. Do not interrupt merely because a child is slow.
- list/read pages are bounded by both limit and a token budget. Follow nextCursor to continue. If a tool-result preview was truncated, repeat the same operation and target with cursor=rereadCursor, preferably as a single call, so omitted text is not skipped. A read source may span pages; reassemble its text by textOffset and respect textFormat (text or message_json).
- List cursors keep the original upper boundary; start a new list to include children created during pagination. Activity changes do not invalidate cursors.
- foregroundWaitMs is optional for spawn/send and defaults to 0. It bounds the foreground wait, not child execution. At most ${MAX_CONCURRENT_CHILD_AGENT_STARTS_PER_TURN} starts enter admission concurrently per parent turn.`,
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [...RUN_AGENT_OPERATIONS],
          description: 'Required. Explicitly select spawn, send, list, read, wait or interrupt_subtree. There is no default operation.'
        },
        prompt: {
          type: 'string',
          description: 'Required for spawn and send. Complete task or follow-up, including context, constraints and expected verification.'
        },
        answerBridgeId: {
          type: 'string',
          description: 'Required for send, read and interrupt_subtree. For wait, supply this or answerBridgeIds, never both.'
        },
        answerBridgeIds: {
          type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32,
          description: 'For wait only: 1 to 32 distinct existing child references. Mutually exclusive with answerBridgeId.'
        },
        taskName: {
          type: 'string',
          description: 'Required for spawn. Short responsibility label, such as "trace send failure"; the full task belongs in prompt.'
        },
        interrupt: {
          type: 'boolean',
          description: 'When continuing a child, true redirects its current work immediately; false or omitted queues the follow-up after its current turn.'
        },
        agent: {
          type: 'object',
          description: 'For spawn only. Selects the child Agent configuration.',
          properties: {
            type: {
              type: 'string',
              description: `The Agent type/configuration id to use, such as main, worker, or explore. The backend may create a temporary runtime mirror internally, but mirror ids are not valid types and should not be supplied here. Available types are appended to the tool description at runtime. Defaults to ${DEFAULT_RUN_AGENT_TYPE}.`
            }
          }
        },
        foregroundWaitMs: {
          type: 'integer',
          minimum: 0,
          maximum: 86_400_000,
          description: 'Optional for spawn/send. Foreground wait in milliseconds, default 0; the child keeps running after it expires.'
        },
        scope: {
          type: 'string', enum: ['direct', 'tree'],
          description: 'Read-only list/read/wait scope. Defaults to direct children; tree includes verified descendants.'
        },
        status: { type: 'string', enum: ['starting', 'active', 'idle', 'interrupting', 'interrupted', 'closed', 'needs_human'], description: 'Optional exact ChildExecution status filter for list. Idle describes an available child; its latest Turn outcome is a separate field.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'List/read maximum page items, default 32. Token budgets may return fewer items or a partial source.' },
        cursor: { type: 'string', description: 'For list/read: nextCursor continues, rereadCursor repeats a truncated page. Keep the same scope, filters and target; immutable source identity must match.' },
        timeoutMs: {
          type: 'integer', minimum: 0, maximum: 60000,
          description: 'For wait only. Observation timeout in milliseconds, default 0; no child state is changed.'
        },
        scheduling: {
          type: 'string',
          enum: ['parallel', 'serial'],
          description: 'Tool-call scheduling mode. Defaults to parallel. Use serial when this task may interfere with other tool calls.'
        }
      },
      required: ['operation'],
      additionalProperties: false
    },
    metadata: {
      category: 'agent',
      scope: 'agent',
      riskLevel: 'agent',
      readonly: false,
      defaultEnabled: true,
      checkpoint: { before: true, after: true }
    },
    configSchema: {
      fields: [{
        key: MAX_CHILD_AGENT_DEPTH_CONFIG_KEY,
        label: '最大子 Agent 层级',
        type: 'number',
        description: '限制新建子 Agent 的嵌套深度。根对话为 0；达到上限后只移除 spawn，查看、等待、续接与中断操作继续可用。',
        defaultValue: DEFAULT_MAX_CHILD_AGENT_DEPTH
      }]
    },
    defaultConfig: {
      [MAX_CHILD_AGENT_DEPTH_CONFIG_KEY]: DEFAULT_MAX_CHILD_AGENT_DEPTH
    }
  },
  scheduling: resolveRunAgentScheduling,
  summary: summarizeRunAgentToolCall
};

interface RunAgentSchedulingArgs {
  operation?: string;
  foregroundWaitMs?: number;
  scheduling?: string;
}

function summarizeRunAgentToolCall(rawArgs: unknown, context: ToolCallSummaryContext): string | undefined {
  const args = (rawArgs ?? {}) as RunAgentSchedulingArgs & { prompt?: unknown; answerBridgeId?: unknown; agent?: { type?: unknown; id?: unknown } };
  const answerBridgeId = typeof args.answerBridgeId === 'string' ? args.answerBridgeId.trim() : '';
  if (args.operation === 'interrupt_subtree') return answerBridgeId ? `Interrupt Agent · ${answerBridgeId}` : 'Interrupt Agent';
  if (args.operation && ['list', 'read', 'wait'].includes(args.operation)) return `${args.operation} child tasks${answerBridgeId ? ` · ${answerBridgeId}` : ''}`;
  const prompt = typeof args.prompt === 'string' ? normalizeSummaryText(args.prompt) : '';
  const resolvedType = runAgentTypeFromValue(context.result) ?? runAgentTypeFromValue(context.progress);
  const requestedType = typeof args.agent?.type === 'string' && args.agent.type.trim()
    ? args.agent.type.trim()
    : undefined;
  const hasIndirectTarget = (typeof args.answerBridgeId === 'string' && !!args.answerBridgeId.trim())
    || (typeof args.agent?.id === 'string' && !!args.agent.id.trim());
  const targetType = resolvedType ?? requestedType ?? (hasIndirectTarget ? 'Agent' : DEFAULT_RUN_AGENT_TYPE);
  return prompt ? `Run ${targetType} · ${truncateSummary(prompt, 96)}` : `Run ${targetType}`;
}

function runAgentTypeFromValue(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const output = record.output;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const nestedType = (output as Record<string, unknown>).agentType;
    if (typeof nestedType === 'string' && nestedType.trim()) return nestedType.trim();
  }
  return typeof record.agentType === 'string' && record.agentType.trim()
    ? record.agentType.trim()
    : undefined;
}

function resolveRunAgentScheduling(rawArgs: unknown): { mode: 'parallel' | 'serial'; reason: string } {
  const args = (rawArgs ?? {}) as RunAgentSchedulingArgs;
  if (args.operation === 'interrupt_subtree') return { mode: 'serial', reason: 'interrupt_subtree' };
  if (args.scheduling === 'serial') return { mode: 'serial', reason: 'explicit_serial' };
  if (args.scheduling === 'parallel') return { mode: 'parallel', reason: 'explicit_parallel' };

  return { mode: 'parallel', reason: 'default_parallel' };
}

function normalizeSummaryText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateSummary(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;
}
