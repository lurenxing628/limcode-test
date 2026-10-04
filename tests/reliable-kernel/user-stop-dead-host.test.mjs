import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.cwd();
const load = (relative) => import(pathToFileURL(path.join(root, 'dist/extension', relative)).href);
const kernel = await load('backend/reliableKernel/index.js');
const { emptyConversationContextHandleStateStep } = await load('backend/reliableKernel/conversationContextHandleState.js');
const { ReliableConversationRunner } = await load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { DEAD_HOST_STOP_REASON } = await load('backend/reliableKernel/phaseDRecovery.js');
const { ReliableChildAgentCoordinator } = await load('backend/reliableKernel/childAgentCoordinator.js');
const { runAgentTool } = await load('backend/world/modules/tools/definitions/runAgent/index.js');
const { evaluateConversationHostEligibility } = await load('backend/application/reliableKernel/conversationHostEligibility.js');
const { projectFolderAssignmentSteps } = await load('backend/reliableKernel/conversationProject.js');
const { stopAndDeleteConversation } = await load('backend/application/reliableKernel/conversationDeleteCommand.js');

const PROVIDER_ID = 'dead-host-provider';
const PROJECT_ONE = 'file:///workspace/project-one';
const PROJECT_TWO = { uri: 'file:///workspace/project-two', name: '项目二' };
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

