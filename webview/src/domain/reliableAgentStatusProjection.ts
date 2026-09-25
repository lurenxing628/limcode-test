import type { ReliableKernelBoundedClientState } from '@shared/reliableKernelClientFeed';

type Records = ReliableKernelBoundedClientState['records'];

export type ReliableChildAgentGroup = 'executing' | 'resumable' | 'finished' | 'attention';

export interface ReliableChildAgentStatus {
  id: string;
  conversationId: string;
  sourceToolCallId: string;
  parentTurnId: string;
  parentChildExecutionId?: string;
  agentId?: string;
  agentName: string;
  lifecycle: string;
  lifecycleLabel: string;
  group: ReliableChildAgentGroup;
  activityKind?: string;
  activitySummary?: string;
  activityToolCallId?: string;
  activityModelRequestId?: string;
  turnId?: string;
  turnStatus?: string;
  turnTerminationStatus?: string;
  turnTerminationReason?: string;
  executorAgentId?: string;
  answerBridgeId?: string;
  answerBridgeStatus?: string;
  answerSubmissionId?: string;
  answerSubmissionSeq?: string;
  answerSubmissionTurnId?: string;
  answerSubmissionInterrupted?: boolean;
  answerTitle?: string;
  answerPayloadId?: string;
  answerByteLength?: string;
  answerSubmittedAt?: string;
  deliveryId?: string;
  deliveryPhase?: string;
  deliveryState?: string;
  parentHandlingState?: string;
  deliveryFailureReason?: string;
  createdAt?: string;
  updatedAt?: string;
  interruptible: boolean;
  deliveryBadge?: 'awaiting_parent' | 'delivery_failed';
}

export interface ReliableAgentStatusProjection {
  currentAgentName: string;
  children: ReliableChildAgentStatus[];
}

export interface ReliableChildTaskPresentation {
  title: string;
  body: string;
}

/**
 * Reads a child's task from its source ToolCall arguments, the same fact the timeline card shows:
 * run_agent names every spawned task, while an approved Plan delegation carries the plan itself.
 */
export function presentReliableChildTask(argumentsText: string): ReliableChildTaskPresentation {
  let args: Record<string, unknown> | undefined;
  try {
    const value = JSON.parse(argumentsText) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) args = value as Record<string, unknown>;
  } catch {
    // Non-JSON arguments are shown verbatim.
  }
  if (!args) return { title: '未命名任务', body: argumentsText || '(无任务内容)' };
  const plan = stringValue(args.plan);
  return {
    title: stringValue(args.taskName)?.replace(/\s+/g, ' ') ?? (plan ? '执行已批准的 Plan' : '未命名任务'),
    body: stringValue(args.prompt) ?? plan ?? JSON.stringify(args, null, 2)
  };
}

