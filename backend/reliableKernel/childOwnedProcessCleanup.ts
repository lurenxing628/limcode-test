import { ProcessControlPlane } from './processEffects';
import {
  isTransactionAssertionFailure,
  stablePhaseFId,
  sqliteUniqueFailureIncludes
} from './phaseFIdentity';
import { DOMAIN_REPOSITORIES } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';
import { isRetryableLocalExecutionError } from './localExecutionRecovery';

const CLEANUP_POLL_MS = 500;
const EXTERNAL_CHANGE_POLL_MS = 1_000;

/**
 * Level-triggered owned-resource cleanup for explicit Child subtree interruption.
 *
 * The immutable ChildInterruptionTurnLink freezes the exact generations authorized for cleanup.
 * ProcessCompletionSourceLink may arrive later than the interruption, so recovery and relevant
 * local commits materialize missing outbox rows before the wrapper stop protocol converges them.
 */
export class ChildOwnedProcessCleanupControlPlane {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pass: Promise<void> | undefined;
  private rerun = false;
  private started = false;
  private startPromise: Promise<void> | undefined;
  private externalPollTask: Promise<void> | undefined;
  private retryNotBefore = 0;
  private closing = false;
  private materializationDirty = true;
  private pollingNeeded = false;
  private externalDataVersion: string | undefined;
  private externalTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribeCommit: () => void;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly processes: ProcessControlPlane,
    private readonly now: () => string = () => new Date().toISOString()
  ) {
    this.unsubscribeCommit = database.onCommit((commit) => {
      if (!commit.changes.some((change) =>
        change.domain === 'ChildInterruptionTurnLink'
        || change.domain === 'ProcessCompletionSourceLink'
      )) return;
      this.materializationDirty = true;
      if (this.started) this.notify();
    });
  }

  public start(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Child owned-process cleanup is closing.'));
    if (this.startPromise) return this.startPromise;
    if (this.started) return this.reconcile();
    this.started = true;
    const task = (async () => {
      const version = await this.database.externalDataVersion();
      if (this.closing) return;
      this.materializationDirty = true;
      await this.reconcile();
      if (this.closing) return;
      this.externalDataVersion = version;
      const afterRecoveryVersion = await this.database.externalDataVersion();
      if (this.closing) return;
      if (afterRecoveryVersion !== version) {
        this.materializationDirty = true;
        await this.reconcile();
        if (!this.closing) this.externalDataVersion = afterRecoveryVersion;
      }
    })().catch((error) => {
      this.materializationDirty = true;
      this.pollingNeeded = true;
      this.retryNotBefore = Date.now() + CLEANUP_POLL_MS;
      throw error;
    }).finally(() => {
      if (this.startPromise === task) this.startPromise = undefined;
      this.schedule();
      this.scheduleExternalChangePoll();
    });
    this.startPromise = task;
    return task;
  }

  public notify(): void {
    if (this.closing) return;
    this.materializationDirty = true;
    if (!this.started) return;
    this.rerun = true;
    if (Date.now() < this.retryNotBefore) {
      this.schedule();
      return;
    }
    this.cancelScheduledPoll();
    this.reconcileInBackground();
  }

  public async reconcile(): Promise<void> {
    if (this.closing) return;
    if (this.pass) {
      this.rerun = true;
      return this.pass;
    }
    this.cancelScheduledPoll();
    let pollingNeeded = false;
    let failed = false;
    const task = (async () => {
      do {
        this.rerun = false;
        if (this.materializationDirty) {
          this.materializationDirty = false;
          try {
            await this.materializeCleanupRows();
          } catch (error) {
            this.materializationDirty = true;
            throw error;
          }
        }
        if (this.closing) break;
        pollingNeeded = await this.convergeCleanupRows();
      } while (this.rerun && !this.closing);
      this.retryNotBefore = 0;
    })().catch((error) => {
      failed = true;
      pollingNeeded = true;
      this.retryNotBefore = Date.now() + CLEANUP_POLL_MS;
      throw error;
    }).finally(() => {
      if (this.pass === task) this.pass = undefined;
      this.pollingNeeded = pollingNeeded && !this.closing;
      if (this.rerun && !failed && !this.closing) this.reconcileInBackground();
      else this.schedule();
    });
    this.pass = task;
    return task;
  }

  public async dispose(): Promise<void> {
    this.closing = true;
    this.unsubscribeCommit();
    this.cancelScheduledPoll();
    if (this.externalTimer) clearTimeout(this.externalTimer);
    this.externalTimer = undefined;
    await Promise.allSettled([this.startPromise, this.externalPollTask, this.pass].filter(
      (task): task is Promise<void> => task !== undefined
    ));
  }

  private schedule(): void {
    if (!this.started || this.closing || !this.pollingNeeded || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.reconcileInBackground();
    }, Math.max(CLEANUP_POLL_MS, this.retryNotBefore - Date.now()));
    this.timer.unref?.();
  }

  private reconcileInBackground(): void {
    void this.reconcile().catch((error) => {
      if (!this.closing) console.warn('[reliable-kernel] Child process cleanup will retry.', error);
    });
  }

  private cancelScheduledPoll(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleExternalChangePoll(): void {
    if (!this.started || this.closing || this.externalTimer) return;
    this.externalTimer = setTimeout(() => {
      this.externalTimer = undefined;
      const task = this.pollExternalChanges();
      this.externalPollTask = task;
      void task.catch(() => undefined).finally(() => {
        if (this.externalPollTask === task) this.externalPollTask = undefined;
        this.scheduleExternalChangePoll();
      });
    }, EXTERNAL_CHANGE_POLL_MS);
    this.externalTimer.unref?.();
  }

  private async pollExternalChanges(): Promise<void> {
    const version = await this.database.externalDataVersion();
    if (this.closing || version === this.externalDataVersion) return;
    this.materializationDirty = true;
    await this.reconcile();
    if (!this.closing) this.externalDataVersion = version;
  }

  private async materializeCleanupRows(): Promise<void> {
    const candidates = await this.database.childProcessCleanupMaterializationCandidates();
    for (const candidate of candidates) {
      if (this.closing) return;
      const requestId = requireId(candidate.interruptionRequestId, 'interruptionRequestId');
      const turnId = requireId(candidate.turnId, 'turnId');
      const processId = requireId(candidate.processId, 'processId');
      const cleanupId = stablePhaseFId(
        'child_interruption_process_cleanup',
        requestId,
        processId
      );
      const now = this.now();
      try {
        await this.database.transaction([
          DOMAIN_REPOSITORIES.domain('ChildInterruptionRequest').assert(requestId, {}),
          DOMAIN_REPOSITORIES.domain('ChildInterruptionTurnLink').assert(
            requireId(candidate.turnLinkId, 'turnLinkId'),
            { interruption_request_id: requestId, turn_id: turnId }
          ),
          DOMAIN_REPOSITORIES.domain('ProcessCompletionSourceLink').assert(
            requireId(candidate.sourceLinkId, 'sourceLinkId'),
            { process_id: processId, source_turn_id: turnId }
          ),
          DOMAIN_REPOSITORIES.domain('ChildInterruptionProcessCleanup').insert({
            id: cleanupId,
            interruption_request_id: requestId,
            process_id: processId,
            state: 'pending',
            last_status: null,
            last_error: null,
            created_at: now,
            updated_at: now
          })
        ]);
      } catch (error) {
        if (!isCleanupIdentityRace(error)) throw error;
      }
    }
  }

  private async convergeCleanupRows(): Promise<boolean> {
    if (this.closing) return false;
    const rows = (await Promise.all([
      listAllDomainRows(this.database, 'ChildInterruptionProcessCleanup', { state: 'pending' }),
      listAllDomainRows(this.database, 'ChildInterruptionProcessCleanup', { state: 'stop_requested' })
    ])).flat();
    let pollingNeeded = false;
    for (const row of rows) {
      if (this.closing) return false;
      const cleanupId = requireId(row.id, 'ChildInterruptionProcessCleanup.id');
      const processId = requireId(row.process_id, 'ChildInterruptionProcessCleanup.process_id');
      let observation;
      try {
        observation = await this.processes.stopOwnedProcess(processId);
      } catch (error) {
        // A failed observation proves nothing about the process. Keep the durable cleanup pending
        // and continue with its siblings; only a real unknown-outcome observation needs a human.
        if (isRetryableLocalExecutionError(error)) {
          pollingNeeded = true;
          continue;
        }
        observation = {
          outcome: 'outcome_unknown' as const,
          status: 'outcome_unknown' as const,
          reason: errorText(error)
        };
      }
      const nextState = observation.status === 'already_exited' || observation.status === 'stopped'
        ? 'completed'
        : observation.status === 'stop_requested'
          ? 'stop_requested'
          : observation.status === 'cancelled'
            ? 'pending'
            : 'needs_human';
      const now = this.now();
      try {
        await this.database.transaction([
          DOMAIN_REPOSITORIES.domain('ChildInterruptionProcessCleanup').assert(cleanupId, {
            process_id: processId,
            state: row.state
          }),
          DOMAIN_REPOSITORIES.domain('ChildInterruptionProcessCleanup').update(cleanupId, {
            state: nextState,
            last_status: observation.status,
            last_error: observation.reason ? bounded(observation.reason) : null,
            updated_at: now
          })
        ]);
      } catch (error) {
        if (!isTransactionAssertionFailure(error)) throw error;
        this.rerun = true;
        pollingNeeded = true;
        continue;
      }
      if (nextState === 'pending' || nextState === 'stop_requested') pollingNeeded = true;
    }
    return pollingNeeded;
  }
}

function isCleanupIdentityRace(error: unknown): boolean {
  return isTransactionAssertionFailure(error) || sqliteUniqueFailureIncludes(error, [
    'child_interruption_process_cleanup.id',
    'child_interruption_process_cleanup.interruption_request_id, child_interruption_process_cleanup.process_id'
  ]);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded(value: string): string {
  return value.length <= 2_000 ? value : `${value.slice(0, 1_997)}…`;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty id.`);
  }
  return value;
}
