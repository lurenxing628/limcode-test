// Small repository-step adapter for selected-root semantics. CAS identity is local to this adapter; real CAS/worker import is exercised by H4/H5.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const load = name => require(path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension', 'backend/reliableKernel', name));
const state = load('conversationContextHandleState.js');
const { upgradePendingConversationContextHandles } = load('conversationContextHandleUpgrade.js');
const { readConversationContextHandleState } = load('conversationChildHandles.js');
const { CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION: contract } = load('modelHandleCatalog.js');
const catalog = (...entries) => ({ entries, retiredRefs: [], identityContractRevision: contract });
const processHandle = n => ({ kind: 'process', ref: `P${n}`, target: `process-${n}` });
const now = '2026-10-04T00:00:00.000Z';

function fixture(shared = { tables: new Map(), contents: new Map(), contentIds: new Map() }) {
  const metrics = { reads: [], queries: [], prepares: 0, transactions: [], historicalFrontiers: 0 };
  const table = name => { if (!shared.tables.has(name)) shared.tables.set(name, []); return shared.tables.get(name); };
  const selected = read => table(read.domain).filter(row => Object.entries(read.where ?? {}).every(([key, value]) => row[key] === value));
  const database = {
    conversationOwners: { async run(_id, run) { return run(); } },
    async withHistoryPreparation(run, options = {}) { return run({ assertActive() { options.signal?.throwIfAborted(); } }); },
    async snapshot(reads) { metrics.queries.push(...reads); return { snapshot: reads.map(read => read.kind === 'get'
      ? structuredClone(table(read.domain).find(row => row.id === read.id) ?? null) : structuredClone(selected(read).slice(0, read.limit ?? Infinity))) }; },
    async snapshotAll(read) { metrics.queries.push(read); return { snapshot: structuredClone(selected(read)) }; },
    async contextHandleEvidenceFrontier() {
      metrics.historicalFrontiers++;
      throw new Error('Current-root upgrade must not read a conversation-wide recipe frontier.');
    },
    async materializeContext(rootId) {
      const root = table('ContextSequenceRoot').find(row => row.id === rootId);
      assert.ok(root, `missing fixture root ${rootId}`);
      const records = [];
      for (let nodeId = root.root_node_id; nodeId !== null;) {
        const node = table('ContextSequenceNode').find(row => row.id === nodeId);
        assert.ok(node, `missing fixture node ${nodeId}`);
        const segment = table('ContextSegment').find(row => row.id === node.segment_id);
        const contentObject = table('ContentObject').find(row => row.id === segment.content_object_id);
        records.unshift({ node, segment, contentObject }); nodeId = node.parent_node_id;
      }
      return { snapshotCommitSeq: '1', snapshot: structuredClone({ root, records }) };
    },
    async transaction(steps) {
      await fixtureState.beforeTransaction?.(steps);
      const before = structuredClone(shared.tables);
      const assertionFailed = () => { throw Object.assign(new Error('Assertion failed'), { code: 'RUNTIME_TRANSACTION_ASSERTION_FAILED' }); };
      const apply = step => {
        if (step.kind === 'savepoint') { for (const child of step.steps) apply(child); return; }
        const rows = table(step.domain);
        const row = rows.find(row => row.id === step.id);
        if (step.kind === 'assert') { if (!row || !Object.entries(step.where).every(([key, value]) => row[key] === value)) assertionFailed(); }
        else if (step.kind === 'assertNone') { if (selected(step).length) assertionFailed(); }
        else if (step.kind === 'assertExactIds') {
          if (JSON.stringify(selected(step).map(row => row.id).sort()) !== JSON.stringify([...step.expectedIds].sort())) assertionFailed();
        } else if (step.kind === 'insert') { if (rows.some(row => row.id === step.row.id)) assertionFailed(); rows.push(structuredClone(step.row)); }
        else if (step.kind === 'update') { if (!row) assertionFailed(); Object.assign(row, structuredClone(step.patch)); }
        else throw new Error(`Unsupported test transaction step: ${step.kind}`);
      };
      try { for (const step of steps) apply(step); metrics.transactions.push(steps); }
      catch (error) { shared.tables = before; throw error; }
    }
  };
  const store = {
    async prepare(_database, text, contentType) {
      metrics.prepares++;
      const bytes = Buffer.from(text);
      const key = contentType + '\0' + text;
      if (!shared.contentIds.has(key)) shared.contentIds.set(key, `memory-cas-${shared.contentIds.size + 1}`);
      const id = shared.contentIds.get(key);
      const metadata = { id, content_type: contentType, sha256: '0'.repeat(64),
        byte_length: BigInt(bytes.length), storage_key: id, created_at: now };
      shared.contents.set(metadata.id, bytes);
      return { metadata, ...(table('ContentObject').some(row => row.id === metadata.id) ? {} : {
        insert: { kind: 'insert', domain: 'ContentObject', row: metadata }
      }) };
    },
    async read(metadata) { metrics.reads.push(metadata.id); return Buffer.from(shared.contents.get(metadata.id)); },
    async readMany(metadata) { return Promise.all(metadata.map(row => this.read(row))); }
  };
  const fixtureState = { shared, metrics, database, store, table, beforeTransaction: undefined };
  return fixtureState;
}
function addRoot(f, id, nodeId = null, count = 0n) {
  const root = { id, conversation_id: 'conversation', root_node_id: nodeId, tail_node_id: null,
    tail_segment_count: 0n, segment_count: count, estimated_tokens: count, root_seq: BigInt(f.table('ContextSequenceRoot').length + 1), created_at: now };
  f.table('ContextSequenceRoot').push(root);
  return { rootNodeId: nodeId, tailNodeId: null, tailSegmentCount: 0n, segmentCount: count };
}
function selectHead(f, rootId) {
  const head = f.table('ConversationContextHeadLink')[0];
  if (head) head.root_id = rootId;
  else f.table('ConversationContextHeadLink').push({ id: 'head', conversation_id: 'conversation', root_id: rootId, updated_at: now });
}
function addProducer(f, key, value, text = value.entries.map(entry => entry.ref).join(' ')) {
  if (!f.table('Turn').some(row => row.id === 'turn')) f.table('Turn').push({ id: 'turn', conversation_id: 'conversation', status: 'terminated' });
  const recipeId = `recipe-${key}`;
  const recipeBytes = Buffer.from(JSON.stringify({ kind: 'reliable-agent-turn', modelHandleCatalog: value, uniqueRecipeField: key }));
  f.shared.contents.set(recipeId, recipeBytes);
  f.table('ContentObject').push({ id: recipeId, content_type: 'application/json', byte_length: BigInt(recipeBytes.length) });
  const requestId = `request-${key}`;
  f.table('ModelRequest').push({ id: requestId, turn_id: 'turn', recipe_object_id: recipeId, authority_snapshot_id: 'authority',
    request_seq: BigInt(f.table('ModelRequest').length + 1), status: 'terminal', terminal_state: 'completed' });
  return { kind: 'message', modelRequestId: requestId, content: text };
}
function addModelOccurrence(f, key, value, parentNodeId = null, text = value.entries.map(entry => entry.ref).join(' ')) {
  const occurrence = addProducer(f, key, value, text);
  const contentId = `message-body-${key}`, messageId = `message-${key}`, revisionId = `revision-${key}`;
  f.shared.contents.set(contentId, Buffer.from(text));
  f.table('ContentObject').push({ id: contentId, content_type: 'text/plain', byte_length: BigInt(Buffer.byteLength(text)) });
  f.table('Message').push({ id: messageId, created_at: now, updated_at: now, deleted_at: null });
  f.table('MessageRevision').push({ id: revisionId, message_id: messageId, role: 'model', revision_seq: 1n, content_object_id: contentId, created_at: now });
  f.table('MessagePartOfConversation').push({ id: `membership-${key}`, conversation_id: 'conversation', message_id: messageId, message_seq: BigInt(f.table('MessagePartOfConversation').length + 1), created_at: now });
  f.table('ModelRequestMessageLink').push({ id: `producer-${key}`, model_request_id: occurrence.modelRequestId, message_id: messageId, created_at: now });
  const segmentId = `segment-${key}`, nodeId = `node-${key}`;
  f.table('ContextSegment').push({ id: segmentId, segment_kind: 'message', content_object_id: contentId, created_at: now });
  f.table('ContextSegmentSource').push({ id: `source-${key}`, segment_id: segmentId, source_kind: 'message_revision', source_id: revisionId, source_revision: 1n, created_at: now });
  f.table('ContextSequenceNode').push({ id: nodeId, parent_node_id: parentNodeId, segment_id: segmentId, created_at: now });
  return { occurrence, nodeId };
}
async function seedReady(f, value, requiresNativeReset = false) {
  f.table('Conversation').push({ id: 'conversation', title: 'Fixture', status: 'active', created_at: now, updated_at: now });
  const rootShape = addRoot(f, 'root-ready'); selectHead(f, 'root-ready');
  await f.database.transaction(await state.prepareReadyConversationContextHandleState({ database: f.database,
    contentStore: f.store, conversationId: 'conversation', contextRootId: 'root-ready', rootShape, catalog: value, requiresNativeReset, now }));
}
const prepare = (f, value, source = 'ordinary') => state.prepareConversationContextHandleUpdate({ database: f.database,
  contentStore: f.store, conversationId: 'conversation', contextRootId: f.table('ConversationContextHeadLink')[0]?.root_id,
  catalog: value, source, now });
const transition = (f, nextRootId, mode, options = {}) => state.prepareContextHandleHeadTransition({ database: f.database,
  contentStore: f.store, conversationId: 'conversation', previousRootId: f.table('ConversationContextHeadLink')[0].root_id,
  nextRootId, mode, now, ...options });
async function commitTransition(f, plan) {
  await f.database.transaction([...plan.steps, { kind: 'update', domain: 'ConversationContextHeadLink', id: 'head',
    patch: { root_id: plan.state.context_root_id } }]);
}

export { fixture, catalog, processHandle, addRoot, selectHead, addProducer, addModelOccurrence, seedReady, prepare, transition, commitTransition, now, state, contract, readConversationContextHandleState, upgradePendingConversationContextHandles };
