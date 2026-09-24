import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const root = process.env.LIMCODE_TEST_EXTENSION_ROOT || path.resolve('dist/extension');
const { buildModelHandleCatalog, resolveModelToolArguments, projectToolResultForModel } =
  require(path.join(root, 'backend/reliableKernel/modelHandleCatalog.js'));
const catalog = buildModelHandleCatalog([{ answerBridgeIds: ['bridge-first', 'bridge-second'] }]);
const { projectToolResultBatch } = require(path.join(root, 'backend/reliableKernel/modelFacingContextProjection.js'));

test('multi-child wait resolves all frozen references without changing caller input', () => {
  const input = { operation: 'wait', childRefs: ['A2', 'A1'], timeoutMs: 0 };
  assert.deepEqual(resolveModelToolArguments('run_agent', input, catalog), {
    operation: 'wait', answerBridgeIds: ['bridge-second', 'bridge-first'], timeoutMs: 0
  });
  assert.deepEqual(input.childRefs, ['A2', 'A1']);
  assert.deepEqual(projectToolResultForModel('run_agent', {
    answerBridgeIds: ['bridge-second', 'bridge-first'], status: 'running'
  }, catalog), { childRefs: ['A2', 'A1'], status: 'running' });
});

test('invalid or conflicting child references cannot silently select a different child', () => {
  for (const args of [
    { childRef: 1 }, { childRef: 'A3' },
    { childRef: 'A1', answerBridgeId: 'bridge-second' },
    { childRefs: ['A1', ''] }, { childRefs: ['A1', 'A3'] },
    { childRefs: ['A1'], answerBridgeIds: ['bridge-second'] },
    { childRefs: Array(33).fill('A1') }
  ]) {
    assert.throws(() => resolveModelToolArguments('run_agent', { operation: 'send', ...args }, catalog),
      error => error.code === 'UNKNOWN_MODEL_HANDLE_REFERENCE');
  }
});

test('empty child references from strict-schema models count as omitted and never pick a child', () => {
  // Strict schema normalization makes models fill unused optional fields with "" or [""].
  for (const args of [{ childRef: '' }, { childRef: null }, { childRefs: [] }, { childRefs: [''] }]) {
    assert.deepEqual(resolveModelToolArguments('run_agent', { operation: 'send', prompt: 'p', ...args }, catalog),
      { operation: 'send', prompt: 'p' });
  }
  assert.deepEqual(resolveModelToolArguments('run_agent', { operation: 'wait', childRef: '', childRefs: ['A1'], timeoutMs: 0 }, catalog),
    { operation: 'wait', answerBridgeIds: ['bridge-first'], timeoutMs: 0 });
});

test('a squeezed parallel read preserves its current-page retry cursor as well as the next cursor', () => {
  const rereadCursor = 'r'.repeat(1_100);
  const batch = projectToolResultBatch(Array.from({ length: 8 }, (_, index) => ({
    toolName: 'run_agent', response: { operation: 'read', scope: 'direct', childRef: `A${index + 1}`,
      rereadCursor, nextCursor: `next-${index}`, timelineSources: [{ text: '正文'.repeat(10_000) }] }
  })), { perResultTokens: 200, batchTokens: 1_000 });
  for (const [index, item] of batch.items.entries()) {
    assert.equal(item.truncated, true);
    assert.equal(item.response.operation, 'read');
    assert.equal(item.response.childRef, `A${index + 1}`);
    assert.equal(item.response.rereadCursor, rereadCursor);
    assert.equal(item.response.nextCursor, `next-${index}`);
  }
});

test('a fork lists inherited child refs as not operable and names the source when they are operated', async () => {
  await withForkedChildHistory(async h => {
    const [ownRequest] = h.requests.filter(request => request.conversationId === 'parent').slice(-1);
    assert.equal(ownRequest.recipe.runtimeStatusCard.totalChildCount, 1);
    assert.equal(ownRequest.recipe.runtimeStatusCard.inheritedChildTargets, undefined,
      'the source still owns and operates its child');
    const [child] = await h.rows('ChildExecution');
    const [bridge] = await h.rows('AnswerBridge', { child_execution_id: child.id });

    const fork = await h.forkParent();
    await h.app.database.conversationOwners.retain(fork, 'fixture-fork-panel');
    const result = await h.app.agentLoop.runInput(h.input(fork, 'operate-inherited-child'));
    assert.equal(result.terminalStatus, 'completed');
    const [first] = h.requests.filter(request => request.conversationId === fork);
    const card = first.recipe.runtimeStatusCard;
    assert.ok(card, 'a fork with only inherited child refs still receives a status card');
    assert.equal(card.totalChildCount, 0);
    assert.deepEqual(card.inheritedChildTargets, [bridge.id]);
    const ref = first.recipe.modelHandleCatalog.entries.find(entry => entry.kind === 'child' && entry.target === bridge.id).ref;
    assert.ok(card.card.split('\n').includes(JSON.stringify({ inheritedChildRefs: [ref], operable: false })), card.card);

    const [read] = (await h.rows('ToolCall', { tool_name: 'run_agent' }))
      .filter(call => call.turn_id === result.turnId);
    const [outcome] = await h.rows('ToolOutcome', { tool_call_id: read.id });
    assert.equal(outcome.status, 'failed');
    const [artifact] = await h.rows('ToolResultArtifact', { tool_call_id: read.id });
    const [metadata] = await h.rows('ContentObject', { id: artifact.content_object_id });
    const body = JSON.parse((await h.app.contentStore.read(metadata)).toString('utf8'));
    assert.match(JSON.stringify(body.detail), /属于分支来源对话/);
  });
});

