import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

// The abandon transitions a data-root relocation settles carried results with
// (RuntimeDeliveryControlPlane.abandonPending, ProcessCompletionDeliveryControlPlane.abandonDispatch)
// are control commands: a Conversation another live window holds is that window's, whose own scans
// deliver or settle its results, exactly as the delivery scan leaves foreign rows untouched. Only a
// window that is gone gives the Conversation up. Also: the settlement's inventory request reads on
// the worker's reader connection through its statement cache, all of it in one read snapshot.
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

if (process.env.LIMCODE_ABANDON_OWNER_WORKER) {
  runOwnerWorker().then(
    () => process.exit(0),
    (error) => {
      console.error(error?.stack ?? error);
      process.exit(1);
    }
  );
} else {

test('目标对话被另一个存活窗口持有：放弃待投递与放弃完成派发都返回 live、什么都不改；本窗口自己持有的照常放弃；那个窗口退出后照常放弃', { timeout: 180_000 }, async (t) => {
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
});

test('迁走工作的盘点业务只用 reader 缓存，RootBinding 准入检查照常执行', { timeout: 60_000 }, async (t) => {
  const { dataRoot } = await createIsolatedRoot(t, 'inventory');
  const app = await openApp(dataRoot);
  try {
    // One Conversation with named work and one without (the kernel's pending-work probe decides it).
    await createConversation(app, 'conversation-requester');
    await createConversation(app, 'conversation-peer');
    await createConversation(app, 'conversation-idle');
    await pendingFollowup(app, 'followup-inventory', 'conversation-requester', 'conversation-peer');
    const counters = (cache) => ({ prepares: cache.prepares, hits: cache.hits, misses: cache.misses, uncached: cache.uncached });
    const before = (await app.database.inspect()).statementCache;
    const first = await app.database.relocatedWorkInventory();
    const afterFirst = (await app.database.inspect()).statementCache;
    const second = await app.database.relocatedWorkInventory();
    const afterSecond = (await app.database.inspect()).statementCache;
    assert.deepEqual(second, first);
    assert.deepEqual(first.conversations.map((entry) => [entry.conversationId, entry.pendingDeliveryIds]),
      [['conversation-peer', ['followup-inventory-delivery']]]);
    // Each diagnostics read itself checks RootBinding on the writer. The inventory's domain
    // queries must add no writer prepares/misses/uncached work or any other writer cache hits.
    assert.deepEqual(counters(afterFirst.writer), { ...counters(before.writer), hits: before.writer.hits + 1 },
      '写连接只增加 inspect 自己的 RootBinding 缓存命中');
    assert.deepEqual(counters(afterSecond.writer), { ...counters(before.writer), hits: before.writer.hits + 2 });
    // Nine work lists, the Conversation titles and the pending-work probe (the worker's own probe,
    // prepared once at startup, stays out of the cache).
    assert.equal(afterFirst.reader.misses - before.reader.misses, 11, '第一次在读连接上准备十一条盘点语句');
    assert.equal(afterFirst.reader.prepares - before.reader.prepares, 11);
    assert.equal(afterSecond.reader.misses, afterFirst.reader.misses, '第二次不再准备');
    assert.equal(afterSecond.reader.prepares, afterFirst.reader.prepares);
    assert.equal(afterSecond.reader.hits - afterFirst.reader.hits, 12,
      '第二次十一条盘点语句与一条 RootBinding 准入查询都复用 reader 缓存');
  } finally {
    await app.close();
  }
});

test('盘点在一个读快照里完成：另一个连接同时提交带活动 Turn 的新会话，清单里的会话都连同它的 Turn 列出，不会只剩 otherRuntimeWork', { timeout: 120_000 }, async (t) => {
  const { dataRoot, databasePath } = await createIsolatedRoot(t, 'snapshot');
  const app = await openApp(dataRoot);
  const writer = startRacingWriter(databasePath);
  try {
    await writer.committed(1);
    const torn = [];
    let listed = 0;
    for (let round = 0; round < 120; round += 1) {
      // Synchronize with actual commits, not the relative speed of the reader and racing writer.
      await writer.committed(round + 1);
      for (const entry of (await app.database.relocatedWorkInventory()).conversations) {
        listed += 1;
        if (entry.otherRuntimeWork || entry.activeTurnIds.join() !== `${entry.conversationId}-turn`) torn.push(entry);
      }
    }
    const commits = await writer.stop();
    assert.equal(torn.length, 0, `前后两个快照拼出的清单：${JSON.stringify(torn.slice(0, 2))}`);
    assert.ok(listed > 0, '盘点看到了另一个连接提交的会话');
    assert.ok(commits >= 120, `另一个连接在盘点期间一直在提交（${commits} 次）`);
  } finally {
    await writer.stop();
    await app.close();
  }
});

}

