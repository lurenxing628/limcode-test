import { createOwnershipScope } from './ownership-scope-fixture.mjs';
// Focused production ownership boundary; old review matrices are absent.
import assert from 'node:assert/strict';

import childProcess from 'node:child_process';

import fs from 'node:fs/promises';

import { createRequire } from 'node:module';

import os from 'node:os';

import path from 'node:path';

import { fileURLToPath, pathToFileURL } from 'node:url';

import { Worker } from 'node:worker_threads';

const root = process.cwd();

const load = (relative) => import(pathToFileURL(path.join(root, 'dist/extension', relative)).href);

const kernel = await load('backend/reliableKernel/index.js');

const { projectFolderAssignmentSteps } = await load('backend/reliableKernel/conversationProject.js');

const { preparedContentObjectSteps } = await load('backend/reliableKernel/contentObjectTransaction.js');

const PROVIDER_ID = 'abandon-ownership-provider';

const PROJECT = { uri: 'file:///workspace/abandon-ownership', name: '放弃与归属' };

const REASON = 'data-root-relocated';

const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);

const TEST_FILE = fileURLToPath(import.meta.url);

const require = createRequire(import.meta.url);

function spawnOwner(dataRoot, conversationId, ready) {
  const child = childProcess.spawn(process.execPath, [TEST_FILE], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LIMCODE_ABANDON_OWNER_WORKER: 'owner',
      LIMCODE_ABANDON_OWNER_DATA_ROOT: dataRoot,
      LIMCODE_ABANDON_OWNER_CONVERSATION: conversationId,
      LIMCODE_ABANDON_OWNER_READY: ready
    },
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

async function createIsolatedRoot(t, label) {
  const h = await createOwnershipScope(label);
  t.after(() => fs.rm(h.outer, { recursive: true, force: true }));
  return { dataRoot: h.dataRoot, databasePath: h.databasePath };
}

async function openApp(dataRoot) {
  return kernel.ReliableKernelApplication.open(new kernel.RootAuthority(() => dataRoot), {
    ...fixtureDependencies(),
    holdRuntimeConvergence: true
  });
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

async function pendingFollowup(app, id, requester, peer) {
  const now = new Date().toISOString();
  const payload = await app.contentStore.ingest(app.database, `请复核部署脚本（${id}）`, 'text/vnd.limcode.collaboration-message');
  await app.database.transaction([
    repo('CollaborationMessage').insertWithNextSequence({ id, dedupe_key: id, mode: 'followup', created_at: now }, { column: 'message_seq', scope: {} }),
    repo('CollaborationMessageSourceLink').insert({ id: `${id}-source`, message_id: id, conversation_id: requester, source_kind: 'tool',
      source_key: id, turn_id: null, tool_call_id: null, created_at: now }),
    repo('RuntimeInboxItem').insert({ id: `${id}-inbox`, dedupe_key: id, source_kind: 'collaboration_message', source_id: id,
      state: 'routed', created_at: now, updated_at: now }),
    repo('CollaborationMessageTargetLink').insert({ id: `${id}-target`, message_id: id, conversation_id: peer, inbox_item_id: `${id}-inbox`,
      anchor_turn_id: null, created_at: now }),
    repo('CollaborationMessagePayloadLink').insert({ id: `${id}-payload`, message_id: id, content_object_id: payload.id, created_at: now }),
    repo('RuntimeInboxPayloadLink').insert({ id: `${id}-inbox-payload`, inbox_item_id: `${id}-inbox`, content_object_id: payload.id, created_at: now }),
    repo('RuntimeDelivery').insert({ id: `${id}-delivery`, inbox_item_id: `${id}-inbox`, target_conversation_id: peer, target_turn_id: null,
      phase: 'next_turn', attempt_seq: 1n, retry_of_delivery_id: null, state: 'pending', failure_reason: null, created_at: now, updated_at: now }),
    repo('CollaborationBudget').insert({ id: `${id}-budget`, origin_kind: 'turn', origin_key: `${id}-origin`,
      authority_turn_id: `${id}-historical-turn`, created_at: now }),
    repo('CollaborationRequest').insert({ id: `${id}-request`, message_id: id, budget_id: `${id}-budget`, automatic: 1n, state: 'pending',
      created_at: now, updated_at: now }),
    repo('RuntimeDeliveryWake').insert({ id: `${id}-wake`, delivery_id: `${id}-delivery`, state: 'pending', claim_owner_host_boot_id: null,
      claim_generation: 0n, claim_expires_at: null, attempt_count: 0n, failure_count: 0n, next_attempt_at: now, last_error: null,
      acknowledged_at: null, created_at: now, updated_at: now })
  ]);
}

async function pendingProcessDispatch(app, id, conversationId) {
  const at = new Date().toISOString();
  const exitRequest = await app.contentStore.prepare(app.database, `{"kind":"process_exit","processId":"${id}"}\n`, 'application/json');
  await app.database.transaction([
    ...preparedContentObjectSteps([exitRequest], 'fixture_process_exit'),
    repo('Process').insert({ id, status: 'exited', wrapper_nonce: `nonce-${id}`, wrapper_pid: 0n, child_pid: null,
      process_group_id: null, start_fingerprint: `fingerprint-${id}`, command_digest: `digest-${id}`,
      spool_locator: `spool/${id}`, retained_bytes: 0n, retained_chunks: 0n, dropped_bytes: 0n, truncated: 0n,
      started_at: at, updated_at: at, completed_at: at }),
    repo('ProcessCompletionSourceLink').insert({ id: `source-${id}`, process_id: id, conversation_id: conversationId,
      source_turn_id: `${id}-turn`, source_tool_call_id: `${id}-tool`, created_at: at }),
    repo('ProcessReceipt').insert({ id: `receipt-${id}`, process_id: id, outcome: 'succeeded', exit_code: 0n,
      exit_signal: null, wrapper_nonce: `nonce-${id}`, start_fingerprint: `fingerprint-${id}`, received_at: at }),
    repo('Operation').insert({ id: `operation-${id}`, owner_kind: 'process', owner_id: id, operation_seq: 1n,
      tool_call_id: null, status: 'succeeded', created_at: at, updated_at: at }),
    repo('Attempt').insert({ id: `attempt-${id}`, operation_id: `operation-${id}`, attempt_seq: 1n, status: 'succeeded',
      created_at: at, updated_at: at, completed_at: at }),
    repo('EffectIntent').insert({ id: `intent-${id}`, attempt_id: `attempt-${id}`, effect_kind: 'process_exit',
      dispatch_state: 'receipt_written', request_object_id: exitRequest.metadata.id, created_at: at, updated_at: at }),
    repo('ProcessCompletionDispatch').insert({ id: `dispatch-${id}`, process_receipt_id: `receipt-${id}`, state: 'pending',
      claim_owner_host_boot_id: null, claim_generation: 0n, claim_expires_at: null, attempt_count: 0n, failure_count: 0n,
      next_attempt_at: null, last_error: null, completed_at: null, created_at: at, updated_at: at })
  ]);
  return `dispatch-${id}`;
}

async function facts(app) {
  return {
    deliveries: await rows(app, 'RuntimeDelivery'),
    wakes: await rows(app, 'RuntimeDeliveryWake'),
    dispatches: await rows(app, 'ProcessCompletionDispatch'),
    requests: await rows(app, 'CollaborationRequest')
  };
}

function fixtureDependencies() {
  const provider = {
    providerId: PROVIDER_ID,
    async sendFullRequest() { throw new Error('这些用例不应调用模型。'); }
  };
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: PROVIDER_ID, modelId: 'abandon-ownership-model' }) },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: { providerConfigId: PROVIDER_ID, provider: 'openai-compatible', modelId: 'abandon-ownership-model', retryPolicy: { enabled: false, maxRetries: 0 } },
              modelProfile: { compressionThresholdTokens: 100_000, contextWindowTokens: 128_000, tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
              toolPolicy: { id: 'abandon-ownership-tools', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
              planReviewPolicy: { mode: 'off' },
              systemPrompt: { id: 'abandon-ownership-prompt', text: '' },
              runtimeContext: { id: null, name: '', template: '' },
              workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
            })
          }
        };
      }
    },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('这些用例不应调用 MCP。'); } },
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
        database, contentStore, effects: runtime.effects, files, fileMutations, processes, mcp, interactions,
        host: { definitions() { return []; }, async cancelTurnWaits() {}, async dispose() {} }
      })
  };
}

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(repo(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 1_000
  }))).snapshot;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const scenario1 = async (t) => {
  const { dataRoot } = await createIsolatedRoot(t, 'owned');
  const [held, mine, requester] = ['conversation-held', 'conversation-mine', 'conversation-requester'];
  const app = await openApp(dataRoot);
  let worker;
  try {
    for (const conversationId of [held, mine, requester]) await createConversation(app, conversationId);
    await pendingFollowup(app, 'followup-held', requester, held);
    await pendingFollowup(app, 'followup-mine', requester, mine);
    const dispatchId = await pendingProcessDispatch(app, 'process-held', held);

    // Another window of the data set holds `held` (its Runner is working on it).
    const ready = path.join(path.dirname(dataRoot), 'owner-ready.json');
    worker = spawnOwner(dataRoot, held, ready);
    const owner = await waitForWorkerJson(worker, ready, 90_000);
    assert.notEqual(owner.hostBootId, app.database.hostBootId);
    const before = await facts(app);

    assert.deepEqual(await app.runtime.deliveries.abandonPending({ deliveryId: 'followup-held-delivery', reason: REASON }), { outcome: 'live' });
    assert.equal(await app.processDeliveries.abandonDispatch({ dispatchId, reason: REASON }), 'live');
    assert.deepEqual(await facts(app), before, '另一个存活窗口持有的对话：投递、唤醒和完成派发都没动');
    assert.equal(app.database.conversationOwners.owns(held), false, '也不占着它');

    // What this window holds itself is its to give up.
    await app.database.conversationOwners.run(mine, async () => {
      assert.deepEqual(await app.runtime.deliveries.abandonPending({ deliveryId: 'followup-mine-delivery', reason: REASON }),
        { outcome: 'abandoned', intentsCancelled: 0 });
    });
    assert.deepEqual((await rows(app, 'RuntimeDelivery', { id: 'followup-mine-delivery' })).map((row) => [row.state, row.failure_reason]),
      [['failed', REASON]]);

    // The window holding `held` is gone: nobody holds it any more, so it is given up here.
    worker.kill('SIGKILL');
    await waitForExit(worker);
    assert.deepEqual(await app.runtime.deliveries.abandonPending({ deliveryId: 'followup-held-delivery', reason: REASON }),
      { outcome: 'abandoned', intentsCancelled: 0 });
    assert.deepEqual((await rows(app, 'RuntimeDelivery', { id: 'followup-held-delivery' })).map((row) => [row.state, row.failure_reason]),
      [['failed', REASON]]);
    assert.deepEqual((await rows(app, 'RuntimeDeliveryWake', { delivery_id: 'followup-held-delivery' })).map((row) => [row.state, row.last_error]),
      [['dead_letter', REASON]]);
    assert.equal(await app.processDeliveries.abandonDispatch({ dispatchId, reason: REASON }), 'abandoned');
    assert.deepEqual((await rows(app, 'ProcessCompletionDispatch', { id: dispatchId })).map((row) => [row.state, row.last_error]),
      [['dead_letter', REASON]]);
    assert.equal(app.database.conversationOwners.owns(held), false, '控制命令做完就交还');
  } finally {
    if (worker) {
      worker.kill('SIGKILL');
      await waitForExit(worker);
    }
    await app.close();
  }
};

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment: ${name}`);
  return value;
}

async function runOwnerWorker() {
  const dataRoot = requiredEnv('LIMCODE_ABANDON_OWNER_DATA_ROOT');
  const conversationId = requiredEnv('LIMCODE_ABANDON_OWNER_CONVERSATION');
  const ready = requiredEnv('LIMCODE_ABANDON_OWNER_READY');
  const app = await openApp(dataRoot);
  let held;
  const holding = new Promise((resolve) => { held = resolve; });
  void app.database.conversationOwners.run(conversationId, () => {
    held();
    return new Promise(() => {});
  });
  await holding;
  await fs.writeFile(`${ready}.tmp`, JSON.stringify({ hostBootId: app.database.hostBootId }), 'utf8');
  await fs.rename(`${ready}.tmp`, ready);
  await new Promise(() => {});
}

if (process.env.LIMCODE_ABANDON_OWNER_WORKER) runOwnerWorker().then(() => process.exit(0), error => { console.error(error?.stack ?? error); process.exit(1); });
