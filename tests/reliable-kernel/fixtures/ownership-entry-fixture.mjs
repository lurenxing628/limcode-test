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
  workspace: { workspaceFolders: [], onDidChangeWorkspaceFolders: () => ({ dispose() {} }) },
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
const { claimGenerationPath } = await load('backend/reliableKernel/runtimeClaimPrimitives.js');

const { askUserTool } = await load('backend/world/modules/tools/definitions/askUser/index.js');

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
  if (mode === 'recoverer') {
    await runRecoveryWorker(dataRoot);
    return;
  }
  if (mode === 'live-owner-controls') {
    await runLiveOwnerControlsWorker(dataRoot);
    return;
  }
  const conversationId = requiredEnv('LIMCODE_ELIGIBILITY_CONVERSATION');
  if (mode === 'origin') {
    const provider = gatedProvider();
    const host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'origin' });
    try {
      await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
      const started = await host.runner.input({ commandId: `input-${conversationId}`, conversationId, text: '开始' });
      await provider.started;
      const owner = JSON.parse(await fs.readFile(path.join(conversationRuntimeOwnerClaimPath(host.app.database.binding.paths, conversationId), 'owner.json'), 'utf8'));
      await writeJson(requiredEnv('LIMCODE_ELIGIBILITY_READY'), { turnId: started.turnId, ownerToken: owner.ownerToken, hostBootId: host.app.database.hostBootId });
      await waitForFile(requiredEnv('LIMCODE_ELIGIBILITY_FINISH'), 300_000);
    } finally {
      await host.close();
    }
    return;
  }
  const provider = gatedProvider();
  const host = await openHost(dataRoot, provider, { folders: [PROJECT_ONE], label: 'p1', askUser: mode === 'answer-p1' });
  try {
    await host.app.recover();
    const report = await host.runner.recoverStartup();
    let ready;
    if (mode === 'control-p1') {
      // VscodeReliableKernelApplicationFacade.renameConversationTitle
      await host.app.database.conversationOwners.run(conversationId, () => host.app.database.transaction([
        kernel.DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, {
          title: '改个名字', updated_at: new Date().toISOString()
        })
      ]));
      const ownsAfterRename = host.owns(conversationId);
      const ownerRecordAfterRename = await ownerRecordExists(dataRoot, conversationId);
      const intentsBefore = (await rows(host.app, 'TurnIntent', { conversation_id: conversationId })).length;
      let inputRejection = null;
      try {
        await createRouter(host).dispatch('p1-client', webview([]), {
          id: 'p1-input',
          type: BridgeMessageType.TurnStart,
          channel: 'command',
          payload: {
            conversationId,
            command: { commandId: 'p1-input', expectedVersion: 0, issuedAt: Date.now() },
            text: '在其它项目窗口发的新消息'
          }
        });
      } catch (error) {
        inputRejection = error instanceof Error ? error.message : String(error);
      }
      ready = {
        report,
        title: (await rows(host.app, 'Conversation', { id: conversationId }))[0]?.title,
        ownsAfterRename,
        ownerRecordAfterRename,
        inputRejection,
        intentsBefore,
        intentsAfter: (await rows(host.app, 'TurnIntent', { conversation_id: conversationId })).length,
        ownsAfterInput: host.owns(conversationId)
      };
    } else if (mode === 'answer-p1') {
      const turnId = requiredEnv('LIMCODE_ELIGIBILITY_TURN');
      const requestId = requiredEnv('LIMCODE_ELIGIBILITY_REQUEST');
      const posted = [];
      await createRouter(host).dispatch('p1-client', webview(posted), {
        id: 'p1-answer',
        type: BridgeMessageType.InteractionResolve,
        channel: 'command',
        payload: {
          conversationId,
          interactionRequestId: requestId,
          interactionRevision: 1,
          ownerTurnId: turnId,
          decision: 'submit',
          response: { answer: { selectedOptionIndexes: [0], customText: '' } }
        }
      });
      // The router nudges the owner with setImmediate; give any (wrong) resume time to drive.
      await sleep(1_500);
      const lease = (await rows(host.app, 'ExecutionLease', { turn_id: turnId }))[0];
      ready = {
        report,
        postedStatuses: posted
          .filter((message) => message.type === BridgeMessageType.InteractionResult)
          .map((message) => message.payload.status),
        responses: (await rows(host.app, 'InteractionResponse', { request_id: requestId })).length,
        informationMessages: [...informationMessages],
        providerCalls: provider.calls,
        ownsAfterAnswer: host.owns(conversationId),
        leaseOnP1: lease?.host_boot_id === host.app.database.hostBootId,
        turnStatus: (await rows(host.app, 'Turn', { id: turnId }))[0]?.status
      };
    } else if (mode === 'stop-p1') {
      const turnId = requiredEnv('LIMCODE_ELIGIBILITY_TURN');
      let deleteBeforeStop = null;
      try {
        await deleteConversation(host, conversationId);
      } catch (error) {
        deleteBeforeStop = error instanceof Error ? error.message : String(error);
      }
      const ownsAfterFailedDelete = host.owns(conversationId);
      const lease = (await rows(host.app, 'ExecutionLease', { turn_id: turnId }))[0];
      // VscodeReliableKernelApplicationFacade.abortConversation
      await host.runner.interrupt({
        commandId: 'p1-stop',
        conversationId,
        turnId,
        expectedLeaseGeneration: String(lease.generation),
        reason: '用户在其它项目窗口停止'
      });
      const turnAfterStop = (await rows(host.app, 'Turn', { id: turnId }))[0]?.status;
      const termination = (await rows(host.app, 'TurnTermination', { turn_id: turnId }))[0];
      const ownsAfterStop = host.owns(conversationId);
      const deleted = await deleteConversation(host, conversationId)
        .catch((error) => ({ deletedConversationIds: String(error?.message ?? error) }));
      const orphanDeleted = await deleteConversation(host, 'conversation-orphan')
        .catch((error) => ({ deletedConversationIds: String(error?.message ?? error) }));
      ready = {
        report,
        deleteBeforeStop,
        ownsAfterFailedDelete,
        turnAfterStop,
        terminationStatus: termination?.terminal_status,
        ownsAfterStop,
        deleted: deleted?.deletedConversationIds,
        orphanDeleted: orphanDeleted?.deletedConversationIds,
        ownsAfterDelete: host.owns(conversationId),
        providerCalls: provider.calls
      };
    } else {
      throw new Error(`Unknown eligibility worker ${mode}.`);
    }
    await writeJson(requiredEnv('LIMCODE_ELIGIBILITY_READY'), ready);
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

