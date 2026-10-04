import type { ContentAddressedStore } from './contentAddressedStore';
import type { RuntimeChange } from './contracts';
import type { ModelHandleCatalog } from './modelHandleCatalog';
import { ContextHandleEvidenceFacts, type PackedContextHandleEvidence } from './contextHandleEvidenceFacts';
import type { ContextHandleEvidenceFrontier } from './contextHandleEvidenceFrontier';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryRead } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import type { RuntimeDatabase } from './runtimeDatabase';

export interface ContextHandleRequestEvidence {
  catalogs: ModelHandleCatalog[];
  currentOrdinaryCatalog?: ModelHandleCatalog;
  /** Ordinary/current recipes depend only on the scoped persisted frontier. */
  frontierCovered?: boolean;
}
export interface ContextHandleState { catalog: ModelHandleCatalog; requiresNativeReset: boolean }
type ForkEvidence = { catalog: ModelHandleCatalog; coveredRecipeObjectIds: string[] } | undefined;
interface Readers {
  beginRead(): void;
  fork(database: RuntimeDatabase): Promise<ForkEvidence>;
  request(database: RuntimeDatabase, request: DomainRow, covered: boolean): Promise<ContextHandleRequestEvidence>;
  reconcile(fork: ForkEvidence, evidence: { catalogs: ModelHandleCatalog[]; hasCurrentOrdinaryCatalog(catalog: ModelHandleCatalog): boolean }): ContextHandleState;
}

// Cache identity is the live RuntimeDatabase, never a root path or conversation id alone. Keep
// only validated identity evidence, not recipe/source bodies. The active frontier is never evicted
// because of its history length: that would turn every subsequent round into a cold full replay.
// The byte budget evicts idle conversations, while shared facts bound cumulative catalog growth.
export const CONTEXT_HANDLE_EVIDENCE_CACHE_LIMITS = Object.freeze({ conversations: 8, bytes: 8 * 1024 * 1024 });
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
  readers.beginRead();
  const fork = await readers.fork(database);
  const covered = new Set(fork?.coveredRecipeObjectIds ?? []);
  const evidence = new ContextHandleEvidenceFacts();
  for (const turn of await listAllDomainRows(database, 'Turn', { conversation_id: conversationId })) {
    for (const request of await listAllDomainRows(database, 'ModelRequest', { turn_id: turn.id })) {
      const value = await readers.request(database, request, covered.has(String(request.recipe_object_id)));
      evidence.add(value.catalogs, value.currentOrdinaryCatalog);
    }
  }
  return readers.reconcile(fork, { catalogs: evidence.allCatalogs(),
    hasCurrentOrdinaryCatalog: catalog => evidence.hasCurrentOrdinaryCatalog(catalog) });
}

