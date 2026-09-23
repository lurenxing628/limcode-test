/**
 * Claude turn-scoped reminders through the real kernel: ModelRequest recipes, Context, retries, restart,
 * fork, compression and a mid-conversation provider switch. Only the external model is synthetic; the
 * agent loop, task cards, Context writer, fork writer, compression writer, the full-request adapter and
 * the Claude request encoder (dry run of the exact wire body and headers) are production code.
 *
 * Official rule under test (https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages):
 * “Re-send cleared messages verbatim” — every earlier request is an exact prefix of the next one, the reminder
 * of each request stays right before the output it produced, and only the newest section renders.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const vscode = createVscodeStub();
Module._load = function (request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
const kernel = load('backend/reliableKernel/index.js');
const { VscodeReliableKernelApplicationFacade: Facade } = load('backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js');
const { VscodeConfigurationAuthority } = load('backend/reliableKernel/vscodeConfigurationAuthority.js');
const { createVscodeStoragePaths } = load('backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = load('backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { dryRunLlmProvider } = load('backend/capabilities/llmProvider.js');
const { applyFrozenModelProviderConfig } = load('backend/reliableKernel/llmCapabilityProviderRegistry.js');
const { workEnvironmentIdFromUri } = load('shared/workEnvironmentCatalog.js');
const { readFrozenTurnAuthority } = load('backend/reliableKernel/frozenAuthority.js');

const BETA = 'mid-conversation-system-clear-at-2026-08-21';
const TASKS = { mode: 'rewrite', items: [{ title: 'Implement', status: 'in_progress' }, { title: 'Verify', status: 'pending' }] };

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where, orderBy: { column: 'id', direction: 'asc' }, limit: 200
  }))).snapshot;
}

const toolNames = (request) => request.context.filter(item => item.segmentKind === 'tool_pair')
  .map(item => JSON.parse(item.content).toolCall.toolName);
/** The text of the latest user message in the frozen Context (the fixture never reinjects the input). */
const inputText = (request) => {
  const current = request.requestAddenda?.currentTurnInput?.content;
  const latest = current ?? request.context.filter(item => item.segmentKind === 'message' && item.messageRole === 'user').at(-1)?.content;
  return typeof latest === 'string' && latest.includes('start-work') ? 'start-work' : latest ?? '';
};

/** The scripted model: a tool loop that leaves tasks open (forcing one completion check), then plain replies. */
function scriptedReply(request, count) {
  const signed = { text: '', thought: true, thoughtSignature: `claude:signed-${count}` };
  if (inputText(request) !== 'start-work') return [signed, { text: `reply ${count}` }];
  const called = toolNames(request);
  if (!called.includes('update_task_list')) {
    return [signed, { text: 'Planning.' }, { id: `toolu_task_${count}`, functionCall: { name: 'update_task_list', args: TASKS } }];
  }
  if (!called.includes('read')) return [signed, { id: `toolu_read_${count}`, functionCall: { name: 'read', args: { path: 'a.txt' } } }];
  return request.recipe.openTaskCompletionCheck
    ? [signed, { text: 'Stopping; Verify is still open.' }]
    : [signed, { text: 'Implemented.' }];
}

