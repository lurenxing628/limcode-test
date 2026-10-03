import type Database from 'better-sqlite3';
import { type AttachmentProjectionScopeCache, type AttachmentScopeCandidate } from './attachmentProjectionScopeCache';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { prepareCached } from './runtimeStatementCache';
import { quote } from './runtimeSqlRows';
import {
  attachmentProjectionId,
  attachmentSourceOwnerScope,
  compareAttachmentSegmentSource,
  type AttachmentSourceOwnerEvidence
} from './attachmentProjectionEvidence';

export interface AttachmentProjectionSegmentSnapshot {
  segments: DomainRow[];
  sources: DomainRow[];
  messageRevisions: DomainRow[];
  memberships: DomainRow[];
  toolResults: DomainRow[];
  toolCalls: DomainRow[];
  turns: DomainRow[];
  compressionBlocks: DomainRow[];
  /** Metadata only; includes foreign evidence which was validated but not transferred. */
  examinedSourceCount: number;
}

export interface AttachmentProjectionLinksSnapshot {
  links: DomainRow[];
  attachments: DomainRow[];
}

const JOINS = [
  ['source', 'ContextSegmentSource'], ['revision', 'MessageRevision'],
  ['membership', 'MessagePartOfConversation'], ['result', 'ToolModelResult'],
  ['call', 'ToolCall'], ['turn_owner', 'Turn'], ['block', 'CompressionBlock']
] as const;

const SOURCE_JOIN_SQL = `SELECT ${JOINS.map(([alias, domain]) => columns(alias, domain)).join(', ')}
  FROM context_segment_source AS source
  LEFT JOIN message_revision AS revision ON source.source_kind = 'message_revision' AND revision.id = source.source_id
  LEFT JOIN message_part_of_conversation AS membership ON membership.message_id = revision.message_id
  LEFT JOIN tool_model_result AS result ON source.source_kind = 'tool_model_result' AND result.id = source.source_id
  LEFT JOIN tool_call AS call ON call.id = CASE source.source_kind
    WHEN 'tool_call' THEN source.source_id WHEN 'tool_model_result' THEN result.tool_call_id ELSE NULL END
  LEFT JOIN turn AS turn_owner ON turn_owner.id = call.turn_id
  LEFT JOIN compression_block AS block ON source.source_kind = 'compression_block' AND block.id = source.source_id`;
const SOURCE_SQL = `${SOURCE_JOIN_SQL} WHERE source.segment_id IN (SELECT value FROM json_each(@ids))`;
const SOURCE_PK_SQL = `${SOURCE_JOIN_SQL} WHERE source.id IN (SELECT value FROM json_each(@ids))`;

const LINKS_SQL = `SELECT ${columns('link', 'AttachmentLink')}, ${columns('attachment', 'Attachment')}
  FROM attachment_link AS link
  LEFT JOIN attachment AS attachment ON attachment.id = link.attachment_id
  WHERE link.message_revision_id IN (SELECT value FROM json_each(@ids))`;

/**
 * The caller holds a fenced SQLite read transaction. A miss consumes and validates the COMPLETE
 * source set, including foreign aliases beyond any page limit. A worker-owned certificate may
 * reuse only that complete scope proof; selected rows and all attachment relationships stay fresh.
 */
