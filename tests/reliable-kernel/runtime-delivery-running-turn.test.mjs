import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiled, 'backend/reliableKernel/index.js'));
const { preparedContentObjectSteps } = require(path.join(compiled, 'backend/reliableKernel/contentObjectTransaction.js'));
const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);

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
    /** The durable facts of one finished background Process started by `sourceTurnId`. */
    const processResult = async (id, sourceTurnId) => {
      const at = new Date().toISOString();
      const payload = await app.contentStore.prepare(app.database, JSON.stringify({ kind: 'process_completion',
        processId: id, processReceiptId: `receipt-${id}`, sourceTurnId, conversationId: CONVERSATION }),
      'application/vnd.limcode.process-completion+json');
      await app.database.transaction([
        ...preparedContentObjectSteps([payload], 'fixture_process_result'),
        repo('Process').insert({ id, status: 'exited', wrapper_nonce: `nonce-${id}`, wrapper_pid: 0n, child_pid: null,
          process_group_id: null, start_fingerprint: `fingerprint-${id}`, command_digest: `digest-${id}`,
          spool_locator: `spool/${id}`, retained_bytes: 0n, retained_chunks: 0n, dropped_bytes: 0n, truncated: 0n,
          started_at: at, updated_at: at, completed_at: at }),
        repo('ProcessCompletionSourceLink').insert({ id: `source-${id}`, process_id: id, conversation_id: CONVERSATION,
          source_turn_id: sourceTurnId, source_tool_call_id: `${id}-tool`, created_at: at }),
        repo('ProcessReceipt').insert({ id: `receipt-${id}`, process_id: id, outcome: 'succeeded', exit_code: 0n,
          exit_signal: null, wrapper_nonce: `nonce-${id}`, start_fingerprint: `fingerprint-${id}`, received_at: at }),
        repo('RuntimeInboxItem').insert({ id, dedupe_key: `fixture:${id}`, source_kind: 'process_receipt',
          source_id: `receipt-${id}`, state: 'available', created_at: at, updated_at: at }),
        repo('RuntimeInboxPayloadLink').insert({ id: `payload-${id}`, inbox_item_id: id,
          content_object_id: payload.metadata.id, created_at: at })
      ]);
      return id;
    };
    /** A completed no-tool-call ModelRequest of a running Turn, ready to be fenced as its final answer. */
    const finalRequest = async turn => {
      const at = new Date().toISOString();
      const id = `final-request-${turn.turnId}`;
      const recipe = await app.contentStore.prepare(app.database, '{}', 'application/json');
      const [authority] = await rows(app, 'AuthoritySnapshot', { turn_id: turn.turnId });
      await app.database.transaction([
        ...preparedContentObjectSteps([recipe], 'fixture_final_request'),
        repo('ModelRequest').insertHistoricalCopy({ id, turn_id: turn.turnId, request_seq: 1n, status: 'terminal',
          terminal_state: 'completed', provider_id: 'provider', model_id: 'model', context_window_tokens: 1000n,
          compression_threshold_tokens: 900n, estimated_context_tokens: 1n, authority_snapshot_id: authority.id,
          settings_snapshot_object_id: null, recipe_object_id: recipe.metadata.id, usage_json: null,
          stream_stats_json: { attemptSeq: '1', socketGeneration: '1', retryReason: null }, created_at: at, updated_at: at }),
        repo('Operation').insertHistoricalCopy({ id: `${id}-operation`, owner_kind: 'model_request', owner_id: id,
          operation_seq: 1n, tool_call_id: null, status: 'completed', created_at: at, updated_at: at }),
        repo('Attempt').insertHistoricalCopy({ id: `${id}-attempt`, operation_id: `${id}-operation`, attempt_seq: 1n,
          status: 'completed', created_at: at, updated_at: at, completed_at: at }),
        repo('ModelStreamFence').insertHistoricalCopy({ id: `${id}-stream-fence`, model_request_id: id, attempt_seq: 1n,
          socket_generation: 1n, terminal_stream_seq: 1n, outcome: 'completed', created_at: at })
      ]);
      return id;
    };
    /** Joins an existing Turn to a ChildExecution of this Conversation, as the child scheduler would. */
    const childLineage = async (childExecutionId, turnIds) => {
      const at = new Date().toISOString();
      await app.database.transaction([
        repo('ChildExecution').insert({ id: childExecutionId, child_conversation_id: CONVERSATION, status: 'idle',
          created_at: at, updated_at: at }),
        ...turnIds.map((turnId, index) => repo('ChildExecutionTurnLink').insert({ id: `${childExecutionId}-${index}`,
          child_execution_id: childExecutionId, turn_id: turnId, turn_seq: BigInt(index + 1), created_at: at }))
      ]);
    };
    /** A background child of `parentTurnId` whose finished Turn submitted the bridge's current answer. */
    const childAnswer = async (id, parentTurnId) => {
      const at = new Date().toISOString();
      const payload = await app.contentStore.prepare(app.database, `ANSWER_${id}`, 'text/plain');
      await app.database.transaction([
        ...preparedContentObjectSteps([payload], 'fixture_child_answer'),
        repo('Conversation').insert({ id: `${id}-conversation`, title: id, status: 'active', created_at: at, updated_at: at }),
        repo('ChildExecution').insert({ id: `${id}-child`, child_conversation_id: `${id}-conversation`, status: 'idle',
          created_at: at, updated_at: at }),
        repo('ChildExecutionParentLink').insert({ id: `${id}-parent`, child_execution_id: `${id}-child`,
          source_tool_call_id: `${id}-spawn`, parent_child_execution_id: null, parent_turn_id: parentTurnId, created_at: at }),
        repo('Turn').insert({ id: `${id}-turn`, conversation_id: `${id}-conversation`, status: 'terminated',
          created_at: at, updated_at: at, terminal_at: at }),
        repo('TurnTermination').insert({ id: `${id}-termination`, turn_id: `${id}-turn`, terminal_status: 'completed',
          reason: 'fixture', created_at: at }),
        repo('ChildExecutionTurnLink').insert({ id: `${id}-lineage`, child_execution_id: `${id}-child`, turn_id: `${id}-turn`,
          turn_seq: 1n, created_at: at }),
        repo('AnswerBridge').insert({ id: `${id}-bridge`, child_execution_id: `${id}-child`,
          current_submission_id: `${id}-submission`, status: 'submitted', created_at: at, updated_at: at }),
        repo('AnswerSubmission').insert({ id: `${id}-submission`, answer_bridge_id: `${id}-bridge`, submission_seq: 1n,
          turn_id: `${id}-turn`, interrupted: 0n, created_at: at }),
        repo('RuntimeInboxItem').insert({ id: `${id}-inbox`, dedupe_key: `fixture:${id}`, source_kind: 'answer_submission',
          source_id: `${id}-submission`, state: 'available', created_at: at, updated_at: at }),
        repo('RuntimeInboxPayloadLink').insert({ id: `${id}-payload`, inbox_item_id: `${id}-inbox`,
          content_object_id: payload.metadata.id, created_at: at })
      ]);
      return { inboxItemId: `${id}-inbox`, bridgeId: `${id}-bridge` };
    };
    /** Production-shaped wake consumer: notifications are acknowledged, other actions only recorded. */
    const wakes = [];
    app.processDeliveries.setWakeHandler(async request => {
      wakes.push(request);
      if (request.action === 'notify_only') await app.runtime.deliveries.acknowledgeNotification(request.deliveryId);
      return { acknowledged: true };
    });
    const router = new kernel.AutomaticRuntimeDeliveryRouter(app.database, app.contentStore);
    await verify({ app, router, startTurn, endTurn, inbox, processResult, finalRequest, childLineage, childAnswer, wakes,
      rows: (domain, where) => rows(app, domain, where) });
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

