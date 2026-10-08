import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A data-root relocation carries unfinished work unchanged into the new directory and never
// modifies the old one. Before a Host recovers the old directory again ("回到旧目录", another
// installation), that work is closed there as a user's stop, so it never runs a second time.
// Every scenario builds its state in the old directory, relocates for real
// (stageDataRootRelocation + completeDataRootRelocation), then opens the old directory, settles the
// inventory taken from it and runs the full startup recovery with the production wake handler. The
// old directory's Runtime is opened with its convergence held (as when it opens with carried work)
// until its recovery releases it; windows that stand for ordinary running ones are `running`. The
// last group opens it the way Facade.open does (openSettlingRelocatedWork): whatever the settlement
// leaves keeps it closed, nothing is released and nothing runs, and the retry settles all of it.
const root = process.cwd();
const load = (relative) => import(pathToFileURL(path.join(root, 'dist/extension', relative)).href);
const kernel = await load('backend/reliableKernel/index.js');
const { emptyConversationContextHandleStateStep } = await load('backend/reliableKernel/conversationContextHandleState.js');
const { ReliableConversationRunner } = await load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { ReliableChildAgentCoordinator } = await load('backend/reliableKernel/childAgentCoordinator.js');
const { createRuntimeDeliveryWakeHandler } = await load('backend/application/reliableKernel/runtimeDeliveryWakeHandler.js');
const { evaluateConversationHostEligibility } = await load('backend/application/reliableKernel/conversationHostEligibility.js');
const { projectFolderAssignmentSteps } = await load('backend/reliableKernel/conversationProject.js');
const { preparedContentObjectSteps } = await load('backend/reliableKernel/contentObjectTransaction.js');
const { askUserTool } = await load('backend/world/modules/tools/definitions/askUser/index.js');
const { runAgentTool } = await load('backend/world/modules/tools/definitions/runAgent/index.js');
const { inventoryRelocatedWork, parseRelocatedWorkInventory, countRelocatedWork } = await load('backend/reliableKernel/relocatedWorkInventory.js');
const { settleRelocatedWork, settleHistoricalMergeWork, HISTORICAL_MERGE_SETTLEMENT_REASON, relocatedWorkSettlementReason } = await load('backend/application/reliableKernel/relocatedWorkSettlement.js');
const { openSettlingRelocatedWork } = await load('backend/application/reliableKernel/relocatedWorkOpening.js');
const reloc = await import(pathToFileURL(path.join(root, 'tests/reliable-kernel/runtime-data-root-relocation-fixture.mjs')).href);

const PROVIDER_ID = 'relocated-work-provider';
const PROJECT = { uri: 'file:///workspace/relocated-work', name: '迁走项目' };
const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);
const TEST_FILE = fileURLToPath(import.meta.url);
const INSTALLATION_A = '/installations/a';
const INSTALLATION_B = '/installations/b';
/** Windows still open (see openHost): a test that fails before its own close leaves none behind (afterEach). */
const stillOpen = new Set();

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

const workerMode = process.env.LIMCODE_RELOCATED_WORK_WORKER;
if (workerMode) {
  runWorker(workerMode).then(
    () => process.exit(0),
    (error) => {
      console.error(error?.stack ?? error);
      process.exit(1);
    }
  );
} else {

afterEach(async () => { for (const host of [...stillOpen]) await host.close(); });

test('回到旧目录：收尾后启动恢复不再执行已迁走的 Turn（旧目录 0 次、新目录 1 次）；清单可写进 JSON；再次收尾不改变任何东西', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const oldDataRoot = fixture.current.binding.paths.dataRootPath;
  const conversationId = 'conversation-carried';

  // Old directory: a project window admitted a user message's Turn and closed before it called the model.
  const origin = await openHost(oldDataRoot, countingProvider('origin'), { label: 'origin', running: true });
  let turnId;
  try {
    await createConversation(origin.app, conversationId);
    const hostBootId = origin.app.database.hostBootId;
    const admitted = await origin.app.database.conversationOwners.run(conversationId, () => origin.app.turns.input({
      source: { kind: 'command', key: 'input-carried' }, conversationId,
      leaseOwnerId: `origin:${hostBootId}`, hostBootId, leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
      content: '运行一次部署脚本', contentType: 'text/plain; charset=utf-8'
    }));
    assert.equal(admitted.admitted, true);
    turnId = admitted.turnId;
  } finally {
    await origin.close();
  }

  const { target, newDataRoot } = await relocateOldHome(fixture);

  // The inventory of the old directory: plain JSON, listing only the Conversation with carried work.
  const inventory = inventoryOf(oldDataRoot);
  assert.deepEqual(parseRelocatedWorkInventory(JSON.parse(JSON.stringify(inventory))), inventory);
  assert.deepEqual(inventory.conversations.map((entry) => entry.conversationId), [conversationId]);
  assert.deepEqual(inventory.conversations[0].activeTurnIds, [turnId]);
  assert.equal(inventory.conversations[0].title, conversationId);
  assert.equal(countRelocatedWork(inventory).activeTurnIds, 1);

  // New directory: the project window recovers the carried Turn and runs it once.
  const inNew = countingProvider('new-home');
  const newHost = await openHost(newDataRoot, inNew, { label: 'new-home', wake: true, running: true });
  try {
    await newHost.recover();
    await eventually(async () => (await rows(newHost.app, 'Turn', { id: turnId }))[0]?.status === 'terminated', 60_000, '新目录没有执行完');
  } finally {
    await newHost.close();
  }
  assert.equal(inNew.calls.length, 1, '新目录执行一次');

  // Old directory ("回到旧目录"): settled first, then the full startup recovery.
  const inOld = countingProvider('old-home');
  const oldHost = await openHost(oldDataRoot, inOld, { label: 'old-home', wake: true });
  try {
    const messagesBefore = await messageIds(oldHost.app, conversationId);
    const settled = await settleRelocatedWork({ application: oldHost.app, inventory, targetRootPath: target });
    const reason = relocatedWorkSettlementReason(target);
    assert.equal(settled.reason, reason);
    assert.deepEqual(settled.unsettled, []);
    assert.deepEqual(settled.live, []);
    assert.equal(settled.counts.turnsStopped, 1);
    assert.equal((await rows(oldHost.app, 'Turn', { id: turnId }))[0].status, 'terminated', '收尾之后、恢复之前 Turn 已结束');
    assert.equal((await rows(oldHost.app, 'TurnTermination', { turn_id: turnId }))[0].terminal_status, 'interrupted');
    const [stop] = await rows(oldHost.app, 'PendingTurnInput', { turn_id: turnId, input_kind: 'interrupt_request' });
    assert.equal((await readContentJson(oldHost.app, stop.content_object_id)).reason, reason, '停止请求写明数据目录已迁走');

    await oldHost.recover();
    await quiet(oldHost);
    assert.equal(inOld.calls.length, 0, '旧目录不再调用模型');
    await assertMessagesKept(oldHost.app, conversationId, messagesBefore);
    assert.ok(messagesBefore.length > 0);
    assert.deepEqual(errors(oldHost), []);

    // The same inventory again: already closed, nothing changes.
    const snapshot = await turnFacts(oldHost.app, conversationId);
    const again = await settleRelocatedWork({ application: oldHost.app, inventory, targetRootPath: target });
    assert.deepEqual(again.unsettled, []);
    assert.deepEqual(again.live, []);
    assert.deepEqual(Object.values(again.counts).filter((count) => count !== 0), []);
    assert.deepEqual(await turnFacts(oldHost.app, conversationId), snapshot);
    await quiet(oldHost, 500);
    assert.equal(inOld.calls.length, 0);
  } finally {
    await oldHost.close();
  }
});

test('排队消息：收尾取消排队的用户消息并停止当前 Turn，恢复后不准入、不调用模型，消息都还在', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const oldDataRoot = fixture.current.binding.paths.dataRootPath;
  const conversationId = 'conversation-queued';
  const origin = await openHost(oldDataRoot, countingProvider('origin'), { label: 'origin', running: true });
  let turnId;
  let intentId;
  try {
    await createConversation(origin.app, conversationId);
    const hostBootId = origin.app.database.hostBootId;
    const input = (key, content) => origin.app.database.conversationOwners.run(conversationId, () => origin.app.turns.input({
      source: { kind: 'command', key }, conversationId,
      leaseOwnerId: `origin:${hostBootId}`, hostBootId, leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
      content, contentType: 'text/plain; charset=utf-8'
    }));
    const first = await input('input-first', '第一条消息');
    assert.equal(first.admitted, true);
    turnId = first.turnId;
    const second = await input('input-second', '排队的第二条消息');
    assert.notEqual(second.admitted, true, '第二条消息排队');
    intentId = second.intentId;
  } finally {
    await origin.close();
  }
  const { target } = await relocateOldHome(fixture);
  const inventory = inventoryOf(oldDataRoot);
  assert.deepEqual(inventory.conversations[0].queuedIntentIds, [intentId]);

  const inOld = countingProvider('old-home');
  const oldHost = await openHost(oldDataRoot, inOld, { label: 'old-home', wake: true });
  try {
    const messagesBefore = await messageIds(oldHost.app, conversationId);
    const settled = await settleRelocatedWork({ application: oldHost.app, inventory, targetRootPath: target });
    assert.deepEqual(settled.unsettled, []);
    assert.equal(settled.counts.queuedMessagesCancelled, 1);
    assert.equal(settled.counts.turnsStopped, 1);
    assert.equal((await rows(oldHost.app, 'TurnIntent', { id: intentId }))[0].state, 'cancelled');
    await oldHost.recover();
    await quiet(oldHost);
    assert.equal(inOld.calls.length, 0, '排队消息没有被准入执行');
    assert.equal((await rows(oldHost.app, 'Turn', { conversation_id: conversationId, status: 'active' })).length, 0);
    assert.equal((await rows(oldHost.app, 'Turn', { conversation_id: conversationId })).length, 1, '没有新 Turn');
    await assertMessagesKept(oldHost.app, conversationId, messagesBefore);
    assert.deepEqual(errors(oldHost), []);
  } finally {
    await oldHost.close();
  }
});

test('等待回答的提问：收尾关闭提问并中止 Turn，恢复后没有待回答的提问、不调用模型', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const oldDataRoot = fixture.current.binding.paths.dataRootPath;
  const conversationId = 'conversation-ask';
  const origin = await openHost(oldDataRoot, scriptedProvider(() => askCall('ask-1', '要继续吗？')), { label: 'origin', running: true });
  let turnId;
  try {
    await createConversation(origin.app, conversationId);
    turnId = (await origin.runner.input({ commandId: 'input-ask', conversationId, text: '问我一个问题' })).turnId;
    await eventually(async () => (await rows(origin.app, 'InteractionRequest', { status: 'pending' })).length === 1, 30_000, '提问未进入等待');
    await origin.runner.waitForIdle();
  } finally {
    await origin.close();
  }
  const [request] = await withOffline(oldDataRoot, (database) =>
    database.prepare("SELECT id FROM interaction_request WHERE status = 'pending'").all());
  const { target } = await relocateOldHome(fixture);
  const inventory = inventoryOf(oldDataRoot);
  assert.deepEqual(inventory.conversations[0].pendingInteractionIds, [request.id]);
  assert.deepEqual(inventory.conversations[0].activeTurnIds, [turnId]);

  const inOld = countingProvider('old-home');
  const oldHost = await openHost(oldDataRoot, inOld, { label: 'old-home', wake: true });
  try {
    const messagesBefore = await messageIds(oldHost.app, conversationId);
    const settled = await settleRelocatedWork({ application: oldHost.app, inventory, targetRootPath: target });
    assert.deepEqual(settled.unsettled, []);
    assert.equal(settled.counts.turnsStopped, 1);
    assert.equal(settled.counts.interactionsCancelled, 1);
    assert.notEqual((await rows(oldHost.app, 'InteractionRequest', { id: request.id }))[0].status, 'pending', '提问已关闭');
    const [response] = await rows(oldHost.app, 'InteractionResponse', { request_id: request.id });
    assert.equal((await readContentJson(oldHost.app, response.content_object_id)).response.reason,
      relocatedWorkSettlementReason(target), '提问按迁移原因关闭');
    await oldHost.recover();
    await quiet(oldHost);
    assert.equal(inOld.calls.length, 0);
    assert.equal((await rows(oldHost.app, 'InteractionRequest', { status: 'pending' })).length, 0, '旧目录不再提问');
    assert.equal((await rows(oldHost.app, 'Turn', { id: turnId }))[0].status, 'terminated');
    await assertMessagesKept(oldHost.app, conversationId, messagesBefore);
    assert.deepEqual(errors(oldHost), []);
  } finally {
    await oldHost.close();
  }
});

