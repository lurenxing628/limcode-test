import type {
  FunctionCallPart,
  InlineDataPart,
  LlmUsageMetadataRecord,
  MessageContent,
  MessageRecord,
  ModelOutputItemReference,
  ModelOutputPartMetadata,
  RunTerminationRecord,
  ToolCallEventKind,
  ToolCallEventRecord,
  ToolCallRecord,
  ToolCallStatus,
  ToolDisplayPolicyRecord,
  ToolSchedulingMode
} from '@shared/protocol';
import { reliableKernelDetailKey } from './reliableDetailKey.ts';
import { modelRequestNativeCapabilities } from '../reliability/modelRequestStreamStats.ts';
import type { NativeSteeringReceipt } from '@shared/openAIResponsesNative';
import { hasSteeringApplicationReceipt } from './steeringReceiptProof.ts';
import type {
  ReliableKernelDetailState,
  ReliableKernelTransientState
} from '@webview/stores/useReliableKernelClientFeedStore';

export type ReliableClientRecord = Record<string, unknown>;
export type ReliableClientRecordBuckets = Record<string, Record<string, ReliableClientRecord>>;

export interface ReliableConversationProjectionInput {
  conversationId: string;
  records: ReliableClientRecordBuckets;
  details: Record<string, ReliableKernelDetailState>;
  transientModelRequests?: Record<string, ReliableKernelTransientState>;
  lastCommitSeq?: string | null;
  /** 当前对话已知的转向回执；驱动聚合消息在转向边界的精确拆分，缺失时保留完整内容。 */
  steeringReceipts?: readonly NativeSteeringReceipt[];
}

export interface ReliableFileDiffProjection {
  files: Array<{
    memberId: string;
    path: string;
    action?: string;
    added?: number;
    removed?: number;
    truncated?: boolean;
    text: string;
  }>;
}

export interface ReliableInteractionProjection {
  id: string;
  kind: string;
  status: string;
  turnId?: string;
  createdAt: number;
  updatedAt: number;
  prompt?: unknown;
}

export type ReliableToolOutcomeProjectionStatus =
  | 'succeeded'
  | 'failed'
  | 'partial'
  | 'rejected'
  | 'cancelled'
  | 'conflict'
  | 'outcome_unknown'
  | 'missing';

export interface ReliableConversationProjection {
  messages: MessageRecord[];
  absoluteFloorByMessageId: Record<string, number>;
  toolCalls: ToolCallRecord[];
  toolCallsByMessageId: Record<string, ToolCallRecord[]>;
  toolCallEvents: ToolCallEventRecord[];
  toolCallEventsByCallId: Record<string, ToolCallEventRecord[]>;
  toolEventIdsByCallId: Record<string, string[]>;
  turnIdByMessageId: Record<string, string>;
  modelRequestIdByMessageId: Record<string, string>;
  messageRevisionIdByMessageId: Record<string, string>;
  /** 转向边界拆分出的展示条目 → 来源聚合消息 id；用于预览/详请归属，不代表持久化身份。 */
  splitSourceMessageIdByMessageId: Record<string, string>;
  /** 展示层只知道尾部归属尚未有完整证明，绝不猜它属于哪条转向消息。 */
  pendingSteeringBoundaryMessageIds: string[];
  terminationByMessageId: Record<string, RunTerminationRecord>;
  toolResultByCallId: Record<string, unknown>;
  toolOutcomeStatusByCallId: Record<string, ReliableToolOutcomeProjectionStatus>;
  interactionByToolCallId: Record<string, ReliableInteractionProjection>;
  interactionPromptIdByToolCallId: Record<string, string>;
  fileDiffByToolCallId: Record<string, ReliableFileDiffProjection>;
  fileDiffMemberIdsByToolCallId: Record<string, string[]>;
  fileChangeSetIdByToolCallId: Record<string, string>;
  /** Durable ChildExecutionParentLink → ChildExecution navigation identity for run_agent cards. */
  childConversationIdByToolCallId: Record<string, string>;
  loadingMessageRevisionIds: string[];
  missingToolArgumentIds: string[];
  missingToolResultIds: string[];
  missingToolEventIds: string[];
  missingInteractionPromptIds: string[];
  missingFileDiffMemberIds: string[];
}

interface ParsedMessage {
  record: ReliableClientRecord;
  message: MessageRecord;
  turnId?: string;
  revisionReady: boolean;
  /** 原生聚合消息在转向边界拆分后，后继 run 条目指向来源聚合消息。 */
  splitFromMessageId?: string;
}

interface FunctionCallTarget {
  messageId: string;
  part: FunctionCallPart;
  ordinal: number;
}

interface ParsedMessageContentCacheEntry {
  role: 'user' | 'model';
  source: string;
  content: MessageContent;
}

const PARSED_MESSAGE_CONTENT_CACHE_MAX_ENTRIES = 256;
const PARSED_MESSAGE_CONTENT_CACHE_MAX_SOURCE_CHARACTERS = 8 * 1024 * 1024;
const parsedMessageContentCache = new Map<string, ParsedMessageContentCacheEntry>();
let parsedMessageContentCacheSourceCharacters = 0;

/**
 * Pure UI projection over independent Runtime objects and Link facts. It never mutates or persists a
 * coupled aggregate: Message↔Turn and Tool↔Turn relationships are interpreted only for rendering.
 */