const workerMode = process.env.LIMCODE_DEAD_HOST_WORKER;
if (workerMode) {
  runWorker(workerMode).then(
    () => process.exit(0),
    (error) => {
      console.error(error?.stack ?? error);
      process.exit(1);
    }
  );
} else {

test('执行窗口被杀、工具仍在执行、项目在任何窗口都打不开：删除事务不收尾活动工作，用户停止后效果为 outcome_unknown、Turn 收尾，删除成功（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('killed');
  let p1;
  let child;
  try {
    const conversationId = 'conversation-killed';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, { ...files.env, LIMCODE_DEAD_HOST_CONVERSATION: conversationId });
    const { turnId } = await waitForWorkerJson(child, files.ready, 90_000);
    child.kill('SIGKILL');
    await waitForExit(child, 30_000);

    const provider = scriptedProvider([]);
    p1 = await openHost(dataRoot, provider, { folders: [PROJECT_ONE], label: 'p1' });
    await p1.app.recover();
    const report = await p1.runner.recoverStartup();
    assert.deepEqual(report.ineligibleTurnIds, [turnId], '没有窗口服务该项目');
    const [call] = await rows(p1.app, 'ToolCall', { turn_id: turnId });
    assert.equal(call.status, 'executing', '被杀窗口留下执行中的工具');
    const [intent] = await effectIntentsForToolCall(p1.app, call.id);
    assert.equal(intent.dispatch_state, 'dispatched');

    // 删除事务本身不收尾活动工作（删除命令先停止再删，见 conversation-delete-stop），拒绝时也不让本窗口一直持有。
    await assert.rejects(deleteTransaction(p1, conversationId), /活动 Turn/);
    assert.equal(p1.owns(conversationId), false);

    // 恢复扫描和延迟轮询不会自动标记：只有用户停止才会。
    await sleep(1_500);
    assert.deepEqual(await rows(p1.app, 'EffectReceipt', { attempt_id: intent.attempt_id }), []);

    // 停止请求已记录（例如来自别的入口），自动的控制类收尾也不碰已派发却没有回执的效果：
    // 不认领租约、不写回执、不报错，留给用户停止或执行它的窗口。
    const [leaseBefore] = await rows(p1.app, 'ExecutionLease', { turn_id: turnId });
    await p1.app.turns.requestExternalInterrupt(conversationId, {
      source: { kind: 'command', key: 'recorded-stop' }, turnId, reason: '别的入口记录的停止'
    });
    const automatic = await p1.runner.recoverStartup();
    assert.deepEqual(automatic.interruptedTurnIds, []);
    const [leaseAfter] = await rows(p1.app, 'ExecutionLease', { turn_id: turnId });
    assert.deepEqual([leaseAfter.host_boot_id, leaseAfter.generation], [leaseBefore.host_boot_id, leaseBefore.generation],
      '自动收尾不认领执行宿主已死但效果结果未知的 Turn');
    assert.deepEqual(await rows(p1.app, 'EffectReceipt', { attempt_id: intent.attempt_id }), []);
    assert.deepEqual(p1.runnerErrors.map((entry) => String(entry.error?.stack ?? entry.error)), []);

    const [lease] = await rows(p1.app, 'ExecutionLease', { turn_id: turnId });
    const stopped = await p1.runner.interrupt({
      commandId: 'user-stop',
      conversationId,
      turnId,
      expectedLeaseGeneration: String(lease.generation),
      reason: '用户停止'
    });
    assert.equal(stopped.executingWindowAlive, undefined);
    const [turn] = await rows(p1.app, 'Turn', { id: turnId });
    assert.equal(turn.status, 'terminated', '用户停止后 Turn 立即收尾');
    assert.equal((await rows(p1.app, 'TurnTermination', { turn_id: turnId }))[0]?.terminal_status, 'interrupted');
    const [receipt] = await rows(p1.app, 'EffectReceipt', { attempt_id: intent.attempt_id });
    assert.equal(receipt?.outcome, 'outcome_unknown');
    assert.deepEqual(await readContentJson(p1.app, receipt.response_object_id), {
      reason: DEAD_HOST_STOP_REASON,
      automaticRetry: false
    });
    assert.equal(DEAD_HOST_STOP_REASON, '执行窗口意外退出，执行结果未知；由用户停止收尾。');
    const [operation] = await rows(p1.app, 'Operation', { tool_call_id: call.id });
    assert.equal(operation.status, 'outcome_unknown');
    assert.equal((await rows(p1.app, 'ToolOutcome', { tool_call_id: call.id }))[0]?.status, 'outcome_unknown');
    assert.equal((await rows(p1.app, 'ToolCall', { id: call.id }))[0]?.status, 'terminal');
    assert.equal(provider.calls, 0, '收尾不调用模型');
    assert.equal(p1.mcpCalls(), 0, '收尾不重放 MCP 调用');
    assert.equal(p1.owns(conversationId), false, '收尾后交还');

    const deleted = await deleteCommand(p1, conversationId);
    assert.deepEqual(deleted?.deletedConversationIds, [conversationId]);
    assert.deepEqual(p1.runnerErrors.map((entry) => String(entry.error?.stack ?? entry.error)), []);
  } finally {
    await p1?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('执行窗口仍存活时，其它窗口的停止不标记结果未知，交给执行窗口处理并提示（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('alive');
  let p1;
  let child;
  try {
    const conversationId = 'conversation-alive';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, { ...files.env, LIMCODE_DEAD_HOST_CONVERSATION: conversationId });
    const { turnId, hostBootId } = await waitForWorkerJson(child, files.ready, 90_000);

    const provider = scriptedProvider([]);
    p1 = await openHost(dataRoot, provider, { folders: [PROJECT_ONE], label: 'p1' });
    await p1.app.recover();
    await p1.runner.recoverStartup();
    const [call] = await rows(p1.app, 'ToolCall', { turn_id: turnId });
    const [intent] = await effectIntentsForToolCall(p1.app, call.id);
    const [lease] = await rows(p1.app, 'ExecutionLease', { turn_id: turnId });
    const stopped = await p1.runner.interrupt({
      commandId: 'user-stop-alive',
      conversationId,
      turnId,
      expectedLeaseGeneration: String(lease.generation),
      reason: '用户停止'
    });
    assert.equal(stopped.executingWindowAlive, true, '提示用户去执行窗口查看');
    assert.equal(p1.owns(conversationId), false);
    const leaseAfter = (await rows(p1.app, 'ExecutionLease', { turn_id: turnId }))[0];
    assert.notEqual(leaseAfter?.host_boot_id, p1.app.database.hostBootId, '不得接走存活窗口的执行租约');

    // 存活的执行窗口收到持久停止请求后自己收尾；本窗口从不写"意外退出"的结果。
    await eventually(async () => (await rows(p1.app, 'Turn', { id: turnId }))[0]?.status === 'terminated',
      60_000, '执行窗口未处理停止请求');
    const [receipt] = await rows(p1.app, 'EffectReceipt', { attempt_id: intent.attempt_id });
    if (receipt?.response_object_id) {
      const detail = await readContentJson(p1.app, receipt.response_object_id);
      assert.notEqual(detail.reason, DEAD_HOST_STOP_REASON);
    }
    const ours = await rows(p1.app, 'CommandReceipt', {});
    assert.equal(ours.some((row) => String(row.source_key).startsWith('user-stop-dead-host:')), false);
    assert.equal(p1.mcpCalls(), 0);
    assert.notEqual(hostBootId, p1.app.database.hostBootId);

    await fs.writeFile(files.finish, 'finish\n', 'utf8');
    await waitForExit(child, 90_000, true);
  } finally {
    await p1?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('子 Agent 同样适用：执行窗口被杀后，用户停止子 Agent 把它的效果标为 outcome_unknown 并收尾子 Turn；删除整棵树时父对话没接收的子答复按 target-gone 收尾（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('killed-child');
  let p1;
  let child;
  try {
    const conversationId = 'conversation-parent';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, { ...files.env, LIMCODE_DEAD_HOST_CONVERSATION: conversationId }, 'origin-child');
    const spawned = await waitForWorkerJson(child, files.ready, 90_000);
    child.kill('SIGKILL');
    await waitForExit(child, 30_000);

    p1 = await openHost(dataRoot, scriptedProvider([]), { folders: [PROJECT_ONE], label: 'p1', children: true });
    await p1.app.recover();
    await p1.runner.recoverStartup();
    await p1.coordinator.recoverStartup();
    const [childTurn] = await rows(p1.app, 'Turn', { id: spawned.childTurnId });
    assert.equal(childTurn.status, 'active', '被杀窗口留下活动的子 Turn');
    const [call] = await rows(p1.app, 'ToolCall', { turn_id: spawned.childTurnId, status: 'executing' });
    const [intent] = await effectIntentsForToolCall(p1.app, call.id);
    assert.equal(intent.dispatch_state, 'dispatched');
    await assert.rejects(deleteTransaction(p1, conversationId), /Subagent|活动 Turn/);

    // A model's run_agent interrupt is not a user's stop: it never closes a dead window's work.
    await p1.coordinator.interruptSubtree({
      sourceKey: 'model-interrupt',
      childExecutionId: spawned.childExecutionId,
      reason: 'run_agent interrupt_subtree requested'
    });
    // The child scheduler's automatic recovery now sees a recorded stop and a dead executing window:
    // it settles control-only work but never closes dispatched work as outcome_unknown on its own.
    await p1.coordinator.recoverStartup();
    await sleep(1_000);
    await p1.coordinator.recoverStartup();
    assert.deepEqual(await rows(p1.app, 'EffectReceipt', { attempt_id: intent.attempt_id }), []);
    assert.equal((await rows(p1.app, 'Turn', { id: spawned.childTurnId }))[0]?.status, 'active');

    const stopped = await p1.coordinator.interruptSubtree({
      sourceKey: 'user-stop-child',
      childExecutionId: spawned.childExecutionId,
      reason: '用户停止子 Agent'
    }, { userStop: true });
    assert.equal(stopped.executingWindowAlive, undefined);
    assert.equal((await rows(p1.app, 'Turn', { id: spawned.childTurnId }))[0]?.status, 'terminated');
    assert.equal((await rows(p1.app, 'TurnTermination', { turn_id: spawned.childTurnId }))[0]?.terminal_status, 'interrupted');
    const [receipt] = await rows(p1.app, 'EffectReceipt', { attempt_id: intent.attempt_id });
    assert.equal(receipt?.outcome, 'outcome_unknown');
    assert.equal((await readContentJson(p1.app, receipt.response_object_id)).reason, DEAD_HOST_STOP_REASON);
    const [execution] = await rows(p1.app, 'ChildExecution', { id: spawned.childExecutionId });
    assert.equal(['starting', 'active', 'interrupting'].includes(String(execution.status)), false, `子执行仍为 ${execution.status}`);
    assert.equal(p1.mcpCalls(), 0);

    // 父对话还没接收子 Agent 的中断结果：删除整棵树时这条答复按 target-gone 收尾，不再挡住删除。
    const pendingAnswers = await rows(p1.app, 'RuntimeDelivery', { target_conversation_id: conversationId, state: 'pending' });
    assert.equal(pendingAnswers.length, 1, '子 Agent 的中断结果投递给父对话');
    const [inbox] = await rows(p1.app, 'RuntimeInboxItem', { id: pendingAnswers[0].inbox_item_id });
    assert.equal(inbox.source_kind, 'answer_submission');
    const deleted = await deleteCommand(p1, conversationId);
    assert.deepEqual([...deleted.deletedConversationIds].sort(), [conversationId, spawned.childConversationId].sort());
    assert.deepEqual((await rows(p1.app, 'RuntimeDelivery', { id: pendingAnswers[0].id })).map((row) => [row.state, row.failure_reason]),
      [['failed', 'target-gone']]);
    assert.deepEqual(await rows(p1.app, 'RuntimeDelivery', { state: 'pending' }), []);
    assert.equal(p1.owns(conversationId), false);
    assert.deepEqual(p1.runnerErrors.map((entry) => String(entry.error?.stack ?? entry.error)), []);
  } finally {
    await p1?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('复审 #7：父对话等待子 Agent 时执行窗口被杀，没有合格窗口：在不合格窗口停止父对话并级联，父子 Turn 都收尾，子 Agent 的停止不必等合格窗口（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('parent-waits');
  let p1;
  let child;
  try {
    const conversationId = 'conversation-parent-waits';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, { ...files.env, LIMCODE_DEAD_HOST_CONVERSATION: conversationId }, 'origin-parent-waits');
    const spawned = await waitForWorkerJson(child, files.ready, 90_000);
    child.kill('SIGKILL');
    await waitForExit(child, 30_000);

    p1 = await openHost(dataRoot, scriptedProvider([]), { folders: [PROJECT_ONE], label: 'p1', children: true });
    await p1.app.recover();
    await p1.runner.recoverStartup();
    await p1.coordinator.recoverStartup();
    const [parentTurn] = await rows(p1.app, 'Turn', { conversation_id: conversationId, status: 'active' });
    assert.ok(parentTurn, '父 Turn 在等待子 Agent');
    const [runAgent] = await rows(p1.app, 'ToolCall', { turn_id: parentTurn.id, tool_name: 'run_agent' });
    assert.equal(runAgent.status, 'executing', '父等子时 run_agent 处于执行中');

    // A stop recorded for the child (here a model's run_agent interrupt) is settled control-only by
    // the child scheduler's own recovery in this window, symmetric to the Conversation runner.
    await p1.coordinator.interruptSubtree({ sourceKey: 'recorded-child-stop', childExecutionId: spawned.childExecutionId,
      reason: 'run_agent interrupt_subtree requested' });
    assert.equal((await rows(p1.app, 'Turn', { id: spawned.childTurnId }))[0]?.status, 'active');
    await p1.coordinator.recoverStartup();
    await eventually(async () => (await rows(p1.app, 'Turn', { id: spawned.childTurnId }))[0]?.status === 'terminated',
      30_000, '子调度没有在不合格窗口收尾已记录停止的子 Turn');

    // The panel's stop with cascade (VscodeReliableKernelCommandRouter.handleInterruptRequest).
    const lease = (await rows(p1.app, 'ExecutionLease', { turn_id: parentTurn.id }))[0];
    const stopped = await p1.runner.interrupt({ commandId: 'stop-parent', conversationId, turnId: String(parentTurn.id),
      expectedLeaseGeneration: String(lease.generation), reason: '用户请求中断当前 Turn 及其子执行。' });
    assert.equal(stopped.executingWindowAlive, undefined);
    const cascaded = await p1.coordinator.interruptSubtree({ sourceKey: 'stop-parent:child', childExecutionId: spawned.childExecutionId,
      reason: 'parent_turn_interrupted' }, { userStop: true });
    assert.equal(cascaded.executingWindowAlive, undefined);
    await eventually(async () => (await rows(p1.app, 'Turn', { id: parentTurn.id }))[0]?.status === 'terminated', 30_000, '父 Turn 未收尾');
    await eventually(async () => (await rows(p1.app, 'Turn', { id: spawned.childTurnId }))[0]?.status === 'terminated', 30_000, '子 Turn 未收尾');
    const [execution] = await rows(p1.app, 'ChildExecution', { id: spawned.childExecutionId });
    assert.equal(['starting', 'active', 'interrupting'].includes(String(execution.status)), false, `子执行仍为 ${execution.status}`);
    assert.equal((await rows(p1.app, 'ToolCall', { turn_id: parentTurn.id, status: 'executing' })).length, 0);
    assert.equal(p1.owns(conversationId), false);
    assert.equal(p1.owns(spawned.childConversationId), false);
    assert.deepEqual(p1.runnerErrors.map((entry) => String(entry.error?.stack ?? entry.error)), []);
    const deleted = await deleteCommand(p1, conversationId);
    assert.deepEqual([...deleted.deletedConversationIds].sort(), [conversationId, spawned.childConversationId].sort(), '停止之后删除成功');
    assert.deepEqual(await rows(p1.app, 'RuntimeDelivery', { state: 'pending' }), []);
  } finally {
    await p1?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('死宿主判定：派发或持租约的宿主存活即为 live；本窗口派发的效果按存活；缺派发宿主记录不按已死；用户停止在栅栏内复核，复核不再是已死就交还租约、不标记；已到回执按回执对账（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('judgement');
  let p1;
  let child;
  try {
    const conversationId = 'conversation-judgement';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, { ...files.env, LIMCODE_DEAD_HOST_CONVERSATION: conversationId });
    const { turnId, hostBootId } = await waitForWorkerJson(child, files.ready, 90_000);
    p1 = await openHost(dataRoot, scriptedProvider([]), { folders: [PROJECT_ONE], label: 'p1' });
    const phaseD = p1.app.phaseDRecovery;
    const self = p1.app.database.hostBootId;
    const [call] = await rows(p1.app, 'ToolCall', { turn_id: turnId });
    const [intent] = await effectIntentsForToolCall(p1.app, call.id);

    // The executing window is alive: its dispatched work is never judged dead.
    assert.deepEqual(await phaseD.deadHostEffectsForTurn(turnId, self), { state: 'live', hostBootIds: [hostBootId] });
    child.kill('SIGKILL');
    await waitForExit(child, 30_000);
    assert.deepEqual(await phaseD.deadHostEffectsForTurn(turnId, self),
      { state: 'dead', hostBootIds: [hostBootId], effectIntentIds: [intent.id] });
    // Asked as the dispatching Host itself, the work runs here: never dead.
    assert.deepEqual(await phaseD.deadHostEffectsForTurn(turnId, hostBootId), { state: 'live', hostBootIds: [hostBootId] });
    // Without a recorded dispatch Host nothing proves the work stopped.
    const effects = phaseD.effects;
    const readFence = effects.readEffectDispatchFence;
    effects.readEffectDispatchFence = async () => undefined;
    try {
      assert.deepEqual(await phaseD.deadHostEffectsForTurn(turnId, self), { state: 'live', hostBootIds: [] });
    } finally {
      effects.readEffectDispatchFence = readFence;
    }

    // The user's stop re-reads the work under the lease it claimed. When that re-read no longer finds
    // every Host dead, nothing is marked and the lease goes straight back.
    const inspect = phaseD.deadHostEffectsForTurn.bind(phaseD);
    let inspections = 0;
    phaseD.deadHostEffectsForTurn = async (...args) => {
      // Only the re-read made while this window holds the Turn's lease sees the changed world.
      const [held] = await rows(p1.app, 'ExecutionLease', { turn_id: turnId });
      if (held?.host_boot_id !== self) return inspect(...args);
      inspections += 1;
      return { state: 'live', hostBootIds: ['host-came-back'] };
    };
    let lease = (await rows(p1.app, 'ExecutionLease', { turn_id: turnId }))[0];
    const recheck = await p1.runner.interrupt({ commandId: 'stop-recheck', conversationId, turnId,
      expectedLeaseGeneration: String(lease.generation), reason: '用户停止' });
    phaseD.deadHostEffectsForTurn = inspect;
    assert.equal(recheck.executingWindowAlive, true);
    assert.ok(inspections >= 1, '认领租约后在栅栏内复核');
    assert.equal((await rows(p1.app, 'Turn', { id: turnId }))[0]?.status, 'active', '复核不是已死：不收尾');
    assert.deepEqual(await rows(p1.app, 'EffectReceipt', { attempt_id: intent.attempt_id }), [], '复核不是已死：不标记');
    lease = (await rows(p1.app, 'ExecutionLease', { turn_id: turnId }))[0];
    assert.equal(lease.owner_id, kernel.RELEASED_EXECUTION_LEASE_HOLDER, '未收尾的认领在同一次持有内交还');
    assert.equal(p1.owns(conversationId), false);

    // The call's answer arrived just before the window died (a Receipt with the Operation still open).
    // The stop applies that recorded result instead of closing the call some other way.
    const recorded = await p1.app.runtime.effects.recordEffectReceipt({
      source: { kind: 'callback', key: `mcp-call:${intent.attempt_id}:receipt` },
      attemptId: intent.attempt_id,
      effectKind: 'mcp_tool_call',
      outcome: 'succeeded',
      detail: { outcome: 'succeeded', result: { content: [{ type: 'text', text: '外部工具完成' }] } }
    });
    assert.ok(recorded.effectReceiptId);
    assert.equal((await rows(p1.app, 'Operation', { tool_call_id: call.id }))[0]?.status, 'executing', '回执已到、Operation 仍未结束');
    const stopped = await p1.runner.interrupt({ commandId: 'stop-arrived', conversationId, turnId,
      expectedLeaseGeneration: String(lease.generation), reason: '用户停止' });
    assert.equal(stopped.executingWindowAlive, undefined);
    assert.equal((await rows(p1.app, 'Turn', { id: turnId }))[0]?.status, 'terminated');
    assert.equal((await rows(p1.app, 'Operation', { tool_call_id: call.id }))[0]?.status, 'succeeded', '按已到回执对账');
    assert.equal((await rows(p1.app, 'ToolOutcome', { tool_call_id: call.id }))[0]?.status, 'succeeded');
    const receipts = await rows(p1.app, 'CommandReceipt', {});
    assert.equal(receipts.some((row) => String(row.source_key).startsWith('user-stop-dead-host:')), false);
    assert.equal(p1.mcpCalls(), 0);
    assert.deepEqual(p1.runnerErrors.map((entry) => String(entry.error?.stack ?? entry.error)), []);
  } finally {
    await p1?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('复审 #7：服务该对话的窗口里用户停止，死宿主留下的效果先走启动恢复同样的核对路径，核对不了的才由停止标为结果未知（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('serving-stop');
  let p2;
  let child;
  try {
    const conversationId = 'conversation-serving-stop';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, { ...files.env, LIMCODE_DEAD_HOST_CONVERSATION: conversationId });
    const { turnId } = await waitForWorkerJson(child, files.ready, 90_000);
    child.kill('SIGKILL');
    await waitForExit(child, 30_000);
    // A window serving the project that has not recovered the Turn yet (it was already open).
    p2 = await openHost(dataRoot, scriptedProvider([]), { folders: [PROJECT_TWO.uri], label: 'p2' });
    const [call] = await rows(p2.app, 'ToolCall', { turn_id: turnId });
    const [intent] = await effectIntentsForToolCall(p2.app, call.id);
    const lease = (await rows(p2.app, 'ExecutionLease', { turn_id: turnId }))[0];
    await p2.runner.interrupt({ commandId: 'serving-stop', conversationId, turnId,
      expectedLeaseGeneration: String(lease.generation), reason: '用户停止' });
    await eventually(async () => (await rows(p2.app, 'Turn', { id: turnId }))[0]?.status === 'terminated', 30_000, 'Turn 未收尾');
    assert.equal((await rows(p2.app, 'TurnTermination', { turn_id: turnId }))[0]?.terminal_status, 'interrupted');
    const [receipt] = await rows(p2.app, 'EffectReceipt', { attempt_id: intent.attempt_id });
    const detail = await readContentJson(p2.app, receipt.response_object_id);
    assert.notEqual(detail.reason, DEAD_HOST_STOP_REASON, '先走恢复路径，不直接按用户停止标记');
    assert.match(detail.reason, /MCP service cannot prove/);
    const receipts = await rows(p2.app, 'CommandReceipt', {});
    assert.equal(receipts.some((row) => String(row.source_key).startsWith('user-stop-dead-host:')), false);
    assert.equal(p2.mcpCalls(), 0, '恢复不重放外部调用');
  } finally {
    await p2?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('盲审 5：服务子对话的窗口里用户停止子 Agent，死宿主留下的效果先对子对话跑启动恢复（Phase D）核对，核对不了的才由停止标为结果未知（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('serving-child-stop');
  let p2;
  let child;
  try {
    const conversationId = 'conversation-serving-child-stop';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, { ...files.env, LIMCODE_DEAD_HOST_CONVERSATION: conversationId }, 'origin-child');
    const spawned = await waitForWorkerJson(child, files.ready, 90_000);
    child.kill('SIGKILL');
    await waitForExit(child, 30_000);
    // A window serving the project, so the child Conversation too, that has not recovered the child Turn yet.
    p2 = await openHost(dataRoot, scriptedProvider([{ role: 'model', parts: [{ text: '父对话收到子 Agent 的结果。' }] }]),
      { folders: [PROJECT_TWO.uri], label: 'p2', children: true });
    assert.equal(await p2.app.database.conversationOwners.executionEligibility(spawned.childConversationId), 'eligible');
    const [call] = await rows(p2.app, 'ToolCall', { turn_id: spawned.childTurnId, status: 'executing' });
    const [intent] = await effectIntentsForToolCall(p2.app, call.id);
    const stopped = await p2.coordinator.interruptSubtree({
      sourceKey: 'user-stop-child-serving',
      childExecutionId: spawned.childExecutionId,
      reason: '用户停止子 Agent'
    }, { userStop: true });
    assert.equal(stopped.executingWindowAlive, undefined);
    await eventually(async () => (await rows(p2.app, 'Turn', { id: spawned.childTurnId }))[0]?.status === 'terminated',
      30_000, '子 Turn 未收尾');
    assert.equal((await rows(p2.app, 'TurnTermination', { turn_id: spawned.childTurnId }))[0]?.terminal_status, 'interrupted');
    const [receipt] = await rows(p2.app, 'EffectReceipt', { attempt_id: intent.attempt_id });
    assert.equal(receipt?.outcome, 'outcome_unknown');
    const detail = await readContentJson(p2.app, receipt.response_object_id);
    assert.notEqual(detail.reason, DEAD_HOST_STOP_REASON, '先走恢复路径，不直接按用户停止标记');
    assert.match(detail.reason, /MCP service cannot prove/);
    const receipts = await rows(p2.app, 'CommandReceipt', {});
    assert.equal(receipts.some((row) => String(row.source_key).startsWith('user-stop-dead-host:')), false);
    assert.equal(p2.mcpCalls(), 0, '恢复不重放外部调用');
  } finally {
    await p2?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('盲审 5：服务子对话的窗口里用户停止子 Agent 时 Phase D 核对本身出错：停止照常按用户停止收尾，不因核对失败卡住（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('serving-child-stop-failed-check');
  let p2;
  let child;
  try {
    const conversationId = 'conversation-serving-child-stop-failed-check';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, { ...files.env, LIMCODE_DEAD_HOST_CONVERSATION: conversationId }, 'origin-child');
    const spawned = await waitForWorkerJson(child, files.ready, 90_000);
    child.kill('SIGKILL');
    await waitForExit(child, 30_000);
    p2 = await openHost(dataRoot, scriptedProvider([{ role: 'model', parts: [{ text: '父对话收到子 Agent 的结果。' }] }]),
      { folders: [PROJECT_TWO.uri], label: 'p2', children: true });
    let checks = 0;
    p2.app.phaseDRecovery.runAll = async () => {
      checks += 1;
      throw new Error('工作区暂时无法读取（注入）');
    };
    const [call] = await rows(p2.app, 'ToolCall', { turn_id: spawned.childTurnId, status: 'executing' });
    const [intent] = await effectIntentsForToolCall(p2.app, call.id);
    await p2.coordinator.interruptSubtree({
      sourceKey: 'user-stop-child-failed-check',
      childExecutionId: spawned.childExecutionId,
      reason: '用户停止子 Agent'
    }, { userStop: true });
    assert.ok(checks >= 1, '先尝试了 Phase D 核对');
    await eventually(async () => (await rows(p2.app, 'Turn', { id: spawned.childTurnId }))[0]?.status === 'terminated',
      30_000, '核对出错后停止没有收尾');
    const [receipt] = await rows(p2.app, 'EffectReceipt', { attempt_id: intent.attempt_id });
    assert.equal(receipt?.outcome, 'outcome_unknown');
    assert.equal((await readContentJson(p2.app, receipt.response_object_id)).reason, DEAD_HOST_STOP_REASON);
    assert.equal(p2.mcpCalls(), 0);
  } finally {
    await p2?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('子驱动只在服务子对话的窗口执行：不合格窗口即使持有子 Turn 的租约也不驱动，立即交还（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('drive-child-gate');
  let p1;
  let child;
  try {
    const conversationId = 'conversation-drive-child-gate';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, { ...files.env, LIMCODE_DEAD_HOST_CONVERSATION: conversationId }, 'origin-parent-waits');
    const spawned = await waitForWorkerJson(child, files.ready, 90_000);
    child.kill('SIGKILL');
    await waitForExit(child, 30_000);
    const provider = scriptedProvider([]);
    p1 = await openHost(dataRoot, provider, { folders: [PROJECT_ONE], label: 'p1', children: true });
    const claimed = await p1.app.turns.claimRecoveryExecution({
      turnId: spawned.childTurnId,
      leaseOwnerId: p1.coordinator.childLeaseOwnerId,
      hostBootId: p1.app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString()
    });
    assert.ok(claimed, '本窗口取得了子 Turn 的租约（例如在这里派生后文件夹被移除）');
    await assert.rejects(p1.coordinator.driveChild(spawned.childExecutionId, spawned.childTurnId), /not served by this Host/);
    const [lease] = await rows(p1.app, 'ExecutionLease', { turn_id: spawned.childTurnId });
    assert.equal(lease.owner_id, kernel.RELEASED_EXECUTION_LEASE_HOLDER, '交还租约');
    assert.equal(provider.calls, 0, '不调用模型');
    assert.equal(p1.owns(spawned.childConversationId), false);
  } finally {
    await p1?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('子 Agent 运行中本窗口移除其项目文件夹：子驱动停在轮次之间并交还租约，模型不再被调用', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('child-round');
  let host;
  try {
    const conversationId = 'conversation-child-round';
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let childStarted;
    const started = new Promise((resolve) => { childStarted = resolve; });
    let parentCalls = 0;
    let childCalls = 0;
    const parentReplies = [
      { role: 'model', parts: [{ id: 'provider-spawn', functionCall: {
        name: 'run_agent', args: { operation: 'spawn', taskName: 'round', prompt: '做两轮', foregroundWaitMs: 0 } } }] },
      { role: 'model', parts: [{ text: '子任务已开始。' }] }
    ];
    const provider = {
      providerId: PROVIDER_ID,
      async sendFullRequest(request, controls) {
        if (request.conversationId === conversationId) {
          const content = parentReplies[parentCalls++];
          if (!content) throw new Error('Unexpected parent Provider call.');
          await controls.onEvent({ kind: 'completed', streamSeq: '1', content });
          return;
        }
        childCalls += 1;
        if (childCalls === 1) {
          childStarted();
          await gate;
          await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ id: 'c1', functionCall: { name: 'not_a_real_tool', args: {} } }] } });
          return;
        }
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: '第二轮' }] } });
      }
    };
    host = await openHost(dataRoot, provider, { folders: [PROJECT_ONE, PROJECT_TWO.uri], label: 'multi-root', children: true });
    await createConversation(host.app, conversationId, PROJECT_TWO);
    await host.runner.input({ commandId: 'child-round', conversationId, text: '派一个子 Agent' });
    await started;
    host.folders.splice(host.folders.indexOf(PROJECT_TWO.uri), 1);
    const [execution] = await rows(host.app, 'ChildExecution', {});
    const [link] = await rows(host.app, 'ChildExecutionActiveTurnLink', { child_execution_id: execution.id });
    release();
    await eventually(async () => (await rows(host.app, 'ExecutionLease', { turn_id: link.turn_id }))[0]?.owner_id
      === kernel.RELEASED_EXECUTION_LEASE_HOLDER, 15_000, '子驱动没有在轮次之间交还租约');
    assert.equal(childCalls, 1, '文件夹移除后子 Agent 不再调用模型');
    assert.equal((await rows(host.app, 'Turn', { id: link.turn_id }))[0]?.status, 'active', '子 Turn 停在轮次之间');
  } finally {
    await host?.close();
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('用户停止：子 Agent 派生已派发、执行窗口在写回执前退出——派生事务已建好子执行，按已派生记录，父 Turn 收尾，级联停止子 Agent（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('spawn-dispatched');
  let p1;
  let child;
  try {
    const conversationId = 'conversation-spawn-dispatched';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, { ...files.env, LIMCODE_DEAD_HOST_CONVERSATION: conversationId }, 'origin-spawn-dispatched');
    const spawned = await waitForWorkerJson(child, files.ready, 90_000);
    child.kill('SIGKILL');
    await waitForExit(child, 30_000);
    const provider = scriptedProvider([]);
    p1 = await openHost(dataRoot, provider, { folders: [PROJECT_ONE], label: 'p1', children: true });
    await p1.app.recover();
    await p1.runner.recoverStartup();
    await p1.coordinator.recoverStartup();
    assert.equal((await rows(p1.app, 'EffectIntent', { id: spawned.spawnIntentId }))[0]?.dispatch_state, 'dispatched');
    assert.equal((await rows(p1.app, 'Turn', { id: spawned.parentTurnId }))[0]?.status, 'active', '自动路径不收尾');
    // The panel's stop with cascade (VscodeReliableKernelCommandRouter.handleInterruptRequest).
    const lease = (await rows(p1.app, 'ExecutionLease', { turn_id: spawned.parentTurnId }))[0];
    const stopped = await p1.runner.interrupt({ commandId: 'stop-parent', conversationId, turnId: spawned.parentTurnId,
      expectedLeaseGeneration: String(lease.generation), reason: '用户请求中断当前 Turn 及其子执行。' });
    assert.equal(stopped.executingWindowAlive, undefined);
    await p1.coordinator.interruptSubtree({ sourceKey: 'stop-parent:child', childExecutionId: spawned.childExecutionId,
      reason: 'parent_turn_interrupted' }, { userStop: true });
    const [intent] = await rows(p1.app, 'EffectIntent', { id: spawned.spawnIntentId });
    assert.equal(intent.dispatch_state, 'receipt_written', '派生按已派生记录');
    assert.equal((await rows(p1.app, 'EffectReceipt', { attempt_id: intent.attempt_id }))[0]?.outcome, 'succeeded');
    await eventually(async () => (await rows(p1.app, 'Turn', { id: spawned.parentTurnId }))[0]?.status === 'terminated', 30_000, '父 Turn 未收尾');
    for (const turn of await rows(p1.app, 'Turn', { conversation_id: spawned.childConversationId })) {
      await eventually(async () => (await rows(p1.app, 'Turn', { id: turn.id }))[0]?.status === 'terminated', 30_000, '子 Turn 未收尾');
    }
    const [execution] = await rows(p1.app, 'ChildExecution', { id: spawned.childExecutionId });
    assert.equal(['starting', 'active', 'interrupting'].includes(String(execution.status)), false, `子执行仍为 ${execution.status}`);
    assert.equal(provider.calls, 0, '不调用模型');
    assert.equal(p1.owns(conversationId), false);
    assert.equal(p1.owns(spawned.childConversationId), false);
  } finally {
    await p1?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});


// 派发宿主仍存活时（它已派发派生、正在写派生回执），另一窗口的普通停止（不级联子 Agent）不替它记派生，
// 交给执行窗口并提示；自动恢复即使先记下，也不占住子对话。执行窗口随后照常写回执（按 attempt 去重）、驱动子 Agent、收尾父 Turn。
for (const variant of [
  { name: 'S1：停止窗口不服务该项目', folders: [PROJECT_ONE] },
  { name: 'S2：停止窗口也打开了该项目，启动时跑过子调度自动恢复', folders: [PROJECT_TWO.uri], coordinatorRecovery: true },
  { name: 'S3：停止窗口也打开了该项目，只跑了对话启动恢复', folders: [PROJECT_TWO.uri] },
  { name: 'S4：停止窗口也打开了该项目，停止前不做任何启动恢复', folders: [PROJECT_TWO.uri], skipRecovery: true }
]) {
  test(`${variant.name}：派发宿主存活、正在写派生回执时停止父 Turn，不抢先记派生，子 Agent 由执行窗口驱动（跨进程）`, { timeout: 180_000 }, async () => {
    const { outer, dataRoot } = await createIsolatedRoot('spawn-live');
    let p1; let child;
    try {
      const conversationId = 'conversation-spawn-live';
      const files = workerFiles(outer);
      const release = path.join(outer, 'origin-release');
      const resultFile = path.join(outer, 'origin-result.json');
      child = spawnWorker(dataRoot, { ...files.env, LIMCODE_DEAD_HOST_CONVERSATION: conversationId,
        LIMCODE_SPAWN_RELEASE: release, LIMCODE_SPAWN_RESULT: resultFile }, 'origin-spawn-paused');
      const spawned = await waitForWorkerJson(child, files.ready, 90_000);
      const provider = scriptedProvider([]);
      p1 = await openHost(dataRoot, provider, { folders: variant.folders, label: 'p1', children: true });
      if (!variant.skipRecovery) {
        await p1.app.recover();
        await p1.runner.recoverStartup();
      }
      if (variant.coordinatorRecovery) await p1.coordinator.recoverStartup();
      // The child scheduler's automatic recovery records the spawn through its own idempotent
      // transition; it must not keep the child Conversation whose Turn the live window leases.
      assert.equal(p1.owns(spawned.childConversationId), false, '恢复不占住子对话');
      const recordedByRecovery = (await rows(p1.app, 'EffectIntent', { id: spawned.spawnIntentId }))[0].dispatch_state === 'receipt_written';
      const [lease] = await rows(p1.app, 'ExecutionLease', { turn_id: spawned.parentTurnId });
      const stopped = await p1.runner.interrupt({ commandId: 'stop-parent', conversationId, turnId: spawned.parentTurnId,
        expectedLeaseGeneration: String(lease.generation), reason: '用户请求中断当前 Turn。' });
      const [intent] = await rows(p1.app, 'EffectIntent', { id: spawned.spawnIntentId });
      if (!recordedByRecovery) {
        assert.equal(stopped.executingWindowAlive, true, '交给执行窗口并提示');
        assert.equal(intent.dispatch_state, 'dispatched', '派发宿主存活：停止不记派生');
        assert.deepEqual(await rows(p1.app, 'EffectReceipt', { attempt_id: intent.attempt_id }), []);
      }
      assert.equal(p1.owns(spawned.childConversationId), false, '停止窗口不占住子对话');
      assert.equal(p1.owns(conversationId), false);

      await fs.writeFile(release, 'go\n', 'utf8');
      const result = await waitForWorkerJson(child, resultFile, 90_000);
      assert.equal(result.receiptError, null, `执行窗口写派生回执出错：${result.receiptError}`);
      assert.ok(result.childCalls >= 1, '子 Agent 被执行窗口驱动');
      assert.equal(result.parentTermination, 'interrupted');
      assert.deepEqual(result.runnerErrors, []);
      const [final] = await rows(p1.app, 'EffectIntent', { id: spawned.spawnIntentId });
      assert.equal((await rows(p1.app, 'EffectReceipt', { attempt_id: final.attempt_id })).length, 1, '只有一条派生回执');
      assert.deepEqual((await rows(p1.app, 'Turn', { conversation_id: spawned.childConversationId })).map((r) => r.status), ['terminated']);
      const [execution] = await rows(p1.app, 'ChildExecution', { id: spawned.childExecutionId });
      assert.equal(['starting', 'active', 'interrupting'].includes(String(execution.status)), false, `子执行仍为 ${execution.status}`);
      assert.equal(provider.calls, 0, '停止窗口不调用模型');
    } finally {
      await p1?.close();
      if (child) await fs.writeFile(workerFiles(outer).finish, 'finish\n', 'utf8').catch(() => undefined);
      if (child) await waitForExit(child, 60_000).catch(() => undefined);
      await stopChild(child);
      await fs.rm(outer, { recursive: true, force: true });
    }
  });
}

test('派发宿主已死、停止窗口服务该项目：普通停止把派生记为已派生后交还子对话，不占着不驱动；子调度随后接管并驱动子 Agent（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('spawn-dead-serving');
  let p1; let child;
  try {
    const conversationId = 'conversation-spawn-dead-serving';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, { ...files.env, LIMCODE_DEAD_HOST_CONVERSATION: conversationId }, 'origin-spawn-dispatched');
    const spawned = await waitForWorkerJson(child, files.ready, 90_000);
    child.kill('SIGKILL');
    await waitForExit(child, 30_000);
    let childCalls = 0;
    const provider = {
      providerId: PROVIDER_ID,
      async sendFullRequest(request, controls) {
        if (request.conversationId !== conversationId) childCalls += 1;
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: '完成' }] } });
      }
    };
    // No startup recovery: only the user's stop touches the dispatched spawn.
    p1 = await openHost(dataRoot, provider, { folders: [PROJECT_TWO.uri], label: 'p1', children: true });
    const [lease] = await rows(p1.app, 'ExecutionLease', { turn_id: spawned.parentTurnId });
    const stopped = await p1.runner.interrupt({ commandId: 'stop-parent', conversationId, turnId: spawned.parentTurnId,
      expectedLeaseGeneration: String(lease.generation), reason: '用户请求中断当前 Turn。' });
    assert.equal(stopped.executingWindowAlive, undefined);
    const [intent] = await rows(p1.app, 'EffectIntent', { id: spawned.spawnIntentId });
    assert.equal(intent.dispatch_state, 'receipt_written', '派发宿主已死：按已派生记录');
    assert.equal(p1.owns(spawned.childConversationId), false, '记完派生后交还子对话，不占着不驱动');
    await p1.coordinator.recoverStartup();
    await eventually(async () => childCalls >= 1, 30_000, '子调度没有接管并驱动子 Agent');
    await eventually(async () => (await rows(p1.app, 'Turn', { id: spawned.parentTurnId }))[0]?.status === 'terminated', 30_000, '父 Turn 未收尾');
  } finally {
    await p1?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

test('复审 X10：子调度的控制类认领已提交但随后出错时交还子 Turn 的租约（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('x10-child-claim');
  let p1; let child;
  try {
    const conversationId = 'conversation-x10';
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, { ...files.env, LIMCODE_DEAD_HOST_CONVERSATION: conversationId }, 'origin-child');
    const spawned = await waitForWorkerJson(child, files.ready, 90_000);
    child.kill('SIGKILL');
    await waitForExit(child, 30_000);
    p1 = await openHost(dataRoot, scriptedProvider([]), { folders: [PROJECT_ONE], label: 'p1', children: true });
    const claim = p1.app.turns.claimRecoveryExecution.bind(p1.app.turns);
    let injected = 0;
    p1.app.turns.claimRecoveryExecution = async (input) => {
      const claimed = await claim(input);
      if (input.turnId !== spawned.childTurnId) return claimed;
      injected += 1;
      throw new Error('认领已提交后读取失败（注入）');
    };
    await p1.coordinator.interruptSubtree({ sourceKey: 'user-stop-child', childExecutionId: spawned.childExecutionId,
      reason: '用户停止子 Agent' }, { userStop: true }).catch(() => undefined);
    assert.ok(injected >= 1, '子 Turn 的控制类认领被调用');
    const [lease] = await rows(p1.app, 'ExecutionLease', { turn_id: spawned.childTurnId });
    assert.ok(lease, '子 Turn 仍有租约');
    assert.notEqual(lease.host_boot_id, p1.app.database.hostBootId, '出错后本窗口不继续持有子 Turn 的租约');
    assert.equal((await rows(p1.app, 'Turn', { id: spawned.childTurnId }))[0]?.status, 'active');
  } finally {
    await p1?.close();
    await stopChild(child);
    await fs.rm(outer, { recursive: true, force: true });
  }
});

}

