import { createHash } from 'node:crypto';
import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import type { SnapshotBarrier } from './contracts';
import type { ConversationChildTaskFacts } from './childTaskFactsSnapshot';
import { childExecutionAcceptsContinuation, requireChildExecutionStatus, type ChildExecutionStatus } from './childExecutionState';
import {
  parseInputTurnIntentEnvelope,
  parseRuntimeContinuationTurnIntentEnvelope,
  TURN_INTENT_ENVELOPE_CONTENT_TYPE
} from './guidanceIntent';
import { CHILD_RUNTIME_DELIVERY_CONTINUATION_CONTENT_TYPE } from './runtimeDeliveryContinuationIdentity';
import type { DomainRow } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';
import { estimateJsonTokens } from './modelTokenEstimator';
import { childTaskTextForPreview } from './childSkillPreload';

export type ConversationChildTaskScope = 'direct' | 'tree';
export type ConversationChildTaskSourceState = 'effective' | 'queued' | 'superseded' | 'cancelled' | 'pending' | 'rejected';
export interface ConversationChildTaskSource {
  /** Stable domain identity; never a title, ordinal, or compression-generated handle. */
  id: string;
  kind: 'message_revision' | 'turn_intent_revision' | 'native_steer' | 'runtime_control' | 'answer_submission';
  classification: 'task' | 'runtime';
  state: ConversationChildTaskSourceState;
  text: string;
  contentObjectId: string;
  contentType: string;
  turnId?: string;
  sourceTurnId?: string;
  intentId?: string;
  messageId?: string;
  answerId?: string;
  sourceToolCallId?: string;
  sourceToolName?: string;
  sequence: string;
  createdAt: string;
  /** Structured message retained intact, including attachment references. */
  content?: unknown;
  hold?: 'none' | 'paused';
}

export interface ConversationChildTaskAnswer {
  answerId: string;
  turnId: string;
  revision: string;
  title?: string;
  contentObjectId: string;
  text: string;
  interrupted: boolean;
}

export interface ConversationChildTaskDelivery {
  id: string;
  state: string;
  phase: string;
  sourceId: string;
  targetConversationId: string;
  targetTurnId?: string;
  wakeState?: string;
  failureReason?: string;
  /** Delivery consumption and model-input handling are different committed facts. */
  handledAt?: string;
}

export interface ConversationChildTaskAnswerHandling {
  answerId: string;
  via: 'tool_result' | 'runtime_delivery' | 'unknown';
  toolCallId?: string;
  /** A committed Context source is not proof that a provider request has consumed it. */
  contextCommitted?: boolean;
  deliveryId?: string;
  handledAt?: string;
  wakeState?: string;
  failureReason?: string;
}

export interface ConversationChildTaskRecord {
  childExecutionId: string;
  answerBridgeId: string;
  parentConversationId: string;
  conversationId: string;
  depth: number;
  status: ChildExecutionStatus;
  resumable: boolean;
  label: string;
  createdAt: string;
  revision: string;
  initialTask?: ConversationChildTaskSource;
  currentInputs: ConversationChildTaskSource[];
  queuedInputs: ConversationChildTaskSource[];
  timeline: ConversationChildTaskSource[];
  execution: {
    activeTurnId?: string;
    latestTurnId?: string;
    termination?: { status: string; reason: string; turnId: string };
  };
  result: {
    latestAnswer?: ConversationChildTaskAnswer;
    deliveries: ConversationChildTaskDelivery[];
    handling: ConversationChildTaskAnswerHandling[];
  };
}

export interface ConversationChildTaskProjection {
  conversationId: string;
  /** Diagnostic only: commit counters from separate Hosts are not comparable. */
  snapshotCommitSeq: string;
  /** Worker-computed fingerprint of the complete transaction snapshot. */
  revision: string;
  tasks: ConversationChildTaskRecord[];
}

export interface ConversationChildTaskPageOptions {
  scope?: ConversationChildTaskScope;
  status?: ChildExecutionStatus | ChildExecutionStatus[];
  limit?: number;
  cursor?: string;
}

export interface ConversationChildTaskSourcePreview extends Omit<ConversationChildTaskSource, 'text' | 'content'> {
  preview: string;
  truncated: boolean;
  characters: number;
}

export interface ConversationChildTaskCard extends Omit<ConversationChildTaskRecord,
  'initialTask' | 'currentInputs' | 'queuedInputs' | 'timeline' | 'result'> {
  initialTask?: ConversationChildTaskSourcePreview;
  currentInputs: ConversationChildTaskSourcePreview[];
  queuedInputs: ConversationChildTaskSourcePreview[];
  currentInputCount: number;
  queuedInputCount: number;
  omittedCurrentInputs: number;
  omittedQueuedInputs: number;
  sourceCount: number;
  result: {
    latestAnswer?: Omit<ConversationChildTaskAnswer, 'text'> & { preview: string; truncated: boolean };
    deliveries: ConversationChildTaskDelivery[];
    omittedDeliveries: number;
    handling: ConversationChildTaskAnswerHandling[];
    omittedHandling: number;
  };
}

export interface ConversationChildTaskSummary {
  childExecutionId: string;
  answerBridgeId: string;
  depth: number;
  status: ChildExecutionStatus;
  label: string;
  taskPreview?: string;
  currentInputCount: number;
  queuedInputCount: number;
  answerAvailable: boolean;
  latestTurnOutcome?: string;
}

export interface ConversationChildTaskSourceChunk extends Omit<ConversationChildTaskSource, 'content'> {
  textOffset: number;
  totalCharacters: number;
  textComplete: boolean;
  textSha256: string;
  textFormat: 'text' | 'message_json';
}

export interface ConversationChildTaskCounts {
  total: number;
  totalDirect: number;
  totalDescendants: number;
  matched: number;
  shown: number;
  omitted: number;
  byStatus: Record<ChildExecutionStatus, number>;
}

