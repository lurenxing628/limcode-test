/** One source's already prepared work; no source is scanned just to build this prompt. */
export interface RuntimeMergeSettlementRequest {
  candidateId: string;
  label?: string;
  dataSetId?: string;
  rootInstanceId?: string;
  turns: number;
  intents: number;
  deliveries?: number;
  children?: number;
  effects?: number;
  sources?: RuntimeMergeSettlementRequest[];
}

/**
 * Preparation pauses at its ordinary consent boundary, outside all maintenance claims. The caller
 * keeps its existing snapshot and resumes each continuation in source order after one prompt.
 */
export class RuntimeMergeSettlementBatch<T> {
  private readonly pending: Array<{
    input: RuntimeMergeSettlementRequest;
    resume(value: boolean): void;
    job: Promise<T>;
    consume(result: T): Promise<void>;
  }> = [];

  public async prepare(
    start: (confirm: (input: RuntimeMergeSettlementRequest) => Promise<boolean>) => Promise<T>,
    consume: (result: T) => Promise<void>
  ): Promise<void> {
    let paused!: () => void;
    const reached = new Promise<void>(resolve => { paused = resolve; });
    let request: { input: RuntimeMergeSettlementRequest; resume(value: boolean): void } | undefined;
    const job = start(input => new Promise<boolean>(resolve => {
      request = { input, resume: resolve };
      paused();
    }));
    const first = await Promise.race([
      job.then(result => ({ result })), reached.then(() => ({ paused: true as const }))
    ]);
    if ('result' in first) await consume(first.result);
    else this.pending.push({ ...request!, job, consume });
  }

  public async confirm(confirm: (input: RuntimeMergeSettlementRequest) => Promise<boolean>, keepGoing: () => boolean = () => true): Promise<void> {
    if (!this.pending.length) return;
    const sources = this.pending.map(item => item.input);
    const sum = (field: 'turns' | 'intents' | 'deliveries' | 'children' | 'effects'): number => sources.reduce((n, item) => n + (item[field] ?? 0), 0);
    const accepted = await confirm({ candidateId: sources[0].candidateId, sources,
      turns: sum('turns'), intents: sum('intents'), deliveries: sum('deliveries'), children: sum('children'), effects: sum('effects') });
    while (this.pending.length) {
      const item = this.pending.shift()!;
      item.resume(accepted && keepGoing());
      await item.consume(await item.job);
    }
  }

  /** A cancelled prompt or failed preparation releases every retained snapshot via its own finally. */
  public async close(): Promise<void> {
    const pending = this.pending.splice(0);
    for (const item of pending) item.resume(false);
    await Promise.allSettled(pending.map(async item => { await item.consume(await item.job); }));
  }
}
