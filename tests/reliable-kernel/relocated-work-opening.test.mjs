// Supplement E of the data-root relocation: the unfinished work a relocation carried away is listed
// in the old directory's moved notice (computed on the snapshot that moved), and opening a data set
// of the old directory settles it (closed as aborted) only after the user chose to keep using the
// old directory, right after its Runtime opened with its convergence held and before anything runs:
// the same order as VscodeReliableKernelApplicationFacade.open and the product runtime (the Runtime
// here is the kernel application with the production Runner, eligibility probe and recovery order).
// A crash in the middle of settling is continued at the next open; the settlement is recorded once.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const root = process.cwd();
const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT ?? path.join(root, 'dist/extension');
const load = (relative) => import(pathToFileURL(path.join(compiled, relative)).href);
const kernel = await load('backend/reliableKernel/index.js');
const { ReliableConversationRunner } = await load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { evaluateConversationHostEligibility } = await load('backend/application/reliableKernel/conversationHostEligibility.js');
const { projectFolderAssignmentSteps } = await load('backend/reliableKernel/conversationProject.js');
const { writeTool } = await load('backend/world/modules/tools/definitions/write/index.js');
const { relocatedWorkBeforeOpen, settleRelocatedWorkOnOpen } = await load('backend/application/reliableKernel/relocatedWorkOpening.js');
const { RELOCATED_WORK_REPORTED_ONLY } = await load('backend/application/reliableKernel/relocatedWorkSettlement.js');
const { preparedContentObjectSteps } = await load('backend/reliableKernel/contentObjectTransaction.js');
const reloc = await import(pathToFileURL(path.join(root, 'tests/reliable-kernel/runtime-data-root-relocation-fixture.mjs')).href);
const { relocation, rootAuthority } = reloc;

const PROVIDER_ID = 'relocated-opening-provider';
const PROJECT = { uri: 'file:///workspace/relocated-opening', name: '迁走项目' };
const ELSEWHERE = 'file:///workspace/elsewhere';
const INSTALLATION_A = '/installations/a';
const INSTALLATION_B = '/installations/b';
const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);
const TEST_FILE = fileURLToPath(import.meta.url);

if (process.env.LIMCODE_RELOCATED_OPENING_WORKER === 'settle-killed') {
  // The next open of the old directory, killed in the middle of settling.
  const { configurationRootPath, dataRoot } = JSON.parse(process.env.LIMCODE_RELOCATED_OPENING_INPUT);
  const opening = await relocatedWorkBeforeOpen(placementOf(configurationRootPath));
  const host = await openHost(dataRoot, countingProvider(), { folders: [PROJECT.uri], label: 'killed', holdRuntimeConvergence: true });
  // Killed after the stop request is written and the control lease taken, before the Turn is closed.
  host.app.agentLoop.terminateRequested = async () => { process.kill(process.pid, 'SIGKILL'); await new Promise(() => {}); };
  await settleRelocatedWorkOnOpen(host.app, opening, INSTALLATION_B);
  process.exit(3);
}

