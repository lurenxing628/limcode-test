import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { before, after, afterEach } from 'node:test';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiled, 'backend/reliableKernel/index.js'));
const shared = require(path.join(compiled, 'shared/reliableKernelClientFeed.js'));
const bounds = require(path.join(compiled, 'backend/reliableKernel/clientFeedBounds.js'));
const { ReliableKernelWebviewFeedBridge } = require(path.join(compiled, 'backend/reliableKernel/webviewFeedBridge.js'));
const NativeDatabase = require('better-sqlite3');
const NOW = '2026-10-13T00:00:00.000Z';
const row = (domain, value) => kernel.DOMAIN_REPOSITORIES.domain(domain).insert(value);
const update = (domain, id, value) => kernel.DOMAIN_REPOSITORIES.domain(domain).update(id, value);
const byId = (rows) => Object.fromEntries(rows.map((value) => [value.id, value]));
const wireBytes = (value) => Buffer.byteLength(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const conversation = (id, title = id) => row('Conversation', { id, title, status: 'active', created_at: NOW, updated_at: NOW });
const turn = (id, conversationId) => row('Turn', { id, conversation_id: conversationId, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW });

let directory, root, database, cas, server, pinia, vue, renderToString, modules, ui;
const previousGlobals = { window: globalThis.window, document: globalThis.document };
const frames = new Map();
let frameId = 0;

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-collaboration-ui-'));
  root = await kernel.resetCandidateRuntimeRoot(directory);
  database = await kernel.RuntimeDatabase.open(root.authority, { hostBootId: 'collaboration-ui' });
  cas = kernel.ContentAddressedStore.forDatabase(root.authority, database);
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, atob,
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    acquireVsCodeApi() { return {
      getState() { return {}; }, setState() {},
      postMessage(value) {
        const current = ui;
        if (!current) return;
        const message = structuredClone(value);
        current.posted.push(message);
        if (message.type === 'reliable-kernel.detail-request' && current.details) {
          current.pending.push(current.details.read({ ...message, conversationId: current.conversationId }).then(
            (detail) => current.feed.observe({ type: 'reliable-kernel.detail-result', requestId: message.requestId, sessionId: message.sessionId, detail }),
            (error) => current.feed.observe({ type: 'reliable-kernel.detail-error', requestId: message.requestId, sessionId: message.sessionId, message: String(error.message) })
          ));
        }
        if (message.type === 'reliable-kernel.collaboration-history-request' && !current.holdHistory) {
          queueMicrotask(() => current.feed.observe({ type: 'reliable-kernel.collaboration-history-result',
            sessionId: message.sessionId, requestId: message.requestId, conversationId: message.conversationId,
            page: { records: {}, hasMore: false, scanProgress: false, scannedRows: 0, responseBytes: 0 } }));
        }
      }
    }; }
  };
  server = await createWebviewSsrServer();
  pinia = await import('pinia');
  vue = await import('vue');
  ({ renderToString } = await import('@vue/server-renderer'));
  const loaded = await Promise.all([
    server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts'),
    server.ssrLoadModule('/src/components/conversation/ReliableMessageList.vue'),
    server.ssrLoadModule('/src/components/input/ReliableQueuePanel.vue'),
    server.ssrLoadModule('/src/domain/reliableCollaborationTimeline.ts'),
    server.ssrLoadModule('/src/domain/reliableAgentStatusProjection.ts'),
    server.ssrLoadModule('/src/domain/reliableTransientLifecycle.ts'),
    server.ssrLoadModule('/src/domain/reliableTransientModel.ts')
  ]);
  modules = { store: loaded[0], MessageList: loaded[1].default, QueuePanel: loaded[2].default,
    timeline: loaded[3], status: loaded[4], transient: loaded[5], preview: loaded[6] };
  globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
});

async function flushFrames() {
  while (frames.size) {
    const scheduled = [...frames];
    frames.clear();
    for (const [, callback] of scheduled) callback(performance.now());
    await vue.nextTick();
  }
}

afterEach(async () => {
  if (ui) {
    await Promise.all(ui.pending);
    ui.feed.observe({ type: 'reliable-kernel.snapshot', sessionId: 'disposed', hostBootId: 'disposed',
      messageSeq: '1', snapshotCommitSeq: '0', projections: {} });
    ui.feed.$dispose();
    ui = undefined;
  }
  await flushFrames();
});

after(async () => {
  await server?.close();
  await database?.close();
  await fs.rm(directory, { recursive: true, force: true });
  globalThis.window = previousGlobals.window;
  globalThis.document = previousGlobals.document;
});

function openUi(conversationId, { details = false, holdHistory = false } = {}) {
  const scope = pinia.createPinia();
  pinia.setActivePinia(scope);
  ui = { scope, feed: modules.store.useReliableKernelClientFeedStore(), conversationId,
    posted: [], pending: [], holdHistory, details: details ? new kernel.ClientDetailReader(database, cas) : undefined };
  return ui;
}

async function render(component = modules.MessageList) {
  let setup;
  const app = vue.createSSRApp(component, {}).use(ui.scope);
  app.mixin({ created() { if (this.$.type.__name === component.__name) setup = this.$.setupState; } });
  return { html: await renderToString(app), setup };
}

async function loadedView() {
  await render();
  await Promise.all(ui.pending);
  await vue.nextTick();
  return render();
}

