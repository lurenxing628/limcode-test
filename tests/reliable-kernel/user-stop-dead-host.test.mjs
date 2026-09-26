import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.cwd();
const load = (relative) => import(pathToFileURL(path.join(root, 'dist/extension', relative)).href);
const kernel = await load('backend/reliableKernel/index.js');
const { ReliableConversationRunner } = await load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { DEAD_HOST_STOP_REASON } = await load('backend/reliableKernel/phaseDRecovery.js');
const { ReliableChildAgentCoordinator } = await load('backend/reliableKernel/childAgentCoordinator.js');
const { runAgentTool } = await load('backend/world/modules/tools/definitions/runAgent/index.js');
const { evaluateConversationHostEligibility } = await load('backend/application/reliableKernel/conversationHostEligibility.js');
const { projectFolderAssignmentSteps } = await load('backend/reliableKernel/conversationProject.js');

const PROVIDER_ID = 'dead-host-provider';
const PROJECT_ONE = 'file:///workspace/project-one';
const PROJECT_TWO = { uri: 'file:///workspace/project-two', name: '项目二' };
const TEST_FILE = fileURLToPath(import.meta.url);

/** An MCP tool whose server never answers: its effect stays dispatched while the window lives. */
const hangingMcpTool = {
  execution: 'runtime',
  declaration: {
    name: 'fixture_hang',
    description: 'MCP fixture that never answers.',
    parameters: { type: 'object', properties: {} },
    source: { kind: 'mcp', sourceId: 'fixture', sourceName: 'fixture', originalToolName: 'hang' },
    metadata: { category: 'general', scope: 'general', riskLevel: 'read', readonly: true, defaultEnabled: true }
  },
  async execute() { throw new Error('MCP execution must use the reliable McpEffect control plane.'); }
};

