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
const { childConversationModelProfiles } = load('backend/reliableKernel/childThinkingInheritance.js');
const { createVscodeStoragePaths } = load('backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = load('backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { ReliableChildAgentCoordinator } = load('backend/reliableKernel/childAgentCoordinator.js');
const { ReliableConversationRunner } = load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { readFrozenTurnAuthority } = load('backend/reliableKernel/frozenAuthority.js');
const { readConversationChildTaskProjection } = load('backend/reliableKernel/conversationChildTaskProjection.js');
const { ReliableConversationLifecycle } = load('backend/application/reliableKernel/conversationLifecycle.js');
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
  const requests = [], wires = [], starts = [], dispatches = [], runnerErrors = [];
  const f = {
    configuration, provider, requests, wires, starts, dispatches, save,
    get app() { return app; }, get coordinator() { return coordinator; },
    async runInput(key, text = 'Continue the existing assignment.', conversationId = 'parent') {
      // AgentLoop.runInput performs only one drive and may validly return waiting while a tool
      // settlement races its last read. Use the production runner's wake/re-entry lifecycle.
      const started = await runner.input({ commandId: key, conversationId, text });
      assert.ok(started.admitted && started.turnId, 'the preceding fixture turn must already be terminal');
      const terminal = await eventually(async () => {
        assert.deepEqual(runnerErrors, [], 'production runner must not hide a drive error');
        return (await f.list('TurnTermination', { turn_id: started.turnId }))[0];
      }, `parent Turn ${started.turnId} did not reach a committed terminal outcome`);
      await runner.waitForIdle();
      assert.deepEqual(runnerErrors, []);
      return { turnId: started.turnId, terminalStatus: terminal.terminal_status };
    },
    list: async (domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
      where, orderBy: { column: 'id', direction: 'asc' }, limit: 100
    }))).snapshot,
    projection: () => readConversationChildTaskProjection(app.database, app.contentStore, 'parent'),
    async compress(key, conversationId = 'parent', segmentCount) {
      const [head] = await f.list('ConversationContextHeadLink', { conversation_id: conversationId });
      const structure = await app.context.materializeStructure(head.root_id);
      const result = await runner.manualCompression({ commandId: key, conversationId,
        compressSegmentCount: segmentCount ?? structure.records.length, target: { kind: 'current_head', expectedRootId: head.root_id } });
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
      // Production wiring (VscodeReliableKernelProductRuntime uses the same adapter).
      modelProfiles: childConversationModelProfiles(configuration.mutations)
    });
    runner = new ReliableConversationRunner(app, 'child-memory-owner', (error, context) => {
      runnerErrors.push({ message: error instanceof Error ? error.message : String(error), ...context });
    });
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
      const started = await f.runInput(`${mode}-dispatch`);
      assert.equal(started.terminalStatus, 'completed', JSON.stringify(await f.list('TurnTermination', { turn_id: started.turnId })));
      assert.equal((await f.list('ChildExecution')).length, 3);
      const before = await f.projection();
      const alpha = before.tasks.find(task => task.initialTask.text.includes(TASKS[0]));
      assert.ok(alpha.currentInputs.some(source => source.text.includes(CURRENT)));
      assert.ok(alpha.queuedInputs.some(source => source.text.includes(QUEUED)));
      const compression = await f.compress(`${mode}-compact-first`);
      assert.equal(new Set(compression.recipe.modelHandleCatalog.entries.filter(entry => entry.kind === 'child').map(entry => entry.ref)).size, 3);
      phase = 'inspect';
      const inspected = await f.runInput(`${mode}-inspect`);
      assert.equal(inspected.terminalStatus, 'completed', JSON.stringify(await f.list('TurnTermination', { turn_id: inspected.turnId })));
      const inspectionRequest = (await f.list('ModelRequest')).find(row => row.id === firstInspection.modelRequestId);
      assert.equal(inspectionRequest.turn_id, inspected.turnId);
      assert.notEqual(inspectionRequest.turn_id, started.turnId);
      assert.equal((await f.list('ChildExecution')).length, 3, 'list, read and transient retry never create a child');
      assert.equal(f.dispatches.filter(call => call.arguments.operation === 'spawn').length, 3);
      assert.equal(f.dispatches.filter(call => call.arguments.operation === 'send').length, 2);
      assert.equal(f.dispatches.filter(call => call.arguments.operation === 'list').length, 1);
      assert.equal(f.dispatches.filter(call => call.arguments.operation === 'read').length, readPages);
      await f.compress(`${mode}-compact-second`);
      phase = 'next-turn';
      assert.equal((await f.runInput(`${mode}-another-turn`)).terminalStatus, 'completed');
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
      assert.equal((await f.runInput(`${mode}-after-reopen`)).terminalStatus, 'completed');
      assert.equal((await f.list('ChildExecution')).length, 3);
    } finally { release(); }
  });
});

