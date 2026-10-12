import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';

import fs from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

import test from 'node:test';

import { pathToFileURL } from 'node:url';

const root = process.cwd();

const compiledRoot = process.env.LIMCODE_COMPILED_ROOT
  ? path.resolve(root, process.env.LIMCODE_COMPILED_ROOT)
  : path.join(root, 'dist/extension');

const kernel = await import(pathToFileURL(path.join(compiledRoot, 'backend/reliableKernel/index.js')).href);

const { emptyConversationContextHandleStateStep } = await import(pathToFileURL(path.join(compiledRoot, 'backend/reliableKernel/conversationContextHandleState.js')).href);

const capabilitiesModule = await import(pathToFileURL(path.join(compiledRoot, 'shared/modelCapabilities.js')).href);

const PROVIDER_ID = 'provider-reduction-gate';

const MODEL_ID = 'model-reduction-gate';

function dependencies(thresholdTokens, options = {}) {
  const capabilities = capabilitiesModule.resolveModelCapabilities({
    provider: 'openai-compatible', baseUrl: 'https://reduction.invalid/v1', modelId: MODEL_ID,
    providerConfigId: PROVIDER_ID, transport: 'http'
  });
  const executionPlan = capabilitiesModule.resolveCompressionExecutionPlan({ kind: 'llm_summary', fallbacks: options.fallbacks ?? [] }, capabilities);
  const summaryReasoning = capabilitiesModule.resolveSummaryReasoning({ mode: 'provider_default', capabilities });
  const trigger = { mode: options.triggerMode ?? 'token_threshold', thresholdUnit: 'tokens', thresholdTokens };
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: PROVIDER_ID, modelId: MODEL_ID }) },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: { providerConfigId: PROVIDER_ID, provider: 'openai-compatible', modelId: MODEL_ID },
              modelProfile: {
                compressionThresholdTokens: thresholdTokens,
                contextWindowTokens: 200_000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              compression: {
                enabled: options.disabled !== true,
                methodKind: 'llm_summary',
                executionPlan,
                thresholdTokens,
                config: { id: 'compression-reduction-gate', name: 'reduction gate', kind: 'llm_summary', trigger },
                provider: {
                  providerConfigId: PROVIDER_ID, provider: 'openai-compatible', modelId: MODEL_ID,
                  capabilities, summaryReasoning, contextWindowTokens: 200_000, maxOutputTokens: 16_000
                }
              },
              toolPolicy: { id: 'tools-default', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
              systemPrompt: { id: 'prompt-default', text: '' },
              runtimeContext: { id: null, name: '', template: '' },
              workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
            })
          }
        };
      }
    },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { return null; } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: {
      async loadGlobalSettings() {
        return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'settings/attachments.json' };
      }
    },
    providers: {
      resolve(providerId) {
        return { providerId, async sendFullRequest() { throw new Error('fixture provider must be supplied explicitly'); } };
      }
    },
    toolDispatcher: { definitions() { return []; }, async dispatch() { throw new Error('fixture has no tools'); } }
  };
}

async function withTurn(name, thresholdTokens, run, options = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const app = await kernel.ReliableKernelApplication.open(authority, dependencies(thresholdTokens, options));
  try {
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: name, title: name, status: 'active', created_at: now, updated_at: now
      }),
      emptyConversationContextHandleStateStep(name, now),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: `${name}-agent-link`, conversation_id: name, agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now
      })
    ]);
    const started = await app.turns.input({
      source: { kind: 'command', key: `${name}-input` },
      conversationId: name,
      leaseOwnerId: `${name}-owner`,
      hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      content: 'start'
    });
    const authoritySnapshot = (await list(app, 'AuthoritySnapshot', { turn_id: started.turnId }))[0];
    await run(app, { conversationId: name, turnId: started.turnId, authoritySnapshotId: authoritySnapshot.id });
  } finally {
    await app.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function list(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where, orderBy: { column: 'id', direction: 'asc' }, limit: 100
  }))).snapshot;
}