const workerMode = process.env.LIMCODE_DEAD_HOST_WORKER;
if (workerMode) {
  runWorker(workerMode).then(
    () => process.exit(0),
    (error) => {
      console.error(error?.stack ?? error);
      process.exit(1);
    }
  );
} else {

test('执行窗口被杀、工具仍在执行、项目在任何窗口都打不开：停止前删不掉，用户停止后效果为 outcome_unknown、Turn 收尾、可以删除（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('killed');
  let p1;
  let child;
  try {
    const conversationId = 'conversation-killed';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, { ...files.env, LIMCODE_DEAD_HOST_CONVERSATION: conversationId });
    const { turnId } = await waitForWorkerJson(child, files.ready, 90_000);
    child.kill('SIGKILL');
    await waitForExit(child, 30_000);

    const provider = scriptedProvider([]);
    p1 = await openHost(dataRoot, provider, { folders: [PROJECT_ONE], label: 'p1' });
    await p1.app.recover();
    const report = await p1.runner.recoverStartup();
    assert.deepEqual(report.ineligibleTurnIds, [turnId], '没有窗口服务该项目');
    const [call] = await rows(p1.app, 'ToolCall', { turn_id: turnId });
    assert.equal(call.status, 'executing', '被杀窗口留下执行中的工具');
    const [intent] = await effectIntentsForToolCall(p1.app, call.id);
    assert.equal(intent.dispatch_state, 'dispatched');

    // 用户先尝试删除：删不掉，也不让本窗口一直持有。
    await assert.rejects(deleteConversation(p1, conversationId), /活动 Turn/);
    assert.equal(p1.owns(conversationId), false);

    // 恢复扫描和延迟轮询不会自动标记：只有用户停止才会。
    await sleep(1_500);
    assert.deepEqual(await rows(p1.app, 'EffectReceipt', { attempt_id: intent.attempt_id }), []);

    const [lease] = await rows(p1.app, 'ExecutionLease', { turn_id: turnId });
    const stopped = await p1.runner.interrupt({
      commandId: 'user-stop',
      conversationId,
      turnId,
      expectedLeaseGeneration: String(lease.generation),
      reason: '用户停止'
    });
    assert.equal(stopped.executingWindowAlive, undefined);
    const [turn] = await rows(p1.app, 'Turn', { id: turnId });
    assert.equal(turn.status, 'terminated', '用户停止后 Turn 立即收尾');
    assert.equal((await rows(p1.app, 'TurnTermination', { turn_id: turnId }))[0]?.terminal_status, 'interrupted');
    const [receipt] = await rows(p1.app, 'EffectReceipt', { attempt_id: intent.attempt_id });
    assert.equal(receipt?.outcome, 'outcome_unknown');
    assert.deepEqual(await readContentJson(p1.app, receipt.response_object_id), {
      reason: DEAD_HOST_STOP_REASON,
      automaticRetry: false
    });
    assert.equal(DEAD_HOST_STOP_REASON, '执行窗口意外退出，执行结果未知；由用户停止收尾。');
    const [operation] = await rows(p1.app, 'Operation', { tool_call_id: call.id });
    assert.equal(operation.status, 'outcome_unknown');
    assert.equal((await rows(p1.app, 'ToolOutcome', { tool_call_id: call.id }))[0]?.status, 'outcome_unknown');
    assert.equal((await rows(p1.app, 'ToolCall', { id: call.id }))[0]?.status, 'terminal');
    assert.equal(provider.calls, 0, '收尾不调用模型');
    assert.equal(p1.mcpCalls(), 0, '收尾不重放 MCP 调用');
    assert.equal(p1.owns(conversationId), false, '收尾后交还');

    const deleted = await deleteConversation(p1, conversationId);
    assert.deepEqual(deleted?.deletedConversationIds, [conversationId]);
    assert.deepEqual(p1.runnerErrors.map((entry) => String(entry.error?.stack ?? entry.error)), []);
  } finally {
    await p1?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('执行窗口仍存活时，其它窗口的停止不标记结果未知，交给执行窗口处理并提示（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('alive');
  let p1;
  let child;
  try {
    const conversationId = 'conversation-alive';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, { ...files.env, LIMCODE_DEAD_HOST_CONVERSATION: conversationId });
    const { turnId, hostBootId } = await waitForWorkerJson(child, files.ready, 90_000);

    const provider = scriptedProvider([]);
    p1 = await openHost(dataRoot, provider, { folders: [PROJECT_ONE], label: 'p1' });
    await p1.app.recover();
    await p1.runner.recoverStartup();
    const [call] = await rows(p1.app, 'ToolCall', { turn_id: turnId });
    const [intent] = await effectIntentsForToolCall(p1.app, call.id);
    const [lease] = await rows(p1.app, 'ExecutionLease', { turn_id: turnId });
    const stopped = await p1.runner.interrupt({
      commandId: 'user-stop-alive',
      conversationId,
      turnId,
      expectedLeaseGeneration: String(lease.generation),
      reason: '用户停止'
    });
    assert.equal(stopped.executingWindowAlive, true, '提示用户去执行窗口查看');
    assert.equal(p1.owns(conversationId), false);
    const leaseAfter = (await rows(p1.app, 'ExecutionLease', { turn_id: turnId }))[0];
    assert.notEqual(leaseAfter?.host_boot_id, p1.app.database.hostBootId, '不得接走存活窗口的执行租约');

    // 存活的执行窗口收到持久停止请求后自己收尾；本窗口从不写"意外退出"的结果。
    await eventually(async () => (await rows(p1.app, 'Turn', { id: turnId }))[0]?.status === 'terminated',
      60_000, '执行窗口未处理停止请求');
    const [receipt] = await rows(p1.app, 'EffectReceipt', { attempt_id: intent.attempt_id });
    if (receipt?.response_object_id) {
      const detail = await readContentJson(p1.app, receipt.response_object_id);
      assert.notEqual(detail.reason, DEAD_HOST_STOP_REASON);
    }
    const ours = await rows(p1.app, 'CommandReceipt', {});
    assert.equal(ours.some((row) => String(row.source_key).startsWith('user-stop-dead-host:')), false);
    assert.equal(p1.mcpCalls(), 0);
    assert.notEqual(hostBootId, p1.app.database.hostBootId);

    await fs.writeFile(files.finish, 'finish\n', 'utf8');
    await waitForExit(child, 90_000, true);
  } finally {
    await p1?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('子 Agent 同样适用：执行窗口被杀后，用户停止子 Agent 把它的效果标为 outcome_unknown 并收尾子 Turn；删除只剩父对话待接收的子答复这一项现有规则（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('killed-child');
  let p1;
  let child;
  try {
    const conversationId = 'conversation-parent';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, { ...files.env, LIMCODE_DEAD_HOST_CONVERSATION: conversationId }, 'origin-child');
    const spawned = await waitForWorkerJson(child, files.ready, 90_000);
    child.kill('SIGKILL');
    await waitForExit(child, 30_000);

    p1 = await openHost(dataRoot, scriptedProvider([]), { folders: [PROJECT_ONE], label: 'p1', children: true });
    await p1.app.recover();
    await p1.runner.recoverStartup();
    await p1.coordinator.recoverStartup();
    const [childTurn] = await rows(p1.app, 'Turn', { id: spawned.childTurnId });
    assert.equal(childTurn.status, 'active', '被杀窗口留下活动的子 Turn');
    const [call] = await rows(p1.app, 'ToolCall', { turn_id: spawned.childTurnId, status: 'executing' });
    const [intent] = await effectIntentsForToolCall(p1.app, call.id);
    assert.equal(intent.dispatch_state, 'dispatched');
    await assert.rejects(deleteConversation(p1, conversationId), /Subagent|活动 Turn/);

    // A model's run_agent interrupt is not a user's stop: it never closes a dead window's work.
    await p1.coordinator.interruptSubtree({
      sourceKey: 'model-interrupt',
      childExecutionId: spawned.childExecutionId,
      reason: 'run_agent interrupt_subtree requested'
    });
    await sleep(1_000);
    assert.deepEqual(await rows(p1.app, 'EffectReceipt', { attempt_id: intent.attempt_id }), []);
    assert.equal((await rows(p1.app, 'Turn', { id: spawned.childTurnId }))[0]?.status, 'active');

    const stopped = await p1.coordinator.interruptSubtree({
      sourceKey: 'user-stop-child',
      childExecutionId: spawned.childExecutionId,
      reason: '用户停止子 Agent'
    }, { userStop: true });
    assert.equal(stopped.executingWindowAlive, undefined);
    assert.equal((await rows(p1.app, 'Turn', { id: spawned.childTurnId }))[0]?.status, 'terminated');
    assert.equal((await rows(p1.app, 'TurnTermination', { turn_id: spawned.childTurnId }))[0]?.terminal_status, 'interrupted');
    const [receipt] = await rows(p1.app, 'EffectReceipt', { attempt_id: intent.attempt_id });
    assert.equal(receipt?.outcome, 'outcome_unknown');
    assert.equal((await readContentJson(p1.app, receipt.response_object_id)).reason, DEAD_HOST_STOP_REASON);
    const [execution] = await rows(p1.app, 'ChildExecution', { id: spawned.childExecutionId });
    assert.equal(['starting', 'active', 'interrupting'].includes(String(execution.status)), false, `子执行仍为 ${execution.status}`);
    assert.equal(p1.mcpCalls(), 0);

    // The Subagent tree itself no longer blocks deletion. What remains is the existing rule that a
    // parent first takes in its Subagent's answer (here the interrupted partial answer), which only a
    // parent Turn in a window serving the project can do; changing that rule is left to the maintainer.
    const pendingAnswers = await rows(p1.app, 'RuntimeDelivery', { target_conversation_id: conversationId, state: 'pending' });
    assert.equal(pendingAnswers.length, 1, '子 Agent 的中断结果投递给父对话');
    const [inbox] = await rows(p1.app, 'RuntimeInboxItem', { id: pendingAnswers[0].inbox_item_id });
    assert.equal(inbox.source_kind, 'answer_submission');
    await assert.rejects(deleteConversation(p1, conversationId), /待接收的后台结果/);
    assert.equal(p1.owns(conversationId), false);
    assert.deepEqual(p1.runnerErrors.map((entry) => String(entry.error?.stack ?? entry.error)), []);
  } finally {
    await p1?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

}

/** The executing window: starts a Turn whose MCP call never answers, then waits to be killed. */
async function runWorker(mode) {
  if (mode === 'origin-child') {
    await runChildOrigin();
    return;
  }
  if (mode !== 'origin') throw new Error(`Unknown worker ${mode}.`);
  const dataRoot = requiredEnv('LIMCODE_DEAD_HOST_DATA_ROOT');
  const conversationId = requiredEnv('LIMCODE_DEAD_HOST_CONVERSATION');
  const provider = scriptedProvider([
    { role: 'model', parts: [{ id: 'provider-hang-call', functionCall: { name: 'fixture_hang', args: {} } }] },
    { role: 'model', parts: [{ text: '已停止。' }] }
  ]);
  const host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO.uri], label: 'origin' });
  try {
    await createConversation(host.app, conversationId, PROJECT_TWO);
    const started = await host.runner.input({ commandId: `input-${conversationId}`, conversationId, text: '调用外部工具' });
    await eventually(async () => host.mcpCalls() > 0, 30_000, 'MCP 调用未派发');
    await writeJson(requiredEnv('LIMCODE_DEAD_HOST_READY'), {
      turnId: started.turnId,
      hostBootId: host.app.database.hostBootId
    });
    await waitForFile(requiredEnv('LIMCODE_DEAD_HOST_FINISH'), 300_000);
  } finally {
    await host.close();
  }
}

