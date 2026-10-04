import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RootBinding } from './contracts';
import { RootAuthority } from './rootAuthority';

export type ReliableDiagnosticScopeKind =
  | 'runtime'
  | 'conversation'
  | 'turn'
  | 'model_request'
  | 'tool_call'
  | 'feed_session';

export interface ReliableDiagnosticEventInput {
  eventKind: string;
  scopeKind?: ReliableDiagnosticScopeKind;
  scopeId?: string;
  correlationId?: string;
  observedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ReliableDiagnosticEventRecord {
  schema: 'limcode-reliable-diagnostic';
  id: string;
  eventKind: string;
  scopeKind?: ReliableDiagnosticScopeKind;
  scopeId?: string;
  correlationId?: string;
  observedAt: string;
  metadata: Record<string, string | number | boolean | null>;
}

/**
 * One high-frequency sample folded into a bounded per-window summary instead of being persisted
 * individually. The rollup identity is eventKind + scope + dimensions; the persisted summary is
 * `${eventKind}.summary`. Dimension and counter keys must be allowlisted metadata keys.
 */
export interface ReliableDiagnosticSampleInput {
  eventKind: string;
  scopeKind?: ReliableDiagnosticScopeKind;
  scopeId?: string;
  dimensions?: Record<string, string | number | boolean>;
  /** Folded into fixed histogram buckets; the summary reports p50/p95 bucket bounds, max and total. */
  durationMs?: number;
  /** Summed across the window. */
  counters?: Record<string, number>;
}

export interface ReliableDiagnosticObserver {
  observe(event: ReliableDiagnosticEventInput): void;
  aggregate?(sample: ReliableDiagnosticSampleInput): void;
  /** Persists the open rollup window now instead of at its scheduled end. */
  emitAggregates?(): void;
}

export type ReliableDiagnosticRollupObserver = ReliableDiagnosticObserver
  & Required<Pick<ReliableDiagnosticObserver, 'aggregate' | 'emitAggregates'>>;

export function supportsDiagnosticRollup(
  observer: ReliableDiagnosticObserver | undefined
): observer is ReliableDiagnosticRollupObserver {
  return typeof observer?.aggregate === 'function' && typeof observer.emitAggregates === 'function';
}

export interface ReliableDiagnosticSpanRecord {
  kind: 'provider-first-paint' | 'feed-roundtrip' | 'diff-open';
  correlationId: string;
  milestones: Record<string, string>;
  startedAt?: string;
  completedAt?: string;
  elapsedMs?: number;
}

export interface ReliableDiagnosticJournalInspection {
  bounds: {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    maxPendingEvents: number;
    retentionMs: number;
    maxReturnedEvents: number;
    maxReturnedSpans: number;
    maxRollupKeys: number;
    rollupWindowMs: number;
  };
  state: {
    pendingEvents: number;
    droppedEvents: number;
    persistedEvents: number;
    rotations: number;
    rollupKeys: number;
    rolledUpSamples: number;
    lastFailureCode?: string;
  };
  events: ReliableDiagnosticEventRecord[];
  spans: ReliableDiagnosticSpanRecord[];
}

const DIAGNOSTIC_DIRECTORY = 'diagnostics';
const CURRENT_FILE = 'events.jsonl';
const MAX_FILES = 4;
const MAX_FILE_BYTES = 2 * 1_048_576;
const MAX_PENDING_EVENTS = 512;
const MAX_FLUSH_EVENTS = 128;
const MAX_RETURNED_EVENTS = 200;
const MAX_RETURNED_SPANS = 100;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const FLUSH_DELAY_MS = 750;
const MAX_METADATA_FIELDS = 16;
const MAX_METADATA_STRING_LENGTH = 192;
const MAX_ID_LENGTH = 256;
const ROLLUP_WINDOW_MS = 5 * 60 * 1_000;
const MAX_ROLLUP_KEYS = 256;
/** Summary fields added to every rollup: sampleCount, windowMs, p50Ms, p95Ms, maxMs, totalMs, histogramMs. */
const ROLLUP_SUMMARY_FIELDS = 7;
/** Upper bounds (ms) of the duration histogram; samples above the last bound fall into `inf`. */
const DURATION_BUCKET_BOUNDS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000];

