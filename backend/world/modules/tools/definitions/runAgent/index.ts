import { MAX_CONCURRENT_CHILD_AGENT_STARTS_PER_TURN } from '../../../../../../shared/agentScheduling';
import { CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY, type ToolConfigRecord } from '../../../../../../shared/protocol';
import type { ToolCallSummaryContext, ToolDefinition } from '../../registry';
import { defineToolDefinitionModule } from '../types';

export const RUN_AGENT_TOOL_NAME = 'run_agent';
export const DEFAULT_RUN_AGENT_TYPE = 'worker';
export const MAX_CHILD_AGENT_DEPTH_CONFIG_KEY = 'maxChildAgentDepth';
export const DEFAULT_MAX_CHILD_AGENT_DEPTH = 1;
export const MAX_CONCURRENT_AGENTS_CONFIG_KEY = 'maxConcurrentAgents';
export const DEFAULT_MAX_CONCURRENT_AGENTS = 8;
export const MAX_AUTOMATIC_FOLLOWUPS_CONFIG_KEY = 'maxAutomaticFollowups';
export const DEFAULT_MAX_AUTOMATIC_FOLLOWUPS = 32;
/** Boolean user switch, frozen per Turn; it has no defaultConfig entry and is off unless set. */
export { CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY };
export const RUN_AGENT_OPERATIONS = ['spawn', 'send', 'list', 'read', 'wait', 'interrupt_subtree'] as const;
/** Skills one spawn may preload into its child's first input. */
export const MAX_RUN_AGENT_SKILLS = 8;
export type RunAgentOperation = typeof RUN_AGENT_OPERATIONS[number];

export function isReadonlyRunAgentOperation(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return ['list', 'read', 'wait'].includes(String((value as { operation?: unknown }).operation));
}

/**
 * The skill names of a run_agent spawn: trimmed, in the given order, repeats dropped. Anything but a
 * list of at most MAX_RUN_AGENT_SKILLS non-empty names throws a model-readable error.
 */
export function normalizeRunAgentSkillNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('run_agent.skills must be an array of skill names.');
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) throw new TypeError('run_agent.skills must contain non-empty skill names.');
    if (!names.includes(entry.trim())) names.push(entry.trim());
  }
  if (names.length > MAX_RUN_AGENT_SKILLS) {
    throw new RangeError(`run_agent.skills accepts at most ${MAX_RUN_AGENT_SKILLS} skills; the child can load more itself with the skills tool.`);
  }
  return names;
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
- spawn skills optionally preloads skills, by the names the skills tool lists, into the child's first input. The child does not inherit skills you loaded; an unknown or disabled name fails the spawn without creating a child.
- spawn forkTurns defaults to "none". Use "all" or a positive integer string to inherit all or the most recent N completed turns. Current, failed and interrupted turns are excluded; inherited child references never grant control. The prompt always starts a new assignment.
- send requires answerBridgeId and prompt, reusing that child conversation and answer channel. It queues after the current child turn unless interrupt=true explicitly redirects current work. An unknown or missing reference fails; it never creates a replacement child.
- A child's answer is the final reply of each of its turns: it settles a foreground wait, otherwise it is delivered to you as that child's final result. Progress the child reports mid-task arrives separately as a collaboration message.
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
        skills: {
          type: 'array', items: { type: 'string' }, maxItems: MAX_RUN_AGENT_SKILLS,
          description: 'For spawn only. Skills to preload into the child, by name as listed in the skills tool (e.g. "pdf", "superpowers:brainstorming"). The child does not inherit skills you loaded.'
        },
        forkTurns: {
          type: 'string',
          description: 'For spawn only: "none" (default), "all", or a positive integer string such as "3". Copies committed completed turns, excluding current, interrupted and failed turns. Does not inherit execution ownership or authority.'
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
        label: '最大子 Agent 深度',
        type: 'number',
        description: '限制新建子 Agent 的嵌套深度。根对话为 0；达到上限后只移除 spawn，查看、等待、续接与中断操作继续可用。',
        defaultValue: DEFAULT_MAX_CHILD_AGENT_DEPTH
      }, {
        key: MAX_CONCURRENT_AGENTS_CONFIG_KEY,
        label: '团队同时运行的子 Agent 上限',
        type: 'number',
        description: '限制同一团队实际同时运行的子 Agent 数量，至少为 1；等待中的启动任务也会核对此预算。',
        defaultValue: DEFAULT_MAX_CONCURRENT_AGENTS
      }, {
        key: MAX_AUTOMATIC_FOLLOWUPS_CONFIG_KEY,
        label: '每轮任务自动续派上限',
        type: 'number',
        description: '限制同一轮任务中 Agent 自动续派的次数；用户开始新一轮任务时重新计数。0 表示不允许自动续派，仍可仅发送消息。',
        defaultValue: DEFAULT_MAX_AUTOMATIC_FOLLOWUPS
      }, {
        key: CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY,
        label: '跨对话协作',
        type: 'boolean',
        description: '允许顶层对话的 Agent 列出、读取同一项目的其他对话（未绑定项目的对话只能访问其他未绑定的对话），向它们发送消息或续派任务，并按用户要求在本项目新建或分支对话。默认关闭。',
        defaultValue: false
      }]
    },
    defaultConfig: {
      [MAX_CHILD_AGENT_DEPTH_CONFIG_KEY]: DEFAULT_MAX_CHILD_AGENT_DEPTH,
      [MAX_CONCURRENT_AGENTS_CONFIG_KEY]: DEFAULT_MAX_CONCURRENT_AGENTS,
      [MAX_AUTOMATIC_FOLLOWUPS_CONFIG_KEY]: DEFAULT_MAX_AUTOMATIC_FOLLOWUPS
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
  const args = (rawArgs ?? {}) as RunAgentSchedulingArgs & { prompt?: unknown; answerBridgeId?: unknown; skills?: unknown; agent?: { type?: unknown; id?: unknown } };
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
  const skills = Array.isArray(args.skills)
    ? args.skills.filter((name): name is string => typeof name === 'string' && !!name.trim()).map((name) => name.trim())
    : [];
  const target = skills.length > 0 ? `${targetType} · skills ${truncateSummary(skills.join(', '), 48)}` : targetType;
  return prompt ? `Run ${target} · ${truncateSummary(prompt, 96)}` : `Run ${target}`;
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