async function runLiveOwnerControlsWorker(dataRoot) {
  const { conversationId, turnId, leaseId, ownerHostBootId, cases } = await readJson(requiredEnv('LIMCODE_ELIGIBILITY_DESCRIPTOR'));
  const provider = gatedProvider();
  const host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'control-peer' });
  try {
    const ownerAlive = await host.app.database.isHostAlive(ownerHostBootId);
    assert.equal(ownerAlive, true);
    const ownerPath = path.join(conversationRuntimeOwnerClaimPath(host.app.database.binding.paths, conversationId), 'owner.json');
    const ownerRecord = await fs.readFile(ownerPath, 'utf8');
    const lease = (await rows(host.app, 'ExecutionLease', { id: leaseId }))[0];
    assert.equal(lease?.host_boot_id, ownerHostBootId);
    const router = createRouter(host);
    const posted = [];
    const completedKinds = [];
    for (const entry of cases) {
      const dispatch = (suffix, decision, response) => router.dispatch('control-peer-client', webview(posted), {
        id: `${entry.toolCallId}:${suffix}`, type: BridgeMessageType.InteractionResolve, channel: 'command',
        payload: { conversationId, interactionRequestId: entry.requestId, interactionRevision: 1,
          ownerTurnId: turnId, decision, response }
      });
      await dispatch('first', entry.decision, entry.response);
      assert.equal(posted.at(-1)?.payload.status, 'committed', `${entry.kind} 在存活 peer 持有时仍能记录决定`);
      const response = (await rows(host.app, 'InteractionResponse', { request_id: entry.requestId }))[0];
      const outcome = (await rows(host.app, 'ToolOutcome', { tool_call_id: entry.toolCallId }))[0];
      const modelResult = (await rows(host.app, 'ToolModelResult', { tool_call_id: entry.toolCallId }))[0];
      assert.equal((await rows(host.app, 'InteractionRequest', { id: entry.requestId }))[0]?.status, entry.status);
      assert.equal(outcome?.status, entry.status);
      assert.ok(response && modelResult, `${entry.kind} 的真实首答和模型结果必须落库`);
      assert.equal((await rows(host.app, 'ToolCall', { id: entry.toolCallId }))[0]?.status, 'terminal');
      await dispatch('late', entry.laterDecision, entry.laterResponse);
      assert.equal(posted.at(-1)?.payload.status, 'already_resolved');
      assert.deepEqual(await rows(host.app, 'InteractionResponse', { request_id: entry.requestId }), [response]);
      assert.deepEqual(await rows(host.app, 'ToolOutcome', { tool_call_id: entry.toolCallId }), [outcome]);
      assert.deepEqual(await rows(host.app, 'ToolModelResult', { tool_call_id: entry.toolCallId }), [modelResult]);
      assert.equal(host.owns(conversationId), false);
      assert.equal(await fs.readFile(ownerPath, 'utf8'), ownerRecord, '记录与重放回答不改变 A 的归属文件');
      assert.deepEqual(await rows(host.app, 'ExecutionLease', { id: leaseId }), [lease], '不接管、不续租 A 的执行租约');
      completedKinds.push(entry.kind);
    }
    // 让路由的 setImmediate 续跑提示走过真实 Runner 的 owner 判定。
    await sleep(50);
    await host.runner.waitForIdle();
    assert.equal(provider.calls, 0);
    assert.equal(host.owns(conversationId), false);
    assert.equal(await fs.readFile(ownerPath, 'utf8'), ownerRecord);
    assert.deepEqual(await rows(host.app, 'ExecutionLease', { id: leaseId }), [lease]);
    assert.deepEqual(await rows(host.app, 'EffectIntent'), []);
    assert.deepEqual(await rows(host.app, 'ChildExecution'), []);
    await writeJson(requiredEnv('LIMCODE_ELIGIBILITY_READY'), {
      ownerAlive, completedKinds, postedStatuses: posted.map(message => message.payload.status),
      providerCalls: provider.calls, owns: host.owns(conversationId)
    });
    await waitForFile(requiredEnv('LIMCODE_ELIGIBILITY_FINISH'), 300_000);
    await host.runner.waitForIdle();
    await writeJson(requiredEnv('LIMCODE_ELIGIBILITY_RESULT'), {
      providerCalls: provider.calls, ownsAtFinish: host.owns(conversationId),
      runnerErrors: host.runnerErrors.map(entry => String(entry.error?.stack ?? entry.error))
    });
  } finally {
    await host.close();
  }
}