/** The executing window for a child: the parent spawns a child whose MCP call never answers. */
async function runChildOrigin() {
  const dataRoot = requiredEnv('LIMCODE_DEAD_HOST_DATA_ROOT');
  const conversationId = requiredEnv('LIMCODE_DEAD_HOST_CONVERSATION');
  const parentReplies = [
    { role: 'model', parts: [{ id: 'provider-spawn', functionCall: {
      name: 'run_agent',
      args: { operation: 'spawn', taskName: 'hang', prompt: '调用外部工具', foregroundWaitMs: 0 }
    } }] },
    { role: 'model', parts: [{ text: '子任务已开始。' }] }
  ];
  const childReplies = [
    { role: 'model', parts: [{ id: 'provider-child-hang', functionCall: { name: 'fixture_hang', args: {} } }] }
  ];
  let parentCalls = 0;
  let childCalls = 0;
  const provider = {
    providerId: PROVIDER_ID,
    async sendFullRequest(request, controls) {
      const content = request.conversationId === conversationId
        ? parentReplies[parentCalls++]
        : childReplies[childCalls++];
      if (!content) throw new Error('Unexpected Provider call.');
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content });
    }
  };
  const host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO.uri], label: 'origin', children: true });
  try {
    await createConversation(host.app, conversationId, PROJECT_TWO);
    await host.runner.input({ commandId: `input-${conversationId}`, conversationId, text: '派一个子 Agent' });
    await eventually(async () => host.mcpCalls() > 0, 60_000, '子 Agent 的 MCP 调用未派发');
    const [execution] = await rows(host.app, 'ChildExecution', {});
    const [link] = await rows(host.app, 'ChildExecutionActiveTurnLink', { child_execution_id: execution.id });
    await writeJson(requiredEnv('LIMCODE_DEAD_HOST_READY'), {
      childExecutionId: execution.id,
      childConversationId: execution.child_conversation_id,
      childTurnId: link.turn_id
    });
    await waitForFile(requiredEnv('LIMCODE_DEAD_HOST_FINISH'), 300_000);
  } finally {
    await host.close();
  }
}

