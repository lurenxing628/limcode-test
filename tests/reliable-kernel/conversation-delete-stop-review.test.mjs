import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 删除规则：审查修复（conversationDeleteCommand 与 ConversationDeletionControlPlane）。
// 停止不依赖对话归属（后台进程、排队消息跨窗口也能停/取消），排队消息先取消再停 Turn；
// 只删子对话时父 Turn 只在模型请求中才等，否则把“子任务对话已被用户删除”作为运行时输入交给它；
// 父 Turn 的停止请求与子树中断同轮写入；等待另一个窗口时有进度提示，文案区分原因；盘点只读删除范围。
const root = process.cwd();
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const load = (relative) => import(pathToFileURL(path.join(root, 'dist/extension', relative)).href);
const kernel = await load('backend/reliableKernel/index.js');
const { ReliableConversationRunner } = await load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { ReliableChildAgentCoordinator } = await load('backend/reliableKernel/childAgentCoordinator.js');
const { createRuntimeDeliveryWakeHandler } = await load('backend/application/reliableKernel/runtimeDeliveryWakeHandler.js');
const { evaluateConversationHostEligibility } = await load('backend/application/reliableKernel/conversationHostEligibility.js');
const { projectFolderAssignmentSteps } = await load('backend/reliableKernel/conversationProject.js');
const { preparedContentObjectSteps } = await load('backend/reliableKernel/contentObjectTransaction.js');
const { ConversationOwnershipGate } = await load('backend/reliableKernel/conversationOwnershipGate.js');
const { DEAD_HOST_STOP_REASON } = await load('backend/reliableKernel/phaseDRecovery.js');
const { askUserTool } = await load('backend/world/modules/tools/definitions/askUser/index.js');
const { runAgentTool } = await load('backend/world/modules/tools/definitions/runAgent/index.js');
const {
  stopAndDeleteConversation,
  isConversationDeleteIncompleteError
} = await load('backend/application/reliableKernel/conversationDeleteCommand.js');
const { CHILD_CONVERSATION_DELETED_NOTICE } = await load('backend/reliableKernel/deliverySettlementSteps.js');
const { createWebviewSsrServer } = await import(pathToFileURL(path.join(root, 'tests/reliable-kernel/webview-ssr-server.mjs')).href);
const clientFeedModule = await import(pathToFileURL(path.join(root, 'dist/extension/shared/reliableKernelClientFeed.js')).href);

const PROVIDER_ID = 'delete-stop-provider';
const PROJECT = { uri: 'file:///workspace/delete-stop', name: '删除项目' };
const OTHER_PROJECT = 'file:///workspace/other';
const TEST_FILE = fileURLToPath(import.meta.url);
const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);

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

/** The process tool as the dispatcher routes it (PROCESS_TOOLS); execution goes through ProcessControlPlane. */
const bashTool = {
  execution: 'runtime',
  declaration: {
    name: 'bash',
    description: 'Runs a command.',
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
    metadata: { category: 'terminal', scope: 'general', riskLevel: 'write', readonly: false, defaultEnabled: true }
  },
  async execute() { throw new Error('Process execution must use the reliable ProcessControlPlane.'); }
};


