import { reliableOutputItemIdentity } from './reliableOutputItemIdentity';
import { modelRequestObservedUsage, modelRequestObservedTiming } from '@shared/modelRequestMeasurement';
import type {
  FunctionCallPart,
  InlineDataPart,
  LlmUsageMetadataRecord,
  MessageContent,
  MessageRecord,
  MessageRetryTarget,
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
import {
  reliableMessageContentWindowState,
  type ReliableMessageContentWindow, type ReliableMessageContentWindowPresentation
} from './reliableMessageContentWindow.ts';
import {
  modelRequestNativeCapabilities,
  modelRequestResponseMetrics,
  modelRequestStreamStats
} from '../reliability/modelRequestStreamStats.ts';
import type { NativeSteeringReceipt } from '@shared/openAIResponsesNative';
import { createSteeringReceiptIndex, hasSteeringApplicationReceipt, type SteeringReceiptIndex } from './steeringReceiptProof.ts';
import { createReliablePresentationIndex, withReliablePresentationMessages, type ReliablePresentationIndex } from './reliablePresentationIndex.ts';
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
  messageContentWindows?: Record<string, ReliableMessageContentWindow>;
  transientModelRequests?: Record<string, ReliableKernelTransientState>;
  lastCommitSeq?: string | null;
  /** Only a full snapshot defines which historical request roots belong to the live window. */
  lastSnapshotCommitSeq?: string | null;
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
  contentWindowByMessageId: Record<string, ReliableMessageContentWindowPresentation>;
  index: ReliablePresentationIndex;
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
  windowFirstSequence?: number;
  /** 原生聚合消息在转向边界拆分后，后继 run 条目指向来源聚合消息。 */
  splitFromMessageId?: string;
}

interface FunctionCallTarget {
  messageId: string;
  part: FunctionCallPart;
  ordinal: number;
}

interface FunctionCallTargetIndex {
  messagesById: Map<string, ParsedMessage>;
  targetsByOwnerId: Map<string, { byCallId: Map<string, FunctionCallTarget>; byOrdinal: Map<number, FunctionCallTarget> }>;
  partsByMessageId: Map<string, Set<FunctionCallPart>>;
  callIdsByMessageId: Map<string, Set<string>>;
  appendedPartsByMessageId: Map<string, FunctionCallPart[]>;
}

interface TurnProjectionIndex {
  requestsByTurn: Map<string, ReliableClientRecord[]>;
  callsByTurn: Map<string, ReliableClientRecord[]>;
  pendingInteractionByTurn: Map<string, ReliableClientRecord>;
}

interface ParsedMessageContentCacheEntry {
  role: 'user' | 'model';
  source: string;
  content: MessageContent;
}

// Detail objects are owned/evicted by the feed. Weak keys retain exactly the loaded working set,
// rather than thrashing a byte-limited global LRU on every transient streaming frame.
const parsedMessageContentCache = new WeakMap<ReliableKernelDetailState, ParsedMessageContentCacheEntry>();
interface ParsedDetail {
  source: string; value: unknown; responseParts: InlineDataPart[]; normalizedText?: string;
}
const parsedDetailCache = new WeakMap<ReliableKernelDetailState, ParsedDetail>();

function parsedDetail(detail: ReliableKernelDetailState): ParsedDetail {
  const cached = parsedDetailCache.get(detail);
  if (cached?.source === detail.text) return cached;
  const value = parseJson(detail.text);
  const entry = { source: detail.text, value, responseParts: toolResponseParts(value) };
  parsedDetailCache.set(detail, entry);
  return entry;
}

function normalizedDetail(detail: ReliableKernelDetailState): string {
  const entry = parsedDetail(detail);
  return entry.normalizedText ??= entry.value === undefined ? detail.text : JSON.stringify(entry.value);
}

/**
 * Pure UI projection over independent Runtime objects and Link facts. It never mutates or persists a
 * coupled aggregate: Message↔Turn and Tool↔Turn relationships are interpreted only for rendering.
 */
export function projectReliableConversation(
  input: ReliableConversationProjectionInput
): ReliableConversationProjection {
  return projectReliableConversationTransient(projectReliableCommittedConversation(input), input);
}

interface ReliableCommittedProjectionContext {
  input: ReliableConversationProjectionInput;
  messagesById: Map<string, ParsedMessage>;
  modelRequestById: Map<string, ReliableClientRecord>;
  sourceMessageIdByTurnId: Map<string, string>;
  messageIdByModelRequestId: Map<string, string>;
  latestRequestSeqByTurn: Map<string, bigint>;
  requestsByTurn: Map<string, ReliableClientRecord[]>;
  callsByTurn: Map<string, ReliableClientRecord[]>;
  messagesByTurn: Map<string, ParsedMessage[]>;
  steeringMessagesByTurn: Map<string, ParsedMessage[]>;
  requestSequenceAnchors: Map<string, number | undefined>;
  toolCallsBySourceMessageId: Map<string, ToolCallRecord[]>;
  sourceByToolCallId: Map<string, ReliableClientRecord>;
}
const committedProjectionContexts = new WeakMap<ReliableConversationProjection, ReliableCommittedProjectionContext>();

