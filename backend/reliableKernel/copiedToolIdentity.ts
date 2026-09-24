import type Database from 'better-sqlite3';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryRead } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';

/**
 * A Conversation fork copies ToolCall rows under new ids while the immutable result content is
 * shared, so a copied ToolResultArtifact still names the ToolCall that originally produced it.
 * The original and each copy own exactly one `tool_call` ContextSegmentSource on the same
 * immutable tool segment at the same call_seq. That fact identifies the copy at any fork depth and
 * stays valid after the source Conversation is deleted, because Context segments and their
 * sources are never removed with a Conversation.
 */
export interface ToolArtifactClaim {
  /** The ToolCall id recorded inside the durable artifact body. */
  claimedId: unknown;
  /** The ToolCall row that owns the artifact in the current Conversation. */
  call: DomainRow;
}

export async function toolArtifactIdentifiesCall(
  database: RuntimeDatabase,
  claimedId: unknown,
  call: DomainRow
): Promise<boolean> {
  return (await toolArtifactsIdentifyCalls(database, [{ claimedId, call }])).identified[0];
}

/** Batched form: at most one snapshot for every claim that is not already a direct match. */
export async function toolArtifactsIdentifyCalls(
  database: RuntimeDatabase,
  claims: readonly ToolArtifactClaim[]
): Promise<{ identified: boolean[]; snapshotCommitSeq?: string }> {
  const identified = claims.map((claim) => claim.claimedId === requireId(claim.call.id, 'ToolCall.id'));
  const pending = claims.flatMap((claim, index) =>
    !identified[index] && typeof claim.claimedId === 'string' && claim.claimedId.length > 0
      ? [{ index, claimedId: claim.claimedId, call: claim.call }]
      : []);
  if (pending.length === 0) return { identified };
  const barrier = await database.snapshot(pending.flatMap(({ claimedId, call }) =>
    copiedToolIdentityReads(claimedId, requireId(call.id, 'ToolCall.id'))));
  pending.forEach(({ index, call }, offset) => {
    identified[index] = copiedToolSourcesIdentifyCall({
      claimedSources: requireRows(barrier.snapshot[offset * 2]),
      callSources: requireRows(barrier.snapshot[offset * 2 + 1]),
      callSeq: requireBigInt(call.call_seq, 'ToolCall.call_seq')
    });
  });
  return { identified, snapshotCommitSeq: barrier.snapshotCommitSeq };
}

/**
 * The same rule over the database worker's connection, for the client projection that runs inside
 * a read transaction there. Rows keep SQLite integers as bigint (defaultSafeIntegers).
 */
export function toolArtifactIdentifiesCallInWorker(
  database: Database.Database,
  claimedId: unknown,
  call: DomainRow
): boolean {
  const toolCallId = requireId(call.id, 'ToolCall.id');
  if (claimedId === toolCallId) return true;
  if (typeof claimedId !== 'string' || claimedId.length === 0) return false;
  const sources = database.prepare(`
    SELECT source_kind, segment_id, source_revision
      FROM context_segment_source
     WHERE source_kind = 'tool_call' AND source_id = ?
     LIMIT 2
  `);
  return copiedToolSourcesIdentifyCall({
    claimedSources: sources.all(claimedId) as DomainRow[],
    callSources: sources.all(toolCallId) as DomainRow[],
    callSeq: requireBigInt(call.call_seq, 'ToolCall.call_seq')
  });
}

function copiedToolIdentityReads(claimedId: string, toolCallId: string): RepositoryRead[] {
  return [claimedId, toolCallId].map((sourceId) => DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
    where: { source_kind: 'tool_call', source_id: sourceId },
    limit: 2
  }));
}

function copiedToolSourcesIdentifyCall(input: {
  claimedSources: readonly DomainRow[];
  callSources: readonly DomainRow[];
  callSeq: bigint;
}): boolean {
  if (input.claimedSources.length !== 1 || input.callSources.length !== 1) return false;
  const [claimed] = input.claimedSources;
  const [current] = input.callSources;
  return claimed.source_kind === 'tool_call'
    && current.source_kind === 'tool_call'
    && typeof claimed.segment_id === 'string'
    && claimed.segment_id === current.segment_id
    && claimed.source_revision === input.callSeq
    && current.source_revision === input.callSeq;
}

function requireRows(value: DomainRow | DomainRow[] | null | undefined): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError('ContextSegmentSource identity read did not return rows.');
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError(`${label} must remain a non-negative bigint.`);
  return value;
}
