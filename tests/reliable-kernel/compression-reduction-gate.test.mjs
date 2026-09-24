import assert from 'node:assert/strict';
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
const capabilitiesModule = await import(pathToFileURL(path.join(compiledRoot, 'shared/modelCapabilities.js')).href);

const PROVIDER_ID = 'provider-reduction-gate';
const MODEL_ID = 'model-reduction-gate';

function dependencies(thresholdTokens) {
  const capabilities = capabilitiesModule.resolveModelCapabilities({
    provider: 'openai-compatible', baseUrl: 'https://reduction.invalid/v1', modelId: MODEL_ID,
    providerConfigId: PROVIDER_ID, transport: 'http'
  });
  const executionPlan = capabilitiesModule.resolveCompressionExecutionPlan({ kind: 'llm_summary', fallbacks: [] }, capabilities);
  const summaryReasoning = capabilitiesModule.resolveSummaryReasoning({ mode: 'provider_default', capabilities });
  const trigger = { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens };
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
                enabled: true,
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

async function withTurn(name, thresholdTokens, run) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const app = await kernel.ReliableKernelApplication.open(authority, dependencies(thresholdTokens));
  try {
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: name, title: name, status: 'active', created_at: now, updated_at: now
      }),
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
            content: { type: 'compression_result', contents: [{ role: 'model', parts: [{ text: summaryText }] }] }
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

test('small threshold dominated by fixed overhead still compresses a Context that shrinks', async () => {
  const thresholdTokens = 1_000;
  const fixedTokens = thresholdTokens - 10;
  await withTurn('reduction-gate-fixed-dominated', thresholdTokens, async (app, seeded) => {
    await appendMessage(app, seeded, 'source', 'assistant', `source ${'alpha beta gamma delta '.repeat(110)}`);
    await appendMessage(app, seeded, 'tail', 'user', `tail ${'epsilon zeta eta theta '.repeat(110)}`);
    const head = await app.context.currentHeadRootId(seeded.conversationId);
    const level = await app.compression.evaluate(head, seeded.authoritySnapshotId);
    // No Provider anchor: the level trigger measures the Context alone.
    assert.equal(level.source, 'semantic');
    assert.equal(level.shouldCompress, true);
    // The mixed-unit bug needed fixed + retained tail >= Context; keep the fixture inside that band.
    assert.ok(level.estimatedTokens <= fixedTokens + 400, `fixture Context ${level.estimatedTokens} is too large`);

    let dispatches = 0;
    const result = await summaryCoordinator(app, 'FIXED-DOMINATED-SUMMARY', () => { dispatches += 1; }).coordinate({
      turnId: seeded.turnId,
      authoritySnapshotId: seeded.authoritySnapshotId,
      headRootId: head,
      trigger: 'auto',
      requestBudget: requestBudget(thresholdTokens, fixedTokens, level.estimatedTokens)
    });
    assert.equal(result.status, 'compressed', JSON.stringify(result));
    assert.equal(dispatches, 1);
    const after = await app.compression.evaluate(await app.context.currentHeadRootId(seeded.conversationId), seeded.authoritySnapshotId);
    assert.ok(after.estimatedTokens < level.estimatedTokens);
  });
});

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

async function compressionMetadata(app, conversationId) {
  const [block] = await list(app, 'CompressionBlock', { conversation_id: conversationId });
  const [object] = await list(app, 'ContentObject', { id: block.summary_object_id });
  return JSON.parse((await app.contentStore.read(object)).toString('utf8'));
}

