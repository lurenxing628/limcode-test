/** Resource admission only: this never grants execution ownership or counts active Agents. */
export const MAX_CONCURRENT_HISTORY_PREPARATIONS = 2;

const permitBrand: unique symbol = Symbol('history-preparation-permit');

/** An explicit, local scope passed from the lifecycle fork to its inner atomic writer. */
export interface HistoryPreparationPermit {
  readonly [permitBrand]: true;
  /** Check before more preparation or submission, never after an atomic commit was submitted. */
  assertActive(): void;
}

export interface HistoryPreparationOptions {
  signal?: AbortSignal;
  permit?: HistoryPreparationPermit;
}

interface Waiter {
  resolve(permit: HistoryPreparationPermit): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  onAbort(): void;
}

/**
 * FIFO preparation scopes. Waiters contain no history or transaction plans. A permit is owned by
 * exactly one admission instance and may be reused by one nested writer, never parallel siblings.
 */
export class HistoryPreparationAdmission {
  private readonly active = new Map<HistoryPreparationPermit, { nested: boolean }>();
  private readonly waiters = new Set<Waiter>();
  private readonly idleWaiters = new Set<() => void>();
  private closed = false;
  private closeReason: unknown;

  public constructor(private readonly limit = MAX_CONCURRENT_HISTORY_PREPARATIONS) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('History preparation concurrency must be positive.');
  }

  public async run<T>(operation: (permit: HistoryPreparationPermit) => Promise<T>,
    options: HistoryPreparationOptions = {}): Promise<T> {
    if (options.permit) {
      const state = this.active.get(options.permit);
      if (!state || state.nested) throw new Error('History preparation permit is stale, foreign or already in use.');
      options.permit.assertActive();
      options.signal?.throwIfAborted();
      state.nested = true;
      try { return await operation(options.permit); }
      finally { state.nested = false; }
    }
    const permit = await this.acquire(options.signal);
    try {
      permit.assertActive();
      return await operation(permit);
    } finally {
      this.active.delete(permit);
      this.drain();
    }
  }

  /** Reject queued work immediately; admitted work checks its scope, or drains its submitted commit. */
  public close(reason: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const waiter of this.waiters) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      waiter.reject(reason);
    }
    this.waiters.clear();
  }

  public whenIdle(): Promise<void> {
    if (this.active.size === 0) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.add(resolve));
  }

  private acquire(signal?: AbortSignal): Promise<HistoryPreparationPermit> {
    if (this.closed) return Promise.reject(this.closeReason);
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active.size < this.limit) return Promise.resolve(this.grant(signal));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, onAbort: () => {
        if (!this.waiters.delete(waiter)) return;
        signal?.removeEventListener('abort', waiter.onAbort);
        reject(signal?.reason);
      } };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
    });
  }

  private grant(signal?: AbortSignal): HistoryPreparationPermit {
    const permit: HistoryPreparationPermit = Object.freeze({
      [permitBrand]: true as const,
      assertActive: () => {
        if (this.closed) throw this.closeReason;
        if (!this.active.has(permit)) throw new Error('History preparation permit is no longer active.');
        signal?.throwIfAborted();
      }
    });
    this.active.set(permit, { nested: false });
    return permit;
  }

  private drain(): void {
    while (!this.closed && this.active.size < this.limit && this.waiters.size > 0) {
      const waiter = this.waiters.values().next().value!;
      this.waiters.delete(waiter);
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal?.aborted) waiter.reject(waiter.signal.reason);
      else waiter.resolve(this.grant(waiter.signal));
    }
    if (this.active.size === 0) {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }
}