const ALLOWED_METADATA_KEYS = new Set([
  'conversationId',
  'turnId',
  'modelRequestId',
  'toolCallId',
  'sessionId',
  'hostBootId',
  'messageSeq',
  'commitSeq',
  'streamSeq',
  'stage',
  'sessionKeyHash',
  'connectionGeneration',
  'connectionReused',
  'connectionReason',
  'mode',
  'timeoutPhase',
  'leaseGeneration',
  'leaseExpiresAt',
  'remainingMs',
  'renewalReason',
  'fullInputItemCount',
  'sentInputItemCount',
  'responseCreateFrameBytes',
  'responseCreateSeq',
  'kind',
  'status',
  'operation',
  'reasonCode',
  'errorName',
  'elapsedMs',
  'bytes',
  'changeCount',
  'memberCount',
  'scanned',
  'reconciled',
  'unchanged',
  'unknown',
  'round',
  'cacheEntries',
  'cacheBytes',
  'cacheHits',
  'cacheMisses',
  'cacheEvictions',
  'openTaskCount',
  'taskCardSha256',
  'activeChildCount',
  'runningProcessCount',
  'droppedEvents',
  'sampleCount',
  'windowMs',
  'p50Ms',
  'p95Ms',
  'maxMs',
  'totalMs',
  'histogramMs',
  'requestKind',
  'executeMs',
  'queueWaitMs',
  'lockWaitMs',
  'holdMs',
  'domain',
  'rawEventCount',
  'emittedEventCount',
  'toolDeltaEventCount',
  'deliveryKind',
  'headCount',
  'sessionCount',
  'publishes',
  'tempWrites',
  'fileFsyncs',
  'directoryFsyncs',
  'lookupHits',
  'lookupMisses',
  'transactionCount',
  'checkpointed',
  'segmentCount',
  'walBytes'
]);

interface DiagnosticRollup {
  eventKind: string;
  scopeKind?: ReliableDiagnosticScopeKind;
  scopeId?: string;
  dimensions: Record<string, string | number | boolean>;
  sampleCount: number;
  durationBuckets: number[];
  totalMs: number;
  maxMs: number;
  counters: Map<string, number>;
}

/**
 * Metadata-only rolling journal stored under the current fenced Runtime root.
 *
 * It is deliberately not a Runtime authority table: diagnostics must never advance domain state or
 * feed commitSeq. Every write revalidates the complete RootBinding, files are capped to 8 MiB total,
 * stale rotations are removed after seven days, and pending memory is bounded. Prompt/output/tool
 * arguments, credentials, headers, paths and arbitrary nested objects are rejected by construction.
 * High-frequency samples are folded into at most 256 in-memory rollups and persisted as one summary
 * per rollup every five minutes (and on inspect/close, or early when a Runtime anomaly is observed),
 * so rare events keep hours of history. A process killed mid-window loses that window's rollups.
 */
export class ReliableDiagnosticJournal implements ReliableDiagnosticRollupObserver {
  private readonly pending: ReliableDiagnosticEventRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushPromise: Promise<void> | undefined;
  private enqueuedEventSequence = 0;
  private settledEventSequence = 0;
  private closed = false;
  private droppedEvents = 0;
  private persistedEvents = 0;
  private rotations = 0;
  private lastFailureCode: string | undefined;
  private readonly rollups = new Map<string, DiagnosticRollup>();
  private rollupWindowStartedAtMs: number | undefined;
  private rollupTimer: ReturnType<typeof setTimeout> | undefined;
  private rolledUpSamples = 0;
  private readonly rollupWindowMs: number;

