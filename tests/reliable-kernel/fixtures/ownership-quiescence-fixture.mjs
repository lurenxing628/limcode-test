import { createOwnershipScope } from './ownership-scope-fixture.mjs';
// Focused production ownership boundary; old review matrices are absent.
import assert from 'node:assert/strict';

import childProcess from 'node:child_process';

import crypto from 'node:crypto';

import fs from 'node:fs';

import fsp from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.cwd();

const load = (relative) => import(pathToFileURL(path.join(root, 'dist/extension', relative)).href);

const kernel = await load('backend/reliableKernel/index.js');

const { emptyConversationContextHandleStateStep } = await load('backend/reliableKernel/conversationContextHandleState.js');

const { ReliableConversationRunner } = await load('backend/application/reliableKernel/ReliableConversationRunner.js');

const { recoverServedConversation } = await load('backend/application/reliableKernel/conversationTakeover.js');

const {
  evaluateConversationEntryEligibility,
  evaluateConversationHostEligibility
} = await load('backend/application/reliableKernel/conversationHostEligibility.js');

const { ReliableChildAgentCoordinator } = await load('backend/reliableKernel/childAgentCoordinator.js');

const { isConversationHostIneligibleError } = await load('backend/reliableKernel/ConversationRuntimeOwnerManager.js');

const { projectFolderAssignmentSteps } = await load('backend/reliableKernel/conversationProject.js');

const { askUserTool } = await load('backend/world/modules/tools/definitions/askUser/index.js');

const { runAgentTool } = await load('backend/world/modules/tools/definitions/runAgent/index.js');

const { workEnvironmentIdFromUri } = await load('shared/workEnvironmentCatalog.js');

const PROVIDER_ID = 'blind-review-provider';

const PROJECT_ONE = 'file:///workspace/project-one';

const PROJECT_TWO = 'file:///workspace/project-two';

const PROJECT_TWO_FOLDER = { uri: PROJECT_TWO, name: '项目二' };

const SHORT_LEASE_MS = 3_000;

const TEST_FILE = fileURLToPath(import.meta.url);

const RELEASED = kernel.RELEASED_EXECUTION_LEASE_HOLDER;

const mcpTool = {
  execution: 'runtime',
  declaration: {
    name: 'fixture_call',
    description: 'MCP fixture.',
    parameters: { type: 'object', properties: {} },
    source: { kind: 'mcp', sourceId: 'fixture', sourceName: 'fixture', originalToolName: 'call' },
    metadata: { category: 'general', scope: 'general', riskLevel: 'read', readonly: true, defaultEnabled: true }
  },
  async execute() { throw new Error('MCP execution must use the reliable McpEffect control plane.'); }
};

const ASK_USER = { role: 'model', parts: [{ id: 'ask', functionCall: {
  name: 'ask_user', args: { question: '继续吗？', options: [{ label: '继续' }, { label: '停止' }] } } }] };

const MCP_CALL = { role: 'model', parts: [{ id: 'mcp-call', functionCall: { name: 'fixture_call', args: {} } }] };

const SPAWN_CHILD = { role: 'model', parts: [{ id: 'provider-spawn', functionCall: {
  name: 'run_agent', args: { operation: 'spawn', taskName: '子任务', prompt: '做子任务', foregroundWaitMs: 0 } } }] };

const text = (value) => ({ role: 'model', parts: [{ text: value }] });

const workerMode = process.env.LIMCODE_BLIND_WORKER;