async function appendMessage(app, seeded, suffix, role, text) {
  const contentObject = await app.contentStore.ingest(app.database, text, 'text/plain');
  const messageId = `message-${suffix}`;
  const revisionId = `message-revision-${suffix}`;
  const now = new Date().toISOString();
  const plan = await app.context.prepareMessageAppendMutation({
    conversationId: seeded.conversationId,
    messageRevisionId: revisionId,
    contentObjectId: contentObject.id,
    contentByteLength: contentObject.byte_length
  });
  await app.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Message').insert({ id: messageId, created_at: now, updated_at: now, deleted_at: null }),
    kernel.DOMAIN_REPOSITORIES.domain('MessageRevision').insertWithNextSequence({
      id: revisionId, message_id: messageId, role, content_object_id: contentObject.id, created_at: now
    }, { column: 'revision_seq', scope: { message_id: messageId } }),
    kernel.DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
      id: `current-revision-${suffix}`, message_id: messageId, revision_id: revisionId, updated_at: now
    }),
    kernel.DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insertWithNextSequence({
      id: `membership-${suffix}`, conversation_id: seeded.conversationId, message_id: messageId, created_at: now
    }, { column: 'message_seq', scope: { conversation_id: seeded.conversationId } }),
    kernel.DOMAIN_REPOSITORIES.domain('MessageTurnLink').insert({
      id: `message-turn-${suffix}`, turn_id: seeded.turnId, message_id: messageId, role: 'context-fixture', created_at: now
    }),
    ...plan.steps
  ]);
}

function summaryCoordinator(app, summaryText, onDispatch) {
  return new kernel.ReliableContextCompressionCoordinator(app.database, app.contentStore, app.modelProvider, {
    resolve(providerId) {
      return {
        providerId,
        async sendFullRequest(_request, controls) {
          onDispatch();
          await controls.onEvent({
            kind: 'completed', streamSeq: '1',
            content: { type: 'compression_result', contents: Array.isArray(summaryText) ? summaryText : [{ role: 'model', parts: [{ text: summaryText }] }] }
          });
        }
      };
    }
  });
}

function requestBudget(thresholdTokens, fixedTokens, contextTokens) {
  return kernel.calculateFullRequestPlanningBudget({
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_000,
    compressionThresholdTokens: thresholdTokens,
    breakdown: {
      systemTokens: 0, toolSchemaTokens: fixedTokens, providerFramingTokens: 0,
      contextTokens, currentInputTokens: 0, runtimeDeliveryTokens: 0, turnReminderTokens: 0, mediaTokens: 0,
      fixedTokens, bodyTokens: contextTokens, fullTokens: fixedTokens + contextTokens
    }
  });
}

async function compressionMetadata(app, conversationId) {
  const [block] = await list(app, 'CompressionBlock', { conversation_id: conversationId });
  const [object] = await list(app, 'ContentObject', { id: block.summary_object_id });
  return JSON.parse((await app.contentStore.read(object)).toString('utf8'));
}

async function rejectOrdinaryContextRequest(app, seeded, code = 'CONTEXT_WINDOW_EXCEEDED') {
  const headRootId = await app.context.currentHeadRootId(seeded.conversationId);
  const settingsSnapshotContentObjectId = await app.modelProvider.freezeRequestSettings(seeded.turnId, seeded.authoritySnapshotId);
  const recipe = await app.agentLoop.freezeOrdinaryRequestRecipe({ turnId: seeded.turnId,
    authoritySnapshotId: seeded.authoritySnapshotId, headRootId, round: '1', tools: [], includeOpenTaskCompletionCheck: false });
  const created = await app.modelProvider.createModelRequest({ turnId: seeded.turnId,
    authoritySnapshotId: seeded.authoritySnapshotId, settingsSnapshotContentObjectId, contextRootId: headRootId,
    recipe, idempotencyKey: 'context-overflow-source' });
  await assert.rejects(app.modelProvider.dispatch(created.modelRequestId, { providerId: PROVIDER_ID,
    async sendFullRequest() { throw Object.assign(new Error('The input exceeds the model context window'), { code }); }
  }), /context window/);
  return { failedModelRequestId: created.modelRequestId, headRootId };
}

