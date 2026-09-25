import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

const require = createRequire(import.meta.url);
const compiledRoot = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT)
  : path.resolve('dist/extension');
const { BoundedClientFeed } = require(path.join(compiledRoot, 'backend/reliableKernel/clientFeed.js'));

const conversationId = 'task-feed-conversation';
const foreignConversationId = 'task-feed-foreign-conversation';
const turnId = 'task-feed-turn';
const foreignTurnId = 'task-feed-foreign-turn';
const messageId = 'task-feed-native-message';
const at = '2026-09-24T16:00:00.000Z';
const task = (status, sourceToolCallId = 'task-feed-base') => ({
  key: 'write tests', title: 'Write tests', status,
  createdOrder: 0, updatedOrder: 0, sourceToolCallId
});
const taskCard = (status, sourceToolCallId = 'task-feed-base', ordinal = '0', sourceMessageId = 'task-feed-old-message') => ({
  conversationId,
  revision: `1:${ordinal}:${ordinal}:${sourceToolCallId}`,
  operationCount: Number(ordinal) + 1,
  sourceToolCallId,
  sourceMessageId,
  baselineToolCallId: 'task-feed-base',
  items: [task(status, sourceToolCallId)],
  stats: {
    total: 1, pending: status === 'pending' ? 1 : 0,
    inProgress: status === 'in_progress' ? 1 : 0,
    completed: status === 'completed' ? 1 : 0,
    blocked: 0, cancelled: 0, open: status === 'completed' ? 0 : 1
  }
});
const call = (id, name = 'update_task_list', turn = turnId) => ({
  id, tool_name: name, turn_id: turn, call_seq: '1',
  status: 'pending', arguments_object_id: `${id}-args`, created_at: at, updated_at: at
});
const operation = (id, toolCallId, status) => ({
  domain: 'Operation', id, kind: 'upsert', record: {
    id, owner_kind: 'tool_call', owner_id: toolCallId, tool_call_id: toolCallId,
    operation_seq: '1', status, created_at: at, updated_at: at
  }
});
const resultArtifact = (id, toolCallId) => ({
  domain: 'ToolResultArtifact', id, kind: 'upsert', record: {
    id, tool_call_id: toolCallId, role: 'no_effect_result', content_object_id: `${id}-content`, created_at: at
  }
});
const outcome = (id, toolCallId) => ({
  domain: 'ToolOutcome', id, kind: 'upsert', record: {
    id, tool_call_id: toolCallId, status: 'succeeded', content_object_id: `${id}-content`, created_at: at
  }
});

class FakeCommittedTaskDatabase {
  hostBootId = 'task-feed-host';
  commitSeq = 1;
  calls = new Map();
  operations = new Map();
  outcomes = new Map();
  turns = new Map([
    [turnId, { id: turnId, conversation_id: conversationId, status: 'active', created_at: at }],
    [foreignTurnId, { id: foreignTurnId, conversation_id: foreignConversationId, status: 'active', created_at: at }]
  ]);
  currentTaskList = taskCard('pending');
  visibleCallIds = new Set();
  visibleMessages = [];
  listeners = new Set();

  constructor() {
    this.calls.set('task-feed-base', call('task-feed-base'));
    this.calls.set('task-feed-update-one', call('task-feed-update-one'));
    this.calls.set('task-feed-update-two', call('task-feed-update-two'));
    this.calls.set('task-feed-plan', call('task-feed-plan', 'submit_plan'));
    this.calls.set('task-feed-rejected-plan', call('task-feed-rejected-plan', 'submit_plan'));
    this.calls.set('task-feed-foreign-plan', call('task-feed-foreign-plan', 'submit_plan', foreignTurnId));
    this.visibleCallIds.add('task-feed-update-one');
    this.visibleCallIds.add('task-feed-update-two');
    this.visibleCallIds.add('task-feed-plan');
    this.visibleCallIds.add('task-feed-rejected-plan');
  }

