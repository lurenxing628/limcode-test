import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
const kernel = load('backend/reliableKernel/index.js');
const { skillsTool, validateSkillsToolArguments } = load('backend/world/modules/tools/definitions/skills/index.js');
const { taskListTool, TASK_LIST_ITEM_SCHEMA } = load('backend/world/modules/tools/definitions/taskList/index.js');
const { TASK_LIST_ITEM_STATUSES } = load('shared/protocol.js');
const { requireTaskListOperation, taskListToolArgumentMetadata, applyTaskListOperationToSnapshot } = load('shared/taskListProjection.js');
const repo = domain => kernel.DOMAIN_REPOSITORIES.domain(domain);
const rows = async (database, domain, where = {}) => (await database.snapshotAll(repo(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 100 }))).snapshot;

test('skills empty source uses normal lookup while an invalid source cannot load a different skill', async () => {
  const requests = [];
  const skill = { name: 'review', source: 'codex', dir: '/mock/skills/review', path: '/mock/skills/review/SKILL.md' };
  const skills = {
    lookup(name, source) { requests.push([name, source]); return { status: 'found', skill }; },
    async readBody() { return { text: 'Review instructions.', startLine: 1 }; },
    refresh() { assert.fail('a malformed source must not refresh the catalog'); }
  };
  for (const source of [undefined, null, '', ' ', [], {}]) {
    const result = await skillsTool.execute({ name: ' review ', source, harmlessExtra: true }, { skills });
    assert.equal(result.ok, true);
    assert.equal(result.output.body, 'Review instructions.');
    assert.deepEqual(requests.at(-1), ['review', undefined]);
  }
  assert.deepEqual(validateSkillsToolArguments({ name: 'review', source: '.Codex' }), { name: 'review', source: 'codex' });
  const lookupCount = requests.length;
  for (const source of ['not-a-source', 0, false, { source: 'codex' }]) {
    const result = await skillsTool.execute({ name: 'review', source }, { skills });
    assert.equal(result.ok, false);
    assert.match(result.output, /skills\.source/);
  }
  assert.equal(requests.length, lookupCount);
});

test('task schema and summary share canonical statuses and parameter semantics', async () => {
  assert.deepEqual(TASK_LIST_ITEM_SCHEMA.properties.status.enum, TASK_LIST_ITEM_STATUSES);
  const input = { mode: 'rewrite', unknownNote: 'harmless', items: [{ title: ' Verify ', description: null, status: '', delete: null, extra: true }] };
  assert.deepEqual(requireTaskListOperation(input), { kind: 'task_list.operation', mode: 'rewrite', items: [{ title: 'Verify' }] });
  assert.match(taskListTool.summary(input), /1 项/);
  assert.equal(taskListTool.summary({ mode: 'rewrite', items: [{ title: 'Verify', status: 'done' }] }), undefined);
  assert.deepEqual(requireTaskListOperation({ mode: 'rewrite', items: [{ title: 'Verify', delete: true }] }).items, [{ title: 'Verify' }]);
  assert.throws(() => requireTaskListOperation({ mode: 'update', items: [{ title: 'Verify', status: false }] }), /status is invalid/);
  assert.throws(() => requireTaskListOperation({ mode: 'update', items: [{ title: 'Verify', delete: 0 }] }), /must be boolean/);
  assert.equal((await taskListTool.execute(input)).ok, false, 'the declaration cannot pretend to persist a task operation');
});