export function projectReliableCommittedConversation(
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
  const contentWindowByMessageId: Record<string, ReliableMessageContentWindowPresentation> = {};
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
    const contentWindow = input.messageContentWindows?.[id];
    const windowed = Boolean(record.item_index_revision_id) && input.messageContentWindows !== undefined;
    const contentState = windowed ? reliableMessageContentWindowState(contentWindow, String(record.item_index_revision_id), input.details) : undefined;
    const items = contentState?.items ?? [];
    const itemParts = items.flatMap(item => {
      const itemDetail = input.details[reliableKernelDetailKey('message-content-item', item.contentObjectId)];
      return itemDetail?.status === 'ready' ? parseReliableMessageContent(itemDetail, role).parts
        : item.outputItem ? [{ text: '', outputItem: item.outputItem }] : [];
    });
    if (windowed) {
      contentWindowByMessageId[id] = contentState!.presentation;
      if (contentWindowByMessageId[id]!.loading) loadingMessageRevisionIds.push(revisionId);
    } else if (!detail || detail.status === 'loading') loadingMessageRevisionIds.push(revisionId);
    const content = windowed ? { role, parts: itemParts } satisfies MessageContent : detail?.status === 'ready'
      ? parseReliableMessageContent(detail, role)
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
      revisionReady: windowed ? contentState!.ready : detail?.status === 'ready',
      ...(windowed ? { windowFirstSequence: items[0]?.sequence ?? 0 } : {}),
      ...(turnIdByMessageId[id] ? { turnId: turnIdByMessageId[id] } : {})
    });
  }

  const modelRequestsByTurn = groupBy(values(input.records.ModelRequest), (record) => text(record.turn_id));
  const modelRequestById = firstBy(values(input.records.ModelRequest), (record) => text(record.id));
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
  parsedMessages.sort(compareParsedMessages);
  for (const entry of parsedMessages) if (entry.turnId) turnIdByMessageId[entry.message.id] = entry.turnId;
  const messageIdByModelRequestId = new Map(modelRequestMessageLinks.flatMap((link) => {
    const requestId = text(link.model_request_id), messageId = text(link.message_id);
    return requestId && messageId ? [[requestId, messageId] as const] : [];
  }));
  const latestRequestSeqByTurn = new Map<string, bigint>();
  for (const [turnId, requests] of modelRequestsByTurn) {
    let latest = 0n;
    for (const request of requests) {
      const sequence = positiveBigInt(request.request_seq) ?? 0n;
      if (sequence > latest) latest = sequence;
    }
    latestRequestSeqByTurn.set(turnId, latest);
  }
  const baseParsedMessages = parsedMessages.map(entry => ({ ...entry }));
  const context: ReliableCommittedProjectionContext = {
    input, messagesById: new Map(baseParsedMessages.map(entry => [entry.message.id, entry])),
    modelRequestById, messageIdByModelRequestId, latestRequestSeqByTurn, requestsByTurn: modelRequestsByTurn,
    sourceMessageIdByTurnId: new Map(values(input.records.Turn).flatMap(turn => {
      const turnId = text(turn.id), sourceMessageId = text(turn.source_message_id);
      return turnId && sourceMessageId ? [[turnId, sourceMessageId] as const] : [];
    })),
    callsByTurn: groupBy(values(input.records.ToolCall), call => text(call.turn_id)),
    messagesByTurn: groupBy(baseParsedMessages, entry => entry.turnId),
    steeringMessagesByTurn: groupBy(baseParsedMessages.filter(entry => entry.message.steeringInput), entry => entry.turnId),
    requestSequenceAnchors: new Map(),
    toolCallsBySourceMessageId: new Map(),
    sourceByToolCallId: firstBy(values(input.records.ToolCallSourceLink), link => text(link.tool_call_id))
  };
  const steeringBoundaries = splitAggregateMessagesAtSteeringBoundaries(
    parsedMessages,
    input.steeringReceipts ?? [],
    modelRequestIdByMessageId
  );
  const splitSourceMessageIdByMessageId = steeringBoundaries.splitSourceMessageIdByMessageId;
  // 拆分条目继承来源消息的 Turn 归属；终止/运行展示按同一 Turn 解释，不虚构独立边界。
  for (const [syntheticId, sourceId] of Object.entries(splitSourceMessageIdByMessageId)) {
    if (contentWindowByMessageId[sourceId]) contentWindowByMessageId[syntheticId] = contentWindowByMessageId[sourceId]!;
    const turnId = turnIdByMessageId[sourceId];
    if (turnId) turnIdByMessageId[syntheticId] = turnId;
  }
  const absoluteFloorByMessageId = projectAbsoluteMessageFloors(parsedMessages);

  const callsByTurn = context.callsByTurn;
  const turnIndex = createTurnProjectionIndex(input.records, modelRequestsByTurn, callsByTurn);
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

  const functionTargets = functionCallTargetIndex(parsedMessages);
  const sourceByToolCallId = context.sourceByToolCallId;
  const policyByToolCallId = firstBy(values(input.records.ToolCallPolicySnapshot), (snapshot) => text(snapshot.tool_call_id));
  for (const [turnId, rawCalls] of callsByTurn) {
    if (!turnId) continue;
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
        sourceLink
      });
      if (!target) continue;
      const argumentsDetail = input.details[reliableKernelDetailKey('tool-arguments-content', id)];
      const resultDetail = input.details[reliableKernelDetailKey('tool-result-content', id)];
      if (!argumentsDetail || argumentsDetail.status === 'loading') missingToolArgumentIds.push(id);
      if (raw.status === 'terminal' && (!resultDetail || resultDetail.status === 'loading')) missingToolResultIds.push(id);
      const args = argumentsDetail?.status === 'ready'
        ? normalizedDetail(argumentsDetail)
        : JSON.stringify(interactionArguments(interactionByToolCallId[id]?.prompt) ?? target.part.functionCall.args ?? {});
      const execution = executionsByCall.get(id);
      const outcome = outcomesByCall.get(id);
      if (raw.status === 'terminal') {
        toolOutcomeStatusByCallId[id] = toolOutcomeProjectionStatus(outcome);
      }
      const result = resultDetail?.status === 'ready' ? parsedDetail(resultDetail) : undefined;
      const parsedResult = result?.value;
      const responseParts = result?.responseParts ?? [];
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
        functionTargets,
        target,
        id,
        name,
        args
      );
    }
  }
  for (const [messageId, parts] of functionTargets.appendedPartsByMessageId) {
    const entry = functionTargets.messagesById.get(messageId)!;
    entry.message = { ...entry.message, content: { ...entry.message.content, parts: [...entry.message.content.parts, ...parts] } };
  }

  const fileChanges = projectReliableFileChanges(input.records, input.details);
  const childConversationIdByToolCallId = projectChildConversationIdsByToolCallId(
    input.records,
    conversationId
  );
  const terminationByMessageId = projectTurnTerminations(input.records, parsedMessages, conversationId, turnIndex);
  const toolCallsByMessageId = objectGroups(toolCalls, (call) => call.messageId);
  const toolCallEventsByCallId = objectGroups(toolCallEvents, (event) => event.toolCallId);
  const toolEventIdsByCallId = Object.fromEntries(Object.entries(toolCallEventsByCallId)
    .map(([toolCallId, events]) => [toolCallId, events.map((event) => event.id)]));
  const messages = parsedMessages.map((entry) => entry.message);
  context.toolCallsBySourceMessageId = groupBy(toolCalls, call => text(sourceByToolCallId.get(call.id)?.message_id));
  const projection: ReliableConversationProjection = {
    index: createReliablePresentationIndex(messages, toolCalls, turnIdByMessageId, undefined,
      [...context.callsByTurn].filter(([, calls]) => calls.some(call => call.status === 'terminal')).map(([turnId]) => turnId)),
    messages,
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
    contentWindowByMessageId,
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
  committedProjectionContexts.set(projection, context);
  return projection;
}