  public constructor(
    private readonly authority: RootAuthority,
    private readonly binding: RootBinding,
    private readonly now: () => Date = () => new Date(),
    options: { rollupWindowMs?: number } = {}
  ) {
    const windowMs = options.rollupWindowMs ?? ROLLUP_WINDOW_MS;
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
      throw new TypeError('Diagnostic rollupWindowMs must be a positive safe integer.');
    }
    this.rollupWindowMs = windowMs;
  }

  public observe(input: ReliableDiagnosticEventInput): void {
    if (this.closed) return;
    let event: ReliableDiagnosticEventRecord;
    try {
      event = normalizeEvent(input, this.now());
    } catch {
      this.droppedEvents += 1;
      return;
    }
    this.enqueue(event);
  }

  public aggregate(input: ReliableDiagnosticSampleInput): void {
    if (this.closed) return;
    let sample: ReturnType<typeof normalizeSample>;
    try {
      sample = normalizeSample(input);
    } catch {
      this.droppedEvents += 1;
      return;
    }
    let rollup = this.rollups.get(sample.key);
    if (!rollup) {
      // Bounded memory: a burst of distinct identities closes the current window early rather than
      // evicting (and silently losing) any rollup that already holds samples.
      if (this.rollups.size >= MAX_ROLLUP_KEYS) this.emitAggregates();
      rollup = {
        eventKind: sample.eventKind,
        ...(sample.scopeKind ? { scopeKind: sample.scopeKind } : {}),
        ...(sample.scopeId ? { scopeId: sample.scopeId } : {}),
        dimensions: sample.dimensions,
        sampleCount: 0,
        durationBuckets: new Array(DURATION_BUCKET_BOUNDS_MS.length + 1).fill(0),
        totalMs: 0,
        maxMs: 0,
        counters: new Map()
      };
      this.rollups.set(sample.key, rollup);
    }
    if (this.rollupWindowStartedAtMs === undefined) this.rollupWindowStartedAtMs = this.now().getTime();
    rollup.sampleCount += 1;
    this.rolledUpSamples += 1;
    if (sample.durationMs !== undefined) {
      rollup.durationBuckets[durationBucket(sample.durationMs)] += 1;
      rollup.totalMs += sample.durationMs;
      rollup.maxMs = Math.max(rollup.maxMs, sample.durationMs);
    }
    for (const [key, value] of Object.entries(sample.counters)) {
      rollup.counters.set(key, (rollup.counters.get(key) ?? 0) + value);
    }
    this.scheduleRollupEmit();
  }

  public async flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    this.clearFlushTimer();
    if (this.pending.length === 0) return;
    this.flushPromise = this.flushOnce().finally(() => {
      // Pending retains the newest contiguous suffix; everything before it has been persisted or
      // dropped, including pending events evicted while this batch was in flight.
      this.settledEventSequence = this.enqueuedEventSequence - this.pending.length;
      this.flushPromise = undefined;
      if (!this.closed && this.pending.length > 0) this.scheduleFlush();
    });
    return this.flushPromise;
  }

  public async inspect(input: { scopeId?: string; limit?: number } = {}): Promise<ReliableDiagnosticJournalInspection> {
    this.emitAggregates();
    const inspectThrough = this.enqueuedEventSequence;
    // Include already received events and rollups without waiting for a live producer to go quiet.
    while (this.settledEventSequence < inspectThrough) await this.flush();
    const limit = normalizeLimit(input.limit);
    const scopeId = input.scopeId?.trim();
    let events: ReliableDiagnosticEventRecord[] = [];
    try {
      await this.authority.validate(this.binding);
      events = await readJournalEvents(this.rootPath(), this.now().getTime() - RETENTION_MS);
      this.lastFailureCode = undefined;
    } catch (error) {
      this.lastFailureCode = errorCode(error);
    }
    if (scopeId) {
      events = events.filter((event) =>
        event.scopeId === scopeId
        || event.metadata.conversationId === scopeId
        || event.metadata.turnId === scopeId
        || event.metadata.modelRequestId === scopeId
        || event.metadata.toolCallId === scopeId
      );
    }
    events.sort((left, right) =>
      Date.parse(left.observedAt) - Date.parse(right.observedAt)
      || left.id.localeCompare(right.id)
    );
    return {
      bounds: {
        maxFiles: MAX_FILES,
        maxFileBytes: MAX_FILE_BYTES,
        maxTotalBytes: MAX_FILES * MAX_FILE_BYTES,
        maxPendingEvents: MAX_PENDING_EVENTS,
        retentionMs: RETENTION_MS,
        maxReturnedEvents: MAX_RETURNED_EVENTS,
        maxReturnedSpans: MAX_RETURNED_SPANS,
        maxRollupKeys: MAX_ROLLUP_KEYS,
        rollupWindowMs: this.rollupWindowMs
      },
      state: {
        pendingEvents: this.pending.length,
        droppedEvents: this.droppedEvents,
        persistedEvents: this.persistedEvents,
        rotations: this.rotations,
        rollupKeys: this.rollups.size,
        rolledUpSamples: this.rolledUpSamples,
        ...(this.lastFailureCode ? { lastFailureCode: this.lastFailureCode } : {})
      },
      events: events.slice(-limit),
      spans: buildDiagnosticSpans(events).slice(-MAX_RETURNED_SPANS)
    };
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.emitAggregates();
    this.closed = true;
    this.clearFlushTimer();
    while (this.flushPromise || this.pending.length > 0) await this.flush();
  }

  private async flushOnce(): Promise<void> {
    const batch = this.pending.splice(0, MAX_FLUSH_EVENTS);
    if (batch.length === 0) return;
    try {
      await this.authority.validate(this.binding);
      const root = this.rootPath();
      await fs.mkdir(root, { recursive: true });
      await pruneExpiredFiles(root, this.now().getTime() - RETENTION_MS);
      const bytes = Buffer.from(batch.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
      if (bytes.length > MAX_FILE_BYTES) throw new Error('diagnostic-batch-too-large');
      const current = path.join(root, CURRENT_FILE);
      const currentBytes = await fileSize(current);
      if (currentBytes + bytes.length > MAX_FILE_BYTES) {
        await rotateFiles(root);
        this.rotations += 1;
      }
      await fs.appendFile(current, bytes, { mode: 0o600 });
      this.persistedEvents += batch.length;
      this.lastFailureCode = undefined;
    } catch (error) {
      // Diagnostics are observational and must never become a second control path. Failed batches are
      // dropped rather than retried without bound; the inspector exposes only a redacted error code.
      this.droppedEvents += batch.length;
      this.lastFailureCode = errorCode(error);
    }
  }

  private enqueue(event: ReliableDiagnosticEventRecord): void {
    this.enqueuedEventSequence += 1;
    if (this.pending.length >= MAX_PENDING_EVENTS) {
      this.pending.shift();
      this.droppedEvents += 1;
    }
    this.pending.push(event);
    if (this.pending.length >= MAX_FLUSH_EVENTS) void this.flush();
    else this.scheduleFlush();
  }

  /** Persists one summary per non-empty rollup and starts a new window. */
  public emitAggregates(): void {
    if (this.closed) return;
    if (this.rollupTimer) clearTimeout(this.rollupTimer);
    this.rollupTimer = undefined;
    const startedAtMs = this.rollupWindowStartedAtMs;
    this.rollupWindowStartedAtMs = undefined;
    if (this.rollups.size === 0 || startedAtMs === undefined) return;
    const now = this.now();
    const windowMs = Math.max(0, now.getTime() - startedAtMs);
    const rollups = [...this.rollups.values()];
    this.rollups.clear();
    for (const rollup of rollups) {
      let event: ReliableDiagnosticEventRecord;
      try {
        event = normalizeEvent({
          eventKind: `${rollup.eventKind}.summary`,
          ...(rollup.scopeKind ? { scopeKind: rollup.scopeKind } : {}),
          ...(rollup.scopeId ? { scopeId: rollup.scopeId } : {}),
          metadata: rollupSummaryMetadata(rollup, windowMs)
        }, now);
      } catch {
        this.droppedEvents += 1;
        continue;
      }
      this.enqueue(event);
    }
  }

  private scheduleRollupEmit(): void {
    if (this.rollupTimer || this.closed) return;
    this.rollupTimer = setTimeout(() => {
      this.rollupTimer = undefined;
      this.emitAggregates();
    }, this.rollupWindowMs);
    this.rollupTimer.unref?.();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private rootPath(): string {
    return path.join(this.binding.paths.dataRootPath, DIAGNOSTIC_DIRECTORY);
  }
}

function normalizeEvent(input: ReliableDiagnosticEventInput, now: Date): ReliableDiagnosticEventRecord {
  const eventKind = normalizeToken(input.eventKind, 'eventKind', 96, /^[a-z][a-z0-9_.-]*$/);
  const scopeKind = input.scopeKind;
  if (scopeKind && !['runtime', 'conversation', 'turn', 'model_request', 'tool_call', 'feed_session'].includes(scopeKind)) {
    throw new TypeError('Diagnostic scopeKind is invalid.');
  }
  const scopeId = optionalId(input.scopeId, 'scopeId');
  const correlationId = optionalId(input.correlationId, 'correlationId');
  const observedAt = normalizeTimestamp(input.observedAt, now);
  const metadata: ReliableDiagnosticEventRecord['metadata'] = {};
  for (const [key, value] of Object.entries(input.metadata ?? {}).slice(0, MAX_METADATA_FIELDS)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) continue;
    const normalized = normalizeMetadataValue(value);
    if (normalized !== undefined) metadata[key] = normalized;
  }
  return {
    schema: 'limcode-reliable-diagnostic',
    id: `diagnostic-${randomUUID()}`,
    eventKind,
    ...(scopeKind ? { scopeKind } : {}),
    ...(scopeId ? { scopeId } : {}),
    ...(correlationId ? { correlationId } : {}),
    observedAt,
    metadata
  };
}

