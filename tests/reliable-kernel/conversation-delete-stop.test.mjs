import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 删除规则：先停再删（conversationDeleteCommand）。删除范围里正在进行的工作用现有的用户停止路径停下，
// 等到没有活动工作，再在删除事务里收尾投递并删除；停不下来时不删，照实说明。
const root = process.cwd();
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const load = (relative) => import(pathToFileURL(path.join(root, 'dist/extension', relative)).href);
const kernel = await load('backend/reliableKernel/index.js');
const { emptyConversationContextHandleStateStep } = await load('backend/reliableKernel/conversationContextHandleState.js');
const { ReliableConversationRunner } = await load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { ReliableChildAgentCoordinator } = await load('backend/reliableKernel/childAgentCoordinator.js');
const { createRuntimeDeliveryWakeHandler } = await load('backend/application/reliableKernel/runtimeDeliveryWakeHandler.js');
const { evaluateConversationHostEligibility } = await load('backend/application/reliableKernel/conversationHostEligibility.js');
const { projectFolderAssignmentSteps } = await load('backend/reliableKernel/conversationProject.js');
const { preparedContentObjectSteps } = await load('backend/reliableKernel/contentObjectTransaction.js');
const { DEAD_HOST_STOP_REASON } = await load('backend/reliableKernel/phaseDRecovery.js');
const { askUserTool } = await load('backend/world/modules/tools/definitions/askUser/index.js');
const { runAgentTool } = await load('backend/world/modules/tools/definitions/runAgent/index.js');
const {
  stopAndDeleteConversation,
  isConversationDeleteIncompleteError,
  CHILD_CONVERSATION_DELETE_REASON,
  CONVERSATION_DELETE_STOP_REASON
} = await load('backend/application/reliableKernel/conversationDeleteCommand.js');

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

