import type { MessageContent, MessageRecord, ToolCallRecord } from '@shared/protocol';
import type { NativeSteeringReceipt } from '@shared/openAIResponsesNative';
import {
  projectReliableCommittedConversation, projectReliableConversationTransient, projectReliableConversation,
  reliableTerminalRequestTime,
  type ReliableClientRecord, type ReliableClientRecordBuckets,
  type ReliableConversationProjection, type ReliableConversationProjectionInput
} from './reliableConversationProjection.ts';
import {
  createReliablePresentationIndex, reliableCompressionAnchorAt, withReliablePresentationMessages, withReliablePresentationMessageOverrides
} from './reliablePresentationIndex.ts';
import { reliableMessageContentItemsKey } from './reliableMessageContentWindow.ts';

const domains = [
  'Message', 'MessageTurnLink', 'Turn', 'TurnTermination', 'ModelRequest', 'ModelRequestMessageLink',
  'ToolCall', 'ToolCallSourceLink', 'ToolCallPolicySnapshot', 'ToolCallEvent', 'ToolExecution', 'ToolOutcome',
  'InteractionRequest', 'InteractionOwnerLink', 'InteractionToolCallLink',
  'FileChangeSet', 'FileChangeSetMember', 'ChildExecution', 'ChildExecutionParentLink'
] as const;
const relationshipDomains = new Set<string>([
  'MessageTurnLink', 'ModelRequest', 'ModelRequestMessageLink', 'ToolCall',
  'InteractionOwnerLink', 'InteractionToolCallLink', 'FileChangeSet', 'ChildExecutionParentLink'
]);

const projectionArrays = ['loadingMessageRevisionIds', 'missingToolArgumentIds', 'missingToolResultIds', 'missingToolEventIds',
  'missingInteractionPromptIds', 'missingFileDiffMemberIds', 'pendingSteeringBoundaryMessageIds'] as const;
const projectionDictionaries = ['contentWindowByMessageId', 'absoluteFloorByMessageId', 'toolCallsByMessageId', 'toolCallEventsByCallId', 'toolEventIdsByCallId',
  'turnIdByMessageId', 'modelRequestIdByMessageId', 'messageRevisionIdByMessageId', 'splitSourceMessageIdByMessageId',
  'terminationByMessageId', 'toolResultByCallId', 'toolOutcomeStatusByCallId', 'interactionByToolCallId',
  'interactionPromptIdByToolCallId', 'fileDiffByToolCallId', 'fileDiffMemberIdsByToolCallId', 'fileChangeSetIdByToolCallId',
  'childConversationIdByToolCallId'] as const;

interface ProjectionGroup {
  records: ReliableClientRecordBuckets;
  projectedRecords?: ReliableClientRecordBuckets;
  detailKeys: string[];
  detailInputs: unknown[];
  contentWindows?: unknown[];
  receipts: readonly NativeSteeringReceipt[];
  projection?: ReliableConversationProjection;
}

/**
 * Domain indexes reference the feed's single committed objects. A batch updates affected Turn
 * groups; each group's completed Messages/tools survive unrelated commits and all transient frames.
 * Group lifetime is exactly the resident fact lifetime, so releasing a page also releases projection.
 */
export class ReliableConversationProjector {
  private conversationId = '';
  private records: ReliableClientRecordBuckets = {};
  private groups = new Map<string, ProjectionGroup>();
  private assignments = new Map<string, Map<string, { groupId: string; record: ReliableClientRecord }>>();
  private committed?: ReliableConversationProjection;
  private assembled?: ReliableConversationProjection;
  private assembledGroups: ReliableConversationProjection[] = [];
  private layoutGroups = new Map<string, ReliableConversationProjection>();
  private layoutOverlayGroups = new Set<string>();
  private input?: ReliableConversationProjectionInput;
  private fallback?: ReliableConversationProjection;
  private transientInput?: Pick<ReliableConversationProjectionInput, 'transientModelRequests' | 'lastCommitSeq' | 'lastSnapshotCommitSeq'>;

