import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A data-root relocation carries unfinished work unchanged into the new directory and never
// modifies the old one. Before a Host recovers the old directory again ("回到旧目录", another
// installation), that work is closed there as a user's stop, so it never runs a second time.
// Every scenario builds its state in the old directory, relocates for real
// (stageDataRootRelocation + completeDataRootRelocation), then opens the old directory, settles the
// inventory taken from it and runs the full startup recovery with the production wake handler.
const root = process.cwd();
const load = (relative) => import(pathToFileURL(path.join(root, 'dist/extension', relative)).href);
const kernel = await load('backend/reliableKernel/index.js');
const { ReliableConversationRunner } = await load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { ReliableChildAgentCoordinator } = await load('backend/reliableKernel/childAgentCoordinator.js');
const { createRuntimeDeliveryWakeHandler } = await load('backend/application/reliableKernel/runtimeDeliveryWakeHandler.js');
const { evaluateConversationHostEligibility } = await load('backend/application/reliableKernel/conversationHostEligibility.js');
const { projectFolderAssignmentSteps } = await load('backend/reliableKernel/conversationProject.js');
const { preparedContentObjectSteps } = await load('backend/reliableKernel/contentObjectTransaction.js');
const { askUserTool } = await load('backend/world/modules/tools/definitions/askUser/index.js');
const { runAgentTool } = await load('backend/world/modules/tools/definitions/runAgent/index.js');
const { inventoryRelocatedWork, parseRelocatedWorkInventory, countRelocatedWork } = await load('backend/reliableKernel/relocatedWorkInventory.js');
const { settleRelocatedWork, relocatedWorkSettlementReason } = await load('backend/application/reliableKernel/relocatedWorkSettlement.js');
const reloc = await import(pathToFileURL(path.join(root, 'tests/reliable-kernel/runtime-data-root-relocation-fixture.mjs')).href);

const PROVIDER_ID = 'relocated-work-provider';
const PROJECT = { uri: 'file:///workspace/relocated-work', name: '迁走项目' };
const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);
const TEST_FILE = fileURLToPath(import.meta.url);

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

test('回到旧目录：收尾后启动恢复不再执行已迁走的 Turn（旧目录 0 次、新目录 1 次）；清单可写进 JSON；再次收尾不改变任何东西', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const oldDataRoot = fixture.current.binding.paths.dataRootPath;
  const conversationId = 'conversation-carried';

  // Old directory: a project window admitted a user message's Turn and closed before it called the model.
  const origin = await openHost(oldDataRoot, countingProvider('origin'), { label: 'origin' });
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
  const newHost = await openHost(newDataRoot, inNew, { label: 'new-home', wake: true });
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
  const origin = await openHost(oldDataRoot, countingProvider('origin'), { label: 'origin' });
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
  const origin = await openHost(oldDataRoot, scriptedProvider(() => askCall('ask-1', '要继续吗？')), { label: 'origin' });
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
  }), { label: 'origin' });
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
  }), { label: 'origin' });
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
  const origin = await openHost(oldDataRoot, scriptedProvider(() => askCall('ask-process', '进程在跑，先问一句')), { label: 'origin' });
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

test('没有现成终态转换的续跑投递只报告不收尾：父 Turn 已完成后才到的子 Agent 答复原样留下并写明原因', { timeout: 240_000 }, async (t) => {
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
  }), { label: 'origin' });
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

  const oldHost = await openHost(oldDataRoot, countingProvider('old-home'), { label: 'old-home' });
  try {
    const [before] = await rows(oldHost.app, 'RuntimeDelivery', { id: deliveryId });
    assert.deepEqual([before.phase, before.target_turn_id, before.state], ['next_turn', null, 'pending'], '答复等着开启新的 Turn');
    const settled = await settleRelocatedWork({ application: oldHost.app, inventory, targetRootPath: target });
    assert.deepEqual(settled.unsettled.map((item) => [item.conversationId, item.kind, item.id]),
      [[conversationId, 'continuation_delivery', deliveryId]]);
    assert.match(settled.unsettled[0].detail, /没有现成的终态转换/);
    const [after] = await rows(oldHost.app, 'RuntimeDelivery', { id: deliveryId });
    assert.deepEqual(after, before, '没有现成终态转换的投递不被改写');
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
  }), { label: 'origin' });
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

}