export function projectReliableConversation(
  input: ReliableConversationProjectionInput
): ReliableConversationProjection {
  const conversationId = input.conversationId.trim();
  if (!conversationId) return emptyProjection();
  const messageFacts = values(input.records.Message)
    .filter((record) => text(record.conversation_id) === conversationId)
    .filter((record) => record.deleted_at === null || record.deleted_at === undefined)
    .sort(compareSequence('message_seq'));
  const messageTurnLinks = values(input.records.MessageTurnLink);
  const turnIdByMessageId: Record<string, string> = {};
  // A steering Message is linked to its Turn as native_steer, never as that Turn's input: it cannot
  // be edited-and-rerun from its own position, only sent again as a new Message.
  const steeringInputMessageIds = new Set<string>();
  for (const link of messageTurnLinks) {
    const messageId = text(link.message_id);
    const turnId = text(link.turn_id);
    if (!messageId || !turnId) continue;
    if (link.role === 'native_steer') steeringInputMessageIds.add(messageId);
    if (link.role === 'model' || turnIdByMessageId[messageId] === undefined) {
      turnIdByMessageId[messageId] = turnId;
    }
  }

  const loadingMessageRevisionIds: string[] = [];
  const messageRevisionIdByMessageId: Record<string, string> = {};
  const parsedMessages: ParsedMessage[] = [];
  for (const record of messageFacts) {
    const role = record.role;
    if (role !== 'user' && role !== 'model') continue;
    const id = text(record.id);
    const revisionId = text(record.revision_id);
    if (!id || !revisionId) continue;
    messageRevisionIdByMessageId[id] = revisionId;
    const detail = input.details[reliableKernelDetailKey('message-content', revisionId)];
    if (!detail || detail.status === 'loading') loadingMessageRevisionIds.push(revisionId);
    const content = detail?.status === 'ready'
      ? parseMessageContent(revisionId, detail.text, role)
      : detail?.status === 'error'
        ? {
            role,
            parts: [{ text: `[正文暂未加载：${detail.error?.trim() || '读取详情失败'}]` }]
          } satisfies MessageContent
      : { role, parts: [] } satisfies MessageContent;
    parsedMessages.push({
      record,
      message: {
        id,
        revisionId,
        conversationId,
        role,
        content,
        // Detail hydration controls only whether the body is available. Durable request facts below
        // decide the model Message lifecycle; a cache miss/read failure must never rewrite it.
        status: role === 'user' ? 'final' : 'partial',
        createdAt: timestamp(record.created_at),
        ...(role === 'model' ? { retryTarget: { kind: 'message' as const, messageId: id } } : {}),
        ...(role === 'user' && steeringInputMessageIds.has(id) ? { steeringInput: true as const } : {}),
        seq: integer(record.display_seq) || integer(record.message_seq)
      },
      revisionReady: detail?.status === 'ready',
      ...(turnIdByMessageId[id] ? { turnId: turnIdByMessageId[id] } : {})
    });
  }

  const modelRequestsByTurn = groupBy(values(input.records.ModelRequest), (record) => text(record.turn_id));
  const modelRequestMessageLinks = values(input.records.ModelRequestMessageLink);
  const modelRequestIdByMessageId: Record<string, string> = {};
  for (const link of modelRequestMessageLinks) {
    const requestId = text(link.model_request_id);
    const messageId = text(link.message_id);
    if (requestId && messageId && modelRequestIdByMessageId[messageId] === undefined) {
      modelRequestIdByMessageId[messageId] = requestId;
    }
  }
  enrichModelMessages(
    parsedMessages,
    modelRequestsByTurn,
    modelRequestMessageLinks
  );
  appendTransientMessages({
    messages: parsedMessages,
    transientByRequest: input.transientModelRequests ?? {},
    conversationId,
    modelRequestById: firstBy(values(input.records.ModelRequest), (record) => text(record.id)),
    sourceMessageIdByTurnId: new Map(values(input.records.Turn).flatMap((turn) => {
      const turnId = text(turn.id);
      const sourceMessageId = text(turn.source_message_id);
      return turnId && sourceMessageId ? [[turnId, sourceMessageId] as const] : [];
    })),
    messageIdByModelRequestId: new Map(modelRequestMessageLinks.flatMap((link) => {
      const requestId = text(link.model_request_id);
      const messageId = text(link.message_id);
      return requestId && messageId ? [[requestId, messageId] as const] : [];
    })),
    toolCallFacts: values(input.records.ToolCall),
    lastCommitSeq: input.lastCommitSeq ?? undefined
  });
  parsedMessages.sort(compareParsedMessages);
  // A streaming reply belongs to its Turn like the saved one that replaces it, so what is placed at
  // that Turn keeps its place while the reply streams.
  for (const entry of parsedMessages) {
    if (entry.turnId && entry.message.id.startsWith('transient:')) turnIdByMessageId[entry.message.id] = entry.turnId;
  }
  const steeringBoundaries = splitAggregateMessagesAtSteeringBoundaries(
    parsedMessages,
    input.steeringReceipts ?? [],
    modelRequestIdByMessageId
  );
  const splitSourceMessageIdByMessageId = steeringBoundaries.splitSourceMessageIdByMessageId;
  // 拆分条目继承来源消息的 Turn 归属；终止/运行展示按同一 Turn 解释，不虚构独立边界。
  for (const [syntheticId, sourceId] of Object.entries(splitSourceMessageIdByMessageId)) {
    const turnId = turnIdByMessageId[sourceId];
    if (turnId) turnIdByMessageId[syntheticId] = turnId;
  }
  const absoluteFloorByMessageId = projectAbsoluteMessageFloors(parsedMessages);

  const callsByTurn = groupBy(values(input.records.ToolCall), (record) => text(record.turn_id));
  const interactionProjection = projectReliableInteractions(input.records, input.details);
  const interactionByToolCallId = interactionProjection.byToolCallId;
  const executionsByCall = firstBy(values(input.records.ToolExecution), (record) => text(record.tool_call_id));
  const outcomesByCall = firstBy(values(input.records.ToolOutcome), (record) => text(record.tool_call_id));
  const toolEventProjection = projectToolCallEvents(input.records, input.details);
  const toolCallEvents = toolEventProjection.events;
  const eventsByCall = groupBy(toolCallEvents, (event) => event.toolCallId);
  const toolCalls: ToolCallRecord[] = [];
  const toolResultByCallId: Record<string, unknown> = {};
  const toolOutcomeStatusByCallId: Record<string, ReliableToolOutcomeProjectionStatus> = {};
  const missingToolArgumentIds: string[] = [];
  const missingToolResultIds: string[] = [];

  const messagesByTurn = groupBy(parsedMessages, (entry) => entry.turnId);
  const sourceByToolCallId = firstBy(values(input.records.ToolCallSourceLink), (link) => text(link.tool_call_id));
  const policyByToolCallId = firstBy(values(input.records.ToolCallPolicySnapshot), (snapshot) => text(snapshot.tool_call_id));
  for (const [turnId, rawCalls] of callsByTurn) {
    if (!turnId) continue;
    const functionTargets = functionCallTargets(messagesByTurn.get(turnId) ?? []);
    const orderedCalls = [...rawCalls].sort(compareSequence('call_seq'));
    for (const raw of orderedCalls) {
      const id = text(raw.id);
      const name = text(raw.tool_name);
      if (!id || !name) continue;
      const sourceLink = sourceByToolCallId.get(id);
      const policy = policyByToolCallId.get(id);
      const target = resolveFunctionCallTarget({
        raw,
        functionTargets,
        messages: messagesByTurn.get(turnId) ?? [],
        sourceLink
      });
      if (!target) continue;
      const argumentsDetail = input.details[reliableKernelDetailKey('tool-arguments-content', id)];
      const resultDetail = input.details[reliableKernelDetailKey('tool-result-content', id)];
      if (!argumentsDetail || argumentsDetail.status === 'loading') missingToolArgumentIds.push(id);
      if (raw.status === 'terminal' && (!resultDetail || resultDetail.status === 'loading')) missingToolResultIds.push(id);
      const args = argumentsDetail?.status === 'ready'
        ? normalizeJsonText(argumentsDetail.text)
        : JSON.stringify(interactionArguments(interactionByToolCallId[id]?.prompt) ?? target.part.functionCall.args ?? {});
      const execution = executionsByCall.get(id);
      const outcome = outcomesByCall.get(id);
      if (raw.status === 'terminal') {
        toolOutcomeStatusByCallId[id] = toolOutcomeProjectionStatus(outcome);
      }
      const parsedResult = resultDetail?.status === 'ready' ? parseJson(resultDetail.text) : undefined;
      const responseParts = toolResponseParts(parsedResult);
      if (parsedResult !== undefined) toolResultByCallId[id] = toolResultDetail(parsedResult);
      const events = eventsByCall.get(id) ?? [];
      const status = toolStatus(raw, execution, outcome);
      const progress = toolProgress(raw, events);
      const error = toolError(raw, outcome, parsedResult, events);
      toolCalls.push({
        id,
        messageId: target.messageId,
        name,
        ...(text(target.part.id) ? { functionCallId: text(target.part.id) } : {}),
        args,
        status,
        ...(toolSummary(policy) ? { summary: toolSummary(policy) } : {}),
        ...(progress !== undefined ? { progress } : {}),
        ...(error ? { error } : {}),
        ...(responseParts.length > 0 ? { responseParts } : {}),
        schedulingOrdinal: sourceLink ? integer(sourceLink.provider_ordinal) : target.ordinal,
        schedulingMode: toolSchedulingMode(policy),
        ...(toolSchedulingReason(policy) ? { schedulingReason: toolSchedulingReason(policy) } : {}),
        ...(toolDisplayPolicy(policy) ? { display: toolDisplayPolicy(policy) } : {}),
        createdAt: timestamp(raw.created_at),
        updatedAt: timestamp(raw.updated_at),
        ...(durationMs(execution) !== undefined ? { durationMs: durationMs(execution) } : {})
      });
      ensureProjectedFunctionCall(
        parsedMessages,
        target,
        id,
        name,
        args
      );
    }
  }

  const fileChanges = projectReliableFileChanges(input.records, input.details);
  const childConversationIdByToolCallId = projectChildConversationIdsByToolCallId(
    input.records,
    conversationId
  );
  const terminationByMessageId = projectTurnTerminations(input.records, parsedMessages, conversationId);
  const toolCallsByMessageId = objectGroups(toolCalls, (call) => call.messageId);
  const toolCallEventsByCallId = objectGroups(toolCallEvents, (event) => event.toolCallId);
  const toolEventIdsByCallId = Object.fromEntries(Object.entries(toolCallEventsByCallId)
    .map(([toolCallId, events]) => [toolCallId, events.map((event) => event.id)]));
  return {
    messages: parsedMessages.map((entry) => entry.message),
    absoluteFloorByMessageId,
    toolCalls,
    toolCallsByMessageId,
    toolCallEvents,
    toolCallEventsByCallId,
    toolEventIdsByCallId,
    turnIdByMessageId,
    modelRequestIdByMessageId,
    messageRevisionIdByMessageId,
    splitSourceMessageIdByMessageId,
    pendingSteeringBoundaryMessageIds: steeringBoundaries.pendingSteeringBoundaryMessageIds,
    terminationByMessageId,
    toolResultByCallId,
    toolOutcomeStatusByCallId,
    interactionByToolCallId,
    interactionPromptIdByToolCallId: interactionProjection.promptIdByToolCallId,
    fileDiffByToolCallId: fileChanges.diffByToolCallId,
    fileDiffMemberIdsByToolCallId: fileChanges.memberIdsByToolCallId,
    fileChangeSetIdByToolCallId: fileChanges.changeSetIdByToolCallId,
    childConversationIdByToolCallId,
    loadingMessageRevisionIds,
    missingToolArgumentIds,
    missingToolResultIds,
    missingToolEventIds: toolEventProjection.missingIds,
    missingInteractionPromptIds: interactionProjection.missingPromptIds,
    missingFileDiffMemberIds: fileChanges.missingMemberIds
  };
}