export interface ConversationChildTaskPage {
  operation: 'list';
  conversationId: string;
  revision: string;
  snapshotCommitSeq: string;
  scope: ConversationChildTaskScope;
  tasks: ConversationChildTaskSummary[];
  counts: ConversationChildTaskCounts;
  totalDirect: number;
  totalDescendants: number;
  shown: number;
  omitted: number;
  nextCursor?: string;
  rereadCursor?: string;
}

export interface ConversationChildTaskReadPage {
  operation: 'read';
  conversationId: string;
  revision: string;
  scope: ConversationChildTaskScope;
  task: ConversationChildTaskSummary;
  timelineSources: ConversationChildTaskSourceChunk[];
  sourceCounts: { total: number; shown: number; omitted: number };
  nextCursor?: string;
  rereadCursor?: string;
}

const DEFAULT_PAGE_LIMIT = 32;
const MAX_PAGE_LIMIT = 100;
const CARD_SOURCE_LIMIT = 8;
const SOURCE_PREVIEW_CHARACTERS = 320;
const PAGE_TOKEN_BUDGET = 2_600;
const MESSAGE_CONTENT_TYPE = 'application/vnd.limcode.message+json';

/** All mutable facts are obtained in one worker read transaction; CAS bodies are read afterward. */
export async function readConversationChildTaskProjection(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  conversationId: string
): Promise<ConversationChildTaskProjection> {
  const barrier = await database.conversationChildTaskSnapshot(requireText(conversationId, 'conversationId'));
  return buildConversationChildTaskProjection(barrier, contentStore);
}

