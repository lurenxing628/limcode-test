import type { ContentAddressedStore } from './contentAddressedStore';
import type { RuntimeChange } from './contracts';
import type { ModelHandleCatalog, ModelHandleEntry } from './modelHandleCatalog';
import type { DomainRow, RepositoryRead } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import type { RuntimeDatabase } from './runtimeDatabase';

export interface ContextHandleRequestEvidence {
  catalogs: ModelHandleCatalog[];
  currentOrdinaryIdentity?: string;
}
export interface ContextHandleState { catalog: ModelHandleCatalog; requiresNativeReset: boolean }
type ForkEvidence = { catalog: ModelHandleCatalog; coveredRecipeObjectIds: string[] } | undefined;
interface Readers {
  fork(database: RuntimeDatabase): Promise<ForkEvidence>;
  request(database: RuntimeDatabase, request: DomainRow, covered: boolean): Promise<ContextHandleRequestEvidence>;
  reconcile(fork: ForkEvidence, requests: ContextHandleRequestEvidence[]): ContextHandleState;
}

// Cache identity is the live RuntimeDatabase, never a root path or conversation id alone. Keep
// only validated identity evidence, not recipe/source bodies. Oversized histories remain readable
// but are not retained. These are optimization limits, not new history validity constraints.
export const CONTEXT_HANDLE_EVIDENCE_CACHE_LIMITS = Object.freeze({ conversations: 8, requests: 2048, turns: 2048, bytes: 8 * 1024 * 1024 });
const caches = new WeakMap<RuntimeDatabase, EvidenceCache>();

export async function readCachedContextHandleState(database: RuntimeDatabase, store: ContentAddressedStore,
  conversationId: string, readers: Readers): Promise<ContextHandleState> {
  // Maintenance has no commit stream. Lightweight repository test doubles also use the complete
  // reader rather than asserting authority they cannot provide.
  if (database.maintenance || typeof database.onCommit !== 'function' || typeof database.externalDataVersion !== 'function') {
    return readUncached(database, readers, conversationId);
  }
  let cache = caches.get(database);
  if (!cache) { cache = new EvidenceCache(database); caches.set(database, cache); }
  return cache.read(store, conversationId, readers);
}

async function readUncached(database: RuntimeDatabase, readers: Readers, conversationId: string): Promise<ContextHandleState> {
  const fork = await readers.fork(database);
  const covered = new Set(fork?.coveredRecipeObjectIds ?? []);
  const evidence: ContextHandleRequestEvidence[] = [];
  for (const turn of await listAllDomainRows(database, 'Turn', { conversation_id: conversationId })) {
    for (const request of await listAllDomainRows(database, 'ModelRequest', { turn_id: turn.id })) {
      evidence.push(await readers.request(database, request, covered.has(String(request.recipe_object_id))));
    }
  }
  return readers.reconcile(fork, evidence);
}

interface Evidence<T> { value: T; dependencies: Dependencies }
interface ConversationEvidence {
  turns: Set<string>;
  pendingTurns: Set<string>;
  internedEntries: Map<string, ModelHandleEntry>;
  requests: Map<string, DomainRow>;
  evidence: Map<string, Evidence<ContextHandleRequestEvidence>>;
  evidenceByDomain: Map<string, Set<string>>;
  fork?: Evidence<ForkEvidence>;
  pending: Set<Dependencies>;
  revision: number;
  ready: boolean;
  reading: boolean;
  result?: ContextHandleState;
  bytes: number;
}