/** The executing window: starts a Turn whose MCP call never answers, then waits to be killed. */
async function runWorker(mode) {
  if (mode === 'origin-child') {
    await runChildOrigin();
    return;
  }
  if (mode === 'origin-parent-waits') {
    await runChildOrigin({ foreground: true });
    return;
  }
  if (mode === 'origin-spawn-dispatched') {
    await runSpawnDispatchedOrigin();
    return;
  }
  if (mode === 'origin-spawn-paused') {
    await runSpawnPausedOrigin();
    return;
  }
  if (mode !== 'origin') throw new Error(`Unknown worker ${mode}.`);
  const dataRoot = requiredEnv('LIMCODE_DEAD_HOST_DATA_ROOT');
  const conversationId = requiredEnv('LIMCODE_DEAD_HOST_CONVERSATION');
  const provider = scriptedProvider([
    { role: 'model', parts: [{ id: 'provider-hang-call', functionCall: { name: 'fixture_hang', args: {} } }] },
    { role: 'model', parts: [{ text: '已停止。' }] }
  ]);
  const host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO.uri], label: 'origin' });
  try {
    await createConversation(host.app, conversationId, PROJECT_TWO);
    const started = await host.runner.input({ commandId: `input-${conversationId}`, conversationId, text: '调用外部工具' });
    await eventually(async () => host.mcpCalls() > 0, 30_000, 'MCP 调用未派发');
    await writeJson(requiredEnv('LIMCODE_DEAD_HOST_READY'), {
      turnId: started.turnId,
      hostBootId: host.app.database.hostBootId
    });
    await waitForFile(requiredEnv('LIMCODE_DEAD_HOST_FINISH'), 300_000);
  } finally {
    await host.close();
  }
}

