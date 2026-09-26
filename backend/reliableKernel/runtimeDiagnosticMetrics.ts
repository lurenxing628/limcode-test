import * as fs from 'node:fs/promises';
import { endianness } from 'node:os';
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
const WAL_SAMPLE_INTERVAL_MS = 60 * 1_000;
const WAL_REPORT_INTERVAL_MS = 5 * 60 * 1_000;
/** Twice SQLite's default wal_autocheckpoint: frames still waiting mean checkpoints are starved. */
const WAL_PENDING_ALERT_FRAMES = 2_000;
/** WAL-index header: two 48-byte WalIndexHdr copies followed by WalCkptInfo.nBackfill. */
const WAL_INDEX_HEADER_BYTES = 100;

export interface RuntimeWalSample {
  walBytes: number;
  walFrames?: number;
  checkpointedFrames?: number;
  pendingFrames?: number;
}

/**
 * Production sink for RuntimePerformanceMetricEvent. It converts hot-path timings into bounded
 * diagnostic rollups (windowed histograms and totals) and a few rate-limited anomaly events:
 * SQLITE_BUSY / locked failures and slow writer-lock waits or holds. It also samples the WAL
 * size and checkpoint backlog from the file system, outside every SQLite lock.
 *
 * Recording runs synchronously on the caller's thread and only updates in-memory counters; the
 * journal persists asynchronously. It never changes Runtime behavior.
 */
export class RuntimeDiagnosticMetrics implements RuntimePerformanceMetricsSink {
  private readonly anomalyBudgets = new Map<string, { windowStartedAtMs: number; count: number }>();
  private walTimer: NodeJS.Timeout | undefined;
  private walSample: Promise<void> | undefined;
  private lastWalReportAtMs: number | undefined;
  private closed = false;

  public constructor(
    private readonly diagnostics: ReliableDiagnosticRollupObserver,
    private readonly binding: RootBinding,
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
      case 'terminal_prefix.scan':
        this.aggregate('terminal_prefix.scan', {}, event.durationMs);
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

  /** Reads the WAL size and the WAL-index checkpoint counters without taking any SQLite lock. */
  public async sampleWal(): Promise<RuntimeWalSample | undefined> {
    if (this.closed) return undefined;
    const databasePath = this.binding.paths.databasePath;
    const walBytes = await fileSize(`${databasePath}-wal`);
    const index = await readWalIndex(`${databasePath}-shm`);
    const sample: RuntimeWalSample = {
      walBytes,
      ...(index ? {
        walFrames: index.maxFrame,
        checkpointedFrames: index.backfilledFrames,
        pendingFrames: Math.max(0, index.maxFrame - index.backfilledFrames)
      } : {})
    };
    const nowMs = this.now();
    const due = this.lastWalReportAtMs === undefined || nowMs - this.lastWalReportAtMs >= WAL_REPORT_INTERVAL_MS;
    const starved = (sample.pendingFrames ?? 0) >= WAL_PENDING_ALERT_FRAMES;
    if (due || starved) {
      this.lastWalReportAtMs = nowMs;
      this.diagnostics.observe({
        eventKind: starved ? 'database.wal.checkpoint_lagging' : 'database.wal',
        scopeKind: 'runtime',
        metadata: { ...sample }
      });
    }
    return sample;
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
            ...location,
            reasonCode,
            ...(waitMs !== undefined ? { lockWaitMs: roundMs(waitMs) } : {}),
            elapsedMs: roundMs(event.roundTripDurationMs)
          }
        });
      }
      return;
    }
    if (
      ((waitMs ?? 0) >= SLOW_WRITE_LOCK_MS || (holdMs ?? 0) >= SLOW_WRITE_LOCK_MS)
      && this.takeAnomalyBudget('database.write_lock.slow')
    ) {
      this.diagnostics.observe({
        eventKind: 'database.write_lock.slow',
        scopeKind: 'runtime',
        metadata: {
          ...location,
          status: event.outcome,
          ...(waitMs !== undefined ? { lockWaitMs: roundMs(waitMs) } : {}),
          ...(holdMs !== undefined ? { holdMs: roundMs(holdMs) } : {}),
          ...(event.workerQueueWaitMs !== undefined ? { queueWaitMs: roundMs(event.workerQueueWaitMs) } : {})
        }
      });
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
      dimensions,
      ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs: Math.max(0, durationMs) } : {}),
      counters
    });
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

/**
 * Parses the documented WAL-index header (https://sqlite.org/walformat.html): mxFrame is the last
 * valid WAL frame and nBackfill the frames already copied into the database. The two header copies
 * must agree, otherwise a concurrent writer was updating it and this sample is skipped.
 */
async function readWalIndex(shmPath: string): Promise<{ maxFrame: number; backfilledFrames: number } | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(shmPath, 'r');
    const buffer = Buffer.alloc(WAL_INDEX_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, WAL_INDEX_HEADER_BYTES, 0);
    if (bytesRead < WAL_INDEX_HEADER_BYTES) return undefined;
    if (!buffer.subarray(0, 48).equals(buffer.subarray(48, 96)) || buffer[12] !== 1) return undefined;
    const readUInt32 = endianness() === 'LE'
      ? (offset: number) => buffer.readUInt32LE(offset)
      : (offset: number) => buffer.readUInt32BE(offset);
    const maxFrame = readUInt32(16);
    const backfilledFrames = readUInt32(96);
    if (backfilledFrames > maxFrame) return { maxFrame, backfilledFrames: maxFrame };
    return { maxFrame, backfilledFrames };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

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