test('运行中的子 Agent（带子树）：父 Turn 停止后级联停止子与孙，恢复后谁都不再执行', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const oldDataRoot = fixture.current.binding.paths.dataRootPath;
  const conversationId = 'conversation-parent';
  const roles = new Map([[conversationId, 'parent']]);
  const origin = await openHost(oldDataRoot, scriptedProvider((request) => {
    let role = roles.get(request.conversationId);
    if (!role) {
      role = roles.size === 1 ? 'child' : 'grandchild';
      roles.set(request.conversationId, role);
    }
    if (role === 'parent') return spawnCall('spawn-child', 'child', '子任务', 600_000);
    if (role === 'child') return spawnCall('spawn-grandchild', 'grandchild', '孙任务', 600_000);
    return askCall('ask-grandchild', '孙 Agent 要继续吗？');
  }), { label: 'origin', running: true });
  let parentTurnId;
  try {
    await createConversation(origin.app, conversationId);
    parentTurnId = (await origin.runner.input({ commandId: 'input-parent', conversationId, text: '派子 Agent' })).turnId;
    await eventually(async () => (await rows(origin.app, 'InteractionRequest', { status: 'pending' })).length === 1, 60_000, '孙 Agent 未进入等待');
  } finally {
    await origin.close();
  }
  const { target } = await relocateOldHome(fixture);
  const inventory = inventoryOf(oldDataRoot);
  const parentEntry = inventory.conversations.find((entry) => entry.conversationId === conversationId);
  assert.equal(parentEntry.childExecutionIds.length, 1, '父对话列出它派出的运行中子 Agent');
  assert.equal(inventory.conversations.length, 3, '父、子、孙三个对话都列出');
  assert.equal(countRelocatedWork(inventory).activeTurnIds, 3);

  const inOld = countingProvider('old-home');
  const oldHost = await openHost(oldDataRoot, inOld, { label: 'old-home', wake: true });
  try {
    const conversationIds = inventory.conversations.map((entry) => entry.conversationId);
    const messagesBefore = await Promise.all(conversationIds.map((id) => messageIds(oldHost.app, id)));
    const settled = await settleRelocatedWork({ application: oldHost.app, inventory, targetRootPath: target });
    assert.deepEqual(settled.unsettled, []);
    assert.deepEqual(settled.live, []);
    assert.equal(settled.rounds, 1, '停下的子树等子调度器收敛，这不算新出现的工作');
    assert.equal(settled.counts.turnsStopped, 1);
    assert.equal(settled.counts.childTurnsStopped, 2, '子与孙的 Turn 都停止');
    assert.equal(settled.counts.childExecutionsInterrupted, 2);
    assert.equal(settled.counts.interactionsCancelled, 1);
    assert.equal((await rows(oldHost.app, 'Turn', { status: 'active' })).length, 0, '收尾后没有活动 Turn');
    assert.equal((await rows(oldHost.app, 'TurnTermination', { turn_id: parentTurnId }))[0].terminal_status, 'interrupted');

    await oldHost.recover();
    await eventually(async () => (await rows(oldHost.app, 'ChildExecution', {}))
      .every((child) => !['starting', 'active', 'interrupting'].includes(String(child.status))), 30_000, '子执行没有收敛');
    await quiet(oldHost);
    assert.equal(inOld.calls.length, 0, '子与孙都不再调用模型');
    assert.equal((await rows(oldHost.app, 'Turn', { status: 'active' })).length, 0);
    assert.equal((await rows(oldHost.app, 'InteractionRequest', { status: 'pending' })).length, 0);
    for (const [index, id] of conversationIds.entries()) await assertMessagesKept(oldHost.app, id, messagesBefore[index]);
    assert.deepEqual(errors(oldHost), []);
  } finally {
    await oldHost.close();
  }
});

test('待投递的子 Agent 答复（投给仍在等待的父 Turn）：收尾时由父 Turn 收进历史，恢复后不续跑', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const oldDataRoot = fixture.current.binding.paths.dataRootPath;
  const conversationId = 'conversation-answer';
  let releaseChild;
  const childGate = new Promise((resolve) => { releaseChild = resolve; });
  let parentCalls = 0;
  const origin = await openHost(oldDataRoot, scriptedProvider(async (request) => {
    if (request.conversationId !== conversationId) {
      await childGate;
      return { role: 'model', parts: [{ text: '子任务完成：结果 42' }] };
    }
    parentCalls += 1;
    return parentCalls === 1
      ? spawnCall('spawn-background', 'background', '后台子任务', 0)
      : askCall('ask-parent', '等子任务的时候先问一句');
  }), { label: 'origin', running: true });
  let parentTurnId;
  try {
    await createConversation(origin.app, conversationId);
    parentTurnId = (await origin.runner.input({ commandId: 'input-answer', conversationId, text: '派后台子 Agent' })).turnId;
    await eventually(async () => (await rows(origin.app, 'InteractionRequest', { status: 'pending' })).length === 1, 60_000, '父 Turn 未进入等待');
    releaseChild();
    await eventually(async () => (await rows(origin.app, 'RuntimeDelivery', { target_conversation_id: conversationId, state: 'pending' })).length === 1,
      60_000, '子 Agent 的答复没有投递给父对话');
  } finally {
    await origin.close();
  }
  const { target } = await relocateOldHome(fixture);
  const inventory = inventoryOf(oldDataRoot);
  const entry = inventory.conversations.find((item) => item.conversationId === conversationId);
  assert.equal(entry.pendingDeliveryIds.length, 1);
  const [deliveryId] = entry.pendingDeliveryIds;

  const inOld = countingProvider('old-home');
  const oldHost = await openHost(oldDataRoot, inOld, { label: 'old-home', wake: true });
  try {
    const [delivery] = await rows(oldHost.app, 'RuntimeDelivery', { id: deliveryId });
    assert.deepEqual([delivery.phase, delivery.target_turn_id], ['current_turn', parentTurnId], '答复投给仍在等待的父 Turn');
    const messagesBefore = await messageIds(oldHost.app, conversationId);
    const settled = await settleRelocatedWork({ application: oldHost.app, inventory, targetRootPath: target });
    assert.deepEqual(settled.unsettled, []);
    assert.equal(settled.counts.turnsStopped, 1);
    assert.equal(settled.counts.deliveriesTakenIn, 1, '答复收进被停止的父 Turn');
    assert.equal((await rows(oldHost.app, 'RuntimeDelivery', { id: deliveryId }))[0].state, 'consumed');
    await oldHost.recover();
    await quiet(oldHost);
    assert.equal(inOld.calls.length, 0, '答复没有让父对话续跑');
    assert.equal((await rows(oldHost.app, 'Turn', { conversation_id: conversationId })).length, 1, '没有续跑 Turn');
    assert.equal((await rows(oldHost.app, 'RuntimeDelivery', { target_conversation_id: conversationId, state: 'pending' })).length, 0);
    await assertMessagesKept(oldHost.app, conversationId, messagesBefore);
    assert.deepEqual(errors(oldHost), []);
  } finally {
    await oldHost.close();
  }
});

test('待投递的进程完成（投给仍在等待的 Turn）：收尾时由该 Turn 收进历史，恢复后不续跑', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const oldDataRoot = fixture.current.binding.paths.dataRootPath;
  const conversationId = 'conversation-process';
  const origin = await openHost(oldDataRoot, scriptedProvider(() => askCall('ask-process', '进程在跑，先问一句')), { label: 'origin', running: true });
  let turnId;
  let deliveryId;
  try {
    await createConversation(origin.app, conversationId);
    turnId = (await origin.runner.input({ commandId: 'input-process', conversationId, text: '启动后台进程' })).turnId;
    await eventually(async () => (await rows(origin.app, 'InteractionRequest', { status: 'pending' })).length === 1, 30_000, 'Turn 未进入等待');
    await origin.runner.waitForIdle();
    const created = await pendingProcessDelivery(origin.app, 'process-carried', conversationId, turnId);
    assert.deepEqual([created.delivery.phase, created.delivery.target_turn_id], ['current_turn', turnId]);
    deliveryId = created.delivery.id;
  } finally {
    await origin.close();
  }
  const { target } = await relocateOldHome(fixture);
  const inventory = inventoryOf(oldDataRoot);
  assert.deepEqual(inventory.conversations[0].pendingDeliveryIds, [deliveryId]);

  const inOld = countingProvider('old-home');
  const oldHost = await openHost(oldDataRoot, inOld, { label: 'old-home', wake: true });
  try {
    const messagesBefore = await messageIds(oldHost.app, conversationId);
    const settled = await settleRelocatedWork({ application: oldHost.app, inventory, targetRootPath: target });
    assert.deepEqual(settled.unsettled, []);
    assert.equal(settled.counts.deliveriesTakenIn, 1);
    assert.equal((await rows(oldHost.app, 'RuntimeDelivery', { id: deliveryId }))[0].state, 'consumed');
    await oldHost.recover();
    await quiet(oldHost);
    assert.equal(inOld.calls.length, 0, '进程完成没有触发续跑');
    assert.equal((await rows(oldHost.app, 'Turn', { conversation_id: conversationId })).length, 1);
    await assertMessagesKept(oldHost.app, conversationId, messagesBefore);
    assert.deepEqual(errors(oldHost), []);
  } finally {
    await oldHost.close();
  }
});

test('已派发未回执的 MCP 调用：派发它的窗口被杀，收尾按迁移原因记为结果未知并中止 Turn，恢复后不重放、不调用模型', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const oldDataRoot = fixture.current.binding.paths.dataRootPath;
  const conversationId = 'conversation-mcp';
  // The window that dispatched the call dies before any receipt (a graceful close records one).
  const ready = path.join(fixture.base, 'mcp-origin-ready.json');
  const child = spawnWorker('mcp-origin', { LIMCODE_RELOCATED_WORK_DATA_ROOT: oldDataRoot,
    LIMCODE_RELOCATED_WORK_CONVERSATION: conversationId, LIMCODE_RELOCATED_WORK_READY: ready });
  let turnId;
  try {
    ({ turnId } = await waitForWorkerJson(child, ready, 90_000));
  } finally {
    child.kill('SIGKILL');
    await waitForExit(child);
  }
  const { target } = await relocateOldHome(fixture);
  const inventory = inventoryOf(oldDataRoot);
  assert.deepEqual(inventory.conversations[0].activeTurnIds, [turnId]);
  assert.equal(inventory.conversations[0].unreceiptedEffectIds.length, 1, 'MCP 调用已派发、没有回执');
  const [effectIntentId] = inventory.conversations[0].unreceiptedEffectIds;

  const inOld = countingProvider('old-home');
  let oldMcpCalls = 0;
  const oldHost = await openHost(oldDataRoot, inOld, { label: 'old-home', wake: true, onMcpCall: () => { oldMcpCalls += 1; } });
  try {
    assert.equal((await rows(oldHost.app, 'EffectIntent', { id: effectIntentId }))[0].dispatch_state, 'dispatched');
    const messagesBefore = await messageIds(oldHost.app, conversationId);
    const settled = await settleRelocatedWork({ application: oldHost.app, inventory, targetRootPath: target });
    assert.deepEqual(settled.unsettled, []);
    assert.equal(settled.counts.turnsStopped, 1);
    assert.equal(settled.counts.effectsClosedAsUnknown, 1);
    assert.equal((await rows(oldHost.app, 'Turn', { id: turnId }))[0].status, 'terminated');
    const [intent] = await rows(oldHost.app, 'EffectIntent', { id: effectIntentId });
    const [receipt] = await rows(oldHost.app, 'EffectReceipt', { attempt_id: intent.attempt_id });
    assert.equal(receipt.outcome, 'outcome_unknown');
    assert.deepEqual(await readContentJson(oldHost.app, receipt.response_object_id), {
      reason: relocatedWorkSettlementReason(target),
      automaticRetry: false
    });
    await oldHost.recover();
    await quiet(oldHost);
    assert.equal(inOld.calls.length, 0);
    assert.equal(oldMcpCalls, 0, '不重放 MCP 调用');
    await assertMessagesKept(oldHost.app, conversationId, messagesBefore);
    assert.deepEqual(errors(oldHost), []);
  } finally {
    await oldHost.close();
  }
});