async function withForkedChildHistory(run) {
  const kernel = require(path.join(root, 'backend/reliableKernel/index.js'));
  const { ReliableChildAgentCoordinator } = require(path.join(root, 'backend/reliableKernel/childAgentCoordinator.js'));
  const { readFrozenTurnAuthority } = require(path.join(root, 'backend/reliableKernel/frozenAuthority.js'));
  const { runAgentTool } = require(path.join(root, 'backend/world/modules/tools/definitions/runAgent/index.js'));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-fork-child-refs-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const requests = [];
  let app;
  let coordinator;
  const rows = async (domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where, orderBy: { column: 'id', direction: 'asc' }, limit: 100
  }))).snapshot;
  const reply = request => {
    const count = requests.filter(item => item.conversationId === request.conversationId).length;
    if (request.conversationId === 'parent' && count === 1) {
      return [{ id: 'spawn-child', functionCall: { name: 'run_agent', args: {
        operation: 'spawn', taskName: 'Investigate', prompt: 'synthetic child task'
      } } }];
    }
    const inherited = request.recipe.runtimeStatusCard?.inheritedChildTargets ?? [];
    if (inherited.length > 0 && count === 1) {
      const ref = request.recipe.modelHandleCatalog.entries.find(entry => entry.target === inherited[0]).ref;
      return [{ id: 'read-inherited', functionCall: { name: 'run_agent', args: { operation: 'read', childRef: ref } } }];
    }
    return [{ text: `done ${request.conversationId} ${count}` }];
  };
  try {
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: { async compile(request) {
        const model = { providerConfigId: 'fork-child-provider', provider: 'openai-compatible', modelId: 'fork-child-model' };
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: model.providerConfigId, modelId: model.modelId }) },
          authoritySnapshot: { content: JSON.stringify({
            kind: 'effective-turn-authority', turnId: request.turnId, conversationId: request.conversationId,
            executorAgentId: request.executorAgentId,
            model: { ...model, retryPolicy: { enabled: false, maxRetries: 0 } },
            modelProfile: { compressionThresholdTokens: 100_000, contextWindowTokens: 128_000,
              tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
            toolPolicy: { id: 'fork-child-tools', allowedTools: ['run_agent'], preset: 'custom',
              toolConfigs: { run_agent: { config: { maxChildAgentDepth: 2 } } }, sourceConfigs: {} },
            planReviewPolicy: { mode: 'off' },
            systemPrompt: { id: 'fork-child-prompt', text: '' },
            runtimeContext: { id: null, name: '', template: '' },
            workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
          }) }
        };
      } },
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { return null; } },
      mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
      attachmentSettings: { async loadGlobalSettings() {
        return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'settings/attachments.json' };
      } },
      providers: { resolve(providerId) { return { providerId, async sendFullRequest(request, controls) {
        requests.push(request);
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: reply(request) } });
      } }; } },
      toolDispatcher: {
        definitions() { return [{ ...runAgentTool.declaration }]; },
        async dispatch(input) {
          const [snapshot] = await rows('AuthoritySnapshot', { turn_id: input.turnId });
          const frozen = await readFrozenTurnAuthority(app.database, app.contentStore, snapshot.id, input.turnId);
          return coordinator.dispatch(input, undefined, { snapshotId: snapshot.id, document: frozen.document,
            toolConfig: { config: { maxChildAgentDepth: 2 } } });
        }
      }
    });
    coordinator = new ReliableChildAgentCoordinator({ database: app.database, ...app.runtime,
      modelProvider: app.modelProvider, turns: app.turns, agentLoop: app.agentLoop,
      agents: { async resolve() { return { agentId: 'agent-worker', agentType: 'worker' }; } },
      modelProfiles: { async initializeConversation() { return { created: true }; } }
    });
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'parent', title: 'Fork child refs', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'parent-agent', conversation_id: 'parent', agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now })
    ]);
    const input = (conversationId, key) => ({ source: { kind: 'command', key }, conversationId,
      leaseOwnerId: 'fork-child-owner', hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), content: key });
    await app.database.conversationOwners.retain('parent', 'fixture-parent-panel');
    assert.equal((await app.agentLoop.runInput(input('parent', 'delegate'))).terminalStatus, 'completed');
    await coordinator.waitForIdle();
    assert.equal((await app.agentLoop.runInput(input('parent', 'after-child'))).terminalStatus, 'completed');
    const forkParent = async () => {
      const [head] = await rows('ConversationContextHeadLink', { conversation_id: 'parent' });
      const structure = await app.context.materializeStructure(head.root_id);
      const [request] = (await rows('ModelRequest')).filter(item => item.id === requests.at(-1).modelRequestId);
      const [output] = await rows('ModelRequestMessageLink', { model_request_id: request.id });
      const [current] = await rows('MessageCurrentRevisionLink', { message_id: output.message_id });
      const forked = await app.runtime.conversationFork.fork({
        idempotencyKey: 'fork-child-refs', reuseKey: 'fork-child-refs',
        sourceConversationId: 'parent', sourceContextRootId: head.root_id,
        sourceContextEndSegmentId: structure.records.at(-1).segment.id,
        sourceMessageRevisionId: current.revision_id, expectedCurrentMessageRevisionId: current.revision_id,
        targetTitle: 'Fork child refs branch', targetAgentId: 'agent-main'
      });
      return forked.targetConversationId;
    };
    await run({ get app() { return app; }, requests, rows, input, forkParent });
  } finally {
    if (coordinator) await coordinator.dispose();
    if (app) await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}