class EvidenceCache {
  private readonly conversations = new Map<string, ConversationEvidence>();
  private store?: ContentAddressedStore;
  private externalVersion?: string;
  // Serialize reads on this instance so a concurrent caller cannot publish a partially built
  // frontier or mutate the evidence another caller is reconciling. Failed reads never poison it.
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly database: RuntimeDatabase) {
    database.onCommit(commit => {
      for (const [conversationId, state] of this.conversations) {
        let changed = false;
        for (const change of commit.changes) {
          const row = change.record;
          if (change.kind === 'remove' && ['Conversation', 'Turn', 'ModelRequest'].includes(change.domain)) {
            // Removed rows intentionally have no owner payload; never guess that they were unrelated.
            this.conversations.delete(conversationId); changed = true; break;
          }
          if (change.domain === 'Turn' && row && state.turns.has(change.id) && row.conversation_id !== conversationId) {
            this.conversations.delete(conversationId); changed = true; break;
          }
          if (change.domain === 'ModelRequest' && row && state.requests.has(change.id) && !state.turns.has(String(row.turn_id))) {
            this.conversations.delete(conversationId); changed = true; break;
          }
          if (change.domain === 'Turn' && row?.conversation_id === conversationId && !state.turns.has(change.id)) {
            state.turns.add(change.id); state.pendingTurns.add(change.id); state.bytes += change.id.length * 2 + 64; changed = true;
          }
        }
        if (!this.conversations.has(conversationId)) { state.revision++; continue; }
        for (const change of commit.changes) {
          const row = change.record;
          if (change.domain === 'ModelRequest' && row && state.turns.has(String(row.turn_id))) {
            const existing = state.requests.get(change.id);
            if (!existing || existing.recipe_object_id !== row.recipe_object_id || existing.turn_id !== row.turn_id) {
              const identity = requestIdentity(row as DomainRow);
              state.requests.set(change.id, identity);
              state.bytes += JSON.stringify(identity).length * 2 + 128;
              removeEvidence(state, change.id); changed = true;
            }
          }
          if (state.fork?.dependencies.affected(change)) { state.fork = undefined; changed = true; }
          for (const id of [...(state.evidenceByDomain.get(change.domain) ?? [])]) {
            const evidence = state.evidence.get(id)!;
            if (evidence.dependencies.affected(change)) { removeEvidence(state, id); changed = true; }
          }
          for (const pending of state.pending) if (pending.affected(change)) changed = true;
        }
        if (changed) { state.revision++; state.result = undefined; }
      }
      this.trim();
    });
  }

  public read(store: ContentAddressedStore, conversationId: string, readers: Readers): Promise<ContextHandleState> {
    const next = this.queue.then(() => this.readSerial(store, conversationId, readers));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async readSerial(store: ContentAddressedStore, conversationId: string, readers: Readers): Promise<ContextHandleState> {
    if (this.store !== store) { this.conversations.clear(); this.store = store; this.externalVersion = undefined; }
    for (let attempt = 0; attempt < 3; attempt++) {
      // This ordinary database request also revalidates the fenced root, even for a cache hit.
      const version = await this.database.externalDataVersion();
      if (version !== this.externalVersion) { this.conversations.clear(); this.externalVersion = version; }
      let state = this.conversations.get(conversationId);
      if (!state) {
        state = { turns: new Set(), pendingTurns: new Set(), internedEntries: new Map(), requests: new Map(), evidence: new Map(), evidenceByDomain: new Map(), pending: new Set(), revision: 0, ready: false, reading: false, bytes: 0 };
        this.conversations.set(conversationId, state);
      }
      this.conversations.delete(conversationId); this.conversations.set(conversationId, state);
      state.reading = true;
      const revision = state.revision;
      const invalidated = (): boolean => state.revision !== revision || this.conversations.get(conversationId) !== state;
      const assertCurrent = (): void => {
        if (invalidated()) throw new Error('Context handle evidence was invalidated during the read.');
      };
      let checkingFinalFence = false;
      try {
        if (!state.ready) {
          const turns = await listAllDomainRows(this.database, 'Turn', { conversation_id: conversationId });
          assertCurrent();
          // Register the entire returned frontier before awaiting any one Turn's requests.
          // A later Turn can otherwise move away without the commit listener knowing it.
          for (const turn of turns) state.turns.add(String(turn.id));
          for (const turn of turns) {
            const requests = await listAllDomainRows(this.database, 'ModelRequest', { turn_id: turn.id });
            assertCurrent();
            for (const request of requests) {
              state.requests.set(String(request.id), requestIdentity(request));
            }
          }
          state.pendingTurns.clear();
          state.ready = true;
        }
        for (const turnId of state.pendingTurns) {
          const requests = await listAllDomainRows(this.database, 'ModelRequest', { turn_id: turnId });
          assertCurrent();
          for (const request of requests) {
            state.requests.set(String(request.id), requestIdentity(request));
          }
          state.pendingTurns.delete(turnId);
        }
        // Commits may clear or replace any shared slot while a reader is suspended. Reconcile
        // only this attempt's coherent references, and publish its result after both fences.
        let result = state.result;
        const recomputing = !result;
        if (!result) {
          let fork = state.fork;
          if (!fork) {
            const previousCoverage = state.evidence.size ? state.evidence.values().next().value?.dependencies.coverage : undefined;
            fork = await this.capture(state, readers.fork);
            assertCurrent();
            state.fork = fork;
            const coverage = JSON.stringify([...(fork.value?.coveredRecipeObjectIds ?? [])].sort());
            if (previousCoverage !== undefined && previousCoverage !== coverage) { state.evidence.clear(); state.evidenceByDomain.clear(); }
          }
          const covered = new Set(fork.value?.coveredRecipeObjectIds ?? []);
          const coverage = JSON.stringify([...covered].sort());
          const requestEvidence: Evidence<ContextHandleRequestEvidence>[] = [];
          for (const [id, request] of [...state.requests]) {
            let evidence = state.evidence.get(id);
            if (!evidence) {
              evidence = await this.capture(state, db => readers.request(db, request, covered.has(String(request.recipe_object_id))));
              assertCurrent();
              evidence.dependencies.coverage = coverage;
              for (const catalog of evidence.value.catalogs) catalog.entries = catalog.entries.map(entry => {
                const key = JSON.stringify(entry);
                const prior = state!.internedEntries.get(key);
                if (prior) return prior;
                state!.internedEntries.set(key, entry); return entry;
              });
              state.evidence.set(id, evidence);
              for (const domain of evidence.dependencies.domains()) {
                let ids = state.evidenceByDomain.get(domain);
                if (!ids) state.evidenceByDomain.set(domain, ids = new Set());
                ids.add(id);
              }
            }
            requestEvidence.push(evidence);
          }
          assertCurrent();
          shareRetiredRefLists(fork.value, requestEvidence);
          result = readers.reconcile(fork.value, requestEvidence.map(entry => entry.value));
          assertCurrent();
        }
        checkingFinalFence = true;
        const afterVersion = await this.database.externalDataVersion();
        checkingFinalFence = false;
        if (afterVersion !== version || invalidated()) {
          this.conversations.delete(conversationId);
          if (afterVersion !== version) { this.conversations.clear(); this.externalVersion = afterVersion; }
          continue;
        }
        const cloned = structuredClone(result);
        state.result = result;
        if (recomputing) state.bytes = retainedSize(state);
        state.reading = false;
        this.trim();
        return cloned;
      } catch (error) {
        if (checkingFinalFence) { this.conversations.delete(conversationId); throw error; }
        // A changing frontier can also make a reader or reconciliation fail before reaching
        // the normal post-read check. Retry only with proof of invalidation; stable corruption
        // and root-fence failures still propagate, and all retries share the same bound.
        const afterVersion = await this.database.externalDataVersion().catch(fenceError => {
          this.conversations.delete(conversationId);
          throw fenceError;
        });
        const changed = invalidated();
        this.conversations.delete(conversationId);
        if (afterVersion !== version) { this.conversations.clear(); this.externalVersion = afterVersion; }
        if (changed || afterVersion !== version) continue;
        throw error;
      } finally { state.pending.clear(); state.reading = false; }
    }
    throw Object.assign(new Error('Context handle evidence changed while it was being read; retry from the current frontier.'),
      { code: 'MODEL_CONTEXT_HANDLE_FRONTIER_CHANGED' });
  }

  private async capture<T>(state: ConversationEvidence, read: (database: RuntimeDatabase) => Promise<T>): Promise<Evidence<T>> {
    const dependencies = new Dependencies();
    state.pending.add(dependencies);
    // Retain through the attempt's final fence, including the promise-continuation gap before
    // the caller installs the captured proof. Otherwise a commit in that gap can be missed.
    return { value: await read(dependencies.reader(this.database)), dependencies };
  }

  private trim(): void {
    const limits = CONTEXT_HANDLE_EVIDENCE_CACHE_LIMITS;
    for (const [id, state] of this.conversations) {
      if (!state.reading && (state.turns.size > limits.turns || state.requests.size > limits.requests || state.bytes > limits.bytes)) this.conversations.delete(id);
    }
    let bytes = [...this.conversations.values()].reduce((sum, value) => sum + value.bytes, 0);
    let requests = [...this.conversations.values()].reduce((sum, value) => sum + value.requests.size, 0);
    while (this.conversations.size > limits.conversations || bytes > limits.bytes || requests > limits.requests) {
      const candidate = [...this.conversations].find(([, value]) => !value.reading);
      if (!candidate) break; // Transient reader memory already existed before caching; never make cache limits a read error.
      const [oldest, entry] = candidate;
      bytes -= entry.bytes; requests -= entry.requests.size; this.conversations.delete(oldest);
    }
  }
}

