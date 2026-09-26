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
const { evaluateConversationHostEligibility } = await load('backend/application/reliableKernel/conversationHostEligibility.js');
const { readPendingInteractionAttention, InteractionLeaseEdgeTracker } = await load(
  'backend/application/reliableKernel/interactionAttention.js'
);
const { projectFolderAssignmentSteps } = await load('backend/reliableKernel/conversationProject.js');
const { conversationRuntimeOwnerClaimPath } = await load('backend/reliableKernel/ConversationRuntimeOwnerManager.js');

const PROVIDER_ID = 'eligibility-provider';
const PROJECT_ONE = 'file:///workspace/project-one';
const PROJECT_TWO = 'file:///workspace/project-two';
const TEST_FILE = fileURLToPath(import.meta.url);

const workerMode = process.env.LIMCODE_ELIGIBILITY_WORKER;
if (workerMode) {
  runRecoveryWorker().then(
    () => process.exit(0),
    (error) => {
      console.error(error?.stack ?? error);
      process.exit(1);
    }
  );
} else {

test('其它项目的窗口不恢复该项目的活动 Turn，保持等待；打开该项目后同一窗口接上', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('project-gate');
  let other;
  try {
    const conversationId = 'conversation-project-two';
    const turnId = await startTurnThenCloseHost(dataRoot, conversationId, { uri: PROJECT_TWO, name: '项目二' });

    const provider = gatedProvider();
    other = await openHost(dataRoot, provider, { folders: [PROJECT_ONE], label: 'project-one-window' });
    await other.app.recover();
    assert.equal(other.owns(conversationId), false, '启动恢复（Phase D/F）不得认领其它项目的对话');
    const report = await other.runner.recoverStartup();
    assert.deepEqual(report.ineligibleTurnIds, [turnId]);
    assert.deepEqual(report.resumedTurnIds, []);
    assert.deepEqual(report.liveOwnedTurnIds, []);
    assert.deepEqual(report.finalizedTurnIds, [], '不合格窗口绝不可 finalize 其它项目的 Turn');
    assert.equal(other.owns(conversationId), false);
    assert.equal(await ownerRecordExists(dataRoot, conversationId), false, '不合格窗口不得写入所有权记录');

    // 其它窗口里回答问题后的"恢复提示"也不得把对话接过来。
    other.runner.resume(conversationId, turnId);
    await other.runner.waitForIdle();
    await sleep(700);
    assert.equal(provider.calls, 0, '不合格窗口不得派发 Provider');
    assert.equal(other.owns(conversationId), false);
    assert.equal((await rows(other.app, 'Turn', { id: turnId }))[0]?.status, 'active', 'Turn 必须保持等待');
    assert.equal((await rows(other.app, 'TurnTermination', { turn_id: turnId })).length, 0);

    // 同一窗口打开该项目文件夹后，重新扫描即可接上。
    other.folders.push(PROJECT_TWO);
    const resumed = await other.runner.recoverStartup();
    assert.deepEqual(resumed.resumedTurnIds, [turnId]);
    assert.deepEqual(resumed.ineligibleTurnIds, []);
    await provider.started;
    provider.release();
    await eventually(async () => (await rows(other.app, 'Turn', { id: turnId }))[0]?.status === 'terminated',
      60_000, '合格窗口接上后 Turn 未完成');
    assert.equal(provider.calls, 1);
    assert.deepEqual(other.runnerErrors, []);
  } finally {
    await other?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('资格判定：项目未打开、冻结工作环境不可用分别拒绝；无项目无环境的对话任何窗口都可承接', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('decisions');
  let host;
  try {
    const provider = gatedProvider();
    host = await openHost(dataRoot, provider, {
      folders: [],
      label: 'decision-window',
      defaultWorkEnvironmentId: 'env-frozen',
      environments: [{ id: 'env-frozen', available: false }]
    });
    const bound = 'conversation-bound';
    const unbound = 'conversation-unbound';
    const idle = 'conversation-idle';
    await createConversation(host.app, bound, { uri: PROJECT_TWO, name: '项目二' });
    await createConversation(host.app, unbound);
    await createConversation(host.app, idle);

    assert.deepEqual(await host.eligibility(bound), {
      eligible: false, reason: 'project_not_open', projectUri: PROJECT_TWO, projectName: '项目二'
    });
    host.folders.push(PROJECT_TWO);
    assert.deepEqual(await host.eligibility(bound), { eligible: true });
    assert.deepEqual(await host.eligibility(idle), { eligible: true });

    // 用户在本窗口的显式输入不受资格收窄；活动 Turn 冻结的默认工作环境决定后台承接资格。
    const started = await host.runner.input({ commandId: 'unbound-input', conversationId: unbound, text: '开始' });
    await provider.started;
    const denied = await host.eligibility(unbound);
    assert.deepEqual(denied, {
      eligible: false, reason: 'work_environment_unavailable', turnId: started.turnId, workEnvironmentId: 'env-frozen'
    });
    assert.equal(await host.app.database.conversationOwners.claimEligible(unbound), true,
      '本窗口已持有的对话继续由本窗口推进');
    host.environments[0].available = true;
    assert.deepEqual(await host.eligibility(unbound), { eligible: true });
    provider.release();
    await eventually(async () => (await rows(host.app, 'Turn', { id: started.turnId }))[0]?.status === 'terminated',
      60_000, '显式输入的 Turn 未完成');
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('同项目两个窗口并发恢复只有一个承接，其它项目窗口不参与（跨进程证明）', { timeout: 240_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('race');
  const children = [];
  let observer;
  try {
    const conversationId = 'conversation-race';
    const turnId = await startTurnThenCloseHost(dataRoot, conversationId, { uri: PROJECT_TWO, name: '项目二' });
    const go = path.join(outer, 'go');
    const gate = path.join(outer, 'gate');
    const finish = path.join(outer, 'finish');
    const workers = [
      { name: 'p2-a', folders: [PROJECT_TWO] },
      { name: 'p2-b', folders: [PROJECT_TWO] },
      { name: 'p1', folders: [PROJECT_ONE] }
    ].map((worker) => ({
      ...worker,
      ready: path.join(outer, `${worker.name}-ready`),
      report: path.join(outer, `${worker.name}-report.json`),
      result: path.join(outer, `${worker.name}-result.json`)
    }));
    for (const worker of workers) {
      children.push({
        worker,
        child: spawnWorker(dataRoot, {
          LIMCODE_ELIGIBILITY_FOLDERS: JSON.stringify(worker.folders),
          LIMCODE_ELIGIBILITY_READY: worker.ready,
          LIMCODE_ELIGIBILITY_GO: go,
          LIMCODE_ELIGIBILITY_GATE: gate,
          LIMCODE_ELIGIBILITY_FINISH: finish,
          LIMCODE_ELIGIBILITY_REPORT: worker.report,
          LIMCODE_ELIGIBILITY_RESULT: worker.result
        })
      });
    }
    for (const worker of workers) await waitForFile(worker.ready, 90_000);
    await fs.writeFile(go, 'go\n', 'utf8');
    const reports = Object.fromEntries(await Promise.all(workers.map(async (worker) =>
      [worker.name, await waitForJson(worker.report, 90_000)])));

    const winners = ['p2-a', 'p2-b'].filter((name) => reports[name].resumedTurnIds.includes(turnId));
    assert.equal(winners.length, 1, '同项目两个窗口必须恰好一个承接');
    const loser = winners[0] === 'p2-a' ? 'p2-b' : 'p2-a';
    assert.deepEqual(reports[loser].resumedTurnIds, []);
    assert.deepEqual(reports[loser].liveOwnedTurnIds, [turnId], '失败方按既有 owner/lease 规则让出');
    assert.deepEqual(reports.p1.ineligibleTurnIds, [turnId]);
    assert.deepEqual(reports.p1.resumedTurnIds, []);
    assert.deepEqual(reports.p1.liveOwnedTurnIds, []);

    await fs.writeFile(gate, 'release\n', 'utf8');
    observer = await kernel.RuntimeDatabase.open(new kernel.RootAuthority(() => dataRoot), { hostBootId: 'race-observer' });
    await eventually(async () => (await rows(observer, 'Turn', { id: turnId }))[0]?.status === 'terminated',
      90_000, '承接方未完成 Turn');
    await fs.writeFile(finish, 'finish\n', 'utf8');
    for (const { child } of children) await waitForExit(child, 90_000, true);
    const results = Object.fromEntries(await Promise.all(workers.map(async (worker) =>
      [worker.name, await readJson(worker.result)])));
    assert.equal(results[winners[0]].providerCalls, 1);
    assert.equal(results[loser].providerCalls, 0);
    assert.equal(results.p1.providerCalls, 0);
    for (const result of Object.values(results)) assert.deepEqual(result.runnerErrors, []);
  } finally {
    if (observer) await observer.close().catch(() => undefined);
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await waitForExit(child, 15_000).catch(() => undefined);
    }
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('审批与提问提示只在持有其 Turn 执行租约的窗口出现，重复回答只生效一次', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('attention');
  let app;
  try {
    app = await kernel.ReliableKernelApplication.open(
      new kernel.RootAuthority(() => dataRoot),
      fixtureDependencies(gatedProvider(), null)
    );
    const hostBootId = app.database.hostBootId;
    const conversationId = 'conversation-attention';
    const turnId = 'turn-attention';
    const leaseId = 'lease-attention';
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId, title: '等待回答', status: 'active', created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: turnId, conversation_id: conversationId, status: 'active', created_at: now, updated_at: now, terminal_at: null
      }),
      kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
        id: leaseId, conversation_id: conversationId, turn_id: turnId, owner_id: 'attention-owner',
        host_boot_id: 'peer-window', generation: 1n, acquired_at: now,
        expires_at: new Date(Date.now() + 60_000).toISOString()
      })
    ]);
    await app.runtime.effects.createToolCall({
      source: { kind: 'internal', key: 'create:ask' }, toolCallId: 'ask-call', turnId, toolName: 'ask_user', arguments: {}
    });
    const pause = await app.interactions.pauseForAskUser({
      source: { kind: 'internal', key: 'pause-ask' }, toolCallId: 'ask-call', prompt: { question: '继续吗？' }
    });

    assert.deepEqual(await readPendingInteractionAttention(app.database, hostBootId), [],
      '租约在其它窗口时本窗口不得提示');
    assert.deepEqual((await readPendingInteractionAttention(app.database, 'peer-window')).map((item) => item.requestId),
      [pause.requestId]);

    const tracker = new InteractionLeaseEdgeTracker(hostBootId);
    const claim = { changes: [{ domain: 'ExecutionLease', kind: 'upsert', id: leaseId,
      record: { host_boot_id: hostBootId, generation: 2n } }] };
    const renewal = { changes: [{ domain: 'ExecutionLease', kind: 'upsert', id: leaseId,
      record: { host_boot_id: hostBootId, generation: 2n } }] };
    const foreign = { changes: [{ domain: 'ExecutionLease', kind: 'upsert', id: 'other-lease',
      record: { host_boot_id: 'peer-window', generation: 1n } }] };
    assert.equal(tracker.observe(claim), true, '本窗口新取得租约必须触发提示刷新');
    assert.equal(tracker.observe(renewal), false, '同代续租不得触发刷新');
    assert.equal(tracker.observe(foreign), false);
    assert.equal(tracker.observe({ changes: [{ domain: 'ExecutionLease', kind: 'remove', id: leaseId }] }), false);
    assert.equal(tracker.observe(claim), true, '释放后再取得视为新边沿');

    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').update(leaseId, { host_boot_id: hostBootId, generation: 2n })
    ]);
    const mine = await readPendingInteractionAttention(app.database, hostBootId);
    assert.deepEqual(mine.map((item) => [item.requestId, item.kind, item.conversationId, item.conversationTitle]),
      [[pause.requestId, 'ask_user', conversationId, '等待回答']]);
    assert.deepEqual(await readPendingInteractionAttention(app.database, 'peer-window'), []);

    const answers = [];
    for (const key of ['window-a', 'window-b']) {
      answers.push(await app.interactions.resolveAskUser({
        source: { kind: 'command', key: `answer-${key}` },
        requestId: pause.requestId,
        response: { answer: { selectedOptionIndexes: [], customText: key } }
      }));
    }
    assert.deepEqual(answers.map((answer) => answer.won), [true, false], '另一窗口的后到回答不得再次生效');
    assert.equal((await rows(app, 'InteractionResponse', { request_id: pause.requestId })).length, 1);
    assert.deepEqual(await readPendingInteractionAttention(app.database, hostBootId), []);
  } finally {
    if (app) await app.close().catch(() => undefined);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

}

