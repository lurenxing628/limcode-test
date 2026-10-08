import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { decodeCanonicalBase64 } from '../capabilities/canonicalBase64';
import type { RootBinding } from './contracts';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import {
  ContentAddressedStore,
  type ContentObjectMetadata,
  type PreparedContentObject
} from './contentAddressedStore';
import {
  EffectControlPlane,
  matchesExpectedUnique,
  preparedContentSteps,
  stablePhaseDId,
  type PhaseDCommandSource,
  type PreparedEffectIntent,
  type ToolTerminalResult
} from './effectControlPlane';
import {
  DEFAULT_PROCESS_EXECUTION_TIMEOUT_MS,
  DEFAULT_PROCESS_MAX_OUTPUT_BYTES,
  MAX_PROCESS_EXECUTION_TIMEOUT_MS,
  MAX_PROCESS_MAX_OUTPUT_BYTES,
  MIN_PROCESS_EXECUTION_TIMEOUT_MS,
  MIN_PROCESS_MAX_OUTPUT_BYTES,
  PROCESS_OUTPUT_MAX_CHUNK_BYTES,
  PROCESS_TERMINATION_GRACE_MS,
  PROCESS_WRAPPER_BOOTSTRAP_FILE,
  PROCESS_WRAPPER_CHUNKS_DIRECTORY,
  PROCESS_WRAPPER_EXIT_RECEIPT_FILE,
  PROCESS_WRAPPER_IDENTITY_FILE,
  PROCESS_WRAPPER_LAUNCH_FAILURE_FILE,
  PROCESS_WRAPPER_MANIFEST_FILE,
  PROCESS_WRAPPER_PROTOCOL,
  PROCESS_WRAPPER_STOP_REQUEST_FILE,
  isWrapperProcessReachable,
  listProcessSpoolChunks,
  parseStopRequest,
  parseWrapperBootstrapReceipt,
  parseWrapperExitReceipt,
  parseWrapperIdentity,
  parseWrapperLaunchFailureReceipt,
  parseWrapperManifest,
  processWrapperManifestLiveTails,
  processChunkFileName,
  processSpoolPath,
  processSpoolRoot,
  readProcessStartFingerprint,
  type ProcessStopRequest,
  type ProcessTerminationReason,
  type ProcessWrapperBootstrapReceipt,
  type ProcessWrapperExitReceipt,
  type ProcessWrapperIdentity,
  type ProcessWrapperLaunchFailureReceipt,
  type ProcessWrapperLaunchRequest,
  type ProcessWrapperManifest
} from './processProtocol';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RootAuthority } from './rootAuthority';
import { RuntimeDatabase } from './runtimeDatabase';
import { LocalExecutionRecoveryExhaustedError, retryLocalExecution } from './localExecutionRecovery';
import { hasMatchingTerminalProcessReceipt } from './runtimeProcessHistory';
import {
  currentExecutionLeaseFence,
  executionLeaseFenceAssertion,
  handoffReason,
  runWithoutExecutionLeaseFence
} from './executionLeaseFence';

export interface ProcessStartRequest {
  processId: string;
  stableNonce: string;
  command: string;
  cwd: string;
  commandDigest: string;
  spoolLocator: string;
  /** Null only when replaying a process_start request written before watchdog support. */
  executionTimeoutMs: number | null;
  maxOutputBytes: number | null;
}

export interface ProcessStopEffectRequest {
  processId: string;
  stableNonce: string;
  startFingerprint: string;
  processGroupId: string;
  commandDigest: string;
  spoolLocator: string;
}

export interface ProcessExitEffectRequest extends ProcessStopEffectRequest {
  wrapperPid: string;
  childPid: string;
}

export interface ProcessStartPreparation {
  effect: PreparedEffectIntent;
  request: ProcessStartRequest;
}

export type ProcessLaunchObservation =
  | { outcome: 'succeeded'; identity: ProcessWrapperIdentity }
  | { outcome: 'failed'; error: string }
  | { outcome: 'cancelled'; error: string }
  | { outcome: 'outcome_unknown'; error: string };

export interface ProcessStartObservation {
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown';
  /** Stable protocol result shown to the model/UI; a foreground wait expiry is a successful handoff. */
  state: 'background_started' | 'completed' | 'launch_failed' | 'launch_cancelled' | 'outcome_unknown';
  processId: string;
  launch: ProcessLaunchObservation;
  foreground: ProcessWaitObservation | null;
}

export interface ProcessOutputReadResult {
  processId: string;
  status: string;
  stdout: Buffer;
  stderr: Buffer;
  retainedBytes: string;
  retainedChunks: string;
  droppedBytes: string;
  truncated: boolean;
}

export interface ProcessOutputPageReadResult {
  processId: string;
  status: string;
  stdout: string;
  stderr: string;
  liveStdout: string;
  liveStderr: string;
  livePreviewBytes: string;
  pageBytes: string;
  pageChunks: string;
  retainedBytes: string;
  retainedChunks: string;
  droppedBytes: string;
  truncated: boolean;
  hasMore: boolean;
  complete: boolean;
  nextOutputHandle: string;
}

/** One verified process-stream prefix for the on-demand Webview byte pager. */
export interface ProcessDetailOutputSnapshot {
  retainedBytes: string;
  retainedChunks: string;
  stdout: Buffer;
  stderr: Buffer;
}

export type ProcessWaitObservation =
  | { state: 'running'; processId: string }
  | { state: 'exited'; processId: string; receipt: ProcessWrapperExitReceipt }
  | { state: 'outcome_unknown'; processId: string; reason: string };

export type ProcessStopStatus =
  | 'already_exited'
  | 'stopped'
  | 'stop_requested'
  | 'cancelled'
  | 'outcome_unknown';

export interface ProcessStopObservation {
  outcome: 'succeeded' | 'cancelled' | 'outcome_unknown';
  status: ProcessStopStatus;
  reason?: string;
  receipt?: ProcessWrapperExitReceipt;
}

interface ReconciledOutput {
  retainedBytes: bigint;
  retainedChunks: bigint;
  droppedBytes: bigint;
  truncated: boolean;
  insertedChunks: number;
}

interface ProcessOutputSnapshot {
  processRow: DomainRow;
  registered: DomainRow[];
}

interface VerifiedSpoolPrefix {
  manifest: ProcessWrapperManifest;
  chunks: ReturnType<typeof listProcessSpoolChunks>;
}

interface ProcessOutputCounters {
  retainedBytes: bigint;
  retainedChunks: bigint;
  droppedBytes: bigint;
  truncated: boolean;
}

interface VerifiedOutputPrefix {
  identity: string;
  retainedBytes: bigint;
  retainedChunks: bigint;
  /** The terminal scan also proved that no rows exist beyond this prefix. */
  complete: boolean;
}

interface OutputPrefixReadFence {
  externalVersion: string;
  removalRevision: number;
  mutationRevision: number;
}

interface OutputPrefixRetryBudget { remainingAttempts: number }

interface WrapperLaunchMonitor {
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  stderrText(): string;
  release(): void;
}

interface PreparedProcessOutputChunk {
  chunkSeq: bigint;
  streamKind: 'stdout' | 'stderr';
  byteLength: bigint;
  createdAt: string;
  content: PreparedContentObject;
}

interface ProcessOutputCursor {
  processId: string;
  nextChunkSeq: bigint;
  nextChunkOffset: number;
  reconciledRetainedChunks: bigint | null;
  stdoutCarry: Buffer;
  stderrCarry: Buffer;
}

const PROCESS_START = 'process_start' as const;
const PROCESS_STOP = 'process_stop_request' as const;
const WRAPPER_BOOTSTRAP_WAIT_MS = 15_000;
const WRAPPER_IDENTITY_WAIT_MS = 30_000;
const WRAPPER_PRE_IDENTITY_STDERR_MAX_BYTES = 8 * 1024;
const WRAPPER_IDENTITY_POLL_MS = 20;
const WRAPPER_EXIT_RECEIPT_SETTLE_MS = 500;
const PROCESS_EXIT_OBSERVER_POLL_MS = 250;
const PROCESS_STOP_RECEIPT_WAIT_MS = PROCESS_TERMINATION_GRACE_MS + 1_000;
const PROCESS_STOP_RECEIPT_POLL_MS = 25;
/** Per-transaction worker message budget; it bounds one commit, never retained process output. */
export const PROCESS_OUTPUT_TRANSACTION_MAX_WIRE_BYTES = 1_048_576;
const PROCESS_OUTPUT_METADATA_READ_ROWS = 32;
/** A mode=output page is resumable; this bounds one model result, never the traversable history. */
export const PROCESS_OUTPUT_READ_PAGE_MAX_BYTES = 128 * 1024;
/** Initial execute responses stay small; the opaque handle resumes exactly at the byte boundary. */
export const PROCESS_START_INLINE_OUTPUT_MAX_BYTES = 16 * 1024;
const PROCESS_OUTPUT_HANDLE_PREFIX = 'rk-process-output:';
const PROCESS_DETAIL_SNAPSHOT_MAX_ATTEMPTS = 4;
const PROCESS_RECONCILE_MAX_RETRIES_PER_DETAIL = 4;
const PROCESS_SPOOL_CLEANUP_BATCH_SIZE = 24;
const PROCESS_OUTPUT_PROOF_CACHE_ENTRIES = 128;
const ARCHIVABLE_PROCESS_STATUSES = new Set([
  'exited',
  'cancelled',
  'timed_out',
  'output_limit_exceeded'
]);

export interface ProcessControlPlaneOptions {
  now?: () => string;
  onExitObserverError?: (input: { processId: string; error: unknown }) => void;
}

export interface ProcessExitObserverInspection {
  enabled: boolean;
  closing: boolean;
  activeProcessIds: string[];
}

export interface ProcessSpoolCleanupReport {
  scanned: number;
  removed: number;
  alreadyAbsent: number;
  retained: number;
  failed: number;
}

