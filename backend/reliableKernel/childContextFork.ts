import { visitForkCopiedMessageSources } from './forkMessageCopy';
import { selectConversationCompressionBlock } from './compressionBlockOwnership';
import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import { ContextSequenceControlPlane } from './contextSequence';
import { estimateContextSegmentTokens } from './contextTokenEstimator';
import { prepareConversationForkSnapshot } from './conversationForkSnapshot';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { requirePhaseFId, stablePhaseFId } from './phaseFIdentity';
import type { RuntimeDatabase } from './runtimeDatabase';
import { ConversationAttachmentHandleRegistry } from './conversationAttachmentHandles';
import { NATIVE_CHILD_HANDLE_PROJECTION_EVENT, readConversationContextHandleCatalog } from './conversationChildHandles';
import { captureForkContextHandleFrontier, prepareForkContextHandleReservations,
  readForkContextHandleReservationEvidence } from './forkContextHandleReservations';

export type ChildForkTurns = 'none' | 'all' | `${number}`;

const FORK_READ_BATCH_SIZE = 64;
const FORK_LIST_FIRST_PAGE_SIZE = 257;
const FORK_CONTENT_BATCH_BYTES = 8n * 1024n * 1024n;

export function normalizeChildForkTurns(value: unknown): ChildForkTurns {
  if (value === undefined || value === 'none') return 'none';
  if (value === 'all') return 'all';
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))) {
    return value as `${number}`;
  }
  throw new TypeError('run_agent.forkTurns must be none, all, or a positive safe integer written as a string.');
}

export interface ChildContextForkPlan {
  steps: RepositoryTransactionStep[];
  segments: Array<{ segmentId: string; estimatedTokens: number }>;
}

/**
 * Prepares history only: no Conversation, execution ownership or child-control links. Inherited
 * Turns own frozen copies of their historical AuthoritySnapshots (like any fork), while the child's
 * own authority is compiled from its assignment by the caller, which commits this plan with the new
 * child and that assignment in one transaction.
 */