async function withRuntime(run, { claudeTurnScopedReminders = true, retryOnError = true, fail } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-turn-scoped-reminders-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const getPaths = () => createVscodeStoragePaths(vscode.Uri.file(path.join(directory, 'configuration')));
  let configuration = new VscodeConfigurationAuthority(getPaths);
  const claude = {
    ...createDefaultLlmProviderConfig({ name: 'Claude fixture' }), id: 'claude-fixture', provider: 'claude',
    baseUrl: 'https://example.invalid/v1', model: 'claude-opus-5-5', models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }],
    promptCache: { enabled: true, mode: 'explicit', ttl: '5m' }, retryOnError, retryMaxAttempts: 2, retryDelaySeconds: 0,
    headers: { 'anthropic-beta': 'user-beta-2026-01-01' },
    ...(claudeTurnScopedReminders ? { claudeTurnScopedReminders: true } : {})
  };
  const openai = {
    ...createDefaultLlmProviderConfig({ name: 'OpenAI fixture' }), id: 'openai-fixture', provider: 'openai-compatible',
    baseUrl: 'https://example.invalid/v1', model: 'gpt-5.5', models: [{ id: 'gpt-5.5', name: 'GPT' }],
    // Even a stray switch on a non-Claude channel must change nothing.
    claudeTurnScopedReminders: true
  };
  for (const [section, settings] of [
    ['llmProviderConfigs', { configs: [claude, openai] }],
    ['llm', { activeProviderConfigId: claude.id }]
  ]) {
    const current = await configuration.loadGlobalSettings(section);
    await configuration.saveGlobalSettings(section, settings, current.revision);
  }
  await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: ['read', 'update_task_list'] });
  const agent = await configuration.mutations.createAgent({ name: 'Reminder fixture', kind: 'custom' });
  const folderPath = path.join(directory, 'workspace');
  await fs.mkdir(folderPath);
  const uri = vscode.Uri.file(folderPath).toString();
  await configuration.synchronizeWorkspaceFolders([{ uri, name: 'Fixture', rootPath: folderPath, index: 0 }]);
  await configuration.mutations.selectConversationWorkEnvironment('source', workEnvironmentIdFromUri(uri));
  const requests = [];
  let app;
  let facade;
  const open = async () => {
    configuration = new VscodeConfigurationAuthority(getPaths);
    await configuration.synchronizeWorkspaceFolders([{ uri, name: 'Fixture', rootPath: folderPath, index: 0 }]);
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: configuration,
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { assert.fail('no MCP'); } },
      mcpPolicyGate: { async authorize() { assert.fail('no MCP'); } },
      attachmentSettings: configuration,
      providers: { resolve(providerId) {
        return { providerId, async sendFullRequest(request, controls) {
          let start;
          const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
            start(input, emit) { start = structuredClone(input); emit({ type: 'llm:done', payload: { requestId: input.id } }); },
            abort() {}, cancelRetry() {}, dispose() {}
          });
          await adapter.sendFullRequest(request, { async onEvent() { return { accepted: true, checkpointed: true, terminal: false }; } });
          const settings = applyFrozenModelProviderConfig(await configuration.providerConfig(providerId), request.modelId);
          const dryRun = await dryRunLlmProvider(start, { settings: { ...settings, apiKey: '' } });
          const entry = { request, start, wire: dryRun.body, headers: dryRun.headers, estimate: adapter.estimateFullRequestInput(request) };
          requests.push(entry);
          const failure = fail?.(entry, requests.length);
          if (failure) throw failure;
          await controls.onEvent({ kind: 'completed', streamSeq: '1',
            content: { role: 'model', parts: scriptedReply(request, requests.length) } });
        } };
      } },
      toolDispatcher: {
        definitions() {
          return [
            { name: 'update_task_list', description: 'Synthetic task list', parameters: { type: 'object' } },
            { name: 'read', description: 'Synthetic read', parameters: { type: 'object' } }
          ];
        },
        async dispatch(input) {
          const settled = await app.runtime.effects.settleWithoutEffect({
            source: { kind: 'internal', key: `fixture:${input.toolCallId}` },
            toolCallId: input.toolCallId, status: 'succeeded',
            detail: input.toolName === 'update_task_list'
              ? { kind: 'task-list', operation: { kind: 'task_list.operation', ...TASKS } }
              : { text: 'alpha' }
          });
          return settled.terminal ?? app.runtime.effects.readTerminalResult(input.toolCallId, true);
        }
      }
    });
    facade = Object.create(Facade.prototype);
    facade.product = { application: app, configuration };
    facade.historyEntries = [];
    facade.refreshConversationHistory = async () => {};
  };
  try {
    await open();
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'source', title: 'Source', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: 'source-agent', conversation_id: 'source', agent_id: agent.id, role: 'default', created_at: now, updated_at: now
      })
    ]);
    const harness = {
      get app() { return app; }, get facade() { return facade; }, get configuration() { return configuration; }, requests,
      async reopen() { await app.close(); await open(); },
      async useModel(conversationId, provider) {
        await configuration.mutations.setModelProfile({
          scopeKind: 'conversation', scopeId: conversationId, providerConfigId: provider.id, provider: provider.provider, model: provider.model
        });
      },
      claude, openai,
      async turn(conversationId, text, expected = 'completed') {
        await app.database.conversationOwners.retain(conversationId, `fixture-panel:${conversationId}`);
        const input = await app.turns.input({
          source: { kind: 'command', key: `${conversationId}:${text}:${requests.length}` }, conversationId,
          leaseOwnerId: 'reminder-fixture-owner', hostBootId: app.database.hostBootId,
          leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), content: text
        });
        const [lease] = await rows(app, 'ExecutionLease', { turn_id: input.turnId });
        const result = await kernel.runWithExecutionLeaseFence({
          id: lease.id, conversationId, turnId: input.turnId, ownerId: lease.owner_id,
          hostBootId: lease.host_boot_id, generation: BigInt(lease.generation)
        }, () => app.agentLoop.drive(input.turnId)).catch(error => ({ terminalStatus: 'failed', error }));
        assert.equal(result.terminalStatus, expected,
          JSON.stringify({ result: String(result.error ?? ''), termination: await rows(app, 'TurnTermination', { turn_id: input.turnId }) }));
        return input;
      },
      async lastMessage(conversationId, role) {
        const memberships = await rows(app, 'MessagePartOfConversation', { conversation_id: conversationId });
        for (const member of memberships.sort((a, b) => Number(b.message_seq - a.message_seq))) {
          const [current] = await rows(app, 'MessageCurrentRevisionLink', { message_id: member.message_id });
          const [revision] = await rows(app, 'MessageRevision', { id: current.revision_id });
          if (revision.role === role) return { sourceConversationId: conversationId, messageId: member.message_id, expectedRevisionId: revision.id };
        }
        assert.fail('no such message');
      }
    };
    await run(harness);
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** Prefix comparison: cache_control markers and the string shorthand of the breakpoint message are not part of the prefix. */
function normalized(messages) {
  if (messages === undefined) return undefined;
  return JSON.parse(JSON.stringify(messages, (key, value) => {
    if (key === 'cache_control') return undefined;
    if (value && typeof value === 'object' && !Array.isArray(value) && (value.role === 'user' || value.role === 'assistant')
      && typeof value.content === 'string') return { ...value, content: [{ type: 'text', text: value.content }] };
    return value;
  }));
}