function projectChildConversationIdsByToolCallId(
  records: ReliableClientRecordBuckets,
  conversationId: string
): Record<string, string> {
  const parentTurnIds = new Set(values(records.Turn)
    .filter((turn) => text(turn.conversation_id) === conversationId)
    .map((turn) => text(turn.id))
    .filter((turnId): turnId is string => Boolean(turnId)));
  const childrenById = firstBy(values(records.ChildExecution), (child) => text(child.id));
  const result: Record<string, string> = {};
  for (const link of values(records.ChildExecutionParentLink)) {
    const parentTurnId = text(link.parent_turn_id);
    const sourceToolCallId = text(link.source_tool_call_id);
    const childExecutionId = text(link.child_execution_id);
    if (!parentTurnId || !parentTurnIds.has(parentTurnId) || !sourceToolCallId || !childExecutionId) continue;
    const childConversationId = text(childrenById.get(childExecutionId)?.child_conversation_id);
    if (childConversationId) result[sourceToolCallId] = childConversationId;
  }
  return result;
}

export function reliableActiveConversationId(projections: Record<string, unknown>): string {
  const window = record(projections.activeConversationWindow);
  return text(window?.conversationId) ?? '';
}

function projectReliableInteractions(
  records: ReliableClientRecordBuckets,
  details: Record<string, ReliableKernelDetailState>
): {
  byToolCallId: Record<string, ReliableInteractionProjection>;
  promptIdByToolCallId: Record<string, string>;
  missingPromptIds: string[];
} {
  const requests = new Map(values(records.InteractionRequest)
    .map((request) => [text(request.id), request] as const)
    .filter((entry): entry is readonly [string, ReliableClientRecord] => !!entry[0]));
  const owners = new Map(values(records.InteractionOwnerLink)
    .map((link) => [text(link.request_id), text(link.turn_id)] as const)
    .filter((entry): entry is readonly [string, string] => !!entry[0] && !!entry[1]));
  const byToolCallId: Record<string, ReliableInteractionProjection> = {};
  const promptIdByToolCallId: Record<string, string> = {};
  const missingPromptIds: string[] = [];
  for (const link of values(records.InteractionToolCallLink)) {
    const requestId = text(link.request_id);
    const toolCallId = text(link.tool_call_id);
    if (!requestId || !toolCallId) continue;
    const request = requests.get(requestId);
    const kind = text(request?.request_kind);
    const status = text(request?.status);
    if (!request || !kind || !status) continue;
    const turnId = owners.get(requestId);
    const detail = details[reliableKernelDetailKey('interaction-prompt', requestId)];
    if (!detail || detail.status === 'loading') missingPromptIds.push(requestId);
    const prompt = detail?.status === 'ready' ? parseJson(detail.text) : undefined;
    promptIdByToolCallId[toolCallId] = requestId;
    byToolCallId[toolCallId] = {
      id: requestId,
      kind,
      status,
      ...(turnId ? { turnId } : {}),
      createdAt: timestamp(request.created_at),
      updatedAt: timestamp(request.updated_at),
      ...(prompt !== undefined ? { prompt } : {})
    };
  }
  return { byToolCallId, promptIdByToolCallId, missingPromptIds };
}

function projectReliableFileChanges(
  records: ReliableClientRecordBuckets,
  details: Record<string, ReliableKernelDetailState>
): {
  diffByToolCallId: Record<string, ReliableFileDiffProjection>;
  changeSetIdByToolCallId: Record<string, string>;
  memberIdsByToolCallId: Record<string, string[]>;
  missingMemberIds: string[];
} {
  const diffByToolCallId: Record<string, ReliableFileDiffProjection> = {};
  const changeSetIdByToolCallId: Record<string, string> = {};
  const memberIdsByToolCallId: Record<string, string[]> = {};
  const missingMemberIds: string[] = [];
  const membersByChangeSet = groupBy(values(records.FileChangeSetMember), (member) => text(member.change_set_id));
  for (const changeSet of values(records.FileChangeSet)) {
    const changeSetId = text(changeSet.id);
    const toolCallId = text(changeSet.tool_call_id);
    if (!changeSetId || !toolCallId) continue;
    changeSetIdByToolCallId[toolCallId] = changeSetId;
    const files: ReliableFileDiffProjection['files'] = [];
    const members = [...(membersByChangeSet.get(changeSetId) ?? [])].sort(compareSequence('member_seq'));
    memberIdsByToolCallId[toolCallId] = members
      .map((member) => text(member.id))
      .filter((id): id is string => !!id);
    for (const member of members) {
      const memberId = text(member.id);
      if (!memberId) continue;
      const detail = details[reliableKernelDetailKey('file-change-diff', memberId)];
      if (!detail || detail.status === 'loading') {
        missingMemberIds.push(memberId);
        continue;
      }
      if (detail.status === 'error') {
        if (!detail.terminalError) missingMemberIds.push(memberId);
        continue;
      }
      const payload = record(parseJson(detail.text));
      const diff = record(payload?.diff);
      const diffText = textPreserveWhitespace(diff?.text);
      const path = text(payload?.path);
      if (!diffText || !path) continue;
      const action = text(payload?.action);
      const added = finiteNumber(diff?.added);
      const removed = finiteNumber(diff?.removed);
      files.push({
        memberId,
        path,
        ...(action ? { action } : {}),
        ...(added !== undefined ? { added } : {}),
        ...(removed !== undefined ? { removed } : {}),
        ...(typeof diff?.truncated === 'boolean' ? { truncated: diff.truncated } : {}),
        text: diffText
      });
    }
    if (files.length > 0) diffByToolCallId[toolCallId] = { files };
  }
  return { diffByToolCallId, changeSetIdByToolCallId, memberIdsByToolCallId, missingMemberIds };
}

