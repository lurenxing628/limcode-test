import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createUiWorkflowFixture, persistedComposer, viewState } from './ui-workflow-fixture.mjs';

let ui;
before(async () => { ui = await createUiWorkflowFixture(); });
after(async () => { await ui?.close(); });
const part = name => ({ inlineData: { mimeType: 'text/plain', name, data: 'bWluZQ==', storage: 'embedded', status: 'available', sizeBytes: 4 } });
const message = (id, revisionId = 'revision-1') => ({ id, revisionId, conversationId: 'conversation-1', role: 'user', status: 'done', seq: 2,
  createdAt: '2026-10-13T00:00:00Z', content: { role: 'user', parts: [{ text: `text-${id}` }, part('original.txt')] } });
const tick = async () => { for (let i = 0; i < 4; i++) await ui.vue.nextTick(); };
const payloads = type => ui.posted.filter(item => item.type === type);

test('输入：替换编辑使旧FileReader失效，新草稿没有旧附件', async t => {
  const h = ui.composer(t);
  h.ui.startEditMessage(message('old'), 1); await tick();
  const read = h.read('old.txt');
  h.ui.cancelEditMode(); h.ui.startEditMessage(message('new'), 1); await tick();
  read.finish(); await read.pending;
  assert.deepEqual(h.view.selectedAttachments.map(part => part.inlineData.name), ['original.txt']);
  assert.equal(h.ui.composerDraft, 'text-new');
});

test('输入：设置保存屏障只发送当前确切草稿，明确替换撤销旧发送', async t => {
  const h = ui.composer(t); h.ui.setComposerDraft('first draft');
  let release; h.profiles.awaitSavedForScope = () => new Promise(resolve => { release = resolve; });
  const old = h.view.submit(); assert.deepEqual(h.sent(), []);
  h.ui.replaceChatDraft('first draft'); release(); await old;
  assert.deepEqual(h.sent(), []);
  const read = h.read('current.txt'); read.finish(); await read.pending;
  const current = h.view.submit(); release(); await current;
  assert.equal(h.sent().length, 1);
  assert.equal(h.sent()[0].payload.text, 'first draft');
  assert.equal(h.sent()[0].payload.content.parts[1].inlineData.name, 'current.txt');
  assert.doesNotThrow(() => structuredClone(h.sent()[0]));
});

test('输入：顺序读取多个文件与键入共享草稿，发送确认后新草稿不接受旧附件', async t => {
  const h = ui.composer(t); h.ui.setComposerDraft('typed before reading');
  const pending = h.view.onPasteFiles(['first.txt', 'second.txt'].map(name => ({ name, type: 'text/plain', size: 10 })));
  ui.readers.at(-1).finish(); await tick();
  h.ui.setComposerDraft('typed during reading'); ui.readers.at(-1).finish(); await pending;
  assert.deepEqual(h.view.selectedAttachments.map(item => item.inlineData.name), ['first.txt', 'second.txt']);
  const late = h.read('late.txt'); await h.view.submit(); const sent = h.sent().at(-1);
  h.ack({ requestId: sent.id, commandId: sent.payload.command.commandId, requestType: sent.type }); await tick();
  assert.equal(h.ui.chatDraft, '');
  h.ui.setComposerDraft('next draft'); late.finish(); await late.pending;
  assert.equal(h.ui.chatDraft, 'next draft'); assert.deepEqual(h.view.selectedAttachments, []);
});

test('输入：pagehide立即保存最后文字和附件，reload精确恢复', async t => {
  const state = viewState(), first = persistedComposer(t, ui, state);
  first.ui.setComposerDraft('last keystrokes'); first.attachments.value.chat = [part('draft.txt')]; await tick();
  first.page.dispatchEvent(new Event('pagehide')); first.reload();
  const reopened = persistedComposer(t, ui, state, { conversationId: 'conversation-1' }); await tick();
  assert.equal(reopened.ui.chatDraft, 'last keystrokes');
  assert.deepEqual(reopened.attachments.value.chat.map(item => item.inlineData.name), ['draft.txt']);
});

test('输入：已提交或已清空的草稿reload不再次恢复', async t => {
  const state = viewState();
  state.write({ chat: { draft: 'already submitted', attachments: [], submitted: { commandId: 'submitted', conversationId: 'conversation-1' } }, savedAt: 1 });
  const h = persistedComposer(t, ui, state, { conversationId: 'conversation-1', pendingInputCommands: [{ commandId: 'submitted', conversationId: 'conversation-1' }] });
  await tick(); assert.equal(h.ui.chatDraft, ''); assert.equal(state.read(), undefined);
  h.ui.setComposerDraft('next draft'); h.persistence.flush();
  h.ui.clearChatDraft(); await tick(); h.reload();
  assert.equal(persistedComposer(t, ui, state).ui.chatDraft, '');
});

test('输入：相同修订的编辑等待消息加载后恢复文字、附件和删除范围', async t => {
  const state = viewState(), original = message('editable');
  const first = persistedComposer(t, ui, state, { conversationId: 'conversation-1', messages: [original] });
  first.ui.startEditMessage(original, 2); await tick();
  first.ui.setComposerDraft('edited text'); first.attachments.value.edit = [part('edited.txt')]; first.persistence.flush(); first.reload();
  const reopened = persistedComposer(t, ui, state); reopened.conversationId.value = 'conversation-1'; await tick();
  assert.equal(reopened.ui.isEditing, false);
  reopened.messages.value = [original]; await tick();
  assert.equal(reopened.ui.composerDraft, 'edited text');
  assert.equal(reopened.ui.editingMessage.deleteCount, 2);
  assert.equal(reopened.attachments.value.edit[0].inlineData.name, 'edited.txt');
});

test('输入：其它窗口换了消息修订，旧编辑被放弃并保留有效聊天草稿', async t => {
  const state = viewState();
  state.write({ chat: { draft: 'unsent chat', attachments: [] }, edit: { kind: 'message', conversationId: 'conversation-1',
    messageId: 'editable', revisionId: 'old-revision', deleteCount: 1, draft: 'stale edit', attachments: [] }, savedAt: 1 });
  const h = persistedComposer(t, ui, state, { conversationId: 'conversation-1', messages: [message('editable', 'new-revision')] });
  await tick(); assert.equal(h.ui.isEditing, false); assert.equal(h.discarded(), 1);
  assert.equal(h.ui.chatDraft, 'unsent chat'); assert.equal(state.read().edit, undefined);
});

test('输入：send-as-new需要确认覆盖草稿，取消保留原内容，确认同步替换附件', async t => {
  const h = ui.composer(t); h.ui.setComposerDraft('own unsent text');
  const own = h.read('own.txt'); own.finish(); await own.pending;
  h.ui.prefillChatDraft(message('steering')); await tick();
  assert.equal(h.ui.chatDraft, 'own unsent text'); assert.ok(h.view.chatDraftPrefill.pending.value);
  h.view.chatDraftPrefill.cancel(); assert.equal(h.ui.chatDraft, 'own unsent text');
  h.ui.prefillChatDraft(message('steering')); await tick(); h.view.chatDraftPrefill.confirm(); await tick();
  assert.equal(h.ui.chatDraft, 'text-steering');
  assert.deepEqual(h.view.selectedAttachments.map(item => item.inlineData.name), ['original.txt']);
});

test('输入：持久receipt先于ACK只确认一次，同回合多输入按确切正文撤下本地输入', async t => {
  const h = ui.stores(t), chat = h.useChat(), sent = chat.sendMessage('input awaiting body');
  assert.equal(ui.posted.at(-1).id, sent.requestId); assert.doesNotThrow(() => structuredClone(ui.posted.at(-1)));
  h.feed.records = { ConversationCommandReceipt: { receipt: { id: 'receipt', command_id: sent.commandId, conversation_id: h.conversationId } } };
  await tick(); assert.ok(chat.currentTurnInputAcknowledgements.value[sent.commandId]);
  chat.dismissTurnInputAcknowledgement(sent.commandId); h.ack(sent); await tick();
  assert.equal(chat.currentTurnInputAcknowledgements.value[sent.commandId], undefined);
  h.message('turn', 'batch-other', 'unrelated'); h.body('unrelated', 'other message'); await tick();
  assert.equal(chat.currentTurnInputEchoes.value[0].displayTarget, undefined);
  h.message(); await tick();
  assert.equal(chat.currentTurnInputEchoes.value[0].displayTarget.messageId, 'input');
  assert.equal(chat.currentTurnInputEchoes.value[0].submission.text, 'input awaiting body');
  const shell = await h.render(ui.messageList); assert.ok(shell.html.includes('input awaiting body'));
  h.body('revision', 'committed input'); await tick();
  assert.equal(chat.currentTurnInputEchoes.value.length, 0);
  assert.ok((await h.render(ui.messageList)).html.includes('committed input'));
});

test('输入：busy提交经admitted:false才进入真实等待队列', async t => {
  const h = ui.stores(t), chat = h.useChat();
  h.feed.records = { Turn: { busy: { id: 'busy', conversation_id: h.conversationId, status: 'active' } } };
  const sent = chat.sendMessage('queued input'); assert.equal(sent.requestType, ui.protocol.TurnEnqueue);
  assert.equal(chat.currentTurnInputEchoes.value.length, 0);
  assert.equal((await h.render(ui.queue)).setup.queueGroups[0].id, 'submissions');
  h.ack(sent, { admitted: false, turnId: undefined, intentId: 'intent' });
  h.feed.records.TurnIntent = { intent: { id: 'intent', conversation_id: h.conversationId, state: 'queued', turn_id: null, created_at: '2026-10-13T00:00:00Z' } };
  assert.equal((await h.render(ui.queue)).setup.queueGroups[0].items[0].state, 'queued');
});

test('输入：未确认重试复用command，明确拒绝保留失败输入且新提交可继续', async t => {
  const h = ui.stores(t), chat = h.useChat(), sent = chat.sendMessage('not confirmed');
  const timer = [...ui.timers].find(([, value]) => value.ms === 30_000); assert.ok(timer);
  ui.timers.delete(timer[0]); timer[1].fn(); await tick();
  assert.ok(chat.retryTurnInputSubmission(sent.commandId));
  assert.ok(payloads(ui.protocol.TurnStart).filter(item => item.id === sent.requestId).every(item => item.payload.command.commandId === sent.commandId));
  h.ack(sent, { status: 'rejected', admitted: undefined, message: 'temporary refusal' }); await tick();
  assert.equal(chat.currentTurnInputFailure.value.text, 'not confirmed');
  assert.equal(chat.currentTurnInputAcknowledgements.value[sent.commandId], undefined);
  assert.ok(chat.sendMessage('new input'));
});

test('输入：真实fork点击只接受匹配结果并打开当前来源的分支', async t => {
  const h = ui.stores(t), chat = h.useChat(), start = ui.posted.length;
  assert.equal(chat.forkConversationFrom(h.conversationId, 'message-a', 'revision-a'), true);
  const request = ui.posted.slice(start).find(item => item.type === ui.protocol.ConversationFork);
  h.emit({ type: ui.protocol.ConversationForkResult, correlationId: 'other-request', payload: { ...request.payload,
    commandId: 'other-command', conversationId: 'branch', status: 'accepted' } });
  assert.equal(ui.posted.slice(start).filter(item => item.type === ui.protocol.ConversationOpen).length, 0);
  h.emit({ type: ui.protocol.ConversationForkResult, correlationId: request.id, payload: { ...request.payload,
    commandId: request.payload.command.commandId, conversationId: 'branch', status: 'accepted' } });
  assert.deepEqual(ui.posted.slice(start).filter(item => item.type === ui.protocol.ConversationOpen).map(item => item.payload), [{ conversationId: 'branch' }]);
});