function normalizeSample(input: ReliableDiagnosticSampleInput): {
  key: string;
  eventKind: string;
  scopeKind?: ReliableDiagnosticScopeKind;
  scopeId?: string;
  dimensions: Record<string, string | number | boolean>;
  durationMs?: number;
  counters: Record<string, number>;
} {
  const eventKind = normalizeToken(input.eventKind, 'eventKind', 88, /^[a-z][a-z0-9_.-]*$/);
  const scopeKind = input.scopeKind;
  if (scopeKind && !['runtime', 'conversation', 'turn', 'model_request', 'tool_call', 'feed_session'].includes(scopeKind)) {
    throw new TypeError('Diagnostic scopeKind is invalid.');
  }
  const scopeId = optionalId(input.scopeId, 'scopeId');
  const dimensionEntries = Object.entries(input.dimensions ?? {});
  const counterEntries = Object.entries(input.counters ?? {});
  if (dimensionEntries.length + counterEntries.length > MAX_METADATA_FIELDS - ROLLUP_SUMMARY_FIELDS) {
    throw new TypeError('Diagnostic sample has too many fields.');
  }
  const dimensions: Record<string, string | number | boolean> = {};
  for (const [key, value] of dimensionEntries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!ALLOWED_METADATA_KEYS.has(key)) throw new TypeError('Diagnostic sample dimension is not allowlisted.');
    const normalized = normalizeMetadataValue(value);
    if (normalized === undefined || normalized === null) throw new TypeError('Diagnostic sample dimension is invalid.');
    dimensions[key] = normalized;
  }
  const counters: Record<string, number> = {};
  for (const [key, value] of counterEntries) {
    if (!ALLOWED_METADATA_KEYS.has(key) || key in dimensions) throw new TypeError('Diagnostic sample counter is not allowlisted.');
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Diagnostic sample counter must be finite.');
    counters[key] = value;
  }
  const durationMs = input.durationMs;
  if (durationMs !== undefined && (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0)) {
    throw new TypeError('Diagnostic sample durationMs must be a non-negative finite number.');
  }
  return {
    key: JSON.stringify([eventKind, scopeKind ?? null, scopeId ?? null, dimensions]),
    eventKind,
    ...(scopeKind ? { scopeKind } : {}),
    ...(scopeId ? { scopeId } : {}),
    dimensions,
    ...(durationMs !== undefined ? { durationMs } : {}),
    counters
  };
}