/** A read-side join over authoritative domain rows; no new persisted task aggregate is created. */
export async function buildConversationChildTaskProjection(
  barrier: SnapshotBarrier<ConversationChildTaskFacts>,
  contentStore: Pick<ContentAddressedStore, 'read'>
): Promise<ConversationChildTaskProjection> {
  const facts = barrier.snapshot;
  const conversationId = requireText(facts.conversationId, 'snapshot.conversationId');
  if (facts.conversation.id !== conversationId) throw new Error('Child task snapshot root identity mismatch.');
  const contents = new SnapshotContentReader(facts.contentObjects, contentStore);
  const turns = indexRows([...facts.parentTurns, ...facts.turns]);
  const conversations = indexRows(facts.conversations);
  const messages = indexRows(facts.messages);
  const revisions = indexRows(facts.messageRevisions);
  const currentRevisions = uniqueBy(facts.currentRevisionLinks, 'message_id');
  const memberships = uniqueBy(facts.messageMemberships, 'message_id');
  const parents = uniqueBy(facts.parentLinks, 'child_execution_id');
  const children = indexRows(facts.childExecutions);
  const bridges = uniqueBy(facts.answerBridges, 'child_execution_id');
  const activeLinks = uniqueBy(facts.activeTurnLinks, 'child_execution_id');
  const terminations = uniqueBy(facts.terminations, 'turn_id');
  const sourceTools = indexRows(facts.sourceToolCalls);
  const tasks: ConversationChildTaskRecord[] = [];
  const depthCache = new Map<string, number>();
  const parentConversation = (childId: string): string => {
    const parent = requiredRow(parents, childId, 'ChildExecutionParentLink');
    const turn = requiredRow(turns, requireText(parent.parent_turn_id, 'parent_turn_id'), 'parent Turn');
    return requireText(turn.conversation_id, 'parent Turn.conversation_id');
  };
  const depthFor = (childId: string, seen = new Set<string>()): number => {
    const cached = depthCache.get(childId);
    if (cached !== undefined) return cached;
    if (seen.has(childId)) throw new Error('Child task lineage is cyclic.');
    seen.add(childId);
    const parent = requiredRow(parents, childId, 'ChildExecutionParentLink');
    const ownerConversation = parentConversation(childId);
    let depth = 1;
    if (ownerConversation !== conversationId) {
      const parentChildId = requireText(parent.parent_child_execution_id, 'parent_child_execution_id');
      const parentChild = requiredRow(children, parentChildId, 'parent ChildExecution');
      if (parentChild.child_conversation_id !== ownerConversation) throw new Error('Child task parent relation mismatch.');
      depth = depthFor(parentChildId, seen) + 1;
    }
    depthCache.set(childId, depth);
    return depth;
  };

  for (const child of facts.childExecutions) {
    const childExecutionId = requireText(child.id, 'ChildExecution.id');
    const childConversationId = requireText(child.child_conversation_id, 'ChildExecution.child_conversation_id');
    const conversation = requiredRow(conversations, childConversationId, 'child Conversation');
    const bridge = requiredRow(bridges, childExecutionId, 'AnswerBridge');
    const answerBridgeId = requireText(bridge.id, 'AnswerBridge.id');
    const parent = requiredRow(parents, childExecutionId, 'ChildExecutionParentLink');
    const sourceToolCallId = requireText(parent.source_tool_call_id, 'ChildExecutionParentLink.source_tool_call_id');
    const sourceTool = sourceTools.get(sourceToolCallId);
    const childTurns = facts.turns.filter(turn => turn.conversation_id === childConversationId).sort(compareCreatedRows);
    const childTurnIds = new Set(childTurns.map(turn => requireText(turn.id, 'Turn.id')));
    const linkedTurns = facts.turnLinks.filter(link => link.child_execution_id === childExecutionId)
      .sort((a, b) => compareSequence(a.turn_seq, b.turn_seq));
    const initialTurnId = linkedTurns[0] ? requireText(linkedTurns[0].turn_id, 'ChildExecutionTurnLink.turn_id') : undefined;
    const activeTurnId = optionalText(activeLinks.get(childExecutionId)?.turn_id);
    if (activeTurnId && !childTurnIds.has(activeTurnId)) throw new Error('Child task active Turn is outside its Conversation.');
    const latestLink = linkedTurns[linkedTurns.length - 1];
    const latestTurnId = latestLink ? requireText(latestLink.turn_id, 'latest ChildExecutionTurnLink.turn_id')
      : childTurns.length ? requireText(childTurns[childTurns.length - 1].id, 'latest Turn.id') : undefined;
    const currentTurnId = activeTurnId ?? latestTurnId;
    const timeline: ConversationChildTaskSource[] = [];

    // Message links, not titles or whichever input happened to survive compression, define inputs.
    for (const link of facts.messageTurnLinks) {
      if (link.role !== 'input' || !childTurnIds.has(String(link.turn_id))) continue;
      const messageId = requireText(link.message_id, 'MessageTurnLink.message_id');
      const message = requiredRow(messages, messageId, 'Message');
      const membership = requiredRow(memberships, messageId, 'MessagePartOfConversation');
      if (membership.conversation_id !== childConversationId) throw new Error('Child input belongs to another Conversation.');
      const current = requiredRow(currentRevisions, messageId, 'MessageCurrentRevisionLink');
      const history = facts.messageRevisions.filter(revision => revision.message_id === messageId)
        .sort((a, b) => compareSequence(a.revision_seq, b.revision_seq));
      if (!history.length || !revisions.has(String(current.revision_id))) throw new Error('Child input has no current MessageRevision.');
      for (const revision of history) {
        if (revision.role !== 'user') throw new Error('Child input MessageRevision must have user role.');
        const contentObjectId = requireText(revision.content_object_id, 'MessageRevision.content_object_id');
        const decoded = await contents.message(contentObjectId);
        const turnId = requireText(link.turn_id, 'MessageTurnLink.turn_id');
        timeline.push({
          id: `message_revision:${String(revision.id)}:turn:${turnId}`,
          kind: 'message_revision', classification: 'task',
          state: message.deleted_at !== null && message.deleted_at !== undefined ? 'cancelled'
            : current.revision_id === revision.id ? 'effective' : 'superseded',
          ...decoded, contentObjectId, turnId, messageId,
          sequence: `${integerText(membership.message_seq)}:${integerText(revision.revision_seq)}`,
          createdAt: requireText(revision.created_at, 'MessageRevision.created_at'),
          ...(turnId === initialTurnId ? { sourceToolCallId,
            ...(sourceTool ? { sourceToolName: requireText(sourceTool.tool_name, 'ToolCall.tool_name') } : {}) } : {})
        });
      }
    }

    // Both UI inputs and run_agent continuations use TurnIntent facts. Every revision remains readable.
    for (const intent of facts.turnIntents.filter(row => row.conversation_id === childConversationId)) {
      const intentId = requireText(intent.id, 'TurnIntent.id');
      const history = facts.turnIntentRevisions.filter(revision => revision.intent_id === intentId)
        .sort((a, b) => compareSequence(a.revision_seq, b.revision_seq));
      if (!history.length) throw new Error(`TurnIntent ${intentId} has no revision.`);
      for (const [index, revision] of history.entries()) {
        const decoded = await contents.intent(requireText(revision.content_object_id, 'TurnIntentRevision.content_object_id'));
        const current = index === history.length - 1;
        const turnId = optionalText(intent.turn_id);
        // Admitted message inputs already have exact MessageRevision occurrences above.
        if (current && intent.state === 'admitted' && decoded.classification === 'task'
          && timeline.some(source => source.turnId === turnId && source.kind === 'message_revision')) continue;
        timeline.push({
          id: `turn_intent_revision:${String(revision.id)}`,
          kind: 'turn_intent_revision', ...decoded,
          state: !current ? 'superseded' : intent.state === 'queued' ? 'queued'
            : intent.state === 'cancelled' ? 'cancelled' : intent.state === 'admitted' ? 'effective'
              : invalidState(intent.state, 'TurnIntent'),
          intentId, ...(turnId ? { turnId } : {}),
          sequence: integerText(revision.revision_seq),
          createdAt: requireText(revision.created_at, 'TurnIntentRevision.created_at')
        });
      }
    }

    for (const pending of facts.pendingInputs.filter(row => childTurnIds.has(String(row.turn_id)))) {
      const pendingId = requireText(pending.id, 'PendingTurnInput.id');
      const turnId = requireText(pending.turn_id, 'PendingTurnInput.turn_id');
      const contentObjectId = requireText(pending.content_object_id, 'PendingTurnInput.content_object_id');
      if (pending.input_kind === 'native_steer') {
        const envelope = await contents.json(contentObjectId, 'application/vnd.limcode.native-steer+json');
        if (envelope.kind !== 'native_steer' || envelope.turnId !== turnId || envelope.conversationId !== childConversationId) {
          throw new Error('Native steering envelope does not match its durable input.');
        }
        const messageId = requireText(envelope.messageId, 'native steering messageId');
        const revisionId = requireText(envelope.messageRevisionId, 'native steering messageRevisionId');
        const revision = requiredRow(revisions, revisionId, 'native steering MessageRevision');
        if (revision.message_id !== messageId) throw new Error('Native steering revision identity mismatch.');
        const applied = facts.contextSegmentSources.some(source => source.source_kind === 'message_revision' && source.source_id === revisionId);
        const current = currentRevisions.get(messageId)?.revision_id === revisionId;
        const message = requiredRow(messages, messageId, 'native steering Message');
        const bodyId = requireText(revision.content_object_id, 'native steering content_object_id');
        timeline.push({
          id: `pending_turn_input:${pendingId}`, kind: 'native_steer', classification: 'task',
          state: message.deleted_at ? 'cancelled' : !current ? 'superseded' : applied ? 'effective'
            : ['failed', 'delivery_unknown'].includes(String(pending.state)) ? 'rejected' : 'pending',
          ...await contents.message(bodyId), contentObjectId: bodyId, turnId, messageId,
          sequence: integerText(pending.position), createdAt: requireText(pending.created_at, 'PendingTurnInput.created_at')
        });
      } else {
        // Interrupts and result delivery are control facts, never new business assignments.
        const body = await contents.raw(contentObjectId);
        timeline.push({
          id: `pending_turn_input:${pendingId}`, kind: 'runtime_control', classification: 'runtime',
          state: pendingState(pending.state), text: body.text, contentObjectId, contentType: body.contentType,
          turnId, sequence: integerText(pending.position),
          createdAt: requireText(pending.created_at, 'PendingTurnInput.created_at')
        });
      }
    }
    for (const submission of facts.answerSubmissions.filter(row => row.answer_bridge_id === answerBridgeId)) {
      const submissionId = requireText(submission.id, 'AnswerSubmission.id');
      const turnId = requireText(submission.turn_id, 'AnswerSubmission.turn_id');
      if (!childTurnIds.has(turnId)) throw new Error('AnswerSubmission belongs to another child Conversation.');
      const payloads = facts.answerPayloads.filter(row => row.submission_id === submissionId);
      if (payloads.length !== 1) throw new Error('AnswerSubmission must have exactly one AnswerPayload.');
      const contentObjectId = requireText(payloads[0].content_object_id, 'AnswerPayload.content_object_id');
      const body = await contents.raw(contentObjectId);
      timeline.push({
        id: `answer_submission:${submissionId}`, answerId: submissionId, kind: 'answer_submission',
        classification: 'runtime', state: bridge.current_submission_id === submissionId ? 'effective' : 'superseded',
        text: body.text, contentType: body.contentType, contentObjectId, turnId,
        sequence: integerText(submission.submission_seq), createdAt: requireText(submission.created_at, 'AnswerSubmission.created_at')
      });
    }
    timeline.sort(compareSources);
    const sourceIds = new Set(timeline.map(source => source.id));
    if (sourceIds.size !== timeline.length) throw new Error('Child task timeline contains duplicate source identities.');
    const initialTask = timeline.filter(source => source.kind === 'message_revision' && source.turnId === initialTurnId)
      .sort((a, b) => compareSourceSequence(a.sequence, b.sequence))[0];
    const termination = latestTurnId ? terminations.get(latestTurnId) : undefined;
    const latestAnswer = await readLatestAnswer(facts, contents, bridge, childTurnIds);
    const submissions = new Set(facts.answerSubmissions.filter(row => row.answer_bridge_id === answerBridgeId).map(row => String(row.id)));
    const inbox = new Map(facts.inboxItems.filter(row => row.source_kind === 'answer_submission' && submissions.has(String(row.source_id)))
      .map(row => [String(row.id), row]));
    const deliveries = facts.deliveries.filter(row => inbox.has(String(row.inbox_item_id))).map(row => {
      const input = facts.deliveryInputLinks.find(link => link.delivery_id === row.id);
      const wake = facts.deliveryWakes.find(value => value.delivery_id === row.id);
      const failureReason = optionalText(row.failure_reason) ?? optionalText(wake?.last_error);
      return {
        id: requireText(row.id, 'RuntimeDelivery.id'), state: requireText(row.state, 'RuntimeDelivery.state'),
        phase: requireText(row.phase, 'RuntimeDelivery.phase'),
        sourceId: requireText(inbox.get(String(row.inbox_item_id))?.source_id, 'RuntimeInboxItem.source_id'),
        targetConversationId: requireText(row.target_conversation_id, 'RuntimeDelivery.target_conversation_id'),
        ...(optionalText(row.target_turn_id) ? { targetTurnId: String(row.target_turn_id) } : {}),
        ...(optionalText(wake?.state) ? { wakeState: String(wake?.state) } : {}),
        ...(failureReason ? { failureReason } : {}),
        ...(optionalText(input?.handled_at) ? { handledAt: String(input?.handled_at) } : {})
      };
    }).sort((a, b) => compareText(a.id, b.id));
    const handling = await answerHandling(facts, contents, submissions, deliveries);
    const effectiveInputs = (turnId: string | undefined, seen = new Set<string>()): ConversationChildTaskSource[] => {
      if (!turnId) return [];
      if (!childTurnIds.has(turnId) || seen.has(turnId)) throw new Error('Child task input lineage is cyclic or crosses Conversation scope.');
      seen.add(turnId);
      const ownInputs = timeline.filter(source => source.classification === 'task' && source.state === 'effective'
        && source.turnId === turnId && (source.kind === 'message_revision' || source.kind === 'native_steer'));
      if (ownInputs.some(source => source.kind === 'message_revision')) return ownInputs;
      const continuations = timeline.filter(source => source.kind === 'turn_intent_revision' && source.classification === 'runtime'
        && source.state === 'effective' && source.turnId === turnId && source.sourceTurnId);
      const origins = new Set(continuations.map(source => source.sourceTurnId!));
      if (origins.size > 1) throw new Error('Child task Turn has conflicting runtime input origins.');
      const sourceTurnId = [...origins][0];
      return sourceTurnId ? [...effectiveInputs(sourceTurnId, seen), ...ownInputs] : ownInputs;
    };
    const task = {
      childExecutionId, answerBridgeId, parentConversationId: parentConversation(childExecutionId),
      conversationId: childConversationId, depth: depthFor(childExecutionId),
      status: requireChildExecutionStatus(child.status),
      resumable: childExecutionAcceptsContinuation(requireChildExecutionStatus(child.status)) && bridge.status !== 'closed',
      label: String(conversation.title),
      createdAt: requireText(child.created_at, 'ChildExecution.created_at'),
      ...(initialTask ? { initialTask } : {}),
      currentInputs: effectiveInputs(currentTurnId),
      queuedInputs: timeline.filter(source => source.classification === 'task' && (source.state === 'queued' || source.state === 'pending')),
      timeline,
      execution: {
        ...(activeTurnId ? { activeTurnId } : {}), ...(latestTurnId ? { latestTurnId } : {}),
        ...(termination && latestTurnId ? { termination: {
          status: requireText(termination.terminal_status, 'TurnTermination.terminal_status'),
          reason: String(termination.reason), turnId: latestTurnId
        } } : {})
      },
      result: { ...(latestAnswer ? { latestAnswer } : {}), deliveries, handling }
    };
    tasks.push({ ...task, revision: createHash('sha256').update(JSON.stringify(task)).digest('hex') });
  }
  tasks.sort((a, b) => compareText(a.createdAt, b.createdAt) || compareText(a.childExecutionId, b.childExecutionId));
  return { conversationId, snapshotCommitSeq: barrier.snapshotCommitSeq,
    revision: requireText(facts.snapshotRevision, 'snapshotRevision'), tasks };
}

