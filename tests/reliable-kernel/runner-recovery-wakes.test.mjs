import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = relative => import(pathToFileURL(path.join(compiled, relative)).href);
const kernel = await load('backend/reliableKernel/index.js');
const { ReliableConversationRunner } = await load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { preparedContentObjectSteps } = await load('backend/reliableKernel/contentObjectTransaction.js');
const { askUserTool } = await load('backend/world/modules/tools/definitions/askUser/index.js');
const { submitPlanTool } = await load('backend/world/modules/tools/definitions/submitPlan/index.js');
const repo = domain => kernel.DOMAIN_REPOSITORIES.domain(domain);
const textReply = text => ({ role: 'model', parts: [{ text }] });
const toolReply = kind => ({ role: 'model', parts: [{ id: `provider-${kind}`, functionCall: {
  name: kind === 'plan_review' ? 'submit_plan' : 'ask_user',
  args: kind === 'plan_review'
    ? { plan: '1. 检查等待恢复。', taskList: { mode: 'rewrite', items: [
      { title: '检查等待恢复', description: '验证没有忙循环。', status: 'pending', delete: false }
    ] } }
    : { question: '继续吗？', options: [{ label: '继续' }, { label: '停止' }] }
} }] });

// Every provider and completed-process receipt below is offline. No tool process is launched.
async function withHarness(verify, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-runner-recovery-wakes-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const conversationId = 'runner-recovery-conversation';
  const ownerId = 'runner-recovery-owner';
  let providerCalls = 0;
  const provider = {
    providerId: 'runner-recovery-provider',
    async sendFullRequest(request, controls) {
      providerCalls += 1;
      await options.beforeReply?.(providerCalls, request);
      await controls.onEvent({ kind: 'completed', streamSeq: '1',
        content: options.waitKind && providerCalls === 1 ? toolReply(options.waitKind) : textReply('完成。') });
    }
  };
  const host = {
    definitions() { return [askUserTool, submitPlanTool]; },
    async cancelTurnWaits() {},
    async dispose() {}
  };
  const app = await kernel.ReliableKernelApplication.open(authority, {
    authorityCompiler: { async compile(request) { return {
      turnId: request.turnId, executorAgentId: request.executorAgentId,
      executionPreset: { content: JSON.stringify({ providerConfigId: provider.providerId, modelId: 'fixture-model' }) },
      authoritySnapshot: { content: JSON.stringify({ kind: 'effective-turn-authority',
        turnId: request.turnId, conversationId: request.conversationId, executorAgentId: request.executorAgentId,
        model: { providerConfigId: provider.providerId, provider: 'fixture', modelId: 'fixture-model',
          retryPolicy: { enabled: false, maxRetries: 0 } },
        modelProfile: { compressionThresholdTokens: 100000, contextWindowTokens: 128000,
          tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
        toolPolicy: { id: 'fixture-tools', allowedTools: ['ask_user', 'submit_plan'], preset: 'custom',
          toolConfigs: {}, sourceConfigs: {} },
        planReviewPolicy: { mode: 'optional' }, systemPrompt: { id: 'fixture-prompt', text: '' },
        runtimeContext: { id: null, name: '', template: '' },
        workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
      }) }
    }; } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('Unexpected MCP call'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: { async loadGlobalSettings() { return {
      section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused'
    }; } },
    providers: { resolve() { return provider; } },
    createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) =>
      new kernel.ReliableToolDispatcher({ database, contentStore, effects: runtime.effects,
        files, fileMutations, processes, mcp, interactions, host })
  });
  const errors = [];
  const runner = new ReliableConversationRunner(app, ownerId, (error, context) => errors.push({ error, context }));
  const now = new Date().toISOString();
  await app.database.transaction([
    repo('Conversation').insert({ id: conversationId, title: 'Runner recovery', status: 'active', created_at: now, updated_at: now }),
    repo('AgentConversationLink').insert({ id: 'runner-recovery-agent', conversation_id: conversationId,
      agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now })
  ]);
  const dormantInput = key => app.turns.input({ source: { kind: 'command', key }, conversationId,
    leaseOwnerId: ownerId, hostBootId: app.database.hostBootId,
    leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), content: key });
  try {
    await verify({ app, runner, conversationId, ownerId, errors, dormantInput,
      get providerCalls() { return providerCalls; } });
  } finally {
    options.release?.();
    runner.dispose();
    await runner.waitForIdle();
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const rows = async (app, domain, where = {}) => (await app.database.snapshotAll(repo(domain).list({
  where, orderBy: { column: 'id', direction: 'asc' }, limit: 100
}))).snapshot;
async function eventually(check, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}
function gate() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function queueAfterTerminal(h) {
  const first = await h.dormantInput('pre-restart-first');
  const queued = await h.dormantInput('pre-restart-second');
  assert.equal(queued.admitted, false);
  await h.app.turns.terminal({ source: { kind: 'internal', key: 'pre-restart-first-terminal' },
    turnId: first.turnId, terminalStatus: 'cancelled', reason: 'Fixture restart between terminal commit and admission' });
  assert.deepEqual(await rows(h.app, 'Turn', { status: 'active' }), []);
  return queued;
}

test('first eligibility rescan of a healthy local drive preserves its generation and sends the provider once', { timeout: 20000 }, async () => {
  const started = gate();
  const release = gate();
  await withHarness(async h => {
    const input = await h.runner.input({ commandId: 'ordinary-input', conversationId: h.conversationId, text: '执行。' });
    await started.promise;
    const [before] = await rows(h.app, 'ExecutionLease', { turn_id: input.turnId });
    assert.equal((await rows(h.app, 'CommandReceipt')).some(row => String(row.source_key).startsWith('runner-claim-execution:')), false);
    await h.runner.rescan();
    const [after] = await rows(h.app, 'ExecutionLease', { turn_id: input.turnId });
    assert.equal(after.generation, before.generation, 'first recovery receipt must not replace a healthy local fence');
    assert.equal(after.acquired_at, before.acquired_at);
    await h.runner.recoverStartup(undefined, h.conversationId);
    assert.equal((await rows(h.app, 'ExecutionLease', { turn_id: input.turnId }))[0].generation, before.generation);
    release.resolve();
    await h.runner.waitForIdle();
    assert.equal(h.providerCalls, 1);
    assert.equal((await rows(h.app, 'Turn', { id: input.turnId }))[0].status, 'terminated');
    assert.deepEqual(h.errors, []);
  }, { beforeReply: async call => { if (call === 1) { started.resolve(); await release.promise; } }, release: release.resolve });
});

for (const expired of [false, true]) {
  test(`first recovery claim ${expired ? 'advances an expired' : 'retains an unexpired'} same-runner lease`, async () => {
    await withHarness(async h => {
      const input = await h.dormantInput('claim-input');
      const [before] = await rows(h.app, 'ExecutionLease', { turn_id: input.turnId });
      if (expired) await h.app.database.transaction([repo('ExecutionLease').update(before.id, { expires_at: '2000-01-01T00:00:00.000Z' })]);
      const claim = await h.app.turns.claimRecoveryExecution({ turnId: input.turnId, leaseOwnerId: h.ownerId,
        hostBootId: h.app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 60000).toISOString() });
      if (!expired) assert.equal((await rows(h.app, 'ExecutionLease', { turn_id: input.turnId }))[0].expires_at, before.expires_at,
        'a retained healthy generation never shortens its existing expiry');
      assert.equal(BigInt(claim.leaseGeneration), before.generation + (expired ? 1n : 0n));
      assert.equal(h.providerCalls, 0);
      if (!expired) await assert.rejects(h.app.turns.claimRecoveryExecution({ turnId: input.turnId,
        leaseOwnerId: 'another-runner', hostBootId: h.app.database.hostBootId,
        leaseExpiresAt: new Date(Date.now() + 120000).toISOString() }), /another runner/);
    });
  });
}

for (const blocked of ['unknown', 'busy']) {
  test(`queued-only ${blocked === 'busy' ? 'scoped' : 'startup'} recovery retries ${blocked} without another event`, { timeout: 20000 }, async () => {
    await withHarness(async h => {
      const queued = await queueAfterTerminal(h);
      const owners = h.app.database.conversationOwners;
      const tryClaim = owners.tryClaimEligible.bind(owners);
      let blockedNow = true;
      let admissionClaims = 0;
      if (blocked === 'unknown') owners.setClaimEligibilityProbe(async () => {
        if (blockedNow) throw new Error('Transient workspace read failure');
        return true;
      });
      owners.tryClaimEligible = async id => {
        assert.equal(id, h.conversationId);
        admissionClaims += 1;
        return blocked === 'busy' && blockedNow ? 'busy' : tryClaim(id);
      };
      // Commit-triggered idle sweeps also ask the eligibility probe whether to keep an owner.
      // Force those unrelated checks before recovery; they must not be mistaken for admission
      // retries or make this bound depend on whether a background cleanup timer happened to run.
      await owners.sweepIdle();
      await owners.sweepIdle();
      assert.equal(admissionClaims, 0, 'idle cleanup never attempts queued admission');
      await h.runner.recoverStartup(undefined, blocked === 'busy' ? h.conversationId : undefined);
      assert.ok(h.runner.admissionRetries.get(h.conversationId)?.timer, 'the queued-only candidate retains its retry timer');
      assert.equal(h.runner.admissionRetries.get(h.conversationId).failures, 1);
      assert.equal(admissionClaims, 1, 'the initial recovery pass attempts admission exactly once before backoff');
      assert.equal(h.providerCalls, 0);
      blockedNow = false;
      // Only the existing backoff timer may wake admission; no resume, rescan, or new input.
      await eventually(async () => (await rows(h.app, 'TurnIntent', { id: queued.intentId }))[0].state === 'admitted', 'queue did not recover');
      await h.runner.waitForIdle();
      assert.equal(h.providerCalls, 1);
      assert.equal(h.runner.admissionRetries.size, 0);
      assert.deepEqual(h.errors, []);
    });
  });
}

test('queued-only rescan clears an old retry when eligibility becomes definitely false', async () => {
  await withHarness(async h => {
    const queued = await queueAfterTerminal(h);
    let eligible = undefined;
    h.app.database.conversationOwners.setClaimEligibilityProbe(async () => {
      if (eligible === undefined) throw new Error('Unknown');
      return eligible;
    });
    await h.runner.recoverStartup();
    assert.ok(h.runner.admissionRetries.get(h.conversationId)?.timer);
    eligible = false;
    await h.runner.rescan();
    assert.equal(h.runner.admissionRetries.size, 0);
    assert.equal((await rows(h.app, 'TurnIntent', { id: queued.intentId }))[0].state, 'queued');
    eligible = true;
    await h.runner.rescan();
    await h.runner.waitForIdle();
    assert.equal(h.providerCalls, 1);
    assert.deepEqual(h.errors, []);
  });
});

test('queued admission retries a busy owner pin after its eligible claim succeeded', { timeout: 20000 }, async () => {
  await withHarness(async h => {
    await queueAfterTerminal(h);
    const owners = h.app.database.conversationOwners;
    const run = owners.run.bind(owners);
    let rejectPin = true;
    owners.run = async (id, operation) => {
      if (rejectPin) {
        const error = new Error('Peer claimed between eligibility and pin');
        error.code = 'conversation-runtime-owner-busy';
        throw error;
      }
      return run(id, operation);
    };
    await h.runner.recoverStartup();
    await h.runner.waitForIdle();
    const retry = h.runner.admissionRetries.get(h.conversationId);
    assert.ok(retry?.timer);
    assert.equal(retry.failures, 1);
    // Advance the scheduled retry without depending on timer throughput.
    clearTimeout(retry.timer);
    retry.timer = undefined;
    h.runner.scheduleAdmission(h.conversationId);
    await h.runner.waitForIdle();
    assert.equal(h.runner.admissionRetries.get(h.conversationId).failures, 2,
      'repeated claim-to-pin contention retains exponential backoff');
    assert.equal(h.providerCalls, 0);
    rejectPin = false;
    await eventually(() => h.providerCalls === 1, 'lost owner pin stranded the queue');
    await h.runner.waitForIdle();
    assert.equal(h.runner.admissionRetries.size, 0);
    assert.deepEqual(h.errors, []);
  });
});

async function deliverCompletedProcess(h, turnId, id) {
  const at = new Date().toISOString();
  const payload = await h.app.contentStore.prepare(h.app.database, JSON.stringify({ kind: 'process_completion',
    processId: id, processReceiptId: `receipt-${id}`, sourceTurnId: turnId, conversationId: h.conversationId }),
  'application/vnd.limcode.process-completion+json');
  await h.app.database.transaction([
    ...preparedContentObjectSteps([payload], 'fixture_wait_process_result'),
    repo('Process').insert({ id, status: 'exited', wrapper_nonce: `nonce-${id}`, wrapper_pid: 0n, child_pid: null,
      process_group_id: null, start_fingerprint: `fingerprint-${id}`, command_digest: `digest-${id}`,
      spool_locator: `spool/${id}`, retained_bytes: 0n, retained_chunks: 0n, dropped_bytes: 0n, truncated: 0n,
      started_at: at, updated_at: at, completed_at: at }),
    repo('ProcessCompletionSourceLink').insert({ id: `source-${id}`, process_id: id, conversation_id: h.conversationId,
      source_turn_id: turnId, source_tool_call_id: `${id}-tool`, created_at: at }),
    repo('ProcessReceipt').insert({ id: `receipt-${id}`, process_id: id, outcome: 'succeeded', exit_code: 0n,
      exit_signal: null, wrapper_nonce: `nonce-${id}`, start_fingerprint: `fingerprint-${id}`, received_at: at }),
    repo('RuntimeInboxItem').insert({ id, dedupe_key: `fixture:${id}`, source_kind: 'process_receipt',
      source_id: `receipt-${id}`, state: 'available', created_at: at, updated_at: at }),
    repo('RuntimeInboxPayloadLink').insert({ id: `payload-${id}`, inbox_item_id: id,
      content_object_id: payload.metadata.id, created_at: at })
  ]);
  const created = await h.app.runtime.deliveries.createAutomatic({ inboxItemId: id,
    targetConversationId: h.conversationId, sourceTurnId: turnId });
  await h.app.runtime.deliveries.advance(created.delivery.id);
}

for (const waitKind of ['plan_review', 'ask_user']) {
  for (const finish of ['answer', 'interrupt']) {
    test(`${waitKind} parks unchanged runtime delivery and still handles ${finish}`, { timeout: 20000 }, async () => {
      await withHarness(async h => {
        let drives = 0;
        const drive = h.app.agentLoop.drive.bind(h.app.agentLoop);
        h.app.agentLoop.drive = async (...args) => {
          drives += 1;
          if (drives > 8) throw new Error('Unchanged waiting facts were driven repeatedly');
          return drive(...args);
        };
        const input = await h.runner.input({ commandId: `wait-${waitKind}`, conversationId: h.conversationId, text: '开始。' });
        await h.runner.waitForIdle();
        const [interaction] = await rows(h.app, 'InteractionRequest', { request_kind: waitKind, status: 'pending' });
        assert.ok(interaction);
        const [call] = await rows(h.app, 'ToolCall', { turn_id: input.turnId });
        const initialDrives = drives;
        await deliverCompletedProcess(h, input.turnId, `process-${waitKind}-${finish}`);
        const observation = await h.runner.waitingWakeFingerprint(input.turnId, call.id);
        assert.equal(observation.ready, false, 'runtime input cannot open the next request while this tool batch waits');
        // Model the same local commit wake used in production, then repeatedly poll unchanged facts.
        await h.runner.pollExternalWakes();
        await h.runner.waitForIdle();
        assert.equal(drives, initialDrives + 1, 'one new delivery wakes exactly once');
        for (let poll = 0; poll < 3; poll += 1) {
          h.runner.localWakeRequested = true;
          await h.runner.pollExternalWakes();
          await h.runner.waitForIdle();
        }
        assert.equal(drives, initialDrives + 1, 'unchanged delivery stays parked');
        assert.equal(h.providerCalls, 1);
        assert.ok(h.runner.waitingOwned.has(input.turnId));
        assert.equal((await rows(h.app, 'PendingTurnInput', { turn_id: input.turnId, state: 'pending' })).length, 1);
        if (finish === 'interrupt') {
          await h.runner.interrupt({ commandId: `stop-${waitKind}`, conversationId: h.conversationId,
            turnId: input.turnId, reason: 'Stop while runtime input waits' });
        } else {
          await h.app.database.conversationOwners.run(h.conversationId, () => waitKind === 'plan_review'
            ? h.app.interactions.resolvePlanReview({ source: { kind: 'command', key: 'reject-plan' },
              requestId: interaction.id, decision: 'reject', response: {} })
            : h.app.interactions.resolveAskUser({ source: { kind: 'command', key: 'answer-question' },
              requestId: interaction.id, response: { answer: { selectedOptionIndexes: [0], customText: '' } }, cancelled: false }));
          h.runner.resume(h.conversationId, input.turnId);
        }
        await h.runner.waitForIdle();
        assert.equal((await rows(h.app, 'TurnTermination', { turn_id: input.turnId }))[0].terminal_status,
          finish === 'interrupt' ? 'interrupted' : 'completed');
        assert.equal(h.providerCalls, finish === 'interrupt' ? 1 : 2);
        assert.deepEqual(await rows(h.app, 'PendingTurnInput', { turn_id: input.turnId, state: 'pending' }), []);
        const [head] = await rows(h.app, 'ConversationContextHeadLink', { conversation_id: h.conversationId });
        const kinds = (await h.app.context.materialize(head.root_id)).segments.map(segment => segment.segmentKind);
        assert.ok(kinds.indexOf('tool_pair') >= 0);
        assert.ok(kinds.indexOf('runtime_context') > kinds.indexOf('tool_pair'), 'delivery follows the atomic tool/result pair');
        assert.deepEqual(h.errors, []);
      }, { waitKind });
    });
  }
}

test('a deferred predecessor that terminates before recovery does not strand its ordinary queue', { timeout: 20000 }, async () => {
  await withHarness(async h => {
    const first = await h.dormantInput('deferred-first');
    const queued = await h.dormantInput('deferred-second');
    const owners = h.app.database.conversationOwners;
    const tryClaim = owners.tryClaimEligible.bind(owners);
    owners.tryClaimEligible = async () => 'busy';
    await h.runner.recoverStartup();
    assert.ok(h.runner.deferredRecovery.has(first.turnId));
    // Equivalent durable frontier to a peer committing terminal then exiting before queue admission.
    await h.app.turns.terminal({ source: { kind: 'internal', key: 'peer-terminal-before-admission' },
      turnId: first.turnId, terminalStatus: 'cancelled', reason: 'Peer completed predecessor before queue admission' });
    owners.tryClaimEligible = tryClaim;
    await h.runner.pollExternalWakes();
    assert.ok(h.runner.admissions.has(h.conversationId) || h.runner.admissionRetries.has(h.conversationId),
      'dropping a terminal recovery candidate must preserve the queued admission wake');
    await eventually(async () => (await rows(h.app, 'TurnIntent', { id: queued.intentId }))[0].state === 'admitted',
      'queue behind terminal deferred predecessor did not recover');
    await h.runner.waitForIdle();
    assert.equal(h.providerCalls, 1);
    assert.deepEqual(h.errors, []);
  });
});

test('a waiting answer wake blocked by a busy conversation owner remains a recovery candidate', { timeout: 20000 }, async () => {
  await withHarness(async h => {
    const input = await h.runner.input({ commandId: 'waiting-busy', conversationId: h.conversationId, text: '提问。' });
    await h.runner.waitForIdle();
    const [interaction] = await rows(h.app, 'InteractionRequest', { request_kind: 'ask_user', status: 'pending' });
    await h.app.database.conversationOwners.run(h.conversationId, () => h.app.interactions.resolveAskUser({
      source: { kind: 'command', key: 'answer-before-busy' }, requestId: interaction.id,
      response: { answer: { selectedOptionIndexes: [0], customText: '' } }, cancelled: false }));
    const owners = h.app.database.conversationOwners;
    const tryClaim = owners.tryClaimEligible.bind(owners);
    owners.tryClaimEligible = async () => 'busy';
    await h.runner.pollExternalWakes();
    assert.ok(h.runner.deferredRecovery.has(input.turnId), 'busy ownership must not discard the answered Turn wake');
    assert.equal(h.providerCalls, 1);
    owners.tryClaimEligible = tryClaim;
    await h.runner.pollExternalWakes();
    await h.runner.waitForIdle();
    assert.equal(h.providerCalls, 2);
    assert.equal((await rows(h.app, 'Turn', { id: input.turnId }))[0].status, 'terminated');
    assert.deepEqual(h.errors, []);
  }, { waitKind: 'ask_user' });
});

test('control-only finalization of a deferred orphan preserves the next queued admission', { timeout: 20000 }, async () => {
  await withHarness(async h => {
    const first = await h.dormantInput('orphan-first');
    const queued = await h.dormantInput('orphan-second');
    const owners = h.app.database.conversationOwners;
    const tryClaim = owners.tryClaimEligible.bind(owners);
    owners.tryClaimEligible = async () => 'busy';
    await h.runner.recoverStartup();
    assert.ok(h.runner.deferredRecovery.has(first.turnId));
    const [lease] = await rows(h.app, 'ExecutionLease', { turn_id: first.turnId });
    // The identity contract's active/no-lease/no-input recovery case is finalize-only.
    await h.app.database.transaction([repo('ExecutionLease').delete(lease.id)]);
    owners.tryClaimEligible = tryClaim;
    await h.runner.pollExternalWakes();
    assert.equal((await rows(h.app, 'Turn', { id: first.turnId }))[0].status, 'terminated');
    await h.runner.waitForIdle();
    assert.equal((await rows(h.app, 'TurnIntent', { id: queued.intentId }))[0].state, 'admitted');
    assert.equal(h.providerCalls, 1);
    assert.deepEqual(h.errors, []);
  });
});

test('concurrent same-fence renewals keep authority and the longest requested expiry', async () => {
  await withHarness(async h => {
    const input = await h.dormantInput('concurrent-renewal');
    const fence = await h.app.turns.executionLeaseFence({ turnId: input.turnId, leaseOwnerId: h.ownerId,
      hostBootId: h.app.database.hostBootId });
    const later = new Date(Date.now() + 300000).toISOString();
    const latest = new Date(Date.now() + 360000).toISOString();
    // Both real snapshot/CAS operations run concurrently, with no inserted yield or fake rejection.
    const results = await Promise.all([
      h.app.turns.renewExecutionLeaseDetailed({ fence, leaseExpiresAt: later }),
      h.app.turns.renewExecutionLeaseDetailed({ fence, leaseExpiresAt: latest })
    ]);
    assert.ok(results.every(result => result.renewed), JSON.stringify(results));
    const [lease] = await rows(h.app, 'ExecutionLease', { turn_id: input.turnId });
    assert.equal(lease.generation, fence.generation);
    assert.equal(lease.expires_at, latest);
    await h.app.turns.releaseExecutionLease(fence);
    assert.equal((await h.app.turns.renewExecutionLeaseDetailed({ fence, leaseExpiresAt: latest })).reason, 'fence_replaced');
    assert.equal(h.providerCalls, 0);
  });
});

for (const loss of ['expired', 'terminal', 'missing']) {
  test(`same-fence renewal still rejects ${loss} authority`, async () => {
    await withHarness(async h => {
      const input = await h.dormantInput(`renewal-${loss}`);
      const fence = await h.app.turns.executionLeaseFence({ turnId: input.turnId, leaseOwnerId: h.ownerId,
        hostBootId: h.app.database.hostBootId });
      if (loss === 'expired') await h.app.database.transaction([
        repo('ExecutionLease').update(fence.id, { expires_at: '2000-01-01T00:00:00.000Z' })
      ]);
      else if (loss === 'missing') await h.app.database.transaction([repo('ExecutionLease').delete(fence.id)]);
      else await h.app.turns.terminal({ source: { kind: 'internal', key: 'renewal-terminal' },
        turnId: input.turnId, terminalStatus: 'cancelled', reason: 'Terminal must not regain authority' });
      const result = await h.app.turns.renewExecutionLeaseDetailed({ fence,
        leaseExpiresAt: new Date(Date.now() + 360000).toISOString() });
      assert.equal(result.renewed, false);
      assert.equal(result.reason, loss === 'expired' ? 'lease_expired' : 'lease_missing');
      assert.equal(h.providerCalls, 0);
    });
  });
}

const localBusyError = () => Object.assign(new Error('Temporary local writer contention'), { code: 'SQLITE_BUSY' });

for (const afterCommit of [false, true]) {
  test(`local assistant commit ${afterCommit ? 'acknowledgment' : 'pre-commit'} failure resumes completed output without another model call`, { timeout: 20000 }, async () => {
    await withHarness(async h => {
      const original = h.app.turnOutput.appendAssistantMessage.bind(h.app.turnOutput);
      let attempts = 0;
      h.app.turnOutput.appendAssistantMessage = async input => {
        attempts += 1;
        if (attempts === 1) {
          if (afterCommit) await original(input);
          throw localBusyError();
        }
        return original(input);
      };
      const input = await h.runner.input({ commandId: `local-output-${afterCommit}`, conversationId: h.conversationId, text: '完成回答。' });
      await h.runner.waitForIdle();
      const [termination] = await rows(h.app, 'TurnTermination', { turn_id: input.turnId });
      assert.equal(termination.terminal_status, 'completed');
      assert.equal(h.providerCalls, 1, 'completed checkpoint is replayed locally');
      assert.equal(attempts, 2);
      const links = await rows(h.app, 'MessageTurnLink', { turn_id: input.turnId });
      assert.equal(links.filter(link => link.role === 'model').length, 1, 'the exact output identity is retained');
      assert.deepEqual(h.errors, []);
    });
  });
}

for (const afterCommit of [false, true]) {
  test(`queued admission recovers a transient ${afterCommit ? 'post-commit acknowledgment' : 'pre-commit'} error without another user event`, { timeout: 20000 }, async () => {
    await withHarness(async h => {
      const queued = await queueAfterTerminal(h);
      const original = h.app.turns.admitNextQueued.bind(h.app.turns);
      let attempts = 0;
      h.app.turns.admitNextQueued = async input => {
        attempts += 1;
        if (attempts === 1) {
          if (afterCommit) await original(input);
          throw localBusyError();
        }
        return original(input);
      };
      await h.runner.recoverStartup();
      await eventually(async () => (await rows(h.app, 'TurnTermination')).some(row => row.terminal_status === 'completed'), 'admission did not recover');
      await h.runner.waitForIdle();
      const [intent] = await rows(h.app, 'TurnIntent', { id: queued.intentId });
      assert.equal(intent.state, 'admitted');
      assert.equal(h.providerCalls, 1);
      assert.equal((await rows(h.app, 'Turn', { id: intent.turn_id })).length, 1);
      assert.equal(h.runner.admissionRetries.size, 0);
      assert.equal(h.runner.localAdmissionRecoveryFailures.size, 0);
    });
  });
}

test('transient execution-fence read retains a delayed recovery wake', { timeout: 20000 }, async () => {
  await withHarness(async h => {
    const original = h.app.turns.executionLeaseFence.bind(h.app.turns);
    let attempts = 0;
    h.app.turns.executionLeaseFence = async input => {
      if (++attempts === 1) throw localBusyError();
      return original(input);
    };
    const input = await h.runner.input({ commandId: 'local-fence-read', conversationId: h.conversationId, text: '完成回答。' });
    await eventually(async () => (await rows(h.app, 'Turn', { id: input.turnId }))[0].status === 'terminated', 'drive wake was lost');
    await h.runner.waitForIdle();
    assert.equal((await rows(h.app, 'TurnTermination', { turn_id: input.turnId }))[0].terminal_status, 'completed');
    assert.equal(h.providerCalls, 1);
    assert.equal(h.runner.deferredRecovery.size, 0);
    assert.equal(h.runner.localDriveRecoveryFailures.size, 0);
  });
});

test('durable interruption cancels local output recovery before any second model request', { timeout: 20000 }, async () => {
  await withHarness(async h => {
    const failed = gate();
    let attempts = 0;
    h.app.turnOutput.appendAssistantMessage = async () => {
      attempts += 1;
      failed.resolve();
      throw localBusyError();
    };
    const input = await h.runner.input({ commandId: 'local-output-stop', conversationId: h.conversationId, text: '完成回答。' });
    await failed.promise;
    await h.runner.interrupt({ commandId: 'stop-local-retry', conversationId: h.conversationId, turnId: input.turnId, reason: 'User stopped local recovery' });
    await h.runner.waitForIdle();
    assert.equal((await rows(h.app, 'TurnTermination', { turn_id: input.turnId }))[0].terminal_status, 'interrupted');
    assert.equal(h.providerCalls, 1);
    assert.ok(attempts < 9, 'interrupt did not wait for the recovery budget');
  });
});

test('local recovery excludes root/schema/permission/cancellation and honors abort during backoff', async () => {
  const { isRetryableLocalExecutionError, retryLocalExecution } = await load('backend/reliableKernel/localExecutionRecovery.js');
  for (const code of ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED', 'EAGAIN', 'EBUSY', 'EMFILE', 'ENFILE']) {
    assert.equal(isRetryableLocalExecutionError(Object.assign(new Error(code), { code })), true);
  }
  for (const code of ['SQLITE_CORRUPT', 'SQLITE_FULL', 'EACCES', 'ENOSPC', 'RUNTIME_TRANSACTION_ASSERTION_FAILED',
    'MODEL_STREAM_IDEMPOTENCY_CONFLICT', 'CONTENT_OBJECT_CORRUPT', 'stale-root-binding', 'EXECUTION_HANDOFF', 'LOCAL_EXECUTION_RECOVERY_EXHAUSTED']) {
    assert.equal(isRetryableLocalExecutionError(Object.assign(new Error(code), { code })), false);
  }
  const controller = new AbortController();
  let attempts = 0;
  const cancelled = Object.assign(new Error('User cancelled'), { name: 'AbortError' });
  await assert.rejects(retryLocalExecution(async () => {
    attempts += 1;
    throw localBusyError();
  }, { signal: controller.signal, beforeRetry: async () => { controller.abort(cancelled); } }), error => error === cancelled);
  assert.equal(attempts, 1);
});

test('an exhausted local retry budget is typed and cannot multiply in an outer retry layer', async t => {
  const { retryLocalExecution, LOCAL_EXECUTION_MAX_RETRIES, isRetryableLocalExecutionError } = await load('backend/reliableKernel/localExecutionRecovery.js');
  let clock = 0;
  t.mock.method(Date, 'now', () => clock += 10000);
  let attempts = 0;
  const original = localBusyError();
  await assert.rejects(retryLocalExecution(() => retryLocalExecution(async () => {
    attempts += 1;
    throw original;
  })), error => error.code === 'LOCAL_EXECUTION_RECOVERY_EXHAUSTED'
    && error.cause === original && !isRetryableLocalExecutionError(error));
  assert.equal(attempts, LOCAL_EXECUTION_MAX_RETRIES + 1);
});