export async function prepareChildContextFork(
  database: RuntimeDatabase,
  store: ContentAddressedStore,
  input: {
    sourceConversationId: string;
    targetConversationId: string;
    targetAgentId: string;
    forkTurns: ChildForkTurns;
    now: string;
    assertActive?: () => void;
  }
): Promise<ChildContextForkPlan> {
  if (input.forkTurns === 'none') return { steps: [], segments: [] };
  input.assertActive?.();
  await new ConversationAttachmentHandleRegistry(database, { contentStore: store, now: () => input.now })
    .ensure(input.sourceConversationId, []);
  const handleFrontier = await captureForkContextHandleFrontier(database, input.sourceConversationId,
    NATIVE_CHILD_HANDLE_PROJECTION_EVENT);
  const sourceReservations = await readForkContextHandleReservationEvidence(database, store, input.sourceConversationId);
  const sourceCatalog = await readConversationContextHandleCatalog(database, store, input.sourceConversationId);
  const handleReservations = await prepareForkContextHandleReservations({ database, contentStore: store,
    sourceConversationId: input.sourceConversationId, targetConversationId: input.targetConversationId,
    catalog: sourceCatalog, coveredRecipeObjectIds: [...new Set([...handleFrontier.coveredRecipeObjectIds,
      ...(sourceReservations?.coveredRecipeObjectIds ?? [])])], now: input.now });
  const list = (domain: string, where: Record<string, string>) => listAllDomainRows(database, domain, where);
  const [heads, turns, memberships] = await Promise.all([
    list('ConversationContextHeadLink', { conversation_id: input.sourceConversationId }),
    list('Turn', { conversation_id: input.sourceConversationId }),
    list('MessagePartOfConversation', { conversation_id: input.sourceConversationId })
  ]);
  if (heads.length !== 1) throw new Error('Child context fork source must have exactly one Context head.');
  const context = new ContextSequenceControlPlane(database, store);
  input.assertActive?.();
  const structure = await context.materializeStructure(id(heads[0].root_id));
  const membershipByMessage = new Map(memberships.map(row => [id(row.message_id), row]));
  const candidates: Array<{ turn: DomainRow; links: DomainRow[]; sequence: bigint }> = [];
  const terminatedTurns = turns.filter(turn => turn.status === 'terminated');
  const [terminationsByTurn, linksByTurn] = await Promise.all([
    readForkLists(database, 'TurnTermination', 'turn_id', terminatedTurns.map(turn => id(turn.id))),
    readForkLists(database, 'MessageTurnLink', 'turn_id', terminatedTurns.map(turn => id(turn.id)))
  ]);
  for (const turn of terminatedTurns) {
    const terminations = terminationsByTurn.get(id(turn.id))!;
    const links = linksByTurn.get(id(turn.id))!;
    // A cancelled or failed turn can contain unfinished native calls. It is not forkable history.
    if (terminations.length !== 1 || terminations[0].terminal_status !== 'completed') continue;
    const sequences = links.map(link => membershipByMessage.get(id(link.message_id)))
      .filter((row): row is DomainRow => row !== undefined).map(row => BigInt(String(row.message_seq)));
    if (sequences.length > 0) candidates.push({ turn, links, sequence: sequences.reduce((a, b) => a < b ? a : b) });
  }
  terminationsByTurn.clear();
  linksByTurn.clear();
  candidates.sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : id(a.turn.id).localeCompare(id(b.turn.id)));
  const completedTurns = new Set(candidates.map(item => id(item.turn.id)));
  const turnsByMessage = new Map<string, Set<string>>();
  for (const item of candidates) for (const link of item.links) {
    const messageId = id(link.message_id);
    const owners = turnsByMessage.get(messageId) ?? new Set<string>();
    owners.add(id(item.turn.id));
    turnsByMessage.set(messageId, owners);
  }
  const cache = new Map<string, DomainRow | null>();
  async function prefetch(domain: string, rowIds: readonly string[]): Promise<void> {
    const missing = [...new Set(rowIds)].filter(rowId => !cache.has(`${domain}:${rowId}`));
    for (let offset = 0; offset < missing.length; offset += FORK_READ_BATCH_SIZE) {
      input.assertActive?.();
      const batch = missing.slice(offset, offset + FORK_READ_BATCH_SIZE);
      const barrier = await database.snapshot(batch.map(rowId => DOMAIN_REPOSITORIES.domain(domain).get(rowId)));
      for (const [index, rowId] of batch.entries()) {
        const row = barrier.snapshot[index];
        if (row !== null && (!row || typeof row !== 'object' || Array.isArray(row))) {
          throw new Error(`Child context fork read an invalid ${domain}:${rowId}.`);
        }
        cache.set(`${domain}:${rowId}`, row as DomainRow | null);
      }
    }
  }
  async function maybeGet(domain: string, rowId: string): Promise<DomainRow | null> {
    const key = `${domain}:${rowId}`;
    if (!cache.has(key)) await prefetch(domain, [rowId]);
    return cache.get(key)!;
  }
  async function get(domain: string, rowId: string): Promise<DomainRow> {
    const row = await maybeGet(domain, rowId);
    if (!row) throw new Error(`Child context fork missing ${domain}:${rowId}.`);
    return row;
  }
  /** Shared tool segments keep provenance of deleted Conversations whose tool rows cascaded away. */
  async function existingToolCall(source: DomainRow): Promise<DomainRow | null> {
    if (source.source_kind === 'tool_call') return maybeGet('ToolCall', id(source.source_id));
    const result = await maybeGet('ToolModelResult', id(source.source_id));
    return result ? maybeGet('ToolCall', id(result.tool_call_id)) : null;
  }
  // These complete source sets live only for this preparation. Shared segments gain provenance
  // from other forks without changing this Conversation's head, so they cannot be cached by root.
  const sourcesBySegment = new Map<string, DomainRow[]>();
  const sourcesByToolCall = new Map<string, DomainRow[]>();
  async function prefetchSources(segments: readonly DomainRow[]): Promise<void> {
    const pending = [...new Map(segments.map(segment => [id(segment.id), segment])).values()]
      .filter(segment => !sourcesBySegment.has(id(segment.id)));
    for (let offset = 0; offset < pending.length; offset += FORK_READ_BATCH_SIZE) {
      input.assertActive?.();
      const batch = pending.slice(offset, offset + FORK_READ_BATCH_SIZE);
      const sourceSets = await readForkLists(database, 'ContextSegmentSource', 'segment_id', batch.map(segment => id(segment.id)));
      for (const [segmentId, sources] of sourceSets) sourcesBySegment.set(segmentId, sources);
      const historySources = batch.filter(segment => segment.segment_kind === 'message' || segment.segment_kind === 'tool_pair')
        .flatMap(segment => sourceSets.get(id(segment.id))!);
      await Promise.all([
        prefetch('MessageRevision', historySources.filter(source => source.source_kind === 'message_revision').map(source => id(source.source_id))),
        prefetch('ToolModelResult', historySources.filter(source => source.source_kind === 'tool_model_result').map(source => id(source.source_id))),
        prefetch('ToolCall', historySources.filter(source => source.source_kind === 'tool_call').map(source => id(source.source_id)))
      ]);
      const resultCalls: string[] = [];
      for (const source of historySources) if (source.source_kind === 'tool_model_result') {
        const result = await maybeGet('ToolModelResult', id(source.source_id));
        if (result) resultCalls.push(id(result.tool_call_id));
      }
      await prefetch('ToolCall', resultCalls);
      const ownedCallIds = new Set<string>();
      for (const source of historySources) {
        if (source.source_kind !== 'tool_call' && source.source_kind !== 'tool_model_result') continue;
        const call = await existingToolCall(source);
        if (call && completedTurns.has(id(call.turn_id)) && !sourcesByToolCall.has(id(call.id))) ownedCallIds.add(id(call.id));
      }
      for (const [callId, sources] of await readForkLists(database, 'ToolCallSourceLink', 'tool_call_id', [...ownedCallIds])) {
        sourcesByToolCall.set(callId, sources);
      }
    }
  }
  const availableSegments: Array<{ row: DomainRow; turns: Set<string>; messages: Set<string> }> = [];
  const path = new Set<string>();
  async function visit(segment: DomainRow): Promise<void> {
    const segmentId = id(segment.id);
    if (path.has(segmentId)) throw new Error('Child context fork compression lineage contains a cycle.');
    path.add(segmentId);
    const sources = sourcesBySegment.get(segmentId)!;
    if (segment.segment_kind === 'compression') {
      const block = await selectConversationCompressionBlock(database, segmentId, input.sourceConversationId, sources);
      if (block.summary_object_id !== segment.content_object_id) throw new Error('Child context fork compression content is inconsistent.');
      const children = await list('CompressionBlockSource', { compression_block_id: id(block.id) });
      children.sort((a, b) => Number(BigInt(String(a.position)) - BigInt(String(b.position))));
      await prefetch('ContextSegment', children.map(child => id(child.segment_id)));
      const childSegments = await Promise.all(children.map(child => get('ContextSegment', id(child.segment_id))));
      await prefetchSources(childSegments);
      for (const [position, child] of children.entries()) {
        if (BigInt(String(child.position)) !== BigInt(position)) throw new Error('Child context fork compression order is invalid.');
        await visit(childSegments[position]);
      }
    } else if (segment.segment_kind === 'message' || segment.segment_kind === 'tool_pair') {
      const owners = new Set<string>();
      const messages = new Set<string>();
      for (const source of sources) {
        if (source.source_kind === 'message_revision') {
          const revision = await get('MessageRevision', id(source.source_id));
          const messageId = id(revision.message_id);
          for (const turnId of turnsByMessage.get(messageId) ?? []) owners.add(turnId);
          if (turnsByMessage.has(messageId)) messages.add(messageId);
        } else if (source.source_kind === 'tool_call' || source.source_kind === 'tool_model_result') {
          const call = await existingToolCall(source);
          if (call && completedTurns.has(id(call.turn_id))) {
            owners.add(id(call.turn_id));
            for (const sourceLink of sourcesByToolCall.get(id(call.id))!) {
              messages.add(id(sourceLink.message_id));
            }
          }
        } else {
          throw new Error(`Child context fork ${String(segment.segment_kind)} segment has an unknown ${String(source.source_kind)} source.`);
        }
      }
      if (owners.size > 0) availableSegments.push({ row: segment, turns: owners, messages });
    }
    // system and runtime_context belong to the source execution, not to reusable conversation history.
    path.delete(segmentId);
  }
  await prefetchSources(structure.records.map(record => record.segment));
  for (const record of structure.records) await visit(record.segment);
  // The traversal facts are no longer needed while the independent snapshot owns its copy plan.
  sourcesBySegment.clear();
  sourcesByToolCall.clear();
  cache.clear();
  const availableTurns = new Set(availableSegments.flatMap(segment => [...segment.turns]));
  const visibleCandidates = candidates.filter(candidate => availableTurns.has(id(candidate.turn.id)));
  const selected = input.forkTurns === 'all' ? visibleCandidates : visibleCandidates.slice(-Number(input.forkTurns));
  const selectedTurns = new Set(selected.map(item => id(item.turn.id)));
  const retained = availableSegments.filter(segment => [...segment.turns].some(turnId => selectedTurns.has(turnId)));
  const selectedMessages = new Set(retained.flatMap(segment => [...segment.messages]));
  const segmentRows = retained.map(segment => segment.row);
  const segmentIds = segmentRows.map(row => id(row.id));
  let boundary = 0n;
  for (const messageId of selectedMessages) {
    const membership = membershipByMessage.get(messageId);
    if (!membership) continue;
    const sequence = BigInt(String(membership.message_seq));
    if (sequence > boundary) boundary = sequence;
  }
  const snapshot = await prepareConversationForkSnapshot(database, {
    sourceConversationId: input.sourceConversationId,
    targetConversationId: input.targetConversationId,
    targetAgentId: input.targetAgentId,
    selectedMessageIds: selectedMessages,
    preparedMemberships: { sourceConversationId: input.sourceConversationId, byMessage: membershipByMessage },
    boundaryMessageSeq: boundary,
    contextSegmentIds: segmentIds,
    now: input.now,
    assertActive: input.assertActive
  });
  const copiedSources = new Map<string, string[]>();
  visitForkCopiedMessageSources(snapshot.inserts, source => {
    const segmentId = id(source.segmentId);
    const kinds = copiedSources.get(segmentId) ?? [];
    kinds.push(id(source.sourceKind));
    copiedSources.set(segmentId, kinds);
  });
  for (const segment of segmentRows) {
    const kinds = copiedSources.get(id(segment.id)) ?? [];
    if (segment.segment_kind === 'message'
      ? kinds.length !== 1 || kinds[0] !== 'message_revision'
      : kinds.length === 0 || kinds.some(kind => kind !== 'tool_call' && kind !== 'tool_model_result')) {
      throw new Error('Child context fork cannot copy the selected current transcript provenance.');
    }
  }
  await prefetch('ContentObject', segmentRows.map(segment => id(segment.content_object_id)));
  input.assertActive?.();
  const segments = await estimateForkSegments(store, segmentRows, async objectId =>
    await get('ContentObject', objectId) as unknown as ContentObjectMetadata);
  return {
    segments,
    steps: [
      DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').assert(id(heads[0].id), {
        conversation_id: input.sourceConversationId, root_id: heads[0].root_id
      }),
      ...snapshot.assertions,
      ...snapshot.inserts,
      ...handleFrontier.assertions,
      ...handleReservations.steps,
      DOMAIN_REPOSITORIES.domain('ConversationBranchLink').insert({
        id: stablePhaseFId('conversation_branch_link', 'child-context-fork', input.targetConversationId),
        target_conversation_id: input.targetConversationId,
        source_conversation_id: input.sourceConversationId,
        source_message_revision_id: null,
        created_at: input.now
      })
    ]
  };
}