test('父 Turn 已完成的后台子 Agent（在等提问）：按子对话面板的停止收尾，子 Agent 转为空闲、不发布答复，恢复后父对话不续跑', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const oldDataRoot = fixture.current.binding.paths.dataRootPath;
  const conversationId = 'conversation-detached';
  let parentCalls = 0;
  const origin = await openHost(oldDataRoot, scriptedProvider(async (request) => {
    // The child has output before it asks: a subtree interruption would publish it as an answer.
    if (request.conversationId !== conversationId) {
      const ask = askCall('child-ask', '后台子 Agent 要继续吗？');
      return { ...ask, parts: [{ text: '后台子任务已经完成一半。' }, ...ask.parts] };
    }
    parentCalls += 1;
    return parentCalls === 1
      ? spawnCall('spawn-detached', 'detached', '后台子任务', 0)
      : { role: 'model', parts: [{ text: '父 Turn 已完成' }] };
  }), { label: 'origin', running: true });
  let parentTurnId;
  try {
    await createConversation(origin.app, conversationId);
    parentTurnId = (await origin.runner.input({ commandId: 'input-detached', conversationId, text: '派一个后台子 Agent' })).turnId;
    await eventually(async () => (await rows(origin.app, 'TurnTermination', { turn_id: parentTurnId }))[0]?.terminal_status === 'completed'
      && (await rows(origin.app, 'InteractionRequest', { status: 'pending' })).length === 1, 60_000, '父 Turn 未完成或子 Agent 未提问');
  } finally {
    await origin.close();
  }
  const { target } = await relocateOldHome(fixture);
  const inventory = inventoryOf(oldDataRoot);
  const parentEntry = inventory.conversations.find((entry) => entry.conversationId === conversationId);
  assert.equal(parentEntry.childExecutionIds.length, 1, '父对话列出仍在运行的后台子 Agent');
  const childEntry = inventory.conversations.find((entry) => entry.conversationId !== conversationId);
  assert.equal(childEntry.activeTurnIds.length, 1);

  const inOld = countingProvider('old-home');
  const oldHost = await openHost(oldDataRoot, inOld, { label: 'old-home', wake: true });
  try {
    const [child] = await rows(oldHost.app, 'ChildExecution');
    const [childTurnId] = childEntry.activeTurnIds;
    const messagesBefore = await Promise.all([conversationId, child.child_conversation_id].map((id) => messageIds(oldHost.app, id)));
    const settled = await settleRelocatedWork({ application: oldHost.app, inventory, targetRootPath: target });
    assert.deepEqual(settled.unsettled, [], '后台子 Agent 不再只报告');
    assert.deepEqual(settled.live, []);
    assert.equal(settled.rounds, 1);
    assert.equal(settled.counts.backgroundChildrenStopped, 1);
    assert.equal(settled.counts.childTurnsStopped, 1);
    assert.equal(settled.counts.childExecutionsInterrupted, 0, '不按子树中断，不发布中断答复');
    assert.equal(settled.counts.interactionsCancelled, 1);
    assert.equal((await rows(oldHost.app, 'TurnTermination', { turn_id: childTurnId }))[0].terminal_status, 'interrupted');
    const [stop] = await rows(oldHost.app, 'PendingTurnInput', { turn_id: childTurnId, input_kind: 'interrupt_request' });
    assert.equal((await readContentJson(oldHost.app, stop.content_object_id)).reason, relocatedWorkSettlementReason(target));
    const again = await settleRelocatedWork({ application: oldHost.app, inventory, targetRootPath: target });
    assert.deepEqual(again.unsettled, []);
    assert.deepEqual(Object.values(again.counts).filter((count) => count !== 0), [], '再次收尾不改变任何东西');

    await oldHost.recover();
    await quiet(oldHost);
    assert.equal(inOld.calls.length, 0, '旧目录不再调用模型，父对话不续跑');
    assert.deepEqual((await rows(oldHost.app, 'Turn', { conversation_id: conversationId })).map((turn) => turn.id), [parentTurnId], '父对话没有新的 Turn');
    assert.equal((await rows(oldHost.app, 'ChildExecution', { id: child.id }))[0].status, 'idle', '子 Agent 转为空闲');
    assert.deepEqual(await rows(oldHost.app, 'AnswerSubmission'), [], '子 Agent 没有发布答复');
    assert.deepEqual(await rows(oldHost.app, 'RuntimeDelivery', { target_conversation_id: conversationId }), [], '没有投给父对话的结果');
    await assertMessagesKept(oldHost.app, conversationId, messagesBefore[0]);
    await assertMessagesKept(oldHost.app, child.child_conversation_id, messagesBefore[1]);
    assert.deepEqual(errors(oldHost), []);
  } finally {
    await oldHost.close();
  }
});

test('父 Turn 已完成后才到的子 Agent 答复（会开启新的 Turn）：收尾按“数据目录已迁移”放弃投递、唤醒进死信，子任务投影写明原因；恢复后父对话不续跑；再次收尾不改变任何东西', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const oldDataRoot = fixture.current.binding.paths.dataRootPath;
  const conversationId = 'conversation-late-answer';
  let releaseChild;
  const childGate = new Promise((resolve) => { releaseChild = resolve; });
  let parentCalls = 0;
  const origin = await openHost(oldDataRoot, scriptedProvider(async (request) => {
    if (request.conversationId !== conversationId) {
      await childGate;
      return { role: 'model', parts: [{ text: '子任务完成' }] };
    }
    parentCalls += 1;
    return parentCalls === 1
      ? spawnCall('spawn-late', 'late', '后台子任务', 0)
      : { role: 'model', parts: [{ text: '父 Turn 先结束' }] };
  }), { label: 'origin', running: true });
  let parentTurnId;
  try {
    await createConversation(origin.app, conversationId);
    parentTurnId = (await origin.runner.input({ commandId: 'input-late', conversationId, text: '派后台子 Agent' })).turnId;
    await eventually(async () => (await rows(origin.app, 'Turn', { id: parentTurnId }))[0]?.status === 'terminated', 60_000, '父 Turn 未结束');
    releaseChild();
    await eventually(async () => (await rows(origin.app, 'RuntimeDelivery', { target_conversation_id: conversationId, state: 'pending' })).length === 1,
      60_000, '子 Agent 的答复没有投递给父对话');
  } finally {
    await origin.close();
  }
  const { target } = await relocateOldHome(fixture);
  const inventory = inventoryOf(oldDataRoot);
  const [deliveryId] = inventory.conversations.find((entry) => entry.conversationId === conversationId).pendingDeliveryIds;

  const inOld = countingProvider('old-home');
  const oldHost = await openHost(oldDataRoot, inOld, { label: 'old-home', wake: true });
  try {
    const [before] = await rows(oldHost.app, 'RuntimeDelivery', { id: deliveryId });
    assert.deepEqual([before.phase, before.target_turn_id, before.state], ['next_turn', null, 'pending'], '答复等着开启新的 Turn');
    const settled = await settleRelocatedWork({ application: oldHost.app, inventory, targetRootPath: target });
    assert.deepEqual([settled.unsettled, settled.live, settled.rounds], [[], [], 1]);
    assert.equal(settled.counts.deliveriesAbandoned, 1);
    assert.deepEqual((await rows(oldHost.app, 'RuntimeDelivery', { id: deliveryId })).map((row) => [row.state, row.failure_reason]),
      [['failed', 'data-root-relocated']]);
    await assertWakesDeadLettered(oldHost.app, deliveryId);
    const [task] = (await oldHost.app.runtime.children.readConversationTaskProjection(conversationId)).tasks;
    assert.deepEqual(task.result.deliveries.map((item) => [item.state, item.failureReason, item.failureReasonText]),
      [['failed', 'data-root-relocated', '数据目录已迁移，未送达']], '子任务投影写明数据目录已迁移、未送达');
    await assertSettledAgain(oldHost, inventory, target);
    await recoverIdle(oldHost, inOld);
    assert.deepEqual((await rows(oldHost.app, 'Turn', { conversation_id: conversationId })).map((turn) => turn.id), [parentTurnId], '父对话没有续跑');
    assert.equal((await rows(oldHost.app, 'RuntimeDelivery', { id: deliveryId }))[0].state, 'failed', '恢复不重试放弃的投递');
  } finally {
    await oldHost.close();
  }
});

test('排队的非普通消息（运行时续跑、续写）：收尾取消排在运行中 Turn 后面的两条续跑并停止该 Turn，续跑所属的追问按“数据目录已迁移”放弃，请求方的回复下一轮一并放弃；恢复后不准入、不开新 Turn', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const oldDataRoot = fixture.current.binding.paths.dataRootPath;
  const [conversationId, requester] = ['conversation-queued-intents', 'conversation-queued-requester'];
  let calls = 0;
  const origin = await openHost(oldDataRoot, scriptedProvider(async () => {
    calls += 1;
    return calls === 1 ? { role: 'model', parts: [{ text: '第一个回合结束' }] } : askCall('ask-second', '第二个回合先问一句');
  }), { label: 'origin', running: true });
  let firstTurnId;
  let secondTurnId;
  const deliveryId = 'followup-queued-delivery';
  const queuedIntentIds = [];
  try {
    await createConversation(origin.app, conversationId);
    await createConversation(origin.app, requester);
    firstTurnId = (await origin.runner.input({ commandId: 'input-first', conversationId, text: '第一个回合' })).turnId;
    await eventually(async () => (await rows(origin.app, 'TurnTermination', { turn_id: firstTurnId }))[0]?.terminal_status === 'completed',
      60_000, '第一个回合未完成');
    secondTurnId = (await origin.runner.input({ commandId: 'input-second', conversationId, text: '再问一句' })).turnId;
    await eventually(async () => (await rows(origin.app, 'InteractionRequest', { status: 'pending' })).length === 1, 60_000, '第二个回合未进入等待');
    // A peer's followup starts its own Turn (no other Turn takes it in). Its wake raced the second
    // Turn's admission, so its runtime continuation queues behind that Turn; so does the user's
    // "continue" of the first Turn.
    await pendingFollowup(origin.app, 'followup-queued', requester, conversationId);
    queuedIntentIds.push((await origin.runner.runtimeContinuation({
      commandId: `runtime-delivery:${deliveryId}`, deliveryId, conversationId, sourceTurnId: null
    })).intentId);
    queuedIntentIds.push((await origin.runner.continuation({
      commandId: 'continue-first', conversationId, sourceTurnId: firstTurnId, text: '接着第一个回合做'
    })).intentId);
    for (const intentId of queuedIntentIds) assert.equal((await rows(origin.app, 'TurnIntent', { id: intentId }))[0].state, 'queued');
  } finally {
    await origin.close();
  }
  const { target } = await relocateOldHome(fixture);
  const inventory = inventoryOf(oldDataRoot);
  const entry = inventory.conversations.find((item) => item.conversationId === conversationId);
  assert.deepEqual(entry.queuedIntentIds, [...queuedIntentIds].sort());
  assert.deepEqual([entry.activeTurnIds, entry.pendingDeliveryIds], [[secondTurnId], [deliveryId]]);

  const inOld = countingProvider('old-home');
  const oldHost = await openHost(oldDataRoot, inOld, { label: 'old-home', wake: true });
  try {
    const settled = await settleRelocatedWork({ application: oldHost.app, inventory, targetRootPath: target });
    assert.deepEqual([settled.unsettled, settled.live, settled.rounds], [[], [], 2]);
    assert.equal(settled.counts.queuedIntentsCancelled, 2, '运行时续跑和续写都取消');
    assert.equal(settled.counts.queuedMessagesCancelled, 0);
    assert.equal(settled.counts.turnsStopped, 1);
    assert.equal(settled.counts.interactionsCancelled, 1);
    assert.equal(settled.counts.deliveriesAbandoned, 2, '追问与给请求方的回复');
    for (const intentId of queuedIntentIds) assert.equal((await rows(oldHost.app, 'TurnIntent', { id: intentId }))[0].state, 'cancelled');
    assert.deepEqual((await rows(oldHost.app, 'RuntimeDelivery', { id: deliveryId })).map((row) => [row.state, row.failure_reason]),
      [['failed', 'data-root-relocated']]);
    await assertWakesDeadLettered(oldHost.app, deliveryId, 1);
    await assertSettledAgain(oldHost, inventory, target);
    await recoverIdle(oldHost, inOld);
    assert.deepEqual((await rows(oldHost.app, 'Turn', { conversation_id: conversationId })).map((turn) => turn.id).sort(), [firstTurnId, secondTurnId].sort());
    assert.deepEqual(await rows(oldHost.app, 'Turn', { conversation_id: requester }), []);
  } finally {
    await oldHost.close();
  }
});