class SnapshotContentReader {
  private readonly metadata: Map<string, DomainRow>;
  private readonly cache = new Map<string, Promise<{ text: string; contentType: string }>>();
  public constructor(rows: DomainRow[], private readonly store: Pick<ContentAddressedStore, 'read'>) {
    this.metadata = indexRows(rows);
  }
  public raw(id: string): Promise<{ text: string; contentType: string }> {
    let value = this.cache.get(id);
    if (!value) {
      const metadata = requiredRow(this.metadata, id, 'snapshot ContentObject') as ContentObjectMetadata;
      value = this.store.read(metadata).then(bytes => ({
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        contentType: requireText(metadata.content_type, 'ContentObject.content_type')
      }));
      this.cache.set(id, value);
    }
    return value;
  }
  public async json(id: string, contentType?: string): Promise<Record<string, unknown>> {
    const value = await this.raw(id);
    if (contentType && value.contentType !== contentType) throw new Error(`ContentObject ${id} has the wrong content type.`);
    return record(JSON.parse(value.text), `ContentObject ${id}`);
  }
  public async message(id: string): Promise<{ text: string; contentType: string; content?: unknown }> {
    const value = await this.raw(id);
    if (value.contentType.startsWith('text/')) return value;
    if (value.contentType !== MESSAGE_CONTENT_TYPE) throw new Error(`Task body ${id} has unsupported content type ${value.contentType}.`);
    const content = record(JSON.parse(value.text), `MessageContent ${id}`);
    if (!Array.isArray(content.parts)) throw new Error(`MessageContent ${id} has no parts.`);
    const text = content.parts.map(part => {
      const item = record(part, `MessageContent ${id} part`);
      if (typeof item.text === 'string' && item.thought !== true) return item.text;
      if (item.fileData || item.inlineData) return '[attachment; full structured content retained]';
      return '';
    }).join('');
    return { text, contentType: value.contentType, content };
  }
  public async intent(id: string): Promise<{
    text: string; contentType: string; contentObjectId: string; classification: 'task' | 'runtime';
    content?: unknown; hold?: 'none' | 'paused'; sourceTurnId?: string;
  }> {
    const value = await this.raw(id);
    if (value.contentType === CHILD_RUNTIME_DELIVERY_CONTINUATION_CONTENT_TYPE) {
      const envelope = await this.json(id);
      const continuation = parseRuntimeContinuationTurnIntentEnvelope(envelope);
      if (!continuation) throw new Error(`Child runtime continuation ${id} has an unsupported envelope kind.`);
      if (continuation.sourceTurnId === null) throw new Error(`Child runtime continuation ${id} has no source Turn.`);
      return { ...value, contentObjectId: id, classification: 'runtime', sourceTurnId: continuation.sourceTurnId };
    }
    if (value.contentType !== TURN_INTENT_ENVELOPE_CONTENT_TYPE) {
      return { ...await this.message(id), contentObjectId: id, classification: 'task' };
    }
    const envelope = record(JSON.parse(value.text), `TurnIntent ${id}`);
    const input = parseInputTurnIntentEnvelope(envelope);
    if (input) return { ...await this.message(input.messageContentObjectId), contentObjectId: input.messageContentObjectId,
      classification: 'task', hold: input.guidance.hold };
    if (envelope.kind === 'continuation') {
      const bodyId = requireText(envelope.messageContentObjectId, 'TurnIntent continuation.messageContentObjectId');
      return { ...await this.message(bodyId), contentObjectId: bodyId, classification: 'task' };
    }
    const continuation = parseRuntimeContinuationTurnIntentEnvelope(envelope);
    if (continuation || envelope.kind === 'retry') {
      return { ...value, contentObjectId: id, classification: 'runtime', content: envelope,
        ...(continuation
          ? continuation.sourceTurnId === null ? {} : { sourceTurnId: continuation.sourceTurnId }
          : { sourceTurnId: requireText(envelope.sourceTurnId, 'TurnIntent retry.sourceTurnId') }) };
    }
    throw new Error(`TurnIntent ${id} has an unsupported envelope kind.`);
  }
}