function durationBucket(durationMs: number): number {
  const index = DURATION_BUCKET_BOUNDS_MS.findIndex((bound) => durationMs <= bound);
  return index < 0 ? DURATION_BUCKET_BOUNDS_MS.length : index;
}

function rollupSummaryMetadata(rollup: DiagnosticRollup, windowMs: number): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    ...rollup.dimensions,
    sampleCount: rollup.sampleCount,
    windowMs
  };
  const durationCount = rollup.durationBuckets.reduce((sum, count) => sum + count, 0);
  if (durationCount > 0) {
    metadata.p50Ms = durationQuantile(rollup, durationCount, 0.5);
    metadata.p95Ms = durationQuantile(rollup, durationCount, 0.95);
    metadata.maxMs = roundMs(rollup.maxMs);
    metadata.totalMs = roundMs(rollup.totalMs);
    const histogram = rollup.durationBuckets
      .map((count, index) => count > 0 ? `${DURATION_BUCKET_BOUNDS_MS[index] ?? 'inf'}:${count}` : '')
      .filter(Boolean)
      .join(',');
    if (histogram.length <= MAX_METADATA_STRING_LENGTH) metadata.histogramMs = histogram;
  }
  for (const [key, value] of rollup.counters) metadata[key] = roundMs(value);
  return metadata;
}

