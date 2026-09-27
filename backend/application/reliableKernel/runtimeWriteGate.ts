/** A write command refused while this window is frozen for an exclusive data-directory operation. */
export class RuntimeWritesFrozenError extends Error {
  public readonly code = 'runtime-writes-frozen';

  public constructor(activity: string) {
    super(`正在${activity}，完成后再操作。`);
    this.name = 'RuntimeWritesFrozenError';
  }
}

export function isRuntimeWritesFrozenError(error: unknown): error is RuntimeWritesFrozenError {
  return error instanceof RuntimeWritesFrozenError
    || (error as { code?: unknown } | null)?.code === 'runtime-writes-frozen';
}

/** What existed when the window froze: the only work that still counts as this window's. */
export interface RuntimeWriteFreezeBaseline {
  /** Conversations this window owned (running or pending work, or a command in progress). */
  conversationIds: ReadonlySet<string>;
  /** A write command admitted before the freeze was still running: its effects cannot be told apart. */
  writesRunning: boolean;
}

interface Freeze {
  activity: string;
  baseline: RuntimeWriteFreezeBaseline;
}

/**
 * The entry-level write freeze of one window. The Facade's write methods and the command router's
 * write commands run through it; while an exclusive data-directory operation is about to close
 * this window's Runtime (from its beforeGo until the operation ended) each of them is refused at
 * its entry with “正在<操作>，完成后再操作。”, before anything is written. Views and reads go on,
 * and unsent input stays in the composer. Nested freezes share the first one's baseline.
 */
export class RuntimeWriteGate {
  private freezes: Freeze[] = [];
  private running = 0;

  /** Refuses the write while frozen; otherwise runs it, counted as a write in progress until it settles. */
  public async run<T>(operation: () => Promise<T>): Promise<T> {
    this.admit();
    this.running += 1;
    try {
      return await operation();
    } finally {
      this.running -= 1;
    }
  }

  /** Throws RuntimeWritesFrozenError while frozen. */
  public admit(): void {
    const freeze = this.freezes[0];
    if (freeze) throw new RuntimeWritesFrozenError(freeze.activity);
  }

  public get frozen(): boolean {
    return this.freezes.length > 0;
  }

  /**
   * Freezes writes for `activity` (“迁移数据目录”). `ownedConversationIds` is what this window owns
   * right now; it and whether a write command is still running form the baseline. Returns the thaw
   * (idempotent).
   */
  public freeze(activity: string, ownedConversationIds: Iterable<string>): () => void {
    const entry: Freeze = {
      activity,
      baseline: { conversationIds: new Set(ownedConversationIds), writesRunning: this.running > 0 }
    };
    this.freezes.push(entry);
    let thawed = false;
    return () => {
      if (thawed) return;
      thawed = true;
      this.freezes = this.freezes.filter((item) => item !== entry);
    };
  }

  /** While frozen: what existed at the (first) freeze. */
  public frozenBaseline(): RuntimeWriteFreezeBaseline | undefined {
    return this.freezes[0]?.baseline;
  }
}
