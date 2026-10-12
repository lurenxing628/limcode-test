import { createOwnershipScope } from './ownership-scope-fixture.mjs';
// Focused production ownership boundary; old review matrices are absent.
import assert from 'node:assert/strict';

import childProcess from 'node:child_process';

import fs from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.cwd();

const load = (relative) => import(pathToFileURL(path.join(root, 'dist/extension', relative)).href);

const kernel = await load('backend/reliableKernel/index.js');

const { emptyConversationContextHandleStateStep } = await load('backend/reliableKernel/conversationContextHandleState.js');

const { ReliableConversationRunner } = await load('backend/application/reliableKernel/ReliableConversationRunner.js');

const {
  evaluateConversationEntryEligibility,
  evaluateConversationHostEligibility
} = await load('backend/application/reliableKernel/conversationHostEligibility.js');

const { createRuntimeDeliveryWakeHandler } = await load('backend/application/reliableKernel/runtimeDeliveryWakeHandler.js');

const { projectFolderAssignmentSteps } = await load('backend/reliableKernel/conversationProject.js');

const { isConversationHostIneligibleError } = await load('backend/reliableKernel/ConversationRuntimeOwnerManager.js');

const { askUserTool } = await load('backend/world/modules/tools/definitions/askUser/index.js');

const { readFrozenTurnAuthority, frozenWorkEnvironmentPolicy } = await load('backend/reliableKernel/frozenAuthority.js');

const { workEnvironmentIdFromUri } = await load('shared/workEnvironmentCatalog.js');

const PROVIDER_ID = 'placement-provider';

const PROJECT_ONE = 'file:///workspace/project-one';

const PROJECT_TWO = 'file:///workspace/project-two';

const PROJECT_TWO_FOLDER = { uri: PROJECT_TWO, name: '项目二' };

const PROJECT_TWO_ENV = workEnvironmentIdFromUri(PROJECT_TWO);

const CHOSEN = { id: 'work-env-chosen', name: '新位置', displayPath: '/workspace/moved', available: true };

const TEST_FILE = fileURLToPath(import.meta.url);

const workerMode = process.env.LIMCODE_PLACEMENT_WORKER;

async function runWorker(mode) {
  const dataRoot = requiredEnv('LIMCODE_PLACEMENT_DATA_ROOT');
  const conversationId = requiredEnv('LIMCODE_PLACEMENT_CONVERSATION');
  if (mode !== 'r5-w1' && mode !== 'x3-w1') throw new Error(`Unknown worker ${mode}`);
  const host = await openHost(dataRoot, scriptedProvider([{ role: 'model', parts: [{ id: 'ask', functionCall: {
    name: 'ask_user', args: { question: '继续吗？', options: [{ label: '继续' }, { label: '停止' }] } } }] }]), { folders: [PROJECT_TWO], label: 'w1', askUser: true });
  try {
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const { turnId } = await host.runner.input({ commandId: 'r5', conversationId, text: '问我' });
    await eventually(async () => (await rows(host.app, 'InteractionRequest', { status: 'pending' })).length === 1, 30_000, '未进入等待');
    await host.runner.waitForIdle();
    // 用户在 W1 移除了项目文件夹（W1 窗口仍开着）。
    host.folders.splice(host.folders.indexOf(PROJECT_TWO), 1);
    // x3: no rescan; the window's idle sweep (any local commit runs one) hands the Conversation back,
    // and the external wake path (another window's answer) notices the rest.
    if (mode === 'r5-w1') await host.runner.rescan();
    else await host.app.database.conversationOwners.sweepIdle();
    const [lease] = await rows(host.app, 'ExecutionLease', { turn_id: turnId });
    await writeJson(requiredEnv('LIMCODE_PLACEMENT_READY'), { turnId, hostBootId: host.app.database.hostBootId,
      ownsAfterRescan: host.owns(conversationId), leaseOnW1: lease?.host_boot_id === host.app.database.hostBootId,
      leaseOwner: lease?.owner_id });
    await waitForFile(requiredEnv('LIMCODE_PLACEMENT_FINISH'), 300_000);
  } finally {
    await host.close();
  }
}