function assertPrefix(previous, next, label) {
  const before = normalized(previous.wire.messages);
  const after = normalized(next.wire.messages);
  assert.deepEqual(after.slice(0, before.length), before, `${label}: the previous request must be an exact prefix`);
  assert.deepEqual(normalized(next.wire.system), normalized(previous.wire.system), `${label}: system unchanged`);
  assert.deepEqual(normalized(next.wire.tools), normalized(previous.wire.tools), `${label}: tools unchanged`);
}

/** Official placement rule for every system section, and only the section after the last user message renders. */
function assertPlacement(entry, label) {
  const messages = entry.wire.messages;
  let lastUser = -1;
  messages.forEach((message, index) => { if (message.role === 'user') lastUser = index; });
  messages.forEach((message, index) => {
    if (message.role !== 'system') return;
    assert.equal(message.clear_at, 'next_user_message', `${label}: turn-scoped`);
    assert.equal(typeof message.content, 'string', `${label}: text only`);
    assert.equal('cache_control' in message, false, `${label}: no cache_control on a reminder`);
    let previous = index - 1;
    while (previous >= 0 && messages[previous].role === 'system') previous -= 1;
    assert.equal(messages[previous]?.role, 'user', `${label}: messages[${index}] follows a user turn`);
    let next = index + 1;
    while (next < messages.length && messages[next].role === 'system') next += 1;
    assert.ok(next === messages.length || messages[next].role === 'assistant', `${label}: messages[${index}] precedes an assistant turn or ends`);
  });
  const rendered = messages.slice(lastUser + 1).filter(message => message.role === 'system');
  assert.ok(rendered.length <= 1, `${label}: at most the newest reminder renders`);
  return rendered[0]?.content;
}