interface Evidence<T> { value: T; dependencies: Dependencies }
interface ConversationEvidence {
  turns: Set<string>;
  activeTurns: Set<string>;
  pendingTurns: Set<string>;
  pendingRequests: Set<string>;
  toolRequests: Map<string, string>;
  invalidation: DependencyIndex;
  coverage?: string;
  coveredRecipeIds: Set<string>;
  needsSizing: boolean;
  recheckRequests: Set<string>;
  recheckFork: boolean;
  facts: ContextHandleEvidenceFacts;
  frontier?: Map<string, Map<string, DomainRow>>;
  externalDirty: boolean;
  requests: Map<string, DomainRow>;
  evidence: Map<string, Evidence<PackedContextHandleEvidence> & { frontierCovered: boolean }>;
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
        this.applyChanges(conversationId, state, commit.changes);
        updateFrontierFromCommit(state, conversationId, commit.changes);
        for (const domain of commit.internalChangedDomains ?? []) {
          // Hidden-domain notifications carry no row payload. Recheck only their query facts;
          // an unrelated internal insertion must not evict already verified historical bytes.
          if (state.fork?.dependencies.affectedInternalDomain(domain)) {
            state.recheckFork = true; if (state.reading) state.revision++;
          }
          for (const id of state.evidenceByDomain.get(domain) ?? []) {
            if (state.evidence.get(id)?.dependencies.affectedInternalDomain(domain)) {
              state.recheckRequests.add(id); if (state.reading) state.revision++;
            }
          }
          for (const pending of state.pending) if (pending.affectedInternalDomain(domain)) {
            state.revision++; state.result = undefined; break;
          }
        }
      }
      this.trim();
    });
  }

  private applyChanges(conversationId: string, state: ConversationEvidence, changes: RuntimeChange[]): void {
    let changed = !state.ready && changes.some(change =>
      ['Turn', 'ModelRequest', 'ToolCallSourceLink', 'ToolCallEvent', 'ContentObject'].includes(change.domain));
    for (const change of changes) {
      const row = change.record;
      if (change.domain === 'Conversation' && change.kind === 'remove' && change.id === conversationId) {
        this.conversations.delete(conversationId); state.revision++; return;
      }
      if (change.domain !== 'Turn') continue;
      if (row?.conversation_id === conversationId && row.status === 'active') state.activeTurns.add(change.id);
      else state.activeTurns.delete(change.id);
      const known = state.turns.has(change.id);
      if (known && (change.kind === 'remove' || row?.conversation_id !== conversationId)) {
        state.turns.delete(change.id); state.pendingTurns.delete(change.id);
        for (const [id, request] of state.requests) if (request.turn_id === change.id) {
          removeEvidence(state, id); state.requests.delete(id); state.pendingRequests.delete(id);
        }
        changed = true;
      } else if (!known && row?.conversation_id === conversationId) {
        state.turns.add(change.id); state.pendingTurns.add(change.id); changed = true;
      }
    }
    for (const change of changes) {
      const row = change.record;
      // A cold atomic frontier may be consumed over many CAS awaits. A native append to a
      // not-yet-visited request has no installed Dependencies yet, but must still invalidate
      // that snapshot. The retry preserves finished proofs and reads only pending scopes live.
      if (state.reading && state.frontier && unresolvedFrontierChange(state, change)) changed = true;
      if (change.domain === 'ModelRequest') {
        const existing = state.requests.get(change.id);
        if (change.kind === 'remove' || row && !state.turns.has(String(row.turn_id))) {
          if (existing) { removeEvidence(state, change.id); state.requests.delete(change.id); state.pendingRequests.delete(change.id); changed = true; }
        } else if (row && state.turns.has(String(row.turn_id))
          && (!existing || existing.recipe_object_id !== row.recipe_object_id || existing.turn_id !== row.turn_id)) {
          state.requests.set(change.id, requestIdentity(row)); removeEvidence(state, change.id); state.pendingRequests.add(change.id); changed = true;
        }
      }
      if (state.fork?.dependencies.affected(change)) { state.fork = undefined; changed = true; }
      for (const id of state.invalidation.affected(change)) {
        if (state.evidence.get(id)?.dependencies.affected(change)) { removeEvidence(state, id); changed = true; }
      }
      for (const pending of state.pending) if (pending.affected(change)) changed = true;
    }
    if (changed) { state.revision++; state.result = undefined; state.needsSizing = true; }
  }

  public read(store: ContentAddressedStore, conversationId: string, readers: Readers): Promise<ContextHandleState> {
    const next = this.queue.then(() => this.readSerial(store, conversationId, readers));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async readSerial(store: ContentAddressedStore, conversationId: string, readers: Readers): Promise<ContextHandleState> {
    if (this.store !== store) { this.conversations.clear(); this.store = store; this.externalVersion = undefined; }
    for (let attempt = 0; attempt < 3; attempt++) {
      readers.beginRead();
      // This ordinary database request also revalidates the fenced root, even for a cache hit.
      const version = await this.database.externalDataVersion();
      if (version !== this.externalVersion) {
        for (const cached of this.conversations.values()) cached.externalDirty = true;
        this.externalVersion = version;
      }
      let state = this.conversations.get(conversationId);
      if (!state) {
        state = { turns: new Set(), activeTurns: new Set(), pendingTurns: new Set(), pendingRequests: new Set(), toolRequests: new Map(), invalidation: new DependencyIndex(), coveredRecipeIds: new Set(), needsSizing: true, recheckRequests: new Set(), recheckFork: false, facts: new ContextHandleEvidenceFacts(), externalDirty: true, requests: new Map(), evidence: new Map(), evidenceByDomain: new Map(), pending: new Set(), revision: 0, ready: false, reading: false, bytes: 0 };
        this.conversations.set(conversationId, state);
      }
      this.conversations.delete(conversationId); this.conversations.set(conversationId, state);
      state.reading = true;
      let revision = state.revision;
      const invalidated = (): boolean => state.revision !== revision || this.conversations.get(conversationId) !== state;
      const assertCurrent = (): void => {
        if (invalidated()) throw new Error('Context handle evidence was invalidated during the read.');
      };
      let checkingFinalFence = false;
      let freshFrontier: ContextHandleEvidenceFrontier | undefined;
      try {
        if ((!state.ready || state.externalDirty) && typeof this.database.contextHandleEvidenceFrontier === 'function') {
          const frontier = (await this.database.contextHandleEvidenceFrontier(conversationId)).snapshot;
          assertCurrent();
          if (state.ready) {
            // A data_version change says another connection committed somewhere, not that this
            // conversation's already validated immutable recipe bodies changed.
            const changes = compareFrontiers(state.frontier!, frontier);
            this.applyChanges(conversationId, state, changes);
            revision = state.revision;
            for (const [id, evidence] of state.evidence) {
              if (!evidence.frontierCovered && !(await evidence.dependencies.stillCurrent(this.database))) {
                removeEvidence(state, id); state.result = undefined;
              }
              assertCurrent();
            }
            if (state.fork && !(await state.fork.dependencies.stillCurrent(this.database))) { state.fork = undefined; state.result = undefined; }
            assertCurrent();
          }
          state.frontier = indexFrontier(frontier); freshFrontier = frontier;
          state.toolRequests = new Map(frontier.sources.map(source => [String(source.tool_call_id), String(source.model_request_id)]));
          state.turns = new Set(frontier.turns.map(turn => String(turn.id)));
          state.activeTurns = new Set(frontier.turns.filter(turn => turn.status === 'active').map(turn => String(turn.id)));
          const requests = new Map(frontier.requests.map(request => [String(request.id), requestIdentity(request)]));
          for (const id of state.requests.keys()) if (!requests.has(id)) removeEvidence(state, id);
          state.requests = requests;
          for (const id of requests.keys()) if (!state.evidence.has(id)) state.pendingRequests.add(id);
          state.pendingTurns.clear(); state.ready = true; state.externalDirty = false;
          // applyChanges above is our own coherent refresh, not a concurrent invalidation.
          revision = state.revision;
        } else if (!state.ready || state.externalDirty) {
          // Repository-only readers (including lightweight tests) have no atomic scoped query.
          // Keep their complete, conservative discovery path rather than claiming a false fence.
          const turns = await listAllDomainRows(this.database, 'Turn', { conversation_id: conversationId });
          assertCurrent();
          state.turns = new Set(turns.map(turn => String(turn.id)));
          state.activeTurns = new Set(turns.filter(turn => turn.status === 'active').map(turn => String(turn.id)));
          const requests = new Map<string, DomainRow>();
          for (const turn of turns) {
            for (const request of await listAllDomainRows(this.database, 'ModelRequest', { turn_id: turn.id })) {
              requests.set(String(request.id), requestIdentity(request));
            }
            assertCurrent();
          }
          if (state.externalDirty) {
            for (const id of [...state.evidence.keys()]) removeEvidence(state, id);
            state.fork = undefined; state.result = undefined;
          }
          state.requests = requests;
          state.pendingRequests = new Set(requests.keys());
          state.pendingTurns.clear(); state.ready = true; state.externalDirty = false;
        }
        for (const turnId of state.pendingTurns) {
          const requests = await listAllDomainRows(this.database, 'ModelRequest', { turn_id: turnId });
          assertCurrent();
          for (const request of requests) {
            const id = String(request.id); state.requests.set(id, requestIdentity(request));
            if (!state.evidence.has(id)) state.pendingRequests.add(id);
          }
          state.pendingTurns.delete(turnId);
        }
        for (const id of state.recheckRequests) {
          const evidence = state.evidence.get(id);
          if (evidence && !(await evidence.dependencies.stillCurrent(this.database))) { removeEvidence(state, id); state.result = undefined; }
          assertCurrent(); state.recheckRequests.delete(id);
        }
        if (state.recheckFork) {
          if (state.fork && !(await state.fork.dependencies.stillCurrent(this.database))) { state.fork = undefined; state.result = undefined; }
          assertCurrent(); state.recheckFork = false;
        }
        // Commits may clear or replace any shared slot while a reader is suspended. Reconcile
        // only this attempt's coherent references, and publish its result after both fences.
        let result = state.result;
        const recomputing = !result;
        if (!result) {
          let fork = state.fork;
          if (!fork) {
            const previousCoverage = state.coverage;
            fork = await this.capture(state, readers.fork, this.database, true);
            assertCurrent();
            fork.dependencies.frontierFacts.clear();
            state.fork = fork; state.pending.delete(fork.dependencies);
            const coverage = JSON.stringify([...(fork.value?.coveredRecipeObjectIds ?? [])].sort());
            state.coverage = coverage;
            state.coveredRecipeIds = new Set(fork.value?.coveredRecipeObjectIds ?? []);
            if (previousCoverage !== undefined && previousCoverage !== coverage) {
              for (const id of [...state.evidence.keys()]) removeEvidence(state, id);
            }
          }
          const covered = state.coveredRecipeIds;
          const requestDatabase = frontierReader(this.database, freshFrontier);
          for (const id of state.pendingRequests) {
            const request = state.requests.get(id);
            if (!request) { state.pendingRequests.delete(id); continue; }
            if (state.evidence.has(id)) { state.pendingRequests.delete(id); continue; }
            const captured = await this.capture(state, db => readers.request(db, request, covered.has(String(request.recipe_object_id))),
              requestDatabase);
            assertCurrent();
            const evidence = { value: state.facts.add(captured.value.catalogs, captured.value.currentOrdinaryCatalog),
              dependencies: captured.dependencies, frontierCovered: captured.value.frontierCovered === true };
            rememberCapturedFrontier(state, request, captured.dependencies.frontierFacts);
            captured.dependencies.frontierFacts.clear();
            if (evidence.frontierCovered) evidence.dependencies.discardRechecks();
            state.evidence.set(id, evidence);
            state.invalidation.add(id, evidence.dependencies);
            state.pending.delete(evidence.dependencies);
            state.pendingRequests.delete(id);
            for (const domain of evidence.dependencies.domains()) {
              let ids = state.evidenceByDomain.get(domain);
              if (!ids) state.evidenceByDomain.set(domain, ids = new Set());
              ids.add(id);
            }
          }
          assertCurrent();
          result = readers.reconcile(fork.value, { catalogs: state.facts.allCatalogs(),
            hasCurrentOrdinaryCatalog: catalog => state!.facts.hasCurrentOrdinaryCatalog(catalog) });
          assertCurrent();
        }
        checkingFinalFence = true;
        const afterVersion = await this.database.externalDataVersion();
        checkingFinalFence = false;
        if (afterVersion !== version || invalidated()) {
          state.result = undefined;
          if (afterVersion !== version) {
            for (const cached of this.conversations.values()) cached.externalDirty = true;
            this.externalVersion = afterVersion;
          }
          continue;
        }
        const cloned = structuredClone(result);
        state.result = result;
        if (recomputing) state.needsSizing = true;
        state.reading = false;
        this.trim(conversationId);
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
        state.result = undefined;
        if (afterVersion !== version) {
          for (const cached of this.conversations.values()) cached.externalDirty = true;
          this.externalVersion = afterVersion;
        }
        if (changed || afterVersion !== version) continue;
        throw error;
      } finally { state.pending.clear(); state.reading = false; }
    }
    throw Object.assign(new Error('Context handle evidence changed while it was being read; retry from the current frontier.'),
      { code: 'MODEL_CONTEXT_HANDLE_FRONTIER_CHANGED' });
  }

  private async capture<T>(state: ConversationEvidence, read: (database: RuntimeDatabase) => Promise<T>, database = this.database, fork = false): Promise<Evidence<T>> {
    const dependencies = new Dependencies(fork);
    state.pending.add(dependencies);
    // Retain through the promise-continuation gap, until the caller atomically transfers
    // this dependency into its installed proof/index. Otherwise a commit can be missed.
    const value = await read(dependencies.reader(database));
    dependencies.complete();
    return { value, dependencies };
  }

  private trim(protectedConversationId?: string): void {
    const limits = CONTEXT_HANDLE_EVIDENCE_CACHE_LIMITS;
    // Locally owned in-flight parent/child Conversations are working state, not idle LRU candidates. Counting
    // them against the idle budget would make concurrent agents evict one another every round.
    const idle = [...this.conversations].filter(([id, state]) => !state.reading
      && !(state.activeTurns.size > 0 && this.database.conversationOwners?.owns(id)));
    for (const [, state] of idle) if (state.needsSizing) { state.bytes = retainedSize(state); state.needsSizing = false; }
    let bytes = idle.reduce((sum, [, state]) => sum + state.bytes, 0);
    while (idle.length > limits.conversations || bytes > limits.bytes && idle.length > 1) {
      const index = idle.findIndex(([id]) => id !== protectedConversationId);
      if (index < 0) break;
      const [oldest, entry] = idle.splice(index, 1)[0];
      bytes -= entry.bytes; this.conversations.delete(oldest);
    }
  }
}

