import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Window eligibility, blind review: a waiting Turn's lease goes back with its folder even after it
// expired, and after a busy Conversation (top-level Turns and child Agents alike); a hand-back first
// lets this window's in-flight native calls settle, and Phase D never records a live dispatcher's
// effect as unknown; a Turn no live Host holds is taken over with the full per-Conversation recovery;
// the takeover scan probes process identity only for expired leases, cached per (hostBootId, pid);
// a child compression admitted here but no longer drivable fails; a peer message's continuation is
// placed by the same decision as new input.
const root = process.cwd();
const load = (relative) => import(pathToFileURL(path.join(root, 'dist/extension', relative)).href);
const kernel = await load('backend/reliableKernel/index.js');
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
/** A short execution lease, so a Turn can wait longer than its lease lasts within a test. */
const SHORT_LEASE_MS = 3_000;
const TEST_FILE = fileURLToPath(import.meta.url);
const RELEASED = kernel.RELEASED_EXECUTION_LEASE_HOLDER;

/** An MCP tool; each window decides how its server answers (never, on a gate, at once). */
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
  name: 'ask_user', args: { question: '继续吗？', options: [{ label: '继续' }] } } }] };
const MCP_CALL = { role: 'model', parts: [{ id: 'mcp-call', functionCall: { name: 'fixture_call', args: {} } }] };
const SPAWN_CHILD = { role: 'model', parts: [{ id: 'provider-spawn', functionCall: {
  name: 'run_agent', args: { operation: 'spawn', taskName: '子任务', prompt: '做子任务', foregroundWaitMs: 0 } } }] };
const text = (value) => ({ role: 'model', parts: [{ text: value }] });

