import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import type { RuntimeCommitResult } from './contracts';
import { modelRequestIdFor } from './modelProviderControlPlane';
import { normalizePlainJson } from './plainJson';
import { DOMAIN_REPOSITORIES, type RepositoryKeysetCursor } from './repositories';
import { sameBindingIdentity } from './rootAuthority';
import type { RuntimeDatabase } from './runtimeDatabase';

export interface AgentLoopResumeState {
  requestSequence: bigint;
  openTaskCompletionCheckConsumed: boolean;
}

// This is working evidence, not a cache of recipes. An active Turn's prefix is never evicted
// because it grew past a request/byte count: doing so would replay all bodies every tool round.
// Completed/deleted Turns and released conversation owners drop their entire frontier instead.
const caches = new WeakMap<RuntimeDatabase, ResumeCache>();
const PAGE_SIZE = 64;
const RECIPE_BATCH_BYTES = 1024 * 1024;

interface RecipeEvidence { ordinaryRound?: bigint; completionCheck: boolean }
interface Entry extends RecipeEvidence {
  requestId: string;
  sequence: bigint;
  metadata: ContentObjectMetadata;
  normalRound: bigint;
  consumed: boolean;
}
interface TurnEvidence {
  entries: Entry[];
  conversationId?: string;
  externalVersion?: string;
  revision: number;
  dirty: boolean;
  full: boolean;
}
interface ScanResult {
  keep: number;
  suffix: Entry[];
  conversationId?: string;
  active: boolean;
}

export async function readAgentLoopResumeState(database: RuntimeDatabase, store: ContentAddressedStore,
  turnId: string): Promise<AgentLoopResumeState> {
  // Maintenance has no commit stream. Repository-only readers must not claim a warm proof.
  if (database.maintenance || typeof database.onCommit !== 'function'
    || typeof database.onClose !== 'function' || typeof database.externalDataVersion !== 'function') {
    const state = emptyState();
    const result = await scan(database, store, turnId, state, true);
    return resumeState(result.suffix[result.suffix.length - 1]);
  }
  let cache = caches.get(database);
  if (!cache) { cache = new ResumeCache(database); caches.set(database, cache); }
  return cache.read(store, turnId);
}

class ResumeCache {
  private readonly turns = new Map<string, TurnEvidence>();
  private readonly contentUsers = new Map<string, Map<TurnEvidence, number>>();
  private store?: ContentAddressedStore;
  private generation = 0;
  // Coalesce the same Turn only: a cold Turn must not hold up another Turn's warm resume.
  // Each reader stages its own suffix; commits invalidate rather than mutate that live prefix.
  private readonly flights = new Map<string, Promise<AgentLoopResumeState>>();

  public constructor(private readonly database: RuntimeDatabase) {
    database.onCommit(commit => this.applyCommit(commit));
    database.onClose(() => { this.clear(); caches.delete(database); });
  }

  public read(store: ContentAddressedStore, turnId: string): Promise<AgentLoopResumeState> {
    if (this.store !== store) { this.clear(); this.store = store; }
    const existing = this.flights.get(turnId);
    if (existing) return existing;
    const next = this.readCurrent(store, turnId, this.generation).finally(() => {
      // A store switch can start a replacement flight before this old one has unwound.
      if (this.flights.get(turnId) === next) this.flights.delete(turnId);
    });
    this.flights.set(turnId, next);
    return next;
  }

  private clear(): void {
    this.generation++;
    for (const state of this.turns.values()) state.revision++;
    this.turns.clear(); this.contentUsers.clear(); this.flights.clear(); this.store = undefined;
  }

  private forget(turnId: string, state: TurnEvidence): void {
    state.revision++;
    this.turns.delete(turnId);
    for (const entry of state.entries) this.removeContentUser(entry, state);
  }

  private removeContentUser(entry: Entry, state: TurnEvidence): void {
    const users = this.contentUsers.get(entry.metadata.id);
    const count = users?.get(state) ?? 0;
    if (count > 1) users!.set(state, count - 1);
    else users?.delete(state);
    if (users?.size === 0) this.contentUsers.delete(entry.metadata.id);
  }

