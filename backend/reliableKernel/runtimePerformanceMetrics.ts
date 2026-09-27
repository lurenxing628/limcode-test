/**
 * Metadata-only timing hooks for the reliable Runtime hot path.
 *
 * Callers must not add ids, command arguments, user/provider content, paths, credentials, or
 * serialized domain rows to these events. Benchmarks attach in-memory collectors; the product
 * attaches the bounded diagnostic rollup (runtimeDiagnosticMetrics.ts), which only keeps windowed
 * aggregates and rate-limited anomalies.
 */
export interface RuntimePerformanceMetricsSink {
  record(event: RuntimePerformanceMetricEvent): void;
}

export type RuntimeDatabaseMetricRequestKind =
  | 'transaction'
  | 'snapshot'
  | 'snapshotAll'
  | 'toolFactsSnapshot'
  | 'conversationChildTaskSnapshot'
  | 'processOutputRegistrationMismatches'
  | 'effectReceiptReconciliationCandidates'
  | 'childConversationOriginCandidates'
  | 'childProcessCleanupMaterializationCandidates'
  | 'contentUsage'
  | 'contextMaterialization'
  | 'contextContentMaterialization'
  | 'modelStreamEvent'
  | 'modelStreamActivity'
  | 'cancelCurrentModelRequest'
  | 'clientProjectionSnapshot'
  | 'clientKeysetPage'
  | 'conversationHistoryProjection'
  | 'externalDataVersion'
  | 'backupDatabase'
  | 'inspect'
  | 'close';

/** Why a bounded Client Feed session received a full snapshot instead of incremental changes. */
export type ClientFeedSnapshotReason =
  | 'initial'
  | 'client_request'
  | 'commit_scope'
  | 'task_candidate'
  | 'change_batch_limit'
  | 'queue_limit'
  | 'external_commit';

export type RuntimePerformanceMetricEvent =
  | {
      kind: 'database.root_validate';
      requestKind: RuntimeDatabaseMetricRequestKind | 'host_liveness';
      durationMs: number;
      outcome: 'ok' | 'error';
    }
  | {
      kind: 'database.request';
      phase: 'started';
      requestKind: RuntimeDatabaseMetricRequestKind;
    }
  | {
      kind: 'database.request';
      phase: 'finished';
      requestKind: RuntimeDatabaseMetricRequestKind;
      outcome: 'ok' | 'error';
      roundTripDurationMs: number;
      workerQueueWaitMs?: number;
      workerExecuteDurationMs?: number;
      /** BEGIN IMMEDIATE wait / lock hold of writer requests. */
      writeLockWaitMs?: number;
      writeLockHoldMs?: number;
      writeLockStage?: 'begin' | 'body' | 'commit' | 'committed';
      /** First mutated Repository domain (schema key) of a failed or measured transaction. */
      writeDomain?: string;
      /** SQLite result code of a failed request, e.g. SQLITE_BUSY. */
      sqliteErrorCode?: string;
      /** The failure reported SQLite's "database is locked" condition. */
      databaseLocked?: boolean;
    }
  | {
      kind: 'database.commit_listeners';
      listenerCount: number;
      durationMs: number;
    }
  | {
      kind: 'cas.prepare';
      operation: 'prepare' | 'prepare_batch';
      lookupHits: number;
      lookupMisses: number;
      publishes: number;
      tempWrites: number;
      fileFsyncs: number;
      directoryFsyncs: number;
      durationMs: number;
    }
  | {
      kind: 'provider.stream_event';
      eventKind: 'output_delta' | 'output_item_done' | 'partial_summary' | 'terminal_summary' | 'other';
      checkpointed: boolean;
      transactionCount: number;
      durationMs: number;
    }
  | {
      kind: 'tool.lifecycle';
      phase:
        | 'provider_terminal'
        | 'capability_start'
        | 'capability_end'
        | 'tool_model_result_commit'
        | 'context_tool_pair_commit'
        | 'next_provider_dispatch';
      atMs: number;
      callCount?: number;
    }
  | {
      kind: 'context.materialize';
      mode: 'structure' | 'content';
      segmentCount: number;
      durationMs: number;
    }
  | {
      kind: 'client_feed.sync_listener';
      listenerKind: 'database_commit' | 'feed_projection' | 'sidebar_projection';
      listenerCount: number;
      durationMs: number;
    }
  | {
      kind: 'client_feed.snapshot';
      reason: ClientFeedSnapshotReason;
      bytes: number;
      durationMs: number;
    }
  | {
      kind: 'client_feed.external_change';
      sessionCount: number;
    }
  | {
      kind: 'process.phase';
      phase: 'spawn' | 'identity_ready' | 'output_import' | 'terminal_receipt';
      durationMs: number;
      byteCount?: number;
    };

/** Metrics must never be allowed to change Runtime behavior. */
export function recordRuntimePerformanceMetric(
  sink: RuntimePerformanceMetricsSink | undefined,
  event: RuntimePerformanceMetricEvent
): void {
  if (!sink) return;
  try {
    sink.record(event);
  } catch {
    // A development observer is diagnostic only and must not fence or fail durable work.
  }
}

/** Bounded in-memory collector intended for repeatable local benchmarks and focused tests. */
export class RuntimePerformanceMetricCollector implements RuntimePerformanceMetricsSink {
  private readonly events: RuntimePerformanceMetricEvent[] = [];
  private dropped = 0;

  public constructor(private readonly maxEvents = 100_000) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents <= 0) {
      throw new TypeError('Runtime performance metric maxEvents must be a positive safe integer.');
    }
  }

  public record(event: RuntimePerformanceMetricEvent): void {
    if (this.events.length >= this.maxEvents) {
      this.dropped += 1;
      return;
    }
    this.events.push(Object.freeze({ ...event }) as RuntimePerformanceMetricEvent);
  }

  public snapshot(): Readonly<{ events: readonly RuntimePerformanceMetricEvent[]; dropped: number }> {
    return Object.freeze({ events: Object.freeze([...this.events]), dropped: this.dropped });
  }

  public reset(): void {
    this.events.length = 0;
    this.dropped = 0;
  }
}