test('task mode consumes only applicable controls and repeated titles retain deterministic input order', () => {
  const rewrite = { kind: 'unused hint', mode: 'rewrite', items: [{ title: ' Verify ', status: 'pending', delete: 0 }, { title: 'verify', status: 'completed', delete: false }] };
  const original = structuredClone(rewrite);
  const operation = requireTaskListOperation(rewrite);
  assert.deepEqual(operation, { kind: 'task_list.operation', mode: 'rewrite', items: [{ title: 'Verify', status: 'pending' }, { title: 'verify', status: 'completed' }] });
  const snapshot = applyTaskListOperationToSnapshot({ items: [] }, operation, { operationIndex: 0, toolCallId: 'fixture' });
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].status, 'completed');
  assert.deepEqual(taskListToolArgumentMetadata(rewrite).ignoredFields, ['kind', 'items[0].delete', 'items[1].delete']);
  assert.deepEqual(rewrite, original);
  const deletion = { mode: 'update', items: [{ title: 'Verify', delete: true, status: false, description: 0 }] };
  assert.deepEqual(requireTaskListOperation(deletion).items, [{ title: 'Verify', delete: true }]);
  assert.deepEqual(taskListToolArgumentMetadata(deletion).ignoredFields, ['items[0].status', 'items[0].description']);
  assert.throws(() => requireTaskListOperation({ mode: 'update', items: [{ title: 'Verify', delete: 0 }] }), /must be boolean/);
});

