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

const { ReliableChildAgentCoordinator } = await load('backend/reliableKernel/childAgentCoordinator.js');

const { runAgentTool } = await load('backend/world/modules/tools/definitions/runAgent/index.js');

const { readFrozenTurnAuthority, frozenWorkEnvironmentPolicy } = await load('backend/reliableKernel/frozenAuthority.js');

const { preparedContentObjectSteps } = await load('backend/reliableKernel/contentObjectTransaction.js');

const { workEnvironmentIdFromUri } = await load('shared/workEnvironmentCatalog.js');

const PROVIDER_ID = 'delivery-placement-provider';

const PROJECT_ONE = 'file:///workspace/project-one';

const PROJECT_TWO = 'file:///workspace/project-two';

const PROJECT_TWO_FOLDER = { uri: PROJECT_TWO, name: '项目二' };

const PROJECT_TWO_ENV = workEnvironmentIdFromUri(PROJECT_TWO);

const PROJECT_TWO_RECORD = { id: PROJECT_TWO_ENV, name: '项目二', displayPath: '/workspace/project-two', available: true };

const CHOSEN = { id: 'work-env-chosen', name: '远程环境', displayPath: '/remote/work', available: true };

const FOLDER_F = { id: 'work-env-folder-f', name: '目录 F', displayPath: '/workspace/f', available: true };

const TEST_FILE = fileURLToPath(import.meta.url);

const workerMode = process.env.LIMCODE_DELIVERY_WORKER;

async function runWorker(mode) {
  if (mode !== 'window') throw new Error(`Unknown worker ${mode}`);
  const dataRoot = requiredEnv('LIMCODE_DELIVERY_DATA_ROOT');
  const conversationId = requiredEnv('LIMCODE_DELIVERY_CONVERSATION');
  const config = JSON.parse(requiredEnv('LIMCODE_DELIVERY_CONFIG'));
  const host = await openHost(dataRoot, scriptedProvider([]), { ...config, label: 'worker', wake: true });
  let everOwned = false;
  const owners = host.app.database.conversationOwners;
  const claims = [];
  for (const method of ['claim', 'tryClaim', 'run', 'tryClaimEligible']) {
    const original = owners[method].bind(owners);
    owners[method] = async (...args) => {
      if (args[0] === conversationId) claims.push(method);
      return original(...args);
    };
  }
  const watch = setInterval(() => { if (host.owns(conversationId)) everOwned = true; }, 5);
  try {
    await host.app.recover();
    await host.runner.recoverStartup();
    // Several delivery and recovery passes.
    for (let i = 0; i < 6; i += 1) {
      await host.app.refreshExternalRuntimeWork();
      host.runner.recoverUnheldTurns();
      await sleep(250);
    }
    await writeJson(requiredEnv('LIMCODE_DELIVERY_READY'), {
      everOwned: everOwned || host.owns(conversationId),
      claims,
      handled: host.handled,
      eligibility: await host.eligibility(conversationId),
      newTurnEntry: await host.entry(conversationId)
    });
    // Stay open (and keep scanning) while the other window works.
    const finish = requiredEnv('LIMCODE_DELIVERY_FINISH');
    for (;;) {
      try { await fs.access(finish); break; } catch { /* not yet */ }
      await host.app.refreshExternalRuntimeWork();
      host.runner.recoverUnheldTurns();
      await sleep(100);
    }
    await writeJson(requiredEnv('LIMCODE_DELIVERY_RESULT'), { everOwned: everOwned || host.owns(conversationId), handled: host.handled });
  } finally {
    clearInterval(watch);
    await host.close();
  }
}