async function runRecoveryWorker(dataRoot) {
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

function deleteConversation(host, conversationId) {
  return host.app.database.conversationOwners.run(conversationId, () =>
    host.app.conversationDeletion.delete(conversationId));
}

function createRouter(host) {
  return new VscodeReliableKernelCommandRouter({
    debugCapture: { setListener() {} },
    toolHost: { setStateChangeListener() {} },
    application: host.app,
    conversations: host.runner,
    childAgents: { async resume() { return false; } },
    async ensureCapabilitiesReady() {},
    conversationHostEligibility: (conversationId) => viewConversationHostEligibility(host.eligibility, conversationId)
  });
}


async function openHost(dataRoot, provider, options) {
  const folders = [...options.folders];
  const environments = (options.environments ?? []).map((environment) => ({ ...environment }));
  const app = await kernel.ReliableKernelApplication.open(
    new kernel.RootAuthority(() => dataRoot),
    fixtureDependencies(provider, options.defaultWorkEnvironmentId ?? null, { askUser: options.askUser === true })
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
                allowedTools: tools.askUser ? ['ask_user'] : [],
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
          definitions() { return tools.askUser ? [askUserTool] : []; },
          async cancelTurnWaits() {},
          async dispose() {}
        }
      })
  };
}

async function createIsolatedRoot(label) {
  return createOwnershipScope(label);
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

function workerFiles(outer, name) {
  const files = {
    ready: path.join(outer, `${name}-ready.json`),
    finish: path.join(outer, `${name}-finish`),
    result: path.join(outer, `${name}-result.json`)
  };
  return {
    ...files,
    env: {
      LIMCODE_ELIGIBILITY_READY: files.ready,
      LIMCODE_ELIGIBILITY_FINISH: files.finish,
      LIMCODE_ELIGIBILITY_RESULT: files.result
    }
  };
}

function spawnWorker(dataRoot, mode, environment) {
  const child = childProcess.spawn(process.execPath, [TEST_FILE], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...environment,
      LIMCODE_ELIGIBILITY_WORKER: mode,
      LIMCODE_ELIGIBILITY_DATA_ROOT: dataRoot
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
      return await readJson(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`eligibility worker exited before ${path.basename(filePath)} (code=${child.exitCode})\n${child.output.stdout}\n${child.output.stderr}`);
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
        reject(new Error(`eligibility worker failed (code=${code}, signal=${signal})\n${child.output?.stdout ?? ''}\n${child.output?.stderr ?? ''}`));
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
      reject(new Error(`eligibility worker timed out after ${timeoutMs}ms\n${child.output?.stdout ?? ''}\n${child.output?.stderr ?? ''}`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      settle(code, signal);
    });
  });
}

