// Focused real production probes; no matrix or duplicate registrations.
import assert from 'node:assert/strict';

import fs from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

import { pathToFileURL } from 'node:url';

const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');

const load = relative => import(pathToFileURL(path.join(compiled, relative)).href);

const kernel = await load('backend/reliableKernel/index.js');

const { emptyConversationContextHandleStateStep } = await load('backend/reliableKernel/conversationContextHandleState.js');

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
    emptyConversationContextHandleStateStep(conversationId, now),
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

const localBusyError = () => Object.assign(new Error('Temporary local writer contention'), { code: 'SQLITE_BUSY' });

const blocked = 'busy';
const afterCommit = true;

export const scenario1 = async () => {
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
  };

export const scenario2 = async () => {
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
  };

export const scenario3 = async () => {
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
};
