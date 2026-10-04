import Database from 'better-sqlite3';
import { CONTEXT_HANDLE_STATE_DOMAIN, conversationContextHandleStateId,
  importConversationContextHandleStateSteps } from './conversationContextHandleState';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';
import { RuntimeDataInvariantError } from './runtimeDataInvariant';
import { RUNTIME_DOMAIN_SCHEMA_BY_KEY } from './schema/domainManifest';

export interface MergeContextHandleStateUpdate { before: DomainRow; after: DomainRow }

const PAGE = 64;
const TOUCHED = 'limcode_merge_context_handle_owners';
const SEGMENTS = 'limcode_merge_context_handle_segments';

/** Imports contribute evidence, never another database's derived handle authority. The bounded
 * TEMP sets contain only inserted evidence. Each owner's exact selected root is checked against
 * those occurrences before demoting its pointer, in the same transaction as the evidence inserts.
 * Metadata-only scope checks never read historical CAS or demote an unrelated discarded branch. */
export class MergeContextHandleStates {
  private readonly scratch = new Database(':memory:');
  private closed = false;

  public constructor(private readonly source: Database.Database, private readonly target: RuntimeDatabase,
    private readonly kept: (domain: string, id: string) => boolean = () => true) {
    try {
      this.scratch.pragma('temp_store = FILE');
      this.scratch.pragma('temp.cache_size = -1024');
      this.scratch.exec(`CREATE TEMP TABLE ${TOUCHED} (id TEXT PRIMARY KEY, evidence_at TEXT NOT NULL,
        force_seed INTEGER NOT NULL) WITHOUT ROWID;
        CREATE TEMP TABLE ${SEGMENTS} (conversation_id TEXT NOT NULL, segment_id TEXT NOT NULL,
          PRIMARY KEY (conversation_id, segment_id)) WITHOUT ROWID`);
    } catch (error) { this.close(); throw error; }
  }