test('输入：导航后迟到fork结果只作来源提示，失去分支关系后不再提供打开', async t => {
  const h = ui.stores(t), chat = h.useChat(), start = ui.posted.length;
  const origin = h.conversationId; chat.forkConversationFrom(origin, 'message-a', 'revision-a');
  const request = ui.posted.slice(start).find(item => item.type === ui.protocol.ConversationFork);
  h.feed.projections.activeConversationWindow = { conversationId: 'elsewhere' }; await tick();
  h.emit({ type: ui.protocol.ConversationForkResult, correlationId: request.id, payload: { ...request.payload,
    commandId: request.payload.command.commandId, conversationId: 'branch', status: 'accepted' } });
  assert.equal(ui.posted.slice(start).filter(item => item.type === ui.protocol.ConversationOpen).length, 0);
  h.feed.records.ConversationBranchLink = { link: { id: 'link', source_conversation_id: origin, target_conversation_id: 'branch' } };
  h.feed.projections.activeConversationWindow = { conversationId: origin }; await tick();
  assert.equal(chat.conversationForkReadyNotice.value.conversationId, 'branch');
  delete h.feed.records.ConversationBranchLink.link; await tick(); assert.equal(chat.conversationForkReadyNotice.value, undefined);
  const fork = await ui.load('composables/forkRequestLifecycle.ts');
  assert.equal(fork.forkResultNavigation({ ...request.payload, actionId: request.payload.command.commandId }, { sourceConversationId: origin, conversationId: 'branch' },
    { clickedThisSession: false, activeConversationId: origin }).kind, 'notice');
});

test('输入：等待队列的显式拖动保留持久身份和位置', async t => {
  const h = ui.stores(t); h.useChat();
  const intent = id => ({ id, conversation_id: h.conversationId, state: 'queued', turn_id: null, created_at: '2026-10-13T00:00:00Z' });
  for (const [id, position] of [['first', '1'], ['second', '2']]) {
    const text = JSON.stringify({ version: 3, kind: 'guidance', text: id, editorText: id, position, hold: 'none', revisionSeq: position });
    h.feed.details[`turn-intent-preview:${id}`] = { status: 'ready', text, totalBytes: text.length };
  }
  h.feed.records = { TurnIntent: { second: intent('second'), first: intent('first') } };
  const { setup } = await h.render(ui.queue);
  assert.deepEqual(setup.waitingItems.map(item => item.id), ['first', 'second']);
  const event = { preventDefault() {}, dataTransfer: { setData() {}, getData: () => 'second' } };
  setup.startDrag(event, setup.waitingItems[1]); setup.dropOn(event, setup.waitingItems[0]);
  assert.deepEqual(payloads(ui.protocol.GuidanceReorder).at(-1).payload.items,
    [{ intentId: 'second', expectedRevisionSeq: '2' }, { intentId: 'first', expectedRevisionSeq: '1' }]);
});

import path from 'node:path';
import { createRequire } from 'node:module';
import { createRolloverFixture, ids, windowEvictions } from './ui-runtime-feed-fixture.mjs';
import { createTaskRuntime } from './ui-task-feed-fixture.mjs';
import { ready, ITEM_ONE, ITEM_TWO, ITEM_LIVE, nativeShellRecords, nativeTransient, twoSteeringChain,
  STEER_RECEIPT, SECOND_STEER_RECEIPT } from './ui-conversation-projection-fixture.mjs';
const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiled, 'backend/reliableKernel/index.js'));
const { ReliableKernelWebviewFeedBridge } = require(path.join(compiled, 'backend/reliableKernel/webviewFeedBridge.js'));
const { buildCurrentTurnTaskProjection, readCurrentTurnTaskCard } = require(path.join(compiled, 'backend/reliableKernel/currentTurnTaskProjection.js'));
const immediate = () => new Promise(resolve => setImmediate(resolve));
async function when(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('production event did not settle'); await immediate(); }
}

// The injected feed is the Extension Host boundary of the real Webview bridge. It supplies
// committed wire frames only; visibility, replay, ACK deadlines and client retirement run in production.
function boundaryFeed() {
  const connections = [], disconnected = [];
  return { connections, disconnected,
    async connect(options) {
      const sessionId = `session-${connections.length + 1}`; connections.push({ ...options, sessionId });
      options.send({ type: 'reliable-kernel.snapshot', sessionId, hostBootId: 'ui-host', messageSeq: '1',
        snapshotCommitSeq: '0', records: {}, projections: {}, projectionSpec: {} });
      return { sessionId, hostBootId: 'ui-host' };
    }, disconnect(id) { disconnected.push(id); }, acknowledge() {}, requestSnapshot() {} };
}

test('Feed：运行Process固定源bundle，结束后原子滚出全部关系且历史事实仍完整', async t => {
  const h = await createRolloverFixture('ui-running', { runningProcessOnFirst: true }); t.after(() => h.close());
  await h.append(201); const first = ids(h.prefix, 1), processId = `${h.prefix}-process-001`;
  assert.ok(h.state.records.Message[first.message]); assert.ok(h.state.records.Process[processId]);
  assert.equal(Object.keys(h.state.records.Message).length, 201);
  await h.finishProcess(); const frame = await h.append(202);
  assert.equal(frame.type, 'reliable-kernel.changes');
  const removed = windowEvictions(frame); assert.ok(removed.length >= 7);
  assert.ok(removed.some(change => change.id === first.message));
  assert.equal(h.state.records.Message[first.message], undefined);
  assert.equal(h.state.records.ModelRequest[first.request], undefined);
  assert.equal(h.state.records.ToolCall[first.tool], undefined);
  assert.equal(h.state.records.Process[processId], undefined);
  assert.ok(h.state.records.Message[ids(h.prefix, 202).message]);
  const page = await h.history.visibleMessages({ conversationId: h.conversationId, beforeMessageSeq: '2', beforeId: ids(h.prefix, 2).message, limit: 20 });
  assert.equal(page.records.Message[0].id, first.message);
  assert.equal(page.records.ModelRequest[0].id, first.request);
  assert.equal(page.records.ToolCall[0].id, first.tool);
  assert.equal(h.frames.filter(frame => frame.type === 'reliable-kernel.snapshot').length, 1);
});

test('Feed：等待Ready，隐藏时断开，显现后从新的session读取', async t => {
  const feed = boundaryFeed(), posted = [];
  const bridge = new ReliableKernelWebviewFeedBridge(feed, { async read() { throw new Error('unexpected detail request'); } }, error => { throw error; });
  t.after(() => bridge.close());
  const id = bridge.attach({ async postMessage(message) { posted.push(structuredClone(message)); return true; } },
    { kind: 'mainPanel', panelId: 'ui-panel', conversationId: 'ui-conversation' });
  await immediate(); assert.equal(feed.connections.length, 0);
  bridge.setVisible(id, false); bridge.reconnect(id); await immediate(); assert.equal(feed.connections.length, 0);
  bridge.setVisible(id, true); await when(() => posted.length > 0); const first = feed.connections[0];
  bridge.setVisible(id, false); await when(() => feed.disconnected.includes(first.sessionId));
  const hiddenCount = posted.length; first.onFailure(new Error('retired session failure')); await immediate();
  assert.equal(posted.length, hiddenCount);
  bridge.setVisible(id, true); await when(() => feed.connections.length === 2);
  assert.notEqual(feed.connections[1].sessionId, first.sessionId);
});

test('Feed：拒收transient批次后重送有界累计事实，重放保留原参数', async t => {
  const feed = boundaryFeed(), posted = []; let reject = true;
  const bridge = new ReliableKernelWebviewFeedBridge(feed, { async read() { throw new Error('unexpected detail request'); } }, () => {},
    undefined, undefined, undefined, { transientAckTimeoutMs: 100, maxTransientSnapshotResends: 1 });
  t.after(() => bridge.close());
  const id = bridge.attach({ async postMessage(message) {
    posted.push(structuredClone(message));
    if (message.type === 'reliable-kernel.transient-batch' && reject) { reject = false; return false; }
    return true;
  } }, { kind: 'mainPanel', panelId: 'ui-replay', conversationId: 'replay-conversation' });
  bridge.reconnect(id); await when(() => posted.some(frame => frame.type === 'reliable-kernel.snapshot'));
  bridge.broadcastTransient({ conversationId: 'replay-conversation', turnId: 'replay-turn', modelRequestId: 'replay-request',
    requestSeq: '1', providerId: 'provider', modelId: 'model', attemptSeq: '1', socketGeneration: '1', afterCommitSeq: '0',
    observedAt: '2026-10-13T00:00:00Z', event: { kind: 'output_delta', streamSeq: '1', content: {
      type: 'tool_call_delta', calls: [{ id: 'call', name: 'write', argumentsDelta: '{"path":"a"}' }] } } });
  await when(() => !reject && posted.some(frame => frame.type === 'reliable-kernel.transient-snapshot' && frame.modelRequestId === 'replay-request'));
  const replay = posted.find(frame => frame.type === 'reliable-kernel.transient-snapshot' && frame.modelRequestId === 'replay-request');
  assert.equal(replay.headStreamSeq, '1'); assert.equal(replay.events[0].event.content.calls[0].argumentsDelta, '{"path":"a"}');
});

test('时间线：原生早Revision保留进行中的item，终态才替换为持久聚合', async () => {
  const { projectReliableConversation: project } = await ui.load('domain/reliableConversationProjection.ts');
  const records = nativeShellRecords('streaming'), input = { conversationId: 'conversation-a', records,
    details: { 'message-content:revision-a': ready(JSON.stringify({ role: 'model', parts: [ITEM_TWO] })) },
    transientModelRequests: nativeTransient([ITEM_ONE, ITEM_LIVE]) };
  const live = project(input); assert.equal(live.messages.length, 1);
  assert.deepEqual(live.messages[0].content.parts, [ITEM_ONE, ITEM_TWO, ITEM_LIVE]);
  records.ModelRequest['request-a'] = { ...records.ModelRequest['request-a'], status: 'terminal', terminal_state: 'completed' };
  input.details['message-content:revision-a'] = ready(JSON.stringify({ role: 'model', parts: [ITEM_ONE, ITEM_TWO] }));
  assert.deepEqual(project(input).messages[0].content.parts, [ITEM_ONE, ITEM_TWO]);
});

test('时间线：连续steer只按已证明的边界切分，未证明后缀完整保留', async () => {
  const { projectReliableConversation: project } = await ui.load('domain/reliableConversationProjection.ts');
  const input = { conversationId: 'conversation-a', ...twoSteeringChain(), steeringReceipts: [STEER_RECEIPT, SECOND_STEER_RECEIPT] };
  assert.deepEqual(project(input).messages.map(message => message.id), ['message-a', 'message-steer',
    'message-a:steer-successor:resp-2', 'message-steer-2', 'message-a:steer-successor:resp-3']);
  input.steeringReceipts[1] = { ...SECOND_STEER_RECEIPT, state: 'accepted' };
  const pending = project(input); assert.equal(pending.messages.length, 4);
  assert.equal(pending.messages[2].content.parts.length, 3);
});

