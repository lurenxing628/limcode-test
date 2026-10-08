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

test('其它项目的窗口不执行该项目的活动 Turn，也不持有它；打开该项目并重扫后同一窗口接上', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('project-gate');
  let other;
  try {
    const conversationId = 'conversation-project-two';
    const turnId = await startTurnThenCloseHost(dataRoot, conversationId, PROJECT_TWO_FOLDER);

    const provider = gatedProvider();
    const diagnostics = recordingDiagnostics();
    other = await openHost(dataRoot, provider, { folders: [PROJECT_ONE], label: 'project-one-window', diagnostics });
    await other.app.recover();
    assert.equal(other.owns(conversationId), false, '启动恢复（Phase D/F）不得认领其它项目的对话');
    const report = await other.runner.recoverStartup();
    assert.deepEqual(report.ineligibleTurnIds, [turnId]);
    assert.deepEqual(report.resumedTurnIds, []);
    assert.deepEqual(report.liveOwnedTurnIds, []);
    assert.deepEqual(report.finalizedTurnIds, [], '有执行租约的 Turn 不是孤儿，不得收尾');
    assert.deepEqual(report.interruptedTurnIds, []);
    assert.equal(other.owns(conversationId), false);
    assert.equal(await ownerRecordExists(dataRoot, conversationId), false, '不合格窗口不得留下归属记录');
    const scan = diagnostics.events.filter((event) => event.eventKind === 'recovery.scan.completed');
    assert.deepEqual(scan.map((event) => event.metadata), [{
      kind: 'conversation-runner',
      status: 'completed',
      hostBootId: other.app.database.hostBootId,
      scanned: 1,
      reconciled: 0,
      unchanged: 1,
      unknown: 0
    }], '恢复事件写出本窗口留给其它窗口的数量');

    // 其它窗口里的"续跑提示"也不得把对话接过来。
    other.runner.resume(conversationId, turnId);
    await other.runner.waitForIdle();
    await sleep(700);
    assert.equal(provider.calls, 0, '不合格窗口不得派发 Provider');
    assert.equal(other.owns(conversationId), false);
    assert.equal((await rows(other.app, 'Turn', { id: turnId }))[0]?.status, 'active', 'Turn 必须保持等待');
    assert.equal((await rows(other.app, 'TurnTermination', { turn_id: turnId })).length, 0);

    // 同一窗口打开该项目文件夹后，重扫立即接上（不等 30 秒的低频复查）。
    other.folders.push(PROJECT_TWO);
    const resumed = await other.runner.rescan();
    assert.deepEqual(resumed.resumedTurnIds, [turnId]);
    assert.deepEqual(resumed.ineligibleTurnIds, []);
    await provider.started;
    provider.release();
    await eventually(async () => (await rows(other.app, 'Turn', { id: turnId }))[0]?.status === 'terminated',
      60_000, '合格窗口接上后 Turn 未完成');
    assert.equal(provider.calls, 1);
    assert.deepEqual(other.runnerErrors, []);
  } finally {
    await other?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('资格判定：项目未打开、冻结工作环境不可用分别拒绝；持有不等于可执行；不合格或未知时新输入在写入前被拒绝', { timeout: 120_000 }, async () => {
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
});

test('#1 不合格窗口的控制命令用完即交还：重命名后 P1 不再持有，P2 在 P1 存活时就能接上；P1 发新消息在写入前被拒绝（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('control-release');
  let p2;
  let child;
  try {
    const conversationId = 'conversation-control-release';
    const turnId = await startTurnThenCloseHost(dataRoot, conversationId, PROJECT_TWO_FOLDER);
    const files = workerFiles(outer, 'p1');
    child = spawnWorker(dataRoot, 'control-p1', { ...files.env, LIMCODE_ELIGIBILITY_CONVERSATION: conversationId });
    const p1 = await waitForWorkerJson(child, files.ready, 90_000);
    assert.deepEqual(p1.report.ineligibleTurnIds, [turnId]);
    assert.equal(p1.title, '改个名字', '控制命令在不合格窗口照常生效');
    assert.equal(p1.ownsAfterRename, false, '不合格窗口做完控制命令立即交还');
    assert.equal(p1.ownerRecordAfterRename, false);
    assert.match(p1.inputRejection ?? '', /项目“项目二”.*未写入任何内容/);
    assert.equal(p1.intentsAfter, p1.intentsBefore, '被拒绝的新消息不得写入');
    assert.equal(p1.ownsAfterInput, false);

    const provider = gatedProvider();
    p2 = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'p2' });
    await p2.app.recover();
    const report = await p2.runner.recoverStartup();
    assert.deepEqual(report.resumedTurnIds, [turnId], 'P1 仍存活时合格窗口即可接上');
    assert.deepEqual(report.liveOwnedTurnIds, []);
    await provider.started;
    provider.release();
    await eventually(async () => (await rows(p2.app, 'Turn', { id: turnId }))[0]?.status === 'terminated',
      60_000, 'P2 接上后 Turn 未完成');

    await fs.writeFile(files.finish, 'finish\n', 'utf8');
    await waitForExit(child, 90_000, true);
    const result = await readJson(files.result);
    assert.equal(result.providerCalls, 0, 'P1 从未执行');
    assert.equal(result.ownsAtFinish, false);
    assert.deepEqual(result.runnerErrors, []);
    assert.deepEqual(p2.runnerErrors, []);
  } finally {
    await p2?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('#2 在不合格窗口经真实命令路由回答提问：只记录回答并提示，Turn 由打开项目的窗口继续（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('answer');
  let p2;
  let child;
  try {
    const conversationId = 'conversation-answer';
    const { turnId, requestId } = await startAskTurnThenCloseHost(dataRoot, conversationId, PROJECT_TWO_FOLDER);
    const files = workerFiles(outer, 'p1');
    child = spawnWorker(dataRoot, 'answer-p1', {
      ...files.env,
      LIMCODE_ELIGIBILITY_CONVERSATION: conversationId,
      LIMCODE_ELIGIBILITY_TURN: turnId,
      LIMCODE_ELIGIBILITY_REQUEST: requestId
    });
    const p1 = await waitForWorkerJson(child, files.ready, 90_000);
    assert.deepEqual(p1.report.ineligibleTurnIds, [turnId]);
    assert.deepEqual(p1.postedStatuses, ['committed'], '回答被持久记录');
    assert.equal(p1.responses, 1);
    assert.equal(p1.providerCalls, 0, '不合格窗口不得续跑');
    assert.equal(p1.leaseOnP1, false, '执行租约不得落到不合格窗口');
    assert.equal(p1.ownsAfterAnswer, false, '回答后立即交还');
    assert.equal(p1.turnStatus, 'active');
    assert.deepEqual(p1.informationMessages, [`${EXTENSION_BRAND}：回答已记录，将在打开项目“项目二”的窗口中继续执行。`]);

    const provider = scriptedProvider([{ role: 'model', parts: [{ text: '已按回答继续。' }] }]);
    p2 = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'p2', askUser: true });
    await p2.app.recover();
    const report = await p2.runner.recoverStartup();
    assert.deepEqual(report.resumedTurnIds, [turnId]);
    await eventually(async () => (await rows(p2.app, 'Turn', { id: turnId }))[0]?.status === 'terminated',
      60_000, '打开项目的窗口未继续完成 Turn');
    assert.equal(provider.calls, 1);
    assert.deepEqual((await rows(p2.app, 'ToolCall', { turn_id: turnId })).map((row) => row.status), ['terminal']);

    await fs.writeFile(files.finish, 'finish\n', 'utf8');
    await waitForExit(child, 90_000, true);
    const result = await readJson(files.result);
    assert.equal(result.providerCalls, 0);
    assert.deepEqual(result.runnerErrors, []);
    assert.deepEqual(p2.runnerErrors, []);
  } finally {
    await p2?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('#3 没有合格窗口时：停止在不合格窗口生效、之后可以删除；孤儿 Turn 被收尾（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('stop');
  let child;
  let observer;
  try {
    const conversationId = 'conversation-stop';
    const orphanConversationId = 'conversation-orphan';
    const turnId = await startTurnThenCloseHost(dataRoot, conversationId, PROJECT_TWO_FOLDER);
    observer = await kernel.ReliableKernelApplication.open(
      new kernel.RootAuthority(() => dataRoot),
      fixtureDependencies(gatedProvider(), null)
    );
    await createConversation(observer, orphanConversationId, PROJECT_TWO_FOLDER);
    const now = new Date().toISOString();
    await observer.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: 'turn-orphan', conversation_id: orphanConversationId, status: 'active',
        created_at: now, updated_at: now, terminal_at: null
      })
    ]);
    await observer.close();
    observer = undefined;

    const files = workerFiles(outer, 'p1');
    child = spawnWorker(dataRoot, 'stop-p1', {
      ...files.env,
      LIMCODE_ELIGIBILITY_CONVERSATION: conversationId,
      LIMCODE_ELIGIBILITY_TURN: turnId
    });
    const p1 = await waitForWorkerJson(child, files.ready, 90_000);
    assert.match(p1.deleteBeforeStop ?? '', /活动 Turn/);
    assert.equal(p1.ownsAfterFailedDelete, false, '删除失败也不得让不合格窗口一直持有');
    assert.equal(p1.turnAfterStop, 'terminated', '停止在不合格窗口立即生效');
    assert.equal(p1.terminationStatus, 'interrupted');
    assert.equal(p1.ownsAfterStop, false);
    assert.deepEqual(p1.deleted, [conversationId], '停止之后可以删除');
    assert.deepEqual(p1.report.finalizedTurnIds, ['turn-orphan'], '孤儿 Turn 在任何窗口都收尾');
    assert.deepEqual(p1.report.ineligibleTurnIds, [turnId]);
    assert.deepEqual(p1.orphanDeleted, [orphanConversationId]);
    assert.equal(p1.ownsAfterDelete, false);
    assert.equal(p1.providerCalls, 0, '控制类收尾不驱动 Provider');
    await fs.writeFile(files.finish, 'finish\n', 'utf8');
    await waitForExit(child, 90_000, true);
    const result = await readJson(files.result);
    assert.deepEqual(result.runnerErrors, []);

    observer = await kernel.RuntimeDatabase.open(new kernel.RootAuthority(() => dataRoot), { hostBootId: 'stop-observer' });
    assert.deepEqual(await rows(observer, 'Conversation', { id: conversationId }), []);
    assert.deepEqual(await rows(observer, 'Conversation', { id: orphanConversationId }), []);
    assert.equal(await ownerRecordExists(dataRoot, conversationId), false);
  } finally {
    if (observer) await observer.close().catch(() => undefined);
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('#4 资格探针暂时出错：候选保留并退避，恢复后在存活 owner 关闭时接上；出错写入诊断并限频（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('probe-backoff');
  let waiter;
  let child;
  try {
    const conversationId = 'conversation-probe-backoff';
    const files = workerFiles(outer, 'origin');
    child = spawnWorker(dataRoot, 'origin', { ...files.env, LIMCODE_ELIGIBILITY_CONVERSATION: conversationId });
    const { turnId } = await waitForWorkerJson(child, files.ready, 90_000);

    const provider = gatedProvider();
    const diagnostics = recordingDiagnostics();
    waiter = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'waiter', diagnostics });
    await waiter.app.recover();
    const report = await waiter.runner.recoverStartup();
    assert.deepEqual(report.liveOwnedTurnIds, [turnId], '同项目存活 owner：交回延迟候选');

    waiter.failProbe = true;
    await sleep(2_500);
    waiter.failProbe = false;
    const failures = diagnostics.events.filter((event) => event.eventKind === 'eligibility.probe_failed');

    await fs.writeFile(files.finish, 'close\n', 'utf8');
    await waitForExit(child, 90_000, true);
    await eventually(async () => provider.calls > 0, 30_000, '探针恢复后，owner 关闭时应当接上');
    provider.release();
    await eventually(async () => (await rows(waiter.app, 'Turn', { id: turnId }))[0]?.status === 'terminated',
      60_000, 'Turn 未完成');
    assert.deepEqual(waiter.runnerErrors, []);
    assert.equal(failures.length, 1, '同一对话一分钟内只逐条记录一次');
    assert.deepEqual(failures[0].metadata, { conversationId, reasonCode: 'probe_failed', errorName: 'TransientProbeError' });
    assert.ok(diagnostics.samples.some((sample) => sample.dimensions?.reasonCode === 'probe_failed'));
    assert.ok(diagnostics.samples.some((sample) => sample.dimensions?.reasonCode === 'eligible'));
  } finally {
    await waiter?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('#4 不合格 → 打开文件夹重扫 → 存活 owner 占用则交回延迟候选 → owner 关闭后很快接上（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('rescan-busy');
  let waiter;
  let child;
  try {
    const conversationId = 'conversation-rescan-busy';
    const files = workerFiles(outer, 'origin');
    child = spawnWorker(dataRoot, 'origin', { ...files.env, LIMCODE_ELIGIBILITY_CONVERSATION: conversationId });
    const { turnId } = await waitForWorkerJson(child, files.ready, 90_000);

    const provider = gatedProvider();
    waiter = await openHost(dataRoot, provider, { folders: [PROJECT_ONE], label: 'waiter' });
    await waiter.app.recover();
    assert.deepEqual((await waiter.runner.recoverStartup()).ineligibleTurnIds, [turnId]);
    waiter.folders.push(PROJECT_TWO);
    const rescanned = await waiter.runner.rescan();
    assert.deepEqual(rescanned.liveOwnedTurnIds, [turnId], '重扫遇到存活 owner');
    assert.deepEqual(rescanned.ineligibleTurnIds, []);

    const closedAt = Date.now();
    await fs.writeFile(files.finish, 'close\n', 'utf8');
    await waitForExit(child, 90_000, true);
    await eventually(async () => provider.calls > 0, 20_000, 'owner 关闭后应由延迟候选接上');
    assert.ok(Date.now() - closedAt < 20_000, '走的是 busy 候选，而不是 30 秒的不合格复查');
    provider.release();
    await eventually(async () => (await rows(waiter.app, 'Turn', { id: turnId }))[0]?.status === 'terminated',
      60_000, 'Turn 未完成');
    assert.deepEqual(waiter.runnerErrors, []);
  } finally {
    await waiter?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('资格判定写入诊断：按原因汇总，探针失败逐条记录并限频；面板显示可见原因', async () => {
  const diagnostics = recordingDiagnostics();
  let now = 1_000;
  const decisions = new Map([
    ['open', { eligible: true }],
    ['elsewhere', { eligible: false, reason: 'project_not_open', projectUri: PROJECT_TWO, projectName: '项目二' }],
    ['environment', { eligible: false, reason: 'work_environment_unavailable', turnId: 'turn', workEnvironmentId: 'env' }]
  ]);
  const probe = createDiagnosedConversationHostEligibility(async (conversationId) => {
    if (conversationId === 'broken') throw Object.assign(new Error('AuthoritySnapshot 重复'), { name: 'CorruptFactError' });
    return decisions.get(conversationId);
  }, diagnostics, () => now);
  for (const conversationId of decisions.keys()) await probe(conversationId);
  await assert.rejects(probe('broken'), /AuthoritySnapshot 重复/);
  await assert.rejects(probe('broken'), /AuthoritySnapshot 重复/);
  now += 60_000;
  await assert.rejects(probe('broken'), /AuthoritySnapshot 重复/);
  assert.deepEqual(diagnostics.samples.map((sample) => [sample.eventKind, sample.scopeKind, sample.dimensions.reasonCode]), [
    ['eligibility.decision', 'runtime', 'eligible'],
    ['eligibility.decision', 'runtime', 'project_not_open'],
    ['eligibility.decision', 'runtime', 'work_environment_unavailable'],
    ['eligibility.decision', 'runtime', 'probe_failed'],
    ['eligibility.decision', 'runtime', 'probe_failed'],
    ['eligibility.decision', 'runtime', 'probe_failed']
  ]);
  const failures = diagnostics.events.filter((event) => event.eventKind === 'eligibility.probe_failed');
  assert.equal(failures.length, 2, '同一对话 60 秒内只记一次');
  assert.deepEqual(failures.map((event) => [event.scopeKind, event.scopeId]), [['conversation', 'broken'], ['conversation', 'broken']]);
  assert.deepEqual(failures[0].metadata, { conversationId: 'broken', reasonCode: 'probe_failed', errorName: 'CorruptFactError' });

  // 确定性数据损坏让所有窗口都"未知"：面板必须说出原因，而不是只写日志。
  const view = await viewConversationHostEligibility(probe, 'broken');
  assert.deepEqual(view, { eligible: false, reason: 'probe_failed', errorName: 'CorruptFactError', message: 'AuthoritySnapshot 重复' });
  const { conversationRecoveryWaitingMessage } = require(compiled('vscode/panels/MainPanel.js'));
  assert.equal(
    conversationRecoveryWaitingMessage({ status: 'eligibility_unknown', message: conversationHostIneligibleMessage(view) }),
    `${EXTENSION_BRAND}：无法确认当前窗口能否继续这个对话（AuthoritySnapshot 重复），因此不会在这里执行。`
  );
  assert.equal(
    conversationRecoveryWaitingMessage({ status: 'waiting_for_project', projectName: '项目二' }),
    `${EXTENSION_BRAND}：该对话属于项目“项目二”，未完成的任务会在打开该项目的窗口中继续执行。`
  );
  assert.equal(conversationRecoveryWaitingMessage({ status: 'checked' }), undefined);
});

test('盲审 8：冻结的工作环境在当前窗口不可用时，面板恢复提示带上它的名称和路径（来自本窗口目录），不显示内部 id', async () => {
  const { conversationRecoveryWaitingMessage } = require(compiled('vscode/panels/MainPanel.js'));
  const { VscodeReliableKernelProductRuntime } = require(compiled('backend/application/reliableKernel/VscodeReliableKernelProductRuntime.js'));
  const view = {
    eligible: false,
    reason: 'work_environment_unavailable',
    turnId: 'turn-remote',
    workEnvironmentId: 'work-env-remote',
    workEnvironmentLabel: '远程机（/srv/app）'
  };
  // VscodeReliableKernelProductRuntime.recoverConversation in a window that does not serve the Conversation.
  const runtime = Object.create(VscodeReliableKernelProductRuntime.prototype);
  Object.assign(runtime, {
    closing: false,
    conversationEligibility: async () => view,
    conversations: { async recoverStartup() { return {}; } },
    recoveryController: new AbortController(),
    application: { database: { async hasConversationRuntimeWork() { return true; } } }
  });
  const result = await runtime.recoverConversation('conversation-remote');
  assert.deepEqual(result, {
    status: 'waiting_for_work_environment',
    workEnvironmentId: 'work-env-remote',
    workEnvironmentLabel: '远程机（/srv/app）'
  });
  assert.equal(
    conversationRecoveryWaitingMessage(result),
    `${EXTENSION_BRAND}：该对话冻结的工作环境“远程机（/srv/app）”在当前窗口不可用，未完成的任务会在有该工作环境的窗口中继续执行。`
  );
  // Not in this window's catalog: no name to show, and never the internal id.
  const { workEnvironmentLabel: _label, ...unlabelled } = view;
  runtime.conversationEligibility = async () => unlabelled;
  const withoutLabel = await runtime.recoverConversation('conversation-remote');
  assert.deepEqual(withoutLabel, { status: 'waiting_for_work_environment', workEnvironmentId: 'work-env-remote' });
  const message = conversationRecoveryWaitingMessage(withoutLabel);
  assert.equal(message, `${EXTENSION_BRAND}：该对话冻结的工作环境在当前窗口不可用，未完成的任务会在打开该工作环境的窗口中继续执行。`);
  assert.equal(message.includes('work-env-remote'), false);
});

test('盲审 3：产品运行时把接管无存活宿主持有的 Turn 接到与打开面板相同的按对话恢复（一次持有内：准备 → Phase D → 子调度 → 对话 Runner）', async () => {
  const { VscodeReliableKernelProductRuntime } = require(compiled('backend/application/reliableKernel/VscodeReliableKernelProductRuntime.js'));
  const order = [];
  let takeover;
  const runtime = new VscodeReliableKernelProductRuntime({
    application: {
      database: { onCommit() { return () => {}; },
        conversationOwners: { async run(id, operation) { order.push(`claim:${id}`); return operation(); } } },
      async recoverConversation(id) { order.push(`phase-d:${id}`); }
    },
    childAgents: { setConversationRecovery() {}, async recoverStartup(_signal, id) { order.push(`children:${id}`); } },
    conversations: {
      setConversationTakeover(hook) { takeover = hook; },
      async recoverStartup(_signal, id) { order.push(`runner:${id}`); }
    },
    executionGate: { frozen: 0 },
    initializeConfiguration: async () => undefined,
    conversationEligibility: async () => ({ eligible: true }),
    conversationEntryEligibility: async () => ({ eligible: true })
  });
  runtime.ensureCapabilitiesReady = async () => { order.push('ready'); };
  assert.equal(typeof takeover, 'function', '产品运行时安装了接管钩子');
  await takeover('conversation-unheld');
  assert.deepEqual(order, [
    'claim:conversation-unheld', 'ready', 'phase-d:conversation-unheld', 'children:conversation-unheld', 'runner:conversation-unheld'
  ]);
});

test('文件修改审批：窗口只记录决定，文件效果由 owner 执行器派发；仅合格窗口安排续跑', async () => {
  for (const eligible of [false, true]) {
    informationMessages.length = 0;
    const calls = { decided: 0, dispatched: 0, resumed: 0 };
    const router = new VscodeReliableKernelCommandRouter({
      debugCapture: { setListener() {} },
      toolHost: { setStateChangeListener() {} },
      application: {
        database: { conversationOwners: { async run(_conversationId, operation) { return operation(); } } },
        files: {
          async decide() {
            calls.decided += 1;
            return { won: true, preparedEffect: { effectIntentId: 'effect-edit' } };
          }
        },
        fileMutations: { async dispatchRecordAndReconcile() { calls.dispatched += 1; } }
      },
      childAgents: { async resume() { return false; } },
      conversations: { resume() { calls.resumed += 1; } },
      async conversationHostEligibility() {
        return eligible
          ? { eligible: true }
          : { eligible: false, reason: 'project_not_open', projectUri: PROJECT_TWO, projectName: '项目二' };
      }
    });
    const requestRows = { approval: { id: 'approval', request_kind: 'file_change_approval', status: 'pending' } };
    const lists = {
      InteractionOwnerLink: [{ id: 'owner', request_id: 'approval', turn_id: 'turn' }],
      InteractionToolCallLink: [{ id: 'link', request_id: 'approval', tool_call_id: 'edit-call' }],
      FileChangeSet: [{ id: 'change-set', tool_call_id: 'edit-call' }]
    };
    router.maybeRow = async (domain, id) => domain === 'InteractionRequest' ? requestRows[id] : undefined;
    router.list = async (domain, where) => (lists[domain] ?? [])
      .filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
    const posted = [];
    await router.dispatch('approval-client', webview(posted), {
      id: `approve-${eligible}`,
      type: BridgeMessageType.InteractionResolve,
      channel: 'command',
      payload: {
        conversationId: 'conversation', interactionRequestId: 'approval', interactionRevision: 1,
        ownerTurnId: 'turn', decision: 'accept', response: {}
      }
    });
    await sleep(50);
    assert.equal(calls.decided, 1);
    assert.equal(calls.dispatched, 0, '命令路由只记录批准，文件效果交给 owner 执行器派发');
    assert.deepEqual(posted.map((message) => message.payload.status), ['committed']);
    if (eligible) {
      assert.equal(calls.resumed, 1);
      assert.deepEqual(informationMessages, []);
    } else {
      assert.equal(calls.resumed, 0);
      assert.deepEqual(informationMessages, [`${EXTENSION_BRAND}：回答已记录，将在打开项目“项目二”的窗口中继续执行。`]);
    }
  }
});

test('停止时工具仍在另一个存活窗口执行：面板停止提示去该窗口查看结果', async () => {
  informationMessages.length = 0;
  const interrupts = [];
  const router = new VscodeReliableKernelCommandRouter({
    debugCapture: { setListener() {} },
    toolHost: { setStateChangeListener() {} },
    application: { database: { conversationOwners: { async run(_conversationId, operation) { return operation(); } } } },
    conversations: {
      async interrupt(input) {
        interrupts.push(input.turnId);
        return { receiptId: 'receipt', deduplicated: false, conversationId: input.conversationId, turnId: input.turnId,
          pendingTurnInputId: 'stop', executingWindowAlive: true };
      }
    }
  });
  router.maybeRow = async (domain, id) => domain === 'Turn' ? { id, conversation_id: 'conversation', status: 'active' } : undefined;
  router.list = async () => [];
  const posted = [];
  await router.dispatch('stop-client', webview(posted), {
    id: 'stop',
    type: BridgeMessageType.TurnInterrupt,
    channel: 'command',
    payload: {
      conversationId: 'conversation', turnId: 'turn', leaseEpoch: 0,
      command: { commandId: 'stop', expectedVersion: 0, issuedAt: Date.now() }, cascadeChildAgents: false
    }
  });
  assert.deepEqual(interrupts, ['turn']);
  assert.deepEqual(posted.map((message) => message.payload.status), ['accepted']);
  assert.deepEqual(informationMessages, [
    `${EXTENSION_BRAND}：停止请求已记录。这个对话的工具或正在启动的子 Agent 仍在另一个窗口中执行，请到该窗口查看停止结果；子 Agent 启动完成后也可以在那里停止它。`
  ]);
});

test('面板入口按将执行它的 Agent 判定：单条消息指定的 Agent；手动压缩用源 Turn 的执行 Agent', async () => {
  const judged = [];
  const refused = { eligible: false, reason: 'next_work_environment_unavailable', message: '当前窗口的工作环境不可用。' };
  const router = new VscodeReliableKernelCommandRouter({
    debugCapture: { setListener() {} },
    toolHost: { setStateChangeListener() {} },
    application: { database: { conversationOwners: { async run(_conversationId, operation) { return operation(); } } } },
    conversations: {
      async manualCompressionExecutorAgentId(conversationId, childExecutionId) {
        judged.push(['source-executor', conversationId, childExecutionId]);
        return 'agent-source';
      }
    },
    async conversationEntryEligibility(conversationId, options) {
      judged.push(['entry', conversationId, options]);
      return refused;
    }
  });
  router.list = async () => [];
  const command = { commandId: 'c', expectedVersion: 0, issuedAt: Date.now() };
  await assert.rejects(router.handleTurnInput(webview([]), 'start', BridgeMessageType.TurnStart,
    { conversationId: 'conversation', command, text: '你好', agentId: ' agent-other ' }), (error) => error?.code === 'conversation-host-ineligible');
  await assert.rejects(router.handleCompressionStart(webview([]), 'compress', {
    conversationId: 'conversation', command, target: { kind: 'current_head', expectedRootId: 'root' }
  }), (error) => error?.code === 'conversation-host-ineligible');
  assert.deepEqual(judged, [
    ['entry', 'conversation', { executorAgentId: 'agent-other' }],
    ['source-executor', 'conversation', undefined],
    ['entry', 'conversation', { executorAgentId: 'agent-source' }]
  ]);
});

test('同项目两个窗口并发恢复只有一个承接，其它项目窗口不参与（跨进程证明）', { timeout: 240_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('race');
  const children = [];
  let observer;
  try {
    const conversationId = 'conversation-race';
    const turnId = await startTurnThenCloseHost(dataRoot, conversationId, PROJECT_TWO_FOLDER);
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

    await fs.writeFile(gate, 'release\n', 'utf8');
    observer = await kernel.RuntimeDatabase.open(new kernel.RootAuthority(() => dataRoot), { hostBootId: 'race-observer' });
    await eventually(async () => (await rows(observer, 'Turn', { id: turnId }))[0]?.status === 'terminated',
      90_000, '承接方未完成 Turn');
    await fs.writeFile(finish, 'finish\n', 'utf8');
    for (const { child } of children) await waitForExit(child, 90_000, true);
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
});

test('审批与提问提示只在持有其 Turn 执行租约的窗口出现，重复回答只生效一次', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('attention');
  let app;
  try {
    app = await kernel.ReliableKernelApplication.open(
      new kernel.RootAuthority(() => dataRoot),
      fixtureDependencies(gatedProvider(), null)
    );
    const hostBootId = app.database.hostBootId;
    const conversationId = 'conversation-attention';
    const turnId = 'turn-attention';
    const leaseId = 'lease-attention';
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId, title: '等待回答', status: 'active', created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: turnId, conversation_id: conversationId, status: 'active', created_at: now, updated_at: now, terminal_at: null
      }),
      kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
        id: leaseId, conversation_id: conversationId, turn_id: turnId, owner_id: 'attention-owner',
        host_boot_id: 'peer-window', generation: 1n, acquired_at: now,
        expires_at: new Date(Date.now() + 60_000).toISOString()
      })
    ]);
    const askArgs = { question: '继续吗？', options: [{ label: '继续' }, { label: '停止' }] };
    await app.runtime.effects.createToolCall({
      source: { kind: 'internal', key: 'create:ask' }, toolCallId: 'ask-call', turnId, toolName: 'ask_user', arguments: askArgs
    });
    const pause = await app.interactions.pauseForAskUser({
      source: { kind: 'internal', key: 'pause-ask' }, toolCallId: 'ask-call', prompt: askArgs
    });

    assert.deepEqual(await readPendingInteractionAttention(app.database, hostBootId), [],
      '租约在其它窗口时本窗口不得提示');
    assert.deepEqual((await readPendingInteractionAttention(app.database, 'peer-window')).map((item) => item.requestId),
      [pause.requestId]);

    const tracker = new InteractionLeaseEdgeTracker(hostBootId);
    const claim = { changes: [{ domain: 'ExecutionLease', kind: 'upsert', id: leaseId,
      record: { host_boot_id: hostBootId, generation: 2n } }] };
    const renewal = { changes: [{ domain: 'ExecutionLease', kind: 'upsert', id: leaseId,
      record: { host_boot_id: hostBootId, generation: 2n } }] };
    const foreign = { changes: [{ domain: 'ExecutionLease', kind: 'upsert', id: 'other-lease',
      record: { host_boot_id: 'peer-window', generation: 1n } }] };
    assert.equal(tracker.observe(claim), true, '本窗口新取得租约必须触发提示刷新');
    assert.equal(tracker.observe(renewal), false, '同代续租不得触发刷新');
    assert.equal(tracker.observe(foreign), false);
    assert.equal(tracker.observe({ changes: [{ domain: 'ExecutionLease', kind: 'remove', id: leaseId }] }), false);
    assert.equal(tracker.observe(claim), true, '释放后再取得视为新边沿');

    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').update(leaseId, { host_boot_id: hostBootId, generation: 2n })
    ]);
    const mine = await readPendingInteractionAttention(app.database, hostBootId);
    assert.deepEqual(mine.map((item) => [item.requestId, item.kind, item.conversationId, item.conversationTitle]),
      [[pause.requestId, 'ask_user', conversationId, '等待回答']]);
    assert.deepEqual(await readPendingInteractionAttention(app.database, 'peer-window'), []);

    const answers = [];
    for (const key of ['window-a', 'window-b']) {
      answers.push(await app.interactions.resolveAskUser({
        source: { kind: 'command', key: `answer-${key}` },
        requestId: pause.requestId,
        response: { answer: { selectedOptionIndexes: [], customText: key } }
      }));
    }
    assert.deepEqual(answers.map((answer) => answer.won), [true, false], '另一窗口的后到回答不得再次生效');
    assert.equal((await rows(app, 'InteractionResponse', { request_id: pause.requestId })).length, 1);
    assert.deepEqual(await readPendingInteractionAttention(app.database, hostBootId), []);
  } finally {
    if (app) await app.close().catch(() => undefined);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('存活窗口持有对话时，另一个窗口经真实路由回答 Ask、取消执行审批与批准当前对话 Plan，只写首答且不接管执行', { timeout: 120_000 }, async () => {
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
});

}

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
      await writeJson(requiredEnv('LIMCODE_ELIGIBILITY_READY'), { turnId: started.turnId });
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
