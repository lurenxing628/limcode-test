import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Window eligibility, third review round: queued input and runtime deliveries are placed by the work
// environment they froze or will freeze (R1), queued admission retries after a busy or unknown claim
// (R3), a manual compression freezes the work environment the entry approved and never leaves a
// stuck maintenance Turn (R4), and a waiting Turn hands its lease back with its folder (R5).
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
if (workerMode) {
  runWorker(workerMode).then(
    () => process.exit(0),
    (error) => {
      console.error(error?.stack ?? error);
      process.exit(1);
    }
  );
} else {

test('R1：项目移动后按所选工作环境开始的对话，运行中排队的消息在前一个 Turn 结束后被准入并执行；之后的新输入照常接受', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('r1-queued');
  let host;
  try {
    const provider = gatedProvider();
    host = await openHost(dataRoot, provider, { folders: [PROJECT_ONE], label: 'r1', frozen: CHOSEN.id, selected: CHOSEN.id, environments: [CHOSEN] });
    const conversationId = 'conversation-r1';
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const first = await host.runner.input({ commandId: 'r1-1', conversationId, text: '第一条' });
    assert.equal(first.admitted, true);
    await provider.started;
    const second = await host.runner.input({ commandId: 'r1-2', conversationId, text: '第二条' });
    assert.notEqual(second.admitted, true, '第一个 Turn 运行中，第二条排队');
    const [queued] = (await rows(host.app, 'TurnIntent', { conversation_id: conversationId })).filter((r) => r.state === 'queued');
    assert.ok(queued, '第二条是排队的 TurnIntent');
    // 排队 intent 冻结的是所选工作环境：执行资格按它判定，不再退回“项目必须打开”。
    provider.release();
    await eventually(async () => provider.calls === 2, 30_000, '排队的第二条消息没有被准入执行');
    await host.runner.waitForIdle();
    const turns = await rows(host.app, 'Turn', { conversation_id: conversationId });
    assert.deepEqual(turns.map((r) => r.status), ['terminated', 'terminated']);
    assert.deepEqual(await host.eligibility(conversationId), { eligible: true }, '空闲后本窗口仍服务该对话（所选环境可用）');
    const third = await host.runner.input({ commandId: 'r1-3', conversationId, text: '第三条' });
    assert.equal(third.admitted, true, '之后的新输入照常接受');
    await eventually(async () => provider.calls === 3, 30_000, '第三条未执行');
    assert.deepEqual(host.runnerErrors.map((e) => String(e.error?.stack ?? e.error)), []);
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('R1：空闲的已移动对话收到运行时投递：与入口同一判定——按新 Turn 将冻结的环境（继承的源 Turn 的环境，或协作消息按当前设置）决定能否在本窗口续跑', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('r1-delivery');
  let origin; let host;
  try {
    const conversationId = 'conversation-r1-delivery';
    // 移动前：项目二在窗口中打开，Turn A 冻结项目自身的工作环境。
    origin = await openHost(dataRoot, scriptedProvider([{ role: 'model', parts: [{ text: '完成 A' }] }]), {
      folders: [PROJECT_TWO], label: 'origin', frozen: PROJECT_TWO_ENV,
      environments: [{ id: PROJECT_TWO_ENV, name: '项目二', displayPath: '/workspace/project-two', available: true }]
    });
    await createConversation(origin.app, conversationId, PROJECT_TWO_FOLDER);
    const turnA = await origin.runner.input({ commandId: 'a', conversationId, text: 'A' });
    await eventually(async () => (await rows(origin.app, 'Turn', { id: turnA.turnId }))[0]?.status === 'terminated', 30_000, 'A 未结束');
    await origin.close(); origin = undefined;
    // 移动后：本窗口没有项目二，用户为对话选择了 work-env-chosen，Turn B 冻结它。
    host = await openHost(dataRoot, scriptedProvider([{ role: 'model', parts: [{ text: '完成 B' }] }]), {
      folders: [PROJECT_ONE], label: 'moved', frozen: CHOSEN.id, selected: CHOSEN.id, environments: [CHOSEN]
    });
    await host.app.recover();
    await host.runner.recoverStartup();
    const turnB = await host.runner.input({ commandId: 'b', conversationId, text: 'B' });
    await eventually(async () => (await rows(host.app, 'Turn', { id: turnB.turnId }))[0]?.status === 'terminated', 30_000, 'B 未结束');
    await host.runner.waitForIdle();
    await host.app.database.conversationOwners.releaseIfIdle(conversationId);
    // 投递调度的所有权闸门：空闲的已移动对话在本窗口可被认领（下一个 Turn 可在这里开始）。
    assert.deepEqual(await host.eligibility(conversationId), { eligible: true });
    assert.equal(await host.app.database.conversationOwners.tryClaimEligible(conversationId), 'owned');
    // The admission itself (Runner.runtimeContinuation) makes the same decision before writing anything.
    await assert.rejects(host.runner.runtimeContinuation({ commandId: 'from-a-direct', deliveryId: 'delivery-not-written',
      conversationId, sourceTurnId: turnA.turnId }), (error) => isConversationHostIneligibleError(error));
    const started = [];
    host.runner.runtimeContinuation = async (input) => { started.push(input.sourceTurnId); return { intentId: `intent-${started.length}` }; };
    const handler = createRuntimeDeliveryWakeHandler({ application: () => host.app, conversations: () => host.runner, children: () => undefined });
    // As ProcessCompletionDeliveryScheduler does: its ownership gate claims (execution eligibility), then
    // runs the wake handler under an activity pin.
    const owners = host.app.database.conversationOwners;
    const wake = async (input) => {
      assert.equal(await owners.tryClaimEligible(conversationId), 'owned', '投递调度的闸门在本窗口认领');
      return owners.run(conversationId, () => handler(input));
    };
    const request = (sourceKind, sourceTurnId, deliveryId) => ({
      wakeId: `wake-${deliveryId}`, deliveryId, inboxItemId: `inbox-${deliveryId}`, sourceKind, sourceId: `source-${deliveryId}`,
      conversationId, sourceTurnId, targetTurnId: null, contentObjectId: 'content', action: 'start_continuation'
    });
    // 后台进程由 Turn B 启动：续跑继承 B 的权限（所选环境），在本窗口续跑。
    assert.deepEqual(await wake(request('process_receipt', turnB.turnId, 'from-b')), { acknowledged: true });
    // 由移动前的 Turn A 启动：续跑会冻结旧项目的环境，本窗口不能执行，投递留给能执行它的窗口。
    assert.deepEqual(await wake(request('process_receipt', turnA.turnId, 'from-a')), { acknowledged: false });
    // 协作消息按当前设置编译：与新输入相同，看所选环境。
    assert.deepEqual(await wake(request('collaboration_message', turnA.turnId, 'peer')), { acknowledged: true });
    assert.deepEqual(started, [turnB.turnId, null], '只有能在本窗口执行的续跑被发起');
    // 入口判定与之一致（Runner.runtimeContinuation 用的同一函数）。
    assert.equal(await host.runner.continuationEligibility(conversationId, turnA.turnId), 'ineligible');
    assert.equal(await host.runner.continuationEligibility(conversationId, turnB.turnId), 'eligible');
  } finally {
    await origin?.close();
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('入口资格也看排队的 TurnIntent：暂停中的排队消息冻结了旧项目环境时，本窗口即使可选别的环境也不接受新输入', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('entry-queued');
  let origin; let host;
  try {
    const conversationId = 'conversation-entry-queued';
    const provider = gatedProvider();
    origin = await openHost(dataRoot, provider, {
      folders: [PROJECT_TWO], label: 'origin', frozen: PROJECT_TWO_ENV,
      environments: [{ id: PROJECT_TWO_ENV, name: '项目二', displayPath: '/workspace/project-two', available: true }]
    });
    await createConversation(origin.app, conversationId, PROJECT_TWO_FOLDER);
    const first = await origin.runner.input({ commandId: 'q-1', conversationId, text: '第一条' });
    await provider.started;
    await origin.runner.input({ commandId: 'q-2', conversationId, text: '排队并暂停' });
    const [queued] = (await rows(origin.app, 'TurnIntent', { conversation_id: conversationId })).filter((r) => r.state === 'queued');
    const revisions = await rows(origin.app, 'TurnIntentRevision', { intent_id: queued.id });
    const hold = await origin.runner.setGuidanceHold({
      commandId: 'q-hold', conversationId, intentId: queued.id,
      expectedRevisionSeq: String(revisions.map((r) => BigInt(r.revision_seq)).reduce((a, b) => (a > b ? a : b))), hold: 'paused'
    }).catch((error) => error);
    assert.ok(!(hold instanceof Error), `暂停排队消息失败：${hold?.message}`);
    provider.release();
    await eventually(async () => (await rows(origin.app, 'Turn', { id: first.turnId }))[0]?.status === 'terminated', 30_000, '第一个 Turn 未结束');
    await origin.runner.waitForIdle();
    await origin.close(); origin = undefined;
    host = await openHost(dataRoot, scriptedProvider([]), {
      folders: [PROJECT_ONE], label: 'moved', frozen: CHOSEN.id, selected: CHOSEN.id, environments: [CHOSEN]
    });
    await host.app.recover();
    await host.runner.recoverStartup();
    assert.equal((await rows(host.app, 'TurnIntent', { id: queued.id }))[0]?.state, 'queued', '排队消息仍在（暂停）');
    assert.equal((await host.entry(conversationId)).reason, 'project_not_open', '排队的消息要在打开项目的窗口执行');
    await assert.rejects(host.runner.input({ commandId: 'q-3', conversationId, text: '新消息' }), (error) => isConversationHostIneligibleError(error));
    assert.equal((await rows(host.app, 'TurnIntent', { conversation_id: conversationId })).length, 2, '未写入新的 TurnIntent');
  } finally {
    await origin?.close();
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('R3：准入因资格探针暂时失败被挡下后按退避自动重试；探针恢复后排队消息被准入并执行', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('r3-admission');
  let host;
  try {
    const provider = gatedProvider();
    host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'r3' });
    const conversationId = 'conversation-r3';
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const first = await host.runner.input({ commandId: 'r3-1', conversationId, text: '第一条' });
    await provider.started;
    await host.runner.input({ commandId: 'r3-2', conversationId, text: '第二条（排队）' });
    host.failProbe = true;
    provider.release();
    await eventually(async () => (await rows(host.app, 'Turn', { id: first.turnId }))[0]?.status === 'terminated', 30_000, '第一个 Turn 未结束');
    await sleep(300);
    const probesWhileFailing = host.probeCalls;
    assert.equal(provider.calls, 1, '探针失败期间不准入');
    host.failProbe = false;
    // 没有新输入、重扫或外部提交：只靠准入自己的退避重试。
    await eventually(async () => provider.calls === 2, 10_000, '探针恢复后排队的第二条消息没有被准入');
    await host.runner.waitForIdle();
    const intents = await rows(host.app, 'TurnIntent', { conversation_id: conversationId });
    assert.deepEqual(intents.map((r) => r.state === 'queued'), [false, false], '两条都已准入');
    assert.deepEqual((await rows(host.app, 'Turn', { conversation_id: conversationId })).map((r) => r.status), ['terminated', 'terminated']);
    assert.ok(probesWhileFailing >= 1);
    assert.deepEqual(host.runnerErrors.map((e) => String(e.error?.stack ?? e.error)), []);
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('R4：项目移动后在本窗口选择工作环境再手动压缩：维护 Turn 继承源 Turn 的其余权限，工作环境换成入口批准的所选环境，本窗口执行完成', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('r4-compress');
  let origin; let host;
  try {
    const conversationId = 'conversation-r4';
    origin = await openHost(dataRoot, scriptedProvider([{ role: 'model', parts: [{ text: '第一轮回答，内容足够被压缩。' }] }]), {
      folders: [PROJECT_TWO], label: 'origin', frozen: PROJECT_TWO_ENV,
      environments: [{ id: PROJECT_TWO_ENV, name: '项目二', displayPath: '/workspace/project-two', available: true }]
    });
    await createConversation(origin.app, conversationId, PROJECT_TWO_FOLDER);
    const first = await origin.runner.input({ commandId: 'r4-1', conversationId, text: '第一条' });
    await eventually(async () => (await rows(origin.app, 'Turn', { id: first.turnId }))[0]?.status === 'terminated', 30_000, '第一个 Turn 未结束');
    await origin.close(); origin = undefined;

    const provider = scriptedProvider([{ role: 'model', parts: [{ text: '压缩摘要。' }] }, { role: 'model', parts: [{ text: '继续' }] }]);
    host = await openHost(dataRoot, provider, { folders: [PROJECT_ONE], label: 'r4', frozen: CHOSEN.id, selected: CHOSEN.id, environments: [CHOSEN] });
    await host.app.recover();
    await host.runner.recoverStartup();
    assert.deepEqual(await host.entry(conversationId), { eligible: true }, '空闲时入口放行（所选环境可用）');
    const [head] = await rows(host.app, 'ConversationContextHeadLink', { conversation_id: conversationId });
    const outcome = await host.runner.manualCompression({ commandId: 'r4-compress', conversationId, compressSegmentCount: 1,
      target: { kind: 'current_head', expectedRootId: head.root_id } }).then((value) => ({ value }), (error) => ({ error }));
    assert.equal(isConversationHostIneligibleError(outcome.error), false, `维护 Turn 不应被资格挡下：${outcome.error?.message}`);
    const maintenance = (await rows(host.app, 'Turn', { conversation_id: conversationId })).find((r) => r.id !== first.turnId);
    assert.ok(maintenance, '维护 Turn 已准入');
    assert.equal(maintenance.status, 'terminated', '维护 Turn 不留在 active');
    const [snapshot] = await rows(host.app, 'AuthoritySnapshot', { turn_id: maintenance.id });
    const document = (await readFrozenTurnAuthority(host.app.database, host.app.contentStore, snapshot.id, maintenance.id)).document;
    assert.deepEqual(frozenWorkEnvironmentPolicy(document), { enabled: false, allowedWorkEnvironmentIds: [CHOSEN.id], defaultWorkEnvironmentId: CHOSEN.id },
      '工作环境换成入口批准的所选环境');
    assert.equal(document.sourceTurnId, first.turnId, '其余权限继承源 Turn');
    assert.equal(document.model.modelId, 'placement-model');
    assert.ok(outcome.value, `压缩应在本窗口完成：${outcome.error?.message}`);
    const next = await host.runner.input({ commandId: 'r4-2', conversationId, text: '压缩后继续' });
    assert.equal(next.admitted, true, '之后的输入不被挡');
  } finally {
    await origin?.close();
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('R4：维护 Turn 准入后驱动被资格挡下时，手动压缩返回错误，维护 Turn 以失败收尾，不留下活动 Turn', { timeout: 120_000 }, async () => {
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
});

test('R5：等待提问的 Turn 所在窗口移除项目文件夹后交还执行租约；持租约窗口仍存活时，另一合格窗口回答即续跑（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('r5-waiting');
  let w2; let child;
  try {
    const conversationId = 'conversation-r5';
    const files = workerFiles(outer, 'w1');
    child = spawnWorker(dataRoot, 'r5-w1', { ...files.env, LIMCODE_PLACEMENT_CONVERSATION: conversationId });
    const w1 = await waitForWorkerJson(child, files.ready, 90_000);
    assert.equal(w1.ownsAfterRescan, false, '重扫后交还归属');
    assert.equal(w1.leaseOnW1, false, '重扫后也交还执行租约');
    assert.equal(w1.leaseOwner, kernel.RELEASED_EXECUTION_LEASE_HOLDER);
    const provider2 = scriptedProvider([{ role: 'model', parts: [{ text: '按回答继续。' }] }]);
    w2 = await openHost(dataRoot, provider2, { folders: [PROJECT_TWO], label: 'w2', askUser: true });
    await w2.app.recover();
    await w2.runner.recoverStartup();
    const [request] = await rows(w2.app, 'InteractionRequest', { status: 'pending' });
    await w2.app.database.conversationOwners.run(conversationId, () => w2.app.interactions.resolveAskUser({
      source: { kind: 'command', key: 'r5-answer' }, requestId: request.id,
      response: { answer: { selectedOptionIndexes: [0], customText: '' } }, cancelled: false
    }));
    w2.runner.resume(conversationId, w1.turnId);
    await eventually(async () => (await rows(w2.app, 'Turn', { id: w1.turnId }))[0]?.status === 'terminated', 30_000,
      '持租约的 W1 存活期间，合格窗口 W2 没有续跑等待中的 Turn');
    assert.equal(provider2.calls, 1);
    assert.equal(child.exitCode, null, 'W1 仍存活');
    await fs.writeFile(files.finish, 'finish\n', 'utf8');
    await waitForExit(child, 90_000, true);
  } finally {
    await w2?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('所有权：执行类认领清掉命令认领标记——命令内转为执行后资格暂时未知，命令结束时仍保留归属', { timeout: 60_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('command-claim');
  let host;
  try {
    host = await openHost(dataRoot, scriptedProvider([]), { folders: [PROJECT_TWO], label: 'claim' });
    const conversationId = 'conversation-claim';
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const owners = host.app.database.conversationOwners;
    owners.setPendingWorkProbe(async () => true);
    await owners.run(conversationId, async () => {
      assert.equal(await owners.tryClaimEligible(conversationId), 'owned', '命令内转为执行类认领');
      host.failProbe = true;
    });
    assert.equal(owners.owns(conversationId), true, '执行类认领在资格未知时不随命令交还');
    host.failProbe = false;
    await owners.run(conversationId, async () => { host.failProbe = true; });
    assert.equal(owners.owns(conversationId), true, '已由执行持有的对话，后来的命令也不交还');
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('复审 #9：入口预览按单条消息指定的 Agent 求值：该 Agent 的工作环境可用时接受，默认 Agent 不可用时拒绝', { timeout: 60_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('agent-preview');
  let host;
  try {
    host = await openHost(dataRoot, scriptedProvider([{ role: 'model', parts: [{ text: '好' }] }]), {
      folders: [PROJECT_ONE], label: 'agent', frozen: CHOSEN.id, environments: [CHOSEN],
      // 只有 agent-other 的工作环境策略选中了本窗口可用的目录。
      selectedFor: (agentId) => agentId === 'agent-other' ? CHOSEN.id : undefined
    });
    const conversationId = 'conversation-agent';
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    await assert.rejects(host.runner.input({ commandId: 'default', conversationId, text: '默认 Agent' }),
      (error) => isConversationHostIneligibleError(error));
    assert.equal((await host.entry(conversationId, { executorAgentId: 'agent-other' })).eligible, true);
    const started = await host.runner.input({ commandId: 'other', conversationId, text: '指定 Agent', agentId: 'agent-other' });
    assert.equal(started.admitted, true);
    assert.deepEqual(host.previewAgents.slice(-2), ['agent-other', 'agent-other']);
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});


test('复审 H2：源 Turn 由单条消息指定的 Agent 执行时，手动压缩入口按该 Agent 判定，与维护 Turn 实际冻结的环境一致', { timeout: 120_000 }, async () => {
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
});

test('复审 X16：重试与编辑后运行按单条消息指定的 Agent 判定入口', { timeout: 60_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('retry-agent');
  let host;
  try {
    host = await openHost(dataRoot, scriptedProvider([]), { folders: [PROJECT_TWO], label: 'retry' });
    const judged = [];
    host.runner.setEntryEligibility(async (conversationId, options) => { judged.push(options); return 'ineligible'; });
    const reject = (promise) => assert.rejects(promise, (error) => isConversationHostIneligibleError(error));
    await reject(host.runner.retry({ commandId: 'r', conversationId: 'c', sourceTurnId: 't', target: { kind: 'turn' }, agentId: ' agent-other ' }));
    await reject(host.runner.editAndRun({ commandId: 'e', conversationId: 'c', messageId: 'm', expectedRevisionId: 'v', text: 'x', agentId: 'agent-edit' }));
    await reject(host.runner.retry({ commandId: 'r2', conversationId: 'c', sourceTurnId: 't', target: { kind: 'turn' } }));
    assert.deepEqual(judged, [{ executorAgentId: 'agent-other' }, { executorAgentId: 'agent-edit' }, {}]);
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('复审 X7/X8：维护 Turn 准入后驱动因资格未知被挡：手动压缩返回错误并以失败收尾；期间排队的消息随后被准入', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('x7-unknown');
  let host;
  try {
    const conversationId = 'conversation-x7';
    const provider = scriptedProvider([{ role: 'model', parts: [{ text: '第一轮回答。' }] }, { role: 'model', parts: [{ text: '排队消息的回答' }] }]);
    host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'x7' });
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const first = await host.runner.input({ commandId: 'x7-1', conversationId, text: '第一条' });
    await eventually(async () => (await rows(host.app, 'Turn', { id: first.turnId }))[0]?.status === 'terminated', 30_000, '第一个 Turn 未结束');
    await host.runner.waitForIdle();
    host.runner.setEntryEligibility(async () => 'eligible');
    // Right after the maintenance Turn is admitted: a message is queued behind it (its admission finds the
    // Turn active), then this window's probe starts failing before the drive claims.
    const admit = host.app.turns.runtimeContinuation.bind(host.app.turns);
    let queued = false;
    host.app.turns.runtimeContinuation = async (command) => {
      const result = await admit(command);
      if (command.maintenance && !queued) {
        queued = true;
        await host.runner.input({ commandId: 'x7-queued', conversationId, text: '压缩期间排队' });
        await eventually(async () => host.runner.admissions.size === 0, 10_000, '排队消息的准入尝试未结束');
        host.failProbe = true;
      }
      return result;
    };
    const [head] = await rows(host.app, 'ConversationContextHeadLink', { conversation_id: conversationId });
    await assert.rejects(host.runner.manualCompression({ commandId: 'x7-compress', conversationId, compressSegmentCount: 1,
      target: { kind: 'current_head', expectedRootId: head.root_id } }),
    (error) => isConversationHostIneligibleError(error) && error.eligibility === 'unknown');
    const maintenance = (await rows(host.app, 'Turn', { conversation_id: conversationId }))
      .find((r) => r.id !== first.turnId && (r.status === 'terminated' || r.status === 'active'));
    const terminations = await rows(host.app, 'TurnTermination', {});
    assert.ok(queued, '排队消息已写入');
    assert.equal(terminations.some((row) => row.terminal_status === 'failed' && row.reason === 'manual_context_compression_not_served_here'), true,
      '维护 Turn 以失败收尾');
    assert.ok(maintenance);
    assert.equal(provider.calls, 1, '没有发起压缩请求');
    host.failProbe = false;
    await eventually(async () => provider.calls === 2, 15_000, '维护 Turn 收尾后排队消息没有被准入');
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('复审 X11/X12：维护 Turn 的环境预览出错时手动压缩报错且不留下活动 Turn；重建摘要估算用的维护权限同样换成本窗口的环境', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('x11-preview');
  let origin; let host;
  try {
    const conversationId = 'conversation-x11';
    origin = await openHost(dataRoot, scriptedProvider([{ role: 'model', parts: [{ text: '第一轮回答。' }] }]), {
      folders: [PROJECT_TWO], label: 'origin', frozen: PROJECT_TWO_ENV,
      environments: [{ id: PROJECT_TWO_ENV, name: '项目二', displayPath: '/workspace/project-two', available: true }]
    });
    await createConversation(origin.app, conversationId, PROJECT_TWO_FOLDER);
    const first = await origin.runner.input({ commandId: 'x11-1', conversationId, text: '第一条' });
    await eventually(async () => (await rows(origin.app, 'Turn', { id: first.turnId }))[0]?.status === 'terminated', 30_000, '第一个 Turn 未结束');
    await origin.close(); origin = undefined;

    const provider = scriptedProvider([]);
    host = await openHost(dataRoot, provider, { folders: [PROJECT_ONE], label: 'x11', frozen: CHOSEN.id, selected: CHOSEN.id, environments: [CHOSEN] });
    const authority = await host.app.turns.previewMaintenanceAuthority(conversationId, first.turnId);
    assert.deepEqual(frozenWorkEnvironmentPolicy(authority), { enabled: false, allowedWorkEnvironmentIds: [CHOSEN.id], defaultWorkEnvironmentId: CHOSEN.id },
      '估算的维护权限换成本窗口所选环境');
    assert.equal(authority.model.modelId, 'placement-model', '其余权限继承源 Turn');
    // The chosen work environment disappears after the entry approved the command.
    host.runner.setEntryEligibility(async () => 'eligible');
    host.environments.splice(0);
    const [head] = await rows(host.app, 'ConversationContextHeadLink', { conversation_id: conversationId });
    await assert.rejects(host.runner.manualCompression({ commandId: 'x11-compress', conversationId, compressSegmentCount: 1,
      target: { kind: 'current_head', expectedRootId: head.root_id } }), /当前窗口的工作环境不可用/);
    assert.deepEqual((await rows(host.app, 'Turn', { conversation_id: conversationId })).map((r) => r.status), ['terminated'], '没有维护 Turn');
    assert.equal(provider.calls, 0);
  } finally {
    await origin?.close();
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('复审 X4/X5/X6：准入被 busy 挡下后按退避重试并在成功后清掉退避；判为不合格时清掉条目；dispose 清掉等待中的重试', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('x4-busy');
  let host;
  try {
    const provider = gatedProvider();
    const gates = new Map();
    provider.gate = (call) => { let open; gates.set(call, { promise: new Promise((resolve) => { open = resolve; }), open }); };
    provider.release = ((releaseFirst) => (call) => call ? gates.get(call).open() : releaseFirst())(provider.release);
    const send = provider.sendFullRequest.bind(provider);
    provider.sendFullRequest = async (request, controls) => {
      const gate = gates.get(provider.calls + 1);
      if (gate) await gate.promise;
      return send(request, controls);
    };
    host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'x4' });
    const conversationId = 'conversation-x4';
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const owners = host.app.database.conversationOwners;
    const tryClaimEligible = owners.tryClaimEligible.bind(owners);
    let forced;
    owners.tryClaimEligible = async (id) => forced ?? tryClaimEligible(id);
    const first = await host.runner.input({ commandId: 'x4-1', conversationId, text: '第一条' });
    await provider.started;
    await host.runner.input({ commandId: 'x4-2', conversationId, text: '第二条（排队）' });
    // Another live window holds the Conversation when the queue drains.
    forced = 'busy';
    provider.release();
    await eventually(async () => (await rows(host.app, 'Turn', { id: first.turnId }))[0]?.status === 'terminated', 30_000, '第一个 Turn 未结束');
    await eventually(async () => host.runner.admissionRetries.has(conversationId), 10_000, 'busy 后没有安排重试');
    await sleep(200);
    assert.equal(provider.calls, 1);
    forced = undefined;
    await eventually(async () => provider.calls === 2, 10_000, 'busy 解除后排队消息没有被重试准入');
    await host.runner.waitForIdle();
    assert.equal(host.runner.admissionRetries.has(conversationId), false, '准入成功后清掉退避');

    // An unknown answer schedules a retry; an ineligible one waits for a rescan and drops the entry.
    provider.gate(3);
    const third = await host.runner.input({ commandId: 'x4-3', conversationId, text: '第三条' });
    assert.equal(third.admitted, true);
    await host.runner.input({ commandId: 'x4-4', conversationId, text: '第四条（排队）' });
    forced = 'unknown';
    provider.release(3);
    await eventually(async () => (await rows(host.app, 'Turn', { id: third.turnId }))[0]?.status === 'terminated', 30_000, '第三个 Turn 未结束');
    await eventually(async () => host.runner.admissionRetries.get(conversationId)?.timer !== undefined, 10_000, 'unknown 后没有安排重试');
    clearTimeout(host.runner.admissionRetries.get(conversationId).timer);
    host.runner.admissionRetries.get(conversationId).timer = undefined;
    forced = 'ineligible';
    host.runner.scheduleAdmission(conversationId);
    await eventually(async () => !host.runner.admissionRetries.has(conversationId), 10_000, '判为不合格后仍留着退避条目');
    forced = 'busy';
    host.runner.scheduleAdmission(conversationId);
    await eventually(async () => host.runner.admissionRetries.get(conversationId)?.timer !== undefined, 10_000, 'busy 后没有安排重试');
    host.runner.dispose();
    assert.equal(host.runner.admissionRetries.size, 0, 'dispose 清掉等待中的重试');
    assert.equal(provider.calls, 3, '排队的第四条没有在本窗口被准入');
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('复审 X3：等待中的 Turn 所在窗口移除项目文件夹后，别的窗口回答触发的外部唤醒路径同样交还执行租约，合格窗口续跑（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('x3-external');
  let w2; let child;
  try {
    const conversationId = 'conversation-x3';
    const files = workerFiles(outer, 'w1');
    child = spawnWorker(dataRoot, 'x3-w1', { ...files.env, LIMCODE_PLACEMENT_CONVERSATION: conversationId });
    const w1 = await waitForWorkerJson(child, files.ready, 90_000);
    assert.equal(w1.leaseOnW1, true, '移除文件夹但还没有重扫：租约仍在 W1');
    const provider2 = scriptedProvider([{ role: 'model', parts: [{ text: '按回答继续。' }] }]);
    w2 = await openHost(dataRoot, provider2, { folders: [PROJECT_TWO], label: 'w2', askUser: true });
    const [request] = await rows(w2.app, 'InteractionRequest', { status: 'pending' });
    // W1 hands the Conversation back on its idle sweep (it no longer serves it); then W2 records the answer.
    await eventually(async () => w2.app.database.conversationOwners.run(conversationId, () => w2.app.interactions.resolveAskUser({
      source: { kind: 'command', key: 'x3-answer' }, requestId: request.id,
      response: { answer: { selectedOptionIndexes: [0], customText: '' } }, cancelled: false
    })).then(() => true, () => false), 30_000, 'W2 无法记录回答');
    await eventually(async () => (await rows(w2.app, 'ExecutionLease', { turn_id: w1.turnId }))[0]?.host_boot_id !== w1.hostBootId,
      30_000, 'W1 看到外部回答后没有交还执行租约');
    w2.runner.resume(conversationId, w1.turnId);
    await eventually(async () => (await rows(w2.app, 'Turn', { id: w1.turnId }))[0]?.status === 'terminated', 30_000, '合格窗口没有续跑');
    assert.equal(provider2.calls, 1);
    assert.equal(child.exitCode, null, 'W1 仍存活');
    await fs.writeFile(files.finish, 'finish\n', 'utf8');
    await waitForExit(child, 90_000, true);
  } finally {
    await w2?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('复审 X9：控制类认领已提交但随后出错时交还租约，不把别的窗口挡在外面', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('x9-claim');
  let origin; let p1;
  try {
    const conversationId = 'conversation-x9';
    origin = await openHost(dataRoot, scriptedProvider([{ role: 'model', parts: [{ id: 'ask', functionCall: {
      name: 'ask_user', args: { question: '继续吗？', options: [{ label: '继续' }] } } }] }]), { folders: [PROJECT_TWO], label: 'origin', askUser: true });
    await createConversation(origin.app, conversationId, PROJECT_TWO_FOLDER);
    const { turnId } = await origin.runner.input({ commandId: 'x9', conversationId, text: '问我' });
    await eventually(async () => (await rows(origin.app, 'InteractionRequest', { status: 'pending' })).length === 1, 30_000, '未进入等待');
    await origin.runner.waitForIdle();
    await origin.close(); origin = undefined;

    // A window that does not serve the Conversation settles the user's stop without executing it.
    p1 = await openHost(dataRoot, scriptedProvider([]), { folders: [PROJECT_ONE], label: 'p1', askUser: true });
    const claim = p1.app.turns.claimRecoveryExecution.bind(p1.app.turns);
    let injected = 0;
    p1.app.turns.claimRecoveryExecution = async (input) => {
      await claim(input);
      injected += 1;
      throw new Error('认领已提交后读取失败（注入）');
    };
    const [lease] = await rows(p1.app, 'ExecutionLease', { turn_id: turnId });
    await p1.runner.interrupt({ commandId: 'x9-stop', conversationId, turnId, expectedLeaseGeneration: String(lease.generation), reason: '用户停止' });
    assert.ok(injected >= 1, '控制类认领被调用');
    const [after] = await rows(p1.app, 'ExecutionLease', { turn_id: turnId });
    assert.ok(after, '租约仍在');
    assert.notEqual(after.host_boot_id, p1.app.database.hostBootId, '出错后本窗口不继续持有租约');
    assert.equal((await rows(p1.app, 'Turn', { id: turnId }))[0]?.status, 'active');
    assert.equal(p1.owns(conversationId), false);
  } finally {
    await origin?.close();
    await p1?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

}

async function runWorker(mode) {
  const dataRoot = requiredEnv('LIMCODE_PLACEMENT_DATA_ROOT');
  const conversationId = requiredEnv('LIMCODE_PLACEMENT_CONVERSATION');
  if (mode !== 'r5-w1' && mode !== 'x3-w1') throw new Error(`Unknown worker ${mode}`);
  const host = await openHost(dataRoot, scriptedProvider([{ role: 'model', parts: [{ id: 'ask', functionCall: {
    name: 'ask_user', args: { question: '继续吗？', options: [{ label: '继续' }] } } }] }]), { folders: [PROJECT_TWO], label: 'w1', askUser: true });
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
      if (calls === 1) {
        markStarted();
        await gate;
      }
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: `回复${calls}` }] } });
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
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-placement-${label}-`));
  await fs.mkdir(path.join(outer, 'control'), { recursive: true });
  const candidate = await kernel.resetCandidateRuntimeRoot(path.join(outer, 'control'));
  return { outer, dataRoot: candidate.binding.paths.dataRootPath };
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
      LIMCODE_PLACEMENT_READY: files.ready,
      LIMCODE_PLACEMENT_FINISH: files.finish,
      LIMCODE_PLACEMENT_RESULT: files.result
    }
  };
}

function spawnWorker(dataRoot, mode, environment) {
  const child = childProcess.spawn(process.execPath, [TEST_FILE], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...environment,
      LIMCODE_PLACEMENT_WORKER: mode,
      LIMCODE_PLACEMENT_DATA_ROOT: dataRoot
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { child.output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { child.output.stderr += chunk; });
  return child;
}

/** Waits for a worker's JSON file, failing at once (with its output) if the worker exits first. */
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