function appendTransientMessages(input: {
  messages: ParsedMessage[];
  transientByRequest: Record<string, ReliableKernelTransientState>;
  conversationId: string;
  modelRequestById: Map<string, ReliableClientRecord>;
  sourceMessageIdByTurnId: Map<string, string>;
  messageIdByModelRequestId: Map<string, string>;
  toolCallFacts: ReliableClientRecord[];
  lastCommitSeq?: string;
}): void {
  const { messages, transientByRequest, conversationId } = input;
  const durableLatestRequestSeqByTurn = new Map<string, bigint>();
  for (const request of input.modelRequestById.values()) {
    const turnId = text(request.turn_id);
    const requestSeq = positiveBigInt(request.request_seq);
    if (!turnId || requestSeq === undefined) continue;
    const current = durableLatestRequestSeqByTurn.get(turnId);
    if (current === undefined || requestSeq > current) durableLatestRequestSeqByTurn.set(turnId, requestSeq);
  }
  const active = Object.values(transientByRequest)
    .filter((entry) => entry.conversationId === conversationId)
    .sort(compareTransientRequests);
  for (const transient of active) {
    const request = input.modelRequestById.get(transient.modelRequestId);
    const requestSeq = positiveBigInt(request?.request_seq) ?? positiveBigInt(transient.requestSeq);
    if (requestSeq === undefined) continue;
    // The durable source ModelRequest is the causal visibility fact. A global commit frontier is
    // only a fallback for the brief interval before that independent record arrives.
    if (!request && !transientCausalFrontierReached(transient, input.lastCommitSeq)) continue;
    if (!request && (durableLatestRequestSeqByTurn.get(transient.turnId) ?? 0n) >= requestSeq) continue;
    // 原生异步链上，Provider/Kernel 已授权在异步调用未决时继续输出；
    // 只有非原生路径保留「前序调用未终结则不显示新输出」的抑制。
    const nativeAsyncContinuation = request !== undefined
      && modelRequestNativeCapabilities(request)?.asyncTools === true;
    if (!nativeAsyncContinuation && !priorToolCallsSettled(transient, request, input.toolCallFacts)) continue;

    const linkedMessageId = input.messageIdByModelRequestId.get(transient.modelRequestId);
    const durableTarget = linkedMessageId
      ? messages.find((entry) => entry.message.id === linkedMessageId)
      : undefined;

    const content = transientMessageContent(transient);
    const hasVisibleContent = content.parts.length > 0;
    // 原生流式会把每个完成 item 的不可变 Revision 提前推进为当前 Revision（durableTarget
    // 在请求未终结时就 revisionReady）。此时瞬态仍持有在飞 item 的实时增量，必须继续合并；
    // 非原生路径保持原有「Revision 就绪即丢弃瞬态」的行为不变。
    const nativeEarlyRevision = durableTarget?.revisionReady === true
      && (hasOutputItemIdentity(durableTarget.message.content) || hasOutputItemIdentity(content));
    if (durableTarget?.revisionReady && (!nativeEarlyRevision || request?.status === 'terminal')) continue;

    const model = transient.modelId;
    const usageMetadata = transient.usageMetadata ?? usageMetadataFromRequest(request);
    const projectedStatus = transientProjectionStatus(transient, request);
    if (durableTarget) {
      const mergedContent = nativeEarlyRevision
        ? mergeTransientContentWithDurable(durableTarget.message.content, content)
        : hasVisibleContent ? content : durableTarget.message.content;
      durableTarget.message = {
        ...durableTarget.message,
        content: mergedContent,
        status: projectedStatus,
        ...(model ? { model } : {}),
        ...(usageMetadata ? { usageMetadata } : {}),
        requestStartedAt: (transient.providerStartedAt ?? timestamp(request?.created_at)) || transient.startedAt,
        firstChunkAt: transient.firstOutputAt ?? transient.startedAt,
        ...(transient.completedAt ? { completedAt: transient.completedAt } : {}),
        ...(transient.streamOutputDurationMs !== undefined
          ? { streamOutputDurationMs: transient.streamOutputDurationMs }
          : {})
      };
      continue;
    }

    if (!hasVisibleContent) continue;
    const terminalState = text(request?.terminal_state);
    const durableCompleted = request?.status === 'terminal'
      && (terminalState === 'completed' || (!terminalState && transient.status === 'completed'));
    const historical = (durableLatestRequestSeqByTurn.get(transient.turnId) ?? requestSeq) > requestSeq;
    if (historical || (durableCompleted && linkedMessageId !== undefined)) continue;
    const anchoredSequence = transientSequenceAnchor({
      messages,
      transient,
      requestSeq,
      modelRequestById: input.modelRequestById,
      sourceMessageIdByTurnId: input.sourceMessageIdByTurnId,
      messageIdByModelRequestId: input.messageIdByModelRequestId
    });
    if (anchoredSequence === undefined) continue;
    messages.push({
      record: {
        model_request_id: transient.modelRequestId,
        request_seq: requestSeq.toString()
      },
      turnId: transient.turnId,
      revisionReady: false,
      message: {
        id: `transient:${transient.modelRequestId}`,
        conversationId,
        role: 'model',
        ...(model ? { model } : {}),
        content,
        status: projectedStatus,
        createdAt: transient.startedAt,
        requestStartedAt: (transient.providerStartedAt ?? timestamp(request?.created_at)) || transient.startedAt,
        firstChunkAt: transient.firstOutputAt ?? transient.startedAt,
        ...(transient.completedAt ? { completedAt: transient.completedAt } : {}),
        ...(transient.streamOutputDurationMs !== undefined
          ? { streamOutputDurationMs: transient.streamOutputDurationMs }
          : {}),
        ...(usageMetadata ? { usageMetadata } : {}),
        retryTarget: { kind: 'model_request', modelRequestId: transient.modelRequestId },
        seq: anchoredSequence
      }
    });
  }
}

function transientProjectionStatus(
  transient: ReliableKernelTransientState,
  request: ReliableClientRecord | undefined
): MessageRecord['status'] {
  if (request?.status === 'terminal') {
    const terminalState = text(request.terminal_state);
    return terminalState === 'completed' || (!terminalState && transient.status === 'completed')
      ? 'final'
      : 'partial';
  }
  // Provider completion is still process-local until the terminal ModelRequest commit is visible.
  // Keep the exact output mounted, but do not publish a durable-looking final state early.
  if (transient.status === 'completed') return 'streaming';
  if (transient.status === 'failed' || transient.status === 'cancelled') return 'partial';
  return 'streaming';
}

function compareTransientRequests(
  left: ReliableKernelTransientState,
  right: ReliableKernelTransientState
): number {
  if (left.turnId === right.turnId) {
    const leftSeq = BigInt(left.requestSeq);
    const rightSeq = BigInt(right.requestSeq);
    if (leftSeq !== rightSeq) return leftSeq < rightSeq ? -1 : 1;
  }
  return left.startedAt - right.startedAt || left.modelRequestId.localeCompare(right.modelRequestId);
}

function transientSequenceAnchor(input: {
  messages: ParsedMessage[];
  transient: ReliableKernelTransientState;
  requestSeq: bigint;
  modelRequestById: Map<string, ReliableClientRecord>;
  sourceMessageIdByTurnId: Map<string, string>;
  messageIdByModelRequestId: Map<string, string>;
}): number | undefined {
  let lower: ParsedMessage | undefined;
  let lowerRequestSeq = -1n;
  let upper: ParsedMessage | undefined;
  let upperRequestSeq: bigint | undefined;
  for (const request of input.modelRequestById.values()) {
    if (text(request.turn_id) !== input.transient.turnId) continue;
    const candidateRequestSeq = positiveBigInt(request.request_seq);
    const requestId = text(request.id);
    const messageId = requestId ? input.messageIdByModelRequestId.get(requestId) : undefined;
    const candidate = messageId
      ? input.messages.find((entry) => entry.message.id === messageId)
      : undefined;
    if (!candidate || candidateRequestSeq === undefined) continue;
    if (candidateRequestSeq < input.requestSeq && candidateRequestSeq > lowerRequestSeq) {
      lower = candidate;
      lowerRequestSeq = candidateRequestSeq;
    } else if (
      candidateRequestSeq > input.requestSeq
      && (upperRequestSeq === undefined || candidateRequestSeq < upperRequestSeq)
    ) {
      upper = candidate;
      upperRequestSeq = candidateRequestSeq;
    }
  }
  for (const candidate of input.messages) {
    if (candidate.turnId !== input.transient.turnId) continue;
    const candidateRequestSeq = positiveBigInt(candidate.record.request_seq);
    if (candidateRequestSeq !== undefined && candidateRequestSeq < input.requestSeq) {
      if (candidateRequestSeq > lowerRequestSeq) {
        lower = candidate;
        lowerRequestSeq = candidateRequestSeq;
      }
    } else if (
      candidateRequestSeq === undefined
      && lowerRequestSeq === -1n
      && (!lower || candidate.message.seq > lower.message.seq)
    ) {
      lower = candidate;
    }
  }
  if (!lower) {
    const sourceMessageId = input.sourceMessageIdByTurnId.get(input.transient.turnId);
    if (sourceMessageId) {
      lower = input.messages.find((candidate) => candidate.message.id === sourceMessageId);
    }
    if (!lower) lower = [...input.messages].sort(compareParsedMessages).pop();
  }
  if (!lower) return undefined;
  if (!upper) {
    upper = input.messages
      .filter((candidate) => candidate.message.seq > lower!.message.seq)
      .sort(compareParsedMessages)[0];
  }
  return upper && upper.message.seq > lower.message.seq
    ? lower.message.seq + (upper.message.seq - lower.message.seq) / 2
    : lower.message.seq + 0.5;
}