test('还没送达的子 Agent 答复（答复已提交、窗口在投递之前关闭）：收尾在同一事务里给它一条已失败的投递、没有唤醒；恢复后不再投递、父对话不续跑', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const oldDataRoot = fixture.current.binding.paths.dataRootPath;
  const conversationId = 'conversation-unrouted';
  let releaseChild;
  const childGate = new Promise((resolve) => { releaseChild = resolve; });
  let parentCalls = 0;
  const origin = await openHost(oldDataRoot, scriptedProvider(async (request) => {
    if (request.conversationId !== conversationId) {
      await childGate;
      return { role: 'model', parts: [{ text: '子任务完成：结果 7' }] };
    }
    parentCalls += 1;
    return parentCalls === 1
      ? spawnCall('spawn-unrouted', 'unrouted', '后台子任务', 0)
      : { role: 'model', parts: [{ text: '父 Turn 先结束' }] };
  }), { label: 'origin', running: true });
  // The answer's submission and its delivery are separate commits: the window stops in between.
  origin.coordinator.deliverBackgroundAnswer = async () => { throw new Error('窗口在答复送达父对话之前关闭'); };
  let parentTurnId;
  let submissionId;
  try {
    await createConversation(origin.app, conversationId);
    parentTurnId = (await origin.runner.input({ commandId: 'input-unrouted', conversationId, text: '派后台子 Agent' })).turnId;
    await eventually(async () => (await rows(origin.app, 'TurnTermination', { turn_id: parentTurnId }))[0]?.terminal_status === 'completed',
      60_000, '父 Turn 未完成');
    releaseChild();
    await eventually(async () => (await rows(origin.app, 'AnswerSubmission')).length === 1, 60_000, '子 Agent 没有提交答复');
    [{ id: submissionId }] = await rows(origin.app, 'AnswerSubmission');
    await origin.coordinator.waitForIdle();
  } finally {
    await origin.close();
  }
  const { target } = await relocateOldHome(fixture);
  const inventory = inventoryOf(oldDataRoot);
  const entry = inventory.conversations.find((item) => item.conversationId === conversationId);
  assert.deepEqual([entry.undeliveredAnswerIds, entry.pendingDeliveryIds], [[submissionId], []], '答复已提交、还没投递');

  const inOld = countingProvider('old-home');
  const oldHost = await openHost(oldDataRoot, inOld, { label: 'old-home', wake: true });
  try {
    assert.deepEqual(await rows(oldHost.app, 'RuntimeDelivery'), []);
    const settled = await settleRelocatedWork({ application: oldHost.app, inventory, targetRootPath: target });
    assert.deepEqual([settled.unsettled, settled.live, settled.rounds], [[], [], 1]);
    assert.equal(settled.counts.answersAbandoned, 1);
    const deliveries = await rows(oldHost.app, 'RuntimeDelivery');
    assert.deepEqual(deliveries.map((row) => [row.target_conversation_id, row.target_turn_id, row.state, row.failure_reason, String(row.attempt_seq)]),
      [[conversationId, null, 'failed', 'data-root-relocated', '1']]);
    const [delivery] = deliveries;
    assert.deepEqual(await rows(oldHost.app, 'RuntimeDeliveryWake', { delivery_id: delivery.id }), [], '已失败的投递没有唤醒');
    assert.equal((await rows(oldHost.app, 'RuntimeInboxItem', { id: delivery.inbox_item_id }))[0].state, 'routed');
    const [task] = (await oldHost.app.runtime.children.readConversationTaskProjection(conversationId)).tasks;
    assert.deepEqual(task.result.deliveries.map((item) => [item.id, item.failureReasonText]), [[delivery.id, '数据目录已迁移，未送达']]);
    await assertSettledAgain(oldHost, inventory, target);
    await recoverIdle(oldHost, inOld);
    assert.deepEqual((await rows(oldHost.app, 'RuntimeDelivery')).map((row) => row.id), [delivery.id], '恢复不再投递这条答复');
    assert.deepEqual((await rows(oldHost.app, 'Turn', { conversation_id: conversationId })).map((turn) => turn.id), [parentTurnId], '父对话没有续跑');
  } finally {
    await oldHost.close();
  }
});

test('已结束、完成通知还没派发的后台进程：收尾把完成派发置为死信，不生成投递；恢复后对话不续跑', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const oldDataRoot = fixture.current.binding.paths.dataRootPath;
  const conversationId = 'conversation-process-exit';
  const origin = await openHost(oldDataRoot, scriptedProvider(() => ({ role: 'model', parts: [{ text: '构建已在后台运行' }] })), { label: 'origin', running: true });
  let turnId;
  let dispatchId;
  try {
    await createConversation(origin.app, conversationId);
    turnId = (await origin.runner.input({ commandId: 'input-process-exit', conversationId, text: '在后台跑构建' })).turnId;
    await eventually(async () => (await rows(origin.app, 'TurnTermination', { turn_id: turnId }))[0]?.terminal_status === 'completed', 30_000, 'Turn 未完成');
    await origin.runner.waitForIdle();
    // The build it started exited after the window closed: its completion notice is not dispatched yet.
    dispatchId = await pendingProcessDispatch(origin.app, 'process-exited', conversationId, turnId);
  } finally {
    await origin.close();
  }
  const { target } = await relocateOldHome(fixture);
  const inventory = inventoryOf(oldDataRoot);
  assert.deepEqual(inventory.conversations.map((entry) => [entry.conversationId, entry.pendingProcessCompletionIds]), [[conversationId, [dispatchId]]]);

  const inOld = countingProvider('old-home');
  const oldHost = await openHost(oldDataRoot, inOld, { label: 'old-home', wake: true });
  try {
    const settled = await settleRelocatedWork({ application: oldHost.app, inventory, targetRootPath: target });
    assert.deepEqual([settled.unsettled, settled.live, settled.rounds], [[], [], 1]);
    assert.equal(settled.counts.processCompletionsAbandoned, 1);
    assert.deepEqual((await rows(oldHost.app, 'ProcessCompletionDispatch', { id: dispatchId }))
      .map((row) => [row.state, row.last_error, row.claim_owner_host_boot_id, row.claim_expires_at]), [['dead_letter', 'data-root-relocated', null, null]]);
    await assertSettledAgain(oldHost, inventory, target);
    await recoverIdle(oldHost, inOld);
    assert.deepEqual(await rows(oldHost.app, 'RuntimeDelivery', { target_conversation_id: conversationId }), [], '没有生成完成投递');
    assert.deepEqual((await rows(oldHost.app, 'Turn', { conversation_id: conversationId })).map((turn) => turn.id), [turnId]);
  } finally {
    await oldHost.close();
  }
});

test('父 Turn 已完成的后台子 Agent（在等提问、还排着一条 send）：先按子对话面板的停止收尾它的 Turn，再按子树中断取消排队的续跑，不发布答复；恢复后谁都不再执行', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const oldDataRoot = fixture.current.binding.paths.dataRootPath;
  const conversationId = 'conversation-detached-queued';
  let parentCalls = 0;
  const origin = await openHost(oldDataRoot, scriptedProvider(async (request) => {
    // The child has output before it asks: an interruption with a termination request would publish it.
    if (request.conversationId !== conversationId) {
      const ask = askCall('child-ask', '后台子 Agent 要继续吗？');
      return { ...ask, parts: [{ text: '后台子任务已经完成一半。' }, ...ask.parts] };
    }
    parentCalls += 1;
    if (parentCalls === 1) return spawnCall('spawn-detached-queued', 'detached', '后台子任务', 0);
    // run_agent send to the child's short reference: it queues after the child's current Turn.
    if (parentCalls === 2) {
      return { role: 'model', parts: [{ id: 'send-detached', functionCall: { name: 'run_agent',
        args: { operation: 'send', childRef: 'A1', prompt: '做完之后再检查一遍' } } }] };
    }
    return { role: 'model', parts: [{ text: '父 Turn 已完成' }] };
  }), { label: 'origin', running: true });
  let parentTurnId;
  try {
    await createConversation(origin.app, conversationId);
    parentTurnId = (await origin.runner.input({ commandId: 'input-detached-queued', conversationId, text: '派一个后台子 Agent，再追加一条任务' })).turnId;
    await eventually(async () => (await rows(origin.app, 'TurnTermination', { turn_id: parentTurnId }))[0]?.terminal_status === 'completed'
      && (await rows(origin.app, 'InteractionRequest', { status: 'pending' })).length === 1
      && (await rows(origin.app, 'ChildExecutionIntentLink', { state: 'pending' })).length === 1, 60_000, '父 Turn 未完成、子 Agent 未提问或 send 没有排队');
  } finally {
    await origin.close();
  }
  const { target } = await relocateOldHome(fixture);
  const inventory = inventoryOf(oldDataRoot);
  const childEntry = inventory.conversations.find((entry) => entry.conversationId !== conversationId);
  assert.equal(childEntry.activeTurnIds.length, 1);
  assert.equal(childEntry.queuedIntentIds.length, 1, 'send 排在子 Agent 当前 Turn 后面');

  const inOld = countingProvider('old-home');
  const oldHost = await openHost(oldDataRoot, inOld, { label: 'old-home', wake: true });
  try {
    const [child] = await rows(oldHost.app, 'ChildExecution');
    const [childTurnId] = childEntry.activeTurnIds;
    const [sendIntentId] = childEntry.queuedIntentIds;
    await assert.rejects(oldHost.app.turns.cancelQueuedIntent({ source: { kind: 'command', key: 'cancel-child-continuation' },
      conversationId: child.child_conversation_id, intentId: sendIntentId, expectedRevisionSeq: '1' }), /lineage interruption cancels it/,
    '子 Agent 的续跑只随子树中断取消');
    const settled = await settleRelocatedWork({ application: oldHost.app, inventory, targetRootPath: target });
    assert.deepEqual([settled.unsettled, settled.live, settled.rounds], [[], [], 1]);
    assert.equal(settled.counts.backgroundChildrenStopped, 1);
    assert.equal(settled.counts.childTurnsStopped, 1);
    assert.equal(settled.counts.interactionsCancelled, 1);
    assert.equal(settled.counts.childExecutionsInterrupted, 1, '排队的续跑随子树中断取消');
    assert.equal(settled.counts.childContinuationsCancelled, 1);
    assert.equal((await rows(oldHost.app, 'TurnTermination', { turn_id: childTurnId }))[0].terminal_status, 'interrupted');
    assert.deepEqual(await rows(oldHost.app, 'PendingTurnInput', { turn_id: childTurnId, input_kind: 'termination_request' }), [],
      '子 Turn 先停下，子树中断不写终止请求');
    assert.equal((await rows(oldHost.app, 'TurnIntent', { id: sendIntentId }))[0].state, 'cancelled');
    await assertSettledAgain(oldHost, inventory, target);
    await recoverIdle(oldHost, inOld);
    assert.deepEqual((await rows(oldHost.app, 'Turn', { conversation_id: conversationId })).map((turn) => turn.id), [parentTurnId], '父对话没有新的 Turn');
    assert.deepEqual((await rows(oldHost.app, 'Turn', { conversation_id: child.child_conversation_id })).map((turn) => turn.id), [childTurnId], '排队的 send 没有开启子 Agent 的新 Turn');
    assert.deepEqual(await rows(oldHost.app, 'AnswerSubmission'), [], '子 Agent 没有发布答复');
    assert.deepEqual(await rows(oldHost.app, 'RuntimeDelivery', { target_conversation_id: conversationId }), [], '没有投给父对话的结果');
  } finally {
    await oldHost.close();
  }
});

test('协作副作用循环收尾：放弃发给对方的追问后，请求方收到“没人会回答”的回复，这条回复又会开启回合，下一轮一并放弃；恢复后两边都不执行', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const oldDataRoot = fixture.current.binding.paths.dataRootPath;
  const [requester, peer] = ['conversation-requester', 'conversation-peer'];
  const origin = await openHost(oldDataRoot, countingProvider('origin'), { label: 'origin', running: true });
  let requesterTurnId;
  try {
    await createConversation(origin.app, requester);
    await createConversation(origin.app, peer);
    // The requester's Turn sent the followup and ended; the reply to it may open a new Turn there.
    requesterTurnId = (await origin.runner.input({ commandId: 'input-requester', conversationId: requester, text: '请对方复核部署脚本' })).turnId;
    await eventually(async () => (await rows(origin.app, 'TurnTermination', { turn_id: requesterTurnId }))[0]?.terminal_status === 'completed',
      30_000, '请求方的回合未完成');
    await origin.runner.waitForIdle();
    await pendingFollowup(origin.app, 'followup-carried', requester, peer, { sourceTurnId: requesterTurnId });
    // A plain message without a wake just waits for the peer's next Turn: it opens none.
    await pendingFollowup(origin.app, 'message-waiting', requester, peer, { mode: 'message' });
  } finally {
    await origin.close();
  }
  const { target } = await relocateOldHome(fixture);
  const inventory = inventoryOf(oldDataRoot);
  assert.deepEqual(inventory.conversations.map((entry) => [entry.conversationId, entry.pendingDeliveryIds]), [[peer, ['followup-carried-delivery']]]);

  const inOld = countingProvider('old-home');
  const oldHost = await openHost(oldDataRoot, inOld, { label: 'old-home', wake: true });
  try {
    const settled = await settleRelocatedWork({ application: oldHost.app, inventory, targetRootPath: target });
    assert.deepEqual([settled.unsettled, settled.live], [[], []]);
    assert.equal(settled.rounds, 2, '第一轮放弃追问，第二轮放弃给请求方的回复');
    assert.equal(settled.counts.deliveriesAbandoned, 2);
    assert.equal((await rows(oldHost.app, 'CollaborationRequest', { id: 'followup-carried-request' }))[0].state, 'failed');
    const [replyLink] = await rows(oldHost.app, 'CollaborationMessageReplyLink', { request_message_id: 'followup-carried' });
    const replyText = (await oldHost.app.runtime.collaboration.readMessage({ conversationId: requester, messageId: replyLink.message_id })).text;
    assert.match(replyText, /data directory was relocated/);
    const replyDeliveries = await rows(oldHost.app, 'RuntimeDelivery', { target_conversation_id: requester });
    assert.deepEqual(replyDeliveries.map((row) => [row.state, row.failure_reason]), [['failed', 'data-root-relocated']]);
    for (const deliveryId of ['followup-carried-delivery', replyDeliveries[0].id]) await assertWakesDeadLettered(oldHost.app, deliveryId, 1);
    assert.equal((await rows(oldHost.app, 'RuntimeDelivery', { id: 'message-waiting-delivery' }))[0].state, 'pending', '不开回合的普通消息留着等下一个回合');
    await assertSettledAgain(oldHost, inventory, target);
    await recoverIdle(oldHost, inOld);
    assert.deepEqual((await rows(oldHost.app, 'Turn')).map((turn) => turn.id), [requesterTurnId], '两边都没有开启新的回合');
  } finally {
    await oldHost.close();
  }
});