async function readLatestAnswer(
  facts: ConversationChildTaskFacts, contents: SnapshotContentReader, bridge: DomainRow, childTurnIds: Set<string>
): Promise<ConversationChildTaskAnswer | undefined> {
  const submissionId = optionalText(bridge.current_submission_id);
  if (!submissionId) return undefined;
  const submission = facts.answerSubmissions.find(row => row.id === submissionId && row.answer_bridge_id === bridge.id);
  if (!submission || !childTurnIds.has(String(submission.turn_id))) throw new Error('AnswerBridge references an invalid AnswerSubmission.');
  const payloads = facts.answerPayloads.filter(row => row.submission_id === submissionId);
  if (payloads.length !== 1) throw new Error('AnswerSubmission must have exactly one AnswerPayload.');
  const payload = payloads[0];
  const contentObjectId = requireText(payload.content_object_id, 'AnswerPayload.content_object_id');
  return { answerId: submissionId, turnId: requireText(submission.turn_id, 'AnswerSubmission.turn_id'),
    revision: integerText(submission.submission_seq), ...(optionalText(payload.title) ? { title: String(payload.title) } : {}),
    contentObjectId, text: (await contents.raw(contentObjectId)).text,
    interrupted: integerText(submission.interrupted) === '1' };
}

async function answerHandling(
  facts: ConversationChildTaskFacts, contents: SnapshotContentReader, submissionIds: Set<string>,
  deliveries: ConversationChildTaskDelivery[]
): Promise<ConversationChildTaskAnswerHandling[]> {
  const evidence: ConversationChildTaskAnswerHandling[] = deliveries.map(delivery => ({
    answerId: delivery.sourceId, via: 'runtime_delivery', deliveryId: delivery.id,
    ...(delivery.wakeState ? { wakeState: delivery.wakeState } : {}),
    ...(delivery.failureReason ? { failureReason: delivery.failureReason } : {}),
    ...(delivery.handledAt ? { handledAt: delivery.handledAt } : {})
  }));
  const candidates = new Set(facts.answerToolCalls.map(row => String(row.id)));
  const seen = new Set<string>();
  for (const row of [...facts.toolResultArtifacts, ...facts.toolOutcomes]) {
    const toolCallId = requireText(row.tool_call_id, 'answer tool_call_id');
    if (!candidates.has(toolCallId) || !optionalText(row.content_object_id)) continue;
    const envelope = await contents.json(String(row.content_object_id));
    const detail = envelope.detail;
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) continue;
    const value = detail as Record<string, unknown>;
    const answerId = optionalText(value.submissionId) ?? optionalText(value.answerSubmissionId);
    if (!answerId || !submissionIds.has(answerId) || seen.has(`${toolCallId}:${answerId}`)) continue;
    seen.add(`${toolCallId}:${answerId}`);
    const results = facts.toolModelResults.filter(result => result.tool_call_id === toolCallId);
    const contextCommitted = results.some(result => facts.contextSegmentSources.some(source =>
      source.source_kind === 'tool_model_result' && source.source_id === result.id));
    evidence.push({ answerId, via: 'tool_result', toolCallId, contextCommitted });
  }
  for (const answerId of submissionIds) {
    if (!evidence.some(value => value.answerId === answerId)) evidence.push({ answerId, via: 'unknown' });
  }
  return evidence.sort((a, b) => compareText(a.answerId, b.answerId)
    || compareText(a.via, b.via) || compareText(a.toolCallId ?? a.deliveryId ?? '', b.toolCallId ?? b.deliveryId ?? ''));
}

