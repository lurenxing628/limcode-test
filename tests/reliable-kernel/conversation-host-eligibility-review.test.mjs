import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The command router and the panel import 'vscode'; the kernel does not.
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
if (workerMode) {
  runWorker(workerMode).then(
    () => process.exit(0),
    (error) => {
      console.error(error?.stack ?? error);
      process.exit(1);
    }
  );
} else {
after(() => { Module._load = originalLoad; });

test('复审 #7：同项目窗口 P2 在 Turn 创建前已打开，P1 记录回答后，P2 收到外部提交即接上续跑（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('n3');
  let p1; let child;
  try {
    informationMessages.length = 0;
    const conversationId = 'conversation-n3';
    const files = workerFiles(outer, 'p2');
    const answered = path.join(outer, 'answered');
    child = spawnWorker(dataRoot, 'n3-p2', { ...files.env, LIMCODE_ELIGIBILITY_CONVERSATION: conversationId, N3_ANSWERED: answered });
    await waitForWorkerJson(child, files.ready, 90_000);
    const { turnId, requestId } = await startAskTurnThenCloseHost(dataRoot, conversationId, PROJECT_TWO_FOLDER);
    p1 = await openHost(dataRoot, gatedProvider(), { folders: [PROJECT_ONE], label: 'p1', askUser: true });
    await p1.app.recover();
    await p1.runner.recoverStartup();
    const posted = [];
    await createRouter(p1).dispatch('p1-client', webview(posted), {
      id: 'n3-answer', type: BridgeMessageType.InteractionResolve, channel: 'command',
      payload: { conversationId, interactionRequestId: requestId, interactionRevision: 1, ownerTurnId: turnId,
        decision: 'submit', response: { answer: { selectedOptionIndexes: [0], customText: '' } } }
    });
    assert.deepEqual(posted.map((m) => m.payload?.status), ['committed']);
    await writeJson(answered, { turnId });
    await waitForExit(child, 120_000, true);
    const result = await readJson(files.result);
    assert.equal(result.callsAfterFiveSeconds, 1, '已打开的合格窗口在外部提交后续跑');
    assert.equal(result.turnAfterFiveSeconds, 'terminated');
    assert.deepEqual(result.scopedResumed, [], '不需要打开面板才接上');
    assert.equal(result.finalStatus, 'terminated');
  } finally {
    await p1?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('复审 #4：不合格窗口控制类收尾在认领执行租约后抛错，同一次持有内交还租约，合格窗口在它存活时即可接手（跨进程，故障注入）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('n8');
  let p2; let child;
  try {
    const conversationId = 'conversation-n8';
    const turnId = await startTurnThenCloseHost(dataRoot, conversationId, PROJECT_TWO_FOLDER);
    const files = workerFiles(outer, 'p1');
    child = spawnWorker(dataRoot, 'n8-stop-fault', { ...files.env, LIMCODE_ELIGIBILITY_CONVERSATION: conversationId, LIMCODE_ELIGIBILITY_TURN: turnId });
    const p1 = await waitForWorkerJson(child, files.ready, 90_000);
    assert.equal(p1.turnAfterStop, 'active', '注入的失败让这次收尾没有完成');
    assert.equal(p1.ownsAfterStop, false, '归属记录已交还');
    assert.equal(p1.leaseOnP1, false, '执行租约也已交还');
    assert.equal(p1.leaseOwner, kernel.RELEASED_EXECUTION_LEASE_HOLDER);
    const provider = gatedProvider();
    p2 = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'p2' });
    await p2.app.recover();
    const report = await p2.runner.recoverStartup();
    assert.deepEqual(report.liveOwnedTurnIds, [], 'P1 存活，但已不持有租约');
    assert.deepEqual(report.resumedTurnIds, [turnId], '合格窗口在 P1 存活时接手');
    await eventually(async () => (await rows(p2.app, 'Turn', { id: turnId }))[0]?.status === 'terminated', 30_000, 'P2 未执行停止');
    assert.equal((await rows(p2.app, 'TurnTermination', { turn_id: turnId }))[0]?.terminal_status, 'interrupted');
    assert.equal(provider.calls, 0, '停止不调用 Provider');
    await fs.writeFile(files.finish, 'finish\n', 'utf8');
    await waitForExit(child, 90_000, true);
  } finally {
    await p2?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('复审 #5：运行中的 Turn 在本窗口移除其项目文件夹后，停在轮次之间并交还租约；文件夹回来后接着执行', { timeout: 120_000 }, async () => {
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
});

for (const approveFirst of [false, true]) {
  test(`复审 #3：文件修改审批${approveFirst ? '先在不合格窗口批准（ToolCall 为 executing、效果未派发）' : '未处理'}，再在不合格窗口停止：Turn 收尾、效果取消、可以删除`, { timeout: 120_000 }, async () => {
    const { outer, dataRoot } = await createIsolatedRoot(`n11-${approveFirst}`);
    let origin; let p1;
    try {
      const conversationId = `conversation-n11-${approveFirst}`;
      // The model proposes a file write; it waits for the user's approval when that window closes.
      const originProvider = scriptedProvider([{ role: 'model', parts: [{ id: 'provider-write-call', functionCall: {
        name: 'write', args: { path: 'x.txt', content: 'x' } } }] }]);
      origin = await openHost(dataRoot, originProvider, { folders: [PROJECT_TWO], label: 'origin', fileWrite: true });
      await createConversation(origin.app, conversationId, PROJECT_TWO_FOLDER);
      const { turnId } = await origin.runner.input({ commandId: 'n11', conversationId, text: '改文件' });
      await eventually(async () => (await rows(origin.app, 'InteractionRequest', { request_kind: 'file_change_approval', status: 'pending' }))
        .length === 1, 30_000, '写文件未进入审批');
      await origin.runner.waitForIdle();
      const [toolCall] = await rows(origin.app, 'ToolCall', { turn_id: turnId });
      const toolCallId = String(toolCall.id);
      await origin.close(); origin = undefined;

      p1 = await openHost(dataRoot, gatedProvider(), { folders: [PROJECT_ONE], label: 'p1', fileWrite: true });
      await p1.app.recover();
      await p1.runner.recoverStartup();
      if (approveFirst) {
        // VscodeReliableKernelCommandRouter.handleInteractionResolve 在不合格窗口：只记录决定，不派发。
        const [changeSet] = await rows(p1.app, 'FileChangeSet', { tool_call_id: toolCallId });
        await p1.app.database.conversationOwners.run(conversationId, () => p1.app.files.decide({
          source: { kind: 'command', key: 'approve-in-p1' }, changeSetId: String(changeSet.id), decision: 'approved', response: {}
        }));
      }
      assert.equal((await rows(p1.app, 'ToolCall', { id: toolCallId }))[0]?.status, approveFirst ? 'executing' : 'waiting_approval');
      assert.deepEqual((await rows(p1.app, 'EffectIntent')).map((r) => r.dispatch_state), approveFirst ? ['pending'] : []);
      const lease = (await rows(p1.app, 'ExecutionLease', { turn_id: turnId }))[0];
      const result = await p1.runner.interrupt({ commandId: 'n11-stop', conversationId, turnId,
        expectedLeaseGeneration: String(lease.generation), reason: '停止' });
      await sleep(1_000);
      const status = (await rows(p1.app, 'Turn', { id: turnId }))[0]?.status;
      if (approveFirst) {
        assert.deepEqual((await rows(p1.app, 'EffectIntent')).map((r) => r.dispatch_state), ['cancelled_before_dispatch'],
          '批准后尚未派发的写入被取消');
      }
      const deleteError = await deleteConversation(p1, conversationId).then(() => null, (error) => String(error?.message ?? error));
      assert.equal(result.ignoredBecauseTerminal ?? false, false);
      assert.equal(status, 'terminated');
      assert.equal(deleteError, null);
      assert.deepEqual(p1.runnerErrors.map((e) => String(e.error?.message ?? e.error)), []);
    } finally {
      await origin?.close();
      await p1?.close();
      await fs.rm(outer, { recursive: true, force: true });
    }
  });
}

test('复审 #8：探针频率——持有多个等待 Turn 的窗口在别的窗口持续提交时不再逐次探测资格（跨进程外部提交）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('n5');
  let child; let waiter; let holder; let writer;
  try {
    const conversationId = 'conversation-n5';
    const files = workerFiles(outer, 'origin');
    child = spawnWorker(dataRoot, 'origin', { ...files.env, LIMCODE_ELIGIBILITY_CONVERSATION: conversationId });
    const { turnId } = await waitForWorkerJson(child, files.ready, 90_000);
    waiter = await openHost(dataRoot, gatedProvider(), { folders: [PROJECT_TWO], label: 'waiter' });
    let waiterProbes = 0;
    waiter.app.database.conversationOwners.setClaimEligibilityProbe(async (id) => {
      waiterProbes += 1;
      return (await waiter.eligibility(id)).eligible;
    });
    await waiter.app.recover();
    assert.deepEqual((await waiter.runner.recoverStartup()).liveOwnedTurnIds, [turnId]);
    const before = waiterProbes;
    await sleep(5_000);
    console.log(`[N5] busy candidate: ${(waiterProbes - before) / 5} probes/s`);
    await fs.writeFile(files.finish, 'close\n', 'utf8');
    await waitForExit(child, 90_000, true);
    await waiter.close(); waiter = undefined;

    // 持有 K 个等待提问 Turn 的窗口；另一个进程持续提交（模拟别的窗口在流式输出）。
    const K = 5;
    const replies = Array.from({ length: K }, () => ({ role: 'model', parts: [{ id: 'ask', functionCall: { name: 'ask_user', args: { question: '继续吗？', options: [{ label: '继续' }] } } }] }));
    holder = await openHost(dataRoot, scriptedProvider(replies), { folders: [PROJECT_TWO], label: 'holder', askUser: true });
    let holderProbes = 0;
    holder.app.database.conversationOwners.setClaimEligibilityProbe(async (id) => {
      holderProbes += 1;
      return (await holder.eligibility(id)).eligible;
    });
    for (let i = 0; i < K; i += 1) {
      await createConversation(holder.app, `conversation-n5-${i}`, PROJECT_TWO_FOLDER);
      await holder.runner.input({ commandId: `n5-${i}`, conversationId: `conversation-n5-${i}`, text: '问我' });
    }
    await eventually(async () => (await rows(holder.app, 'InteractionRequest', { status: 'pending' })).length === K, 30_000, '未全部进入等待');
    await holder.runner.waitForIdle();
    const writerFiles = workerFiles(outer, 'writer');
    writer = spawnWorker(dataRoot, 'n5-writer', { ...writerFiles.env, LIMCODE_ELIGIBILITY_CONVERSATION: 'conversation-n5-writer' });
    await waitForWorkerJson(writer, writerFiles.ready, 90_000);
    const holderBefore = holderProbes;
    await sleep(5_000);
    const holderRate = (holderProbes - holderBefore) / 5;
    console.log(`[N5] holder with ${K} waiting Turns under external commits: ${holderRate} probes/s`);
    assert.ok(holderRate <= 1, `别的对话的提交不应触发资格探测（实际 ${holderRate} 次/秒）`);
    await fs.writeFile(writerFiles.finish, 'finish\n', 'utf8');
    await waitForExit(writer, 90_000, true);
  } finally {
    await waiter?.close();
    await holder?.close();
    await stopChild(child);
    await stopChild(writer);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('复审 #9：资格未知时两个重叠的控制命令，无论谁后结束，认领都随最后一个命令交还', { timeout: 60_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('n7');
  let host;
  try {
    const conversationId = 'conversation-n7';
    const turnId = await startTurnThenCloseHost(dataRoot, conversationId, PROJECT_TWO_FOLDER);
    host = await openHost(dataRoot, gatedProvider(), { folders: [PROJECT_ONE], label: 'n7' });
    await host.app.recover();
    await host.runner.recoverStartup();
    host.failProbe = true;
    const owners = host.app.database.conversationOwners;
    const first = owners.run(conversationId, () => sleep(200));
    await sleep(50);
    const second = owners.run(conversationId, () => sleep(400));
    await Promise.all([first, second]);
    assert.equal(host.owns(conversationId), false, '资格未知时，重叠控制命令的认领在最后一个命令结束时交还');
    assert.equal(await ownerRecordExists(dataRoot, conversationId), false);
    assert.ok(turnId);
    host.failProbe = false;
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('准入被资格挡下时不再空转重排：探针失败期间只探测一次，事件循环照常运行', { timeout: 60_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('admission-spin');
  let host;
  try {
    host = await openHost(dataRoot, gatedProvider(), { folders: [], label: 'admission' });
    await createConversation(host.app, 'conversation-admission', null);
    let probes = 0;
    // A probe answered from memory: before the fix the admission slot re-queued itself forever
    // without yielding; the probe turns eligible after 200 calls so a regression ends instead of hanging.
    host.app.database.conversationOwners.setClaimEligibilityProbe(async () => {
      probes += 1;
      if (probes < 200) throw new Error('probe unavailable');
      return true;
    });
    host.runner['scheduleAdmission']('conversation-admission');
    let timerFired = false;
    await new Promise((resolve) => setTimeout(() => { timerFired = true; resolve(); }, 50));
    assert.equal(timerFired, true);
    assert.equal(probes, 1, '资格未知时准入只尝试一次，由之后的唤醒重新检查');
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('防护：后台扫描的资格闸门——已持有但不合格时不放行', { timeout: 60_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('gate');
  let host;
  try {
    host = await openHost(dataRoot, gatedProvider(), { folders: [], label: 'gate' });
    const conversationId = 'conversation-gate';
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const owners = host.app.database.conversationOwners;
    let release;
    const held = owners.run(conversationId, () => new Promise((resolve) => { release = resolve; }));
    await eventually(async () => host.owns(conversationId), 10_000, '控制命令未持有');
    for (const acquisition of ['owned', 'claim']) {
      const gate = new ConversationOwnershipGate(host.app.database, acquisition);
      assert.equal(await gate.check(conversationId), false, `${acquisition}：持有不等于可以执行`);
      assert.deepEqual(await gate.run(conversationId, async () => 'ran'), { ran: false });
    }
    release();
    await held;
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('防护：运行时投递唤醒——已持有但不合格的窗口不续跑、不确认投递', { timeout: 60_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('delivery-wake');
  let host;
  try {
    host = await openHost(dataRoot, gatedProvider(), { folders: [], label: 'delivery' });
    const conversationId = 'conversation-delivery';
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const resumed = [];
    const handler = createRuntimeDeliveryWakeHandler({
      application: () => host.app,
      conversations: () => ({ resume: (id, turnId) => resumed.push([id, turnId]) }),
      children: () => ({ async resume() { return false; } })
    });
    const result = await host.app.database.conversationOwners.run(conversationId, () => handler({
      deliveryId: 'delivery-1', conversationId, action: 'resume_current_turn', targetTurnId: 'turn-1'
    }));
    assert.deepEqual(result, { acknowledged: false });
    assert.deepEqual(resumed, [], '不合格窗口不续跑');
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('防护：重扫时，文件夹离开本窗口的等待中 Turn 不再由本窗口持有', { timeout: 60_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('rescan-demote');
  let host;
  try {
    const provider = scriptedProvider([{ role: 'model', parts: [{ id: 'ask', functionCall: {
      name: 'ask_user', args: { question: '继续吗？', options: [{ label: '继续' }] } } }] }]);
    host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'rescan', askUser: true });
    const conversationId = 'conversation-rescan';
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const { turnId } = await host.runner.input({ commandId: 'rescan', conversationId, text: '问我' });
    await eventually(async () => (await rows(host.app, 'InteractionRequest', { status: 'pending' })).length === 1, 30_000, '未进入等待');
    await host.runner.waitForIdle();
    assert.equal(host.owns(conversationId), true, '等待中的 Turn 由本窗口持有');
    host.folders.splice(host.folders.indexOf(PROJECT_TWO), 1);
    const report = await host.runner.rescan();
    assert.deepEqual(report.ineligibleTurnIds, [turnId]);
    assert.equal(host.owns(conversationId), false, '文件夹离开后交还');
    assert.equal(provider.calls, 1);
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('防护：已持有但不合格的窗口，运行时收敛不派发已批准的文件修改', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('converge');
  let origin; let p1;
  try {
    const conversationId = 'conversation-converge';
    const originProvider = scriptedProvider([{ role: 'model', parts: [{ id: 'provider-write-call', functionCall: {
      name: 'write', args: { path: 'x.txt', content: 'x' } } }] }]);
    origin = await openHost(dataRoot, originProvider, { folders: [PROJECT_TWO], label: 'origin', fileWrite: true });
    await createConversation(origin.app, conversationId, PROJECT_TWO_FOLDER);
    const { turnId } = await origin.runner.input({ commandId: 'converge', conversationId, text: '改文件' });
    await eventually(async () => (await rows(origin.app, 'FileChangeSet', { status: 'pending' })).length === 1, 30_000, '未进入审批');
    await origin.runner.waitForIdle();
    await origin.close(); origin = undefined;

    p1 = await openHost(dataRoot, gatedProvider(), { folders: [PROJECT_ONE], label: 'p1', fileWrite: true });
    const [changeSet] = await rows(p1.app, 'FileChangeSet', { status: 'pending' });
    const owners = p1.app.database.conversationOwners;
    let release;
    // A control command in this window still holds the Conversation while convergence runs.
    const held = owners.run(conversationId, async () => {
      await p1.app.files.decide({ source: { kind: 'command', key: 'approve' }, changeSetId: String(changeSet.id), decision: 'approved', response: {} });
      await new Promise((resolve) => { release = resolve; });
    });
    await eventually(async () => (await rows(p1.app, 'EffectIntent', { effect_kind: 'file_mutation' })).length === 1, 10_000, '批准未记录');
    await p1.app.refreshExternalRuntimeWork();
    await sleep(1_000);
    assert.deepEqual((await rows(p1.app, 'EffectIntent', { effect_kind: 'file_mutation' })).map((r) => r.dispatch_state), ['pending'],
      '不合格窗口不派发');
    assert.ok(turnId);
    release();
    await held;
  } finally {
    await origin?.close();
    await p1?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('复审 #10：资格判定从本窗口的工作环境目录取名称和路径', { timeout: 60_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('label');
  let host;
  try {
    const provider = gatedProvider();
    host = await openHost(dataRoot, provider, {
      folders: [],
      label: 'label',
      defaultWorkEnvironmentId: 'work-env-local-abc',
      environments: [{ id: 'work-env-local-abc', name: '项目二', displayPath: '/workspace/project-two', available: true }]
    });
    await createConversation(host.app, 'conversation-label', null);
    const started = await host.runner.input({ commandId: 'label', conversationId: 'conversation-label', text: '开始' });
    await provider.started;
    host.environments[0].available = false;
    const view = await host.eligibility('conversation-label');
    assert.deepEqual(view, { eligible: false, reason: 'work_environment_unavailable', turnId: started.turnId,
      workEnvironmentId: 'work-env-local-abc', workEnvironmentLabel: '项目二（/workspace/project-two）' });
    assert.doesNotMatch(conversationHostIneligibleMessage(view), /work-env-local-abc/);
    assert.match(conversationHostIneligibleMessage(view), /项目二（\/workspace\/project-two）/);
    host.environments[0].available = true;
    provider.release();
    await eventually(async () => (await rows(host.app, 'Turn', { id: started.turnId }))[0]?.status === 'terminated', 30_000, 'Turn 未结束');
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('复审 #10：工作环境不可用的提示显示名称和路径，不显示内部 ID；空闲对话提示可在本窗口选择工作环境', () => {
  const unavailable = { eligible: false, reason: 'work_environment_unavailable', turnId: 't', workEnvironmentId: 'work-env-local-abc',
    workEnvironmentLabel: '项目二（/workspace/project-two）' };
  assert.equal(conversationHostIneligibleMessage(unavailable), '这个对话正在工作环境“项目二（/workspace/project-two）”中运行，当前窗口不能使用它，请在有它的窗口中继续。');
  const { workEnvironmentLabel: _omitted, ...unknown } = unavailable;
  assert.doesNotMatch(conversationHostIneligibleMessage(unknown), /work-env-local-abc/);
  assert.match(conversationHostIneligibleMessage({ eligible: false, reason: 'next_work_environment_unavailable', message: '当前窗口的工作环境不可用：项目二，请打开对应目录或重新选择。' }),
    /也可以在本窗口手动选择工作环境后继续。$/);
});

}

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

/** VscodeReliableKernelApplicationFacade.deleteConversation */
function deleteConversation(host, conversationId) {
  return host.app.database.conversationOwners.run(conversationId, () =>
    host.app.conversationDeletion.delete(conversationId));
}

/** The production router over this Host's real application and Runner. */
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

/** Starts a Turn in a window serving `project`, waits for its lease, then closes that window. */
async function startTurnThenCloseHost(dataRoot, conversationId, project) {
  const provider = gatedProvider();
  const origin = await openHost(dataRoot, provider, { folders: [project.uri], label: 'origin-window' });
  try {
    await createConversation(origin.app, conversationId, project);
    const started = await origin.runner.input({ commandId: `input-${conversationId}`, conversationId, text: '开始执行' });
    await provider.started;
    await eventually(async () => (await rows(origin.app, 'ExecutionLease', { turn_id: started.turnId })).length === 1,
      30_000, 'Turn 未建立 ExecutionLease');
    return started.turnId;
  } finally {
    await origin.close();
  }
}

/** Starts a Turn whose model asks the user a question, waits for the question, then closes that window. */
async function startAskTurnThenCloseHost(dataRoot, conversationId, project) {
  const provider = scriptedProvider([{
    role: 'model',
    parts: [{
      id: 'provider-ask-call',
      functionCall: { name: 'ask_user', args: { question: '继续吗？', options: [{ label: '继续' }, { label: '停止' }] } }
    }]
  }]);
  const origin = await openHost(dataRoot, provider, { folders: [project.uri], label: 'origin-window', askUser: true });
  try {
    await createConversation(origin.app, conversationId, project);
    const started = await origin.runner.input({ commandId: `input-${conversationId}`, conversationId, text: '问我一个问题' });
    await eventually(async () => (await rows(origin.app, 'InteractionRequest', {
      request_kind: 'ask_user',
      status: 'pending'
    })).length === 1, 30_000, '提问未进入等待');
    await origin.runner.waitForIdle();
    const request = (await rows(origin.app, 'InteractionRequest', { request_kind: 'ask_user', status: 'pending' }))[0];
    return { turnId: started.turnId, requestId: String(request.id) };
  } finally {
    await origin.close();
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
    kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
      id: `link-${conversationId}`, conversation_id: conversationId, agent_id: 'agent-main',
      role: 'default', created_at: now, updated_at: now
    }),
    ...(project ? projectFolderAssignmentSteps({ conversationId, folder: project, now }) : [])
  ]);
}

function recordingDiagnostics() {
  const events = [];
  const samples = [];
  return {
    events,
    samples,
    observe(event) { events.push(event); },
    aggregate(sample) { samples.push(sample); }
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
            return [{ operation: 'create_file', workEnvironmentId: 'work-env-test', targetPath: `${input.toolCallId}.txt`, targetContent: 'x' }];
          },
          async cancelTurnWaits() {},
          async dispose() {}
        }
      })
  };
}

async function createIsolatedRoot(label) {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-eligibility-${label}-`));
  await fs.mkdir(path.join(outer, 'control'), { recursive: true });
  const candidate = await kernel.resetCandidateRuntimeRoot(path.join(outer, 'control'));
  return { outer, dataRoot: candidate.binding.paths.dataRootPath };
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