async function runRecoveryWorker() {
  const dataRoot = requiredEnv('LIMCODE_ELIGIBILITY_DATA_ROOT');
  const gatePath = requiredEnv('LIMCODE_ELIGIBILITY_GATE');
  let providerCalls = 0;
  const provider = {
    providerId: PROVIDER_ID,
    async sendFullRequest(_request, controls) {
      providerCalls += 1;
      await waitForFile(gatePath, 300_000);
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: '已接上' }] } });
    }
  };
  const host = await openHost(dataRoot, provider, {
    folders: JSON.parse(requiredEnv('LIMCODE_ELIGIBILITY_FOLDERS')),
    label: 'race-window'
  });
  try {
    await fs.writeFile(requiredEnv('LIMCODE_ELIGIBILITY_READY'), `${process.pid}\n`, 'utf8');
    await waitForFile(requiredEnv('LIMCODE_ELIGIBILITY_GO'), 300_000);
    await host.app.recover();
    const report = await host.runner.recoverStartup();
    await writeJson(requiredEnv('LIMCODE_ELIGIBILITY_REPORT'), report);
    await waitForFile(requiredEnv('LIMCODE_ELIGIBILITY_FINISH'), 300_000);
    await host.runner.waitForIdle();
    await writeJson(requiredEnv('LIMCODE_ELIGIBILITY_RESULT'), {
      providerCalls,
      runnerErrors: host.runnerErrors.map((entry) => String(entry.error?.stack ?? entry.error))
    });
  } finally {
    await host.close();
  }
}