async function snapshot(conversationId) {
  const feed = new kernel.BoundedClientFeed(database);
  const sent = [];
  try {
    await feed.connect({ activeConversationId: conversationId, send: (value) => sent.push(value) });
    return sent[0];
  } finally { feed.close(); }
}

function envelope(id, source, target, payloadId, { turnId = null, sourceTurnId = null, state = 'pending' } = {}) {
  return [
    kernel.DOMAIN_REPOSITORIES.domain('CollaborationMessage').insertWithNextSequence({ id, dedupe_key: id, mode: 'message', created_at: NOW }, { column: 'message_seq', scope: {} }),
    row('CollaborationMessageSourceLink', { id: `${id}-source`, message_id: id, conversation_id: source, source_kind: 'tool', source_key: id, turn_id: sourceTurnId, tool_call_id: null, created_at: NOW }),
    row('RuntimeInboxItem', { id: `${id}-inbox`, dedupe_key: id, source_kind: 'collaboration_message', source_id: id, state: 'available', created_at: NOW, updated_at: NOW }),
    row('CollaborationMessageTargetLink', { id: `${id}-target`, message_id: id, conversation_id: target, inbox_item_id: `${id}-inbox`, anchor_turn_id: null, created_at: NOW }),
    row('CollaborationMessagePayloadLink', { id: `${id}-payload`, message_id: id, content_object_id: payloadId, created_at: NOW }),
    row('RuntimeDelivery', { id: `${id}-delivery`, inbox_item_id: `${id}-inbox`, target_conversation_id: target, target_turn_id: turnId,
      phase: turnId ? 'current_turn' : 'next_turn', attempt_seq: 1n, retry_of_delivery_id: null, state, failure_reason: state === 'failed' ? 'wake-dead-letter' : null, created_at: NOW, updated_at: NOW }),
    ...(state === 'consumed' ? [row('RuntimeDeliveryInputLink', { id: `${id}-input`, delivery_id: `${id}-delivery`, pending_turn_input_id: `${id}-pending-input`, handled_at: NOW, created_at: NOW, updated_at: NOW })] : [])
  ];
}

test('durable child status retains activity, answer and delivery identities independently', () => {
  const records = {
    Turn: { parent: { id: 'status-parent-turn', conversation_id: 'status-parent', status: 'active' },
      child: { id: 'status-child-turn', conversation_id: 'status-child', status: 'active' } },
    AgentConversationLink: { child: { id: 'status-agent-link', conversation_id: 'status-child', agent_id: 'worker', role: 'default' } },
    ChildExecution: { child: { id: 'status-execution', child_conversation_id: 'status-child', status: 'active' } },
    ChildExecutionParentLink: { child: { id: 'status-parent-link', child_execution_id: 'status-execution', parent_turn_id: 'status-parent-turn', source_tool_call_id: 'status-spawn-call' } },
    ChildExecutionActiveTurnLink: { child: { id: 'status-active-link', child_execution_id: 'status-execution', turn_id: 'status-child-turn' } },
    ChildExecutionActivity: { child: { id: 'status-execution', child_execution_id: 'status-execution', kind: 'tool', summary: '正在运行命令', tool_call_id: 'status-shell-call' } },
    TurnExecutorLink: { child: { id: 'status-executor', turn_id: 'status-child-turn', agent_id: 'worker' } },
    AnswerBridge: { child: { id: 'status-bridge', child_execution_id: 'status-execution', status: 'open', current_submission_id: 'status-answer', current_submission_seq: '2', current_turn_id: 'status-child-turn', current_title: '调研结果' } },
    AnswerSubmission: { child: { id: 'status-answer', answer_bridge_id: 'status-bridge', submission_seq: '2', turn_id: 'status-child-turn' } },
    RuntimeInboxItem: { child: { id: 'status-inbox', source_kind: 'answer_submission', source_id: 'status-answer' } },
    RuntimeDelivery: { child: { id: 'status-delivery', inbox_item_id: 'status-inbox', attempt_seq: '1', state: 'consumed', parent_handling_state: 'unhandled' } }
  };
  const child = modules.status.projectReliableAgentStatus({ conversationId: 'status-parent', records, agentNames: new Map([['worker', 'Worker']]) }).children[0];
  assert.deepEqual([child.agentName, child.turnId, child.activityToolCallId, child.answerSubmissionId, child.deliveryId],
    ['Worker', 'status-child-turn', 'status-shell-call', 'status-answer', 'status-delivery']);
  assert.equal(child.activitySummary, '正在运行命令');
  assert.equal(child.deliveryBadge, 'awaiting_parent');
  assert.equal(child.interruptible, true);
});