test('task-list production settlement preserves frozen input and replays its canonical CAS result', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-task-arguments-'));
  let database;
  try {
    const authority = new kernel.RootAuthority(() => path.join(temporary, 'runtime'));
    await kernel.initializeEmptyRuntimeRoot(authority);
    database = await kernel.RuntimeDatabase.open(authority);
    const store = kernel.ContentAddressedStore.forDatabase(authority, database);
    const effects = new kernel.EffectControlPlane(database, store);
    const interactions = new kernel.ToolInteractionControlPlane(database, store, effects);
    const now = new Date().toISOString();
    await database.transaction([
      repo('Conversation').insert({ id: 'conversation', title: 'Task argument fixture', status: 'active', created_at: now, updated_at: now }),
      repo('Turn').insert({ id: 'turn', conversation_id: 'conversation', status: 'active', created_at: now, updated_at: now, terminal_at: null }),
      repo('ExecutionLease').insert({ id: 'lease', conversation_id: 'conversation', turn_id: 'turn', owner_id: 'fixture', host_boot_id: database.hostBootId,
        generation: 1n, acquired_at: now, expires_at: new Date(Date.now() + 600_000).toISOString() })
    ]);
    const args = { mode: 'rewrite', items: [{ title: ' Verify ', status: 'in_progress', description: null, delete: false, note: 'ignored' }], note: 'ignored' };
    const original = JSON.stringify(args);
    await effects.createToolCall({ source: { kind: 'internal', key: 'create-task' }, toolCallId: 'task', turnId: 'turn', toolName: 'update_task_list', arguments: args });
    const input = { source: { kind: 'internal', key: 'settle-task' }, toolCallId: 'task', operation: args };
    const result = await interactions.settleTaskList(input);
    assert.equal(result.terminal.status, 'succeeded');
    assert.equal(JSON.stringify(args), original);
    const [call] = await rows(database, 'ToolCall', { id: 'task' });
    const [argumentMetadata] = await rows(database, 'ContentObject', { id: call.arguments_object_id });
    assert.deepEqual(JSON.parse((await store.read(argumentMetadata)).toString('utf8')), JSON.parse(original));
    const [outcome] = await rows(database, 'ToolOutcome', { tool_call_id: 'task' });
    const [resultMetadata] = await rows(database, 'ContentObject', { id: outcome.content_object_id });
    const body = JSON.parse((await store.read(resultMetadata)).toString('utf8'));
    assert.deepEqual(body.detail.operation, { kind: 'task_list.operation', mode: 'rewrite', items: [{ title: 'Verify', status: 'in_progress' }] });
    assert.equal(body.detail.kind, 'task-list');
    assert.deepEqual(body.detail.ignoredFields, ['items[0].delete']);
    assert.match(body.detail.warning, /mode=rewrite.*items\[0\]\.delete/);
    assert.equal((await interactions.settleTaskList(input)).deduplicated, true);
    assert.equal((await rows(database, 'ToolOutcome', { tool_call_id: 'task' })).length, 1);
    assert.equal((await rows(database, 'Operation', { tool_call_id: 'task' }))[0].status, 'succeeded');

    const invalid = { mode: 'rewrite', items: [{ title: 'Verify', status: 'done' }] };
    await effects.createToolCall({ source: { kind: 'internal', key: 'create-invalid' }, toolCallId: 'invalid', turnId: 'turn', toolName: 'update_task_list', arguments: invalid });
    await assert.rejects(interactions.settleTaskList({ source: { kind: 'internal', key: 'settle-invalid' }, toolCallId: 'invalid', operation: invalid }), /status is invalid/);
    assert.equal((await rows(database, 'Operation', { tool_call_id: 'invalid' })).length, 0);
    assert.equal((await rows(database, 'ToolOutcome', { tool_call_id: 'invalid' })).length, 0);
    assert.equal((await rows(database, 'InteractionRequest')).length, 0);
    assert.equal((await rows(database, 'EffectIntent')).length, 0);
  } finally {
    if (database) await database.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('ask-user validates before a new durable pause and replays existing requests before validation', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-ask-arguments-'));
  let database;
  try {
    const authority = new kernel.RootAuthority(() => path.join(temporary, 'runtime'));
    await kernel.initializeEmptyRuntimeRoot(authority);
    database = await kernel.RuntimeDatabase.open(authority);
    const store = kernel.ContentAddressedStore.forDatabase(authority, database);
    const effects = new kernel.EffectControlPlane(database, store);
    const interactions = new kernel.ToolInteractionControlPlane(database, store, effects);
    const now = new Date().toISOString();
    await database.transaction([
      repo('Conversation').insert({ id: 'conversation', title: 'Ask argument fixture', status: 'active', created_at: now, updated_at: now }),
      repo('Turn').insert({ id: 'turn', conversation_id: 'conversation', status: 'active', created_at: now, updated_at: now, terminal_at: null }),
      repo('ExecutionLease').insert({ id: 'lease', conversation_id: 'conversation', turn_id: 'turn', owner_id: 'fixture', host_boot_id: database.hostBootId,
        generation: 1n, acquired_at: now, expires_at: new Date(Date.now() + 600_000).toISOString() })
    ]);
    const args = { question: ' Continue? ', options: [{ label: ' Continue ', description: null }], multiple: null, harmlessNote: true };
    await effects.createToolCall({ source: { kind: 'internal', key: 'create-ask' }, toolCallId: 'ask', turnId: 'turn', toolName: 'ask_user', arguments: args });
    const input = { source: { kind: 'internal', key: 'pause-ask' }, toolCallId: 'ask', prompt: args };
    const pause = await interactions.pauseForAskUser(input);
    const [request] = await rows(database, 'InteractionRequest', { id: pause.requestId });
    const [metadata] = await rows(database, 'ContentObject', { id: request.prompt_object_id });
    const promptBytes = await store.read(metadata);
    assert.deepEqual(JSON.parse(promptBytes.toString('utf8')).prompt, { question: 'Continue?', options: [{ label: 'Continue' }], multiple: false });
    assert.equal((await interactions.pauseForAskUser({ ...input, prompt: { options: [] } })).deduplicated, true);
    const resolved = await interactions.resolveAskUser({ source: { kind: 'command', key: 'answer-ask' }, requestId: pause.requestId,
      response: { answer: { selectedOptionIndexes: [0] } } });
    assert.equal(resolved.terminal.status, 'succeeded');
    assert.equal((await interactions.pauseForAskUser({ ...input, prompt: null })).deduplicated, true);
    assert.deepEqual(await store.read(metadata), promptBytes);

    const invalid = { question: 'Continue?', options: [] };
    await effects.createToolCall({ source: { kind: 'internal', key: 'create-invalid-ask' }, toolCallId: 'invalid-ask', turnId: 'turn', toolName: 'ask_user', arguments: invalid });
    const prepare = store.prepare.bind(store);
    let promptPreparations = 0;
    store.prepare = async (database, content, contentType) => {
      if (contentType === 'application/vnd.limcode.ask-user-prompt+json') promptPreparations++;
      return prepare(database, content, contentType);
    };
    await assert.rejects(interactions.pauseForAskUser({ source: { kind: 'internal', key: 'pause-invalid-ask' }, toolCallId: 'invalid-ask', prompt: invalid }), /options must contain 1 to 8/);
    assert.equal(promptPreparations, 0);
    assert.equal((await rows(database, 'Operation', { tool_call_id: 'invalid-ask' })).length, 0);
    assert.equal((await rows(database, 'ToolOutcome', { tool_call_id: 'invalid-ask' })).length, 0);
    assert.equal((await rows(database, 'InteractionRequest')).length, 1);
    assert.equal((await rows(database, 'OutcomePause')).length, 1);
  } finally {
    if (database) await database.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('historical invalid pending Ask remains visible with the existing cancellation route', async () => {
  const { createSSRApp } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const pinia = await import('pinia');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const messages = [];
  globalThis.window = { addEventListener() {}, removeEventListener() {}, setTimeout() { return 1; }, clearTimeout() {},
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
    acquireVsCodeApi() { return { postMessage(message) { messages.push(structuredClone(message)); }, getState() {}, setState() {} }; } };
  const server = await createWebviewSsrServer();
  try {
    const { default: panel } = await server.ssrLoadModule('/src/components/askUser/AskUserTopPanel.vue');
    const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
    const { useAskUserStore } = await server.ssrLoadModule('/src/stores/useAskUserStore.ts');
    const { interactionViewFromReliableRuntime } = await server.ssrLoadModule('/src/domain/interactionProjection.ts');
    const activePinia = pinia.createPinia();
    pinia.setActivePinia(activePinia);
    const feed = useReliableKernelClientFeedStore();
    const invalid = { question: 'Continue?', options: [] };
    const interaction = { id: 'ask-request', request_kind: 'ask_user', status: 'pending', prompt_object_id: 'ask-prompt', created_at: 1, updated_at: 1 };
    feed.projections = { activeConversationWindow: { conversationId: 'conversation' } };
    feed.records = {
      Message: { message: { id: 'message', conversation_id: 'conversation', role: 'model', revision_id: 'revision', message_seq: '1' } },
      MessageTurnLink: { link: { id: 'link', message_id: 'message', turn_id: 'turn', role: 'model' } },
      Turn: { turn: { id: 'turn', conversation_id: 'conversation', status: 'active' } },
      ToolCall: { call: { id: 'call', turn_id: 'turn', tool_name: 'ask_user', status: 'waiting_answer', call_seq: '1' } },
      ToolCallSourceLink: { source: { id: 'source', tool_call_id: 'call', message_id: 'message', provider_call_id: 'call', provider_ordinal: '0' } },
      ToolExecution: { execution: { id: 'execution', tool_call_id: 'call', status: 'waiting_answer' } },
      InteractionRequest: { request: interaction },
      InteractionOwnerLink: { owner: { id: 'owner', request_id: 'ask-request', turn_id: 'turn' } },
      InteractionToolCallLink: { tool: { id: 'tool', request_id: 'ask-request', tool_call_id: 'call' } }
    };
    const ready = value => ({ status: 'ready', text: JSON.stringify(value) });
    feed.details = {
      'message-content:revision': ready({ role: 'model', parts: [{ id: 'call', functionCall: { name: 'ask_user', args: invalid } }] }),
      'tool-arguments-content:call': ready(invalid),
      'interaction-prompt:ask-request': ready({ toolCallId: 'call', prompt: invalid })
    };
    const render = () => renderToString(createSSRApp(panel).use(activePinia));
    const html = await render();
    assert.match(html, /这个问题的内容无效，无法回答/);
    assert.match(html, /取消提问/);
    assert.doesNotMatch(html, /radiogroup|提交回答/);
    const target = interactionViewFromReliableRuntime({ interaction: { id: 'ask-request', kind: 'ask_user', status: 'pending', turnId: 'turn', createdAt: 1, updatedAt: 1 },
      conversationId: 'conversation', toolCallId: 'call', expectedKind: 'ask_user' });
    useAskUserStore().cancel('call', target);
    assert.ok(messages.some(message => message.payload?.decision === 'cancel' && message.payload?.interactionRequestId === 'ask-request'));
    assert.match(await render(), /正在取消/);
    assert.equal(feed.records.InteractionRequest.request.status, 'pending', 'the client must wait for the durable cancellation result');
  } finally {
    pinia.setActivePinia(previousPinia);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  }
});