  private applyCommit(commit: RuntimeCommitResult): void {
    for (const change of commit.changes) {
      const row = change.record;
      if (change.domain === 'Turn') {
        const state = this.turns.get(change.id);
        if (state && (change.kind === 'remove' || row?.status !== 'active'
          || state.conversationId && row?.conversation_id !== state.conversationId)) this.forget(change.id, state);
      } else if (change.domain === 'Conversation' && change.kind === 'remove') {
        for (const [id, state] of this.turns) {
          // Also cover a cold read whose Turn owner has not yet returned from the worker.
          if (!state.conversationId || state.conversationId === change.id) this.forget(id, state);
        }
      } else if (change.domain === 'ModelRequest') {
        if (change.kind === 'remove' || !row) {
          // Rare cascades may carry only the deleted request id. Recheck metadata, not bodies.
          for (const state of this.turns.values()) invalidate(state, true);
          continue;
        }
        const state = this.turns.get(String(row.turn_id));
        if (!state) continue;
        const sequence = positiveInteger(row.request_seq, 'ModelRequest.request_seq');
        const entry = sequence <= BigInt(state.entries.length) ? state.entries[Number(sequence - 1n)] : undefined;
        if (entry && entry.requestId === change.id && entry.metadata.id === row.recipe_object_id) continue;
        invalidate(state, sequence <= BigInt(state.entries.length));
      } else if (change.domain === 'ContentObject') {
        // ContentObject is insert-only. Ordinary new tool/result objects have no users here.
        for (const state of this.contentUsers.get(change.id)?.keys() ?? []) invalidate(state, true);
      }
    }
  }

  private async readCurrent(store: ContentAddressedStore, turnId: string, generation: number): Promise<AgentLoopResumeState> {
    const assertCurrentStore = (): void => {
      if (generation !== this.generation || store !== this.store) {
        throw Object.assign(new Error('Agent resume store changed during the read; retry the current Turn.'), { code: 'EAGAIN' });
      }
    };
    if (!sameBindingIdentity(this.database.binding, store.binding)) {
      this.clear(); throw new Error('Agent resume evidence requires the database and CAS to share the same root binding.');
    }
    for (const [id, state] of this.turns) {
      if (id !== turnId && state.conversationId && this.database.conversationOwners
        && !this.database.conversationOwners.owns(state.conversationId)) this.forget(id, state);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      // This ordinary worker request checks the live root fence even on a warm cache hit.
      const version = await this.database.externalDataVersion().catch(error => { this.clear(); throw error; });
      assertCurrentStore();
      let state = this.turns.get(turnId);
      if (!state) { state = emptyState(); this.turns.set(turnId, state); }
      const full = state.full || state.externalVersion !== version;
      if (!state.dirty && !full) return resumeState(state.entries[state.entries.length - 1]);
      const revision = state.revision;
      const invalidated = (): boolean => state!.revision !== revision || this.turns.get(turnId) !== state;
      let checkingFence = false;
      try {
        const result = await scan(this.database, store, turnId, state, full, assertCurrentStore);
        assertCurrentStore();
        checkingFence = true;
        const after = await this.database.externalDataVersion();
        checkingFence = false;
        assertCurrentStore();
        if (after !== version || invalidated()) continue;
        // Remove old suffix membership before installing new identities (an object may be shared).
        for (let index = result.keep; index < state.entries.length; index++) this.removeContentUser(state.entries[index], state);
        state.entries.length = result.keep;
        for (const entry of result.suffix) state.entries.push(entry);
        for (const entry of result.suffix) {
          let users = this.contentUsers.get(entry.metadata.id);
          if (!users) this.contentUsers.set(entry.metadata.id, users = new Map());
          users.set(state, (users.get(state) ?? 0) + 1);
        }
        state.conversationId = result.conversationId;
        state.externalVersion = version; state.dirty = false; state.full = false;
        const value = resumeState(state.entries[state.entries.length - 1]);
        if (!result.active) this.forget(turnId, state);
        return value;
      } catch (error) {
        assertCurrentStore();
        if (checkingFence) { this.clear(); throw error; }
        const after = await this.database.externalDataVersion().catch(fenceError => { this.clear(); throw fenceError; });
        if (after !== version || invalidated()) continue;
        // Never retain failed validation as a successful resume frontier.
        this.forget(turnId, state);
        throw error;
      }
    }
    throw Object.assign(new Error('Agent resume frontier changed while it was being read; retry the current Turn.'), { code: 'EAGAIN' });
  }
}