  projection(activeConversationId) {
    return {
      navigationSummary: { conversations: [{ id: conversationId, title: 'Tasks', status: 'active' }] },
      activeConversationWindow: {
        conversationId: activeConversationId, messages: [...this.visibleMessages],
        currentTaskList: activeConversationId === conversationId ? this.currentTaskList : null,
        lastMessageSeq: String(this.visibleMessages.length),
        visibleMessageCount: String(this.visibleMessages.length), taskList: []
      },
      activeTurnSummary: { turns: [this.turns.get(activeConversationId === foreignConversationId ? foreignTurnId : turnId)] },
      activeToolAndInteractionSummary: {
        toolCalls: [...this.visibleCallIds].map((id) => this.calls.get(id))
      },
      subagentDeliverySummary: {}
    };
  }

  async externalDataVersion() { return '1'; }
  async clientProjectionSnapshot(activeConversationId) {
    return { snapshotCommitSeq: String(this.commitSeq), snapshot: this.projection(activeConversationId) };
  }
  async clientProjectionSnapshotAndSubscribe(activeConversationId, listener) {
    this.listeners.add(listener);
    return {
      barrier: await this.clientProjectionSnapshot(activeConversationId),
      unsubscribe: () => this.listeners.delete(listener)
    };
  }
  async snapshot(reads) {
    return {
      snapshotCommitSeq: String(this.commitSeq),
      snapshot: reads.map((read) => {
        if (read.domain === 'ToolCall') return this.calls.get(read.id) ?? null;
        if (read.domain === 'Turn') return this.turns.get(read.id) ?? null;
        if (read.domain === 'Operation' && read.kind === 'list') {
          return [...this.operations.values()].filter((row) => row.tool_call_id === read.where.tool_call_id);
        }
        if (read.domain === 'ToolOutcome' && read.kind === 'list') {
          return [...this.outcomes.values()].filter((row) => row.tool_call_id === read.where.tool_call_id);
        }
        return null;
      })
    };
  }
  commit(changes, currentTaskList = this.currentTaskList) {
    this.commitSeq += 1;
    this.currentTaskList = currentTaskList;
    for (const change of changes) {
      if (change.domain === 'Operation') this.operations.set(change.id, change.record);
      if (change.domain === 'ToolOutcome') this.outcomes.set(change.id, change.record);
    }
    const commit = { commitSeq: String(this.commitSeq), changes, allocatedSequences: [] };
    for (const listener of this.listeners) listener(commit);
  }
}

async function createHarness() {
  const pinia = await import('pinia');
  const { createSSRApp } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, atob,
    requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 0); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    acquireVsCodeApi() { return { postMessage() {}, getState() {}, setState() {} }; }
  };
  const server = await createWebviewSsrServer();
  const { default: TaskListTopPanel } = await server.ssrLoadModule('/src/components/taskList/TaskListTopPanel.vue');
  const { taskListToolDisplay } = await server.ssrLoadModule('/src/components/content/toolDisplay/taskListToolDisplay.ts');
  const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
  globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
  const database = new FakeCommittedTaskDatabase();
  const feed = new BoundedClientFeed(database);
  const active = pinia.createPinia();
  pinia.setActivePinia(active);
  const store = useReliableKernelClientFeedStore();
  const frames = [];
  const connection = await feed.connect({ activeConversationId: conversationId, send(frame) { frames.push(frame); } });
  let consumed = 0;
  async function drain() {
    // Both a synchronous refresh and a bounded database probe eventually emit one data frame.
    for (let tries = 0; tries < 40 && consumed === frames.length; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(consumed < frames.length, 'committed task fact must reach the bounded Feed');
    const frame = frames[consumed++];
    store.observeData(frame);
    feed.acknowledge({ sessionId: frame.sessionId, hostBootId: frame.hostBootId, messageSeq: frame.messageSeq });
    return frame;
  }
  await drain();
  async function render() {
    const app = createSSRApp(TaskListTopPanel, {}).use(active);
    return renderToString(app);
  }
  return {
    database, feed, store, frames, connection, drain, render, taskListToolDisplay,
    async close() {
      feed.close();
      await server.close();
      pinia.setActivePinia(previousPinia);
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    }
  };
}

