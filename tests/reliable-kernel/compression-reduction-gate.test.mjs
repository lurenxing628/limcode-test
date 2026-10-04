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

test('shared Context append and compression root identities preserve the published hash formulas', () => {
  const priorId = (domain, kind, parts) => `${kind}_${createHash('sha256')
    .update(`limcode-reliable-kernel-${domain}\0`).update(kind).update('\0').update(parts.join('\0')).digest('hex')}`;
  for (const base of [null, 'source-root']) {
    assert.equal(kernel.contextAppendRootId('conversation', base, 'node'),
      priorId('context', 'context_root_append', ['conversation', base ?? '<null>', 'node']));
  }
  assert.equal(kernel.compressionRootIdFor('block', 'source-root'),
    priorId('compression', 'compression_root', ['block', 'source-root']));
});

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

test('a ciphertext compaction without an output count has an unknown size, so a text summary replacing it is not judged non-reducing', async () => {
  const thresholdTokens = 1;
  await withTurn('reduction-gate-unsized-ciphertext', thresholdTokens, async (app, seeded) => {
    await appendMessage(app, seeded, 'paid', 'assistant', `paid-history ${'alpha beta gamma delta '.repeat(200)}`);
    // A gateway that returned no usage: the OpenAI compaction item is stored without its output count.
    await app.compression.create({
      conversationId: seeded.conversationId,
      headRootId: await app.context.currentHeadRootId(seeded.conversationId),
      authoritySnapshotId: seeded.authoritySnapshotId,
      // The Turn's own input and the paid history.
      compressSegmentCount: 2,
      title: '原生压缩',
      idempotencyKey: 'unsized-native-compaction',
      summary: [{ role: 'model', parts: [{ providerContext: {
        format: 'openai-responses', itemType: 'compaction',
        rawItem: { type: 'compaction', id: 'cmp_unsized', encrypted_content: 'gAAAA-ciphertext' }
      } }] }],
      summaryMetadata: {
        trigger: 'auto', methodKind: 'provider_native',
        contextTokensBefore: 900, estimatedTokensAfter: 30, estimatedTokens: 0
      }
    });
    await appendMessage(app, seeded, 'source', 'assistant', 'small-source');
    await appendMessage(app, seeded, 'tail', 'user', 'protected-tail');
    const head = await app.context.currentHeadRootId(seeded.conversationId);
    let dispatches = 0;
    const result = await summaryCoordinator(app, `REPLACEMENT-${'x'.repeat(4096)}`, () => { dispatches += 1; }).coordinate({
      turnId: seeded.turnId,
      authoritySnapshotId: seeded.authoritySnapshotId,
      headRootId: head,
      trigger: 'auto',
      requestBudget: requestBudget(thresholdTokens, 0, 2_000)
    });
    assert.equal(dispatches, 1);
    // Before: the ciphertext measured 0 tokens, every text summary looked larger, and the paid summary
    // was thrown away as non_reducing on every attempt.
    assert.equal(result.status, 'compressed', JSON.stringify(result));
    const blocks = await list(app, 'CompressionBlock', { conversation_id: seeded.conversationId });
    const presentations = new Map();
    const reader = new kernel.ClientDetailReader(app.database, app.contentStore);
    for (const block of blocks) {
      const [object] = await list(app, 'ContentObject', { id: block.summary_object_id });
      const stored = JSON.parse((await app.contentStore.read(object)).toString('utf8'));
      const detail = await reader.read({ kind: 'compression-presentation', recordId: block.id, offset: 0, maxBytes: 64 * 1024 });
      presentations.set(stored.methodKind, { stored, presentation: JSON.parse(Buffer.from(detail.chunk, 'base64').toString('utf8')) });
    }
    const text = presentations.get('llm_summary');
    assert.equal(text.stored.contextTokensBefore, undefined, 'an unknown Context size is not recorded as a before figure');
    assert.equal(text.presentation.resultSizeUncounted, undefined);
    // The card shows no saving for the ciphertext block: its after-figure counted the ciphertext as 0.
    assert.equal(presentations.get('provider_native').presentation.resultSizeUncounted, true);
  });
});