async function scan(database: RuntimeDatabase, store: ContentAddressedStore, turnId: string,
  state: TurnEvidence, full: boolean, assertCurrentStore: () => void = () => undefined): Promise<ScanResult> {
  const turnSnapshot = await database.snapshot([DOMAIN_REPOSITORIES.domain('Turn').get(turnId)]);
  assertCurrentStore();
  const turn = turnSnapshot.snapshot[0];
  if (Array.isArray(turn)) throw new Error('Turn resume metadata returned a list.');
  const result: ScanResult = { keep: state.entries.length, suffix: [],
    conversationId: turn ? id(turn.conversation_id, 'Turn.conversation_id') : undefined,
    active: turn?.status === 'active' };
  let index = full ? 0 : state.entries.length;
  let previous = index > 0 ? state.entries[index - 1] : undefined;
  let cursor = previous ? requestCursor(previous) : undefined;
  for (;;) {
    assertCurrentStore();
    const snapshot = await database.snapshot([DOMAIN_REPOSITORIES.domain('ModelRequest').list({
      where: { turn_id: turnId }, orderBy: { column: 'request_seq', direction: 'asc' },
      ...(cursor ? { keyset: cursor } : {}), limit: PAGE_SIZE
    })]);
    const page = snapshot.snapshot[0];
    if (!Array.isArray(page)) throw new Error('ModelRequest resume metadata returned a non-list.');
    if (page.length === 0) break;
    const objects = await database.snapshot(page.map(request => DOMAIN_REPOSITORIES.domain('ContentObject')
      .get(id(request.recipe_object_id, 'ModelRequest.recipe_object_id'))));
    assertCurrentStore();
    if (objects.snapshot.length !== page.length) throw new Error('ModelRequest recipe metadata batch returned the wrong result count.');
    const metadata = objects.snapshot.map((value, offset) => {
      if (!value || Array.isArray(value)) throw new Error(`ContentObject ${String(page[offset].recipe_object_id)} does not exist.`);
      return value as ContentObjectMetadata;
    });
    // Only new/changed immutable identities need CAS. Unrelated external writes revalidate the
    // whole small metadata frontier without parsing or normalizing historical recipe graphs.
    const decoded = new Map<number, RecipeEvidence>();
    let batch: number[] = [];
    let batchBytes = 0n;
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      assertCurrentStore();
      await decodeBatch(store, metadata, batch, decoded, assertCurrentStore);
      batch = []; batchBytes = 0n;
      await yieldTurn();
    };
    for (let offset = 0; offset < page.length; offset++) {
      const request = page[offset];
      const sequence = positiveInteger(request.request_seq, 'ModelRequest.request_seq');
      if (sequence !== BigInt(index + offset) + 1n) throw sequenceError(turnId, BigInt(index + offset) + 1n);
      const old = state.entries[index + offset];
      if (old && old.requestId === request.id && sameMetadata(old.metadata, metadata[offset])) continue;
      const bytes = metadata[offset].byte_length;
      if (batch.length && batchBytes + bytes > BigInt(RECIPE_BATCH_BYTES)) await flush();
      batch.push(offset); batchBytes += bytes;
      // An individually larger valid recipe remains readable, alone; no new content limit.
      if (batchBytes >= BigInt(RECIPE_BATCH_BYTES)) await flush();
    }
    await flush();
    for (let offset = 0; offset < page.length; offset++, index++) {
      const requestId = id(page[offset].id, 'ModelRequest.id');
      const old = state.entries[index];
      const evidence = decoded.get(offset) ?? old;
      if (!evidence) throw new Error(`ModelRequest ${requestId} recipe batch lost its request.`);
      if (!decoded.has(offset) && index < result.keep) {
        previous = old;
        continue;
      }
      let normalRound = previous?.normalRound ?? 0n;
      let consumed = previous?.consumed ?? false;
      if (evidence.ordinaryRound !== undefined) {
        normalRound++;
        if (evidence.ordinaryRound !== normalRound) {
          throw new Error(`Turn ${turnId} ordinary ModelRequest round is not contiguous at ${normalRound.toString()}.`);
        }
        if (requestId !== modelRequestIdFor(turnId, `agent-loop:${turnId}:round:${normalRound.toString()}`)) {
          throw new Error(`Turn ${turnId} ordinary ModelRequest ${normalRound.toString()} has an invalid identity.`);
        }
        consumed ||= evidence.completionCheck;
      }
      result.keep = Math.min(result.keep, index);
      previous = { requestId, sequence: BigInt(index) + 1n, metadata: metadata[offset],
        ordinaryRound: evidence.ordinaryRound, completionCheck: evidence.completionCheck, normalRound, consumed };
      result.suffix.push(previous);
    }
    cursor = requestCursor(previous!);
    await yieldTurn();
    if (page.length < PAGE_SIZE) break;
  }
  result.keep = Math.min(result.keep, index);
  return result;
}