test('an answer for a stopped parent Turn that a newer child generation superseded settles instead of retrying forever', { timeout: 30000 }, async () => {
  await withKernel(async ({ app, startTurn, endTurn, childAnswer, wakes, rows }) => {
    const parent = await startTurn('stopped-parent');
    await endTurn(parent, 'interrupted');
    const answer = await childAnswer('superseded', parent.turnId);
    const created = await app.runtime.deliveries.createAutomatic({ inboxItemId: answer.inboxItemId,
      targetConversationId: CONVERSATION, sourceTurnId: parent.turnId });
    assert.equal(created.delivery.phase, 'next_turn', 'the current answer may continue its stopped parent');
    // The child starts a newer generation of its task before the wake runs: this answer is no
    // longer the one on its bridge.
    await app.database.transaction([repo('AnswerBridge').update(answer.bridgeId, {
      current_submission_id: null, status: 'open', updated_at: new Date().toISOString() })]);
    for (let scan = 0; scan < 4; scan += 1) await app.processDeliveries.scanNow();
    const [wake] = await rows('RuntimeDeliveryWake', { delivery_id: created.delivery.id });
    assert.equal(wake.state, 'acknowledged', `the wake settles instead of looping: ${JSON.stringify(wake, (_, value) => typeof value === 'bigint' ? String(value) : value)}`);
    const [delivery] = await rows('RuntimeDelivery', { id: created.delivery.id });
    assert.equal(delivery.phase, 'notify_only', 'a superseded answer can no longer continue the stopped parent');
    assert.deepEqual(wakes.map(request => request.action), ['notify_only']);
  });
});

