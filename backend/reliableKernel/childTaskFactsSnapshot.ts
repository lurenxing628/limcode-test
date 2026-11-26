import type Database from 'better-sqlite3';
import type { SnapshotBarrier } from './contracts';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryRead } from './repositories';
import { requireRuntimeId } from './runtimeSqlRows';
import { prepareCached } from './runtimeStatementCache';
import { parseInputTurnIntentEnvelope, parseRuntimeContinuationTurnIntentEnvelope, TURN_INTENT_ENVELOPE_CONTENT_TYPE } from './guidanceIntent';
import { CHILD_RUNTIME_DELIVERY_CONTINUATION_CONTENT_TYPE } from './runtimeDeliveryContinuationIdentity';
import { readChildExecutionSnapshot, type ChildExecutionSnapshot } from './childExecutionFactsSnapshot';
import { requireChildExecutionStatus, type ChildExecutionStatus } from './childExecutionState';
import { CHILD_INTENT_ANSWER_WAIT_OWNER_KIND, CHILD_TURN_ANSWER_WAIT_OWNER_KIND, LEGACY_ANSWER_BRIDGE_WAIT_OWNER_KIND } from './childSendLineage';

export interface ChildTaskCurrentState {
  childExecutionId: string;
  answerBridgeId: string;
  depth: number;
  status: ChildExecutionStatus;
  queuedInputCount: number;
  awaitingHandling: boolean;
  hasPendingQuestion?: boolean;
  createdAt: string;
}

export type ConversationChildTaskSnapshotOptions =
  | { kind: 'current'; childExecutionIds?: string[] }
  | { kind: 'runtime'; limit: number }
  | { kind: 'history'; childExecutionId: string; after?: ChildTaskSourceCursor; upper?: ChildTaskSourceCursor; limit: number };

export interface ChildTaskSourceCursor {
  createdAt: string;
  sequence: string;
  id: string;
}

/** Read-only domain facts. This projection owns no task, relationship, or status authority. */
export interface ConversationChildTaskFacts {
  conversationId: string;
  conversation: DomainRow;
  taskStates?: ChildTaskCurrentState[];
  selectedChildIds?: string[];
  history?: { total: number; remaining: number; upper?: ChildTaskSourceCursor; sourceKeys: ChildTaskSourceCursor[] };
  parentTurns: DomainRow[];
  childExecutions: DomainRow[];
  parentLinks: DomainRow[];
  conversations: DomainRow[];
  turns: DomainRow[];
  turnLinks: DomainRow[];
  activeTurnLinks: DomainRow[];
  intentLinks: DomainRow[];
  turnIntents: DomainRow[];
  turnIntentRevisions: DomainRow[];
  pendingInputs: DomainRow[];
  messages: DomainRow[];
  messageTurnLinks: DomainRow[];
  messageMemberships: DomainRow[];
  messageRevisions: DomainRow[];
  currentRevisionLinks: DomainRow[];
  contextSegmentSources: DomainRow[];
  terminations: DomainRow[];
  executionLeases: DomainRow[];
  executorLinks: DomainRow[];
  agentLinks: DomainRow[];
  sourceToolCalls: DomainRow[];
  answerToolCalls: DomainRow[];
  answerWaitOperations: DomainRow[];
  toolOutcomes: DomainRow[];
  toolResultArtifacts: DomainRow[];
  toolModelResults: DomainRow[];
  toolResultMessageRevisions: DomainRow[];
  answerBridges: DomainRow[];
  answerSubmissions: DomainRow[];
  answerPayloads: DomainRow[];
  inboxItems: DomainRow[];
  inboxPayloadLinks: DomainRow[];
  deliveries: DomainRow[];
  deliveryWakes: DomainRow[];
  deliveryInputLinks: DomainRow[];
  deliveryIntentLinks: DomainRow[];
  pendingAskUserRequests: DomainRow[];
  pendingAskUserOwnerLinks: DomainRow[];
  pendingAskUserToolCallLinks: DomainRow[];
  contentObjects: DomainRow[];
}

type FactsRows = Omit<ConversationChildTaskFacts, 'conversationId' | 'conversation' | 'taskStates' | 'selectedChildIds' | 'history'>;
type FactsRowsKey = keyof FactsRows;
type ReadRepository = (database: Database.Database, read: RepositoryRead) => DomainRow | DomainRow[] | null;
type ReadVerifiedEnvelope = (metadata: DomainRow) => Buffer;
const INTENT_ENVELOPE_MAX_BYTES = 64 * 1024;