/** Starts a Turn in a window serving `project`, waits for its lease, then closes that window. */
async function startTurnThenCloseHost(dataRoot, conversationId, project) {
  const provider = gatedProvider();
  const origin = await openHost(dataRoot, provider, { folders: [project.uri], label: 'origin-window' });
  try {
    await createConversation(origin.app, conversationId, project);
    const started = await origin.runner.input({ commandId: `input-${conversationId}`, conversationId, text: '开始执行' });
    await provider.started;
    await eventually(async () => (await rows(origin.app, 'ExecutionLease', { turn_id: started.turnId })).length === 1,
      30_000, 'Turn 未建立 ExecutionLease');
    return started.turnId;
  } finally {
    await origin.close();
  }
}

async function openHost(dataRoot, provider, options) {
  const folders = [...options.folders];
  const environments = (options.environments ?? []).map((environment) => ({ ...environment }));
  const app = await kernel.ReliableKernelApplication.open(
    new kernel.RootAuthority(() => dataRoot),
    fixtureDependencies(provider, options.defaultWorkEnvironmentId ?? null)
  );
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
    workEnvironments: async () => environments
  }, conversationId);
  app.database.conversationOwners.setClaimEligibilityProbe(async (conversationId) =>
    (await eligibility(conversationId)).eligible);
  let closed = false;
  return {
    app,
    runner,
    runnerErrors,
    folders,
    environments,
    eligibility,
    owns: (conversationId) => app.database.conversationOwners.owns(conversationId),
    async close() {
      if (closed) return;
      closed = true;
      runner.dispose();
      await app.beginHandoff().catch(() => undefined);
      await runner.waitForIdle().catch(() => undefined);
      await app.close();
    }
  };
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
    ...(project ? projectFolderAssignmentSteps({ conversationId, folder: project, now }) : [])
  ]);
}

