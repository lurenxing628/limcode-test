/**
 * Retries of local, idempotent persistence steps are separate from Provider Attempts. These
 * counters are deliberately Host-local; durable Turn/Intent/checkpoint facts, not this helper,
 * decide what a restarted Host resumes. Never use this helper to repeat an external effect.
 */
export const LOCAL_EXECUTION_MAX_RETRIES = 8;
const LOCAL_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 3_000, 5_000, 5_000] as const;

// A reconstructed terminal fact is immutable history, even when its diagnostic code names a
// transient local error. Keep provenance out of serialized/provider-controlled error fields.
const restoredTerminalFailures = new WeakSet<object>();

export function markRestoredTerminalFailure<T extends Error>(error: T): T {
  restoredTerminalFailures.add(error);
  return error;
}

/** Prevent nested local/provider/runner retry loops from multiplying an exhausted budget. */
export class LocalExecutionRecoveryExhaustedError extends Error {
  public readonly code = 'LOCAL_EXECUTION_RECOVERY_EXHAUSTED';
  public readonly category = 'internal';
  public constructor(public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'LocalExecutionRecoveryExhaustedError';
  }
}

export function isRetryableLocalExecutionError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || restoredTerminalFailures.has(error)) return false;
  const value = error as { code?: unknown; name?: unknown };
  if (value.name === 'AbortError' || value.name === 'RootAuthorityError'
    || value.name === 'StaleRootBindingError') return false;
  const code = typeof value.code === 'string' ? value.code : '';
  // SQLite rolls back a refused/failed transaction; callers still re-read its idempotent facts
  // because an acknowledgment can be lost after a successful commit. Corruption, full disks,
  // permissions, root identity and schema/assertion errors are intentionally not transient.
  return /^(SQLITE_BUSY|SQLITE_LOCKED)(?:_|$)/.test(code)
    || ['EAGAIN', 'EBUSY', 'EMFILE', 'ENFILE'].includes(code);
}

export function localExecutionRetryDelayMs(retryNumber: number): number {
  return LOCAL_RETRY_DELAYS_MS[Math.max(0, Math.min(LOCAL_RETRY_DELAYS_MS.length - 1, retryNumber - 1))]!;
}

/** The callback may stop a delay for a durable interrupt or shutdown, without consuming it. */
export async function waitForLocalExecutionRetry(
  retryNumber: number,
  shouldStop?: () => Promise<boolean>
): Promise<void> {
  const until = Date.now() + localExecutionRetryDelayMs(retryNumber);
  for (;;) {
    if (shouldStop && await shouldStop()) return;
    const remaining = until - Date.now();
    if (remaining <= 0) return;
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(250, remaining)));
  }
}

/** Only wrap an idempotent local operation, retaining its original identities on every call. */
export async function retryLocalExecution<T>(
  operation: () => Promise<T>,
  options: { signal?: AbortSignal; beforeRetry?: (error: unknown, retryNumber: number) => Promise<void> } = {}
): Promise<T> {
  for (let retryNumber = 0; ; retryNumber += 1) {
    options.signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!isRetryableLocalExecutionError(error)) throw error;
      if (retryNumber >= LOCAL_EXECUTION_MAX_RETRIES) throw new LocalExecutionRecoveryExhaustedError(error);
      await options.beforeRetry?.(error, retryNumber + 1);
      await waitForLocalExecutionRetry(retryNumber + 1, async () => {
        options.signal?.throwIfAborted();
        return false;
      });
    }
  }
}
