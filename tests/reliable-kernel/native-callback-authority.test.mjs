import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiled, 'backend/reliableKernel/index.js'));
const capabilities = { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false, explicitCaching: true };
const definition = { name: 'native_probe', description: 'native authority probe',
  parameters: { type: 'object' }, metadata: { nativeAsync: true } };
const deadlineMs = 21377;
const rows = async (app, domain, where = {}) => (await app.database.snapshotAll(
  kernel.DOMAIN_REPOSITORIES.domain(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 100 })
)).snapshot;

async function withNativeApp(stage, verify) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-callback-authority-'));
  const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(root);
  let app;
  let sends = 0;
  let aborted = false;
  let release;
  const abortObserved = new Promise(resolve => { release = resolve; });
  const executions = [];
  const settlements = [];
  const adapter = new kernel.LlmCapabilityFullRequestAdapter('native-provider', {
    start(request, emit, controls) {
      sends += 1;
      const responseId = `response-${sends}`;
      controls.native.onController({
        responseId, endLogicalRequest() {},
        async steer() { throw new Error('unused steering'); },
        async submitToolResults() { throw new Error('fixture never delivers a tool result'); }
      });
      const control = event => emit({ type: 'llm:nativeControl', payload: { requestId: request.id, event } });
      control({ type: 'response.created', responseId, capabilities });
      if (sends === 1) {
        emit({ type: 'llm:toolcall', payload: { requestId: request.id,
          calls: [{ id: 'expired-call', ordinal: 0, name: definition.name, arguments: {}, async: stage !== 'sync-freeze' }],
          outputItem: { id: 'expired-item', ordinal: 0, providerResponseId: responseId }
        } });
        if (stage === 'sync-freeze') control({ type: 'response.completed', responseId });
      } else {
        control({ type: 'response.completed', responseId });
        emit({ type: 'llm:done', payload: { requestId: request.id,
          content: { role: 'model', parts: [{ text: 'recovered without the expired tool' }] } } });
      }
    },
    abort() { aborted = true; release(); }, compact() {}, resolveInvocation() {}, cancelRetry() {}, dispose() {},
    listModels: async () => [], dryRun() { throw new Error('unused dry run'); }, dryRunCompact() { throw new Error('unused compact'); }
  });
  const dependencies = {
    authorityCompiler: { async compile(input) {
      return { turnId: input.turnId, executorAgentId: input.executorAgentId,
        executionPreset: { content: JSON.stringify({ providerConfigId: 'native-provider', modelId: 'gpt-6-astra' }) },
        authoritySnapshot: { content: JSON.stringify({ kind: 'effective-turn-authority',
          turnId: input.turnId, conversationId: input.conversationId, executorAgentId: input.executorAgentId,
          model: { providerConfigId: 'native-provider', provider: 'openai-responses', modelId: 'gpt-6-astra',
            baseUrl: 'https://native-callback.invalid/v1', openaiResponsesTransport: 'http',
            nativeResponses: { enabled: true, asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false },
            retryPolicy: { enabled: true, maxRetries: 1, retryDelayMs: 1 } },
          modelProfile: { compressionThresholdTokens: 1000000, contextWindowTokens: 1200000,
            tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
          toolPolicy: { id: 'native-tools', allowedTools: [definition.name], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
          planReviewPolicy: { mode: 'never' }, systemPrompt: { id: 'prompt', text: '' },
          runtimeContext: { id: null, name: '', template: '' },
          workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
        }) } };
    } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { toolAnnotations: async () => ({}), callTool: async () => null },
    mcpPolicyGate: { authorize: async () => ({ toolPolicyAllowed: true, planReviewAllowed: true }) },
    attachmentSettings: { loadGlobalSettings: async () => ({ section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }) },
    providers: { resolve: () => adapter },
    toolDispatcher: {
      definitions: () => [definition],
      async dispatch() { throw new Error('unexpected ordinary tool dispatch'); },
      async scheduleAdmittedCall(input) {
        executions.push(input.providerCallId);
        const settling = app.runtime.effects.settleWithoutEffect({
          source: { kind: 'internal', key: `authority-probe:${input.toolCallId}` },
          toolCallId: input.toolCallId, status: 'succeeded', detail: { ok: true }
        });
        settlements.push(settling);
        const settled = await settling;
        return settled.terminal;
      }
    }
  };
  try {
    app = await kernel.ReliableKernelApplication.open(root, dependencies);
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'native-authority', title: 'Native authority',
        status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'native-authority-agent',
        conversation_id: 'native-authority', agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now })
    ]);
    await verify({ app, executions, abortObserved, get aborted() { return aborted; }, get sends() { return sends; } });
  } finally {
    release();
    await Promise.allSettled(settlements);
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

for (const stage of ['queued-control', 'proof', 'item', 'async-freeze', 'sync-freeze',
  'batch-entry', 'batch-prepare', 'root-binding', 'context-committed']) {
  test(`native callback loses admission authority when dispatch aborts during ${stage}`, { timeout: 15000 }, async t => {
    let fireDeadline;
    let firstDeadline = true;
    const schedule = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
      const handle = schedule(callback, milliseconds, ...args);
      if (milliseconds === deadlineMs && firstDeadline) {
        firstDeadline = false;
        fireDeadline = () => { clearTimeout(handle); callback(...args); };
      }
      return handle;
    });
    await withNativeApp(stage, async state => {
      const plane = state.app.modelProvider;
      const dispatch = plane.dispatch.bind(plane);
      plane.dispatch = (id, adapter, options) => dispatch(id, adapter, { ...options, timeoutMs: deadlineMs });
      let stalled = false;
      const stall = async () => {
        stalled = true;
        assert.equal(typeof fireDeadline, 'function');
        assert.equal((await rows(state.app, 'ToolCall')).length, stage === 'context-committed' ? 1 : 0,
          'the positive context case has already committed admission before the dispatch abort');
        fireDeadline();
        await state.abortObserved;
        assert.equal(state.aborted, true, 'the original dispatch aborted before its callback resumes');
      };
      const wrap = (owner, name, matches = () => true) => {
        const original = owner[name].bind(owner);
        owner[name] = async (...args) => {
          if (!stalled && matches(args)) await stall();
          return original(...args);
        };
      };
      if (stage === 'queued-control') wrap(plane, 'recordDispatchStreamEvent', args => args[3].kind === 'native_control');
      if (stage === 'proof') wrap(plane, 'recordNativeToolCallProof');
      if (stage === 'item') wrap(state.app.agentLoop.turnOutput, 'appendNativeAssistantItem');
      if (stage.endsWith('freeze')) wrap(state.app.agentLoop, 'freezeDispatchPolicies');
      if (stage === 'batch-entry') wrap(state.app.agentLoop.effects, 'createToolCallBatch');
      if (stage === 'batch-prepare') wrap(state.app.contentStore, 'prepare',
        args => args[2] === 'application/vnd.limcode.native-tool-admission+json');
      if (stage === 'context-committed') wrap(state.app.agentLoop.context, 'appendNativeToolCall');
      if (stage === 'root-binding') {
        // Isolate the admission transaction's actual RootAuthority await from other worker reads.
        const admission = new AsyncLocalStorage();
        const database = state.app.database;
        const request = database.request.bind(database);
        database.request = (payload, ...args) => admission.run(payload.kind === 'transaction'
          && payload.steps.some(step => step.domain === 'ToolCall' && step.kind === 'insert'),
        () => request(payload, ...args));
        const validate = database.authority.validate.bind(database.authority);
        database.authority.validate = async (...args) => {
          const binding = await validate(...args);
          if (admission.getStore() && !stalled) await stall();
          return binding;
        };
      }
      const started = await state.app.turns.input({ source: { kind: 'command', key: stage }, conversationId: 'native-authority',
        leaseOwnerId: 'authority-owner', hostBootId: state.app.database.hostBootId,
        leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), content: 'Run the native probe.' });
      const [lease] = await rows(state.app, 'ExecutionLease', { turn_id: started.turnId });
      const fence = { id: lease.id, conversationId: lease.conversation_id, turnId: lease.turn_id,
        ownerId: lease.owner_id, hostBootId: lease.host_boot_id, generation: BigInt(lease.generation) };
      const drive = () => kernel.runWithExecutionLeaseFence(fence, () => state.app.agentLoop.drive(started.turnId));
      let outcome = await drive();
      if (stage === 'context-committed' && outcome.terminalStatus === 'waiting') {
        await state.app.agentLoop.quiesceNativeCalls(started.turnId);
        outcome = await drive();
      }
      assert.equal(stalled, true, 'the regression reached the selected asynchronous boundary');
      const admittedBeforeAbort = stage === 'context-committed';
      assert.deepEqual(state.executions, admittedBeforeAbort ? ['expired-call'] : [],
        'aborting dispatch rejects new admission and preserves already committed work');
      assert.equal((await rows(state.app, 'ToolCall')).length, admittedBeforeAbort ? 1 : 0);
      assert.equal(outcome.terminalStatus, 'completed', 'bounded recovery still accepts the next live dispatch');
      assert.equal(state.sends, 2);
    });
  });
}