export function readAttachmentProjectionSegments(
  database: Database.Database,
  conversationIdInput: string,
  segmentIdsInput: readonly string[],
  cache?: AttachmentProjectionScopeCache
): AttachmentProjectionSegmentSnapshot {
  const conversationId = attachmentProjectionId(conversationIdInput, 'conversationId');
  const ids = selectors(segmentIdsInput, 64, 'segmentIds');
  const segmentIds = JSON.parse(ids) as string[];
  const snapshot: AttachmentProjectionSegmentSnapshot = {
    segments: [], sources: [], messageRevisions: [], memberships: [], toolResults: [], toolCalls: [],
    turns: [], compressionBlocks: [], examinedSourceCount: 0
  };
  const segments = prepareCached(database,
    'SELECT * FROM context_segment WHERE id IN (SELECT value FROM json_each(@ids))').iterate({ ids });
  for (const row of segments) snapshot.segments.push(DOMAIN_REPOSITORIES.domain('ContextSegment').codec.decode(row as DomainRow));
  const existingSegments = new Set(snapshot.segments.map(row => String(row.id)));
  const bySegment = new Map<string, DomainRow[]>(segmentIds.map(id => [id, []]));
  const selected = new Set<DomainRow>();
  const membershipIds = new Map<string, string>();
  const retained = new Map<string, Map<string, DomainRow>>();
  const candidates = new Map<string, AttachmentScopeCandidate>();
  const fullSegments: string[] = [];
  const hitSegments: string[] = [];
  const expectedSources = new Map<string, string>();
  const remember = (key: keyof AttachmentProjectionSegmentSnapshot, row: DomainRow | undefined): void => {
    if (!row) return;
    let rows = retained.get(key); if (!rows) retained.set(key, rows = new Map());
    rows.set(String(row.id), row);
  };
  let fallback = false;
  try {
    for (const segmentId of segmentIds) {
      const routed = cache?.selectedSourceIds(segmentId, conversationId);
      if (routed !== undefined && existingSegments.has(segmentId)) {
        hitSegments.push(segmentId);
        for (const id of routed) expectedSources.set(id, segmentId);
      } else {
        fullSegments.push(segmentId);
        const candidate = existingSegments.has(segmentId) ? cache?.candidate(segmentId) : undefined;
        if (candidate) candidates.set(segmentId, candidate);
      }
    }
    const consume = (joined: DomainRow, cached: boolean): void => {
      const source = decode(joined, 'source', 'ContextSegmentSource')!;
      snapshot.examinedSourceCount++;
      const segmentId = attachmentProjectionId(source.segment_id, 'ContextSegmentSource.segment_id');
      let sources = bySegment.get(segmentId); if (!sources) bySegment.set(segmentId, sources = []);
      sources.push(source);
      const owner: AttachmentSourceOwnerEvidence = {
        messageRevision: decode(joined, 'revision', 'MessageRevision'), memberships: [],
        toolResult: decode(joined, 'result', 'ToolModelResult'),
        toolCall: decode(joined, 'call', 'ToolCall'), turn: decode(joined, 'turn_owner', 'Turn'),
        compressionBlock: decode(joined, 'block', 'CompressionBlock')
      };
      const membership = decode(joined, 'membership', 'MessagePartOfConversation');
      if (membership) owner.memberships!.push(membership);
      // Preserve exact SQL identities and the existing trimmed-reference normalization contract.
      normalizeOwnerReferences(database, source, owner);
      for (const membership of owner.memberships ?? []) {
        const messageId = attachmentProjectionId(membership.message_id, 'MessagePartOfConversation.message_id');
        const prior = membershipIds.get(messageId);
        if (prior !== undefined && prior !== membership.id) throw new Error(`Message ${messageId} belongs to multiple Conversations.`);
        membershipIds.set(messageId, String(membership.id));
      }
      if (source.source_kind === 'message_revision' && !owner.messageRevision) {
        throw new Error(`MessageRevision ${attachmentProjectionId(source.source_id, 'ContextSegmentSource.source_id')} does not exist.`);
      }
      const scope = attachmentSourceOwnerScope(source, owner);
      const belongs = scope === null || scope === conversationId;
      if (cached) {
        if (expectedSources.get(String(source.id)) !== segmentId || !belongs) fallback = true;
        expectedSources.delete(String(source.id));
      } else {
        const candidate = candidates.get(segmentId);
        // sort() never calls a comparator for one row. Such a row may keep baseline behavior,
        // but it must not establish a reusable proof without validating every comparator field.
        try { compareAttachmentSegmentSource(source, source); }
        catch { candidate?.abort(); }
        candidate?.add(String(source.id), scope);
      }
      if (!belongs) return;
      selected.add(source);
      remember('messageRevisions', owner.messageRevision);
      for (const row of owner.memberships ?? []) remember('memberships', row);
      remember('toolResults', owner.toolResult); remember('toolCalls', owner.toolCall);
      remember('turns', owner.turn); remember('compressionBlocks', owner.compressionBlock);
    };
    if (fullSegments.length > 0) {
      for (const raw of prepareCached(database, SOURCE_SQL).iterate({ ids: JSON.stringify(fullSegments) })) {
        consume(raw as DomainRow, false);
      }
    }
    const sourceIds = [...expectedSources.keys()];
    for (let offset = 0; offset < sourceIds.length; offset += 128) {
      for (const raw of prepareCached(database, SOURCE_PK_SQL).iterate({ ids: JSON.stringify(sourceIds.slice(offset, offset + 128)) })) {
        consume(raw as DomainRow, true);
      }
    }
    if (fallback || expectedSources.size > 0) {
      // Never leak partial hit evidence into the retry. It uses the same already-established
      // SQLite snapshot and original complete reader, preserving its errors and authority.
      for (const candidate of candidates.values()) candidate.abort();
      for (const segmentId of hitSegments) cache?.evict(segmentId);
      cache?.fallback();
      return readAttachmentProjectionSegments(database, conversationId, segmentIds);
    }
    for (const sources of bySegment.values()) {
      sources.sort(compareAttachmentSegmentSource);
      snapshot.sources.push(...sources.filter(source => selected.has(source)));
    }
    for (const [key, rows] of retained) (snapshot[key as keyof typeof snapshot] as DomainRow[]) = [...rows.values()];
    for (const candidate of candidates.values()) candidate.publish();
    return snapshot;
  } finally {
    for (const candidate of candidates.values()) candidate.abort();
  }
}