function transientMessageContent(transient: ReliableKernelTransientState): MessageContent {
  if (transient.completedContent) return transient.completedContent;
  return {
    role: 'model',
    parts: transient.outputParts
  };
}

function partOutputItem(part: MessageContent['parts'][number]): ModelOutputItemReference | undefined {
  return (part as ModelOutputPartMetadata).outputItem;
}

function hasOutputItemIdentity(content: MessageContent): boolean {
  return content.parts.some((part) => text(partOutputItem(part)?.id) !== undefined);
}

/**
 * 原生提前 Revision（当前指针=最新完成 item）与瞬态累计内容的合并。瞬态在同一个 Webview
 * 会话内按时序累计了全部 item，是被覆盖部分的展示权威；durable 部分只在瞬态缺失时
 * （重载/恢复间隙）按 outputItem.ordinal 插回正确时序位置，绝不按身份重复。
 * 去重身份：providerCallId（functionCall part id）+ outputItem.id。
 */
function mergeTransientContentWithDurable(durable: MessageContent, transient: MessageContent): MessageContent {
  if (transient.parts.length === 0) return durable;
  if (durable.parts.length === 0) return transient;
  const transientItemIds = new Set<string>();
  const transientCallIds = new Set<string>();
  for (const part of transient.parts) {
    const itemId = text(partOutputItem(part)?.id);
    if (itemId) transientItemIds.add(itemId);
    if ('functionCall' in part) {
      const callId = text(part.id);
      if (callId) transientCallIds.add(callId);
    }
  }
  const merged = [...transient.parts];
  for (const part of durable.parts) {
    const itemId = text(partOutputItem(part)?.id);
    if (itemId && transientItemIds.has(itemId)) continue;
    const callId = 'functionCall' in part ? text(part.id) : undefined;
    if (callId && transientCallIds.has(callId)) continue;
    // 无身份部分无法安全去重；瞬态累计已覆盖同时序内容，宁可不插回。
    if (!itemId && !callId) continue;
    const ordinal = partOutputItem(part)?.ordinal;
    const insertAt = ordinal === undefined
      ? -1
      : merged.findIndex((candidate) => {
          const candidateOrdinal = partOutputItem(candidate)?.ordinal;
          return candidateOrdinal !== undefined && candidateOrdinal > ordinal;
        });
    if (insertAt >= 0) merged.splice(insertAt, 0, part);
    else merged.push(part);
  }
  return { role: transient.role, parts: merged };
}

function transientCausalFrontierReached(
  transient: ReliableKernelTransientState,
  lastCommitSeq: string | undefined
): boolean {
  if (!transient.afterCommitSeq) return true;
  if (!lastCommitSeq || !/^\d+$/.test(lastCommitSeq)) return false;
  return BigInt(lastCommitSeq) >= BigInt(transient.afterCommitSeq);
}

function priorToolCallsSettled(
  transient: ReliableKernelTransientState,
  request: ReliableClientRecord | undefined,
  toolCalls: readonly ReliableClientRecord[]
): boolean {
  const requestStartedAt = timestamp(request?.created_at) || transient.startedAt;
  return !toolCalls.some((call) =>
    text(call.turn_id) === transient.turnId
    && call.status !== 'terminal'
    && timestamp(call.created_at) < requestStartedAt
  );
}

function enrichModelMessages(
  messages: ParsedMessage[],
  modelRequestsByTurn: Map<string, ReliableClientRecord[]>,
  requestMessageLinks: ReliableClientRecord[]
): void {
  const messagesById = firstBy(messages, (entry) => entry.message.id);
  const requestsById = firstBy(
    [...modelRequestsByTurn.values()].flat(),
    (request) => text(request.id)
  );
  for (const link of requestMessageLinks) {
    const messageId = text(link.message_id);
    const requestId = text(link.model_request_id);
    if (!messageId || !requestId) continue;
    const entry = messagesById.get(messageId);
    const request = requestsById.get(requestId);
    if (!entry || !request || entry.message.role !== 'model') continue;
    applyModelRequestMetadata(entry, request);
  }
}

function applyModelRequestMetadata(entry: ParsedMessage, request: ReliableClientRecord): void {
  const requestId = text(request.id);
  const turnId = text(request.turn_id);
  const model = text(request.model_id);
  const usageMetadata = usageMetadataFromRequest(request);
  const streamStats = record(typeof request.stream_stats_json === 'string'
    ? parseJson(request.stream_stats_json)
    : request.stream_stats_json);
  const providerStartedAt = timestamp(streamStats?.providerStartedAt);
  const firstChunkAt = timestamp(streamStats?.firstOutputAt);
  const completedAt = timestamp(streamStats?.completedAt);
  const streamOutputDurationMs = finiteNumber(streamStats?.streamOutputDurationMs);
  const materializationStatus: MessageRecord['status'] = request.status === 'terminal'
    ? request.terminal_state === 'completed' ? 'final' : 'partial'
    : 'streaming';
  const retryTarget = request.status === 'terminal'
    && request.terminal_state !== 'completed'
    && requestId
    ? { kind: 'model_request' as const, modelRequestId: requestId }
    : entry.message.retryTarget;
  // ModelRequestMessageLink is an additional authoritative live association. Keep using its Turn
  // identity even though MessageTurnLink now also arrives incrementally: commits may expose the
  // request/message fact first, and projection must remain correct at every atomic feed frontier.
  if (turnId) entry.turnId = turnId;
  entry.message = {
    ...entry.message,
    status: materializationStatus,
    ...(retryTarget ? { retryTarget } : {}),
    ...(model ? { model } : {}),
    ...(usageMetadata ? { usageMetadata } : {}),
    ...((providerStartedAt || timestamp(request.created_at)) > 0
      ? { requestStartedAt: providerStartedAt || timestamp(request.created_at) }
      : {}),
    ...(firstChunkAt > 0 ? { firstChunkAt } : {}),
    ...(completedAt > 0 ? { completedAt } : {}),
    ...(streamOutputDurationMs !== undefined && streamOutputDurationMs >= 0
      ? { streamOutputDurationMs }
      : {})
  };
}

function usageMetadataFromRequest(request: ReliableClientRecord | undefined): LlmUsageMetadataRecord | undefined {
  if (!request) return undefined;
  const value = typeof request.usage_json === 'string' ? parseJson(request.usage_json) : request.usage_json;
  return record(value) as LlmUsageMetadataRecord | undefined;
}

function compareParsedMessages(left: ParsedMessage, right: ParsedMessage): number {
  return left.message.seq - right.message.seq
    || left.message.createdAt - right.message.createdAt
    || left.message.id.localeCompare(right.message.id);
}

/**
 * 原生聚合内容按物理 response 身份的连续段分组；缺少身份的 part 是单独的未知段，
 * 不能使已经证明的前缀边界整段回退，也不能被挪进未经证明的后继消息。
 */
function responseRunsByProviderResponseId(
  content: MessageContent
): Array<{ responseId?: string; parts: MessageContent['parts'] }> | undefined {
  const runs: Array<{ responseId?: string; parts: MessageContent['parts'] }> = [];
  for (const part of content.parts) {
    const responseId = text(partOutputItem(part)?.providerResponseId);
    const last = runs[runs.length - 1];
    if (last && last.responseId === responseId) last.parts.push(part);
    else runs.push({ ...(responseId ? { responseId } : {}), parts: [part] });
  }
  return runs.length >= 2 ? runs : undefined;
}

interface SteeringBoundaryProjection {
  splitSourceMessageIdByMessageId: Record<string, string>;
  pendingSteeringBoundaryMessageIds: string[];
}

/**
 * 原生一个 ModelRequest 的聚合 Message 可跨多次物理 response。只按同一请求/Turn、
 * 精确前驱与后继 response 身份、已提交模型上下文的转向回执、真实用户 Message 配对。
 * 缺少证明的后缀留在最后一个已证实条目，不倒退前缀，也绝不凭消息/回执顺序配对。
 * 所有拆分只影响展示，ToolCallSourceLink 和持久化消息身份仍归来源聚合 Message。
 */