/** The executing window for a child: the parent spawns a child whose MCP call never answers. */
async function runChildOrigin(options = {}) {
  const dataRoot = requiredEnv('LIMCODE_DEAD_HOST_DATA_ROOT');
  const conversationId = requiredEnv('LIMCODE_DEAD_HOST_CONVERSATION');
  const parentReplies = [
    { role: 'model', parts: [{ id: 'provider-spawn', functionCall: {
      name: 'run_agent',
      args: { operation: 'spawn', taskName: 'hang', prompt: '调用外部工具', foregroundWaitMs: options.foreground ? 600_000 : 0 }
    } }] },
    { role: 'model', parts: [{ text: '子任务已开始。' }] }
  ];
  const childReplies = [
    { role: 'model', parts: [{ id: 'provider-child-hang', functionCall: { name: 'fixture_hang', args: {} } }] }
  ];
  let parentCalls = 0;
  let childCalls = 0;
  const provider = {
    providerId: PROVIDER_ID,
    async sendFullRequest(request, controls) {
      // A waiting parent's child keeps streaming until its window dies.
      if (options.foreground && request.conversationId !== conversationId) {
        childCalls += 1;
        return new Promise(() => {});
      }
      const content = request.conversationId === conversationId
        ? parentReplies[parentCalls++]
        : childReplies[childCalls++];
      if (!content) throw new Error('Unexpected Provider call.');
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content });
    }
  };
  const host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO.uri], label: 'origin', children: true });
  try {
    await createConversation(host.app, conversationId, PROJECT_TWO);
    await host.runner.input({ commandId: `input-${conversationId}`, conversationId, text: '派一个子 Agent' });
    if (options.foreground) {
      await eventually(async () => childCalls > 0, 60_000, '子 Agent 未开始');
    } else {
      await eventually(async () => host.mcpCalls() > 0, 60_000, '子 Agent 的 MCP 调用未派发');
    }
    const [execution] = await rows(host.app, 'ChildExecution', {});
    const [link] = await rows(host.app, 'ChildExecutionActiveTurnLink', { child_execution_id: execution.id });
    await writeJson(requiredEnv('LIMCODE_DEAD_HOST_READY'), {
      childExecutionId: execution.id,
      childConversationId: execution.child_conversation_id,
      childTurnId: link.turn_id
    });
    await waitForFile(requiredEnv('LIMCODE_DEAD_HOST_FINISH'), 300_000);
  } finally {
    await host.close();
  }
}

