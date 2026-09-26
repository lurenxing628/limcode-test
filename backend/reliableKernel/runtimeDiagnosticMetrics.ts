import * as fs from 'node:fs/promises';
import type { RootBinding } from './contracts';
import type { ReliableDiagnosticRollupObserver } from './diagnosticJournal';
import type {
  RuntimePerformanceMetricEvent,
  RuntimePerformanceMetricsSink
} from './runtimePerformanceMetrics';

/** Writer lock waits or holds at least this long are also persisted individually. */
export const SLOW_WRITE_LOCK_MS = 250;
/** Individually persisted anomalies of one kind per window; the rollup still counts every sample. */
const ANOMALY_EVENTS_PER_WINDOW = 20;
const ANOMALY_WINDOW_MS = 5 * 60 * 1_000;
/** An anomaly persists the open rollup window at most this often, so a storm cannot flood the journal. */
const ANOMALY_ROLLUP_FLUSH_INTERVAL_MS = 60 * 1_000;
const WAL_SAMPLE_INTERVAL_MS = 60 * 1_000;
const WAL_REPORT_INTERVAL_MS = 5 * 60 * 1_000;
/**
 * The WAL file is never truncated here (no journal_size_limit), so its size is a high-water mark:
 * it only grows past about 4 MiB (the default 1000-page auto-checkpoint) when checkpoints cannot
 * restart the log, typically because a long-lived reader pins it.
 */
export const WAL_GROWTH_ALERT_BYTES = 16 * 1_048_576;

export interface RuntimeWalSample {
  walBytes: number;
}

/**
 * Production sink for RuntimePerformanceMetricEvent. It converts hot-path timings into bounded
 * diagnostic rollups (windowed histograms and totals) and a few rate-limited anomaly events:
 * SQLITE_BUSY / locked failures and slow writer-lock waits or holds. Every rollup and anomaly carries
 * the Host boot id, because several Hosts append to one data root's journal.
 *
 * WAL sampling only stat()s the -wal file. It must never open, read or close limcode.sqlite, its
 * -wal or its -shm in this process: SQLite's unix VFS holds POSIX fcntl locks on them (writer lock,
 * reader marks, DMS), and closing ANY descriptor of such a file drops every lock the process holds
 * on it, letting another Host overwrite a transaction in flight.
 *
 * Recording runs synchronously on the caller's thread and only updates in-memory counters; the
 * journal persists asynchronously. It never changes Runtime behavior.
 */
export class RuntimeDiagnosticMetrics implements RuntimePerformanceMetricsSink {
  private readonly anomalyBudgets = new Map<string, { windowStartedAtMs: number; count: number }>();
  private walTimer: NodeJS.Timeout | undefined;
  private walSample: Promise<void> | undefined;
  private lastWalReportAtMs: number | undefined;
  private lastWalBytes: number | undefined;
  private lastAnomalyRollupFlushAtMs: number | undefined;
  private closed = false;

  public constructor(
    private readonly diagnostics: ReliableDiagnosticRollupObserver,
    private readonly binding: Pick<RootBinding, 'paths'>,
    private readonly hostBootId: string,
    private readonly now: () => number = () => Date.now()
  ) {}