/** Estimate each immutable body/kind once, without retaining all inherited body buffers. */
async function estimateForkSegments(
  store: ContentAddressedStore,
  segmentRows: readonly DomainRow[],
  readMetadata: (objectId: string) => Promise<ContentObjectMetadata>
): Promise<ChildContextForkPlan['segments']> {
  const contentKinds = new Map<string, Set<'message' | 'tool_pair'>>();
  for (const segment of segmentRows) {
    const objectId = id(segment.content_object_id);
    const kinds = contentKinds.get(objectId) ?? new Set<'message' | 'tool_pair'>();
    kinds.add(segment.segment_kind === 'message' ? 'message' : 'tool_pair');
    contentKinds.set(objectId, kinds);
  }
  const estimates = new Map<string, number>();
  let contentBatch: ContentObjectMetadata[] = [];
  let contentBatchBytes = 0n;
  async function estimateBatch(): Promise<void> {
    if (contentBatch.length === 0) return;
    const contents = await store.readMany(contentBatch);
    for (const [index, contentObject] of contentBatch.entries()) {
      for (const segmentKind of contentKinds.get(contentObject.id)!) {
        estimates.set(`${segmentKind}:${contentObject.id}`, estimateContextSegmentTokens({
          segmentKind, messageRole: null, contentObject, content: contents[index]
        }));
      }
    }
    contentBatch = [];
    contentBatchBytes = 0n;
  }
  for (const objectId of contentKinds.keys()) {
    const contentObject = await readMetadata(objectId);
    if (contentBatch.length >= FORK_READ_BATCH_SIZE
      || (contentBatch.length > 0 && contentBatchBytes + contentObject.byte_length > FORK_CONTENT_BATCH_BYTES)) {
      await estimateBatch();
    }
    // An individual large object is still supported, but never shares its batch with another.
    contentBatch.push(contentObject);
    contentBatchBytes += contentObject.byte_length;
  }
  await estimateBatch();
  return segmentRows.map(segment => ({ segmentId: id(segment.id), estimatedTokens: estimates.get(
    `${segment.segment_kind === 'message' ? 'message' : 'tool_pair'}:${id(segment.content_object_id)}`
  )! }));
}