async function runWorker(mode) {
  const dataRoot = requiredEnv('LIMCODE_BLIND_DATA_ROOT');
  const conversationId = requiredEnv('LIMCODE_BLIND_CONVERSATION');
  if (mode === 'expired' || mode === 'busy') {
    const host = await openHost(dataRoot, scriptedProvider([ASK_USER]), {
      folders: [PROJECT_TWO], label: 'w1', askUser: true, leaseDurationMs: SHORT_LEASE_MS
    });
    try {
      await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
      const { turnId } = await host.runner.input({ commandId: `input-${mode}`, conversationId, text: '问我' });
      await eventually(async () => (await rows(host.app, 'InteractionRequest', { status: 'pending' })).length === 1, 30_000, '未进入等待');
      await host.runner.waitForIdle();
      const [waiting] = await rows(host.app, 'ExecutionLease', { turn_id: turnId });
      if (waiting?.host_boot_id !== host.app.database.hostBootId) throw new Error('W1 does not hold the waiting Turn.');
      // The user thinks (or is away) longer than the lease lasts; a waiting Turn does not renew it.
      await sleep(Math.max(0, Date.parse(waiting.expires_at) - Date.now()) + 300);
      const expiredBeforeRemoval = Date.parse(waiting.expires_at) < Date.now();
      // The user removes the project folder in W1 (W1 stays open).
      host.folders.splice(host.folders.indexOf(PROJECT_TWO), 1);
      if (mode === 'busy') {
        // W1's idle sweep hands the Conversation back first (W1 no longer serves it); another
        // window then holds it while W1's rescan tries to hand the lease back.
        await host.app.database.conversationOwners.sweepIdle();
        if (host.owns(conversationId)) throw new Error('W1 still owns the Conversation after its idle sweep.');
        await writeJson(requiredEnv('LIMCODE_BLIND_READY'), { turnId, hostBootId: host.app.database.hostBootId });
        await waitForFile(requiredEnv('LIMCODE_BLIND_SIGNAL'), 120_000);
      }
      await host.runner.rescan();
      const [lease] = await rows(host.app, 'ExecutionLease', { turn_id: turnId });
      await writeJson(requiredEnv(mode === 'busy' ? 'LIMCODE_BLIND_REPORT' : 'LIMCODE_BLIND_READY'), {
        turnId,
        hostBootId: host.app.database.hostBootId,
        expiredBeforeRemoval,
        leaseOwner: lease?.owner_id,
        leaseHost: lease?.host_boot_id,
        runnerErrors: errorsOf(host)
      });
      await waitForFile(requiredEnv('LIMCODE_BLIND_FINISH'), 300_000);
      if (errorsOf(host).length > 0) throw new Error(`W1 runner errors:\n${errorsOf(host).join('\n')}`);
    } finally {
      await host.close();
    }
    return;
  }
  if (mode === 'child') {
    const provider = routedProvider((request, n) => request.conversationId === conversationId
      ? [SPAWN_CHILD, text('子任务已开始。')][n - 1]
      : [ASK_USER][n - 1]);
    const host = await openHost(dataRoot, provider, {
      folders: [PROJECT_TWO], label: 'w1', askUser: true, children: true,
      leaseDurationMs: SHORT_LEASE_MS, childLeaseDurationMs: SHORT_LEASE_MS
    });
    try {
      await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
      await host.runner.input({ commandId: 'input-child', conversationId, text: '派一个子 Agent' });
      const { execution, childTurnId } = await waitForChildQuestion(host);
      const [waiting] = await rows(host.app, 'ExecutionLease', { turn_id: childTurnId });
      if (waiting?.owner_id !== host.coordinator.childLeaseOwnerId) throw new Error('W1 does not hold the waiting child Turn.');
      await sleep(Math.max(0, Date.parse(waiting.expires_at) - Date.now()) + 300);
      const expiredBeforeRemoval = Date.parse(waiting.expires_at) < Date.now();
      host.folders.splice(host.folders.indexOf(PROJECT_TWO), 1);
      // VscodeReliableKernelProductRuntime.rescanEligibility: the child scheduler, then the runner.
      await host.coordinator.recoverStartup();
      await host.runner.rescan();
      const [lease] = await rows(host.app, 'ExecutionLease', { turn_id: childTurnId });
      await writeJson(requiredEnv('LIMCODE_BLIND_READY'), {
        childExecutionId: execution.id,
        childConversationId: execution.child_conversation_id,
        childTurnId,
        hostBootId: host.app.database.hostBootId,
        expiredBeforeRemoval,
        leaseOwner: lease?.owner_id,
        errors: errorsOf(host)
      });
      await waitForFile(requiredEnv('LIMCODE_BLIND_FINISH'), 300_000);
    } finally {
      await host.close();
    }
    return;
  }
  if (mode === 'phase-d') {
    const signal = requiredEnv('LIMCODE_BLIND_SIGNAL');
    const host = await openHost(dataRoot, scriptedProvider([MCP_CALL, text('W1 完成。')]), {
      folders: [PROJECT_TWO], label: 'w1',
      mcp: async () => {
        await waitForFile(signal, 300_000);
        return { content: [{ type: 'text', text: 'W1 的真实结果' }] };
      }
    });
    try {
      await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
      const { turnId } = await host.runner.input({ commandId: 'input-phase-d', conversationId, text: '调用外部工具' });
      await eventually(async () => host.mcpCalls() > 0, 30_000, 'MCP 调用未派发');
      // The lease goes back while the call still runs here (a hand-back that did not wait for it),
      // and so does ownership (the drive is stuck in the call, so the owner manager is closed).
      const [lease] = await rows(host.app, 'ExecutionLease', { turn_id: turnId });
      const released = await host.app.turns.releaseExecutionLease({
        id: lease.id, conversationId, turnId, ownerId: lease.owner_id, hostBootId: lease.host_boot_id, generation: lease.generation
      });
      await host.app.database.conversationOwners.close();
      await writeJson(requiredEnv('LIMCODE_BLIND_READY'), { turnId, hostBootId: host.app.database.hostBootId, released });
      await waitForFile(requiredEnv('LIMCODE_BLIND_FINISH'), 300_000);
    } finally {
      await host.close();
    }
    return;
  }
  if (mode === 'takeover') {
    const host = await openHost(dataRoot, scriptedProvider([MCP_CALL]), {
      folders: [PROJECT_TWO], label: 'w1', leaseDurationMs: SHORT_LEASE_MS, mcp: () => new Promise(() => {})
    });
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const { turnId } = await host.runner.input({ commandId: 'input-takeover', conversationId, text: '调用外部工具' });
    await eventually(async () => host.mcpCalls() > 0, 30_000, 'MCP 调用未派发');
    await writeJson(requiredEnv('LIMCODE_BLIND_READY'), { turnId, hostBootId: host.app.database.hostBootId });
    await new Promise(() => {});
  }
  if (mode === 'probe') {
    const host = await openHost(dataRoot, scriptedProvider([ASK_USER]), {
      folders: [PROJECT_TWO], label: 'w1', askUser: true, leaseDurationMs: Number(process.env.LIMCODE_BLIND_LEASE_MS ?? 6_000)
    });
    try {
      await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
      const { turnId } = await host.runner.input({ commandId: 'input-probe', conversationId, text: '问我' });
      await eventually(async () => (await rows(host.app, 'InteractionRequest', { status: 'pending' })).length === 1, 30_000, '未进入等待');
      await host.runner.waitForIdle();
      await writeJson(requiredEnv('LIMCODE_BLIND_READY'), { turnId, hostBootId: host.app.database.hostBootId, pid: process.pid });
      await waitForFile(requiredEnv('LIMCODE_BLIND_FINISH'), 300_000);
    } finally {
      await host.close();
    }
    return;
  }
  throw new Error(`Unknown worker ${mode}`);
}

