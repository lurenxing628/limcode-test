import { MAX_CONCURRENT_CHILD_AGENT_STARTS_PER_TURN } from '../../../../../../shared/agentScheduling';
import type { ToolConfigRecord } from '../../../../../../shared/protocol';
import type { ToolCallSummaryContext, ToolDefinition } from '../../registry';
import { defineToolDefinitionModule } from '../types';

export const RUN_AGENT_TOOL_NAME = 'run_agent';
export const DEFAULT_RUN_AGENT_TYPE = 'worker';
export const MAX_CHILD_AGENT_DEPTH_CONFIG_KEY = 'maxChildAgentDepth';
export const DEFAULT_MAX_CHILD_AGENT_DEPTH = 1;

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
    description: `Delegate a bounded task, continue an existing child, or explicitly stop it.
- Check the conversation child-agent roster before starting a new child. Reuse answerBridgeId for follow-up work that depends on that child's findings or context. Use agent.type only to choose the configuration for a new child; a type is not a running child identity.
- For a new child, give taskName a short responsibility label and prompt the objective, necessary context, constraints, expected result and verification. State whether the child may edit files or should only investigate.
- A continuation preserves the child conversation and answer channel. By default it queues after the current child turn. Set interrupt=true only when the current work needs immediate redirection; mode="interrupt" stops the child and descendants without assigning a new task.
- Do not duplicate delegated work. Continue independent work while the child runs. When nothing useful remains until its answer arrives, end the current turn; submit_agent_answer will notify the parent. Do not repeatedly poll read_agent_answer or interrupt a child merely because it is slow.
- foregroundWaitMs defaults to 0 (return immediately). A positive value is a bounded wait for an immediately needed result, not a child timeout; the child continues when the wait expires.
- At most ${MAX_CONCURRENT_CHILD_AGENT_STARTS_PER_TURN} child starts enter admission concurrently per parent turn. scheduling controls tool-call concurrency, not background execution.`,
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['run', 'interrupt'],
          description: 'Operation mode. Defaults to "run". Use "interrupt" with answerBridgeId only when the user explicitly wants to stop/replace an existing child task; it recursively cancels descendant child AgentRuns. Do not interrupt merely because a child is slow or still running.'
        },
        prompt: {
          type: 'string',
          description: 'Required in run mode. The complete task for the target AgentRun, including all relevant background, role instructions, constraints, and supplemental information.'
        },
        answerBridgeId: {
          type: 'string',
          description: 'Reuse the existing child conversation and answer channel. Required for mode=interrupt; in run mode, follow-ups queue unless interrupt=true.'
        },
        taskName: {
          type: 'string',
          description: 'Short responsibility label for a new child, such as "trace send failure". Displayed in the conversation roster; not an instruction or an agent type.'
        },
        interrupt: {
          type: 'boolean',
          description: 'When continuing a child, true redirects its current work immediately; false or omitted queues the follow-up after its current turn.'
        },
        agent: {
          type: 'object',
          description: 'Selects the child Agent. Omit this when answerBridgeId already identifies an existing child conversation.',
          properties: {
            id: {
              type: 'string',
              description: 'Internal compatibility selector for a temporary Agent mirror previously returned by run_agent. The model normally should not use this. Prefer answerBridgeId for an existing child conversation; to create a new child, omit id and provide agent.type.'
            },
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
          description: 'Optional in run mode. Foreground wait budget in integer milliseconds from 0 to 86400000; this is not an AgentRun timeout. Omit or use 0 to background immediately (recommended for delegation). Use a small positive value only when the current reply truly needs an immediate child result. When the budget expires, the child continues in the background and the tool returns agentId, runId, conversationId, and answerBridgeId.'
        },
        wait: {
          type: 'string',
          description: 'Legacy scheduling hint only. Prefer scheduling. Pass "true" for serial or "false" for parallel when scheduling is omitted. This field never backgrounds an AgentRun; omit foregroundWaitMs or use foregroundWaitMs=0 for background execution.'
        },
        scheduling: {
          type: 'string',
          enum: ['parallel', 'serial'],
          description: 'Tool-call scheduling mode. Defaults to parallel. Use serial when this task may interfere with other tool calls.'
        }
      }
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
        description: '限制子 Agent 的嵌套深度。根对话为 0；设为 1 时只允许根对话创建第一层子 Agent；设为 0 时根对话也看不到 run_agent。当前层级达到上限后，后续模型请求不再提供 run_agent；已经发出的调用仍可完成或中断。',
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
  mode?: string;
  foregroundWaitMs?: number;
  wait?: string;
  scheduling?: string;
}

function summarizeRunAgentToolCall(rawArgs: unknown, context: ToolCallSummaryContext): string | undefined {
  const args = (rawArgs ?? {}) as RunAgentSchedulingArgs & { prompt?: unknown; answerBridgeId?: unknown; agent?: { type?: unknown; id?: unknown } };
  const answerBridgeId = typeof args.answerBridgeId === 'string' ? args.answerBridgeId.trim() : '';
  if (args.mode?.trim() === 'interrupt') return answerBridgeId ? `Interrupt Agent · ${answerBridgeId}` : 'Interrupt Agent';
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
  if (args.mode?.trim() === 'interrupt') return { mode: 'serial', reason: 'interrupt_mode' };
  if (args.scheduling === 'serial') return { mode: 'serial', reason: 'explicit_serial' };
  if (args.scheduling === 'parallel') return { mode: 'parallel', reason: 'explicit_parallel' };

  const wait = typeof args.wait === 'string' ? args.wait.trim().toLowerCase() : '';
  if (wait === 'true') return { mode: 'serial', reason: 'wait_true' };
  if (wait === 'false') return { mode: 'parallel', reason: 'wait_false' };
  return { mode: 'parallel', reason: 'default_parallel' };
}

function normalizeSummaryText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateSummary(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;
}