test('时间线：模型用量和失败重试从真实关系恢复，不借用另一个请求', async () => {
  const { projectReliableConversation: project } = await ui.load('domain/reliableConversationProjection.ts');
  const records = nativeShellRecords('terminal');
  records.Turn['turn-a'].status = 'terminated';
  records.ModelRequest['request-a'] = { ...records.ModelRequest['request-a'], terminal_state: 'failed',
    usage_json: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } };
  records.TurnTermination = { stop: { id: 'stop', turn_id: 'turn-a', terminal_status: 'failed', reason: 'provider failed', created_at: '2026-10-13T00:00:00Z' } };
  const input = { conversationId: 'conversation-a', records,
    details: { 'message-content:revision-a': ready(JSON.stringify({ role: 'model', parts: [{ text: 'partial answer' }] })) } };
  const row = project(input).messages[0]; assert.equal(row.model, 'gpt-6-astra');
  assert.equal(row.usageMetadata.totalTokenCount, 120);
  assert.deepEqual(row.retryTarget, { kind: 'model_request', modelRequestId: 'request-a' });
  delete records.ModelRequestMessageLink; assert.equal(project(input).messages[0].model, undefined);
});

test('时间线：停止按钮和旧版执行器原因都显示为手动暂停，失败原因原样保留', async () => {
  const { projectReliableTurnTermination: terminate } = await ui.load('domain/reliableConversationProjection.ts');
  const records = nativeShellRecords('terminal');
  const stop = (terminal_status, reason) => terminate({ id: 'stop', turn_id: 'turn-a', terminal_status, reason, created_at: '2026-10-13T00:00:00Z' }, records);
  for (const reason of ['用户请求中断当前 Turn。', 'Executor observed interrupt_request at tool_batch_boundary.']) {
    const row = stop('interrupted', reason);
    assert.equal(row.actor, 'user'); assert.equal(row.reasonCode, 'user_cancelled'); assert.equal(row.detail, '手动暂停');
  }
  const failed = stop('failed', 'provider failed');
  assert.notEqual(failed.actor, 'user'); assert.equal(failed.detail, 'provider failed');
  assert.equal(stop('interrupted', 'Executor observed termination_request at model_request.').detail, 'Executor observed termination_request at model_request.');
});

test('用量：中转重复计入输入的总量不当作上下文占用', async () => {
  const { normalizeTokenUsage } = await ui.load('components/conversation/tokenUsageModel.ts');
  // 实测 Gemini 中转偶发的 total ≈ 2 × prompt + 输出；思考计在 total 里不算重复。
  const doubled = normalizeTokenUsage({ promptTokenCount: 228887, candidatesTokenCount: 624, thoughtsTokenCount: 30, totalTokenCount: 458601 });
  assert.equal(doubled.total, 229541); assert.equal(doubled.output, 654); assert.equal(doubled.totalEstimated, true);
  const normal = normalizeTokenUsage({ promptTokenCount: 220909, candidatesTokenCount: 392, thoughtsTokenCount: 67, totalTokenCount: 221368 });
  assert.equal(normal.total, 221368); assert.equal(normal.totalEstimated, undefined);
  const { providerTotalTokens } = require(path.join(compiled, 'backend/reliableKernel/contextTokenEstimator.js'));
  assert.equal(providerTotalTokens({ promptTokenCount: 228887, candidatesTokenCount: 624, thoughtsTokenCount: 30, totalTokenCount: 458601 }), 229541);
  assert.equal(providerTotalTokens({ promptTokenCount: 220909, candidatesTokenCount: 392, thoughtsTokenCount: 67, totalTokenCount: 221368 }), 221368);
  assert.equal(providerTotalTokens({ prompt_tokens: 100, total_tokens: 120 }), 120);
  assert.equal(providerTotalTokens({ promptTokenCount: 100, candidatesTokenCount: 20 }), 120);
});

test('时间线：持久Message壳的正文就绪前由同一个overlay占位', async () => {
  const { projectReliableConversation: project } = await ui.load('domain/reliableConversationProjection.ts');
  const input = { conversationId: 'conversation-a', records: nativeShellRecords('streaming'), details: {}, transientModelRequests: nativeTransient([ITEM_LIVE]) };
  const live = project(input); assert.equal(live.messages.length, 1); assert.equal(live.messages[0].id, 'message-a');
  assert.deepEqual(live.messages[0].content.parts, [ITEM_LIVE]);
  input.details['message-content:revision-a'] = ready(JSON.stringify({ role: 'model', parts: [{ text: 'durable body' }] }));
  input.records.ModelRequest['request-a'] = { ...input.records.ModelRequest['request-a'], status: 'terminal', terminal_state: 'completed' };
  assert.equal(project(input).messages.length, 1);
  assert.equal(project(input).messages[0].content.parts[0].text, 'durable body');
});

test('时间线：协作卡按已提交消息边界定位，外部Conversation消息不混入', async () => {
  const { projectCollaborationTimeline } = await ui.load('domain/reliableCollaborationTimeline.ts');
  const { composeTimelineRows, latestTimelineSegmentStart } = await ui.load('components/conversation/segmentedTimeline.ts');
  const messages = Array.from({ length: 35 }, (_, i) => ({ id: `m${i + 1}` }));
  const records = {
    Message: Object.fromEntries(messages.map(({ id }, i) => [id, { id, conversation_id: 'self', message_seq: String(1001 + i) }])),
    CollaborationMessage: { card: { id: 'card', message_seq: '1', mode: 'followup', text_preview: 'continue' }, foreign: { id: 'foreign', message_seq: '2', mode: 'message', text_preview: 'private' } },
    CollaborationMessageSourceLink: { source: { id: 'source', message_id: 'card', conversation_id: 'peer', source_kind: 'tool', turn_id: 'peer-turn' },
      foreign: { id: 'foreign-source', message_id: 'foreign', conversation_id: 'other', source_kind: 'tool', turn_id: null } },
    CollaborationMessageTargetLink: { target: { id: 'target', message_id: 'card', conversation_id: 'self', inbox_item_id: 'inbox' },
      foreign: { id: 'foreign-target', message_id: 'foreign', conversation_id: 'another', inbox_item_id: 'foreign-inbox' } },
    RuntimeDelivery: { delivery: { id: 'delivery', inbox_item_id: 'inbox', target_conversation_id: 'self', target_turn_id: 'turn', state: 'consumed', attempt_seq: '1' } },
    RuntimeDeliveryTimelineLink: { position: { id: 'position', delivery_id: 'delivery', conversation_id: 'self', predecessor_message_id: 'm34', predecessor_message_seq: '1034', exchange_seq: '1' } }
  };
  const timeline = projectCollaborationTimeline({ conversationId: 'self', records, messages,
    turnIdByMessageId: Object.fromEntries(messages.map(({ id }) => [id, 'turn'])), removedConversationIds: [] });
  assert.deepEqual(timeline.afterMessage.m34.map(card => card.messageId), ['card']);
  const rows = composeTimelineRows(messages, timeline), latest = rows.slice(latestTimelineSegmentStart(rows.length));
  assert.equal(latest.length, 30); assert.equal(latest.at(-1).id, 'm35'); assert.equal(latest.at(-2).id, 'collaboration:card');
});

test('时间线：未知steer不标成功，失败提示关闭后重读仍保持关闭', async () => {
  const steering = await ui.load('composables/steeringReceipts.ts'), state = viewState();
  const applied = { ...STEER_RECEIPT, responseId: 'resp-2', updatedAt: 1000 };
  steering.mergeSteeringReceipts('conversation-a', [applied]);
  steering.mergeSteeringReceipts('conversation-a', [{ ...applied, state: 'delivery_unknown', updatedAt: 2000 }]);
  assert.equal(steering.steeringReceiptsByConversationState().value['conversation-a'][applied.submissionId].state, 'delivery_unknown');
  assert.deepEqual(steering.visibleSteeringReceipts([{ ...applied, state: 'delivery_unknown' }], 2000), []);
  const failed = { ...applied, submissionId: 'failed', state: 'failed', message: 'provider refused', updatedAt: 3000 };
  assert.equal(steering.visibleSteeringReceipts([failed], 3000).length, 1);
  steering.persistSteeringDismissal(state, failed);
  assert.deepEqual(steering.visibleSteeringReceipts([failed], 3000, steering.readSteeringDismissals(state, 'conversation-a')), []);
  assert.equal(steering.visibleSteeringReceipts([applied], 5000).length, 0);
});

test('任务：批准Plan建立rewrite基线，后续Turn只应用有效update', () => {
  const fact = (id, operation, sourceTurnId, extra = {}) => ({ toolCallId: id, callSeq: '1', toolName: 'update_task_list', operation,
    sourceTurnId, sourceMessageId: `${id}-message`, sourceMessageSeq: id === 'baseline' ? '1' : '2', providerOrdinal: '0', ...extra });
  const card = buildCurrentTurnTaskProjection({ turnId: 'next-turn', operations: [
    fact('unapproved', { kind: 'task_list.operation', mode: 'rewrite', items: [{ title: 'wrong' }] }, 'old-turn', { toolName: 'submit_plan' }),
    fact('baseline', { kind: 'task_list.operation', mode: 'rewrite', items: [{ title: 'Implement', status: 'pending' }] }, 'old-turn', { toolName: 'submit_plan', planApproved: true }),
    fact('next-update', { kind: 'task_list.operation', mode: 'update', items: [{ title: 'Implement', status: 'in_progress' }] }, 'next-turn') ] });
  assert.equal(card.baselineToolCallId, 'baseline'); assert.equal(card.sourceTurnId, 'next-turn');
  assert.deepEqual(card.snapshot.items.map(item => [item.title, item.status]), [['Implement', 'in_progress']]);
});

async function taskHarness(t) {
  const h = ui.stores(t); h.feed.$reset();
  const runtime = await createTaskRuntime(), feed = new kernel.BoundedClientFeed(runtime.database), frames = [];
  let snapshotReads = 0;
  const readSnapshot = runtime.database.clientProjectionSnapshot.bind(runtime.database);
  runtime.database.clientProjectionSnapshot = (...args) => { snapshotReads += 1; return readSnapshot(...args); };
  t.after(async () => { feed.close(); await runtime.close(); });
  const connect = () => feed.connect({ activeConversationId: 'task-feed-conversation', send(frame) { frames.push(frame); } });
  let connection = await connect();
  let consumed = 0;
  const drain = async () => { await when(() => consumed < frames.length); const frame = frames[consumed++];
    h.feed.observeData(frame); feed.acknowledge({ sessionId: frame.sessionId, hostBootId: frame.hostBootId, messageSeq: frame.messageSeq }); return frame; };
  await drain(); const panel = (await ui.load('components/taskList/TaskListTopPanel.vue')).default;
  return { runtime, feed, store: h.feed, drain, render: async () => (await h.render(panel)).html,
    get snapshotReads() { return snapshotReads; },
    async reconnect() { feed.disconnect(connection.sessionId); connection = await connect(); return drain(); }
  };
}