const workerMode = process.env.LIMCODE_BLIND_WORKER;
if (workerMode) {
  runWorker(workerMode).then(
    () => process.exit(0),
    (error) => {
      console.error(error?.stack ?? error);
      process.exit(1);
    }
  );
} else {

test('盲审 1：Turn 等待回答超过执行租约时长后才移走项目文件夹：本窗口重扫时按租约行交还（不看是否过期），合格窗口回答后续跑（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('expired');
  let w2; let child;
  try {
    const conversationId = 'conversation-expired';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, 'expired', { ...files.env, LIMCODE_BLIND_CONVERSATION: conversationId });
    const w1 = await waitForWorkerJson(child, files.ready, 90_000);
    assert.equal(w1.expiredBeforeRemoval, true, '移走文件夹时 W1 的租约已过期（等待中的 Turn 不续租）');
    assert.equal(w1.leaseOwner, RELEASED, 'W1 仍交还了自己持有的租约');
    assert.deepEqual(w1.runnerErrors, []);

    const provider2 = scriptedProvider([text('按回答继续。')]);
    w2 = await openHost(dataRoot, provider2, { folders: [PROJECT_TWO], label: 'w2', askUser: true });
    await w2.app.recover();
    await w2.runner.recoverStartup();
    const [request] = await rows(w2.app, 'InteractionRequest', { status: 'pending' });
    await answerAskUser(w2, conversationId, request.id, 'expired-answer');
    w2.runner.resume(conversationId, w1.turnId);
    await eventually(async () => (await rows(w2.app, 'Turn', { id: w1.turnId }))[0]?.status === 'terminated',
      30_000, '合格窗口没有续跑');
    assert.equal(provider2.calls, 1);
    assert.equal(child.exitCode, null, 'W1 一直存活');
    assert.deepEqual(errorsOf(w2), []);
    await fsp.writeFile(files.finish, 'finish\n', 'utf8');
    await waitForExit(child, 90_000, true);
  } finally {
    await w2?.close();
    await stopChild(child);
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('盲审 1：交还时别的窗口正持有该对话：保留待交还，对方放手后本窗口延迟重试时交还，合格窗口回答后续跑（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('busy');
  let w2; let child;
  try {
    const conversationId = 'conversation-busy';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, 'busy', { ...files.env, LIMCODE_BLIND_CONVERSATION: conversationId });
    const w1 = await waitForWorkerJson(child, files.ready, 90_000);
    const provider2 = scriptedProvider([text('按回答继续。')]);
    w2 = await openHost(dataRoot, provider2, { folders: [PROJECT_TWO], label: 'w2', askUser: true });
    // W2 holds the Conversation (a command runs there) exactly while W1 rescans without the folder.
    let report;
    await w2.app.database.conversationOwners.run(conversationId, async () => {
      await fsp.writeFile(files.signal, 'remove\n', 'utf8');
      report = await waitForWorkerJson(child, files.report, 60_000);
    });
    assert.equal(report.expiredBeforeRemoval, true);
    assert.equal(report.leaseHost, w1.hostBootId, '对话被别的窗口占着：这一次交还不成，租约仍在 W1');
    // W2 lets go; W1 keeps the hand-back pending and retries it.
    await eventually(async () => (await rows(w2.app, 'ExecutionLease', { turn_id: w1.turnId }))[0]?.owner_id === RELEASED,
      20_000, 'W1 没有在对方放手后重试交还');
    await w2.app.recover();
    await w2.runner.recoverStartup();
    const [request] = await rows(w2.app, 'InteractionRequest', { status: 'pending' });
    await answerAskUser(w2, conversationId, request.id, 'busy-answer');
    w2.runner.resume(conversationId, w1.turnId);
    await eventually(async () => (await rows(w2.app, 'Turn', { id: w1.turnId }))[0]?.status === 'terminated',
      30_000, '合格窗口没有续跑');
    assert.equal(provider2.calls, 1);
    assert.equal(child.exitCode, null, 'W1 一直存活');
    assert.deepEqual(errorsOf(w2), []);
    await fsp.writeFile(files.finish, 'finish\n', 'utf8');
    const done = await waitForExit(child, 90_000, true);
    assert.equal(done.code, 0);
  } finally {
    await w2?.close();
    await stopChild(child);
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('盲审 1：子 Agent 等待回答超过子 Turn 租约时长后才移走项目文件夹：本窗口子调度交还子 Turn 的租约，合格窗口回答后子 Agent 续跑（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('child-expired');
  let w2; let child;
  try {
    const conversationId = 'conversation-child-expired';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, 'child', { ...files.env, LIMCODE_BLIND_CONVERSATION: conversationId });
    const w1 = await waitForWorkerJson(child, files.ready, 120_000);
    assert.equal(w1.expiredBeforeRemoval, true, '移走文件夹时子 Turn 的租约已过期');
    assert.equal(w1.leaseOwner, RELEASED, '子调度交还了子 Turn 的租约');
    assert.deepEqual(w1.errors, []);

    const provider2 = routedProvider((request, n) => request.conversationId === w1.childConversationId
      ? [text('子 Agent 按回答完成。')][n - 1]
      : [text('父对话收到子 Agent 的结果。')][n - 1]);
    w2 = await openHost(dataRoot, provider2, { folders: [PROJECT_TWO], label: 'w2', askUser: true, children: true });
    await w2.app.recover();
    await w2.coordinator.recoverStartup();
    await w2.runner.recoverStartup();
    const [request] = await rows(w2.app, 'InteractionRequest', { status: 'pending' });
    await answerAskUser(w2, w1.childConversationId, request.id, 'child-answer');
    // VscodeReliableKernelCommandRouter.resumeInteractionOwner
    assert.equal(await w2.coordinator.resume(w1.childTurnId), true);
    await eventually(async () => (await rows(w2.app, 'Turn', { id: w1.childTurnId }))[0]?.status === 'terminated',
      30_000, '合格窗口没有续跑子 Agent');
    assert.equal(provider2.callsFor(w1.childConversationId), 1, '子 Agent 在合格窗口调用了一次模型');
    assert.equal(child.exitCode, null, 'W1 一直存活');
    await fsp.writeFile(files.finish, 'finish\n', 'utf8');
    await waitForExit(child, 90_000, true);
  } finally {
    await w2?.close();
    await stopChild(child);
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('盲审 2：交还等待中 Turn 的租约前，先等本窗口这个 Turn 的在途 native 调用结束；重扫本身不被它阻塞', { timeout: 120_000 }, async () => {
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
    await sleep(500);
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
});

test('盲审 2：等本窗口在途 native 调用期间文件夹又回来了：调用结束后在认领内复核，不交还租约，本窗口照常接着执行', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('quiesce-returned');
  let host;
  try {
    const conversationId = 'conversation-quiesce-returned';
    const provider = scriptedProvider([ASK_USER, text('按回答继续。')]);
    host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'w', askUser: true });
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const { turnId } = await host.runner.input({ commandId: 'quiesce-returned', conversationId, text: '问我' });
    await eventually(async () => (await rows(host.app, 'InteractionRequest', { status: 'pending' })).length === 1, 30_000, '未进入等待');
    await host.runner.waitForIdle();
    const call = inFlightNativeCall(host.app.agentLoop, turnId);
    host.folders.splice(host.folders.indexOf(PROJECT_TWO), 1);
    await host.runner.rescan();
    host.folders.push(PROJECT_TWO);
    call.settle();
    await sleep(800);
    const [lease] = await rows(host.app, 'ExecutionLease', { turn_id: turnId });
    assert.equal(lease?.host_boot_id, host.app.database.hostBootId, '文件夹已回来：租约留在本窗口');
    await host.runner.rescan();
    const [request] = await rows(host.app, 'InteractionRequest', { status: 'pending' });
    await answerAskUser(host, conversationId, request.id, 'returned-answer');
    host.runner.resume(conversationId, turnId);
    await eventually(async () => (await rows(host.app, 'Turn', { id: turnId }))[0]?.status === 'terminated', 30_000, '本窗口没有接着执行');
    assert.equal(provider.calls, 2);
    assert.deepEqual(errorsOf(host), []);
  } finally {
    await host?.close();
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('盲审 1：资格一度无法确定、之后确定不合格：延迟候选复查时本窗口仍持有租约就交还；本窗口不持有租约时不为交还认领对话', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('deferred-hand-back');
  let host;
  try {
    const conversationId = 'conversation-deferred-hand-back';
    host = await openHost(dataRoot, scriptedProvider([ASK_USER]), { folders: [PROJECT_TWO], label: 'w', askUser: true });
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const { turnId } = await host.runner.input({ commandId: 'deferred-hand-back', conversationId, text: '问我' });
    await eventually(async () => (await rows(host.app, 'InteractionRequest', { status: 'pending' })).length === 1, 30_000, '未进入等待');
    await host.runner.waitForIdle();
    host.failProbe = true;
    host.folders.splice(host.folders.indexOf(PROJECT_TWO), 1);
    await host.runner.rescan();
    assert.equal((await rows(host.app, 'ExecutionLease', { turn_id: turnId }))[0]?.host_boot_id, host.app.database.hostBootId,
      '资格未知：不交还');
    host.failProbe = false;
    await eventually(async () => (await rows(host.app, 'ExecutionLease', { turn_id: turnId }))[0]?.owner_id === RELEASED,
      15_000, '延迟候选复查确定不合格后没有交还');
    // Nothing is held any more: a hand-back does not claim the Conversation for nothing.
    await eventually(async () => !host.runner.leaseHandBacks.has(turnId), 5_000, '交还没有结束');
    const owners = host.app.database.conversationOwners;
    const run = owners.run.bind(owners);
    let claims = 0;
    owners.run = (id, operation) => {
      if (id === conversationId) claims += 1;
      return run(id, operation);
    };
    assert.equal(await host.runner.releaseWaitingTurn(conversationId, turnId), 'not_held');
    assert.equal(claims, 0, '不持有租约时不认领对话');
    assert.deepEqual(errorsOf(host), []);
  } finally {
    await host?.close();
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('盲审 1：待交还标记重试时 Turn 正由本窗口驱动：不替驱动交还，租约由驱动在轮次之间自己交还', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('pending-driven');
  let host;
  try {
    const conversationId = 'conversation-pending-driven';
    const mcp = gatedMcp();
    const provider = scriptedProvider([MCP_CALL, text('不应到达')]);
    host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'w', mcp: mcp.answer });
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const { turnId } = await host.runner.input({ commandId: 'pending-driven', conversationId, text: '调用外部工具' });
    await mcp.started;
    // The folder leaves while a tool of the Turn runs; a hand-back left pending earlier is retried.
    host.folders.splice(host.folders.indexOf(PROJECT_TWO), 1);
    host.runner.pendingLeaseHandBacks.set(turnId, conversationId);
    host.runner.ensureExternalWakePolling();
    await sleep(1_500);
    assert.equal((await rows(host.app, 'ExecutionLease', { turn_id: turnId }))[0]?.host_boot_id, host.app.database.hostBootId,
      '工具仍在执行：不替驱动交还租约');
    mcp.release();
    await eventually(async () => (await rows(host.app, 'ExecutionLease', { turn_id: turnId }))[0]?.owner_id === RELEASED,
      30_000, '驱动没有在轮次之间交还');
    assert.equal(provider.calls, 1);
  } finally {
    await host?.close();
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('盲审 2：驱动中文件夹离开、循环在轮次之间停下：先等本窗口这个 Turn 的在途 native 调用结束再交还租约', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('quiesce-drive');
  let host;
  try {
    const conversationId = 'conversation-quiesce-drive';
    const mcp = gatedMcp();
    const provider = scriptedProvider([MCP_CALL, text('不应到达')]);
    host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'w', mcp: mcp.answer });
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    const { turnId } = await host.runner.input({ commandId: 'quiesce-drive', conversationId, text: '调用外部工具' });
    await mcp.started;
    const call = inFlightNativeCall(host.app.agentLoop, turnId);
    host.folders.splice(host.folders.indexOf(PROJECT_TWO), 1);
    mcp.release();
    await eventuallyValue(async () => (await rows(host.app, 'ToolCall', { turn_id: turnId, status: 'terminal' }))[0],
      30_000, '外部调用的结果没有记录');
    await sleep(800);
    assert.equal(provider.calls, 1, '循环在下一轮开始前停下');
    assert.equal((await rows(host.app, 'ExecutionLease', { turn_id: turnId }))[0]?.host_boot_id, host.app.database.hostBootId,
      '本窗口仍在执行这个 Turn 的调用：租约还不交还');
    call.settle();
    await eventually(async () => (await rows(host.app, 'ExecutionLease', { turn_id: turnId }))[0]?.owner_id === RELEASED,
      10_000, '调用结束后没有交还租约');
    assert.equal(provider.calls, 1);
  } finally {
    await host?.close();
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('盲审 2：子 Agent 等待中文件夹离开：子调度先等本窗口子 Turn 的在途 native 调用结束再交还，恢复扫描本身不被它阻塞', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('quiesce-child-waiting');
  let host;
  try {
    const conversationId = 'conversation-quiesce-child-waiting';
    const provider = routedProvider((request, n) => request.conversationId === conversationId
      ? [SPAWN_CHILD, text('子任务已开始。')][n - 1]
      : [ASK_USER][n - 1]);
    host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'w', askUser: true, children: true });
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    await host.runner.input({ commandId: 'quiesce-child', conversationId, text: '派一个子 Agent' });
    const { childTurnId } = await waitForChildQuestion(host);
    const call = inFlightNativeCall(host.app.agentLoop, childTurnId);
    host.folders.splice(host.folders.indexOf(PROJECT_TWO), 1);
    await withinMs(host.coordinator.recoverStartup(), 5_000, '子调度恢复扫描被在途调用阻塞');
    await sleep(500);
    assert.equal((await rows(host.app, 'ExecutionLease', { turn_id: childTurnId }))[0]?.host_boot_id, host.app.database.hostBootId,
      '本窗口仍在执行子 Turn 的调用：租约还不交还');
    call.settle();
    await eventually(async () => (await rows(host.app, 'ExecutionLease', { turn_id: childTurnId }))[0]?.owner_id === RELEASED,
      10_000, '调用结束后子调度没有交还租约');
  } finally {
    await host?.close();
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('盲审 2：子 Agent 等本窗口在途 native 调用期间文件夹又回来了：不交还子 Turn 的租约；已不持有时子调度不为交还认领子对话', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('quiesce-child-returned');
  let host;
  try {
    const conversationId = 'conversation-quiesce-child-returned';
    const provider = routedProvider((request, n) => request.conversationId === conversationId
      ? [SPAWN_CHILD, text('子任务已开始。')][n - 1]
      : [ASK_USER][n - 1]);
    host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'w', askUser: true, children: true });
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    await host.runner.input({ commandId: 'quiesce-child-returned', conversationId, text: '派一个子 Agent' });
    const { execution, childTurnId } = await waitForChildQuestion(host);
    const call = inFlightNativeCall(host.app.agentLoop, childTurnId);
    host.folders.splice(host.folders.indexOf(PROJECT_TWO), 1);
    await host.coordinator.recoverStartup();
    host.folders.push(PROJECT_TWO);
    call.settle();
    await sleep(800);
    const [lease] = await rows(host.app, 'ExecutionLease', { turn_id: childTurnId });
    assert.equal(lease?.owner_id, host.coordinator.childLeaseOwnerId, '文件夹已回来：子 Turn 的租约留在本窗口');

    // Once the lease went back, a later pass finds nothing held and claims nothing for it.
    host.folders.splice(host.folders.indexOf(PROJECT_TWO), 1);
    await host.coordinator.recoverStartup();
    await eventually(async () => (await rows(host.app, 'ExecutionLease', { turn_id: childTurnId }))[0]?.owner_id === RELEASED,
      10_000, '子调度没有交还');
    await eventually(async () => !host.coordinator.leaseHandBacks.has(childTurnId), 5_000, '子调度的交还没有结束');
    const owners = host.app.database.conversationOwners;
    const run = owners.run.bind(owners);
    let claims = 0;
    owners.run = (id, operation) => {
      if (id === execution.child_conversation_id) claims += 1;
      return run(id, operation);
    };
    await host.coordinator.handBackIneligibleChildLease(childTurnId, execution.child_conversation_id);
    assert.equal(claims, 0, '不持有租约时不认领子对话');
  } finally {
    await host?.close();
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('盲审 2：不服务子对话的窗口被唤醒驱动子 Turn：先等本窗口子 Turn 的在途 native 调用结束再交还租约', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('quiesce-child-not-served');
  let host;
  try {
    const conversationId = 'conversation-quiesce-child-not-served';
    const provider = routedProvider((request, n) => request.conversationId === conversationId
      ? [SPAWN_CHILD, text('子任务已开始。')][n - 1]
      : [ASK_USER][n - 1]);
    host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'w', askUser: true, children: true });
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    await host.runner.input({ commandId: 'quiesce-child-not-served', conversationId, text: '派一个子 Agent' });
    const { execution, childTurnId } = await waitForChildQuestion(host);
    const call = inFlightNativeCall(host.app.agentLoop, childTurnId);
    host.folders.splice(host.folders.indexOf(PROJECT_TWO), 1);
    let settled = false;
    const drive = host.coordinator.driveChild(execution.id, childTurnId).finally(() => { settled = true; });
    const rejected = assert.rejects(drive, /not served by this Host/);
    await sleep(500);
    assert.equal(settled, false, '驱动在等本窗口的调用');
    assert.equal((await rows(host.app, 'ExecutionLease', { turn_id: childTurnId }))[0]?.owner_id, host.coordinator.childLeaseOwnerId,
      '调用仍在执行：租约还不交还');
    call.settle();
    await rejected;
    assert.equal((await rows(host.app, 'ExecutionLease', { turn_id: childTurnId }))[0]?.owner_id, RELEASED);
  } finally {
    await host?.close();
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('盲审 2：子 Agent 驱动中文件夹离开、在轮次之间停下：先等本窗口子 Turn 的在途 native 调用结束再交还', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('quiesce-child-drive');
  let host;
  try {
    const conversationId = 'conversation-quiesce-child-drive';
    const mcp = gatedMcp();
    const provider = routedProvider((request, n) => request.conversationId === conversationId
      ? [SPAWN_CHILD, text('子任务已开始。')][n - 1]
      : [MCP_CALL, text('不应到达')][n - 1]);
    host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'w', children: true, mcp: mcp.answer });
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    await host.runner.input({ commandId: 'quiesce-child-drive', conversationId, text: '派一个子 Agent' });
    await mcp.started;
    const [execution] = await rows(host.app, 'ChildExecution', {});
    const [link] = await rows(host.app, 'ChildExecutionActiveTurnLink', { child_execution_id: execution.id });
    const childTurnId = link.turn_id;
    const call = inFlightNativeCall(host.app.agentLoop, childTurnId);
    host.folders.splice(host.folders.indexOf(PROJECT_TWO), 1);
    mcp.release();
    await eventuallyValue(async () => (await rows(host.app, 'ToolCall', { turn_id: childTurnId, status: 'terminal' }))[0],
      30_000, '子 Agent 外部调用的结果没有记录');
    await sleep(800);
    assert.equal(provider.callsFor(execution.child_conversation_id), 1, '子 Agent 的循环在下一轮开始前停下');
    assert.equal((await rows(host.app, 'ExecutionLease', { turn_id: childTurnId }))[0]?.host_boot_id, host.app.database.hostBootId,
      '本窗口仍在执行子 Turn 的调用：租约还不交还');
    call.settle();
    await eventually(async () => (await rows(host.app, 'ExecutionLease', { turn_id: childTurnId }))[0]?.owner_id === RELEASED,
      10_000, '调用结束后没有交还子 Turn 的租约');
  } finally {
    await host?.close();
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('盲审 2：租约已交还但派发窗口仍存活：合格窗口打开面板时 Phase D 不把它仍在执行的效果记为结果未知，派发窗口随后写回真实结果（跨进程）', { timeout: 180_000 }, async () => {
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
});

test('盲审 3/4：已打开的合格窗口接管退出窗口留下的 Turn 时走与打开面板相同的恢复（先 Phase D），Turn 续跑完成；退出时租约未过期也会在到期后接管（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('takeover');
  let w2; let child;
  try {
    const conversationId = 'conversation-takeover';
    // Already open before the Turn exists, so its own startup recovery saw nothing.
    const provider2 = scriptedProvider([text('接上后完成。')]);
    w2 = await openHost(dataRoot, provider2, { folders: [PROJECT_TWO], label: 'w2', children: true, takeover: true });
    await w2.app.recover();
    await w2.coordinator.recoverStartup();
    await w2.runner.recoverStartup();

    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, 'takeover', { ...files.env, LIMCODE_BLIND_CONVERSATION: conversationId });
    const w1 = await waitForWorkerJson(child, files.ready, 90_000);
    child.kill('SIGKILL');
    await waitForExit(child, 30_000);
    const [lease] = await rows(w2.app, 'ExecutionLease', { turn_id: w1.turnId });
    assert.equal(lease.host_boot_id, w1.hostBootId);
    // As the ExternalDataVersionWatcher does after another window's commit: one scan, no later trigger.
    w2.runner.recoverUnheldTurns();
    await eventually(async () => (await rows(w2.app, 'Turn', { id: w1.turnId }))[0]?.status === 'terminated',
      45_000, '接管后 Turn 没有完成');
    const [call] = await rows(w2.app, 'ToolCall', { turn_id: w1.turnId });
    const [intent] = await effectIntentsForToolCall(w2.app, call.id);
    const [receipt] = await rows(w2.app, 'EffectReceipt', { attempt_id: intent.attempt_id });
    assert.equal(receipt?.outcome, 'outcome_unknown', '退出窗口已派发的调用由 Phase D 核对');
    assert.match((await readContentJson(w2.app, receipt.response_object_id)).reason, /MCP service cannot prove/);
    assert.equal(provider2.calls, 1, '接管窗口续跑了 Turn');
    assert.equal(w2.mcpCalls(), 0, '不重放外部调用');
    assert.deepEqual(errorsOf(w2), []);
  } finally {
    await w2?.close();
    await stopChild(child);
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('盲审 4：接管扫描只对租约已过期的 Turn 做进程身份探测，比对结果按 (hostBootId, pid) 缓存；持有进程消失后立即判死并接管（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('probe');
  let w2; let child;
  const readFileSync = fs.readFileSync;
  try {
    const conversationId = 'conversation-probe';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, 'probe', { ...files.env, LIMCODE_BLIND_CONVERSATION: conversationId });
    const w1 = await waitForWorkerJson(child, files.ready, 90_000);
    w2 = await openHost(dataRoot, scriptedProvider([]), { folders: [PROJECT_TWO], label: 'w2', askUser: true, takeover: true });
    const database = w2.app.database;
    const probes = { cached: 0, uncached: 0 };
    const cached = database.isHostAliveCached.bind(database);
    const uncached = database.isHostAlive.bind(database);
    database.isHostAliveCached = async (hostBootId) => {
      if (hostBootId === w1.hostBootId) probes.cached += 1;
      return cached(hostBootId);
    };
    database.isHostAlive = async (hostBootId) => {
      if (hostBootId === w1.hostBootId) probes.uncached += 1;
      return uncached(hostBootId);
    };
    const [lease] = await rows(w2.app, 'ExecutionLease', { turn_id: w1.turnId });
    const expiresAt = Date.parse(lease.expires_at);

    // Unexpired: never taken over here, so its holder is not probed.
    await w2.runner.scanUnheldTurns();
    assert.ok(Date.now() < expiresAt, '前提：扫描时租约尚未过期');
    assert.deepEqual(probes, { cached: 0, uncached: 0 }, '未过期的租约不做进程探测');

    // Expired (a waiting Turn does not renew): each scan probes, with the cached comparison.
    await sleep(Math.max(0, expiresAt - Date.now()) + 1_000);
    await w2.runner.scanUnheldTurns();
    await w2.runner.scanUnheldTurns();
    assert.ok(probes.cached >= 2, '过期租约的持有者被探测');
    assert.equal(probes.uncached, 0, '扫描不用无缓存的探测');
    assert.equal((await rows(w2.app, 'ExecutionLease', { turn_id: w1.turnId }))[0]?.host_boot_id, w1.hostBootId,
      '持有者存活：不接管');

    // The comparison of W1's process start identity is not repeated per probe.
    const statReads = { count: 0 };
    fs.readFileSync = function patched(file, ...rest) {
      if (String(file) === `/proc/${w1.pid}/stat`) statReads.count += 1;
      return readFileSync.call(this, file, ...rest);
    };
    for (let i = 0; i < 3; i += 1) assert.equal(await database.isHostAliveCached(w1.hostBootId), true);
    if (process.platform === 'linux') {
      assert.equal(statReads.count, 0, '缓存命中时不再比对进程启动身份');
      assert.equal(await database.isHostAlive(w1.hostBootId), true);
      assert.equal(statReads.count, 1, '无缓存的探测每次都比对');
    }

    // A recorded process whose start identity does not match (its PID was reused) is dead, and stays
    // dead although a process with that PID exists.
    const own = JSON.parse(await fsp.readFile(database.hostLivenessPath(database.hostBootId), 'utf8'));
    const reusedHostBootId = crypto.randomUUID();
    await fsp.writeFile(database.hostLivenessPath(reusedHostBootId),
      JSON.stringify({ ...own, hostBootId: reusedHostBootId, processStartIdentity: `${own.processStartIdentity ?? 'identity'}-reused` }));
    assert.equal(await database.isHostAliveCached(reusedHostBootId), false, 'PID 被复用：启动身份不符即判死');
    assert.equal(await database.isHostAliveCached(reusedHostBootId), false, '判死的结果不因该 PID 上仍有进程而翻回存活');

    // The holder exits: the cheap existence check finds it gone at once, and the Turn is taken over.
    child.kill('SIGKILL');
    await waitForExit(child, 30_000);
    assert.equal(await database.isHostAliveCached(w1.hostBootId), false, '进程消失后立即判死');
    await w2.runner.scanUnheldTurns();
    await eventually(async () => (await rows(w2.app, 'ExecutionLease', { turn_id: w1.turnId }))[0]?.host_boot_id
      === database.hostBootId, 30_000, '持有者退出后没有接管');
  } finally {
    fs.readFileSync = readFileSync;
    await w2?.close();
    await stopChild(child);
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('盲审 6：子对话手动压缩准入后本窗口不再服务它：维护 Turn 以失败收尾，命令报不合格，不留下没有窗口执行的维护 Turn', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('child-compression');
  let host;
  try {
    const conversationId = 'conversation-child-compression';
    const provider = routedProvider((request, n) => request.conversationId === conversationId
      ? [SPAWN_CHILD, text('子任务已开始。'), text('父对话收到子 Agent 的结果。')][n - 1]
      : [text('子任务完成。')][n - 1]);
    host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO], label: 'w', children: true });
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    await host.runner.input({ commandId: 'child-compression', conversationId, text: '派一个子 Agent' });
    const execution = await eventuallyValue(async () => {
      const [row] = await rows(host.app, 'ChildExecution', {});
      if (!row || (await rows(host.app, 'ChildExecutionActiveTurnLink', { child_execution_id: row.id })).length > 0) return undefined;
      const turns = await rows(host.app, 'Turn', { conversation_id: row.child_conversation_id });
      return turns.length > 0 && turns.every((turn) => turn.status === 'terminated') ? row : undefined;
    }, 60_000, '子 Agent 没有完成');
    await host.coordinator.waitForIdle();
    await host.runner.waitForIdle();
    const childConversationId = execution.child_conversation_id;
    const callsBefore = provider.callsFor(childConversationId);

    // Admitted here; the folder leaves before the child scheduler drives the maintenance Turn.
    const admit = host.runner.admitManualCompression.bind(host.runner);
    let admitted;
    host.runner.admitManualCompression = async (input) => {
      admitted = await admit(input);
      host.folders.splice(host.folders.indexOf(PROJECT_TWO), 1);
      return admitted;
    };
    await assert.rejects(
      host.app.database.conversationOwners.run(childConversationId, () => host.coordinator.manualCompressionFromConversation({
        commandId: 'child-compress', childExecutionId: execution.id, conversationId: childConversationId, compressSegmentCount: 1
      })),
      (error) => isConversationHostIneligibleError(error)
    );
    assert.equal(admitted?.admitted, true, '准入时本窗口服务子对话');
    assert.equal((await rows(host.app, 'Turn', { id: admitted.turnId }))[0]?.status, 'terminated', '维护 Turn 已收尾');
    const [termination] = await rows(host.app, 'TurnTermination', { turn_id: admitted.turnId });
    assert.deepEqual([termination?.terminal_status, termination?.reason], ['failed', 'manual_context_compression_not_served_here']);
    assert.deepEqual(await rows(host.app, 'ExecutionLease', { turn_id: admitted.turnId }), []);
    assert.deepEqual(await rows(host.app, 'ChildExecutionActiveTurnLink', { child_execution_id: execution.id }), [], '子执行不再指向维护 Turn');
    assert.equal(provider.callsFor(childConversationId), callsBefore, '没有发出压缩请求');
  } finally {
    await host?.close();
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

test('盲审 7：空闲对话只等协作消息的续跑时，宿主资格与新输入的入口判定是同一个：项目在本窗口打开但下一个 Turn 的工作环境只在别的窗口可用时不合格，反之合格', { timeout: 60_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('collaboration');
  let host;
  try {
    const conversationId = 'conversation-collaboration';
    host = await openHost(dataRoot, scriptedProvider([]), { folders: [PROJECT_TWO], label: 'w' });
    await createConversation(host.app, conversationId, PROJECT_TWO_FOLDER);
    await pendingCollaborationDelivery(host.app, 'peer-message', conversationId);
    const decide = async (folders, preview) => {
      const dependencies = {
        database: host.app.database,
        contentStore: host.app.contentStore,
        workspaceFolderUris: () => folders,
        workEnvironments: async () => [],
        nextTurnWorkEnvironment: async () => preview
      };
      return {
        host: await evaluateConversationHostEligibility(dependencies, conversationId),
        entry: await evaluateConversationEntryEligibility(dependencies, conversationId)
      };
    };
    const elsewhere = await decide([PROJECT_TWO], { workEnvironmentId: 'work-env-remote', error: '所选工作环境只在别的窗口可用' });
    assert.deepEqual(elsewhere.host, elsewhere.entry, '续跑放置与入口同一判定');
    assert.equal(elsewhere.host.eligible, false, '项目打开但续跑的 Turn 在这里开不了：不认领');
    const here = await decide([PROJECT_ONE], {
      workEnvironmentId: 'work-env-here',
      policy: { id: null, enabled: false, allowedWorkEnvironmentIds: ['work-env-here'], defaultWorkEnvironmentId: 'work-env-here' }
    });
    assert.deepEqual(here.host, here.entry);
    assert.equal(here.host.eligible, true, '项目没打开但续跑的 Turn 在这里能开始：认领');
    const unknown = await decide([PROJECT_ONE], undefined);
    assert.deepEqual(unknown.host, unknown.entry, '没有预览时同样按项目是否打开判定');
  } finally {
    await host?.close();
    await fsp.rm(outer, { recursive: true, force: true });
  }
});

}

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
      folders: [PROJECT_TWO], label: 'w1', askUser: true, leaseDurationMs: 6_000
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

/** A Provider answering each Conversation from its own script: `route(request, nth call of that Conversation)`. */
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

/** An MCP server that answers once released. */
function gatedMcp() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  return {
    started,
    release: () => release(),
    async answer() {
      markStarted();
      await gate;
      return { content: [{ type: 'text', text: '外部调用结果' }] };
    }
  };
}

/**
 * A native call this Host still runs for the Turn (an admitted async call spanning rounds), as
 * ReliableAgentLoop.dispatchNativeCall tracks it: settled, it leaves the bookkeeping.
 */
function inFlightNativeCall(agentLoop, turnId, toolCallId = `in-flight-${turnId}`) {
  let settle;
  const execution = new Promise((resolve) => { settle = resolve; });
  agentLoop.nativeCallExecutions.set(toolCallId, execution);
  agentLoop.nativeCallTurnIds.set(toolCallId, turnId);
  void execution.then(() => {
    agentLoop.nativeCallExecutions.delete(toolCallId);
    agentLoop.nativeCallTurnIds.delete(toolCallId);
  });
  assert.equal(agentLoop.hasNativeCalls(turnId), true);
  return { settle: () => settle({ settled: true }) };
}

/** The child Agent asked the user and its drive returned: the child Turn waits. */
async function waitForChildQuestion(host) {
  await eventually(async () => (await rows(host.app, 'InteractionRequest', { status: 'pending' })).length === 1, 60_000, '子 Agent 没有提问');
  const [execution] = await rows(host.app, 'ChildExecution', {});
  const [link] = await rows(host.app, 'ChildExecutionActiveTurnLink', { child_execution_id: execution.id });
  await host.coordinator.waitForIdle();
  await host.runner.waitForIdle();
  return { execution, childTurnId: link.turn_id };
}

/** VscodeReliableKernelCommandRouter.handleInteractionResolve records the answer under ownership. */
async function answerAskUser(host, conversationId, requestId, key) {
  await host.app.database.conversationOwners.run(conversationId, () => host.app.interactions.resolveAskUser({
    source: { kind: 'command', key },
    requestId,
    response: { answer: { selectedOptionIndexes: [0], customText: '' } },
    cancelled: false
  }));
}

/** A peer's collaboration message waiting to start the idle Conversation's next Turn. */
async function pendingCollaborationDelivery(app, id, conversationId) {
  const repo = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);
  const now = new Date().toISOString();
  await app.database.transaction([
    repo('RuntimeInboxItem').insert({ id: `inbox-${id}`, dedupe_key: `fixture:${id}`, source_kind: 'collaboration_message',
      source_id: `message-${id}`, state: 'routed', created_at: now, updated_at: now }),
    repo('RuntimeDelivery').insert({ id: `delivery-${id}`, inbox_item_id: `inbox-${id}`, target_conversation_id: conversationId,
      target_turn_id: null, phase: 'next_turn', attempt_seq: 1n, retry_of_delivery_id: null, state: 'pending',
      failure_reason: null, created_at: now, updated_at: now })
  ]);
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
  const outer = await fsp.mkdtemp(path.join(os.tmpdir(), `limcode-blind-review-${label}-`));
  await fsp.mkdir(path.join(outer, 'control'), { recursive: true });
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

/** Fails when the operation does not finish in time (it waited for something it must not wait for). */
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