test('committed prefix compression keeps historical process references stable in the next ordinary recipe', async () => {
  await withTurn('process-ref-compression', 100000, async (app, seeded) => {
    for (const suffix of ['build', 'tests']) {
      const processId = `process-${suffix}`;
      const processReceiptId = `receipt-${suffix}`;
      const delivery = kernel.projectRuntimeDeliveryForModel({
        kind: 'process_completion', phase: 'current_turn', processId, processReceiptId,
        deliveryId: `delivery-${suffix}`, inboxItemId: `inbox-${suffix}`,
        targetTurnId: seeded.turnId, deliveredAt: new Date().toISOString(),
        content: { kind: 'process_completion', processId, processReceiptId, status: 'exited', stdout: `${suffix} output`,
          nextOutputHandle: `rk-process-output:${suffix}` }
      });
      await app.context.appendContent({ conversationId: seeded.conversationId, segmentKind: 'runtime_context',
        source: { sourceKind: 'runtime_context', sourceId: `process-proof-${suffix}`, sourceRevision: '0' },
        content: delivery.content, contentType: delivery.contentType });
    }
    const headRootId = await app.context.currentHeadRootId(seeded.conversationId);
    const freeze = (head, round) => app.agentLoop.freezeOrdinaryRequestRecipe({
      turnId: seeded.turnId, authoritySnapshotId: seeded.authoritySnapshotId,
      headRootId: head, round, tools: [], includeOpenTaskCompletionCheck: false
    });
    const before = await freeze(headRootId, '1');
    const consumed = await app.modelProvider.createModelRequest({ turnId: seeded.turnId,
      authoritySnapshotId: seeded.authoritySnapshotId, contextRootId: headRootId,
      recipe: before, idempotencyKey: 'consume-process-references' });
    const answer = { role: 'model', parts: [{ text: 'Both process results are available.' }] };
    await app.modelProvider.dispatch(consumed.modelRequestId, { providerId: PROVIDER_ID,
      async sendFullRequest(_request, controls) {
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content: answer });
      }
    });
    await new kernel.TurnOutputControlPlane(app.database, app.contentStore).appendAssistantMessage({
      turnId: seeded.turnId, modelRequestId: consumed.modelRequestId,
      sourceKey: 'consume-process-references', content: JSON.stringify(answer) });
    // The bindings were consumed and admitted even though this output does not echo P1/P2.
    // Compress that original input prefix and retain the admitted output as the active tail.
    const consumedHead = await app.context.currentHeadRootId(seeded.conversationId);
    const coordinator = summaryCoordinator(app, 'Build task output is available via P1 and O1.', () => {});
    const compressed = await coordinator.coordinate({ ...seeded, headRootId: consumedHead, trigger: 'manual',
      compressSegmentCount: 3, modelHandleCatalog: before.modelHandleCatalog });
    assert.equal(compressed.status, 'compressed');
    const nextHead = await app.context.currentHeadRootId(seeded.conversationId);
    const after = await freeze(nextHead, '2');
    const args = { mode: 'output', processRef: 'P1', cursor: 'O1' };
    assert.deepEqual(kernel.resolveModelToolArguments('bash', args, after.modelHandleCatalog),
      kernel.resolveModelToolArguments('bash', args, before.modelHandleCatalog));
    assert.equal(kernel.resolveModelToolArguments('bash', { mode: 'output', processRef: 'P2' },
      after.modelHandleCatalog).processId, 'process-tests');
    const stored = await app.context.materialize(nextHead);
    assert.equal(stored.segments[0].segmentKind, 'compression');
    assert.match(stored.segments[0].content.toString(), /P1 and O1/);
    assert.equal(stored.segments.length, 2, 'the first canonical process source really left the active window');
  });
});

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

test('provider overflow never resends a non-reducing result or bypasses manual-only compression', async () => {
  for (const triggerMode of ['token_threshold', 'manual', 'disabled']) {
    await withTurn(`provider-overflow-no-progress-${triggerMode}`, 100_000, async (app, seeded) => {
      await appendMessage(app, seeded, `no-progress-source-${triggerMode}`, 'assistant', 'small source');
      await appendMessage(app, seeded, `no-progress-tail-${triggerMode}`, 'user', 'latest question');
      const rejected = await rejectOrdinaryContextRequest(app, seeded);
      let sends = 0;
      const coordinator = summaryCoordinator(app, 'not smaller '.repeat(1000), () => sends++);
      const command = { turnId: seeded.turnId, failedModelRequestId: rejected.failedModelRequestId };
      const first = await coordinator.recoverProviderContextOverflow(command);
      assert.equal(first.status, 'skipped');
      assert.equal(first.reason, triggerMode === 'disabled' ? 'disabled' : triggerMode === 'manual' ? 'manual_only' : 'non_reducing');
      const replay = await coordinator.recoverProviderContextOverflow(command);
      assert.equal(replay.reason, first.reason);
      assert.equal(sends, triggerMode === 'token_threshold' ? 1 : 0);
      assert.equal(await app.context.currentHeadRootId(seeded.conversationId), rejected.headRootId);
      assert.equal((await list(app, 'CompressionBlock')).length, 0);
    }, { triggerMode: triggerMode === 'disabled' ? 'token_threshold' : triggerMode, disabled: triggerMode === 'disabled' });
  }
});

test('a real provider overflow cannot use the continue-uncompressed-if-fits estimator fallback', async () => {
  await withTurn('provider-overflow-no-unchanged-fallback', 100_000, async (app, seeded) => {
    await appendMessage(app, seeded, 'no-unchanged-source', 'assistant', 'history '.repeat(700));
    await appendMessage(app, seeded, 'no-unchanged-tail', 'user', 'latest question');
    const rejected = await rejectOrdinaryContextRequest(app, seeded);
    let sends = 0;
    const coordinator = new kernel.ReliableContextCompressionCoordinator(app.database, app.contentStore, app.modelProvider, {
      resolve(providerId) { return { providerId, async sendFullRequest() {
        sends++;
        throw new kernel.ProviderCapabilityError('unsupported_parameter', 'Summary unavailable', 400, 'llm_summary');
      } }; }
    });
    const command = { turnId: seeded.turnId, failedModelRequestId: rejected.failedModelRequestId };
    await assert.rejects(coordinator.recoverProviderContextOverflow(command), /后备链已耗尽/);
    await assert.rejects(coordinator.recoverProviderContextOverflow(command), /后备链已耗尽/);
    assert.equal(sends, 1);
    assert.equal(await app.context.currentHeadRootId(seeded.conversationId), rejected.headRootId);
  }, { fallbacks: ['continue_uncompressed_if_fits'] });
});