  public start(intervalMs = WAL_SAMPLE_INTERVAL_MS): void {
    if (this.closed || this.walTimer) return;
    this.walTimer = setInterval(() => {
      if (this.walSample) return;
      this.walSample = this.sampleWal().then(() => undefined, () => undefined).finally(() => {
        this.walSample = undefined;
      });
    }, intervalMs);
    this.walTimer.unref();
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.walTimer) clearInterval(this.walTimer);
    this.walTimer = undefined;
    await this.walSample;
  }

  public record(event: RuntimePerformanceMetricEvent): void {
    if (this.closed) return;
    switch (event.kind) {
      case 'database.request':
        if (event.phase === 'finished') this.recordDatabaseRequest(event);
        return;
      case 'database.root_validate':
        this.aggregate('database.root_validate', { status: event.outcome }, event.durationMs);
        return;
      case 'database.commit_listeners':
        this.aggregate('database.commit_listeners', {}, event.durationMs);
        return;
      case 'cas.prepare':
        this.aggregate('cas.prepare', { operation: event.operation }, event.durationMs, {
          publishes: event.publishes,
          tempWrites: event.tempWrites,
          fileFsyncs: event.fileFsyncs,
          directoryFsyncs: event.directoryFsyncs,
          lookupHits: event.lookupHits,
          lookupMisses: event.lookupMisses
        });
        return;
      case 'client_feed.snapshot':
        this.aggregate('feed.snapshot', { reasonCode: event.reason }, event.durationMs, { bytes: event.bytes });
        return;
      case 'client_feed.external_change':
        this.aggregate('feed.external_change', {}, undefined, { sessionCount: event.sessionCount });
        return;
      case 'client_feed.sync_listener':
        this.aggregate('feed.sync_listener', { kind: event.listenerKind }, event.durationMs);
        return;
      case 'provider.stream_event':
        this.aggregate('provider.stream_event', { kind: event.eventKind, checkpointed: event.checkpointed },
          event.durationMs, { transactionCount: event.transactionCount });
        return;
      case 'context.materialize':
        this.aggregate('context.materialize', { mode: event.mode }, event.durationMs, { segmentCount: event.segmentCount });
        return;
      case 'process.phase':
        this.aggregate('process.phase', { stage: event.phase }, event.durationMs,
          event.byteCount !== undefined ? { bytes: event.byteCount } : {});
        return;
      case 'tool.lifecycle':
        // Absolute milestones, not durations; the Agent lifecycle journal already records them.
        return;
    }
  }

  /** stat() only: reports the WAL high-water size and alerts while it keeps growing past the bound. */
  public async sampleWal(): Promise<RuntimeWalSample | undefined> {
    if (this.closed) return undefined;
    const walBytes = await fileSize(`${this.binding.paths.databasePath}-wal`);
    const previousBytes = this.lastWalBytes;
    this.lastWalBytes = walBytes;
    const nowMs = this.now();
    const due = this.lastWalReportAtMs === undefined || nowMs - this.lastWalReportAtMs >= WAL_REPORT_INTERVAL_MS;
    const growing = walBytes >= WAL_GROWTH_ALERT_BYTES && previousBytes !== undefined && walBytes > previousBytes;
    if (due || growing) {
      this.lastWalReportAtMs = nowMs;
      this.diagnostics.observe({
        eventKind: growing ? 'database.wal.growing' : 'database.wal',
        scopeKind: 'runtime',
        metadata: { hostBootId: this.hostBootId, walBytes }
      });
      if (growing) this.flushRollupsForAnomaly();
    }
    return { walBytes };
  }

  private recordDatabaseRequest(event: Extract<RuntimePerformanceMetricEvent, { kind: 'database.request'; phase: 'finished' }>): void {
    const requestKind = event.requestKind;
    this.aggregate('database.request', { requestKind, status: event.outcome }, event.roundTripDurationMs, {
      ...(event.workerExecuteDurationMs !== undefined ? { executeMs: event.workerExecuteDurationMs } : {}),
      ...(event.workerQueueWaitMs !== undefined ? { queueWaitMs: event.workerQueueWaitMs } : {})
    });
    if (event.workerQueueWaitMs !== undefined) {
      this.aggregate('database.queue_wait', {}, event.workerQueueWaitMs);
    }
    const waitMs = event.writeLockWaitMs;
    const holdMs = event.writeLockHoldMs;
    if (waitMs !== undefined) this.aggregate('database.write_lock_wait', { requestKind }, waitMs);
    if (holdMs !== undefined && event.writeLockStage !== 'begin') {
      this.aggregate('database.write_lock_hold', { requestKind }, holdMs);
    }
    const busy = event.databaseLocked === true
      || (event.sqliteErrorCode !== undefined && /^SQLITE_(?:BUSY|LOCKED)/.test(event.sqliteErrorCode));
    const location = {
      requestKind,
      ...(event.writeLockStage ? { stage: event.writeLockStage } : {}),
      ...(event.writeDomain ? { domain: event.writeDomain } : {})
    };
    if (busy) {
      const reasonCode = event.sqliteErrorCode ?? 'database_locked';
      this.aggregate('database.busy', { ...location, reasonCode }, waitMs);
      if (this.takeAnomalyBudget('database.busy')) {
        this.diagnostics.observe({
          eventKind: 'database.busy',
          scopeKind: 'runtime',
          metadata: {
            hostBootId: this.hostBootId,
            ...location,
            reasonCode,
            ...(waitMs !== undefined ? { lockWaitMs: roundMs(waitMs) } : {}),
            elapsedMs: roundMs(event.roundTripDurationMs)
          }
        });
      }
      this.flushRollupsForAnomaly();
      return;
    }
    if ((waitMs ?? 0) >= SLOW_WRITE_LOCK_MS || (holdMs ?? 0) >= SLOW_WRITE_LOCK_MS) {
      if (this.takeAnomalyBudget('database.write_lock.slow')) {
        this.diagnostics.observe({
          eventKind: 'database.write_lock.slow',
          scopeKind: 'runtime',
          metadata: {
            hostBootId: this.hostBootId,
            ...location,
            status: event.outcome,
            ...(waitMs !== undefined ? { lockWaitMs: roundMs(waitMs) } : {}),
            ...(holdMs !== undefined ? { holdMs: roundMs(holdMs) } : {}),
            ...(event.workerQueueWaitMs !== undefined ? { queueWaitMs: roundMs(event.workerQueueWaitMs) } : {})
          }
        });
      }
      this.flushRollupsForAnomaly();
    }
  }

  private aggregate(
    eventKind: string,
    dimensions: Record<string, string | boolean>,
    durationMs: number | undefined,
    counters: Record<string, number> = {}
  ): void {
    this.diagnostics.aggregate({
      eventKind,
      scopeKind: 'runtime',
      dimensions: { hostBootId: this.hostBootId, ...dimensions },
      ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs: Math.max(0, durationMs) } : {}),
      counters
    });
  }

  /**
   * A rollup window lives in memory for up to five minutes. When an anomaly happens, persist the
   * surrounding window right away (at most once a minute) so a crash soon after cannot lose it.
   */
  private flushRollupsForAnomaly(): void {
    const nowMs = this.now();
    if (
      this.lastAnomalyRollupFlushAtMs !== undefined
      && nowMs - this.lastAnomalyRollupFlushAtMs < ANOMALY_ROLLUP_FLUSH_INTERVAL_MS
    ) return;
    this.lastAnomalyRollupFlushAtMs = nowMs;
    this.diagnostics.emitAggregates();
  }

  private takeAnomalyBudget(kind: string): boolean {
    const nowMs = this.now();
    const budget = this.anomalyBudgets.get(kind);
    if (!budget || nowMs - budget.windowStartedAtMs >= ANOMALY_WINDOW_MS) {
      this.anomalyBudgets.set(kind, { windowStartedAtMs: nowMs, count: 1 });
      return true;
    }
    if (budget.count >= ANOMALY_EVENTS_PER_WINDOW) return false;
    budget.count += 1;
    return true;
  }
}

/** stat() never opens a descriptor, so it cannot drop SQLite's POSIX locks on the file. */
async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return 0;
  }
}

function roundMs(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