function indexRows(rows: DomainRow[]): Map<string, DomainRow> {
  return new Map(rows.map(row => [requireText(row.id, 'domain id'), row]));
}
function uniqueBy(rows: DomainRow[], column: string): Map<string, DomainRow> {
  const indexed = new Map<string, DomainRow>();
  for (const row of rows) {
    const key = requireText(row[column], column);
    if (indexed.has(key)) throw new Error(`Multiple child task facts for ${column} ${key}.`);
    indexed.set(key, row);
  }
  return indexed;
}
function requiredRow(map: Map<string, DomainRow>, id: string, label: string): DomainRow {
  const row = map.get(id);
  if (!row) throw new Error(`Missing ${label} ${id}.`);
  return row;
}
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function integerText(value: unknown): string {
  if ((typeof value !== 'bigint' && typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value))) {
    throw new Error('Child task sequence must be a non-negative integer.');
  }
  return String(value);
}
function compareSequence(a: unknown, b: unknown): number {
  const left = BigInt(integerText(a)); const right = BigInt(integerText(b));
  return left < right ? -1 : left > right ? 1 : 0;
}
function compareCreatedRows(a: DomainRow, b: DomainRow): number {
  return compareText(String(a.created_at), String(b.created_at)) || compareText(String(a.id), String(b.id));
}
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function compareSourceSequence(a: string, b: string): number {
  const left = a.split(':'); const right = b.split(':');
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = compareSequence(left[index] ?? '0', right[index] ?? '0');
    if (difference) return difference;
  }
  return 0;
}
function compareSources(a: ConversationChildTaskSource, b: ConversationChildTaskSource): number {
  return compareText(a.createdAt, b.createdAt) || compareSourceSequence(a.sequence, b.sequence) || compareText(a.id, b.id);
}
function invalidState(value: unknown, label: string): never { throw new Error(`${label} has unsupported state ${String(value)}.`); }
function pendingState(value: unknown): ConversationChildTaskSourceState {
  if (value === 'pending' || value === 'queued') return 'pending';
  if (value === 'consumed' || value === 'handled' || value === 'admitted') return 'effective';
  if (value === 'cancelled') return 'cancelled';
  if (value === 'rejected') return 'rejected';
  return invalidState(value, 'PendingTurnInput');
}

export function childTaskCard(task: ConversationChildTaskRecord): ConversationChildTaskCard {
  const { initialTask, currentInputs, queuedInputs, timeline, result, ...identity } = task;
  const answer = result.latestAnswer;
  const answerPreview = answer ? previewText(answer.text) : undefined;
  return {
    ...identity,
    ...(initialTask ? { initialTask: sourcePreview(initialTask) } : {}),
    currentInputs: currentInputs.slice(0, CARD_SOURCE_LIMIT).map(sourcePreview),
    queuedInputs: queuedInputs.slice(0, CARD_SOURCE_LIMIT).map(sourcePreview),
    currentInputCount: currentInputs.length,
    queuedInputCount: queuedInputs.length,
    omittedCurrentInputs: Math.max(0, currentInputs.length - CARD_SOURCE_LIMIT),
    omittedQueuedInputs: Math.max(0, queuedInputs.length - CARD_SOURCE_LIMIT),
    sourceCount: timeline.length,
    result: {
      ...(answer && answerPreview ? { latestAnswer: {
        answerId: answer.answerId, turnId: answer.turnId, revision: answer.revision,
        ...(answer.title ? { title: answer.title } : {}),
        contentObjectId: answer.contentObjectId, interrupted: answer.interrupted,
        preview: answerPreview.preview, truncated: answerPreview.truncated
      } } : {}),
      deliveries: result.deliveries.slice(0, CARD_SOURCE_LIMIT).map(value => ({ ...value })),
      omittedDeliveries: Math.max(0, result.deliveries.length - CARD_SOURCE_LIMIT),
      handling: result.handling.slice(0, CARD_SOURCE_LIMIT).map(value => ({ ...value })),
      omittedHandling: Math.max(0, result.handling.length - CARD_SOURCE_LIMIT)
    }
  };
}