test('two generations of one child answer bridge survive snapshot and distinguish failed output', async () => {
  const body = await cas.ingest(database, '子任务的回答', 'text/plain');
  const failed = kernel.stablePhaseFId('answer_submission', 'child-drive-failed', 'answer-child-execution', 'answer-child-2');
  await database.transaction([
    conversation('answer-parent', '主对话'), conversation('answer-child', '调研子任务'),
    turn('answer-spawn-turn', 'answer-parent'), turn('answer-parent-1', 'answer-parent'), turn('answer-parent-2', 'answer-parent'),
    turn('answer-child-1', 'answer-child'), turn('answer-child-2', 'answer-child'),
    row('ChildExecution', { id: 'answer-child-execution', child_conversation_id: 'answer-child', status: 'idle', created_at: NOW, updated_at: NOW }),
    row('ChildExecutionParentLink', { id: 'answer-child-parent', child_execution_id: 'answer-child-execution', parent_turn_id: 'answer-spawn-turn', parent_child_execution_id: null, source_tool_call_id: 'answer-spawn', created_at: NOW }),
    row('AnswerBridge', { id: 'answer-bridge', child_execution_id: 'answer-child-execution', current_submission_id: null, status: 'open', created_at: NOW, updated_at: NOW })
  ]);
  const answerRows = (id, sequence, childTurn, parentTurn) => [
    row('AnswerSubmission', { id, answer_bridge_id: 'answer-bridge', submission_seq: sequence, turn_id: childTurn, interrupted: 0n, created_at: NOW }),
    row('AnswerPayload', { id: `${id}-payload`, submission_id: id, title: null, content_object_id: body.id, byte_length: BigInt(body.byte_length), created_at: NOW }),
    row('RuntimeInboxItem', { id: `${id}-inbox`, dedupe_key: id, source_kind: 'answer_submission', source_id: id, state: 'consumed', created_at: NOW, updated_at: NOW }),
    row('RuntimeDelivery', { id: `${id}-delivery`, inbox_item_id: `${id}-inbox`, target_conversation_id: 'answer-parent', target_turn_id: parentTurn, phase: 'next_turn', attempt_seq: 1n, retry_of_delivery_id: null, state: 'consumed', failure_reason: null, created_at: NOW, updated_at: NOW }),
    row('RuntimeDeliveryInputLink', { id: `${id}-input`, delivery_id: `${id}-delivery`, pending_turn_input_id: `${id}-pending`, handled_at: NOW, created_at: NOW, updated_at: NOW })
  ];
  await database.transaction([...answerRows('answer-first', 1n, 'answer-child-1', 'answer-parent-1'),
    ...answerRows(failed, 2n, 'answer-child-2', 'answer-parent-2'), update('AnswerBridge', 'answer-bridge', { current_submission_id: failed, updated_at: NOW })]);
  const state = openUi('answer-parent', { details: true });
  state.feed.observe(await snapshot('answer-parent'));
  const view = await loadedView();
  const cards = view.setup.timelineRows.filter((entry) => entry.kind === 'collaboration').map((entry) => entry.card);
  assert.deepEqual(Object.fromEntries(cards.map((card) => [card.messageId, modules.timeline.collaborationCardKindLabel(card)])),
    { 'answer:answer-first': '最终结果', [`answer:${failed}`]: '执行失败' });
  assert.match(view.html, /执行失败/);
  assert.equal(cards.length, 2);
  const queue = await render(modules.QueuePanel);
  const source = queue.setup.runtimeContinuationSource({ kind: 'subagent', inboxItemId: `${failed}-inbox`, sourceId: failed,
    submissionId: failed, childExecutionId: 'answer-child-execution', childConversationId: 'answer-child', childStatus: 'idle', outcome: 'failed' });
  assert.equal(queue.setup.stateLabel({ id: 'answer-intent', state: 'queued', preview: { version: 3, kind: 'runtime_continuation',
    revisionSeq: '1', sourceTurnId: 'answer-child-2', deliveryId: `${failed}-delivery`, deliveryState: 'pending', phase: 'next_turn', source } }), '子 Agent 执行失败');
});

test('sender receives newly sent message and latest retry state with bounded preview', async () => {
  await database.transaction([conversation('outgoing-sender'), conversation('outgoing-target'), conversation('outgoing-other'), turn('outgoing-turn', 'outgoing-sender')]);
  const body = await cas.ingest(database, `开头 ${'协作😀'.repeat(400)} TAIL_NOT_IN_PREVIEW`, 'text/vnd.limcode.collaboration-message');
  const feed = new kernel.BoundedClientFeed(database);
  const sent = [];
  try {
    const connection = await feed.connect({ activeConversationId: 'outgoing-sender', send: (value) => sent.push(value) });
    const ack = () => feed.acknowledge({ sessionId: connection.sessionId, hostBootId: connection.hostBootId, messageSeq: sent.at(-1).messageSeq });
    ack();
    await database.transaction(envelope('outgoing-message', 'outgoing-sender', 'outgoing-target', body.id, { sourceTurnId: 'outgoing-turn' }));
    await tick();
    const message = sent.at(-1).changes.find((change) => change.type === 'CollaborationMessage');
    assert.equal(Array.from(message.record.text_preview).length, 320);
    assert.doesNotMatch(JSON.stringify(sent.at(-1)), /TAIL_NOT_IN_PREVIEW/);
    assert.equal(sent.at(-1).changes.find((change) => change.id === 'outgoing-message-delivery').record.state, 'pending');
    ack();
    await database.transaction([update('RuntimeDelivery', 'outgoing-message-delivery', { state: 'failed', failure_reason: 'wake-dead-letter:retry', updated_at: NOW }),
      row('RuntimeDelivery', { id: 'outgoing-retry', inbox_item_id: 'outgoing-message-inbox', target_conversation_id: 'outgoing-target', target_turn_id: null,
        phase: 'next_turn', attempt_seq: 2n, retry_of_delivery_id: 'outgoing-message-delivery', state: 'pending', failure_reason: null, created_at: NOW, updated_at: NOW })]);
    await tick();
    assert.equal(sent.at(-1).changes.find((change) => change.id === 'outgoing-retry').record.attempt_seq, '2');
    ack();
    const before = sent.length;
    await database.transaction(envelope('outgoing-foreign', 'outgoing-target', 'outgoing-other', body.id));
    await tick();
    assert.equal(sent.length, before);
  } finally { feed.close(); }
});