/** Process domain orchestration; the detached wrapper remains the external process authority. */
export class ProcessControlPlane {
  private readonly now: () => string;
  private readonly onExitObserverError: ProcessControlPlaneOptions['onExitObserverError'];
  private readonly exitObservers = new Map<string, Promise<void>>();
  private readonly exitObserverWakeups = new Set<() => void>();
  private readonly processIdentityReadyAt = new Map<string, number>();
  // Only already-validated immutable SQLite rows are covered. Spool files, manifests and CAS
  // bytes are never cached here; their normal identity/content reads remain authoritative.
  private readonly verifiedOutputPrefixes = new Map<string, VerifiedOutputPrefix>();
  private outputPrefixExternalVersion: string | undefined;
  private outputPrefixRemovalRevision = 0;
  private outputPrefixMutationRevision = 0;
  private outputPrefixCaching = false;
  private readonly outputPrefixSubscriptions: Array<() => void> = [];
  private exitObserversEnabled = false;
  private exitObserversClosing = false;
  private exitObserversDisposePromise: Promise<void> | undefined;
  private processReceiptObserver: ((processId: string) => void) | undefined;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly effects: EffectControlPlane,
    private readonly authority: RootAuthority,
    private readonly binding: RootBinding,
    options: ProcessControlPlaneOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.onExitObserverError = options.onExitObserverError;
    if (!database.maintenance && typeof database.onCommit === 'function'
      && typeof database.onClose === 'function' && typeof database.externalDataVersion === 'function') {
      this.outputPrefixCaching = true;
      this.outputPrefixSubscriptions.push(database.onCommit(commit => {
        for (const change of commit.changes) {
          if (change.domain === 'Process' && change.kind === 'remove') {
            this.verifiedOutputPrefixes.delete(change.id);
            this.outputPrefixRemovalRevision++;
          }
          if (change.domain !== 'ProcessOutputChunk') continue;
          this.outputPrefixMutationRevision++;
          if (change.kind === 'remove' || !change.record) {
            this.verifiedOutputPrefixes.clear();
            this.outputPrefixRemovalRevision++;
            continue;
          }
          const processId = String(change.record.process_id);
          const known = this.verifiedOutputPrefixes.get(processId);
          if (!known) continue;
          if (BigInt(String(change.record.chunk_seq)) <= known.retainedChunks) {
            this.verifiedOutputPrefixes.delete(processId);
            this.outputPrefixRemovalRevision++;
          } else {
            // Appending immutable rows preserves the old prefix but invalidates an exact total.
            known.complete = false;
          }
        }
      }), database.onClose(() => this.releaseOutputPrefixProofs()));
    }
  }

  /**
   * Registers an observational level-trigger wake. The observer never owns ProcessReceipt writes;
   * callers must still scan SQLite on startup because a host may stop between receipt commit and it.
   */
  public setProcessReceiptObserver(observer: ((processId: string) => void) | undefined): void {
    this.processReceiptObserver = observer;
  }

  public async prepareStart(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    command: string;
    cwd: string;
    executionTimeoutMs?: number;
    maxOutputBytes?: number;
  }): Promise<ProcessStartPreparation> {
    const toolCallId = requireId(input.toolCallId, 'toolCallId');
    const command = requireText(input.command, 'command');
    const cwd = path.resolve(requireText(input.cwd, 'cwd'));
    const executionTimeoutMs = requireBoundedWatchdogInteger(
      input.executionTimeoutMs ?? DEFAULT_PROCESS_EXECUTION_TIMEOUT_MS,
      'executionTimeoutMs',
      MIN_PROCESS_EXECUTION_TIMEOUT_MS,
      MAX_PROCESS_EXECUTION_TIMEOUT_MS
    );
    const maxOutputBytes = requireBoundedWatchdogInteger(
      input.maxOutputBytes ?? DEFAULT_PROCESS_MAX_OUTPUT_BYTES,
      'maxOutputBytes',
      MIN_PROCESS_MAX_OUTPUT_BYTES,
      MAX_PROCESS_MAX_OUTPUT_BYTES
    );
    const processId = stablePhaseDId('process', toolCallId);
    const request: ProcessStartRequest = {
      processId,
      stableNonce: randomBytes(16).toString('hex'),
      command,
      cwd,
      commandDigest: commandDigest(command, cwd),
      spoolLocator: processId,
      executionTimeoutMs,
      maxOutputBytes
    };
    const effect = await this.effects.prepareEffectIntent({
      source: input.source,
      toolCallId,
      effectKind: PROCESS_START,
      request
    });
    // Duplicate source replay must return the first committed stable nonce/request.
    return {
      effect,
      request: normalizeStartRequest(
        await this.effects.readEffectRequest<ProcessStartRequest>(effect.effectIntentId)
      )
    };
  }

  public async dispatchStart(
    effectIntentIdInput: string,
    foregroundWaitMs = 0,
    signal?: AbortSignal
  ): Promise<{
    observation: ProcessStartObservation | null;
    terminal: ToolTerminalResult | null;
  }> {
    const effectIntentId = requireId(effectIntentIdInput, 'effectIntentId');
    requireWaitDuration(foregroundWaitMs);
    if (signal?.aborted) {
      const handoff = handoffReason(signal);
      if (handoff) throw handoff;
      const cancelled = await this.effects.cancelPendingEffect({
        source: { kind: 'internal', key: `process-start:${effectIntentId}:cancel-before-dispatch` },
        effectIntentId,
        detail: { reason: 'Process start cancelled before capability dispatch.' }
      });
      if (cancelled) return { observation: null, terminal: cancelled.terminal ?? null };
    }
    if (!await retryLocalExecution(() => this.effects.claimEffectDispatch(effectIntentId))) return { observation: null, terminal: null };
    const { intent, request } = await retryLocalExecution(async () => {
      const intent = await this.requireExisting('EffectIntent', effectIntentId);
      const request = normalizeStartRequest(await this.effects.readEffectRequest<ProcessStartRequest>(effectIntentId));
      return { intent, request };
    });
    const launch: ProcessLaunchObservation = signal?.aborted
      ? { outcome: 'cancelled', error: 'Process start cancelled before wrapper launch.' }
      : await this.launchDispatched(effectIntentId, signal);
    // Launch is never repeated. Foreground observation and persistence retain this exact launch.
    const observation = await retryLocalExecution(() => this.observeStart(request, launch, foregroundWaitMs, signal));
    const recorded = await retryLocalExecution(() => this.effects.recordEffectReceipt({
      source: { kind: 'callback', key: `process-start:${String(intent.attempt_id)}:receipt` },
      attemptId: intent.attempt_id as string,
      effectKind: PROCESS_START,
      outcome: observation.outcome,
      detail: observation
    }));
    return {
      observation,
      terminal: await retryLocalExecution(() => this.reconcileStartReceipt(recorded.effectReceiptId))
    };
  }

  /** Launches only an already-dispatched intent; useful after the durable claim, never for retry. */
  public async launchDispatched(
    effectIntentIdInput: string,
    signal?: AbortSignal
  ): Promise<ProcessLaunchObservation> {
    const effectIntentId = requireId(effectIntentIdInput, 'effectIntentId');
    await retryLocalExecution(() => this.validateBinding());
    if (signal?.aborted) return { outcome: 'cancelled', error: 'Process start cancelled before spool creation.' };
    const request = await retryLocalExecution(async () => {
      const intent = await this.requireExisting('EffectIntent', effectIntentId);
      if (intent.effect_kind !== PROCESS_START || intent.dispatch_state !== 'dispatched') {
        throw new Error('Process launch requires a committed dispatched process_start EffectIntent.');
      }
      if ((await this.list('EffectReceipt', { attempt_id: intent.attempt_id }, 1)).length > 0) {
        throw new Error('process_start EffectIntent already has a Receipt and cannot launch again.');
      }
      return normalizeStartRequest(await this.effects.readEffectRequest<ProcessStartRequest>(effectIntentId));
    });
    if (signal?.aborted) return { outcome: 'cancelled', error: 'Process start cancelled before spool creation.' };
    const spoolPath = processSpoolPath(this.binding, request.spoolLocator);
    try {
      await fs.mkdir(processSpoolRoot(this.binding), { recursive: true });
      await fs.mkdir(spoolPath, { recursive: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { outcome: 'outcome_unknown', error: 'Process spool already exists; automatic redispatch is forbidden.' };
      }
      return { outcome: 'failed', error: errorMessage(error) };
    }
    if (signal?.aborted) return { outcome: 'cancelled', error: 'Process start cancelled before launch request write.' };
    // External watchdog deadlines must use the physical wall clock. The injected `now` function is
    // only for persisted application timestamps and may deliberately be frozen in deterministic tests.
    const createdAt = new Date().toISOString();
    const launch: ProcessWrapperLaunchRequest = {
      kind: PROCESS_WRAPPER_PROTOCOL,
      ...request,
      executionDeadlineAt: request.executionTimeoutMs === null
        ? null
        : addMilliseconds(createdAt, request.executionTimeoutMs, 'process launch createdAt'),
      createdAt
    };
    const launchPath = path.join(spoolPath, 'launch.json');
    await writeAtomicJson(launchPath, launch);
    if (signal?.aborted) return { outcome: 'cancelled', error: 'Process start cancelled before wrapper spawn.' };
    const spawnStartedAt = this.database.performanceMetrics ? performance.now() : undefined;
    const spawned = await spawnWrapperForLaunch(launchPath);
    if (spawnStartedAt !== undefined) {
      this.database.recordPerformanceMetric({
        kind: 'process.phase',
        phase: 'spawn',
        durationMs: performance.now() - spawnStartedAt
      });
    }
    if (!spawned.ok) return { outcome: 'failed', error: errorMessage(spawned.error) };
    const identityStartedAt = this.database.performanceMetrics ? performance.now() : undefined;
    let evidence: ProcessLaunchObservation;
    try {
      evidence = await waitForLaunchEvidence(request, spoolPath, launch.createdAt, spawned.monitor);
    } finally {
      spawned.monitor.release();
    }
    if (identityStartedAt !== undefined && evidence.outcome === 'succeeded') {
      const readyAt = performance.now();
      this.processIdentityReadyAt.set(request.processId, readyAt);
      this.database.recordPerformanceMetric({
        kind: 'process.phase',
        phase: 'identity_ready',
        durationMs: readyAt - identityStartedAt
      });
    }
    return evidence;
  }

  public async reconcileStartReceipt(effectReceiptIdInput: string): Promise<ToolTerminalResult | null> {
    const effectReceiptId = requireId(effectReceiptIdInput, 'effectReceiptId');
    const receipt = await this.requireExisting('EffectReceipt', effectReceiptId);
    if (receipt.effect_kind !== PROCESS_START) throw new Error('EffectReceipt is not process_start.');
    const attempt = await this.requireExisting('Attempt', requireId(receipt.attempt_id, 'EffectReceipt.attempt_id'));
    const operation = await this.requireExisting('Operation', requireId(attempt.operation_id, 'Attempt.operation_id'));
    const toolCallId = requireId(operation.tool_call_id, 'Operation.tool_call_id');
    const toolCall = await this.requireExisting('ToolCall', toolCallId);
    const sourceTurnId = requireId(toolCall.turn_id, 'ToolCall.turn_id');
    const sourceTurn = await this.requireExisting('Turn', sourceTurnId);
    const conversationId = requireId(sourceTurn.conversation_id, 'Turn.conversation_id');
    const intentRows = await this.list('EffectIntent', { attempt_id: attempt.id }, 2);
    if (intentRows.length !== 1) throw new Error('process_start Attempt must have one EffectIntent.');
    const request = normalizeStartRequest(await this.effects.readEffectRequest<ProcessStartRequest>(intentRows[0].id as string));
    const source: PhaseDCommandSource = { kind: 'internal', key: `process-start-reconcile:${effectReceiptId}` };
    const outcome = requireProcessStartOutcome(receipt.outcome);
    const rawObservation = await this.readReceiptDetail<unknown>(receipt);
    const observation = normalizeProcessStartObservation(rawObservation, request);
    if (observation.outcome !== outcome) throw new Error('process_start Receipt detail outcome mismatch.');

    const existingProcess = await this.maybeGet('Process', request.processId);
    const additionalSteps: RepositoryTransactionStep[] = [];
    let exitRequestContent: PreparedContentObject | undefined;
    if (observation.launch.outcome === 'succeeded') {
      assertIdentityMatchesStart(observation.launch.identity, request);
      if (!observation.foreground) throw new Error('Succeeded process launch lacks foreground observation.');
      if (existingProcess) {
        assertProcessMatchesIdentity(existingProcess, observation.launch.identity);
      } else {
        if (observation.foreground.state === 'running') {
          exitRequestContent = await this.contentStore.prepare(
            this.database,
            Buffer.from(JSON.stringify(processExitRequest(observation.launch.identity)), 'utf8'),
            'application/vnd.limcode.effect-process_exit+json'
          );
        }
        additionalSteps.push(...processStartFactSteps(
          request,
          toolCallId,
          sourceTurnId,
          conversationId,
          observation.launch.identity,
          observation.foreground,
          this.timestamp(),
          exitRequestContent
        ));
      }
    } else if (existingProcess) {
      throw new Error('Failed/unknown process launch cannot already own a Process row.');
    }
    const existingTerminal = await this.effects.completeOperation({
      source,
      effectReceiptId,
      outcome,
      ...(additionalSteps.length > 0 ? { additionalSteps } : {})
    }, { finalize: false });
    if (observation.foreground?.state === 'running') this.ensureExitObserver(request.processId);
    if (existingTerminal) return existingTerminal;

    let detail: unknown;
    if (observation.launch.outcome === 'succeeded') {
      const existingModelResponse = await this.readExistingModelResponseDetail(toolCallId, outcome);
      if (existingModelResponse.found) {
        // The first committed model response is immutable. Reusing its exact detail also reuses the
        // original source receipt identity when a host stopped between artifact and final outcome.
        detail = existingModelResponse.detail;
      } else {
        try {
          await this.reconcileOutputBounded(
            request.processId,
            PROCESS_RECONCILE_MAX_RETRIES_PER_DETAIL
          );
          const output = await this.readOutputPage(
            request.processId,
            undefined,
            PROCESS_START_INLINE_OUTPUT_MAX_BYTES
          );
          detail = processStartModelDetail(observation, output);
        } catch {
          // Inline output is a convenience, not execution authority. The durable processId remains
          // sufficient to page output later, so preview I/O must never strand a successful ToolCall.
          detail = processStartModelDetailWithoutPreview(observation);
        }
      }
    } else {
      detail = processStartFailureModelDetail(observation);
    }
    const terminal = await this.effects.recordToolModelDetail({
      source: { kind: 'internal', key: `process-start-model-detail:${effectReceiptId}` },
      toolCallId,
      status: outcome,
      detail
    });
    if (observation.foreground?.state === 'exited') {
      await this.cleanupArchivedSpool(request.processId).catch((error) => {
        console.warn(
          `[reliable-kernel] failed to clean completed foreground process spool ${request.processId}:`,
          errorMessage(error)
        );
      });
    }
    return terminal;
  }

  public async prepareStop(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    processId: string;
  }): Promise<PreparedEffectIntent> {
    const processRow = await this.requireExisting('Process', requireId(input.processId, 'processId'));
    const request: ProcessStopEffectRequest = {
      processId: processRow.id as string,
      stableNonce: requireText(processRow.wrapper_nonce, 'Process.wrapper_nonce'),
      startFingerprint: requireText(processRow.start_fingerprint, 'Process.start_fingerprint'),
      processGroupId: requireBigInt(processRow.process_group_id, 'Process.process_group_id').toString(),
      commandDigest: requireSha256(processRow.command_digest, 'Process.command_digest'),
      spoolLocator: requireText(processRow.spool_locator, 'Process.spool_locator')
    };
    return this.effects.prepareEffectIntent({
      source: input.source,
      toolCallId: input.toolCallId,
      effectKind: PROCESS_STOP,
      request,
      owner: { kind: 'process', id: request.processId }
    });
  }

  public async dispatchStop(effectIntentIdInput: string, signal?: AbortSignal): Promise<{
    outcome: 'succeeded' | 'cancelled' | 'outcome_unknown';
    terminal: ToolTerminalResult | null;
  } | null> {
    const effectIntentId = requireId(effectIntentIdInput, 'effectIntentId');
    if (signal?.aborted) {
      const handoff = handoffReason(signal);
      if (handoff) throw handoff;
      await this.effects.cancelPendingEffect({
        source: { kind: 'internal', key: `process-stop:${effectIntentId}:cancel-before-dispatch` },
        effectIntentId,
        detail: { reason: 'Process stop cancelled before capability dispatch.' }
      });
      return null;
    }
    if (!await retryLocalExecution(() => this.effects.claimEffectDispatch(effectIntentId))) return null;
    const outcome = await this.executeDispatchedStop(effectIntentId, signal);
    const intent = await retryLocalExecution(() => this.requireExisting('EffectIntent', effectIntentId));
    const recorded = await retryLocalExecution(() => this.effects.recordEffectReceipt({
      source: { kind: 'callback', key: `process-stop:${String(intent.attempt_id)}:receipt` },
      attemptId: intent.attempt_id as string,
      effectKind: PROCESS_STOP,
      outcome: outcome.outcome,
      detail: outcome
    }));
    return retryLocalExecution(async () => {
      const persisted = await this.requireExisting('EffectReceipt', recorded.effectReceiptId);
      const persistedOutcome = requireProcessStopOutcome(persisted.outcome);
      return {
        outcome: persistedOutcome,
        terminal: await this.effects.completeOperation({
          source: { kind: 'internal', key: `process-stop-reconcile:${recorded.effectReceiptId}` },
          effectReceiptId: recorded.effectReceiptId,
          outcome: persistedOutcome
        })
      };
    });
  }

  /** Writes a request for the wrapper; the Extension Host never signals a bare PID/process group. */
  public async executeDispatchedStop(
    effectIntentIdInput: string,
    signal?: AbortSignal
  ): Promise<ProcessStopObservation> {
    const effectIntentId = requireId(effectIntentIdInput, 'effectIntentId');
    if (signal?.aborted) {
      return {
        outcome: 'cancelled',
        status: 'cancelled',
        reason: 'Process stop cancelled before the stop request was dispatched.'
      };
    }
    const { request, processRow } = await retryLocalExecution(async () => {
      await this.validateBinding();
      const intent = await this.requireExisting('EffectIntent', effectIntentId);
      if (intent.effect_kind !== PROCESS_STOP || intent.dispatch_state !== 'dispatched') {
        throw new Error('Process stop requires a committed dispatched process_stop_request EffectIntent.');
      }
      const request = normalizeStopRequest(await this.effects.readEffectRequest<ProcessStopEffectRequest>(effectIntentId));
      const processRow = await this.requireExisting('Process', request.processId);
      return { request, processRow };
    });
    if (!processEvidenceMatches(processRow, request)) {
      return {
        outcome: 'outcome_unknown',
        status: 'outcome_unknown',
        reason: 'Persisted Process evidence does not match stop request.'
      };
    }
    return this.convergeDispatchedStop(request, processRow, { allowStopWrite: true, signal });
  }

  /**
   * Internal resource-owner stop path used by explicit Child subtree interruption. The durable
   * cleanup outbox owns retries; this method preserves the same wrapper identity/PID-reuse fences
   * as the user-facing process_stop effect without pretending a second ToolCall exists.
   */
  public async stopOwnedProcess(
    processIdInput: string,
    signal?: AbortSignal
  ): Promise<ProcessStopObservation> {
    const processId = requireId(processIdInput, 'processId');
    if (signal?.aborted) {
      return {
        outcome: 'cancelled',
        status: 'cancelled',
        reason: 'Owned process cleanup was cancelled before dispatch.'
      };
    }
    await this.validateBinding();
    const processRow = await this.requireExisting('Process', processId);
    const request: ProcessStopEffectRequest = {
      processId,
      stableNonce: requireText(processRow.wrapper_nonce, 'Process.wrapper_nonce'),
      startFingerprint: requireText(processRow.start_fingerprint, 'Process.start_fingerprint'),
      processGroupId: requireBigInt(processRow.process_group_id, 'Process.process_group_id').toString(),
      commandDigest: requireSha256(processRow.command_digest, 'Process.command_digest'),
      spoolLocator: requireText(processRow.spool_locator, 'Process.spool_locator')
    };
    return this.convergeDispatchedStop(request, processRow, { allowStopWrite: true, signal });
  }

  /** Recovery reads existing stop evidence and never writes or re-dispatches the stop request. */
  public async recoverDispatchedStop(input: {
    source: PhaseDCommandSource;
    effectIntentId: string;
  }): Promise<ToolTerminalResult | null> {
    if (input.source.kind !== 'recovery') throw new TypeError('Process stop recovery requires recovery source kind.');
    const intent = await this.requireExisting('EffectIntent', requireId(input.effectIntentId, 'effectIntentId'));
    if (intent.effect_kind !== PROCESS_STOP) throw new Error('Recovery target must be process_stop_request.');
    const existing = (await this.list('EffectReceipt', { attempt_id: intent.attempt_id }, 2))[0];
    if (existing) {
      return this.effects.completeOperation({
        source: { kind: 'recovery', key: `process-stop-reconcile:${String(existing.id)}` },
        effectReceiptId: existing.id as string,
        outcome: requireProcessStopOutcome(existing.outcome)
      });
    }
    if (intent.dispatch_state !== 'dispatched') {
      throw new Error('Process stop recovery without a Receipt requires a dispatched EffectIntent.');
    }
    await this.validateBinding();
    const request = normalizeStopRequest(await this.effects.readEffectRequest<ProcessStopEffectRequest>(intent.id as string));
    const processRow = await this.requireExisting('Process', request.processId);
    const observation = processEvidenceMatches(processRow, request)
      ? await this.convergeDispatchedStop(request, processRow, { allowStopWrite: false })
      : {
          outcome: 'outcome_unknown' as const,
          status: 'outcome_unknown' as const,
          reason: 'Persisted Process does not match stop request.'
        };
    const recorded = await this.effects.recordEffectReceipt({
      source: input.source,
      attemptId: intent.attempt_id as string,
      effectKind: PROCESS_STOP,
      outcome: observation.outcome,
      detail: { ...observation, automaticRetry: false }
    });
    const winner = await this.requireExisting('EffectReceipt', recorded.effectReceiptId);
    return this.effects.completeOperation({
      source: { kind: 'recovery', key: `process-stop-reconcile:${recorded.effectReceiptId}` },
      effectReceiptId: recorded.effectReceiptId,
      outcome: requireProcessStopOutcome(winner.outcome)
    });
  }

  /**
   * Converges the level-triggered ProcessReceipt/atomic exit receipt before relying on liveness.
   * Recovery shares the same reader but never creates a missing external stop request.
   */
  private async convergeDispatchedStop(
    request: ProcessStopEffectRequest,
    processRow: DomainRow,
    options: { allowStopWrite: boolean; signal?: AbortSignal }
  ): Promise<ProcessStopObservation> {
    const evidence = await retryLocalExecution(() => this.readPersistedProcessEvidence(request.processId));
    if (evidence.receipt) {
      const persisted = persistedProcessObservation(evidence.process, evidence.receipt);
      if (persisted.state === 'exited') return terminalStopObservation(persisted, true);
      if (persisted.state === 'outcome_unknown') return unknownStopObservation(persisted.reason);
      throw new Error('Persisted ProcessReceipt cannot describe a running Process.');
    }

    const before = await retryLocalExecution(() => this.waitForTerminalProcessEvidence(request.processId, 0));
    if (before.state === 'exited') return terminalStopObservation(before, true);

    const spoolPath = processSpoolPath(this.binding, request.spoolLocator);
    const stopPath = path.join(spoolPath, PROCESS_WRAPPER_STOP_REQUEST_FILE);
    let matchingStopExists = false;
    try {
      const persistedStop = parseStopRequest(await retryLocalExecution(() => readJson(stopPath)));
      assertStopRequestMatchesEffect(request, persistedStop);
      matchingStopExists = true;
    } catch (error) {
      if (error instanceof LocalExecutionRecoveryExhaustedError) throw error;
      if (!isNotFound(error)) return unknownStopObservation(errorMessage(error));
    }

    if (!matchingStopExists) {
      if (!options.allowStopWrite) {
        const terminal = await retryLocalExecution(() => this.waitForTerminalProcessEvidence(
          request.processId,
          PROCESS_STOP_RECEIPT_WAIT_MS
        ));
        return terminal.state === 'exited'
          ? terminalStopObservation(terminal, true)
          : unknownStopObservation(
              terminal.state === 'outcome_unknown'
                ? terminal.reason
                : 'Dispatched process stop has neither an atomic stop request nor a terminal receipt.'
            );
      }

      let identity: ProcessWrapperIdentity;
      try {
        identity = parseWrapperIdentity(await retryLocalExecution(() => readJson(path.join(spoolPath, PROCESS_WRAPPER_IDENTITY_FILE))));
        assertIdentityMatchesStop(identity, request);
      } catch (error) {
        if (error instanceof LocalExecutionRecoveryExhaustedError) throw error;
        const terminal = await retryLocalExecution(() => this.waitForTerminalProcessEvidence(
          request.processId,
          PROCESS_STOP_RECEIPT_WAIT_MS
        ));
        return terminal.state === 'exited'
          ? terminalStopObservation(terminal, true)
          : unknownStopObservation(errorMessage(error));
      }

      if (!isWrapperProcessReachable(identity.wrapperPid, path.join(spoolPath, 'launch.json'))) {
        const terminal = await retryLocalExecution(() => this.waitForTerminalProcessEvidence(
          request.processId,
          PROCESS_STOP_RECEIPT_WAIT_MS
        ));
        return terminal.state === 'exited'
          ? terminalStopObservation(terminal, true)
          : unknownStopObservation('Recorded process wrapper is not reachable and no terminal receipt converged.');
      }
      try {
        if (readProcessStartFingerprint(identity.childPid) !== identity.startFingerprint) {
          return unknownStopObservation('Live process start fingerprint does not match.');
        }
      } catch (error) {
        const terminal = await retryLocalExecution(() => this.waitForTerminalProcessEvidence(
          request.processId,
          PROCESS_STOP_RECEIPT_WAIT_MS
        ));
        return terminal.state === 'exited'
          ? terminalStopObservation(terminal, true)
          : unknownStopObservation(errorMessage(error));
      }

      const terminalBeforeWrite = await retryLocalExecution(() => this.waitForTerminalProcessEvidence(request.processId, 0));
      if (terminalBeforeWrite.state === 'exited') return terminalStopObservation(terminalBeforeWrite, true);
      if (options.signal?.aborted) {
        return {
          outcome: 'cancelled',
          status: 'cancelled',
          reason: 'Process stop cancelled before the stop request was dispatched.'
        };
      }
      const stop: ProcessStopRequest = {
        kind: PROCESS_WRAPPER_PROTOCOL,
        processId: request.processId,
        stableNonce: request.stableNonce,
        startFingerprint: request.startFingerprint,
        processGroupId: request.processGroupId,
        commandDigest: request.commandDigest,
        requestedAt: this.timestamp()
      };
      try {
        await writeAtomicJsonOnce(stopPath, stop);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const winner = parseStopRequest(await retryLocalExecution(() => readJson(stopPath)));
        assertStopRequestMatchesEffect(request, winner);
      }
      matchingStopExists = true;
    }

    const after = await retryLocalExecution(() => this.waitForTerminalProcessEvidence(
      request.processId,
      PROCESS_STOP_RECEIPT_WAIT_MS
    ));
    if (after.state === 'exited') return terminalStopObservation(after, false);
    if (!matchingStopExists) {
      return unknownStopObservation(
        after.state === 'outcome_unknown' ? after.reason : 'Process stop request was not durably persisted.'
      );
    }
    return {
      outcome: 'succeeded',
      status: 'stop_requested',
      reason: 'Matching atomic stop request is durable; terminal receipt is still pending.'
    };
  }

  private async waitForTerminalProcessEvidence(
    processId: string,
    timeoutMs: number
  ): Promise<ProcessWaitObservation> {
    const deadline = Date.now() + timeoutMs;
    let latest: ProcessWaitObservation = { state: 'running', processId };
    for (;;) {
      const evidence = await this.readPersistedProcessEvidence(processId);
      if (evidence.receipt) {
        return persistedProcessObservation(evidence.process, evidence.receipt);
      }
      latest = await this.observeProcess(processId);
      if (latest.state === 'exited') return this.reconcileProcessExit(processId);
      if (Date.now() >= deadline) return latest;
      await sleep(Math.min(PROCESS_STOP_RECEIPT_POLL_MS, Math.max(1, deadline - Date.now())));
    }
  }

  /** Imports one immutable wrapper-manifest prefix into CAS+SQLite; it never re-runs the process. */
  public async reconcileOutput(processIdInput: string): Promise<ReconciledOutput> {
    const processId = requireId(processIdInput, 'processId');
    return this.reconcileOutputBounded(processId, Number.POSITIVE_INFINITY);
  }

  /** Removes one terminal spool only after its receipt and complete durable output prefix exist. */
  public async cleanupArchivedSpool(
    processIdInput: string
  ): Promise<'removed' | 'already_absent' | 'retained'> {
    const processId = requireId(processIdInput, 'processId');
    await this.validateBinding();
    const processRow = await this.requireExisting('Process', processId);
    if (!ARCHIVABLE_PROCESS_STATUSES.has(String(processRow.status))) return 'retained';
    const receipts = await this.list('ProcessReceipt', { process_id: processId }, 2);
    if (receipts.length !== 1 || !hasMatchingTerminalProcessReceipt(processRow, receipts[0]!)) return 'retained';
    if (!await this.terminalOutputIsFullyRegistered(processRow)) return 'retained';
    return this.removeArchivedSpool(processRow);
  }

  /**
   * Startup sweep for spools left behind by a previous Host. Incomplete output is first imported
   * from the spool; ambiguous and unreadable entries stay in place for a later recovery pass.
   */
  public async cleanupArchivedSpools(signal?: AbortSignal): Promise<ProcessSpoolCleanupReport> {
    signal?.throwIfAborted();
    await this.validateBinding();
    const [processRows, receiptRows, mismatches] = await Promise.all([
      listAllDomainRows(this.database, 'Process'),
      listAllDomainRows(this.database, 'ProcessReceipt'),
      this.database.processOutputRegistrationMismatches()
    ]);
    const receiptsByProcess = new Map<string, DomainRow[]>();
    for (const receipt of receiptRows) {
      const processId = requireId(receipt.process_id, 'ProcessReceipt.process_id');
      const current = receiptsByProcess.get(processId) ?? [];
      current.push(receipt);
      receiptsByProcess.set(processId, current);
    }
    const mismatchIds = new Set(mismatches.map((entry) => entry.processId));
    const candidates = processRows.filter((row) => ARCHIVABLE_PROCESS_STATUSES.has(String(row.status)));
    const report: ProcessSpoolCleanupReport = {
      scanned: candidates.length,
      removed: 0,
      alreadyAbsent: 0,
      retained: 0,
      failed: 0
    };

    for (let offset = 0; offset < candidates.length; offset += PROCESS_SPOOL_CLEANUP_BATCH_SIZE) {
      signal?.throwIfAborted();
      await this.validateBinding();
      const batch = candidates.slice(offset, offset + PROCESS_SPOOL_CLEANUP_BATCH_SIZE);
      const outcomes = await Promise.all(batch.map(async (processRow): Promise<keyof Omit<ProcessSpoolCleanupReport, 'scanned'>> => {
        const processId = requireId(processRow.id, 'Process.id');
        const receipts = receiptsByProcess.get(processId) ?? [];
        if (receipts.length !== 1 || !hasMatchingTerminalProcessReceipt(processRow, receipts[0]!)) return 'retained';
        if (mismatchIds.has(processId)) {
          try {
            await this.reconcileOutput(processId);
          } catch (error) {
            console.warn(`[reliable-kernel] retained incomplete process spool ${processId}:`, errorMessage(error));
            return 'failed';
          }
        }
        try {
          const outcome = await this.removeArchivedSpool(processRow);
          return outcome === 'removed' ? 'removed' : 'alreadyAbsent';
        } catch (error) {
          console.warn(`[reliable-kernel] failed to clean archived process spool ${processId}:`, errorMessage(error));
          return 'failed';
        }
      }));
      for (const outcome of outcomes) report[outcome] += 1;
    }
    return report;
  }

  private async reconcileOutputBounded(processId: string, maxAttempts: number,
    proofFenceBudget: OutputPrefixRetryBudget = { remainingAttempts: PROCESS_RECONCILE_MAX_RETRIES_PER_DETAIL }): Promise<ReconciledOutput> {
    await this.validateBinding();
    // A concurrent exit/import or a changed metadata fence may invalidate the selected snapshot.
    // Restart only on that explicit evidence; every import pass otherwise makes keyset progress.
    for (let attempt = 1; ; attempt += 1) {
      try {
        const processRow = await this.requireExisting('Process', processId);
        if (
          ARCHIVABLE_PROCESS_STATUSES.has(String(processRow.status))
          && await this.terminalOutputIsFullyRegistered(processRow)
        ) {
          return { ...processRowOutputCounters(processRow), insertedChunks: 0 };
        }
        const spoolPath = processSpoolPath(this.binding, requireText(processRow.spool_locator, 'Process.spool_locator'));
        await this.requireMatchingSpoolEvidence(processRow, spoolPath);
        const manifest = await this.readManifest(spoolPath, processRow);
        const counters = outputCounters(manifest);
        assertProcessOutputProgress(processRow, counters, manifest.status);
        return await this.reconcileOutputPrefix(processRow, spoolPath, manifest, counters);
      } catch (error) {
        if (error instanceof ProcessOutputSnapshotAdvancedError) {
          const proofCanRetry = error.reason !== 'proof_fence' || --proofFenceBudget.remainingAttempts > 0;
          if (attempt < maxAttempts && proofCanRetry) continue;
        }
        throw error;
      }
    }
  }

  /**
   * Imports the latest immutable chunk prefix and captures the wrapper's matching stable live
   * tails. The returned retained counters let the detail reader reject a concurrently superseded
   * pairing before it combines CAS bytes and live bytes into one stream.
   */
  public async snapshotOutputForDetail(processIdInput: string): Promise<ProcessDetailOutputSnapshot> {
    const processId = requireId(processIdInput, 'processId');
    const proofFenceBudget = { remainingAttempts: PROCESS_RECONCILE_MAX_RETRIES_PER_DETAIL };
    for (let attempt = 1; attempt <= PROCESS_DETAIL_SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.reconcileOutputBounded(processId, PROCESS_RECONCILE_MAX_RETRIES_PER_DETAIL, proofFenceBudget);
      } catch (error) {
        if (!(error instanceof ProcessOutputSnapshotAdvancedError)) throw error;
        const current = await this.requireExisting('Process', processId);
        return processDetailDurablePrefix(processRowOutputCounters(current));
      }
      const processRow = await this.requireExisting('Process', processId);
      if (ARCHIVABLE_PROCESS_STATUSES.has(String(processRow.status))) {
        try {
          if (await this.terminalOutputIsFullyRegistered(processRow)) {
            return processDetailDurablePrefix(processRowOutputCounters(processRow));
          }
        } catch (error) {
          if (!(error instanceof ProcessOutputSnapshotAdvancedError)) throw error;
          const proofCanRetry = error.reason !== 'proof_fence' || --proofFenceBudget.remainingAttempts > 0;
          if (attempt < PROCESS_DETAIL_SNAPSHOT_MAX_ATTEMPTS && proofCanRetry) continue;
          const current = await this.requireExisting('Process', processId);
          return processDetailDurablePrefix(processRowOutputCounters(current));
        }
      }
      const spoolPath = processSpoolPath(this.binding, requireText(processRow.spool_locator, 'Process.spool_locator'));
      await this.requireMatchingSpoolEvidence(processRow, spoolPath);
      const manifest = await this.readManifest(spoolPath, processRow);
      const observed = outputCounters(manifest);
      assertProcessOutputProgress(processRow, observed, manifest.status);
      const retained = processRowOutputCounters(processRow);
      if (!outputCounterValuesEqual(retained, observed)) {
        if (attempt < PROCESS_DETAIL_SNAPSHOT_MAX_ATTEMPTS) continue;
        return processDetailDurablePrefix(retained);
      }
      if (manifest.status === 'exited') {
        return {
          retainedBytes: retained.retainedBytes.toString(),
          retainedChunks: retained.retainedChunks.toString(),
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0)
        };
      }
      const live = await this.readStableLiveTails(spoolPath, processRow, manifest);
      if (!live) {
        if (attempt < PROCESS_DETAIL_SNAPSHOT_MAX_ATTEMPTS) continue;
        return processDetailDurablePrefix(retained);
      }
      return {
        retainedBytes: retained.retainedBytes.toString(),
        retainedChunks: retained.retainedChunks.toString(),
        stdout: live.stdout,
        stderr: live.stderr
      };
    }
    throw new Error('Unreachable process detail snapshot retry state.');
  }

  /** A terminal continuation handle proves that its immutable retained prefix was already reconciled. */
  public async reconcileOutputForRead(
    processIdInput: string,
    outputHandleInput?: unknown
  ): Promise<ReconciledOutput> {
    const processId = requireId(processIdInput, 'processId');
    await this.validateBinding();
    if (outputHandleInput !== undefined && outputHandleInput !== null && outputHandleInput !== '') {
      const cursor = decodeProcessOutputHandle(outputHandleInput, processId);
      const processRow = await this.requireExisting('Process', processId);
      const counters = processRowOutputCounters(processRow);
      if (
        processRow.status !== 'running'
        && cursor.reconciledRetainedChunks === counters.retainedChunks
      ) return { ...counters, insertedChunks: 0 };
    }
    return this.reconcileOutput(processId);
  }

  /**
   * Reads one immutable keyset page. The opaque handle carries the next global chunk sequence and
   * at most three pending UTF-8 bytes per stream, so concatenating page strings is lossless even
   * when wrapper chunk/page boundaries bisect a code point.
   */
  public async readOutputPage(
    processIdInput: string,
    outputHandleInput?: unknown,
    maxBytes = PROCESS_OUTPUT_READ_PAGE_MAX_BYTES
  ): Promise<ProcessOutputPageReadResult> {
    const processId = requireId(processIdInput, 'processId');
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > PROCESS_OUTPUT_READ_PAGE_MAX_BYTES) {
      throw new RangeError(`Process output page maxBytes must be from 1 to ${PROCESS_OUTPUT_READ_PAGE_MAX_BYTES}.`);
    }
    await this.validateBinding();
    const processRow = await this.requireExisting('Process', processId);
    const counters = processRowOutputCounters(processRow);
    const cursor = decodeProcessOutputHandle(outputHandleInput, processId);
    if (cursor.nextChunkSeq > counters.retainedChunks + 1n) {
      throw new RangeError('Process output handle is beyond the retained chunk prefix.');
    }
    if (cursor.nextChunkSeq === counters.retainedChunks + 1n && cursor.nextChunkOffset !== 0) {
      throw new RangeError('Process output handle offset is beyond the retained chunk prefix.');
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let pageBytes = 0n;
    let pageChunks = 0n;
    let nextChunkSeq = cursor.nextChunkSeq;
    let nextChunkOffset = cursor.nextChunkOffset;
    outputPage: while (nextChunkSeq <= counters.retainedChunks) {
      const remaining = counters.retainedChunks - nextChunkSeq + 1n;
      const rowCount = Number(remaining < BigInt(PROCESS_OUTPUT_METADATA_READ_ROWS)
        ? remaining
        : BigInt(PROCESS_OUTPUT_METADATA_READ_ROWS));
      const rows = await this.readOutputChunkRows(processId, nextChunkSeq, rowCount);
      for (const row of rows) {
        const chunkSeq = requireBigInt(row.chunk_seq, 'ProcessOutputChunk.chunk_seq');
        const byteLength = requireBigInt(row.byte_length, 'ProcessOutputChunk.byte_length');
        const metadata = await this.requireExisting(
          'ContentObject',
          requireId(row.content_object_id, 'ProcessOutputChunk.content_object_id')
        ) as ContentObjectMetadata;
        const bytes = await this.contentStore.read(metadata);
        if (BigInt(bytes.byteLength) !== byteLength) {
          throw new Error(`ProcessOutputChunk ${String(row.id)} CAS length mismatch.`);
        }
        const offset = chunkSeq === nextChunkSeq ? nextChunkOffset : 0;
        if (offset < 0 || offset >= Math.max(1, bytes.byteLength)) {
          throw new RangeError('Process output handle chunk offset is invalid.');
        }
        const remainingBudget = maxBytes - Number(pageBytes);
        if (remainingBudget <= 0) break outputPage;
        const available = bytes.subarray(offset);
        const take = Math.min(available.byteLength, remainingBudget);
        const pagePart = available.subarray(0, take);
        (requireStreamKind(row.stream_kind) === 'stdout' ? stdout : stderr).push(pagePart);
        pageBytes += BigInt(pagePart.byteLength);
        pageChunks += 1n;
        if (take < available.byteLength) {
          nextChunkSeq = chunkSeq;
          nextChunkOffset = offset + take;
          break outputPage;
        }
        nextChunkSeq = chunkSeq + 1n;
        nextChunkOffset = 0;
      }
      if (pageBytes >= BigInt(maxBytes)) break;
      if (rows.length < rowCount || nextChunkSeq > counters.retainedChunks) break;
    }

    const hasMore = nextChunkSeq <= counters.retainedChunks;
    const complete = processRow.status !== 'running' && !hasMore;
    const stdoutText = decodeUtf8OutputPage(cursor.stdoutCarry, stdout, complete);
    const stderrText = decodeUtf8OutputPage(cursor.stderrCarry, stderr, complete);
    let liveStdout = '';
    let liveStderr = '';
    let livePreviewBytes = 0n;
    if (processRow.status === 'running' && !hasMore) {
      const spoolPath = processSpoolPath(this.binding, requireText(processRow.spool_locator, 'Process.spool_locator'));
      await this.requireMatchingSpoolEvidence(processRow, spoolPath);
      const manifest = await this.readManifest(spoolPath, processRow);
      const manifestCounters = outputCounters(manifest);
      assertProcessOutputProgress(processRow, manifestCounters, manifest.status);
      const live = outputCounterValuesEqual(counters, manifestCounters)
        ? await this.readStableLiveTails(spoolPath, processRow, manifest)
        : undefined;
      if (live) {
        liveStdout = decodeUtf8OutputPage(stdoutText.carry, [live.stdout], false).text;
        liveStderr = decodeUtf8OutputPage(stderrText.carry, [live.stderr], false).text;
        livePreviewBytes = BigInt(live.stdout.byteLength + live.stderr.byteLength);
      }
    }
    const nextOutputHandle = encodeProcessOutputHandle({
      processId,
      nextChunkSeq,
      nextChunkOffset,
      reconciledRetainedChunks: counters.retainedChunks,
      stdoutCarry: stdoutText.carry,
      stderrCarry: stderrText.carry
    });
    return {
      processId,
      status: String(processRow.status),
      stdout: stdoutText.text,
      stderr: stderrText.text,
      liveStdout,
      liveStderr,
      livePreviewBytes: livePreviewBytes.toString(),
      pageBytes: pageBytes.toString(),
      pageChunks: pageChunks.toString(),
      retainedBytes: counters.retainedBytes.toString(),
      retainedChunks: counters.retainedChunks.toString(),
      droppedBytes: counters.droppedBytes.toString(),
      truncated: counters.truncated,
      hasMore,
      complete,
      nextOutputHandle
    };
  }

  /** Reads only terminal-notification tails; scans metadata by keyset without materializing history. */
  public async readOutputTail(
    processIdInput: string,
    maxBytesPerStream: number
  ): Promise<ProcessOutputReadResult> {
    const processId = requireId(processIdInput, 'processId');
    if (!Number.isSafeInteger(maxBytesPerStream) || maxBytesPerStream <= 0) {
      throw new RangeError('Process output tail maxBytesPerStream must be a positive safe integer.');
    }
    await this.validateBinding();
    const processRow = await this.requireExisting('Process', processId);
    const counters = processRowOutputCounters(processRow);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let nextChunkSeq = counters.retainedChunks;
    while (nextChunkSeq > 0n && (stdoutBytes < maxBytesPerStream || stderrBytes < maxBytesPerStream)) {
      const firstChunkSeq = nextChunkSeq >= BigInt(PROCESS_OUTPUT_METADATA_READ_ROWS)
        ? nextChunkSeq - BigInt(PROCESS_OUTPUT_METADATA_READ_ROWS) + 1n
        : 1n;
      const rows = await this.readOutputChunkRows(
        processId,
        firstChunkSeq,
        Number(nextChunkSeq - firstChunkSeq + 1n)
      );
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index]!;
        const streamKind = requireStreamKind(row.stream_kind);
        const needsBytes = streamKind === 'stdout'
          ? stdoutBytes < maxBytesPerStream
          : stderrBytes < maxBytesPerStream;
        if (needsBytes) {
          const metadata = await this.requireExisting(
            'ContentObject',
            requireId(row.content_object_id, 'ProcessOutputChunk.content_object_id')
          ) as ContentObjectMetadata;
          const bytes = await this.contentStore.read(metadata);
          const byteLength = requireBigInt(row.byte_length, 'ProcessOutputChunk.byte_length');
          if (BigInt(bytes.byteLength) !== byteLength) {
            throw new Error(`ProcessOutputChunk ${String(row.id)} CAS length mismatch.`);
          }
          if (streamKind === 'stdout') {
            stdout.unshift(bytes);
            stdoutBytes += bytes.byteLength;
          } else {
            stderr.unshift(bytes);
            stderrBytes += bytes.byteLength;
          }
        }
        if (stdoutBytes >= maxBytesPerStream && stderrBytes >= maxBytesPerStream) break;
      }
      nextChunkSeq = firstChunkSeq - 1n;
    }
    return {
      processId,
      status: String(processRow.status),
      stdout: boundedBufferTail(stdout, maxBytesPerStream),
      stderr: boundedBufferTail(stderr, maxBytesPerStream),
      retainedBytes: counters.retainedBytes.toString(),
      retainedChunks: counters.retainedChunks.toString(),
      droppedBytes: counters.droppedBytes.toString(),
      truncated: counters.truncated
    };
  }

  /**
   * Enables the application-owned exit observer service after deterministic startup recovery.
   * Existing running Processes are seeded from SQLite; later process_start commits register through
   * reconcileStartReceipt. One bounded-cadence observer exists per Process and never redispatches it.
   */
  public async startExitObservers(): Promise<{ scanned: number; started: number }> {
    if (this.exitObserversClosing) throw new Error('Process exit observers are closing.');
    this.exitObserversEnabled = true;
    const running = await listAllDomainRows(this.database, 'Process', { status: 'running' });
    let started = 0;
    for (const processRow of running) {
      const processId = requireId(processRow.id, 'Process.id');
      const receipts = await this.list('ProcessReceipt', { process_id: processId }, 2);
      if (receipts.length > 0) {
        this.notifyProcessReceipt(processId);
        continue;
      }
      const intent = await this.requireExisting('EffectIntent', processExitIds(processId).effectIntentId);
      if (intent.effect_kind !== 'process_exit' || !['dispatched', 'receipt_written'].includes(String(intent.dispatch_state))) {
        throw new Error(`Running Process ${processId} lacks a dispatched process_exit EffectIntent.`);
      }
      if (this.ensureExitObserver(processId)) started += 1;
    }
    return { scanned: running.length, started };
  }

  public inspectExitObservers(): ProcessExitObserverInspection {
    return {
      enabled: this.exitObserversEnabled,
      closing: this.exitObserversClosing,
      activeProcessIds: [...this.exitObservers.keys()].sort()
    };
  }

  /** Stops timers and drains in-flight observer transactions before RuntimeDatabase closes. */
  public dispose(): Promise<void> {
    if (this.exitObserversDisposePromise) return this.exitObserversDisposePromise;
    this.exitObserversEnabled = false;
    this.exitObserversClosing = true;
    this.releaseOutputPrefixProofs();
    for (const wake of [...this.exitObserverWakeups]) wake();
    const active = [...this.exitObservers.values()];
    this.exitObserversDisposePromise = Promise.allSettled(active).then(() => undefined);
    return this.exitObserversDisposePromise;
  }

  /** Observes wrapper evidence only. A local timeout never changes Process state. */
  public async wait(processIdInput: string, timeoutMs = 0): Promise<ProcessWaitObservation> {
    const processId = requireId(processIdInput, 'processId');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new TypeError('wait timeoutMs must be a non-negative integer.');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const observed = await this.observeProcess(processId);
      if (observed.state !== 'running' || Date.now() >= deadline) return observed;
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  }

  public async reconcileProcessExit(processIdInput: string): Promise<ProcessWaitObservation> {
    const processId = requireId(processIdInput, 'processId');
    const observed = await this.observeProcess(processId);
    if (observed.state === 'running') return observed;
    const existing = (await this.list('ProcessReceipt', { process_id: processId }, 2))[0];
    if (existing) {
      this.notifyProcessReceipt(processId);
      return observed;
    }
    const ids = processExitIds(processId);
    const intent = await this.requireExisting('EffectIntent', ids.effectIntentId);
    if (intent.effect_kind !== 'process_exit') throw new Error('Process exit observation has no process_exit EffectIntent.');
    const recorded = await this.effects.recordEffectReceipt({
      source: { kind: 'callback', key: `process-exit:${ids.attemptId}:receipt` },
      attemptId: ids.attemptId,
      effectKind: 'process_exit',
      outcome: processExitOutcome(observed),
      detail: observed
    });
    return this.reconcileExitEffectReceipt(recorded.effectReceiptId, 'internal');
  }

  public async reconcileExitEffectReceipt(
    effectReceiptIdInput: string,
    sourceKind: 'internal' | 'recovery'
  ): Promise<ProcessWaitObservation> {
    const effectReceiptId = requireId(effectReceiptIdInput, 'effectReceiptId');
    const receipt = await this.requireExisting('EffectReceipt', effectReceiptId);
    if (receipt.effect_kind !== 'process_exit') throw new Error('EffectReceipt is not process_exit.');
    const attempt = await this.requireExisting('Attempt', requireId(receipt.attempt_id, 'EffectReceipt.attempt_id'));
    const operation = await this.requireExisting('Operation', requireId(attempt.operation_id, 'Attempt.operation_id'));
    if (operation.owner_kind !== 'process' || operation.tool_call_id !== null) {
      throw new Error('process_exit Operation must be owned by Process and detached from ToolCall.');
    }
    const processId = requireId(operation.owner_id, 'Operation.owner_id');
    const processRow = await this.requireExisting('Process', processId);
    const intents = await this.list('EffectIntent', { attempt_id: attempt.id }, 2);
    if (intents.length !== 1) throw new Error('process_exit Attempt must have one EffectIntent.');
    const request = normalizeExitRequest(
      await this.effects.readEffectRequest<ProcessExitEffectRequest>(intents[0].id as string)
    );
    assertExitRequestMatchesProcess(request, processRow);
    const detail = await this.readReceiptDetail<unknown>(receipt);
    const observed = normalizeProcessExitObservation(detail, processRow, receipt.outcome);
    const now = this.timestamp();
    const additionalSteps: RepositoryTransactionStep[] = [];
    if (observed.state === 'outcome_unknown') {
      additionalSteps.push(
        DOMAIN_REPOSITORIES.domain('ProcessReceipt').insert({
          id: stablePhaseDId('process_receipt', processId),
          process_id: processId,
          outcome: 'outcome_unknown',
          exit_code: null,
          exit_signal: null,
          wrapper_nonce: processRow.wrapper_nonce,
          start_fingerprint: processRow.start_fingerprint,
          received_at: now
        }),
        processCompletionDispatchInsert(processId, now),
        DOMAIN_REPOSITORIES.domain('Process').update(processId, {
          status: 'outcome_unknown',
          updated_at: now,
          completed_at: now
        })
      );
    } else {
      const exit = observed.receipt;
      const outcome = processExitOutcome(observed);
      additionalSteps.push(
        DOMAIN_REPOSITORIES.domain('ProcessReceipt').insert({
          id: stablePhaseDId('process_receipt', processId),
          process_id: processId,
          outcome: processReceiptOutcome(exit),
          exit_code: exit.exitCode,
          exit_signal: exit.signal,
          wrapper_nonce: exit.stableNonce,
          start_fingerprint: exit.startFingerprint,
          received_at: now
        }),
        processCompletionDispatchInsert(processId, now),
        DOMAIN_REPOSITORIES.domain('Process').update(processId, {
          status: processTerminalStatus(exit),
          retained_bytes: exit.retainedBytes,
          retained_chunks: exit.retainedChunks,
          dropped_bytes: exit.droppedBytes,
          truncated: exit.truncated ? '1' : '0',
          updated_at: now,
          completed_at: exit.exitedAt
        })
      );
    }
    await this.effects.completeDetachedOperation({
      source: { kind: sourceKind, key: `process-exit-reconcile:${effectReceiptId}` },
      effectReceiptId,
      outcome: processExitOutcome(observed),
      additionalSteps
    });
    this.notifyProcessReceipt(processId);
    return this.observeProcess(processId);
  }

  public async recoverDispatchedExit(input: {
    source: PhaseDCommandSource;
    effectIntentId: string;
  }): Promise<ProcessWaitObservation> {
    if (input.source.kind !== 'recovery') throw new TypeError('Process exit recovery requires recovery source kind.');
    const intent = await this.requireExisting('EffectIntent', requireId(input.effectIntentId, 'effectIntentId'));
    if (intent.effect_kind !== 'process_exit') throw new Error('Recovery target must be process_exit.');
    const attempt = await this.requireExisting('Attempt', requireId(intent.attempt_id, 'EffectIntent.attempt_id'));
    const operation = await this.requireExisting('Operation', requireId(attempt.operation_id, 'Attempt.operation_id'));
    const processId = requireId(operation.owner_id, 'Operation.owner_id');
    const processRow = await this.requireExisting('Process', processId);
    const request = normalizeExitRequest(
      await this.effects.readEffectRequest<ProcessExitEffectRequest>(intent.id as string)
    );
    assertExitRequestMatchesProcess(request, processRow);
    const existing = (await this.list('EffectReceipt', { attempt_id: attempt.id }, 2))[0];
    if (existing) return this.reconcileExitEffectReceipt(existing.id as string, 'recovery');
    if (intent.dispatch_state !== 'dispatched') {
      throw new Error('Recovery without a Receipt requires a dispatched process_exit EffectIntent.');
    }
    const observed = await this.observeProcess(processId);
    if (observed.state === 'running') return observed;
    const recorded = await this.effects.recordEffectReceipt({
      source: input.source,
      attemptId: attempt.id as string,
      effectKind: 'process_exit',
      outcome: processExitOutcome(observed),
      detail: observed
    });
    return this.reconcileExitEffectReceipt(recorded.effectReceiptId, 'recovery');
  }

  /** Recovery never launches again: it only verifies wrapper evidence or records unknown. */
  public async recoverDispatchedStart(input: {
    source: PhaseDCommandSource;
    effectIntentId: string;
  }): Promise<ToolTerminalResult | null> {
    if (input.source.kind !== 'recovery') throw new TypeError('Process recovery requires recovery source kind.');
    const intent = await this.requireExisting('EffectIntent', requireId(input.effectIntentId, 'effectIntentId'));
    if (intent.effect_kind !== PROCESS_START) throw new Error('Recovery target must be process_start.');
    const existing = (await this.list('EffectReceipt', { attempt_id: intent.attempt_id }, 2))[0];
    if (existing) return this.reconcileStartReceipt(existing.id as string);
    if (intent.dispatch_state !== 'dispatched') {
      throw new Error('Recovery without a Receipt requires a dispatched process_start EffectIntent.');
    }
    const request = normalizeStartRequest(await this.effects.readEffectRequest<ProcessStartRequest>(intent.id as string));
    await this.validateBinding();
    const spoolPath = processSpoolPath(this.binding, request.spoolLocator);
    let launch: ProcessLaunchObservation;
    try {
      const failure = parseWrapperLaunchFailureReceipt(
        await readJson(path.join(spoolPath, PROCESS_WRAPPER_LAUNCH_FAILURE_FILE))
      );
      assertLaunchFailureMatchesStart(request, failure);
      launch = { outcome: 'failed', error: launchFailureMessage(failure) };
    } catch (failureError) {
      try {
        const identity = parseWrapperIdentity(await readJson(path.join(spoolPath, PROCESS_WRAPPER_IDENTITY_FILE)));
        assertIdentityMatchesStart(identity, request);
        launch = { outcome: 'succeeded', identity };
      } catch (identityError) {
        try {
          const receipt = parseWrapperExitReceipt(await readJson(path.join(spoolPath, PROCESS_WRAPPER_EXIT_RECEIPT_FILE)));
          assertExitReceiptMatchesStartRequest(request, receipt);
          launch = {
            outcome: 'succeeded',
            identity: identityFromExitReceipt(request, receipt, requireText(intent.created_at, 'EffectIntent.created_at'))
          };
        } catch (receiptError) {
          launch = {
            outcome: 'outcome_unknown',
            error: `${errorMessage(failureError)}; ${errorMessage(identityError)}; ${errorMessage(receiptError)}`
          };
        }
      }
    }
    const observation = await this.observeStart(request, launch, 0);
    const recorded = await this.effects.recordEffectReceipt({
      source: input.source,
      attemptId: intent.attempt_id as string,
      effectKind: PROCESS_START,
      outcome: observation.outcome,
      detail: observation
    });
    return this.reconcileStartReceipt(recorded.effectReceiptId);
  }

  private ensureExitObserver(processIdInput: string): boolean {
    const processId = requireId(processIdInput, 'processId');
    if (!this.exitObserversEnabled || this.exitObserversClosing || this.exitObservers.has(processId)) return false;
    const task = runWithoutExecutionLeaseFence(() => this.runExitObserver(processId));
    this.exitObservers.set(processId, task);
    return true;
  }

  private async runExitObserver(processId: string): Promise<void> {
    try {
      while (!this.exitObserversClosing) {
        try {
          const observed = await this.reconcileProcessExit(processId);
          if (observed.state !== 'running') return;
        } catch (error) {
          if (this.exitObserversClosing) return;
          try {
            this.onExitObserverError?.({ processId, error });
          } catch {
            // Diagnostics are observational and must never create a second control path.
          }
        }
        await this.waitForExitObserverPoll();
      }
    } finally {
      this.exitObservers.delete(processId);
    }
  }

  private waitForExitObserverPoll(): Promise<void> {
    if (this.exitObserversClosing) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.exitObserverWakeups.delete(finish);
        resolve();
      };
      timer = setTimeout(finish, PROCESS_EXIT_OBSERVER_POLL_MS);
      timer.unref?.();
      this.exitObserverWakeups.add(finish);
    });
  }

  private async observeProcess(processId: string): Promise<ProcessWaitObservation> {
    await this.validateBinding();
    const evidence = await this.readPersistedProcessEvidence(processId);
    const processRow = evidence.process;
    if (evidence.receipt) return persistedProcessObservation(processRow, evidence.receipt);
    const spoolPath = processSpoolPath(this.binding, requireText(processRow.spool_locator, 'Process.spool_locator'));
    try {
      const receipt = parseWrapperExitReceipt(await retryLocalExecution(() => readJson(path.join(spoolPath, PROCESS_WRAPPER_EXIT_RECEIPT_FILE))));
      assertExitReceiptMatchesProcess(processRow, receipt);
      this.recordTerminalReceiptMetric(processId);
      return { state: 'exited', processId, receipt };
    } catch (error) {
      if (error instanceof LocalExecutionRecoveryExhaustedError) throw error;
      if (!isNotFound(error)) return { state: 'outcome_unknown', processId, reason: errorMessage(error) };
    }
    let identity: ProcessWrapperIdentity;
    try {
      identity = await retryLocalExecution(() => this.requireMatchingIdentity(processRow, spoolPath));
    } catch (error) {
      if (error instanceof LocalExecutionRecoveryExhaustedError) throw error;
      return { state: 'outcome_unknown', processId, reason: errorMessage(error) };
    }
    return this.observeVerifiedIdentity(identity, spoolPath);
  }

  private async observeStart(
    request: ProcessStartRequest,
    launch: ProcessLaunchObservation,
    foregroundWaitMs: number,
    signal?: AbortSignal
  ): Promise<ProcessStartObservation> {
    if (launch.outcome !== 'succeeded') {
      return {
        outcome: launch.outcome,
        state: launch.outcome === 'failed'
          ? 'launch_failed'
          : launch.outcome === 'cancelled'
            ? 'launch_cancelled'
            : 'outcome_unknown',
        processId: request.processId,
        launch,
        foreground: null
      };
    }
    await this.validateBinding();
    const spoolPath = processSpoolPath(this.binding, request.spoolLocator);
    const deadline = Date.now() + foregroundWaitMs;
    let foreground: ProcessWaitObservation;
    do {
      foreground = await this.observeVerifiedIdentity(launch.identity, spoolPath);
      if (foreground.state !== 'running' || Date.now() >= deadline || signal?.aborted) break;
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    } while (true);
    return {
      outcome: processWaitOutcome(foreground),
      state: foreground.state === 'running'
        ? 'background_started'
        : foreground.state === 'exited'
          ? 'completed'
          : 'outcome_unknown',
      processId: request.processId,
      launch,
      foreground
    };
  }

  private async observeVerifiedIdentity(
    identity: ProcessWrapperIdentity,
    spoolPath: string
  ): Promise<ProcessWaitObservation> {
    const processId = identity.processId;
    try {
      const raw = await retryLocalExecution(() => readJson(path.join(spoolPath, PROCESS_WRAPPER_EXIT_RECEIPT_FILE)));
      const receipt = parseWrapperExitReceipt(raw);
      assertExitReceiptMatches(identity, receipt);
      this.recordTerminalReceiptMetric(processId);
      return { state: 'exited', processId, receipt };
    } catch (error) {
      if (error instanceof LocalExecutionRecoveryExhaustedError) throw error;
      if (!isNotFound(error)) return { state: 'outcome_unknown', processId, reason: errorMessage(error) };
    }
    if (!isWrapperProcessReachable(identity.wrapperPid, path.join(spoolPath, 'launch.json'))) {
      // The wrapper can atomically publish its receipt and exit between the first receipt read and
      // this liveness check. Re-read the terminal authority before classifying that normal race as
      // outcome_unknown.
      const deadline = Date.now() + WRAPPER_EXIT_RECEIPT_SETTLE_MS;
      do {
        try {
          const receipt = parseWrapperExitReceipt(
            await retryLocalExecution(() => readJson(path.join(spoolPath, PROCESS_WRAPPER_EXIT_RECEIPT_FILE)))
          );
          assertExitReceiptMatches(identity, receipt);
          this.recordTerminalReceiptMetric(processId);
          return { state: 'exited', processId, receipt };
        } catch (error) {
          if (error instanceof LocalExecutionRecoveryExhaustedError) throw error;
          if (!isNotFound(error)) {
            return { state: 'outcome_unknown', processId, reason: errorMessage(error) };
          }
        }
        if (Date.now() < deadline) await sleep(Math.min(WRAPPER_IDENTITY_POLL_MS, deadline - Date.now()));
      } while (Date.now() < deadline);
      return {
        state: 'outcome_unknown',
        processId,
        reason: 'Recorded wrapper is unreachable and no valid atomic exit receipt exists.'
      };
    }
    try {
      if (readProcessStartFingerprint(identity.childPid) !== identity.startFingerprint) {
        return {
          state: 'outcome_unknown',
          processId,
          reason: 'Live child PID no longer matches its persisted start fingerprint.'
        };
      }
    } catch (error) {
      if (!isNotFound(error)) {
        return { state: 'outcome_unknown', processId, reason: errorMessage(error) };
      }
      // The wrapper is still reachable: the child may have closed while its receipt is being fsynced.
    }
    return { state: 'running', processId };
  }

  private async reconcileOutputPrefix(
    selectedProcessRow: DomainRow,
    spoolPath: string,
    manifest: ProcessWrapperManifest,
    counters: ProcessOutputCounters
  ): Promise<ReconciledOutput> {
    const processId = requireId(selectedProcessRow.id, 'Process.id');
    const outputImportStartedAt = this.database.performanceMetrics ? performance.now() : undefined;
    const proofFence = await this.outputPrefixReadFence();
    const known = this.verifiedOutputPrefix(selectedProcessRow, counters);
    let nextChunkSeq = (known?.retainedChunks ?? 0n) + 1n;
    let representedBytes = known?.retainedBytes ?? 0n;
    let representedChunks = known?.retainedChunks ?? 0n;
    let insertedChunks = 0;
    let pending: PreparedProcessOutputChunk[] = [];
    const estimateTimestamp = requireText(selectedProcessRow.updated_at, 'Process.updated_at');

    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      // Chunk batches become durable first. Publishing the newly observed retained_* counters is
      // the final fence, so readers never see a running Process claim a prefix whose CAS rows are
      // still queued in later transactions.
      insertedChunks += await this.commitProcessOutputBatch(processId, manifest, counters, pending, false);
      pending = [];
    };

    while (nextChunkSeq <= counters.retainedChunks) {
      const remaining = counters.retainedChunks - nextChunkSeq + 1n;
      const rowCount = Number(remaining < BigInt(PROCESS_OUTPUT_METADATA_READ_ROWS)
        ? remaining
        : BigInt(PROCESS_OUTPUT_METADATA_READ_ROWS));
      const reads = Array.from({ length: rowCount }, (_, index) => {
        const chunkSeq = nextChunkSeq + BigInt(index);
        return DOMAIN_REPOSITORIES.domain('ProcessOutputChunk').get(processOutputChunkId(processId, chunkSeq));
      });
      const snapshot = await this.database.snapshot(reads);
      for (let index = 0; index < rowCount; index += 1) {
        const chunkSeq = nextChunkSeq + BigInt(index);
        const row = snapshot.snapshot[index];
        if (Array.isArray(row)) throw new TypeError('ProcessOutputChunk get returned rows.');
        if (row) {
          validateRegisteredProcessOutputChunk(row, processId, chunkSeq);
          representedBytes += requireBigInt(row.byte_length, 'ProcessOutputChunk.byte_length');
          representedChunks += 1n;
          continue;
        }

        const prepared = await this.prepareProcessOutputChunk(processId, spoolPath, chunkSeq);
        representedBytes += prepared.byteLength;
        representedChunks += 1n;
        const tentative = [...pending, prepared];
        const estimated = processOutputTransactionWireBytes(
          processOutputTransactionSteps(selectedProcessRow, counters, tentative, estimateTimestamp)
        );
        if (
          pending.length > 0
          && estimated > PROCESS_OUTPUT_TRANSACTION_MAX_WIRE_BYTES
        ) {
          await flush();
        }
        const singleEstimate = processOutputTransactionWireBytes(
          processOutputTransactionSteps(selectedProcessRow, counters, [prepared], estimateTimestamp)
        );
        if (singleEstimate > PROCESS_OUTPUT_TRANSACTION_MAX_WIRE_BYTES) {
          throw new Error(`Process output chunk ${chunkSeq} metadata exceeds the transaction wire budget.`);
        }
        pending.push(prepared);
      }
      nextChunkSeq += BigInt(rowCount);
    }

    await flush();
    assertOutputCoverage(
      representedBytes,
      representedChunks,
      counters.retainedBytes,
      counters.retainedChunks
    );
    await this.commitProcessOutputBatch(processId, manifest, counters, [], true);
    await this.rememberOutputPrefix(selectedProcessRow, counters, false, proofFence);
    if (outputImportStartedAt !== undefined) {
      this.database.recordPerformanceMetric({
        kind: 'process.phase',
        phase: 'output_import',
        durationMs: performance.now() - outputImportStartedAt,
        byteCount: Number(counters.retainedBytes)
      });
    }
    return {
      retainedBytes: counters.retainedBytes,
      retainedChunks: counters.retainedChunks,
      droppedBytes: counters.droppedBytes,
      truncated: counters.truncated,
      insertedChunks
    };
  }

  private async prepareProcessOutputChunk(
    processId: string,
    spoolPath: string,
    chunkSeq: bigint
  ): Promise<PreparedProcessOutputChunk> {
    const stdoutPath = path.join(
      spoolPath,
      PROCESS_WRAPPER_CHUNKS_DIRECTORY,
      processChunkFileName(chunkSeq, 'stdout')
    );
    const stderrPath = path.join(
      spoolPath,
      PROCESS_WRAPPER_CHUNKS_DIRECTORY,
      processChunkFileName(chunkSeq, 'stderr')
    );
    const [stdoutStat, stderrStat] = await Promise.all([
      statRegularFileIfPresent(stdoutPath),
      statRegularFileIfPresent(stderrPath)
    ]);
    if ((stdoutStat ? 1 : 0) + (stderrStat ? 1 : 0) !== 1) {
      throw new Error(`Process spool chunk ${chunkSeq} must have exactly one stream file.`);
    }
    const streamKind = stdoutStat ? 'stdout' as const : 'stderr' as const;
    const chunkPath = stdoutStat ? stdoutPath : stderrPath;
    const stat = stdoutStat ?? stderrStat!;
    if (stat.size <= 0 || stat.size > PROCESS_OUTPUT_MAX_CHUNK_BYTES) {
      throw new Error(`Invalid process spool chunk ${chunkSeq}.`);
    }
    const bytes = await fs.readFile(chunkPath);
    if (bytes.byteLength !== stat.size) throw new Error(`Process spool chunk ${chunkSeq} changed during import.`);
    return {
      chunkSeq,
      streamKind,
      byteLength: BigInt(bytes.byteLength),
      createdAt: stat.mtime.toISOString(),
      content: await this.contentStore.prepare(this.database, bytes, 'application/octet-stream')
    };
  }

  private async commitProcessOutputBatch(
    processId: string,
    manifest: ProcessWrapperManifest,
    counters: ProcessOutputCounters,
    prepared: readonly PreparedProcessOutputChunk[],
    publishCounters: boolean
  ): Promise<number> {
    for (;;) {
      const currentProcessRow = await this.requireExisting('Process', processId);
      try {
        assertProcessOutputProgress(currentProcessRow, counters, manifest.status);
      } catch {
        throw new ProcessOutputSnapshotAdvancedError();
      }
      const missing: PreparedProcessOutputChunk[] = [];
      for (let offset = 0; offset < prepared.length; offset += PROCESS_OUTPUT_METADATA_READ_ROWS) {
        const page = prepared.slice(offset, offset + PROCESS_OUTPUT_METADATA_READ_ROWS);
        const snapshot = await this.database.snapshot(page.map((entry) => (
          DOMAIN_REPOSITORIES.domain('ProcessOutputChunk').get(processOutputChunkId(processId, entry.chunkSeq))
        )));
        for (let index = 0; index < page.length; index += 1) {
          const entry = page[index]!;
          const existing = snapshot.snapshot[index];
          if (Array.isArray(existing)) throw new TypeError('ProcessOutputChunk get returned rows.');
          if (!existing) {
            missing.push(entry);
            continue;
          }
          validateRegisteredProcessOutputChunk(existing, processId, entry.chunkSeq, entry);
        }
      }
      if (
        missing.length === 0
        && (!publishCounters || processCountersEqual(currentProcessRow, counters))
      ) return 0;
      const targetCounters = publishCounters ? counters : processRowOutputCounters(currentProcessRow);
      const steps = processOutputTransactionSteps(currentProcessRow, targetCounters, missing, this.timestamp());
      const wireBytes = processOutputTransactionWireBytes(steps);
      if (wireBytes > PROCESS_OUTPUT_TRANSACTION_MAX_WIRE_BYTES) {
        throw new Error(`Process output transaction requires ${wireBytes} wire bytes, exceeding its per-commit budget.`);
      }
      try {
        await this.database.transaction(steps);
        return missing.length;
      } catch (error) {
        if (isTransactionAssertionFailure(error)) continue;
        if (matchesExpectedUnique(error, [
          ['process_output_chunk', ['id']],
          ['process_output_chunk', ['process_id', 'chunk_seq']]
        ])) continue;
        throw error;
      }
    }
  }

  private async readOutputChunkRows(
    processId: string,
    firstChunkSeq: bigint,
    count: number
  ): Promise<DomainRow[]> {
    const reads = Array.from({ length: count }, (_, index) => {
      const chunkSeq = firstChunkSeq + BigInt(index);
      return DOMAIN_REPOSITORIES.domain('ProcessOutputChunk').get(processOutputChunkId(processId, chunkSeq));
    });
    const snapshot = await this.database.snapshot(reads);
    return snapshot.snapshot.map((row, index) => {
      const chunkSeq = firstChunkSeq + BigInt(index);
      if (!row || Array.isArray(row)) {
        throw new Error(`Process output registration has a gap at chunk ${chunkSeq}.`);
      }
      validateRegisteredProcessOutputChunk(row, processId, chunkSeq);
      return row;
    });
  }

  private async readStableLiveTails(
    spoolPath: string,
    _processRow: DomainRow,
    manifest: ProcessWrapperManifest
  ): Promise<{ stdout: Buffer; stderr: Buffer } | undefined> {
    if (await fileExists(path.join(spoolPath, PROCESS_WRAPPER_EXIT_RECEIPT_FILE))) return undefined;
    if (manifest.status !== 'running') return undefined;
    try {
      return processWrapperManifestLiveTails(manifest);
    } catch {
      // The immutable chunk prefix remains authoritative. A malformed preview is omitted rather
      // than promoted into a Tool/Process failure.
      return undefined;
    }
  }

  private async terminalOutputIsFullyRegistered(processRow: DomainRow): Promise<boolean> {
    const processId = requireId(processRow.id, 'Process.id');
    const counters = processRowOutputCounters(processRow);
    const proofFence = await this.outputPrefixReadFence();
    const known = this.verifiedOutputPrefix(processRow, counters);
    if (known?.complete && known.retainedChunks === counters.retainedChunks
      && known.retainedBytes === counters.retainedBytes) return true;
    const rows = await listAllDomainRows(this.database, 'ProcessOutputChunk', { process_id: processId });
    if (BigInt(rows.length) !== counters.retainedChunks) return false;
    const sequences = new Set<string>();
    let registeredBytes = 0n;
    for (const row of rows) {
      const chunkSeq = requireBigInt(row.chunk_seq, 'ProcessOutputChunk.chunk_seq');
      if (chunkSeq <= 0n || chunkSeq > counters.retainedChunks) return false;
      validateRegisteredProcessOutputChunk(row, processId, chunkSeq);
      sequences.add(chunkSeq.toString());
      registeredBytes += requireBigInt(row.byte_length, 'ProcessOutputChunk.byte_length');
    }
    if (BigInt(sequences.size) !== counters.retainedChunks || registeredBytes !== counters.retainedBytes) return false;
    if (proofFence && !await this.rememberOutputPrefix(processRow, counters, true, proofFence)) {
      // Complete rows were observed. A changed fence asks for a coherent recheck, never for a
      // spool recovery: a valid historical spool may already have been removed.
      throw new ProcessOutputSnapshotAdvancedError('proof_fence');
    }
    return true;
  }

  private async outputPrefixReadFence(): Promise<OutputPrefixReadFence | undefined> {
    if (!this.outputPrefixCaching) return undefined;
    // This request validates the current RootBinding even when the proof is reused. A foreign
    // connection's commit invalidates every proof; local deletions invalidate via onCommit.
    const externalVersion = await this.database.externalDataVersion();
    if (externalVersion !== this.outputPrefixExternalVersion) {
      this.verifiedOutputPrefixes.clear();
      this.outputPrefixExternalVersion = externalVersion;
      this.outputPrefixRemovalRevision++;
    }
    return { externalVersion, removalRevision: this.outputPrefixRemovalRevision,
      mutationRevision: this.outputPrefixMutationRevision };
  }

  private verifiedOutputPrefix(processRow: DomainRow, counters: ProcessOutputCounters): VerifiedOutputPrefix | undefined {
    const processId = requireId(processRow.id, 'Process.id');
    const known = this.verifiedOutputPrefixes.get(processId);
    const durable = processRowOutputCounters(processRow);
    if (!known || known.identity !== processOutputIdentity(processRow)
      || known.retainedChunks > counters.retainedChunks || known.retainedBytes > counters.retainedBytes
      || known.retainedChunks > durable.retainedChunks || known.retainedBytes > durable.retainedBytes) return undefined;
    this.verifiedOutputPrefixes.delete(processId);
    this.verifiedOutputPrefixes.set(processId, known);
    return known;
  }

  private async rememberOutputPrefix(processRow: DomainRow, counters: ProcessOutputCounters, complete: boolean,
    fence: OutputPrefixReadFence | undefined): Promise<boolean> {
    if (!fence) return false;
    const current = await this.outputPrefixReadFence();
    if (!current || current.externalVersion !== fence.externalVersion
      || current.removalRevision !== fence.removalRevision
      || (complete && current.mutationRevision !== fence.mutationRevision)) return false;
    const processId = requireId(processRow.id, 'Process.id');
    const previous = this.verifiedOutputPrefixes.get(processId);
    if (previous?.identity === processOutputIdentity(processRow) && previous.retainedChunks > counters.retainedChunks) return false;
    const samePrefix = previous?.identity === processOutputIdentity(processRow)
      && previous.retainedChunks === counters.retainedChunks && previous.retainedBytes === counters.retainedBytes;
    this.verifiedOutputPrefixes.delete(processId);
    this.verifiedOutputPrefixes.set(processId, { identity: processOutputIdentity(processRow),
      retainedBytes: counters.retainedBytes, retainedChunks: counters.retainedChunks,
      complete: complete || Boolean(samePrefix && previous?.complete) });
    while (this.verifiedOutputPrefixes.size > PROCESS_OUTPUT_PROOF_CACHE_ENTRIES) {
      this.verifiedOutputPrefixes.delete(this.verifiedOutputPrefixes.keys().next().value!);
    }
    return true;
  }

  private releaseOutputPrefixProofs(): void {
    this.outputPrefixCaching = false;
    this.verifiedOutputPrefixes.clear();
    for (const unsubscribe of this.outputPrefixSubscriptions.splice(0)) unsubscribe();
  }

  private async removeArchivedSpool(
    processRow: DomainRow
  ): Promise<'removed' | 'already_absent'> {
    const spoolPath = processSpoolPath(
      this.binding,
      requireText(processRow.spool_locator, 'Process.spool_locator')
    );
    try {
      const stat = await fs.lstat(spoolPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Archived process spool is not a plain directory: ${spoolPath}`);
      }
      await fs.rm(spoolPath, { recursive: true, force: false, maxRetries: 2, retryDelay: 20 });
      return 'removed';
    } catch (error) {
      if (isNotFound(error)) return 'already_absent';
      throw error;
    }
  }

  private async requireMatchingSpoolEvidence(processRow: DomainRow, spoolPath: string): Promise<void> {
    try {
      const receipt = parseWrapperExitReceipt(await readJson(path.join(spoolPath, PROCESS_WRAPPER_EXIT_RECEIPT_FILE)));
      assertExitReceiptMatchesProcess(processRow, receipt);
      return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await this.requireMatchingIdentity(processRow, spoolPath);
  }

  private async requireMatchingIdentity(processRow: DomainRow, spoolPath: string): Promise<ProcessWrapperIdentity> {
    const identity = parseWrapperIdentity(await readJson(path.join(spoolPath, PROCESS_WRAPPER_IDENTITY_FILE)));
    if (
      identity.processId !== processRow.id
      || identity.stableNonce !== processRow.wrapper_nonce
      || BigInt(identity.wrapperPid) !== requireBigInt(processRow.wrapper_pid, 'Process.wrapper_pid')
      || BigInt(identity.childPid) !== requireBigInt(processRow.child_pid, 'Process.child_pid')
      || BigInt(identity.processGroupId) !== requireBigInt(processRow.process_group_id, 'Process.process_group_id')
      || identity.startFingerprint !== processRow.start_fingerprint
      || identity.commandDigest !== processRow.command_digest
      || identity.spoolLocator !== processRow.spool_locator
    ) throw new Error('Process wrapper identity does not match persisted Process evidence.');
    return identity;
  }

  private async readManifest(spoolPath: string, processRow: DomainRow): Promise<ProcessWrapperManifest> {
    const manifest = parseWrapperManifest(await readJson(path.join(spoolPath, PROCESS_WRAPPER_MANIFEST_FILE)));
    if (manifest.processId !== processRow.id || manifest.stableNonce !== processRow.wrapper_nonce) {
      throw new Error('Process wrapper manifest identity mismatch.');
    }
    return manifest;
  }

  private async readExistingModelResponseDetail(
    toolCallId: string,
    expectedStatus: ProcessStartObservation['outcome']
  ): Promise<{ found: false } | { found: true; detail: unknown }> {
    const artifacts = await this.list('ToolResultArtifact', {
      tool_call_id: toolCallId,
      role: 'model_response'
    }, 2);
    if (artifacts.length === 0) return { found: false };
    if (artifacts.length !== 1) throw new Error(`ToolCall ${toolCallId} has multiple model_response artifacts.`);
    const metadata = await this.requireExisting(
      'ContentObject',
      requireId(artifacts[0].content_object_id, 'ToolResultArtifact.content_object_id')
    ) as ContentObjectMetadata;
    const body = JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as Record<string, unknown>;
    if (
      body.toolCallId !== toolCallId
      || body.status !== expectedStatus
      || !Object.prototype.hasOwnProperty.call(body, 'detail')
    ) throw new Error(`ToolCall ${toolCallId} model_response artifact is inconsistent.`);
    return { found: true, detail: body.detail };
  }

  private async readReceiptDetail<T>(receipt: DomainRow): Promise<T | undefined> {
    if (receipt.response_object_id === null) return undefined;
    const metadata = await this.requireExisting(
      'ContentObject',
      requireId(receipt.response_object_id, 'EffectReceipt.response_object_id')
    ) as Parameters<ContentAddressedStore['read']>[0];
    return JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as T;
  }

  private async validateBinding(): Promise<void> {
    await this.authority.validate(this.binding);
  }

  private async maybeGet(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    if (Array.isArray(row)) throw new TypeError(`${domain} get returned rows.`);
    return row;
  }

  /** The Process and its immutable receipt must come from one worker read snapshot. */
  private async readPersistedProcessEvidence(processId: string): Promise<{ process: DomainRow; receipt?: DomainRow }> {
    const [process, receipts] = (await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Process').get(processId),
      DOMAIN_REPOSITORIES.domain('ProcessReceipt').list({ where: { process_id: processId }, limit: 2 })
    ])).snapshot;
    if (!process || Array.isArray(process)) throw new Error(`Process ${processId} does not exist.`);
    if (!Array.isArray(receipts)) throw new TypeError('ProcessReceipt list did not return rows.');
    if (receipts.length > 1) throw new Error(`Process ${processId} has multiple ProcessReceipts.`);
    return { process, ...(receipts[0] ? { receipt: receipts[0] } : {}) };
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const row = await this.maybeGet(domain, id);
    if (!row) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })]);
    const rows = snapshot.snapshot[0];
    if (!Array.isArray(rows)) throw new TypeError(`${domain} list did not return rows.`);
    return rows;
  }

  private timestamp(): string {
    return requireText(this.now(), 'clock result');
  }

  private recordTerminalReceiptMetric(processId: string): void {
    const identityReadyAt = this.processIdentityReadyAt.get(processId);
    if (identityReadyAt === undefined) return;
    this.processIdentityReadyAt.delete(processId);
    if (!this.database.performanceMetrics) return;
    this.database.recordPerformanceMetric({
      kind: 'process.phase',
      phase: 'terminal_receipt',
      durationMs: performance.now() - identityReadyAt
    });
  }

  private notifyProcessReceipt(processId: string): void {
    try {
      this.processReceiptObserver?.(processId);
    } catch {
      // Delivery is level-triggered from SQLite; an observational wake may never fail receipt commit.
    }
  }
}

class ProcessOutputSnapshotAdvancedError extends Error {
  public constructor(public readonly reason: 'process_progress' | 'proof_fence' = 'process_progress') {
    super('Process output snapshot advanced during reconciliation.');
    this.name = 'ProcessOutputSnapshotAdvancedError';
  }
}

function processOutputChunkId(processId: string, chunkSeq: bigint): string {
  return stablePhaseDId('process_output_chunk', `${processId}:${chunkSeq}`);
}

function processOutputIdentity(row: DomainRow): string {
  return JSON.stringify([row.id, row.wrapper_nonce, row.start_fingerprint, row.spool_locator,
    row.command_digest, String(row.wrapper_pid), String(row.child_pid), String(row.process_group_id)]);
}

function processOutputTransactionSteps(
  processRow: DomainRow,
  counters: ProcessOutputCounters,
  prepared: readonly PreparedProcessOutputChunk[],
  now: string
): RepositoryTransactionStep[] {
  const processId = requireId(processRow.id, 'Process.id');
  const steps: RepositoryTransactionStep[] = [
    DOMAIN_REPOSITORIES.domain('Process').assert(processId, {
      status: processRow.status,
      retained_bytes: processRow.retained_bytes,
      retained_chunks: processRow.retained_chunks,
      dropped_bytes: processRow.dropped_bytes,
      truncated: processRow.truncated
    })
  ];
  for (const entry of prepared) {
    steps.push(
      ...preparedContentSteps([entry.content], `process_chunk_${entry.chunkSeq}`),
      DOMAIN_REPOSITORIES.domain('ProcessOutputChunk').insert({
        id: processOutputChunkId(processId, entry.chunkSeq),
        process_id: processId,
        chunk_seq: entry.chunkSeq.toString(),
        stream_kind: entry.streamKind,
        content_object_id: entry.content.metadata.id,
        byte_length: entry.byteLength.toString(),
        created_at: entry.createdAt
      })
    );
  }
  if (!processCountersEqual(processRow, counters)) {
    steps.push(DOMAIN_REPOSITORIES.domain('Process').update(processId, {
      retained_bytes: counters.retainedBytes.toString(),
      retained_chunks: counters.retainedChunks.toString(),
      dropped_bytes: counters.droppedBytes.toString(),
      truncated: counters.truncated ? '1' : '0',
      updated_at: now
    }));
  }
  return steps;
}

function processOutputTransactionWireBytes(steps: readonly RepositoryTransactionStep[]): number {
  const fence = currentExecutionLeaseFence();
  const fencedSteps = fence
    ? [
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(
          fence.id,
          executionLeaseFenceAssertion(fence)
        ),
        ...steps
      ]
    : steps;
  return Buffer.byteLength(JSON.stringify({ kind: 'transaction', steps: fencedSteps }, (_key, value) => (
    typeof value === 'bigint' ? value.toString() : value
  )), 'utf8');
}

function validateRegisteredProcessOutputChunk(
  row: DomainRow,
  processId: string,
  chunkSeq: bigint,
  expected?: PreparedProcessOutputChunk
): void {
  if (
    requireId(row.id, 'ProcessOutputChunk.id') !== processOutputChunkId(processId, chunkSeq)
    || requireId(row.process_id, 'ProcessOutputChunk.process_id') !== processId
    || requireBigInt(row.chunk_seq, 'ProcessOutputChunk.chunk_seq') !== chunkSeq
  ) throw new Error(`ProcessOutputChunk ${chunkSeq} identity mismatch.`);
  const streamKind = requireStreamKind(row.stream_kind);
  const byteLength = requireBigInt(row.byte_length, 'ProcessOutputChunk.byte_length');
  if (byteLength <= 0n || byteLength > BigInt(PROCESS_OUTPUT_MAX_CHUNK_BYTES)) {
    throw new Error(`ProcessOutputChunk ${chunkSeq} has an invalid byte length.`);
  }
  if (expected && (
    streamKind !== expected.streamKind
    || byteLength !== expected.byteLength
    || requireId(row.content_object_id, 'ProcessOutputChunk.content_object_id') !== expected.content.metadata.id
  )) throw new Error(`ProcessOutputChunk ${chunkSeq} conflicts with the immutable spool prefix.`);
}

async function statRegularFileIfPresent(
  filePath: string
): Promise<Awaited<ReturnType<typeof fs.stat>> | undefined> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(`Process spool entry is not a regular file: ${filePath}`);
    return stat;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function encodeProcessOutputHandle(cursor: ProcessOutputCursor): string {
  const payload = JSON.stringify({
    processId: cursor.processId,
    nextChunkSeq: cursor.nextChunkSeq.toString(),
    nextChunkOffset: cursor.nextChunkOffset,
    reconciledRetainedChunks: cursor.reconciledRetainedChunks?.toString() ?? null,
    stdoutCarry: cursor.stdoutCarry.toString('base64'),
    stderrCarry: cursor.stderrCarry.toString('base64')
  });
  return `${PROCESS_OUTPUT_HANDLE_PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

function decodeProcessOutputHandle(value: unknown, processId: string): ProcessOutputCursor {
  if (value === undefined || value === null || value === '') {
    return {
      processId,
      nextChunkSeq: 1n,
      nextChunkOffset: 0,
      reconciledRetainedChunks: null,
      stdoutCarry: Buffer.alloc(0),
      stderrCarry: Buffer.alloc(0)
    };
  }
  if (typeof value !== 'string' || !value.startsWith(PROCESS_OUTPUT_HANDLE_PREFIX)) {
    throw new TypeError('outputHandle must be an opaque handle returned by mode=output.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value.slice(PROCESS_OUTPUT_HANDLE_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new TypeError('outputHandle is malformed.');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new TypeError('outputHandle payload is malformed.');
  }
  const record = decoded as Record<string, unknown>;
  if (record.processId !== processId) throw new Error('outputHandle belongs to a different process.');
  if (typeof record.nextChunkSeq !== 'string' || !/^[1-9]\d*$/.test(record.nextChunkSeq)) {
    throw new TypeError('outputHandle nextChunkSeq is invalid.');
  }
  if (typeof record.reconciledRetainedChunks !== 'string' || !/^(?:0|[1-9]\d*)$/.test(record.reconciledRetainedChunks)) {
    throw new TypeError('outputHandle reconciledRetainedChunks is invalid.');
  }
  const nextChunkOffset = record.nextChunkOffset === undefined ? 0 : record.nextChunkOffset;
  if (!Number.isSafeInteger(nextChunkOffset) || (nextChunkOffset as number) < 0 || (nextChunkOffset as number) >= PROCESS_OUTPUT_MAX_CHUNK_BYTES) {
    throw new TypeError('outputHandle nextChunkOffset is invalid.');
  }
  const stdoutCarry = decodeOutputHandleCarry(record.stdoutCarry, 'stdoutCarry');
  const stderrCarry = decodeOutputHandleCarry(record.stderrCarry, 'stderrCarry');
  return {
    processId,
    nextChunkSeq: BigInt(record.nextChunkSeq),
    nextChunkOffset: nextChunkOffset as number,
    reconciledRetainedChunks: BigInt(record.reconciledRetainedChunks),
    stdoutCarry,
    stderrCarry
  };
}

function decodeOutputHandleCarry(value: unknown, label: string): Buffer {
  if (typeof value !== 'string') throw new TypeError(`outputHandle ${label} is invalid.`);
  let bytes: Buffer;
  try {
    bytes = decodeCanonicalBase64(value, { maxBytes: 3 });
  } catch {
    throw new TypeError(`outputHandle ${label} is invalid.`);
  }
  return bytes;
}

function decodeUtf8OutputPage(
  carry: Buffer,
  chunks: readonly Buffer[],
  flush: boolean
): { text: string; carry: Buffer } {
  const bytes = Buffer.concat(carry.byteLength > 0 ? [carry, ...chunks] : [...chunks]);
  if (flush || bytes.byteLength === 0) return { text: bytes.toString('utf8'), carry: Buffer.alloc(0) };
  const carryLength = incompleteUtf8TailLength(bytes);
  if (carryLength === 0) return { text: bytes.toString('utf8'), carry: Buffer.alloc(0) };
  const split = bytes.byteLength - carryLength;
  return {
    text: bytes.subarray(0, split).toString('utf8'),
    carry: Buffer.from(bytes.subarray(split))
  };
}

function boundedBufferTail(chunks: readonly Buffer[], maxBytes: number): Buffer {
  const totalBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = Buffer.allocUnsafe(Math.min(totalBytes, maxBytes));
  let targetEnd = result.byteLength;
  for (let index = chunks.length - 1; index >= 0 && targetEnd > 0; index -= 1) {
    const chunk = chunks[index]!;
    const length = Math.min(chunk.byteLength, targetEnd);
    chunk.copy(result, targetEnd - length, chunk.byteLength - length);
    targetEnd -= length;
  }
  return result;
}

function incompleteUtf8TailLength(bytes: Buffer): number {
  let leadingIndex = bytes.byteLength - 1;
  while (leadingIndex >= 0 && (bytes[leadingIndex]! & 0xc0) === 0x80) leadingIndex -= 1;
  if (leadingIndex < 0) return 0;
  const leading = bytes[leadingIndex]!;
  const expectedLength = leading >= 0xc2 && leading <= 0xdf
    ? 2
    : leading >= 0xe0 && leading <= 0xef
      ? 3
      : leading >= 0xf0 && leading <= 0xf4
        ? 4
        : 1;
  const available = bytes.byteLength - leadingIndex;
  return expectedLength > available ? available : 0;
}

function processStartFactSteps(
  request: ProcessStartRequest,
  toolCallId: string,
  sourceTurnId: string,
  conversationId: string,
  identity: ProcessWrapperIdentity,
  foreground: ProcessWaitObservation,
  now: string,
  exitRequestContent?: PreparedContentObject
): RepositoryTransactionStep[] {
  const terminal = foreground.state !== 'running';
  const exited = foreground.state === 'exited' ? foreground.receipt : undefined;
  const outcome = processWaitOutcome(foreground);
  const processStatus = foreground.state === 'running'
    ? 'running'
    : foreground.state === 'outcome_unknown'
      ? 'outcome_unknown'
      : exited
        ? processTerminalStatus(exited)
        : 'outcome_unknown';
  const steps: RepositoryTransactionStep[] = [
    DOMAIN_REPOSITORIES.domain('Process').insert({
      id: request.processId,
      status: processStatus,
      wrapper_nonce: identity.stableNonce,
      wrapper_pid: identity.wrapperPid,
      child_pid: identity.childPid,
      process_group_id: identity.processGroupId,
      start_fingerprint: identity.startFingerprint,
      command_digest: identity.commandDigest,
      spool_locator: identity.spoolLocator,
      retained_bytes: exited?.retainedBytes ?? '0',
      retained_chunks: exited?.retainedChunks ?? '0',
      dropped_bytes: exited?.droppedBytes ?? '0',
      truncated: exited?.truncated ? '1' : '0',
      started_at: identity.startedAt,
      updated_at: now,
      completed_at: terminal ? (exited?.exitedAt ?? now) : null
    }),
    DOMAIN_REPOSITORIES.domain('ProcessOriginLink').insert({
      id: stablePhaseDId('process_origin_link', request.processId),
      process_id: request.processId,
      tool_call_id: toolCallId,
      created_at: now
    }),
    DOMAIN_REPOSITORIES.domain('ProcessCompletionSourceLink').insert({
      id: stablePhaseDId('process_completion_source_link', request.processId),
      process_id: request.processId,
      conversation_id: conversationId,
      source_turn_id: sourceTurnId,
      source_tool_call_id: toolCallId,
      created_at: now
    })
  ];
  if (!terminal) {
    if (!exitRequestContent) throw new Error('Running Process requires a persisted process_exit request.');
    const ids = processExitIds(request.processId);
    steps.push(
      ...preparedContentSteps([exitRequestContent], 'process_exit_request'),
      DOMAIN_REPOSITORIES.domain('Operation').insert({
        id: ids.operationId,
        owner_kind: 'process',
        owner_id: request.processId,
        operation_seq: '1',
        tool_call_id: null,
        status: 'executing',
        created_at: now,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Attempt').insert({
        id: ids.attemptId,
        operation_id: ids.operationId,
        attempt_seq: '1',
        status: 'dispatched',
        created_at: now,
        updated_at: now,
        completed_at: null
      }),
      DOMAIN_REPOSITORIES.domain('EffectIntent').insert({
        id: ids.effectIntentId,
        attempt_id: ids.attemptId,
        effect_kind: 'process_exit',
        dispatch_state: 'dispatched',
        request_object_id: exitRequestContent.metadata.id,
        created_at: now,
        updated_at: now
      })
    );
  } else {
    steps.push(DOMAIN_REPOSITORIES.domain('ProcessReceipt').insert({
      id: stablePhaseDId('process_receipt', request.processId),
      process_id: request.processId,
      outcome: exited ? processReceiptOutcome(exited) : outcome,
      exit_code: exited?.exitCode ?? null,
      exit_signal: exited?.signal ?? null,
      wrapper_nonce: identity.stableNonce,
      start_fingerprint: identity.startFingerprint,
      received_at: now
    }));
  }
  return steps;
}

function processCompletionDispatchInsert(processId: string, now: string): RepositoryTransactionStep {
  const processReceiptId = stablePhaseDId('process_receipt', processId);
  return DOMAIN_REPOSITORIES.domain('ProcessCompletionDispatch').insert({
    id: stablePhaseDId('process_completion_dispatch', processReceiptId),
    process_receipt_id: processReceiptId,
    state: 'pending',
    claim_owner_host_boot_id: null,
    claim_generation: 0n,
    claim_expires_at: null,
    attempt_count: 0n,
    failure_count: 0n,
    next_attempt_at: null,
    last_error: null,
    completed_at: null,
    created_at: now,
    updated_at: now
  });
}

function processStartModelDetail(
  observation: ProcessStartObservation,
  output: ProcessOutputPageReadResult
): Record<string, unknown> {
  const foreground = observation.foreground;
  const exited = foreground?.state === 'exited' ? foreground.receipt : undefined;
  const provisional = foreground?.state === 'running' && (output.liveStdout.length > 0 || output.liveStderr.length > 0);
  const stdout = output.stdout || (provisional ? output.liveStdout : '');
  const stderr = output.stderr || (provisional ? output.liveStderr : '');
  return {
    processId: observation.processId,
    status: exited ? processTerminalStatus(exited) : (foreground?.state ?? output.status),
    exitCode: exited?.exitCode === null || exited?.exitCode === undefined ? null : Number(exited.exitCode),
    ...(exited ? { terminationReason: exited.terminationReason } : {}),
    ...(exited?.stopRequested ? { killed: true } : {}),
    stdout,
    stderr,
    ...(provisional ? { outputProvisional: true } : {}),
    complete: foreground?.state === 'running' ? false : output.complete,
    ...(output.hasMore ? { nextOutputHandle: output.nextOutputHandle } : {}),
    ...(output.truncated ? { truncated: true, droppedBytes: output.droppedBytes } : {})
  };
}

function processStartModelDetailWithoutPreview(
  observation: ProcessStartObservation
): Record<string, unknown> {
  const foreground = observation.foreground;
  const exited = foreground?.state === 'exited' ? foreground.receipt : undefined;
  return {
    processId: observation.processId,
    status: exited ? processTerminalStatus(exited) : (foreground?.state ?? observation.state),
    exitCode: exited?.exitCode === null || exited?.exitCode === undefined ? null : Number(exited.exitCode),
    ...(exited ? { terminationReason: exited.terminationReason } : {}),
    ...(exited?.stopRequested ? { killed: true } : {}),
    stdout: '',
    stderr: '',
    outputPreviewUnavailable: true,
    complete: foreground?.state !== 'running'
  };
}

function processStartFailureModelDetail(observation: ProcessStartObservation): Record<string, unknown> {
  return {
    processId: observation.processId,
    status: observation.state,
    exitCode: null,
    stdout: '',
    stderr: observation.launch.outcome === 'succeeded' ? '' : observation.launch.error,
    complete: true
  };
}

function processDetailDurablePrefix(counters: ProcessOutputCounters): ProcessDetailOutputSnapshot {
  return {
    retainedBytes: counters.retainedBytes.toString(),
    retainedChunks: counters.retainedChunks.toString(),
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0)
  };
}

function processExitRequest(identity: ProcessWrapperIdentity): ProcessExitEffectRequest {
  return {
    processId: identity.processId,
    stableNonce: identity.stableNonce,
    wrapperPid: identity.wrapperPid,
    childPid: identity.childPid,
    startFingerprint: identity.startFingerprint,
    processGroupId: identity.processGroupId,
    commandDigest: identity.commandDigest,
    spoolLocator: identity.spoolLocator
  };
}

function processExitIds(processId: string): { operationId: string; attemptId: string; effectIntentId: string } {
  const operationId = stablePhaseDId('operation', `process-exit:${processId}`);
  const attemptId = stablePhaseDId('attempt', `${operationId}:1`);
  return {
    operationId,
    attemptId,
    effectIntentId: stablePhaseDId('effect_intent', attemptId)
  };
}

function normalizeProcessStartObservation(
  value: unknown,
  request: ProcessStartRequest
): ProcessStartObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid process_start Receipt detail.');
  }
  const record = value as Record<string, unknown>;
  const outcome = requireProcessStartOutcome(record.outcome);
  const processId = requireId(record.processId, 'process_start.processId');
  if (processId !== request.processId) throw new Error('process_start result belongs to another Process.');
  const launchValue = record.launch;
  if (!launchValue || typeof launchValue !== 'object' || Array.isArray(launchValue)) {
    throw new TypeError('process_start Receipt lacks launch observation.');
  }
  const launchRecord = launchValue as Record<string, unknown>;
  let launch: ProcessLaunchObservation;
  if (launchRecord.outcome === 'succeeded') {
    const identity = parseWrapperIdentity(launchRecord.identity);
    assertIdentityMatchesStart(identity, request);
    launch = { outcome: 'succeeded', identity };
  } else if (
    launchRecord.outcome === 'failed'
    || launchRecord.outcome === 'cancelled'
    || launchRecord.outcome === 'outcome_unknown'
  ) {
    launch = {
      outcome: launchRecord.outcome,
      error: requireText(launchRecord.error, 'process launch error')
    };
  } else {
    throw new TypeError('Invalid process launch outcome.');
  }
  let foreground: ProcessWaitObservation | null = null;
  if (record.foreground !== null) {
    const observed = record.foreground;
    if (!observed || typeof observed !== 'object' || Array.isArray(observed)) {
      throw new TypeError('Invalid process foreground observation.');
    }
    const foregroundRecord = observed as Record<string, unknown>;
    const processId = requireId(foregroundRecord.processId, 'foreground.processId');
    if (processId !== request.processId) throw new Error('Foreground observation belongs to another Process.');
    if (foregroundRecord.state === 'running') {
      foreground = { state: 'running', processId };
    } else if (foregroundRecord.state === 'outcome_unknown') {
      foreground = {
        state: 'outcome_unknown',
        processId,
        reason: requireText(foregroundRecord.reason, 'foreground.reason')
      };
    } else if (foregroundRecord.state === 'exited') {
      if (launch.outcome !== 'succeeded') throw new Error('Exited foreground observation requires a wrapper identity.');
      const receipt = parseWrapperExitReceipt(foregroundRecord.receipt);
      assertExitReceiptMatches(launch.identity, receipt);
      foreground = { state: 'exited', processId, receipt };
    } else {
      throw new TypeError('Invalid process foreground state.');
    }
  }
  if (launch.outcome === 'succeeded') {
    if (!foreground || processWaitOutcome(foreground) !== outcome) {
      throw new Error('process_start foreground outcome does not match its Receipt.');
    }
  } else if (foreground !== null || launch.outcome !== outcome) {
    throw new Error('Failed/unknown process launch has inconsistent foreground facts.');
  }
  const expectedState = launch.outcome !== 'succeeded'
    ? launch.outcome === 'failed'
      ? 'launch_failed'
      : launch.outcome === 'cancelled'
        ? 'launch_cancelled'
        : 'outcome_unknown'
    : foreground?.state === 'running'
      ? 'background_started'
      : foreground?.state === 'exited'
        ? 'completed'
        : 'outcome_unknown';
  if (record.state !== expectedState) {
    throw new Error(`process_start protocol state must be ${expectedState}.`);
  }
  return { outcome, state: expectedState, processId, launch, foreground };
}

function normalizeProcessExitObservation(
  value: unknown,
  processRow: DomainRow,
  persistedOutcome: unknown
): Exclude<ProcessWaitObservation, { state: 'running' }> {
  const processId = requireId(processRow.id, 'Process.id');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (persistedOutcome === 'outcome_unknown') {
      return { state: 'outcome_unknown', processId, reason: 'process_exit Receipt has no provable exit detail.' };
    }
    throw new TypeError('process_exit Receipt lacks observation detail.');
  }
  const record = value as Record<string, unknown>;
  if (record.processId !== processId) throw new Error('process_exit observation belongs to another Process.');
  if (record.state === 'outcome_unknown') {
    if (persistedOutcome !== 'outcome_unknown') throw new Error('process_exit outcome/detail mismatch.');
    return {
      state: 'outcome_unknown',
      processId,
      reason: requireText(record.reason, 'process_exit unknown reason')
    };
  }
  if (record.state !== 'exited') throw new TypeError('process_exit observation must be exited or outcome_unknown.');
  const receipt = parseWrapperExitReceipt(record.receipt);
  assertExitReceiptMatchesProcess(processRow, receipt);
  const observed: ProcessWaitObservation = { state: 'exited', processId, receipt };
  if (processExitOutcome(observed) !== persistedOutcome) throw new Error('process_exit outcome/detail mismatch.');
  return observed;
}

type ProcessReceiptTerminalOutcome =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'output_limit_exceeded';

function processExitOutcome(
  observed: ProcessWaitObservation
): 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown' {
  if (observed.state === 'outcome_unknown') return 'outcome_unknown';
  if (observed.state === 'running') throw new Error('A running Process has no terminal process_exit outcome.');
  const reason = observed.receipt.terminationReason;
  if (reason === 'manual') return 'cancelled';
  if (reason === 'timed_out' || reason === 'output_limit_exceeded') return 'failed';
  return observed.receipt.exitCode === '0' ? 'succeeded' : 'failed';
}