/** All dependent reads, including relationship traversal, run before COMMIT. CAS is read later. */
export function executeConversationChildTaskSnapshot(
  database: Database.Database,
  conversationIdInput: string,
  localCommitSeq: bigint,
  read: ReadRepository,
  readVerifiedEnvelope: ReadVerifiedEnvelope,
  options: ConversationChildTaskSnapshotOptions = { kind: 'current' }
): SnapshotBarrier<ConversationChildTaskFacts> {
  const conversationId = requireRuntimeId(conversationIdInput);
  database.exec('BEGIN');
  try {
    const facts = collectConversationChildTaskFacts(database, conversationId, read, readVerifiedEnvelope, options);
    database.exec('COMMIT');
    // Existing barrier sequencing is Host-local diagnostics, not a cross-Host change token.
    return { snapshotCommitSeq: localCommitSeq.toString(), snapshot: facts };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function collectConversationChildTaskFacts(
  database: Database.Database,
  conversationId: string,
  read: ReadRepository,
  readVerifiedEnvelope: ReadVerifiedEnvelope,
  options: ConversationChildTaskSnapshotOptions
): ConversationChildTaskFacts {
  const rows: FactsRows = {
    parentTurns: [], childExecutions: [], parentLinks: [], conversations: [], turns: [], turnLinks: [],
    activeTurnLinks: [], intentLinks: [], turnIntents: [], turnIntentRevisions: [], pendingInputs: [],
    messages: [], messageTurnLinks: [], messageMemberships: [], messageRevisions: [], currentRevisionLinks: [], contextSegmentSources: [],
    terminations: [], executionLeases: [], executorLinks: [], agentLinks: [], sourceToolCalls: [],
    answerToolCalls: [], answerWaitOperations: [], toolOutcomes: [], toolResultArtifacts: [], toolModelResults: [], toolResultMessageRevisions: [],
    answerBridges: [], answerSubmissions: [], answerPayloads: [], inboxItems: [], inboxPayloadLinks: [],
    deliveries: [], deliveryWakes: [], deliveryInputLinks: [], deliveryIntentLinks: [],
    pendingAskUserRequests: [], pendingAskUserOwnerLinks: [], pendingAskUserToolCallLinks: [], contentObjects: []
  };
  const seen = new Map<FactsRowsKey, Set<string>>();
  const add = (key: FactsRowsKey, values: DomainRow[]) => {
    const ids = seen.get(key) ?? new Set<string>();
    seen.set(key, ids);
    for (const row of values) {
      const id = requireRuntimeId(row.id);
      if (ids.has(id)) continue;
      ids.add(id);
      rows[key].push(row);
    }
  };
  const get = (domain: string, id: unknown): DomainRow => {
    const row = read(database, DOMAIN_REPOSITORIES.domain(domain).get(requireRuntimeId(id)));
    if (!row || Array.isArray(row)) throw new Error(`Child task snapshot requires ${domain} ${String(id)}.`);
    return row;
  };
  const optionalGet = (domain: string, id: unknown): DomainRow | null => {
    const row = read(database, DOMAIN_REPOSITORIES.domain(domain).get(requireRuntimeId(id)));
    if (Array.isArray(row)) throw new Error(`Child task snapshot ${domain} get returned an array.`);
    return row;
  };
  const list = (domain: string, where: DomainRow): DomainRow[] => {
    const result: DomainRow[] = [];
    let afterId: string | undefined;
    for (;;) {
      const page = read(database, DOMAIN_REPOSITORIES.domain(domain).list({
        where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000,
        ...(afterId ? { afterId } : {})
      }));
      if (!Array.isArray(page)) throw new Error(`Child task snapshot ${domain} list returned no array.`);
      result.push(...page);
      if (page.length < 1000) return result;
      const next = requireRuntimeId(page[page.length - 1].id);
      if (next === afterId) throw new Error(`Child task snapshot ${domain} pagination did not advance.`);
      afterId = next;
    }
  };
  const one = (domain: string, where: DomainRow, required = false): DomainRow | undefined => {
    const matches = list(domain, where);
    if (matches.length > 1 || (required && matches.length !== 1)) {
      throw new Error(`Child task snapshot requires ${required ? 'one' : 'at most one'} ${domain} relation.`);
    }
    return matches[0];
  };
  const query = (domain: string, sql: string, ...args: (string | number)[]): DomainRow[] =>
    prepareCached(database, sql).all(...args).map(row => DOMAIN_REPOSITORIES.domain(domain).codec.decode(row as DomainRow));
  const latest = (domain: string, where: DomainRow, column: string): DomainRow | undefined => {
    const values = read(database, DOMAIN_REPOSITORIES.domain(domain).list({ where,
      orderBy: { column, direction: 'desc' }, limit: 1 }));
    if (!Array.isArray(values)) throw new Error(`Child task snapshot ${domain} list returned no array.`);
    return values[0];
  };
  const structuralEnvelopes = new Map<string, Record<string, unknown>>();
  const envelope = (metadata: DomainRow): Record<string, unknown> => {
    const id = requireRuntimeId(metadata.id);
    const cached = structuralEnvelopes.get(id);
    if (cached) return cached;
    const length = BigInt(String(metadata.byte_length));
    if (length < 0n || length > BigInt(INTENT_ENVELOPE_MAX_BYTES)) throw new Error('Child task snapshot TurnIntent envelope exceeds the structural byte limit.');
    const value: unknown = JSON.parse(readVerifiedEnvelope(metadata).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Child task structural envelope must be an object.');
    structuralEnvelopes.set(id, value as Record<string, unknown>);
    return value as Record<string, unknown>;
  };
  const intentRevision = (intent: DomainRow): DomainRow => {
    const revision = latest('TurnIntentRevision', { intent_id: intent.id }, 'revision_seq');
    if (!revision) throw new Error(`TurnIntent ${String(intent.id)} has no revision.`);
    return revision;
  };
  const intentSource = (revision: DomainRow): { task: boolean; sourceTurnId?: string } => {
    const metadata = get('ContentObject', revision.content_object_id);
    if (![TURN_INTENT_ENVELOPE_CONTENT_TYPE, CHILD_RUNTIME_DELIVERY_CONTINUATION_CONTENT_TYPE].includes(String(metadata.content_type))) return { task: true };
    const value = envelope(metadata);
    if (parseInputTurnIntentEnvelope(value) || value.kind === 'continuation') return { task: true };
    const continuation = parseRuntimeContinuationTurnIntentEnvelope(value);
    if (continuation || value.kind === 'retry') return { task: false,
      ...(typeof (continuation?.sourceTurnId ?? value.sourceTurnId) === 'string'
        ? { sourceTurnId: String(continuation?.sourceTurnId ?? value.sourceTurnId) } : {}) };
    throw new Error('Child task snapshot TurnIntent envelope kind is unsupported.');
  };
  const conversation = get('Conversation', conversationId);
  const scopeLineage = one('ChildExecution', { child_conversation_id: conversationId });
  // The selected Conversation is the outer indexed relation, including when it has no children.
  const linksInConversation = (parentConversationId: string): DomainRow[] => query('ChildExecutionParentLink', `
    SELECT link.* FROM turn AS parent CROSS JOIN child_execution_parent_link AS link
      ON link.parent_turn_id = parent.id WHERE parent.conversation_id = ? ORDER BY link.id
  `, parentConversationId);
  const queue = linksInConversation(conversationId).map(link => ({ link, depth: 1 }));
  const processed = new Set<string>();
  const lineageConversations = new Map<string, string>();
  const conversationIds = new Set([conversationId]);
  const executions = new Map<string, ChildExecutionSnapshot>();
  let history: ConversationChildTaskFacts['history'];
  const queuedIntents = new Map<string, DomainRow[]>();
  const queuedNativeInputs = new Map<string, DomainRow[]>();
  const waitingDeliveries = new Map<string, DomainRow[]>();
  const taskStates: ChildTaskCurrentState[] = [];
  const requestedChildren = options.kind === 'current' && options.childExecutionIds
    ? new Set(options.childExecutionIds) : null;
  if (scopeLineage) lineageConversations.set(requireRuntimeId(scopeLineage.id), conversationId);
  for (const { link, depth } of queue) {
    const childId = requireRuntimeId(link.child_execution_id);
    if (processed.has(childId)) throw new Error('Child task snapshot found a repeated or cyclic child lineage.');
    processed.add(childId);
    const child = get('ChildExecution', childId);
    const parentTurn = get('Turn', link.parent_turn_id);
    const parentConversationId = requireRuntimeId(parentTurn.conversation_id);
    const parentChildId = link.parent_child_execution_id === null ? null : requireRuntimeId(link.parent_child_execution_id);
    if (parentConversationId === conversationId) {
      if (parentChildId !== (scopeLineage?.id ?? null)) throw new Error('Child task snapshot direct parent relation crosses conversation scope.');
    } else if (!parentChildId || lineageConversations.get(parentChildId) !== parentConversationId) {
      throw new Error('Child task snapshot descendant parent relation crosses conversation scope.');
    }
    const childConversationId = requireRuntimeId(child.child_conversation_id);
    if (conversationIds.has(childConversationId)) throw new Error('Child task snapshot found a conversation cycle.');
    conversationIds.add(childConversationId);
    lineageConversations.set(childId, childConversationId);
    add('parentTurns', [parentTurn]);
    add('childExecutions', [child]);
    add('parentLinks', [link]);
    add('conversations', [get('Conversation', childConversationId)]);
    const bridge = one('AnswerBridge', { child_execution_id: childId }, true)!;
    add('answerBridges', [bridge]);
    let queuedInputCount = 0;
    let awaitingHandling = false;
    let hasPendingQuestion = false;
    const needsCurrentWork = options.kind === 'runtime' ? depth === 1
      : options.kind === 'history' ? childId === options.childExecutionId
        : requestedChildren === null || requestedChildren.has(childId);
    if (needsCurrentWork) {
      const intents = list('TurnIntent', { conversation_id: childConversationId, state: 'queued', turn_id: null });
      queuedIntents.set(childId, intents);
      for (const intent of intents) if (intentSource(intentRevision(intent)).task) queuedInputCount += 1;
      // Continuing publishes Context atomically; completed/rejected receipts are historical.
      const nativeInputs = query('PendingTurnInput', `SELECT input.* FROM turn AS target
        JOIN pending_turn_input AS input ON input.turn_id = target.id
        WHERE target.conversation_id = ? AND input.input_kind = 'native_steer'
          AND input.state IN ('queued', 'sent', 'accepted', 'waiting_for_input')`, childConversationId);
      const queuedNative: DomainRow[] = [];
      for (const input of nativeInputs) {
        const value = envelope(get('ContentObject', input.content_object_id));
        const revisionId = requireRuntimeId(value.messageRevisionId);
        const messageId = requireRuntimeId(value.messageId);
        const message = get('Message', messageId);
        const current = one('MessageCurrentRevisionLink', { message_id: messageId }, true)!;
        if (message.deleted_at === null && current.revision_id === revisionId
          && !one('ContextSegmentSource', { source_kind: 'message_revision', source_id: revisionId })) {
          queuedNative.push(input);
        }
      }
      queuedNativeInputs.set(childId, queuedNative);
      queuedInputCount += queuedNative.length;
      const pending = query('RuntimeDelivery', `SELECT delivery.* FROM answer_submission AS submission
        JOIN runtime_inbox_item AS item ON item.source_kind = 'answer_submission' AND item.source_id = submission.id
        JOIN runtime_delivery AS delivery ON delivery.inbox_item_id = item.id
        LEFT JOIN runtime_delivery_input_link AS input ON input.delivery_id = delivery.id
        LEFT JOIN runtime_delivery_wake AS wake ON wake.delivery_id = delivery.id
        WHERE submission.answer_bridge_id = ? AND delivery.target_conversation_id = ?
          AND delivery.state != 'failed' AND delivery.phase != 'notify_only'
          AND input.handled_at IS NULL AND (wake.state IS NULL OR wake.state != 'dead_letter')`, requireRuntimeId(bridge.id), conversationId);
      waitingDeliveries.set(childId, pending);
      awaitingHandling = pending.length > 0;
      const activeTurnLink = one('ChildExecutionActiveTurnLink', { child_execution_id: childId });
      if (activeTurnLink) {
        const pendingQuestionRow = prepareCached(database, `
          SELECT req.id FROM interaction_owner_link AS owner
            JOIN interaction_request AS req ON req.id = owner.request_id
            WHERE owner.turn_id = ? AND req.request_kind = 'ask_user' AND req.status = 'pending'
            LIMIT 1
        `).get(requireRuntimeId(activeTurnLink.turn_id)) as { id?: unknown } | undefined;
        hasPendingQuestion = pendingQuestionRow !== undefined;
      }
    }
    taskStates.push({ childExecutionId: childId, answerBridgeId: requireRuntimeId(bridge.id), depth,
      status: requireChildExecutionStatus(child.status), queuedInputCount, awaitingHandling,
      ...(hasPendingQuestion ? { hasPendingQuestion } : {}), createdAt: String(child.created_at) });
    const descendants = new Map<string, DomainRow>();
    for (const descendant of list('ChildExecutionParentLink', { parent_child_execution_id: childId })) descendants.set(requireRuntimeId(descendant.id), descendant);
    for (const descendant of linksInConversation(childConversationId)) descendants.set(requireRuntimeId(descendant.id), descendant);
    for (const descendant of descendants.values()) queue.push({ link: descendant, depth: depth + 1 });
  }
  if (options.kind === 'runtime' && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)) throw new Error('child_task_runtime_limit_invalid');
  const selectedChildIds = options.kind === 'runtime'
    ? taskStates.filter(state => state.depth === 1).sort(compareChildTaskCurrentPriority).slice(0, options.limit).map(state => state.childExecutionId)
    : options.kind === 'history' ? [options.childExecutionId]
      : options.childExecutionIds ?? taskStates.map(state => state.childExecutionId);
  const selected = new Set(selectedChildIds);
  for (const childId of selected) {
    if (!processed.has(childId)) throw new Error(`child_task_out_of_scope: ${childId}`);
    const execution = readChildExecutionSnapshot(database, childId);
    executions.set(childId, execution);
    add('turnLinks', execution.turnLinks);
    if (execution.activeTurnLink) {
      add('activeTurnLinks', [execution.activeTurnLink]);
      const activeTurnId = requireRuntimeId(execution.activeTurnLink.turn_id);
      const pendingQuestions = query('InteractionRequest', `
        SELECT req.* FROM interaction_owner_link AS owner
          JOIN interaction_request AS req ON req.id = owner.request_id
          WHERE owner.turn_id = ? AND req.request_kind = 'ask_user' AND req.status = 'pending'
          ORDER BY req.created_at, req.id
      `, activeTurnId);
      add('pendingAskUserRequests', pendingQuestions);
      for (const req of pendingQuestions) {
        const ownerLink = one('InteractionOwnerLink', { request_id: req.id }, true)!;
        const toolCallLink = one('InteractionToolCallLink', { request_id: req.id }, true)!;
        add('pendingAskUserOwnerLinks', [ownerLink]);
        add('pendingAskUserToolCallLinks', [toolCallLink]);
      }
    }
    const childConversationId = requireRuntimeId(execution.childExecution.child_conversation_id);
    const source = get('ToolCall', execution.parentLink.source_tool_call_id);
    if (source.turn_id !== execution.parentLink.parent_turn_id) throw new Error('Child task snapshot source ToolCall crosses Turn scope.');
    add('sourceToolCalls', [source]);
    add('agentLinks', list('AgentConversationLink', { conversation_id: childConversationId }));
    const loadedTurns = new Set<string>();
    const loadTurn = (turnIdInput: unknown): void => {
      const turnId = requireRuntimeId(turnIdInput);
      if (loadedTurns.has(turnId)) return;
      loadedTurns.add(turnId);
      const turn = get('Turn', turnId);
      if (turn.conversation_id !== childConversationId) throw new Error('Child task snapshot input source crosses Conversation scope.');
      const membership = one('ChildExecutionTurnLink', { turn_id: turnId });
      if (membership && membership.child_execution_id !== childId) throw new Error('Child task snapshot input source crosses lineage.');
      add('turns', [turn]);
      if (membership) add('turnLinks', [membership]);
      add('pendingInputs', list('PendingTurnInput', { turn_id: turnId }));
      for (const role of ['input', 'native_steer']) add('messageTurnLinks', list('MessageTurnLink', { turn_id: turnId, role }));
      add('terminations', list('TurnTermination', { turn_id: turnId }));
      add('executionLeases', list('ExecutionLease', { turn_id: turnId }));
      add('executorLinks', list('TurnExecutorLink', { turn_id: turnId }));
      for (const intent of list('TurnIntent', { turn_id: turnId })) {
        if (intent.conversation_id !== childConversationId) throw new Error('Child task snapshot TurnIntent crosses Conversation scope.');
        const revision = intentRevision(intent);
        add('turnIntents', [intent]);
        add('turnIntentRevisions', [revision]);
        const relation = one('ChildExecutionIntentLink', { turn_intent_id: intent.id });
        if (relation) add('intentLinks', [relation]);
        const source = intentSource(revision);
        if (source.sourceTurnId) loadTurn(source.sourceTurnId);
      }
    };
    for (const turnLink of execution.turnLinks) loadTurn(turnLink.turn_id);
    for (const input of queuedNativeInputs.get(childId) ?? []) loadTurn(input.turn_id);
    for (const intent of queuedIntents.get(childId) ?? []) {
      add('turnIntents', [intent]);
      add('turnIntentRevisions', [intentRevision(intent)]);
      const relation = one('ChildExecutionIntentLink', { turn_intent_id: intent.id });
      if (relation) add('intentLinks', [relation]);
      if (intent.turn_id !== null) loadTurn(intent.turn_id);
    }
    const submissions = new Map<string, DomainRow>();
    if (execution.currentSubmission) submissions.set(requireRuntimeId(execution.currentSubmission.id), execution.currentSubmission);
    for (const delivery of waitingDeliveries.get(childId) ?? []) {
      const item = get('RuntimeInboxItem', delivery.inbox_item_id);
      const submission = get('AnswerSubmission', item.source_id);
      submissions.set(requireRuntimeId(submission.id), submission);
      add('deliveries', [delivery]);
      add('inboxItems', [item]);
    }
    for (const submission of submissions.values()) {
      const member = one('ChildExecutionTurnLink', { turn_id: submission.turn_id }, true)!;
      if (member.child_execution_id !== childId) throw new Error('Child task snapshot AnswerSubmission crosses child lineage.');
      add('turnLinks', [member]);
      add('turns', [get('Turn', submission.turn_id)]);
      add('answerSubmissions', [submission]);
      add('answerPayloads', [one('AnswerPayload', { submission_id: submission.id }, true)!]);
      add('inboxItems', list('RuntimeInboxItem', { source_kind: 'answer_submission', source_id: submission.id }));
    }
  }
  if (options.kind === 'history') {
    const execution = executions.get(options.childExecutionId)!;
    const page = selectChildTaskHistorySources(database, requireRuntimeId(execution.childExecution.child_conversation_id),
      requireRuntimeId(execution.answerBridge.id), options);
    history = { total: page.total, remaining: page.remaining, upper: page.upper, sourceKeys: page.sources.map(source => source.key) };
    for (const source of page.sources) {
      if (source.turnId) {
        const turn = get('Turn', source.turnId);
        if (turn.conversation_id !== execution.childExecution.child_conversation_id) throw new Error('Child task history source crosses Conversation.');
        add('turns', [turn]);
        const membership = one('ChildExecutionTurnLink', { turn_id: source.turnId });
        if (membership) add('turnLinks', [membership]);
      }
      if (source.kind === 'message_revision') {
        const revision = get('MessageRevision', source.sourceId);
        add('messageRevisions', [revision]);
        add('messageTurnLinks', list('MessageTurnLink', { message_id: revision.message_id, turn_id: source.turnId, role: 'input' }));
      } else if (source.kind === 'turn_intent_revision') {
        const revision = get('TurnIntentRevision', source.sourceId);
        const intent = get('TurnIntent', revision.intent_id);
        add('turnIntents', [intent]);
        add('turnIntentRevisions', [revision, intentRevision(intent)]);
      } else if (source.kind === 'pending_turn_input') {
        const input = get('PendingTurnInput', source.sourceId);
        add('pendingInputs', [input]);
        if (input.input_kind === 'native_steer') {
          const value = envelope(get('ContentObject', input.content_object_id));
          add('messageTurnLinks', list('MessageTurnLink', { message_id: value.messageId, turn_id: input.turn_id, role: 'native_steer' }));
        }
      } else {
        const submission = get('AnswerSubmission', source.sourceId);
        add('answerSubmissions', [submission]);
        add('answerPayloads', [one('AnswerPayload', { submission_id: submission.id }, true)!]);
        add('inboxItems', list('RuntimeInboxItem', { source_kind: 'answer_submission', source_id: submission.id }));
      }
    }
  }
  for (const link of rows.messageTurnLinks) {
    const message = get('Message', link.message_id);
    const membership = one('MessagePartOfConversation', { message_id: message.id }, true)!;
    if (membership.conversation_id !== get('Turn', link.turn_id).conversation_id) {
      throw new Error('Child task snapshot MessageTurnLink crosses conversation scope.');
    }
    add('messages', [message]);
    add('messageMemberships', [membership]);
    const current = one('MessageCurrentRevisionLink', { message_id: message.id }, true)!;
    if (get('MessageRevision', current.revision_id).message_id !== message.id) {
      throw new Error('Child task snapshot current MessageRevision belongs to another message.');
    }
    add('currentRevisionLinks', [current]);
    add('messageRevisions', [get('MessageRevision', current.revision_id)]);
    const childId = one('ChildExecutionTurnLink', { turn_id: link.turn_id })?.child_execution_id;
    if (executions.get(String(childId))?.firstTurnLink?.turn_id === link.turn_id) {
      const first = read(database, DOMAIN_REPOSITORIES.domain('MessageRevision').list({ where: { message_id: message.id },
        orderBy: { column: 'revision_seq', direction: 'asc' }, limit: 1 }));
      if (Array.isArray(first)) add('messageRevisions', first);
    }
  }
  for (const input of rows.pendingInputs) {
    if (input.input_kind !== 'native_steer') continue;
    const value = envelope(get('ContentObject', input.content_object_id));
    const revision = get('MessageRevision', value.messageRevisionId);
    if (revision.message_id !== value.messageId) throw new Error('Child task snapshot native steering revision mismatch.');
    add('messageRevisions', [revision]);
  }
  // Both input and intent delivery edges identify Runtime-generated continuation content.
  for (const pending of rows.pendingInputs) {
    const link = one('RuntimeDeliveryInputLink', { pending_turn_input_id: pending.id });
    if (link) add('deliveries', [get('RuntimeDelivery', link.delivery_id)]);
  }
  for (const intent of rows.turnIntents) {
    const link = one('RuntimeDeliveryIntentLink', { turn_intent_id: intent.id });
    if (link) add('deliveries', [get('RuntimeDelivery', link.delivery_id)]);
  }
  for (const item of rows.inboxItems) add('deliveries', list('RuntimeDelivery', { inbox_item_id: item.id }));
  for (const delivery of rows.deliveries) {
    add('inboxItems', [get('RuntimeInboxItem', delivery.inbox_item_id)]);
    const wake = one('RuntimeDeliveryWake', { delivery_id: delivery.id });
    if (wake) add('deliveryWakes', [wake]);
    const inputLink = one('RuntimeDeliveryInputLink', { delivery_id: delivery.id });
    if (inputLink) {
      const pending = optionalGet('PendingTurnInput', inputLink.pending_turn_input_id);
      if (!pending && inputLink.handled_at === null) {
        throw new Error('Child task snapshot unhandled RuntimeDelivery has no PendingTurnInput.');
      }
      if (pending && (pending.turn_id !== delivery.target_turn_id || pending.input_kind !== 'runtime_delivery')) {
        throw new Error('Child task snapshot RuntimeDeliveryInputLink crosses input scope.');
      }
      add('deliveryInputLinks', [inputLink]);
    }
    const intentLink = one('RuntimeDeliveryIntentLink', { delivery_id: delivery.id });
    if (intentLink) {
      const intent = get('TurnIntent', intentLink.turn_intent_id);
      if (intent.conversation_id !== delivery.target_conversation_id) {
        throw new Error('Child task snapshot RuntimeDeliveryIntentLink crosses conversation scope.');
      }
      add('deliveryIntentLinks', [intentLink]);
    }
    if (delivery.target_turn_id !== null
      && get('Turn', delivery.target_turn_id).conversation_id !== delivery.target_conversation_id) {
      throw new Error('Child task snapshot RuntimeDelivery target crosses conversation scope.');
    }
  }
  for (const item of rows.inboxItems) add('inboxPayloadLinks', list('RuntimeInboxPayloadLink', { inbox_item_id: item.id }));
  // Foreground answers can settle a later wait/send ToolCall without creating a RuntimeDelivery.
  // Preserve committed tool-result facts so consumers do not confuse no delivery with no result.
  add('answerToolCalls', rows.sourceToolCalls);
  const answerIntents = new Map(rows.turnIntents.map(intent => [requireRuntimeId(intent.id), intent]));
  const loadedIntentTurnIds = new Set(rows.turnIntents.filter(intent => intent.turn_id !== null)
    .map(intent => requireRuntimeId(intent.turn_id)));
  for (const turn of rows.turns) {
    add('answerWaitOperations', list('Operation', { owner_kind: CHILD_TURN_ANSWER_WAIT_OWNER_KIND, owner_id: turn.id }));
    if (!loadedIntentTurnIds.has(requireRuntimeId(turn.id))) {
      // A historical answer may reference a Turn outside the already loaded input sources.
      for (const intent of list('TurnIntent', { turn_id: turn.id })) answerIntents.set(requireRuntimeId(intent.id), intent);
    }
  }
  for (const intent of answerIntents.values()) {
    add('answerWaitOperations', list('Operation', { owner_kind: CHILD_INTENT_ANSWER_WAIT_OWNER_KIND, owner_id: intent.id }));
  }
  for (const bridge of rows.answerBridges.filter(bridge => selected.has(String(bridge.child_execution_id)))) {
    add('answerWaitOperations', list('Operation', { owner_kind: LEGACY_ANSWER_BRIDGE_WAIT_OWNER_KIND, owner_id: bridge.id }));
  }
  const scopedConversationIds = new Set([conversationId, ...lineageConversations.values()]);
  for (const operation of rows.answerWaitOperations) {
    if (operation.tool_call_id === null) throw new Error('Child task snapshot answer wait has no ToolCall.');
    const call = get('ToolCall', operation.tool_call_id);
    // A later parent Turn may wait/send to an older child. Validate that requested Turn on
    // demand rather than collecting every parent Turn merely to prove membership in a Set.
    const callTurn = get('Turn', call.turn_id);
    if (!scopedConversationIds.has(requireRuntimeId(callTurn.conversation_id))) {
      throw new Error('Child task snapshot answer wait ToolCall crosses scope.');
    }
    if (callTurn.conversation_id === conversationId) add('parentTurns', [callTurn]);
    add('answerToolCalls', [call]);
  }
  for (const toolCall of rows.answerToolCalls) {
    const outcome = one('ToolOutcome', { tool_call_id: toolCall.id });
    if (outcome) add('toolOutcomes', [outcome]);
    const artifact = one('ToolResultArtifact', { tool_call_id: toolCall.id, role: 'no_effect_result' });
    if (artifact) add('toolResultArtifacts', [artifact]);
    const modelResult = one('ToolModelResult', { tool_call_id: toolCall.id });
    if (modelResult) {
      const revision = get('MessageRevision', modelResult.message_revision_id);
      const membership = one('MessagePartOfConversation', { message_id: revision.message_id }, true)!;
      if (membership.conversation_id !== get('Turn', toolCall.turn_id).conversation_id) {
        throw new Error('Child task snapshot ToolModelResult crosses conversation scope.');
      }
      add('toolModelResults', [modelResult]);
      add('toolResultMessageRevisions', [revision]);
      add('contextSegmentSources', list('ContextSegmentSource', { source_kind: 'tool_model_result', source_id: modelResult.id }));
    }
  }
  for (const revision of rows.messageRevisions) {
    add('contextSegmentSources', list('ContextSegmentSource', { source_kind: 'message_revision', source_id: revision.id }));
  }
  for (const key of Object.keys(rows) as FactsRowsKey[]) {
    if (key === 'contentObjects') continue;
    for (const row of rows[key]) {
      for (const column of ['content_object_id', 'arguments_object_id', 'prompt_object_id']) {
        if (row[column] !== null && row[column] !== undefined) add('contentObjects', [get('ContentObject', row[column])]);
      }
    }
  }
  // The envelope's immutable ContentObject reference is stored in CAS rather than a SQL Link.
  // Read only this bounded, verified structure in the transaction to close metadata dependencies;
  // task bodies and result bodies remain CAS reads outside the transaction.
  for (const revision of rows.turnIntentRevisions) {
    const metadata = get('ContentObject', revision.content_object_id);
    if (metadata.content_type !== TURN_INTENT_ENVELOPE_CONTENT_TYPE) continue;
    const value = envelope(metadata);
    const input = parseInputTurnIntentEnvelope(value);
    if (input) add('contentObjects', [get('ContentObject', input.messageContentObjectId)]);
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const envelope = value as Record<string, unknown>;
      if (envelope.kind === 'continuation') {
        add('contentObjects', [get('ContentObject', envelope.messageContentObjectId)]);
      } else if (envelope.kind !== 'retry' && envelope.kind !== 'runtime_continuation') {
        throw new Error('Child task snapshot TurnIntent envelope kind is unsupported.');
      }
    } else throw new Error('Child task snapshot TurnIntent envelope must be an object.');
  }
  for (const key of Object.keys(rows) as FactsRowsKey[]) rows[key].sort((a, b) =>
    String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0
  );
  return { conversationId, conversation, taskStates, selectedChildIds, ...(history ? { history } : {}), ...rows };
}

/** Shared state order for selecting runtime cards before any preview body is read. */
export function compareChildTaskCurrentPriority(a: ChildTaskCurrentState, b: ChildTaskCurrentState): number {
  const live = (status: ChildExecutionStatus) => ['starting', 'active', 'interrupting'].includes(status);
  return Number(live(b.status)) - Number(live(a.status))
    || Number(Boolean(b.hasPendingQuestion)) - Number(Boolean(a.hasPendingQuestion))
    || Number(b.queuedInputCount > 0) - Number(a.queuedInputCount > 0)
    || Number(b.awaitingHandling) - Number(a.awaitingHandling)
    || Number(a.status === 'closed') - Number(b.status === 'closed')
    || b.createdAt.localeCompare(a.createdAt) || a.childExecutionId.localeCompare(b.childExecutionId);
}

interface ChildTaskHistorySource {
  kind: 'message_revision' | 'turn_intent_revision' | 'pending_turn_input' | 'answer_submission';
  sourceId: string;
  turnId?: string;
  key: ChildTaskSourceCursor;
}

/** Source metadata pages and counts share the exact ordered source relation. No task body is scanned. */
function selectChildTaskHistorySources(database: Database.Database, conversationId: string, answerBridgeId: string,
  options: Extract<ConversationChildTaskSnapshotOptions, { kind: 'history' }>): {
    sources: ChildTaskHistorySource[]; total: number; remaining: number; upper?: ChildTaskSourceCursor
  } {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error('child_task_limit_invalid');
  const sourcesSql = `WITH sources AS (
    SELECT 'message_revision' AS kind, revision.id AS source_id, link.turn_id AS turn_id,
      'message_revision:' || revision.id || ':turn:' || link.turn_id AS id,
      revision.created_at AS created_at, membership.message_seq AS sequence1, revision.revision_seq AS sequence2
    FROM turn AS target JOIN message_turn_link AS link ON link.turn_id = target.id AND link.role = 'input'
      JOIN message_revision AS revision ON revision.message_id = link.message_id
      JOIN message_part_of_conversation AS membership ON membership.message_id = link.message_id
    WHERE target.conversation_id = ?
    UNION ALL
    SELECT 'turn_intent_revision', revision.id, intent.turn_id, 'turn_intent_revision:' || revision.id,
      revision.created_at, revision.revision_seq, 0
    FROM turn_intent AS intent JOIN turn_intent_revision AS revision ON revision.intent_id = intent.id
    WHERE intent.conversation_id = ? AND NOT (intent.state = 'admitted'
      AND NOT EXISTS (SELECT 1 FROM turn_intent_revision AS later WHERE later.intent_id = intent.id AND later.revision_seq > revision.revision_seq)
      AND EXISTS (SELECT 1 FROM message_turn_link AS message_input WHERE message_input.turn_id = intent.turn_id AND message_input.role = 'input'))
    UNION ALL
    SELECT 'pending_turn_input', input.id, input.turn_id, 'pending_turn_input:' || input.id,
      input.created_at, input.position, 0
    FROM turn AS target JOIN pending_turn_input AS input ON input.turn_id = target.id WHERE target.conversation_id = ?
    UNION ALL
    SELECT 'answer_submission', submission.id, submission.turn_id, 'answer_submission:' || submission.id,
      submission.created_at, submission.submission_seq, 0
    FROM answer_submission AS submission WHERE submission.answer_bridge_id = ?
  )`;
  const base = [conversationId, conversationId, conversationId, answerBridgeId];
  const key = (row: DomainRow): ChildTaskSourceCursor => ({ createdAt: String(row.created_at),
    sequence: `${String(row.sequence1)}:${String(row.sequence2)}`, id: requireRuntimeId(row.id) });
  const parameters = (cursor: ChildTaskSourceCursor): (string | bigint)[] => {
    const parts = cursor.sequence.split(':');
    if (parts.length !== 2 || parts.some(part => !/^\d+$/.test(part))) throw new Error('child_task_cursor_invalid');
    return [requireRuntimeId(cursor.createdAt), BigInt(parts[0]), BigInt(parts[1]), requireRuntimeId(cursor.id)];
  };
  const columns = '(created_at, sequence1, sequence2, id)';
  const last = options.upper ? undefined : prepareCached(database, `${sourcesSql} SELECT * FROM sources
    ORDER BY created_at DESC, sequence1 DESC, sequence2 DESC, id DESC LIMIT 1`).get(...base) as DomainRow | undefined;
  const upper = options.upper ?? (last ? key(last) : undefined);
  if (!upper) return { sources: [], total: 0, remaining: 0 };
  const upperParameters = parameters(upper);
  const upperWhere = `${columns} <= (?, ?, ?, ?)`;
  const where = options.after ? `${upperWhere} AND ${columns} > (?, ?, ?, ?)` : upperWhere;
  const rangeParameters = [...base, ...upperParameters, ...(options.after ? parameters(options.after) : [])];
  const count = (range: string, args: (string | bigint)[]) => Number((prepareCached(database,
    `${sourcesSql} SELECT COUNT(*) AS count FROM sources WHERE ${range}`).get(...args) as { count: bigint }).count);
  const selected = prepareCached(database, `${sourcesSql} SELECT * FROM sources WHERE ${where}
    ORDER BY created_at, sequence1, sequence2, id LIMIT ?`).all(...rangeParameters, options.limit) as DomainRow[];
  const total = count(upperWhere, [...base, ...upperParameters]);
  return { sources: selected.map(row => ({ kind: row.kind as ChildTaskHistorySource['kind'], sourceId: requireRuntimeId(row.source_id),
    ...(row.turn_id === null ? {} : { turnId: requireRuntimeId(row.turn_id) }), key: key(row) })),
    total, remaining: options.after ? count(where, rangeParameters) : total, upper };
}