const systemContents = (entry) => entry.wire.messages.filter(message => message.role === 'system').map(message => message.content);

test('Claude 多轮工具循环：每次请求都是下一次的前缀，提醒原文原位、只显示最后一段，并经受重启、fork 与压缩', { timeout: 180_000 }, async () => {
  await withRuntime(async h => {
    await h.turn('source', 'start-work');
    const loop = [...h.requests];
    assert.ok(loop.length >= 4, `tool loop and one completion check: ${loop.length} requests`);
    for (const [index, entry] of loop.entries()) {
      assert.equal(String(entry.headers['anthropic-beta']).split(',').includes(BETA), true, `request ${index + 1} carries the beta`);
      assert.equal(String(entry.headers['anthropic-beta']).split(',')[0], 'user-beta-2026-01-01', 'user beta kept first');
      assert.equal(entry.start.settingsSnapshot.claudeTurnScopedReminders, true);
      assertPlacement(entry, `request ${index + 1}`);
      if (index > 0) assertPrefix(loop[index - 1], entry, `request ${index} → ${index + 1}`);
    }
    // After update_task_list the task card appears and is re-sent verbatim before the output it produced.
    const second = loop[1];
    const card = assertPlacement(second, 'second request');
    assert.match(card, /Current Turn Task Card/);
    assert.ok(systemContents(loop[2]).includes(card), 'the second request’s reminder stays in history');
    // The completion check follows a model turn, so it is sent as the old tail user message and later re-sent in place.
    const check = loop.at(-1);
    assert.equal(check.wire.messages.at(-1).role, 'user');
    assert.match(JSON.stringify(check.wire.messages.at(-1)), /Open Task Completion Check/);
    // Cleared history costs nothing in the planning estimate (“Token counting follows what renders”): inside the
    // loop every history reminder is a cleared system section, so dropping them leaves the estimate unchanged.
    const estimator = new kernel.LlmCapabilityFullRequestAdapter('claude-fixture', { start() {}, abort() {}, cancelRetry() {}, dispose() {} });
    const withHistory = loop.filter(entry => entry.request.requestAddenda?.turnReminderHistory?.length);
    assert.ok(withHistory.length >= 2);
    for (const entry of withHistory) {
      const { turnReminderHistory, ...addenda } = entry.request.requestAddenda;
      assert.deepEqual(entry.estimate, estimator.estimateFullRequestInput({ ...entry.request, requestAddenda: addenda }));
      assert.equal(entry.estimate.turnReminderTokens > 0, !!entry.request.requestAddenda.turnReminder);
    }

    await h.turn('source', 'second-turn');
    const afterTurn = h.requests.at(-1);
    assertPrefix(check, afterTurn, 'next Turn');
    assertPlacement(afterTurn, 'next Turn');

    await h.reopen();
    await h.turn('source', 'after-restart');
    const afterRestart = h.requests.at(-1);
    assertPrefix(afterTurn, afterRestart, 'after restart');

    const fork = await h.facade.forkConversation({ ...(await h.lastMessage('source', 'model')), command: { commandId: 'fork-reminders' } });
    await h.turn(fork.conversationId, 'in-fork');
    const inFork = h.requests.at(-1);
    assertPrefix(afterRestart, inFork, 'fork');
    assertPlacement(inFork, 'fork');

    // Compress the first Turn up to (not including) its last model output; later reminders stay in place.
    const rootId = await h.app.context.currentHeadRootId('source');
    const structure = await h.app.context.materializeStructure(rootId);
    const [turn] = (await rows(h.app, 'Turn', { conversation_id: 'source' })).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const [snapshot] = await rows(h.app, 'AuthoritySnapshot', { turn_id: turn.id });
    const keptFrom = afterRestart.request.context.findIndex(item => item.segmentKind === 'message' && item.messageRole === 'model'
      && JSON.parse(item.content).parts.some(part => part.text === 'Stopping; Verify is still open.'));
    assert.ok(keptFrom > 0);
    await h.app.compression.create({
      conversationId: 'source', headRootId: rootId, authoritySnapshotId: snapshot.id,
      compressSegmentCount: keptFrom, title: 'Reminder summary', summary: 'Synthetic summary of the tool loop',
      idempotencyKey: 'reminder-compression'
    });
    assert.ok(structure.records.length > keptFrom);
    await h.turn('source', 'after-compression');
    const afterCompression = h.requests.at(-1);
    assertPlacement(afterCompression, 'after compression');
    // The kept tail is re-sent exactly as before: the completion check user message, then its output and later turns.
    const tailStart = normalized(afterRestart.wire.messages).findIndex(message => JSON.stringify(message).includes('Open Task Completion Check'));
    const tail = normalized(afterRestart.wire.messages).slice(tailStart);
    const compressedMessages = normalized(afterCompression.wire.messages);
    const at = compressedMessages.findIndex(message => JSON.stringify(message).includes('Open Task Completion Check'));
    assert.ok(at > 0, 'the kept completion check is still there');
    // The check was first sent after a model message, as the old tail user message. It now directly follows the
    // summary (a user message whose prefix is new anyway), so from here on it is a turn-scoped section, stably.
    assert.equal(tail[0].role, 'user');
    assert.deepEqual(compressedMessages[at], { role: 'system', clear_at: 'next_user_message', content: tail[0].content[0].text });
    assert.deepEqual(compressedMessages.slice(at + 1, at + tail.length), tail.slice(1), 'the kept tail is otherwise verbatim');
    assert.match(JSON.stringify(compressedMessages.slice(0, at)), /Synthetic summary of the tool loop/);
    assert.equal(compressedMessages.slice(0, at).some(message => message.role === 'system'), false,
      'reminders of the compressed range went with it');
    assert.equal(systemContents(afterCompression).length,
      tail.filter(message => message.role === 'system').length + 2, 'the kept history reminders, the check, and the current one');
    await h.turn('source', 'after-compression-again');
    assertPrefix(afterCompression, h.requests.at(-1), 'after compression, stable again');
  });
});