  public touch(domain: string, row: DomainRow): void {
    const evidenceAt = String(row.updated_at ?? row.created_at);
    const owner = (conversationId: unknown, force = false): void => {
      if (typeof conversationId !== 'string' || !this.kept('Conversation', conversationId)) return;
      this.scratch.prepare(`INSERT INTO temp.${TOUCHED} VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET evidence_at = MAX(evidence_at, excluded.evidence_at),
          force_seed = MAX(force_seed, excluded.force_seed)`).run(conversationId, evidenceAt, force ? 1 : 0);
    };
    const segment = (conversationId: unknown, segmentId: unknown): void => {
      if (typeof conversationId !== 'string' || typeof segmentId !== 'string'
        || !this.kept('Conversation', conversationId)) return;
      owner(conversationId);
      this.scratch.prepare(`INSERT OR IGNORE INTO temp.${SEGMENTS} VALUES (?, ?)`).run(conversationId, segmentId);
    };
    const requestOwner = (requestId: unknown): unknown => this.source.prepare(`SELECT owner.conversation_id
      FROM model_request AS request JOIN turn AS owner ON owner.id = request.turn_id WHERE request.id = ?`)
      .pluck().get(requestId);
    const messageSegments = (conversationId: unknown, messageId: unknown): void => {
      for (const source of this.source.prepare(`SELECT source.segment_id FROM context_segment_source AS source
        JOIN message_revision AS revision ON revision.id = source.source_id
        WHERE source.source_kind = 'message_revision' AND revision.message_id = ?`).all(messageId) as DomainRow[]) {
        segment(conversationId, source.segment_id);
      }
    };
    const toolSegments = (toolCallId: unknown): void => {
      const conversationId = this.source.prepare(`SELECT owner.conversation_id FROM tool_call AS tool
        JOIN turn AS owner ON owner.id = tool.turn_id WHERE tool.id = ?`).pluck().get(toolCallId);
      for (const source of this.source.prepare(`SELECT segment_id FROM context_segment_source
        WHERE source_kind = 'tool_call' AND source_id = ?`).all(toolCallId) as DomainRow[]) segment(conversationId, source.segment_id);
    };
    const requestSegments = (requestId: unknown): void => {
      const conversationId = requestOwner(requestId);
      for (const link of this.source.prepare('SELECT message_id FROM model_request_message_link WHERE model_request_id = ?')
        .all(requestId) as DomainRow[]) messageSegments(conversationId, link.message_id);
      for (const link of this.source.prepare('SELECT tool_call_id FROM tool_call_source_link WHERE model_request_id = ?')
        .all(requestId) as DomainRow[]) toolSegments(link.tool_call_id);
      for (const block of this.source.prepare(`SELECT block.id FROM compression_block AS block
        JOIN model_request AS request ON request.authority_snapshot_id = block.authority_snapshot_id
        WHERE request.id = ? AND block.conversation_id = ?`).all(requestId, conversationId) as DomainRow[]) blockSegments(block.id);
    };
    const blockSegments = (blockId: unknown): void => {
      const conversationId = this.source.prepare('SELECT conversation_id FROM compression_block WHERE id = ?').pluck().get(blockId);
      for (const source of this.source.prepare(`SELECT segment_id FROM context_segment_source
        WHERE source_kind = 'compression_block' AND source_id = ?`).all(blockId) as DomainRow[]) segment(conversationId, source.segment_id);
    };
    if (domain === 'Conversation') owner(row.id, true);
    else if (domain === 'ConversationContextHeadLink') owner(row.conversation_id, true);
    else if (domain === 'ModelRequest') requestSegments(row.id);
    else if (domain === 'ModelRequestMessageLink') messageSegments(requestOwner(row.model_request_id), row.message_id);
    else if (domain === 'ToolCallSourceLink') {
      toolSegments(row.tool_call_id);
      messageSegments(requestOwner(row.model_request_id), row.message_id);
    } else if (domain === 'MessagePartOfConversation') messageSegments(row.conversation_id, row.message_id);
    else if (domain === 'MessageRevision') {
      for (const member of this.source.prepare('SELECT conversation_id FROM message_part_of_conversation WHERE message_id = ?')
        .all(row.message_id) as DomainRow[]) messageSegments(member.conversation_id, row.message_id);
    } else if (domain === 'ToolModelResult') toolSegments(row.tool_call_id);
    else if (domain === 'ToolCallEvent' && row.event_kind === 'native_child_handle_projection') toolSegments(row.tool_call_id);
    else if (domain === 'CompressionBlock') blockSegments(row.id);
    else if (domain === 'CompressionBlockSource') blockSegments(row.compression_block_id);
    else if (domain === 'ModelContextProjection') {
      if (row.owner_kind === 'conversation_handle_catalog') owner(row.owner_id, true);
      else if (row.owner_kind === 'model_request') requestSegments(row.owner_id);
      else if (row.owner_kind === 'compression_block') blockSegments(row.owner_id);
    } else if (domain === 'ContextSegmentSource') {
      if (row.source_kind === 'message_revision') {
        for (const member of this.source.prepare(`SELECT member.conversation_id FROM message_revision AS revision
          JOIN message_part_of_conversation AS member ON member.message_id = revision.message_id WHERE revision.id = ?`)
          .all(row.source_id) as DomainRow[]) segment(member.conversation_id, row.segment_id);
      } else if (row.source_kind === 'tool_call') toolSegments(row.source_id);
      else if (row.source_kind === 'tool_model_result') {
        const tool = this.source.prepare('SELECT tool_call_id FROM tool_model_result WHERE id = ?').pluck().get(row.source_id);
        if (tool) toolSegments(tool);
      } else if (row.source_kind === 'compression_block') blockSegments(row.source_id);
    }
  }

