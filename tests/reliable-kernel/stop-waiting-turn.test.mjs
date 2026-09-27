import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A user's stop of a Turn that waits for a question, a plan review, an execution approval or a
// foreground child Agent, with the tool host wired as the product wires it (cancelTurnWaits →
// ReliableChildAgentCoordinator.cancelParentWaits, VscodeReliableKernelProductRuntime). Every stop
// path of ReliableConversationRunner.interrupt must end the Turn as interrupted, close its questions
// and approvals as cancelled, cancel its child waits and never call the model again:
// - the executing window, whose own drive observes the stop (AgentLoop.terminateIfRequested);
// - a window that must not execute the Conversation (settleWithoutExecution);
// - any window after the executing one was killed with work in flight (settleDeadHostExecution).
const root = process.cwd();
const load = (relative) => import(pathToFileURL(path.join(root, 'dist/extension', relative)).href);
const kernel = await load('backend/reliableKernel/index.js');
const { ReliableConversationRunner } = await load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { ReliableChildAgentCoordinator } = await load('backend/reliableKernel/childAgentCoordinator.js');
const { evaluateConversationHostEligibility } = await load('backend/application/reliableKernel/conversationHostEligibility.js');
const { projectFolderAssignmentSteps } = await load('backend/reliableKernel/conversationProject.js');
const { askUserTool } = await load('backend/world/modules/tools/definitions/askUser/index.js');
const { runAgentTool } = await load('backend/world/modules/tools/definitions/runAgent/index.js');
const { submitPlanTool } = await load('backend/world/modules/tools/definitions/submitPlan/index.js');

const PROVIDER_ID = 'stop-waiting-provider';
const PROJECT = { uri: 'file:///workspace/stop-waiting', name: '停止项目' };
const CONVERSATION = 'conversation-stop-waiting';
const STOP_REASON = '用户停止当前回复。';
const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);
const TEST_FILE = fileURLToPath(import.meta.url);

const PLAN_ARGS = {
  plan: '1. 检查停止路径。',
  taskList: {
    mode: 'rewrite',
    items: [{ title: '检查停止路径', description: '停止时关闭计划审阅。', status: 'pending', delete: false }]
  }
};

function mcpTool(name, description, metadata = {}) {
  return {
    execution: 'runtime',
    declaration: {
      name,
      description,
      parameters: { type: 'object', properties: {} },
      source: { kind: 'mcp', sourceId: 'fixture', sourceName: 'fixture', originalToolName: name },
      metadata: { category: 'general', scope: 'general', riskLevel: 'read', readonly: true, defaultEnabled: true, ...metadata }
    },
    async execute() { throw new Error('MCP execution must use the reliable McpEffect control plane.'); }
  };
}

/** Never answers: its effect stays dispatched while the window lives. */
const hangingMcpTool = mcpTool('fixture_hang', 'MCP fixture that never answers.');
/** Runs only after the user approves its execution. */
const guardedMcpTool = mcpTool('fixture_guarded', 'MCP fixture that needs execution approval.', { defaultAutoApproveExecution: false });

const call = (id, name, args) => ({ id, functionCall: { name, args } });
const askArgs = { question: '继续吗？', options: [{ label: '继续' }, { label: '停止' }] };

/** What the stopped Turn waits for, and what the stop must close. */
const WAITS = {
  ask: {
    label: '等提问',
    reply: () => [call('call-ask', 'ask_user', askArgs)],
    interactions: ['ask_user']
  },
  plan: {
    label: '等计划审阅',
    reply: () => [call('call-plan', 'submit_plan', PLAN_ARGS)],
    interactions: ['plan_review']
  },
  approval: {
    label: '等执行审批',
    reply: () => [call('call-guarded', 'fixture_guarded', {})],
    interactions: ['exec_approval']
  },
  child: {
    label: '等前台子 Agent',
    reply: () => [call('call-spawn', 'run_agent', { operation: 'spawn', taskName: 'waited', prompt: '前台子任务', foregroundWaitMs: 600_000 })],
    interactions: []
  }
};