/** A transient frame projects only its request's current Message and steering successors. */
export function projectReliableConversationTransient(
  committed: ReliableConversationProjection,
  input: Pick<ReliableConversationProjectionInput, 'transientModelRequests' | 'lastCommitSeq' | 'lastSnapshotCommitSeq'> & {
    transientSequenceAnchors?: ReadonlyMap<string, number>;
  }
): ReliableConversationProjection {
  const context = committedProjectionContexts.get(committed);
  if (!context) return committed;
  const transientByRequest = input.transientModelRequests ?? {};
  const selected = new Map<string, ParsedMessage>();
  const selectedRequestIds = new Set<string>();
  for (const transient of Object.values(transientByRequest)) {
    if (transient.conversationId !== context.input.conversationId) continue;
    selectedRequestIds.add(transient.modelRequestId);
    const messageId = context.messageIdByModelRequestId.get(transient.modelRequestId);
    const entry = messageId ? context.messagesById.get(messageId) : undefined;
    if (entry) selected.set(entry.message.id, { ...entry });
  }
  if (selectedRequestIds.size === 0) return committed;
  const messages = [...selected.values()];
  appendTransientMessages({
    messages, transientByRequest, conversationId: context.input.conversationId,
    modelRequestById: context.modelRequestById, sourceMessageIdByTurnId: context.sourceMessageIdByTurnId,
    messageIdByModelRequestId: context.messageIdByModelRequestId, latestRequestSeqByTurn: context.latestRequestSeqByTurn,
    toolCallsByTurn: context.callsByTurn, messagesById: context.messagesById,
    requestsByTurn: context.requestsByTurn, messagesByTurn: context.messagesByTurn,
    contentWindows: context.input.messageContentWindows, requestSequenceAnchors: context.requestSequenceAnchors,
    transientSequenceAnchors: input.transientSequenceAnchors,
    lastCommitSeq: input.lastCommitSeq ?? undefined, lastSnapshotCommitSeq: input.lastSnapshotCommitSeq ?? undefined
  });
  const changedSources = new Set(messages.filter(entry =>
    entry.message !== context.messagesById.get(entry.message.id)?.message).map(entry => entry.message.id));
  if (changedSources.size === 0) return committed;
  const receipts = (context.input.steeringReceipts ?? []).filter(receipt => selectedRequestIds.has(receipt.modelRequestId ?? ''));
  const turns = new Set(Object.values(transientByRequest).map(transient => transient.turnId));
  for (const turnId of turns) for (const entry of context.steeringMessagesByTurn.get(turnId) ?? []) {
    if (!selected.has(entry.message.id)) { selected.set(entry.message.id, entry); messages.push({ ...entry }); }
  }
  const boundary = splitAggregateMessagesAtSteeringBoundaries(messages, receipts, committed.modelRequestIdByMessageId);
  const targets = functionCallTargetIndex(messages);
  const replacements = new Map<string, ToolCallRecord | undefined>();
  for (const sourceId of changedSources) {
    for (const call of context.toolCallsBySourceMessageId.get(sourceId) ?? []) {
      const raw = context.input.records.ToolCall?.[call.id];
      if (!raw) continue;
      const target = resolveFunctionCallTarget({ raw, functionTargets: targets, sourceLink: context.sourceByToolCallId.get(call.id) });
      if (!target) replacements.set(call.id, undefined);
      else {
        if (target.messageId !== call.messageId) replacements.set(call.id, { ...call, messageId: target.messageId });
        ensureProjectedFunctionCall(targets, target, call.id, call.name, call.args);
      }
    }
  }
  for (const [id, parts] of targets.appendedPartsByMessageId) {
    const entry = targets.messagesById.get(id)!;
    entry.message = { ...entry.message, content: { ...entry.message.content, parts: [...entry.message.content.parts, ...parts] } };
  }
  const replaces = (id: string): boolean => changedSources.has(committed.splitSourceMessageIdByMessageId[id] ?? id);
  const overlayEntries = messages.filter(entry => changedSources.has(entry.splitFromMessageId ?? entry.message.id));
  const projectedMessages = [
    ...committed.messages.filter(message => !replaces(message.id)),
    ...overlayEntries.map(entry => entry.message)
  ].sort((left, right) => left.seq - right.seq || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const turnIdByMessageId = { ...committed.turnIdByMessageId };
  const absoluteFloorByMessageId = { ...committed.absoluteFloorByMessageId };
  const splitSourceMessageIdByMessageId = Object.fromEntries(Object.entries(committed.splitSourceMessageIdByMessageId)
    .filter(([id]) => !replaces(id)));
  const terminationByMessageId = { ...committed.terminationByMessageId };
  const contentWindowByMessageId = { ...committed.contentWindowByMessageId };
  const terminationByTurn = new Map<string, RunTerminationRecord>();
  for (const [id, termination] of Object.entries(terminationByMessageId)) {
    if (replaces(id)) {
      terminationByTurn.set(termination.runId, termination);
      delete terminationByMessageId[id];
    }
  }
  const lastOverlayByTurn = new Map(overlayEntries.flatMap(entry => entry.turnId ? [[entry.turnId, entry] as const] : []));
  for (const entry of overlayEntries) {
    if (entry.turnId) {
      turnIdByMessageId[entry.message.id] = entry.turnId;
      const termination = terminationByTurn.get(entry.turnId);
      if (termination) {
        const previous = lastOverlayByTurn.get(entry.turnId);
        if (previous) terminationByMessageId[previous.message.id] = termination;
      }
    }
    const source = entry.splitFromMessageId;
    if (source) {
      splitSourceMessageIdByMessageId[entry.message.id] = source;
      if (committed.contentWindowByMessageId[source]) contentWindowByMessageId[entry.message.id] = committed.contentWindowByMessageId[source]!;
    }
    const floor = committed.absoluteFloorByMessageId[source ?? entry.message.id] ?? positiveCeiling(entry.message.seq);
    if (floor !== undefined) absoluteFloorByMessageId[entry.message.id] = floor;
  }
  const toolCalls = replacements.size === 0 ? committed.toolCalls
    : committed.toolCalls.flatMap(call => replacements.has(call.id) ? replacements.get(call.id) ? [replacements.get(call.id)!] : [] : [call]);
  const toolCallsByMessageId = replacements.size === 0 ? committed.toolCallsByMessageId : objectGroups(toolCalls, call => call.messageId);
  return {
    ...committed, messages: projectedMessages, toolCalls, toolCallsByMessageId,
    index: replacements.size === 0 ? withReliablePresentationMessages(committed.index, projectedMessages)
      : createReliablePresentationIndex(projectedMessages, toolCalls, turnIdByMessageId, committed.index, committed.index.completedToolTurnIds),
    turnIdByMessageId, absoluteFloorByMessageId, splitSourceMessageIdByMessageId, terminationByMessageId, contentWindowByMessageId,
    pendingSteeringBoundaryMessageIds: [
      ...committed.pendingSteeringBoundaryMessageIds.filter(id => !replaces(id)), ...boundary.pendingSteeringBoundaryMessageIds
    ]
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
    const prompt = detail?.status === 'ready' ? parsedDetail(detail).value : undefined;
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
      if (!detail || detail.status === 'loading' || detail.status === 'error' && !detail.terminalError) {
        missingMemberIds.push(memberId);
      }
      // File identity comes from the change member, not from successful diff rendering. Empty
      // files, directories and a still-loading preview must not disappear from the tool card.
      const payload = detail?.status === 'ready' ? record(parsedDetail(detail).value) : undefined;
      const diff = record(payload?.diff);
      const diffText = textPreserveWhitespace(diff?.text) ?? '';
      const path = text(member.target_path);
      if (!path) continue;
      const action = ({
        create_file: 'created', replace_file: 'modified', delete_file: 'deleted',
        create_directory: 'created-directory', delete_directory_tree: 'deleted-directory'
      } as Record<string, string>)[String(member.operation)] ?? text(payload?.action);
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
  toolCallsByTurn: ReadonlyMap<string, ReliableClientRecord[]>;
  latestRequestSeqByTurn: ReadonlyMap<string, bigint>;
  messagesById: ReadonlyMap<string, ParsedMessage>;
  requestsByTurn: ReadonlyMap<string, ReliableClientRecord[]>;
  messagesByTurn: ReadonlyMap<string, ParsedMessage[]>;
  contentWindows?: Record<string, ReliableMessageContentWindow>;
  requestSequenceAnchors: Map<string, number | undefined>;
  transientSequenceAnchors?: ReadonlyMap<string, number>;
  lastCommitSeq?: string;
  lastSnapshotCommitSeq?: string;
}): void {
  const { messages, transientByRequest, conversationId } = input;
  const durableLatestRequestSeqByTurn = input.latestRequestSeqByTurn;
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
    // A reconnect can replay a cached terminal preview after a history action removed its
    // Message and the full snapshot no longer includes that request. Do not recreate an extra
    // transcript card beyond that causal snapshot. Keep the overlay cache: a history page may
    // restore its request, and neither a delta nor a snapshot older than the frame proves scope.
    if (!request && ['completed', 'failed', 'cancelled'].includes(transient.status)
      && transient.afterCommitSeq && /^\d+$/.test(transient.afterCommitSeq)
      && input.lastSnapshotCommitSeq
      && transientCausalFrontierReached(transient, input.lastSnapshotCommitSeq)) continue;
    // 原生异步链上，Provider/Kernel 已授权在异步调用未决时继续输出；
    // 只有非原生路径保留「前序调用未终结则不显示新输出」的抑制。
    const nativeAsyncContinuation = request !== undefined
      && modelRequestNativeCapabilities(request)?.asyncTools === true;
    if (!nativeAsyncContinuation && !priorToolCallsSettled(transient, request, input.toolCallsByTurn.get(transient.turnId) ?? [])) continue;

    const linkedMessageId = input.messageIdByModelRequestId.get(transient.modelRequestId);
    const durableTarget = linkedMessageId
      ? messages.find((entry) => entry.message.id === linkedMessageId)
      : undefined;

    if (linkedMessageId && input.contentWindows?.[linkedMessageId]?.followTail === false) continue;
    const content = transientMessageContent(transient);
    const hasVisibleContent = content.parts.length > 0;
    // 原生流式会把每个完成 item 的不可变 Revision 提前推进为当前 Revision（durableTarget
    // 在请求未终结时就 revisionReady）。此时瞬态仍持有在飞 item 的实时增量，必须继续合并；
    // 非原生路径保持原有「Revision 就绪即丢弃瞬态」的行为不变。
    const nativeEarlyRevision = durableTarget !== undefined
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
      // Content may still be supplied by the transient overlay before detail hydration, but a
      // terminal request's verified measurement/timing is already authoritative.
      if (request?.status === 'terminal') applyModelRequestMetadata(durableTarget, request);
      continue;
    }

    if (!hasVisibleContent) continue;
    const terminalState = text(request?.terminal_state);
    const durableCompleted = request?.status === 'terminal'
      && (terminalState === 'completed' || (!terminalState && transient.status === 'completed'));
    const historical = (durableLatestRequestSeqByTurn.get(transient.turnId) ?? requestSeq) > requestSeq;
    if (historical || (durableCompleted && linkedMessageId !== undefined)) continue;
    const localAnchoredSequence = input.requestSequenceAnchors.has(transient.modelRequestId)
      ? input.requestSequenceAnchors.get(transient.modelRequestId) : transientSequenceAnchor({
      messages: [...input.messagesById.values()],
      messagesById: input.messagesById,
      requests: input.requestsByTurn.get(transient.turnId) ?? [],
      turnMessages: input.messagesByTurn.get(transient.turnId) ?? [],
      transient,
      requestSeq,
      modelRequestById: input.modelRequestById,
      sourceMessageIdByTurnId: input.sourceMessageIdByTurnId,
      messageIdByModelRequestId: input.messageIdByModelRequestId
    });
    input.requestSequenceAnchors.set(transient.modelRequestId, localAnchoredSequence);
    const anchoredSequence = localAnchoredSequence ?? input.transientSequenceAnchors?.get(transient.modelRequestId);
    if (anchoredSequence === undefined) continue;
    const responseMetrics = request ? modelRequestResponseMetrics(modelRequestStreamStats(request)) : undefined;
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
        ...(responseMetrics ? { responseMetrics } : {}),
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
  messagesById: ReadonlyMap<string, ParsedMessage>;
  requests: readonly ReliableClientRecord[];
  turnMessages: readonly ParsedMessage[];
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
  for (const request of input.requests) {
    const candidateRequestSeq = positiveBigInt(request.request_seq);
    const requestId = text(request.id);
    const messageId = requestId ? input.messageIdByModelRequestId.get(requestId) : undefined;
    const candidate = messageId
      ? input.messagesById.get(messageId)
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
  for (const candidate of input.turnMessages) {
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
      lower = input.messagesById.get(sourceMessageId);
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
  const identity = (part: MessageContent['parts'][number]): string | undefined => reliableOutputItemIdentity(part.outputItem)
    ?? ('functionCall' in part && part.id ? `call:${part.id}` : undefined);
  const transientById = new Map(transient.parts.flatMap(part => { const id = identity(part); return id ? [[id, part] as const] : []; }));
  const used = new Set<string>();
  const groups = new Map<string, MessageContent['parts']>();
  const responseOrder: string[] = [];
  const append = (part: MessageContent['parts'][number]): void => {
    const response = part.outputItem?.providerResponseId ?? '';
    let group = groups.get(response);
    if (!group) {
      group = []; groups.set(response, group);
      const predecessor = part.outputItem?.previousResponseId;
      const prior = predecessor ? responseOrder.indexOf(predecessor) : -1;
      if (prior >= 0) responseOrder.splice(prior + 1, 0, response); else responseOrder.push(response);
    }
    group.push(part);
  };
  for (const part of durable.parts) {
    const id = identity(part);
    if (!id) continue;
    append(transientById.get(id) ?? part); used.add(id);
  }
  for (const part of transient.parts) {
    const id = identity(part);
    if (!id || !used.has(id)) append(part);
  }
  const parts: MessageContent['parts'] = [];
  for (const response of responseOrder) {
    const group = groups.get(response)!;
    group.sort((left, right) => (left.outputItem?.ordinal ?? Number.MAX_SAFE_INTEGER) - (right.outputItem?.ordinal ?? Number.MAX_SAFE_INTEGER));
    for (const part of group) parts.push(part);
  }
  return { role: transient.role, parts };
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
  const streamStats = modelRequestObservedTiming(request);
  const providerStartedAt = timestamp(streamStats?.providerStartedAt);
  const firstChunkAt = timestamp(streamStats?.firstOutputAt);
  const completedAt = timestamp(streamStats?.completedAt);
  const streamOutputDurationMs = finiteNumber(streamStats?.streamOutputDurationMs);
  const responseMetrics = modelRequestResponseMetrics(streamStats);
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
    ...(providerStartedAt > 0 ? { requestStartedAt: providerStartedAt } : {}),
    ...(firstChunkAt > 0 ? { firstChunkAt } : {}),
    ...(completedAt > 0 ? { completedAt } : {}),
    ...(streamOutputDurationMs !== undefined && streamOutputDurationMs >= 0
      ? { streamOutputDurationMs }
      : {}),
    ...(responseMetrics ? { responseMetrics } : {})
  };
}

function usageMetadataFromRequest(request: ReliableClientRecord | undefined): LlmUsageMetadataRecord | undefined {
  return modelRequestObservedUsage(request);
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
  content: MessageContent, allowSingle = false
): Array<{ responseId?: string; parts: MessageContent['parts'] }> | undefined {
  const runs: Array<{ responseId?: string; parts: MessageContent['parts'] }> = [];
  for (const part of content.parts) {
    const responseId = text(partOutputItem(part)?.providerResponseId);
    const last = runs[runs.length - 1];
    if (last && last.responseId === responseId) last.parts.push(part);
    else runs.push({ ...(responseId ? { responseId } : {}), parts: [part] });
  }
  return runs.length >= (allowSingle ? 1 : 2) ? runs : undefined;
}

interface SteeringBoundaryProjection {
  splitSourceMessageIdByMessageId: Record<string, string>;
  pendingSteeringBoundaryMessageIds: string[];
}

/**
 * 原生一个 ModelRequest 的聚合 Message 可跨多次物理 response（工具结果续流与转向后继都会产生新
 * response）。只在转向回执认领的边界上拆分或标记待确认：
 * - 没有任何回执认领的边界是同一段的续流（例如工具结果后的新 response），内容留在当前段；
 * - 恰好一条已证实回执认领、后继身份与盖章前驱一致、且对应真实转向用户 Message 时拆出新段；
 * - 被认领但无法证实（未生效、冲突、盖章不符、转向消息缺失）时内容留在当前段并标记待确认；后续边界继续独立判断。
 * 同一回合里还有未被任何回执覆盖的转向消息时，续流的归属无法确认，同样标记待确认。
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
  const receiptMessageIds = new Set(steeringReceipts.flatMap((receipt) => receipt.messageId ? [receipt.messageId] : []));
  const receiptsByRequest = groupBy([...steeringReceipts], (receipt) => receipt.modelRequestId);
  const receiptIndex = createSteeringReceiptIndex(steeringReceipts);
  const unaccountedSteerSeqByTurn = new Map<string, number>();
  for (const entry of messages) {
    if (entry.turnId && entry.message.role === 'user' && entry.message.steeringInput && !receiptMessageIds.has(entry.message.id)) {
      unaccountedSteerSeqByTurn.set(entry.turnId, Math.max(unaccountedSteerSeqByTurn.get(entry.turnId) ?? 0, entry.message.seq));
    }
  }
  for (const entry of [...messages].sort(compareParsedMessages)) {
    if (entry.message.role !== 'model') continue;
    const startsWithinWindow = (entry.windowFirstSequence ?? 1) > 1;
    const runs = responseRunsByProviderResponseId(entry.message.content, startsWithinWindow);
    if (!runs?.[0]) continue;
    const requestId = modelRequestIdByMessageId[entry.message.id];
    if (!requestId || !entry.turnId) continue;
    const requestReceipts = (receiptsByRequest.get(requestId) ?? []).filter((receipt) =>
      receipt.conversationId === entry.message.conversationId
      && receipt.turnId === entry.turnId
    );
    if (requestReceipts.length === 0) continue;
    const successorClaims = new Map<string, NativeSteeringReceipt[]>();
    const predecessorClaims = new Map<string, NativeSteeringReceipt[]>();
    const targetResponseIds = new Set<string>();
    const openSubmissionIds = new Set<string>();
    for (const receipt of requestReceipts) {
      if (receipt.state === 'failed') continue;
      openSubmissionIds.add(receipt.submissionId);
      if (receipt.targetResponseId) targetResponseIds.add(receipt.targetResponseId);
      const ids = receipt.successorResponseId ? [receipt.successorResponseId]
        : [...new Set([receipt.targetResponseId, receipt.responseId].filter((id): id is string => Boolean(id)))];
      const map = receipt.successorResponseId ? successorClaims : predecessorClaims;
      for (const id of ids) {
        const claims = map.get(id) ?? [];
        claims.push(receipt);
        map.set(id, claims);
      }
    }

    const segments: Array<{ steer?: ParsedMessage; responseId?: string; parts: MessageContent['parts']; pending?: boolean }> = [{ parts: [] }];
    const usedSubmissionIds = new Set<string>();
    const earlierResponseIds = new Set<string>();
    let previousSteerSeq = entry.message.seq;
    let continued = false;
    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index]!;
      const current = segments[segments.length - 1]!;
      if (index === 0 && !startsWithinWindow) {
        for (const part of run.parts) current.parts.push(part);
        if (run.responseId) earlierResponseIds.add(run.responseId);
        continue;
      }
      const windowStart = index === 0;
      const previousResponseId = windowStart
        ? text(partOutputItem(run.parts[0]!)?.previousResponseId) : runs[index - 1]!.responseId;
      if (windowStart && previousResponseId) earlierResponseIds.add(previousResponseId);
      const boundary = classifySteeringBoundary({
        run, previousResponseId, windowStart, receiptIndex, successorClaims, predecessorClaims, targetResponseIds, openSubmissionIds,
        earlierResponseIds, usedSubmissionIds, messagesById, entry, previousSteerSeq
      });
      if (run.responseId) earlierResponseIds.add(run.responseId);
      if (boundary.kind === 'split') {
        usedSubmissionIds.add(boundary.receipt.submissionId);
        previousSteerSeq = boundary.steer.message.seq;
        segments.push({ steer: boundary.steer, responseId: boundary.receipt.successorResponseId,
          parts: [...run.parts], ...(boundary.pending ? { pending: true } : {}) });
        continue;
      }
      for (const part of run.parts) current.parts.push(part);
      if (boundary.kind === 'unresolved') current.pending = true;
      else if (!windowStart) continued = true;
    }
    // A steering Message of this Turn that no receipt accounts for may own a continuation.
    const unaccountedSteer = continued && (unaccountedSteerSeqByTurn.get(entry.turnId) ?? 0) > entry.message.seq;
    const originalMessage = entry.message;
    const pendingIds = (segment: typeof segments[number], id: string): void => {
      if (segment.pending) result.pendingSteeringBoundaryMessageIds.push(id);
    };
    if (segments.length === 1) {
      if (segments[0]!.pending || unaccountedSteer) result.pendingSteeringBoundaryMessageIds.push(originalMessage.id);
      continue;
    }
    entry.message = {
      ...originalMessage,
      content: { ...originalMessage.content, parts: segments[0]!.parts }
    };
    pendingIds(segments[0]!, originalMessage.id);
    let lastId = originalMessage.id;
    for (const segment of segments.slice(1)) {
      const syntheticId = `${originalMessage.id}:steer-successor:${segment.responseId}`;
      // 用量与每轮指标属于整个请求，只留在来源条目上，不在拆出的后继上重复。
      const {
        retryTarget: _retryTarget,
        usageMetadata: _usageMetadata,
        responseMetrics: _responseMetrics,
        ...messageBase
      } = originalMessage;
      result.splitSourceMessageIdByMessageId[syntheticId] = originalMessage.id;
      messages.push({
        record: entry.record,
        ...(entry.turnId ? { turnId: entry.turnId } : {}),
        revisionReady: entry.revisionReady,
        windowFirstSequence: entry.windowFirstSequence,
        splitFromMessageId: originalMessage.id,
        message: {
          ...messageBase,
          id: syntheticId,
          content: { ...originalMessage.content, parts: segment.parts },
          seq: segment.steer!.message.seq + 0.25
        }
      });
      pendingIds(segment, syntheticId);
      lastId = syntheticId;
    }
    if (unaccountedSteer && !segments[segments.length - 1]!.pending) result.pendingSteeringBoundaryMessageIds.push(lastId);
  }
  messages.sort(compareParsedMessages);
  return result;
}

type SteeringBoundary =
  | { kind: 'continuation' }
  | { kind: 'unresolved' }
  | { kind: 'split'; receipt: NativeSteeringReceipt; steer: ParsedMessage; pending?: boolean };

/**
 * A receipt claims the boundary into its recorded successor; one without a successor yet claims the
 * boundary after the response it steered (its target, or its latest observed response), since that
 * next response may be its successor. Failed receipts and receipts already placed claim nothing.
 */
interface SteeringBoundaryInput {
  run: { responseId?: string; parts: MessageContent['parts'] };
  previousResponseId?: string;
  windowStart: boolean;
  receiptIndex: SteeringReceiptIndex;
  successorClaims: ReadonlyMap<string, readonly NativeSteeringReceipt[]>;
  predecessorClaims: ReadonlyMap<string, readonly NativeSteeringReceipt[]>;
  targetResponseIds: ReadonlySet<string>;
  openSubmissionIds: ReadonlySet<string>;
  earlierResponseIds: ReadonlySet<string>;
  usedSubmissionIds: ReadonlySet<string>;
  messagesById: ReadonlyMap<string, ParsedMessage>;
  entry: ParsedMessage;
  previousSteerSeq: number;
}

function classifySteeringBoundary(input: SteeringBoundaryInput): SteeringBoundary {
  const { run, previousResponseId } = input;
  const claiming = [...(run.responseId ? input.successorClaims.get(run.responseId) ?? [] : []),
    ...(previousResponseId ? input.predecessorClaims.get(previousResponseId) ?? [] : [])]
    .filter((receipt) => !input.usedSubmissionIds.has(receipt.submissionId));
  let boundary: SteeringBoundary = { kind: 'continuation' };
  if (claiming.length > 0) boundary = proveSteeringBoundary(input, claiming, 'boundary');
  else if ((!run.responseId || (!previousResponseId && !input.windowStart))
    && input.openSubmissionIds.size > input.usedSubmissionIds.size) boundary = { kind: 'unresolved' };
  if (!input.windowStart || boundary.kind === 'split') return boundary;
  // The item carries its actual steering segment independently of how many physical tool-result
  // responses precede this window. Physical predecessor identity alone cannot recover that owner.
  const segmentResponseId = text(partOutputItem(run.parts[0]!)?.steeringSuccessorResponseId);
  if (!segmentResponseId) return boundary.kind === 'continuation' && run.responseId
    && !input.targetResponseIds.has(run.responseId) && input.openSubmissionIds.size > input.usedSubmissionIds.size
    ? { kind: 'unresolved' } : boundary;
  const inheritedClaims = (input.successorClaims.get(segmentResponseId) ?? [])
    .filter(receipt => !input.usedSubmissionIds.has(receipt.submissionId));
  if (inheritedClaims.length === 0) return { kind: 'unresolved' };
  const inherited = proveSteeringBoundary(input, inheritedClaims, 'segment');
  if (inherited.kind === 'continuation') return boundary;
  return inherited.kind === 'split' && boundary.kind === 'unresolved' ? { ...inherited, pending: true } : inherited;
}

function proveSteeringBoundary(
  input: SteeringBoundaryInput,
  claiming: readonly NativeSteeringReceipt[],
  relation: 'boundary' | 'segment'
): SteeringBoundary {
  const { run, previousResponseId } = input;
  const receipt = claiming[0]!;
  const segmentResponseId = text(partOutputItem(run.parts[0]!)?.steeringSuccessorResponseId);
  // 一个物理后继被两次转向同时认领是证据冲突，不能挑任意一条渲染为生效。
  if (!run.responseId || claiming.length !== 1
    || !hasSteeringApplicationReceipt(receipt, input.receiptIndex)
    || receipt.successorResponseId !== (relation === 'boundary' ? run.responseId : segmentResponseId)) return { kind: 'unresolved' };
  // The steer targeted this response or an earlier one of the same request (a tool continuation
  // may come in between); the successor itself must be stamped as following the previous response.
  if (segmentResponseId) {
    if (run.parts.some(part => text(partOutputItem(part)?.steeringSuccessorResponseId) !== receipt.successorResponseId)) return { kind: 'unresolved' };
  } else if (!previousResponseId || !input.earlierResponseIds.has(receipt.targetResponseId!)
    || run.parts.some(part => text(partOutputItem(part)?.previousResponseId) !== previousResponseId)) return { kind: 'unresolved' };
  const steer = input.messagesById.get(receipt.messageId!);
  if (!steer || steer.message.role !== 'user' || steer.turnId !== input.entry.turnId) return { kind: 'unresolved' };
  // Steering admitted before this aggregate's first output is already before the source Message;
  // its segment needs no synthetic row at an earlier display position.
  if (steer.message.seq <= input.entry.message.seq) return { kind: 'continuation' };
  if (steer.message.seq <= input.previousSteerSeq) return { kind: 'unresolved' };
  return { kind: 'split', receipt, steer };
}

function functionCallTargetIndex(messages: ParsedMessage[]): FunctionCallTargetIndex {
  const index: FunctionCallTargetIndex = {
    messagesById: new Map(), targetsByOwnerId: new Map(), partsByMessageId: new Map(),
    callIdsByMessageId: new Map(), appendedPartsByMessageId: new Map()
  };
  const nextOrdinalByOwner = new Map<string, number>();
  for (const entry of [...messages].sort((left, right) => left.message.seq - right.message.seq)) {
    index.messagesById.set(entry.message.id, entry);
    const ownerId = entry.splitFromMessageId ?? entry.message.id;
    const targets = index.targetsByOwnerId.get(ownerId) ?? { byCallId: new Map(), byOrdinal: new Map() };
    index.targetsByOwnerId.set(ownerId, targets);
    const parts = new Set<FunctionCallPart>();
    const callIds = new Set<string>();
    index.partsByMessageId.set(entry.message.id, parts);
    index.callIdsByMessageId.set(entry.message.id, callIds);
    let ordinal = nextOrdinalByOwner.get(ownerId) ?? 0;
    for (const part of entry.message.content.parts) {
      if (!('functionCall' in part)) continue;
      const target = { messageId: entry.message.id, part, ordinal };
      parts.add(part);
      const callId = text(part.id);
      if (callId) {
        callIds.add(callId);
        if (!targets.byCallId.has(callId)) targets.byCallId.set(callId, target);
      }
      if ((entry.windowFirstSequence ?? 1) <= 1 && !targets.byOrdinal.has(ordinal)) targets.byOrdinal.set(ordinal, target);
      ordinal += 1;
    }
    nextOrdinalByOwner.set(ownerId, ordinal);
  }
  return index;
}

function resolveFunctionCallTarget(input: {
  raw: ReliableClientRecord;
  functionTargets: FunctionCallTargetIndex;
  sourceLink?: ReliableClientRecord;
}): FunctionCallTarget | undefined {
  // ToolCallSourceLink is the only authoritative owner relation. Guessing by Turn index, name,
  // timestamp or nearest Message can attach an outcome/diff to a different provider call when a
  // bounded feed is incomplete, which is worse than rendering the card as incomplete.
  if (!input.sourceLink) return undefined;
  const providerCallId = text(input.sourceLink.provider_call_id);
  const linkedOwnerMessageId = text(input.sourceLink?.message_id);
  if (!linkedOwnerMessageId) return undefined;
  const owner = input.functionTargets.messagesById.get(linkedOwnerMessageId);
  if (!owner || owner.turnId !== text(input.raw.turn_id)) return undefined;
  // 原生聚合消息在转向边界拆成多个展示条目后，durable part 可能落在任一拆分条目里；
  // ToolCallSourceLink 仍然只指向来源聚合消息，所以把解析范围扩大到它的全部拆分条目。
  const ownerTargets = input.functionTargets.targetsByOwnerId.get(linkedOwnerMessageId);
  const providerOrdinal = integer(input.sourceLink.provider_ordinal);
  const exact = providerCallId
    ? ownerTargets?.byCallId.get(providerCallId)
    : ownerTargets?.byOrdinal.get(providerOrdinal);
  if (exact) return exact;
  // While the Message body is still hydrating, the authoritative link is sufficient to create a
  // temporary target. Once that body is ready, a mismatch is an integrity failure and stays hidden.
  if (owner.revisionReady || owner.windowFirstSequence !== undefined) return undefined;
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
  index: FunctionCallTargetIndex,
  target: FunctionCallTarget,
  toolCallId: string,
  toolName: string,
  serializedArgs: string
): void {
  if (!index.messagesById.has(target.messageId)) return;
  if (index.partsByMessageId.get(target.messageId)?.has(target.part)) return;
  const providerCallId = text(target.part.id);
  const callIds = index.callIdsByMessageId.get(target.messageId)!;
  if ((providerCallId && callIds.has(providerCallId)) || callIds.has(toolCallId)) return;
  const parsedArgs = parseJson(serializedArgs);
  const part: FunctionCallPart = {
    id: providerCallId ?? toolCallId,
    functionCall: { name: toolName, args: parsedArgs === undefined ? target.part.functionCall.args : parsedArgs }
  };
  callIds.add(part.id!);
  const parts = index.appendedPartsByMessageId.get(target.messageId) ?? [];
  parts.push(part);
  index.appendedPartsByMessageId.set(target.messageId, parts);
}

export function parseReliableMessageContent(
  detail: ReliableKernelDetailState,
  role: 'user' | 'model'
): MessageContent {
  const source = detail.text;
  const cached = parsedMessageContentCache.get(detail);
  if (cached && cached.role === role && cached.source === source) return cached.content;
  const parsed = parsedDetail(detail).value;
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
  parsedMessageContentCache.set(detail, { role, source, content });
  return content;
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
    const content = detail?.status === 'ready' ? record(parsedDetail(detail).value) : undefined;
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

export interface ReliableModelRequestRetryIndex {
  turns: Map<string, ReliableClientRecord>;
  hasActiveTurn: boolean;
  terminations: Map<string, ReliableClientRecord[]>;
  latestRequests: Map<string, ReliableClientRecord>;
  contextProjections: Map<string, ReliableClientRecord[]>;
  heads: ReliableClientRecord[];
}

/** These relationships change at a committed boundary, independently of streamed message bodies. */
export function createReliableModelRequestRetryIndex(records: ReliableClientRecordBuckets, conversationId: string): ReliableModelRequestRetryIndex {
  const turns = new Map(values(records.Turn).filter(turn => text(turn.conversation_id) === conversationId).map(turn => [text(turn.id)!, turn]));
  const latestRequests = new Map<string, ReliableClientRecord>();
  const compare = compareSequence('request_seq');
  for (const request of values(records.ModelRequest)) {
    const turnId = text(request.turn_id), current = turnId ? latestRequests.get(turnId) : undefined;
    if (turnId && (!current || compare(current, request) < 0)) latestRequests.set(turnId, request);
  }
  return { turns, hasActiveTurn: [...turns.values()].some(turn => turn.status === 'active'),
    terminations: groupBy(values(records.TurnTermination), item => text(item.turn_id)), latestRequests,
    contextProjections: groupBy(values(records.ModelContextProjection).filter(item => item.owner_kind === 'model_request'), item => text(item.owner_id)),
    heads: values(records.ConversationContextStatus).filter(head => head.conversation_id === conversationId) };
}

/** A presentation of the same frozen-root conditions rechecked by TurnControlPlane on submission. */
export function modelRequestRetryForTurn(
  records: ReliableClientRecordBuckets,
  conversationId: string,
  turnId: string,
  index: ReliableModelRequestRetryIndex = createReliableModelRequestRetryIndex(records, conversationId)
): { target?: Extract<MessageRetryTarget, { kind: 'model_request' }>; blockedReason?: string } {
  const turn = index.turns.get(turnId);
  if (!turn || turn.status !== 'terminated') return { blockedReason: '本轮尚未结束，请等待状态同步' };
  if (index.hasActiveTurn) return {};
  const termination = index.terminations.get(turnId) ?? [];
  if (termination.length !== 1 || termination[0].terminal_status !== 'failed') {
    return { blockedReason: '本轮已停止；如需继续，请发送新消息' };
  }
  const request = index.latestRequests.get(turnId);
  const requestId = text(request?.id);
  if (!requestId) return { blockedReason: '本轮尚未创建模型请求，请重新发送消息' };
  const terminalState = text(request?.terminal_state) ?? '';
  if (request?.status !== 'terminal'
    || (terminalState !== 'provider_failed' && !terminalState.startsWith('provider_transient_'))) {
    return { blockedReason: '没有可重试的失败模型请求，请重新发送消息' };
  }
  const projections = index.contextProjections.get(requestId) ?? [], heads = index.heads;
  if (projections.length !== 1 || heads.length !== 1 || !text(projections[0].root_id) || !text(heads[0].root_id)) {
    return { blockedReason: '正在等待模型请求与当前上下文同步' };
  }
  if (projections[0].root_id !== heads[0].root_id) {
    return { blockedReason: '此请求之后的上下文已改变，请从当前上下文发送消息' };
  }
  return { target: { kind: 'model_request', modelRequestId: requestId } };
}

/** Preserve the exact durable terminal identity even when a retry Turn owns no user Message. */
export function projectReliableTurnTermination(
  raw: ReliableClientRecord,
  records: ReliableClientRecordBuckets,
  index: TurnProjectionIndex = createTurnProjectionIndex(records)
): RunTerminationRecord | undefined {
  const terminalStatus = text(raw.terminal_status);
  const id = text(raw.id);
  const turnId = text(raw.turn_id);
  if (!terminalStatus || terminalStatus === 'completed' || !id || !turnId) return undefined;
  const reason = textPreserveWhitespace(raw.reason) ?? terminalStatus;
  const manualStop = (terminalStatus === 'interrupted' || terminalStatus === 'cancelled') && isManualStopReason(reason);
  return {
    id, runId: turnId, kind: terminationKind(terminalStatus),
    actor: manualStop ? 'user' : terminationActor(terminalStatus, reason),
    interruptedPhase: inferredInterruptedPhase(turnId, index),
    reasonCode: manualStop ? 'user_cancelled' : terminationReasonCode(terminalStatus, reason),
    detail: manualStop ? MANUAL_STOP_DETAIL : reason, createdAt: timestamp(raw.created_at)
  };
}

const MANUAL_STOP_DETAIL = '手动暂停';

/**
 * 停止按钮（以及删除、编辑前的自动停止）写下的原因。旧版本只记录了执行器观察到的英文阶段说明，
 * 那时几乎都来自手动停止，一并按手动暂停显示。
 */
function isManualStopReason(reason: string): boolean {
  return reason.startsWith('用户请求中断当前 Turn') || reason.startsWith('Executor observed interrupt_request');
}

function projectTurnTerminations(
  records: ReliableClientRecordBuckets,
  messages: ParsedMessage[],
  conversationId: string,
  index: TurnProjectionIndex
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
    const termination = projectReliableTurnTermination(raw, records, index);
    if (!termination) continue;
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
  if ((value === 'cancelled' || value === 'interrupted') && (normalized.includes('user') || reason.startsWith('用户'))) return 'user';
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

export function createTurnProjectionIndex(
  records: ReliableClientRecordBuckets,
  requestsByTurn = groupBy(values(records.ModelRequest), (request) => text(request.turn_id)),
  callsByTurn = groupBy(values(records.ToolCall), (call) => text(call.turn_id))
): TurnProjectionIndex {
  for (const requests of requestsByTurn.values()) requests.sort(compareSequence('request_seq'));
  const turnByInteractionId = new Map<string, string[]>();
  for (const link of values(records.InteractionOwnerLink)) {
    const requestId = text(link.request_id);
    const turnId = text(link.turn_id);
    if (requestId && turnId) {
      const turns = turnByInteractionId.get(requestId) ?? [];
      turns.push(turnId);
      turnByInteractionId.set(requestId, turns);
    }
  }
  const pendingInteractionByTurn = new Map<string, ReliableClientRecord>();
  for (const request of values(records.InteractionRequest)) {
    if (request.status !== 'pending') continue;
    for (const turnId of turnByInteractionId.get(text(request.id) ?? '') ?? []) {
      if (!pendingInteractionByTurn.has(turnId)) pendingInteractionByTurn.set(turnId, request);
    }
  }
  return { requestsByTurn, callsByTurn, pendingInteractionByTurn };
}

function inferredInterruptedPhase(
  turnId: string,
  index: TurnProjectionIndex
): RunTerminationRecord['interruptedPhase'] {
  const pendingInteraction = index.pendingInteractionByTurn.get(turnId);
  if (pendingInteraction?.request_kind === 'plan_review') return 'waiting_plan_review';
  if (pendingInteraction) return 'waiting_user';
  if (index.callsByTurn.get(turnId)?.some((call) => call.status !== 'terminal')) return 'waiting_tools';
  const orderedRequests = index.requestsByTurn.get(turnId) ?? [];
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
    contentWindowByMessageId: {},
    index: createReliablePresentationIndex([], []),
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