function processReceiptOutcome(receipt: ProcessWrapperExitReceipt): ProcessReceiptTerminalOutcome {
  if (receipt.terminationReason === 'manual') return 'cancelled';
  if (receipt.terminationReason === 'timed_out') return 'timed_out';
  if (receipt.terminationReason === 'output_limit_exceeded') return 'output_limit_exceeded';
  return receipt.exitCode === '0' ? 'succeeded' : 'failed';
}

function processTerminalStatus(receipt: ProcessWrapperExitReceipt): string {
  if (receipt.terminationReason === 'manual') return 'cancelled';
  if (receipt.terminationReason === 'timed_out') return 'timed_out';
  if (receipt.terminationReason === 'output_limit_exceeded') return 'output_limit_exceeded';
  return 'exited';
}

function persistedTerminationReason(outcome: ProcessReceiptTerminalOutcome): ProcessTerminationReason {
  if (outcome === 'cancelled') return 'manual';
  if (outcome === 'timed_out') return 'timed_out';
  if (outcome === 'output_limit_exceeded') return 'output_limit_exceeded';
  return 'natural';
}

function persistedProcessObservation(processRow: DomainRow, receipt: DomainRow): ProcessWaitObservation {
  const processId = requireId(processRow.id, 'Process.id');
  if (
    receipt.wrapper_nonce !== processRow.wrapper_nonce
    || receipt.start_fingerprint !== processRow.start_fingerprint
  ) return { state: 'outcome_unknown', processId, reason: 'Persisted ProcessReceipt identity mismatch.' };
  if (!hasMatchingTerminalProcessReceipt(processRow, receipt)) {
    return { state: 'outcome_unknown', processId, reason: 'Persisted ProcessReceipt terminal state/time or outcome/exit tuple mismatch.' };
  }
  if (receipt.outcome === 'outcome_unknown') {
    return { state: 'outcome_unknown', processId, reason: 'Persisted ProcessReceipt records outcome_unknown.' };
  }
  const persistedOutcome = String(receipt.outcome);
  if (!['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit_exceeded'].includes(persistedOutcome)) {
    return { state: 'outcome_unknown', processId, reason: 'Persisted ProcessReceipt has an invalid outcome.' };
  }
  try {
    const legacyReceipt = parseWrapperExitReceipt({
        kind: PROCESS_WRAPPER_PROTOCOL,
        processId,
        stableNonce: requireText(processRow.wrapper_nonce, 'Process.wrapper_nonce'),
        wrapperPid: requireBigInt(processRow.wrapper_pid, 'Process.wrapper_pid').toString(),
        childPid: requireBigInt(processRow.child_pid, 'Process.child_pid').toString(),
        processGroupId: requireBigInt(processRow.process_group_id, 'Process.process_group_id').toString(),
        startFingerprint: requireText(processRow.start_fingerprint, 'Process.start_fingerprint'),
        commandDigest: requireSha256(processRow.command_digest, 'Process.command_digest'),
        exitCode: receipt.exit_code === null ? null : requireBigInt(receipt.exit_code, 'ProcessReceipt.exit_code').toString(),
        signal: receipt.exit_signal === null ? null : requireText(receipt.exit_signal, 'ProcessReceipt.exit_signal'),
        exitedAt: requireText(processRow.completed_at, 'Process.completed_at'),
        retainedBytes: requireBigInt(processRow.retained_bytes, 'Process.retained_bytes').toString(),
        retainedChunks: requireBigInt(processRow.retained_chunks, 'Process.retained_chunks').toString(),
        droppedBytes: requireBigInt(processRow.dropped_bytes, 'Process.dropped_bytes').toString(),
        truncated: requireBigInt(processRow.truncated, 'Process.truncated') === 1n,
        stopRequested: persistedOutcome === 'cancelled'
      });
    return {
      state: 'exited',
      processId,
      receipt: {
        ...legacyReceipt,
        terminationReason: persistedTerminationReason(persistedOutcome as ProcessReceiptTerminalOutcome)
      }
    };
  } catch {
    return { state: 'outcome_unknown', processId, reason: 'Persisted ProcessReceipt has an invalid exit tuple.' };
  }
}