const workerMode = process.env.LIMCODE_STOP_WAITING_WORKER;
if (workerMode) {
  runWorker(workerMode).then(
    () => process.exit(0),
    (error) => {
      console.error(error?.stack ?? error);
      process.exit(1);
    }
  );
} else {

for (const [kind, wait] of Object.entries(WAITS)) {
  test(`执行窗口里停止${wait.label}的 Turn：Turn 中断，等待被关闭，不再调用模型`, { timeout: 120_000 }, async (t) => {
    const { dataRoot } = await isolatedRoot(t, `exec-${kind}`);
    const provider = waitingProvider(kind);
    const host = await openHost(dataRoot, provider, { label: 'exec' });
    try {
      const turnId = await startWaiting(host, kind);
      const parentCalls = provider.parentCalls();
      await host.runner.interrupt({ commandId: `stop-${kind}`, conversationId: CONVERSATION, turnId, reason: STOP_REASON });
      await eventually(async () => (await rows(host.app, 'Turn', { id: turnId }))[0].status === 'terminated', 30_000, 'Turn 没有结束')
        .catch((error) => { throw new Error(`${error.message}\n${errors(host).join('\n')}`); });
      await quiet(host);
      await assertStopped(host.app, turnId, kind);
      assert.equal(provider.parentCalls(), parentCalls, '停止后不再调用模型');
      assert.equal(host.mcpCalls.length, 0, '未批准的工具没有执行');
      assert.deepEqual(errors(host), []);
    } finally {
      await host.close();
    }
  });

  test(`不执行该对话的窗口里停止${wait.label}的 Turn：控制类收尾成功，Turn 中断，等待被关闭`, { timeout: 120_000 }, async (t) => {
    const { dataRoot } = await isolatedRoot(t, `other-${kind}`);
    const origin = await openHost(dataRoot, waitingProvider(kind), { label: 'origin' });
    let turnId;
    try {
      turnId = await startWaiting(origin, kind);
    } finally {
      await origin.close();
    }
    const provider = countingProvider();
    const other = await openHost(dataRoot, provider, { label: 'other', folders: [] });
    try {
      assert.equal(await other.app.database.conversationOwners.executionEligibility(CONVERSATION), 'ineligible');
      await other.runner.interrupt({ commandId: `stop-${kind}`, conversationId: CONVERSATION, turnId, reason: STOP_REASON });
      assert.equal((await rows(other.app, 'Turn', { id: turnId }))[0].status, 'terminated', `停止当场收尾\n${errors(other).join('\n')}`);
      await quiet(other);
      await assertStopped(other.app, turnId, kind);
      assert.equal(provider.calls.length, 0, '不执行的窗口不调用模型');
      assert.equal(other.mcpCalls.length, 0);
      assert.deepEqual(errors(other), []);
    } finally {
      await other.close();
    }
  });
}

test('执行窗口被杀时同一轮里 MCP 调用已派发、提问和执行审批在等待：其它窗口停止后效果记为结果未知，提问与审批关闭，Turn 中断（跨进程）', { timeout: 180_000 }, async (t) => {
  const { outer, dataRoot } = await isolatedRoot(t, 'dead-host');
  const ready = path.join(outer, 'origin-ready.json');
  const worker = spawnWorker('parallel-waits', {
    LIMCODE_STOP_WAITING_DATA_ROOT: dataRoot,
    LIMCODE_STOP_WAITING_READY: ready
  });
  let turnId;
  try {
    ({ turnId } = await waitForWorkerJson(worker, ready, 90_000));
  } finally {
    worker.kill('SIGKILL');
    await waitForExit(worker);
  }
  const provider = countingProvider();
  const other = await openHost(dataRoot, provider, { label: 'other', folders: [] });
  try {
    const [hang] = await rows(other.app, 'EffectIntent', { effect_kind: 'mcp_tool_call' });
    assert.equal(hang.dispatch_state, 'dispatched', '被杀的窗口留下已派发、没有回执的 MCP 调用');
    await other.runner.interrupt({ commandId: 'stop-dead-host', conversationId: CONVERSATION, turnId, reason: STOP_REASON });
    assert.equal((await rows(other.app, 'Turn', { id: turnId }))[0].status, 'terminated', `停止当场收尾\n${errors(other).join('\n')}`);
    await quiet(other);
    const [termination] = await rows(other.app, 'TurnTermination', { turn_id: turnId });
    assert.equal(termination.terminal_status, 'interrupted');
    const requests = await interactionsOf(other.app, turnId);
    assert.deepEqual(requests.map((request) => [request.request_kind, request.status]).sort(),
      [['ask_user', 'cancelled'], ['exec_approval', 'cancelled']], '提问与审批都关闭');
    const [receipt] = await rows(other.app, 'EffectReceipt', { attempt_id: hang.attempt_id });
    assert.equal(receipt.outcome, 'outcome_unknown', '死窗口派发的 MCP 调用记为结果未知');
    const outcomes = await outcomesByTool(other.app, turnId);
    assert.equal(outcomes.ask_user, 'cancelled');
    assert.equal(outcomes.fixture_guarded, 'cancelled');
    assert.equal(provider.calls.length, 0);
    assert.equal(other.mcpCalls.length, 0, '没有重放或执行 MCP 调用');
    assert.deepEqual(errors(other), []);
  } finally {
    await other.close();
  }
});

}