function registerCases(test) {

test('a summary that does not shrink the Context is still skipped as non_reducing and replays without a second call', async () => {
  const thresholdTokens = 1;
  await withTurn('reduction-gate-non-reducing', thresholdTokens, async (app, seeded) => {
    await appendMessage(app, seeded, 'source', 'assistant', 'small-source');
    await appendMessage(app, seeded, 'tail', 'user', 'protected-tail');
    const head = await app.context.currentHeadRootId(seeded.conversationId);
    let dispatches = 0;
    const coordinator = summaryCoordinator(app, `NON-REDUCING-${'x'.repeat(4096)}`, () => { dispatches += 1; });
    const command = {
      turnId: seeded.turnId,
      authoritySnapshotId: seeded.authoritySnapshotId,
      headRootId: head,
      trigger: 'auto',
      requestBudget: requestBudget(thresholdTokens, 0, 2_000)
    };
    const first = await coordinator.coordinate(command);
    assert.equal(first.status, 'skipped');
    assert.equal(first.reason, 'non_reducing');
    const replay = await coordinator.coordinate(command);
    assert.equal(replay.reason, 'non_reducing');
    assert.equal(dispatches, 1);
    assert.equal(await app.context.currentHeadRootId(seeded.conversationId), head);
    assert.equal((await list(app, 'CompressionBlock', { conversation_id: seeded.conversationId })).length, 0);
  });
});
test('real provider overflow forces below-threshold compression, proves reduction and replays the committed repair after a crash', async () => {
  await withTurn('provider-overflow-reduction', 100_000, async (app, seeded) => {
    await appendMessage(app, seeded, 'overflow-history', 'assistant', 'important history '.repeat(600));
    await appendMessage(app, seeded, 'overflow-tail', 'user', 'keep this latest question');
    const rejected = await rejectOrdinaryContextRequest(app, seeded);
    const before = await app.compression.evaluate(rejected.headRootId, seeded.authoritySnapshotId);
    assert.equal(before.shouldCompress, false);
    let sends = 0;
    const coordinator = summaryCoordinator(app, 'Short faithful history summary', () => sends++);
    const command = { turnId: seeded.turnId, failedModelRequestId: rejected.failedModelRequestId };
    const compressed = await coordinator.recoverProviderContextOverflow(command);
    assert.equal(compressed.status, 'compressed', JSON.stringify(compressed));
    assert.equal(compressed.triggerReason, 'provider_context_overflow');
    assert.equal(compressed.providerContextOverflowRequestId, rejected.failedModelRequestId);
    assert.notEqual(compressed.result.rootId, rejected.headRootId);
    const metadata = await compressionMetadata(app, seeded.conversationId);
    assert.ok(metadata.estimatedTokensAfter < metadata.contextTokensBefore);
    assert.equal(metadata.triggerReason, 'provider_context_overflow');
    // A new coordinator sees a moved head and must find the exact prior request/block proof.
    const replay = await summaryCoordinator(app, 'Short faithful history summary', () => sends++)
      .recoverProviderContextOverflow(command);
    assert.equal(replay.result.rootId, compressed.result.rootId);
    assert.equal(replay.modelRequestId, compressed.modelRequestId);
    assert.equal(sends, 1);
    const requests = await list(app, 'ModelRequest', { turn_id: seeded.turnId });
    assert.equal(requests.length, 2, 'one rejected ordinary request and one immutable recovery compression');
    const repaired = await app.modelProvider.replay(compressed.modelRequestId);
    assert.equal(repaired.recipe.providerContextOverflowRequestId, rejected.failedModelRequestId);
    const original = requests.find(row => row.id === rejected.failedModelRequestId);
    assert.equal(original.terminal_state, 'provider_failed', 'repair never rewrites the rejected request');
    await appendMessage(app, seeded, 'foreign-after-repair', 'user', 'unrelated later input');
    const foreignHead = await app.context.currentHeadRootId(seeded.conversationId);
    await assert.rejects(coordinator.recoverProviderContextOverflow(command), /without a committed repair/);
    assert.equal(sends, 1, 'a committed block does not authorize a new repair at an unrelated head');
    assert.equal(await app.context.currentHeadRootId(seeded.conversationId), foreignHead);
  });
});
}

export { registerCases };