export function listConversationChildTasks(
  projection: ConversationChildTaskProjection,
  options: ConversationChildTaskPageOptions = {}
): ConversationChildTaskPage {
  const scope = requireScope(options.scope);
  const limit = pageLimit(options.limit);
  const statuses = normalizeStatuses(options.status);
  const query = JSON.stringify({ kind: 'list', scope, statuses });
  const scoped = projection.tasks.filter(task => scope === 'tree' || task.depth === 1);
  const cursor = decodeCursor(options.cursor, projection, query);
  const key = (task: ConversationChildTaskRecord) => [task.createdAt, task.childExecutionId];
  const upper = cursor ? cursorKey(cursor.upper) : projection.tasks.length ? key(projection.tasks[projection.tasks.length - 1]) : [];
  const after = cursor ? cursorKey(cursor.after) : undefined;
  const matched = scoped.filter(task => (statuses.length === 0 || statuses.includes(task.status))
    && compareKey(key(task), upper) <= 0);
  const remaining = matched.filter(task => !after || compareKey(key(task), after) > 0);
  const totalDirect = projection.tasks.filter(task => task.depth === 1).length;
  const totalDescendants = projection.tasks.length - totalDirect;
  const byStatus: Record<ChildExecutionStatus, number> = {
    starting: 0, active: 0, idle: 0, interrupting: 0, interrupted: 0, closed: 0, needs_human: 0
  };
  scoped.forEach(task => { byStatus[task.status] += 1; });
  const build = (selected: ConversationChildTaskRecord[]): ConversationChildTaskPage => {
    const omitted = remaining.length - selected.length;
    return {
      operation: 'list', conversationId: projection.conversationId, revision: projection.revision,
      snapshotCommitSeq: projection.snapshotCommitSeq, scope,
      tasks: selected.map(childTaskSummary),
      counts: { total: scoped.length, totalDirect, totalDescendants, matched: matched.length, shown: selected.length, omitted, byStatus },
      totalDirect, totalDescendants, shown: selected.length, omitted,
      ...(upper.length ? { rereadCursor: options.cursor ?? encodeCursor(projection, query, { upper, after: ['', ''] }) } : {}),
      ...(omitted > 0 && selected.length ? { nextCursor: encodeCursor(projection, query,
        { upper, after: key(selected[selected.length - 1]) }) } : {})
    };
  };
  const selected: ConversationChildTaskRecord[] = [];
  for (const task of remaining.slice(0, limit)) {
    if (estimateJsonTokens(build([...selected, task])) > PAGE_TOKEN_BUDGET) {
      if (!selected.length) throw new Error('child_task_page_identity_exceeds_budget');
      break;
    }
    selected.push(task);
  }
  return build(selected);
}

export function readConversationChildTask(
  projection: ConversationChildTaskProjection,
  options: { childExecutionId: string; scope?: ConversationChildTaskScope; limit?: number; cursor?: string }
): ConversationChildTaskReadPage {
  const scope = requireScope(options.scope);
  const limit = pageLimit(options.limit);
  const childExecutionId = requireText(options.childExecutionId, 'childExecutionId');
  const task = projection.tasks.find(item => item.childExecutionId === childExecutionId
    && (scope === 'tree' || item.depth === 1));
  if (!task) throw new Error(`child_task_out_of_scope: ${childExecutionId}`);
  const query = JSON.stringify({ kind: 'read', scope, childExecutionId });
  const cursor = decodeCursor(options.cursor, projection, query);
  const upperId = cursor ? requireText(cursor.upperId, 'cursor.upperId') : task.timeline[task.timeline.length - 1]?.id;
  const upperIndex = upperId ? task.timeline.findIndex(source => source.id === upperId) : -1;
  if (upperId && upperIndex < 0) throw new Error('child_task_cursor_source_missing');
  const timeline = task.timeline.slice(0, upperIndex + 1);
  const bodies = new Map<string, { text: string; hash: string; format: 'text' | 'message_json' }>();
  const bodyFor = (source: ConversationChildTaskSource) => {
    let body = bodies.get(source.id);
    if (!body) { body = sourceBody(source); bodies.set(source.id, body); }
    return body;
  };
  let sourceIndex = cursor ? timeline.findIndex(source => source.id === cursor.sourceId) : 0;
  if (sourceIndex < 0) throw new Error('child_task_cursor_source_missing');
  let offset = cursor ? cursorOffset(cursor.offset) : 0;
  if (cursor && bodyFor(timeline[sourceIndex]).hash !== cursor.sourceHash) throw new Error('child_task_cursor_source_changed');
  const firstSource = timeline[sourceIndex];
  const rereadCursor = options.cursor ?? (firstSource ? encodeCursor(projection, query, {
    upperId, sourceId: firstSource.id, sourceHash: bodyFor(firstSource).hash, offset
  }) : undefined);
  const build = (chunks: ConversationChildTaskSourceChunk[], nextIndex: number, nextOffset: number): ConversationChildTaskReadPage => {
    const next = timeline[nextIndex];
    return {
      operation: 'read', conversationId: projection.conversationId, revision: projection.revision, scope,
      task: childTaskSummary(task), timelineSources: chunks,
      ...(rereadCursor ? { rereadCursor } : {}),
      sourceCounts: { total: timeline.length, shown: chunks.length, omitted: timeline.length - nextIndex },
      ...(next ? { nextCursor: encodeCursor(projection, query, {
        upperId, sourceId: next.id, sourceHash: bodyFor(next).hash, offset: nextOffset
      }) } : {})
    };
  };
  const chunks: ConversationChildTaskSourceChunk[] = [];
  while (sourceIndex < timeline.length && chunks.length < limit) {
    const source = timeline[sourceIndex];
    const body = bodyFor(source);
    if (offset > body.text.length) throw new Error('child_task_cursor_offset_invalid');
    const candidate = (end: number) => {
      const { content: _content, ...identity } = source;
      return { ...identity, text: body.text.slice(offset, end), textOffset: offset,
        totalCharacters: body.text.length, textComplete: end === body.text.length,
        textSha256: body.hash, textFormat: body.format };
    };
    const fits = (end: number) => estimateJsonTokens(build([...chunks, candidate(end)],
      end === body.text.length ? sourceIndex + 1 : sourceIndex,
      end === body.text.length ? 0 : end)) <= PAGE_TOKEN_BUDGET;
    let low = offset;
    let high = Math.min(body.text.length, offset + 12000);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(middle)) low = middle; else high = middle - 1;
    }
    // Keep UTF-16 surrogate pairs together while retaining an exact offset for reassembly.
    if (low < body.text.length && low > offset && /[\uD800-\uDBFF]/.test(body.text[low - 1])) low -= 1;
    if ((low === offset && body.text.length > offset) || !fits(low)) {
      if (chunks.length === 0) throw new Error('child_task_page_identity_exceeds_budget');
      break;
    }
    chunks.push(candidate(low));
    if (low === body.text.length) { sourceIndex += 1; offset = 0; }
    else { offset = low; break; }
  }
  return build(chunks, sourceIndex, offset);
}