/** The executing window dies after dispatching a run_agent spawn and before writing its receipt. */
async function runSpawnDispatchedOrigin() {
  const dataRoot = requiredEnv('LIMCODE_DEAD_HOST_DATA_ROOT');
  const conversationId = requiredEnv('LIMCODE_DEAD_HOST_CONVERSATION');
  const provider = scriptedProvider([{ role: 'model', parts: [{ id: 'provider-spawn', functionCall: {
    name: 'run_agent', args: { operation: 'spawn', taskName: 'spawned', prompt: '子任务', foregroundWaitMs: 0 } } }] }]);
  const host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO.uri], label: 'origin', children: true });
  const effects = host.app.runtime.effects;
  const record = effects.recordEffectReceipt.bind(effects);
  effects.recordEffectReceipt = (input) => input.effectKind === 'subagent_spawn' ? new Promise(() => {}) : record(input);
  try {
    await createConversation(host.app, conversationId, PROJECT_TWO);
    const started = await host.runner.input({ commandId: `input-${conversationId}`, conversationId, text: '派一个子 Agent' });
    await eventually(async () => (await rows(host.app, 'EffectIntent', { effect_kind: 'subagent_spawn', dispatch_state: 'dispatched' })).length === 1,
      60_000, '派生未派发');
    const [intent] = await rows(host.app, 'EffectIntent', { effect_kind: 'subagent_spawn' });
    const [execution] = await rows(host.app, 'ChildExecution', {});
    await writeJson(requiredEnv('LIMCODE_DEAD_HOST_READY'), {
      parentTurnId: started.turnId,
      spawnIntentId: intent.id,
      childExecutionId: execution.id,
      childConversationId: execution.child_conversation_id
    });
    await waitForFile(requiredEnv('LIMCODE_DEAD_HOST_FINISH'), 300_000);
  } finally {
    await host.close();
  }
}