test('RVX（其它安装打开旧目录）：迁移完成时清单写进“已迁走”标记；没有同意时拒绝打开（运行时不打开）；选“在这里继续”之后先收尾再恢复，旧目录 Provider 0 次，收尾结果只记一次', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const { conversationId, turnId } = await admitUnstartedTurn(fixture);
  const { target, relocationId } = await relocateOldHome(fixture);
  const notice = await relocation.readDataRootMovedNotice(fixture.root);
  assert.equal(notice.carriedWork.dataSets.length, 1, '只有真正迁走、带着未完成任务的库');
  const [entry] = notice.carriedWork.dataSets;
  assert.equal(entry.id, 'default');
  assert.equal(entry.dataSetId, fixture.current.binding.dataSetId);
  assert.deepEqual(entry.settlement, { state: 'pending' });
  assert.deepEqual(entry.inventory.conversations.map((item) => [item.conversationId, item.activeTurnIds]), [[conversationId, [turnId]]]);

  // "暂不打开" (or any open before a decision): refused before the Runtime opens, nothing changes.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(relocatedWorkBeforeOpen(placementOf(fixture.root)), (error) => error.reason === 'moved-work' && /迁走时还有没完成的任务/.test(error.message));
  }
  assert.deepEqual((await relocation.readDataRootMovedNotice(fixture.root)).carriedWork, notice.carriedWork);
  assert.equal(await relocation.clearDataRootMovedNotice(fixture.root, INSTALLATION_A), false, '还有没收尾的任务时标记保留');
  // Another data set under that id now (reset or replaced since): none of that work is in it.
  const noticeFile = path.join(fixture.root, relocation.DATA_ROOT_MOVED_NOTICE_FILE);
  const written = await fs.readFile(noticeFile, 'utf8');
  const replaced = JSON.parse(written);
  replaced.carriedWork.dataSets[0].dataSetId = 'data-set-replaced-since';
  await fs.writeFile(noticeFile, JSON.stringify(replaced));
  assert.equal(await relocatedWorkBeforeOpen(placementOf(fixture.root)), undefined, '换成了别的库：里面没有这些任务，照常打开');
  await fs.writeFile(noticeFile, written);

  // "在这里继续": the consent is recorded, then the open settles before anything runs.
  assert.equal(await relocation.consentToDataRootMovedWork(fixture.root, 'another-relocation', INSTALLATION_B), false, '只认同一次迁移的标记');
  assert.equal(await relocation.consentToDataRootMovedWork(fixture.root, relocationId, INSTALLATION_B), true);
  const provider = countingProvider();
  await openSettleAndRecover(fixture, provider, INSTALLATION_B);
  assert.equal(provider.calls.length, 0, '旧目录不再调用模型');
  assert.equal((await turnRow(fixture, turnId)).status, 'terminated');
  const settled = (await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets[0].settlement;
  assert.equal(settled.state, 'settled');
  assert.equal(settled.by, INSTALLATION_B);
  assert.equal(settled.result.counts.turnsStopped, 1);
  assert.deepEqual([settled.result.live, settled.result.unsettled], [[], []]);
  assert.equal(await relocation.recordDataRootMovedWorkSettled(fixture.root, relocationId, 'default', INSTALLATION_A, { counts: {}, live: [], unsettled: [] }), false, '只记一次');
  assert.equal(await relocation.consentToDataRootMovedWork(fixture.root, relocationId, INSTALLATION_A), false, '已收尾的不再同意');
  assert.ok(target);
});

test('“回到旧目录”：发起安装确认即同意，打开时直接收尾（不再询问）；重开幂等：已收尾后不再收尾、照常打开也不执行；本安装的标记此时才清掉', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const { turnId } = await admitUnstartedTurn(fixture);
  const { relocationId } = await relocateOldHome(fixture);
  // What returnToPreviousDataRoot records once the user confirmed.
  assert.equal(await relocation.consentToDataRootMovedWork(fixture.root, relocationId, INSTALLATION_A), true);
  const first = countingProvider();
  await openSettleAndRecover(fixture, first, INSTALLATION_A);
  assert.equal(first.calls.length, 0);
  const notice = await relocation.readDataRootMovedNotice(fixture.root);
  assert.equal(notice.carriedWork.dataSets[0].settlement.state, 'settled');

  // Reopened: nothing left to settle, nothing runs, nothing recorded again.
  assert.equal(await relocatedWorkBeforeOpen(placementOf(fixture.root)), undefined);
  const facts = await turnRow(fixture, turnId);
  const again = countingProvider();
  const host = await openHost(dataRootOf(fixture), again, { folders: [PROJECT.uri], label: 'reopened' });
  try {
    await host.recover();
    await quiet();
  } finally { await host.close(); }
  assert.equal(again.calls.length, 0);
  assert.deepEqual(await turnRow(fixture, turnId), facts);
  assert.deepEqual(await relocation.readDataRootMovedNotice(fixture.root), notice);
  assert.equal(await relocation.clearDataRootMovedNotice(fixture.root, INSTALLATION_A), true, '都收尾之后，本安装回到旧目录时照常清掉自己的标记');
});

