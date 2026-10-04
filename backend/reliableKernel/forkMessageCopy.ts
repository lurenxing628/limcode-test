import type { RepositoryAssertStep, RepositoryInsertMutation, RepositoryTransactionStep } from './repositories';

/** Transport/storage bound only; all batches remain in the caller's one atomic transaction. */
export const FORK_MESSAGE_COPY_BATCH_LIMIT = 128;

/** Captured values, not instructions to re-read mutable source rows in the writer. */
export type ForkMessageCopyBase = readonly [
  sourceMessageId: string, targetMessageId: string, messageCreatedAt: string,
  messageUpdatedAt: string, messageDeletedAt: string | null,
  sourceRevisionId: string, targetRevisionId: string, revisionSeq: bigint,
  role: string, contentObjectId: string, revisionCreatedAt: string,
  sourceCurrentId: string, targetCurrentId: string, currentUpdatedAt: string,
  sourceMembershipId: string, targetMembershipId: string, messageSeq: bigint, membershipCreatedAt: string
];
export type ForkMessageSourceCopy = readonly [id: string, segmentId: string, createdAt: string];
export type ForkMessageAttachmentCopy = readonly [id: string, attachmentId: string, position: bigint, createdAt: string];
export type ForkMessageTurnCopy = readonly [id: string, turnId: string, role: string, createdAt: string];
export interface ForkMessageCopyDescriptor {
  readonly base: ForkMessageCopyBase;
  readonly sources: readonly ForkMessageSourceCopy[];
  readonly attachments: readonly ForkMessageAttachmentCopy[];
  readonly turns: readonly ForkMessageTurnCopy[];
}
export interface ForkMessageCopyBatch {
  readonly sourceConversationId: string;
  readonly targetConversationId: string;
  readonly messages: readonly ForkMessageCopyDescriptor[];
}
export interface RepositoryAssertForkMessageCopiesStep {
  kind: 'assertForkMessageCopies';
  domain: 'Message';
  batch: ForkMessageCopyBatch;
}
export interface RepositoryCopyForkMessagesStep {
  kind: 'copyForkMessages';
  domain: 'Message';
  batch: ForkMessageCopyBatch;
}

/** These visitors never collect an expanded plan, nor read or write a database themselves. */
export function* forkMessageCopyAssertions(
  step: RepositoryAssertForkMessageCopiesStep
): Generator<RepositoryAssertStep> {
  validateStep(step, 'assertForkMessageCopies');
  for (const message of step.batch.messages) {
    validateDescriptor(message);
    const b = message.base;
    yield { kind: 'assert', domain: 'Message', id: b[0], where: { deleted_at: b[4] } };
    yield { kind: 'assert', domain: 'MessageRevision', id: b[5], where: {
      message_id: b[0], revision_seq: b[7], role: b[8], content_object_id: b[9]
    } };
    yield { kind: 'assert', domain: 'MessageCurrentRevisionLink', id: b[11], where: {
      message_id: b[0], revision_id: b[5]
    } };
    yield { kind: 'assert', domain: 'MessagePartOfConversation', id: b[14], where: {
      conversation_id: step.batch.sourceConversationId, message_id: b[0], message_seq: b[16]
    } };
  }
}

export function* forkMessageCopyInserts(
  step: RepositoryCopyForkMessagesStep
): Generator<RepositoryInsertMutation> {
  validateStep(step, 'copyForkMessages');
  for (const message of step.batch.messages) {
    validateDescriptor(message);
    const b = message.base;
    yield { kind: 'insert', domain: 'Message', row: {
      id: b[1], created_at: b[2], updated_at: b[3], deleted_at: null
    } };
    yield { kind: 'insert', domain: 'MessageRevision', row: {
      id: b[6], message_id: b[1], revision_seq: b[7], role: b[8], content_object_id: b[9], created_at: b[10]
    } };
    yield { kind: 'insert', domain: 'MessageCurrentRevisionLink', row: {
      id: b[12], message_id: b[1], revision_id: b[6], updated_at: b[13]
    } };
    yield { kind: 'insert', domain: 'MessagePartOfConversation', row: {
      id: b[15], conversation_id: step.batch.targetConversationId, message_id: b[1], message_seq: b[16], created_at: b[17]
    } };
    for (const source of message.sources) {
      requireTuple(source, 3, 'source');
      yield { kind: 'insert', domain: 'ContextSegmentSource', row: {
        id: source[0], segment_id: source[1], source_kind: 'message_revision',
        source_id: b[6], source_revision: b[7], created_at: source[2]
      } };
    }
    for (const attachment of message.attachments) {
      requireTuple(attachment, 4, 'attachment');
      yield { kind: 'insert', domain: 'AttachmentLink', row: {
        id: attachment[0], message_revision_id: b[6], attachment_id: attachment[1],
        position: attachment[2], created_at: attachment[3]
      } };
    }
    for (const turn of message.turns) {
      requireTuple(turn, 4, 'turn link');
      yield { kind: 'insert', domain: 'MessageTurnLink', row: {
        id: turn[0], turn_id: turn[1], message_id: b[1], role: turn[2], created_at: turn[3]
      } };
    }
  }
}

/** Worker execution stays synchronous inside its caller-owned transaction. */
export function visitForkMessageCopyAssertions(step: RepositoryAssertForkMessageCopiesStep,
  visit: (assertion: RepositoryAssertStep) => void): void {
  for (const assertion of forkMessageCopyAssertions(step)) visit(assertion);
}
export function visitForkMessageCopyInserts(step: RepositoryCopyForkMessagesStep,
  visit: (insert: RepositoryInsertMutation) => void): void {
  for (const insert of forkMessageCopyInserts(step)) visit(insert);
}