test('provider overflow repair refuses unrelated failures and unrelated changed heads', async () => {
  await withTurn('provider-overflow-invalid-proof', 100_000, async (app, seeded) => {
    const rejected = await rejectOrdinaryContextRequest(app, seeded, 'AUTHENTICATION_ERROR');
    const coordinator = summaryCoordinator(app, 'unused', () => assert.fail('must not dispatch'));
    await assert.rejects(coordinator.recoverProviderContextOverflow({ turnId: seeded.turnId,
      failedModelRequestId: rejected.failedModelRequestId }), /exact persisted context-window rejection/);
  });
  await withTurn('provider-overflow-changed-head', 100_000, async (app, seeded) => {
    const rejected = await rejectOrdinaryContextRequest(app, seeded);
    const coordinator = summaryCoordinator(app, 'unused', () => assert.fail('must not dispatch'));
    for (const changed of [{ headRootId: 'unrelated-root' }, { authoritySnapshotId: 'unrelated-authority' },
      { settingsSnapshotContentObjectId: 'unrelated-settings' }]) {
      await assert.rejects(coordinator.coordinate({ turnId: seeded.turnId, authoritySnapshotId: seeded.authoritySnapshotId,
        headRootId: rejected.headRootId, trigger: 'auto', providerContextOverflowRequestId: rejected.failedModelRequestId,
        ...changed }), /differs from the rejected immutable request/);
    }
    await appendMessage(app, seeded, 'unrelated-head', 'assistant', 'unrelated append');
    await assert.rejects(coordinator.recoverProviderContextOverflow({ turnId: seeded.turnId,
      failedModelRequestId: rejected.failedModelRequestId }), /without a committed repair/);
  });
});

test('provider overflow cannot claim reduction from an opaque compaction result without a measured size', async () => {
  await withTurn('provider-overflow-unsized-result', 100_000, async (app, seeded) => {
    await appendMessage(app, seeded, 'opaque-result-source', 'assistant', 'history '.repeat(700));
    await appendMessage(app, seeded, 'opaque-result-tail', 'user', 'latest question');
    const rejected = await rejectOrdinaryContextRequest(app, seeded);
    const coordinator = summaryCoordinator(app, [{ role: 'model', parts: [{ providerContext: {
      format: 'openai-responses', itemType: 'compaction',
      rawItem: { type: 'compaction', id: 'cmp_unmeasured', encrypted_content: 'opaque-unknown-size' }
    } }] }], () => {});
    const result = await coordinator.recoverProviderContextOverflow({ turnId: seeded.turnId,
      failedModelRequestId: rejected.failedModelRequestId });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'non_reducing');
    assert.equal(await app.context.currentHeadRootId(seeded.conversationId), rejected.headRootId);
  });
});

test('restored transient connection interruption still advances the configured compression fallback', async () => {
  await withTurn('compression-restored-transient', 1, async (app, seeded) => {
    await appendMessage(app, seeded, 'transient-source', 'assistant', 'history '.repeat(1000));
    await appendMessage(app, seeded, 'transient-tail', 'user', 'latest');
    const headRootId = await app.context.currentHeadRootId(seeded.conversationId);
    const level = await app.compression.evaluate(headRootId, seeded.authoritySnapshotId);
    const sent = [];
    const coordinator = new kernel.ReliableContextCompressionCoordinator(app.database, app.contentStore, app.modelProvider, {
      resolve(providerId) { return { providerId, async sendFullRequest(request, controls) {
        sent.push(request.recipe.compressionMethodKind);
        if (request.recipe.compressionMethodKind === 'llm_summary') {
          throw new kernel.ProviderTransientError('connection_interrupted', 'Connection interrupted before response', false, { maxRetries: 0 });
        }
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { type: 'compression_result',
          contents: [{ role: 'model', parts: [{ text: 'Fallback summary' }] }] } });
      } }; }
    });
    const command = { turnId: seeded.turnId, authoritySnapshotId: seeded.authoritySnapshotId, headRootId,
      trigger: 'auto', requestBudget: requestBudget(1, 0, level.estimatedTokens) };
    const first = await coordinator.coordinate(command);
    assert.equal(first.status, 'compressed');
    assert.deepEqual(sent, ['llm_summary', 'deterministic_summary']);
    const replay = await coordinator.coordinate(command);
    assert.equal(replay.status, 'compressed');
    assert.equal(replay.result.rootId, first.result.rootId);
    assert.deepEqual(sent, ['llm_summary', 'deterministic_summary'], 'restored interrupted metadata must not block the fallback or resend');
  }, { fallbacks: ['deterministic_summary'] });
});