test('snapshot byte trimming removes oldest collaboration causal bundle and preserves own queue', async () => {
  const projection = structuredClone((await database.clientProjectionSnapshot(null)).snapshot);
  projection.activeConversationWindow.conversationId = 'trim-self';
  const summary = projection.subagentDeliverySummary;
  const messages = ['trim-new', 'trim-middle', 'trim-old'];
  for (const [index, id] of messages.entries()) {
    const peer = `${id}-peer`;
    summary.collaborationMessages.push({ id, message_seq: String(3 - index), mode: 'message', text_preview: 'x'.repeat(300), created_at: NOW });
    summary.collaborationMessageSourceLinks.push({ id: `${id}-source`, message_id: id, conversation_id: 'trim-self', source_kind: 'tool' });
    summary.collaborationMessageTargetLinks.push({ id: `${id}-target`, message_id: id, conversation_id: peer, inbox_item_id: `${id}-inbox` });
    summary.runtimeDeliveries.push({ id: `${id}-delivery`, inbox_item_id: `${id}-inbox`, target_conversation_id: peer, state: 'pending', attempt_seq: '1' });
    summary.runtimeInboxItems.push({ id: `${id}-inbox`, source_kind: 'collaboration_message', source_id: id, state: 'available' });
    summary.collaborationPeerConversations.push({ id: peer, title: peer, status: 'active' });
  }
  summary.runtimeDeliveries.push({ id: 'trim-own-delivery', inbox_item_id: 'trim-own-inbox', target_conversation_id: 'trim-self', state: 'pending', attempt_seq: '1' });
  summary.runtimeInboxItems.push({ id: 'trim-own-inbox', source_kind: 'child_execution', source_id: 'trim-own-child', state: 'available' });
  // Keep the fixed envelope just below the transport limit; three temporal anchors cross it.
  // This isolates byte-pressure closure without manufacturing hundreds of unrelated queue rows.
  projection.activeConversationWindow.fixedEnvelope = 'x'.repeat(bounds.CLIENT_SNAPSHOT_MAX_BYTES - wireBytes(projection) + 300);
  let commit;
  const sent = [];
  const feed = new kernel.BoundedClientFeed({ binding: database.binding, hostBootId: 'trim-host',
    async externalDataVersion() { return '1'; },
    async clientProjectionSnapshotAndSubscribe(_id, listener) { commit = listener; return { barrier: { snapshotCommitSeq: '1', snapshot: projection }, unsubscribe() {} }; } });
  try {
    const connection = await feed.connect({ activeConversationId: 'trim-self', send: (value) => sent.push(value) });
    const snapshot = sent[0];
    assert.ok(wireBytes(snapshot) <= bounds.CLIENT_SNAPSHOT_MAX_BYTES);
    const kept = snapshot.projections.subagentDeliverySummary;
    assert.deepEqual(kept.collaborationMessages.map((value) => value.id), ['trim-new', 'trim-middle']);
    assert.ok(kept.runtimeDeliveries.some((value) => value.id === 'trim-own-delivery'));
    assert.equal(JSON.stringify(kept).includes('trim-old'), false);
    feed.acknowledge({ ...connection, messageSeq: snapshot.messageSeq });
    commit({ commitSeq: '2', changes: [{ domain: 'RuntimeDelivery', kind: 'upsert', id: 'trim-old-delivery', record: {
      id: 'trim-old-delivery', inbox_item_id: 'trim-old-inbox', target_conversation_id: 'trim-old-peer', state: 'failed', attempt_seq: '1' } }], allocatedSequences: [] });
    await tick();
    assert.equal(sent.length, 1);
  } finally { feed.close(); }
});

