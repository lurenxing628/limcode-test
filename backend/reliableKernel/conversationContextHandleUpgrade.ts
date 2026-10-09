import { ConversationRuntimeOwnerBusyError } from './ConversationRuntimeOwnerManager';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { ContentAddressedStore } from './contentAddressedStore';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import { CONTEXT_HANDLE_STATE_DOMAIN, contextHandleStateAssertion, emptyContextHandleCatalog,
  prepareReadyConversationContextHandleState, readContextHandleStateContent,
  readConversationContextHandleStateRow } from './conversationContextHandleState';
import { readContextHandleRootEvidence, type ContextHandleRootCheckpoint } from './contextHandleOccurrenceEvidence';
import { normalizeModelHandleCatalog } from './modelHandleCatalog';
import { isTransactionAssertionFailure } from './phaseFIdentity';
import { canonicalPlainJson, normalizePlainJson } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import type { RuntimeDatabase } from './runtimeDatabase';

const CHECKPOINT_CONTENT_TYPE = 'application/vnd.limcode.conversation-context-handle-upgrade+json';
const CHECKPOINT_KIND = 'conversation-context-handle-upgrade';
export interface ContextHandleUpgradeProgress {
  conversationId: string; conversationIndex: number; conversationCount: number;
  completedRequests: number; totalRequests: number;
}
export interface ContextHandleUpgradeFailure {
  conversationId: string;
  contextRootId: string | null;
  provenanceRevision: string;
  error: unknown;
}
interface Checkpoint extends ContextHandleRootCheckpoint {
  kind: typeof CHECKPOINT_KIND; conversationId: string;
}
interface UpgradeJob {
  promise: Promise<void>; controller: AbortController;
  listeners: Set<(progress: ContextHandleUpgradeProgress) => void>;
  progress?: ContextHandleUpgradeProgress;
}
const jobs = new WeakMap<RuntimeDatabase, Map<string, UpgradeJob>>();

export async function listPendingContextHandleUpgrades(database: RuntimeDatabase): Promise<DomainRow[]> {
  return listAllDomainRows(database, CONTEXT_HANDLE_STATE_DOMAIN, { state: 'pending' });
}

/** Explicit resumable recovery job. This is never called by the ordinary catalog reader. */
export async function upgradePendingConversationContextHandles(database: RuntimeDatabase, store: ContentAddressedStore,
  options: { signal?: AbortSignal; skipConversationIds?: ReadonlySet<string>;
    onProgress?(progress: ContextHandleUpgradeProgress): void } = {}): Promise<ContextHandleUpgradeFailure[]> {
  const busy = new Set(options.skipConversationIds);
  const failures: ContextHandleUpgradeFailure[] = [];
  for (;;) {
    const pending = (await listPendingContextHandleUpgrades(database)).filter(row => !busy.has(String(row.conversation_id)));
    if (pending.length === 0) return failures;
    for (const [index, row] of pending.entries()) {
      options.signal?.throwIfAborted();
      try {
        await upgradeConversationContextHandles(database, store, String(row.conversation_id), {
          ...options, onProgress: progress => options.onProgress?.({ ...progress,
            conversationIndex: index + 1, conversationCount: pending.length })
        });
      } catch (error) {
        options.signal?.throwIfAborted();
        if ((error as { name?: string })?.name === 'AbortError') throw error;
        busy.add(String(row.conversation_id));
        if (error instanceof ConversationRuntimeOwnerBusyError) continue;
        failures.push({ conversationId: String(row.conversation_id), contextRootId: row.context_root_id as string | null,
          provenanceRevision: String(row.provenance_revision), error });
      }
    }
  }
}

/** A target may join its own background job without waiting for any unrelated conversation. */
export async function upgradeConversationContextHandles(database: RuntimeDatabase, store: ContentAddressedStore,
  conversationId: string, options: { signal?: AbortSignal; onProgress?(progress: ContextHandleUpgradeProgress): void } = {}): Promise<void> {
  if ((await readConversationContextHandleStateRow(database, conversationId)).state === 'ready') return;
  let byConversation = jobs.get(database);
  if (!byConversation) { byConversation = new Map(); jobs.set(database, byConversation); }
  const existing = byConversation.get(conversationId);
  if (existing) return joinUpgradeJob(existing, options);
  const controller = new AbortController();
  const job: UpgradeJob = { controller, listeners: new Set(), promise: Promise.resolve() };
  const progress = (value: ContextHandleUpgradeProgress) => {
    job.progress = value;
    for (const listener of job.listeners) listener(value);
  };
  job.promise = database.conversationOwners.run(conversationId, () => database.withHistoryPreparation(async permit => {
    for (;;) {
      permit.assertActive(); controller.signal.throwIfAborted();
      try {
        await rebuildConversation(database, store, conversationId, () => {
          permit.assertActive(); controller.signal.throwIfAborted();
        }, (completedRequests, totalRequests) => progress({ conversationId, conversationIndex: 1,
          conversationCount: 1, completedRequests, totalRequests }), controller.signal);
        return;
      } catch (error) {
        if ((error as { code?: string }).code !== 'MODEL_CONTEXT_HANDLE_UPGRADE_FRONTIER_CHANGED') throw error;
        await yieldToEventLoop();
      }
    }
  }, { signal: controller.signal }));
  byConversation.set(conversationId, job);
  void job.promise.finally(() => {
    if (byConversation!.get(conversationId) === job) byConversation!.delete(conversationId);
  }).catch(() => undefined);
  return joinUpgradeJob(job, options);
}