/** Upper bound of the bucket holding the quantile, capped by the exact maximum. */
function durationQuantile(rollup: DiagnosticRollup, durationCount: number, quantile: number): number {
  const target = Math.max(1, Math.ceil(durationCount * quantile));
  let cumulative = 0;
  for (let index = 0; index < rollup.durationBuckets.length; index += 1) {
    cumulative += rollup.durationBuckets[index];
    if (cumulative >= target) {
      const bound = DURATION_BUCKET_BOUNDS_MS[index];
      return roundMs(bound === undefined ? rollup.maxMs : Math.min(bound, rollup.maxMs));
    }
  }
  return roundMs(rollup.maxMs);
}

function roundMs(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function buildDiagnosticSpans(events: ReliableDiagnosticEventRecord[]): ReliableDiagnosticSpanRecord[] {
  const spans = new Map<string, ReliableDiagnosticSpanRecord>();
  for (const event of events) {
    const providerRequestId = metadataText(event.metadata.modelRequestId)
      ?? (event.scopeKind === 'model_request' ? event.scopeId : undefined);
    if (
      providerRequestId
      && (
        (event.eventKind === 'agent.lifecycle' && event.metadata.stage === 'provider_dispatch_started')
        || event.eventKind === 'provider.transient.first_event'
        || event.eventKind === 'webview.transient.painted'
      )
    ) {
      const span = getSpan(spans, `provider:${providerRequestId}`, 'provider-first-paint', providerRequestId);
      if (event.eventKind === 'agent.lifecycle') span.milestones.dispatchStarted = event.observedAt;
      else if (event.eventKind === 'provider.transient.first_event') span.milestones.firstEvent = event.observedAt;
      else span.milestones.firstPaint = event.observedAt;
      continue;
    }
    if (
      event.scopeKind === 'feed_session'
      && event.scopeId
      && event.correlationId
      && ['feed.data.posted', 'feed.data.acked', 'feed.data.post_failed', 'webview.feed.painted'].includes(event.eventKind)
    ) {
      const correlationId = `${event.scopeId}:${event.correlationId}`;
      const span = getSpan(spans, `feed:${correlationId}`, 'feed-roundtrip', correlationId);
      if (event.eventKind === 'feed.data.posted') span.milestones.posted = event.observedAt;
      else if (event.eventKind === 'feed.data.acked') span.milestones.acked = event.observedAt;
      else if (event.eventKind === 'feed.data.post_failed') span.milestones.postFailed = event.observedAt;
      else span.milestones.painted = event.observedAt;
      continue;
    }
    if (event.scopeKind === 'tool_call' && event.scopeId && event.eventKind.startsWith('diff.')) {
      const span = getSpan(spans, `diff:${event.scopeId}`, 'diff-open', event.scopeId);
      if (event.eventKind === 'diff.open.requested') span.milestones.requested = event.observedAt;
      else if (event.eventKind === 'diff.cas.loaded') span.milestones.casLoaded = event.observedAt;
      else if (event.eventKind === 'diff.editor.shown') span.milestones.editorShown = event.observedAt;
      else if (event.eventKind === 'diff.open.failed') span.milestones.failed = event.observedAt;
    }
  }
  const result = [...spans.values()];
  for (const span of result) {
    const times = Object.values(span.milestones)
      .map((value) => ({ value, time: Date.parse(value) }))
      .filter((entry) => Number.isFinite(entry.time))
      .sort((left, right) => left.time - right.time);
    if (times.length === 0) continue;
    span.startedAt = times[0].value;
    if (times.length > 1) {
      span.completedAt = times[times.length - 1].value;
      span.elapsedMs = Math.max(0, times[times.length - 1].time - times[0].time);
    }
  }
  return result.sort((left, right) =>
    Date.parse(left.startedAt ?? '') - Date.parse(right.startedAt ?? '')
    || left.correlationId.localeCompare(right.correlationId)
  );
}

function getSpan(
  spans: Map<string, ReliableDiagnosticSpanRecord>,
  key: string,
  kind: ReliableDiagnosticSpanRecord['kind'],
  correlationId: string
): ReliableDiagnosticSpanRecord {
  const existing = spans.get(key);
  if (existing) return existing;
  const created: ReliableDiagnosticSpanRecord = { kind, correlationId, milestones: {} };
  spans.set(key, created);
  return created;
}

function metadataText(value: string | number | boolean | null | undefined): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function normalizeMetadataValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.slice(0, MAX_METADATA_STRING_LENGTH);
}