test('real SQLite keyset advances through one foreign-only scan before scoped messages', async () => {
  await database.transaction([conversation('page-self'), conversation('page-peer'), conversation('page-other')]);
  const body = await cas.ingest(database, '真实的分页协作正文', 'text/vnd.limcode.collaboration-message');
  await database.transaction(envelope('page-own-old', 'page-self', 'page-peer', body.id));
  // Keep one complete envelope and the real 4096-row global SQL window. Seed the unrelated
  // background in one external transaction so setup emits no thousands of unused feed changes.
  await database.transaction(envelope('page-foreign-0', 'page-other', 'page-peer', body.id));
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./collaboration-history-seed.mjs', import.meta.url)),
    root.binding.paths.databasePath, body.id, String(bounds.CLIENT_COLLABORATION_SCAN_MAX_ROWS - 1), NOW]);
  await database.transaction(envelope('page-own-new', 'page-peer', 'page-self', body.id));
  await database.transaction([update('RuntimeDelivery', 'page-own-old-delivery', { state: 'failed', failure_reason: 'retry', updated_at: NOW }),
    row('RuntimeDelivery', { id: 'page-own-old-retry', inbox_item_id: 'page-own-old-inbox', target_conversation_id: 'page-peer', target_turn_id: null,
      phase: 'next_turn', attempt_seq: 2n, retry_of_delivery_id: 'page-own-old-delivery', state: 'pending', failure_reason: null, created_at: NOW, updated_at: NOW })]);
  const history = new kernel.ClientHistoryReader(database);
  const latest = await history.backwardCollaboration({ conversationId: 'page-self', limit: 1, cursor: { kind: 'message' } });
  assert.deepEqual(latest.records.CollaborationMessage.map((value) => value.id), ['page-own-new']);
  const empty = await history.backwardCollaboration({ conversationId: 'page-self', limit: 1, cursor: latest.nextCursor });
  assert.equal(empty.scannedRows, bounds.CLIENT_COLLABORATION_SCAN_MAX_ROWS);
  assert.equal(empty.records.CollaborationMessage, undefined);
  assert.equal(empty.scanProgress, true);
  assert.ok(BigInt(empty.nextCursor.beforeMessageSeq) < BigInt(latest.nextCursor.beforeMessageSeq));
  const older = await history.backwardCollaboration({ conversationId: 'page-self', limit: 1, cursor: empty.nextCursor });
  assert.deepEqual(older.records.CollaborationMessage.map((value) => value.id), ['page-own-old']);
  assert.deepEqual(older.records.RuntimeDelivery.map((value) => [value.id, value.attempt_seq]), [['page-own-old-retry', '2']]);
  assert.equal(older.records.CollaborationMessageSourceLink[0].message_id, 'page-own-old');
  assert.equal(older.records.CollaborationMessageTargetLink[0].message_id, 'page-own-old');
  assert.equal(older.responseBytes, wireBytes(older));
  assert.ok(older.responseBytes <= bounds.CLIENT_PAGE_MAX_BYTES);
  const native = new NativeDatabase(root.binding.paths.databasePath, { readonly: true });
  try {
    const plan = native.prepare(`EXPLAIN QUERY PLAN WITH bounded AS MATERIALIZED (
      SELECT message.id FROM collaboration_message AS message INDEXED BY ux_collaboration_message_02
      WHERE message.message_seq < @beforeMessageSeq ORDER BY message.message_seq DESC LIMIT @scanLimit)
      SELECT bounded.id FROM bounded WHERE EXISTS (SELECT 1 FROM collaboration_message_source_link AS source
      WHERE source.message_id = bounded.id AND source.conversation_id = @conversationId) OR EXISTS (
      SELECT 1 FROM collaboration_message_target_link AS target WHERE target.message_id = bounded.id AND target.conversation_id = @conversationId)`)
      .all({ beforeMessageSeq: BigInt(latest.nextCursor.beforeMessageSeq), scanLimit: 4096n, conversationId: 'page-self' }).map((value) => value.detail).join(' | ');
    assert.match(plan, /ux_collaboration_message_02 \(message_seq<\?\)/);
    assert.match(plan, /ux_collaboration_message_source_link_01 \(message_id=\?\)/);
    assert.match(plan, /ux_collaboration_message_target_link_01 \(message_id=\?\)/);
  } finally { native.close(); }
});

test('navigation discards late historical replies at Host and client session boundaries', async () => {
  let resolvePage, entered;
  const reading = new Promise((resolve) => { entered = resolve; });
  const sent = [];
  let serial = 0;
  const feed = { async connect(options) {
    const sessionId = `navigation-${++serial}`;
    options.send({ type: 'reliable-kernel.snapshot', sessionId, hostBootId: 'navigation-host', messageSeq: '1', snapshotCommitSeq: '0', projections: {} });
    return { sessionId, hostBootId: 'navigation-host' };
  }, disconnect() {}, acknowledge() {}, requestSnapshot() {} };
  const bridge = new ReliableKernelWebviewFeedBridge(feed, { async read() { assert.fail('unexpected detail read'); } },
    (error) => { throw error; }, undefined, undefined, { backwardCollaboration() {
      entered(); return new Promise((resolve) => { resolvePage = resolve; });
    } });
  const clientId = bridge.attach({ async postMessage(value) { sent.push(structuredClone(value)); return true; } }, { kind: 'mainPanel', conversationId: 'navigation-old' });
  try {
    bridge.reconnect(clientId, 'navigation-old');
    await tick();
    const pending = bridge.handleControl(clientId, { type: 'reliable-kernel.collaboration-history-request', requestId: 'navigation-read',
      sessionId: 'navigation-1', conversationId: 'navigation-old', limit: 20 });
    await reading;
    bridge.reconnect(clientId, 'navigation-new');
    resolvePage({ records: {}, hasMore: false, responseBytes: 0 });
    await pending;
    assert.equal(sent.some((value) => value.type === 'reliable-kernel.collaboration-history-result'), false);
    const state = openUi('navigation-old', { holdHistory: true });
    state.feed.observe({ type: 'reliable-kernel.snapshot', sessionId: 'client-old', hostBootId: 'navigation-host', messageSeq: '1', snapshotCommitSeq: '0',
      projections: { activeConversationWindow: { conversationId: 'navigation-old' } } });
    const request = state.posted.find((value) => value.type === 'reliable-kernel.collaboration-history-request');
    assert.ok(request);
    state.feed.observe({ type: 'reliable-kernel.snapshot', sessionId: 'client-new', hostBootId: 'navigation-host', messageSeq: '1', snapshotCommitSeq: '0',
      projections: { activeConversationWindow: { conversationId: 'navigation-new' } } });
    state.feed.observe({ type: 'reliable-kernel.collaboration-history-result', requestId: request.requestId, sessionId: 'client-old', conversationId: 'navigation-old',
      page: { records: { CollaborationMessage: [{ id: 'retired-message', message_seq: '1', mode: 'message' }] }, hasMore: false, responseBytes: 0 } });
    assert.equal(state.feed.collaborationHistoryConversationId, 'navigation-new');
    assert.deepEqual(state.feed.collaborationHistoryRecords, {});
  } finally { bridge.detach(clientId); bridge.close(); }
});