for (const mode of ['llm_summary', 'provider_native']) for (const forkTurns of ['none', 'all', '1']) test(`spawn forkTurns=${forkTurns} inherits completed history atomically after ${mode}`, { timeout: 120000 }, async () => {
  let phase = 1;
  const rounds = new Map();
  let childStart;
  await fixture(mode, {
    async send(request, controls, f, wire, start) {
      if (request.conversationId !== 'parent') {
        childStart = { request, start };
        return complete(controls, done());
      }
      const round = (rounds.get(phase) ?? 0) + 1;
      rounds.set(phase, round);
      if (round === 1) return complete(controls, { role: 'model', parts: [phase < 3
        ? tool(`inspect-history-${phase}`, { operation: 'list' })
        : tool('fork-history', { operation: 'spawn', taskName: 'Forked reviewer',
          prompt: 'CHILD_NEW_ASSIGNMENT_7723', forkTurns })] });
      return complete(controls, { role: 'model', parts: [{ text: `COMPLETED_REPLY_${phase}_9981` }] });
    }
  }, async f => {
    for (phase = 1; phase <= 2; phase += 1) {
      const result = await f.runInput(`fork-history-${phase}`, `HISTORY_INPUT_${phase}_9927`);
      assert.equal(result.terminalStatus, 'completed');
    }
    await f.compress('fork-history-compression');
    const result = await f.runInput('fork-current', 'CURRENT_INCOMPLETE_INPUT_6621');
    assert.equal(result.terminalStatus, 'completed');
    assert.equal((await f.list('ChildExecution')).length, 1,
      JSON.stringify(f.starts.filter(item => item.conversationId === 'parent').at(-1)?.start.contents));
    await eventually(() => childStart, 'context-inheriting child did not reach the provider');
    const body = JSON.stringify(childStart.start.contents);
    assert.ok(body.includes('CHILD_NEW_ASSIGNMENT_7723'));
    assert.ok(!body.includes('CURRENT_INCOMPLETE_INPUT_6621'), 'current input is never inherited before the parent turn completes');
    for (const historyPhase of [1, 2]) {
      const expected = forkTurns === 'all' || (forkTurns === '1' && historyPhase === 2);
      assert.equal(body.includes(`HISTORY_INPUT_${historyPhase}_9927`), expected);
      assert.equal(body.includes(`COMPLETED_REPLY_${historyPhase}_9981`), expected);
    }
    const childConversation = childStart.request.conversationId;
    const childTurnId = (await f.list('ModelRequest')).find(row => row.id === childStart.request.modelRequestId).turn_id;
    const [head] = await f.list('ConversationContextHeadLink', { conversation_id: childConversation });
    await f.app.context.assertNativeContextClosed(head.root_id);
    const inheritedTurns = await f.list('Turn', { conversation_id: childConversation });
    assert.equal(inheritedTurns.length, forkTurns === 'none' ? 1 : forkTurns === 'all' ? 3 : 2);
    const childLinks = await f.list('ChildExecutionTurnLink');
    assert.equal(childLinks.length, 1, 'forked history grants no ChildExecution control links');
    const [childAuthority] = await f.list('AuthoritySnapshot', { turn_id: childTurnId });
    for (const turn of inheritedTurns.filter(turn => turn.id !== childTurnId)) {
      assert.equal((await f.list('ExecutionLease', { turn_id: turn.id })).length, 0);
      // Inherited history owns frozen copies of its historical authority, never the child's own.
      const snapshots = await f.list('AuthoritySnapshot', { turn_id: turn.id });
      assert.equal(snapshots.length, 1);
      assert.notEqual(snapshots[0].content_object_id, childAuthority.content_object_id);
      for (const request of await f.list('ModelRequest', { turn_id: turn.id })) {
        assert.equal(request.authority_snapshot_id, snapshots[0].id);
      }
    }
    await f.coordinator.waitForIdle();
    const [intent] = await f.list('EffectIntent', { effect_kind: 'subagent_spawn' });
    const request = await f.app.runtime.effects.readEffectRequest(intent.id);
    const replayCommand = { ...request, leaseOwnerId: 'different-replay-host',
      leaseExpiresAt: new Date(Date.now() + 120000).toISOString() };
    if (replayCommand.waitDeadlineAt === null) delete replayCommand.waitDeadlineAt;
    const beforeReplayMessages = await f.list('MessagePartOfConversation', { conversation_id: childConversation });
    assert.equal((await f.app.runtime.children.spawn(replayCommand)).deduplicated, true);
    assert.deepEqual(await f.list('MessagePartOfConversation', { conversation_id: childConversation }), beforeReplayMessages,
      'replay uses the committed snapshot rather than copying the now-completed parent current turn');
    await assert.rejects(f.app.runtime.children.spawn({ ...replayCommand,
      forkTurns: forkTurns === 'none' ? 'all' : 'none' }), /different facts/);
  });
});