test('放弃转换（控制面）：存活宿主的认领没过期就返回 live、什么都不改，认领过期或认领它的窗口已死就照常放弃：一个事务放弃投递、唤醒进死信并取消它排队的运行时续跑；完成派发、未路由的结果与排队的续写同理；重复调用幂等', { timeout: 120_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const conversationId = 'conversation-abandon';
  const reason = 'data-root-relocated';
  const host = await openHost(fixture.current.binding.paths.dataRootPath, scriptedProvider(() => ({ role: 'model', parts: [{ text: '完成' }] })), { label: 'control', running: true });
  try {
    const { app } = host;
    await createConversation(app, conversationId);
    const firstTurnId = (await host.runner.input({ commandId: 'input-control', conversationId, text: '第一个回合' })).turnId;
    await eventually(async () => (await rows(app, 'TurnTermination', { turn_id: firstTurnId }))[0]?.terminal_status === 'completed', 30_000, '第一个回合未完成');
    await host.runner.waitForIdle();
    // A Turn holding the Conversation's execution lease: continuations queue behind it.
    const hostBootId = app.database.hostBootId;
    const lease = { leaseOwnerId: `control:${hostBootId}`, hostBootId, leaseExpiresAt: new Date(Date.now() + 120_000).toISOString() };
    const running = await app.database.conversationOwners.run(conversationId, () => app.turns.input({
      source: { kind: 'command', key: 'input-running' }, conversationId, ...lease, content: '第二个回合', contentType: 'text/plain; charset=utf-8'
    }));
    assert.equal(running.admitted, true);
    // A claim a live Host holds (this very process stands in for it), expiring shortly: live until
    // then, nobody's afterwards. A claim whose Host is gone is stale right away.
    const liveHost = app.database.hostBootId;
    const shortClaim = () => new Date(Date.now() + 1_500).toISOString();
    const longClaim = () => new Date(Date.now() + 600_000).toISOString();
    const untilExpired = (expiresAt) => sleep(Math.max(0, Date.parse(expiresAt) - Date.now()) + 50);

    // abandonPending: a peer's followup whose runtime continuation queued behind the running Turn.
    await createConversation(app, 'conversation-abandon-requester');
    await pendingFollowup(app, 'followup-control', 'conversation-abandon-requester', conversationId);
    const delivery = { id: 'followup-control-delivery' };
    const continuation = await app.database.conversationOwners.run(conversationId, () => app.turns.runtimeContinuation({
      source: { kind: 'internal', key: `runtime-delivery:${delivery.id}` }, conversationId, ...lease, sourceTurnId: null, deliveryId: delivery.id
    }));
    assert.equal((await rows(app, 'TurnIntent', { id: continuation.intentId }))[0].state, 'queued', '续跑排在运行中的 Turn 后面');
    const wakeId = 'followup-control-wake';
    const wakeClaimExpiresAt = shortClaim();
    await app.database.transaction([repo('RuntimeDeliveryWake').update(wakeId, { state: 'claimed', claim_owner_host_boot_id: liveHost,
      claim_generation: 1n, claim_expires_at: wakeClaimExpiresAt, attempt_count: 1n, next_attempt_at: null, updated_at: new Date().toISOString() })]);
    const deliveries = app.runtime.deliveries;
    assert.deepEqual(await deliveries.abandonPending({ deliveryId: delivery.id, reason }), { outcome: 'live' });
    assert.equal((await rows(app, 'RuntimeDelivery', { id: delivery.id }))[0].state, 'pending', '存活宿主认领着唤醒：不动');
    assert.equal((await rows(app, 'RuntimeDeliveryWake', { id: wakeId }))[0].state, 'claimed');
    assert.equal((await rows(app, 'TurnIntent', { id: continuation.intentId }))[0].state, 'queued');
    await untilExpired(wakeClaimExpiresAt);
    assert.deepEqual(await deliveries.abandonPending({ deliveryId: delivery.id, reason }), { outcome: 'abandoned', intentsCancelled: 1 });
    assert.deepEqual((await rows(app, 'RuntimeDelivery', { id: delivery.id })).map((row) => [row.state, row.failure_reason]), [['failed', reason]]);
    await assertWakesDeadLettered(app, delivery.id, 1);
    assert.equal((await rows(app, 'TurnIntent', { id: continuation.intentId }))[0].state, 'cancelled', '同一事务取消它排队的运行时续跑');
    assert.deepEqual(await deliveries.abandonPending({ deliveryId: delivery.id, reason }), { outcome: 'not_pending', state: 'failed' });
    // A wake claimed by a window that crashed: its claim has not expired, but nobody holds it.
    await pendingFollowup(app, 'followup-crashed-claim', 'conversation-abandon-requester', conversationId);
    await app.database.transaction([repo('RuntimeDeliveryWake').update('followup-crashed-claim-wake', { state: 'claimed',
      claim_owner_host_boot_id: 'crashed-host', claim_generation: 1n, claim_expires_at: longClaim(), attempt_count: 1n, next_attempt_at: null,
      updated_at: new Date().toISOString() })]);
    assert.deepEqual(await deliveries.abandonPending({ deliveryId: 'followup-crashed-claim-delivery', reason }), { outcome: 'abandoned', intentsCancelled: 0 },
      '认领它的窗口已经不在：认领作废，照常放弃');
    await assertWakesDeadLettered(app, 'followup-crashed-claim-delivery', 1);

    // createAbandoned
    const inboxItemId = await finishedProcessResult(app, 'process-unrouted', conversationId, firstTurnId);
    const created = await deliveries.createAbandoned({ inboxItemId, targetConversationId: conversationId, reason });
    assert.equal(created.created, true);
    assert.deepEqual((await rows(app, 'RuntimeDelivery', { id: created.deliveryId })).map((row) =>
      [row.inbox_item_id, row.target_turn_id, row.phase, row.state, row.failure_reason, String(row.attempt_seq)]),
    [[inboxItemId, null, 'next_turn', 'failed', reason, '1']]);
    assert.deepEqual(await rows(app, 'RuntimeDeliveryWake', { delivery_id: created.deliveryId }), [], '没有唤醒');
    assert.equal((await rows(app, 'RuntimeInboxItem', { id: inboxItemId }))[0].state, 'routed', '同一事务里路由掉，恢复不会再路由它');
    assert.deepEqual(await deliveries.createAbandoned({ inboxItemId, targetConversationId: conversationId, reason }), { deliveryId: created.deliveryId, created: false });
    const routedElsewhere = await finishedProcessResult(app, 'process-routed', conversationId, firstTurnId);
    await app.database.transaction([repo('RuntimeInboxItem').update(routedElsewhere, { state: 'routed', updated_at: new Date().toISOString() })]);
    await assert.rejects(deliveries.createAbandoned({ inboxItemId: routedElsewhere, targetConversationId: conversationId, reason }), /was routed without a delivery/);

    // abandonDispatch
    const dispatchId = await pendingProcessDispatch(app, 'process-dispatch', conversationId, firstTurnId);
    const dispatchClaimExpiresAt = shortClaim();
    await app.database.transaction([repo('ProcessCompletionDispatch').update(dispatchId, { state: 'claimed', claim_owner_host_boot_id: liveHost,
      claim_generation: 1n, claim_expires_at: dispatchClaimExpiresAt, attempt_count: 1n, updated_at: new Date().toISOString() })]);
    assert.equal(await app.processDeliveries.abandonDispatch({ dispatchId, reason }), 'live');
    assert.equal((await rows(app, 'ProcessCompletionDispatch', { id: dispatchId }))[0].state, 'claimed', '存活宿主认领着：不动');
    await untilExpired(dispatchClaimExpiresAt);
    assert.equal(await app.processDeliveries.abandonDispatch({ dispatchId, reason }), 'abandoned');
    assert.deepEqual((await rows(app, 'ProcessCompletionDispatch', { id: dispatchId })).map((row) =>
      [row.state, row.last_error, row.claim_owner_host_boot_id, row.claim_expires_at]), [['dead_letter', reason, null, null]]);
    assert.equal(await app.processDeliveries.abandonDispatch({ dispatchId, reason }), 'not_pending');
    const crashedDispatchId = await pendingProcessDispatch(app, 'process-crashed-claim', conversationId, firstTurnId);
    await app.database.transaction([repo('ProcessCompletionDispatch').update(crashedDispatchId, { state: 'claimed', claim_owner_host_boot_id: 'crashed-host',
      claim_generation: 1n, claim_expires_at: longClaim(), attempt_count: 1n, updated_at: new Date().toISOString() })]);
    assert.equal(await app.processDeliveries.abandonDispatch({ dispatchId: crashedDispatchId, reason }), 'abandoned', '认领它的窗口已经不在');

    // cancelQueuedIntent
    const continued = await host.runner.continuation({ commandId: 'continue-control', conversationId, sourceTurnId: firstTurnId, text: '接着做' });
    assert.equal((await rows(app, 'TurnIntent', { id: continued.intentId }))[0].state, 'queued');
    const command = { source: { kind: 'command', key: 'cancel-continuation' }, conversationId, intentId: continued.intentId, expectedRevisionSeq: '1' };
    await assert.rejects(app.turns.cancelGuidance({ ...command, source: { kind: 'command', key: 'cancel-as-message' } }), /not an ordinary queued guidance message/);
    await assert.rejects(app.turns.cancelQueuedIntent({ ...command, source: { kind: 'command', key: 'cancel-stale' }, expectedRevisionSeq: '2' }),
      (error) => error.code === 'GUIDANCE_CONTROL_CONFLICT');
    assert.equal((await rows(app, 'TurnIntent', { id: continued.intentId }))[0].state, 'queued', '版本对不上：不动');
    assert.equal((await app.turns.cancelQueuedIntent(command)).deduplicated, false);
    assert.equal((await rows(app, 'TurnIntent', { id: continued.intentId }))[0].state, 'cancelled');
    assert.equal((await app.turns.cancelQueuedIntent(command)).deduplicated, true, '同一命令重复调用幂等');
  } finally {
    await host.close();
  }
});


test('父 Turn 在一个存活的窗口里运行：它还没送达的子 Agent 答复留给那个窗口（live），不在这里放弃；再次收尾结果相同', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const dataRoot = fixture.current.binding.paths.dataRootPath;
  const conversationId = 'conversation-live-parent';
  const ready = path.join(fixture.base, 'live-parent-ready.json');
  const worker = spawnWorker('live-parent', { LIMCODE_RELOCATED_WORK_DATA_ROOT: dataRoot,
    LIMCODE_RELOCATED_WORK_CONVERSATION: conversationId, LIMCODE_RELOCATED_WORK_READY: ready });
  let host;
  try {
    const { turnId, submissionId } = await waitForWorkerJson(worker, ready, 90_000);
    // Still alive (its process identity checks out), but it runs nothing while the settlement runs.
    await sleep(300);
    await reloc.stopOutsideWrites(worker, fixture.current.binding.paths.databasePath);
    const provider = countingProvider('settling');
    host = await openHost(dataRoot, provider, { label: 'settling' });
    const inventory = parseRelocatedWorkInventory(await host.app.database.relocatedWorkInventory());
    const entry = inventory.conversations.find((item) => item.conversationId === conversationId);
    assert.deepEqual([entry.activeTurnIds, entry.undeliveredAnswerIds], [[turnId], [submissionId]]);
    const targetRootPath = path.join(fixture.base, 'new-home');
    const settled = await settleRelocatedWork({ application: host.app, inventory, targetRootPath });
    assert.deepEqual(settled.unsettled, []);
    assert.deepEqual(settled.live, [
      { conversationId, id: turnId, list: 'activeTurnIds' }, { conversationId, id: submissionId, list: 'undeliveredAnswerIds' }
    ], '父 Turn 和它的答复都留给存活的窗口');
    assert.equal(settled.counts.answersAbandoned, 0);
    assert.deepEqual(await rows(host.app, 'RuntimeDelivery'), [], '没有替存活窗口的父 Turn 放弃答复');
    assert.equal((await rows(host.app, 'Turn', { id: turnId }))[0].status, 'active');
    const again = await settleRelocatedWork({ application: host.app, inventory, targetRootPath });
    assert.deepEqual([again.live, again.unsettled], [settled.live, []]);
    assert.deepEqual(await rows(host.app, 'RuntimeDelivery'), []);
    assert.equal(provider.calls.length, 0);
  } finally {
    worker.kill('SIGKILL');
    await waitForExit(worker);
    await host?.close();
  }
});

