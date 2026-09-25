import { taskListOperationFromArgs } from './taskListProjection';
import { renderPlanMarkdown } from './planMarkdown';
import type {
  PlanProposalStatus,
  SubmitPlanDecisionStatus,
  SubmitPlanDelegationStatus,
  SubmitPlanExecutionTarget,
  SubmitPlanToolOutputRecord,
  SubmitPlanToolRequestRecord,
  TaskListToolOperationRecord
} from './protocol';

export const SUBMIT_PLAN_MAX_BODY_LENGTH = 40_000;
export const DELEGATED_PLAN_APPROVAL_MESSAGE = 'Plan 已下发给 Agent 执行，请耐心等待。';
export const CHILD_PLAN_AUTO_APPROVAL_MESSAGE = '子 Agent 的 Plan 已按父任务授权自动批准，请继续执行。';
export const PLAN_AUTO_APPROVAL_MESSAGE = 'Plan 已按自动审批设置批准，请在当前会话继续执行。';

/**
 * What choosing “新开对话执行” on a Plan card does. The user's approval lets the executor run with
 * its own settings instead of the planning conversation's (ChildSpawnAuthorityBound 'executor_agent').
 */
export function delegatedPlanDispatchDescription(agentName?: string): string {
  const name = agentName?.trim();
  const executor = name ? `「${name}」` : '所选 Agent ';
  return `将新建一个子 Agent 对话，在后台执行已批准的 Plan。将按${executor}自己的工具权限执行：`
    + '工具、技能和可用的工作目录都按它自己的设置，不受当前对话规划时的限制；它自己的设置允许时，从规划时的工作目录开始。'
    + '全局设置里关掉的工具仍然用不了。';
}

export function normalizeSubmitPlanToolRequest(value: unknown): SubmitPlanToolRequestRecord {
  const record = asRecord(parseJsonValue(value));
  if (!record) throw new Error('submit_plan arguments must be an object');

  const plan = requiredText(record.plan, 'plan', SUBMIT_PLAN_MAX_BODY_LENGTH);
  const taskList = requiredTaskList(record.taskList);

  return { plan, taskList };
}

export function submitPlanRequestFromArgs(value: unknown): SubmitPlanToolRequestRecord | undefined {
  try {
    return normalizeSubmitPlanToolRequest(value);
  } catch {
    return undefined;
  }
}

export function createDelegatedPlanPrompt(request: SubmitPlanToolRequestRecord): string {
  const planMarkdown = renderPlanMarkdown({
    plan: request.plan,
    ...(request.taskList ? { taskList: request.taskList } : {}),
    statusLabel: 'Plan 已批准'
  });
  return [
    '[Approved Plan Delegation]',
    '用户已批准以下实施 Plan，并选择由你在新的 Agent 对话中负责执行。请独立完成实际落地，不要只复述或重新规划。',
    '',
    planMarkdown,
    '',
    '## 执行要求',
    '1. 严格按照已批准 Plan 和任务清单推进；仅在确有必要时做最小调整。',
    '2. 如果提供了任务清单，先使用 update_task_list 将其同步到当前子对话，并在执行过程中持续更新状态。',
    '3. 完成实现后运行适当验证，清楚记录结果、剩余风险和任何未完成事项。',
    '4. 全部完成后直接写出最终回复：本轮最后一条回复会自动作为结果交给来源 Agent；需要中途告知进展时使用 send_agent_message。'
  ].join('\n');
}

export function createSubmitPlanToolOutput(input: {
  proposalId: string;
  status: SubmitPlanDecisionStatus;
  userMessage?: string;
  executionTarget?: SubmitPlanExecutionTarget;
  delegationStatus?: SubmitPlanDelegationStatus;
  agentId?: string;
  agentType?: string;
  childExecutionId?: string;
  runId?: string;
  conversationId?: string;
  answerBridgeId?: string;
}): SubmitPlanToolOutputRecord {
  const userMessage = input.userMessage?.trim();
  return {
    kind: 'submit_plan.result',
    proposalId: input.proposalId,
    status: input.status,
    ...(userMessage ? { userMessage } : {}),
    ...(input.executionTarget ? { executionTarget: input.executionTarget } : {}),
    ...(input.delegationStatus ? { delegationStatus: input.delegationStatus } : {}),
    ...optionalOutputId('agentId', input.agentId),
    ...optionalOutputId('agentType', input.agentType),
    ...optionalOutputId('childExecutionId', input.childExecutionId),
    ...optionalOutputId('runId', input.runId),
    ...optionalOutputId('conversationId', input.conversationId),
    ...optionalOutputId('answerBridgeId', input.answerBridgeId)
  };
}