test('收尾中途 SIGKILL：同意保留，下次打开先续完收尾，期间没有执行任何工作（没有模型请求），之后照常恢复也不执行', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const { conversationId, turnId } = await admitUnstartedTurn(fixture);
  const { relocationId } = await relocateOldHome(fixture);
  assert.equal(await relocation.consentToDataRootMovedWork(fixture.root, relocationId, INSTALLATION_B), true);
  const killed = await runWorker('settle-killed', { configurationRootPath: fixture.root, dataRoot: dataRootOf(fixture) });
  assert.equal(killed.signal, 'SIGKILL', `收尾写下停止请求之后被杀（退出码 ${killed.code}）：${killed.output.slice(-2000)}`);
  assert.equal((await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets[0].settlement.state, 'consented', '收尾没有记下，同意还在');
  assert.equal((await turnRow(fixture, turnId)).status, 'active', '前提：收尾确实没做完');
  const provider = countingProvider();
  await openSettleAndRecover(fixture, provider, INSTALLATION_B);
  assert.equal(provider.calls.length, 0);
  assert.equal((await turnRow(fixture, turnId)).status, 'terminated');
  assert.deepEqual(await rowsOf(fixture, 'ModelRequest', { turn_id: turnId }), [], '被杀之前与之后都没有执行任何工作');
  assert.ok(conversationId);
  assert.equal((await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets[0].settlement.state, 'settled');
});

test('窄竞态：打开之后、收尾之前，已批准还没派发的文件修改不会被运行时收敛派发（收敛从打开起扣住，收尾后才放行），收尾把它连同 Turn 一起取消', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const conversationId = 'conversation-approved-write';
  const dataRoot = dataRootOf(fixture);
  // A window asked for a file change and closed; a window that does not serve the project approved it.
  const origin = await openHost(dataRoot, scriptedProvider([{ role: 'model', parts: [{ id: 'write-call', functionCall: { name: 'write', args: { path: 'x.txt', content: 'x' } } }] }]),
    { folders: [PROJECT.uri], label: 'origin', write: true });
  try {
    await createConversation(origin.app, conversationId);
    await origin.runner.input({ commandId: 'approved-write', conversationId, text: '改文件' });
    await eventually(async () => (await rows(origin.app, 'FileChangeSet', { status: 'pending' })).length === 1, 30_000, '没有进入审批');
    await origin.runner.waitForIdle();
  } finally { await origin.close(); }
  const approver = await openHost(dataRoot, countingProvider(), { folders: [ELSEWHERE], label: 'approver', write: true });
  try {
    const [changeSet] = await rows(approver.app, 'FileChangeSet', { status: 'pending' });
    await approver.app.database.conversationOwners.run(conversationId, () => approver.app.files.decide({
      source: { kind: 'command', key: 'approve-write' }, changeSetId: String(changeSet.id), decision: 'approved', response: {}
    }));
    await eventually(async () => (await rows(approver.app, 'EffectIntent', { effect_kind: 'file_mutation', dispatch_state: 'pending' })).length === 1, 10_000, '批准没有记下');
  } finally { await approver.close(); }
  const { relocationId } = await relocateOldHome(fixture);
  const [entry] = (await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets;
  assert.equal(entry.inventory.conversations[0].unreceiptedEffectIds.length, 1, '清单里有这项已批准的文件修改');
  assert.equal(await relocation.consentToDataRootMovedWork(fixture.root, relocationId, INSTALLATION_B), true);

  const opening = await relocatedWorkBeforeOpen(placementOf(fixture.root));
  const provider = countingProvider();
  const host = await openHost(dataRoot, provider, { folders: [PROJECT.uri], label: 'old-home', write: true, holdRuntimeConvergence: true });
  const dispatched = [];
  const dispatch = host.app.fileMutations.dispatchRecordAndReconcile.bind(host.app.fileMutations);
  host.app.fileMutations.dispatchRecordAndReconcile = async (id) => { dispatched.push(id); return dispatch(id); };
  // While the settlement holds the Conversation (this window owns it and serves its project), a
  // convergence is asked for, as the settlement's own commits do (e.g. closing a pending approval
  // first): given time to run before the Turn and its effects are closed.
  const terminate = host.app.agentLoop.terminateRequested.bind(host.app.agentLoop);
  host.app.agentLoop.terminateRequested = async (...input) => {
    await host.app.refreshExternalRuntimeWork();
    await sleep(800);
    return terminate(...input);
  };
  try {
    await host.app.refreshExternalRuntimeWork();
    await sleep(500);
    assert.deepEqual(dispatched, [], '打开之后、收尾之前不派发');
    await settleRelocatedWorkOnOpen(host.app, opening, INSTALLATION_B);
    assert.deepEqual(dispatched, [], '收尾期间也不派发');
    host.app.releaseRuntimeConvergence();
    await host.recover();
    await quiet();
  } finally { await host.close(); }
  assert.deepEqual(dispatched, [], '收尾之后没有可派发的');
  assert.deepEqual((await rowsOf(fixture, 'EffectIntent', { effect_kind: 'file_mutation' })).map((row) => row.dispatch_state), ['cancelled_before_dispatch']);
  assert.equal(provider.calls.length, 0);
});

test('打开前的提示只列收尾不了的项：待投递的结果和进程完成通知现在都能收尾，提示列表比上一轮短（这里 2 项变 0 项）；清单照样记下，同意后打开时一并收尾，旧目录 Provider 0 次', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const { conversationId, turnId } = await admitUnstartedTurn(fixture);
  const { deliveryId, dispatchId } = await finishedBackgroundProcesses(fixture, conversationId, turnId);
  const { relocationId } = await relocateOldHome(fixture);
  const [entry] = (await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets;
  const [work] = entry.inventory.conversations;
  assert.deepEqual([work.activeTurnIds, work.pendingDeliveryIds, work.pendingProcessCompletionIds], [[turnId], [deliveryId], [dispatchId]], '清单照样记下');
  const previously = reportedOnlyItems(entry.inventory, PREVIOUSLY_REPORTED_ONLY);
  const now = reportedOnlyItems(entry.inventory, RELOCATED_WORK_REPORTED_ONLY);
  assert.equal(previously.length, 2, '上一轮：待投递的结果和进程完成通知逐条列为收尾不了、打开后仍会执行一次');
  assert.ok(now.length < previously.length, '提示列表变短');
  assert.deepEqual(now, [], '能收尾的类别不再列出');
  assert.deepEqual(RELOCATED_WORK_REPORTED_ONLY, {});
  assert.ok(Object.isFrozen(RELOCATED_WORK_REPORTED_ONLY), '形状不变：仍是冻结的 { 清单列表名: 类别 }');

  assert.equal(await relocation.consentToDataRootMovedWork(fixture.root, relocationId, INSTALLATION_B), true);
  const provider = countingProvider();
  await openSettleAndRecover(fixture, provider, INSTALLATION_B);
  assert.equal(provider.calls.length, 0, '旧目录不调用模型');
  const settled = (await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets[0].settlement;
  assert.deepEqual([settled.state, settled.result.live, settled.result.unsettled], ['settled', [], []], '没有需要人处理的项');
  assert.deepEqual([settled.result.counts.turnsStopped, settled.result.counts.deliveriesTakenIn, settled.result.counts.processCompletionsAbandoned], [1, 1, 1]);
  assert.deepEqual((await rowsOf(fixture, 'ProcessCompletionDispatch', { id: dispatchId })).map((row) => [row.state, row.last_error]), [['dead_letter', 'data-root-relocated']]);
  assert.deepEqual((await rowsOf(fixture, 'RuntimeDelivery', { id: deliveryId })).map((row) => row.state), ['consumed']);
});

test('真实的 Facade.open：旧目录带着没同意的迁走任务时，在运行时打开之前就拒绝（reason moved-work，由恢复提示给出三选一）', { timeout: 120_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  await admitUnstartedTurn(fixture);
  await relocateOldHome(fixture);
  const { Facade, globalStatus, context } = loadFacade();
  const storage = path.join(fixture.base, 'vscode-global-storage');
  await fs.mkdir(storage);
  const vscodeContext = context(storage);
  await globalStatus.saveGlobalStatus(vscodeContext, fixture.root, '');
  const refused = await Facade.open(vscodeContext).then(async (facade) => { await facade.dispose(); return undefined; }, (error) => error);
  assert.equal(refused?.reason, 'moved-work', `拒绝打开：${refused?.message}`);
  assert.equal((await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets[0].settlement.state, 'pending');
  const hosts = await fs.readdir(path.join(dataRootOf(fixture), 'host-liveness')).catch(() => []);
  assert.deepEqual(hosts.filter((name) => name.endsWith('.json')), [], '运行时没有打开（没有登记 Host）');
});

test('产品运行时的门：打开时扣住（holdForRelocatedWork）就不开始启动恢复、也不接管对话，收尾后 releaseRelocatedWorkHold 才放行并放开收敛', async () => {
  loadFacade();
  const { VscodeReliableKernelProductRuntime } = require(path.join(compiled, 'backend/application/reliableKernel/VscodeReliableKernelProductRuntime.js'));
  const calls = [];
  // The runtime's own startRecovery / takeover code on stand-in collaborators (a real product runtime needs VS Code).
  let release;
  const runtime = Object.assign(Object.create(VscodeReliableKernelProductRuntime.prototype), {
    closing: false,
    recoveryController: new AbortController(),
    conversationRecoveryTasks: new Map(),
    relocatedWorkSettled: new Promise((resolve) => { release = resolve; }),
    releaseRelocatedWork: () => release(),
    externalRuntimeWatcher: { async start() { calls.push('watch'); } },
    toolHost: { async initialize() {} },
    initializeConfiguration: async () => {},
    childAgents: { async recoverStartup(_signal, conversationId) { calls.push(conversationId ? `children:${conversationId}` : 'children'); } },
    conversations: { async recoverStartup(_signal, conversationId) { calls.push(conversationId ? `conversations:${conversationId}` : 'conversations'); } },
    ensureCapabilitiesReady: async () => {},
    application: {
      database: { conversationOwners: { run: async (conversationId, run) => { calls.push(`owner:${conversationId}`); return run(); } } },
      async recoverConversation(conversationId) { calls.push(`recover:${conversationId}`); },
      async recover() { calls.push('recover'); return { phaseD: [], phaseF: [] }; },
      async refreshExternalRuntimeWork() { calls.push('refresh'); },
      releaseRuntimeConvergence() { calls.push('release-convergence'); }
    }
  });
  const recovery = runtime.startRecovery();
  // The Runner's takeover of a Conversation (setConversationTakeover) goes through the same gate.
  const takeover = runtime.recoverOwnedConversation('conversation-taken-over');
  await sleep(100);
  assert.deepEqual(calls, [], '收尾之前什么都不开始，也不接管');
  runtime.releaseRelocatedWorkHold();
  await Promise.all([recovery, takeover]);
  assert.deepEqual(calls.filter((call) => !call.includes(':')), ['release-convergence', 'watch', 'recover', 'children', 'conversations', 'refresh']);
  assert.deepEqual(calls.filter((call) => call.includes(':')), [
    'owner:conversation-taken-over', 'recover:conversation-taken-over', 'children:conversation-taken-over', 'conversations:conversation-taken-over'
  ]);
});

// ---------------------------------------------------------------------------------------------

function dataRootOf(fixture) {
  return fixture.current.binding.paths.dataRootPath;
}

function placementOf(configurationRootPath) {
  return { configurationRootPath, runtimeScopeRootPath: rootAuthority.resolveVscodeRuntimeDataSetScopeRoot(configurationRootPath, 'default') };
}

/** A project window of the old directory admitted a user message's Turn and closed before it called the model. */
async function admitUnstartedTurn(fixture) {
  const conversationId = 'conversation-carried';
  const origin = await openHost(dataRootOf(fixture), countingProvider(), { folders: [PROJECT.uri], label: 'origin', runner: false });
  try {
    await createConversation(origin.app, conversationId);
    const hostBootId = origin.app.database.hostBootId;
    const admitted = await origin.app.database.conversationOwners.run(conversationId, () => origin.app.turns.input({
      source: { kind: 'command', key: 'input-carried' }, conversationId,
      leaseOwnerId: `origin:${hostBootId}`, hostBootId, leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
      content: '运行一次部署脚本', contentType: 'text/plain; charset=utf-8'
    }));
    assert.equal(admitted.admitted, true);
    return { conversationId, turnId: admitted.turnId };
  } finally { await origin.close(); }
}

/** The kinds the moved-work prompt listed item by item before this round made them settleable. */
const PREVIOUSLY_REPORTED_ONLY = Object.freeze({
  pendingDeliveryIds: 'continuation_delivery',
  undeliveredAnswerIds: 'child_answer',
  pendingProcessCompletionIds: 'process_completion'
});

/** The items the moved-work prompt lists as "收尾不了" for `table` (vscode/commands/dataRootRelocation.ts describeMovedWork). */
function reportedOnlyItems(inventory, table) {
  return inventory.conversations.flatMap((conversation) => Object.entries(table).flatMap(([list, kind]) =>
    (conversation[list] ?? []).map((id) => `“${conversation.title || conversation.conversationId}”：${kind}（${id}）`)));
}

/**
 * Two background Processes the unstarted Turn `turnId` started, finished while its window was
 * gone: one completion already delivered to that Turn (pending), one not dispatched yet.
 */
async function finishedBackgroundProcesses(fixture, conversationId, turnId) {
  const origin = await openHost(dataRootOf(fixture), countingProvider(), { folders: [PROJECT.uri], label: 'origin', runner: false });
  try {
    const { app } = origin;
    const at = new Date().toISOString();
    const processSteps = (id) => [
      repo('Process').insert({ id, status: 'exited', wrapper_nonce: `nonce-${id}`, wrapper_pid: 0n, child_pid: null,
        process_group_id: null, start_fingerprint: `fingerprint-${id}`, command_digest: `digest-${id}`, spool_locator: `spool/${id}`,
        retained_bytes: 0n, retained_chunks: 0n, dropped_bytes: 0n, truncated: 0n, started_at: at, updated_at: at, completed_at: at }),
      repo('ProcessCompletionSourceLink').insert({ id: `source-${id}`, process_id: id, conversation_id: conversationId,
        source_turn_id: turnId, source_tool_call_id: `${id}-tool`, created_at: at }),
      repo('ProcessReceipt').insert({ id: `receipt-${id}`, process_id: id, outcome: 'succeeded', exit_code: 0n, exit_signal: null,
        wrapper_nonce: `nonce-${id}`, start_fingerprint: `fingerprint-${id}`, received_at: at })
    ];
    const payload = await app.contentStore.prepare(app.database, JSON.stringify({ kind: 'process_completion', processId: 'process-delivered',
      processReceiptId: 'receipt-process-delivered', sourceTurnId: turnId, conversationId }), 'application/vnd.limcode.process-completion+json');
    const exitRequest = await app.contentStore.prepare(app.database, '{"kind":"process_exit","processId":"process-undispatched"}\n', 'application/json');
    await app.database.transaction([
      ...preparedContentObjectSteps([payload, exitRequest], 'fixture_process'),
      ...processSteps('process-delivered'),
      repo('RuntimeInboxItem').insert({ id: 'process-delivered', dedupe_key: 'fixture:process-delivered', source_kind: 'process_receipt',
        source_id: 'receipt-process-delivered', state: 'available', created_at: at, updated_at: at }),
      repo('RuntimeInboxPayloadLink').insert({ id: 'payload-process-delivered', inbox_item_id: 'process-delivered',
        content_object_id: payload.metadata.id, created_at: at }),
      ...processSteps('process-undispatched'),
      repo('Operation').insert({ id: 'operation-process-undispatched', owner_kind: 'process', owner_id: 'process-undispatched',
        operation_seq: 1n, tool_call_id: null, status: 'succeeded', created_at: at, updated_at: at }),
      repo('Attempt').insert({ id: 'attempt-process-undispatched', operation_id: 'operation-process-undispatched', attempt_seq: 1n,
        status: 'succeeded', created_at: at, updated_at: at, completed_at: at }),
      repo('EffectIntent').insert({ id: 'intent-process-undispatched', attempt_id: 'attempt-process-undispatched', effect_kind: 'process_exit',
        dispatch_state: 'receipt_written', request_object_id: exitRequest.metadata.id, created_at: at, updated_at: at }),
      repo('ProcessCompletionDispatch').insert({ id: 'dispatch-process-undispatched', process_receipt_id: 'receipt-process-undispatched',
        state: 'pending', claim_owner_host_boot_id: null, claim_generation: 0n, claim_expires_at: null, attempt_count: 0n, failure_count: 0n,
        next_attempt_at: null, last_error: null, completed_at: null, created_at: at, updated_at: at })
    ]);
    const delivered = await app.runtime.deliveries.createAutomatic({ inboxItemId: 'process-delivered', targetConversationId: conversationId, sourceTurnId: turnId });
    assert.deepEqual([delivered.delivery.phase, delivered.delivery.target_turn_id], ['current_turn', turnId]);
    return { deliveryId: delivered.delivery.id, dispatchId: 'dispatch-process-undispatched' };
  } finally { await origin.close(); }
}

/** A real relocation of the old home by installation A (it names itself in the moved notice). */
async function relocateOldHome(fixture) {
  const target = path.join(fixture.base, 'new-home');
  const plan = await reloc.planWithRuntime(fixture, target);
  assert.deepEqual(plan.problems, []);
  const options = { movedBy: { id: INSTALLATION_A, label: 'VS Code（A）' }, installation: INSTALLATION_A };
  const source = await reloc.openRuntime(fixture.current);
  let staged;
  try { staged = await relocation.stageDataRootRelocation(plan, source, options); } finally { await source.close(); }
  await relocation.completeDataRootRelocation(staged, async () => undefined, options);
  return { target, relocationId: staged.relocationId };
}

/** Facade.open's order: consent checked before the open, Runtime opened with convergence held, settled, released, then the startup recovery. */
async function openSettleAndRecover(fixture, provider, by) {
  const opening = await relocatedWorkBeforeOpen(placementOf(fixture.root));
  assert.ok(opening, '同意之后照常打开');
  const host = await openHost(dataRootOf(fixture), provider, { folders: [PROJECT.uri], label: 'old-home', holdRuntimeConvergence: true });
  try {
    await settleRelocatedWorkOnOpen(host.app, opening, by);
    host.app.releaseRuntimeConvergence();
    await host.recover();
    await quiet();
  } finally { await host.close(); }
}

async function turnRow(fixture, turnId) {
  return (await rowsOf(fixture, 'Turn', { id: turnId }))[0];
}

/** Rows of the old directory read with nothing of it open in this process (the POSIX lock rule). */
async function rowsOf(fixture, domain, where) {
  const host = await openHost(dataRootOf(fixture), countingProvider(), { folders: [], label: 'reader', runner: false });
  try { return await rows(host.app, domain, where); } finally { await host.close(); }
}

async function openHost(dataRoot, provider, options) {
  const folders = [...options.folders];
  const app = await kernel.ReliableKernelApplication.open(
    new kernel.RootAuthority(() => dataRoot),
    { ...fixtureDependencies(provider, options.write === true), ...(options.holdRuntimeConvergence ? { holdRuntimeConvergence: true } : {}) }
  );
  const runner = options.runner === false ? undefined : new ReliableConversationRunner(app, `${options.label}:${app.database.hostBootId}`, () => undefined);
  app.database.conversationOwners.setClaimEligibilityProbe(async (conversationId) => (await evaluateConversationHostEligibility({
    database: app.database,
    contentStore: app.contentStore,
    workspaceFolderUris: () => folders,
    workEnvironments: async () => []
  }, conversationId)).eligible);
  let closed = false;
  return {
    app,
    runner,
    /** VscodeReliableKernelProductRuntime.startRecovery, in its order (no child Agents here). */
    async recover() {
      await app.recover();
      await runner?.recoverStartup();
      await app.refreshExternalRuntimeWork();
    },
    async close() {
      if (closed) return;
      closed = true;
      runner?.dispose();
      await app.beginHandoff().catch(() => undefined);
      await runner?.waitForIdle().catch(() => undefined);
      await app.close();
    }
  };
}

function fixtureDependencies(provider, write) {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: PROVIDER_ID, modelId: 'relocated-opening-model' }) },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: { providerConfigId: PROVIDER_ID, provider: 'fixture', modelId: 'relocated-opening-model', retryPolicy: { enabled: false, maxRetries: 0 } },
              modelProfile: { compressionThresholdTokens: 100_000, contextWindowTokens: 128_000, tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
              toolPolicy: { id: 'relocated-opening-tools', allowedTools: write ? ['write'] : [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
              planReviewPolicy: { mode: 'optional' },
              systemPrompt: { id: 'relocated-opening-prompt', text: '' },
              runtimeContext: { id: null, name: '', template: '' },
              workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
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
        if (providerId !== PROVIDER_ID) throw new Error(`Unexpected provider ${providerId}.`);
        return provider;
      }
    },
    createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) =>
      new kernel.ReliableToolDispatcher({
        database, contentStore, effects: runtime.effects, files, fileMutations, processes, mcp, interactions,
        host: {
          definitions() { return write ? [writeTool] : []; },
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

/** Every model call is recorded; the reply is a plain final answer. */
function countingProvider() {
  return scriptedProvider(null);
}

function scriptedProvider(replies) {
  const calls = [];
  return {
    providerId: PROVIDER_ID,
    calls,
    async sendFullRequest(request, controls) {
      calls.push(request.conversationId);
      const content = replies ? replies[calls.length - 1] : { role: 'model', parts: [{ text: '已执行' }] };
      if (!content) throw new Error(`Unexpected Provider call ${calls.length}.`);
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content });
    }
  };
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

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(repo(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1_000 }))).snapshot;
}

