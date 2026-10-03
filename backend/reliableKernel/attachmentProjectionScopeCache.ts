import type Database from 'better-sqlite3';
import type { DomainRow, RepositoryMutation } from './repositories';

export const ATTACHMENT_SCOPE_CACHE_MAX_BYTES = 96 * 1024 * 1024;
export const ATTACHMENT_SCOPE_CACHE_MAX_ENTRIES = 65_536;
export const ATTACHMENT_SCOPE_CACHE_MAX_SOURCES = 1_000_000;

interface ScopeRoutes { shared: string[]; conversations: Array<[string, string[]]> }
interface Certificate { bytes: Buffer; charge: number; sources: number }
export interface AttachmentScopeCacheLimits { bytes: number; entries: number; sources: number }
export interface AttachmentScopeCacheCounters {
  entries: number; bytes: number; sources: number; candidateBytes: number; peakChargedBytes: number;
  maxBytes: number; maxEntries: number; maxSources: number;
  hits: number; misses: number; admissions: number; bypasses: number; invalidations: number;
  externalInvalidations: number; snapshotRaces: number; fallbacks: number;
}

/**
 * Complete source-SCOPE proofs, owned by one database worker. This is not a cache of selected
 * owners, compression lineage, attachment relationships, or model-facing results. Exact raw
 * source PKs and owner Conversation ids are packed as ordinary JSON in an unpooled Buffer.
 *
 * Admitted entries stay protected until invalidated. At capacity a scan bypasses admission,
 * rather than evicting the prefix it will need on its next sweep. The byte charge includes the
 * packed allocation, a conservative entry/key allowance, and all in-progress builders. Limits
 * are storage limits only: an overlarge source set is still completely read and validated.
 */
export class AttachmentProjectionScopeCache {
  private readonly entries = new Map<string, Certificate>();
  private readonly candidates = new Set<AttachmentScopeCandidate>();
  private bytes = 0;
  private sources = 0;
  private candidateBytes = 0;
  private candidateSources = 0;
  private peakChargedBytes = 0;
  private externalVersion: bigint | undefined;
  private hits = 0;
  private misses = 0;
  private admissions = 0;
  private bypasses = 0;
  private invalidations = 0;
  private externalInvalidations = 0;
  private snapshotRaces = 0;
  private fallbacks = 0;