test('成功 Operation 在有序 ToolOutcome 仍被慢工具阻塞时刷新 Feed→store→顶栏；迟到 Outcome 不回退', async () => {
  const h = await createHarness();
  try {
    assert.match(await h.render(), /0\/1 已完成/);
    h.database.commit([
      operation('task-feed-operation-one', 'task-feed-update-one', 'succeeded'),
      resultArtifact('task-feed-artifact-one', 'task-feed-update-one')
    ], taskCard('in_progress', 'task-feed-update-one', '1', messageId));
    const early = await h.drain();
    assert.equal(early.type, 'reliable-kernel.snapshot', 'Operation settlement itself must refresh the derived Conversation projection');
    assert.match(await h.render(), /当前：Write tests/);
    h.database.commit([outcome('task-feed-outcome-one', 'task-feed-update-one')]);
    await h.drain();
    assert.match(await h.render(), /当前：Write tests/);
  } finally { await h.close(); }
});

test('窗口外 ToolCall 仅凭已提交 Operation 与随后合法 no_effect_result artifact 独立刷新', async () => {
  const h = await createHarness();
  try {
    h.database.visibleCallIds.delete('task-feed-update-one');
    h.database.commit([operation('task-feed-hidden-operation', 'task-feed-update-one', 'succeeded')]);
    assert.equal((await h.drain()).type, 'reliable-kernel.snapshot');
    assert.match(await h.render(), /0\/1 已完成/, 'Operation 成功但无 artifact 不得使用 arguments 猜任务');
    h.database.commit([resultArtifact('task-feed-hidden-artifact', 'task-feed-update-one')],
      taskCard('in_progress', 'task-feed-update-one', '1', messageId));
    assert.equal((await h.drain()).type, 'reliable-kernel.snapshot');
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

test('同一原生聚合 Message 后续 provider ordinal 更新、裁剪 source ToolCall、历史分页与 reload 仍只认提交投影', async () => {
  const h = await createHarness();
  try {
    h.database.commit([
      operation('task-feed-operation-one', 'task-feed-update-one', 'succeeded'),
      resultArtifact('task-feed-artifact-one', 'task-feed-update-one')
    ], taskCard('in_progress', 'task-feed-update-one', '1', messageId));
    await h.drain();
    // An earlier rewrite and the first update have left the 200-row live suffix. The second
    // provider ordinal of the same native message is the sole visible source of the next update.
    h.database.visibleCallIds.delete('task-feed-update-one');
    h.database.visibleCallIds.delete('task-feed-base');
    h.database.commit([
      operation('task-feed-operation-two', 'task-feed-update-two', 'succeeded'),
      resultArtifact('task-feed-artifact-two', 'task-feed-update-two')
    ], taskCard('completed', 'task-feed-update-two', '2', messageId));
    const second = await h.drain();
    assert.equal(second.type, 'reliable-kernel.snapshot');
    assert.equal(h.store.records.ToolCall?.['task-feed-update-one'], undefined,
      'current task projection must not pin its historical source ToolCall in the live window');
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
    // Reload exercises the new session snapshot instead of retaining historical ToolCalls.
    h.feed.disconnect(h.connection.sessionId);
    const reload = await h.feed.connect({ activeConversationId: conversationId, send(frame) { h.store.observeData(frame); } });
    assert.match(await h.render(), /1\/1 已完成/);
    h.feed.disconnect(reload.sessionId);
  } finally { await h.close(); }
});

test('批准本会话 Plan 才重建任务，拒绝和异会话 Plan 均不能冒充已批准', async () => {
  const h = await createHarness();
  try {
    h.database.commit([
      operation('task-feed-rejected-operation', 'task-feed-rejected-plan', 'rejected'),
      resultArtifact('task-feed-rejected-artifact', 'task-feed-rejected-plan')
    ]);
    assert.equal((await h.drain()).type, 'reliable-kernel.changes');
    assert.match(await h.render(), /0\/1 已完成/);
    h.database.commit([
      operation('task-feed-foreign-operation', 'task-feed-foreign-plan', 'succeeded'),
      resultArtifact('task-feed-foreign-artifact', 'task-feed-foreign-plan')
    ], taskCard('pending'));
    assert.match(await h.render(), /0\/1 已完成/);
    h.database.commit([
      operation('task-feed-plan-operation', 'task-feed-plan', 'succeeded'),
      resultArtifact('task-feed-plan-artifact', 'task-feed-plan')
    ], taskCard('completed', 'task-feed-plan', '3', messageId));
    const frame = await h.drain();
    assert.equal(frame.type, 'reliable-kernel.snapshot');
    assert.match(await h.render(), /1\/1 已完成/);
  } finally { await h.close(); }
});