test('Claude 重试不重复提醒；失败的请求不留下提醒，也不会出现 system 后面紧跟 user', { timeout: 180_000 }, async () => {
  let failedOnce = false;
  await withRuntime(async h => {
    await h.turn('source', 'start-work');
    const attempts = h.requests.filter(entry => entry.request.modelRequestId === h.requests[2].request.modelRequestId);
    assert.equal(attempts.length, 2, 'the third request was retried once');
    assert.equal(attempts[1].request.attemptSeq, '2');
    assert.deepEqual(attempts[1].wire, attempts[0].wire, 'a retry re-sends the frozen request byte for byte');
    const later = h.requests.at(-1);
    const reminder = assertPlacement(attempts[0], 'retried request');
    assert.equal(systemContents(later).filter(content => content === reminder).length,
      systemContents(attempts[0]).filter(content => content === reminder).length, 'no duplicate after the retry');
  }, {
    fail(entry, count) {
      if (count === 3 && !failedOnce) {
        failedOnce = true;
        return new kernel.ProviderTransientError('temporary_service_error', 'synthetic 529');
      }
      return undefined;
    }
  });

  let failedPermanently = false;
  await withRuntime(async h => {
    await h.turn('source', 'start-work', 'failed');
    const failed = h.requests.at(-1);
    const lost = assertPlacement(failed, 'failed request');
    assert.match(lost, /Current Turn Task Card/, 'the failed request carried the task card');
    const firstAfter = h.requests.length;
    await h.turn('source', 'after-failure');
    for (const entry of h.requests.slice(firstAfter)) assertPlacement(entry, 'after failure');
    const next = h.requests[firstAfter];
    const lastUser = next.wire.messages.findLastIndex(message => message.role === 'user');
    assert.equal(next.wire.messages.slice(0, lastUser).some(message => message.role === 'system'), false,
      'the failed request produced no output, so its reminder is not re-sent');
    assert.equal(next.wire.messages.at(-1).role, 'system', 'only the new request’s own reminder');
    assertPrefix({ wire: { ...failed.wire, messages: failed.wire.messages.filter(message => message.role !== 'system') } }, next, 'after failure');
  }, {
    retryOnError: false,
    fail(entry) {
      if (failedPermanently || !toolNames(entry.request).includes('update_task_list')) return undefined;
      failedPermanently = true;
      return new Error('synthetic permanent failure');
    }
  });
});