function webview(posted) {
  return {
    async postMessage(message) {
      posted.push(message);
      return true;
    }
  };
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
  const { outer, dataRoot } = await createIsolatedRoot('decisions');
  let host;
  try {
    const provider = gatedProvider();
    host = await openHost(dataRoot, provider, {
      folders: [],
      label: 'decision-window',
      defaultWorkEnvironmentId: 'env-frozen',
      environments: [{ id: 'env-frozen', available: true }]
    });
    const bound = 'conversation-bound';
    const unbound = 'conversation-unbound';
    const idle = 'conversation-idle';
    await createConversation(host.app, bound, PROJECT_TWO_FOLDER);
    await createConversation(host.app, unbound);
    await createConversation(host.app, idle);
    const owners = host.app.database.conversationOwners;

    assert.deepEqual(await host.eligibility(bound), {
      eligible: false, reason: 'project_not_open', projectUri: PROJECT_TWO, projectName: '项目二'
    });
    await assert.rejects(host.runner.input({ commandId: 'bound-input', conversationId: bound, text: '开始' }),
      (error) => error.code === 'conversation-host-ineligible' && error.eligibility === 'ineligible');
    assert.equal((await rows(host.app, 'TurnIntent', { conversation_id: bound })).length, 0, '被拒绝的输入不得写入');
    assert.equal(host.owns(bound), false);
    host.folders.push(PROJECT_TWO);
    assert.deepEqual(await host.eligibility(bound), { eligible: true });
    assert.deepEqual(await host.eligibility(idle), { eligible: true });

    // 资格探针出错是"未知"，从不当作合格。
    host.failProbe = true;
    assert.equal(await owners.executionEligibility(idle), 'unknown');
    await assert.rejects(host.runner.input({ commandId: 'idle-input', conversationId: idle, text: '开始' }),
      (error) => error.code === 'conversation-host-ineligible' && error.eligibility === 'unknown');
    assert.equal((await rows(host.app, 'TurnIntent', { conversation_id: idle })).length, 0);
    host.failProbe = false;

    // 活动 Turn 冻结的默认工作环境在本窗口消失后，已持有归属也不代表可以执行。
    const started = await host.runner.input({ commandId: 'unbound-input', conversationId: unbound, text: '开始' });
    await provider.started;
    host.environments[0].available = false;
    assert.deepEqual(await host.eligibility(unbound), {
      eligible: false, reason: 'work_environment_unavailable', turnId: started.turnId, workEnvironmentId: 'env-frozen'
    });
    assert.equal(host.owns(unbound), true, '正在本窗口运行的 Turn 仍由本窗口持有');
    assert.equal(await owners.executionEligibility(unbound), 'ineligible');
    assert.equal(await owners.tryClaimEligible(unbound), 'ineligible');
    const intentsBefore = (await rows(host.app, 'TurnIntent', { conversation_id: unbound })).length;
    await assert.rejects(host.runner.input({ commandId: 'unbound-input-2', conversationId: unbound, text: '再来' }),
      (error) => error.code === 'conversation-host-ineligible');
    assert.equal((await rows(host.app, 'TurnIntent', { conversation_id: unbound })).length, intentsBefore);
    host.environments[0].available = true;
    assert.deepEqual(await host.eligibility(unbound), { eligible: true });
    provider.release();
    await eventually(async () => (await rows(host.app, 'Turn', { id: started.turnId }))[0]?.status === 'terminated',
      60_000, '已开始的 Turn 未完成');

    // 认领之后原子复核：资格在检查与认领之间消失时，刚认领的归属立即交还，即使对话仍有工作。
    const now = new Date().toISOString();
    await host.app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: 'turn-toctou', conversation_id: bound, status: 'active', created_at: now, updated_at: now, terminal_at: null
      })
    ]);
    let probeCalls = 0;
    owners.setClaimEligibilityProbe(async () => (probeCalls += 1) === 1);
    assert.equal(await owners.tryClaimEligible(bound), 'ineligible');
    assert.equal(host.owns(bound), false);
    assert.equal(await ownerRecordExists(dataRoot, bound), false);
    owners.setClaimEligibilityProbe(async (conversationId) => (await host.eligibility(conversationId)).eligible);
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
};

