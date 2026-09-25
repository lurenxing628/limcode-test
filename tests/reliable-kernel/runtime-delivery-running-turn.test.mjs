import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiled, 'backend/reliableKernel/index.js'));

const CONVERSATION = 'delivery-running-turn';
const rows = async (app, domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain)
  .list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;

async function withKernel(verify) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-running-turn-'));
  const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(root);
  const dependencies = {
    authorityCompiler: { async compile(request) { return {
      turnId: request.turnId, executorAgentId: request.executorAgentId,
      executionPreset: { content: JSON.stringify({ providerConfigId: 'provider', modelId: 'model' }) },
      authoritySnapshot: { content: JSON.stringify({ kind: 'effective-turn-authority',
        turnId: request.turnId, conversationId: request.conversationId, executorAgentId: request.executorAgentId,
        model: { providerConfigId: 'provider', provider: 'openai-responses', modelId: 'model',
          baseUrl: 'https://delivery.invalid/v1', retryPolicy: { enabled: false, maxRetries: 0 } },
        modelProfile: { compressionThresholdTokens: 100000, contextWindowTokens: 120000,
          tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
        toolPolicy: { id: 'tools', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
        planReviewPolicy: { mode: 'never' }, systemPrompt: { id: 'prompt', text: '' },
        runtimeContext: { id: null, name: '', template: '' },
        workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
      }) }
    }; } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('unexpected MCP call'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }; } },
    providers: { resolve() { throw new Error('no provider request in this fixture'); } },
    toolDispatcher: { definitions() { return []; }, async dispatch() { throw new Error('no tools in this fixture'); } }
  };
  let app;
  try {
    app = await kernel.ReliableKernelApplication.open(root, dependencies);
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: CONVERSATION, title: 'Delivery', status: 'active', created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: 'delivery-agent', conversation_id: CONVERSATION, agent_id: 'agent-main', role: 'default',
        created_at: now, updated_at: now
      })
    ]);
    const startTurn = async key => {
      const started = await app.turns.input({ source: { kind: 'command', key }, conversationId: CONVERSATION,
        leaseOwnerId: 'fixture', hostBootId: app.database.hostBootId,
        leaseExpiresAt: new Date(Date.now() + 300000).toISOString(), content: key });
      const [lease] = await rows(app, 'ExecutionLease', { turn_id: started.turnId });
      return { turnId: started.turnId, fence: { id: lease.id, conversationId: lease.conversation_id,
        turnId: lease.turn_id, ownerId: lease.owner_id, hostBootId: lease.host_boot_id, generation: BigInt(lease.generation) } };
    };
    const endTurn = (turn, terminalStatus) => kernel.runWithExecutionLeaseFence(turn.fence, () => app.turns.terminal({
      source: { kind: 'internal', key: `fixture-end-${turn.turnId}` }, turnId: turn.turnId,
      terminalStatus, reason: `fixture ${terminalStatus}`
    }));
    const inbox = async id => {
      const created = new Date().toISOString();
      await app.database.transaction([kernel.DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').insert({
        id, dedupe_key: `fixture:${id}`, source_kind: 'process_receipt', source_id: `receipt-${id}`,
        state: 'available', created_at: created, updated_at: created
      })]);
      return id;
    };
    const router = new kernel.AutomaticRuntimeDeliveryRouter(app.database, app.contentStore);
    await verify({ app, router, startTurn, endTurn, inbox });
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('a result of a completed source Turn joins the running Turn instead of waiting for it to end', { timeout: 30000 }, async () => {
  await withKernel(async ({ router, startTurn, endTurn, inbox }) => {
    const source = await startTurn('source-turn');
    await endTurn(source, 'completed');
    const running = await startTurn('running-turn');
    const inboxItemId = await inbox('background-command');
    const decision = await router.resolve({ inboxItemId, targetConversationId: CONVERSATION, sourceTurnId: source.turnId });
    assert.equal(decision.phase, 'current_turn');
    assert.equal(decision.targetTurnId, running.turnId, 'the running Turn takes the result at its next request boundary');
    assert.equal(decision.reason, 'target_turn_active');
    assert.equal(decision.sourceTurnId, source.turnId, 'authority still comes from the completed source Turn');

    await endTurn(running, 'completed');
    const idle = await router.resolve({ inboxItemId, targetConversationId: CONVERSATION, sourceTurnId: source.turnId });
    assert.equal(idle.phase, 'next_turn', 'an idle Conversation starts a continuation as before');
    assert.equal(idle.targetTurnId, null);
    assert.equal(idle.reason, 'source_turn_completed');
  });
});

test('an interrupted source Turn never gains delivery authority because another Turn is running', { timeout: 30000 }, async () => {
  await withKernel(async ({ router, startTurn, endTurn, inbox }) => {
    const source = await startTurn('stopped-source');
    await endTurn(source, 'interrupted');
    await startTurn('unrelated-running-turn');
    const inboxItemId = await inbox('stopped-command');
    const decision = await router.resolve({ inboxItemId, targetConversationId: CONVERSATION, sourceTurnId: source.turnId });
    assert.equal(decision.phase, 'notify_only');
    assert.equal(decision.targetTurnId, null);
    assert.equal(decision.reason, 'source_turn_not_successful');
  });
});
