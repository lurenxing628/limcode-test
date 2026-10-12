import { createOwnershipScope } from './ownership-scope-fixture.mjs';
// Focused production ownership boundary; old review matrices are absent.
import assert from 'node:assert/strict';

import childProcess from 'node:child_process';

import fs from 'node:fs/promises';

import { createRequire } from 'node:module';

import os from 'node:os';

import path from 'node:path';

import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const Module = require('node:module');

const originalLoad = Module._load;

const informationMessages = [];

class StubEventEmitter {
  listeners = new Set();
  event = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}

class StubUri {
  constructor(fsPath) { this.fsPath = fsPath; this.path = fsPath; this.scheme = 'file'; this.authority = ''; }
  static file(fsPath) { return new StubUri(fsPath); }
  static joinPath(base, ...parts) { return new StubUri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.fsPath}`; }
}

const vscodeStub = {
  Uri: StubUri,
  EventEmitter: StubEventEmitter,
  ViewColumn: { One: 1 },
  workspace: { workspaceFolders: [] },
  window: {
    async showInformationMessage(message) { informationMessages.push(message); },
    async showWarningMessage() {},
    async showErrorMessage() {},
    registerWebviewPanelSerializer() { return { dispose() {} }; }
  }
};

Module._load = function load(request, parent, isMain) {
  return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain);
};

const root = process.cwd();

const compiled = (relative) => path.join(root, 'dist/extension', relative);

const load = (relative) => import(pathToFileURL(compiled(relative)).href);

const kernel = await load('backend/reliableKernel/index.js');

const { emptyConversationContextHandleStateStep } = await load('backend/reliableKernel/conversationContextHandleState.js');

const { captureFilePlanningRoot } = await load('backend/reliableKernel/fileTargetBoundary.js');

const { ReliableConversationRunner } = await load('backend/application/reliableKernel/ReliableConversationRunner.js');

const {
  conversationHostIneligibleMessage,
  createDiagnosedConversationHostEligibility,
  evaluateConversationHostEligibility,
  viewConversationHostEligibility
} = await load('backend/application/reliableKernel/conversationHostEligibility.js');

const { readPendingInteractionAttention, InteractionLeaseEdgeTracker } = await load(
  'backend/application/reliableKernel/interactionAttention.js'
);

const { projectFolderAssignmentSteps } = await load('backend/reliableKernel/conversationProject.js');

const { conversationRuntimeOwnerClaimPath } = await load('backend/reliableKernel/ConversationRuntimeOwnerManager.js');

const { askUserTool } = await load('backend/world/modules/tools/definitions/askUser/index.js');

const { ConversationOwnershipGate } = await load('backend/reliableKernel/conversationOwnershipGate.js');

const { createRuntimeDeliveryWakeHandler } = await load('backend/application/reliableKernel/runtimeDeliveryWakeHandler.js');

const { writeTool } = await load('backend/world/modules/tools/definitions/write/index.js');

const { VscodeReliableKernelCommandRouter } = require(compiled('backend/application/reliableKernel/VscodeReliableKernelCommandRouter.js'));

const { BridgeMessageType } = require(compiled('shared/protocol.js'));

const { EXTENSION_BRAND } = require(compiled('shared/extensionIdentity.js'));

const PROVIDER_ID = 'eligibility-provider';

const PROJECT_ONE = 'file:///workspace/project-one';

const PROJECT_TWO = 'file:///workspace/project-two';

const PROJECT_TWO_FOLDER = { uri: PROJECT_TWO, name: '项目二' };

const TEST_FILE = fileURLToPath(import.meta.url);

const workerMode = process.env.LIMCODE_ELIGIBILITY_WORKER;

async function runWorker(mode) {
  const dataRoot = requiredEnv('LIMCODE_ELIGIBILITY_DATA_ROOT');
  const conversationId = requiredEnv('LIMCODE_ELIGIBILITY_CONVERSATION');
  if (mode === 'origin') {
    const provider = gatedProvider();
    const host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'origin' });
    try {
      await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
      const started = await host.runner.input({ commandId: `input-${conversationId}`, conversationId, text: '开始' });
      await provider.started;
      await writeJson(requiredEnv('LIMCODE_ELIGIBILITY_READY'), { turnId: started.turnId });
      await waitForFile(requiredEnv('LIMCODE_ELIGIBILITY_FINISH'), 300_000);
    } finally {
      await host.close();
    }
    return;
  }
  if (mode === 'n3-p2') {
    const provider = scriptedProvider([{ role: 'model', parts: [{ text: '按回答继续。' }] }]);
    const host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'p2-already-open', askUser: true });
    try {
      await host.app.recover();
      await host.runner.recoverStartup();
      await writeJson(requiredEnv('LIMCODE_ELIGIBILITY_READY'), {});
      const { turnId } = await waitForJson(requiredEnv('N3_ANSWERED'), 300_000);
      // VscodeReliableKernelProductRuntime 的 ExternalDataVersionWatcher 在外部提交后的调用。
      for (let i = 0; i < 10; i += 1) {
        await host.app.refreshExternalRuntimeWork();
        host.runner.recoverUnheldTurns();
        await sleep(500);
      }
      const callsAfterFiveSeconds = provider.calls;
      const turnAfterFiveSeconds = (await rows(host.app, 'Turn', { id: turnId }))[0]?.status;
      const scoped = await host.runner.recoverStartup(undefined, conversationId);
      await eventually(async () => (await rows(host.app, 'Turn', { id: turnId }))[0]?.status === 'terminated', 30_000, 'P2 未完成');
      await writeJson(requiredEnv('LIMCODE_ELIGIBILITY_RESULT'), {
        callsAfterFiveSeconds, turnAfterFiveSeconds, scopedResumed: scoped.resumedTurnIds,
        finalStatus: (await rows(host.app, 'Turn', { id: turnId }))[0]?.status
      });
    } finally {
      await host.close();
    }
    return;
  }
  if (mode === 'n8-stop-fault') {
    const provider = gatedProvider();
    const host = await openHost(dataRoot, provider, { folders: [PROJECT_ONE], label: 'p1' });
    try {
      await host.app.recover();
      await host.runner.recoverStartup();
      const turnId = requiredEnv('LIMCODE_ELIGIBILITY_TURN');
      const original = host.app.agentLoop.terminateRequested.bind(host.app.agentLoop);
      let failures = 0;
      host.app.agentLoop.terminateRequested = async (id) => {
        if (failures === 0) { failures += 1; throw new Error('模拟：收尾过程中的一次性失败'); }
        return original(id);
      };
      const lease = (await rows(host.app, 'ExecutionLease', { turn_id: turnId }))[0];
      await host.runner.interrupt({ commandId: 'n8-stop', conversationId, turnId,
        expectedLeaseGeneration: String(lease.generation), reason: '停止' });
      const leaseAfter = (await rows(host.app, 'ExecutionLease', { turn_id: turnId }))[0];
      // 故障只注入一次；之后把 30 秒复查推迟到测试结束（避免 P1 自己在观察窗口内收尾）。
      host.app.agentLoop.terminateRequested = async () => { throw new Error('模拟：持续失败'); };
      await writeJson(requiredEnv('LIMCODE_ELIGIBILITY_READY'), {
        turnAfterStop: (await rows(host.app, 'Turn', { id: turnId }))[0]?.status,
        ownsAfterStop: host.owns(conversationId),
        leaseOnP1: leaseAfter?.host_boot_id === host.app.database.hostBootId,
        leaseOwner: leaseAfter?.owner_id,
        errors: host.runnerErrors.map((e) => String(e.error?.message ?? e.error))
      });
      await waitForFile(requiredEnv('LIMCODE_ELIGIBILITY_FINISH'), 300_000);
    } finally {
      await host.close();
    }
    return;
  }
  if (mode === 'n5-writer') {
    const host = await openHost(dataRoot, gatedProvider(), { folders: [PROJECT_ONE], label: 'writer' });
    try {
      await createConversation(host.app, conversationId, null);
      await writeJson(requiredEnv('LIMCODE_ELIGIBILITY_READY'), {});
      const finish = requiredEnv('LIMCODE_ELIGIBILITY_FINISH');
      for (let i = 0; ; i += 1) {
        try { await fs.access(finish); break; } catch { /* keep writing */ }
        await host.app.database.transaction([kernel.DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, {
          title: `t${i}`, updated_at: new Date().toISOString()
        })]);
        await sleep(100);
      }
    } finally {
      await host.close();
    }
    return;
  }
  const provider = gatedProvider();
  const host = await openHost(dataRoot, provider, { folders: [PROJECT_ONE], label: 'p1' });
  try {
    await host.app.recover();
    const report = await host.runner.recoverStartup();
    if (mode === 'r1-rename') {
      await host.app.database.conversationOwners.run(conversationId, () => host.app.database.transaction([
        kernel.DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { title: '改个名字', updated_at: new Date().toISOString() })
      ]));
      await writeJson(requiredEnv('LIMCODE_ELIGIBILITY_READY'), { report, ownsAfterRename: host.owns(conversationId) });
    } else {
      throw new Error(`Unknown worker ${mode}`);
    }
    await waitForFile(requiredEnv('LIMCODE_ELIGIBILITY_FINISH'), 300_000);
    await host.runner.waitForIdle();
    await writeJson(requiredEnv('LIMCODE_ELIGIBILITY_RESULT'), {
      providerCalls: provider.calls,
      ownsAtFinish: host.owns(conversationId),
      runnerErrors: host.runnerErrors.map((entry) => String(entry.error?.stack ?? entry.error))
    });
  } finally {
    await host.close();
  }
}

async function openHost(dataRoot, provider, options) {
  const folders = [...options.folders];
  const environments = (options.environments ?? []).map((environment) => ({ ...environment }));
  const app = await kernel.ReliableKernelApplication.open(
    new kernel.RootAuthority(() => dataRoot),
    fixtureDependencies(provider, options.defaultWorkEnvironmentId ?? null, {
      askUser: options.askUser === true,
      fileWrite: options.fileWrite === true
    })
  );
  const runnerErrors = [];
  const runner = new ReliableConversationRunner(
    app,
    `${options.label}:${app.database.hostBootId}`,
    (error, context) => runnerErrors.push({ error, context }),
    undefined,
    options.diagnostics
  );
  let failProbe = false;
  // Same wiring as VscodeReliableKernelProductRuntime: the diagnosed decision is the claim probe.
  const eligibility = createDiagnosedConversationHostEligibility(async (conversationId) => {
    if (failProbe) throw Object.assign(new Error('工作环境目录暂时读取失败'), { name: 'TransientProbeError' });
    return evaluateConversationHostEligibility({
      database: app.database,
      contentStore: app.contentStore,
      workspaceFolderUris: () => folders,
      workEnvironments: async () => environments
    }, conversationId);
  }, options.diagnostics);
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
    get failProbe() { return failProbe; },
    set failProbe(value) { failProbe = value; },
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
    emptyConversationContextHandleStateStep(conversationId, now),
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

function fixtureDependencies(provider, defaultWorkEnvironmentId, tools = {}) {
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
              toolPolicy: {
                id: 'eligibility-tools',
                allowedTools: [...(tools.askUser ? ['ask_user'] : []), ...(tools.fileWrite ? ['write'] : [])],
                preset: 'custom',
                toolConfigs: {},
                sourceConfigs: {}
              },
              planReviewPolicy: { mode: 'optional' },
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
          definitions() { return [...(tools.askUser ? [askUserTool] : []), ...(tools.fileWrite ? [writeTool] : [])]; },
          // A write proposes one file change that waits for the user's approval.
          async planFileMutation(_definition, input) {
            return [{ operation: 'create_file', workEnvironmentId: 'work-env-test', planningRoot: await captureFilePlanningRoot(database.binding.paths.dataRootPath), targetPath: `${input.toolCallId}.txt`, targetContent: 'x' }];
          },
          async cancelTurnWaits() {},
          async dispose() {}
        }
      })
  };
}

async function createIsolatedRoot(label) {
  return createOwnershipScope(label);
}

async function rows(appOrDatabase, domain, where = {}) {
  const database = appOrDatabase.database ?? appOrDatabase;
  return (await database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 1_000
  }))).snapshot;
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

if (workerMode) runWorker(workerMode).then(() => process.exit(0), error => { console.error(error?.stack ?? error); process.exit(1); });

export const scenario1 = async () => {
  const { outer, dataRoot } = await createIsolatedRoot('n10');
  let host;
  try {
    let release; const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0; let started; const firstStarted = new Promise((resolve) => { started = resolve; });
    const eligibilityAtCall = [];
    let hostRef;
    const provider = {
      providerId: PROVIDER_ID,
      async sendFullRequest(_request, controls) {
        calls += 1;
        eligibilityAtCall.push(await hostRef.app.database.conversationOwners.executionEligibility('conversation-n10'));
        if (calls === 1) {
          started();
          await gate;
          await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ id: 'c1', functionCall: { name: 'not_a_real_tool', args: {} } }] } });
          return;
        }
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: '第二轮' }] } });
      }
    };
    host = await openHost(dataRoot, provider, { folders: [PROJECT_ONE, PROJECT_TWO], label: 'multi-root' });
    hostRef = host;
    await createConversation(host.app, 'conversation-n10', PROJECT_TWO_FOLDER);
    const turn = await host.runner.input({ commandId: 'n10', conversationId: 'conversation-n10', text: '开始' });
    await firstStarted;
    host.folders.splice(host.folders.indexOf(PROJECT_TWO), 1);
    const rescan = await host.runner.rescan();
    console.log('[N10] rescan', JSON.stringify(rescan));
    release();
    await eventually(async () => (await rows(host.app, 'ExecutionLease', { turn_id: turn.turnId }))[0]?.owner_id
      === kernel.RELEASED_EXECUTION_LEASE_HOLDER, 30_000, '租约未交还');
    await host.runner.waitForIdle();
    assert.equal(calls, 1, '文件夹移除后不再发起模型调用');
    assert.equal((await rows(host.app, 'Turn', { id: turn.turnId }))[0]?.status, 'active', 'Turn 停在轮次之间，不被终止');
    assert.deepEqual((await rows(host.app, 'ToolCall', { turn_id: turn.turnId })).map((r) => r.status), ['terminal'],
      '正在执行的工具先完成，不被打断');
    assert.equal(host.owns('conversation-n10'), false, '归属也已交还');
    host.folders.push(PROJECT_TWO);
    await host.runner.rescan();
    await eventually(async () => (await rows(host.app, 'Turn', { id: turn.turnId }))[0]?.status === 'terminated', 30_000, 'Turn 未接着执行');
    assert.equal(calls, 2);
    assert.deepEqual(eligibilityAtCall, ['eligible', 'eligible']);
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
};