export const scenario2 = async () => {
  const { outer, dataRoot } = await createIsolatedRoot('live-owner-controls');
  let owner;
  let peer;
  try {
    const ownerProvider = gatedProvider();
    owner = await openHost(dataRoot, ownerProvider, { folders: [PROJECT_TWO], label: 'control-owner' });
    const conversationId = 'conversation-live-owner-controls';
    const turnId = 'turn-live-owner-controls';
    const leaseId = 'lease-live-owner-controls';
    await createConversation(owner.app, conversationId, PROJECT_TWO_FOLDER);
    const now = new Date().toISOString();
    await owner.app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: turnId, conversation_id: conversationId, status: 'active', created_at: now, updated_at: now, terminal_at: null
      }),
      kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
        id: leaseId, conversation_id: conversationId, turn_id: turnId, owner_id: 'live-control-owner',
        host_boot_id: owner.app.database.hostBootId, generation: 3n, acquired_at: now,
        expires_at: new Date(Date.now() + 120_000).toISOString()
      })
    ]);
    await owner.app.database.conversationOwners.claim(conversationId);
    const ownerPath = path.join(conversationRuntimeOwnerClaimPath(owner.app.database.binding.paths, conversationId), 'owner.json');
    const ownerRecord = await fs.readFile(ownerPath, 'utf8');
    const lease = (await rows(owner.app, 'ExecutionLease', { id: leaseId }))[0];
    const cases = [
      {
        kind: 'ask_user', toolName: 'ask_user', status: 'succeeded', decision: 'submit', laterDecision: 'submit',
        arguments: { question: '继续吗？', options: [{ label: '继续' }, { label: '停止' }] },
        response: { answer: { selectedOptionIndexes: [0] } },
        laterResponse: { answer: { selectedOptionIndexes: [1] } }
      },
      {
        kind: 'exec_approval', toolName: 'guarded_action', status: 'cancelled', decision: 'cancel', laterDecision: 'accept',
        arguments: {}, response: { reason: '这次不执行。' }, laterResponse: {}
      },
      {
        kind: 'plan_review', toolName: 'submit_plan', status: 'succeeded', decision: 'accept', laterDecision: 'reject',
        arguments: { plan: '按当前方案继续。', taskList: { mode: 'rewrite', items: [
          { title: '实施方案', description: '在当前对话继续。', status: 'pending', delete: false }
        ] } },
        response: { executionTarget: 'current_conversation' }, laterResponse: { message: '后到的拒绝不覆盖批准。' }
      }
    ];
    for (const entry of cases) {
      const toolCallId = `live-control-${entry.kind}`;
      await owner.app.runtime.effects.createToolCall({
        source: { kind: 'internal', key: `create:${toolCallId}` }, toolCallId, turnId,
        toolName: entry.toolName, arguments: entry.arguments
      });
      const pauseInput = { source: { kind: 'internal', key: `pause:${toolCallId}` }, toolCallId };
      const pause = entry.kind === 'ask_user'
        ? await owner.app.interactions.pauseForAskUser({ ...pauseInput, prompt: entry.arguments })
        : entry.kind === 'exec_approval'
          ? await owner.app.interactions.pauseForExecutionApproval({ ...pauseInput, prompt: { toolName: entry.toolName } })
          : await owner.app.interactions.pauseForPlanReview({ ...pauseInput, request: entry.arguments });
      entry.toolCallId = toolCallId;
      entry.requestId = pause.requestId;
    }
    const files = workerFiles(outer, 'control-peer');
    const descriptor = path.join(outer, 'control-responses.json');
    await writeJson(descriptor, { conversationId, turnId, leaseId, ownerHostBootId: owner.app.database.hostBootId, cases });
    peer = spawnWorker(dataRoot, 'live-owner-controls', {
      ...files.env, LIMCODE_ELIGIBILITY_DESCRIPTOR: descriptor
    });
    const ready = await waitForWorkerJson(peer, files.ready, 90_000);
    assert.equal(ready.ownerAlive, true, '回答期间 A 是真实存活 Host');
    assert.deepEqual(ready.completedKinds, cases.map(entry => entry.kind));
    assert.deepEqual(ready.postedStatuses, cases.flatMap(() => ['committed', 'already_resolved']));
    assert.equal(ready.providerCalls, 0);
    assert.equal(ready.owns, false);
    for (const entry of cases) {
      assert.equal((await rows(owner.app, 'InteractionResponse', { request_id: entry.requestId })).length, 1);
      assert.equal((await rows(owner.app, 'InteractionRequest', { id: entry.requestId }))[0]?.status, entry.status);
      assert.equal((await rows(owner.app, 'ToolOutcome', { tool_call_id: entry.toolCallId }))[0]?.status, entry.status);
      assert.equal((await rows(owner.app, 'ToolModelResult', { tool_call_id: entry.toolCallId })).length, 1);
      assert.equal((await rows(owner.app, 'ToolCall', { id: entry.toolCallId }))[0]?.status, 'terminal');
    }
    assert.equal(ownerProvider.calls, 0);
    assert.equal(owner.owns(conversationId), true);
    assert.equal(await fs.readFile(ownerPath, 'utf8'), ownerRecord);
    assert.deepEqual(await rows(owner.app, 'ExecutionLease', { id: leaseId }), [lease]);
    assert.deepEqual(await rows(owner.app, 'EffectIntent'), [], '纯控制答复不派发文件或其它工具效果');
    assert.deepEqual(await rows(owner.app, 'ChildExecution'), [], '批准当前对话 Plan 不启动子 Agent');
    await fs.writeFile(files.finish, 'finish\n', 'utf8');
    await waitForExit(peer, 90_000, true);
    const result = await readJson(files.result);
    assert.equal(result.providerCalls, 0, 'B 不调用模型');
    assert.equal(result.ownsAtFinish, false);
    assert.deepEqual(result.runnerErrors, []);
  } finally {
    await stopChild(peer);
    await owner?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
};