  public constructor(private readonly limits: AttachmentScopeCacheLimits = {
    bytes: ATTACHMENT_SCOPE_CACHE_MAX_BYTES,
    entries: ATTACHMENT_SCOPE_CACHE_MAX_ENTRIES,
    sources: ATTACHMENT_SCOPE_CACHE_MAX_SOURCES
  }) {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Attachment scope cache limits must be positive safe integers.');
    }
  }

  /** Both values must come from this worker's writer, around the reader's first actual read. */
  public synchronizeSnapshot(before: bigint, after: bigint): boolean {
    if (before !== after) {
      this.clear();
      this.externalVersion = undefined;
      this.snapshotRaces++;
      return false;
    }
    if (this.externalVersion !== after) {
      this.clear();
      this.externalVersion = after;
      this.externalInvalidations++;
    }
    return true;
  }

  public selectedSourceIds(segmentId: string, conversationId: string): string[] | undefined {
    const entry = this.entries.get(segmentId);
    if (!entry) { this.misses++; return undefined; }
    this.hits++;
    const routes = JSON.parse(entry.bytes.toString('utf8')) as ScopeRoutes;
    const selected = routes.conversations.find(([owner]) => owner === conversationId)?.[1] ?? [];
    return [...routes.shared, ...selected];
  }

  public candidate(segmentId: string): AttachmentScopeCandidate | undefined {
    const charge = entryCharge(segmentId) + 256; // Empty JSON framing and stringify scratch too.
    if (this.entries.size + this.candidates.size >= this.limits.entries || !this.reserve(charge, 0)) {
      this.bypasses++;
      return undefined;
    }
    const candidate = new AttachmentScopeCandidate(this, segmentId, charge);
    this.candidates.add(candidate);
    return candidate;
  }

  public evict(segmentId: string): void {
    const entry = this.entries.get(segmentId);
    if (!entry) return;
    this.entries.delete(segmentId);
    this.bytes -= entry.charge;
    this.sources -= entry.sources;
    this.invalidations++;
  }

  public clear(): void {
    if (this.entries.size > 0) this.invalidations++;
    this.entries.clear();
    this.bytes = this.sources = 0;
    for (const candidate of [...this.candidates]) candidate.abort();
  }

  public fallback(): void { this.fallbacks++; }

  /** Called at the real generic mutation boundary; rollback never resurrects an old proof. */
  public beforeMutation(mutation: RepositoryMutation, encodedInsert?: DomainRow): void {
    if (!SCOPE_DOMAINS.has(mutation.domain) && !REVIEWED_DISJOINT_DOMAINS.has(mutation.domain)) {
      this.clear();
      return;
    }
    if (mutation.kind === 'insert') {
      if (mutation.domain === 'ContextSegmentSource') {
        const segmentId = encodedInsert?.segment_id ?? mutation.row.segment_id;
        if (typeof segmentId === 'string') {
          const key = segmentId.trim();
          // SQLite receives UTF-8: a lone UTF-16 surrogate becomes U+FFFD before its FK lookup.
          this.evict(/[\uD800-\uDFFF]/.test(key) ? Buffer.from(key).toString('utf8') : key);
        }
        else this.clear();
      }
      return;
    }
    if (mutation.kind === 'update') {
      const allowed = mutation.domain === 'ToolCall' ? ['status', 'updated_at']
        : mutation.domain === 'Turn' ? ['status', 'updated_at', 'terminal_at']
          : mutation.domain === 'CompressionBlock' ? ['status', 'updated_at']
            : mutation.domain === 'Message' ? ['created_at', 'updated_at', 'deleted_at']
              : mutation.domain === 'Conversation' ? ['title', 'status', 'created_at', 'updated_at'] : undefined;
      if (allowed && Object.keys(mutation.patch).some(key => !allowed.includes(key))) this.clear();
      else if (!allowed && SCOPE_DOMAINS.has(mutation.domain)) this.clear();
      return;
    }
    if (SCOPE_DOMAINS.has(mutation.domain)) this.clear();
  }

  public inspect(): AttachmentScopeCacheCounters {
    return {
      entries: this.entries.size, bytes: this.bytes, sources: this.sources,
      candidateBytes: this.candidateBytes, peakChargedBytes: this.peakChargedBytes,
      maxBytes: this.limits.bytes, maxEntries: this.limits.entries, maxSources: this.limits.sources,
      hits: this.hits, misses: this.misses, admissions: this.admissions, bypasses: this.bypasses,
      invalidations: this.invalidations, externalInvalidations: this.externalInvalidations,
      snapshotRaces: this.snapshotRaces, fallbacks: this.fallbacks
    };
  }

  /** Builder reservations also cover JSON stringification and the temporary packed Buffer. */
  public reserve(bytes: number, sources: number): boolean {
    if (this.bytes + this.candidateBytes + bytes > this.limits.bytes
      || this.sources + this.candidateSources + sources > this.limits.sources) return false;
    this.candidateBytes += bytes;
    this.candidateSources += sources;
    this.peakChargedBytes = Math.max(this.peakChargedBytes, this.bytes + this.candidateBytes);
    return true;
  }

  public finish(candidate: AttachmentScopeCandidate, packed?: Buffer): void {
    if (!this.candidates.delete(candidate)) return;
    this.candidateBytes -= candidate.charge;
    this.candidateSources -= candidate.sources;
    if (!packed) { this.bypasses++; return; }
    const charge = entryCharge(candidate.segmentId) + packed.byteLength;
    // The builder reserved more than the final entry needs, including the packed allocation.
    if (charge > candidate.charge) throw new Error('Attachment scope certificate exceeded its reserved byte charge.');
    this.evict(candidate.segmentId);
    this.entries.set(candidate.segmentId, { bytes: packed, charge, sources: candidate.sources });
    this.bytes += charge;
    this.sources += candidate.sources;
    this.admissions++;
  }
}

/** Includes the current CASCADE ancestors, even where today's Repository is insert-only. */
const SCOPE_DOMAINS = new Set([
  'Conversation', 'ContentObject', 'Message', 'ContextSegment', 'ContextSegmentSource',
  'MessageRevision', 'MessagePartOfConversation', 'ToolCall', 'ToolModelResult', 'Turn', 'CompressionBlock'
]);