test('the card saving compares Context with Context; manual compression records no full-request size', async () => {
  const thresholdTokens = 1_000;
  await withTurn('reduction-gate-metadata', thresholdTokens, async (app, seeded) => {
    await appendMessage(app, seeded, 'source', 'assistant', `source ${'alpha beta gamma delta '.repeat(110)}`);
    await appendMessage(app, seeded, 'tail', 'user', `tail ${'epsilon zeta eta theta '.repeat(110)}`);
    const head = await app.context.currentHeadRootId(seeded.conversationId);
    const result = await summaryCoordinator(app, 'MANUAL-SUMMARY', () => {}).coordinate({
      turnId: seeded.turnId,
      authoritySnapshotId: seeded.authoritySnapshotId,
      headRootId: head,
      trigger: 'manual'
    });
    assert.equal(result.status, 'compressed', JSON.stringify(result));
    const metadata = await compressionMetadata(app, seeded.conversationId);
    assert.equal(metadata.trigger, 'manual');
    // Previously 0 with an all-zero breakdown, which the card showed as “节省约 0 Token”.
    assert.equal(metadata.estimatedTokensBefore, undefined);
    assert.equal(metadata.requestBreakdown, undefined);
    assert.equal(metadata.calibratedTokensBefore, undefined);
    assert.ok(Number.isSafeInteger(metadata.contextTokensBefore) && Number.isSafeInteger(metadata.estimatedTokensAfter));
    assert.ok(metadata.contextTokensBefore > metadata.estimatedTokensAfter, JSON.stringify(metadata));
  });
  await withTurn('reduction-gate-metadata-auto', thresholdTokens, async (app, seeded) => {
    await appendMessage(app, seeded, 'source', 'assistant', `source ${'alpha beta gamma delta '.repeat(110)}`);
    await appendMessage(app, seeded, 'tail', 'user', `tail ${'epsilon zeta eta theta '.repeat(110)}`);
    const head = await app.context.currentHeadRootId(seeded.conversationId);
    const level = await app.compression.evaluate(head, seeded.authoritySnapshotId);
    const fixedTokens = 500;
    const result = await summaryCoordinator(app, 'AUTO-SUMMARY', () => {}).coordinate({
      turnId: seeded.turnId, authoritySnapshotId: seeded.authoritySnapshotId, headRootId: head, trigger: 'auto',
      requestBudget: requestBudget(thresholdTokens, fixedTokens, level.estimatedTokens)
    });
    assert.equal(result.status, 'compressed', JSON.stringify(result));
    const metadata = await compressionMetadata(app, seeded.conversationId);
    assert.equal(metadata.estimatedTokensBefore, fixedTokens + level.estimatedTokens, 'automatic keeps the full-request figure');
    assert.ok(metadata.requestBreakdown);
    // The saving excludes the fixed system/tool overhead that compression never removes.
    assert.ok(metadata.contextTokensBefore < metadata.estimatedTokensBefore);
    assert.ok(metadata.contextTokensBefore > metadata.estimatedTokensAfter);
  });
});

test('with a Provider calibration above 1 the frozen summary limit is converted into estimator tokens', async () => {
  const thresholdTokens = 20_000;
  await withTurn('reduction-gate-calibrated-summary', thresholdTokens, async (app, seeded) => {
    await appendMessage(app, seeded, 'source', 'assistant', `source ${'alpha beta gamma delta '.repeat(400)}`);
    await appendMessage(app, seeded, 'tail', 'user', `tail ${'epsilon zeta eta theta '.repeat(20)}`);
    const head = await app.context.currentHeadRootId(seeded.conversationId);
    const level = await app.compression.evaluate(head, seeded.authoritySnapshotId);
    const fixedTokens = 1_000;
    const budget = requestBudget(thresholdTokens, fixedTokens, level.estimatedTokens);
    const recipes = [];
    const coordinator = new kernel.ReliableContextCompressionCoordinator(app.database, app.contentStore, app.modelProvider, {
      resolve(providerId) {
        return {
          providerId,
          async sendFullRequest(request, controls) {
            recipes.push(request.recipe);
            await controls.onEvent({
              kind: 'completed', streamSeq: '1',
              content: { type: 'compression_result', contents: [{ role: 'model', parts: [{ text: 'CALIBRATED-SUMMARY' }] }] }
            });
          }
        };
      }
    });
    // The Provider counted twice what the local estimator measures for this request.
    const evaluate = coordinator.compression.evaluate.bind(coordinator.compression);
    coordinator.compression.evaluate = async (...args) => ({
      ...(await evaluate(...args)),
      shouldCompress: true,
      source: 'provider-observed-delta',
      estimatedTokens: budget.estimatedFullInputTokens * 2
    });
    const result = await coordinator.coordinate({
      turnId: seeded.turnId, authoritySnapshotId: seeded.authoritySnapshotId, headRootId: head, trigger: 'auto',
      requestBudget: budget
    });
    assert.equal(result.status, 'compressed', JSON.stringify(result));
    assert.equal(recipes.length, 1);
    // 8,000 Provider tokens are reserved for the summary; the summary is written and cut with the
    // local estimator, where the same room is 4,000 tokens at a ratio of 2.
    assert.equal(recipes[0].effectiveSummaryMaxTokens, 4_000);
  });
});