async function openHost(dataRoot, provider, options) {
  const folders = [...options.folders];
  let mcpCalls = 0;
  let coordinator;
  // Stands in for VscodeConfigurationAuthority.previewWorkEnvironment: the project's own folder.
  const previewWorkEnvironment = async (request) => {
    const id = request.workspace ? workEnvironmentIdFromUri(request.workspace.uri) : undefined;
    if (!id) return {};
    if (!folders.includes(request.workspace.uri)) return { error: `当前窗口的工作环境不可用：${id}` };
    return { workEnvironmentId: id, policy: { id: null, enabled: false, allowedWorkEnvironmentIds: [id], defaultWorkEnvironmentId: id } };
  };
  const app = await kernel.ReliableKernelApplication.open(
    new kernel.RootAuthority(() => dataRoot),
    fixtureDependencies(provider, {
      previewWorkEnvironment,
      askUser: options.askUser === true,
      coordinator: options.children ? () => coordinator : undefined,
      callTool: () => {
        mcpCalls += 1;
        return (options.mcp ?? (() => new Promise(() => {})))();
      }
    })
  );
  const runnerErrors = [];
  const runner = new ReliableConversationRunner(
    app,
    `${options.label}:${app.database.hostBootId}`,
    (error, context) => runnerErrors.push({ error, context }),
    options.leaseDurationMs
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
      deadHostEffects: app.phaseDRecovery,
      ...(options.childLeaseDurationMs ? { leaseDurationMs: options.childLeaseDurationMs } : {}),
      // As VscodeReliableKernelProductRuntime wires it.
      manualCompression: {
        admit: (input) => runner.admitManualCompression(input),
        inspect: (input) => runner.inspectManualCompression(input),
        driveIfPresent: (input) => runner.driveManualCompressionIfPresent(input)
      }
    });
  }
  // The same wiring as VscodeReliableKernelProductRuntime.
  const base = {
    database: app.database,
    contentStore: app.contentStore,
    workspaceFolderUris: () => folders,
    workEnvironments: async () => [],
    nextTurnWorkEnvironment: (id, next) => app.turns.previewNextTurnWorkEnvironment(id, next?.executorAgentId)
  };
  let failProbe = false;
  app.database.conversationOwners.setClaimEligibilityProbe(async (conversationId) => {
    if (failProbe) throw Object.assign(new Error('工作环境目录暂时读取失败'), { name: 'TransientProbeError' });
    return (await evaluateConversationHostEligibility(base, conversationId)).eligible;
  });
  runner.setEntryEligibility(async (conversationId, next) => {
    try {
      if (failProbe) return 'unknown';
      return (await evaluateConversationEntryEligibility(base, conversationId, next)).eligible ? 'eligible' : 'ineligible';
    } catch {
      return 'unknown';
    }
  });
  if (options.takeover) {
    // VscodeReliableKernelProductRuntime: a Turn no live Host holds is taken over like a view takeover.
    runner.setConversationTakeover((conversationId) => recoverServedConversation({
      application: app,
      childAgents: coordinator ?? { async recoverStartup() { return undefined; } },
      conversations: runner,
      conversationId
    }));
  }
  let closed = false;
  return {
    app,
    runner,
    coordinator,
    runnerErrors,
    folders,
    set failProbe(value) { failProbe = value; },
    mcpCalls: () => mcpCalls,
    owns: (conversationId) => app.database.conversationOwners.owns(conversationId),
    async close() {
      if (closed) return;
      closed = true;
      for (const settle of inFlightCalls.get(app.agentLoop) ?? []) settle();
      runner.dispose();
      await app.beginHandoff().catch(() => undefined);
      await runner.waitForIdle().catch(() => undefined);
      await coordinator?.dispose().catch(() => undefined);
      await app.close();
    }
  };
}

