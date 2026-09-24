import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SnapshotBarrier } from './contracts';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryRead } from './repositories';
import { requireRuntimeId } from './runtimeSqlRows';
import { parseInputTurnIntentEnvelope, TURN_INTENT_ENVELOPE_CONTENT_TYPE } from './guidanceIntent';

/** Read-only domain facts. This projection owns no task, relationship, or status authority. */
export interface ConversationChildTaskFacts {
  conversationId: string;
  /** Content fingerprint of this complete SQLite read snapshot, valid across Runtime Hosts. */
  snapshotRevision: string;
  conversation: DomainRow;
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
  contentObjects: DomainRow[];
}

type FactsRows = Omit<ConversationChildTaskFacts, 'conversationId' | 'snapshotRevision' | 'conversation'>;
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
  readVerifiedEnvelope: ReadVerifiedEnvelope
): SnapshotBarrier<ConversationChildTaskFacts> {
  const conversationId = requireRuntimeId(conversationIdInput);
  database.exec('BEGIN');
  try {
    const facts = collectConversationChildTaskFacts(database, conversationId, read, readVerifiedEnvelope);
    database.exec('COMMIT');
    // Existing barrier sequencing is Host-local diagnostics; consumers use snapshotRevision.
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
  readVerifiedEnvelope: ReadVerifiedEnvelope
): ConversationChildTaskFacts {
  const rows: FactsRows = {
    parentTurns: [], childExecutions: [], parentLinks: [], conversations: [], turns: [], turnLinks: [],
    activeTurnLinks: [], intentLinks: [], turnIntents: [], turnIntentRevisions: [], pendingInputs: [],
    messages: [], messageTurnLinks: [], messageMemberships: [], messageRevisions: [], currentRevisionLinks: [], contextSegmentSources: [],
    terminations: [], executionLeases: [], executorLinks: [], agentLinks: [], sourceToolCalls: [],
    answerToolCalls: [], answerWaitOperations: [], toolOutcomes: [], toolResultArtifacts: [], toolModelResults: [], toolResultMessageRevisions: [],
    answerBridges: [], answerSubmissions: [], answerPayloads: [], inboxItems: [], inboxPayloadLinks: [],
    deliveries: [], deliveryWakes: [], deliveryInputLinks: [], deliveryIntentLinks: [], contentObjects: []
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
  const conversation = get('Conversation', conversationId);
  add('parentTurns', list('Turn', { conversation_id: conversationId }));
  const scopeLineage = one('ChildExecution', { child_conversation_id: conversationId });
  const parentTurnIds = new Set(rows.parentTurns.map((row) => requireRuntimeId(row.id)));
  const queue: DomainRow[] = [];
  for (const turn of rows.parentTurns) queue.push(...list('ChildExecutionParentLink', { parent_turn_id: turn.id }));
  const processed = new Set<string>();
  const lineageConversations = new Map<string, string>();
  if (scopeLineage) lineageConversations.set(requireRuntimeId(scopeLineage.id), conversationId);
  for (let index = 0; index < queue.length; index += 1) {
    const link = queue[index];
    const childId = requireRuntimeId(link.child_execution_id);
    if (processed.has(childId)) throw new Error('Child task snapshot found a repeated or cyclic child lineage.');
    processed.add(childId);
    const child = get('ChildExecution', childId);
    const ownLink = one('ChildExecutionParentLink', { child_execution_id: childId }, true)!;
    if (ownLink.id !== link.id) throw new Error('Child task snapshot found conflicting parent relations.');
    const parentTurn = get('Turn', link.parent_turn_id);
    const parentConversationId = requireRuntimeId(parentTurn.conversation_id);
    const parentChildId = link.parent_child_execution_id === null ? null : requireRuntimeId(link.parent_child_execution_id);
    const direct = parentTurnIds.has(requireRuntimeId(parentTurn.id));
    if (direct) {
      if (parentConversationId !== conversationId || parentChildId !== (scopeLineage?.id ?? null)) {
        throw new Error('Child task snapshot direct parent relation crosses conversation scope.');
      }
    } else if (!parentChildId || lineageConversations.get(parentChildId) !== parentConversationId) {
      throw new Error('Child task snapshot descendant parent relation crosses conversation scope.');
    }
    const childConversationId = requireRuntimeId(child.child_conversation_id);
    if (childConversationId === conversationId || [...lineageConversations.values()].includes(childConversationId)) {
      throw new Error('Child task snapshot found a conversation cycle.');
    }
    lineageConversations.set(childId, childConversationId);
    add('childExecutions', [child]);
    add('parentLinks', [link]);
    add('conversations', [get('Conversation', childConversationId)]);
    add('turns', list('Turn', { conversation_id: childConversationId }));
    const turnLinks = list('ChildExecutionTurnLink', { child_execution_id: childId });
    for (const turnLink of turnLinks) {
      if (get('Turn', turnLink.turn_id).conversation_id !== childConversationId) {
        throw new Error('Child task snapshot TurnLink crosses conversation scope.');
      }
    }
    add('turnLinks', turnLinks);
    const activeLink = one('ChildExecutionActiveTurnLink', { child_execution_id: childId });
    if (activeLink) {
      if (!turnLinks.some((row) => row.turn_id === activeLink.turn_id)) {
        throw new Error('Child task snapshot ActiveTurnLink is outside its lineage.');
      }
      add('activeTurnLinks', [activeLink]);
    }
    const intents = list('ChildExecutionIntentLink', { child_execution_id: childId });
    for (const intentLink of intents) {
      const intent = get('TurnIntent', intentLink.turn_intent_id);
      if (intent.conversation_id !== childConversationId || (intent.turn_id !== null
        && get('Turn', intent.turn_id).conversation_id !== childConversationId)) {
        throw new Error('Child task snapshot IntentLink crosses conversation scope.');
      }
    }
    add('intentLinks', intents);
    const source = get('ToolCall', link.source_tool_call_id);
    if (source.turn_id !== link.parent_turn_id) throw new Error('Child task snapshot source ToolCall crosses Turn scope.');
    add('sourceToolCalls', [source]);
    const bridge = one('AnswerBridge', { child_execution_id: childId }, true)!;
    add('answerBridges', [bridge]);
    const submissions = list('AnswerSubmission', { answer_bridge_id: bridge.id });
    if (bridge.current_submission_id !== null && !submissions.some((row) => row.id === bridge.current_submission_id)) {
      throw new Error('Child task snapshot AnswerBridge points outside its submissions.');
    }
    for (const submission of submissions) {
      if (!turnLinks.some((row) => row.turn_id === submission.turn_id)) {
        throw new Error('Child task snapshot AnswerSubmission crosses child lineage.');
      }
      add('answerPayloads', [one('AnswerPayload', { submission_id: submission.id }, true)!]);
      add('inboxItems', list('RuntimeInboxItem', { source_kind: 'answer_submission', source_id: submission.id }));
    }
    add('answerSubmissions', submissions);
    const descendantLinks = new Map<string, DomainRow>();
    for (const descendant of list('ChildExecutionParentLink', { parent_child_execution_id: childId })) {
      descendantLinks.set(requireRuntimeId(descendant.id), descendant);
    }
    for (const turn of rows.turns.filter((row) => row.conversation_id === childConversationId)) {
      for (const descendant of list('ChildExecutionParentLink', { parent_turn_id: turn.id })) {
        descendantLinks.set(requireRuntimeId(descendant.id), descendant);
      }
    }
    queue.push(...descendantLinks.values());
  }

  // Per-conversation reads include queued intents that have no Turn yet.
  for (const childConversation of rows.conversations) {
    add('turnIntents', list('TurnIntent', { conversation_id: childConversation.id }));
    add('agentLinks', list('AgentConversationLink', { conversation_id: childConversation.id }));
  }
  for (const intent of rows.turnIntents) {
    if (intent.turn_id !== null && get('Turn', intent.turn_id).conversation_id !== intent.conversation_id) {
      throw new Error('Child task snapshot TurnIntent crosses conversation scope.');
    }
    add('turnIntentRevisions', list('TurnIntentRevision', { intent_id: intent.id }));
  }
  for (const turn of rows.turns) {
    add('pendingInputs', list('PendingTurnInput', { turn_id: turn.id }));
    // The task ledger follows user assignments and native steering, not the model's growing
    // transcript. Answers and foreground tool results have their own explicit closure below.
    for (const role of ['input', 'native_steer']) {
      add('messageTurnLinks', list('MessageTurnLink', { turn_id: turn.id, role }));
    }
    add('terminations', list('TurnTermination', { turn_id: turn.id }));
    const leases = list('ExecutionLease', { turn_id: turn.id });
    for (const lease of leases) {
      if (lease.conversation_id !== turn.conversation_id) throw new Error('Child task snapshot ExecutionLease crosses conversation scope.');
    }
    add('executionLeases', leases);
    add('executorLinks', list('TurnExecutorLink', { turn_id: turn.id }));
  }
  for (const link of rows.messageTurnLinks) {
    const message = get('Message', link.message_id);
    const membership = one('MessagePartOfConversation', { message_id: message.id }, true)!;
    if (membership.conversation_id !== get('Turn', link.turn_id).conversation_id) {
      throw new Error('Child task snapshot MessageTurnLink crosses conversation scope.');
    }
    add('messages', [message]);
    add('messageMemberships', [membership]);
    add('messageRevisions', list('MessageRevision', { message_id: message.id }));
    const current = one('MessageCurrentRevisionLink', { message_id: message.id }, true)!;
    if (get('MessageRevision', current.revision_id).message_id !== message.id) {
      throw new Error('Child task snapshot current MessageRevision belongs to another message.');
    }
    add('currentRevisionLinks', [current]);
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
  for (const turn of rows.turns) {
    add('answerWaitOperations', list('Operation', { owner_kind: 'child_turn_answer_wait', owner_id: turn.id }));
  }
  for (const bridge of rows.answerBridges) {
    add('answerWaitOperations', list('Operation', { owner_kind: 'answer_bridge_wait', owner_id: bridge.id }));
  }
  const scopedTurnIds = new Set([...rows.parentTurns, ...rows.turns].map((turn) => turn.id));
  for (const operation of rows.answerWaitOperations) {
    if (operation.tool_call_id === null) throw new Error('Child task snapshot answer wait has no ToolCall.');
    const call = get('ToolCall', operation.tool_call_id);
    if (!scopedTurnIds.has(call.turn_id)) throw new Error('Child task snapshot answer wait ToolCall crosses scope.');
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
      for (const column of ['content_object_id', 'arguments_object_id']) {
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
    const length = BigInt(String(metadata.byte_length));
    if (length < 0n || length > BigInt(INTENT_ENVELOPE_MAX_BYTES)) {
      throw new Error('Child task snapshot TurnIntent envelope exceeds the structural byte limit.');
    }
    const bytes = readVerifiedEnvelope(metadata);
    if (BigInt(bytes.byteLength) !== length) throw new Error('Child task snapshot TurnIntent envelope byte length mismatch.');
    const value: unknown = JSON.parse(bytes.toString('utf8'));
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
  const body = { conversationId, conversation, ...rows };
  const snapshotRevision = createHash('sha256').update('limcode.child-task-facts\0').update(canonicalJson(body)).digest('hex');
  return { ...body, snapshotRevision };
}

function canonicalJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as DomainRow)[key])}`).join(',')}}`;
}