function normalizeTimestamp(value: string | undefined, fallback: Date): string {
  if (value === undefined) return fallback.toISOString();
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new TypeError('Diagnostic observedAt must be ISO-compatible.');
  return new Date(time).toISOString();
}

function optionalId(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  return normalizeToken(value, label, MAX_ID_LENGTH, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
}

function normalizeToken(value: string, label: string, maxLength: number, pattern: RegExp): string {
  if (typeof value !== 'string') throw new TypeError(`Diagnostic ${label} must be text.`);
  const text = value.trim();
  if (!text || text.length > maxLength || !pattern.test(text)) {
    throw new TypeError(`Diagnostic ${label} is invalid.`);
  }
  return text;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return MAX_RETURNED_EVENTS;
  if (!Number.isSafeInteger(value) || value <= 0) return MAX_RETURNED_EVENTS;
  return Math.min(value, MAX_RETURNED_EVENTS);
}

async function readJournalEvents(root: string, cutoffMs: number): Promise<ReliableDiagnosticEventRecord[]> {
  const result: ReliableDiagnosticEventRecord[] = [];
  for (let index = MAX_FILES - 1; index >= 0; index -= 1) {
    const file = journalFile(root, index);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as ReliableDiagnosticEventRecord;
        if (
          parsed?.schema === 'limcode-reliable-diagnostic'
          && typeof parsed.observedAt === 'string'
          && Date.parse(parsed.observedAt) >= cutoffMs
          && parsed.metadata !== null
          && typeof parsed.metadata === 'object'
          && !Array.isArray(parsed.metadata)
        ) result.push(parsed);
      } catch {
        // A torn final diagnostic line is non-authoritative and ignored.
      }
    }
  }
  return result;
}

async function pruneExpiredFiles(root: string, cutoffMs: number): Promise<void> {
  for (let index = 0; index < MAX_FILES; index += 1) {
    const file = journalFile(root, index);
    try {
      const stat = await fs.stat(file);
      if (stat.mtimeMs < cutoffMs) await fs.rm(file, { force: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

async function rotateFiles(root: string): Promise<void> {
  await fs.rm(journalFile(root, MAX_FILES - 1), { force: true });
  for (let index = MAX_FILES - 2; index >= 0; index -= 1) {
    try {
      await fs.rename(journalFile(root, index), journalFile(root, index + 1));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

function journalFile(root: string, index: number): string {
  return index === 0 ? path.join(root, CURRENT_FILE) : path.join(root, `events.${index}.jsonl`);
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)) return error.name;
  return 'diagnostic-write-failed';
}
