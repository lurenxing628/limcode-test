import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import { ContextSequenceControlPlane } from './contextSequence';
import { estimateContextSegmentTokens } from './contextTokenEstimator';
import { prepareConversationForkSnapshot } from './conversationForkSnapshot';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { requirePhaseFId, stablePhaseFId } from './phaseFIdentity';
import type { RuntimeDatabase } from './runtimeDatabase';

export type ChildForkTurns = 'none' | 'all' | `${number}`;

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
 * Prepares history only: no Conversation, execution ownership, authority or child-control links.
 * The caller commits this plan with the new child and its new assignment in one transaction.
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
  }
): Promise<ChildContextForkPlan> {
  if (input.forkTurns === 'none') return { steps: [], segments: [] };
  const list = (domain: string, where: Record<string, string>) => listAllDomainRows(database, domain, where);
  const [heads, turns, memberships] = await Promise.all([
    list('ConversationContextHeadLink', { conversation_id: input.sourceConversationId }),
    list('Turn', { conversation_id: input.sourceConversationId }),
    list('MessagePartOfConversation', { conversation_id: input.sourceConversationId })
  ]);
  if (heads.length !== 1) throw new Error('Child context fork source must have exactly one Context head.');
  const context = new ContextSequenceControlPlane(database, store);
  const structure = await context.materializeStructure(id(heads[0].root_id));
  const membershipByMessage = new Map(memberships.map(row => [id(row.message_id), row]));
  const candidates: Array<{ turn: DomainRow; links: DomainRow[]; sequence: bigint }> = [];
  for (const turn of turns) {
    if (turn.status !== 'terminated') continue;
    const [terminations, links] = await Promise.all([
      list('TurnTermination', { turn_id: id(turn.id) }), list('MessageTurnLink', { turn_id: id(turn.id) })
    ]);
    // A cancelled or failed turn can contain unfinished native calls. It is not forkable history.
    if (terminations.length !== 1 || terminations[0].terminal_status !== 'completed') continue;
    const sequences = links.map(link => membershipByMessage.get(id(link.message_id)))
      .filter((row): row is DomainRow => row !== undefined).map(row => BigInt(String(row.message_seq)));
    if (sequences.length > 0) candidates.push({ turn, links, sequence: sequences.reduce((a, b) => a < b ? a : b) });
  }
  candidates.sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : id(a.turn.id).localeCompare(id(b.turn.id)));
  const completedTurns = new Set(candidates.map(item => id(item.turn.id)));
  const turnsByMessage = new Map<string, Set<string>>();
  for (const item of candidates) for (const link of item.links) {
    const messageId = id(link.message_id);
    const owners = turnsByMessage.get(messageId) ?? new Set<string>();
    owners.add(id(item.turn.id));
    turnsByMessage.set(messageId, owners);
  }
  const cache = new Map<string, DomainRow>();
  async function get(domain: string, rowId: string): Promise<DomainRow> {
    const key = `${domain}:${rowId}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const barrier = await database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(rowId)]);
    const row = barrier.snapshot[0];
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Child context fork missing ${key}.`);
    cache.set(key, row as DomainRow);
    return row as DomainRow;
  }
  const availableSegments: Array<{ row: DomainRow; turns: Set<string>; messages: Set<string> }> = [];
  const path = new Set<string>();
  async function visit(segment: DomainRow): Promise<void> {
    const segmentId = id(segment.id);
    if (path.has(segmentId)) throw new Error('Child context fork compression lineage contains a cycle.');
    path.add(segmentId);
    const sources = await list('ContextSegmentSource', { segment_id: segmentId });
    if (segment.segment_kind === 'compression') {
      if (sources.length !== 1 || sources[0].source_kind !== 'compression_block') {
        throw new Error('Child context fork compression source is ambiguous.');
      }
      const block = await get('CompressionBlock', id(sources[0].source_id));
      if (block.summary_object_id !== segment.content_object_id) throw new Error('Child context fork compression content is inconsistent.');
      const children = await list('CompressionBlockSource', { compression_block_id: id(block.id) });
      children.sort((a, b) => Number(BigInt(String(a.position)) - BigInt(String(b.position))));
      for (const [position, child] of children.entries()) {
        if (BigInt(String(child.position)) !== BigInt(position)) throw new Error('Child context fork compression order is invalid.');
        await visit(await get('ContextSegment', id(child.segment_id)));
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
          const call = source.source_kind === 'tool_call'
            ? await get('ToolCall', id(source.source_id))
            : await get('ToolCall', id((await get('ToolModelResult', id(source.source_id))).tool_call_id));
          if (completedTurns.has(id(call.turn_id))) {
            owners.add(id(call.turn_id));
            for (const sourceLink of await list('ToolCallSourceLink', { tool_call_id: id(call.id) })) {
              messages.add(id(sourceLink.message_id));
            }
          }
        }
      }
      if (owners.size > 0) availableSegments.push({ row: segment, turns: owners, messages });
    }
    // system and runtime_context belong to the source execution, not to reusable conversation history.
    path.delete(segmentId);
  }
  for (const record of structure.records) await visit(record.segment);
  const availableTurns = new Set(availableSegments.flatMap(segment => [...segment.turns]));
  const visibleCandidates = candidates.filter(candidate => availableTurns.has(id(candidate.turn.id)));
  const selected = input.forkTurns === 'all' ? visibleCandidates : visibleCandidates.slice(-Number(input.forkTurns));
  const selectedTurns = new Set(selected.map(item => id(item.turn.id)));
  const retained = availableSegments.filter(segment => [...segment.turns].some(turnId => selectedTurns.has(turnId)));
  const selectedMessages = new Set(retained.flatMap(segment => [...segment.messages]));
  const segmentRows = retained.map(segment => segment.row);
  const segmentIds = segmentRows.map(row => id(row.id));
  const boundary = memberships.reduce((maximum, row) => {
    const sequence = BigInt(String(row.message_seq));
    return sequence > maximum ? sequence : maximum;
  }, 0n);
  const snapshot = await prepareConversationForkSnapshot(database, {
    sourceConversationId: input.sourceConversationId,
    targetConversationId: input.targetConversationId,
    targetAgentId: input.targetAgentId,
    selectedMessageIds: selectedMessages,
    boundaryMessageSeq: boundary,
    contextSegmentIds: segmentIds,
    now: input.now
  });
  const copiedSources = new Map<string, string[]>();
  for (const step of snapshot.inserts) {
    if (step.kind !== 'insert' || step.domain !== 'ContextSegmentSource') continue;
    const segmentId = id(step.row.segment_id);
    const kinds = copiedSources.get(segmentId) ?? [];
    kinds.push(id(step.row.source_kind));
    copiedSources.set(segmentId, kinds);
  }
  for (const segment of segmentRows) {
    const kinds = copiedSources.get(id(segment.id)) ?? [];
    if (segment.segment_kind === 'message'
      ? kinds.length !== 1 || kinds[0] !== 'message_revision'
      : kinds.length === 0 || kinds.some(kind => kind !== 'tool_call' && kind !== 'tool_model_result')) {
      throw new Error('Child context fork cannot copy the selected current transcript provenance.');
    }
  }
  const segments = [];
  for (const segment of segmentRows) {
    const contentObject = await get('ContentObject', id(segment.content_object_id)) as unknown as ContentObjectMetadata;
    const content = await store.read(contentObject);
    segments.push({ segmentId: id(segment.id), estimatedTokens: estimateContextSegmentTokens({
      segmentKind: segment.segment_kind === 'message' ? 'message' : 'tool_pair',
      messageRole: null, contentObject, content
    }) });
  }
  return {
    segments,
    steps: [
      DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').assert(id(heads[0].id), {
        conversation_id: input.sourceConversationId, root_id: heads[0].root_id
      }),
      ...snapshot.assertions,
      ...snapshot.inserts,
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

function id(value: unknown): string { return requirePhaseFId(value, 'Child context fork id'); }
