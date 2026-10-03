/** Only fixed, bounded lease renewals may overtake ordinary Runtime requests. */
export const DATABASE_WORKER_CRITICAL_BURST = 32;

interface QueuedRequest<T> { sequence: number; request: T }

/**
 * One synchronous job per event-loop turn: an atomic SQLite transaction is never split. Ordinary
 * requests remain FIFO, critical bursts are bounded, and no request crosses close/maintenance.
 * The injected scheduler is only an event-loop adapter; production uses setImmediate and tests
 * drain it explicitly to verify dispatch order without machine-dependent timing assertions.
 */
export class DatabaseWorkerRequestQueue<T extends { kind: string }> {
  private ordinary: Array<QueuedRequest<T> | undefined> = [];
  private critical: Array<QueuedRequest<T> | undefined> = [];
  private barriers: number[] = [];
  private ordinaryHead = 0;
  private criticalHead = 0;
  private barrierHead = 0;
  private nextSequence = 0;
  private criticalBurst = 0;
  private scheduled = false;
  private closed = false;

  public constructor(
    private readonly execute: (request: T) => void,
    private readonly schedule: (run: () => void) => void = run => { setImmediate(run); }
  ) {}

  public enqueue(request: T): void {
    if (this.closed) return;
    const entry = { sequence: this.nextSequence++, request };
    if (request.kind === 'renewExecutionLease') this.critical.push(entry);
    else this.ordinary.push(entry);
    if (request.kind === 'close' || request.kind.startsWith('maintenance')) {
      this.barriers.push(entry.sequence);
    }
    this.scheduleNext();
  }

  public close(): void {
    this.closed = true;
    this.ordinary = [];
    this.critical = [];
    this.barriers = [];
    this.ordinaryHead = this.criticalHead = this.barrierHead = 0;
  }

  private scheduleNext(): void {
    if (this.closed || this.scheduled || !this.hasPending()) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      if (this.closed) return;
      const next = this.takeNext();
      if (!next) return;
      try { this.execute(next.request); }
      finally { this.scheduleNext(); }
    });
  }

  private hasPending(): boolean {
    return this.ordinaryHead < this.ordinary.length || this.criticalHead < this.critical.length;
  }

  private takeNext(): QueuedRequest<T> | undefined {
    const ordinary = this.ordinary[this.ordinaryHead];
    const critical = this.critical[this.criticalHead];
    const barrier = this.barriers[this.barrierHead];
    // A later critical request cannot cross an earlier close or maintenance boundary. Conversely,
    // a boundary must not overtake a critical request that was already submitted before it.
    const criticalBeforeBarrier = critical && (barrier === undefined || critical.sequence < barrier);
    const ordinaryIsBarrier = ordinary && ordinary.sequence === barrier;
    const takeCritical = criticalBeforeBarrier && (
      !ordinary || ordinaryIsBarrier || this.criticalBurst < DATABASE_WORKER_CRITICAL_BURST
    );
    let next: QueuedRequest<T> | undefined;
    if (takeCritical) {
      next = critical;
      this.critical[this.criticalHead++] = undefined;
      this.criticalBurst += 1;
    } else if (ordinary) {
      next = ordinary;
      this.ordinary[this.ordinaryHead++] = undefined;
      this.criticalBurst = 0;
      if (ordinaryIsBarrier) this.barrierHead += 1;
    }
    // Avoid shift()'s quadratic queue movement without retaining completed requests indefinitely.
    if (this.ordinaryHead >= 1024 && this.ordinaryHead * 2 >= this.ordinary.length) {
      this.ordinary = this.ordinary.slice(this.ordinaryHead); this.ordinaryHead = 0;
    }
    if (this.criticalHead >= 1024 && this.criticalHead * 2 >= this.critical.length) {
      this.critical = this.critical.slice(this.criticalHead); this.criticalHead = 0;
    }
    if (this.barrierHead >= 1024 && this.barrierHead * 2 >= this.barriers.length) {
      this.barriers = this.barriers.slice(this.barrierHead); this.barrierHead = 0;
    }
    return next;
  }
}