function requestIdentity(row: DomainRow): DomainRow {
  return { id: row.id, turn_id: row.turn_id, recipe_object_id: row.recipe_object_id };
}

/** Query membership is part of the proof: both changes to known rows and new matching rows
 * invalidate it. Only identity selectors, never source bodies, are retained. */
class Dependencies {
  public constructor(private readonly fork: boolean = false) {}
  private readonly ids = new Map<string, Set<string>>();
  private readonly lists: Array<{ domain: string; where: DomainRow }> = [];
  private readonly materializing = new Set<string>();
  private readonly turns = new Map<string, string>();
  private readonly forkIdentities = new Map<string, Map<string, string>>();
  public readonly frontierFacts = new Map<string, DomainRow[]>();
  private finished = false;
  private readonly rechecks: Array<{ read: RepositoryRead; all: boolean; identity: string }> = [];

  public complete(): void { this.finished = true; }
  public discardRechecks(): void { this.rechecks.length = 0; }
  public async stillCurrent(database: RuntimeDatabase): Promise<boolean> {
    // Compare repository facts, never recipe/CAS bytes. Normal ordinary evidence uses the
    // joined frontier instead; only legacy compression and fork dependencies need this path.
    const bounded = this.rechecks.filter(check => !check.all);
    for (let offset = 0; offset < bounded.length; offset += 256) {
      const batch = bounded.slice(offset, offset + 256);
      const result = await database.snapshot(batch.map(check => check.read));
      if (batch.some((check, index) => this.identity(check.read.domain, result.snapshot[index]) !== check.identity)) return false;
    }
    for (const check of this.rechecks) if (check.all) {
      if (check.read.kind !== 'list') return false;
      const result = await database.snapshotAll(check.read);
      if (this.identity(check.read.domain, result.snapshot) !== check.identity) return false;
    }
    return true;
  }