test('actual MessageList windows mixed timeline by proven position and retains recent messages', async () => {
  const state = openUi('timeline-self');
  const feed = state.feed;
  feed.projections.activeConversationWindow = { conversationId: 'timeline-self' };
  feed.records = {
    Conversation: { peer: { id: 'timeline-peer', title: '调研对话', status: 'active' } },
    Turn: { turn: { id: 'timeline-turn', conversation_id: 'timeline-self', status: 'terminated', created_at: NOW } },
    Message: byId(Array.from({ length: 35 }, (_, index) => ({ id: `timeline-m${index + 1}`, conversation_id: 'timeline-self', message_seq: String(index + 1),
      revision_id: `timeline-revision-${index + 1}`, role: 'user', created_at: NOW }))),
    MessageTurnLink: byId(Array.from({ length: 35 }, (_, index) => ({ id: `timeline-link-${index + 1}`, message_id: `timeline-m${index + 1}`, turn_id: 'timeline-turn', role: 'user' }))),
    CollaborationMessage: { positioned: { id: 'timeline-positioned', message_seq: '1', mode: 'message', text_preview: '继续处理' },
      older: { id: 'timeline-older', message_seq: '2', mode: 'message', text_preview: '较早协作' },
      unbound: { id: 'timeline-unbound', message_seq: '3', mode: 'message', text_preview: '位置没有证据', created_at: '2020-01-01T00:00:00.000Z' } },
    CollaborationMessageSourceLink: byId(['positioned', 'older', 'unbound'].map((id) => ({ id: `timeline-${id}-source`, message_id: `timeline-${id}`, conversation_id: 'timeline-peer', source_kind: 'tool' }))),
    CollaborationMessageTargetLink: byId(['positioned', 'older', 'unbound'].map((id) => ({ id: `timeline-${id}-target`, message_id: `timeline-${id}`, conversation_id: 'timeline-self', inbox_item_id: `timeline-${id}-inbox` }))),
    RuntimeDelivery: {
      positioned: { id: 'timeline-positioned-delivery', inbox_item_id: 'timeline-positioned-inbox', target_conversation_id: 'timeline-self', target_turn_id: 'timeline-turn', attempt_seq: '1', state: 'consumed' },
      older: { id: 'timeline-older-delivery', inbox_item_id: 'timeline-older-inbox', target_conversation_id: 'timeline-self', target_turn_id: 'timeline-unloaded-turn', attempt_seq: '1', state: 'consumed' },
      unbound: { id: 'timeline-unbound-delivery', inbox_item_id: 'timeline-unbound-inbox', target_conversation_id: 'timeline-self', target_turn_id: null, attempt_seq: '1', state: 'failed' } },
    RuntimeDeliveryTimelineLink: { positioned: { id: 'timeline-position', delivery_id: 'timeline-positioned-delivery', conversation_id: 'timeline-self',
      predecessor_message_id: 'timeline-m34', predecessor_message_seq: '34', exchange_seq: '1' } }
  };
  const view = await render();
  assert.equal(view.setup.visibleTimelineRows.length, 30);
  assert.match(view.html, /data-timeline-row-key="timeline-m35"/);
  assert.doesNotMatch(view.html, /data-timeline-row-key="timeline-m1"/);
  const ids = view.setup.timelineRows.map((entry) => entry.id);
  assert.equal(ids.indexOf('collaboration:timeline-positioned'), ids.indexOf('timeline-m34') + 1);
  assert.equal(ids.indexOf('timeline-m35'), ids.indexOf('collaboration:timeline-positioned') + 1);
  const unbound = view.setup.timelineRows.find((entry) => entry.id === 'collaboration:timeline-unbound').card;
  assert.equal(unbound.placement, 'unbound');
  assert.match(view.html, /位置待确认/);
  assert.equal(ids[0], 'collaboration:timeline-older');
  view.setup.showEarlierSegment();
  await flushFrames();
  assert.equal(view.setup.visibleTimelineRows.some((entry) => entry.id === 'timeline-m1'), true);
});