function splitAggregateMessagesAtSteeringBoundaries(
  messages: ParsedMessage[],
  steeringReceipts: readonly NativeSteeringReceipt[],
  modelRequestIdByMessageId: Record<string, string>
): SteeringBoundaryProjection {
  const result: SteeringBoundaryProjection = {
    splitSourceMessageIdByMessageId: {},
    pendingSteeringBoundaryMessageIds: []
  };
  if (steeringReceipts.length === 0) return result;
  const messagesById = new Map(messages.map((entry) => [entry.message.id, entry]));
  for (const entry of [...messages].sort(compareParsedMessages)) {
    if (entry.message.role !== 'model') continue;
    const runs = responseRunsByProviderResponseId(entry.message.content);
    if (!runs?.[0]?.responseId) continue;
    const requestId = modelRequestIdByMessageId[entry.message.id];
    if (!requestId || !entry.turnId) continue;
    const requestReceipts = steeringReceipts.filter((receipt) =>
      receipt.modelRequestId === requestId
      && receipt.conversationId === entry.message.conversationId
      && receipt.turnId === entry.turnId
    );
    if (requestReceipts.length === 0) continue;

    const proved: Array<{ run: (typeof runs)[number]; steer: ParsedMessage }> = [];
    const usedSteerMessageIds = new Set<string>();
    let previousSteerSeq = entry.message.seq;
    for (let index = 1; index < runs.length; index += 1) {
      const run = runs[index]!;
      const previousResponseId = runs[index - 1]!.responseId;
      if (!run.responseId || !previousResponseId || run.responseId === previousResponseId) break;
      // 一个物理后继被两次转向同时认领是证据冲突，不能挑任意一条渲染为生效。
      const matching = requestReceipts.filter((receipt) =>
        hasSteeringApplicationReceipt(receipt, requestReceipts)
        && receipt.targetResponseId === previousResponseId
        && receipt.successorResponseId === run.responseId
      );
      if (matching.length !== 1) break;
      if (run.parts.some((part) => {
        const stampedPredecessor = text(partOutputItem(part)?.previousResponseId);
        return stampedPredecessor !== previousResponseId;
      })) break;
      const messageId = matching[0]!.messageId!;
      const steer = messagesById.get(messageId);
      if (!steer || steer.message.role !== 'user' || steer.turnId !== entry.turnId
        || steer.message.seq <= previousSteerSeq || usedSteerMessageIds.has(messageId)) break;
      usedSteerMessageIds.add(messageId);
      proved.push({ run, steer });
      previousSteerSeq = steer.message.seq;
    }
    if (proved.length === 0) {
      // 只有本请求实际有转向收据时才报告未知边界；多 response 也可能只是工具续流。
      result.pendingSteeringBoundaryMessageIds.push(entry.message.id);
      continue;
    }
    const originalMessage = entry.message;
    entry.message = {
      ...originalMessage,
      content: { ...originalMessage.content, parts: runs[0]!.parts }
    };
    for (const [index, pairing] of proved.entries()) {
      const syntheticId = `${originalMessage.id}:steer-successor:${pairing.run.responseId}`;
      // 未证明的尾部保留在最后一段、仍位于下一条转向用户消息之前；不吞掉任何输出。
      const unknownSuffix = index === proved.length - 1
        ? runs.slice(proved.length + 1).flatMap((run) => run.parts)
        : [];
      const { retryTarget: _retryTarget, usageMetadata: _usageMetadata, ...messageBase } = originalMessage;
      result.splitSourceMessageIdByMessageId[syntheticId] = originalMessage.id;
      messages.push({
        record: entry.record,
        ...(entry.turnId ? { turnId: entry.turnId } : {}),
        revisionReady: entry.revisionReady,
        splitFromMessageId: originalMessage.id,
        message: {
          ...messageBase,
          id: syntheticId,
          content: { ...originalMessage.content, parts: [...pairing.run.parts, ...unknownSuffix] },
          seq: pairing.steer.message.seq + 0.25
        }
      });
      if (unknownSuffix.length > 0) result.pendingSteeringBoundaryMessageIds.push(syntheticId);
    }
  }
  messages.sort(compareParsedMessages);
  return result;
}

function functionCallTargets(messages: ParsedMessage[]): FunctionCallTarget[] {
  const targets: FunctionCallTarget[] = [];
  for (const entry of [...messages].sort((left, right) => left.message.seq - right.message.seq)) {
    let ordinal = 0;
    for (const part of entry.message.content.parts) {
      if (!('functionCall' in part)) continue;
      targets.push({ messageId: entry.message.id, part, ordinal });
      ordinal += 1;
    }
  }
  return targets;
}

function resolveFunctionCallTarget(input: {
  raw: ReliableClientRecord;
  functionTargets: FunctionCallTarget[];
  messages: ParsedMessage[];
  sourceLink?: ReliableClientRecord;
}): FunctionCallTarget | undefined {
  // ToolCallSourceLink is the only authoritative owner relation. Guessing by Turn index, name,
  // timestamp or nearest Message can attach an outcome/diff to a different provider call when a
  // bounded feed is incomplete, which is worse than rendering the card as incomplete.
  if (!input.sourceLink) return undefined;
  const providerCallId = text(input.sourceLink.provider_call_id);
  const linkedOwnerMessageId = text(input.sourceLink?.message_id);
  if (!linkedOwnerMessageId) return undefined;
  const owner = input.messages.find((entry) => entry.message.id === linkedOwnerMessageId);
  if (!owner) return undefined;
  // 原生聚合消息在转向边界拆成多个展示条目后，durable part 可能落在任一拆分条目里；
  // ToolCallSourceLink 仍然只指向来源聚合消息，所以把解析范围扩大到它的全部拆分条目。
  const ownerMessageIds = new Set([linkedOwnerMessageId]);
  for (const entry of input.messages) {
    if (entry.splitFromMessageId === linkedOwnerMessageId) ownerMessageIds.add(entry.message.id);
  }
  const ownerTargets = input.functionTargets.filter((target) => ownerMessageIds.has(target.messageId));
  const providerOrdinal = integer(input.sourceLink.provider_ordinal);
  const exact = providerCallId
    ? ownerTargets.find((candidate) => text(candidate.part.id) === providerCallId)
    : ownerTargets.find((candidate) => candidate.ordinal === providerOrdinal);
  if (exact) return exact;
  // While the Message body is still hydrating, the authoritative link is sufficient to create a
  // temporary target. Once that body is ready, a mismatch is an integrity failure and stays hidden.
  if (owner.revisionReady) return undefined;
  return {
    messageId: linkedOwnerMessageId,
    ordinal: providerOrdinal,
    part: {
      ...(providerCallId ? { id: providerCallId } : {}),
      functionCall: {
        name: text(input.raw.tool_name) ?? 'tool',
        args: {}
      }
    }
  };
}

function ensureProjectedFunctionCall(
  messages: ParsedMessage[],
  target: FunctionCallTarget,
  toolCallId: string,
  toolName: string,
  serializedArgs: string
): void {
  const message = messages.find((entry) => entry.message.id === target.messageId);
  if (!message) return;
  const functionParts = message.message.content.parts.filter((part): part is FunctionCallPart => 'functionCall' in part);
  if (functionParts.includes(target.part)) return;
  const providerCallId = text(target.part.id);
  if (functionParts.some((part) =>
    (providerCallId && text(part.id) === providerCallId)
    || text(part.id) === toolCallId
  )) return;
  const parsedArgs = parseJson(serializedArgs);
  message.message = {
    ...message.message,
    content: {
      ...message.message.content,
      parts: [...message.message.content.parts, {
        id: providerCallId ?? toolCallId,
        functionCall: {
          name: toolName,
          args: parsedArgs === undefined ? target.part.functionCall.args : parsedArgs
        }
      }]
    }
  };
}

function parseMessageContent(
  revisionId: string,
  source: string,
  role: 'user' | 'model'
): MessageContent {
  const cached = parsedMessageContentCache.get(revisionId);
  if (cached && cached.role === role && cached.source === source) {
    parsedMessageContentCache.delete(revisionId);
    parsedMessageContentCache.set(revisionId, cached);
    return cached.content;
  }
  const parsed = parseJson(source);
  let content: MessageContent;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const candidate = parsed as Record<string, unknown>;
    if ((candidate.role === 'user' || candidate.role === 'model') && Array.isArray(candidate.parts)) {
      content = candidate as unknown as MessageContent;
    } else {
      content = { role, parts: source ? [{ text: source }] : [] };
    }
  } else {
    content = { role, parts: source ? [{ text: source }] : [] };
  }
  rememberParsedMessageContent(revisionId, { role, source, content });
  return content;
}