  public affected(change: RuntimeChange): boolean {
    if (this.fork && change.record && this.forkIdentities.get(change.domain)?.get(change.id)
      === this.identity(change.domain, change.record)) return false;
    if (change.domain === 'Turn' && change.record && this.turns.get(change.id) === this.identity('Turn', change.record)) return false;
    if (this.materializing.has(change.domain) || this.ids.get(change.domain)?.has(change.id)) return true;
    return this.lists.some(read => read.domain === change.domain && (change.kind === 'remove' && !this.finished
      || change.kind !== 'remove' && (!change.record || Object.entries(read.where).every(([key, value]) => String(change.record![key]) === String(value)))));
  }

  public affectedInternalDomain(domain: string): boolean {
    if (this.materializing.has(domain) || this.lists.some(read => read.domain === domain)) return true;
    // Insert-only internal identities cannot modify an already captured row. Cascading removal
    // is accompanied by its captured visible ancestor; external writes take the separate fence.
    const mutations = DOMAIN_REPOSITORIES.domain(domain).schema.mutations;
    return this.ids.has(domain) && mutations.some(kind => kind !== 'insert');
  }

  /** These selectors belong only to readForkContextHandleReservationEvidence. The source
   * Turn's terminal state remains significant in a legacy compression proof and is not ignored. */
  private identity(domain: string, value: unknown): string {
    if (!this.fork || !['Turn', 'ChildExecution', 'ToolCall', 'ConversationContextHeadLink'].includes(domain)) {
      return rowIdentity(domain, value);
    }
    const select = (row: unknown): unknown => {
      if (Array.isArray(row)) return row.map(select);
      if (!row || typeof row !== 'object') return row;
      const record = row as DomainRow;
      if (domain === 'Turn') return [record.id, record.conversation_id];
      if (domain === 'ChildExecution') return [record.id, record.child_conversation_id];
      if (domain === 'ToolCall') return [record.id, record.turn_id];
      // The private reservation artifact must remain outside the live model-visible head.
      // Moving that head between other roots/clocks does not change the proved catalog.
      return [record.conversation_id, this.ids.get('ContextSequenceRoot')?.has(String(record.root_id)) === true];
    };
    return JSON.stringify(select(value));
  }