test('轮间的协作收敛一时出错（另一个窗口同时收敛同样的事实）：这一轮重试，照常收尾，不记 failed；一直出错时只记一条 failed（round），收尾本身不抛错', { timeout: 120_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const [requester, peer] = ['conversation-flaky-requester', 'conversation-flaky-peer'];
  const host = await openHost(fixture.current.binding.paths.dataRootPath, countingProvider('flaky'), { label: 'flaky' });
  try {
    const { app } = host;
    await createConversation(app, requester);
    await createConversation(app, peer);
    await pendingFollowup(app, 'followup-flaky', requester, peer);
    const collaboration = app.runtime.collaboration;
    let calls = 0;
    let failing = 2;
    const application = Object.create(app, { runtime: { value: { ...app.runtime, collaboration: {
      async reconcile() {
        calls += 1;
        if (failing > 0) {
          failing -= 1;
          throw new Error('revision conflict: another Host reconciled this request first');
        }
        await collaboration.reconcile();
      }
    } } } });
    const inventory = parseRelocatedWorkInventory(await app.database.relocatedWorkInventory());
    const targetRootPath = path.join(fixture.base, 'new-home');
    const settled = await settleRelocatedWork({ application, inventory, targetRootPath });
    assert.deepEqual(settled.unsettled, [], '重试之后照常收尾');
    assert.equal(settled.rounds, 2, '放弃追问后给请求方的回复在第二轮放弃');
    assert.ok(calls >= 4, `前两次出错的收敛又试过：${calls}`);

    failing = Infinity;
    const failed = await settleRelocatedWork({ application, inventory, targetRootPath });
    assert.deepEqual(failed.unsettled.map((item) => [item.conversationId, item.list, item.kind, item.id]), [['', 'round', 'failed', 'round-2']]);
    assert.match(failed.unsettled[0].detail, /试了 3 次/);
  } finally {
    await host.close();
  }
});

test('合并前收尾复用离线路径：使用独立原因与文案，最多三轮，剩余工作按对话返回且不处理已剔除对话', { timeout: 120_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const [requester, peer] = ['conversation-endless-requester', 'conversation-endless-peer'];
  // As on opening the old directory: this Runtime's own convergence is held, so it does not reconcile
  // the same collaboration facts at the same time (that made a round fail once in a whole-file run).
  const host = await openHost(fixture.current.binding.paths.dataRootPath, countingProvider('endless'), { label: 'endless' });
  try {
    const { app } = host;
    await createConversation(app, requester);
    await createConversation(app, peer);
    const excluded = 'conversation-excluded';
    await createConversation(app, excluded);
    await pendingFollowup(app, 'excluded-followup', requester, excluded);
    await pendingFollowup(app, 'followup-0', requester, peer);
    // Every convergence between rounds also brings one more followup: work that keeps appearing.
    let appeared = 0;
    const collaboration = app.runtime.collaboration;
    const application = Object.create(app, { runtime: { value: { ...app.runtime, collaboration: {
      async reconcile() {
        await collaboration.reconcile();
        appeared += 1;
        await pendingFollowup(app, `followup-${appeared}`, requester, peer);
      }
    } } } });
    const inventory = parseRelocatedWorkInventory(await app.database.relocatedWorkInventory());
    const settled = await settleHistoricalMergeWork({ application, inventory, excludedConversationIds: new Set(['conversation-excluded']) });
    assert.equal(settled.reason, HISTORICAL_MERGE_SETTLEMENT_REASON);
    const [abandoned] = await rows(app, 'RuntimeDelivery', { id: 'followup-0-delivery' });
    assert.equal(abandoned.failure_reason, 'historical-merge-settled', JSON.stringify(settled));
    const [replyLink] = await rows(app, 'CollaborationMessageReplyLink', { request_message_id: 'followup-0' });
    const reply = await app.runtime.collaboration.readMessage({ conversationId: requester, messageId: replyLink.message_id });
    assert.match(reply.text, /stopped by the user before its history was merged/);
    assert.equal((await rows(app, 'RuntimeDelivery', { id: 'excluded-followup-delivery' }))[0].state, 'pending');
    const shown = JSON.stringify(settled.unsettled);
    assert.equal(settled.rounds, 3, shown);
    assert.equal(appeared, 3, `每轮之后都重新盘点：${shown}`);
    assert.deepEqual(settled.live, []);
    const [lastReply] = await rows(app, 'RuntimeDelivery', { target_conversation_id: requester, state: 'pending' });
    assert.deepEqual(settled.unsettled.map((item) => [item.conversationId, item.kind, item.id, item.list]), [
      [peer, 'rounds_exhausted', 'followup-3-delivery', 'pendingDeliveryIds'], [requester, 'rounds_exhausted', lastReply.id, 'pendingDeliveryIds']
    ], '第 3 轮之后冒出的留下（rounds_exhausted）');
    assert.match(settled.unsettled[0].detail, /收尾 3 轮后仍出现新的可执行项/);
    assert.equal((await rows(app, 'RuntimeDelivery', { id: 'followup-3-delivery' }))[0].state, 'pending', '留下的项这次不收尾');
    assert.equal(settled.counts.deliveriesAbandoned, 5, '3 条追问与前 2 条回复');
  } finally {
    await host.close();
  }
});

// ---- Opening the old directory as Facade.open does (openSettlingRelocatedWork): whatever the
// settlement leaves (failed, rounds_exhausted, needs_human, live) keeps it closed, the Runtime is
// closed again without being released, nothing runs; the retry settles all of it, then opens.

test('不放行（failed）：某一轮协作收敛一直出错（重试 3 次），这次打开失败、运行时关掉、不恢复（照旧放行时请求方收到“没人会回答”的回复会开回合，见审查 RV2）；重试时整库收尾完才放行，旧目录 Provider、工具、进程都是 0 次', { timeout: 300_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  await fundedFollowup(fixture, 'conversation-requester', 'conversation-peer', 'followup-carried');
  await consentAfterRelocation(fixture);
  const provider = countingProvider('old-home');
  const first = await openOldHome(fixture, provider, { wrap: (app) => withCollaboration(app, {
    async reconcile() { throw new Error('revision conflict: another Host reconciled this request first'); }
  }) });
  await assertRefused(fixture, first, [['', 'round', 'round-2', 'failed']]);
  assert.match(first.refused.cause.items[0].detail, /试了 3 次.*revision conflict/);
  assertNothingRan(provider, first);
  await assertRetrySettles(fixture, provider);
});

test('不放行（rounds_exhausted）：每一轮之后都冒出新的可执行工作，收尾 5 轮后还有剩下的，这次打开失败、运行时关掉、不恢复（照旧放行时剩下的追问会开回合，见审查 RV3）；重试时整库收尾完才放行，旧目录 Provider、工具、进程都是 0 次', { timeout: 300_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const [requester, peer] = ['conversation-endless-requester', 'conversation-endless-peer'];
  const requesterTurnId = await fundedFollowup(fixture, requester, peer, 'followup-0');
  await consentAfterRelocation(fixture);
  const provider = countingProvider('old-home');
  let appeared = 0;
  const first = await openOldHome(fixture, provider, { wrap: (app) => {
    const collaboration = app.runtime.collaboration;
    return withCollaboration(app, {
      // Every convergence between rounds also brings one more followup: work that keeps appearing.
      async reconcile() {
        await collaboration.reconcile();
        appeared += 1;
        await pendingFollowup(app, `followup-${appeared}`, requester, peer, { sourceTurnId: requesterTurnId });
      }
    });
  } });
  assert.equal(appeared, 5);
  const left = first.refused?.cause?.items ?? [];
  assert.ok(left.length > 0 && left.every((item) => item.why === 'rounds_exhausted' && item.list === 'pendingDeliveryIds'), JSON.stringify(left));
  assert.ok(left.some((item) => item.conversationId === peer && item.id === 'followup-5-delivery'), JSON.stringify(left));
  await assertRefused(fixture, first, left.map((item) => [item.conversationId, item.list, item.id, 'rounds_exhausted']));
  assertNothingRan(provider, first);
  await assertRetrySettles(fixture, provider);
});

test('不放行（needs_human）：停止路径收不掉的 Turn（这里它的恢复判断是 needs_human），这次打开失败、运行时关掉、不恢复；重试时它照常停下、整库收尾完才放行，旧目录 Provider、工具、进程都是 0 次', { timeout: 300_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const conversationId = 'conversation-needs-human';
  const turnId = await unstartedTurn(fixture, conversationId);
  await consentAfterRelocation(fixture);
  const provider = countingProvider('old-home');
  const first = await openOldHome(fixture, provider, { wrap: (app) => withTurns(app, {
    async recoveryFacts(id) { return { ...(await app.turns.recoveryFacts(id)), judgment: 'needs_human' }; }
  }) });
  await assertRefused(fixture, first, [[conversationId, 'activeTurnIds', turnId, 'needs_human']]);
  assert.match(first.refused.cause.items[0].detail, /终态事实不一致/);
  assertNothingRan(provider, first);
  await assertRetrySettles(fixture, provider);
  const host = await openHost(fixture.current.binding.paths.dataRootPath, countingProvider('reader'), { label: 'reader' });
  try { assert.equal((await rows(host.app, 'Turn', { id: turnId }))[0].status, 'terminated'); } finally { await host.close(); }
});

test('不放行（live：绕过闸门的存活窗口在旧目录里跑着父 Turn，它的子 Agent 答复还没送达）：这次打开失败、运行时关掉、不恢复，答复不在这里放弃；那个窗口没做完就退出后，重试时父 Turn 停下、答复按“数据目录已迁移”放弃，整库收尾完才放行，旧目录 Provider、工具、进程都是 0 次', { timeout: 300_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const dataRoot = fixture.current.binding.paths.dataRootPath;
  await unstartedTurn(fixture, 'conversation-carried');
  await consentAfterRelocation(fixture);
  // A window of the old directory without this gate (e.g. an older version) keeps running a parent Turn there.
  const conversationId = 'conversation-live-parent';
  const ready = path.join(fixture.base, 'live-parent-ready.json');
  const worker = spawnWorker('live-parent', { LIMCODE_RELOCATED_WORK_DATA_ROOT: dataRoot,
    LIMCODE_RELOCATED_WORK_CONVERSATION: conversationId, LIMCODE_RELOCATED_WORK_READY: ready });
  t.after(async () => { worker.kill('SIGKILL'); await waitForExit(worker); });
  const { turnId, submissionId } = await waitForWorkerJson(worker, ready, 90_000);
  await sleep(300);
  await reloc.stopOutsideWrites(worker, fixture.current.binding.paths.databasePath);
  const provider = countingProvider('old-home');
  const first = await openOldHome(fixture, provider);
  await assertRefused(fixture, first, [
    [conversationId, 'activeTurnIds', turnId, 'live'], [conversationId, 'undeliveredAnswerIds', submissionId, 'live']
  ]);
  assertNothingRan(provider, first);
  const reader = await openHost(dataRoot, countingProvider('reader'), { label: 'reader' });
  try { assert.deepEqual(await rows(reader.app, 'RuntimeDelivery'), [], '答复留给存活的窗口，没有在这里放弃'); } finally { await reader.close(); }

  worker.kill('SIGKILL');
  await waitForExit(worker);
  const counts = await assertRetrySettles(fixture, provider);
  assert.equal(counts.answersAbandoned, 1);
});

}

// ---- fixture ----