function terminalStopObservation(
  observation: Extract<ProcessWaitObservation, { state: 'exited' }>,
  alreadyExited: boolean
): ProcessStopObservation {
  return {
    outcome: 'succeeded',
    status: alreadyExited || !observation.receipt.stopRequested ? 'already_exited' : 'stopped',
    receipt: observation.receipt,
    reason: alreadyExited || !observation.receipt.stopRequested
      ? 'Process terminal receipt was already authoritative before a stop request was needed.'
      : 'Process acknowledged the stop request with a terminal receipt.'
  };
}

function unknownStopObservation(reason: string): ProcessStopObservation {
  return { outcome: 'outcome_unknown', status: 'outcome_unknown', reason };
}

function processWaitOutcome(
  observation: ProcessWaitObservation
): 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown' {
  if (observation.state === 'running') return 'succeeded';
  return processExitOutcome(observation);
}

function requireProcessStopOutcome(value: unknown): 'succeeded' | 'cancelled' | 'outcome_unknown' {
  if (value !== 'succeeded' && value !== 'cancelled' && value !== 'outcome_unknown') {
    throw new TypeError(`Invalid process_stop_request outcome: ${String(value)}.`);
  }
  return value;
}

function requireStreamKind(value: unknown): 'stdout' | 'stderr' {
  if (value !== 'stdout' && value !== 'stderr') {
    throw new TypeError(`Invalid ProcessOutputChunk.stream_kind: ${String(value)}.`);
  }
  return value;
}