function fixtureDependencies(provider, options) {
  return {
    authorityCompiler: {
      previewWorkEnvironment: options.previewWorkEnvironment,
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: provider.providerId, modelId: 'blind-model' }) },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: {
                providerConfigId: provider.providerId,
                provider: 'openai-compatible',
                modelId: 'blind-model',
                retryPolicy: { enabled: false, maxRetries: 0 }
              },
              modelProfile: {
                compressionThresholdTokens: 100_000,
                contextWindowTokens: 128_000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              toolPolicy: {
                id: 'blind-tools',
                allowedTools: [...(options.askUser ? ['ask_user'] : []), ...(options.coordinator ? ['run_agent'] : [])],
                preset: 'yolo',
                toolConfigs: {},
                sourceConfigs: { fixture: { enabled: true } }
              },
              planReviewPolicy: { mode: 'off' },
              systemPrompt: { id: 'blind-prompt', text: '' },
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
      callTool() { return options.callTool(); }
    },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
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
          definitions() {
            return [mcpTool, ...(options.askUser ? [askUserTool] : []), ...(options.coordinator ? [runAgentTool] : [])];
          },
          async dispatchSpecial(_definition, input, authority, signal, admission) {
            return options.coordinator?.().dispatch(input, signal, authority, admission);
          },
          async cancelTurnWaits(input) { await options.coordinator?.().cancelParentWaits(input); },
          async quiesce(reason) { await options.coordinator?.().quiesce(reason); },
          async dispose() {}
        }
      })
  };
}

