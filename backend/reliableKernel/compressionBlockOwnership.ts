import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import type { RuntimeDatabase } from './runtimeDatabase';

/**
 * A compression summary segment is immutable Context shared by Conversation forks, while each
 * Conversation that can reach it owns its own CompressionBlock over it (a fork copies the block).
 * Readers therefore select the block by Conversation: blocks of other Conversations, including
 * those removed with a deleted Conversation, are never used, and anything but exactly one owned
 * block fails closed.
 */
export async function resolveConversationCompressionBlock(
  database: RuntimeDatabase,
  segmentId: string,
  conversationId: string
): Promise<DomainRow> {
  const sources = await listAllDomainRows(database, 'ContextSegmentSource', { segment_id: segmentId });
  return selectConversationCompressionBlock(database, segmentId, conversationId, sources);
}

/** Same selection over an already complete ContextSegmentSource set of the summary segment. */
export async function selectConversationCompressionBlock(
  database: Pick<RuntimeDatabase, 'snapshot'>,
  segmentId: string,
  conversationId: string,
  sources: readonly DomainRow[]
): Promise<DomainRow> {
  if (sources.length === 0 || sources.some((source) =>
    source.source_kind !== 'compression_block' || source.source_revision !== 0n
  )) {
    throw new Error(`Compression segment ${segmentId} must only carry CompressionBlock sources.`);
  }
  const snapshot = await database.snapshot(sources.map((source) =>
    DOMAIN_REPOSITORIES.domain('CompressionBlock').get(requireId(source.source_id))
  ));
  const owned = snapshot.snapshot.filter((row): row is DomainRow =>
    !!row && typeof row === 'object' && !Array.isArray(row)
    && (row as DomainRow).conversation_id === conversationId
  );
  if (owned.length !== 1) {
    throw new Error(`Compression segment ${segmentId} has no unique CompressionBlock owned by Conversation ${conversationId}.`);
  }
  return owned[0];
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('ContextSegmentSource.source_id is invalid.');
  return value;
}