// ---- fixture ----

/** The executing window: one round dispatches a never-answering MCP call next to a question and a
 * call that waits for approval (all read-only, so one parallel group), then waits to be killed. */
async function runWorker(mode) {
  if (mode !== 'parallel-waits') throw new Error(`Unknown worker ${mode}.`);
  const dataRoot = requiredEnv('LIMCODE_STOP_WAITING_DATA_ROOT');
  const host = await openHost(dataRoot, scriptedProvider(() => [
    call('call-hang', 'fixture_hang', {}),
    call('call-ask', 'ask_user', askArgs),
    call('call-guarded', 'fixture_guarded', {})
  ]), { label: 'origin' });
  await createConversation(host.app, CONVERSATION);
  const { turnId } = await host.runner.input({ commandId: 'input-parallel', conversationId: CONVERSATION, text: '一起做三件事' });
  await eventually(async () => host.mcpCalls.length > 0
    && (await rows(host.app, 'EffectIntent', { effect_kind: 'mcp_tool_call', dispatch_state: 'dispatched' })).length === 1
    && (await interactionsOf(host.app, turnId)).filter((request) => request.status === 'pending').length === 2,
  60_000, 'MCP 调用未派发或提问、审批未进入等待');
  const ready = requiredEnv('LIMCODE_STOP_WAITING_READY');
  await fs.writeFile(`${ready}.tmp`, JSON.stringify({ turnId }), 'utf8');
  await fs.rename(`${ready}.tmp`, ready);
  await new Promise(() => {});
}

function spawnWorker(mode, environment) {
  const child = childProcess.spawn(process.execPath, [TEST_FILE], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment, LIMCODE_STOP_WAITING_WORKER: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.output = '';
  child.stdout.on('data', (chunk) => { child.output += chunk; });
  child.stderr.on('data', (chunk) => { child.output += chunk; });
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
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`worker exited early\n${child.output}`);
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}\n${child.output}`);
    await sleep(20);
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment: ${name}`);
  return value;
}

