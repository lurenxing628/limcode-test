import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const kernel = await import(pathToFileURL(
  path.join(root, 'dist/extension/backend/reliableKernel/index.js')
).href);

const PLAN_REQUEST = {
  plan: '1. 验证审批终态。',
  taskList: {
    mode: 'rewrite',
    items: [{ title: '验证审批终态', description: '区分取消与拒绝。', status: 'pending', delete: false }]
  }
};

test('全局停止把 AskUser、执行审批和文件审批统一收敛为 cancelled', async () => {
  const harness = await createHarness('cancel-all');
  try {
    const askCallId = await harness.createTool('ask-call', 'ask_user');
    await harness.app.interactions.pauseForAskUser({
      source: { kind: 'internal', key: 'pause-ask' },
      toolCallId: askCallId,
      prompt: { question: '继续吗？' }
    });

    const execCallId = await harness.createTool('exec-call', 'shell');
    await harness.app.interactions.pauseForExecutionApproval({
      source: { kind: 'internal', key: 'pause-exec' },
      toolCallId: execCallId,
      prompt: { command: 'printf test' }
    });

    const fileCallId = await harness.createTool('file-call', 'write');
    await harness.app.files.propose({
      source: { kind: 'internal', key: 'propose-file' },
      toolCallId: fileCallId,
      members: [{
        operation: 'create_file',
        workEnvironmentId: 'work-env-test',
        planningRoot: harness.planningRoot,
        targetPath: 'cancelled.txt',
        targetContent: 'must-not-be-written'
      }]
    });

    await harness.app.toolDispatcher.cancelWaiting({
      turnId: harness.turnId,
      sourceKey: 'global-stop',
      reason: '用户停止当前回复。'
    });

    const requests = await rows(harness.app, 'InteractionRequest');
    assert.deepEqual(
      requests.map((request) => [request.request_kind, request.status]).sort(),
      [
        ['ask_user', 'cancelled'],
        ['exec_approval', 'cancelled'],
        ['file_change_approval', 'cancelled']
      ]
    );
    const decisions = await rows(harness.app, 'FileChangeDecision');
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision, 'cancelled');
    await assertToolOutcomes(harness.app, [askCallId, execCallId, fileCallId], 'cancelled');
  } finally {
    await harness.close();
  }
});

test('审批按钮的明确拒绝仍保持 rejected，不与取消混淆', async () => {
  const harness = await createHarness('explicit-reject');
  try {
    const execCallId = await harness.createTool('exec-reject-call', 'shell');
    const execPause = await harness.app.interactions.pauseForExecutionApproval({
      source: { kind: 'internal', key: 'pause-exec-reject' },
      toolCallId: execCallId,
      prompt: { command: 'printf reject' }
    });
    const execResult = await harness.app.interactions.resolveExecutionApproval({
      source: { kind: 'command', key: 'reject-exec' },
      requestId: execPause.requestId,
      decision: 'reject',
      response: { reason: '用户明确拒绝执行。' }
    });
    assert.equal(execResult.approved, false);
    assert.equal(execResult.cancelled, false);

    const fileCallId = await harness.createTool('file-reject-call', 'write');
    const fileProposal = await harness.app.files.propose({
      source: { kind: 'internal', key: 'propose-file-reject' },
      toolCallId: fileCallId,
      members: [{
        operation: 'create_file',
        workEnvironmentId: 'work-env-test',
        planningRoot: harness.planningRoot,
        targetPath: 'rejected.txt',
        targetContent: 'must-not-be-written'
      }]
    });
    await harness.app.files.decide({
      source: { kind: 'command', key: 'reject-file' },
      changeSetId: fileProposal.changeSetId,
      decision: 'rejected',
      response: { reason: '用户明确拒绝更改。' }
    });

    const planCallId = await harness.createTool('plan-reject-call', 'submit_plan');
    const planPause = await harness.app.interactions.pauseForPlanReview({
      source: { kind: 'internal', key: 'pause-plan-reject' },
      toolCallId: planCallId,
      request: PLAN_REQUEST
    });
    await harness.app.interactions.resolvePlanReview({
      source: { kind: 'command', key: 'reject-plan' },
      requestId: planPause.requestId,
      decision: 'reject',
      response: { message: 'User rejected the plan.' }
    });

    const requests = await rows(harness.app, 'InteractionRequest');
    assert.ok(requests.length === 3 && requests.every((request) => request.status === 'rejected'));
    const [fileDecision] = await rows(harness.app, 'FileChangeDecision');
    assert.equal(fileDecision.decision, 'rejected');
    await assertToolOutcomes(harness.app, [execCallId, fileCallId, planCallId], 'rejected');
    const planArtifact = await toolResultArtifactBody(harness.app, planCallId);
    assert.equal(planArtifact.status, 'rejected');
    assert.equal(planArtifact.detail?.status, 'rejected');
  } finally {
    await harness.close();
  }
});