test('a user fork of a forkTurns child owns its inherited history and outlives the deleted parent', { timeout: 120000 }, async () => {
  let phase = 1;
  const rounds = new Map();
  await fixture('llm_summary', {
    async send(request, controls) {
      if (request.conversationId !== 'parent') return complete(controls, done());
      const round = (rounds.get(phase) ?? 0) + 1;
      rounds.set(phase, round);
      if (round === 1 && phase === 2) return complete(controls, { role: 'model', parts: [tool('fork-history-child', {
        operation: 'spawn', taskName: 'Forked reviewer', prompt: 'CHILD_FORK_ASSIGNMENT_4471', forkTurns: 'all' })] });
      return complete(controls, { role: 'model', parts: [{ text: `PARENT_REPLY_${phase}_5530` }] });
    }
  }, async f => {
    for (phase = 1; phase <= 2; phase += 1) {
      assert.equal((await f.runInput(`child-fork-history-${phase}`, `PARENT_HISTORY_${phase}_5530`)).terminalStatus, 'completed');
    }
    await f.coordinator.waitForIdle();
    const [execution] = await f.list('ChildExecution');
    const child = execution.child_conversation_id;
    await eventually(async () => (await f.list('Turn', { conversation_id: child })).every(turn => turn.status === 'terminated')
      && (await f.list('Turn', { conversation_id: child })).length === 2, 'the child did not finish its assignment');
    const childModels = [];
    for (const member of (await f.list('MessagePartOfConversation', { conversation_id: child }))
      .sort((left, right) => Number(right.message_seq - left.message_seq))) {
      const [current] = await f.list('MessageCurrentRevisionLink', { message_id: member.message_id });
      const [revision] = await f.list('MessageRevision', { id: current.revision_id });
      if (revision.role === 'model') childModels.push({ messageId: member.message_id, revisionId: revision.id });
    }
    assert.ok(childModels.length > 0);
    /** Every request of a Conversation references an AuthoritySnapshot owned by its own Turn. */
    const assertSelfContainedAuthority = async conversationId => {
      for (const turn of await f.list('Turn', { conversation_id: conversationId })) {
        const snapshots = await f.list('AuthoritySnapshot', { turn_id: turn.id });
        assert.equal(snapshots.length, 1, `Turn ${turn.id} owns its frozen authority`);
        for (const request of await f.list('ModelRequest', { turn_id: turn.id })) {
          assert.equal(request.authority_snapshot_id, snapshots[0].id);
        }
      }
    };
    await assertSelfContainedAuthority(child);
    const lifecycle = new ReliableConversationLifecycle({ application: f.app, configuration: f.configuration });
    const fork = await lifecycle.fork({ sourceConversationId: child, messageId: childModels[0].messageId,
      expectedRevisionId: childModels[0].revisionId, commandId: 'user-fork-of-forked-child' });
    assert.equal(fork.deduplicated, false);
    assert.equal((await f.list('Turn', { conversation_id: fork.conversationId })).length, 2);
    await assertSelfContainedAuthority(fork.conversationId);

    await f.coordinator.waitForIdle();
    const deleted = await f.app.database.conversationOwners.run('parent', () => f.app.conversationDeletion.delete('parent'));
    assert.ok(deleted.deletedConversationIds.includes('parent'));
    assert.equal(deleted.deletedConversationIds.includes(fork.conversationId), false);
    await assertSelfContainedAuthority(fork.conversationId);
    assert.equal((await f.runInput('continue-child-fork-after-parent-delete', 'CONTINUE_CHILD_FORK_7718', fork.conversationId))
      .terminalStatus, 'completed');
    const body = JSON.stringify(f.requests.at(-1).context);
    assert.ok(body.includes('PARENT_HISTORY_1_5530'), 'the fork keeps the history the child inherited');
    const [forkModel] = (await f.list('MessagePartOfConversation', { conversation_id: fork.conversationId }))
      .sort((left, right) => Number(left.message_seq - right.message_seq));
    const [current] = await f.list('MessageCurrentRevisionLink', { message_id: forkModel.message_id });
    const again = await lifecycle.fork({ sourceConversationId: fork.conversationId, messageId: forkModel.message_id,
      expectedRevisionId: current.revision_id, commandId: 'fork-of-child-fork-after-parent-delete' });
    await assertSelfContainedAuthority(again.conversationId);
  });
});