/**
 * The executing window stays alive after dispatching a run_agent spawn, with its spawn receipt write
 * held until the test releases it; then it continues normally (records the receipt, drives the child).
 */
async function runSpawnPausedOrigin() {
  const dataRoot = requiredEnv('LIMCODE_DEAD_HOST_DATA_ROOT');
  const conversationId = requiredEnv('LIMCODE_DEAD_HOST_CONVERSATION');
  let parentCalls = 0;
  let childCalls = 0;
  const provider = {
    providerId: PROVIDER_ID,
    async sendFullRequest(request, controls) {
      let content;
      if (request.conversationId === conversationId) {
        parentCalls += 1;
        content = parentCalls === 1
          ? { role: 'model', parts: [{ id: 'provider-spawn', functionCall: { name: 'run_agent',
            args: { operation: 'spawn', taskName: 'spawned', prompt: '子任务', foregroundWaitMs: 0 } } }] }
          : { role: 'model', parts: [{ text: '父继续' }] };
      } else {
        childCalls += 1;
        content = { role: 'model', parts: [{ text: '子任务完成' }] };
      }
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content });
    }
  };
  const host = await openHost(dataRoot, provider, { folders: [PROJECT_TWO.uri], label: 'origin', children: true });
  const effects = host.app.runtime.effects;
  const record = effects.recordEffectReceipt.bind(effects);
  let receiptError = null;
  effects.recordEffectReceipt = async (input) => {
    if (input.effectKind !== 'subagent_spawn') return record(input);
    await waitForFile(requiredEnv('LIMCODE_SPAWN_RELEASE'), 300_000);
    try {
      return await record(input);
    } catch (error) {
      receiptError = String(error?.stack ?? error);
      throw error;
    }
  };
  try {
    await createConversation(host.app, conversationId, PROJECT_TWO);
    const started = await host.runner.input({ commandId: `input-${conversationId}`, conversationId, text: '派一个子 Agent' });
    await eventually(async () => (await rows(host.app, 'EffectIntent', { effect_kind: 'subagent_spawn', dispatch_state: 'dispatched' })).length === 1,
      60_000, '派生未派发');
    const [intent] = await rows(host.app, 'EffectIntent', { effect_kind: 'subagent_spawn' });
    const [execution] = await rows(host.app, 'ChildExecution', {});
    await writeJson(requiredEnv('LIMCODE_DEAD_HOST_READY'), {
      parentTurnId: started.turnId,
      spawnIntentId: intent.id,
      childExecutionId: execution.id,
      childConversationId: execution.child_conversation_id
    });
    await waitForFile(requiredEnv('LIMCODE_SPAWN_RELEASE'), 300_000);
    await eventually(async () => (await rows(host.app, 'Turn', { id: started.turnId }))[0]?.status === 'terminated', 30_000, '父 Turn 未收尾');
    await eventually(async () => childCalls >= 1
      && (await rows(host.app, 'Turn', { conversation_id: execution.child_conversation_id })).every((turn) => turn.status === 'terminated'),
    30_000, '子 Agent 未被驱动完成').catch(() => undefined);
    await host.runner.waitForIdle();
    await writeJson(requiredEnv('LIMCODE_SPAWN_RESULT'), {
      receiptError,
      parentTermination: (await rows(host.app, 'TurnTermination', { turn_id: started.turnId }))[0]?.terminal_status ?? null,
      childCalls,
      runnerErrors: host.runnerErrors.map((entry) => String(entry.error?.message ?? entry.error))
    });
    await waitForFile(requiredEnv('LIMCODE_DEAD_HOST_FINISH'), 300_000);
  } finally {
    await host.close();
  }
}