function gatedProvider() {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  return {
    providerId: PROVIDER_ID,
    started,
    release: () => release(),
    get calls() { return calls; },
    async sendFullRequest(_request, controls) {
      calls += 1;
      markStarted();
      await new Promise((resolve, reject) => {
        const signal = controls.signal;
        const onAbort = () => reject(signal.reason ?? new Error('aborted'));
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        void gate.then(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        });
      });
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: '完成' }] } });
    }
  };
}

function fixtureDependencies(provider, defaultWorkEnvironmentId) {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: {
            content: JSON.stringify({ providerConfigId: provider.providerId, modelId: 'eligibility-model' })
          },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: {
                providerConfigId: provider.providerId,
                provider: 'fixture',
                modelId: 'eligibility-model',
                retryPolicy: { enabled: false, maxRetries: 0 }
              },
              modelProfile: {
                compressionThresholdTokens: 100_000,
                contextWindowTokens: 128_000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              toolPolicy: { id: 'eligibility-tools', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
              systemPrompt: { id: 'eligibility-prompt', text: '' },
              runtimeContext: { id: null, name: '', template: '' },
              workEnvironmentPolicy: {
                id: null,
                enabled: false,
                allowedWorkEnvironmentIds: defaultWorkEnvironmentId ? [defaultWorkEnvironmentId] : [],
                defaultWorkEnvironmentId
              }
            })
          }
        };
      }
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
          definitions() { return []; },
          async cancelTurnWaits() {},
          async dispose() {}
        }
      })
  };
}