function requireProcessStartOutcome(
  value: unknown
): 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown' {
  if (!['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(String(value))) {
    throw new TypeError(`Invalid process_start outcome: ${String(value)}.`);
  }
  return value as 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown';
}

function requireBoundedWatchdogInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function requireNullableBoundedWatchdogInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number | null {
  if (value === null) return null;
  return requireBoundedWatchdogInteger(value, label, minimum, maximum);
}

function addMilliseconds(timestamp: string, milliseconds: number, label: string): string {
  const base = Date.parse(timestamp);
  if (!Number.isFinite(base)) throw new TypeError(`${label} must be a valid timestamp.`);
  return new Date(base + milliseconds).toISOString();
}

function requireWaitDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('foregroundWaitMs must be a non-negative safe integer.');
  }
}

function assertExitReceiptMatchesStartRequest(request: ProcessStartRequest, receipt: ProcessWrapperExitReceipt): void {
  if (
    receipt.processId !== request.processId
    || receipt.stableNonce !== request.stableNonce
    || receipt.commandDigest !== request.commandDigest
    || receipt.maxOutputBytes !== request.maxOutputBytes
    || (request.executionTimeoutMs === null) !== (receipt.executionDeadlineAt === null)
  ) throw new Error('Process exit receipt does not match process_start request.');
}