// ---- fixture ----

/** The other window: holds the Conversation with an activity pin (a run in progress) until it is killed. */
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

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment: ${name}`);
  return value;
}

async function createIsolatedRoot(t, label) {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-abandon-ownership-${label}-`));
  t.after(() => fs.rm(outer, { recursive: true, force: true }));
  await fs.mkdir(path.join(outer, 'control'), { recursive: true });
  const candidate = await kernel.resetCandidateRuntimeRoot(path.join(outer, 'control'));
  return { dataRoot: candidate.binding.paths.dataRootPath, databasePath: candidate.binding.paths.databasePath };
}

/**
 * Another connection of the data set (another window, say) committing all the time, with short
 * pauses so the window's own writes get the lock too: each transaction adds a Conversation together
 * with its active Turn and drops the one added 16 transactions earlier, so the inventory stays small.
 */
function startRacingWriter(databasePath) {
  // [0] stop, [1] transactions committed
  const shared = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(`
    const { workerData } = require('node:worker_threads');
    const Database = require(workerData.betterSqlite3);
    const shared = workerData.shared;
    const database = new Database(workerData.databasePath, { fileMustExist: true });
    database.pragma('busy_timeout = 5000');
    database.pragma('synchronous = OFF');
    const addConversation = database.prepare("INSERT INTO conversation (id, title, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)");
    const addTurn = database.prepare("INSERT INTO turn (id, conversation_id, status, created_at, updated_at, terminal_at) VALUES (?, ?, 'active', ?, ?, NULL)");
    const dropTurn = database.prepare('DELETE FROM turn WHERE conversation_id = ?');
    const dropConversation = database.prepare('DELETE FROM conversation WHERE id = ?');
    const commit = database.transaction((n, at) => {
      addConversation.run('racing-' + n, 'racing-' + n, at, at);
      addTurn.run('racing-' + n + '-turn', 'racing-' + n, at, at);
      dropTurn.run('racing-' + (n - 16));
      dropConversation.run('racing-' + (n - 16));
    });
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let n = 0; Atomics.load(shared, 0) === 0; n += 1) {
      commit(n, new Date().toISOString());
      Atomics.add(shared, 1, 1);
      Atomics.wait(pause, 0, 0, 0.2);
    }
    database.close();
  `, { eval: true, workerData: { databasePath, shared, betterSqlite3: require.resolve('better-sqlite3') } });
  const exited = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`并发写入线程退出码 ${code}`))));
  });
  exited.catch(() => {});
  return {
    async committed(count) {
      for (let poll = 0; Atomics.load(shared, 1) < count; poll += 1) {
        if (poll >= 200) throw new Error('并发写入线程一直没有提交。');
        await Promise.race([exited, sleep(25)]);
      }
    },
    async stop() {
      Atomics.store(shared, 0, 1);
      await exited;
      return Atomics.load(shared, 1);
    }
  };
}

/** A window of the data set: opened, not recovered, so nothing runs in it by itself. */
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

/**
 * A cross-conversation followup from `requester` waiting to open a Turn of `peer`: its delivery is
 * pending and its wake pending, nobody claimed it yet (collaboration-lifecycle's fixture).
 */
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

/**
 * A background Process started from `conversationId` that exited while no window ran: its detached
 * process_exit Operation has its receipt and the completion dispatch is still pending, unclaimed.
 */
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

/** The rows an abandonment would change. */
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