async function openHost(dataRoot, provider, options) {
  const folders = [...options.folders];
  let mcpCalls = 0;
  let coordinator;
  const app = await kernel.ReliableKernelApplication.open(
    new kernel.RootAuthority(() => dataRoot),
    fixtureDependencies(provider, () => { mcpCalls += 1; }, options.children ? () => coordinator : undefined)
  );
  if (options.children) {
    coordinator = new ReliableChildAgentCoordinator({
      database: app.database,
      ...app.runtime,
      modelProvider: app.modelProvider,
      turns: app.turns,
      agentLoop: app.agentLoop,
      agents: { async resolve() { return { agentId: 'agent-worker', agentType: 'worker' }; } },
      modelProfiles: { async initializeConversation() { return { created: true }; } },
      deliveryWakeups: app.processDeliveries,
      ownedProcessCleanup: app.childOwnedProcessCleanup,
      deadHostEffects: app.phaseDRecovery
    });
  }
  const runnerErrors = [];
  const runner = new ReliableConversationRunner(
    app,
    `${options.label}:${app.database.hostBootId}`,
    (error, context) => runnerErrors.push({ error, context })
  );
  const eligibility = (conversationId) => evaluateConversationHostEligibility({
    database: app.database,
    contentStore: app.contentStore,
    workspaceFolderUris: () => folders,
    workEnvironments: async () => []
  }, conversationId);
  app.database.conversationOwners.setClaimEligibilityProbe(async (conversationId) =>
    (await eligibility(conversationId)).eligible);
  let closed = false;
  return {
    app,
    runner,
    coordinator,
    runnerErrors,
    mcpCalls: () => mcpCalls,
    owns: (conversationId) => app.database.conversationOwners.owns(conversationId),
    async close() {
      if (closed) return;
      closed = true;
      runner.dispose();
      await app.beginHandoff().catch(() => undefined);
      await runner.waitForIdle().catch(() => undefined);
      await coordinator?.dispose().catch(() => undefined);
      await app.close();
    }
  };
}