test('删除有活动 Turn 和多层活动子 Agent 的树：先停再删，调用 Provider 的次数不再增加，子与孙的答复一起收尾', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('tree');
  const roles = new Map([['parent', 'parent']]);
  const provider = scriptedProvider((request) => {
    let role = roles.get(request.conversationId);
    if (!role) {
      role = roles.size === 1 ? 'child' : 'grandchild';
      roles.set(request.conversationId, role);
    }
    if (role === 'parent') return spawnCall('spawn-child', 'child', '子任务', 600_000);
    if (role === 'child') return spawnCall('spawn-grandchild', 'grandchild', '孙任务', 600_000);
    return 'hang';
  });
  const p1 = await openHost(dataRoot, provider, { label: 'p1' });
  try {
    await createConversation(p1.app, 'parent');
    await p1.runner.input({ commandId: 'input-parent', conversationId: 'parent', text: '派子 Agent' });
    await eventually(async () => provider.calls.some((call) => roles.get(call.conversationId) === 'grandchild'), 60_000, '孙 Agent 未开始');
    assert.equal((await rows(p1.app, 'Turn', { status: 'active' })).length, 3, '父、子、孙三个 Turn 都在进行');
    assert.equal((await rows(p1.app, 'ChildExecution', {})).length, 2);
    const callsBefore = provider.calls.length;
    const progress = [];
    const deleted = await deleteCommand(p1, 'parent', { onProgress: (entry) => progress.push(entry.kind) });
    assert.deepEqual(progress, ['stopping'], '需要停止时只提示一次');
    assert.deepEqual([...deleted.deletedConversationIds].sort(), [...roles.keys()].sort(), '整棵树一起删除');
    await quiet(p1, 1_500);
    assert.equal(provider.calls.length, callsBefore, '先停再删：Provider 调用次数不再增加');
    assert.equal((await rows(p1.app, 'Conversation', {})).length, 0);
    assert.equal((await rows(p1.app, 'ChildExecution', {})).length, 0);
    await assertNoPendingResults(p1.app);
    assert.deepEqual(errors(p1), []);
  } finally {
    await p1.close();
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

test('删除正在等提问回答的对话：提问随 Turn 停止关闭，然后删除', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('ask');
  const provider = scriptedProvider(() => askCall('ask-1', '要继续吗？'));
  const p1 = await openHost(dataRoot, provider, { label: 'p1' });
  try {
    await createConversation(p1.app, 'asking');
    await p1.runner.input({ commandId: 'input-ask', conversationId: 'asking', text: '问我一个问题' });
    await eventually(async () => (await rows(p1.app, 'InteractionRequest', { status: 'pending' })).length === 1, 30_000, '提问未进入等待');
    const callsBefore = provider.calls.length;
    const deleted = await deleteCommand(p1, 'asking');
    assert.deepEqual(deleted.deletedConversationIds, ['asking']);
    await quiet(p1, 1_000);
    assert.equal(provider.calls.length, callsBefore);
    assert.deepEqual(await rows(p1.app, 'InteractionRequest', {}), [], '提问随对话删除');
    await assertNoPendingResults(p1.app);
    assert.deepEqual(errors(p1), []);
  } finally {
    await p1.close();
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

test('删除有后台进程的对话：进程被终止，完成通知不再续跑，然后删除', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('process');
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
    const [processRow] = await rows(p1.app, 'Process', {});
    assert.equal(processRow?.status, 'running', '后台进程在运行');
    const pid = Number(processRow.child_pid ?? processRow.wrapper_pid);
    assert.ok(pid > 0 && alive(pid));
    const callsBefore = provider.calls.length;
    const deleted = await deleteCommand(p1, 'with-process');
    assert.deepEqual(deleted.deletedConversationIds, ['with-process']);
    const [after] = await rows(p1.app, 'Process', { id: processRow.id });
    assert.notEqual(after.status, 'running', '进程已终止');
    await eventually(async () => !alive(pid), 10_000, '进程仍在运行');
    await quiet(p1, 1_500);
    assert.equal(provider.calls.length, callsBefore, '进程的完成通知没有开启新的回合');
    await assertNoPendingResults(p1.app);
    assert.deepEqual((await rows(p1.app, 'ProcessCompletionDispatch', {})).filter((row) => ['pending', 'claimed'].includes(row.state)), []);
    assert.deepEqual(errors(p1), []);
  } finally {
    await p1.close();
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

test('删除有排队消息的对话：排队消息先取消，不被准入；当前 Turn 停止后删除', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('queued');
  const provider = scriptedProvider(() => 'hang');
  const p1 = await openHost(dataRoot, provider, { label: 'p1' });
  try {
    await createConversation(p1.app, 'queued');
    await p1.runner.input({ commandId: 'input-first', conversationId: 'queued', text: '第一条消息' });
    await eventually(async () => provider.calls.length === 1, 30_000, '第一条消息未调用模型');
    const second = await p1.runner.input({ commandId: 'input-second', conversationId: 'queued', text: '排队的第二条消息' });
    assert.notEqual(second.admitted, true, '第二条消息排队');
    assert.equal((await rows(p1.app, 'TurnIntent', { conversation_id: 'queued', state: 'queued' })).length, 1);
    const deleted = await deleteCommand(p1, 'queued');
    assert.deepEqual(deleted.deletedConversationIds, ['queued']);
    await quiet(p1, 1_500);
    assert.equal(provider.calls.length, 1, '排队消息没有被准入执行');
    await assertNoPendingResults(p1.app);
    assert.deepEqual(errors(p1), []);
  } finally {
    await p1.close();
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

test('只删子对话：父 Turn 拿到“用户删除子任务对话”的结果并继续；父对话里子 Agent 没接收的答复被收尾', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('child-only');
  const parentRequests = [];
  let background = false;
  const provider = scriptedProvider((request) => {
    if (request.conversationId !== 'parent' && request.conversationId !== 'parent-bg') {
      return background ? { role: 'model', parts: [{ text: 'CHILD_ANSWER_7788' }] } : 'hang';
    }
    parentRequests.push(request);
    const rounds = parentRequests.filter((entry) => entry.conversationId === request.conversationId).length;
    if (rounds === 1) return spawnCall('spawn-1', 'child', '子任务', background ? 0 : 600_000);
    return { role: 'model', parts: [{ text: `PARENT_ROUND_${rounds}` }] };
  });
  const p1 = await openHost(dataRoot, provider, { label: 'p1' });
  try {
    // 父 Turn 在前台等子 Agent：删子对话后，父的等待以删除原因取消，父 Turn 拿这个结果继续。
    await createConversation(p1.app, 'parent');
    const parentTurn = await p1.runner.input({ commandId: 'input-parent', conversationId: 'parent', text: '派子 Agent 并等它' });
    await eventually(async () => provider.calls.some((call) => call.conversationId !== 'parent'), 60_000, '子 Agent 未开始');
    const [execution] = await rows(p1.app, 'ChildExecution', {});
    const childConversationId = String(execution.child_conversation_id);
    const deleted = await deleteCommand(p1, childConversationId);
    assert.deepEqual(deleted.deletedConversationIds, [childConversationId], '只删子对话');
    await eventually(async () => (await rows(p1.app, 'Turn', { id: parentTurn.turnId }))[0]?.status === 'terminated', 30_000, '父 Turn 未继续到结束');
    const [parentTermination] = await rows(p1.app, 'TurnTermination', { turn_id: parentTurn.turnId });
    assert.equal(parentTermination?.terminal_status, 'completed',
      `父 Turn 继续并完成：${JSON.stringify(parentTermination, (_key, value) => typeof value === 'bigint' ? String(value) : value)} ${errors(p1).join('\n')}`);
    const continued = parentRequests.filter((request) => request.conversationId === 'parent');
    // 子 Agent 停下时的部分答复若赶上仍在跑的父 Turn，会被它一并接收，因此可能多一次调用；第一次继续一定带着删除原因。
    assert.ok(continued.length >= 2, '父 Turn 拿到结果后继续调用模型');
    assert.ok(JSON.stringify(continued[1].context).includes(CHILD_CONVERSATION_DELETE_REASON), '父的等待结果写明是用户删除了子任务对话');
    assert.equal((await rows(p1.app, 'Conversation', { id: 'parent' })).length, 1, '父对话保留');
    await assertNoPendingResults(p1.app);

    // 父 Turn 已结束、子 Agent 的答复等着父对话下一轮接收：删子对话后这条答复收尾，父对话以后不会收到。
    background = true;
    await createConversation(p1.app, 'parent-bg');
    await p1.runner.input({ commandId: 'input-parent-bg', conversationId: 'parent-bg', text: '派一个后台子 Agent' });
    const answer = await eventually(async () => {
      const pending = await rows(p1.app, 'RuntimeDelivery', { target_conversation_id: 'parent-bg', state: 'pending' });
      return pending.length === 1 ? pending[0] : undefined;
    }, 60_000, '子 Agent 的答复没有投给父对话');
    const [inbox] = await rows(p1.app, 'RuntimeInboxItem', { id: answer.inbox_item_id });
    assert.equal(inbox.source_kind, 'answer_submission');
    const bgChild = (await rows(p1.app, 'ChildExecution', {})).map((row) => String(row.child_conversation_id))
      .find((id) => id !== childConversationId);
    await p1.runner.waitForIdle();
    const deletedBg = await deleteCommand(p1, bgChild);
    assert.deepEqual(deletedBg.deletedConversationIds, [bgChild]);
    const [settled] = await rows(p1.app, 'RuntimeDelivery', { id: answer.id });
    assert.deepEqual([settled.state, settled.failure_reason], ['failed', 'source-gone'], '没接收的答复按子任务已删除收尾');
    await p1.runner.input({ commandId: 'input-parent-bg-2', conversationId: 'parent-bg', text: '继续' });
    await eventually(async () => parentRequests.filter((request) => request.conversationId === 'parent-bg').length >= 3, 30_000, '父对话下一轮未开始');
    assert.equal(JSON.stringify(parentRequests.at(-1).context).includes('CHILD_ANSWER_7788'), false, '父对话不再收到已删除子任务的答复');
    await p1.runner.waitForIdle();
    await assertNoPendingResults(p1.app);
    assert.deepEqual(errors(p1), []);
  } finally {
    await p1.close();
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

test('外面投进删除范围的投递（后台进程完成通知）按 target-gone 收尾，不挡住删除', { timeout: 120_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('inbound');
  const provider = scriptedProvider(() => ({ role: 'model', parts: [{ text: '好的。' }] }));
  const p1 = await openHost(dataRoot, provider, { label: 'p1' });
  try {
    await createConversation(p1.app, 'notified');
    const { turnId } = await p1.runner.input({ commandId: 'input-notified', conversationId: 'notified', text: '你好' });
    await eventually(async () => (await rows(p1.app, 'Turn', { id: turnId }))[0]?.status === 'terminated', 30_000, 'Turn 未结束');
    await p1.runner.waitForIdle();
    const deliveryId = String((await pendingProcessDelivery(p1.app, 'finished-process', 'notified', turnId)).delivery.id);
    assert.equal((await rows(p1.app, 'RuntimeDelivery', { id: deliveryId }))[0]?.state, 'pending', '进程完成通知等着下一轮');
    const deleted = await deleteCommand(p1, 'notified');
    assert.deepEqual(deleted.deletedConversationIds, ['notified']);
    const [settled] = await rows(p1.app, 'RuntimeDelivery', { id: deliveryId });
    assert.deepEqual([settled.state, settled.failure_reason], ['failed', 'target-gone']);
    assert.equal((await rows(p1.app, 'RuntimeInboxItem', { id: 'finished-process' })).length, 1, 'Inbox 事实保留');
    await assertNoPendingResults(p1.app);
    assert.deepEqual(errors(p1), []);
  } finally {
    await p1.close();
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

test('另一个窗口正在执行时从本窗口删除：由执行窗口停止，之后删除成功（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('live-owner');
  let child;
  let p1;
  try {
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, files.env, 'origin-hang');
    const { turnId, hostBootId } = await waitForWorkerJson(child, files.ready, 90_000);
    p1 = await openHost(dataRoot, scriptedProvider(() => { throw new Error('本窗口不应调用模型'); }), { label: 'p1', folders: [OTHER_PROJECT] });
    const [lease] = await rows(p1.app, 'ExecutionLease', { turn_id: turnId });
    assert.equal(lease.host_boot_id, hostBootId, '执行窗口持有租约');
    const deleted = await deleteCommand(p1, 'hanging');
    assert.deepEqual(deleted.deletedConversationIds, ['hanging']);
    const receipts = await rows(p1.app, 'EffectReceipt', {});
    for (const receipt of receipts) {
      if (!receipt.response_object_id) continue;
      assert.notEqual((await readContentJson(p1.app, receipt.response_object_id)).reason, DEAD_HOST_STOP_REASON,
        '存活的执行窗口自己停止，本窗口不写“意外退出”的结果');
    }
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

test('执行窗口已死、工具执行到一半：删除走用户停止的 outcome_unknown，然后删除（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('dead-owner');
  let child;
  let p1;
  try {
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, files.env, 'origin-hang');
    const { turnId } = await waitForWorkerJson(child, files.ready, 90_000);
    child.kill('SIGKILL');
    await waitForExit(child, 30_000);
    p1 = await openHost(dataRoot, scriptedProvider(() => { throw new Error('本窗口不应调用模型'); }), { label: 'p1', folders: [OTHER_PROJECT] });
    const [call] = await rows(p1.app, 'ToolCall', { turn_id: turnId, status: 'executing' });
    const [operation] = await rows(p1.app, 'Operation', { tool_call_id: call.id });
    const [attempt] = await rows(p1.app, 'Attempt', { operation_id: operation.id });
    const deleted = await deleteCommand(p1, 'hanging');
    assert.deepEqual(deleted.deletedConversationIds, ['hanging']);
    const [receipt] = await rows(p1.app, 'EffectReceipt', { attempt_id: attempt.id });
    assert.equal(receipt?.outcome, 'outcome_unknown', '已派发的工具按结果未知收尾');
    assert.equal((await readContentJson(p1.app, receipt.response_object_id)).reason, DEAD_HOST_STOP_REASON);
    await assertNoPendingResults(p1.app);
    assert.deepEqual(errors(p1), []);
  } finally {
    await p1?.close();
    await stopChild(child);
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

test('超时：执行窗口存活但停不下来时不删，提示哪个任务在哪个窗口没停下、停止请求已发出；它停下后再删一次成功（跨进程）', { timeout: 180_000 }, async () => {
  const { outer, dataRoot } = await createIsolatedRoot('timeout');
  let child;
  let p1;
  try {
    const files = workerFiles(outer);
    child = spawnWorker(dataRoot, files.env, 'origin-hang');
    const { turnId } = await waitForWorkerJson(child, files.ready, 90_000);
    p1 = await openHost(dataRoot, scriptedProvider(() => { throw new Error('本窗口不应调用模型'); }), { label: 'p1', folders: [OTHER_PROJECT] });
    // 执行窗口还活着，但不再处理任何事（例如工具迟迟不返回）。
    child.kill('SIGSTOP');
    const started = Date.now();
    const error = await deleteCommand(p1, 'hanging', { timeoutMs: 2_500 }).then(() => null, (reason) => reason);
    assert.ok(isConversationDeleteIncompleteError(error), `应为没能完成：${error?.stack ?? error}`);
    assert.ok(Date.now() - started >= 2_500, '等到上限才放弃');
    assert.match(error.message, /^删除没有完成：/);
    assert.ok(error.message.includes(`对话「hanging」的回合仍在另一个窗口（进程 ${child.pid}）中执行`), error.message);
    assert.ok(error.message.includes('工具 fixture_hang 还没有返回'), error.message);
    assert.ok(error.message.endsWith('停止请求已经发出，等它停下后再删除一次。'), error.message);
    assert.equal((await rows(p1.app, 'Conversation', { id: 'hanging' })).length, 1, '没能完成时不删');
    assert.equal((await rows(p1.app, 'Turn', { id: turnId }))[0].status, 'active');
    child.kill('SIGCONT');
    await eventually(async () => (await rows(p1.app, 'Turn', { id: turnId }))[0]?.status === 'terminated', 60_000, '执行窗口未处理停止请求');
    const deleted = await deleteCommand(p1, 'hanging');
    assert.deepEqual(deleted.deletedConversationIds, ['hanging']);
    await assertNoPendingResults(p1.app);
    assert.deepEqual(errors(p1), []);
    await fs.writeFile(files.finish, 'finish\n', 'utf8');
    await waitForExit(child, 90_000, true);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGCONT');
    await p1?.close();
    await stopChild(child);
  }
  assertForeignKeysClean(dataRoot);
  await fs.rm(outer, { recursive: true, force: true });
});

}

async function runWorker(mode) {
  if (mode !== 'origin-hang') throw new Error(`Unknown worker ${mode}.`);
  const dataRoot = requiredEnv('LIMCODE_DELETE_STOP_DATA_ROOT');
  let calls = 0;
  const provider = scriptedProvider(() => {
    calls += 1;
    if (calls === 1) return { role: 'model', parts: [{ id: 'provider-hang-call', functionCall: { name: 'fixture_hang', args: {} } }] };
    return { role: 'model', parts: [{ text: '已停止。' }] };
  });
  let mcpCalls = 0;
  const host = await openHost(dataRoot, provider, { label: 'origin', onMcpCall: () => { mcpCalls += 1; } });
  try {
    await createConversation(host.app, 'hanging');
    const started = await host.runner.input({ commandId: 'input-hanging', conversationId: 'hanging', text: '调用外部工具' });
    await eventually(async () => mcpCalls > 0, 30_000, 'MCP 调用未派发');
    await writeJson(requiredEnv('LIMCODE_DELETE_STOP_READY'), { turnId: started.turnId, hostBootId: host.app.database.hostBootId });
    await waitForFile(requiredEnv('LIMCODE_DELETE_STOP_FINISH'), 300_000);
  } finally {
    await host.close();
  }
}

/** The facade's deleteConversation (VscodeReliableKernelApplicationFacade), without the notification. */
function deleteCommand(host, conversationId, options = {}) {
  return stopAndDeleteConversation({
    application: host.app,
    conversations: host.runner,
    childAgents: host.coordinator,
    pollMs: 100,
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
    emptyConversationContextHandleStateStep(conversationId, now),
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

void CONVERSATION_DELETE_STOP_REASON;