  /** Append bounded pages after all evidence inserts, before the source transaction commits. */
  public async append(consume: (steps: RepositoryTransactionStep[], updates: MergeContextHandleStateUpdate[]) => void | Promise<void>, signal?: AbortSignal): Promise<void> {
    const repository = DOMAIN_REPOSITORIES.domain(CONTEXT_HANDLE_STATE_DOMAIN);
    for (let after = ''; ;) {
      signal?.throwIfAborted();
      const page = this.scratch.prepare(`SELECT id, evidence_at, force_seed FROM temp.${TOUCHED} WHERE id > ? ORDER BY id LIMIT ${PAGE}`)
        .all(after) as Array<{ id: string; evidence_at: string; force_seed: number }>;
      if (page.length === 0) return;
      const current = (await this.target.snapshot(page.map(({ id }) => repository.get(conversationContextHandleStateId(id)))))
        .snapshot as Array<DomainRow | null>;
      const steps: RepositoryTransactionStep[] = [];
      const updates: MergeContextHandleStateUpdate[] = [];
      for (const [index, { id, evidence_at, force_seed }] of page.entries()) {
        signal?.throwIfAborted();
        const previous = current[index];
        const heads = await this.rows('ConversationContextHeadLink', { conversation_id: id });
        if (heads.length > 1) throw new RuntimeDataInvariantError(CONTEXT_HANDLE_STATE_DOMAIN, id, 'Imported Context head is not unique.');
        const rootId = heads[0]?.root_id ?? null;
        const affectsCurrent = Boolean(force_seed) || (rootId !== null && await this.affectsRoot(id, String(rootId), signal));
        const now = previous && String(previous.updated_at) > evidence_at ? String(previous.updated_at) : evidence_at;
        const transition = importConversationContextHandleStateSteps(id, now, previous ?? undefined, rootId as string | null, affectsCurrent);
        if (previous) {
          // Relocation recovery journals complete before/after images. Fence every old field,
          // including timestamps, so those images describe precisely what the writer changes.
          const { id: stateId, ...expected } = previous;
          steps.push(repository.assert(String(stateId), expected));
          for (const step of transition) if (step.kind === 'update') {
            updates.push({ before: previous, after: { ...previous, ...step.patch } });
          }
        }
        steps.push(...transition);
      }
      signal?.throwIfAborted();
      if (steps.length > 0) await consume(steps, updates);
      after = page[page.length - 1]!.id;
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  /** Effective target + kept source metadata, including rows appended but not yet committed in
   * streamed imports. Existing target identity always wins; ordinary merge conflict checks fence it. */
  private async get(domain: string, id: string): Promise<DomainRow | undefined> {
    const value = (await this.target.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)])).snapshot[0];
    if (value && !Array.isArray(value)) return value;
    if (!this.kept(domain, id)) return undefined;
    const schema = RUNTIME_DOMAIN_SCHEMA_BY_KEY.get(domain)!;
    const raw = this.source.prepare(`SELECT * FROM "${schema.table}" WHERE id = ?`).get(id);
    return raw ? DOMAIN_REPOSITORIES.codec(domain).decode(raw as Record<string, unknown>) : undefined;
  }

  private async rows(domain: string, where: DomainRow): Promise<DomainRow[]> {
    const repository = DOMAIN_REPOSITORIES.domain(domain);
    const target = (await this.target.snapshotAll(repository.list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: PAGE }))).snapshot;
    const schema = RUNTIME_DOMAIN_SCHEMA_BY_KEY.get(domain)!;
    const values = Object.entries(where);
    const source = this.source.prepare(`SELECT * FROM "${schema.table}" WHERE ${values.map(([key]) => `"${key}" = ?`).join(' AND ')}`)
      .all(...values.map(([, value]) => value)) as Record<string, unknown>[];
    const combined = new Map(target.map(row => [String(row.id), row]));
    for (const row of source) if (this.kept(domain, String(row.id)) && !combined.has(String(row.id))) {
      combined.set(String(row.id), repository.codec.decode(row));
    }
    return [...combined.values()];
  }

  private async affectsRoot(conversationId: string, rootId: string, signal?: AbortSignal): Promise<boolean> {
    const root = await this.get('ContextSequenceRoot', rootId);
    if (!root || root.conversation_id !== conversationId) throw new RuntimeDataInvariantError(
      CONTEXT_HANDLE_STATE_DOMAIN, conversationId, 'Imported handle scope has no correctly owned Context root.');
    const pending: string[] = [];
    const chain = async (nodeId: unknown, count: bigint): Promise<void> => {
      for (let left = count; left > 0n; left--) {
        signal?.throwIfAborted();
        if (typeof nodeId !== 'string') throw new Error('Imported Context root chain is incomplete.');
        const node = await this.get('ContextSequenceNode', nodeId);
        if (!node) throw new Error('Imported Context root node is missing.');
        pending.push(String(node.segment_id)); nodeId = node.parent_node_id;
      }
    };
    const tailCount = BigInt(String(root.tail_segment_count));
    await chain(root.root_node_id, BigInt(String(root.segment_count)) - tailCount);
    await chain(root.tail_node_id, tailCount);
    const seen = new Set<string>();
    while (pending.length > 0) {
      signal?.throwIfAborted();
      const segmentId = pending.pop()!;
      if (seen.has(segmentId)) continue;
      seen.add(segmentId);
      if (this.scratch.prepare(`SELECT 1 FROM temp.${SEGMENTS} WHERE conversation_id = ? AND segment_id = ?`)
        .get(conversationId, segmentId)) return true;
      const segment = await this.get('ContextSegment', segmentId);
      if (segment?.segment_kind !== 'compression') continue;
      const sources = await this.rows('ContextSegmentSource', { segment_id: segmentId });
      for (const source of sources) {
        if (source.source_kind !== 'compression_block') continue;
        const block = await this.get('CompressionBlock', String(source.source_id));
        if (block?.conversation_id !== conversationId) continue;
        for (const child of await this.rows('CompressionBlockSource', { compression_block_id: block.id })) pending.push(String(child.segment_id));
      }
    }
    return false;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.scratch.close();
  }
}