function rememberParsedMessageContent(revisionId: string, entry: ParsedMessageContentCacheEntry): void {
  const existing = parsedMessageContentCache.get(revisionId);
  if (existing) parsedMessageContentCacheSourceCharacters -= existing.source.length;
  parsedMessageContentCache.delete(revisionId);
  // A single pathological body remains renderable but must not pin the complete parser cache.
  if (entry.source.length > PARSED_MESSAGE_CONTENT_CACHE_MAX_SOURCE_CHARACTERS) return;
  parsedMessageContentCache.set(revisionId, entry);
  parsedMessageContentCacheSourceCharacters += entry.source.length;
  while (
    parsedMessageContentCache.size > PARSED_MESSAGE_CONTENT_CACHE_MAX_ENTRIES
    || parsedMessageContentCacheSourceCharacters > PARSED_MESSAGE_CONTENT_CACHE_MAX_SOURCE_CHARACTERS
  ) {
    const oldestRevisionId = parsedMessageContentCache.keys().next().value as string | undefined;
    if (!oldestRevisionId) break;
    const oldest = parsedMessageContentCache.get(oldestRevisionId);
    parsedMessageContentCache.delete(oldestRevisionId);
    if (oldest) parsedMessageContentCacheSourceCharacters -= oldest.source.length;
  }
}

function toolStatus(
  call: ReliableClientRecord,
  execution: ReliableClientRecord | undefined,
  outcome: ReliableClientRecord | undefined
): ToolCallStatus {
  if (call.status === 'terminal') {
    const status = toolOutcomeProjectionStatus(outcome);
    if (status === 'succeeded') return 'success';
    if (status === 'partial' || status === 'rejected' || status === 'cancelled'
      || status === 'outcome_unknown' || status === 'missing') return 'warning';
    return 'error';
  }
  if (execution?.status === 'waiting_answer') {
    return call.tool_name === 'run_agent' ? 'awaiting_child' : 'awaiting_user_input';
  }
  if (call.status === 'executing' || execution?.status === 'executing') return 'executing';
  return 'queued';
}

function toolOutcomeProjectionStatus(
  outcome: ReliableClientRecord | undefined
): ReliableToolOutcomeProjectionStatus {
  const status = text(outcome?.status);
  return status === 'succeeded' || status === 'failed' || status === 'partial'
    || status === 'rejected' || status === 'cancelled' || status === 'conflict'
    || status === 'outcome_unknown'
    ? status
    : 'missing';
}

function projectToolCallEvents(
  records: ReliableClientRecordBuckets,
  details: Record<string, ReliableKernelDetailState>
): { events: ToolCallEventRecord[]; missingIds: string[] } {
  const missingIds: string[] = [];
  const events = values(records.ToolCallEvent).flatMap((event) => {
    const id = text(event.id);
    const toolCallId = text(event.tool_call_id);
    const kind = toolCallEventKind(event.event_kind);
    if (!id || !toolCallId || !kind) return [];
    const detail = details[reliableKernelDetailKey('tool-event-content', id)];
    if (!detail || detail.status === 'loading') missingIds.push(id);
    const content = detail?.status === 'ready' ? record(parseJson(detail.text)) : undefined;
    const delta = textPreserveWhitespace(content?.delta);
    const payload = content?.payload ?? (kind === 'progress' ? content?.progress : undefined);
    const error = text(content?.error);
    const status = toolCallStatusValue(content?.status);
    const elapsedMs = finiteNumber(content?.elapsedMs);
    const duration = finiteNumber(content?.durationMs);
    return [{
      id,
      toolCallId,
      seq: integer(event.event_seq),
      kind,
      at: timestamp(event.created_at),
      ...(status ? { status } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(duration !== undefined ? { durationMs: duration } : {}),
      ...(delta !== undefined ? { delta } : {}),
      ...(payload !== undefined ? { payload } : {}),
      ...(error ? { error } : {})
    }];
  }).sort((left, right) => left.at - right.at || left.seq - right.seq || left.id.localeCompare(right.id));
  return { events, missingIds };
}

function toolCallEventKind(value: unknown): ToolCallEventKind | undefined {
  return value === 'created' || value === 'queued' || value === 'started' || value === 'progress'
    || value === 'stdout' || value === 'stderr' || value === 'state' || value === 'completed'
    || value === 'failed'
    ? value
    : undefined;
}

function toolCallStatusValue(value: unknown): ToolCallStatus | undefined {
  return value === 'streaming' || value === 'queued' || value === 'awaiting_approval'
    || value === 'awaiting_user_input' || value === 'awaiting_child' || value === 'executing' || value === 'awaiting_change_apply'
    || value === 'applying_change' || value === 'change_applied' || value === 'change_rejected'
    || value === 'awaiting_result_submit' || value === 'success' || value === 'warning' || value === 'error'
    ? value
    : undefined;
}

function toolSummary(policy: ReliableClientRecord | undefined): string | undefined {
  return text(policy?.summary);
}

function toolProgress(call: ReliableClientRecord, events: readonly ToolCallEventRecord[]): unknown {
  const direct = typeof call.progress_json === 'string' ? parseJson(call.progress_json) : call.progress_json ?? call.progress;
  if (direct !== undefined && direct !== null) return direct;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === 'progress' && event.payload !== undefined) return event.payload;
  }
  return undefined;
}

function toolError(
  call: ReliableClientRecord,
  outcome: ReliableClientRecord | undefined,
  result: unknown,
  events: readonly ToolCallEventRecord[]
): string | undefined {
  const direct = text(call.error ?? call.error_message);
  if (direct) return direct;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.error) return event.error;
  }
  if (outcome?.status === 'succeeded' || outcome?.status === 'rejected') return undefined;
  const detail = record(toolResultDetail(result));
  return text(detail?.error ?? detail?.message ?? detail?.reason);
}

function toolSchedulingMode(policy: ReliableClientRecord | undefined): ToolSchedulingMode {
  const direct = policy?.scheduling_mode;
  if (direct === 'parallel' || direct === 'serial') return direct;
  return 'serial';
}

function toolSchedulingReason(policy: ReliableClientRecord | undefined): string | undefined {
  return text(policy?.scheduling_reason);
}

function toolDisplayPolicy(policy: ReliableClientRecord | undefined): ToolDisplayPolicyRecord | undefined {
  if (!policy) return undefined;
  const autoExpand = booleanInteger(policy.display_auto_expand);
  const autoOpenDiffPreview = booleanInteger(policy.display_auto_open_diff);
  return autoExpand === undefined && autoOpenDiffPreview === undefined
    ? undefined
    : {
        ...(autoExpand !== undefined ? { autoExpand } : {}),
        ...(autoOpenDiffPreview !== undefined ? { autoOpenDiffPreview } : {})
      };
}

function booleanInteger(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === 1n || value === '1') return true;
  if (value === false || value === 0 || value === 0n || value === '0') return false;
  return undefined;
}

