import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
const Module = require('node:module');
const originalLoad = Module._load;
class Uri {
  constructor(value) { this.scheme = 'file'; this.fsPath = path.resolve(value); this.path = this.fsPath; }
  static file(value) { return new Uri(value); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.path}`; }
}
const vscode = { Uri, FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 }, workspace: { fs: {
  createDirectory: uri => fs.mkdir(uri.fsPath, { recursive: true }), readFile: uri => fs.readFile(uri.fsPath),
  async writeFile(uri, bytes) { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, bytes); },
  async readDirectory(uri) { return (await fs.readdir(uri.fsPath, { withFileTypes: true })).map(item => [item.name, item.isDirectory() ? 2 : 1]); },
  delete: uri => fs.rm(uri.fsPath, { recursive: true, force: true }),
  async stat(uri) { const stat = await fs.stat(uri.fsPath); return { type: stat.isDirectory() ? 2 : 1, size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs }; }
} } };
Module._load = function(request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const kernel = load('backend/reliableKernel/index.js');
const { VscodeConfigurationAuthority } = load('backend/reliableKernel/vscodeConfigurationAuthority.js');
const { createVscodeStoragePaths } = load('backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = load('backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { ReliableChildAgentCoordinator } = load('backend/reliableKernel/childAgentCoordinator.js');
const { ReliableConversationRunner } = load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { readFrozenTurnAuthority } = load('backend/reliableKernel/frozenAuthority.js');
const { readConversationChildTaskProjection } = load('backend/reliableKernel/conversationChildTaskProjection.js');
const { runAgentTool } = load('backend/world/modules/tools/definitions/runAgent/index.js');
const { dryRunLlmProvider } = load('backend/capabilities/llmProvider.js');
const { applyFrozenModelProviderConfig } = load('backend/reliableKernel/llmCapabilityProviderRegistry.js');
const { LlmEventType } = load('backend/world/modules/llm/events.js');
const { createDefaultLlmCompressionConfig } = load('shared/protocol.js');

const TASKS = [
  'ALPHA_INITIAL: trace request dispatch and report the exact source path.',
  'BETA_INITIAL: audit SQLite task links and verify crash recovery.',
  'GAMMA_INITIAL: inspect model-facing history and compression replay.'
];
const CURRENT = 'ALPHA_CURRENT: verify queue admission without starting a new child.';
const QUEUED = 'ALPHA_QUEUED: add a regression covering a second compression boundary.';
const QUEUED_FULL = `${QUEUED} ${'Retain the complete verification requirements. '.repeat(250)}QUEUE_FULL_TEXT_END_8942`;
const RETRY_GUIDANCE = 'RETRY_NEW_GUIDANCE: independently saved while the parent request is retrying.';
const SUMMARY = 'Synthetic compacted history: continue the user request. All task details were intentionally omitted.';
const tool = (id, args) => ({ id, functionCall: { name: 'run_agent', args } });
const done = () => ({ role: 'model', parts: [{ text: 'Synthetic parent round complete.' }] });
const complete = (controls, content) => controls.onEvent({ kind: 'completed', streamSeq: '1', content });

async function eventually(check, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

/** Real SQLite, CAS, configuration, loop, child scheduler and provider encoder; only the external model is synthetic. */
async function fixture(mode, hooks, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-child-task-runtime-'));
  let app, coordinator, runner;
  const configuration = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(Uri.file(path.join(root, 'settings'))));
  const save = async (section, settings) => configuration.saveGlobalSettings(section, settings, (await configuration.loadGlobalSettings(section)).revision);
  const native = mode === 'provider_native';
  const provider = {
    ...createDefaultLlmProviderConfig({ name: 'synthetic child memory' }), id: 'child-memory-provider',
    provider: native ? 'openai-responses' : 'openai-compatible', baseUrl: 'https://example.invalid/v1',
    model: 'gpt-6-astra', models: [{ id: 'gpt-6-astra', name: 'synthetic Astra' }], modelConfigs: [],
    generationConfig: {}, contextWindowTokens: 200000,
    ...(native ? { nativeResponses: { enabled: true, reasoningUpdates: true, asyncTools: false, steering: false, multiplexing: false } } : {})
  };
  const requests = [], wires = [], starts = [], dispatches = [];
  const f = {
    configuration, provider, requests, wires, starts, dispatches, save,
    get app() { return app; }, get coordinator() { return coordinator; },
    input: key => ({ source: { kind: 'command', key }, conversationId: 'parent', leaseOwnerId: 'child-memory-owner',
      hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), content: 'Continue the existing assignment.' }),
    list: async (domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
      where, orderBy: { column: 'id', direction: 'asc' }, limit: 100
    }))).snapshot,
    projection: () => readConversationChildTaskProjection(app.database, app.contentStore, 'parent'),
    async compress(key) {
      const [head] = await f.list('ConversationContextHeadLink', { conversation_id: 'parent' });
      const structure = await app.context.materializeStructure(head.root_id);
      const result = await runner.manualCompression({ commandId: key, conversationId: 'parent',
        compressSegmentCount: structure.records.length, target: { kind: 'current_head', expectedRootId: head.root_id } });
      assert.equal(result.compression.status, 'compressed', JSON.stringify(result));
      const request = requests.filter(request => request.recipe.kind === 'reliable-context-compression').at(-1);
      assert.equal(request.recipe.compressionMethodKind, mode, 'the requested compression mode actually ran');
      return request;
    },
    async reopen() {
      runner.dispose(); runner = undefined;
      await coordinator.dispose(); coordinator = undefined;
      await app.close(); app = undefined;
      await open();
    }
  };
  let childAgent;
  async function open() {
    const authority = new kernel.RootAuthority(() => path.join(root, 'runtime'));
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: configuration, compressionSettingsAuthority: configuration, attachmentSettings: configuration,
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { return null; } },
      mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
      providers: { resolve(providerId) { return { providerId, async sendFullRequest(request, controls) {
        requests.push(request);
        if (request.recipe.kind === 'reliable-context-compression') {
          await complete(controls, { type: 'compression_result', contents: [{ role: 'user', parts: [{ text: SUMMARY }] }] });
          return;
        }
        let start;
        const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
          start(input, emit) { start = input; emit({ type: LlmEventType.Done, payload: { requestId: input.id } }); },
          abort() {}, dispose() {}
        });
        await adapter.sendFullRequest(request, { async onEvent() { return { accepted: true, terminal: true, checkpointed: true }; } });
        const effective = applyFrozenModelProviderConfig(await configuration.providerConfig(providerId), request.modelId);
        const wire = await dryRunLlmProvider(start, { settings: { ...effective, apiKey: '' } });
        const captured = { requestId: request.modelRequestId, conversationId: request.conversationId, turnId: request.turnId, body: wire.body };
        wires.push(captured); starts.push({ ...captured, start });
        await hooks.send(request, controls, f, captured, start);
      } }; } },
      toolDispatcher: {
        definitions() { return [{ ...runAgentTool.declaration }]; },
        async dispatch(input) {
          dispatches.push(structuredClone(input));
          const [snapshot] = await f.list('AuthoritySnapshot', { turn_id: input.turnId });
          const authority = await readFrozenTurnAuthority(app.database, app.contentStore, snapshot.id, input.turnId);
          return coordinator.dispatch(input, undefined, { snapshotId: snapshot.id, document: authority.document,
            toolConfig: { config: { maxChildAgentDepth: 3 } } });
        }
      }
    });
    coordinator = new ReliableChildAgentCoordinator({ database: app.database, ...app.runtime,
      modelProvider: app.modelProvider, turns: app.turns, agentLoop: app.agentLoop,
      agents: { async resolve() { return { agentId: childAgent.id, agentType: 'worker' }; } },
      modelProfiles: { initializeConversation: ({ conversationId, model, thinkingOverride }) =>
        configuration.mutations.initializeConversationModelProfile({ conversationId, ...model,
          ...(thinkingOverride ? { thinkingOverride } : {}) }) }
    });
    runner = new ReliableConversationRunner(app, 'child-memory-owner');
  }
  try {
    await save('llmProviderConfigs', { configs: [provider] });
    await save('llm', { activeProviderConfigId: provider.id });
    const compression = { ...createDefaultLlmCompressionConfig('synthetic task memory'), kind: mode,
      bodyTargetTokens: 4096, llmSummary: { targetTokens: 1024 }, fallbacks: [],
      providerNative: { trustMode: 'trust_configured_endpoint' },
      trigger: { mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: 120000 } };
    await save('llmCompressionConfigs', { configs: [compression] });
    await save('llmCompression', { defaultConfigId: compression.id, providerBindings: [], modelBindings: [] });
    const agent = await configuration.mutations.createAgent({ name: 'synthetic parent', kind: 'custom' });
    childAgent = await configuration.mutations.createAgent({ name: 'synthetic worker', kind: 'custom' });
    await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: ['run_agent'],
      toolConfigs: { run_agent: { config: { maxChildAgentDepth: 3 } } } });
    await kernel.initializeEmptyRuntimeRoot(new kernel.RootAuthority(() => path.join(root, 'runtime')));
    await open();
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'parent', title: 'Synthetic child task memory', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'parent-agent', conversation_id: 'parent', agent_id: agent.id, role: 'default', created_at: now, updated_at: now })
    ]);
    await run(f);
  } finally {
    hooks.release?.();
    runner?.dispose();
    if (coordinator) await coordinator.dispose();
    if (app) await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function rosterFromStart(start) {
  const last = start.contents.at(-1);
  assert.equal(last.role, 'user', 'current task roster is a user-level request addendum');
  const text = last.parts.filter(part => typeof part.text === 'string').map(part => part.text).join('\n');
  const cards = text.split('\n').filter(line => line.startsWith('{')).flatMap(line => {
    try { const card = JSON.parse(line); return card.childRef ? [card] : []; } catch { return []; }
  });
  assert.equal(cards.length, 3, `all three same-label children must be visible in the actual provider tail: ${text}`);
  return cards;
}
function assertAssignmentsInWire(wire, start, refs, { queued = true } = {}) {
  const cards = rosterFromStart(start);
  assert.deepEqual(new Set(cards.map(card => card.label)), new Set(['Investigate reliability']));
  for (const prompt of TASKS) {
    const card = cards.find(card => card.initialTask?.includes(prompt));
    assert.ok(card, `initial assignment missing from provider tail: ${prompt}`);
    assert.equal(card.childRef, refs.get(prompt), 'same-label children keep their original distinct short reference');
  }
  const alpha = cards.find(card => card.initialTask?.includes(TASKS[0]));
  if (queued) {
    assert.ok(alpha.currentTasks.some(text => text.includes(CURRENT)), 'current assignment survives independently of the initial task');
    assert.ok(alpha.queuedTasks.some(text => text.includes(QUEUED)), 'queued follow-up is visible before it is admitted');
  }
  const body = JSON.stringify(wire.body);
  for (const prompt of [...TASKS, ...(queued ? [CURRENT, QUEUED] : [])]) assert.ok(body.includes(prompt), `actual encoded body omitted ${prompt}`);
  for (const ref of refs.values()) assert.ok(body.includes(ref));
}

for (const mode of ['llm_summary', 'provider_native']) test(`child task memory reaches actual provider wire after full ${mode}, retry, new Turn and reopen`, { timeout: 120000 }, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let phase = 'spawn', spawnRound = 0, inspectRound = 0, alphaConversation, alphaRef, currentStarted = false;
  let retryRequest, retryWire, retryRecipe, firstInspection, expectedReadCursor;
  let readPages = 0;
  const readSources = new Map();
  const refs = new Map();
  await fixture(mode, {
    release,
    async send(request, controls, f, wire, start) {
      if (request.conversationId !== 'parent') {
        const body = JSON.stringify(start.contents);
        if (body.includes(TASKS[0]) && !alphaConversation) alphaConversation = request.conversationId;
        if (request.conversationId === alphaConversation && !body.includes(CURRENT)) return complete(controls, done());
        if (request.conversationId === alphaConversation) currentStarted = true;
        await gate;
        return complete(controls, done());
      }
      if (phase === 'spawn') {
        spawnRound += 1;
        if (spawnRound === 1) return complete(controls, { role: 'model', parts: TASKS.map((prompt, index) =>
          tool(`spawn-${index}`, { operation: 'spawn', taskName: 'Investigate reliability', prompt, foregroundWaitMs: 0 })) });
        if (spawnRound === 2) {
          await eventually(async () => {
            const projection = await f.projection();
            return projection.tasks.find(task => task.initialTask?.text.includes(TASKS[0]) && task.status === 'idle') ? projection : undefined;
          }, 'alpha initial turn did not finish');
          const cards = rosterFromStart(start);
          for (const prompt of TASKS) {
            const card = cards.find(card => card.initialTask?.includes(prompt));
            assert.ok(card, 'the simulated model locates existing tasks using its actual input, without canonical ids');
            refs.set(prompt, card.childRef);
          }
          assert.deepEqual(new Set(refs.values()), new Set(['A1', 'A2', 'A3']));
          alphaRef = refs.get(TASKS[0]);
          return complete(controls, { role: 'model', parts: [tool('current-alpha', { operation: 'send', childRef: alphaRef, prompt: CURRENT })] });
        }
        if (spawnRound === 3) {
          await eventually(() => currentStarted, 'the continued alpha Turn never reached its provider');
          return complete(controls, { role: 'model', parts: [tool('queued-alpha', { operation: 'send', childRef: alphaRef, prompt: QUEUED_FULL })] });
        }
        assertAssignmentsInWire(wire, start, refs);
        return complete(controls, done());
      }
      if (phase === 'inspect') {
        inspectRound += 1;
        assertAssignmentsInWire(wire, start, refs);
        if (inspectRound === 1) {
          firstInspection = request;
          const persistedHistory = JSON.stringify(request.context);
          assert.ok(persistedHistory.includes(SUMMARY));
          for (const prompt of [...TASKS, CURRENT, QUEUED]) assert.ok(!persistedHistory.includes(prompt), 'the raw task history really was replaced; recovery is not a lucky retained tool pair');
          return complete(controls, { role: 'model', parts: [tool('list-after-compression', { operation: 'list', limit: 2 })] });
        }
        if (inspectRound === 2) {
          const responses = start.contents.flatMap(content => content.parts).filter(part => part.functionResponse?.name === 'run_agent');
          const list = responses.at(-1).functionResponse.response.detail;
          assert.equal(list.totalDirect, 3, JSON.stringify(list)); assert.equal(list.shown, 2); assert.equal(list.omitted, 1);
          assert.ok(list.nextCursor);
          assert.ok(list.rereadCursor);
          assert.equal(list.tasks.length, 2);
          assert.ok(!JSON.stringify(wire.body).includes('QUEUE_FULL_TEXT_END_8942'), 'roster and list previews remain bounded until an explicit full read');
          assert.ok(list.tasks.every(task => task.childRef && !task.answerBridgeId), 'query result uses the model-facing reference contract');
          return complete(controls, { role: 'model', parts: [tool('read-after-compression', { operation: 'read', childRef: alphaRef, limit: 100 })] });
        }
        if (!retryRequest) {
          const responses = start.contents.flatMap(content => content.parts).filter(part => part.functionResponse?.name === 'run_agent');
          const read = responses.at(-1).functionResponse.response.detail;
          assert.equal(read.operation, 'read');
          assert.equal(read.task.childRef, alphaRef);
          assert.ok(read.rereadCursor, 'each page can be reread after tool history compaction');
          if (expectedReadCursor) assert.equal(read.rereadCursor, expectedReadCursor);
          readPages += 1;
          assert.ok(readPages <= 20, 'bounded source paging must make forward progress');
          assert.ok(read.timelineSources.length > 0, 'a continuation page cannot silently omit the source body');
          for (const chunk of read.timelineSources) {
            const source = readSources.get(chunk.id) ?? { text: '', hash: chunk.textSha256, total: chunk.totalCharacters,
              format: chunk.textFormat, complete: false };
            assert.equal(chunk.textOffset, source.text.length, 'source chunks have no gaps or overlaps');
            assert.equal(chunk.textSha256, source.hash, 'one source retains one full-body digest across pages');
            assert.equal(chunk.totalCharacters, source.total);
            assert.equal(chunk.textFormat, source.format);
            assert.equal(source.complete, false, 'a completed source must not reappear on the next page');
            source.text += chunk.text;
            source.complete = chunk.textComplete;
            if (source.complete) {
              assert.equal(source.text.length, source.total, 'source paging restores every character');
              assert.equal(createHash('sha256').update(source.text).digest('hex'), source.hash,
                'source paging restores the exact body, including text beyond the ordinary tool-result cap');
            }
            readSources.set(chunk.id, source);
          }
          if (read.nextCursor) {
            expectedReadCursor = read.nextCursor;
            return complete(controls, { role: 'model', parts: [tool(`read-after-compression-${readPages + 1}`,
              { operation: 'read', childRef: alphaRef, limit: 100, cursor: read.nextCursor })] });
          }
          assert.ok(readPages > 1, 'large queued input must be recovered through multiple real tool calls');
          const texts = [...readSources.values()].map(source => {
            assert.equal(source.complete, true);
            if (source.format === 'text') return source.text;
            assert.equal(source.format, 'message_json');
            return JSON.parse(source.text).parts.map(part => part.text ?? '').join('');
          });
          for (const prompt of [TASKS[0], CURRENT, QUEUED_FULL]) assert.ok(texts.some(text => text.includes(prompt)),
            `paged read must recover full retained text: ${prompt}`);
          assert.ok(JSON.stringify(wire.body).includes('QUEUE_FULL_TEXT_END_8942'), 'the final chunk survives actual provider encoding');
          retryRequest = request.modelRequestId; retryWire = structuredClone(wire.body); retryRecipe = structuredClone(request.recipe);
          const beta = (await f.projection()).tasks.find(task => task.initialTask.text.includes(TASKS[1]));
          const queued = await f.coordinator.inputFromConversation({ commandId: `${mode}-guidance-during-retry`,
            childExecutionId: beta.childExecutionId, conversationId: beta.conversationId, content: RETRY_GUIDANCE });
          assert.equal(queued.admitted, false);
          assert.ok((await f.projection()).tasks.find(task => task.childExecutionId === beta.childExecutionId).queuedInputs.some(source => source.text.includes(RETRY_GUIDANCE)));
          throw new kernel.ProviderTransientError('temporary_service_error', 'synthetic retry of a frozen task roster');
        }
        assert.equal(inspectRound, readPages + 3);
        assert.equal(request.modelRequestId, retryRequest, 'retry reuses the same durable ModelRequest');
        assert.deepEqual(request.recipe, retryRecipe, 'retry does not refreeze the roster');
        assert.deepEqual(wire.body, retryWire, 'retry sends the exact same encoded model input');
        assert.ok(!JSON.stringify(wire.body).includes(RETRY_GUIDANCE), 'newly saved child guidance must not alter an in-flight request');
        return complete(controls, done());
      }
      assertAssignmentsInWire(wire, start, refs, { queued: phase !== 'reopened' });
      if (phase === 'next-turn') assert.ok(JSON.stringify(wire.body).includes(RETRY_GUIDANCE), 'a new request refreshes the durable child guidance');
      return complete(controls, done());
    }
  }, async f => {
    try {
      const started = await f.app.agentLoop.runInput(f.input(`${mode}-dispatch`));
      assert.equal(started.terminalStatus, 'completed', JSON.stringify(await f.list('TurnTermination', { turn_id: started.turnId })));
      assert.equal((await f.list('ChildExecution')).length, 3);
      const before = await f.projection();
      const alpha = before.tasks.find(task => task.initialTask.text.includes(TASKS[0]));
      assert.ok(alpha.currentInputs.some(source => source.text.includes(CURRENT)));
      assert.ok(alpha.queuedInputs.some(source => source.text.includes(QUEUED)));
      const compression = await f.compress(`${mode}-compact-first`);
      assert.equal(new Set(compression.recipe.modelHandleCatalog.entries.filter(entry => entry.kind === 'child').map(entry => entry.ref)).size, 3);
      phase = 'inspect';
      const inspected = await f.app.agentLoop.runInput(f.input(`${mode}-inspect`));
      assert.equal(inspected.terminalStatus, 'completed', JSON.stringify(await f.list('TurnTermination', { turn_id: inspected.turnId })));
      assert.notEqual(firstInspection.turnId, started.turnId);
      assert.equal((await f.list('ChildExecution')).length, 3, 'list, read and transient retry never create a child');
      assert.equal(f.dispatches.filter(call => call.arguments.operation === 'spawn').length, 3);
      assert.equal(f.dispatches.filter(call => call.arguments.operation === 'send').length, 2);
      assert.equal(f.dispatches.filter(call => call.arguments.operation === 'list').length, 1);
      assert.equal(f.dispatches.filter(call => call.arguments.operation === 'read').length, readPages);
      await f.compress(`${mode}-compact-second`);
      phase = 'next-turn';
      assert.equal((await f.app.agentLoop.runInput(f.input(`${mode}-another-turn`))).terminalStatus, 'completed');
      assert.equal((await f.list('CompressionBlock')).length, 2);
      release();
      await f.coordinator.waitForIdle();
      await f.coordinator.recoverStartup();
      await f.coordinator.waitForIdle();
      const settled = await f.projection();
      const completedAlpha = settled.tasks.find(task => task.childExecutionId === alpha.childExecutionId);
      assert.equal(completedAlpha.queuedInputs.length, 0);
      assert.ok(completedAlpha.timeline.some(source => source.text.includes(QUEUED)));
      phase = 'reopened';
      await f.reopen();
      assert.equal((await f.list('ChildExecution')).length, 3);
      const restored = await f.projection();
      assert.deepEqual(restored.tasks.map(task => [task.childExecutionId, task.initialTask.text]).sort(), settled.tasks.map(task => [task.childExecutionId, task.initialTask.text]).sort());
      assert.ok(restored.tasks.find(task => task.childExecutionId === alpha.childExecutionId).timeline.some(source => source.text.includes(QUEUED_FULL)), 'full follow-up body remains readable after reopening');
      assert.ok(restored.tasks.find(task => task.initialTask.text.includes(TASKS[1])).timeline.some(source => source.text.includes(RETRY_GUIDANCE)), 'guidance saved during the retry is durable');
      assert.equal((await f.app.agentLoop.runInput(f.input(`${mode}-after-reopen`))).terminalStatus, 'completed');
      assert.equal((await f.list('ChildExecution')).length, 3);
    } finally { release(); }
  });
});