async function quiet(ms = 1_500) {
  await sleep(ms);
}

async function eventually(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  assert.fail(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runWorker(mode, input) {
  const child = spawn(process.execPath, [TEST_FILE], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LIMCODE_RELOCATED_OPENING_WORKER: mode, LIMCODE_RELOCATED_OPENING_INPUT: JSON.stringify(input) }
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, output })));
}

/** The compiled Facade with a VS Code mock (a window without folders: the default data set). */
function loadFacade() {
  class MockUri {
    constructor(fsPath) { this.scheme = 'file'; this.fsPath = path.resolve(fsPath); this.path = this.fsPath.replaceAll('\\', '/'); }
    static file(fsPath) { return new MockUri(fsPath); }
    static parse(text) { return new MockUri(text.replace(/^file:\/\//, '')); }
    static joinPath(base, ...segments) { return new MockUri(path.join(base.fsPath, ...segments)); }
    toString() { return `file://${this.path}`; }
  }
  const vscodeMock = {
    Uri: MockUri,
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    ProgressLocation: { Notification: 15 },
    window: { state: { focused: true }, async showWarningMessage() {}, async showInformationMessage() {}, async showErrorMessage() {} },
    workspace: { workspaceFile: undefined, workspaceFolders: [] },
    commands: { async executeCommand() {} }
  };
  const originalLoad = Module._load;
  Module._load = function loadWithVscode(name, parent, isMain) {
    return name === 'vscode' ? vscodeMock : originalLoad.call(this, name, parent, isMain);
  };
  const facadeModule = require(path.join(compiled, 'backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js'));
  const globalStatus = require(path.join(compiled, 'backend/capabilities/vscodeStorage/globalStatus.js'));
  const context = (storage) => {
    const state = new Map();
    return {
      globalStorageUri: MockUri.file(storage),
      globalState: { get: (key) => state.get(key), update: async (key, value) => { state.set(key, value); }, keys: () => [...state.keys()] },
      workspaceState: { get: () => undefined, update: async () => {}, keys: () => [] }
    };
  };
  return { Facade: facadeModule.VscodeReliableKernelApplicationFacade, globalStatus, context };
}