async function openHost(dataRoot, provider, options) {
  const folders = [...options.folders];
  const environments = (options.environments ?? []).map((environment) => ({ ...environment }));
  const previewAgents = [];
  // Stands in for VscodeConfigurationAuthority.previewWorkEnvironment: an explicit choice (or the
  // named Agent's policy) first, then the project's own folder; the same policy compile() freezes.
  const previewWorkEnvironment = async (request) => {
    previewAgents.push(request.executorAgentId);
    const selected = options.selectedFor ? options.selectedFor(request.executorAgentId) : options.selected;
    const id = selected ?? (request.workspace ? workEnvironmentIdFromUri(request.workspace.uri) : undefined);
    if (!id) return {};
    const available = selected
      ? environments.some((environment) => environment.id === id && environment.available)
      : folders.includes(request.workspace.uri);
    if (!available) return { error: `当前窗口的工作环境不可用：${id}，请打开对应目录或重新选择。` };
    return { workEnvironmentId: id, policy: { id: null, enabled: false, allowedWorkEnvironmentIds: [id], defaultWorkEnvironmentId: id } };
  };
  const app = await kernel.ReliableKernelApplication.open(
    new kernel.RootAuthority(() => dataRoot),
    fixtureDependencies(provider, options.frozen ?? null, previewWorkEnvironment, { askUser: options.askUser === true })
  );
  const runnerErrors = [];
  const runner = new ReliableConversationRunner(app, `${options.label}:${app.database.hostBootId}`,
    (error, context) => runnerErrors.push({ error, context }));
  let failProbe = false;
  let forceIneligible = false;
  let probeCalls = 0;
  const base = {
    database: app.database,
    contentStore: app.contentStore,
    workspaceFolderUris: () => folders,
    workEnvironments: async () => environments,
    nextTurnWorkEnvironment: (id, next) => app.turns.previewNextTurnWorkEnvironment(id, next?.executorAgentId)
  };
  // The same wiring as VscodeReliableKernelProductRuntime.
  const eligibility = async (conversationId) => {
    probeCalls += 1;
    if (failProbe) throw Object.assign(new Error('工作环境目录暂时读取失败'), { name: 'TransientProbeError' });
    if (forceIneligible) return { eligible: false, reason: 'project_not_open', projectUri: PROJECT_TWO, projectName: '项目二' };
    return evaluateConversationHostEligibility(base, conversationId);
  };
  const entry = (conversationId, next) => evaluateConversationEntryEligibility(base, conversationId, next);
  app.database.conversationOwners.setClaimEligibilityProbe(async (conversationId) => (await eligibility(conversationId)).eligible);
  runner.setEntryEligibility(async (conversationId, next) => {
    try {
      if (failProbe) return 'unknown';
      return (await entry(conversationId, next)).eligible ? 'eligible' : 'ineligible';
    } catch {
      return 'unknown';
    }
  });
  let closed = false;
  return {
    app, runner, runnerErrors, folders, environments, eligibility, entry, previewAgents,
    get probeCalls() { return probeCalls; },
    get failProbe() { return failProbe; },
    set failProbe(value) { failProbe = value; },
    set forceIneligible(value) { forceIneligible = value; },
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

function fixtureDependencies(provider, defaultWorkEnvironmentId, previewWorkEnvironment, tools = {}) {
  return {
    authorityCompiler: {
      previewWorkEnvironment,
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: provider.providerId, modelId: 'placement-model' }) },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: { providerConfigId: provider.providerId, provider: 'fixture', modelId: 'placement-model', retryPolicy: { enabled: false, maxRetries: 0 } },
              modelProfile: { compressionThresholdTokens: 100_000, contextWindowTokens: 128_000, tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
              toolPolicy: { id: 'placement-tools', allowedTools: tools.askUser ? ['ask_user'] : [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
              planReviewPolicy: { mode: 'optional' },
              systemPrompt: { id: 'placement-prompt', text: '' },
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
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { return null; } },
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
        database, contentStore, effects: runtime.effects, files, fileMutations, processes, mcp, interactions,
        host: {
          definitions() { return tools.askUser ? [askUserTool] : []; },
          async cancelTurnWaits() {},
          async dispose() {}
        }
      })
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
  const { outer, dataRoot } = await createIsolatedRoot('h2-agent');
  let host;
  try {
    host = await openHost(dataRoot, scriptedProvider([{ role: 'model', parts: [{ text: '好' }] }, { role: 'model', parts: [{ text: '摘要' }] }]), {
      folders: [PROJECT_ONE], label: 'h2', frozen: CHOSEN.id, environments: [CHOSEN],
      // 只有 agent-other 的工作环境策略选中了本窗口可用的目录。
      selectedFor: (agentId) => agentId === 'agent-other' ? CHOSEN.id : undefined
    });
    const conversationId = 'conversation-h2';
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const first = await host.runner.input({ commandId: 'h2-1', conversationId, text: '指定 Agent', agentId: 'agent-other' });
    await eventually(async () => (await rows(host.app, 'Turn', { id: first.turnId }))[0]?.status === 'terminated', 30_000, '第一个 Turn 未结束');
    await host.runner.waitForIdle();
    assert.equal((await host.entry(conversationId)).eligible, false, '对比：按默认 Agent 判定会拒绝');
    assert.equal(await host.runner.manualCompressionExecutorAgentId(conversationId), 'agent-other');
    const [head] = await rows(host.app, 'ConversationContextHeadLink', { conversation_id: conversationId });
    const outcome = await host.runner.manualCompression({ commandId: 'h2-compress', conversationId, compressSegmentCount: 1,
      target: { kind: 'current_head', expectedRootId: head.root_id } });
    const maintenance = (await rows(host.app, 'Turn', { conversation_id: conversationId })).find((r) => r.id !== first.turnId);
    assert.equal(maintenance?.id, outcome.turnId);
    assert.equal(maintenance.status, 'terminated');
    const [snapshot] = await rows(host.app, 'AuthoritySnapshot', { turn_id: maintenance.id });
    const document = (await readFrozenTurnAuthority(host.app.database, host.app.contentStore, snapshot.id, maintenance.id)).document;
    assert.equal(frozenWorkEnvironmentPolicy(document).defaultWorkEnvironmentId, CHOSEN.id, '入口批准的正是维护 Turn 冻结的环境');
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
};

export const scenario2 = async () => {
  const { outer, dataRoot } = await createIsolatedRoot('r4-blocked');
  let host;
  try {
    const conversationId = 'conversation-r4-blocked';
    const provider = scriptedProvider([{ role: 'model', parts: [{ text: '第一轮回答。' }] }, { role: 'model', parts: [{ text: '继续' }] }]);
    host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'blocked' });
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const first = await host.runner.input({ commandId: 'b-1', conversationId, text: '第一条' });
    await eventually(async () => (await rows(host.app, 'Turn', { id: first.turnId }))[0]?.status === 'terminated', 30_000, '第一个 Turn 未结束');
    await host.runner.waitForIdle();
    // 入口放行、维护 Turn 准入之后，驱动之前本窗口不再服务该对话（例如文件夹刚被移除）。
    host.runner.setEntryEligibility(async () => 'eligible');
    host.forceIneligible = true;
    const [head] = await rows(host.app, 'ConversationContextHeadLink', { conversation_id: conversationId });
    await assert.rejects(host.runner.manualCompression({ commandId: 'b-compress', conversationId, compressSegmentCount: 1,
      target: { kind: 'current_head', expectedRootId: head.root_id } }), (error) => isConversationHostIneligibleError(error));
    const maintenance = (await rows(host.app, 'Turn', { conversation_id: conversationId })).find((r) => r.id !== first.turnId);
    assert.equal(maintenance?.status, 'terminated', '维护 Turn 不留在 active');
    assert.equal((await rows(host.app, 'TurnTermination', { turn_id: maintenance.id }))[0]?.terminal_status, 'failed');
    assert.equal(provider.calls, 1, '没有发起压缩请求');
    host.forceIneligible = false;
    const next = await host.runner.input({ commandId: 'b-2', conversationId, text: '继续' });
    assert.equal(next.admitted, true, '之后的输入不被卡住的维护 Turn 挡住');
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
};