  projectCommitted(input: ReliableConversationProjectionInput): ReliableConversationProjection {
    if (input.conversationId !== this.conversationId) {
      this.conversationId = input.conversationId;
      this.records = {};
      this.groups.clear();
      this.assignments.clear();
      this.committed = undefined;
      this.assembled = undefined;
      this.assembledGroups = [];
      this.layoutGroups.clear(); this.layoutOverlayGroups.clear();
    }
    this.input = input;
    this.synchronizeRecords(input.records);
    const receiptsByTurn = new Map<string, NativeSteeringReceipt[]>();
    for (const receipt of input.steeringReceipts ?? []) {
      const group = receiptsByTurn.get(receipt.turnId) ?? [];
      group.push(receipt);
      receiptsByTurn.set(receipt.turnId, group);
    }
    let changed = !this.committed;
    for (const [id, group] of this.groups) {
      const receipts = receiptsByTurn.get(id) ?? [];
      const contentWindows = Object.keys(group.records.Message ?? {}).map(id => input.messageContentWindows?.[id]);
      if (group.records !== group.projectedRecords || !sameItems(group.contentWindows ?? [], contentWindows)) {
        group.detailKeys = detailKeysForRecords(group.records, input);
      }
      const detailInputs = group.detailKeys.flatMap(key => {
        const detail = input.details[key];
        return [detail, detail?.status, detail?.text, detail?.error];
      });
      if (group.records === group.projectedRecords && sameItems(group.detailInputs, detailInputs)
        && sameItems(group.receipts, receipts) && sameItems(group.contentWindows ?? [], contentWindows)) continue;
      const next = projectReliableCommittedConversation({
        conversationId: input.conversationId, records: group.records, details: input.details, steeringReceipts: receipts, messageContentWindows: input.messageContentWindows
      });
      if (group.projection) reuseUnchangedProjectionObjects(group.projection, next);
      group.projection = next;
      group.projectedRecords = group.records;
      group.detailInputs = detailInputs;
      group.contentWindows = contentWindows;
      group.receipts = receipts;
      changed = true;
    }
    const projections = [...this.groups.values()].flatMap(group => group.projection ? [group.projection] : []);
    if (changed || !this.committed || !sameItems(this.committedGroups, projections)) {
      this.committed = this.assemble(projections);
      this.layoutGroups = new Map([...this.groups].flatMap(([id, group]) => group.projection ? [[id, group.projection] as const] : []));
      this.layoutOverlayGroups.clear();
      this.committedGroups = projections;
      this.fallback = undefined;
    }
    return this.committed;
  }

  private committedGroups: ReliableConversationProjection[] = [];

