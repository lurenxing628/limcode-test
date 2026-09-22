/** Bounded host-memory observation fence, not a persistent job engine or cancellation mechanism. */
export class ModelProfileMutationCompletions {
  private readonly entries = new Map<string, { done: Promise<void>; settledAt?: number }>();
  public constructor(private readonly now: () => number = Date.now, private readonly limit = 512, private readonly ttlMs = 600000) {}

  public register<T>(key: string, operation: () => Promise<T>): Promise<T> {
    this.prune();
    if (this.entries.has(key)) return Promise.reject(new Error('ModelProfile requestId 重复；请确认原请求结果。'));
    if (this.entries.size >= this.limit) return Promise.reject(new Error('ModelProfile 操作仍在处理中；未自动重发。'));
    let settle!: () => void;
    const entry: { done: Promise<void>; settledAt?: number } = { done: new Promise(resolve => { settle = resolve; }) };
    // Registration precedes even the first preflight/owner-claim await in operation().
    this.entries.set(key, entry);
    return Promise.resolve().then(operation).finally(() => { entry.settledAt = this.now(); settle(); });
  }

  public async after(key: string, waitMs = 5000): Promise<void> {
    this.prune();
    const entry = this.entries.get(key);
    if (!entry) throw new Error('保存结果未确定（未知请求或宿主已换代）；不能把当前值当作原保存已取消。');
    if (entry.settledAt !== undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([entry.done, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('保存仍可能在途，结果未确定；请稍后重新读取。')), waitMs);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  private prune(): void {
    for (const [key, entry] of this.entries) {
      // Never expire executing work into a false "settled" result. Eviction means unknown.
      if (entry.settledAt !== undefined && this.now() - entry.settledAt >= this.ttlMs) this.entries.delete(key);
    }
  }
}

export function modelProfileCompletionKey(clientId: string, authorityId: string, scopeKind: string, scopeId: string | undefined, requestId: string): string {
  return JSON.stringify([clientId, authorityId, scopeKind, scopeKind === 'global' ? null : scopeId, requestId]);
}