/** VscodeReliableKernelApplicationFacade.deleteConversation */
function deleteConversation(host, conversationId) {
  return host.app.database.conversationOwners.run(conversationId, () =>
    host.app.conversationDeletion.delete(conversationId));
}

async function createConversation(app, conversationId, project) {
  const now = new Date().toISOString();
  await app.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
      id: conversationId, title: conversationId, status: 'active', created_at: now, updated_at: now
    }),
    kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
      id: `link-${conversationId}`, conversation_id: conversationId, agent_id: 'agent-main',
      role: 'default', created_at: now, updated_at: now
    }),
    ...projectFolderAssignmentSteps({ conversationId, folder: project, now })
  ]);
}

async function effectIntentsForToolCall(app, toolCallId) {
  const intents = [];
  for (const operation of await rows(app, 'Operation', { tool_call_id: toolCallId })) {
    for (const attempt of await rows(app, 'Attempt', { operation_id: operation.id })) {
      intents.push(...await rows(app, 'EffectIntent', { attempt_id: attempt.id }));
    }
  }
  return intents;
}

async function readContentJson(app, contentObjectId) {
  const [metadata] = await rows(app, 'ContentObject', { id: contentObjectId });
  return JSON.parse((await app.contentStore.read(metadata)).toString('utf8'));
}

function scriptedProvider(replies) {
  let calls = 0;
  return {
    providerId: PROVIDER_ID,
    get calls() { return calls; },
    async sendFullRequest(_request, controls) {
      calls += 1;
      const content = replies[calls - 1];
      if (!content) throw new Error(`Unexpected Provider call ${calls}.`);
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content });
    }
  };
}

