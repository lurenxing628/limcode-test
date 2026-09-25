import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

// A real Runtime database, bounded Feed and client projection: the task panel shows only what
// projectCurrentTaskList derives from committed ToolCall/Operation/ToolOutcome/artifact facts.
const require = createRequire(import.meta.url);
const kernel = require(path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension', 'backend/reliableKernel/index.js'));
const row = (domain, value) => kernel.DOMAIN_REPOSITORIES.domain(domain).insert(value);

const conversationId = 'task-feed-conversation';
const foreignConversationId = 'task-feed-foreign-conversation';
const turnId = 'task-feed-turn';
const foreignTurnId = 'task-feed-foreign-turn';
const messageId = 'task-feed-native-message';
const at = '2026-09-24T16:00:00.000Z';
const rewrite = (status) => ({ kind: 'task_list.operation', mode: 'rewrite', items: [{ title: 'Write tests', status }] });
const update = (status) => ({ kind: 'task_list.operation', mode: 'update', items: [{ title: 'Write tests', status }] });
const planResult = (status) => ({ output: {
  kind: 'submit_plan.result', proposalId: 'task-feed-proposal', status, executionTarget: 'current_conversation'
} });

/** The Runtime a Conversation with a task list, its settled rewrite and still-running task tools. */
async function openRuntime({ laterMessages = 0 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-task-live-feed-'));
  let database;
  const close = async () => {
    if (database) await database.close();
    database = undefined;
    await fs.rm(directory, { recursive: true, force: true });
  };
  try {
    const root = await kernel.resetCandidateRuntimeRoot(directory);
    database = await kernel.RuntimeDatabase.open(root.authority, { hostBootId: 'task-live-feed' });
    const cas = new kernel.ContentAddressedStore(root.authority, root.binding);
    const json = async (value, type = 'application/json') => (await cas.ingest(database, JSON.stringify(value), type)).id;
    const modelBody = await json({ role: 'model', parts: [{ text: '任务' }] }, 'application/vnd.limcode.message+json');
    const userBody = await json({ role: 'user', parts: [{ text: '继续' }] }, 'application/vnd.limcode.message+json');
    const recipe = await json({ recipe: 'task-live-feed' });
    const message = (id, seq, role, owner = conversationId, turn = turnId) => [
      row('Message', { id, created_at: at, updated_at: at, deleted_at: null }),
      row('MessageRevision', { id: `${id}-revision`, message_id: id, revision_seq: 1n, role,
        content_object_id: role === 'model' ? modelBody : userBody, created_at: at }),
      row('MessageCurrentRevisionLink', { id: `${id}-current`, message_id: id, revision_id: `${id}-revision`, updated_at: at }),
      row('MessagePartOfConversation', { id: `${id}-member`, conversation_id: owner, message_id: id, message_seq: BigInt(seq), created_at: at }),
      row('MessageTurnLink', { id: `${id}-turn`, turn_id: turn, message_id: id, role, created_at: at })
    ];
    const request = (id, turn, seq) => [row('ModelRequest', { id, turn_id: turn, request_seq: BigInt(seq), status: 'prepared',
      terminal_state: null, provider_id: 'fixture-provider', model_id: 'fixture-model', context_window_tokens: 128000n,
      compression_threshold_tokens: 100000n, estimated_context_tokens: 1n, authority_snapshot_id: `${id}-authority`,
      settings_snapshot_object_id: null, recipe_object_id: recipe, usage_json: null, stream_stats_json: { attemptSeq: '1', socketGeneration: '0', retryReason: null }, created_at: at, updated_at: at }),
      row('Operation', { id: `${id}-operation`, owner_kind: 'model_request', owner_id: id, operation_seq: 1n, tool_call_id: null,
        status: 'pending', created_at: at, updated_at: at }),
      row('Attempt', { id: `${id}-attempt`, operation_id: `${id}-operation`, attempt_seq: 1n, status: 'pending',
        created_at: at, updated_at: at, completed_at: null }),
      row('ModelContextProjection', { id: `${id}-projection`, owner_kind: 'model_request', owner_id: id,
        root_id: `${id}-context-root`, purpose: 'provider-request', created_at: at })];
    const call = async (id, name, args, source, ordinal, turn = turnId, seq = ordinal + 1) => [
      row('ToolCall', { id, turn_id: turn, call_seq: BigInt(seq), tool_name: name, status: 'terminal',
        arguments_object_id: await json(args), created_at: at, updated_at: at }),
      row('ToolCallSourceLink', { id: `${id}-source`, tool_call_id: id, model_request_id: source.request, message_id: source.message,
        provider_call_id: `${id}-provider`, provider_ordinal: BigInt(ordinal), batch_id: `${id}-batch`, batch_ordinal: 0n,
        thought_signature: null, created_at: at })
    ];
    const oldSource = { request: 'task-feed-old-request', message: 'task-feed-old-message' };
    const nativeSource = { request: 'task-feed-native-request', message: messageId };
    const foreignSource = { request: 'task-feed-foreign-request', message: 'task-feed-foreign-message' };
    await database.transaction([
      row('Conversation', { id: conversationId, title: 'Tasks', status: 'active', created_at: at, updated_at: at }),
      row('Conversation', { id: foreignConversationId, title: 'Other', status: 'active', created_at: at, updated_at: at }),
      row('Turn', { id: turnId, conversation_id: conversationId, status: 'terminated', created_at: at, updated_at: at, terminal_at: at }),
      row('Turn', { id: foreignTurnId, conversation_id: foreignConversationId, status: 'terminated', created_at: at, updated_at: at, terminal_at: at }),
      ...message('task-feed-old-message', 1, 'model'),
      ...message(messageId, 2, 'model'),
      ...message('task-feed-foreign-message', 1, 'model', foreignConversationId, foreignTurnId),
      ...request(oldSource.request, turnId, 1),
      ...request(nativeSource.request, turnId, 2),
      ...request(foreignSource.request, foreignTurnId, 1),
      row('ModelRequestMessageLink', { id: 'task-feed-old-request-link', model_request_id: oldSource.request, message_id: oldSource.message, created_at: at }),
      row('ModelRequestMessageLink', { id: 'task-feed-native-request-link', model_request_id: nativeSource.request, message_id: messageId, created_at: at }),
      row('ModelRequestMessageLink', { id: 'task-feed-foreign-request-link', model_request_id: foreignSource.request, message_id: foreignSource.message, created_at: at }),
      ...await call('task-feed-base', 'update_task_list', rewrite('pending'), oldSource, 0, turnId, 1),
      // The arguments are optimistic on purpose: only a committed result artifact may show them.
      ...await call('task-feed-update-one', 'update_task_list', update('completed'), nativeSource, 0, turnId, 2),
      ...await call('task-feed-update-two', 'update_task_list', update('completed'), nativeSource, 1, turnId, 3),
      ...await call('task-feed-plan', 'submit_plan', { plan: '完成', taskList: rewrite('completed') }, nativeSource, 2, turnId, 4),
      ...await call('task-feed-rejected-plan', 'submit_plan', { plan: '放弃', taskList: rewrite('completed') }, nativeSource, 3, turnId, 5),
      ...await call('task-feed-foreign-plan', 'submit_plan', { plan: '别处', taskList: rewrite('completed') }, foreignSource, 0, foreignTurnId, 1)
    ]);
    const settle = async (toolCallId, { operation = 'succeeded', detail, outcome = false } = {}) => {
      const steps = [];
      if (operation) steps.push(row('Operation', { id: `${toolCallId}-operation`, owner_kind: 'tool_call', owner_id: toolCallId,
        operation_seq: 1n, tool_call_id: toolCallId, status: operation, created_at: at, updated_at: at }));
      if (detail) steps.push(row('ToolResultArtifact', { id: `${toolCallId}-artifact`, tool_call_id: toolCallId, role: 'no_effect_result',
        content_object_id: await json({ toolCallId, status: 'succeeded', detail }), created_at: at }));
      if (outcome) steps.push(row('ToolOutcome', { id: `${toolCallId}-outcome`, tool_call_id: toolCallId, status: 'succeeded',
        content_object_id: null, created_at: at }));
      await database.transaction(steps);
    };
    await settle('task-feed-base', { detail: { kind: 'task-list', operation: rewrite('pending') }, outcome: true });
    for (let start = 0; start < laterMessages; start += 50) {
      await database.transaction(Array.from({ length: Math.min(50, laterMessages - start) }, (_value, offset) =>
        message(`task-feed-later-${start + offset}`, 3 + start + offset, 'user')).flat());
    }
    return { database, settle, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function createHarness(options) {
  const pinia = await import('pinia');
  const { createSSRApp } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  let server;
  let runtime;
  let feed;
  // Every resource opened here is released even when setup itself fails; a leaked Vite server or
  // Runtime worker would otherwise keep the whole serial test run alive.
  const release = async () => {
    feed?.close();
    try {
      await server?.close();
    } finally {
      await runtime?.close();
      pinia.setActivePinia(previousPinia);
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    }
  };
  try {
    globalThis.window = {
      addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, atob,
      requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 0); },
      cancelAnimationFrame(id) { clearTimeout(id); },
      acquireVsCodeApi() { return { postMessage() {}, getState() {}, setState() {} }; }
    };
    runtime = await openRuntime(options);
    server = await createWebviewSsrServer();
    const { default: TaskListTopPanel } = await server.ssrLoadModule('/src/components/taskList/TaskListTopPanel.vue');
    const { taskListToolDisplay } = await server.ssrLoadModule('/src/components/content/toolDisplay/taskListToolDisplay.ts');
    const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
    globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
    feed = new kernel.BoundedClientFeed(runtime.database);
    const active = pinia.createPinia();
    pinia.setActivePinia(active);
    const store = useReliableKernelClientFeedStore();
    const frames = [];
    const connection = await feed.connect({ activeConversationId: conversationId, send(frame) { frames.push(frame); } });
    let consumed = 0;
    async function drain() {
      for (let tries = 0; tries < 400 && consumed === frames.length; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(consumed < frames.length, 'committed task fact must reach the bounded Feed');
      const frame = frames[consumed++];
      store.observeData(frame);
      feed.acknowledge({ sessionId: frame.sessionId, hostBootId: frame.hostBootId, messageSeq: frame.messageSeq });
      return frame;
    }
    /** An artifact-only commit is sent as changes first; its settled owner then refreshes the snapshot. */
    async function drainUntilSnapshot() {
      for (let index = 0; index < 3; index += 1) {
        const frame = await drain();
        if (frame.type === 'reliable-kernel.snapshot') return frame;
      }
      assert.fail('the settled task fact must refresh the Conversation snapshot');
    }
    async function settleQuietly() {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(frames.length, consumed, 'this commit must not reach the Conversation Feed');
    }
    await drain();
    const render = () => renderToString(createSSRApp(TaskListTopPanel, {}).use(active));
    return {
      runtime, feed, store, frames, connection, drain, drainUntilSnapshot, settleQuietly, render, taskListToolDisplay, close: release
    };
  } catch (error) {
    await release();
    throw error;
  }
}

test('成功 Operation 在有序 ToolOutcome 仍被慢工具阻塞时刷新 Feed→store→顶栏；迟到 Outcome 不回退', async () => {
  const h = await createHarness();
  try {
    assert.match(await h.render(), /0\/1 已完成/);
    await h.runtime.settle('task-feed-update-one', { detail: { kind: 'task-list', operation: update('in_progress') } });
    const early = await h.drain();
    assert.equal(early.type, 'reliable-kernel.snapshot', 'Operation settlement itself must refresh the derived Conversation projection');
    assert.equal(early.projections.activeConversationWindow.currentTaskList.sourceToolCallId, 'task-feed-update-one');
    assert.match(await h.render(), /当前：Write tests/);
    // The ordered ToolOutcome arrives later; the projection re-derived from it keeps the same state.
    await h.runtime.settle('task-feed-update-one', { operation: null, outcome: true });
    const late = await h.drain();
    assert.equal(late.type, 'reliable-kernel.snapshot');
    assert.equal(late.projections.activeConversationWindow.currentTaskList.sourceToolCallId, 'task-feed-update-one');
    assert.match(await h.render(), /当前：Write tests/);
    assert.match(await h.render(), /0\/1 已完成/);
  } finally { await h.close(); }
});

test('仅有成功 Operation 时不按参数猜任务，随后合法 no_effect_result artifact 独立刷新', async () => {
  const h = await createHarness();
  try {
    await h.runtime.settle('task-feed-update-one');
    assert.equal((await h.drain()).type, 'reliable-kernel.snapshot');
    assert.match(await h.render(), /0\/1 已完成/, 'Operation 成功但无 artifact 不得使用 arguments（completed）猜任务');
    await h.runtime.settle('task-feed-update-one', { operation: null, detail: { kind: 'task-list', operation: update('in_progress') } });
    const refreshed = await h.drainUntilSnapshot();
    assert.equal(refreshed.projections.activeConversationWindow.currentTaskList.sourceToolCallId, 'task-feed-update-one');
    assert.match(await h.render(), /当前：Write tests/);
  } finally { await h.close(); }
});

test('下方卡无成功结果时只能预览参数，成功结果必须来自真实 result detail', async () => {
  const h = await createHarness();
  try {
    const args = { kind: 'task_list.operation', mode: 'rewrite', items: [{ title: 'Write tests', status: 'completed' }] };
    const actual = { kind: 'task_list.operation', mode: 'rewrite', items: [{ title: 'Write tests', status: 'in_progress' }] };
    const context = (status, result) => ({
      toolName: 'update_task_list', args, result, events: [],
      toolCall: {
        id: 'task-feed-update-one', messageId, name: 'update_task_list', args: JSON.stringify(args),
        status, createdAt: 0, updatedAt: 0
      },
      stringifyValue: String
    });
    for (const status of ['queued', 'warning', 'success']) {
      const preview = h.taskListToolDisplay(context(status, status === 'warning'
        ? { kind: 'task-list', operation: actual } : undefined));
      assert.equal(preview.outputSections.length, 0, 'arguments alone cannot produce a completed output');
      assert.match(preview.inputSections[0].title, /预览/);
      assert.equal(preview.inputSections[0].taskList, undefined, '未决/失败不能画已完成标记');
      assert.match(preview.inputSections[0].rows.at(-1).value, /目标状态：completed/);
    }
    const completed = h.taskListToolDisplay(context('success', { kind: 'task-list', operation: actual }));
    assert.equal(completed.outputSections.length, 1);
    assert.equal(completed.outputSections[0].taskList.items[0].status, 'in_progress',
      'actual settled result, not optimistic completed argument, is shown');
    const withSpeculativeTimeline = {
      ...context('success', { kind: 'task-list', operation: actual }),
      currentConversationId: conversationId,
      messages: [{
        id: messageId, conversationId, seq: 1, createdAt: 0,
        content: { role: 'model', parts: [] }
      }]
    };
    withSpeculativeTimeline.toolCalls = [withSpeculativeTimeline.toolCall];
    const canonical = h.taskListToolDisplay(withSpeculativeTimeline);
    assert.equal(canonical.outputSections[0].taskList.items[0].status, 'in_progress',
      'a hydrated result must not be overwritten by a historical timeline reconstructed from arguments');
    assert.doesNotMatch(canonical.outputSections[0].title, /已完成/,
      'do not present argument-derived progress as confirmed output');
  } finally { await h.close(); }
});

test('来源 ToolCall 已离开有界窗口时仍由提交投影推进任务，不钉住历史 ToolCall；历史分页与 reload 不回放参数', async () => {
  // 205 later messages push the rewrite and both updates out of the 200-message live window.
  const h = await createHarness({ laterMessages: 205 });
  try {
    assert.equal(h.store.records.ToolCall?.['task-feed-base'], undefined);
    assert.match(await h.render(), /0\/1 已完成/);
    await h.runtime.settle('task-feed-update-one', { detail: { kind: 'task-list', operation: update('in_progress') } });
    assert.equal((await h.drain()).type, 'reliable-kernel.snapshot');
    assert.match(await h.render(), /当前：Write tests/);
    await h.runtime.settle('task-feed-update-two', { detail: { kind: 'task-list', operation: update('completed') } });
    const second = await h.drain();
    assert.equal(second.type, 'reliable-kernel.snapshot');
    assert.equal(second.projections.activeConversationWindow.currentTaskList.sourceToolCallId, 'task-feed-update-two');
    for (const id of ['task-feed-base', 'task-feed-update-one', 'task-feed-update-two']) {
      assert.equal(h.store.records.ToolCall?.[id], undefined,
        'current task projection must not pin its historical source ToolCall in the live window');
    }
    assert.match(await h.render(), /1\/1 已完成/);
    assert.doesNotMatch(await h.render(), /当前：Write tests/);
    h.store.historyConversationId = conversationId;
    h.store.historyRecords = {
      Message: { 'task-feed-old-message': {
        id: 'task-feed-old-message', conversation_id: conversationId,
        message_seq: '1', display_seq: '1', role: 'model', created_at: at
      } }
    };
    assert.match(await h.render(), /1\/1 已完成/, 'loading a historical page must not replay argument-only operations');
    // Reload reads a new session snapshot instead of retaining historical ToolCalls.
    h.feed.disconnect(h.connection.sessionId);
    const reload = await h.feed.connect({ activeConversationId: conversationId, send(frame) { h.store.observeData(frame); } });
    assert.match(await h.render(), /1\/1 已完成/);
    h.feed.disconnect(reload.sessionId);
  } finally { await h.close(); }
});

test('批准本会话 Plan 才重建任务，拒绝和异会话 Plan 均不能冒充已批准', async () => {
  const h = await createHarness();
  try {
    await h.runtime.settle('task-feed-rejected-plan', { operation: 'rejected', detail: planResult('rejected') });
    assert.equal((await h.drain()).type, 'reliable-kernel.changes', 'a rejected Plan is not a settled task fact');
    assert.match(await h.render(), /0\/1 已完成/);
    await h.runtime.settle('task-feed-foreign-plan', { detail: planResult('approved') });
    await h.settleQuietly();
    assert.match(await h.render(), /0\/1 已完成/);
    await h.runtime.settle('task-feed-plan', { detail: planResult('approved') });
    const frame = await h.drain();
    assert.equal(frame.type, 'reliable-kernel.snapshot');
    assert.equal(frame.projections.activeConversationWindow.currentTaskList.sourceToolCallId, 'task-feed-plan');
    assert.match(await h.render(), /1\/1 已完成/);
  } finally { await h.close(); }
});