export function submitPlanOutputFromResult(value: unknown): SubmitPlanToolOutputRecord | undefined {
  const envelope = asRecord(value);
  const rawOutput = envelope && 'output' in envelope ? envelope.output : value;
  const output = asRecord(rawOutput);
  if (!output || output.kind !== 'submit_plan.result') return undefined;
  if (typeof output.proposalId !== 'string' || !output.proposalId.trim()) return undefined;
  if (!isSubmitPlanDecisionStatus(output.status)) return undefined;

  const userMessage = optionalText(output.userMessage);
  const executionTarget = isSubmitPlanExecutionTarget(output.executionTarget) ? output.executionTarget : undefined;
  const delegationStatus = output.delegationStatus === 'backgrounded' ? output.delegationStatus : undefined;
  const agentId = optionalText(output.agentId);
  const agentType = optionalText(output.agentType);
  const childExecutionId = optionalText(output.childExecutionId);
  const runId = optionalText(output.runId);
  const conversationId = optionalText(output.conversationId);
  const answerBridgeId = optionalText(output.answerBridgeId);
  return {
    kind: 'submit_plan.result',
    proposalId: output.proposalId.trim(),
    status: output.status,
    ...(userMessage ? { userMessage } : {}),
    ...(executionTarget ? { executionTarget } : {}),
    ...(delegationStatus ? { delegationStatus } : {}),
    ...(agentId ? { agentId } : {}),
    ...(agentType ? { agentType } : {}),
    ...(childExecutionId ? { childExecutionId } : {}),
    ...(runId ? { runId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(answerBridgeId ? { answerBridgeId } : {})
  };
}

export function planProposalStatusToDecision(status: PlanProposalStatus): SubmitPlanDecisionStatus | undefined {
  if (
    status === 'approved'
    || status === 'change_requested'
    || status === 'rejected'
    || status === 'cancelled'
  ) return status;
  return undefined;
}

function isSubmitPlanDecisionStatus(value: unknown): value is SubmitPlanDecisionStatus {
  return value === 'approved'
    || value === 'change_requested'
    || value === 'rejected'
    || value === 'cancelled';
}

function isSubmitPlanExecutionTarget(value: unknown): value is SubmitPlanExecutionTarget {
  return value === 'current_conversation' || value === 'new_conversation';
}

function optionalOutputId<TKey extends 'agentId' | 'agentType' | 'childExecutionId' | 'runId' | 'conversationId' | 'answerBridgeId'>(
  key: TKey,
  value: string | undefined
): { [K in TKey]?: string } {
  const id = value?.trim();
  return id ? { [key]: id } as { [K in TKey]?: string } : {};
}

function requiredTaskList(value: unknown): TaskListToolOperationRecord {
  if (value === undefined) {
    throw new Error('taskList is required and must use the same shape as update_task_list: { mode, items }');
  }
  const operation = taskListOperationFromArgs(value);
  if (!operation) throw new Error('taskList must use the same shape as update_task_list: { mode, items }');
  if (operation.mode !== 'rewrite') throw new Error('submit_plan taskList must use mode="rewrite"');
  if (operation.items.length === 0) throw new Error('submit_plan taskList must contain at least one task');
  return cloneTaskListOperation(operation);
}

function cloneTaskListOperation(operation: TaskListToolOperationRecord): TaskListToolOperationRecord {
  return {
    kind: 'task_list.operation',
    mode: operation.mode,
    items: operation.items.map((item) => ({
      title: item.title,
      ...(item.description ? { description: item.description } : {}),
      ...(item.status ? { status: item.status } : {}),
      ...(item.delete ? { delete: true } : {})
    }))
  };
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('submit_plan arguments must be valid JSON');
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a non-empty string`);
  const text = value.trim();
  if (!text) throw new Error(`${label} must be a non-empty string`);
  if (text.length > maxLength) throw new Error(`${label} must not exceed ${maxLength} characters`);
  return text;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}