function fixtureDependencies(provider, onMcpCall, coordinator) {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: {
            content: JSON.stringify({ providerConfigId: provider.providerId, modelId: 'dead-host-model' })
          },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: {
                providerConfigId: provider.providerId,
                provider: 'openai-compatible',
                modelId: 'dead-host-model',
                retryPolicy: { enabled: false, maxRetries: 0 }
              },
              modelProfile: {
                compressionThresholdTokens: 100_000,
                contextWindowTokens: 128_000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              toolPolicy: {
                id: 'dead-host-tools',
                allowedTools: coordinator ? ['run_agent'] : [],
                preset: 'yolo',
                toolConfigs: {},
                sourceConfigs: { fixture: { enabled: true } }
              },
              planReviewPolicy: { mode: 'off' },
              systemPrompt: { id: 'dead-host-prompt', text: '' },
              runtimeContext: { id: null, name: '', template: '' },
              workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
            })
          }
        };
      }
    },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: {
      async toolAnnotations() { return {}; },
      callTool() {
        onMcpCall();
        return new Promise(() => {});
      }
    },
    mcpPolicyGate: {
      async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; }
    },
    attachmentSettings: {
      async loadGlobalSettings() {
        return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'settings/attachments.json' };
      }
    },
    providers: {
      resolve(providerId) {
        if (providerId !== provider.providerId) throw new Error(`Unexpected provider ${providerId}.`);
        return provider;
      }
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
        host: {
          definitions() { return coordinator ? [hangingMcpTool, runAgentTool] : [hangingMcpTool]; },
          async dispatchSpecial(_definition, input, authority, signal, admission) {
            return coordinator?.().dispatch(input, signal, authority, admission);
          },
          async cancelTurnWaits(input) { await coordinator?.().cancelParentWaits(input); },
          async quiesce(reason) { await coordinator?.().quiesce(reason); },
          async dispose() {}
        }
      })
  };
}

async function createIsolatedRoot(label) {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-dead-host-${label}-`));
  await fs.mkdir(path.join(outer, 'control'), { recursive: true });
  const candidate = await kernel.resetCandidateRuntimeRoot(path.join(outer, 'control'));
  return { outer, dataRoot: candidate.binding.paths.dataRootPath };
}

async function rows(appOrDatabase, domain, where = {}) {
  const database = appOrDatabase.database ?? appOrDatabase;
  return (await database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 1_000
  }))).snapshot;
}

function workerFiles(outer) {
  const files = { ready: path.join(outer, 'origin-ready.json'), finish: path.join(outer, 'origin-finish') };
  return {
    ...files,
    env: { LIMCODE_DEAD_HOST_READY: files.ready, LIMCODE_DEAD_HOST_FINISH: files.finish }
  };
}

function spawnWorker(dataRoot, environment, mode = 'origin') {
  const child = childProcess.spawn(process.execPath, [TEST_FILE], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...environment,
      LIMCODE_DEAD_HOST_WORKER: mode,
      LIMCODE_DEAD_HOST_DATA_ROOT: dataRoot
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { child.output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { child.output.stderr += chunk; });
  return child;
}

async function waitForWorkerJson(child, filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`worker exited before ${path.basename(filePath)} (code=${child.exitCode})\n${child.output.stdout}\n${child.output.stderr}`);
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await sleep(20);
  }
}

async function stopChild(child) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await waitForExit(child, 15_000).catch(() => undefined);
}

function waitForExit(child, timeoutMs, rejectNonZero = false) {
  return new Promise((resolve, reject) => {
    const settle = (code, signal) => {
      if (rejectNonZero && code !== 0) {
        reject(new Error(`worker failed (code=${code}, signal=${signal})\n${child.output?.stdout ?? ''}\n${child.output?.stderr ?? ''}`));
      } else {
        resolve({ code, signal });
      }
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      settle(child.exitCode, child.signalCode);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`worker timed out after ${timeoutMs}ms\n${child.output?.stdout ?? ''}\n${child.output?.stderr ?? ''}`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      settle(code, signal);
    });
  });
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.access(filePath);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await sleep(20);
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(`${filePath}.tmp`, `${JSON.stringify(value)}\n`, 'utf8');
  await fs.rename(`${filePath}.tmp`, filePath);
}

async function eventually(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(20);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment: ${name}`);
  return value;
}