async function decodeBatch(store: ContentAddressedStore, metadata: ContentObjectMetadata[],
  batch: number[], output: Map<number, RecipeEvidence>, assertCurrentStore: () => void): Promise<void> {
  const bytes = await store.readMany(batch.map(index => metadata[index]));
  assertCurrentStore();
  if (bytes.length !== batch.length) throw new Error('ModelRequest recipe CAS batch returned the wrong result count.');
  for (let index = 0; index < batch.length; index++) {
    const recipe = normalizePlainJson(JSON.parse(bytes[index].toString('utf8')), 'ModelRequest recipe');
    if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) throw new TypeError('ModelRequest recipe must be an object.');
    if (recipe.kind !== 'reliable-agent-turn' && recipe.kind !== 'reliable-context-compression') {
      throw new Error(`ModelRequest has unsupported recipe kind ${String(recipe.kind)}.`);
    }
    const check = recipe.openTaskCompletionCheck;
    output.set(batch[index], { ...(recipe.kind === 'reliable-agent-turn'
      ? { ordinaryRound: positiveInteger(recipe.round, 'ModelRequest recipe.round') } : {}),
      completionCheck: !!check && typeof check === 'object' && !Array.isArray(check) && check.kind === 'open_task_completion_check' });
  }
}

function sameMetadata(left: ContentObjectMetadata, right: ContentObjectMetadata): boolean {
  return left.id === right.id && left.content_type === right.content_type && left.sha256 === right.sha256
    && left.byte_length === right.byte_length && left.storage_key === right.storage_key && left.created_at === right.created_at;
}
function requestCursor(entry: Entry): RepositoryKeysetCursor {
  return { column: 'request_seq', value: entry.sequence, id: entry.requestId, direction: 'after' };
}
function resumeState(last?: Entry): AgentLoopResumeState {
  return { requestSequence: last?.normalRound || 1n, openTaskCompletionCheckConsumed: last?.consumed ?? false };
}
function emptyState(): TurnEvidence { return { entries: [], revision: 0, dirty: true, full: true }; }
function invalidate(state: TurnEvidence, full: boolean): void { state.revision++; state.dirty = true; state.full ||= full; }
function yieldTurn(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }
function sequenceError(turnId: string, sequence: bigint): Error {
  return new Error(`Turn ${turnId} ModelRequest sequence is not contiguous at ${sequence.toString()}.`);
}
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new TypeError(`${label} must be non-empty text.`);
  return value;
}
function positiveInteger(value: unknown, label: string): bigint {
  if (typeof value === 'bigint' && value > 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return BigInt(value);
  throw new TypeError(`${label} must be a positive integer.`);
}