// Explicitly reviewed disjoint domains. Additions default to invalidation until their writes
// and CASCADE edges have been checked against the source-owner graph.
const REVIEWED_DISJOINT_DOMAINS = new Set([
  'AgentConversationLink', 'AnswerBridge', 'AnswerPayload',
  'AnswerSubmission', 'Attachment', 'AttachmentLink',
  'AttachmentObservationLink', 'Attempt', 'AuthoritySnapshot',
  'ChildExecution', 'ChildExecutionActiveTurnLink', 'ChildExecutionIntentLink',
  'ChildExecutionParentLink', 'ChildExecutionTurnLink', 'ChildInterruptionIntentLink',
  'ChildInterruptionLineageLink', 'ChildInterruptionProcessCleanup', 'ChildInterruptionRequest',
  'ChildInterruptionTurnLink', 'CollaborationBoardChannel', 'CollaborationBoardChannelScopeLink',
  'CollaborationBoardCommandReceipt', 'CollaborationBoardPost', 'CollaborationBoardPostChannelLink',
  'CollaborationBoardPostSourceLink', 'CollaborationBoardReplyLink', 'CollaborationBoardSubscriptionLink',
  'CollaborationBudget', 'CollaborationMessage', 'CollaborationMessagePayloadLink',
  'CollaborationMessageReplyLink', 'CollaborationMessageSourceLink', 'CollaborationMessageTargetLink',
  'CollaborationRequest', 'CollaborationRequestTurnLink', 'CommandReceipt',
  'CompressionBlockObservationLink', 'CompressionBlockSource', 'ContextSequenceNode',
  'ContextSequenceRoot', 'ConversationAttachmentHandleLink', 'ConversationBranchLink',
  'ConversationContextHeadLink', 'ConversationOriginLink', 'ConversationProjectLink',
  'ConversationReuseLink', 'EffectIntent', 'EffectReceipt',
  'ExecutionLease', 'FileChangeDecision', 'FileChangeSet',
  'FileChangeSetMember', 'FileMutationReceipt', 'FileMutationReceiptMember',
  'InteractionOwnerLink', 'InteractionRequest', 'InteractionResponse',
  'InteractionToolCallLink', 'MessageCurrentRevisionLink', 'MessageTurnLink',
  'ModelContextProjection', 'ModelRequest', 'ModelRequestMessageLink',
  'ModelStreamCheckpoint', 'ModelStreamFence', 'Operation',
  'OperationResolution', 'OutcomePause', 'PendingTurnInput',
  'Process', 'ProcessCompletionDispatch', 'ProcessCompletionSourceLink',
  'ProcessOriginLink', 'ProcessOutputChunk', 'ProcessReceipt',
  'ProjectContext', 'RuntimeDelivery', 'RuntimeDeliveryInputLink',
  'RuntimeDeliveryIntentLink', 'RuntimeDeliveryWake', 'RuntimeInboxItem',
  'RuntimeInboxPayloadLink', 'ToolCallEvent', 'ToolCallPolicySnapshot',
  'ToolCallSourceLink', 'ToolExecution', 'ToolOutcome',
  'ToolResultArtifact', 'TurnExecutionPresetRevision', 'TurnExecutorLink',
  'TurnFinalOutputFence', 'TurnIntent', 'TurnIntentAuthorityRevision',
  'TurnIntentExecutorLink', 'TurnIntentRevision', 'TurnTermination',
]);

function entryCharge(segmentId: string): number { return 512 + 2 * segmentId.length; }

export class AttachmentScopeCandidate {
  private readonly shared: string[] = [];
  private readonly conversations = new Map<string, string[]>();
  private open = true;
  public sources = 0;
  public constructor(
    private readonly cache: AttachmentProjectionScopeCache,
    public readonly segmentId: string,
    public charge: number
  ) {}

  public add(rawSourceId: string, scope: string | null | undefined): void {
    if (!this.open) return;
    if (scope === undefined) { this.abort(); return; }
    // JSON escaping needs at most six code units per input code unit. The factor includes the
    // transient UTF-16 JSON, UTF-8 Buffer, retained strings, arrays, and map slots together.
    const charge = 256 + 24 * rawSourceId.length
      + (scope !== null && !this.conversations.has(scope) ? 256 + 24 * scope.length : 0);
    if (!this.cache.reserve(charge, 1)) { this.abort(); return; }
    this.charge += charge;
    this.sources++;
    if (scope === null) this.shared.push(rawSourceId);
    else {
      let sources = this.conversations.get(scope);
      if (!sources) this.conversations.set(scope, sources = []);
      sources.push(rawSourceId);
    }
  }

  public publish(): void {
    if (!this.open) return;
    const routes: ScopeRoutes = { shared: this.shared, conversations: [...this.conversations] };
    const json = JSON.stringify(routes);
    // No small-Buffer slab retention: the cache owns exactly this backing allocation.
    const packed = Buffer.allocUnsafeSlow(Buffer.byteLength(json));
    packed.write(json);
    this.open = false;
    this.cache.finish(this, packed);
    this.shared.length = 0;
    this.conversations.clear();
  }

  public abort(): void {
    if (!this.open) return;
    this.open = false;
    this.cache.finish(this);
    this.shared.length = 0;
    this.conversations.clear();
  }
}

/** The RootBinding read is inside the transaction, so BEGIN alone is never mistaken for a snapshot. */
export function readAttachmentScopeSnapshot<T>(
  reader: Database.Database,
  writer: Database.Database,
  cache: AttachmentProjectionScopeCache,
  establishFencedSnapshot: () => void,
  read: (cache: AttachmentProjectionScopeCache | undefined) => T
): T {
  const before = BigInt(writer.pragma('data_version', { simple: true }) as number | bigint);
  return reader.transaction(() => {
    establishFencedSnapshot();
    const after = BigInt(writer.pragma('data_version', { simple: true }) as number | bigint);
    return read(cache.synchronizeSnapshot(before, after) ? cache : undefined);
  })();
}