  projectTransient(input: Pick<ReliableConversationProjectionInput,
    'transientModelRequests' | 'lastCommitSeq' | 'lastSnapshotCommitSeq'>): ReliableConversationProjection {
    this.transientInput = input;
    const committed = this.committed!;
    const byTurn = new Map<string, NonNullable<ReliableConversationProjectionInput['transientModelRequests']>>();
    for (const [id, transient] of Object.entries(input.transientModelRequests ?? {})) {
      if (transient.conversationId !== this.conversationId) continue;
      const entries = byTurn.get(transient.turnId) ?? {};
      entries[id] = transient;
      byTurn.set(transient.turnId, entries);
    }
    if (byTurn.size === 0) return committed;
    // A causally visible frame may briefly precede its independent request/Turn row. Its fallback
    // context is prepared once at the committed boundary and never rebuilt by text deltas.
    if ([...byTurn.keys()].some(turnId => !this.groups.has(turnId))) {
      this.fallback ??= projectReliableCommittedConversation(this.input!);
      return projectReliableConversationTransient(this.fallback, input);
    }
    // Retry/continuation Turns can own no Message yet. Borrow only the stable global position;
    // the group still decides request visibility and projects its own output without history bodies.
    const transientSequenceAnchors = new Map<string, number>();
    const { messageIds, messageById, messagePositionById } = committed.index;
    for (const [turnId, requests] of byTurn) {
      const sourceId = this.records.Turn?.[turnId]?.source_message_id;
      const sourcePosition = typeof sourceId === 'string' ? messagePositionById.get(sourceId) : undefined;
      for (const { modelRequestId } of Object.values(requests)) {
        const terminalAt = reliableTerminalRequestTime(this.records.ModelRequest?.[modelRequestId]);
        const position = sourcePosition ?? (terminalAt
          ? messagePositionById.get(reliableCompressionAnchorAt(committed.index, terminalAt) ?? '')
          : messageIds.length - 1);
        if (position === undefined) continue;
        const lower = messageById.get(messageIds[position] ?? ''), upper = messageById.get(messageIds[position + 1] ?? '');
        if (!lower) continue;
        transientSequenceAnchors.set(modelRequestId,
          upper && upper.seq > lower.seq ? lower.seq + (upper.seq - lower.seq) / 2 : lower.seq + 0.5);
      }
    }
    const projectedGroups = new Map<string, ReliableConversationProjection>();
    for (const id of new Set([...byTurn.keys(), ...this.layoutOverlayGroups])) {
      const group = this.groups.get(id);
      if (!group?.projection) continue;
      const transient = byTurn.get(id);
      projectedGroups.set(id, transient ? projectReliableConversationTransient(group.projection, {
        ...input, transientModelRequests: transient, transientSequenceAnchors
      }) : group.projection);
    }
    // A pure body frame leaves layout and every relationship dictionary intact. Only the small
    // active group is inspected; the public message array keeps its existing shallow-array contract.
    if (this.assembled && [...projectedGroups].every(([id, projection]) => {
      const layout = this.layoutGroups.get(id);
      return layout && sameProjectionLayout(layout, projection);
    })) {
      const messages = this.assembled.messages.slice();
      const overrides = new Map<string, MessageRecord>();
      for (const projection of projectedGroups.values()) for (const message of projection.messages) {
        const position = this.assembled.index.messagePositionById.get(message.id)!;
        messages[position] = message;
        if (this.assembled.index.messageById.get(message.id) !== message) overrides.set(message.id, message);
      }
      return { ...this.assembled, messages, index: withReliablePresentationMessageOverrides(this.assembled.index, overrides) };
    }
    const groups = [...this.groups.entries()].flatMap(([id, group]) => {
      const projection = projectedGroups.get(id) ?? group.projection;
      return projection ? [[id, projection] as const] : [];
    });
    const projections = groups.map(([, projection]) => projection);
    const result = sameItems(projections, this.committedGroups) ? committed : this.assemble(projections);
    if (result === committed) { this.assembled = committed; this.assembledGroups = projections; }
    this.layoutGroups = new Map(groups);
    this.layoutOverlayGroups = new Set(byTurn.keys());
    return result;
  }

  prepareCompleteMessageContent(messageId: string, sourceMessageId: string): (details: ReliableConversationProjectionInput['details']) => MessageContent | undefined {
    const owner = this.assignments.get('Message')?.get(sourceMessageId)?.groupId;
    const group = owner ? this.groups.get(owner) : undefined;
    const conversationId = this.conversationId, records = group?.records, receipts = group?.receipts;
    const transient = this.transientInput;
    return details => {
      if (!records) return undefined;
      const complete = projectReliableConversation({ conversationId, records, details, steeringReceipts: receipts, ...transient });
      return complete.index.messageById.get(messageId)?.content;
    };
  }

  private synchronizeRecords(records: ReliableClientRecordBuckets): void {
    const changedTypes = domains.filter(type => records[type] !== this.records[type]);
    if (changedTypes.length === 0) return;
    const relationChanged = changedTypes.some(type => relationshipDomains.has(type));
    const owner = recordOwnerSelector(records);
    const drafted = new Map<string, Set<string>>();
    const writable = (groupId: string, type: string): Record<string, ReliableClientRecord> => {
      let group = this.groups.get(groupId);
      if (!group) {
        group = { records: {}, detailKeys: [], detailInputs: [], receipts: [] };
        this.groups.set(groupId, group);
      }
      let types = drafted.get(groupId);
      if (!types) {
        group.records = { ...group.records };
        types = new Set(); drafted.set(groupId, types);
      }
      if (!types.has(type)) {
        group.records[type] = { ...group.records[type] };
        types.add(type);
      }
      return group.records[type]!;
    };
    for (const type of relationChanged ? domains : changedTypes) {
      const prior = this.assignments.get(type) ?? new Map();
      const next = new Map<string, { groupId: string; record: ReliableClientRecord }>();
      for (const [id, record] of Object.entries(records[type] ?? {})) {
        const groupId = owner(type, id, record);
        const previous = prior.get(id);
        next.set(id, { groupId, record });
        if (previous?.groupId === groupId && previous.record === record) continue;
        if (previous) delete writable(previous.groupId, type)[id];
        writable(groupId, type)[id] = record;
      }
      for (const [id, previous] of prior) if (!next.has(id)) delete writable(previous.groupId, type)[id];
      this.assignments.set(type, next);
    }
    for (const groupId of drafted.keys()) {
      const group = this.groups.get(groupId)!;
      if (Object.values(group.records).every(bucket => Object.keys(bucket).length === 0)) this.groups.delete(groupId);
    }
    this.records = records;
  }