/** The window that dispatches an MCP call that never answers, then waits to be killed. */
async function runWorker(mode) {
  if (mode === 'live-parent') return runLiveParentWorker();
  if (mode !== 'mcp-origin') throw new Error(`Unknown worker ${mode}.`);
  const dataRoot = requiredEnv('LIMCODE_RELOCATED_WORK_DATA_ROOT');
  const conversationId = requiredEnv('LIMCODE_RELOCATED_WORK_CONVERSATION');
  let hangCalls = 0;
  const host = await openHost(dataRoot, scriptedProvider(() => ({
    role: 'model', parts: [{ id: 'call-hang', functionCall: { name: 'fixture_hang', args: {} } }]
  })), { label: 'origin', running: true, onMcpCall: () => { hangCalls += 1; } });
  await createConversation(host.app, conversationId);
  const { turnId } = await host.runner.input({ commandId: 'input-mcp', conversationId, text: '调用外部工具' });
  await eventually(async () => hangCalls > 0
    && (await rows(host.app, 'EffectIntent', { effect_kind: 'mcp_tool_call', dispatch_state: 'dispatched' })).length === 1,
  30_000, 'MCP 调用未派发');
  const ready = requiredEnv('LIMCODE_RELOCATED_WORK_READY');
  await fs.writeFile(`${ready}.tmp`, JSON.stringify({ turnId }), 'utf8');
  await fs.rename(`${ready}.tmp`, ready);
  await new Promise(() => {});
}

/**
 * A window that keeps running a parent Turn (it waits for the user) while the background child it
 * started already submitted its answer; the answer's delivery, a separate commit, never happens here.
 */
async function runLiveParentWorker() {
  const dataRoot = requiredEnv('LIMCODE_RELOCATED_WORK_DATA_ROOT');
  const conversationId = requiredEnv('LIMCODE_RELOCATED_WORK_CONVERSATION');
  let parentCalls = 0;
  const host = await openHost(dataRoot, scriptedProvider(async (request) => {
    if (request.conversationId !== conversationId) return { role: 'model', parts: [{ text: '子任务完成' }] };
    parentCalls += 1;
    return parentCalls === 1 ? spawnCall('spawn-live', 'live', '后台子任务', 0) : askCall('ask-live', '父 Turn 还在等用户回答');
  }), { label: 'live', running: true });
  host.coordinator.deliverBackgroundAnswer = async () => { throw new Error('答复送达之前窗口被暂停'); };
  await createConversation(host.app, conversationId);
  const { turnId } = await host.runner.input({ commandId: 'input-live', conversationId, text: '派后台子 Agent，然后问一句' });
  await eventually(async () => (await rows(host.app, 'AnswerSubmission')).length === 1
    && (await rows(host.app, 'InteractionRequest', { status: 'pending' })).length === 1, 60_000, '答复没有提交或父 Turn 没有进入等待');
  const [submission] = await rows(host.app, 'AnswerSubmission');
  await host.runner.waitForIdle();
  await host.coordinator.waitForIdle();
  const ready = requiredEnv('LIMCODE_RELOCATED_WORK_READY');
  await fs.writeFile(`${ready}.tmp`, JSON.stringify({ turnId, submissionId: submission.id }), 'utf8');
  await fs.rename(`${ready}.tmp`, ready);
  await new Promise(() => {});
}