/** Small logical provenance view for planner checks; never expand the other copied domains. */
export function visitForkCopiedMessageSources(
  steps: readonly RepositoryTransactionStep[],
  visit: (source: { segmentId: string; sourceKind: string }) => void
): void {
  for (const step of steps) {
    if (step.kind === 'copyForkMessages') {
      for (const message of step.batch.messages) for (const source of message.sources) {
        visit({ segmentId: source[1], sourceKind: 'message_revision' });
      }
    } else if (step.kind === 'insert' && step.domain === 'ContextSegmentSource') {
      if (typeof step.row.segment_id !== 'string' || typeof step.row.source_kind !== 'string') {
        throw new TypeError('Fork copied Context source identity must be text.');
      }
      visit({ segmentId: step.row.segment_id, sourceKind: step.row.source_kind });
    }
  }
}

/** One snapshot shared by the separate assertion and insertion positions. */
export function cloneForkMessageCopyBatch(batch: ForkMessageCopyBatch): ForkMessageCopyBatch {
  validateBatch(batch);
  return Object.freeze({
    sourceConversationId: batch.sourceConversationId,
    targetConversationId: batch.targetConversationId,
    messages: Object.freeze(batch.messages.map(message => {
      validateDescriptor(message);
      return Object.freeze({
        base: Object.freeze([...message.base]) as ForkMessageCopyBase,
        sources: Object.freeze(message.sources.map(tuple => {
          requireTuple(tuple, 3, 'source');
          return Object.freeze([...tuple]) as ForkMessageSourceCopy;
        })),
        attachments: Object.freeze(message.attachments.map(tuple => {
          requireTuple(tuple, 4, 'attachment');
          return Object.freeze([...tuple]) as ForkMessageAttachmentCopy;
        })),
        turns: Object.freeze(message.turns.map(tuple => {
          requireTuple(tuple, 4, 'turn link');
          return Object.freeze([...tuple]) as ForkMessageTurnCopy;
        }))
      });
    }))
  });
}

/** Cooperate per relation as well as per Message; a rich single Message is not a bounded batch. */
export interface ForkMessageCopyWork {
  shouldYield(): boolean;
  yield(): Promise<void>;
}
export async function cloneForkMessageCopyBatchCooperatively(
  batch: ForkMessageCopyBatch,
  work: ForkMessageCopyWork
): Promise<ForkMessageCopyBatch> {
  validateBatch(batch);
  const messages: ForkMessageCopyDescriptor[] = [];
  for (const message of batch.messages) {
    if (work.shouldYield()) await work.yield();
    validateDescriptor(message);
    const sources: ForkMessageSourceCopy[] = [];
    const attachments: ForkMessageAttachmentCopy[] = [];
    const turns: ForkMessageTurnCopy[] = [];
    for (const tuple of message.sources) {
      if (work.shouldYield()) await work.yield();
      requireTuple(tuple, 3, 'source');
      sources.push(Object.freeze([...tuple]) as ForkMessageSourceCopy);
    }
    for (const tuple of message.attachments) {
      if (work.shouldYield()) await work.yield();
      requireTuple(tuple, 4, 'attachment');
      attachments.push(Object.freeze([...tuple]) as ForkMessageAttachmentCopy);
    }
    for (const tuple of message.turns) {
      if (work.shouldYield()) await work.yield();
      requireTuple(tuple, 4, 'turn link');
      turns.push(Object.freeze([...tuple]) as ForkMessageTurnCopy);
    }
    messages.push(Object.freeze({ base: Object.freeze([...message.base]) as ForkMessageCopyBase,
      sources: Object.freeze(sources), attachments: Object.freeze(attachments), turns: Object.freeze(turns) }));
  }
  return Object.freeze({ sourceConversationId: batch.sourceConversationId,
    targetConversationId: batch.targetConversationId, messages: Object.freeze(messages) });
}

function validateStep(
  step: RepositoryAssertForkMessageCopiesStep | RepositoryCopyForkMessagesStep,
  kind: 'assertForkMessageCopies' | 'copyForkMessages'
): void {
  if (step.kind !== kind || step.domain !== 'Message'
    || Object.keys(step).some(key => !['kind', 'domain', 'batch'].includes(key))) {
    throw new TypeError('Invalid fixed fork Message copy step.');
  }
  validateBatch(step.batch);
}

function validateBatch(batch: ForkMessageCopyBatch): void {
  if (!batch || typeof batch !== 'object'
    || Object.keys(batch).some(key => !['sourceConversationId', 'targetConversationId', 'messages'].includes(key))
    || typeof batch.sourceConversationId !== 'string' || typeof batch.targetConversationId !== 'string') {
    throw new TypeError('Invalid fork Message copy batch.');
  }
  if (!Array.isArray(batch.messages) || batch.messages.length < 1 || batch.messages.length > FORK_MESSAGE_COPY_BATCH_LIMIT) {
    throw new RangeError(`Fork Message copy batches require 1 through ${FORK_MESSAGE_COPY_BATCH_LIMIT} messages.`);
  }
}

function validateDescriptor(message: ForkMessageCopyDescriptor): void {
  if (!message || typeof message !== 'object'
    || Object.keys(message).some(key => !['base', 'sources', 'attachments', 'turns'].includes(key))
    || !Array.isArray(message.sources) || !Array.isArray(message.attachments) || !Array.isArray(message.turns)) {
    throw new TypeError('Invalid fork Message copy descriptor.');
  }
  requireTuple(message.base, 18, 'base');
}

function requireTuple(value: unknown, length: number, name: string): void {
  if (!Array.isArray(value) || value.length !== length) throw new TypeError(`Fork Message ${name} tuple requires ${length} fields.`);
}