test('a wake rescans without a failure only when its delivery moved; an authority that keeps failing counts as a failed wake', { timeout: 30000 }, async () => {
  await withKernel(async ({ app, startTurn, endTurn, processResult, wakes, rows }) => {
    const source = await startTurn('wake-source');
    await endTurn(source, 'completed');
    const assertionFailure = () => Object.assign(new Error('fixture authority moved'), { code: 'RUNTIME_TRANSACTION_ASSERTION_FAILED' });
    const router = app.processDeliveries.automaticDeliveryRouter;
    const reconcile = router.reconcilePendingDelivery;
    const wakeOf = async deliveryId => (await rows('RuntimeDeliveryWake', { delivery_id: deliveryId }))[0];

    const moved = await app.runtime.deliveries.createAutomatic({ inboxItemId: await processResult('moved-process', source.turnId),
      targetConversationId: CONVERSATION, sourceTurnId: source.turnId });
    let movedCalls = 0;
    router.reconcilePendingDelivery = async function(input) {
      if (input.deliveryId === moved.delivery.id && ++movedCalls === 1) {
        // Another commit moves this very delivery between the wake's read and its CAS.
        await app.database.transaction([repo('RuntimeDelivery').update(moved.delivery.id, { updated_at: new Date(Date.now() + 1000).toISOString() })]);
        throw assertionFailure();
      }
      return reconcile.call(this, input);
    };
    await app.processDeliveries.scanNow();
    const deferred = await wakeOf(moved.delivery.id);
    assert.equal(deferred.state, 'pending');
    assert.equal(deferred.failure_count, 0n, 'a delivery that moved is a race, not a failed wake');
    assert.equal(deferred.next_attempt_at, null, 'it rescans at once');
    await app.processDeliveries.scanNow();
    assert.equal((await wakeOf(moved.delivery.id)).state, 'acknowledged');
    assert.ok(wakes.some(request => request.deliveryId === moved.delivery.id && request.action === 'start_continuation'));

    const stuck = await app.runtime.deliveries.createAutomatic({ inboxItemId: await processResult('stuck-process', source.turnId),
      targetConversationId: CONVERSATION, sourceTurnId: source.turnId });
    let stuckCalls = 0;
    router.reconcilePendingDelivery = async function(input) {
      if (input.deliveryId === stuck.delivery.id) { stuckCalls += 1; throw assertionFailure(); }
      return reconcile.call(this, input);
    };
    await app.processDeliveries.scanNow();
    const failed = await wakeOf(stuck.delivery.id);
    assert.equal(stuckCalls, 2, 'the authority is decided once more from fresh facts before the wake fails');
    assert.equal(failed.state, 'pending');
    assert.equal(failed.failure_count, 1n, 'an authority CAS that keeps failing is counted, backed off and eventually dead-lettered');
    assert.notEqual(failed.next_attempt_at, null);
    router.reconcilePendingDelivery = reconcile;
  });
});