function routedProvider(route) {
  const calls = [];
  return {
    providerId: PROVIDER_ID,
    get calls() { return calls.length; },
    callsFor(conversationId) { return calls.filter((id) => id === conversationId).length; },
    async sendFullRequest(request, controls) {
      calls.push(request.conversationId);
      const content = route(request, calls.filter((id) => id === request.conversationId).length);
      if (!content) throw new Error(`Unexpected Provider call for ${request.conversationId}.`);
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content });
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

const inFlightCalls = new WeakMap();

function inFlightNativeCall(agentLoop, turnId, toolCallId = `in-flight-${turnId}`) {
  let settle;
  const execution = new Promise((resolve) => { settle = resolve; });
  // A test that fails early still lets the call settle before its window closes.
  inFlightCalls.set(agentLoop, [...(inFlightCalls.get(agentLoop) ?? []), () => settle({ settled: true })]);
  agentLoop.nativeCallExecutions.set(toolCallId, execution);
  agentLoop.nativeCallTurnIds.set(toolCallId, turnId);
  void execution.then(() => {
    agentLoop.nativeCallExecutions.delete(toolCallId);
    agentLoop.nativeCallTurnIds.delete(toolCallId);
  });
  assert.equal(agentLoop.hasNativeCalls(turnId), true);
  return { settle: () => settle({ settled: true }) };
}

async function waitForChildQuestion(host) {
  await eventually(async () => (await rows(host.app, 'InteractionRequest', { status: 'pending' })).length === 1, 60_000, '子 Agent 没有提问');
  const [execution] = await rows(host.app, 'ChildExecution', {});
  const [link] = await rows(host.app, 'ChildExecutionActiveTurnLink', { child_execution_id: execution.id });
  await host.coordinator.waitForIdle();
  await host.runner.waitForIdle();
  return { execution, childTurnId: link.turn_id };
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

function errorsOf(host) {
  return host.runnerErrors.map((entry) => String(entry.error?.stack ?? entry.error));
}

function workerFiles(outer) {
  const files = {
    ready: path.join(outer, 'worker-ready.json'),
    report: path.join(outer, 'worker-report.json'),
    signal: path.join(outer, 'worker-signal'),
    finish: path.join(outer, 'worker-finish')
  };
  return {
    ...files,
    env: {
      LIMCODE_BLIND_READY: files.ready,
      LIMCODE_BLIND_REPORT: files.report,
      LIMCODE_BLIND_SIGNAL: files.signal,
      LIMCODE_BLIND_FINISH: files.finish
    }
  };
}

function spawnWorker(dataRoot, mode, environment) {
  const child = childProcess.spawn(process.execPath, [TEST_FILE], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment, LIMCODE_BLIND_WORKER: mode, LIMCODE_BLIND_DATA_ROOT: dataRoot },
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
      throw new Error(`blind review worker exited before ${path.basename(filePath)} (code=${child.exitCode})\n${child.output.stdout}\n${child.output.stderr}`);
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}\n${child.output.stdout}\n${child.output.stderr}`);
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
        reject(new Error(`blind review worker failed (code=${code}, signal=${signal})\n${child.output?.stdout ?? ''}\n${child.output?.stderr ?? ''}`));
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
      reject(new Error(`blind review worker timed out after ${timeoutMs}ms\n${child.output?.stdout ?? ''}\n${child.output?.stderr ?? ''}`));
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
      await fsp.access(filePath);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await sleep(20);
  }
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fsp.writeFile(`${filePath}.tmp`, `${JSON.stringify(value)}\n`, 'utf8');
  await fsp.rename(`${filePath}.tmp`, filePath);
}

async function eventually(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(20);
  }
}

async function eventuallyValue(read, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(20);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withinMs(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment: ${name}`);
  return value;
}