function identityFromExitReceipt(
  request: ProcessStartRequest,
  receipt: ProcessWrapperExitReceipt,
  startedAt: string
): ProcessWrapperIdentity {
  return {
    kind: PROCESS_WRAPPER_PROTOCOL,
    processId: request.processId,
    stableNonce: request.stableNonce,
    wrapperPid: receipt.wrapperPid,
    childPid: receipt.childPid,
    processGroupId: receipt.processGroupId,
    startFingerprint: receipt.startFingerprint,
    commandDigest: request.commandDigest,
    spoolLocator: request.spoolLocator,
    startedAt
  };
}

function assertExitReceiptMatchesProcess(processRow: DomainRow, receipt: ProcessWrapperExitReceipt): void {
  if (
    receipt.processId !== processRow.id
    || receipt.stableNonce !== processRow.wrapper_nonce
    || BigInt(receipt.wrapperPid) !== requireBigInt(processRow.wrapper_pid, 'Process.wrapper_pid')
    || BigInt(receipt.childPid) !== requireBigInt(processRow.child_pid, 'Process.child_pid')
    || BigInt(receipt.processGroupId) !== requireBigInt(processRow.process_group_id, 'Process.process_group_id')
    || receipt.startFingerprint !== processRow.start_fingerprint
    || receipt.commandDigest !== processRow.command_digest
  ) throw new Error('Process exit receipt does not match persisted Process evidence.');
}