// ---- fixture ----

/** The window that dispatches an MCP call that never answers, then waits to be killed. */
async function runWorker(mode) {
  if (mode !== 'mcp-origin') throw new Error(`Unknown worker ${mode}.`);
  const dataRoot = requiredEnv('LIMCODE_RELOCATED_WORK_DATA_ROOT');
  const conversationId = requiredEnv('LIMCODE_RELOCATED_WORK_CONVERSATION');
  let hangCalls = 0;
  const host = await openHost(dataRoot, scriptedProvider(() => ({
    role: 'model', parts: [{ id: 'call-hang', functionCall: { name: 'fixture_hang', args: {} } }]
  })), { label: 'origin', onMcpCall: () => { hangCalls += 1; } });
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

async function openHost(dataRoot, provider, options) {
  const folders = options.folders ?? [PROJECT.uri];
  let coordinator;
  const app = await kernel.ReliableKernelApplication.open(
    new kernel.RootAuthority(() => dataRoot),
    fixtureDependencies(provider, options.onMcpCall ?? (() => undefined), () => coordinator)
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
  if (options.wake) {
    // The production scheduler for runtime deliveries (VscodeReliableKernelProductRuntime).
    app.processDeliveries.setWakeHandler(createRuntimeDeliveryWakeHandler({
      application: () => app,
      conversations: () => runner,
      children: () => coordinator
    }));
  }
  let closed = false;
  return {
    app,
    runner,
    coordinator,
    runnerErrors,
    /** VscodeReliableKernelProductRuntime.startRecovery, in its order. */
    async recover() {
      await app.recover();
      await coordinator.recoverStartup();
      await runner.recoverStartup();
      await app.refreshExternalRuntimeWork();
    },
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

function fixtureDependencies(provider, onMcpCall, coordinator) {
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
          definitions() { return [hangingMcpTool, askUserTool, runAgentTool]; },
          async dispatchSpecial(_definition, input, authority, signal, admission) {
            return coordinator().dispatch(input, signal, authority, admission);
          },
          async cancelTurnWaits(input) { await coordinator().cancelParentWaits(input); },
          async quiesce(reason) { await coordinator().quiesce(reason); },
          async dispose() {}
        }
      })
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
    repo('AgentConversationLink').insert({
      id: `link-${conversationId}`, conversation_id: conversationId, agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now
    }),
    ...projectFolderAssignmentSteps({ conversationId, folder: PROJECT, now })
  ]);
}

/** A finished background Process started by `sourceTurnId`, with its automatic delivery (eligibility-delivery-ownership). */
async function pendingProcessDelivery(app, id, conversationId, sourceTurnId) {
  const at = new Date().toISOString();
  const payload = await app.contentStore.prepare(app.database, JSON.stringify({ kind: 'process_completion',
    processId: id, processReceiptId: `receipt-${id}`, sourceTurnId, conversationId }),
  'application/vnd.limcode.process-completion+json');
  await app.database.transaction([
    ...preparedContentObjectSteps([payload], 'fixture_process_result'),
    repo('Process').insert({ id, status: 'exited', wrapper_nonce: `nonce-${id}`, wrapper_pid: 0n, child_pid: null,
      process_group_id: null, start_fingerprint: `fingerprint-${id}`, command_digest: `digest-${id}`,
      spool_locator: `spool/${id}`, retained_bytes: 0n, retained_chunks: 0n, dropped_bytes: 0n, truncated: 0n,
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
  return app.runtime.deliveries.createAutomatic({ inboxItemId: id, targetConversationId: conversationId, sourceTurnId });
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