async function openHost(dataRoot, provider, options) {
  const folders = [...options.folders];
  let mcpCalls = 0;
  let coordinator;
  const app = await kernel.ReliableKernelApplication.open(
    new kernel.RootAuthority(() => dataRoot),
    fixtureDependencies(provider, () => { mcpCalls += 1; }, options.children ? () => coordinator : undefined)
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
      deadHostEffects: app.phaseDRecovery
    });
  }
  const runnerErrors = [];
  const runner = new ReliableConversationRunner(
    app,
    `${options.label}:${app.database.hostBootId}`,
    (error, context) => runnerErrors.push({ error, context })
  );
  const eligibility = (conversationId) => evaluateConversationHostEligibility({
    database: app.database,
    contentStore: app.contentStore,
    workspaceFolderUris: () => folders,
    workEnvironments: async () => []
  }, conversationId);
  app.database.conversationOwners.setClaimEligibilityProbe(async (conversationId) =>
    (await eligibility(conversationId)).eligible);
  let closed = false;
  return {
    app,
    runner,
    coordinator,
    runnerErrors,
    folders,
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

/** The deletion transaction alone (the last step of the delete command): it never settles live work. */
function deleteTransaction(host, conversationId) {
  return host.app.database.conversationOwners.run(conversationId, () =>
    host.app.conversationDeletion.delete(conversationId));
}

/** VscodeReliableKernelApplicationFacade.deleteConversation: stops the tree's work, then deletes it. */
function deleteCommand(host, conversationId) {
  return stopAndDeleteConversation({
    application: host.app,
    conversations: host.runner,
    childAgents: host.coordinator ?? { interruptSubtree() { throw new Error('这个窗口没有子 Agent 调度。'); } },
    pollMs: 100
  }, { conversationId, requestId: `delete-${conversationId}` });
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
    ...projectFolderAssignmentSteps({ conversationId, folder: project, now })
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

function fixtureDependencies(provider, onMcpCall, coordinator) {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: {
            content: JSON.stringify({ providerConfigId: provider.providerId, modelId: 'dead-host-model' })
          },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: {
                providerConfigId: provider.providerId,
                provider: 'openai-compatible',
                modelId: 'dead-host-model',
                retryPolicy: { enabled: false, maxRetries: 0 }
              },
              modelProfile: {
                compressionThresholdTokens: 100_000,
                contextWindowTokens: 128_000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              toolPolicy: {
                id: 'dead-host-tools',
                allowedTools: coordinator ? ['run_agent'] : [],
                preset: 'yolo',
                toolConfigs: {},
                sourceConfigs: { fixture: { enabled: true } }
              },
              planReviewPolicy: { mode: 'off' },
              systemPrompt: { id: 'dead-host-prompt', text: '' },
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
          definitions() { return coordinator ? [hangingMcpTool, runAgentTool] : [hangingMcpTool]; },
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

async function createIsolatedRoot(label) {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-dead-host-${label}-`));
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

function workerFiles(outer) {
  const files = { ready: path.join(outer, 'origin-ready.json'), finish: path.join(outer, 'origin-finish') };
  return {
    ...files,
    env: { LIMCODE_DEAD_HOST_READY: files.ready, LIMCODE_DEAD_HOST_FINISH: files.finish }
  };
}

function spawnWorker(dataRoot, environment, mode = 'origin') {
  const child = childProcess.spawn(process.execPath, [TEST_FILE], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...environment,
      LIMCODE_DEAD_HOST_WORKER: mode,
      LIMCODE_DEAD_HOST_DATA_ROOT: dataRoot
    },
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
  await waitForExit(child, 15_000).catch(() => undefined);
}

function waitForExit(child, timeoutMs, rejectNonZero = false) {
  return new Promise((resolve, reject) => {
    const settle = (code, signal) => {
      if (rejectNonZero && code !== 0) {
        reject(new Error(`worker failed (code=${code}, signal=${signal})\n${child.output?.stdout ?? ''}\n${child.output?.stderr ?? ''}`));
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
      reject(new Error(`worker timed out after ${timeoutMs}ms\n${child.output?.stdout ?? ''}\n${child.output?.stderr ?? ''}`));
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