export const scenario3 = async () => {
  const { outer, dataRoot } = await createIsolatedRoot('race');
  const children = [];
  let observer;
  try {
    const conversationId = 'conversation-race';
    const originFiles = workerFiles(outer, 'dead-origin');
    const origin = spawnWorker(dataRoot, 'origin', { ...originFiles.env, LIMCODE_ELIGIBILITY_CONVERSATION: conversationId });
    children.push({ child: origin });
    const deadOwner = await waitForWorkerJson(origin, originFiles.ready, 90000);
    const turnId = deadOwner.turnId;
    origin.kill('SIGKILL');
    await waitForExit(origin, 30000);
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
        child: spawnWorker(dataRoot, 'recoverer', {
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
    const claimPath = conversationRuntimeOwnerClaimPath((await new kernel.RootAuthority(() => dataRoot).current()).paths, conversationId);
    const currentOwner = JSON.parse(await fs.readFile(path.join(claimPath, 'owner.json'), 'utf8'));
    assert.notEqual(currentOwner.ownerToken, deadOwner.ownerToken, 'dead Host replacement publishes a new durable owner token');
    assert.notEqual(currentOwner.hostBootId, deadOwner.hostBootId);
    assert.ok((await fs.readdir(claimGenerationPath(claimPath, `dead-${deadOwner.ownerToken}`))).length > 0, 'dead owner generation remains a nonempty tombstone');

    await fs.writeFile(gate, 'release\n', 'utf8');
    observer = await kernel.RuntimeDatabase.open(new kernel.RootAuthority(() => dataRoot), { hostBootId: 'race-observer' });
    await eventually(async () => (await rows(observer, 'Turn', { id: turnId }))[0]?.status === 'terminated',
      90_000, '承接方未完成 Turn');
    await fs.writeFile(finish, 'finish\n', 'utf8');
    for (const { child } of children) if (child !== origin) await waitForExit(child, 90_000, true);
    const results = Object.fromEntries(await Promise.all(workers.map(async (worker) =>
      [worker.name, await readJson(worker.result)])));
    assert.equal(results[winners[0]].providerCalls, 1);
    assert.equal(results[loser].providerCalls, 0);
    assert.equal(results.p1.providerCalls, 0);
    for (const result of Object.values(results)) assert.deepEqual(result.runnerErrors, []);
  } finally {
    if (observer) await observer.close().catch(() => undefined);
    for (const { child } of children) await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
};