/** Fresh relationship query for each independently timed projection, including an empty result. */
export function readAttachmentProjectionLinks(
  database: Database.Database,
  revisionIds: readonly string[]
): AttachmentProjectionLinksSnapshot {
  const ids = selectors(revisionIds, 128, 'revisionIds');
  const links: DomainRow[] = [];
  const attachments = new Map<string, DomainRow>();
  for (const raw of prepareCached(database, LINKS_SQL).iterate({ ids })) {
    const joined = raw as DomainRow;
    const link = decode(joined, 'link', 'AttachmentLink')!;
    const attachmentId = attachmentProjectionId(link.attachment_id, 'AttachmentLink.attachment_id');
    const attachment = attachmentId === link.attachment_id
      ? decode(joined, 'attachment', 'Attachment')
      : get(database, 'Attachment', attachmentId);
    if (!attachment) throw new Error(`Attachment ${attachmentId} does not exist.`);
    links.push(link); attachments.set(attachmentId, attachment);
  }
  return { links, attachments: [...attachments.values()] };
}

function normalizeOwnerReferences(database: Database.Database, source: DomainRow, owner: AttachmentSourceOwnerEvidence): void {
  const kind = source.source_kind;
  if (!['message_revision', 'tool_call', 'tool_model_result', 'compression_block'].includes(String(kind))) return;
  const sourceId = attachmentProjectionId(source.source_id, 'ContextSegmentSource.source_id');
  if (sourceId !== source.source_id) {
    if (kind === 'message_revision') owner.messageRevision = get(database, 'MessageRevision', sourceId);
    if (kind === 'tool_call') owner.toolCall = get(database, 'ToolCall', sourceId);
    if (kind === 'tool_model_result') owner.toolResult = get(database, 'ToolModelResult', sourceId);
    if (kind === 'compression_block') owner.compressionBlock = get(database, 'CompressionBlock', sourceId);
  }
  if (kind === 'message_revision' && owner.messageRevision) {
    const messageId = attachmentProjectionId(owner.messageRevision.message_id, `MessageRevision ${sourceId}.message_id`);
    if (sourceId !== source.source_id || messageId !== owner.messageRevision.message_id) {
      owner.memberships = (prepareCached(database,
        'SELECT * FROM message_part_of_conversation WHERE message_id = ? ORDER BY id LIMIT 2').all(messageId) as DomainRow[])
        .map(row => DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').codec.decode(row));
    }
  }
  if (kind === 'tool_model_result' && owner.toolResult) {
    const callId = attachmentProjectionId(owner.toolResult.tool_call_id, `ToolModelResult ${sourceId}.tool_call_id`);
    if (sourceId !== source.source_id || callId !== owner.toolResult.tool_call_id) owner.toolCall = get(database, 'ToolCall', callId);
  }
  if ((kind === 'tool_call' || kind === 'tool_model_result') && owner.toolCall) {
    const turnId = attachmentProjectionId(owner.toolCall.turn_id, `ToolCall ${owner.toolCall.id}.turn_id`);
    if (sourceId !== source.source_id || owner.toolCall.id !== (kind === 'tool_call' ? source.source_id : owner.toolResult?.tool_call_id)
      || turnId !== owner.toolCall.turn_id) owner.turn = get(database, 'Turn', turnId);
  }
}

function selectors(input: readonly string[], limit: number, label: string): string {
  if (!Array.isArray(input) || input.length > limit) throw new RangeError(`${label} must contain at most ${limit} ids.`);
  return JSON.stringify([...new Set(input.map(value => attachmentProjectionId(value, label)))]);
}

function columns(alias: string, domain: string): string {
  return DOMAIN_REPOSITORIES.domain(domain).schema.columns
    .map(column => `${quote(alias)}.${quote(column.name)} AS ${quote(`${alias}_${column.name}`)}`).join(', ');
}

function decode(joined: DomainRow, alias: string, domain: string): DomainRow | undefined {
  if (joined[`${alias}_id`] === null) return undefined;
  const repository = DOMAIN_REPOSITORIES.domain(domain);
  const row: DomainRow = {};
  for (const column of repository.schema.columns) row[column.name] = joined[`${alias}_${column.name}`];
  return repository.codec.decode(row);
}

function get(database: Database.Database, domain: string, id: string): DomainRow | undefined {
  const repository = DOMAIN_REPOSITORIES.domain(domain);
  const row = prepareCached(database, `SELECT * FROM ${quote(repository.schema.table)} WHERE id = ?`).get(id);
  return row ? repository.codec.decode(row as DomainRow) : undefined;
}