/** Complete equality-filtered sets, with bounded first pages and the existing atomic overflow read. */
async function readForkLists(
  database: RuntimeDatabase,
  domain: string,
  column: string,
  rowIds: readonly string[]
): Promise<Map<string, DomainRow[]>> {
  const uniqueIds = [...new Set(rowIds)];
  const result = new Map<string, DomainRow[]>();
  for (let offset = 0; offset < uniqueIds.length; offset += FORK_READ_BATCH_SIZE) {
    const batch = uniqueIds.slice(offset, offset + FORK_READ_BATCH_SIZE);
    const barrier = await database.snapshot(batch.map(rowId => DOMAIN_REPOSITORIES.domain(domain).list({
      where: { [column]: rowId }, orderBy: { column: 'id', direction: 'asc' }, limit: FORK_LIST_FIRST_PAGE_SIZE
    })));
    for (const [index, rowId] of batch.entries()) {
      const first = barrier.snapshot[index];
      if (!Array.isArray(first)) throw new Error(`Child context fork read an invalid ${domain} set.`);
      result.set(rowId, first.length < FORK_LIST_FIRST_PAGE_SIZE ? first
        : await listAllDomainRows(database, domain, { [column]: rowId }));
    }
  }
  return result;
}

function id(value: unknown): string { return requirePhaseFId(value, 'Child context fork id'); }