test('deleted peer snapshot updates card and queue labels while received body remains readable', async () => {
  await database.transaction([conversation('deleted-self'), conversation('deleted-peer', '会被删除的对话'), turn('deleted-turn', 'deleted-self')]);
  const body = await cas.ingest(database, '已经收到的协作正文', 'text/vnd.limcode.collaboration-message');
  const peerBody = await cas.ingest(database, JSON.stringify({ role: 'user', parts: [{ text: '同伴的消息' }] }), 'application/vnd.limcode.message+json');
  await database.transaction([
    ...envelope('deleted-message', 'deleted-peer', 'deleted-self', body.id, { turnId: 'deleted-turn', state: 'consumed' }),
    row('Message', { id: 'deleted-peer-message', created_at: NOW, updated_at: NOW, deleted_at: null }),
    row('MessageRevision', { id: 'deleted-peer-revision', message_id: 'deleted-peer-message', revision_seq: 1n, role: 'user', content_object_id: peerBody.id, created_at: NOW }),
    row('MessageCurrentRevisionLink', { id: 'deleted-peer-current', message_id: 'deleted-peer-message', revision_id: 'deleted-peer-revision', updated_at: NOW }),
    row('MessagePartOfConversation', { id: 'deleted-peer-member', conversation_id: 'deleted-peer', message_id: 'deleted-peer-message', message_seq: 1n, created_at: NOW })
  ]);
  const state = openUi('deleted-self', { details: true });
  state.feed.observe(await snapshot('deleted-self'));
  assert.match((await loadedView()).html, /来自对话 会被删除的对话/);
  const live = new kernel.BoundedClientFeed(database);
  let resolveDeletion;
  const receivedDeletion = new Promise((resolve) => { resolveDeletion = resolve; });
  const sent = [];
  try {
    const connection = await live.connect({ activeConversationId: 'deleted-self', send: (frame) => {
      sent.push(frame); if (sent.length > 1) resolveDeletion(frame);
    } });
    live.acknowledge({ ...connection, messageSeq: sent[0].messageSeq });
    await new kernel.ConversationDeletionControlPlane(database).delete('deleted-peer');
    const changed = await receivedDeletion;
    assert.equal(changed.type, 'reliable-kernel.snapshot');
    state.feed.observe(changed);
    assert.match((await loadedView()).html, /来自已删除的对话/);
    const queue = await render(modules.QueuePanel);
    assert.equal(queue.setup.collaborationSourceLabel('deleted-peer'), '来自已删除的对话');
    const { CollaborationControlPlane } = require(path.join(compiled, 'backend/reliableKernel/collaborationControlPlane.js'));
    const { RuntimeDeliveryControlPlane } = require(path.join(compiled, 'backend/reliableKernel/answerDelivery.js'));
    const collaboration = new CollaborationControlPlane(database, cas, new RuntimeDeliveryControlPlane(database, cas));
    assert.equal((await collaboration.readMessage({ conversationId: 'deleted-self', messageId: 'deleted-message' })).text, '已经收到的协作正文');
  } finally { live.close(); }
});

test('transient sequence gap keeps contiguous text and atomically adopts cumulative snapshot', () => {
  const state = openUi('transient-self');
  state.feed.observe({ type: 'reliable-kernel.snapshot', sessionId: 'transient-session', hostBootId: 'transient-host', navigationGeneration: '7',
    messageSeq: '1', snapshotCommitSeq: '0', projections: { activeConversationWindow: { conversationId: 'transient-self' } } });
  const item = (fromStreamSeq, streamSeq, text) => ({ turnId: 'transient-turn', modelRequestId: 'transient-request', requestSeq: '1',
    providerId: 'provider', modelId: 'model', attemptSeq: '1', socketGeneration: '1', afterCommitSeq: '0', fromStreamSeq, observedAt: NOW,
    event: { kind: 'output_delta', streamSeq, content: { type: 'text_delta', text } } });
  const batch = (deliveryId, events) => ({ type: 'reliable-kernel.transient-batch', deliveryId, sessionId: 'transient-session', hostBootId: 'transient-host',
    navigationGeneration: '7', conversationId: 'transient-self', events });
  state.feed.observe(batch('transient-a', [item('1', '1', 'A')]));
  state.feed.observe(batch('transient-c', [item('3', '3', 'C')]));
  assert.equal(state.feed.transientModelRequests['transient-request'].text, 'A');
  assert.equal(state.feed.transientModelRequests['transient-request'].recovering, true);
  assert.equal(state.posted.some((value) => value.type === 'reliable-kernel.transient-ack' && value.deliveryId === 'transient-c'), false);
  const request = state.posted.find((value) => value.type === 'reliable-kernel.transient-snapshot-request');
  assert.equal(request.afterStreamSeq, '1');
  state.feed.observe({ type: 'reliable-kernel.transient-snapshot', deliveryId: 'transient-replay', requestId: request.requestId,
    sessionId: 'transient-session', hostBootId: 'transient-host', navigationGeneration: '7', conversationId: 'transient-self',
    turnId: 'transient-turn', modelRequestId: 'transient-request', requestSeq: '1', providerId: 'provider', modelId: 'model', attemptSeq: '1',
    socketGeneration: '1', afterCommitSeq: '0', headStreamSeq: '3', observedAt: NOW, events: [item('1', '3', 'ABC')] });
  assert.equal(state.feed.transientModelRequests['transient-request'].text, 'ABC');
  assert.equal(state.feed.transientModelRequests['transient-request'].recovering, false);
  assert.ok(state.posted.some((value) => value.type === 'reliable-kernel.transient-ack' && value.deliveryId === 'transient-replay' && value.heads[0].streamSeq === '3'));
});