  private forkIdentity(domain: string, row: DomainRow): void {
    if (!this.fork || !['Turn', 'ChildExecution', 'ToolCall'].includes(domain)) return;
    let rows = this.forkIdentities.get(domain);
    if (!rows) this.forkIdentities.set(domain, rows = new Map());
    rows.set(String(row.id), this.identity(domain, row));
  }

  private observe(read: RepositoryRead): void {
    if (read.kind === 'get') this.id(read.domain, read.id);
    else if (read.kind === 'conversationMessagePrefix') {
      // Conservatively invalidate for any membership change in this Conversation, even beyond
      // the selected cutoff. The prefix rows themselves are never a separate cached result.
      this.lists.push({ domain: read.domain, where: { conversation_id: read.conversationId } });
    } else if (read.kind === 'list' && read.collaborationProjectScope !== undefined) {
      for (const domain of ['Conversation', 'ChildExecution', 'ConversationProjectLink']) this.materializing.add(domain);
    } else if (read.kind === 'list' && read.collaborationRootConversationId === undefined) {
      this.lists.push({ domain: read.domain, where: { ...read.where } });
    } else {
      // Rooted collaboration reads depend on ancestry as well as their result domain.
      for (const domain of ['Conversation', 'Turn', 'ChildExecution', 'ChildExecutionParentLink']) this.materializing.add(domain);
    }
  }
  private frontierFact(domain: string, row: DomainRow): void {
    if (!['ContentObject', 'ToolCallSourceLink', 'ToolCallEvent'].includes(domain)) return;
    if (domain === 'ToolCallEvent' && row.event_kind !== 'native_child_handle_projection') return;
    const rows = this.frontierFacts.get(domain) ?? [];
    rows.push(row); this.frontierFacts.set(domain, rows);
  }
  private id(domain: string, id: unknown): void {
    let ids = this.ids.get(domain); if (!ids) this.ids.set(domain, ids = new Set()); ids.add(String(id));
  }
  public indexEntries(): {
    ids: ReadonlyMap<string, ReadonlySet<string>>;
    lists: ReadonlyArray<{ domain: string; where: DomainRow }>;
    broad: ReadonlySet<string>;
  } { return { ids: this.ids, lists: this.lists, broad: this.materializing }; }
  public domains(): Set<string> { return new Set([...this.ids.keys(), ...this.lists.map(read => read.domain), ...this.materializing]); }
  public size(): number {
    return JSON.stringify([...this.ids].map(([domain, ids]) => [domain, [...ids]])).length * 2
      + JSON.stringify(this.lists, (_, value) => typeof value === 'bigint' ? String(value) : value).length * 2 + JSON.stringify([...this.turns]).length * 2
      + this.rechecks.reduce((bytes, check) => bytes + check.identity.length * 2 + 128, 0);
  }
  public reader(database: RuntimeDatabase): RuntimeDatabase {
    return new Proxy(database, { get: (target, property) => {
      if (property === 'snapshot') return async (reads: RepositoryRead[]) => {
        reads.forEach(read => this.observe(read));
        const result = await target.snapshot(reads);
        result.snapshot.forEach((value, index) => {
          this.rechecks.push({ read: reads[index], all: false, identity: this.identity(reads[index].domain, value) });
          if (value) for (const row of Array.isArray(value) ? value : [value]) {
            this.id(reads[index].domain, row.id);
            this.frontierFact(reads[index].domain, row);
            this.forkIdentity(reads[index].domain, row);
            if (reads[index].domain === 'Turn') this.turns.set(String(row.id), this.identity('Turn', row));
          }
        });
        return result;
      };
      if (property === 'snapshotAll') return async (read: Parameters<RuntimeDatabase['snapshotAll']>[0]) => {
        this.observe(read);
        const result = await target.snapshotAll(read);
        this.rechecks.push({ read, all: true, identity: this.identity(read.domain, result.snapshot) });
        for (const row of result.snapshot) { this.id(read.domain, row.id); this.frontierFact(read.domain, row); this.forkIdentity(read.domain, row); }
        return result;
      };
      if (property === 'materializeContext') return async (rootId: string) => {
        const domains = ['ContextSequenceRoot', 'ContextSequenceNode', 'ContextSegment', 'ContentObject'];
        this.id('ContextSequenceRoot', rootId); domains.forEach(domain => this.materializing.add(domain));
        try {
          const result = await target.materializeContext(rootId);
          const root = result.snapshot.root;
          this.rechecks.push({ read: DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').get(rootId), all: false,
            identity: this.identity('ContextSequenceRoot', root) });
          for (const record of result.snapshot.records) {
            this.id('ContextSequenceNode', record.node.id); this.id('ContextSegment', record.segment.id);
            this.id('ContentObject', record.contentObject.id);
            for (const [domain, row] of [['ContextSequenceNode', record.node], ['ContextSegment', record.segment],
              ['ContentObject', record.contentObject]] as const) this.rechecks.push({
              read: DOMAIN_REPOSITORIES.domain(domain).get(String(row.id)), all: false, identity: this.identity(domain, row)
            });
          }
          return result;
        } finally { domains.forEach(domain => this.materializing.delete(domain)); }
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
}

/** Route a local commit directly to matching captured identities/query selectors. A newly
 * inserted CAS object must not visit every historical request just to discover it is unrelated. */
class DependencyIndex {
  private readonly ids = new Map<string, Map<string, Set<string>>>();
  private readonly lists = new Map<string, Map<string, { columns: string[]; values: Map<string, Set<string>> }>>();
  private readonly broad = new Map<string, Set<string>>();

  public add(owner: string, dependencies: Dependencies): void { this.change(owner, dependencies, true); }
  public remove(owner: string, dependencies: Dependencies): void { this.change(owner, dependencies, false); }

  private change(owner: string, dependencies: Dependencies, add: boolean): void {
    const entries = dependencies.indexEntries();
    const update = (map: Map<string, Set<string>>, key: string): void => {
      let owners = map.get(key);
      if (add) { if (!owners) map.set(key, owners = new Set()); owners.add(owner); }
      else if (owners) { owners.delete(owner); if (!owners.size) map.delete(key); }
    };
    for (const [domain, ids] of entries.ids) {
      let index = this.ids.get(domain);
      if (!index) { if (!add) continue; this.ids.set(domain, index = new Map()); }
      for (const id of ids) update(index, id);
      if (!index.size) this.ids.delete(domain);
    }
    for (const read of entries.lists) {
      const columns = Object.keys(read.where).sort();
      const shape = JSON.stringify(columns);
      let domain = this.lists.get(read.domain);
      if (!domain) { if (!add) continue; this.lists.set(read.domain, domain = new Map()); }
      let index = domain.get(shape);
      if (!index) { if (!add) continue; domain.set(shape, index = { columns, values: new Map() }); }
      update(index.values, JSON.stringify(columns.map(column => String(read.where[column]))));
      if (!index.values.size) domain.delete(shape);
      if (!domain.size) this.lists.delete(read.domain);
    }
    for (const domain of entries.broad) update(this.broad, domain);
  }

  public size(): number {
    let bytes = 0;
    for (const ids of this.ids.values()) for (const [id, owners] of ids) bytes += 128 + id.length * 2 + owners.size * 32;
    for (const shapes of this.lists.values()) for (const shape of shapes.values()) {
      for (const [key, owners] of shape.values) bytes += 128 + key.length * 2 + owners.size * 32;
    }
    for (const owners of this.broad.values()) bytes += owners.size * 32 + 64;
    return bytes;
  }

  public affected(change: RuntimeChange): Set<string> {
    const owners = new Set(this.ids.get(change.domain)?.get(change.id));
    for (const owner of this.broad.get(change.domain) ?? []) owners.add(owner);
    if (change.kind === 'remove') return owners;
    for (const index of this.lists.get(change.domain)?.values() ?? []) {
      if (!change.record) {
        for (const values of index.values.values()) for (const owner of values) owners.add(owner);
      } else {
        const key = JSON.stringify(index.columns.map(column => String(change.record![column])));
        for (const owner of index.values.get(key) ?? []) owners.add(owner);
      }
    }
    return owners;
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
  size += state.facts.size() + state.invalidation.size() + bytes(state.coverage);
  if (state.frontier) for (const rows of state.frontier.values()) size += bytes([...rows.values()]);
  if (state.fork) size += bytes(state.fork.value) + state.fork.dependencies.size();
  for (const entry of state.evidence.values()) size += entry.value.catalogs.length * 8 + 64 + entry.dependencies.size() + 128;
  for (const ids of state.evidenceByDomain.values()) size += bytes([...ids]);
  return size;
}

function removeEvidence(state: ConversationEvidence, id: string): void {
  const previous = state.evidence.get(id);
  if (!previous) return;
  for (const domain of previous.dependencies.domains()) {
    const ids = state.evidenceByDomain.get(domain);
    ids?.delete(id);
    if (ids?.size === 0) state.evidenceByDomain.delete(domain);
  }
  state.invalidation.remove(id, previous.dependencies);
  state.facts.remove(previous.value);
  state.needsSizing = true;
  state.evidence.delete(id);
  state.recheckRequests.delete(id);
  if (state.requests.has(id)) state.pendingRequests.add(id);
}

const FRONTIER_DOMAINS = [
  ['Turn', 'turns'], ['ModelRequest', 'requests'], ['ToolCallSourceLink', 'sources'],
  ['ToolCallEvent', 'events'], ['ContentObject', 'contentObjects']
] as const;

const FRONTIER_COLUMNS: Record<string, readonly string[]> = {
  Turn: ['id', 'conversation_id', 'status'],
  ModelRequest: ['id', 'turn_id', 'recipe_object_id', 'status', 'terminal_state'],
  ToolCallSourceLink: ['id', 'model_request_id', 'tool_call_id'],
  ToolCallEvent: ['id', 'tool_call_id', 'event_seq', 'event_kind', 'content_object_id'],
  ContentObject: ['id', 'content_type', 'sha256', 'byte_length', 'storage_key', 'created_at']
};

function projectFrontierRow(domain: string, row: DomainRow): DomainRow {
  return Object.fromEntries(FRONTIER_COLUMNS[domain].map(column => [column, row[column]]));
}

function indexFrontier(frontier: ContextHandleEvidenceFrontier): Map<string, Map<string, DomainRow>> {
  return new Map(FRONTIER_DOMAINS.map(([domain, field]) => [domain,
    new Map(frontier[field].map(row => [String(row.id), row]))]));
}

function unresolvedFrontierChange(state: ConversationEvidence, change: RuntimeChange): boolean {
  const frontier = state.frontier!;
  const row = change.record ?? frontier.get(change.domain)?.get(change.id);
  if (change.domain === 'ContentObject') return frontier.get('ContentObject')!.has(change.id);
  if (change.domain === 'ToolCallSourceLink') return Boolean(row && state.pendingRequests.has(String(row.model_request_id)));
  if (change.domain !== 'ToolCallEvent' || row?.event_kind !== 'native_child_handle_projection') return false;
  const owner = state.toolRequests.get(String(row.tool_call_id));
  return owner !== undefined && state.pendingRequests.has(owner);
}

function rememberCapturedFrontier(state: ConversationEvidence, request: DomainRow, facts: Map<string, DomainRow[]>): void {
  if (!state.frontier) return;
  const sources = (facts.get('ToolCallSourceLink') ?? []).filter(source => source.model_request_id === request.id);
  const tools = new Set(sources.map(source => source.tool_call_id));
  const events = (facts.get('ToolCallEvent') ?? []).filter(event => tools.has(event.tool_call_id));
  const objectIds = new Set([request.recipe_object_id, ...events.map(event => event.content_object_id)]);
  // Legacy compression reads other source objects too. They are generic dependencies, not
  // members of this recipe/native frontier, and must not look deleted on its next refresh.
  for (const [domain, rows] of [
    ['ToolCallSourceLink', sources], ['ToolCallEvent', events],
    ['ContentObject', (facts.get('ContentObject') ?? []).filter(row => objectIds.has(row.id))]
  ] as const) {
    for (const row of rows) {
      state.frontier.get(domain)!.set(String(row.id), projectFrontierRow(domain, row));
      if (domain === 'ToolCallSourceLink') state.toolRequests.set(String(row.tool_call_id), String(row.model_request_id));
    }
  }
}

function updateFrontierFromCommit(state: ConversationEvidence, conversationId: string, changes: RuntimeChange[]): void {
  if (!state.frontier) return;
  for (const change of changes) {
    const rows = state.frontier.get(change.domain);
    if (!rows) continue;
    const row = change.record;
    if (change.kind === 'remove') {
      if (change.domain === 'ToolCallSourceLink' && rows.has(change.id)) state.toolRequests.delete(String(rows.get(change.id)!.tool_call_id));
      rows.delete(change.id); continue;
    }
    if (!row) continue;
    const belongs = change.domain === 'Turn' ? row.conversation_id === conversationId
      : change.domain === 'ModelRequest' ? state.requests.has(change.id)
        : change.domain === 'ToolCallSourceLink' ? state.requests.has(String(row.model_request_id))
          : change.domain === 'ToolCallEvent' ? row.event_kind === 'native_child_handle_projection'
            && state.requests.has(state.toolRequests.get(String(row.tool_call_id)) ?? '')
            : rows.has(change.id);
    if (belongs) {
      rows.set(change.id, projectFrontierRow(change.domain, row));
      if (change.domain === 'ToolCallSourceLink') state.toolRequests.set(String(row.tool_call_id), String(row.model_request_id));
    }
    else rows.delete(change.id);
  }
}

function compareFrontiers(before: Map<string, Map<string, DomainRow>>, after: ContextHandleEvidenceFrontier): RuntimeChange[] {
  const changes: RuntimeChange[] = [];
  for (const [domain, field] of FRONTIER_DOMAINS) {
    const previous = new Map(before.get(domain));
    for (const row of after[field]) {
      const id = String(row.id);
      const prior = previous.get(id);
      if (!prior || rowIdentity(domain, prior) !== rowIdentity(domain, row)) changes.push({ domain, id, kind: 'upsert', record: row });
      previous.delete(id);
    }
    for (const id of previous.keys()) changes.push({ domain, id, kind: 'remove' });
  }
  return changes;
}

/** Exact database-fact equality; bigint encoding is unambiguous within a fixed repository schema. */
function rowIdentity(domain: string, value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (typeof input === 'bigint') return String(input);
    if (Array.isArray(input)) return input.map(normalize);
    if (!input || typeof input !== 'object') return input;
    if (domain === 'Turn') {
      const row = input as DomainRow;
      return [row.id, row.conversation_id, row.status];
    }
    if (domain === 'ToolCallSourceLink' || domain === 'ToolCallEvent') {
      const row = input as DomainRow;
      return FRONTIER_COLUMNS[domain].map(column => typeof row[column] === 'bigint' ? String(row[column]) : row[column]);
    }
    return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, normalize(child)]));
  };
  return JSON.stringify(normalize(value));
}

/** Reuse the atomic cold/frontier snapshot for its exact recipe/native selectors. This eliminates
 * a metadata RPC and source/event list RPCs per historical request. Other reads remain live. */
function frontierReader(database: RuntimeDatabase, frontier?: ContextHandleEvidenceFrontier): RuntimeDatabase {
  if (!frontier) return database;
  const requests = new Set(frontier.requests.map(request => String(request.id)));
  const objects = new Map(frontier.contentObjects.map(row => [String(row.id), row]));
  const sources = new Map<string, DomainRow[]>();
  const events = new Map<string, DomainRow[]>();
  for (const row of frontier.sources) {
    const id = String(row.model_request_id);
    const group = sources.get(id) ?? []; group.push(row); sources.set(id, group);
    if (!events.has(String(row.tool_call_id))) events.set(String(row.tool_call_id), []);
  }
  for (const row of frontier.events) events.get(String(row.tool_call_id))?.push(row);
  const local = (read: RepositoryRead, all: boolean): DomainRow | DomainRow[] | null | undefined => {
    if (read.kind === 'get' && read.domain === 'ContentObject') return objects.get(read.id);
    if (read.kind !== 'list' || read.afterId || read.keyset || read.collaborationConversationId
      || read.collaborationBacklog || read.collaborationRootConversationId || read.collaborationProjectScope
      || read.orderBy && (read.orderBy.column !== 'id' || read.orderBy.direction !== 'asc')) return undefined;
    const where = read.where ?? {};
    let rows: DomainRow[] | undefined;
    if (read.domain === 'ToolCallSourceLink' && Object.keys(where).length === 1
      && requests.has(String(where.model_request_id))) rows = sources.get(String(where.model_request_id)) ?? [];
    if (read.domain === 'ToolCallEvent' && Object.keys(where).length === 2
      && where.event_kind === 'native_child_handle_projection') rows = events.get(String(where.tool_call_id));
    if (!rows) return undefined;
    return all ? rows : rows.slice(0, read.limit);
  };
  return new Proxy(database, { get: (target, property) => {
    if (property === 'snapshot') return async (reads: RepositoryRead[]) => {
      const snapshot = reads.map(read => local(read, false));
      const missing = reads.flatMap((read, index) => snapshot[index] === undefined ? [{ read, index }] : []);
      let snapshotCommitSeq = '0';
      if (missing.length) {
        const live = await target.snapshot(missing.map(item => item.read));
        snapshotCommitSeq = live.snapshotCommitSeq;
        missing.forEach((item, index) => { snapshot[item.index] = live.snapshot[index]; });
      }
      return { snapshotCommitSeq, snapshot: snapshot as Array<DomainRow | DomainRow[] | null> };
    };
    if (property === 'snapshotAll') return async (read: Parameters<RuntimeDatabase['snapshotAll']>[0]) => {
      const snapshot = local(read, true);
      return Array.isArray(snapshot) ? { snapshotCommitSeq: '0', snapshot } : target.snapshotAll(read);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