  private assemble(projections: ReliableConversationProjection[]): ReliableConversationProjection {
    if (this.assembled && sameItems(projections, this.assembledGroups)) return this.assembled;
    const empty = projectReliableCommittedConversation({ conversationId: this.conversationId, records: {}, details: {} });
    const result = empty;
    const completedToolTurnIds = new Set<string>();
    for (const projection of projections) {
      for (const turnId of projection.index.completedToolTurnIds) completedToolTurnIds.add(turnId);
      for (const message of projection.messages) result.messages.push(message);
      for (const call of projection.toolCalls) result.toolCalls.push(call);
      for (const event of projection.toolCallEvents) result.toolCallEvents.push(event);
      for (const key of projectionArrays) for (const value of projection[key]) result[key].push(value);
      for (const key of projectionDictionaries) Object.assign(result[key], projection[key]);
    }
    if (this.assembled) {
      for (const key of projectionDictionaries) if (sameShallowRecord(this.assembled[key], result[key])) {
        (result as unknown as Record<string, unknown>)[key] = this.assembled[key];
      }
    }
    result.messages.sort((left, right) => left.seq - right.seq || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    if (this.assembled && sameItems(result.toolCalls, this.assembled.toolCalls)) result.toolCalls = this.assembled.toolCalls;
    result.index = this.assembled && result.toolCalls === this.assembled.toolCalls
      ? withReliablePresentationMessages(this.assembled.index, result.messages)
      : createReliablePresentationIndex(result.messages, result.toolCalls, result.turnIdByMessageId, this.assembled?.index);
    const previousCompleted = this.assembled?.index.completedToolTurnIds;
    result.index = { ...result.index, completedToolTurnIds: previousCompleted?.size === completedToolTurnIds.size
      && [...completedToolTurnIds].every(id => previousCompleted.has(id)) ? previousCompleted : completedToolTurnIds };
    this.assembled = result;
    this.assembledGroups = projections;
    return result;
  }
}

function recordOwnerSelector(records: ReliableClientRecordBuckets): (type: string, id: string, row: ReliableClientRecord) => string {
  const rows = (type: string): ReliableClientRecord[] => Object.values(records[type] ?? {});
  const field = (row: ReliableClientRecord | undefined, name: string): string => typeof row?.[name] === 'string' ? row[name] as string : '';
  const messages = new Map<string, string>();
  const requests = new Map(rows('ModelRequest').map(row => [field(row, 'id'), field(row, 'turn_id')]));
  const calls = new Map(rows('ToolCall').map(row => [field(row, 'id'), field(row, 'turn_id')]));
  for (const row of rows('MessageTurnLink')) {
    const id = field(row, 'message_id');
    if (row.role === 'model' || !messages.has(id)) messages.set(id, field(row, 'turn_id'));
  }
  for (const row of rows('ModelRequestMessageLink')) {
    const turn = requests.get(field(row, 'model_request_id'));
    if (turn) messages.set(field(row, 'message_id'), turn);
  }
  const interactions = new Map(rows('InteractionOwnerLink').map(row => [field(row, 'request_id'), field(row, 'turn_id')]));
  for (const row of rows('InteractionToolCallLink')) {
    const turn = calls.get(field(row, 'tool_call_id'));
    if (turn && !interactions.has(field(row, 'request_id'))) interactions.set(field(row, 'request_id'), turn);
  }
  const changes = new Map(rows('FileChangeSet').map(row => [field(row, 'id'), calls.get(field(row, 'tool_call_id')) ?? '']));
  const children = new Map(rows('ChildExecutionParentLink').map(row => [field(row, 'child_execution_id'), field(row, 'parent_turn_id')]));
  return (type, id, row) => {
    switch (type) {
      case 'Message': return messages.get(id) || `message:${id}`;
      case 'Turn': return id;
      case 'ModelRequestMessageLink': return requests.get(field(row, 'model_request_id')) || messages.get(field(row, 'message_id')) || 'unplaced';
      case 'InteractionRequest': return interactions.get(id) || 'unplaced';
      case 'InteractionToolCallLink': return calls.get(field(row, 'tool_call_id')) || interactions.get(field(row, 'request_id')) || 'unplaced';
      case 'FileChangeSetMember': return changes.get(field(row, 'change_set_id')) || 'unplaced';
      case 'ChildExecution': return children.get(id) || 'unplaced';
      case 'ChildExecutionParentLink': return field(row, 'parent_turn_id') || 'unplaced';
      default: return field(row, 'turn_id') || calls.get(field(row, 'tool_call_id')) || 'unplaced';
    }
  };
}

function detailKeysForRecords(records: ReliableClientRecordBuckets, input: ReliableConversationProjectionInput): string[] {
  const keys: string[] = [];
  for (const [id, row] of Object.entries(records.Message ?? {})) {
    const window = input.messageContentWindows?.[id];
    if (row.item_index_revision_id && input.messageContentWindows !== undefined) {
      if (window) keys.push(reliableMessageContentItemsKey(window.indexRevisionId, window.currentAfterSequence));
      for (const page of window?.pages ?? []) for (const item of page.items) keys.push(`message-content-item:${item.contentObjectId}`);
    } else if (typeof row.revision_id === 'string') keys.push(`message-content:${row.revision_id}`);
  }
  for (const id of Object.keys(records.ToolCall ?? {})) keys.push(`tool-arguments-content:${id}`, `tool-result-content:${id}`);
  for (const [type, kind] of [['ToolCallEvent', 'tool-event-content'], ['InteractionRequest', 'interaction-prompt'],
    ['FileChangeSetMember', 'file-change-diff']] as const) for (const id of Object.keys(records[type] ?? {})) keys.push(`${kind}:${id}`);
  return keys;
}

function sameItems(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sameShallowRecord(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}

function sameMessage(left: MessageRecord, right: MessageRecord): boolean {
  if (left.content !== right.content && (left.content.role !== right.content.role || !sameItems(left.content.parts, right.content.parts))) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  keys.delete('content');
  return [...keys].every(key => {
    const a = (left as unknown as Record<string, unknown>)[key], b = (right as unknown as Record<string, unknown>)[key];
    return a === b || sameShallowRecord(a, b);
  });
}

function reuseUnchangedProjectionObjects(previous: ReliableConversationProjection, next: ReliableConversationProjection): void {
  next.messages = next.messages.map(message => {
    const prior = previous.index.messageById.get(message.id);
    return prior && sameMessage(prior, message) ? prior : message;
  });
  next.toolCalls = next.toolCalls.map(call => {
    const prior = previous.index.toolCallById.get(call.id);
    if (!prior) return call;
    const keys = new Set([...Object.keys(prior), ...Object.keys(call)]);
    return [...keys].every(key => {
      const a = (prior as unknown as Record<string, unknown>)[key], b = (call as unknown as Record<string, unknown>)[key];
      return a === b || sameShallowRecord(a, b) || Array.isArray(a) && Array.isArray(b) && sameItems(a, b);
    }) ? prior : call;
  });
  if (sameItems(previous.toolCalls, next.toolCalls)) next.toolCalls = previous.toolCalls;
  const callsByMessage: Record<string, ToolCallRecord[]> = {};
  for (const call of next.toolCalls) (callsByMessage[call.messageId] ??= []).push(call);
  for (const [id, calls] of Object.entries(callsByMessage)) if (sameItems(calls, previous.toolCallsByMessageId[id] ?? [])) {
    callsByMessage[id] = previous.toolCallsByMessageId[id]!;
  }
  next.toolCallsByMessageId = callsByMessage;
  next.index = next.toolCalls === previous.toolCalls ? withReliablePresentationMessages(previous.index, next.messages)
    : createReliablePresentationIndex(next.messages, next.toolCalls, next.turnIdByMessageId);
}

function sameProjectionLayout(left: ReliableConversationProjection, right: ReliableConversationProjection): boolean {
  return left.messages.length === right.messages.length
    && left.messages.every((message, index) => {
      const next = right.messages[index]!;
      return message.id === next.id && message.seq === next.seq && message.createdAt === next.createdAt && message.role === next.role;
    })
    && sameItems(left.toolCalls, right.toolCalls) && sameItems(left.toolCallEvents, right.toolCallEvents)
    && projectionArrays.every(key => sameItems(left[key], right[key]))
    && projectionDictionaries.every(key => sameShallowRecord(left[key], right[key]));
}