test('tool preview hands off only when durable message body and matching tool facts are ready', () => {
  const requests = { request: { conversationId: 'handoff-self', turnId: 'handoff-turn', modelRequestId: 'request', requestSeq: '1',
    providerId: 'provider', modelId: 'model', afterCommitSeq: '1', streamSeq: '3', text: '', thought: '',
    outputParts: [{ id: 'handoff-provider-call', functionCall: { name: 'read', args: { path: 'a.ts' } } }],
    toolCalls: [{ id: 'preview:handoff-provider-call', callId: 'handoff-provider-call', name: 'read', argumentsText: '{"path":"a.ts"}', final: true, createdAt: 1, updatedAt: 2 }],
    status: 'completed', startedAt: 1, updatedAt: 2 } };
  const records = { ModelRequest: { request: { id: 'request', turn_id: 'handoff-turn', request_seq: '1', status: 'terminal', terminal_state: 'completed' } },
    ModelRequestMessageLink: { link: { id: 'handoff-link', model_request_id: 'request', message_id: 'handoff-message' } },
    Message: { 'handoff-message': { id: 'handoff-message', revision_id: 'handoff-revision' } },
    ToolCall: { call: { id: 'handoff-call', turn_id: 'handoff-turn', tool_name: 'read', status: 'queued' } } };
  const ready = { 'message-content:handoff-revision': { status: 'ready', text: '{}', totalBytes: 2 } };
  modules.transient.reconcileReliableTransientRequests(requests, records, ready);
  assert.ok(requests.request, 'body hydration alone retains the only complete tool preview');
  assert.equal(modules.preview.shouldKeepTransientToolCallPreview(records.ToolCall.call, undefined), true);
  records.ToolCallSourceLink = { source: { id: 'handoff-source', tool_call_id: 'handoff-call', model_request_id: 'request',
    message_id: 'handoff-message', provider_call_id: 'handoff-provider-call', provider_ordinal: 0 } };
  modules.transient.reconcileReliableTransientRequests(requests, records, {});
  assert.ok(requests.request, 'matching tool facts alone retain the preview until body hydration');
  records.ToolCall.call.status = 'executing';
  assert.equal(modules.preview.shouldKeepTransientToolCallPreview(records.ToolCall.call, undefined), false);
  modules.transient.reconcileReliableTransientRequests(requests, records, ready);
  assert.equal(requests.request, undefined);
});

test('slow ACK coalesces visible commits without sequence gaps or snapshot fallback', async () => {
  await database.transaction([conversation('ack-self')]);
  const sent = [];
  const feed = new kernel.BoundedClientFeed(database);
  try {
    const connection = await feed.connect({ send: (value) => sent.push(value) });
    await database.transaction([update('Conversation', 'ack-self', { title: 'first', updated_at: NOW })]);
    await database.transaction([update('Conversation', 'ack-self', { title: 'latest', updated_at: NOW })]);
    const queued = feed.inspectSession(connection.sessionId);
    assert.equal(queued.snapshotRequired, false);
    assert.equal(queued.queuedBatches, 1);
    assert.equal(queued.nextMessageSeq, '2');
    feed.acknowledge({ ...connection, messageSeq: '1' });
    assert.equal(sent.length, 2);
    assert.equal(sent[1].messageSeq, '2');
    assert.equal(sent[1].type, 'reliable-kernel.changes');
    assert.equal(sent[1].changes.length, 1);
    assert.equal(sent[1].changes[0].record.title, 'latest');
    const first = shared.applyReliableKernelDataMessage(shared.createEmptyReliableKernelClientState(), sent[0]);
    const latest = shared.applyReliableKernelDataMessage(first.state, sent[1]);
    assert.equal(latest.snapshotRequired, false);
    assert.equal(latest.state.records.Conversation['ack-self'].title, 'latest');
  } finally { feed.close(); }
});

test('CAS detail pages reconstruct complete bodies and reuse batched immutable metadata', async () => {
  const first = await cas.ingest(database, JSON.stringify({ role: 'user', parts: [{ text: '中文😀'.repeat(50) }] }), 'application/vnd.limcode.message+json');
  const second = await cas.ingest(database, JSON.stringify({ role: 'user', parts: [{ text: '第二份正文'.repeat(50) }] }), 'application/vnd.limcode.message+json');
  await database.transaction([row('Message', { id: 'detail-first', created_at: NOW, updated_at: NOW, deleted_at: null }),
    row('Message', { id: 'detail-second', created_at: NOW, updated_at: NOW, deleted_at: null }),
    row('MessageRevision', { id: 'detail-first-revision', message_id: 'detail-first', revision_seq: 1n, role: 'user', content_object_id: first.id, created_at: NOW }),
    row('MessageRevision', { id: 'detail-second-revision', message_id: 'detail-second', revision_seq: 1n, role: 'user', content_object_id: second.id, created_at: NOW })]);
  const reads = [];
  const observedDatabase = { snapshot(requests) { reads.push(requests.map((value) => `${value.domain}:${value.id}`)); return database.snapshot(requests); } };
  const reader = new kernel.ClientDetailReader(observedDatabase, cas);
  const ids = ['detail-first-revision', 'detail-second-revision'];
  const initial = await Promise.all(ids.map((recordId) => reader.read({ kind: 'message-content', recordId, offset: 0, maxBytes: 64 })));
  assert.equal(reads.length, 2);
  assert.deepEqual(reads[0], ids.map((id) => `MessageRevision:${id}`));
  assert.deepEqual(reads[1], [first, second].map((metadata) => `ContentObject:${metadata.id}`));
  const complete = await Promise.all(initial.map(async (page, index) => {
    const pieces = [Buffer.from(page.chunk, 'base64')];
    while (page.hasMore) {
      const offset = page.nextOffset;
      page = await reader.read({ kind: 'message-content', recordId: ids[index], offset, maxBytes: 64 });
      assert.ok(!page.hasMore || page.nextOffset > offset);
      assert.ok(page.responseBytes <= bounds.CLIENT_DETAIL_MAX_RESPONSE_BYTES);
      pieces.push(Buffer.from(page.chunk, 'base64'));
    }
    return Buffer.concat(pieces);
  }));
  assert.deepEqual(complete, await Promise.all([first, second].map((metadata) => cas.read(metadata))));
  assert.equal(reads.length, 2, 'continuation pages reuse the immutable metadata prepared once');
});