function projectTurnTerminations(
  records: ReliableClientRecordBuckets,
  messages: ParsedMessage[],
  conversationId: string
): Record<string, RunTerminationRecord> {
  const byMessageId: Record<string, RunTerminationRecord> = {};
  const conversationTurnIds = new Set(values(records.Turn)
    .filter((turn) => text(turn.conversation_id) === conversationId)
    .map((turn) => text(turn.id))
    .filter((id): id is string => id !== undefined));
  const modelMessagesByTurn = groupBy(
    messages.filter((entry) => entry.message.role === 'model'),
    (entry) => entry.turnId
  );
  const userMessagesByTurn = groupBy(
    messages.filter((entry) => entry.message.role === 'user'),
    (entry) => entry.turnId
  );
  for (const raw of values(records.TurnTermination)) {
    const terminalStatus = text(raw.terminal_status);
    if (!terminalStatus || terminalStatus === 'completed') continue;
    const id = text(raw.id);
    const turnId = text(raw.turn_id);
    if (!id || !turnId || !conversationTurnIds.has(turnId)) continue;
    const reason = textPreserveWhitespace(raw.reason) ?? terminalStatus;
    const termination: RunTerminationRecord = {
      id,
      runId: turnId,
      kind: terminationKind(terminalStatus),
      actor: terminationActor(terminalStatus, reason),
      interruptedPhase: inferredInterruptedPhase(turnId, records),
      reasonCode: terminationReasonCode(terminalStatus, reason),
      detail: reason,
      createdAt: timestamp(raw.created_at)
    };
    const orderedModelTargets = [...(modelMessagesByTurn.get(turnId) ?? [])].sort(compareParsedMessages);
    const orderedUserTargets = [...(userMessagesByTurn.get(turnId) ?? [])].sort(compareParsedMessages);
    const target = orderedModelTargets[orderedModelTargets.length - 1]
      ?? orderedUserTargets[orderedUserTargets.length - 1];
    // The bounded Message window is the rendering authority for placement. A historical fact whose
    // exact Turn anchor is outside that window stays in history; it must never move to the latest row.
    if (!target) continue;
    if (target.message.role === 'model' && !target.revisionReady) {
      target.message = { ...target.message, status: 'partial' };
    }
    byMessageId[target.message.id] = termination;
  }
  return byMessageId;
}

function terminationKind(value: string): RunTerminationRecord['kind'] {
  if (value === 'cancelled') return 'cancelled';
  if (value === 'interrupted') return 'interrupted';
  return 'failed';
}

function terminationActor(value: string, reason: string): RunTerminationRecord['actor'] {
  const normalized = reason.toLowerCase();
  if ((value === 'cancelled' || value === 'interrupted') && normalized.includes('user')) return 'user';
  if (normalized.includes('provider') || normalized.includes('model')) return 'provider';
  if (normalized.includes('tool')) return 'tool';
  return 'system';
}

function terminationReasonCode(value: string, reason: string): RunTerminationRecord['reasonCode'] {
  const normalized = reason.toLowerCase();
  if (normalized.includes('empty') && normalized.includes('model')) return 'empty_model_result';
  if (normalized.includes('extension') || normalized.includes('host restart')) return 'extension_host_restarted';
  if (value === 'cancelled') return 'user_cancelled';
  if (value === 'interrupted') return 'agent_interrupt_requested';
  if (value === 'outcome_unknown') return 'parent_outcome_unknown';
  if (normalized.includes('model') || normalized.includes('provider') || normalized.includes('round')) return 'llm_request_failed';
  return 'invocation_failed';
}

function inferredInterruptedPhase(
  turnId: string,
  records: ReliableClientRecordBuckets
): RunTerminationRecord['interruptedPhase'] {
  const interactionOwnerIds = new Set(values(records.InteractionOwnerLink)
    .filter((link) => text(link.turn_id) === turnId)
    .map((link) => text(link.request_id))
    .filter((id): id is string => id !== undefined));
  const pendingInteraction = values(records.InteractionRequest).find((request) =>
    interactionOwnerIds.has(text(request.id) ?? '') && request.status === 'pending'
  );
  if (pendingInteraction?.request_kind === 'plan_review') return 'waiting_plan_review';
  if (pendingInteraction) return 'waiting_user';
  if (values(records.ToolCall).some((call) => text(call.turn_id) === turnId && call.status !== 'terminal')) return 'waiting_tools';
  const orderedRequests = values(records.ModelRequest)
    .filter((request) => text(request.turn_id) === turnId)
    .sort(compareSequence('request_seq'));
  const latestRequest = orderedRequests[orderedRequests.length - 1];
  if (latestRequest?.status === 'streaming') return 'llm_streaming';
  if (latestRequest?.status === 'pending') return 'llm_request_pending';
  return 'delivering';
}

function toolResponseParts(value: unknown): InlineDataPart[] {
  const envelope = record(value);
  const detail = record(envelope?.detail);
  if (!detail || !Array.isArray(detail.parts)) return [];
  return detail.parts.filter((part): part is InlineDataPart => {
    const wrapper = record(part);
    const inlineData = record(wrapper?.inlineData);
    return !!inlineData
      && typeof inlineData.mimeType === 'string'
      && (
        typeof inlineData.attachmentId === 'string'
        || typeof inlineData.data === 'string'
        || typeof inlineData.sourcePath === 'string'
      );
  });
}

function toolResultDetail(value: unknown): unknown {
  const envelope = record(value);
  return envelope && 'detail' in envelope ? envelope.detail : value;
}

function interactionArguments(prompt: unknown): unknown {
  const envelope = record(prompt);
  if (!envelope) return undefined;
  if ('prompt' in envelope) return envelope.prompt;
  if ('request' in envelope) return envelope.request;
  return undefined;
}

function durationMs(execution: ReliableClientRecord | undefined): number | undefined {
  if (!execution) return undefined;
  const started = timestamp(execution.started_at);
  const completed = timestamp(execution.completed_at);
  return started > 0 && completed >= started ? completed - started : undefined;
}

function normalizeJsonText(value: string): string {
  const parsed = parseJson(value);
  return parsed === undefined ? value : JSON.stringify(parsed);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function projectAbsoluteMessageFloors(messages: readonly ParsedMessage[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const entry of messages) {
    const durableFloor = positiveSafeInteger(entry.record.display_seq)
      ?? positiveSafeInteger(entry.record.message_seq);
    const projectedFloor = durableFloor ?? positiveCeiling(entry.message.seq);
    if (projectedFloor !== undefined) result[entry.message.id] = projectedFloor;
  }
  return result;
}

function positiveSafeInteger(value: unknown): number | undefined {
  const parsed = integer(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveCeiling(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const result = Math.ceil(value);
  return Number.isSafeInteger(result) ? result : undefined;
}

function emptyProjection(): ReliableConversationProjection {
  return {
    messages: [],
    absoluteFloorByMessageId: {},
    toolCalls: [],
    toolCallsByMessageId: {},
    toolCallEvents: [],
    toolCallEventsByCallId: {},
    toolEventIdsByCallId: {},
    turnIdByMessageId: {},
    modelRequestIdByMessageId: {},
    messageRevisionIdByMessageId: {},
    splitSourceMessageIdByMessageId: {},
    pendingSteeringBoundaryMessageIds: [],
    terminationByMessageId: {},
    toolResultByCallId: {},
    toolOutcomeStatusByCallId: {},
    interactionByToolCallId: {},
    interactionPromptIdByToolCallId: {},
    fileDiffByToolCallId: {},
    fileDiffMemberIdsByToolCallId: {},
    fileChangeSetIdByToolCallId: {},
    childConversationIdByToolCallId: {},
    loadingMessageRevisionIds: [],
    missingToolArgumentIds: [],
    missingToolResultIds: [],
    missingToolEventIds: [],
    missingInteractionPromptIds: [],
    missingFileDiffMemberIds: []
  };
}

function values(bucket: Record<string, ReliableClientRecord> | undefined): ReliableClientRecord[] {
  return Object.values(bucket ?? {});
}

function firstBy<T>(
  input: T[],
  key: (record: T) => string | undefined
): Map<string, T> {
  const result = new Map<string, T>();
  for (const entry of input) {
    const id = key(entry);
    if (id && !result.has(id)) result.set(id, entry);
  }
  return result;
}

function groupBy<T>(input: T[], key: (record: T) => string | undefined): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const entry of input) {
    const id = key(entry);
    if (!id) continue;
    const group = result.get(id) ?? [];
    group.push(entry);
    result.set(id, group);
  }
  return result;
}

function objectGroups<T>(input: readonly T[], key: (entry: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const entry of input) (result[key(entry)] ??= []).push(entry);
  return result;
}

function compareSequence(field: string): (left: ReliableClientRecord, right: ReliableClientRecord) => number {
  return (left, right) => integer(left[field]) - integer(right[field])
    || text(left.id)?.localeCompare(text(right.id) ?? '')
    || 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function textPreserveWhitespace(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function integer(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return Number(value);
  return 0;
}

function positiveBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'bigint' && value > 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return BigInt(value);
  return undefined;
}

function timestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
