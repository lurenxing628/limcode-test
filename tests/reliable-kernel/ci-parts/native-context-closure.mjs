import assert from 'node:assert/strict';

import fs from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

import { createRequire } from 'node:module';

import { setTimeout as delay } from 'node:timers/promises';

import test from 'node:test';

const require = createRequire(import.meta.url);

const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');

const load = file => require(path.join(compiled, file));

const kernel = load('backend/reliableKernel/index.js');

const { emptyConversationContextHandleStateStep } = load('backend/reliableKernel/conversationContextHandleState.js');

const capabilities = { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false, explicitCaching: true };

const definition = { name: 'native_probe', description: 'one synchronous native tool', parameters: { type: 'object' } };

const CONVERSATION = 'native-closure';

const rows = async (app, domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain)
  .list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function waitFor(predicate, label, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

/** Per provider call id: native call occurrences and result-pair occurrences one full request carries. */
function nativeToolPairs(request) {
  const calls = new Map();
  for (const item of request.context) {
    if (item.contentType !== 'application/vnd.limcode.context-tool-pair+json') continue;
    const pair = JSON.parse(item.content);
    const id = pair.toolCall.providerCallId ?? pair.toolCall.id;
    const entry = calls.get(id) ?? { calls: 0, results: 0 };
    if (pair.toolModelResult) entry.results += 1; else entry.calls += 1;
    calls.set(id, entry);
  }
  return calls;
}

/** Native calls whose Context call occurrence has no result occurrence: an unresolved Provider call. */
async function unresolvedNativeCalls(app) {
  return (await app.runtime.effects.listNativePendingWork({ conversationId: CONVERSATION }))
    .filter(entry => entry.callContextSegmentId !== undefined && entry.resultContextSegmentId === undefined);
}

async function emitToolResponse(emit, responseId, callIds) {
  await emit('native_control', { type: 'response.created', responseId, capabilities });
  for (const [index, callId] of callIds.entries()) {
    await emit('output_item_done', {
      type: 'tool_calls',
      calls: [{ id: callId, ordinal: index, name: 'native_probe', arguments: { callId } }],
      outputItem: { id: `item-${callId}`, ordinal: index, providerResponseId: responseId }
    });
  }
  await emit('native_control', { type: 'response.completed', responseId,
    usage: { input_tokens: 200, output_tokens: 10 } });
}

async function emitFinalText(emit, responseId, text) {
  await emit('native_control', { type: 'response.created', responseId, capabilities });
  await emit('native_control', { type: 'response.completed', responseId,
    usage: { input_tokens: 220, output_tokens: 5 } });
  await emit('completed', { role: 'model', parts: [{ text }] });
}

/**
 * Scripted native transport over the real fenced SQLite/CAS kernel. `script` runs one physical
 * logical request per sendFullRequest; `gates` holds tool executions that must not settle yet.
 */
async function withNativeKernel(script, verify) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-context-closure-'));
  const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(root);
  const requests = [];
  const executions = [];
  const gates = new Map();
  let app;
  const adapter = {
    providerId: 'native-provider',
    async materializeNativeToolOutput(outputs) { return outputs; },
    async sendFullRequest(request, controls) {
      const round = requests.length;
      requests.push(request);
      const responseId = `response-${round}`;
      let sequence = 0;
      const emit = (kind, content) => controls.onEvent({ kind, streamSeq: String(++sequence), content });
      const ended = deferred();
      controls.native.onController({
        get responseId() { return responseId; },
        endLogicalRequest() { ended.resolve(); },
        async steer() { throw new Error('No steering in this fixture.'); },
        async submitToolResults() { throw new Error('A settled batch is carried by the next full request.'); }
      });
      try {
        await script({ round, request, controls, emit, responseId, ended, app });
      } finally {
        controls.native.onController(undefined);
      }
    }
  };
  const dependencies = {
    authorityCompiler: { async compile(request) { return {
      turnId: request.turnId, executorAgentId: request.executorAgentId,
      executionPreset: { content: JSON.stringify({ providerConfigId: 'native-provider', modelId: 'gpt-6-astra' }) },
      authoritySnapshot: { content: JSON.stringify({ kind: 'effective-turn-authority',
        turnId: request.turnId, conversationId: request.conversationId, executorAgentId: request.executorAgentId,
        model: { providerConfigId: 'native-provider', provider: 'openai-responses', modelId: 'gpt-6-astra',
          baseUrl: 'https://native-closure.invalid/v1', openaiResponsesTransport: 'http',
          nativeResponses: { enabled: true, asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false },
          retryPolicy: { enabled: false, maxRetries: 0 } },
        modelProfile: { compressionThresholdTokens: 1000000, contextWindowTokens: 1200000,
          tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
        toolPolicy: { id: 'native-tools', allowedTools: ['native_probe'], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
        planReviewPolicy: { mode: 'never' }, systemPrompt: { id: 'prompt', text: '' },
        runtimeContext: { id: null, name: '', template: '' },
        workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
      }) }
    }; } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('unexpected MCP call'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }; } },
    providers: { resolve() { return adapter; } },
    toolDispatcher: {
      definitions() { return [definition]; },
      async dispatch() { assert.fail('native calls must use the durable admitted-call dispatcher'); },
      async scheduleAdmittedCall(input) {
        executions.push(input.providerCallId);
        const gate = gates.get(input.providerCallId);
        if (gate) await gate.promise;
        const settled = await app.runtime.effects.settleWithoutEffect({
          source: { kind: 'internal', key: `native-closure:${input.toolCallId}` },
          toolCallId: input.toolCallId, status: 'succeeded', detail: { ok: true, callId: input.providerCallId }
        });
        return settled.terminal;
      }
    }
  };
  const leaseFor = async turnId => {
    const [lease] = await rows(app, 'ExecutionLease', { turn_id: turnId });
    return { id: lease.id, conversationId: lease.conversation_id, turnId: lease.turn_id,
      ownerId: lease.owner_id, hostBootId: lease.host_boot_id, generation: BigInt(lease.generation) };
  };
  const startTurn = async (key, content) => {
    const started = await app.turns.input({ source: { kind: 'command', key }, conversationId: CONVERSATION,
      leaseOwnerId: 'fixture', hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 300000).toISOString(), content });
    return { turnId: started.turnId, fence: await leaseFor(started.turnId) };
  };
  const drive = (turn) => kernel.runWithExecutionLeaseFence(turn.fence, () => app.agentLoop.drive(turn.turnId));
  const reopen = async () => {
    await app.close();
    app = await kernel.ReliableKernelApplication.open(root, dependencies);
    return app;
  };
  const recover = async (turnId) => {
    const claimed = await app.turns.claimRecoveryExecution({ turnId, leaseOwnerId: 'recovered-owner',
      hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 120000).toISOString() });
    assert.ok(claimed, 'a new Host may claim the orphaned Turn');
    return { turnId, fence: await leaseFor(turnId) };
  };
  try {
    app = await kernel.ReliableKernelApplication.open(root, dependencies);
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: CONVERSATION, title: 'Native closure', status: 'active', created_at: now, updated_at: now
      }),
      emptyConversationContextHandleStateStep(CONVERSATION, now),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: 'native-closure-agent', conversation_id: CONVERSATION, agent_id: 'agent-main', role: 'default',
        created_at: now, updated_at: now
      })
    ]);
    await verify({ get app() { return app; }, requests, executions, gates, startTurn, drive, reopen, recover });
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function registerCases(test) {

test('a user interrupt keeps the finished sibling result in Context while the other call is still running', { timeout: 30000 }, async () => {
  const running = deferred();
  await withNativeKernel(async ({ round, controls, emit, responseId }) => {
    if (round === 0) {
      await emitToolResponse(emit, responseId, ['call-finished', 'call-running']);
      running.resolve();
      await new Promise(resolve => controls.signal.addEventListener('abort', resolve, { once: true }));
      const error = new Error('aborted by the user');
      error.name = 'AbortError';
      throw error;
    }
    await emitFinalText(emit, responseId, 'continued after the interrupt');
  }, async ({ app, requests, executions, gates, startTurn, drive }) => {
    gates.set('call-running', deferred());
    const first = await startTurn('closure-interrupt-1', 'Run both probes.');
    const driving = drive(first);
    await running.promise;
    await waitFor(async () => executions.includes('call-running')
      && (await rows(app, 'ToolModelResult')).length === 1, 'finished sibling settled while the other still runs');
    await app.turns.interrupt({ source: { kind: 'command', key: 'closure-stop' },
      turnId: first.turnId, reason: 'user stop' });
    await kernel.runWithExecutionLeaseFence(first.fence,
      () => app.modelProvider.cancelTurnDispatches(first.turnId, 'user stop'));
    assert.equal((await driving).terminalStatus, 'interrupted');
    assert.deepEqual(await unresolvedNativeCalls(app), [],
      'no native call stays in Context without its result after the interrupt');

    const second = await startTurn('closure-interrupt-2', 'Continue.');
    const outcome = await drive(second);
    assert.equal(outcome.terminalStatus, 'completed');
    const pairs = nativeToolPairs(requests[requests.length - 1]);
    assert.deepEqual(pairs.get('call-finished'), { calls: 1, results: 1 },
      'the finished result reaches the next request exactly once');
    assert.deepEqual(pairs.get('call-running'), { calls: 1, results: 1 },
      'the interrupted call is closed by its real cancelled result');
    assert.equal(executions.filter(id => id === 'call-finished').length, 1);
    assert.equal(executions.filter(id => id === 'call-running').length, 1);
  });
});
}

export { registerCases };