async function createIsolatedRoot(label) {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-eligibility-${label}-`));
  await fs.mkdir(path.join(outer, 'control'), { recursive: true });
  const candidate = await kernel.resetCandidateRuntimeRoot(path.join(outer, 'control'));
  return { outer, dataRoot: candidate.binding.paths.dataRootPath };
}

async function ownerRecordExists(dataRoot, conversationId) {
  const binding = await new kernel.RootAuthority(() => dataRoot).current();
  const claimPath = conversationRuntimeOwnerClaimPath(binding.paths, conversationId);
  return fs.access(path.join(claimPath, 'owner.json')).then(() => true, () => false);
}

async function rows(appOrDatabase, domain, where = {}) {
  const database = appOrDatabase.database ?? appOrDatabase;
  return (await database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 1_000
  }))).snapshot;
}

function spawnWorker(dataRoot, environment) {
  return childProcess.spawn(process.execPath, [TEST_FILE], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...environment,
      LIMCODE_ELIGIBILITY_WORKER: 'recoverer',
      LIMCODE_ELIGIBILITY_DATA_ROOT: dataRoot
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
}

function waitForExit(child, timeoutMs, rejectNonZero = false) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const settle = (code, signal) => {
      if (rejectNonZero && code !== 0) {
        reject(new Error(`eligibility worker failed (code=${code}, signal=${signal})\n${stdout}\n${stderr}`));
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
      reject(new Error(`eligibility worker timed out after ${timeoutMs}ms\n${stdout}\n${stderr}`));
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

async function waitForJson(filePath, timeoutMs) {
  await waitForFile(filePath, timeoutMs);
  return readJson(filePath);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
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