function spawnWorker(mode, environment) {
  const child = childProcess.spawn(process.execPath, [TEST_FILE], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment, LIMCODE_RELOCATED_WORK_WORKER: mode },
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

/** Relocated by installation A with its moved notice, and B's "在这里继续" consent for the old directory. */
async function consentAfterRelocation(fixture) {
  const target = path.join(fixture.base, 'new-home');
  const plan = await reloc.planWithRuntime(fixture, target);
  assert.deepEqual(plan.problems, []);
  const options = { movedBy: { id: INSTALLATION_A, label: 'VS Code（A）' }, installation: INSTALLATION_A };
  const source = await reloc.openRuntime(fixture.current);
  let staged;
  try { staged = await reloc.relocation.stageDataRootRelocation(plan, source, options); } finally { await source.close(); }
  await reloc.relocation.completeDataRootRelocation(staged, async () => undefined, options);
  assert.equal(await reloc.relocation.consentToDataRootMovedWork(fixture.root, staged.relocationId, INSTALLATION_B), true);
}

/**
 * Facade.open with the real openSettlingRelocatedWork (see relocated-work-opening): opened with its
 * convergence held when there is carried work, settled (`wrap`: a fault while settling), released
 * only when all of it is settled (`released`: the product runtime's startRecovery waits for it), else
 * closed again and refused.
 */
async function openOldHome(fixture, provider, { wrap = (app) => app } = {}) {
  const state = { hold: undefined, released: false, closed: false, host: undefined, refused: undefined };
  const placement = {
    configurationRootPath: fixture.root,
    runtimeScopeRootPath: reloc.rootAuthority.resolveVscodeRuntimeDataSetScopeRoot(fixture.root, 'default')
  };
  try {
    await openSettlingRelocatedWork(placement, INSTALLATION_B, async (hold) => {
      state.hold = hold;
      state.host = await openHost(fixture.current.binding.paths.dataRootPath, provider, { label: 'old-home', wake: true, holdRuntimeConvergence: hold });
      return {
        application: wrap(state.host.app),
        releaseRelocatedWorkHold: () => { state.released = true; },
        close: async () => { state.closed = true; await state.host.close(); }
      };
    });
  } catch (error) {
    state.refused = error;
    if (state.host && !state.closed) await state.host.close();
  }
  return state;
}

/** Refused with what was left (`[conversation, list, id, why]`), closed without release; the notice stays consented and records it. */
async function assertRefused(fixture, opened, left) {
  assert.equal(opened.refused?.reason, 'moved-work-unsettled', `不放行：${opened.refused?.stack}`);
  assert.deepEqual(opened.refused.cause.items.map((item) => [item.conversationId, item.list, item.id, item.why]), left);
  assert.deepEqual([opened.hold, opened.released, opened.closed], [true, false, true], '扣住打开、没有放行、运行时关掉');
  const settlement = (await reloc.relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets[0].settlement;
  assert.equal(settlement.state, 'consented', '不记已收尾');
  assert.deepEqual(settlement.left.items, opened.refused.cause.items, '记下这次留下了什么、为什么');
}

function assertNothingRan(provider, opened) {
  assert.equal(provider.calls.length, 0, '旧目录不调用模型');
  assert.deepEqual(opened.host.executions, { tools: [], processes: [] }, '旧目录不调用工具、不启动进程');
}

/** The retry: all of it settled and recorded once, released, and the full startup recovery runs nothing. Returns the counts. */
async function assertRetrySettles(fixture, provider) {
  const opened = await openOldHome(fixture, provider);
  assert.equal(opened.refused, undefined, `重试：${opened.refused?.stack}`);
  assert.deepEqual([opened.hold, opened.released], [true, true], '收尾完才放行');
  try {
    await recoverIdle(opened.host, provider);
    assert.deepEqual(opened.host.executions, { tools: [], processes: [] }, '旧目录不调用工具、不启动进程');
  } finally { await opened.host.close(); }
  const settlement = (await reloc.relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets[0].settlement;
  assert.equal(settlement.state, 'settled');
  assert.equal('left' in settlement, false);
  return settlement.result.counts;
}

function withCollaboration(app, collaboration) {
  return Object.create(app, { runtime: { value: { ...app.runtime, collaboration } } });
}

/** The application with some Turn control-plane calls replaced (the rest go to the real one). */
function withTurns(app, overrides) {
  const turns = new Proxy(app.turns, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return Object.create(app, { turns: { value: turns } });
}

/** A requester's completed Turn funds a followup to `peer` that waits to open a Turn there. Returns that Turn. */
async function fundedFollowup(fixture, requester, peer, id) {
  const origin = await openHost(fixture.current.binding.paths.dataRootPath, countingProvider('origin'), { label: 'origin', running: true });
  try {
    await createConversation(origin.app, requester);
    await createConversation(origin.app, peer);
    const { turnId } = await origin.runner.input({ commandId: `input-${id}`, conversationId: requester, text: '请对方复核部署脚本' });
    await eventually(async () => (await rows(origin.app, 'TurnTermination', { turn_id: turnId }))[0]?.terminal_status === 'completed', 30_000, '请求方的回合未完成');
    await origin.runner.waitForIdle();
    await pendingFollowup(origin.app, id, requester, peer, { sourceTurnId: turnId });
    return turnId;
  } finally { await origin.close(); }
}

/** A project window admitted a user message's Turn and closed before it called the model. Returns the Turn. */
async function unstartedTurn(fixture, conversationId) {
  const origin = await openHost(fixture.current.binding.paths.dataRootPath, countingProvider('origin'), { label: 'origin', running: true });
  try {
    await createConversation(origin.app, conversationId);
    const hostBootId = origin.app.database.hostBootId;
    const admitted = await origin.app.database.conversationOwners.run(conversationId, () => origin.app.turns.input({
      source: { kind: 'command', key: `input-${conversationId}` }, conversationId,
      leaseOwnerId: `origin:${hostBootId}`, hostBootId, leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
      content: '运行一次部署脚本', contentType: 'text/plain; charset=utf-8'
    }));
    assert.equal(admitted.admitted, true);
    return admitted.turnId;
  } finally { await origin.close(); }
}

async function relocateOldHome(fixture) {
  const target = path.join(fixture.base, 'new-home');
  const plan = await reloc.planWithRuntime(fixture, target);
  assert.deepEqual(plan.problems, []);
  await reloc.relocate(fixture, plan);
  return { target, newDataRoot: (await reloc.selectedDataSet(target)).runtimeDataRootPath };
}

/** Reads the old directory while no Runtime of this process has it open (the POSIX lock rule). */
function withOffline(dataRoot, read) {
  const database = new reloc.Database(path.join(dataRoot, 'limcode.sqlite'), { readonly: true, fileMustExist: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

function inventoryOf(dataRoot) {
  return withOffline(dataRoot, (database) => inventoryRelocatedWork(database));
}

/**
 * A window of the directory. Its convergence is held from the open, as when the old directory opens
 * with carried work to settle (openSettlingRelocatedWork), until recover() releases it first, as the
 * product runtime's startRecovery does; `running`: an ordinary window whose convergence runs from the
 * start. `executions` records what runs here besides the model: tool calls and process starts.
 */
async function openHost(dataRoot, provider, options) {
  const folders = options.folders ?? [PROJECT.uri];
  const executions = { tools: [], processes: [] };
  let coordinator;
  const app = await kernel.ReliableKernelApplication.open(
    new kernel.RootAuthority(() => dataRoot),
    {
      ...fixtureDependencies(provider, options.onMcpCall ?? (() => undefined), () => coordinator, executions),
      holdRuntimeConvergence: options.holdRuntimeConvergence ?? options.running !== true
    }
  );
  for (const name of ['prepareStart', 'dispatchStart', 'launchDispatched']) {
    const original = app.processes[name].bind(app.processes);
    app.processes[name] = (...input) => { executions.processes.push(name); return original(...input); };
  }
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
  if (options.wake) {
    // The production scheduler for runtime deliveries (VscodeReliableKernelProductRuntime).
    app.processDeliveries.setWakeHandler(createRuntimeDeliveryWakeHandler({
      application: () => app,
      conversations: () => runner,
      children: () => coordinator
    }));
  }
  let closed = false;
  const host = {
    app,
    runner,
    coordinator,
    runnerErrors,
    executions,
    /** VscodeReliableKernelProductRuntime.startRecovery, in its order. */
    async recover() {
      app.releaseRuntimeConvergence();
      await app.recover();
      await coordinator.recoverStartup();
      await runner.recoverStartup();
      await app.refreshExternalRuntimeWork();
    },
    async close() {
      if (closed) return;
      closed = true;
      stillOpen.delete(host);
      runner.dispose();
      await app.beginHandoff().catch(() => undefined);
      await runner.waitForIdle().catch(() => undefined);
      await coordinator.dispose().catch(() => undefined);
      await app.close();
    }
  };
  stillOpen.add(host);
  return host;
}

function fixtureDependencies(provider, onMcpCall, coordinator, executions) {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: PROVIDER_ID, modelId: 'relocated-work-model' }) },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: {
                providerConfigId: PROVIDER_ID,
                provider: 'openai-compatible',
                modelId: 'relocated-work-model',
                retryPolicy: { enabled: false, maxRetries: 0 }
              },
              modelProfile: {
                compressionThresholdTokens: 100_000,
                contextWindowTokens: 128_000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              toolPolicy: {
                id: 'relocated-work-tools',
                allowedTools: ['ask_user', 'run_agent'],
                preset: 'yolo',
                toolConfigs: { run_agent: { config: { maxChildAgentDepth: 3 } } },
                sourceConfigs: { fixture: { enabled: true } }
              },
              planReviewPolicy: { mode: 'off' },
              systemPrompt: { id: 'relocated-work-prompt', text: '' },
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
    processCompletionDelivery: { scanIntervalMs: 50 },
    createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) => {
      const dispatcher = new kernel.ReliableToolDispatcher({
        database,
        contentStore,
        effects: runtime.effects,
        files,
        fileMutations,
        processes,
        mcp,
        interactions,
        host: {
          definitions() { return [hangingMcpTool, askUserTool, runAgentTool]; },
          async dispatchSpecial(_definition, input, authority, signal, admission) {
            return coordinator().dispatch(input, signal, authority, admission);
          },
          async cancelTurnWaits(input) { await coordinator().cancelParentWaits(input); },
          async quiesce(reason) { await coordinator().quiesce(reason); },
          async dispose() {}
        }
      });
      // Every tool call of this window goes through dispatch or dispatchBatch.
      for (const name of ['dispatch', 'dispatchBatch']) {
        const original = dispatcher[name].bind(dispatcher);
        dispatcher[name] = (...input) => { executions.tools.push(name); return original(...input); };
      }
      return dispatcher;
    }
  };
}

/** Every model call is recorded; the reply is a plain final answer. */
function countingProvider(label) {
  return scriptedProvider(() => ({ role: 'model', parts: [{ text: `${label} 已执行` }] }), label);
}

function scriptedProvider(reply, label = 'scripted') {
  const calls = [];
  return {
    providerId: PROVIDER_ID,
    calls,
    async sendFullRequest(request, controls) {
      calls.push({ label, conversationId: request.conversationId });
      const content = await reply(request);
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content });
    }
  };
}

function askCall(id, question) {
  return { role: 'model', parts: [{ id, functionCall: { name: 'ask_user', args: { question, options: [{ label: '继续' }, { label: '停止' }] } } }] };
}

function spawnCall(id, taskName, prompt, foregroundWaitMs) {
  return { role: 'model', parts: [{ id, functionCall: { name: 'run_agent', args: { operation: 'spawn', taskName, prompt, foregroundWaitMs } } }] };
}

async function createConversation(app, conversationId) {
  const now = new Date().toISOString();
  await app.database.transaction([
    repo('Conversation').insert({ id: conversationId, title: conversationId, status: 'active', created_at: now, updated_at: now }),
    emptyConversationContextHandleStateStep(conversationId, now),
    repo('AgentConversationLink').insert({
      id: `link-${conversationId}`, conversation_id: conversationId, agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now
    }),
    ...projectFolderAssignmentSteps({ conversationId, folder: PROJECT, now })
  ]);
}

/** A finished background Process started by `sourceTurnId`, with its automatic delivery (eligibility-delivery-ownership). */
async function pendingProcessDelivery(app, id, conversationId, sourceTurnId) {
  await finishedProcessResult(app, id, conversationId, sourceTurnId);
  return app.runtime.deliveries.createAutomatic({ inboxItemId: id, targetConversationId: conversationId, sourceTurnId });
}

/** A finished background Process's result in the Inbox (the Inbox item `id`), not routed yet. */
async function finishedProcessResult(app, id, conversationId, sourceTurnId) {
  const at = new Date().toISOString();
  const payload = await app.contentStore.prepare(app.database, JSON.stringify({ kind: 'process_completion',
    processId: id, processReceiptId: `receipt-${id}`, sourceTurnId, conversationId }),
  'application/vnd.limcode.process-completion+json');
  await app.database.transaction([
    ...preparedContentObjectSteps([payload], 'fixture_process_result'),
    ...finishedProcessSteps(id, conversationId, sourceTurnId, at),
    repo('RuntimeInboxItem').insert({ id, dedupe_key: `fixture:${id}`, source_kind: 'process_receipt',
      source_id: `receipt-${id}`, state: 'available', created_at: at, updated_at: at }),
    repo('RuntimeInboxPayloadLink').insert({ id: `payload-${id}`, inbox_item_id: id,
      content_object_id: payload.metadata.id, created_at: at })
  ]);
  return id;
}

/**
 * A background Process started by `sourceTurnId` that exited while no window ran: its detached
 * process_exit Operation has its receipt and the completion dispatch is still pending (the scan
 * would turn it into a delivery that continues the Conversation). Returns the dispatch id.
 */
async function pendingProcessDispatch(app, id, conversationId, sourceTurnId) {
  const at = new Date().toISOString();
  const exitRequest = await app.contentStore.prepare(app.database, `{"kind":"process_exit","processId":"${id}"}\n`, 'application/json');
  await app.database.transaction([
    ...preparedContentObjectSteps([exitRequest], 'fixture_process_exit'),
    ...finishedProcessSteps(id, conversationId, sourceTurnId, at),
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

function finishedProcessSteps(id, conversationId, sourceTurnId, at) {
  return [
    repo('Process').insert({ id, status: 'exited', wrapper_nonce: `nonce-${id}`, wrapper_pid: 0n, child_pid: null,
      process_group_id: null, start_fingerprint: `fingerprint-${id}`, command_digest: `digest-${id}`,
      spool_locator: `spool/${id}`, retained_bytes: 0n, retained_chunks: 0n, dropped_bytes: 0n, truncated: 0n,
      started_at: at, updated_at: at, completed_at: at }),
    repo('ProcessCompletionSourceLink').insert({ id: `source-${id}`, process_id: id, conversation_id: conversationId,
      source_turn_id: sourceTurnId, source_tool_call_id: `${id}-tool`, created_at: at }),
    repo('ProcessReceipt').insert({ id: `receipt-${id}`, process_id: id, outcome: 'succeeded', exit_code: 0n,
      exit_signal: null, wrapper_nonce: `nonce-${id}`, start_fingerprint: `fingerprint-${id}`, received_at: at })
  ];
}

/**
 * A cross-conversation followup from `requester` waiting to open a Turn of `peer` (its wake is
 * pending), with its automatic request (collaboration-lifecycle's fixture); with `mode: 'message'`
 * a plain message without request or wake, waiting for the peer's next Turn. The requester's Turn
 * that sent it (`sourceTurnId`) funds the request's budget: only then may the reply that tells the
 * requester the outcome open a Turn there. Ids derive from `id`.
 */
async function pendingFollowup(app, id, requester, peer, { mode = 'followup', sourceTurnId = null } = {}) {
  const now = new Date().toISOString();
  const followup = mode === 'followup';
  const payload = await app.contentStore.ingest(app.database, `请 ${peer} 复核部署脚本`, 'text/vnd.limcode.collaboration-message');
  await app.database.transaction([
    repo('CollaborationMessage').insertWithNextSequence({ id, dedupe_key: id, mode, created_at: now }, { column: 'message_seq', scope: {} }),
    repo('CollaborationMessageSourceLink').insert({ id: `${id}-source`, message_id: id, conversation_id: requester, source_kind: 'tool',
      source_key: id, turn_id: sourceTurnId, tool_call_id: null, created_at: now }),
    repo('RuntimeInboxItem').insert({ id: `${id}-inbox`, dedupe_key: id, source_kind: 'collaboration_message', source_id: id,
      state: 'routed', created_at: now, updated_at: now }),
    repo('CollaborationMessageTargetLink').insert({ id: `${id}-target`, message_id: id, conversation_id: peer, inbox_item_id: `${id}-inbox`,
      anchor_turn_id: null, created_at: now }),
    repo('CollaborationMessagePayloadLink').insert({ id: `${id}-payload`, message_id: id, content_object_id: payload.id, created_at: now }),
    repo('RuntimeInboxPayloadLink').insert({ id: `${id}-inbox-payload`, inbox_item_id: `${id}-inbox`, content_object_id: payload.id, created_at: now }),
    repo('RuntimeDelivery').insert({ id: `${id}-delivery`, inbox_item_id: `${id}-inbox`, target_conversation_id: peer, target_turn_id: null,
      phase: 'next_turn', attempt_seq: 1n, retry_of_delivery_id: null, state: 'pending', failure_reason: null, created_at: now, updated_at: now }),
    ...(followup ? [
      repo('CollaborationBudget').insert({ id: `${id}-budget`, origin_kind: 'turn', origin_key: `${id}-origin`,
        authority_turn_id: sourceTurnId ?? `${id}-historical-turn`, created_at: now }),
      repo('CollaborationRequest').insert({ id: `${id}-request`, message_id: id, budget_id: `${id}-budget`, automatic: 1n, state: 'pending',
        created_at: now, updated_at: now }),
      repo('RuntimeDeliveryWake').insert({ id: `${id}-wake`, delivery_id: `${id}-delivery`, state: 'pending', claim_owner_host_boot_id: null,
        claim_generation: 0n, claim_expires_at: null, attempt_count: 0n, failure_count: 0n, next_attempt_at: now, last_error: null,
        acknowledged_at: null, created_at: now, updated_at: now })
    ] : [])
  ]);
}

/** The delivery's wakes, each dead-lettered with the relocation reason and without a claim (`count` of them when given). */
async function assertWakesDeadLettered(app, deliveryId, count) {
  const wakes = await rows(app, 'RuntimeDeliveryWake', { delivery_id: deliveryId });
  if (count !== undefined) assert.equal(wakes.length, count);
  assert.deepEqual(wakes.map((wake) => [wake.state, wake.last_error, wake.claim_owner_host_boot_id, wake.claim_expires_at]),
    wakes.map(() => ['dead_letter', 'data-root-relocated', null, null]), `投递 ${deliveryId} 的唤醒都进了死信`);
}

/** The same inventory settled again: everything is closed already, one round, nothing changes. */
async function assertSettledAgain(host, inventory, targetRootPath) {
  const before = await settledFacts(host.app);
  const again = await settleRelocatedWork({ application: host.app, inventory, targetRootPath });
  assert.deepEqual([again.unsettled, again.live, again.rounds], [[], [], 1]);
  assert.deepEqual(Object.entries(again.counts).filter(([, count]) => count !== 0), [], '再次收尾不改变任何东西');
  assert.deepEqual(await settledFacts(host.app), before);
}

const SETTLED_DOMAINS = [
  'Turn', 'TurnTermination', 'TurnIntent', 'PendingTurnInput', 'InteractionRequest', 'ChildExecution', 'ChildExecutionIntentLink',
  'AnswerSubmission', 'RuntimeInboxItem', 'RuntimeDelivery', 'RuntimeDeliveryWake', 'ProcessCompletionDispatch',
  'CollaborationRequest', 'CollaborationMessage'
];

async function settledFacts(app) {
  return Object.fromEntries(await Promise.all(SETTLED_DOMAINS.map(async (domain) => [domain, await rows(app, domain)])));
}

/** The full startup recovery after the settlement: no model call, no new Turn, nothing left to run. */
async function recoverIdle(host, provider) {
  const turnsBefore = (await rows(host.app, 'Turn')).map((turn) => turn.id);
  await host.recover();
  await eventually(async () => (await rows(host.app, 'ChildExecution'))
    .every((child) => !['starting', 'active', 'interrupting'].includes(String(child.status))), 30_000, '子执行没有收敛');
  await quiet(host);
  assert.equal(provider.calls.length, 0, '旧目录不调用模型');
  assert.deepEqual((await rows(host.app, 'Turn')).map((turn) => turn.id), turnsBefore, '恢复没有开启新的 Turn');
  assert.deepEqual((await host.app.database.relocatedWorkInventory()).conversations, [], '恢复之后没有待执行的工作');
  assert.deepEqual(errors(host), []);
}

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(repo(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 1_000
  }))).snapshot;
}

async function messageIds(app, conversationId) {
  return (await rows(app, 'MessagePartOfConversation', { conversation_id: conversationId })).map((row) => String(row.message_id)).sort();
}

/** Nothing of the conversation is lost; a stop may add the record of a cancelled tool call. */
async function assertMessagesKept(app, conversationId, before) {
  const after = new Set(await messageIds(app, conversationId));
  assert.deepEqual(before.filter((id) => !after.has(id)), [], `对话 ${conversationId} 的消息都还在`);
}

/** The Turn-level facts a second settlement must leave untouched. */
async function turnFacts(app, conversationId) {
  const turns = await rows(app, 'Turn', { conversation_id: conversationId });
  const facts = [];
  for (const turn of turns) {
    facts.push({
      turn: [turn.id, turn.status, turn.terminal_at],
      terminations: (await rows(app, 'TurnTermination', { turn_id: turn.id })).map((row) => [row.id, row.terminal_status]),
      inputs: (await rows(app, 'PendingTurnInput', { turn_id: turn.id })).map((row) => [row.id, row.state]),
      leases: (await rows(app, 'ExecutionLease', { turn_id: turn.id })).map((row) => [row.id, String(row.generation)])
    });
  }
  return facts;
}

async function readContentJson(app, contentObjectId) {
  const [metadata] = await rows(app, 'ContentObject', { id: contentObjectId });
  return JSON.parse((await app.contentStore.read(metadata)).toString('utf8'));
}

function errors(host) {
  return host.runnerErrors.map((entry) => String(entry.error?.stack ?? entry.error));
}

/** Lets delivery scans, wakes and drives run; a Turn that would run again calls the Provider here. */
async function quiet(host, ms = 2_500) {
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