async function openHost(dataRoot, provider, options) {
  const folders = [...options.folders];
  const environments = (options.environments ?? []).map((environment) => ({ ...environment }));
  const frozen = options.frozenRef ?? { value: options.frozen ?? null };
  // Stands in for VscodeConfigurationAuthority.previewWorkEnvironment: an explicit choice first,
  // then the project's own folder; the same policy compile() freezes.
  const previewWorkEnvironment = async (request) => {
    const selected = options.selected;
    const id = selected ?? (request.workspace ? workEnvironmentIdFromUri(request.workspace.uri) : undefined);
    if (!id) return {};
    const available = selected
      ? environments.some((environment) => environment.id === id && environment.available)
      : folders.includes(request.workspace.uri);
    if (!available) return { error: `当前窗口的工作环境不可用：${id}，请打开对应目录或重新选择。` };
    return { workEnvironmentId: id, policy: { id: null, enabled: false, allowedWorkEnvironmentIds: [id], defaultWorkEnvironmentId: id } };
  };
  let coordinator;
  const app = await kernel.ReliableKernelApplication.open(
    new kernel.RootAuthority(() => dataRoot),
    fixtureDependencies(provider, frozen, previewWorkEnvironment, options.children ? () => coordinator : undefined)
  );
  if (options.children) {
    coordinator = new ReliableChildAgentCoordinator({
      database: app.database, ...app.runtime, modelProvider: app.modelProvider, turns: app.turns, agentLoop: app.agentLoop,
      agents: { async resolve() { return { agentId: 'agent-worker', agentType: 'worker' }; } },
      modelProfiles: { async initializeConversation() { return { created: true }; } },
      deliveryWakeups: app.processDeliveries, ownedProcessCleanup: app.childOwnedProcessCleanup, deadHostEffects: app.phaseDRecovery
    });
  }
  const runnerErrors = [];
  const runner = new ReliableConversationRunner(app, `${options.label}:${app.database.hostBootId}`,
    (error, context) => runnerErrors.push({ error, context }));
  const handled = [];
  if (options.wake) {
    const handler = createRuntimeDeliveryWakeHandler({ application: () => app, conversations: () => runner, children: () => coordinator });
    app.processDeliveries.setWakeHandler(async (request) => {
      const result = await handler(request);
      handled.push({ action: request.action, sourceKind: request.sourceKind, sourceTurnId: request.sourceTurnId, ...result });
      return result;
    });
  }
  const base = {
    database: app.database,
    contentStore: app.contentStore,
    workspaceFolderUris: () => folders,
    workEnvironments: async () => environments,
    nextTurnWorkEnvironment: (id, next) => app.turns.previewNextTurnWorkEnvironment(id, next?.executorAgentId)
  };
  // The same wiring as VscodeReliableKernelProductRuntime.
  const eligibility = (conversationId) => evaluateConversationHostEligibility(base, conversationId);
  const entry = (conversationId, next) => evaluateConversationEntryEligibility(base, conversationId, next);
  app.database.conversationOwners.setClaimEligibilityProbe(async (conversationId) => (await eligibility(conversationId)).eligible);
  runner.setEntryEligibility(async (conversationId, next) => {
    try {
      return (await entry(conversationId, next)).eligible ? 'eligible' : 'ineligible';
    } catch {
      return 'unknown';
    }
  });
  let closed = false;
  return {
    app, runner, runnerErrors, folders, environments, eligibility, entry, handled, coordinator,
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

function fixtureDependencies(provider, frozen, previewWorkEnvironment, coordinator) {
  return {
    authorityCompiler: {
      previewWorkEnvironment,
      async compile(request) {
        const defaultWorkEnvironmentId = frozen.value;
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: provider.providerId, modelId: 'delivery-model' }) },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: { providerConfigId: provider.providerId, provider: 'openai-compatible', modelId: 'delivery-model', retryPolicy: { enabled: false, maxRetries: 0 } },
              modelProfile: { compressionThresholdTokens: 100_000, contextWindowTokens: 128_000, tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
              toolPolicy: { id: 'delivery-tools', allowedTools: coordinator ? ['run_agent'] : [], preset: coordinator ? 'yolo' : 'custom', toolConfigs: {}, sourceConfigs: {} },
              planReviewPolicy: { mode: 'off' },
              systemPrompt: { id: 'delivery-prompt', text: '' },
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
    resolveWorkEnvironment: async (id) => ({ id, rootPath: os.tmpdir() }),
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
          definitions() { return coordinator ? [runAgentTool] : []; },
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
  const { outer, dataRoot } = await createIsolatedRoot('h1-handback');
  let setup; let host;
  try {
    const conversationId = 'conversation-h1-handback';
    setup = await openHost(dataRoot, scriptedProvider([{ role: 'model', parts: [{ text: 'A 完成' }] }]), {
      folders: [PROJECT_TWO], label: 'setup', frozen: PROJECT_TWO_ENV, environments: [PROJECT_TWO_RECORD]
    });
    await createConversation(setup.app, conversationId, PROJECT_TWO_FOLDER);
    const turnA = await setup.runner.input({ commandId: 'hb-a', conversationId, text: 'A' });
    await eventually(async () => (await rows(setup.app, 'Turn', { id: turnA.turnId }))[0]?.status === 'terminated', 30_000, 'A 未结束');
    await setup.runner.waitForIdle();
    await pendingProcessDelivery(setup.app, 'proc-handback', conversationId, turnA.turnId);
    await setup.close(); setup = undefined;

    host = await openHost(dataRoot, scriptedProvider([]), {
      folders: [PROJECT_ONE], label: 'hb', frozen: CHOSEN.id, selected: CHOSEN.id, environments: [CHOSEN], wake: true
    });
    // A claim probe that answers eligible (it disagrees with the continuation's own decision).
    host.app.database.conversationOwners.setClaimEligibilityProbe(async () => true);
    await host.app.recover();
    await host.runner.recoverStartup();
    await eventually(async () => {
      await host.app.refreshExternalRuntimeWork();
      return host.handled.length > 0;
    }, 30_000, '投递调度没有处理这条投递');
    assert.deepEqual(host.handled.map((h) => [h.action, h.acknowledged]).slice(0, 1), [['start_continuation', false]]);
    assert.equal(await host.app.database.hasConversationRuntimeWork(conversationId), true, '投递仍待处理');
    await eventually(async () => !host.owns(conversationId), 5_000, '不能执行续跑的窗口仍持有对话归属');
  } finally {
    await setup?.close();
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
};

async function pendingProcessDelivery(app, id, conversationId, sourceTurnId) {
  const repo = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);
  const at = new Date().toISOString();
  const payload = await app.contentStore.prepare(app.database, JSON.stringify({ kind: 'process_completion',
    processId: id, processReceiptId: `receipt-${id}`, sourceTurnId, conversationId }),
  'application/vnd.limcode.process-completion+json');
  await app.database.transaction([
    ...preparedContentObjectSteps([payload], 'fixture_process_result'),
    repo('Process').insert({ id, status: 'exited', wrapper_nonce: `nonce-${id}`, wrapper_pid: 0n, child_pid: null,
      process_group_id: null, start_fingerprint: `fingerprint-${id}`, command_digest: `digest-${id}`,
      spool_locator: `fixture-${id}`, retained_bytes: 0n, retained_chunks: 0n, dropped_bytes: 0n, truncated: 0n,
      started_at: at, updated_at: at, completed_at: at }),
    repo('ProcessCompletionSourceLink').insert({ id: `source-${id}`, process_id: id, conversation_id: conversationId,
      source_turn_id: sourceTurnId, source_tool_call_id: `${id}-tool`, created_at: at }),
    repo('ProcessReceipt').insert({ id: `receipt-${id}`, process_id: id, outcome: 'succeeded', exit_code: 0n,
      exit_signal: null, wrapper_nonce: `nonce-${id}`, start_fingerprint: `fingerprint-${id}`, received_at: at }),
    repo('RuntimeInboxItem').insert({ id, dedupe_key: `fixture:${id}`, source_kind: 'process_receipt',
      source_id: `receipt-${id}`, state: 'available', created_at: at, updated_at: at }),
    repo('RuntimeInboxPayloadLink').insert({ id: `payload-${id}`, inbox_item_id: id,
      content_object_id: payload.metadata.id, created_at: at })
  ]);
  const created = await app.runtime.deliveries.createAutomatic({ inboxItemId: id, targetConversationId: conversationId, sourceTurnId });
  assert.equal(created.delivery.phase, 'next_turn');
  assert.equal(created.delivery.state, 'pending');
  return created;
}