test('任务：artifact经Feed和Pinia立即显示，滚出来源与重连后仍采用本对话最新rewrite', async t => {
  const h = await taskHarness(t); assert.ok((await h.render()).includes('0/1'));
  await h.runtime.settle('task-feed-foreign-plan', { detail: { output: { kind: 'submit_plan.result', proposalId: 'foreign', status: 'approved', executionTarget: 'current_conversation' } } });
  const before = await readCurrentTurnTaskCard(h.runtime.database, 'task-feed-turn');
  assert.equal(before.baselineToolCallId, 'task-feed-base');
  await h.runtime.settle('task-feed-update-one', { detail: { kind: 'task-list', operation: { kind: 'task_list.operation', mode: 'update', items: [{ title: 'Write tests', status: 'in_progress' }] } } });
  const frame = await h.drain(); assert.equal(frame.type, 'reliable-kernel.changes');
  assert.equal(h.store.projections.activeConversationWindow.currentTaskList.sourceToolCallId, 'task-feed-update-one');
  assert.equal(h.snapshotReads, 1, 'settled task artifacts must not read the transcript snapshot');
  assert.ok((await h.render()).includes('Write tests'));
  await h.runtime.settle('task-feed-update-one', { operation: null, outcome: true }); await h.drain();
  assert.equal(h.store.projections.activeConversationWindow.currentTaskList.sourceToolCallId, 'task-feed-update-one');
  await h.runtime.settle('task-feed-plan', { detail: { output: { kind: 'submit_plan.result', proposalId: 'task-feed-proposal', status: 'approved', executionTarget: 'current_conversation' } } });
  assert.equal((await h.drain()).type, 'reliable-kernel.changes');
  assert.equal(h.store.projections.activeConversationWindow.currentTaskList.sourceToolCallId, 'task-feed-plan');
  assert.ok((await h.render()).includes('1/1'));
  assert.equal(h.snapshotReads, 1);
  for (let from = 0; from < 205; from += 50) {
    await h.runtime.appendMessages(from, Math.min(50, 205 - from)); await h.drain();
  }
  await h.reconnect();
  assert.equal(h.store.records.ToolCall?.['task-feed-base'], undefined);
  const reads = h.snapshotReads;
  await h.runtime.settle('task-feed-update-two', { detail: { kind: 'task-list', operation: { kind: 'task_list.operation', mode: 'update', items: [{ title: 'Write tests', status: 'completed' }] } } });
  assert.equal((await h.drain()).type, 'reliable-kernel.changes'); assert.ok((await h.render()).includes('1/1'));
  assert.equal(h.snapshotReads, reads, 'task tools outside the live window update through the same small delta');
  assert.equal(h.store.records.ToolCall?.['task-feed-update-two'], undefined);
  h.store.historyConversationId = 'task-feed-conversation';
  h.store.committedRecords = { ...h.store.committedRecords, Message: { ...h.store.committedRecords.Message, old: { id: 'task-feed-old-message', conversation_id: 'task-feed-conversation', message_seq: '1', display_seq: '1', role: 'model' } } };
  assert.ok((await h.render()).includes('1/1'));
  await h.reconnect(); assert.ok((await h.render()).includes('1/1'));
  await h.runtime.settle('task-feed-latest-rewrite', { detail: { kind: 'task-list', operation: { kind: 'task_list.operation', mode: 'rewrite', items: [{ title: 'Latest', status: 'pending' }] } } });
  await h.drain();
  const latest = await readCurrentTurnTaskCard(h.runtime.database, 'task-feed-turn');
  assert.equal(latest.baselineToolCallId, 'task-feed-latest-rewrite');
  assert.equal(latest.operationCount, 1); assert.ok(latest.card.includes('Latest')); assert.equal(latest.card.includes('Write tests'), false);
  assert.ok((await h.render()).includes('0/1'));
});

test('Feed：回合开始和结束只更新冻结目录字段，Pinia状态与完整快照一致', async t => {
  const h = await taskHarness(t);
  await h.runtime.startTurn({ asChild: true });
  const started = await h.drain();
  assert.equal(started.type, 'reliable-kernel.changes');
  assert.equal(h.snapshotReads, 1);
  const window = h.store.projections.activeConversationWindow;
  assert.deepEqual(window.activeTurnWorkEnvironment, { conversationId: 'task-feed-conversation',
    turnId: 'task-feed-active-turn', enabled: true, defaultWorkEnvironmentId: 'frozen-directory',
    allowedWorkEnvironmentIds: ['frozen-directory'] });
  assert.equal(h.store.records.Turn['task-feed-active-turn'].status, 'active');
  const expected = (await h.runtime.database.clientProjectionSnapshot('task-feed-conversation')).snapshot.activeConversationWindow;
  assert.deepEqual(window.activeTurnWorkEnvironment, expected.activeTurnWorkEnvironment);
  assert.deepEqual(window.childConversationBoundary, expected.childConversationBoundary);
  assert.equal(window.childConversationBoundary.workEnvironment.turnId, 'task-feed-active-turn');
  assert.deepEqual(window.childConversationBoundary.workEnvironment.allowedWorkEnvironmentIds, ['frozen-directory']);
  const reads = h.snapshotReads;
  await h.runtime.finishTurn();
  assert.equal((await h.drain()).type, 'reliable-kernel.changes');
  assert.equal(h.snapshotReads, reads);
  assert.equal(h.store.projections.activeConversationWindow.activeTurnWorkEnvironment, null);
  assert.deepEqual(h.store.projections.activeConversationWindow.childConversationBoundary, window.childConversationBoundary);
  assert.equal(h.store.records.Turn['task-feed-active-turn'].status, 'terminated');
});

import { createHistoryFixture, projectionDatabase, projection, visited, sidebar, flushMicrotasks, P, Q } from './ui-history-fixture.mjs';