/** Projects direct children only; lifecycle and delivery remain orthogonal facts. */
export function projectReliableAgentStatus(input: {
  conversationId: string;
  records: Records;
  agentNames: ReadonlyMap<string, string>;
}): ReliableAgentStatusProjection {
  const { conversationId, records } = input;
  const turns = Object.values(records.Turn ?? {});
  const parentTurnIds = new Set(turns
    .filter((turn) => turn.conversation_id === conversationId)
    .map((turn) => stringValue(turn.id))
    .filter((id): id is string => Boolean(id)));
  const agentLinks = Object.values(records.AgentConversationLink ?? {});
  const currentAgentName = agentNameForConversation(conversationId, agentLinks, input.agentNames) ?? 'Agent';
  const childrenById = new Map(Object.values(records.ChildExecution ?? {})
    .flatMap((child) => stringValue(child.id) ? [[stringValue(child.id)!, child] as const] : []));
  const bridgesByChild = new Map(Object.values(records.AnswerBridge ?? {})
    .flatMap((bridge) => stringValue(bridge.child_execution_id)
      ? [[stringValue(bridge.child_execution_id)!, bridge] as const]
      : []));
  const inboxBySubmission = new Map(Object.values(records.RuntimeInboxItem ?? {})
    .filter((inbox) => inbox.source_kind === 'answer_submission')
    .flatMap((inbox) => stringValue(inbox.source_id) ? [[stringValue(inbox.source_id)!, inbox] as const] : []));
  const deliveries = Object.values(records.RuntimeDelivery ?? {});
  const activitiesByChild = new Map(Object.values(records.ChildExecutionActivity ?? {})
    .flatMap((activity) => stringValue(activity.child_execution_id)
      ? [[stringValue(activity.child_execution_id)!, activity] as const]
      : []));
  const activeTurnsByChild = new Map(Object.values(records.ChildExecutionActiveTurnLink ?? {})
    .flatMap((link) => stringValue(link.child_execution_id)
      ? [[stringValue(link.child_execution_id)!, link] as const]
      : []));
  const latestTurnsByChild = latestChildTurnLinks(Object.values(records.ChildExecutionTurnLink ?? {}));
  const turnById = new Map(turns.flatMap((turn) => stringValue(turn.id) ? [[stringValue(turn.id)!, turn] as const] : []));
  const terminationByTurn = new Map(Object.values(records.TurnTermination ?? {})
    .flatMap((termination) => stringValue(termination.turn_id)
      ? [[stringValue(termination.turn_id)!, termination] as const]
      : []));
  const executorByTurn = new Map(Object.values(records.TurnExecutorLink ?? {})
    .flatMap((executor) => stringValue(executor.turn_id)
      ? [[stringValue(executor.turn_id)!, executor] as const]
      : []));

  const children = Object.values(records.ChildExecutionParentLink ?? {}).flatMap((link) => {
    const parentTurnId = stringValue(link.parent_turn_id);
    const childId = stringValue(link.child_execution_id);
    const sourceToolCallId = stringValue(link.source_tool_call_id);
    if (!parentTurnId || !parentTurnIds.has(parentTurnId) || !childId || !sourceToolCallId) return [];
    const child = childrenById.get(childId);
    const childConversationId = stringValue(child?.child_conversation_id);
    const lifecycle = stringValue(child?.status);
    if (!child || !childConversationId || !lifecycle) return [];
    const activity = activitiesByChild.get(childId);
    const activityKind = stringValue(activity?.kind);
    const activitySummary = stringValue(activity?.summary);
    const projectedLifecycle = lifecycleProjection(lifecycle, activityKind);
    const bridge = bridgesByChild.get(childId);
    const submissionId = stringValue(bridge?.current_submission_id);
    const submission = submissionId ? records.AnswerSubmission?.[submissionId] : undefined;
    const inboxId = submissionId ? stringValue(inboxBySubmission.get(submissionId)?.id) : undefined;
    const delivery = inboxId
      ? deliveries
          .filter((candidate) => candidate.inbox_item_id === inboxId)
          .sort(compareDelivery)[0]
      : undefined;
    const deliveryBadge = deliveryBadgeFor(delivery);
    const activeTurnLink = activeTurnsByChild.get(childId);
    const latestTurnLink = latestTurnsByChild.get(childId);
    const turnId = stringValue(activeTurnLink?.turn_id) ?? stringValue(latestTurnLink?.turn_id);
    const turn = turnId ? turnById.get(turnId) : undefined;
    const termination = turnId ? terminationByTurn.get(turnId) : undefined;
    const executor = turnId ? executorByTurn.get(turnId) : undefined;
    const childAgent = agentForConversation(childConversationId, agentLinks, input.agentNames);
    return [{
      id: childId,
      conversationId: childConversationId,
      sourceToolCallId,
      parentTurnId,
      ...(stringValue(link.parent_child_execution_id)
        ? { parentChildExecutionId: stringValue(link.parent_child_execution_id) }
        : {}),
      ...(childAgent.id ? { agentId: childAgent.id } : {}),
      agentName: childAgent.name ?? '子 Agent',
      lifecycle,
      interruptible: ['starting', 'active', 'idle'].includes(lifecycle),
      ...projectedLifecycle,
      ...(activityKind ? { activityKind } : {}),
      ...(activitySummary ? { activitySummary } : {}),
      ...(stringValue(activity?.tool_call_id) ? { activityToolCallId: stringValue(activity?.tool_call_id) } : {}),
      ...(stringValue(activity?.model_request_id) ? { activityModelRequestId: stringValue(activity?.model_request_id) } : {}),
      ...(turnId ? { turnId } : {}),
      ...(stringValue(turn?.status) ? { turnStatus: stringValue(turn?.status) } : {}),
      ...(stringValue(termination?.terminal_status)
        ? { turnTerminationStatus: stringValue(termination?.terminal_status) }
        : {}),
      ...(stringValue(termination?.reason) ? { turnTerminationReason: stringValue(termination?.reason) } : {}),
      ...(stringValue(executor?.agent_id) ? { executorAgentId: stringValue(executor?.agent_id) } : {}),
      ...(stringValue(bridge?.id) ? { answerBridgeId: stringValue(bridge?.id) } : {}),
      ...(stringValue(bridge?.status) ? { answerBridgeStatus: stringValue(bridge?.status) } : {}),
      ...(submissionId ? { answerSubmissionId: submissionId } : {}),
      ...(decimalText(bridge?.current_submission_seq ?? submission?.submission_seq)
        ? { answerSubmissionSeq: decimalText(bridge?.current_submission_seq ?? submission?.submission_seq) }
        : {}),
      ...(stringValue(bridge?.current_turn_id ?? submission?.turn_id)
        ? { answerSubmissionTurnId: stringValue(bridge?.current_turn_id ?? submission?.turn_id) }
        : {}),
      ...(booleanFlag(bridge?.current_submission_interrupted ?? submission?.interrupted) !== undefined
        ? { answerSubmissionInterrupted: booleanFlag(bridge?.current_submission_interrupted ?? submission?.interrupted) }
        : {}),
      ...(stringValue(bridge?.current_title) ? { answerTitle: stringValue(bridge?.current_title) } : {}),
      ...(stringValue(bridge?.current_payload_id) ? { answerPayloadId: stringValue(bridge?.current_payload_id) } : {}),
      ...(decimalText(bridge?.current_byte_length) ? { answerByteLength: decimalText(bridge?.current_byte_length) } : {}),
      ...(stringValue(bridge?.current_submission_created_at ?? submission?.created_at)
        ? { answerSubmittedAt: stringValue(bridge?.current_submission_created_at ?? submission?.created_at) }
        : {}),
      ...(stringValue(delivery?.id) ? { deliveryId: stringValue(delivery?.id) } : {}),
      ...(stringValue(delivery?.phase) ? { deliveryPhase: stringValue(delivery?.phase) } : {}),
      ...(stringValue(delivery?.state) ? { deliveryState: stringValue(delivery?.state) } : {}),
      ...(stringValue(delivery?.parent_handling_state)
        ? { parentHandlingState: stringValue(delivery?.parent_handling_state) }
        : {}),
      ...(stringValue(delivery?.failure_reason) ? { deliveryFailureReason: stringValue(delivery?.failure_reason) } : {}),
      ...(stringValue(child.created_at) ? { createdAt: stringValue(child.created_at) } : {}),
      ...(stringValue(child.updated_at) ? { updatedAt: stringValue(child.updated_at) } : {}),
      ...(deliveryBadge ? { deliveryBadge } : {})
    } satisfies ReliableChildAgentStatus];
  }).sort(compareChildren);

  return { currentAgentName, children };
}