async function isolatedRoot(t, label) {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-stop-waiting-${label}-`));
  t.after(() => fs.rm(outer, { recursive: true, force: true }));
  await fs.mkdir(path.join(outer, 'control'), { recursive: true });
  const candidate = await kernel.resetCandidateRuntimeRoot(path.join(outer, 'control'));
  return { outer, dataRoot: candidate.binding.paths.dataRootPath };
}

/** Admits a Turn whose first model reply makes it wait for `kind`; returns once the wait is durable. */
async function startWaiting(host, kind) {
  await createConversation(host.app, CONVERSATION);
  const { turnId } = await host.runner.input({ commandId: `input-${kind}`, conversationId: CONVERSATION, text: '开始' });
  await eventually(() => isWaiting(host.app, turnId, kind), 60_000, `${WAITS[kind].label}没有进入等待`);
  return turnId;
}

async function isWaiting(app, turnId, kind) {
  if (kind !== 'child') {
    const pending = (await interactionsOf(app, turnId)).filter((request) => request.status === 'pending');
    return pending.length === 1 && pending[0].request_kind === WAITS[kind].interactions[0];
  }
  // The parent waits in the foreground; the child is parked on its own question, so nothing runs.
  const [spawn] = await rows(app, 'ToolCall', { turn_id: turnId });
  if (!spawn) return false;
  const waits = await rows(app, 'Operation', { tool_call_id: spawn.id, owner_kind: 'child_execution', status: 'waiting_answer' });
  const childQuestions = (await rows(app, 'InteractionRequest', { status: 'pending' })).filter((request) => request.request_kind === 'ask_user');
  return waits.length === 1 && childQuestions.length === 1;
}

async function assertStopped(app, turnId, kind) {
  const [turn] = await rows(app, 'Turn', { id: turnId });
  assert.equal(turn.status, 'terminated', 'Turn 已结束');
  const [termination] = await rows(app, 'TurnTermination', { turn_id: turnId });
  assert.equal(termination.terminal_status, 'interrupted');
  const requests = await interactionsOf(app, turnId);
  assert.deepEqual(requests.map((request) => [request.request_kind, request.status]),
    WAITS[kind].interactions.map((requestKind) => [requestKind, 'cancelled']), '已停止的 Turn 上没有待回答的交互');
  const calls = await rows(app, 'ToolCall', { turn_id: turnId });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, 'terminal');
  const outcomes = await rows(app, 'ToolOutcome', { tool_call_id: calls[0].id });
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['cancelled'], '等待的工具调用按取消结束');
  if (kind === 'child') {
    const waits = await rows(app, 'Operation', { tool_call_id: calls[0].id, owner_kind: 'child_execution' });
    assert.deepEqual(waits.map((operation) => operation.status), ['cancelled'], '父对话对子 Agent 的前台等待被取消');
    const [child] = await rows(app, 'ChildExecution', { id: waits[0].owner_id });
    assert.equal(child.status, 'active', '普通停止不级联，子 Agent 转入后台继续');
  }
}

async function interactionsOf(app, turnId) {
  const requests = [];
  for (const link of await rows(app, 'InteractionOwnerLink', { turn_id: turnId })) {
    requests.push(...await rows(app, 'InteractionRequest', { id: link.request_id }));
  }
  return requests.sort((left, right) => String(left.request_kind).localeCompare(String(right.request_kind)));
}

async function outcomesByTool(app, turnId) {
  const byTool = {};
  for (const toolCall of await rows(app, 'ToolCall', { turn_id: turnId })) {
    const [outcome] = await rows(app, 'ToolOutcome', { tool_call_id: toolCall.id });
    byTool[toolCall.tool_name] = outcome?.status;
  }
  return byTool;
}

async function openHost(dataRoot, provider, options) {
  const folders = options.folders ?? [PROJECT.uri];
  const mcpCalls = [];
  let coordinator;
  const app = await kernel.ReliableKernelApplication.open(
    new kernel.RootAuthority(() => dataRoot),
    fixtureDependencies(provider, mcpCalls, () => coordinator)
  );
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
  const runnerErrors = [];
  const runner = new ReliableConversationRunner(
    app,
    `${options.label}:${app.database.hostBootId}`,
    (error, context) => runnerErrors.push({ error, context })
  );
  app.database.conversationOwners.setClaimEligibilityProbe(async (conversationId) => (await evaluateConversationHostEligibility({
    database: app.database,
    contentStore: app.contentStore,
    workspaceFolderUris: () => folders,
    workEnvironments: async () => []
  }, conversationId)).eligible);
  let closed = false;
  return {
    app,
    runner,
    coordinator,
    runnerErrors,
    mcpCalls,
    async close() {
      if (closed) return;
      closed = true;
      runner.dispose();
      await app.beginHandoff().catch(() => undefined);
      await runner.waitForIdle().catch(() => undefined);
      await coordinator.dispose().catch(() => undefined);
      await app.close();
    }
  };
}

function fixtureDependencies(provider, mcpCalls, coordinator) {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: PROVIDER_ID, modelId: 'stop-waiting-model' }) },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: {
                providerConfigId: PROVIDER_ID,
                provider: 'openai-compatible',
                modelId: 'stop-waiting-model',
                retryPolicy: { enabled: false, maxRetries: 0 }
              },
              modelProfile: {
                compressionThresholdTokens: 100_000,
                contextWindowTokens: 128_000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              toolPolicy: {
                id: 'stop-waiting-tools',
                allowedTools: ['ask_user', 'submit_plan', 'run_agent'],
                preset: 'custom',
                toolConfigs: { run_agent: { config: { maxChildAgentDepth: 2 } } },
                sourceConfigs: { fixture: { enabled: true } }
              },
              planReviewPolicy: { mode: 'optional' },
              systemPrompt: { id: 'stop-waiting-prompt', text: '' },
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
      callTool(...args) {
        mcpCalls.push(args);
        return new Promise(() => {});
      }
    },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: {
      async loadGlobalSettings() {
        return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'settings/attachments.json' };
      }
    },
    providers: {
      resolve(providerId) {
        if (providerId !== PROVIDER_ID) throw new Error(`Unexpected provider ${providerId}.`);
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
          definitions() { return [hangingMcpTool, guardedMcpTool, askUserTool, submitPlanTool, runAgentTool]; },
          async dispatchSpecial(_definition, input, authority, signal, admission) {
            return coordinator().dispatch(input, signal, authority, admission);
          },
          // The product wiring (VscodeReliableKernelProductRuntime): a stop cancels the Turn's child waits.
          async cancelTurnWaits(input) { await coordinator().cancelParentWaits(input); },
          async quiesce(reason) { await coordinator().quiesce(reason); },
          async dispose() {}
        }
      })
  };
}

/** The parent Conversation's first reply makes it wait for `kind`; a child Agent asks a question. */
function waitingProvider(kind) {
  const provider = scriptedProvider((request, calls) => {
    if (request.conversationId !== CONVERSATION) return [call('call-child-ask', 'ask_user', askArgs)];
    const parentCalls = calls.filter((entry) => entry.conversationId === CONVERSATION).length;
    return parentCalls === 1 ? WAITS[kind].reply() : [{ text: '停止后不应再被调用' }];
  });
  provider.parentCalls = () => provider.calls.filter((entry) => entry.conversationId === CONVERSATION).length;
  return provider;
}

function countingProvider() {
  return scriptedProvider(() => [{ text: '不应被调用' }]);
}

function scriptedProvider(parts) {
  const calls = [];
  return {
    providerId: PROVIDER_ID,
    calls,
    async sendFullRequest(request, controls) {
      calls.push({ conversationId: request.conversationId });
      const content = { role: 'model', parts: await parts(request, calls) };
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content });
    }
  };
}

async function createConversation(app, conversationId) {
  const now = new Date().toISOString();
  await app.database.transaction([
    repo('Conversation').insert({ id: conversationId, title: conversationId, status: 'active', created_at: now, updated_at: now }),
    repo('AgentConversationLink').insert({
      id: `link-${conversationId}`, conversation_id: conversationId, agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now
    }),
    ...projectFolderAssignmentSteps({ conversationId, folder: PROJECT, now })
  ]);
}

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(repo(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 1_000
  }))).snapshot;
}

function errors(host) {
  return host.runnerErrors.map((entry) => String(entry.error?.stack ?? entry.error));
}

/** Lets drives and the child scheduler run; a Turn that would run again calls the Provider here. */
async function quiet(host, ms = 1_500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await host.runner.waitForIdle();
    await host.coordinator.waitForIdle();
    await sleep(100);
  }
  await host.runner.waitForIdle();
  await host.coordinator.waitForIdle();
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