test('历史：项目分页隔离外部提交，更新删除和改名后准确重排，计数与刷新同步收敛', async t => {
  const h = await createHistoryFixture(t), first = await h.page(), second = await h.page('project', first.pageInfo.nextCursor);
  const read = input => h.database.conversationHistoryProjection({ ...input, limit: 5, pageIndex: 0 });
  assert.equal((await read({ scopeKind: 'all' })).total, 19);
  assert.equal((await read({ scopeKind: 'unbound' })).total, 2);
  assert.equal((await read({ scopeKind: 'project', projectFolderUri: P })).total, 13);
  assert.equal((await read({ scopeKind: 'project', projectFolderUri: `${P}/` })).total, 0);
  await h.create('foreign-latest'); await h.touch('q-3');
  const again = await h.page('project', second.pageInfo.cursor);
  assert.deepEqual(again, second);
  const pages = [first, second, await h.page('project', second.pageInfo.nextCursor)];
  assert.deepEqual(pages.flatMap(page => page.entries.map(row => row.id)), await h.order());
  await h.touch('p-04'); await h.remove('p-12');
  const moved = await h.page('project', second.pageInfo.cursor), order = await h.order();
  assert.equal(moved.pageInfo.pageIndex, 1); assert.deepEqual(moved.entries.map(row => row.id), order.slice(5, 10));
  let page = await h.page(); const ids = [];
  for (;;) { ids.push(...page.entries.map(row => row.id)); if (!page.pageInfo.nextCursor) break; page = await h.page('project', page.pageInfo.nextCursor); }
  assert.deepEqual(ids, order); assert.equal(new Set(ids).size, ids.length);
  assert.ok(moved.entries.some(row => row.id === 'p-06'));
  assert.equal(await h.facade.renameConversationTitle('p-06', 'Renamed'), true);
  const top = await h.page(); assert.equal(top.entries[0].id, 'p-06'); assert.equal(top.entries[0].title, 'Renamed');
  assert.deepEqual(h.reveals, [{ conversationId: 'p-06', projectFolderUri: P }]);
  const links = kernel.DOMAIN_REPOSITORIES.domain('ConversationProjectLink');
  await h.database.transaction([links.delete('p-01-project'), links.insert({ id: 'p-01-secondary', conversation_id: 'p-01', project_context_id: 'p',
    role: 'secondary', created_at: '2000-01-01T00:00:00Z', updated_at: '2000-01-01T00:00:00Z' })]);
  assert.equal((await read({ scopeKind: 'project', projectFolderUri: P })).total, 11);
  assert.equal((await read({ scopeKind: 'unbound' })).total, 3);
  await h.remove('p-02'); assert.equal((await read({ scopeKind: 'project', projectFolderUri: P })).total, 10);
  let release, started = 0; const gate = new Promise(resolve => { release = resolve; });
  h.facade.product.application.database = new Proxy(h.database, { get(target, key) {
    if (key === 'conversationHistoryProjection') return async input => { started++; if (started === 1) await gate; return target.conversationHistoryProjection(input); };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const active = h.facade.refreshConversationHistory(), next = h.facade.refreshConversationHistory();
  assert.equal(started, 1); assert.equal(h.facade.refreshConversationHistory(), next);
  release(); await Promise.all([active, next]); assert.equal(started, 2);
});

test('历史：侧栏首尾seek读取量不随可见正文历史增长', t => {
  const f = projectionDatabase(t); f.conversation('bounded'); f.conversation('empty');
  f.message('first', 'bounded', 1); f.message('last', 'bounded', 2, 'model');
  const read = () => projection.executeConversationHistoryProjection(f.db, { scopeKind: 'all', pageIndex: 0, limit: 50 });
  const cold = read(), sql = f.queries.filter(sql => sql.includes('SELECT conversation.id AS conversation_id, revision.id AS revision_id'));
  assert.equal(cold.titleTargets[0].revisionId, 'r-first'); assert.equal(cold.previewTargets[0].revisionId, 'r-last');
  const before = sql.map(query => visited(f.db, query, { conversation0: 'bounded', conversation1: 'empty' }));
  f.db.transaction(() => { for (let i = 3; i <= 1000; i++) f.message(`long-${i}`, 'bounded', i, 'model'); })();
  const after = sql.map(query => visited(f.db, query, { conversation0: 'bounded', conversation1: 'empty' }));
  assert.deepEqual(after, before); assert.ok(after.every(value => value <= 2));
  assert.equal(read().previewTargets.find(row => row.conversationId === 'bounded').revisionId, 'r-long-1000');
});

test('历史：旧消息页保留绝对可见序号，新后缀不增大其读取范围', t => {
  const f = projectionDatabase(t); f.conversation('visible'); f.conversation('foreign');
  f.db.transaction(() => { for (let i = 1; i <= 12; i++) f.message(`m-${i}`, 'visible', i * 10, i === 3 ? 'system' : 'user', i === 6); })();
  f.message('foreign', 'foreign', 15);
  const input = { conversationId: 'visible', beforeMessageSeq: '100', beforeId: 'm-10', limit: 4 };
  const read = () => projection.executeClientVisibleMessageHistoryPage(f.db, input, {}), before = read();
  assert.deepEqual(before.records.Message.map(row => [row.id, row.display_seq]), [['m-5', '4'], ['m-7', '5'], ['m-8', '6'], ['m-9', '7']]);
  const sql = f.queries.find(sql => sql.includes('WITH page AS MATERIALIZED') && sql.includes('@cursorSeq'));
  const parameters = { conversationId: 'visible', cursorSeq: 100n, cursorId: 'm-10', limit: 5n }, visits = visited(f.db, sql, parameters);
  f.db.transaction(() => { for (let i = 13; i <= 1000; i++) f.message(`m-${i}`, 'visible', i * 10); })();
  assert.deepEqual(read(), before); assert.equal(visited(f.db, sql, parameters), visits);
});

test('历史：持续刷新合并在途读取，页面导航和关闭拒绝迟到发布', async t => {
  const h = sidebar(t); h.request('page-2'); await flushMicrotasks(); h.hold(); h.change(); await h.advance(180);
  h.change(); await h.advance(100); h.change(); await h.advance(100);
  assert.equal(h.requests.length, 2);
  h.release(); await flushMicrotasks(); await h.advance(180);
  assert.equal(h.requests.length, 3); assert.equal(h.posted.length, 3);
  h.hold(); h.change(); await h.advance(180); h.reveal(Q); assert.equal(h.requests.length, 4);
  h.closeView(); h.release(); await flushMicrotasks(); await h.advance(1000);
  assert.equal(h.posted.length, 3); assert.equal(h.timers.size, 0);
});

test('历史：分支独立平级显示，真正的子Agent仍随所属对话折叠和分页', async () => {
  const tree = await ui.server.ssrLoadModule(`${process.cwd()}/shared/conversationHistoryTree.ts`);
  const collapse = await ui.load('sidebar/collapseIntent.ts');
  const entry = (id, updatedAt) => ({ id, title: id, status: 'final', messageCount: 1, createdAt: 1, updatedAt, previewState: 'ready', preview: id });
  const origin = (conversationId, sourceConversationId, originKind) => ({ id: `origin-${conversationId}`, conversationId, sourceConversationId, originKind, createdAt: 1 });
  const forkOrigin = origin('fork', 'source', 'user');
  const forest = tree.buildConversationHistoryForest([
    entry('source', 1), entry('source-child', 4), entry('fork', 6), entry('fork-child', 5), entry('child-fork', 8)
  ], [forkOrigin, origin('source-child', 'source', 'agent'), origin('fork-child', 'fork', 'agent'), origin('child-fork', 'source-child', 'user')]);
  assert.deepEqual(forest.map(node => node.entry.id), ['child-fork', 'fork', 'source']);
  assert.equal(forest[1].originLink, forkOrigin, '保留分支来源记录');
  assert.deepEqual(forest[1].children.map(node => node.entry.id), ['fork-child']);
  assert.deepEqual(forest[2].children.map(node => node.entry.id), ['source-child']);
  const visible = collapse.flattenVisibleHistoryNodes({ forest, expandedIds: new Set(), maxVisualDepth: 8 });
  assert.deepEqual(visible.map(node => [node.entry.id, node.depth]), [['child-fork', 0], ['fork', 0], ['source', 0]]);
  assert.deepEqual(tree.packConversationHistoryForestIntoPages(forest, 2).map(page => page.map(node => node.entry.id)),
    [['child-fork'], ['fork', 'fork-child'], ['source', 'source-child']]);
});

test('历史：读取分支页不夹带来源对话，读取真正子Agent仍携带父对话', t => {
  const f = projectionDatabase(t), now = '2000-01-01T00:00:00Z';
  for (const id of ['source', 'fork', 'child']) f.conversation(id);
  f.db.prepare('UPDATE conversation SET updated_at=? WHERE id=?').run('2000-02-01T00:00:00Z', 'fork');
  f.db.prepare('UPDATE conversation SET updated_at=? WHERE id=?').run('2000-03-01T00:00:00Z', 'child');
  for (const [id, source, toolCall] of [['fork', 'source', null], ['child', 'fork', 'spawn']]) {
    f.insert('conversation_origin_link', { id: `origin-${id}`, conversation_id: id, source_conversation_id: source,
      source_turn_id: null, source_tool_call_id: toolCall, source_message_revision_id: null, created_at: now });
  }
  const read = pageIndex => projection.executeConversationHistoryProjection(f.db, { scopeKind: 'all', pageIndex, limit: 1 });
  assert.deepEqual(read(0).conversations.map(row => row.id), ['child', 'fork']);
  assert.deepEqual(read(1).conversations.map(row => row.id), ['fork']);
  assert.deepEqual(read(2).conversations.map(row => row.id), ['source']);
});

test('历史：用户折叠保留运行子任务汇总，主动展开恢复自动展开资格', async () => {
  const tree = await ui.server.ssrLoadModule(`${process.cwd()}/shared/conversationHistoryTree.ts`);
  const collapse = await ui.load('sidebar/collapseIntent.ts');
  const entry = (id, running = false) => ({ id, title: id, isRunning: running, runState: running ? 'running' : undefined, status: 'final', messageCount: 1, createdAt: 1, updatedAt: 2, previewState: 'ready', preview: id });
  const forest = tree.buildConversationHistoryForest([entry('parent'), entry('child', true)],
    [{ id: 'origin', conversationId: 'child', sourceConversationId: 'parent', originKind: 'agent', sourceKind: 'explicit', createdAt: 1 }]);
  const result = collapse.expandNewlyActiveAgentAncestors({ nodes: tree.flattenConversationHistoryForest(forest), expandedIds: new Set(),
    userCollapsedIds: new Set(['parent']), previouslyActiveAgentIds: new Set() });
  assert.equal(result.expandedIds.has('parent'), false);
  const visible = collapse.flattenVisibleHistoryNodes({ forest, expandedIds: result.expandedIds, maxVisualDepth: 8 });
  assert.equal(visible.length, 1); assert.equal(visible[0].descendantAgents.running, 1);
  const expanded = collapse.toggleHistoryNode({ conversationId: 'parent', expandedIds: new Set(), userCollapsedIds: new Set(['parent']) });
  assert.equal(expanded.userCollapsedIds.has('parent'), false); assert.equal(expanded.expandedIds.has('parent'), true);
});

test('滚动：补入不等高历史后保留阅读行，丢失锚点不会跳动', async () => {
  const { captureScrollAnchor, restoreScrollAfterHistoryLoad } = await ui.load('components/conversation/scrollAnchor.ts');
  const positions = new Map([['first', 200], ['second', 600]]);
  const scroller = { scrollTop: 240, scrollHeight: 2000, clientHeight: 800, getBoundingClientRect: () => ({ top: 30, bottom: 830 }),
    querySelectorAll: () => [...positions].map(([id, top]) => ({ dataset: { timelineRowKey: id },
      getBoundingClientRect: () => ({ top: 30 + top - scroller.scrollTop, bottom: 430 + top - scroller.scrollTop }) })) };
  const anchor = captureScrollAnchor({ scroller, visibleRows: [{ id: 'first' }, { id: 'second' }] });
  positions.set('first', 1375); positions.set('second', 1775); scroller.scrollHeight += 1175;
  assert.equal(restoreScrollAfterHistoryLoad({ scroller, anchor }), true); assert.equal(scroller.scrollTop, 1415);
  restoreScrollAfterHistoryLoad({ scroller, anchor }); assert.equal(scroller.scrollTop, 1415);
  positions.delete('first'); restoreScrollAfterHistoryLoad({ scroller, anchor }); assert.equal(scroller.scrollTop, 1415);
});

test('滚动：内容检查和贴底共用frame，卸载回收观察者与排队frame', async t => {
  const sticky = await ui.load('composables/useBottomStickyScroller.ts');
  const old = Object.fromEntries(['Element', 'HTMLElement', 'ResizeObserver', 'MutationObserver'].map(key => [key, globalThis[key]]));
  const oldRequest = window.requestAnimationFrame, oldCancel = window.cancelAnimationFrame;
  t.after(() => { Object.assign(globalThis, old); window.requestAnimationFrame = oldRequest; window.cancelAnimationFrame = oldCancel; });
  const frames = new Map(), resize = [], mutation = []; let next = 0;
  class Element { constructor() { this.scrollTop = 500; this.scrollHeight = 1000; this.clientHeight = 500; this.listeners = new Map(); }
    addEventListener(name, fn) { this.listeners.set(name, fn); } removeEventListener(name) { this.listeners.delete(name); }
    dispatchEvent(event) { this.listeners.get(event.type)?.(event); return true; } closest() { return null; } }
  globalThis.Element = globalThis.HTMLElement = Element;
  window.requestAnimationFrame = fn => { const id = ++next; frames.set(id, fn); return id; }; window.cancelAnimationFrame = id => frames.delete(id);
  globalThis.ResizeObserver = class { constructor(callback) { resize.push(callback); } observe() {} unobserve() {} disconnect() {} };
  globalThis.MutationObserver = class { constructor(callback) { mutation.push(callback); } observe() {} disconnect() {} };
  const element = new Element(); element.firstElementChild = new Element();
  const app = ui.renderer.createApp({ setup() { sticky.useBottomStickyScroller(ui.vue.ref(element)); return () => null; } }); app.mount({});
  t.after(() => app.unmount()); await tick(); assert.equal(frames.size, 1);
  resize[0]([]); mutation[0]([]); element.listeners.get('keydown')({ key: 'End' }); assert.equal(frames.size, 1);
  app.unmount(); assert.equal(frames.size, 0);
});

test('显示：不可变正文warm projection复用解析，替换详情立即失效', async () => {
  const { projectReliableConversation: project } = await ui.load('domain/reliableConversationProjection.ts');
  const records = nativeShellRecords('terminal'); records.ModelRequest['request-a'].terminal_state = 'completed';
  const input = { conversationId: 'conversation-a', records, details: { 'message-content:revision-a': ready(JSON.stringify({ role: 'model', parts: [{ text: 'x'.repeat(200_000) }] })) } };
  const first = project(input), next = project({ ...input, lastCommitSeq: '2' }); assert.equal(next.messages[0].content, first.messages[0].content);
  input.details['message-content:revision-a'] = ready(JSON.stringify({ role: 'model', parts: [{ text: 'replacement' }] }));
  assert.equal(project(input).messages[0].content.parts[0].text, 'replacement');
});

test('显示：10k行代码只渲染可见窗口，换wrap尺寸和stream内容保留逻辑阅读位置', async t => {
  const { default: CodeBlock } = await ui.load('components/content/CodeBlockViewer.vue');
  const { CodeLineHeights, codeLineWindow, codeLineReadingAnchor, codeLineReadingAnchorOffset } = await ui.load('domain/codeLineWindow.ts');
  const html = await ui.renderToString(ui.vue.createSSRApp({ render: () => ui.vue.h(CodeBlock, { code: Array.from({ length: 10000 }, (_, i) => `中文\tline-${i + 1}`).join('\n'), language: 'js' }) }));
  assert.ok((html.match(/class="lc-code-block-line"/g) ?? []).length < 80);
  assert.ok(html.includes('aria-setsize="10000"')); assert.equal(html.includes('line-10000<'), false);
  const heights = new CodeLineHeights(10000, 20); heights.set(5000, 20000);
  const anchor = codeLineReadingAnchor(heights, heights.offset(5000) + 10000);
  const streamed = new CodeLineHeights(10001, 20, index => index < heights.count ? heights.height(index) : 20);
  streamed.set(5000, 30000); assert.equal(codeLineReadingAnchorOffset(streamed, anchor), heights.offset(5000) + 10000);
  const visible = codeLineWindow(streamed, codeLineReadingAnchorOffset(streamed, anchor), 520); assert.ok(visible.end - visible.start < 80);
});

test('显示：transient只更新当前消息，已提交历史正文和工具对象不重新读取', async () => {
  const { ReliableConversationProjector } = await ui.load('domain/reliableConversationProjector.ts');
  const records = nativeShellRecords('streaming');
  records.Message['message-a'].message_seq = '101';
  const details = { 'message-content:revision-a': ready(JSON.stringify({ role: 'model', parts: [ITEM_ONE] })) };
  let historicalReads = 0;
  for (let index = 1; index <= 80; index++) {
    const id = `historical-${index}`, revision = `history-revision-${index}`, turnId = `historical-turn-${index}`;
    records.Message[id] = { id, revision_id: revision, conversation_id: 'conversation-a', role: 'user', message_seq: String(index), created_at: '2026-08-01T00:00:00Z' };
    records.MessageTurnLink[id] = { id, message_id: id, turn_id: turnId, role: 'input' };
    records.Turn[turnId] = { id: turnId, conversation_id: 'conversation-a', status: 'terminated' };
    const body = JSON.stringify({ role: 'user', parts: [{ text: 'stable historical body ' + index }] });
    details[`message-content:${revision}`] = { status: 'ready', totalBytes: body.length, get text() { historicalReads++; return body; } };
  }
  const projector = new ReliableConversationProjector();
  const committed = projector.projectCommitted({ conversationId: 'conversation-a', records, details });
  const history = committed.messages.slice(0, 80), toolCalls = committed.toolCalls;
  historicalReads = 0;
  const first = projector.projectTransient({ transientModelRequests: nativeTransient([ITEM_LIVE]) });
  const second = projector.projectTransient({ transientModelRequests: nativeTransient([{ ...ITEM_LIVE, text: 'continued live tail' }]) });
  assert.equal(historicalReads, 0);
  assert.ok(history.every((message, index) => message === first.messages[index] && message === second.messages[index]));
  assert.equal(first.toolCalls, toolCalls); assert.equal(second.toolCalls, toolCalls);
  assert.equal(first.index.messageIds, second.index.messageIds);
  assert.equal(first.index.messageMetadata, second.index.messageMetadata);
  assert.equal(second.messages.at(-1).content.parts.at(-1).text, 'continued live tail');
});

test('历史：阅读页只驻留相邻页面，after游标重载已释放正文并保留展开详情', async t => {
  const h = ui.stores(t), feed = h.feed;
  const rows = (first, count) => Array.from({ length: count }, (_, offset) => {
    const seq = first + offset;
    return { id: `resident-${seq}`, revision_id: `resident-revision-${seq}`, conversation_id: h.conversationId,
      role: 'user', message_seq: String(seq), display_seq: String(seq), created_at: '2026-10-13T00:00:00Z' };
  });
  feed.observe({ type: 'reliable-kernel.snapshot', sessionId: 'resident-session', hostBootId: 'resident-host',
    messageSeq: '1', snapshotCommitSeq: '1',
    projections: { activeConversationWindow: { conversationId: h.conversationId, visibleMessageCount: '120', messages: rows(101, 20) } } });
  const admit = (direction, first) => {
    assert.equal(direction === 'before' ? feed.requestEarlierHistory(h.conversationId) : feed.requestLaterHistory(h.conversationId), true);
    const request = ui.posted.at(-1);
    assert.equal(Object.hasOwn(request, direction === 'before' ? 'afterMessageSeq' : 'beforeMessageSeq'), false);
    const messages = rows(first, 20);
    for (const row of messages) feed.details[`message-content:${row.revision_id}`] = ready(JSON.stringify({ role: 'user', parts: [{ text: row.id }] }));
    feed.observeHistoryPageResult({ sessionId: feed.sessionId, conversationId: h.conversationId, requestId: request.requestId,
      page: { records: { Message: messages }, hasMoreBefore: first > 1, hasMoreAfter: first + 19 < 120,
        nextBeforeMessageSeq: String(first), nextBeforeId: messages[0].id,
        nextAfterMessageSeq: String(first + 19), nextAfterId: messages.at(-1).id } });
    assert.ok(feed.historyPages.length <= 3);
    assert.ok(Object.keys(feed.committedRecords.Message).length <= 80);
    return request;
  };
  admit('before', 81);
  const heldKey = 'message-content:resident-revision-81';
  feed.setDetailOwnerKeys('expanded-audit', [heldKey]);
  admit('before', 61); admit('before', 41); admit('before', 21);
  assert.equal(feed.committedRecords.Message['resident-81'], undefined);
  assert.ok(feed.details[heldKey]);
  feed.setDetailOwnerKeys('expanded-audit', []); assert.equal(feed.details[heldKey], undefined);
  assert.equal(feed.details['message-content:resident-revision-82'], undefined);
  assert.equal(admit('after', 41).afterMessageSeq, '40');
  assert.equal(admit('after', 61).afterMessageSeq, '60');
  assert.equal(admit('after', 81).afterMessageSeq, '80');
  assert.equal(feed.committedRecords.Message['resident-81'].display_seq, '81');
  assert.ok(feed.details[heldKey]);
  assert.equal(new Set(Object.values(feed.committedRecords.Message).map(row => row.id)).size, Object.keys(feed.committedRecords.Message).length);
});

test('原生内容：封闭item页与活尾文共存，旧页释放，完整复制使用同一逻辑正文入口', async t => {
  const h = ui.stores(t), feed = h.feed;
  const records = nativeShellRecords('streaming');
  records.Message['message-a'] = { ...records.Message['message-a'], item_index_revision_id: 'index-a', revision_id: 'index-a',
    content_type: 'application/vnd.limcode.native-message-composition+json', display_seq: '1' };
  feed.observe({ type: 'reliable-kernel.snapshot', sessionId: 'items-session', hostBootId: 'items-host', messageSeq: '1', snapshotCommitSeq: '1',
    projections: { activeConversationWindow: { conversationId: 'conversation-a', visibleMessageCount: '1',
      messages: Object.values(records.Message), turns: Object.values(records.Turn ?? {}),
      messageTurnLinks: Object.values(records.MessageTurnLink ?? {}), modelRequests: Object.values(records.ModelRequest ?? {}),
      modelRequestMessageLinks: Object.values(records.ModelRequestMessageLink ?? {}) } } });
  const nativePart = sequence => ({ text: `content-${sequence}\n`, outputItem: { id: `item-${(sequence - 1) % 32}`,
    ordinal: (sequence - 1) % 32, providerResponseId: `response-${Math.floor((sequence - 1) / 32)}`,
    ...(sequence > 32 ? { previousResponseId: `response-${Math.floor((sequence - 1) / 32) - 1}` } : {}) } });
  const { useReliableConversation } = await ui.load('composables/useReliableConversation.ts');
  const view = h.scope.run(() => useReliableConversation());
  const served = new Set();
  let fullReads = 0;
  const reply = request => {
    let value;
    if (request.kind === 'message-content-items') {
      const first = (request.itemAfterSequence ?? 64) + 1;
      const items = Array.from({ length: Math.min(32, 97 - first) }, (_, index) => {
        const sequence = first + index, part = nativePart(sequence);
        return { id: `item-revision-${sequence}`, sequence, revisionId: `item-revision-${sequence}`, contentObjectId: `item-object-${sequence}`,
          partByteLength: Buffer.byteLength(JSON.stringify(part)), outputItem: part.outputItem };
      });
      const last = items.at(-1)?.sequence ?? 0;
      value = { totalItems: 96, totalBytes: 20000, items, ...(last < 96 ? { nextSequence: last } : {}) };
    } else if (request.kind === 'message-content-item' && request.recordId.startsWith('item-object-')) {
      value = { role: 'model', parts: [nativePart(Number(request.recordId.slice('item-object-'.length)))] };
    } else if (request.kind === 'message-content' && request.recordId === 'index-a') {
      fullReads++; value = { role: 'model', parts: Array.from({ length: 96 }, (_, index) => nativePart(index + 1)) };
    } else return false;
    const bytes = Buffer.from(JSON.stringify(value));
    feed.observeDetailResult({ sessionId: feed.sessionId, requestId: request.requestId,
      detail: { recordId: request.recordId, offset: 0, totalBytes: bytes.length, chunk: bytes.toString('base64'), hasMore: false } });
    return true;
  };
  const drain = async () => {
    for (let round = 0; round < 200; round++) {
      const requests = ui.posted.filter(request => request.type === 'reliable-kernel.detail-request' && request.sessionId === feed.sessionId && !served.has(request.requestId));
      if (!requests.length) break;
      for (const request of requests) { served.add(request.requestId); reply(request); }
      await tick();
    }
  };
  feed.ensureMessageContent('message-a'); await drain();
  assert.equal(fullReads, 0);
  assert.deepEqual(view.projection.value.messages[0].content.parts.map(part => part.text), Array.from({ length: 64 }, (_, index) => `content-${index + 33}\n`));
  const stableItem = view.projection.value.messages[0].content.parts[0];
  feed.transientModelRequests = nativeTransient([nativePart(97)]);
  const withLive = view.projection.value.messages[0];
  assert.equal(withLive.content.parts[0], stableItem); assert.equal(withLive.content.parts.at(-1).text, 'content-97\n');
  const complete = view.completeMessageContent('message-a'); await drain();
  const content = await complete;
  assert.equal(content.parts.length, 97); assert.equal(content.parts[0].text, 'content-1\n'); assert.equal(content.parts.at(-1).text, 'content-97\n');
  assert.equal(fullReads, 1); assert.equal(feed.details['message-content:index-a'], undefined);
  feed.moveMessageContentWindow('message-a', 'before'); await drain();
  assert.equal(view.projection.value.messages[0].content.parts[0].text, 'content-1\n');
  assert.equal(feed.details['message-content-item:item-object-96'], undefined);
  assert.ok(feed.messageContentWindows['message-a'].pages.length <= 3);
  feed.moveMessageContentWindow('message-a', 'after'); await drain();
  assert.equal(feed.messageContentWindows['message-a'].followTail, true);
  assert.equal(view.projection.value.messages[0].content.parts.at(-1).text, 'content-97\n');
  feed.retainMessageContentWindows([]);
  assert.equal(feed.details['message-content-item:item-object-64'], undefined);
});

test('原生内容：终态metadata先到时保留未hydrate的transient，逐项正文接管后保持已读内容', async () => {
  const { projectReliableConversation: project } = await ui.load('domain/reliableConversationProjection.ts');
  const records = nativeShellRecords('terminal');
  records.ModelRequest['request-a'].terminal_state = 'completed';
  records.Message['message-a'] = { ...records.Message['message-a'], revision_id: 'index-ready', item_index_revision_id: 'index-ready' };
  const parts = [1, 2].map(sequence => ({ text: `visible-${sequence}`, outputItem: { id: `ready-${sequence}`, ordinal: sequence - 1, providerResponseId: 'ready-response' } }));
  const items = parts.map((part, index) => ({ id: `ready-revision-${index}`, revisionId: `ready-revision-${index}`,
    sequence: index + 1, contentObjectId: `ready-object-${index}`, partByteLength: 100, outputItem: part.outputItem }));
  const transientModelRequests = nativeTransient([parts[1]]);
  transientModelRequests['request-a'].status = 'completed';
  const input = { conversationId: 'conversation-a', records, transientModelRequests,
    details: { 'message-content-item:ready-object-0': ready(JSON.stringify({ role: 'model', parts: [parts[0]] })) },
    messageContentWindows: { 'message-a': { indexRevisionId: 'index-ready', followTail: true, pages: [{
      key: 'message-content-items:index-ready:tail', indexRevisionId: 'index-ready', totalItems: 2, totalBytes: 200, items
    }] } } };
  const window = input.messageContentWindows['message-a'], currentPages = window.pages;
  window.pages = [{ key: 'message-content-items:index-before:tail', indexRevisionId: 'index-before', totalItems: 1, totalBytes: 100, items: items.slice(0, 1) }];
  input.details['message-content-items:index-ready:tail'] = { status: 'loading', text: '', totalBytes: 0 };
  assert.deepEqual(project(input).messages[0].content.parts.map(part => part.text), ['visible-1', 'visible-2']);
  window.pages = currentPages; delete input.details['message-content-items:index-ready:tail'];
  const pending = project(input);
  assert.deepEqual(pending.messages[0].content.parts.map(part => part.text), ['visible-1', 'visible-2']);
  assert.equal(pending.contentWindowByMessageId['message-a'].loading, true);
  const stable = pending.messages[0].content.parts[0];
  input.details['message-content-item:ready-object-1'] = ready(JSON.stringify({ role: 'model', parts: [parts[1]] }));
  const hydrated = project(input);
  assert.deepEqual(hydrated.messages[0].content.parts.map(part => part.text), ['visible-1', 'visible-2']);
  assert.equal(hydrated.messages[0].content.parts[0], stable);
  assert.equal(hydrated.contentWindowByMessageId['message-a'].loading, false);
});

test('原生内容：首次终态Feed先于列表正文需求时持续交接已显示的transient', async t => {
  const h = ui.stores(t), feed = h.feed, records = nativeShellRecords('streaming');
  const originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  t.after(() => { if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver; else delete globalThis.ResizeObserver; });
  feed.projections = { activeConversationWindow: { conversationId: 'conversation-a' } };
  const modelMessage = records.Message['message-a'], modelLink = records.MessageTurnLink['link-a'];
  const requestLink = records.ModelRequestMessageLink;
  records.Turn['turn-a'].source_message_id = 'user-a';
  records.Message = { 'user-a': { id: 'user-a', conversation_id: 'conversation-a', message_seq: '1', display_seq: '1',
    revision_id: 'user-revision', role: 'user', created_at: '2026-08-03T00:00:00.000Z' } };
  records.MessageTurnLink = { 'user-link': { id: 'user-link', message_id: 'user-a', turn_id: 'turn-a', role: 'input' } };
  records.ModelRequestMessageLink = {};
  const snapshot = sequence => ({ type: 'reliable-kernel.snapshot', sessionId: 'session', hostBootId: 'host',
    messageSeq: String(sequence), snapshotCommitSeq: String(sequence), projections: { activeConversationWindow: {
      conversationId: 'conversation-a', visibleMessageCount: String(sequence), messages: Object.values(records.Message),
      turns: Object.values(records.Turn), messageTurnLinks: Object.values(records.MessageTurnLink),
      modelRequests: Object.values(records.ModelRequest), modelRequestMessageLinks: Object.values(records.ModelRequestMessageLink)
    } } });
  feed.observe(snapshot(1));
  feed.details['message-content:user-revision'] = ready(JSON.stringify({ role: 'user', parts: [{ text: 'question' }] }));
  feed.observe({ type: 'reliable-kernel.transient', sessionId: feed.sessionId, hostBootId: feed.hostBootId,
    conversationId: 'conversation-a', turnId: 'turn-a', modelRequestId: 'request-a', requestSeq: '1',
    providerId: 'provider-a', modelId: 'gpt-6-astra', attemptSeq: '1', socketGeneration: '1', afterCommitSeq: '1',
    observedAt: '2026-08-03T00:00:02.000Z', fromStreamSeq: '1',
    event: { kind: 'output_delta', streamSeq: '1', content: { type: 'text_delta', text: ITEM_LIVE.text, outputItem: ITEM_LIVE.outputItem } } });
  const app = ui.renderer.createApp({ ...ui.messageList, render() { return null; }, ssrRender: undefined }).use(h.active);
  h.cleanup.push(() => app.unmount()); app.provide(ui.vue.ssrContextKey, { modules: new Set() }); app.mount({});
  const { useReliableConversation } = await ui.load('composables/useReliableConversation.ts');
  const view = h.scope.run(() => useReliableConversation());
  await tick();
  assert.equal(view.projection.value.messages.at(-1).id, 'transient:request-a');
  assert.deepEqual(Object.keys(feed.messageContentWindows), []);
  records.Message['message-a'] = { ...modelMessage, message_seq: '2', display_seq: '2',
    revision_id: 'first-terminal-index', item_index_revision_id: 'first-terminal-index' };
  records.MessageTurnLink['link-a'] = modelLink; records.ModelRequestMessageLink = requestLink;
  records.ModelRequest['request-a'] = { ...records.ModelRequest['request-a'], status: 'terminal', terminal_state: 'completed' };
  feed.observe(snapshot(2));
  assert.ok(feed.transientModelRequests['request-a']);
  await tick();
  assert.deepEqual(view.projection.value.messages.at(-1).content.parts, [ITEM_LIVE]);
  assert.equal(view.projection.value.contentWindowByMessageId['message-a'].loading, true);
  const reply = (kind, value) => {
    const [requestId, request] = Object.entries(feed.pendingDetails).find(([, pending]) => pending.kind === kind);
    const bytes = Buffer.from(JSON.stringify(value));
    feed.observeDetailResult({ sessionId: feed.sessionId, requestId, detail: { recordId: request.recordId,
      offset: 0, totalBytes: bytes.length, chunk: bytes.toString('base64'), hasMore: false } });
  };
  reply('message-content-items', { totalItems: 1, totalBytes: 100, items: [{ id: 'terminal-item', revisionId: 'terminal-item',
    sequence: 1, contentObjectId: 'terminal-body', partByteLength: 100, outputItem: ITEM_LIVE.outputItem }] });
  assert.deepEqual(view.projection.value.messages.at(-1).content.parts, [ITEM_LIVE]);
  assert.ok(feed.transientModelRequests['request-a']);
  reply('message-content-item', { role: 'model', parts: [ITEM_LIVE] });
  assert.deepEqual(view.projection.value.messages.at(-1).content.parts, [ITEM_LIVE]);
  assert.equal(feed.transientModelRequests['request-a'], undefined);
  assert.equal(view.projection.value.contentWindowByMessageId['message-a'].loading, false);
});

test('原生内容：item正文读取耗尽后展示错误并开放翻页，明确重试沿原详情入口恢复', async t => {
  const h = ui.stores(t), feed = h.feed, records = nativeShellRecords('terminal');
  records.ModelRequest['request-a'].terminal_state = 'completed';
  records.Message['message-a'] = { ...records.Message['message-a'], revision_id: 'index-error', item_index_revision_id: 'index-error' };
  feed.records = records; feed.committedRecords = records;
  feed.projections = { activeConversationWindow: { conversationId: 'conversation-a' } };
  const items = Array.from({ length: 32 }, (_, index) => {
    const sequence = index + 65;
    return { id: `error-revision-${sequence}`, revisionId: `error-revision-${sequence}`, sequence,
      contentObjectId: `error-object-${sequence}`, partByteLength: 100,
      outputItem: { id: `error-item-${sequence}`, ordinal: sequence - 1, providerResponseId: 'error-response' } };
  });
  const pageKey = 'message-content-items:index-error:tail';
  feed.messageContentWindows['message-a'] = { indexRevisionId: 'index-error', followTail: true, currentPageKey: pageKey, pages: [{
    key: pageKey, indexRevisionId: 'index-error', totalItems: 96, totalBytes: 9600, items
  }] };
  feed.messageContentItemOwners[pageKey] = 'message-a';
  const body = item => ({ role: 'model', parts: [{ text: `body-${item.sequence}`, outputItem: item.outputItem }] });
  for (const item of items.slice(0, -1)) feed.details[`message-content-item:${item.contentObjectId}`] = ready(JSON.stringify(body(item)));
  feed.hydrateMessageContentWindow('message-a');
  const failed = Object.entries(feed.pendingDetails).find(([, request]) => request.recordId === 'error-object-96');
  failed[1].retryCount = 3;
  feed.failDetailRequest(failed[0], 'item body read failed');
  const { useReliableConversation } = await ui.load('composables/useReliableConversation.ts');
  const view = h.scope.run(() => useReliableConversation());
  const state = view.projection.value.contentWindowByMessageId['message-a'];
  assert.equal(state.loading, false); assert.equal(state.error, 'item body read failed'); assert.equal(state.canRetry, true);
  const messageItem = (await ui.load('components/conversation/MessageItem.vue')).default;
  const html = (await h.render(messageItem, { message: view.projection.value.messages[0], contentWindow: state })).html;
  assert.match(html, /role="alert"[^>]*>item body read failed/);
  assert.match(html, /<button(?![^>]*disabled)[^>]*>显示前面的内容<\/button>/);
  assert.match(html, /重试读取内容/);
  feed.retryMessageContentWindow('message-a');
  const retry = Object.entries(feed.pendingDetails).find(([, request]) => request.recordId === 'error-object-96');
  assert.ok(retry); assert.notEqual(retry[0], failed[0]);
  const bytes = Buffer.from(JSON.stringify(body(items.at(-1))));
  feed.observeDetailResult({ sessionId: feed.sessionId, requestId: retry[0], detail: { recordId: retry[1].recordId,
    offset: 0, totalBytes: bytes.length, chunk: bytes.toString('base64'), hasMore: false } });
  assert.equal(view.projection.value.contentWindowByMessageId['message-a'].error, undefined);
  assert.equal(view.projection.value.messages[0].content.parts.at(-1).text, 'body-96');
  feed.moveMessageContentWindow('message-a', 'before');
  assert.ok(Object.values(feed.pendingDetails).some(request => request.kind === 'message-content-items' && request.itemAfterSequence === 32));
});

test('原生内容：连续index修订释放被替代metadata请求和owner，迟到响应不恢复旧详情', t => {
  const h = ui.stores(t), feed = h.feed;
  const replies = [];
  for (let revision = 1; revision <= 40; revision += 1) {
    feed.committedRecords = { Message: { m: { id: 'm', conversation_id: h.conversationId, role: 'model',
      revision_id: `index-${revision}`, item_index_revision_id: `index-${revision}` } } };
    feed.ensureMessageContent('m');
    const requests = Object.entries(feed.pendingDetails).filter(([, request]) => request.kind === 'message-content-items');
    assert.equal(requests.length, 1); assert.equal(Object.keys(feed.messageContentItemOwners).length, 1);
    replies.push(requests[0]);
  }
  const text = JSON.stringify({ totalItems: 1, totalBytes: 100, items: [{ id: 'latest-revision', revisionId: 'latest-revision',
    sequence: 1, contentObjectId: 'latest-object', partByteLength: 100,
    outputItem: { id: 'latest-item', ordinal: 0, providerResponseId: 'latest-response' } }] });
  for (const [requestId, request] of replies) feed.observeDetailResult({ sessionId: feed.sessionId, requestId,
    detail: { recordId: request.recordId, offset: 0, totalBytes: Buffer.byteLength(text), chunk: Buffer.from(text).toString('base64'), hasMore: false } });
  assert.equal(feed.messageContentWindows.m.pages.length, 1);
  assert.equal(Object.keys(feed.messageContentItemOwners).length, 1);
  assert.equal(feed.detailOwnerKeys['message-content-window:m'].length, 2);
  assert.deepEqual(Object.keys(feed.details).filter(key => key.startsWith('message-content-items:')), ['message-content-items:index-40:tail']);
});

test('原生内容：sealed done使用确切committedPart，恢复marker缺正文不会重建旧累计', async t => {
  const h = ui.stores(t), feed = h.feed;
  feed.observe({ type: 'reliable-kernel.snapshot', sessionId: 'marker-session', hostBootId: 'marker-host', messageSeq: '1', snapshotCommitSeq: '1',
    projections: { activeConversationWindow: { conversationId: 'marker-conversation' } } });
  const outputItem = { id: 'same-id', ordinal: 0, providerResponseId: 'response-new', previousResponseId: 'response-old' };
  const event = (sequence, kind, content) => ({ type: 'reliable-kernel.transient', sessionId: feed.sessionId, hostBootId: feed.hostBootId,
    conversationId: 'marker-conversation', turnId: 'marker-turn', modelRequestId: 'marker-request', requestSeq: '1',
    providerId: 'provider', modelId: 'model', attemptSeq: '1', socketGeneration: '1', afterCommitSeq: '1', observedAt: '2026-10-13T00:00:00Z',
    fromStreamSeq: String(sequence), event: { kind, streamSeq: String(sequence), content } });
  feed.observe(event(1, 'output_delta', { type: 'text_delta', text: 'draft', outputItem }));
  feed.observe(event(2, 'output_item_done', { type: 'output_item_done', committedRevisionId: 'sealed-revision', committedContentObjectId: 'sealed-object', outputItem,
    committedPart: { text: 'exact committed text', outputItem } }));
  assert.equal(JSON.parse(feed.details['message-content-item:sealed-object'].text).parts[0].text, 'exact committed text');
  assert.equal(feed.transientModelRequests['marker-request'].outputParts[0].text, 'exact committed text');
  const marker = event(3, 'output_item_done', { type: 'output_item_done', committedRevisionId: 'sealed-revision', committedContentObjectId: 'sealed-object', outputItem });
  feed.observe({ ...marker, type: 'reliable-kernel.transient-snapshot', deliveryId: 'marker-recovery', headStreamSeq: '3', events: [marker] });
  assert.equal(feed.transientModelRequests['marker-request'].outputParts.length, 0);
  assert.equal(feed.transientModelRequests['marker-request'].streamSeq, '3');
  assert.equal(feed.details['message-content-item:sealed-object'], undefined);
  for (let sequence = 4; sequence <= 103; sequence++) {
    const item = { id: `handoff-${sequence}`, ordinal: sequence, providerResponseId: 'handoff-response' };
    feed.observe(event(sequence, 'output_item_done', { type: 'output_item_done', outputItem: item,
      committedRevisionId: `handoff-revision-${sequence}`, committedContentObjectId: `handoff-object-${sequence}`,
      committedPart: { text: `${sequence}:` + 'x'.repeat(2048), outputItem: item } }));
    assert.ok(feed.transientModelRequests['marker-request'].outputParts.length <= 32);
    assert.ok((feed.detailOwnerKeys['native-handoff:marker-request'] ?? []).length <= 32);
  }
  assert.equal(feed.details['message-content-item:handoff-object-4'], undefined);
  assert.equal(Object.keys(feed.details).filter(key => key.startsWith('message-content-item:')).length, 32);
  feed.observe(event(104, 'completed', { type: 'native_completed' }));
  assert.equal(feed.transientModelRequests['marker-request'].status, 'completed');
  assert.equal(feed.transientModelRequests['marker-request'].completedContent, undefined);
  const { appendReliableTransientTextPart } = await ui.load('domain/reliableTransientOutput.ts');
  const twoResponses = appendReliableTransientTextPart([{ text: 'old response', outputItem: { ...outputItem, providerResponseId: 'response-old', previousResponseId: undefined } }],
    { text: 'new response', thought: false, outputItem });
  assert.deepEqual(twoResponses.map(part => part.text), ['old response', 'new response']);
});

test('显示：单消息已完成render nodes稳定，变动尾块保留原key', async () => {
  const { RichRenderNodeProjector } = await ui.load('components/content/partRegistry.ts');
  const projector = new RichRenderNodeProjector();
  const parts = Array.from({ length: 120 }, (_, index) => ({ text: `block-${index}`, outputItem: { id: `block-${index}`, ordinal: index, providerResponseId: 'render-response' } }));
  const before = projector.project(parts);
  const after = projector.project([...parts.slice(0, -1), { ...parts.at(-1), text: 'tail continued' }]);
  assert.equal(before.length, 120); assert.ok(before.slice(0, -1).every((node, index) => node === after[index]));
  assert.equal(before.at(-1).key, after.at(-1).key); assert.equal(after.at(-1).props.text, 'tail continued');
});

test('原生内容：metadata预取耗尽后翻页显示错误，明确重试恢复页面和正文', async t => {
  const h = ui.stores(t), feed = h.feed, records = nativeShellRecords('terminal');
  records.ModelRequest['request-a'].terminal_state = 'completed';
  records.Message['message-a'] = { ...records.Message['message-a'], revision_id: 'index-prefetch-error', item_index_revision_id: 'index-prefetch-error' };
  feed.records = records; feed.committedRecords = records;
  feed.projections = { activeConversationWindow: { conversationId: 'conversation-a' } };
  const { useReliableConversation } = await ui.load('composables/useReliableConversation.ts');
  const view = h.scope.run(() => useReliableConversation());
  const part = sequence => ({ text: `prefetch-body-${sequence}`, outputItem: {
    id: `prefetch-item-${sequence}`, ordinal: sequence - 1, providerResponseId: 'prefetch-response'
  } });
  const items = first => Array.from({ length: 32 }, (_, index) => {
    const sequence = first + index, value = part(sequence);
    return { id: `prefetch-revision-${sequence}`, revisionId: `prefetch-revision-${sequence}`, sequence,
      contentObjectId: `prefetch-object-${sequence}`, partByteLength: Buffer.byteLength(JSON.stringify(value)), outputItem: value.outputItem };
  });
  const reply = ([requestId, request], value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    feed.observeDetailResult({ sessionId: feed.sessionId, requestId, detail: { recordId: request.recordId,
      offset: 0, totalBytes: bytes.length, chunk: bytes.toString('base64'), hasMore: false } });
  };
  for (const item of items(65)) feed.details[`message-content-item:${item.contentObjectId}`] = ready(JSON.stringify({ role: 'model', parts: [part(item.sequence)] }));
  feed.ensureMessageContent('message-a');
  const tail = Object.entries(feed.pendingDetails).find(([, request]) => request.kind === 'message-content-items');
  reply(tail, { totalItems: 96, totalBytes: 9600, items: items(65) });
  const prefetch = Object.entries(feed.pendingDetails).find(([, request]) => request.kind === 'message-content-items' && request.itemAfterSequence === 32);
  assert.ok(prefetch); prefetch[1].retryCount = 3;
  feed.failDetailRequest(prefetch[0], 'metadata prefetch retries exhausted');
  feed.moveMessageContentWindow('message-a', 'before');
  const failed = view.projection.value.contentWindowByMessageId['message-a'];
  assert.equal(failed.loading, false); assert.equal(failed.error, 'metadata prefetch retries exhausted'); assert.equal(failed.canRetry, true);
  const messageItem = (await ui.load('components/conversation/MessageItem.vue')).default;
  const failedHtml = (await h.render(messageItem, { message: view.projection.value.messages[0], contentWindow: failed })).html;
  assert.match(failedHtml, /role="alert"[^>]*>metadata prefetch retries exhausted/);
  assert.match(failedHtml, /<button(?![^>]*disabled)[^>]*>显示前面的内容<\/button>/);
  assert.match(failedHtml, /重试读取内容/);
  feed.retryMessageContentWindow('message-a');
  const retry = Object.entries(feed.pendingDetails).find(([, request]) => request.kind === 'message-content-items' && request.itemAfterSequence === 32);
  assert.ok(retry); assert.notEqual(retry[0], prefetch[0]);
  assert.equal(view.projection.value.contentWindowByMessageId['message-a'].loading, true);
  reply(retry, { totalItems: 96, totalBytes: 9600, items: items(33), nextSequence: 64 });
  for (const pending of Object.entries(feed.pendingDetails).filter(([, request]) => request.kind === 'message-content-item')) {
    reply(pending, { role: 'model', parts: [part(Number(pending[1].recordId.slice('prefetch-object-'.length)))] });
  }
  const restored = view.projection.value.contentWindowByMessageId['message-a'];
  assert.equal(restored.firstSequence, 33); assert.equal(restored.loading, false); assert.equal(restored.error, undefined); assert.ok(!restored.canRetry);
  assert.equal(view.projection.value.messages[0].content.parts[0].text, 'prefetch-body-33');
});

test('原生内容：metadata自动重试跟随详情loading，成功后清除界面旧错误', async t => {
  const h = ui.stores(t), feed = h.feed, records = nativeShellRecords('terminal');
  records.ModelRequest['request-a'].terminal_state = 'completed';
  records.Message['message-a'] = { ...records.Message['message-a'], revision_id: 'index-auto-retry', item_index_revision_id: 'index-auto-retry' };
  feed.records = records; feed.committedRecords = records;
  feed.projections = { activeConversationWindow: { conversationId: 'conversation-a' } };
  const { useReliableConversation } = await ui.load('composables/useReliableConversation.ts');
  const messageItem = (await ui.load('components/conversation/MessageItem.vue')).default;
  const view = h.scope.run(() => useReliableConversation());
  const reply = ([requestId, request], value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    feed.observeDetailResult({ sessionId: feed.sessionId, requestId, detail: { recordId: request.recordId,
      offset: 0, totalBytes: bytes.length, chunk: bytes.toString('base64'), hasMore: false } });
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    feed.ensureMessageContent('message-a');
    const first = Object.entries(feed.pendingDetails).find(([, request]) => request.kind === 'message-content-items');
    feed.failDetailRequest(first[0], 'transient metadata failure');
    const failed = view.projection.value.contentWindowByMessageId['message-a'];
    assert.equal(failed.loading, false); assert.equal(failed.error, 'transient metadata failure'); assert.equal(failed.canRetry, true);
    t.mock.timers.tick(250);
    const retry = Object.entries(feed.pendingDetails).find(([, request]) => request.kind === 'message-content-items');
    assert.ok(retry); assert.notEqual(retry[0], first[0]);
    const loading = view.projection.value.contentWindowByMessageId['message-a'];
    assert.equal(loading.loading, true); assert.equal(loading.error, undefined); assert.ok(!loading.canRetry);
    const part = { text: 'metadata automatic retry recovered', outputItem: { id: 'auto-retry-item', ordinal: 0, providerResponseId: 'auto-retry-response' } };
    reply(retry, { totalItems: 1, totalBytes: 100, items: [{ id: 'auto-retry-revision', revisionId: 'auto-retry-revision', sequence: 1,
      contentObjectId: 'auto-retry-object', partByteLength: Buffer.byteLength(JSON.stringify(part)), outputItem: part.outputItem }] });
    const body = Object.entries(feed.pendingDetails).find(([, request]) => request.kind === 'message-content-item');
    assert.ok(body); reply(body, { role: 'model', parts: [part] });
    const restored = view.projection.value.contentWindowByMessageId['message-a'];
    assert.equal(restored.loading, false); assert.equal(restored.error, undefined); assert.ok(!restored.canRetry);
    assert.equal(view.projection.value.messages[0].content.parts[0].text, part.text);
    const html = (await h.render(messageItem, { message: view.projection.value.messages[0], contentWindow: restored })).html;
    assert.doesNotMatch(html, /transient metadata failure|重试读取内容/);
  } finally { t.mock.timers.reset(); }
});