function lifecycleProjection(
  lifecycle: string,
  activityKind?: string
): Pick<ReliableChildAgentStatus, 'group' | 'lifecycleLabel'> {
  if (lifecycle === 'idle' && activityKind && !['idle', 'stopping'].includes(activityKind)) {
    return { group: 'executing', lifecycleLabel: '下级子 Agent 仍在运行' };
  }
  switch (lifecycle) {
    case 'starting': return { group: 'executing', lifecycleLabel: '启动中' };
    case 'active': return { group: 'executing', lifecycleLabel: '执行中' };
    case 'interrupting': return { group: 'executing', lifecycleLabel: '正在中断' };
    case 'idle': return { group: 'resumable', lifecycleLabel: '可继续' };
    case 'interrupted': return { group: 'resumable', lifecycleLabel: '已中断' };
    case 'closed': return { group: 'finished', lifecycleLabel: '已结束' };
    case 'needs_human': return { group: 'attention', lifecycleLabel: '需要处理' };
    default: return { group: 'resumable', lifecycleLabel: lifecycle };
  }
}

function deliveryBadgeFor(delivery: Record<string, unknown> | undefined): ReliableChildAgentStatus['deliveryBadge'] {
  if (!delivery) return undefined;
  if (delivery.state === 'failed') return 'delivery_failed';
  if (delivery.state === 'pending') return 'awaiting_parent';
  return delivery.state === 'consumed' && delivery.parent_handling_state === 'unhandled'
    ? 'awaiting_parent'
    : undefined;
}