test('a user fork of a forkTurns child stays forkable after a compression and a delete inside the inherited history', { timeout: 120000 }, async () => {
  let phase = 1;
  const rounds = new Map();
  await fixture('llm_summary', {
    async send(request, controls) {
      if (request.conversationId !== 'parent') return complete(controls, done());
      const round = (rounds.get(phase) ?? 0) + 1;
      rounds.set(phase, round);
      if (round === 1 && phase === 3) return complete(controls, { role: 'model', parts: [tool('truncated-history-child', {
        operation: 'spawn', taskName: 'Truncated reviewer', prompt: 'CHILD_TRUNCATED_ASSIGNMENT_6120', forkTurns: 'all' })] });
      return complete(controls, { role: 'model', parts: [{ text: `PARENT_REPLY_${phase}_6120` }] });
    }
  }, async f => {
    for (phase = 1; phase <= 3; phase += 1) {
      assert.equal((await f.runInput(`truncated-child-history-${phase}`, `PARENT_HISTORY_${phase}_6120`)).terminalStatus, 'completed');
    }
    await f.coordinator.waitForIdle();
    const [execution] = await f.list('ChildExecution');
    const child = execution.child_conversation_id;
    await eventually(async () => (await f.list('Turn', { conversation_id: child })).every(turn => turn.status === 'terminated')
      && (await f.list('Turn', { conversation_id: child })).length === 3, 'the child did not finish its assignment');
    // The child's first Context root holds both inherited exchanges and its assignment in one step:
    // no root of the child ever held only part of the inherited history.
    const [firstRoot] = (await f.list('ContextSequenceRoot', { conversation_id: child }))
      .sort((left, right) => Number(left.root_seq - right.root_seq));
    assert.equal(firstRoot.segment_count, 5n, 'fixture: the child started from two inherited exchanges and its assignment');
    const lifecycle = new ReliableConversationLifecycle({ application: f.app, configuration: f.configuration });
    const messages = async conversationId => {
      const result = [];
      for (const member of (await f.list('MessagePartOfConversation', { conversation_id: conversationId }))
        .sort((left, right) => Number(left.message_seq - right.message_seq))) {
        const [current] = await f.list('MessageCurrentRevisionLink', { message_id: member.message_id });
        const [revision] = await f.list('MessageRevision', { id: current.revision_id });
        const [message] = await f.list('Message', { id: member.message_id });
        if (message.deleted_at === null) result.push({ messageId: member.message_id, expectedRevisionId: revision.id, role: revision.role });
      }
      return result;
    };
    const latestModel = async conversationId => (await messages(conversationId)).filter(message => message.role === 'model').at(-1);
    const fork = await lifecycle.fork({ sourceConversationId: child, ...await latestModel(child), commandId: 'fork-truncated-child' });
    const branch = fork.conversationId;
    // Compress the first inherited exchange, then delete from the second one: the compression's
    // creation root keeps only the first exchange, which no root of the branch holds.
    await f.compress('truncated-child-compression', branch, 2);
    const secondInherited = (await messages(branch))[2];
    assert.equal(secondInherited.role, 'user');
    await f.app.turns.delete({ source: { kind: 'command', key: 'delete-inside-inherited-history' }, conversationId: branch,
      messageId: secondInherited.messageId });
    assert.equal((await f.app.context.materializeStructure(await f.app.context.currentHeadRootId(branch))).records.length, 1);
    assert.equal((await f.runInput('continue-truncated-child-fork', 'CONTINUE_TRUNCATED_FORK_6120', branch)).terminalStatus, 'completed');

    const again = await lifecycle.fork({ sourceConversationId: branch, ...await latestModel(branch), commandId: 'refork-truncated-child' });
    const [block] = await f.list('CompressionBlock', { conversation_id: again.conversationId });
    const [projection] = await f.list('ModelContextProjection', { owner_kind: 'compression_block', owner_id: block.id });
    const [creationRoot] = await f.list('ContextSequenceRoot', { id: projection.root_id });
    assert.equal(creationRoot.conversation_id, again.conversationId, 'the creation projection is re-homed onto the new fork');
    assert.equal(creationRoot.segment_count, 2n, 'the creation root holds exactly the kept first exchange');
    assert.equal((await f.runInput('continue-truncated-child-refork', 'CONTINUE_TRUNCATED_REFORK_6120', again.conversationId))
      .terminalStatus, 'completed');
    const body = JSON.stringify(f.requests.at(-1).context);
    assert.ok(body.includes(SUMMARY) && body.includes('CONTINUE_TRUNCATED_FORK_6120'));
    assert.ok(!body.includes('PARENT_HISTORY_2_6120'), 'the deleted inherited exchange stays deleted');
  });
});