function requestIdentity(row: DomainRow): DomainRow {
  return { id: row.id, turn_id: row.turn_id, recipe_object_id: row.recipe_object_id };
}

/** Query membership is part of the proof: both changes to known rows and new matching rows
 * invalidate it. Only identity selectors, never source bodies, are retained. */
class Dependencies {
  public coverage?: string;
  private readonly ids = new Map<string, Set<string>>();
  private readonly lists: Array<{ domain: string; where: DomainRow }> = [];
  private readonly materializing = new Set<string>();
  private readonly turns = new Map<string, string>();

  public affected(change: RuntimeChange): boolean {
    if (change.domain === 'Turn' && change.record && this.turns.get(change.id) === turnIdentity(change.record)) return false;
    if (this.materializing.has(change.domain) || this.ids.get(change.domain)?.has(change.id)) return true;
    return this.lists.some(read => read.domain === change.domain && (change.kind === 'remove'
      || !change.record || Object.entries(read.where).every(([key, value]) => String(change.record![key]) === String(value))));
  }

  private observe(read: RepositoryRead): void {
    if (read.kind === 'get') this.id(read.domain, read.id);
    else if (read.kind === 'list' && read.collaborationProjectScope !== undefined) {
      for (const domain of ['Conversation', 'ChildExecution', 'ConversationProjectLink']) this.materializing.add(domain);
    } else if (read.kind === 'list' && read.collaborationRootConversationId === undefined) {
      this.lists.push({ domain: read.domain, where: { ...read.where } });
    } else {
      // Rooted collaboration reads depend on ancestry as well as their result domain.
      for (const domain of ['Conversation', 'Turn', 'ChildExecution', 'ChildExecutionParentLink']) this.materializing.add(domain);
    }
  }
  private id(domain: string, id: unknown): void {
    let ids = this.ids.get(domain); if (!ids) this.ids.set(domain, ids = new Set()); ids.add(String(id));
  }
  public domains(): Set<string> { return new Set([...this.ids.keys(), ...this.lists.map(read => read.domain), ...this.materializing]); }
  public size(): number {
    return JSON.stringify([...this.ids].map(([domain, ids]) => [domain, [...ids]])).length * 2
      + JSON.stringify(this.lists, (_, value) => typeof value === 'bigint' ? String(value) : value).length * 2 + (this.coverage?.length ?? 0) * 2 + JSON.stringify([...this.turns]).length * 2;
  }
  public reader(database: RuntimeDatabase): RuntimeDatabase {
    return new Proxy(database, { get: (target, property) => {
      if (property === 'snapshot') return async (reads: RepositoryRead[]) => {
        reads.forEach(read => this.observe(read));
        const result = await target.snapshot(reads);
        result.snapshot.forEach((value, index) => {
          if (value) for (const row of Array.isArray(value) ? value : [value]) {
            this.id(reads[index].domain, row.id);
            if (reads[index].domain === 'Turn') this.turns.set(String(row.id), turnIdentity(row));
          }
        });
        return result;
      };
      if (property === 'snapshotAll') return async (read: Parameters<RuntimeDatabase['snapshotAll']>[0]) => {
        this.observe(read);
        const result = await target.snapshotAll(read);
        for (const row of result.snapshot) this.id(read.domain, row.id);
        return result;
      };
      if (property === 'materializeContext') return async (rootId: string) => {
        const domains = ['ContextSequenceRoot', 'ContextSequenceNode', 'ContextSegment', 'ContentObject'];
        this.id('ContextSequenceRoot', rootId); domains.forEach(domain => this.materializing.add(domain));
        try {
          const result = await target.materializeContext(rootId);
          for (const record of result.snapshot.records) {
            this.id('ContextSequenceNode', record.node.id); this.id('ContextSegment', record.segment.id);
            this.id('ContentObject', record.contentObject.id);
          }
          return result;
        } finally { domains.forEach(domain => this.materializing.delete(domain)); }
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
}

/** Share only exactly equal, already validated retirement facts within the live evidence set.
 * The lookup is discarded before returning, so it retains neither serialized keys nor obsolete
 * arrays. Evidence invalidation releases each shared list when its last catalog is discarded. */
function shareRetiredRefLists(fork: ForkEvidence, requests: Evidence<ContextHandleRequestEvidence>[]): void {
  const lists = new Map<string, string[]>();
  const share = (catalog: ModelHandleCatalog): void => {
    const refs = catalog.retiredRefs;
    if (!refs) return;
    const key = JSON.stringify(refs);
    const existing = lists.get(key);
    if (existing) catalog.retiredRefs = existing;
    else { Object.freeze(refs); lists.set(key, refs); }
  };
  if (fork) share(fork.catalog);
  for (const evidence of requests) {
    for (const catalog of evidence.value.catalogs) share(catalog);
  }
}

function retainedSize(state: ConversationEvidence): number {
  // Cumulative frozen catalogs share their identical entries. Count each retained object once,
  // including array slots, rather than repeatedly charging serialized target strings per round.
  const seen = new Set<object>();
  const bytes = (value: unknown): number => {
    if (typeof value === 'string') return 16 + value.length * 2;
    if (!value || typeof value !== 'object') return 8;
    if (seen.has(value)) return 0;
    seen.add(value);
    if (Array.isArray(value)) return 32 + value.reduce((sum, child) => sum + 8 + bytes(child), 0);
    return 64 + Object.entries(value).reduce((sum, [key, child]) => sum + key.length * 2 + 16 + bytes(child), 0);
  };
  let size = bytes([...state.requests.values()]) + bytes([...state.turns]) + bytes([...state.pendingTurns]) + bytes(state.result);
  for (const [key, entry] of state.internedEntries) size += bytes(key) + bytes(entry) + 64;
  if (state.fork) size += bytes(state.fork.value) + state.fork.dependencies.size();
  for (const entry of state.evidence.values()) size += bytes(entry.value) + entry.dependencies.size() + 256;
  for (const ids of state.evidenceByDomain.values()) size += bytes([...ids]);
  return size;
}

// Historical/fork proofs inspect Turn ownership and terminal state, never its activity clock or UI projection.
function turnIdentity(row: Record<string, unknown>): string {
  return JSON.stringify([row.id, row.conversation_id, row.status]);
}

function removeEvidence(state: ConversationEvidence, id: string): void {
  const previous = state.evidence.get(id);
  if (!previous) return;
  for (const domain of previous.dependencies.domains()) {
    const ids = state.evidenceByDomain.get(domain);
    ids?.delete(id);
    if (ids?.size === 0) state.evidenceByDomain.delete(domain);
  }
  state.evidence.delete(id);
}