function assertProcessMatchesIdentity(processRow: DomainRow, identity: ProcessWrapperIdentity): void {
  if (
    processRow.id !== identity.processId
    || processRow.wrapper_nonce !== identity.stableNonce
    || requireBigInt(processRow.wrapper_pid, 'Process.wrapper_pid').toString() !== identity.wrapperPid
    || requireBigInt(processRow.child_pid, 'Process.child_pid').toString() !== identity.childPid
    || requireBigInt(processRow.process_group_id, 'Process.process_group_id').toString() !== identity.processGroupId
    || processRow.start_fingerprint !== identity.startFingerprint
    || processRow.command_digest !== identity.commandDigest
    || processRow.spool_locator !== identity.spoolLocator
  ) throw new Error('Persisted Process does not match process_start wrapper identity.');
}

function normalizeStartRequest(value: ProcessStartRequest): ProcessStartRequest {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid process_start request.');
  const command = requireText(value.command, 'command');
  const cwd = path.resolve(requireText(value.cwd, 'cwd'));
  const digest = requireSha256(value.commandDigest, 'commandDigest');
  if (digest !== commandDigest(command, cwd)) throw new Error('process_start commandDigest mismatch.');
  return {
    processId: requireId(value.processId, 'processId'),
    stableNonce: requireNonce(value.stableNonce),
    command,
    cwd,
    commandDigest: digest,
    spoolLocator: requireLocator(value.spoolLocator),
    executionTimeoutMs: value.executionTimeoutMs === undefined
      ? null
      : requireNullableBoundedWatchdogInteger(
          value.executionTimeoutMs,
          'executionTimeoutMs',
          MIN_PROCESS_EXECUTION_TIMEOUT_MS,
          MAX_PROCESS_EXECUTION_TIMEOUT_MS
        ),
    maxOutputBytes: value.maxOutputBytes === undefined
      ? null
      : requireNullableBoundedWatchdogInteger(
          value.maxOutputBytes,
          'maxOutputBytes',
          MIN_PROCESS_MAX_OUTPUT_BYTES,
          MAX_PROCESS_MAX_OUTPUT_BYTES
        )
  };
}