function agentNameForConversation(
  conversationId: string,
  links: Array<Record<string, unknown>>,
  agentNames: ReadonlyMap<string, string>
): string | undefined {
  const link = links.find((candidate) =>
    candidate.conversation_id === conversationId && candidate.role === 'default'
  ) ?? links.find((candidate) => candidate.conversation_id === conversationId);
  const agentId = stringValue(link?.agent_id);
  return agentId ? agentNames.get(agentId) ?? agentId : undefined;
}

function agentForConversation(
  conversationId: string,
  links: Array<Record<string, unknown>>,
  agentNames: ReadonlyMap<string, string>
): { id?: string; name?: string } {
  const link = links.find((candidate) =>
    candidate.conversation_id === conversationId && candidate.role === 'default'
  ) ?? links.find((candidate) => candidate.conversation_id === conversationId);
  const id = stringValue(link?.agent_id);
  return id ? { id, name: agentNames.get(id) ?? id } : {};
}

function latestChildTurnLinks(links: Array<Record<string, unknown>>): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const link of links) {
    const childId = stringValue(link.child_execution_id);
    if (!childId) continue;
    const current = result.get(childId);
    if (!current || decimal(link.turn_seq) > decimal(current.turn_seq)) result.set(childId, link);
  }
  return result;
}

function compareChildren(left: ReliableChildAgentStatus, right: ReliableChildAgentStatus): number {
  const priority: Record<ReliableChildAgentGroup, number> = {
    executing: 0,
    attention: 1,
    resumable: 2,
    finished: 3
  };
  const groupOrder = priority[left.group] - priority[right.group];
  if (groupOrder !== 0) return groupOrder;
  const updatedOrder = String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''));
  return updatedOrder || left.agentName.localeCompare(right.agentName, 'zh-CN') || left.id.localeCompare(right.id);
}

function compareDelivery(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftAttempt = decimal(left.attempt_seq);
  const rightAttempt = decimal(right.attempt_seq);
  if (leftAttempt !== rightAttempt) return leftAttempt > rightAttempt ? -1 : 1;
  return String(right.updated_at ?? '').localeCompare(String(left.updated_at ?? ''));
}

function decimal(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function decimalText(value: unknown): string | undefined {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === 'string' && /^\d+$/.test(value) ? value : undefined;
}

function booleanFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 0n || value === '0') return false;
  if (value === 1 || value === 1n || value === '1') return true;
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