test('中途切到别的 provider 时历史提醒不以任何形式泄漏过去；切回 Claude 后原位出现', { timeout: 180_000 }, async () => {
  await withRuntime(async h => {
    await h.turn('source', 'start-work');
    const claudeLast = h.requests.at(-1);
    const history = systemContents(claudeLast);
    assert.ok(history.length > 0);
    await h.useModel('source', h.openai);
    await h.turn('source', 'on-openai');
    const onOpenAI = h.requests.at(-1);
    assert.equal(onOpenAI.request.providerId, 'openai-fixture');
    const [modelRequest] = await rows(h.app, 'ModelRequest', { id: onOpenAI.request.modelRequestId });
    const [snapshot] = await rows(h.app, 'AuthoritySnapshot', { turn_id: modelRequest.turn_id });
    const authority = await readFrozenTurnAuthority(h.app.database, h.app.contentStore, snapshot.id);
    assert.equal(authority.document.model.provider, 'openai-compatible');
    assert.equal('claudeTurnScopedReminders' in authority.document.model, false, 'the switch is frozen only for Claude');
    assert.equal(onOpenAI.request.requestAddenda?.turnReminderHistory, undefined);
    assert.equal(JSON.stringify(onOpenAI.start).includes('turnReminder"'), false);
    assert.equal(JSON.stringify(onOpenAI.start).includes('claudeSystemMessage'), false);
    for (const content of history) assert.equal(JSON.stringify(onOpenAI.wire).includes(content), false, 'no history reminder on another provider');
    await h.useModel('source', h.claude);
    await h.turn('source', 'back-on-claude');
    const back = h.requests.at(-1);
    assertPlacement(back, 'back on Claude');
    const claudePrefix = normalized(claudeLast.wire.messages);
    assert.deepEqual(normalized(back.wire.messages).slice(0, claudePrefix.length), claudePrefix,
      'the earlier Claude request is still an exact prefix once the switch is back');
  });
});

test('开关关闭时同样的对话：没有 system 消息、不带 beta 头、提醒仍是原来的尾巴 user 消息', { timeout: 180_000 }, async () => {
  await withRuntime(async h => {
    await h.turn('source', 'start-work');
    for (const entry of h.requests) {
      assert.equal(entry.wire.messages.some(message => message.role === 'system'), false);
      assert.equal(String(entry.headers['anthropic-beta']), 'user-beta-2026-01-01');
      assert.equal(entry.request.requestAddenda?.turnReminderHistory, undefined);
      assert.equal('claudeTurnScopedReminders' in entry.start.settingsSnapshot, false);
    }
    const withCard = h.requests.find(entry => entry.request.requestAddenda?.turnReminder);
    assert.ok(withCard);
    assert.match(JSON.stringify(withCard.wire.messages.at(-1)), /Current Turn Task Card/);
  }, { claudeTurnScopedReminders: false });
});

function createVscodeStub() {
  class Uri {
    constructor(fsPath) { this.scheme = 'file'; this.fsPath = path.resolve(fsPath); this.path = this.fsPath.split(path.sep).join('/'); }
    static file(value) { return new Uri(value); }
    static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
    toString() { return `file://${this.path}`; }
  }
  const FileType = { Unknown: 0, File: 1, Directory: 2 };
  return { Uri, FileType, workspace: { fs: {
    async createDirectory(uri) { await fs.mkdir(uri.fsPath, { recursive: true }); },
    async readFile(uri) { return fs.readFile(uri.fsPath); },
    async writeFile(uri, bytes) { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, bytes); },
    async readDirectory(uri) { return (await fs.readdir(uri.fsPath, { withFileTypes: true })).map(entry => [entry.name, entry.isDirectory() ? FileType.Directory : FileType.File]); },
    async delete(uri) { await fs.rm(uri.fsPath, { recursive: true, force: true }); },
    async stat(uri) { const stat = await fs.stat(uri.fsPath); return { type: stat.isDirectory() ? FileType.Directory : FileType.File, ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size }; }
  } } };
}