export function childTaskSummary(task: ConversationChildTaskRecord): ConversationChildTaskSummary {
  const input = task.currentInputs[task.currentInputs.length - 1]?.text ?? task.initialTask?.text;
  const text = input === undefined ? undefined : childTaskTextForPreview(input);
  return {
    childExecutionId: task.childExecutionId, answerBridgeId: task.answerBridgeId, depth: task.depth,
    status: task.status, label: task.label.slice(0, 80),
    ...(text ? { taskPreview: text.slice(0, 120) } : {}),
    currentInputCount: task.currentInputs.length, queuedInputCount: task.queuedInputs.length,
    answerAvailable: !!task.result.latestAnswer,
    ...(task.execution.termination ? { latestTurnOutcome: task.execution.termination.status } : {})
  };
}

function sourceBody(source: ConversationChildTaskSource): { text: string; hash: string; format: 'text' | 'message_json' } {
  const text = source.content === undefined ? source.text : JSON.stringify(source.content);
  return { text, hash: createHash('sha256').update(text).digest('hex'),
    format: source.content === undefined ? 'text' : 'message_json' };
}

/** Model-facing summary only. Titles are labels; each preview retains a stable read-side source ref. */
export function renderConversationChildTaskCard(
  task: ConversationChildTaskRecord | ConversationChildTaskCard,
  reference?: { childRef: string }
): string {
  const card = 'timeline' in task ? childTaskCard(task) : task;
  const lines = [
    `${reference ? `childRef=${reference.childRef}; ` : ''}status=${card.status}; depth=${card.depth}; label=${JSON.stringify(card.label)}`,
    `execution: active=${!!card.execution.activeTurnId}; latestTurnOutcome=${card.execution.termination?.status ?? 'none'}; resumable=${card.resumable}`,
    'Use run_agent operation=read with this childRef to retrieve source text; continue with nextCursor. rereadCursor repeats the current page.'
  ];
  if (card.initialTask) lines.push(sourceLine('initial', card.initialTask));
  lines.push(`current_inputs=${card.currentInputCount}; queued_inputs=${card.queuedInputCount}; source_count=${card.sourceCount}`);
  lines.push(...card.currentInputs.map(source => sourceLine('current', source)));
  lines.push(...card.queuedInputs.map(source => sourceLine('queued', source)));
  if (card.omittedCurrentInputs || card.omittedQueuedInputs) {
    lines.push(`omitted_sources: current=${card.omittedCurrentInputs}; queued=${card.omittedQueuedInputs}; read this child for the full timeline`);
  }
  const answer = card.result.latestAnswer;
  lines.push(answer
    ? `answer: available; interrupted=${answer.interrupted}; preview=${JSON.stringify(answer.preview)}; truncated=${answer.truncated}`
    : 'answer: none');
  lines.push(`deliveries=${card.result.deliveries.length}; omittedDeliveries=${card.result.omittedDeliveries}; termination, answer submission, delivery consumption and input handling are distinct facts`);
  return lines.join('\n');
}

function sourceLine(label: string, source: ConversationChildTaskSourcePreview): string {
  return `${label}: kind=${source.classification}; state=${source.state}; preview=${JSON.stringify(source.preview)}; truncated=${source.truncated}`;
}

function sourcePreview(source: ConversationChildTaskSource): ConversationChildTaskSourcePreview {
  const { text, content: _content, ...identity } = source;
  return { ...identity, ...previewText(childTaskTextForPreview(text)) };
}

function previewText(text: string): { preview: string; truncated: boolean; characters: number } {
  const characters = Array.from(text);
  return { preview: characters.slice(0, SOURCE_PREVIEW_CHARACTERS).join(''), truncated: characters.length > SOURCE_PREVIEW_CHARACTERS, characters: characters.length };
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be non-empty text.`);
  return value;
}

function requireScope(value: unknown): ConversationChildTaskScope {
  if (value === undefined) return 'direct';
  if (value !== 'direct' && value !== 'tree') throw new Error('child_task_scope_invalid');
  return value;
}

function pageLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_PAGE_LIMIT;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new Error(`child_task_limit_invalid: limit must be 1..${MAX_PAGE_LIMIT}`);
  }
  return value;
}

function normalizeStatuses(value: ConversationChildTaskPageOptions['status']): ChildExecutionStatus[] {
  return [...new Set((value === undefined ? [] : Array.isArray(value) ? value : [value])
    .map(status => requireChildExecutionStatus(status)))].sort();
}

function encodeCursor(projection: ConversationChildTaskProjection, query: string, position: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ conversationId: projection.conversationId, query, ...position }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined, projection: ConversationChildTaskProjection, query: string): Record<string, unknown> | undefined {
  if (cursor === undefined) return undefined;
  if (typeof cursor !== 'string' || cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('child_task_cursor_invalid');
  let value: Record<string, unknown>;
  try { value = record(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')), 'cursor'); }
  catch { throw new Error('child_task_cursor_invalid'); }
  if (value.conversationId !== projection.conversationId || value.query !== query) throw new Error('child_task_cursor_scope_mismatch');
  return value;
}

function cursorOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('child_task_cursor_offset_invalid');
  return value;
}
function cursorKey(value: unknown): string[] {
  if (!Array.isArray(value) || value.length !== 2 || value.some(item => typeof item !== 'string')) throw new Error('child_task_cursor_invalid');
  return value as string[];
}
function compareKey(a: string[], b: string[]): number {
  return compareText(a[0] ?? '', b[0] ?? '') || compareText(a[1] ?? '', b[1] ?? '');
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