function normalizeExitRequest(value: ProcessExitEffectRequest): ProcessExitEffectRequest {
  const stop = normalizeStopRequest(value);
  return {
    ...stop,
    wrapperPid: requireDecimalString(value.wrapperPid, 'wrapperPid'),
    childPid: requireDecimalString(value.childPid, 'childPid')
  };
}

function assertExitRequestMatchesProcess(request: ProcessExitEffectRequest, processRow: DomainRow): void {
  if (
    !processEvidenceMatches(processRow, request)
    || BigInt(request.wrapperPid) !== requireBigInt(processRow.wrapper_pid, 'Process.wrapper_pid')
    || BigInt(request.childPid) !== requireBigInt(processRow.child_pid, 'Process.child_pid')
  ) throw new Error('process_exit request does not match persisted Process evidence.');
}

function normalizeStopRequest(value: ProcessStopEffectRequest): ProcessStopEffectRequest {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid process_stop_request.');
  return {
    processId: requireId(value.processId, 'processId'),
    stableNonce: requireNonce(value.stableNonce),
    startFingerprint: requireText(value.startFingerprint, 'startFingerprint'),
    processGroupId: requireDecimalString(value.processGroupId, 'processGroupId'),
    commandDigest: requireSha256(value.commandDigest, 'commandDigest'),
    spoolLocator: requireLocator(value.spoolLocator)
  };
}

function processEvidenceMatches(processRow: DomainRow, request: ProcessStopEffectRequest): boolean {
  return processRow.id === request.processId
    && processRow.wrapper_nonce === request.stableNonce
    && processRow.start_fingerprint === request.startFingerprint
    && requireBigInt(processRow.process_group_id, 'Process.process_group_id').toString() === request.processGroupId
    && processRow.command_digest === request.commandDigest
    && processRow.spool_locator === request.spoolLocator;
}

function assertBootstrapMatchesStart(
  request: ProcessStartRequest,
  receipt: ProcessWrapperBootstrapReceipt
): void {
  if (
    receipt.processId !== request.processId
    || receipt.stableNonce !== request.stableNonce
    || receipt.commandDigest !== request.commandDigest
    || receipt.spoolLocator !== request.spoolLocator
  ) throw new Error('Wrapper bootstrap receipt does not match process_start request.');
}

function assertLaunchFailureMatchesStart(
  request: ProcessStartRequest,
  receipt: ProcessWrapperLaunchFailureReceipt
): void {
  if (
    receipt.processId !== request.processId
    || receipt.stableNonce !== request.stableNonce
    || receipt.commandDigest !== request.commandDigest
    || receipt.spoolLocator !== request.spoolLocator
  ) throw new Error('Wrapper launch failure receipt does not match process_start request.');
}

function launchFailureMessage(receipt: ProcessWrapperLaunchFailureReceipt): string {
  const code = receipt.errorCode ? ` ${receipt.errorCode}` : '';
  return `Wrapper launch failed during ${receipt.phase}: ${receipt.errorName}${code}: ${receipt.errorMessage}`;
}

function assertIdentityMatchesStart(identity: ProcessWrapperIdentity, request: ProcessStartRequest): void {
  if (
    identity.processId !== request.processId
    || identity.stableNonce !== request.stableNonce
    || identity.commandDigest !== request.commandDigest
    || identity.spoolLocator !== request.spoolLocator
  ) throw new Error('Wrapper identity does not match process_start request.');
}

function assertStopRequestMatchesEffect(request: ProcessStopEffectRequest, persisted: ProcessStopRequest): void {
  if (
    persisted.processId !== request.processId
    || persisted.stableNonce !== request.stableNonce
    || persisted.startFingerprint !== request.startFingerprint
    || persisted.processGroupId !== request.processGroupId
    || persisted.commandDigest !== request.commandDigest
  ) throw new Error('Atomic stop request does not match process_stop_request evidence.');
}

function assertIdentityMatchesStop(identity: ProcessWrapperIdentity, request: ProcessStopEffectRequest): void {
  if (
    identity.processId !== request.processId
    || identity.stableNonce !== request.stableNonce
    || identity.startFingerprint !== request.startFingerprint
    || identity.processGroupId !== request.processGroupId
    || identity.commandDigest !== request.commandDigest
    || identity.spoolLocator !== request.spoolLocator
  ) throw new Error('Wrapper identity does not match process_stop_request evidence.');
}

function assertExitReceiptMatches(identity: ProcessWrapperIdentity, receipt: ProcessWrapperExitReceipt): void {
  if (
    receipt.processId !== identity.processId
    || receipt.stableNonce !== identity.stableNonce
    || receipt.wrapperPid !== identity.wrapperPid
    || receipt.childPid !== identity.childPid
    || receipt.processGroupId !== identity.processGroupId
    || receipt.startFingerprint !== identity.startFingerprint
    || receipt.commandDigest !== identity.commandDigest
  ) throw new Error('Atomic wrapper exit receipt identity mismatch.');
  assertNonNegativeOutputCounters(BigInt(receipt.retainedBytes), BigInt(receipt.retainedChunks));
}

function outputCounters(manifest: ProcessWrapperManifest): ProcessOutputCounters {
  const counters = {
    retainedBytes: BigInt(manifest.retainedBytes),
    retainedChunks: BigInt(manifest.retainedChunks),
    droppedBytes: BigInt(manifest.droppedBytes),
    truncated: manifest.truncated
  };
  assertNonNegativeOutputCounters(counters.retainedBytes, counters.retainedChunks);
  return counters;
}

function processRowOutputCounters(processRow: DomainRow): ProcessOutputCounters {
  const counters = {
    retainedBytes: requireBigInt(processRow.retained_bytes, 'Process.retained_bytes'),
    retainedChunks: requireBigInt(processRow.retained_chunks, 'Process.retained_chunks'),
    droppedBytes: requireBigInt(processRow.dropped_bytes, 'Process.dropped_bytes'),
    truncated: requireBigInt(processRow.truncated, 'Process.truncated') === 1n
  };
  assertNonNegativeOutputCounters(counters.retainedBytes, counters.retainedChunks);
  return counters;
}

function assertProcessOutputProgress(
  processRow: DomainRow,
  observed: ProcessOutputCounters,
  manifestStatus: ProcessWrapperManifest['status']
): void {
  const persisted = processRowOutputCounters(processRow);
  if (processRow.status !== 'running') {
    if (manifestStatus !== 'exited' || !outputCounterValuesEqual(persisted, observed)) {
      throw new Error('Terminal Process counters do not match the final wrapper manifest.');
    }
    return;
  }
  if (
    observed.retainedBytes < persisted.retainedBytes
    || observed.retainedChunks < persisted.retainedChunks
    || observed.droppedBytes < persisted.droppedBytes
    || (persisted.truncated && !observed.truncated)
  ) throw new Error('Process wrapper counters moved backwards.');
}

function processCountersEqual(processRow: DomainRow, observed: ProcessOutputCounters): boolean {
  return outputCounterValuesEqual(processRowOutputCounters(processRow), observed);
}

function outputCounterValuesEqual(left: ProcessOutputCounters, right: ProcessOutputCounters): boolean {
  return left.retainedBytes === right.retainedBytes
    && left.retainedChunks === right.retainedChunks
    && left.droppedBytes === right.droppedBytes
    && left.truncated === right.truncated;
}

function assertOutputCoverage(
  representedBytes: bigint,
  representedChunks: bigint,
  retainedBytes: bigint,
  retainedChunks: bigint
): void {
  if (representedBytes !== retainedBytes || representedChunks !== retainedChunks) {
    throw new Error('Registered CAS chunks plus verified spool do not cover retained process output.');
  }
}

function assertNonNegativeOutputCounters(retainedBytes: bigint, retainedChunks: bigint): void {
  if (retainedBytes < 0n || retainedChunks < 0n) {
    throw new Error('Process output counters must be non-negative.');
  }
}

function isTransactionAssertionFailure(error: unknown): boolean {
  return (error as Error & { code?: string }).code === 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
}

function boundedPreIdentityStderr(bytes: Buffer): string {
  return bytes.toString('utf8')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7e\u0080-\uffff]/g, '')
    .trim()
    .slice(-2_048);
}

async function spawnWrapperForLaunch(
  launchPath: string
): Promise<{ ok: true; monitor: WrapperLaunchMonitor } | { ok: false; error: unknown }> {
  return new Promise((resolve) => {
    try {
      const wrapper = spawn(process.execPath, [path.join(__dirname, 'processWrapper.js'), launchPath], {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      });
      let exit: WrapperLaunchMonitor['exit'] = null;
      let stderr = Buffer.alloc(0);
      let released = false;
      const captureStderr = (chunk: Buffer | string) => {
        stderr = Buffer.concat([stderr, Buffer.from(chunk)]);
        if (stderr.byteLength > WRAPPER_PRE_IDENTITY_STDERR_MAX_BYTES) {
          stderr = stderr.subarray(stderr.byteLength - WRAPPER_PRE_IDENTITY_STDERR_MAX_BYTES);
        }
      };
      wrapper.stderr?.on('data', captureStderr);
      wrapper.once('exit', (code, signal) => { exit = { code, signal }; });
      const onSpawnError = (error: Error) => resolve({ ok: false, error });
      wrapper.once('error', onSpawnError);
      wrapper.once('spawn', () => {
        wrapper.off('error', onSpawnError);
        wrapper.on('error', (error) => {
          console.warn('[reliable-kernel] detached process wrapper error:', errorMessage(error));
        });
        wrapper.unref();
        (wrapper.stderr as NodeJS.ReadableStream & { unref?: () => void } | null)?.unref?.();
        resolve({
          ok: true,
          monitor: {
            get exit() { return exit; },
            stderrText: () => boundedPreIdentityStderr(stderr),
            release: () => {
              if (released) return;
              released = true;
              wrapper.stderr?.off('data', captureStderr);
              wrapper.stderr?.resume();
            }
          }
        });
      });
    } catch (error) {
      resolve({ ok: false, error });
    }
  });
}

async function waitForLaunchEvidence(
  request: ProcessStartRequest,
  spoolPath: string,
  startedAt: string,
  monitor: WrapperLaunchMonitor
): Promise<ProcessLaunchObservation> {
  const bootstrapDeadline = Date.now() + WRAPPER_BOOTSTRAP_WAIT_MS;
  let identityDeadline = bootstrapDeadline;
  let bootstrapSeen = false;
  let lastBootstrapPhase: ProcessWrapperBootstrapReceipt['phase'] | undefined;
  let wrapperExitObservedAt: number | undefined;
  const bootstrapPath = path.join(spoolPath, PROCESS_WRAPPER_BOOTSTRAP_FILE);
  const failurePath = path.join(spoolPath, PROCESS_WRAPPER_LAUNCH_FAILURE_FILE);
  const identityPath = path.join(spoolPath, PROCESS_WRAPPER_IDENTITY_FILE);
  const exitPath = path.join(spoolPath, PROCESS_WRAPPER_EXIT_RECEIPT_FILE);
  let lastError = 'Wrapper bootstrap evidence did not appear.';
  for (;;) {
    try {
      const failure = parseWrapperLaunchFailureReceipt(await readJson(failurePath));
      assertLaunchFailureMatchesStart(request, failure);
      return { outcome: 'failed', error: launchFailureMessage(failure) };
    } catch (error) {
      if (!isNotFound(error)) lastError = errorMessage(error);
    }
    try {
      const identity = parseWrapperIdentity(await readJson(identityPath));
      assertIdentityMatchesStart(identity, request);
      return { outcome: 'succeeded', identity };
    } catch (error) {
      if (!isNotFound(error)) lastError = errorMessage(error);
    }
    try {
      const receipt = parseWrapperExitReceipt(await readJson(exitPath));
      assertExitReceiptMatchesStartRequest(request, receipt);
      return {
        outcome: 'succeeded',
        identity: identityFromExitReceipt(request, receipt, startedAt)
      };
    } catch (error) {
      if (!isNotFound(error)) lastError = errorMessage(error);
    }
    try {
      const bootstrap = parseWrapperBootstrapReceipt(await readJson(bootstrapPath));
      assertBootstrapMatchesStart(request, bootstrap);
      if (!bootstrapSeen || bootstrap.phase !== lastBootstrapPhase) {
        bootstrapSeen = true;
        lastBootstrapPhase = bootstrap.phase;
        identityDeadline = Date.now() + WRAPPER_IDENTITY_WAIT_MS;
      }
    } catch (error) {
      if (!isNotFound(error)) lastError = errorMessage(error);
    }

    if (monitor.exit && wrapperExitObservedAt === undefined) wrapperExitObservedAt = Date.now();
    const deadline = bootstrapSeen ? identityDeadline : bootstrapDeadline;
    if (
      Date.now() >= deadline
      || wrapperExitObservedAt !== undefined && Date.now() - wrapperExitObservedAt >= WRAPPER_EXIT_RECEIPT_SETTLE_MS
    ) {
      const stderr = monitor.stderrText();
      return {
        outcome: 'outcome_unknown',
        error: stderr ? `${lastError} Pre-identity stderr: ${stderr}` : lastError
      };
    }
    await sleep(WRAPPER_IDENTITY_POLL_MS);
  }
}

async function writeAtomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, filePath);
  await syncDirectoryDurably(path.dirname(filePath));
}

/** Publishes an immutable request without replacing a winner from another Host/effect. */
async function writeAtomicJsonOnce(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(temporary, filePath);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
  await syncDirectoryDurably(path.dirname(filePath));
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function commandDigest(command: string, cwd: string): string {
  return createHash('sha256')
    .update('limcode-process-command\0')
    .update(command)
    .update('\0')
    .update(cwd)
    .digest('hex');
}

function requireNonce(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw new TypeError('stableNonce must be 128-bit lowercase hex.');
  return value;
}

function requireLocator(value: unknown): string {
  const locator = requireText(value, 'spoolLocator');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(locator)) throw new TypeError('Invalid spoolLocator.');
  return locator;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${label} must be lowercase SHA-256.`);
  return value;
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${label} must remain bigint in JavaScript.`);
  return value;
}

function requireDecimalString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) throw new TypeError(`${label} must be a decimal integer string.`);
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
