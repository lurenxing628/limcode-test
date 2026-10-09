import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
const require = createRequire(import.meta.url);
const load = name => require(path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension', 'backend/reliableKernel', name));
const state = load('conversationContextHandleState.js');
const { upgradePendingConversationContextHandles } = load('conversationContextHandleUpgrade.js');
const { readConversationContextHandleState } = load('conversationChildHandles.js');
const { CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION: contract } = load('modelHandleCatalog.js');
const catalog = (...entries) => ({ entries, retiredRefs: [], identityContractRevision: contract });
const processHandle = n => ({ kind: 'process', ref: `P${n}`, target: `process-${n}` });
const now = '2026-10-04T00:00:00.000Z';

function fixture(shared = { tables: new Map(), contents: new Map() }) {
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
      const bytes = Buffer.from(text); const digest = createHash('sha256').update(bytes).digest('hex');
      const metadata = { id: `cas-${digest}`, content_type: contentType, sha256: digest,
        byte_length: BigInt(bytes.length), storage_key: digest, created_at: now };
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

test('cold current-state read touches one CAS; unchanged rounds reuse it without preparing, hashing or revising storage', async () => {
  const seeded = fixture(); await seedReady(seeded, catalog(processHandle(1)));
  const f = fixture(seeded.shared); // New database and CAS objects represent a real process restart.
  assert.deepEqual((await readConversationContextHandleState(f.database, f.store, 'conversation')).catalog.entries, [processHandle(1)]);
  assert.equal(f.metrics.reads.length, 1);
  const revision = f.table(state.CONTEXT_HANDLE_STATE_DOMAIN)[0].revision;
  for (let index = 0; index < 3; index++) {
    const steps = await prepare(f, catalog(processHandle(1)));
    assert.equal(steps.length, 1); assert.equal(steps[0].kind, 'assert');
    await f.database.transaction(steps);
  }
  assert.equal(f.metrics.reads.length, 1); assert.equal(f.metrics.prepares, 0);
  assert.equal(f.table(state.CONTEXT_HANDLE_STATE_DOMAIN)[0].revision, revision);
  assert.ok(f.metrics.queries.every(read => [state.CONTEXT_HANDLE_STATE_DOMAIN, 'ConversationContextHeadLink', 'ContentObject'].includes(read.domain)),
    'ordinary creation must not query Turn, ModelRequest, native history or fork history');
});

test('only admitted occurrence bindings publish atomically and stale head plans cannot overwrite them', async () => {
  const f = fixture(); await seedReady(f, catalog(processHandle(1)));
  const second = addModelOccurrence(f, 'second', catalog(processHandle(1), processHandle(2), processHandle(99)), null, 'P2');
  const third = addModelOccurrence(f, 'third', catalog(processHandle(1), processHandle(3)), null, 'P3');
  const root2 = addRoot(f, 'root-2', second.nodeId, 1n), root3 = addRoot(f, 'root-3', third.nodeId, 1n);
  const first = await transition(f, 'root-2', 'append', { rootShape: root2, occurrence: second.occurrence });
  const stale = await transition(f, 'root-3', 'append', { rootShape: root3, occurrence: third.occurrence });
  await commitTransition(f, first);
  await assert.rejects(commitTransition(f, stale), { code: 'RUNTIME_TRANSACTION_ASSERTION_FAILED' });
  const before = f.table(state.CONTEXT_HANDLE_STATE_DOMAIN)[0].content_object_id;
  const next = await transition(f, 'root-3', 'append', { rootShape: root3, occurrence: third.occurrence });
  await assert.rejects(f.database.transaction([...next.steps, { kind: 'assertNone', domain: 'Conversation', where: { id: 'conversation' } }]));
  assert.equal(f.table(state.CONTEXT_HANDLE_STATE_DOMAIN)[0].content_object_id, before);
  const current = await state.readCurrentConversationContextHandleState(f.database, f.store, 'conversation');
  assert.deepEqual(current.catalog.entries, [processHandle(1), processHandle(2)]);
  assert.equal(current.catalog.allocationHighWater.process, 99, 'unused private allocation reserves an ordinal but is not a binding');
  assert.equal(f.table('ContextRootHandleCatalog').some(row => row.context_root_id === 'root-3'), false);
});

test('request freezes are assertion-only; private native allocations cannot change the selected catalog', async () => {
  const f = fixture(); await seedReady(f, catalog(processHandle(1), processHandle(2)), true);
  await assert.rejects(prepare(f, catalog(processHandle(1))), { code: 'MODEL_CONTEXT_HANDLE_FRONTIER_CHANGED' });
  const initial = structuredClone(f.table(state.CONTEXT_HANDLE_STATE_DOMAIN)[0]);
  for (const source of ['ordinary', 'compression', 'native']) {
    const steps = await prepare(f, catalog(processHandle(1), processHandle(2), processHandle(3)), source);
    assert.equal(steps.length, 1); assert.equal(steps[0].kind, 'assert'); await f.database.transaction(steps);
  }
  assert.deepEqual(f.table(state.CONTEXT_HANDLE_STATE_DOMAIN)[0], initial);
  const current = await state.readCurrentConversationContextHandleState(f.database, f.store, 'conversation');
  assert.deepEqual(current.catalog.entries, [processHandle(1), processHandle(2)]);
  assert.equal(current.requiresNativeReset, true);
});

test('pending and absent authority never cause a hidden historical replay or become an empty catalog', async () => {
  const f = fixture();
  await assert.rejects(readConversationContextHandleState(f.database, f.store, 'conversation'), { code: 'MODEL_CONTEXT_HANDLE_STATE_INVALID' });
  await f.database.transaction(state.pendingConversationContextHandleStateSteps('conversation', now));
  await assert.rejects(readConversationContextHandleState(f.database, f.store, 'conversation'), { code: 'MODEL_CONTEXT_HANDLE_UPGRADE_PENDING' });
  assert.equal(f.metrics.reads.length, 0); assert.ok(f.metrics.queries.every(read => [state.CONTEXT_HANDLE_STATE_DOMAIN, 'ConversationContextHeadLink'].includes(read.domain)));
  f.table('ConversationContextHeadLink').push({ id: 'unexpected-head', conversation_id: 'conversation', root_id: 'other-root' });
  await assert.rejects(readConversationContextHandleState(f.database, f.store, 'conversation'), { code: 'MODEL_CONTEXT_HANDLE_STATE_INVALID' });
  assert.equal(f.metrics.historicalFrontiers, 0);
});

async function legacyFixture(count = 60) {
  const f = fixture();
  f.table('Conversation').push({ id: 'conversation', title: 'Fixture', status: 'active', created_at: now, updated_at: now });
  let parentNodeId = null;
  for (let index = 0; index < count; index++) {
    parentNodeId = addModelOccurrence(f, String(index), catalog(processHandle(1)), parentNodeId, 'P1').nodeId;
  }
  addRoot(f, 'legacy-root', parentNodeId, BigInt(count)); selectHead(f, 'legacy-root');
  await f.database.transaction(state.pendingConversationContextHandleStateSteps('conversation', now, undefined, 'legacy-root'));
  return f;
}

test('explicit selected-root upgrade checkpoints, cancels and resumes remaining occurrences after restart', async () => {
  const f = await legacyFixture(); const controller = new AbortController();
  await assert.rejects(upgradePendingConversationContextHandles(f.database, f.store, {
    signal: controller.signal, onProgress(progress) { if (progress.completedRequests === 35) controller.abort(); }
  }), { name: 'AbortError' });
  assert.equal(f.table(state.CONTEXT_HANDLE_STATE_DOMAIN)[0].state, 'pending');
  assert.notEqual(f.table(state.CONTEXT_HANDLE_STATE_DOMAIN)[0].content_object_id, null);
  const resumed = fixture(f.shared); const progress = [];
  await upgradePendingConversationContextHandles(resumed.database, resumed.store, { onProgress: value => progress.push(value) });
  assert.equal(progress[0].completedRequests, 32);
  assert.equal(resumed.metrics.reads.filter(id => id.startsWith('recipe-')).length, 28);
  assert.equal(resumed.table(state.CONTEXT_HANDLE_STATE_DOMAIN)[0].state, 'ready');
  const cold = fixture(resumed.shared);
  assert.deepEqual((await readConversationContextHandleState(cold.database, cold.store, 'conversation')).catalog.entries, [processHandle(1)]);
  assert.equal(cold.metrics.reads.length, 1);
});

test('P3520 follows the selected retry branch and exact-prefix restoration reuses catalog bytes', async () => {
  const f = fixture(); await seedReady(f, catalog());
  const a = { kind: 'process', ref: 'P3520', target: 'branch-A' };
  const b = { kind: 'process', ref: 'P3520', target: 'branch-B' };
  const outputA = addModelOccurrence(f, 'branch-A', catalog(a));
  const shapeA = addRoot(f, 'root-A', outputA.nodeId, 1n);
  await commitTransition(f, await transition(f, 'root-A', 'append', { rootShape: shapeA, occurrence: outputA.occurrence }));
  const snapshotA = structuredClone(f.table('ContextRootHandleCatalog').find(row => row.context_root_id === 'root-A'));
  const rawA = Buffer.from(f.shared.contents.get('recipe-branch-A'));
  const prefixShape = addRoot(f, 'retry-prefix');
  const before = { reads: f.metrics.reads.length, prepares: f.metrics.prepares };
  await commitTransition(f, await transition(f, 'retry-prefix', 'rewrite', { rootShape: prefixShape }));
  assert.equal(f.metrics.reads.length, before.reads); assert.equal(f.metrics.prepares, before.prepares);
  assert.equal(f.table(state.CONTEXT_HANDLE_STATE_DOMAIN)[0].state, 'ready');
  assert.deepEqual((await readConversationContextHandleState(f.database, f.store, 'conversation')).catalog.entries, []);
  const outputB = addModelOccurrence(f, 'branch-B', catalog(b));
  const shapeB = addRoot(f, 'root-B', outputB.nodeId, 1n);
  await commitTransition(f, await transition(f, 'root-B', 'append', { rootShape: shapeB, occurrence: outputB.occurrence }));
  assert.deepEqual((await readConversationContextHandleState(f.database, f.store, 'conversation')).catalog.entries, [b]);
  assert.deepEqual(f.table('ContextRootHandleCatalog').find(row => row.context_root_id === 'root-A'), snapshotA);
  assert.deepEqual(f.shared.contents.get('recipe-branch-A'), rawA);
  await commitTransition(f, await transition(f, 'root-A', 'activate'));
  const restored = await readConversationContextHandleState(f.database, f.store, 'conversation');
  assert.deepEqual(restored.catalog.entries, [a]); assert.equal(restored.requiresNativeReset, true);
  assert.equal(f.metrics.historicalFrontiers, 0);
});

async function inheritedCompressionFixture(owner = 'parent') {
  const f = await legacyFixture(1);
  const put = (id, text, content_type = 'text/plain') => {
    const bytes = Buffer.from(text);
    f.shared.contents.set(id, bytes);
    f.table('ContentObject').push({ id, content_type, byte_length: BigInt(bytes.length) });
  };
  f.table('Conversation').push({ id: 'parent' });
  f.table('ConversationBranchLink').push({ id: 'branch', target_conversation_id: 'conversation', source_conversation_id: 'parent' });
  put('inherited-input', 'P2');
  f.table('ContextSegment').push({ id: 'inherited-input', segment_kind: 'runtime_context', content_object_id: 'inherited-input' });
  f.table('ContextSequenceNode').push({ id: 'inherited-input-node', segment_id: 'inherited-input', parent_node_id: 'node-0' });
  f.table('ContextSequenceRoot').push({ ...f.table('ContextSequenceRoot')[0], id: 'compression-source-root',
    conversation_id: owner, root_node_id: 'inherited-input-node', segment_count: 2n });
  const blockId = 'inherited-block';
  put('summary', 'Inherited summary keeps P2');
  put('compression-recipe', JSON.stringify({ kind: 'reliable-context-compression', blockId,
    modelHandleCatalog: catalog(processHandle(2)) }), 'application/json');
  f.table('Turn').push({ id: 'compression-turn', conversation_id: owner, status: 'terminated' });
  f.table('AuthoritySnapshot').push({ id: 'compression-authority', turn_id: 'compression-turn' });
  f.table('ModelRequest').push({ id: 'compression-request', turn_id: 'compression-turn',
    authority_snapshot_id: 'compression-authority', recipe_object_id: 'compression-recipe',
    stream_stats_json: { compressionPurpose: { blockId } } });
  f.table('ModelContextProjection').push({ id: 'compression-input', owner_kind: 'model_request',
    owner_id: 'compression-request', root_id: 'compression-source-root' });
  f.table('CompressionBlock').push({ id: blockId, conversation_id: owner, authority_snapshot_id: 'compression-authority', summary_object_id: 'summary' });
  for (const [position, segment_id] of ['segment-0', 'inherited-input'].entries()) {
    f.table('CompressionBlockSource').push({ id: `block-source-${position}`, compression_block_id: blockId, segment_id, position: BigInt(position) });
  }
  f.table('ContextSegment').push({ id: 'summary', segment_kind: 'compression', content_object_id: 'summary' });
  f.table('ContextSegmentSource').push({ id: 'summary-source', segment_id: 'summary', source_kind: 'compression_block', source_id: blockId, source_revision: 0n });
  f.table('ContextSequenceNode').push({ id: 'summary-node', parent_node_id: null, segment_id: 'summary' });
  Object.assign(f.table('ContextSequenceRoot')[0], { root_node_id: 'summary-node', segment_count: 1n });
  return f;
}

for (const owner of ['parent', 'conversation']) test(`引用目录升级保留${owner === 'parent' ? '早期父会话共享' : '分支独立'}压缩块的原始引用`, async () => {
  const f = await inheritedCompressionFixture(owner);
  const before = structuredClone(f.table('CompressionBlock'));
  assert.deepEqual(await upgradePendingConversationContextHandles(f.database, f.store), []);
  assert.deepEqual((await readConversationContextHandleState(f.database, f.store, 'conversation')).catalog.entries,
    [processHandle(1), processHandle(2)]);
  assert.deepEqual(f.table('CompressionBlock'), before, '只重建目录，不改写历史压缩块');
});

test('早期多层分支沿祖先链读取压缩块，但不会采用共享摘要的无关会话块', async () => {
  const f = await inheritedCompressionFixture();
  f.table('ConversationBranchLink')[0].source_conversation_id = 'middle';
  f.table('ConversationBranchLink').push({ id: 'middle-branch', target_conversation_id: 'middle', source_conversation_id: 'parent' });
  f.table('CompressionBlock').push({ id: 'unrelated-block', conversation_id: 'unrelated', summary_object_id: 'summary' });
  f.table('ContextSegmentSource').push({ id: 'unrelated-source', segment_id: 'summary', source_kind: 'compression_block', source_id: 'unrelated-block', source_revision: 0n });
  assert.deepEqual(await upgradePendingConversationContextHandles(f.database, f.store), []);
  assert.deepEqual((await readConversationContextHandleState(f.database, f.store, 'conversation')).catalog.entries,
    [processHandle(1), processHandle(2)]);
});

for (const damage of ['unrelated', 'duplicate', 'summary']) test(`压缩来源${damage}不会被分支兼容吞掉，后续会话仍能升级`, async () => {
  const f = await inheritedCompressionFixture();
  if (damage === 'unrelated') f.table('CompressionBlock')[0].conversation_id = 'unrelated';
  if (damage === 'summary') f.table('CompressionBlock')[0].summary_object_id = 'different';
  if (damage === 'duplicate') {
    f.table('CompressionBlock').push({ ...f.table('CompressionBlock')[0], id: 'duplicate' });
    f.table('ContextSegmentSource').push({ ...f.table('ContextSegmentSource').find(row => row.segment_id === 'summary'), id: 'duplicate-source', source_id: 'duplicate' });
  }
  f.table('Conversation').push({ id: 'healthy', title: 'Healthy' });
  await f.database.transaction(state.pendingConversationContextHandleStateSteps('healthy', now));
  const failures = await upgradePendingConversationContextHandles(f.database, f.store);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].conversationId, 'conversation');
  assert.equal(failures[0].error.code, 'MODEL_CONTEXT_HANDLE_STATE_INVALID');
  assert.match(failures[0].error.message, /summary.*conversation/);
  assert.equal(f.table(state.CONTEXT_HANDLE_STATE_DOMAIN).find(row => row.conversation_id === 'conversation').state, 'pending');
  assert.equal(f.table(state.CONTEXT_HANDLE_STATE_DOMAIN).find(row => row.conversation_id === 'healthy').state, 'ready');
  assert.deepEqual(await upgradePendingConversationContextHandles(f.database, f.store, { skipConversationIds: new Set(['conversation']) }), []);
});