test('forkTurns validates a single explicit format without number or whitespace fallback', () => {
  const { normalizeChildForkTurns } = load('backend/reliableKernel/childContextFork.js');
  for (const valid of [undefined, 'none', 'all', '1', '25']) {
    assert.equal(normalizeChildForkTurns(valid), valid ?? 'none');
  }
  for (const invalid of [null, 1, 0, '0', '-1', '01', ' 1', '1 ', '1.5', '9007199254740992', 'ALL']) {
    assert.throws(() => normalizeChildForkTurns(invalid), /forkTurns/);
  }
});

for (const winningState of ['dispatched', 'receipt_written', 'reconciled', 'inconsistent']) {
  test(`spawn recovery validates the exact concurrent dispatch winner: ${winningState}`, { timeout: 30000 }, async () => {
    await fixture('llm_summary', { async send() { throw new Error('Claim recovery must not start a model request.'); } }, async f => {
      const { database } = f.app;
      const { effects, children } = f.app.runtime;
      const parent = await f.app.turns.input({ source: { kind: 'command', key: `claim-race-${winningState}` },
        conversationId: 'parent', content: 'Prepare a child without dispatching it.',
        leaseOwnerId: 'claim-race-owner', hostBootId: database.hostBootId,
        leaseExpiresAt: new Date(Date.now() + 120000).toISOString() });
      const sourceToolCallId = `claim-race-tool-${winningState}`;
      await effects.createToolCall({ source: { kind: 'internal', key: sourceToolCallId },
        toolCallId: sourceToolCallId, turnId: parent.turnId, toolName: 'run_agent',
        arguments: { operation: 'spawn', taskName: 'Dispatch race', prompt: 'Inspect the race.' } });
      const [agentLink] = await f.list('AgentConversationLink', { conversation_id: 'parent' });
      const spawned = await children.spawn({ sourceToolCallId, childAgentId: agentLink.agent_id,
        modelFallback: { providerConfigId: f.provider.id, model: f.provider.model }, prompt: 'Inspect the race.',
        completionPolicy: 'background', sourceSettlement: 'child_handle', leaseOwnerId: 'claim-race-child',
        leaseExpiresAt: new Date(Date.now() + 120000).toISOString() });
      const originalClaim = effects.claimEffectDispatch;
      const originalSnapshot = database.snapshot;
      let winningClaimCount = 0;
      let losingClaimError;
      effects.claimEffectDispatch = async intentId => {
        assert.equal(intentId, spawned.effectIntentId);
        database.snapshot = async reads => {
          const snapshot = await originalSnapshot.call(database, reads);
          if (reads.length === 1 && reads[0].domain === 'EffectIntent' && reads[0].kind === 'get'
            && reads[0].id === intentId && snapshot.snapshot[0]?.dispatch_state === 'pending') {
            // The losing claim has read pending. Before its next Attempt read, let the real
            // dispatcher commit the next frontier, returning the original stale Intent read.
            database.snapshot = originalSnapshot;
            assert.equal(await originalClaim.call(effects, intentId), true);
            winningClaimCount += 1;
            if (winningState !== 'dispatched') {
              const receipt = await children.recordSpawnReceipt({ sourceKey: `normal-winner-${winningState}`,
                attemptId: spawned.attemptId, outcome: 'succeeded' });
              if (winningState === 'reconciled') await children.reconcileSpawnReceipt(receipt.effectReceiptId);
              if (winningState === 'inconsistent') await database.transaction([
                kernel.DOMAIN_REPOSITORIES.domain('Operation').update(spawned.operationId, { status: 'invalid-frontier' })
              ]);
            }
          }
          return snapshot;
        };
        try {
          return await originalClaim.call(effects, intentId);
        } catch (error) {
          losingClaimError = error;
          assert.match(error.message, /parent Attempt\/Operation is no longer dispatchable/);
          throw error;
        } finally { database.snapshot = originalSnapshot; }
      };
      try {
        if (winningState === 'inconsistent') {
          await assert.rejects(children.recoverSpawnIntent(spawned.effectIntentId), error => error === losingClaimError);
          assert.equal((await f.list('ChildExecution'))[0].status, 'starting', 'inconsistent evidence cannot promote the child');
          assert.equal((await f.list('ToolModelResult', { tool_call_id: sourceToolCallId })).length, 0);
        } else {
          const recovered = await children.recoverSpawnIntent(spawned.effectIntentId);
          assert.equal(recovered.childExecutionId, spawned.childExecutionId);
          assert.equal(recovered.childTurnId, spawned.childTurnId);
          assert.equal(recovered.dispatchState, 'receipt_written');
          assert.equal(recovered.childStatus, 'active');
          assert.equal(recovered.shouldDrive, true);
          assert.equal((await f.list('ToolModelResult', { tool_call_id: sourceToolCallId })).length, 1);
          assert.equal((await effects.readTerminalResult(sourceToolCallId)).status, 'succeeded');
        }
        assert.equal(winningClaimCount, 1, 'one actual dispatcher wins the persisted claim');
        assert.ok(losingClaimError, 'the regression must exercise the real stale-claim rejection');
        assert.equal((await f.list('ChildExecution')).length, 1);
        assert.equal((await f.list('EffectReceipt', { attempt_id: spawned.attemptId })).length, 1,
          'recovery reuses the winner receipt or creates exactly one for the claimed local effect');
        assert.equal(f.requests.length, 0, 'claim recovery only reconciles facts; the child driver starts model work separately');
      } finally {
        effects.claimEffectDispatch = originalClaim;
        database.snapshot = originalSnapshot;
      }
    });
  });
}