async function joinUpgradeJob(job: UpgradeJob, options: {
  signal?: AbortSignal; onProgress?(progress: ContextHandleUpgradeProgress): void;
}): Promise<void> {
  const abort = () => job.controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  if (options.onProgress) {
    job.listeners.add(options.onProgress);
    if (job.progress) options.onProgress(job.progress);
  }
  try { await job.promise; }
  finally {
    options.signal?.removeEventListener('abort', abort);
    if (options.onProgress) job.listeners.delete(options.onProgress);
  }
}

async function rebuildConversation(database: RuntimeDatabase, store: ContentAddressedStore, conversationId: string,
  assertActive: () => void, progress: (completed: number, total: number) => void, signal?: AbortSignal): Promise<void> {
  let row = await readConversationContextHandleStateRow(database, conversationId);
  if (row.state === 'ready') return;
  assertActive();
  const heads = (await database.snapshot([DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').list({
    where: { conversation_id: conversationId }, limit: 2
  })])).snapshot[0];
  if (!Array.isArray(heads) || heads.length > 1) throw new Error('Context reference upgrade requires one exact current head.');
  const rootId = heads[0]?.root_id ?? null;
  if (rootId !== row.context_root_id || (rootId !== null && typeof rootId !== 'string')) {
    throw new Error('Context reference upgrade pointer does not name its exact current head.');
  }
  const headAssertion = heads.length ? DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').assert(String(heads[0].id), {
    conversation_id: conversationId, root_id: rootId
  }) : DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').assertNone({ conversation_id: conversationId });
  let checkpoint: Checkpoint | undefined;
  if (row.content_object_id !== null) {
    checkpoint = parseCheckpoint(await readContextHandleStateContent(database, store, row, CHECKPOINT_CONTENT_TYPE),
      conversationId, rootId);
  }
  const evidence = rootId === null ? { catalog: emptyContextHandleCatalog(), assertions: [] } :
    await readContextHandleRootEvidence(database, store, conversationId, rootId, {
      signal, ...(checkpoint ? { resume: checkpoint }
        : { prefixProvenanceRevision: BigInt(String(row.provenance_revision)) }),
      onProgress: value => { assertActive(); progress(value.completedRequests, value.totalRequests); },
      onCheckpoint: async checkpoint => {
        assertActive();
        row = await saveCheckpoint(database, store, row, { kind: CHECKPOINT_KIND, conversationId, ...checkpoint });
      }
    });
  assertActive();
  const ready = await prepareReadyConversationContextHandleState({ database, contentStore: store, conversationId,
    contextRootId: rootId, catalog: evidence.catalog, requiresNativeReset: true,
    current: row, now: new Date().toISOString() });
  assertActive();
  try {
    await database.transaction([
      DOMAIN_REPOSITORIES.domain('Conversation').assert(conversationId, {}), headAssertion,
      ...evidence.assertions, ...ready
    ], { durable: true });
  } catch (error) {
    if (!isTransactionAssertionFailure(error)) throw error;
    const latest = await readConversationContextHandleStateRow(database, conversationId);
    if (changedScopeState(row, latest)) throw upgradeFrontierChanged();
    throw error;
  }
}

async function saveCheckpoint(database: RuntimeDatabase, store: ContentAddressedStore, row: DomainRow,
  checkpoint: Checkpoint): Promise<DomainRow> {
  const content = await store.prepare(database, canonicalPlainJson(normalizePlainJson(checkpoint, 'Context reference upgrade')),
    CHECKPOINT_CONTENT_TYPE);
  const next = { ...row, content_object_id: content.metadata.id, revision: BigInt(String(row.revision)) + 1n,
    updated_at: new Date().toISOString() };
  try {
    await database.transaction([contextHandleStateAssertion(row),
      ...preparedContentObjectSteps([content], 'context_handle_upgrade_checkpoint'),
      DOMAIN_REPOSITORIES.domain(CONTEXT_HANDLE_STATE_DOMAIN).update(String(row.id), {
        content_object_id: next.content_object_id, revision: next.revision, updated_at: next.updated_at
      })], { durable: true });
  } catch (error) {
    if (!isTransactionAssertionFailure(error)) throw error;
    if (changedScopeState(row, await readConversationContextHandleStateRow(database, String(row.conversation_id)))) {
      throw upgradeFrontierChanged();
    }
    throw error;
  }
  return next;
}

function changedScopeState(before: DomainRow, after: DomainRow): boolean {
  return before.revision !== after.revision || before.state !== after.state
    || before.context_root_id !== after.context_root_id || before.content_object_id !== after.content_object_id;
}

function parseCheckpoint(value: ReturnType<typeof normalizePlainJson>, conversationId: string,
  rootId: string | null): Checkpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== CHECKPOINT_KIND
    || value.conversationId !== conversationId || value.rootId !== rootId || typeof rootId !== 'string'
    || !Number.isSafeInteger(value.nextOccurrence) || Number(value.nextOccurrence) < 0 || !Array.isArray(value.facts)) {
    throw new Error('Invalid durable root-scoped Context reference upgrade checkpoint.');
  }
  const floor = normalizeModelHandleCatalog({ ...emptyContextHandleCatalog(), allocationHighWater: value.allocationHighWater });
  return { kind: CHECKPOINT_KIND, conversationId, rootId, nextOccurrence: Number(value.nextOccurrence),
    facts: value.facts.map(normalizeModelHandleCatalog), allocationHighWater: floor.allocationHighWater ?? {} };
}

function upgradeFrontierChanged(): Error {
  return Object.assign(new Error('Context reference upgrade source changed; resume the current pending root scope.'),
    { code: 'MODEL_CONTEXT_HANDLE_UPGRADE_FRONTIER_CHANGED' });
}