if (workerMode) runWorker(workerMode).then(() => process.exit(0), error => { console.error(error?.stack ?? error); process.exit(1); });

export const scenario1 = async () => {
  const { outer, dataRoot } = await createIsolatedRoot('quiesce-waiting');
  let host;
  try {
    const conversationId = 'conversation-quiesce-waiting';
    host = await openHost(dataRoot, scriptedProvider([ASK_USER]), { folders: [PROJECT_TWO], label: 'w', askUser: true });
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const { turnId } = await host.runner.input({ commandId: 'quiesce-waiting', conversationId, text: '问我' });
    await eventually(async () => (await rows(host.app, 'InteractionRequest', { status: 'pending' })).length === 1, 30_000, '未进入等待');
    await host.runner.waitForIdle();
    const call = inFlightNativeCall(host.app.agentLoop, turnId);
    host.folders.splice(host.folders.indexOf(PROJECT_TWO), 1);
    await withinMs(host.runner.rescan(), 5_000, '重扫被在途调用阻塞');
    await eventually(() => host.runner.leaseHandBacks.has(turnId), 5000, "handback did not start");
    assert.equal((await rows(host.app, 'ExecutionLease', { turn_id: turnId }))[0]?.host_boot_id, host.app.database.hostBootId,
      '本窗口仍在执行这个 Turn 的调用：租约还不交还');
    call.settle();
    await eventually(async () => (await rows(host.app, 'ExecutionLease', { turn_id: turnId }))[0]?.owner_id === RELEASED,
      10_000, '调用结束后没有交还租约');
    assert.deepEqual(errorsOf(host), []);
  } finally {
    await host?.close();
    await fsp.rm(outer, { recursive: true, force: true });
  }
};

export const scenario2 = async () => {
  const { outer, dataRoot } = await createIsolatedRoot('phase-d-live');
  let w2; let child;
  try {
    const conversationId = 'conversation-phase-d-live';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, 'phase-d', { ...files.env, LIMCODE_BLIND_CONVERSATION: conversationId });
    const w1 = await waitForWorkerJson(child, files.ready, 90_000);
    assert.equal(w1.released, true, 'W1 在调用仍在执行时交还了租约');

    w2 = await openHost(dataRoot, scriptedProvider([]), { folders: [PROJECT_TWO], label: 'w2' });
    // Opening the panel: VscodeReliableKernelProductRuntime.recoverConversation → recoverOwnedConversation.
    await w2.app.database.conversationOwners.run(conversationId, () => w2.app.recoverConversation(conversationId));
    const [call] = await rows(w2.app, 'ToolCall', { turn_id: w1.turnId });
    const [intent] = await effectIntentsForToolCall(w2.app, call.id);
    assert.equal(intent.dispatch_state, 'dispatched', '派发窗口存活：Phase D 不碰它的效果');
    assert.deepEqual(await rows(w2.app, 'EffectReceipt', { attempt_id: intent.attempt_id }), []);
    assert.equal(child.exitCode, null, 'W1 仍存活');

    // W1's MCP server answers now: its real result is what gets recorded.
    await fsp.writeFile(files.signal, 'answer\n', 'utf8');
    const receipt = await eventuallyValue(async () => (await rows(w2.app, 'EffectReceipt', { attempt_id: intent.attempt_id }))[0],
      30_000, 'W1 的真实结果没有写回');
    assert.equal(receipt.outcome, 'succeeded');
    assert.deepEqual((await readContentJson(w2.app, receipt.response_object_id)).result,
      { content: [{ type: 'text', text: 'W1 的真实结果' }] });
    assert.equal(w2.mcpCalls(), 0, 'W2 不重放调用');
    await fsp.writeFile(files.finish, 'finish\n', 'utf8');
    await waitForExit(child, 90_000, true);
  } finally {
    await w2?.close();
    await stopChild(child);
    await fsp.rm(outer, { recursive: true, force: true });
  }
};