// 跨窗口的用例用真实的第二个进程（本文件以 LIMCODE_DELETE_STOP_WORKER 启动的 worker）。
const workerMode = process.env.LIMCODE_DELETE_STOP_WORKER;
if (workerMode) {
  runWorker(workerMode).then(
    () => process.exit(0),
    (error) => {
      console.error(error?.stack ?? error);
      process.exit(1);
    }
  );
} else {

/** 父 Turn 先后台派子 Agent，再调用 ask_user 等用户；子 Agent 等父的提问出现后才给出最终答复。 */
async function parentAsksWhileChildAnswers(label, options = {}) {
  const { outer, dataRoot } = await createIsolatedRoot(label);
  let parentRound = 0;
  let parentAsked = false;
  const requests = [];
  const provider = scriptedProvider(async (request) => {
    if (request.conversationId === 'parent') {
      requests.push(request);
      parentRound += 1;
      if (parentRound === 1) return spawnCall('spawn-bg', 'child', '子任务', 0);
      if (parentRound === 2) {
        parentAsked = true;
        return askCall('ask-parent', '要继续吗？');
      }
      return { role: 'model', parts: [{ text: `PARENT_ROUND_${parentRound}` }] };
    }
    const deadline = Date.now() + 30_000;
    while (!parentAsked && Date.now() < deadline) await sleep(20);
    await sleep(300);
    return { role: 'model', parts: [{ text: 'CHILD_ANSWER_R1' }] };
  });
  const p1 = await openHost(dataRoot, provider, { label: 'p1', wake: options.wake ?? true });
  await createConversation(p1.app, 'parent');
  const { turnId } = await p1.runner.input({ commandId: 'input-parent', conversationId: 'parent', text: '派后台子 Agent，然后问我' });
  await eventually(async () => (await rows(p1.app, 'InteractionRequest', { status: 'pending' })).length === 1, 60_000, '父 Turn 的提问未进入等待');
  const answer = await eventually(async () => {
    const pending = await rows(p1.app, 'RuntimeDelivery', { target_conversation_id: 'parent', state: 'pending' });
    return pending.find((row) => row.target_turn_id === turnId);
  }, 60_000, '子 Agent 的答复没有作为 current_turn 投给正在运行的父 Turn');
  const [execution] = await rows(p1.app, 'ChildExecution', {});
  return { outer, dataRoot, p1, provider, requests, parentTurnId: turnId, answer, childConversationId: String(execution.child_conversation_id) };
}

test('高-3：只删子对话，父 Turn 在等提问、子 Agent 的答复已投给它 → 不等父 Turn，删除立即完成；父 Turn 以运行时输入收到删除通知、看不到已删子任务的答复，回答后继续完成', { timeout: 180_000 }, async () => {
  const setup = await parentAsksWhileChildAnswers('r1');
  const { p1, outer, dataRoot } = setup;
  try {
    const [childConversation] = await rows(p1.app, 'Conversation', { id: setup.childConversationId });
    const progress = [];
    const started = Date.now();
    const deleted = await deleteCommand(p1, setup.childConversationId, { timeoutMs: 30_000, onProgress: (entry) => progress.push(entry.kind) });
    assert.deepEqual(deleted.deletedConversationIds, [setup.childConversationId]);
    assert.ok(Date.now() - started < 10_000, '不等父 Turn 到请求边界');
    assert.equal(progress.includes('waiting_parent'), false, '父 Turn 不在模型请求中，不等它');
    const [delivery] = await rows(p1.app, 'RuntimeDelivery', { id: setup.answer.id });
    assert.equal(delivery.state, 'consumed', '这条答复换成删除通知交给了父 Turn');
    const inputs = await rows(p1.app, 'PendingTurnInput', { turn_id: setup.parentTurnId, input_kind: 'runtime_delivery', state: 'pending' });
    assert.equal(inputs.length, 1, '父 Turn 有一条待接收的运行时输入');
    const [request] = await rows(p1.app, 'InteractionRequest', { status: 'pending' });
    await answerAskUser(p1, 'parent', request.id, 'answer-parent');
    p1.runner.resume('parent', setup.parentTurnId);
    await eventually(async () => (await rows(p1.app, 'Turn', { id: setup.parentTurnId }))[0]?.status === 'terminated', 30_000, '父 Turn 没有继续到结束');
    const [termination] = await rows(p1.app, 'TurnTermination', { turn_id: setup.parentTurnId });
    assert.equal(termination.terminal_status, 'completed', `父 Turn 继续并完成：${termination.reason}`);
    const context = setup.requests.at(-1).context;
    const notice = context.find((item) => item.segmentKind === 'runtime_context' && item.content.includes(CHILD_CONVERSATION_DELETED_NOTICE));
    assert.ok(notice, '父 Turn 的下一次模型请求带着删除通知');
    const projected = JSON.parse(notice.content);
    assert.equal(projected.kind, 'child_failure');
    assert.equal(projected.status, 'failed');
    assert.equal(projected.content, CHILD_CONVERSATION_DELETED_NOTICE);
    assert.equal(projected.title, childConversation.title, '通知用子任务对话的标题称呼它');
    assert.equal(JSON.stringify(context).includes('CHILD_ANSWER_R1'), false, '看不到已删子任务的答复（包括由答复生成的标题）');
    await p1.runner.waitForIdle();
    // 父对话的界面投影照常生成：删除通知的输入、已删子任务留下的收件项都不让它出错。
    const feed = new kernel.BoundedClientFeed(p1.app.database);
    const frames = [];
    await feed.connect({ activeConversationId: 'parent', send(frame) { frames.push(frame); } });
    try {
      await eventually(async () => frames.length > 0, 10_000, '界面投影没有生成快照');
      assert.equal(frames[0].type, 'reliable-kernel.snapshot');
      const applied = clientFeedModule.applyReliableKernelDataMessage(clientFeedModule.createEmptyReliableKernelClientState(), frames[0]);
      assert.equal(applied.snapshotRequired, false, applied.reason);
    } finally {
      feed.close();
    }
    await assertNoPendingResults(p1.app);
    assert.deepEqual(errors(p1), []);
  } finally {
    await p1.close();
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

test('高-3 竞态：父 Turn 正在请求边界接收子 Agent 的答复时子对话被删除 → 父 Turn 跳过已收尾的答复、接收删除通知，照常完成', { timeout: 180_000 }, async () => {
  const setup = await parentAsksWhileChildAnswers('r1-race');
  const { p1, outer, dataRoot } = setup;
  const deliveries = p1.app.agentLoop.runtimeDeliveries;
  const router = deliveries.automaticDeliveryRouter;
  const deliverySourceTurn = router.deliverySourceTurn;
  let deleted;
  try {
    // 固定竞态窗口：父 Turn 已读到这条答复仍待接收、正在推进它时，删除事务提交。
    router.deliverySourceTurn = async (inboxItemId) => {
      if (!deleted && inboxItemId === setup.answer.inbox_item_id) {
        deleted = await deleteCommand(p1, setup.childConversationId, { timeoutMs: 30_000 });
      }
      return deliverySourceTurn.call(router, inboxItemId);
    };
    const [request] = await rows(p1.app, 'InteractionRequest', { status: 'pending' });
    await answerAskUser(p1, 'parent', request.id, 'answer-parent');
    p1.runner.resume('parent', setup.parentTurnId);
    await eventually(async () => (await rows(p1.app, 'Turn', { id: setup.parentTurnId }))[0]?.status === 'terminated', 30_000, '父 Turn 没有继续到结束');
    assert.deepEqual(deleted?.deletedConversationIds, [setup.childConversationId], '删除恰好在父 Turn 接收这条答复时完成');
    const [termination] = await rows(p1.app, 'TurnTermination', { turn_id: setup.parentTurnId });
    assert.equal(termination.terminal_status, 'completed', `父 Turn 继续并完成：${termination.reason}`);
    const body = JSON.stringify(setup.requests.at(-1).context);
    assert.ok(body.includes(CHILD_CONVERSATION_DELETED_NOTICE), '父 Turn 接收了删除通知');
    assert.equal(body.includes('CHILD_ANSWER_R1'), false, '看不到已删子任务的答复');
    await p1.runner.waitForIdle();
    await assertNoPendingResults(p1.app);
    assert.deepEqual(errors(p1), []);
  } finally {
    router.deliverySourceTurn = deliverySourceTurn;
    await p1.close();
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

test('高-3：只删子对话，父 Turn 正在发模型请求、子 Agent 的答复已投给它 → 删除等它的请求结束（进度写明在等父对话），之后完成', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('r1b');
  let parentRound = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let parentWaiting = false;
  const provider = scriptedProvider(async (request) => {
    if (request.conversationId === 'parent') {
      parentRound += 1;
      if (parentRound === 1) return spawnCall('spawn-bg', 'child', '子任务', 0);
      if (parentRound === 2) {
        parentWaiting = true;
        await gate;
      }
      return { role: 'model', parts: [{ text: `PARENT_ROUND_${parentRound}` }] };
    }
    const deadline = Date.now() + 30_000;
    while (!parentWaiting && Date.now() < deadline) await sleep(20);
    return { role: 'model', parts: [{ text: 'CHILD_ANSWER_R1B' }] };
  });
  const p1 = await openHost(dataRoot, provider, { label: 'p1', wake: true });
  try {
    await createConversation(p1.app, 'parent');
    const { turnId } = await p1.runner.input({ commandId: 'input-parent', conversationId: 'parent', text: '派后台子 Agent' });
    await eventually(async () => (await rows(p1.app, 'RuntimeDelivery', { target_conversation_id: 'parent', state: 'pending' }))
      .some((row) => row.target_turn_id === turnId), 60_000, '子 Agent 的答复没有投给正在发请求的父 Turn');
    const [execution] = await rows(p1.app, 'ChildExecution', {});
    const childConversationId = String(execution.child_conversation_id);
    const progress = [];
    const deleting = deleteCommand(p1, childConversationId, { timeoutMs: 60_000, onProgress: (entry) => progress.push(entry) });
    await eventually(async () => progress.some((entry) => entry.kind === 'waiting_parent'), 10_000, '没有提示在等父对话');
    assert.match(progress.find((entry) => entry.kind === 'waiting_parent').message, /父对话「parent」正在等模型回复/);
    assert.equal((await rows(p1.app, 'Conversation', { id: childConversationId })).length, 1, '父 Turn 的请求结束前不删');
    release();
    const deleted = await deleting;
    assert.deepEqual(deleted.deletedConversationIds, [childConversationId]);
    await eventually(async () => (await rows(p1.app, 'Turn', { id: turnId }))[0]?.status === 'terminated', 30_000, '父 Turn 未结束');
    assert.equal((await rows(p1.app, 'TurnTermination', { turn_id: turnId }))[0]?.terminal_status, 'completed');
    await quiet(p1, 1_000);
    await assertNoPendingResults(p1.app);
    assert.deepEqual(errors(p1), []);
  } finally {
    release();
    await p1.close();
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

test('高-3 对照：删除整棵树，父 Turn 在等提问、后台子 Agent 的答复已投给父 Turn → 先停再删，不再调用模型', { timeout: 180_000 }, async () => {
  const setup = await parentAsksWhileChildAnswers('r4');
  const { p1, provider, outer, dataRoot } = setup;
  try {
    const before = provider.calls.length;
    const deleted = await deleteCommand(p1, 'parent', { pollMs: 250 });
    await quiet(p1, 1_500);
    assert.deepEqual([...deleted.deletedConversationIds].sort(), ['parent', setup.childConversationId].sort());
    assert.equal(provider.calls.length, before, '删除期间不再调用模型');
    await assertNoPendingResults(p1.app);
    assert.deepEqual(errors(p1), []);
  } finally {
    await p1.close();
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

test('中-1：删除整棵树，子 Agent 恰好在父 Turn 停下时正常完成 → 子树与父 Turn 的停止请求同轮写入，父对话不开续跑、不再调用模型', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('r6');
  let host;
  let parentTurnId;
  let parentRound = 0;
  const provider = scriptedProvider(async (request) => {
    if (request.conversationId === 'parent') {
      parentRound += 1;
      if (parentRound === 1) return spawnCall('spawn-bg', 'child', '子任务', 0);
      if (parentRound === 2) return askCall('ask-parent', '要继续吗？');
      return { role: 'model', parts: [{ text: `PARENT_ROUND_${parentRound}` }] };
    }
    // 子 Agent 一直“思考”，直到父 Turn 收到停止请求或停下，然后立即正常给出最终答复。
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const [turn] = parentTurnId ? await rows(host.app, 'Turn', { id: parentTurnId }) : [];
      const requested = parentTurnId ? await rows(host.app, 'PendingTurnInput', { turn_id: parentTurnId, input_kind: 'interrupt_request' }) : [];
      if (turn?.status === 'terminated' || requested.length > 0) break;
      await sleep(10);
    }
    return { role: 'model', parts: [{ text: 'CHILD_FINISHED_NORMALLY' }] };
  });
  host = await openHost(dataRoot, provider, { label: 'p1', wake: true });
  try {
    await createConversation(host.app, 'parent');
    ({ turnId: parentTurnId } = await host.runner.input({ commandId: 'input-parent', conversationId: 'parent', text: '派后台子 Agent，然后问我' }));
    await eventually(async () => (await rows(host.app, 'InteractionRequest', { status: 'pending' })).length === 1, 60_000, '父 Turn 的提问未进入等待');
    await eventually(async () => provider.calls.some((call) => call.conversationId !== 'parent'), 60_000, '子 Agent 未开始');
    const parentCallsBefore = provider.calls.filter((call) => call.conversationId === 'parent').length;
    const deleted = await deleteCommand(host, 'parent', { pollMs: 250 });
    await quiet(host, 1_500);
    assert.equal(deleted.deletedConversationIds.includes('parent'), true);
    const parentCallsAfter = provider.calls.filter((call) => call.conversationId === 'parent').length;
    assert.equal(parentCallsAfter, parentCallsBefore, '删除期间父对话不再调用模型');
    await assertNoPendingResults(host.app);
    assert.deepEqual(errors(host), []);
  } finally {
    await host.close();
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

test('中-1：父 Turn 前台等子 Agent 时删除整棵树 → 父 Turn 的停止请求先于子树中断写入，子树中断结束父的等待后父 Turn 直接停下，不再调用模型（执行停止被推迟也一样）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('order');
  let parentRound = 0;
  const provider = scriptedProvider((request) => {
    if (request.conversationId === 'parent') {
      parentRound += 1;
      return parentRound === 1 ? spawnCall('spawn-fg', 'child', '子任务', 600_000) : { role: 'model', parts: [{ text: `PARENT_ROUND_${parentRound}` }] };
    }
    return 'hang';
  });
  const host = await openHost(dataRoot, provider, { label: 'p1' });
  try {
    await createConversation(host.app, 'parent');
    await host.runner.input({ commandId: 'input-parent', conversationId: 'parent', text: '派子 Agent 并等它' });
    await eventually(async () => provider.calls.some((call) => call.conversationId !== 'parent'), 60_000, '子 Agent 未开始');
    const parentCallsBefore = provider.calls.filter((call) => call.conversationId === 'parent').length;
    // 执行停止推迟 1 秒：父 Turn 能不能停，只看子树中断之前是否已有它的持久停止请求。
    const delayedRunner = { interrupt: async (input) => { await sleep(1_000); return host.runner.interrupt(input); } };
    const deleted = await stopAndDeleteConversation({
      application: host.app, conversations: delayedRunner, childAgents: host.coordinator, pollMs: 100, timeoutMs: 30_000
    }, { conversationId: 'parent', requestId: 'delete-order' });
    assert.equal(deleted.deletedConversationIds.includes('parent'), true);
    await quiet(host, 1_000);
    assert.equal(provider.calls.filter((call) => call.conversationId === 'parent').length, parentCallsBefore, '父 Turn 的等待结束后没有再调用模型');
    await assertNoPendingResults(host.app);
    assert.deepEqual(errors(host), []);
  } finally {
    await host.close();
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

test('低-4：只删子对话，父 Turn 拿到删除结果后向同一子 Agent 续派 → 续派开出的新 Turn 也会被停下，删除完成', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('r7');
  let host;
  let parentRound = 0;
  const provider = scriptedProvider(async (request) => {
    if (request.conversationId === 'parent') {
      parentRound += 1;
      if (parentRound === 1) return spawnCall('spawn-fg', 'child', '子任务', 600_000);
      if (parentRound === 2) {
        // 模型只见得到子 Agent 的短引用（modelHandleCatalog），续派用它。
        const ref = request.recipe?.modelHandleCatalog?.entries?.find((entry) => entry.kind === 'child')?.ref;
        if (!ref) return { role: 'model', parts: [{ text: 'CHILD_GONE' }] };
        return { role: 'model', parts: [{ id: 'send-again', functionCall: { name: 'run_agent', args: {
          operation: 'send', childRef: ref, prompt: '再试一次', foregroundWaitMs: 600_000 } } }] };
      }
      return { role: 'model', parts: [{ text: `PARENT_ROUND_${parentRound}` }] };
    }
    return 'hang';
  });
  host = await openHost(dataRoot, provider, { label: 'p1' });
  try {
    await createConversation(host.app, 'parent');
    await host.runner.input({ commandId: 'input-parent', conversationId: 'parent', text: '派子 Agent 并等它' });
    await eventually(async () => provider.calls.some((call) => call.conversationId !== 'parent'), 60_000, '子 Agent 未开始');
    const [execution] = await rows(host.app, 'ChildExecution', {});
    const childConversationId = String(execution.child_conversation_id);
    const childCalls = () => provider.calls.filter((call) => call.conversationId === childConversationId).length;
    // 第二次盘点等到父 Turn 拿到删除结果、向同一子 Agent 续派并开出新 Turn 之后：这个新 Turn 只有新的中断才停得下。
    const deletion = host.app.conversationDeletion;
    const inspect = deletion.inspect;
    let inspections = 0;
    deletion.inspect = async (id) => {
      inspections += 1;
      if (inspections === 2) await eventually(async () => childCalls() >= 2, 30_000, '续派没有开出新 Turn');
      return inspect.call(deletion, id);
    };
    let deleted;
    try {
      deleted = await deleteCommand(host, childConversationId, { timeoutMs: 30_000, pollMs: 250 });
    } finally {
      deletion.inspect = inspect;
    }
    assert.deepEqual(deleted.deletedConversationIds, [childConversationId]);
    assert.equal(childCalls(), 2, '续派确实开出了第二个子 Turn，删除把它也停下了');
    await quiet(host, 1_000);
    assert.equal((await rows(host.app, 'Turn', { conversation_id: childConversationId })).length, 0);
    assert.equal((await rows(host.app, 'Turn', { status: 'active' })).length, 0, '父 Turn 拿到第二次删除结果后结束');
    await assertNoPendingResults(host.app);
    assert.deepEqual(errors(host), []);
  } finally {
    await host.close();
  }
  await fs.rm(outer, { recursive: true, force: true });
});

test('低-5：子调度的答复扫描进行中、其中一个子 Agent 随对话被删除 → 扫描跳过它、继续处理其它子 Agent，不报答复记录不存在', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('r8');
  let parentRound = 0;
  const provider = scriptedProvider((request) => {
    if (request.conversationId === 'parent') {
      parentRound += 1;
      if (parentRound === 1) return spawnCall('spawn-a', 'child-a', '子任务 A', 0);
      if (parentRound === 2) return spawnCall('spawn-b', 'child-b', '子任务 B', 0);
      return { role: 'model', parts: [{ text: `PARENT_ROUND_${parentRound}` }] };
    }
    return { role: 'model', parts: [{ text: `ANSWER_${request.conversationId}` }] };
  });
  const host = await openHost(dataRoot, provider, { label: 'p1' });
  const answers = host.app.runtime.answers;
  const original = answers.classifyDeliveryRecovery.bind(answers);
  let releaseClassify;
  const classifyReleased = new Promise((resolve) => { releaseClassify = resolve; });
  try {
    await createConversation(host.app, 'parent');
    await host.runner.input({ commandId: 'input-parent', conversationId: 'parent', text: '派两个后台子 Agent' });
    await eventually(async () => (await rows(host.app, 'AnswerBridge', {})).filter((bridge) => bridge.current_submission_id !== null).length === 2,
      60_000, '两个子 Agent 没有都给出答复');
    await host.runner.waitForIdle();
    const executions = await rows(host.app, 'ChildExecution', {});
    const bridges = await rows(host.app, 'AnswerBridge', {});
    const classified = [];
    let blocked;
    let reachedClassify;
    const classifyReached = new Promise((resolve) => { reachedClassify = resolve; });
    // 固定竞态窗口：扫描已读到两个子 Agent 的答复，正在处理第一个时，它的对话被删除。
    answers.classifyDeliveryRecovery = async (submissionId) => {
      classified.push(submissionId);
      if (!blocked) {
        blocked = submissionId;
        reachedClassify();
        await classifyReleased;
      }
      return original(submissionId);
    };
    const gate = new ConversationOwnershipGate(host.app.database, 'claim');
    const scan = host.coordinator.reconcileCommittedAnswers(executions.map((row) => String(row.id)), undefined, gate)
      .then(() => 'resolved', (error) => error)
      .finally(() => gate.releaseClaimed());
    await classifyReached;
    const bridge = bridges.find((row) => row.current_submission_id === blocked);
    const deletedExecution = executions.find((row) => row.id === bridge.child_execution_id);
    const deleted = await deleteCommand(host, String(deletedExecution.child_conversation_id), { timeoutMs: 30_000 });
    assert.deepEqual(deleted.deletedConversationIds, [String(deletedExecution.child_conversation_id)]);
    releaseClassify();
    const outcome = await Promise.race([scan, sleep(20_000).then(() => 'timeout')]);
    assert.equal(outcome instanceof Error ? outcome.message : outcome, 'resolved', '扫描不因删除而失败');
    const other = bridges.find((row) => row.current_submission_id !== blocked);
    assert.ok(classified.includes(other.current_submission_id), '扫描继续处理了另一个子 Agent 的答复');
  } finally {
    answers.classifyDeliveryRecovery = original;
    releaseClassify();
    await host.close();
  }
  await fs.rm(outer, { recursive: true, force: true });
});

test('低-6：删除等待期间的盘点只读删除范围，不整表读取对话、Turn 与子执行', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('r9');
  const host = await openHost(dataRoot, scriptedProvider(() => ({ role: 'model', parts: [{ text: 'x' }] })), { label: 'p1' });
  try {
    const now = new Date().toISOString();
    const steps = [];
    for (let index = 0; index < 50; index += 1) {
      const id = `bulk-${String(index).padStart(4, '0')}`;
      steps.push(repo('Conversation').insert({ id, title: id, status: 'active', created_at: now, updated_at: now }));
    }
    await host.app.database.transaction(steps);
    await createConversation(host.app, 'target');
    const reads = [];
    const database = host.app.database;
    const snapshotAll = database.snapshotAll.bind(database);
    const snapshot = database.snapshot.bind(database);
    database.snapshotAll = (read, ...rest) => { reads.push(read); return snapshotAll(read, ...rest); };
    database.snapshot = (list, ...rest) => { reads.push(...list); return snapshot(list, ...rest); };
    try {
      assert.equal((await host.app.conversationDeletion.inspect('target')).work.length, 0);
    } finally {
      database.snapshotAll = snapshotAll;
      database.snapshot = snapshot;
    }
    const scoped = new Set(['Conversation', 'Turn', 'ChildExecution', 'ConversationOriginLink', 'ExecutionLease', 'ChildExecutionActiveTurnLink']);
    const unfiltered = reads.filter((read) => read.kind === 'list' && scoped.has(read.domain) && Object.keys(read.where ?? {}).length === 0);
    assert.deepEqual(unfiltered.map((read) => read.domain), [], '盘点不整表读取');
  } finally {
    await host.close();
  }
  await fs.rm(outer, { recursive: true, force: true });
});

test('高-1：后台进程属于另一个存活窗口（它一直持有对话）→ 本窗口删除直接写进程的停止请求，进程被终止，删除成功（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('r2');
  let child;
  let p1;
  let ready;
  try {
    const files = workerFiles(outer);
    const marker = path.join(outer, 'provider-calls.log');
    child = spawnWorker(dataRoot, { ...files.env, DELETE_STOP_CWD: outer, DELETE_STOP_MARKER: marker }, 'process-owner');
    ready = await waitForWorkerJson(child, files.ready, 90_000);
    assert.equal(ready.ownsConversation, true, '执行窗口因进程在跑一直持有对话');
    p1 = await openHost(dataRoot, scriptedProvider(() => { throw new Error('本窗口不应调用模型'); }), { label: 'p1', folders: [OTHER_PROJECT] });
    const deleted = await deleteCommand(p1, 'with-process', { timeoutMs: 30_000 });
    assert.deepEqual(deleted.deletedConversationIds, ['with-process']);
    await eventually(async () => !alive(ready.pid), 10_000, '进程仍在运行');
    const [processRow] = await rows(p1.app, 'Process', { id: ready.processId });
    assert.notEqual(processRow.status, 'running');
    // The window that owns the Conversation may open one Turn for the stopped process's end before
    // it releases the Conversation; the deletion stops that Turn too (see conversationDeleteCommand).
    const calls = (await fs.readFile(marker, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    assert.ok(calls.length <= 3, `执行窗口最多为进程的结束开一次续跑：\n${calls.join('\n')}`);
    await assertNoPendingResults(p1.app);
    assert.deepEqual(errors(p1), []);
    await fs.writeFile(files.finish, 'finish\n', 'utf8');
    await waitForExit(child, 90_000, true);
  } finally {
    if (ready?.pid && alive(ready.pid)) { try { process.kill(ready.pid, 'SIGKILL'); } catch { /* gone */ } }
    if (ready?.wrapperPid && alive(ready.wrapperPid)) { try { process.kill(ready.wrapperPid, 'SIGKILL'); } catch { /* gone */ } }
    await p1?.close();
    await stopChild(child);
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

test('高-1 同窗口：删除空闲对话里的后台进程，按生产轮询间隔也不为进程的结束开续跑、不再调用模型', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('process-idle');
  const command = `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`;
  let round = 0;
  const provider = scriptedProvider(() => {
    round += 1;
    if (round === 1) return { role: 'model', parts: [{ id: 'bash-1', functionCall: { name: 'bash', args: {
      mode: 'execute', explanation: '后台运行', command, foregroundWaitMs: 0 } } }] };
    return { role: 'model', parts: [{ text: `第 ${round} 次回复` }] };
  });
  const p1 = await openHost(dataRoot, provider, { label: 'p1', wake: true, cwd: outer });
  try {
    await createConversation(p1.app, 'with-process');
    await p1.runner.input({ commandId: 'input-process', conversationId: 'with-process', text: '在后台跑一个进程' });
    await eventually(async () => (await rows(p1.app, 'Turn', { conversation_id: 'with-process', status: 'terminated' })).length === 1,
      30_000, '启动进程的 Turn 未结束');
    await p1.runner.waitForIdle();
    const [processRow] = await rows(p1.app, 'Process', {});
    assert.equal(processRow?.status, 'running');
    const callsBefore = provider.calls.length;
    // 轮询间隔放宽到 1 秒：进程结束的通知有充裕时间开续跑，只有删除期间的标记能挡住它。
    const deleted = await deleteCommand(p1, 'with-process', { pollMs: 1_000 });
    assert.deepEqual(deleted.deletedConversationIds, ['with-process']);
    await quiet(p1, 1_500);
    assert.equal(provider.calls.length, callsBefore, '进程的结束没有开启新的回合');
    assert.equal(p1.app.conversationDeletion.isStopping('with-process'), false, '删除结束后标记释放');
    await assertNoPendingResults(p1.app);
    assert.deepEqual(errors(p1), []);
  } finally {
    await p1.close();
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

test('删除期间的标记只挡续跑：标记释放后，被挡住的进程结束通知照常开续跑', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('mark-release');
  const command = `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`;
  let round = 0;
  const provider = scriptedProvider(() => {
    round += 1;
    if (round === 1) return { role: 'model', parts: [{ id: 'bash-1', functionCall: { name: 'bash', args: {
      mode: 'execute', explanation: '后台运行', command, foregroundWaitMs: 0 } } }] };
    return { role: 'model', parts: [{ text: `第 ${round} 次回复` }] };
  });
  const p1 = await openHost(dataRoot, provider, { label: 'p1', wake: true, cwd: outer });
  try {
    await createConversation(p1.app, 'with-process');
    await p1.runner.input({ commandId: 'input-process', conversationId: 'with-process', text: '在后台跑一个进程' });
    await eventually(async () => (await rows(p1.app, 'Turn', { conversation_id: 'with-process', status: 'terminated' })).length === 1,
      30_000, '启动进程的 Turn 未结束');
    await p1.runner.waitForIdle();
    const [processRow] = await rows(p1.app, 'Process', {});
    const callsBefore = provider.calls.length;
    const release = p1.app.conversationDeletion.markStopping(['with-process']);
    const stopped = await p1.app.processes.stopOwnedProcess(processRow.id);
    if (stopped.receipt) await p1.app.processes.reconcileProcessExit(processRow.id);
    await eventually(async () => (await rows(p1.app, 'RuntimeDeliveryWake', {})).length === 1, 30_000, '进程结束的通知没有生成唤醒');
    await quiet(p1, 1_500);
    assert.equal(provider.calls.length, callsBefore, '标记期间不开续跑');
    const [wake] = await rows(p1.app, 'RuntimeDeliveryWake', {});
    assert.ok(['pending', 'claimed'].includes(wake.state), `唤醒留着待重试：${wake.state}`);
    release();
    await eventually(async () => provider.calls.length === callsBefore + 1, 60_000, '标记释放后进程结束的通知没有送达');
    await p1.runner.waitForIdle();
    assert.deepEqual(errors(p1), []);
  } finally {
    await p1.close();
  }
  await fs.rm(outer, { recursive: true, force: true });
});

test('中-2：只删子对话、父 Turn 的模型请求一直没结束 → 超时不删，说明在等父对话接收答复、不说发出了停止；标记随之释放', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('parent-timeout');
  let parentRound = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let parentWaiting = false;
  const provider = scriptedProvider(async (request) => {
    if (request.conversationId === 'parent') {
      parentRound += 1;
      if (parentRound === 1) return spawnCall('spawn-bg', 'child', '子任务', 0);
      if (parentRound === 2) {
        parentWaiting = true;
        await gate;
      }
      return { role: 'model', parts: [{ text: `PARENT_ROUND_${parentRound}` }] };
    }
    const deadline = Date.now() + 30_000;
    while (!parentWaiting && Date.now() < deadline) await sleep(20);
    return { role: 'model', parts: [{ text: 'CHILD_ANSWER_TIMEOUT' }] };
  });
  const p1 = await openHost(dataRoot, provider, { label: 'p1', wake: true });
  try {
    await createConversation(p1.app, 'parent');
    const { turnId } = await p1.runner.input({ commandId: 'input-parent', conversationId: 'parent', text: '派后台子 Agent' });
    await eventually(async () => (await rows(p1.app, 'RuntimeDelivery', { target_conversation_id: 'parent', state: 'pending' }))
      .some((row) => row.target_turn_id === turnId), 60_000, '子 Agent 的答复没有投给正在发请求的父 Turn');
    const [execution] = await rows(p1.app, 'ChildExecution', {});
    const childConversationId = String(execution.child_conversation_id);
    const error = await deleteCommand(p1, childConversationId, { timeoutMs: 1_000 }).then(() => null, (reason) => reason);
    assert.ok(isConversationDeleteIncompleteError(error), `预期没能完成：${error?.stack ?? error}`);
    assert.equal(error.message, '删除没有完成：父对话「parent」的模型回复还没结束，它要先接收子任务的答复。等它结束后再删除一次。');
    assert.deepEqual(error.remaining.map((item) => [item.kind, item.stopRequested]), [['parent_intake', false]]);
    assert.equal(p1.app.conversationDeletion.isStopping(childConversationId), false, '没完成也释放标记');
    assert.equal((await rows(p1.app, 'Conversation', { id: childConversationId })).length, 1, '没完成时不删');
    release();
    await eventually(async () => (await rows(p1.app, 'Turn', { id: turnId }))[0]?.status === 'terminated', 30_000, '父 Turn 未结束');
    const deleted = await deleteCommand(p1, childConversationId, { timeoutMs: 30_000 });
    assert.deepEqual(deleted.deletedConversationIds, [childConversationId]);
    await quiet(p1, 1_000);
    await assertNoPendingResults(p1.app);
    assert.deepEqual(errors(p1), []);
  } finally {
    release();
    await p1.close();
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

test('高-2：排队消息没能取消的那一轮不停 Turn；超时说明逐项写明“还没能发出停止请求”，不说已发出', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('queued-gate');
  let calls = 0;
  const provider = scriptedProvider(() => {
    calls += 1;
    return calls === 1 ? 'hang' : { role: 'model', parts: [{ text: `第 ${calls} 次回复` }] };
  });
  const p1 = await openHost(dataRoot, provider, { label: 'p1' });
  try {
    await createConversation(p1.app, 'queued');
    const first = await p1.runner.input({ commandId: 'input-first', conversationId: 'queued', text: '第一条消息' });
    await eventually(async () => calls === 1, 30_000, '第一条消息未调用模型');
    await p1.runner.input({ commandId: 'input-second', conversationId: 'queued', text: '排队的第二条消息' });
    assert.equal((await rows(p1.app, 'TurnIntent', { conversation_id: 'queued', state: 'queued' })).length, 1);
    const turns = p1.app.turns;
    const originalCancel = turns.cancelGuidanceForDeletion;
    const originalRequest = turns.requestExternalInterrupt;
    const stopRequests = [];
    // 取消没落地（例如这条消息刚被改过，修订号对不上）。
    turns.cancelGuidanceForDeletion = async () => { throw new Error('这条排队消息刚被改过'); };
    turns.requestExternalInterrupt = async (...args) => {
      stopRequests.push(args[1]?.turnId);
      return originalRequest.apply(turns, args);
    };
    let error;
    try {
      error = await deleteCommand(p1, 'queued', { timeoutMs: 1_000 }).then(() => null, (reason) => reason);
    } finally {
      turns.cancelGuidanceForDeletion = originalCancel;
      turns.requestExternalInterrupt = originalRequest;
    }
    assert.ok(isConversationDeleteIncompleteError(error), `预期没能完成：${error?.stack ?? error}`);
    assert.deepEqual(stopRequests, [], '排队消息取消落地之前不停 Turn');
    assert.equal((await rows(p1.app, 'Turn', { id: first.turnId }))[0].status, 'active');
    assert.ok(error.message.includes('对话「queued」还有排队的消息没能取消（还没能发出停止请求）'), error.message);
    assert.ok(error.message.includes('对话「queued」的回合正在本窗口执行（还没能发出停止请求）'), error.message);
    assert.ok(error.message.includes('停止对话「queued」里的任务时出错：这条排队消息刚被改过'), error.message);
    assert.equal(error.message.includes('停止请求已经发出'), false, error.message);
    assert.ok(error.message.endsWith('等它结束后再删除一次。'), error.message);
    const deleted = await deleteCommand(p1, 'queued', { timeoutMs: 30_000 });
    assert.deepEqual(deleted.deletedConversationIds, ['queued']);
    await quiet(p1, 1_000);
    assert.equal(calls, 1, '排队消息从未被准入');
    await assertNoPendingResults(p1.app);
    assert.deepEqual(errors(p1), []);
  } finally {
    await p1.close();
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

test('高-2：另一个存活窗口在执行 Turn、还有一条排队消息 → 本窗口先取消排队消息再停 Turn，执行窗口不准入它、模型只被第一条消息调用（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('r3');
  let child;
  let p1;
  const marker = path.join(outer, 'provider-calls.log');
  const sideEffect = path.join(outer, 'queued-message-side-effect.txt');
  try {
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, { ...files.env, DELETE_STOP_MARKER: marker, DELETE_STOP_SIDE_EFFECT: sideEffect, DELETE_STOP_CWD: outer }, 'queued-owner');
    await waitForWorkerJson(child, files.ready, 90_000);
    p1 = await openHost(dataRoot, scriptedProvider(() => { throw new Error('本窗口不应调用模型'); }), { label: 'p1', folders: [OTHER_PROJECT] });
    assert.equal((await rows(p1.app, 'TurnIntent', { conversation_id: 'queued', state: 'queued' })).length, 1, '有一条排队消息');
    const deleted = await deleteCommand(p1, 'queued', { timeoutMs: 30_000, pollMs: 250 });
    assert.deepEqual(deleted.deletedConversationIds, ['queued']);
    await sleep(1_500);
    const calls = (await fs.readFile(marker, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    assert.equal(calls.length, 1, `排队消息没有被准入执行：\n${calls.join('\n')}`);
    assert.equal(await fs.readFile(sideEffect, 'utf8').then(() => true, () => false), false, '排队消息的工具没有执行');
    await assertNoPendingResults(p1.app);
    assert.deepEqual(errors(p1), []);
    await fs.writeFile(files.finish, 'finish\n', 'utf8');
    await waitForExit(child, 90_000, true);
  } finally {
    await p1?.close();
    await stopChild(child);
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

test('中-2：另一个存活窗口只是占着对话 → 删除显示在等那个窗口（写明进程号）；超时时如实说明是占用、不说发出了停止；释放后删除成功（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('r5');
  let child;
  let p1;
  try {
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, { ...files.env, DELETE_STOP_HOLD_MS: '8000' }, 'hold-owner');
    await waitForWorkerJson(child, files.ready, 90_000);
    p1 = await openHost(dataRoot, scriptedProvider(() => { throw new Error('本窗口不应调用模型'); }), { label: 'p1', folders: [OTHER_PROJECT] });
    const progress = [];
    const error = await deleteCommand(p1, 'held', { timeoutMs: 2_500, onProgress: (entry) => progress.push(entry) }).then(() => null, (reason) => reason);
    assert.ok(isConversationDeleteIncompleteError(error), `预期没能完成：${error?.stack ?? error}`);
    assert.deepEqual(progress.map((entry) => entry.kind), ['waiting_owner'], '等待期间有提示，写明在等另一个窗口');
    assert.ok(progress[0].message.includes(`进程 ${child.pid}`), progress[0].message);
    assert.ok(error.message.includes(`对话「held」正被另一个窗口（进程 ${child.pid}）使用`), error.message);
    assert.equal(error.message.includes('停止请求已经发出'), false, '没有要停的任务，不说发出了停止');
    assert.ok(error.message.endsWith('那个窗口释放这个对话后再删除一次。'), error.message);
    const deleted = await deleteCommand(p1, 'held', { timeoutMs: 30_000 });
    assert.deepEqual(deleted.deletedConversationIds, ['held']);
    await fs.writeFile(files.finish, 'finish\n', 'utf8');
    await waitForExit(child, 90_000, true);
  } finally {
    await p1?.close();
    await stopChild(child);
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

test('低-1/低-2/低-3：确认框说清父对话会怎样，没删完用警告样式，删除中的对话连同子 Agent 对话一起隐藏', { timeout: 120_000 }, async (context) => {
  const server = await createWebviewSsrServer();
  context.after(async () => server.close());
  const presentation = await server.ssrLoadModule('/src/sidebar/deletePresentation.ts');
  const child = presentation.deleteConfirmDescriptionHtml('「子任务」', true);
  assert.ok(child.includes('会先停止「子任务」和它的子任务里正在运行的任务（包括后台进程）'));
  assert.ok(child.includes('如果父对话正在等这个子任务，它会得知这个子任务对话已被用户删除'), '只在父对话正在等时才说它会得知');
  assert.ok(child.includes('父对话还没接收的这个子任务的答复会被丢弃，不会再送达'), '空闲父对话的未接收答复写明丢弃');
  const top = presentation.deleteConfirmDescriptionHtml('「主对话」', false);
  assert.equal(top.includes('父对话'), false);
  assert.ok(top.includes('<strong>不能撤销</strong>'));
  assert.equal(presentation.operationNoticeKind(false, 'warning'), 'warning');
  assert.equal(presentation.operationNoticeKind(false), 'error');
  assert.equal(presentation.operationNoticeKind(true), 'info');
  const link = (id, conversationId, sourceConversationId, originKind = 'agent') => ({ id, conversationId, sourceConversationId, originKind, createdAt: 1, updatedAt: 1 });
  const hidden = presentation.withDeletedDescendants(new Set(['root']), [
    link('l1', 'child', 'root'), link('l2', 'grandchild', 'child'), link('l3', 'fork', 'child', 'user'), link('l4', 'other-child', 'other')
  ]);
  assert.deepEqual([...hidden].sort(), ['child', 'grandchild', 'root'], '子 Agent 对话随父隐藏，用户 fork 不隐藏');
  const sidebar = await fs.readFile(path.join(root, 'webview/src/sidebar/SidebarApp.vue'), 'utf8');
  for (const used of ['deleteConfirmDescriptionHtml(', 'operationNoticeKind(message.ok, message.severity)', 'withDeletedDescendants(']) {
    assert.ok(sidebar.includes(used), `侧栏使用 ${used}`);
  }
  const view = await fs.readFile(path.join(root, 'vscode/views/SidebarEntryView.ts'), 'utf8');
  assert.ok(view.includes("incomplete ? { severity: 'warning' } : {}"), '没删完的结果以警告发给侧栏');
  const css = await fs.readFile(path.join(root, 'webview/src/sidebar/sidebar.css'), 'utf8');
  assert.match(css, /\.operation-notice\.is-warning\s*\{/, '警告样式存在');
});

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

async function runWorker(mode) {
  const dataRoot = requiredEnv('LIMCODE_DELETE_STOP_DATA_ROOT');
  if (mode === 'process-owner') {
    const command = `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`;
    const marker = requiredEnv('DELETE_STOP_MARKER');
    let round = 0;
    const provider = scriptedProvider(async (request) => {
      round += 1;
      await fs.appendFile(marker, `call ${round} conversation=${request.conversationId} at=${Date.now()}\n`, 'utf8');
      if (round === 1) return { role: 'model', parts: [{ id: 'bash-1', functionCall: { name: 'bash', args: {
        mode: 'execute', explanation: '后台运行', command, foregroundWaitMs: 0 } } }] };
      return { role: 'model', parts: [{ text: `第 ${round} 次回复` }] };
    });
    // Production-like: the window that started the process delivers its completion (wake handler).
    const host = await openHost(dataRoot, provider, { label: 'origin', cwd: requiredEnv('DELETE_STOP_CWD'), wake: true });
    try {
      await createConversation(host.app, 'with-process');
      const started = await host.runner.input({ commandId: 'input-process', conversationId: 'with-process', text: '在后台跑一个进程' });
      await eventually(async () => (await rows(host.app, 'Turn', { id: started.turnId }))[0]?.status === 'terminated', 30_000, 'Turn 未结束');
      await host.runner.waitForIdle();
      const [processRow] = await rows(host.app, 'Process', {});
      await writeJson(requiredEnv('LIMCODE_DELETE_STOP_READY'), {
        processId: processRow.id,
        pid: Number(processRow.child_pid ?? processRow.wrapper_pid),
        wrapperPid: Number(processRow.wrapper_pid),
        status: processRow.status,
        ownsConversation: host.app.database.conversationOwners.owns('with-process')
      });
      await waitForFile(requiredEnv('LIMCODE_DELETE_STOP_FINISH'), 300_000);
    } finally {
      await host.close();
    }
    return;
  }
  if (mode === 'queued-owner') {
    const marker = requiredEnv('DELETE_STOP_MARKER');
    const sideEffect = requiredEnv('DELETE_STOP_SIDE_EFFECT');
    let calls = 0;
    const provider = scriptedProvider(async (request) => {
      calls += 1;
      await fs.appendFile(marker, `call ${calls} conversation=${request.conversationId} containsQueuedText=${JSON.stringify(request.context ?? '').includes('排队的第二条消息')} at=${Date.now()}\n`, 'utf8');
      if (calls === 1) return 'hang';
      if (calls === 2) {
        const command = `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(${JSON.stringify(sideEffect).replace(/"/g, '\\"')}, 'queued message ran')"`;
        return { role: 'model', parts: [{ id: 'bash-queued', functionCall: { name: 'bash', args: {
          mode: 'execute', explanation: '排队消息的工具', command, foregroundWaitMs: 10_000 } } }] };
      }
      return { role: 'model', parts: [{ text: `第 ${calls} 次回复` }] };
    });
    const host = await openHost(dataRoot, provider, { label: 'origin', cwd: requiredEnv('DELETE_STOP_CWD') });
    try {
      await createConversation(host.app, 'queued');
      const first = await host.runner.input({ commandId: 'input-first', conversationId: 'queued', text: '第一条消息' });
      await eventually(async () => calls === 1, 30_000, '第一条消息未调用模型');
      const second = await host.runner.input({ commandId: 'input-second', conversationId: 'queued', text: '排队的第二条消息' });
      await writeJson(requiredEnv('LIMCODE_DELETE_STOP_READY'), { turnId: first.turnId, secondAdmitted: second.admitted ?? null, hostBootId: host.app.database.hostBootId });
      await waitForFile(requiredEnv('LIMCODE_DELETE_STOP_FINISH'), 300_000);
    } finally {
      await host.close();
    }
    return;
  }
  if (mode === 'hold-owner') {
    const host = await openHost(dataRoot, scriptedProvider(() => ({ role: 'model', parts: [{ text: 'x' }] })), { label: 'origin' });
    try {
      await createConversation(host.app, 'held');
      const holdMs = Number(requiredEnv('DELETE_STOP_HOLD_MS'));
      let release;
      const released = new Promise((resolve) => { release = resolve; });
      const held = host.app.database.conversationOwners.run('held', () => released);
      await eventually(async () => host.app.database.conversationOwners.owns('held'), 10_000, '未持有归属');
      await writeJson(requiredEnv('LIMCODE_DELETE_STOP_READY'), { holding: true });
      await sleep(holdMs);
      release();
      await held;
      await waitForFile(requiredEnv('LIMCODE_DELETE_STOP_FINISH'), 300_000);
    } finally {
      await host.close();
    }
    return;
  }
  throw new Error(`Unknown worker ${mode}.`);
}

/** The facade's deleteConversation (VscodeReliableKernelApplicationFacade), without the notification. */
function deleteCommand(host, conversationId, options = {}) {
  return stopAndDeleteConversation({
    application: host.app,
    conversations: host.runner,
    childAgents: host.coordinator,
    pollMs: options.pollMs ?? 100,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
  }, {
    conversationId,
    requestId: `delete-${conversationId}-${Date.now()}`,
    ...(options.onProgress ? { onProgress: options.onProgress } : {})
  });
}

async function openHost(dataRoot, provider, options) {
  const folders = options.folders ?? [PROJECT.uri];
  let coordinator;
  const app = await kernel.ReliableKernelApplication.open(
    new kernel.RootAuthority(() => dataRoot),
    fixtureDependencies(provider, options.onMcpCall ?? (() => undefined), () => coordinator, options.cwd ?? os.tmpdir())
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
  await app.recover();
  await coordinator.recoverStartup();
  await runner.recoverStartup();
  let closed = false;
  return {
    app,
    runner,
    coordinator,
    runnerErrors,
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

function fixtureDependencies(provider, onMcpCall, coordinator, cwd) {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: PROVIDER_ID, modelId: 'delete-stop-model' }) },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: {
                providerConfigId: PROVIDER_ID,
                provider: 'openai-compatible',
                modelId: 'delete-stop-model',
                retryPolicy: { enabled: false, maxRetries: 0 }
              },
              modelProfile: {
                compressionThresholdTokens: 100_000,
                contextWindowTokens: 128_000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              toolPolicy: {
                id: 'delete-stop-tools',
                allowedTools: ['ask_user', 'run_agent', 'bash'],
                preset: 'yolo',
                toolConfigs: { run_agent: { config: { maxChildAgentDepth: 3 } } },
                sourceConfigs: { fixture: { enabled: true } }
              },
              planReviewPolicy: { mode: 'off' },
              systemPrompt: { id: 'delete-stop-prompt', text: '' },
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
          definitions() { return [hangingMcpTool, askUserTool, runAgentTool, bashTool]; },
          async dispatchSpecial(_definition, input, authority, signal, admission) {
            return coordinator().dispatch(input, signal, authority, admission);
          },
          resolveProcessCwd() { return cwd; },
          async cancelTurnWaits(input) { await coordinator().cancelParentWaits(input); },
          async quiesce(reason) { await coordinator().quiesce(reason); },
          async dispose() {}
        }
      })
  };
}

/** Every model call is recorded. `reply` returns content, or 'hang' for a call that only ends when aborted. */
function scriptedProvider(reply) {
  const calls = [];
  return {
    providerId: PROVIDER_ID,
    calls,
    async sendFullRequest(request, controls) {
      calls.push({ conversationId: request.conversationId });
      const content = await reply(request);
      if (content === 'hang') {
        await new Promise((_resolve, reject) => {
          const abort = () => reject(controls.signal?.reason ?? new Error('aborted'));
          if (controls.signal?.aborted) abort();
          else controls.signal?.addEventListener('abort', abort, { once: true });
        });
        return;
      }
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

/** A finished background Process started by `sourceTurnId`, with its automatic delivery (relocated-work-settlement). */
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

/** After a deletion nothing is left pending: no RuntimeDelivery, and no unfinished wake of a settled one. */
async function assertNoPendingResults(app) {
  assert.deepEqual((await rows(app, 'RuntimeDelivery', { state: 'pending' })).map((row) => row.id), [], '删除后没有残留的 pending 投递');
  const failed = new Set((await rows(app, 'RuntimeDelivery', { state: 'failed' })).map((row) => row.id));
  const wakes = (await rows(app, 'RuntimeDeliveryWake', {}))
    .filter((row) => failed.has(row.delivery_id) && (row.state === 'pending' || row.state === 'claimed'));
  assert.deepEqual(wakes.map((row) => row.id), [], '收尾的投递没有未完成的唤醒');
}

/** PRAGMA foreign_key_check, read after the Runtime of this process closed the database (POSIX lock rule). */
function assertForeignKeysClean(dataRoot) {
  const database = new Database(path.join(dataRoot, 'limcode.sqlite'), { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(database.pragma('foreign_key_check'), [], '外键检查为空');
  } finally {
    database.close();
  }
}

async function readContentJson(app, contentObjectId) {
  const [metadata] = await rows(app, 'ContentObject', { id: contentObjectId });
  return JSON.parse((await app.contentStore.read(metadata)).toString('utf8'));
}

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(repo(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 1_000
  }))).snapshot;
}

function errors(host) {
  return host.runnerErrors.map((entry) => String(entry.error?.stack ?? entry.error));
}

/** Lets delivery scans, wakes and drives run; a Turn that would run again calls the Provider here. */
async function quiet(host, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await host.runner.waitForIdle();
    await host.coordinator.waitForIdle();
    await sleep(100);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function createIsolatedRoot(label) {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-delete-stop-${label}-`));
  await fs.mkdir(path.join(outer, 'control'), { recursive: true });
  const candidate = await kernel.resetCandidateRuntimeRoot(path.join(outer, 'control'));
  return { outer, dataRoot: candidate.binding.paths.dataRootPath };
}

function workerFiles(outer) {
  const files = { ready: path.join(outer, 'origin-ready.json'), finish: path.join(outer, 'origin-finish') };
  return { ...files, env: { LIMCODE_DELETE_STOP_READY: files.ready, LIMCODE_DELETE_STOP_FINISH: files.finish } };
}

function spawnWorker(dataRoot, environment, mode) {
  const child = childProcess.spawn(process.execPath, [TEST_FILE], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment, LIMCODE_DELETE_STOP_WORKER: mode, LIMCODE_DELETE_STOP_DATA_ROOT: dataRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { child.output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { child.output.stderr += chunk; });
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
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`worker exited before ${path.basename(filePath)} (code=${child.exitCode})\n${child.output.stdout}\n${child.output.stderr}`);
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await sleep(20);
  }
}

async function stopChild(child) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await waitForExit(child, 30_000).catch(() => undefined);
}

function waitForExit(child, timeoutMs, rejectNonZero = false) {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (rejectNonZero && child.exitCode !== 0) {
      return Promise.reject(new Error(`worker exited with ${child.exitCode}\n${child.output.stdout}\n${child.output.stderr}`));
    }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker did not exit\n${child.output.stdout}\n${child.output.stderr}`)), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (rejectNonZero && code !== 0) reject(new Error(`worker exited with ${code}\n${child.output.stdout}\n${child.output.stderr}`));
      else resolve();
    });
  });
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
      await sleep(50);
    }
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(`${filePath}.tmp`, JSON.stringify(value), 'utf8');
  await fs.rename(`${filePath}.tmp`, filePath);
}

async function eventually(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(20);
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