test('执行审批 reject/cancel 并发时只有一个 durable response 获胜', async () => {
  const harness = await createHarness('approval-race');
  try {
    const toolCallId = await harness.createTool('exec-race-call', 'shell');
    const pause = await harness.app.interactions.pauseForExecutionApproval({
      source: { kind: 'internal', key: 'pause-exec-race' },
      toolCallId,
      prompt: { command: 'printf race' }
    });
    const results = await Promise.all([
      harness.app.interactions.resolveExecutionApproval({
        source: { kind: 'command', key: 'race-reject' },
        requestId: pause.requestId,
        decision: 'reject',
        response: { reason: 'explicit rejection' }
      }),
      harness.app.interactions.resolveExecutionApproval({
        source: { kind: 'command', key: 'race-cancel' },
        requestId: pause.requestId,
        decision: 'cancel',
        response: { reason: 'global cancellation' }
      })
    ]);

    assert.equal(results.filter((result) => result.won).length, 1);
    const responses = await rows(harness.app, 'InteractionResponse', { request_id: pause.requestId });
    assert.equal(responses.length, 1);
    const [request] = await rows(harness.app, 'InteractionRequest', { id: pause.requestId });
    assert.ok(request.status === 'rejected' || request.status === 'cancelled');
    await assertToolOutcomes(harness.app, [toolCallId], request.status);
    assert.ok(results.every((result) => result.cancelled === (request.status === 'cancelled')));
  } finally {
    await harness.close();
  }
});

async function createHarness(suffix) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-waiting-${suffix}-`));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const host = {
    definitions() { return []; },
    async cancelTurnWaits() {},
    async dispose() {}
  };
  const app = await kernel.ReliableKernelApplication.open(authority, dependencies(host));
  const conversationId = `conversation-${suffix}-${path.basename(parent)}`;
  const turnId = `turn-${suffix}-${path.basename(parent)}`;
  const now = new Date().toISOString();
  await app.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
      id: conversationId,
      title: `Waiting interaction ${suffix}`,
      status: 'active',
      created_at: now,
      updated_at: now
    }),
    kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
      id: turnId,
      conversation_id: conversationId,
      status: 'active',
      created_at: now,
      updated_at: now,
      terminal_at: null
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
      id: `lease-${suffix}-${path.basename(parent)}`,
      conversation_id: conversationId,
      turn_id: turnId,
      owner_id: 'waiting-interaction-test',
      host_boot_id: app.database.hostBootId,
      generation: 1n,
      acquired_at: now,
      expires_at: new Date(Date.now() + 60_000).toISOString()
    })
  ]);

  const rootStat = await fs.lstat(await fs.realpath(parent), { bigint: true });
  return {
    app,
    planningRoot: { canonicalPath: await fs.realpath(parent), device: String(rootStat.dev), inode: String(rootStat.ino) },
    turnId,
    async createTool(id, toolName) {
      await app.runtime.effects.createToolCall({
        source: { kind: 'internal', key: `create:${id}` },
        toolCallId: id,
        turnId,
        toolName,
        arguments: {}
      });
      return id;
    },
    async close() {
      await app.close();
      await fs.rm(parent, { recursive: true, force: true });
    }
  };
}

function dependencies(host) {
  return {
    authorityCompiler: {
      async compile() { throw new Error('Authority compilation is not expected in waiting interaction tests.'); }
    },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: {
      async toolAnnotations() { return {}; },
      async callTool() { return null; }
    },
    mcpPolicyGate: {
      async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; }
    },
    attachmentSettings: {
      async loadGlobalSettings() {
        return {
          section: 'attachments',
          settings: { maxStoredInlineFileMb: 25 },
          filePath: 'settings/attachments.json'
        };
      }
    },
    providers: {
      resolve() { throw new Error('Provider resolution is not expected in waiting interaction tests.'); }
    },
    createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) =>
      new kernel.ReliableToolDispatcher({
        database,
        contentStore,
        effects: runtime.effects,
        files,
        fileMutations,
        processes,
        mcp,
        interactions,
        host
      })
  };
}

async function assertToolOutcomes(app, toolCallIds, expectedStatus) {
  const calls = await rows(app, 'ToolCall');
  for (const toolCallId of toolCallIds) {
    assert.equal(calls.find((call) => call.id === toolCallId)?.status, 'terminal');
    const outcomes = await rows(app, 'ToolOutcome', { tool_call_id: toolCallId });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, expectedStatus);
  }
}

async function toolResultArtifactBody(app, toolCallId) {
  const [artifact] = await rows(app, 'ToolResultArtifact', { tool_call_id: toolCallId });
  const [metadata] = await rows(app, 'ContentObject', { id: artifact.content_object_id });
  return JSON.parse((await app.contentStore.read(metadata)).toString('utf8'));
}

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 100
  }))).snapshot;
}
