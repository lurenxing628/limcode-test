// Supplement E of the data-root relocation: the unfinished work a relocation carried away is listed
// in the old directory's moved notice (computed on the snapshot that moved), and opening a data set
// of the old directory settles it (closed as aborted) only after the user chose to keep using the
// old directory, right after its Runtime opened with its convergence held and before anything runs:
// the same order as VscodeReliableKernelApplicationFacade.open and the product runtime (the Runtime
// here is the kernel application with the production Runner, eligibility probe and recovery order;
// its convergence is held from the open until the recovery releases it, as in production).
// A crash in the middle of settling is continued at the next open; the settlement is recorded once,
// and only once all of it is settled: anything left fails the open and nothing runs. The moved
// notice is written before the pointer switches and removed by an undo; one that cannot be
// understood refuses the open.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const root = process.cwd();
const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT ?? path.join(root, 'dist/extension');
const load = (relative) => import(pathToFileURL(path.join(compiled, relative)).href);
const kernel = await load('backend/reliableKernel/index.js');
const { emptyConversationContextHandleStateStep } = await load('backend/reliableKernel/conversationContextHandleState.js');
const { captureFilePlanningRoot } = await load('backend/reliableKernel/fileTargetBoundary.js');
const { ReliableConversationRunner } = await load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { evaluateConversationHostEligibility } = await load('backend/application/reliableKernel/conversationHostEligibility.js');
const { projectFolderAssignmentSteps } = await load('backend/reliableKernel/conversationProject.js');
const { writeTool } = await load('backend/world/modules/tools/definitions/write/index.js');
const { openSettlingRelocatedWork, relocatedWorkBeforeOpen, settleRelocatedWorkOnOpen, settleEarlierMovedWorkOffline } = await load('backend/application/reliableKernel/relocatedWorkOpening.js');
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
/** Windows still open (see openHost): a test that fails before its own close leaves none behind (afterEach). */
const stillOpen = new Set();

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

if (process.env.LIMCODE_RELOCATED_OPENING_WORKER === 'live-holder') {
  // A live window of the old directory that runs the carried Turn (its model call never answers),
  // so it holds the Conversation while another window settles; killed later without finishing.
  const { dataRoot, ready } = JSON.parse(process.env.LIMCODE_RELOCATED_OPENING_INPUT);
  const host = await openHost(dataRoot, hangingProvider(), { folders: [PROJECT.uri], label: 'live-holder', running: true });
  await host.recover();
  await eventually(async () => (await rows(host.app, 'ModelRequest')).length > 0, 60_000, '存活窗口没有接手迁走的 Turn');
  await fs.writeFile(`${ready}.tmp`, 'ready');
  await fs.rename(`${ready}.tmp`, ready);
  await new Promise(() => {});
}

afterEach(async () => { for (const host of [...stillOpen]) await host.close(); });

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
  assert.deepEqual(Object.keys(settled.result), ['counts'], '全部收尾才记已收尾：只记关掉了什么');
  assert.equal(settled.result.counts.turnsStopped, 1);
  assert.equal(await relocation.recordDataRootMovedWorkSettled(fixture.root, relocationId, 'default', INSTALLATION_A, { counts: {} }), false, '只记一次');
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
    { folders: [PROJECT.uri], label: 'origin', write: true, running: true });
  try {
    await createConversation(origin.app, conversationId);
    await origin.runner.input({ commandId: 'approved-write', conversationId, text: '改文件' });
    await eventually(async () => (await rows(origin.app, 'FileChangeSet', { status: 'pending' })).length === 1, 30_000, '没有进入审批');
    await origin.runner.waitForIdle();
  } finally { await origin.close(); }
  const approver = await openHost(dataRoot, countingProvider(), { folders: [ELSEWHERE], label: 'approver', write: true, running: true });
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

  // The real open of Facade.open (openSettlingRelocatedWork): the Runtime opens with its convergence held.
  const provider = countingProvider();
  const dispatched = [];
  const opened = await openOldHome(fixture, provider, { write: true, opened: async (host) => {
    // Recorded and refused: a dispatch here would be the carried change running a second time.
    host.app.fileMutations.dispatchRecordAndReconcile = async (id) => { dispatched.push(id); throw new Error(`不应派发 ${id}`); };
    // While the settlement holds the Conversation (this window owns it and serves its project), a
    // convergence is asked for, as the settlement's own commits do (e.g. closing a pending approval
    // first): given time to run before the Turn and its effects are closed.
    const terminate = host.app.agentLoop.terminateRequested.bind(host.app.agentLoop);
    host.app.agentLoop.terminateRequested = async (...input) => {
      await host.app.refreshExternalRuntimeWork();
      await sleep(800);
      return terminate(...input);
    };
    await host.app.refreshExternalRuntimeWork();
    await sleep(500);
    assert.deepEqual(dispatched, [], '打开之后、收尾之前不派发');
  } });
  assert.equal(opened.refused, undefined, `打开：${opened.refused?.stack}`);
  assert.equal(opened.hold, true, '有迁走的任务要收尾：打开时扣住收敛');
  try {
    assert.deepEqual(dispatched, [], '收尾期间也不派发');
    await opened.host.recover();
    await quiet();
  } finally { await opened.host.close(); }
  assert.deepEqual(dispatched, [], '收尾之后没有可派发的');
  assert.deepEqual((await rowsOf(fixture, 'EffectIntent', { effect_kind: 'file_mutation' })).map((row) => row.dispatch_state), ['cancelled_before_dispatch']);
  assert.equal(provider.calls.length, 0);
});

test('待投递的结果和进程完成通知都能收尾：迁移时照样记进清单；同意后打开时一并收尾，旧目录 Provider、工具、进程都是 0 次', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const { conversationId, turnId } = await admitUnstartedTurn(fixture);
  const { deliveryId, dispatchId } = await finishedBackgroundProcesses(fixture, conversationId, turnId);
  const { relocationId } = await relocateOldHome(fixture);
  const [entry] = (await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets;
  const [work] = entry.inventory.conversations;
  assert.deepEqual([work.activeTurnIds, work.pendingDeliveryIds, work.pendingProcessCompletionIds], [[turnId], [deliveryId], [dispatchId]], '清单照样记下');

  assert.equal(await relocation.consentToDataRootMovedWork(fixture.root, relocationId, INSTALLATION_B), true);
  const provider = countingProvider();
  const opened = await openSettleAndRecover(fixture, provider, INSTALLATION_B);
  assert.equal(provider.calls.length, 0, '旧目录不调用模型');
  assert.deepEqual(opened.host.executions, { tools: [], processes: [] }, '旧目录不调用工具、不启动进程');
  const settled = (await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets[0].settlement;
  assert.equal(settled.state, 'settled', '都收尾了');
  assert.deepEqual([settled.result.counts.turnsStopped, settled.result.counts.deliveriesTakenIn, settled.result.counts.processCompletionsAbandoned], [1, 1, 1]);
  assert.deepEqual((await rowsOf(fixture, 'ProcessCompletionDispatch', { id: dispatchId })).map((row) => [row.state, row.last_error]), [['dead_letter', 'data-root-relocated']]);
  assert.deepEqual((await rowsOf(fixture, 'RuntimeDelivery', { id: deliveryId })).map((row) => row.state), ['consumed']);
});

test('存活窗口占着的项（live：它在执行的 Turn 与排在后面的消息）：不放行，这次打开失败，运行时关掉、不恢复，逐条记下留下了什么；那个窗口没做完就退出后，重试时整库收尾完才放行，旧目录 Provider、工具、进程都是 0 次', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const { conversationId, turnId } = await admitUnstartedTurn(fixture);
  const queuedId = await queueMessage(fixture, conversationId);
  const { relocationId } = await relocateOldHome(fixture);
  assert.equal(await relocation.consentToDataRootMovedWork(fixture.root, relocationId, INSTALLATION_B), true);
  const ready = path.join(fixture.base, 'live-holder-ready');
  const holder = spawnWorker('live-holder', { dataRoot: dataRootOf(fixture), ready });
  t.after(() => { if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL'); });
  await waitForFile(holder, ready, 90_000);
  // Stopped outside a write transaction (a window that stalls inside one holds every writer up).
  await reloc.stopOutsideWrites(holder, fixture.current.binding.paths.databasePath);

  // This open: what the live window holds cannot be settled here, so nothing is released.
  const provider = countingProvider();
  const first = await openOldHome(fixture, provider);
  assert.equal(first.refused?.reason, 'moved-work-unsettled', `不放行：${first.refused?.stack}`);
  assert.match(first.refused.message, /还剩 2 项：另一个窗口正在执行或占着 2 项/);
  const left = [
    { conversationId, title: conversationId, list: 'queuedIntentIds', id: queuedId, why: 'live', detail: '' },
    { conversationId, title: conversationId, list: 'activeTurnIds', id: turnId, why: 'live', detail: '' }
  ];
  assert.deepEqual(first.refused.cause.items, left, '拒绝时带着这次留下的项（提示逐条列出）');
  assert.deepEqual([first.hold, first.released, first.closed], [true, false, true], '扣住打开、没有放行、运行时关掉');
  const kept = (await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets[0].settlement;
  assert.equal(kept.state, 'consented', '不算已收尾');
  assert.deepEqual([kept.left.by, kept.left.items], [INSTALLATION_B, left], '记下这次留下了什么、为什么');
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(first.host.executions, { tools: [], processes: [] });
  assert.equal((await turnRow(fixture, turnId)).status, 'active', '前提：存活窗口还占着它');

  // That window ends without finishing: the retry settles the whole data set again, then opens.
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.once('exit', resolve));
  const next = await openSettleAndRecover(fixture, provider, INSTALLATION_B);
  assert.equal(provider.calls.length, 0, '迁走的项没有执行');
  assert.deepEqual(next.host.executions, { tools: [], processes: [] });
  assert.equal((await turnRow(fixture, turnId)).status, 'terminated');
  assert.equal((await rowsOf(fixture, 'TurnIntent', { id: queuedId }))[0].state, 'cancelled');
  const settled = (await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets[0].settlement;
  assert.equal(settled.state, 'settled');
  assert.equal('left' in settled, false);
  assert.equal(settled.result.counts.turnsStopped, 1);
  assert.equal(settled.result.counts.queuedMessagesCancelled, 1);
});

test('某一轮收尾时协作收敛一直出错（重试 3 次仍失败）：不放行（不恢复、不执行），标记保持同意、不记已收尾并记下留下的项，这次打开失败并说明可以重试；重开后接着收尾完，旧目录 Provider、工具、进程都是 0 次', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const { turnId } = await admitUnstartedTurn(fixture);
  const { relocationId } = await relocateOldHome(fixture);
  assert.equal(await relocation.consentToDataRootMovedWork(fixture.root, relocationId, INSTALLATION_B), true);
  const provider = countingProvider();
  const first = await openOldHome(fixture, provider, { wrap: (app) => Object.create(app, { runtime: { value: { ...app.runtime, collaboration: {
    async reconcile() { throw new Error('collaboration facts changed concurrently'); }
  } } } }) });
  assert.equal(first.refused?.reason, 'moved-work-unsettled', `不放行：${first.refused?.stack}`);
  assert.match(first.refused.message, /迁走的任务还没有全部收尾（还剩 1 项：收尾时出错 1 项）/);
  assert.match(first.refused.message, /可以重试/);
  assert.deepEqual(first.refused.cause.items.map((item) => [item.conversationId, item.list, item.id, item.why]), [['', 'round', 'round-2', 'failed']]);
  assert.match(first.refused.cause.items[0].detail, /collaboration facts changed concurrently/);
  assert.deepEqual([first.hold, first.released, first.closed], [true, false, true], '扣住打开、没有放行、运行时关掉');
  const entry = (await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets[0];
  assert.equal(entry.settlement.state, 'consented', '不记已收尾');
  assert.deepEqual(entry.settlement.left.items, first.refused.cause.items, '记下这次留下的项');
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(first.host.executions, { tools: [], processes: [] });

  const next = await openSettleAndRecover(fixture, provider, INSTALLATION_B);
  assert.equal(provider.calls.length, 0, '重开后收尾完，照常恢复也不执行');
  assert.deepEqual(next.host.executions, { tools: [], processes: [] });
  assert.equal((await turnRow(fixture, turnId)).status, 'terminated');
  assert.equal((await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets[0].settlement.state, 'settled');
});

test('真实的 Facade.open：旧目录带着没同意的迁走任务时，在运行时打开之前就拒绝（reason moved-work，由恢复提示给出三选一）；同意之后打开运行时时带着扣住（holdForRelocatedWork）', { timeout: 120_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  await admitUnstartedTurn(fixture);
  const { relocationId } = await relocateOldHome(fixture);
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

  // "在这里继续": the product Runtime is asked to open with its hold (a stand-in open; what the hold
  // does is shown by the product runtime's gate below and by openSettlingRelocatedWork above).
  assert.equal(await relocation.consentToDataRootMovedWork(fixture.root, relocationId, INSTALLATION_B), true);
  const { VscodeReliableKernelProductRuntime } = require(path.join(compiled, 'backend/application/reliableKernel/VscodeReliableKernelProductRuntime.js'));
  const realOpen = VscodeReliableKernelProductRuntime.open;
  const asked = [];
  VscodeReliableKernelProductRuntime.open = async (_context, options) => {
    asked.push(options.holdForRelocatedWork);
    throw new Error('stand-in: the product Runtime is not opened here');
  };
  t.after(() => { VscodeReliableKernelProductRuntime.open = realOpen; });
  const stopped = await Facade.open(vscodeContext).then(async (facade) => { await facade.dispose(); return undefined; }, (error) => error);
  assert.match(String(stopped?.message), /stand-in/, String(stopped?.stack));
  assert.deepEqual(asked, [true], '有同意过的迁走任务：运行时打开时扣住收敛与恢复');
  assert.equal((await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets[0].settlement.state, 'consented', '没打开就没有收尾');
});

test('标记先写（决定二）：切换指针之前旧目录里就有这次迁移的标记；迁移还在进行（发起进程还在）时旧目录按 relocating 拒绝，不拿它问用户、也不收尾；切换失败撤销时标记随撤销删掉，旧目录照常打开', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  await admitUnstartedTurn(fixture);
  const target = path.join(fixture.base, 'new-home');
  const options = { movedBy: { id: INSTALLATION_A, label: 'VS Code（A）' }, installation: INSTALLATION_A };
  const staged = await stageOldHome(fixture, target, options);
  let during;
  const failure = await relocation.completeDataRootRelocation(staged, async () => {
    const notice = await relocation.readDataRootMovedNotice(fixture.root);
    during = {
      relocationId: notice?.relocationId,
      dataSets: notice?.carriedWork?.dataSets.length,
      opening: await relocatedWorkBeforeOpen(placementOf(fixture.root)).then(() => 'opens', (error) => error.reason)
    };
    throw new Error('切换指针失败');
  }, { ...options, pointerUnchanged: async () => true }).then(() => undefined, (error) => error);
  assert.match(String(failure?.message), /切换指针失败/);
  assert.deepEqual(during, { relocationId: staged.relocationId, dataSets: 1, opening: 'relocating' }, '切换之前标记已写好；进行中的迁移不拿来问用户');
  assert.equal(relocation.dataRootRelocationCleanupState(failure), 'cleaned');
  assert.equal(await relocation.readDataRootMovedNotice(fixture.root), undefined, '撤销时标记随之删掉');
  await assert.rejects(fs.stat(path.join(target, relocation.DATA_ROOT_RELOCATION_MARKER_FILE)), { code: 'ENOENT' });
  assert.equal(await relocatedWorkBeforeOpen(placementOf(fixture.root)), undefined, '迁移没有生效：旧目录照常打开（工作只有这一份）');
});

test('标记先写（决定二）：写“已迁走”标记失败（注入 EIO）时迁移按切换前失败撤销：不切换指针、新目录撤销干净、旧目录没有标记，旧目录照常打开（工作只有这一份）', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  await admitUnstartedTurn(fixture);
  const target = path.join(fixture.base, 'new-home');
  const options = { movedBy: { id: INSTALLATION_A, label: 'VS Code（A）' }, installation: INSTALLATION_A };
  const staged = await stageOldHome(fixture, target, options);
  const fsp = require('node:fs/promises');
  const realOpen = fsp.open;
  const failed = [];
  fsp.open = async (file, ...rest) => {
    const name = String(file);
    if (name.startsWith(`${path.join(fixture.root, relocation.DATA_ROOT_MOVED_NOTICE_FILE)}.`) && name.endsWith('.tmp')) {
      failed.push(name);
      throw Object.assign(new Error(`EIO: i/o error, open '${name}'`), { code: 'EIO' });
    }
    return realOpen(file, ...rest);
  };
  let published = 0;
  let failure;
  try {
    failure = await relocation.completeDataRootRelocation(staged, async () => { published += 1; }, options).then(() => undefined, (error) => error);
  } finally { fsp.open = realOpen; }
  assert.equal(failed.length, 1, '注入的失败确实落在写标记上');
  assert.equal(failure?.code, 'EIO', String(failure?.stack));
  assert.equal(published, 0, '没有切换指针');
  assert.equal(relocation.dataRootRelocationCleanupState(failure), 'cleaned', '按切换前失败撤销');
  await assert.rejects(fs.stat(path.join(target, relocation.DATA_ROOT_RELOCATION_MARKER_FILE)), { code: 'ENOENT' });
  assert.equal(await relocation.readDataRootMovedNotice(fixture.root), undefined);
  assert.equal(await relocatedWorkBeforeOpen(placementOf(fixture.root)), undefined, '迁移没有生效：旧目录照常打开');
});

test('撤销只动这次迁移自己的标记（决定二）：旧目录里原有的别的迁移的标记（还有没收尾的库）在这次迁移失败撤销后原样放回；撤销时那里已是别的迁移的标记，就不碰它', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  await admitUnstartedTurn(fixture);
  const noticeFile = path.join(fixture.root, relocation.DATA_ROOT_MOVED_NOTICE_FILE);
  const noticeOf = (relocationId) => `${JSON.stringify({
    kind: 'limcode-data-root-moved', targetRootPath: path.join(fixture.base, 'elsewhere'), relocationId, movedAt: '2026-09-20T08:00:00.000Z',
    installation: { id: '/installations/c', label: 'VS Code（C）' },
    carriedWork: { dataSets: [{ id: 'workspace:other', dataSetId: 'other', inventory: { conversations: [] }, settlement: { state: 'pending' } }] }
  }, null, 2)}\n`;
  // An earlier relocation away from this directory left its notice, with a data set not settled yet.
  const earlier = noticeOf(randomUUID());
  await fs.writeFile(noticeFile, earlier);
  const target = path.join(fixture.base, 'new-home');
  const options = { movedBy: { id: INSTALLATION_A, label: 'VS Code（A）' }, installation: INSTALLATION_A };
  const staged = await stageOldHome(fixture, target, options);
  let during;
  const failure = await relocation.completeDataRootRelocation(staged, async () => {
    during = (await relocation.readDataRootMovedNotice(fixture.root))?.relocationId;
    throw new Error('切换指针失败');
  }, { ...options, pointerUnchanged: async () => true }).then(() => undefined, (error) => error);
  assert.equal(during, staged.relocationId, '切换之前换成了这次迁移的标记');
  assert.equal(relocation.dataRootRelocationCleanupState(failure), 'cleaned');
  assert.equal(await fs.readFile(noticeFile, 'utf8'), earlier, '撤销后原有的标记原样放回');

  // Not undone at once (the pointer may have switched); by the time it is, another relocation's notice is there.
  const again = await stageOldHome(fixture, target, options);
  const kept = await relocation.completeDataRootRelocation(again, async () => { throw new Error('切换指针失败'); },
    { ...options, pointerUnchanged: async () => false }).then(() => undefined, (error) => error);
  assert.equal(relocation.dataRootRelocationCleanupState(kept), 'not-cleaned');
  assert.equal((await relocation.readDataRootMovedNotice(fixture.root))?.relocationId, again.relocationId);
  const later = noticeOf(randomUUID());
  await fs.writeFile(noticeFile, later);
  await relocation.abandonStagedDataRootRelocation(again, { pointerUnchanged: true });
  assert.equal(await fs.readFile(noticeFile, 'utf8'), later, '撤销不碰别的迁移的标记');
  await assert.rejects(fs.stat(path.join(target, relocation.DATA_ROOT_RELOCATION_MARKER_FILE)), { code: 'ENOENT' });
});

test('标记读不懂（决定三）：截断的 JSON、不认识的收尾状态（settling）、不合格的库、坏的 left、别的 kind，一律按 moved-notice-invalid 拒绝打开，不当作没有标记；读得出新目录时一并给出', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  await admitUnstartedTurn(fixture);
  const { target } = await relocateOldHome(fixture);
  const noticeFile = path.join(fixture.root, relocation.DATA_ROOT_MOVED_NOTICE_FILE);
  const written = await fs.readFile(noticeFile, 'utf8');
  const notice = JSON.parse(written);
  const withSettlement = (settlement) => JSON.stringify({ ...notice, carriedWork: { dataSets: notice.carriedWork.dataSets.map((item) => ({ ...item, settlement })) } });
  const variants = {
    truncated: written.slice(0, Math.floor(written.length / 2)),
    unknownState: withSettlement({ state: 'settling', at: 'x', by: 'y' }),
    badDataSet: JSON.stringify({ ...notice, carriedWork: { dataSets: [{ ...notice.carriedWork.dataSets[0], inventory: { conversations: 'x' } }] } }),
    badLeft: withSettlement({ state: 'consented', at: 'x', by: 'y', left: { at: 'x', by: 'y', items: [
      { conversationId: 'c', title: '', list: 'activeTurnIds', id: 't', why: 'maybe', detail: '' }
    ] } }),
    otherKind: JSON.stringify({ ...notice, kind: 'limcode-data-root-moved-v2' })
  };
  const outcomes = {};
  const targets = {};
  for (const [name, text] of Object.entries(variants)) {
    await fs.writeFile(noticeFile, text);
    outcomes[name] = await relocatedWorkBeforeOpen(placementOf(fixture.root)).then((value) => (value === undefined ? 'opens-unheld' : 'held'), (error) => error.reason);
    const read = await relocation.inspectDataRootMovedNotice(fixture.root);
    targets[name] = read.targetRootPath ?? null;
    assert.equal(await relocation.readDataRootMovedNotice(fixture.root), undefined, '只作展示的读取把它当作没有');
  }
  assert.deepEqual(outcomes, Object.fromEntries(Object.keys(variants).map((name) => [name, 'moved-notice-invalid'])), '读不懂的标记证明不了没有迁走的任务');
  assert.deepEqual(targets, { truncated: null, unknownState: target, badDataSet: target, badLeft: target, otherKind: target });
  await fs.writeFile(noticeFile, variants.unknownState);
  const refused = await relocatedWorkBeforeOpen(placementOf(fixture.root)).then(() => undefined, (error) => error);
  assert.match(refused.message, /“数据已迁走”标记（\.limcode-data-root-moved\.json）读不懂（迁走的任务清单或它的收尾状态不是本版本认得的内容/);
  assert.match(refused.message, /本窗口没有打开运行时。可以改用新目录/);
  await fs.writeFile(noticeFile, written);
  await assert.rejects(relocatedWorkBeforeOpen(placementOf(fixture.root)), (error) => error.reason === 'moved-work', '标记恢复原样：照常询问');
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

test('风险 2：收尾本身意外出错（不是某一项失败）时不再是通用的“运行时无法启动”：照样不放行，记下一条“收尾过程出错”的剩余项，拒绝打开（moved-work-unsettled）并说明可以重试；重试时收尾完', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const { turnId } = await admitUnstartedTurn(fixture);
  const { relocationId } = await relocateOldHome(fixture);
  assert.equal(await relocation.consentToDataRootMovedWork(fixture.root, relocationId, INSTALLATION_B), true);
  const provider = countingProvider();
  const first = await openOldHome(fixture, provider, { wrap: (app) => Object.create(app, {
    runtime: { get() { throw new Error('数据库 worker 已退出'); } }
  }) });
  assert.equal(first.refused?.reason, 'moved-work-unsettled', `不放行：${first.refused?.stack}`);
  assert.match(first.refused.message, /迁走的任务还没有全部收尾（还剩 1 项：收尾时出错 1 项）.*可以重试/);
  assert.deepEqual(first.refused.cause.items.map((item) => [item.conversationId, item.list, item.id, item.why]), [['', 'round', 'settlement', 'failed']]);
  assert.match(first.refused.cause.items[0].detail, /收尾中途出错：数据库 worker 已退出/);
  assert.deepEqual([first.hold, first.released, first.closed], [true, false, true], '扣住打开、没有放行、运行时关掉');
  const entry = (await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets[0];
  assert.equal(entry.settlement.state, 'consented');
  assert.deepEqual(entry.settlement.left.items, first.refused.cause.items);
  const next = await openSettleAndRecover(fixture, provider, INSTALLATION_B);
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(next.host.executions, { tools: [], processes: [] });
  assert.equal((await turnRow(fixture, turnId)).status, 'terminated');
});

test('盲审 worker #1：“已收尾”只在收尾落盘之后记：记之前先过落盘屏障（那时标记还是同意、收尾已提交）；屏障失败时不记已收尾、保持同意，按“收尾过程出错”留下一项、这次不打开；下次打开照常收尾，过了屏障才记', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const { turnId } = await admitUnstartedTurn(fixture);
  const { relocationId } = await relocateOldHome(fixture);
  assert.equal(await relocation.consentToDataRootMovedWork(fixture.root, relocationId, INSTALLATION_B), true);
  const settlement = async () => (await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets[0].settlement;
  const barriers = [];
  // The window's own barrier, observed: what the notice and the Turn were when it was reached.
  const observeBarrier = (failure) => async (host) => {
    const { database } = host.app;
    const barrier = database.durabilityCheckpoint.bind(database);
    database.durabilityCheckpoint = async () => {
      const [turn] = (await database.snapshot([repo('Turn').get(turnId)])).snapshot;
      barriers.push([(await settlement()).state, turn.status]);
      if (failure) throw failure;
      return barrier();
    };
  };
  const provider = countingProvider();
  const first = await openOldHome(fixture, provider, { opened: observeBarrier(new Error('另一个窗口还在读旧的状态')) });
  assert.equal(first.refused?.reason, 'moved-work-unsettled', `不放行：${first.refused?.stack}`);
  assert.deepEqual(first.refused.cause.items.map((item) => [item.conversationId, item.list, item.id, item.why]), [['', 'round', 'settlement', 'failed']]);
  assert.match(first.refused.cause.items[0].detail, /收尾没能写回磁盘：另一个窗口还在读旧的状态/);
  assert.deepEqual([first.hold, first.released, first.closed], [true, false, true], '扣住打开、没有放行、运行时关掉');
  assert.deepEqual(barriers, [['consented', 'terminated']], '屏障在记录之前：收尾已提交，标记还是同意');
  const kept = await settlement();
  assert.equal(kept.state, 'consented', '屏障失败：不记已收尾');
  assert.deepEqual(kept.left.items, first.refused.cause.items);

  const next = await openOldHome(fixture, provider, { opened: observeBarrier() });
  try {
    assert.equal(next.refused, undefined, `重开照常收尾并放行：${next.refused?.stack}`);
    assert.deepEqual([next.hold, next.released], [true, true]);
  } finally { await next.host?.close(); }
  assert.deepEqual(barriers, [['consented', 'terminated'], ['consented', 'terminated']], '真的屏障通过之后才记');
  assert.equal((await settlement()).state, 'settled');
  assert.equal(provider.calls.length, 0);
  assert.equal((await turnRow(fixture, turnId)).status, 'terminated');
});

test('遗留风险 1：A→B 迁移、回到 A（只打开了当前库，工作区库还没打开、没收尾）、再 A→C：规划逐库列出；不选收尾就拒绝（撤销，A 不变）；选“先按中止收尾再迁移”时在独占阶段离线收尾后才迁移；C 里 Provider、工具、进程都是 0 次，B 里各执行一次', { timeout: 300_000 }, async (t) => {
  const fixture = await reloc.createFixture(t);
  const current = await admitUnstartedTurn(fixture);
  const alpha = await admitUnstartedTurn(fixture, { dataRoot: fixture.alpha.binding.paths.dataRootPath, conversationId: 'conversation-alpha-carried' });
  const b = await relocateOldHomeTo(fixture, 'b-home');
  const carried = (await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets;
  assert.deepEqual(carried.map((item) => [item.id, item.settlement.state]).sort(), [['default', 'pending'], [fixture.alpha.id, 'pending']].sort());
  // "回到旧目录": the initiating installation's confirmation consents; only the current data set opens (and settles).
  assert.equal(await relocation.consentToDataRootMovedWork(fixture.root, b.relocationId, INSTALLATION_A), true);
  await openSettleAndRecover(fixture, countingProvider(), INSTALLATION_A);
  const states = async () => Object.fromEntries((await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets.map((item) => [item.id, item.settlement.state]));
  assert.deepEqual(await states(), { default: 'settled', [fixture.alpha.id]: 'consented' }, '前提：工作区库还没收尾');

  const cTarget = path.join(fixture.base, 'c-home');
  const plan = await reloc.planWithRuntime(fixture, cTarget);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.earlierMovedWork.relocationId, b.relocationId);
  assert.equal(plan.earlierMovedWork.targetRootPath, b.target);
  assert.deepEqual(plan.earlierMovedWork.dataSets.map((item) => [item.id, item.state, item.conversations.map((conversation) => conversation.title)]),
    [[fixture.alpha.id, 'consented', ['conversation-alpha-carried']]]);
  assert.match(plan.earlierMovedWork.dataSets[0].label, /迁走项目/, '用项目名标识这个库');
  const described = relocation.describeEarlierMovedWork(plan.earlierMovedWork).join('\n');
  assert.match(described, new RegExp(`这些历史库里还有上一次迁移到 ${escapeRegExp(b.target)} 时迁走、但这里还没收尾的任务`));
  assert.match(described, /历史库“[^”]*迁走项目[^”]*”：1 个对话（“conversation-alpha-carried”）/);
  assert.match(described, /先把这些任务按中止收尾，再迁移.*切换为当前历史库/s);

  // Not chosen (no settlement given), or chosen but nothing got settled: refused before anything moves, undone.
  for (const settleEarlierMovedWork of [undefined, async () => undefined]) {
    await assert.rejects(relocateOldHomeTo(fixture, 'c-home', settleEarlierMovedWork ? { settleEarlierMovedWork } : {}),
      (error) => error.code === 'data-root-relocation-earlier-moved-work' && /还没收尾的任务/.test(error.message));
    assert.equal(await pathExists(cTarget), false, '撤销干净');
    assert.equal((await relocation.readDataRootMovedNotice(fixture.root)).relocationId, b.relocationId, '旧目录还是上一次迁移的标记');
    assert.deepEqual(await states(), { default: 'settled', [fixture.alpha.id]: 'consented' });
  }
  assert.equal((await turnRow(fixture, alpha.turnId, fixture.alpha.binding.paths.dataRootPath)).status !== 'terminated', true, '拒绝时什么都没收尾');

  // Chosen: settled offline first (as at an open of that data set, nothing runs), then relocated.
  const c = await relocateOldHomeTo(fixture, 'c-home', {
    settleEarlierMovedWork: (dataSet) => settleEarlierMovedWorkOffline(fixture.root, dataSet.id, INSTALLATION_A)
  });
  assert.deepEqual(c.result.others.migrated, [fixture.alpha.id], '工作区库照常迁走');
  assert.equal((await turnRow(fixture, alpha.turnId, fixture.alpha.binding.paths.dataRootPath)).status, 'terminated', '在 A 里按中止收尾');
  const cNotice = await relocation.readDataRootMovedNotice(fixture.root);
  assert.equal(cNotice.relocationId, c.relocationId);
  assert.equal(cNotice.carriedWork, undefined, '这次没有带走任何未完成的工作');

  const inC = await runsIn(fixture.alpha.id, c.target, 0);
  assert.deepEqual(inC, { calls: 0, tools: [], processes: [] }, 'C 里什么都不执行');
  assert.equal((await turnRow(undefined, alpha.turnId, alphaDataRoot(c.target, fixture.alpha.id))).status, 'terminated');
  const inB = await runsIn(fixture.alpha.id, b.target, 1);
  assert.equal(inB.calls, 1, 'B 里执行一次（B 和 C 合计一次）');
  assert.deepEqual(await runsIn('default', c.target, 0), { calls: 0, tools: [], processes: [] }, 'C 里当前库也什么都不执行');
  assert.equal(current.turnId.length > 0, true);
});

test('遗留风险 1：旧目录里上一次迁走的工作区库从没打开、同意也没记（pending）时，选“先按中止收尾再迁移”即同意：迁移先记下同意再离线收尾，然后迁移', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t);
  const alpha = await admitUnstartedTurn(fixture, { dataRoot: fixture.alpha.binding.paths.dataRootPath, conversationId: 'conversation-alpha-carried' });
  const b = await relocateOldHomeTo(fixture, 'b-home');
  const [entry] = (await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets;
  assert.deepEqual([entry.id, entry.settlement.state], [fixture.alpha.id, 'pending'], '当前库没有迁走的任务，打开 A 不问、也不记同意');
  const plan = await reloc.planWithRuntime(fixture, path.join(fixture.base, 'c-home'));
  assert.deepEqual(plan.earlierMovedWork.dataSets.map((item) => [item.id, item.state]), [[fixture.alpha.id, 'pending']]);

  // A library that cannot be read now may hold that work and cannot be settled: planning refuses, and so does the exclusive phase.
  const scopeRoot = fixture.alpha.scopeRoot;
  await fs.chmod(scopeRoot, 0o000);
  let unreadablePlan;
  try {
    unreadablePlan = await reloc.planWithRuntime(fixture, path.join(fixture.base, 'c-home'));
    assert.match(unreadablePlan.problems.join('\n'), /历史库“旧工作区历史”（现在读不出来，无法收尾）/);
    assert.match(unreadablePlan.problems.join('\n'), /读不出来的历史库要等它能读了才能收尾；在这之前不能迁移/);
    const source = await reloc.openRuntime(fixture.current);
    let staged;
    try { staged = await relocation.stageDataRootRelocation(unreadablePlan, source, { installation: INSTALLATION_A }); } finally { await source.close(); }
    await assert.rejects(relocation.completeDataRootRelocation(staged, async () => undefined, {
      installation: INSTALLATION_A, movedBy: { id: INSTALLATION_A, label: 'VS Code（A）' }, pointerUnchanged: async () => true,
      settleEarlierMovedWork: async () => assert.fail('读不出来的库不收尾')
    }), (error) => error.code === 'data-root-relocation-earlier-moved-work' && /现在读不出来，无法收尾/.test(error.message));
  } finally { await fs.chmod(scopeRoot, 0o755); }

  // Work carried away after the plan was confirmed (the confirmation did not name it): staging refuses.
  const early = await reloc.planWithRuntime(fixture, path.join(fixture.base, 'd-home'));
  const source = await reloc.openRuntime(fixture.current);
  try {
    await assert.rejects(relocation.stageDataRootRelocation({ ...early, earlierMovedWork: undefined }, source, { installation: INSTALLATION_A }),
      (error) => error.code === 'data-root-relocation-changed');
  } finally { await source.close(); }
  // ... or after staging (another relocation from here replaced the notice): the exclusive phase refuses before
  // consenting to or settling anything, and undoes.
  const noticeFile = path.join(fixture.root, relocation.DATA_ROOT_MOVED_NOTICE_FILE);
  const confirmedNotice = await fs.readFile(noticeFile, 'utf8');
  const eTarget = path.join(fixture.base, 'e-home');
  const staged = await stageOldHome(fixture, eTarget, { installation: INSTALLATION_A });
  await fs.writeFile(noticeFile, JSON.stringify({ ...JSON.parse(confirmedNotice), relocationId: randomUUID() }));
  await assert.rejects(relocation.completeDataRootRelocation(staged, async () => undefined, {
    installation: INSTALLATION_A, movedBy: { id: INSTALLATION_A, label: 'VS Code（A）' }, pointerUnchanged: async () => true,
    settleEarlierMovedWork: async () => assert.fail('确认框没有列出的不收尾')
  }), (error) => error.code === 'data-root-relocation-changed' && /确认框没有列出/.test(error.message));
  assert.equal(await pathExists(eTarget), false, '撤销干净');
  assert.equal((await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets[0].settlement.state, 'pending', '没有记同意');
  await fs.writeFile(noticeFile, confirmedNotice);

  // Chosen: the relocation consents first, then settles through a Runtime that is held and can run nothing, never recovered or released.
  const Application = kernel.ReliableKernelApplication;
  const realOpen = Application.open;
  const composed = [];
  Application.open = async function (authority, dependencies) {
    const app = await realOpen.call(this, authority, dependencies);
    const record = { dependencies, recovered: false, released: false };
    composed.push(record);
    const [recover, release] = [app.recover.bind(app), app.releaseRuntimeConvergence.bind(app)];
    app.recover = async (...input) => { record.recovered = true; return recover(...input); };
    app.releaseRuntimeConvergence = (...input) => { record.released = true; return release(...input); };
    return app;
  };
  let c;
  try {
    c = await relocateOldHomeTo(fixture, 'c-home', {
      settleEarlierMovedWork: (dataSet) => settleEarlierMovedWorkOffline(fixture.root, dataSet.id, INSTALLATION_A)
    });
  } finally { Application.open = realOpen; }
  assert.equal(composed.length, 1, '只为那个库打开一次');
  const [{ dependencies, recovered, released }] = composed;
  assert.deepEqual([dependencies.holdRuntimeConvergence, recovered, released], [true, false, false], '扣住收敛，从不恢复、不放开');
  assert.throws(() => dependencies.providers.resolve('any'), /不执行任何工作（模型）/);
  await assert.rejects(dependencies.toolDispatcher.dispatch({}), /不执行任何工作（工具）/);
  await assert.rejects(dependencies.authorityCompiler.compile({}), /不执行任何工作（开始回合）/);
  await assert.rejects(dependencies.mcpConnections.callTool('server', 'tool', {}), /不执行任何工作（MCP）/);
  await assert.rejects(dependencies.mcpPolicyGate.authorize({}), /不执行任何工作（MCP）/);
  assert.equal((await turnRow(fixture, alpha.turnId, fixture.alpha.binding.paths.dataRootPath)).status, 'terminated');
  assert.deepEqual(await runsIn(fixture.alpha.id, c.target, 0), { calls: 0, tools: [], processes: [] });
  assert.equal((await runsIn(fixture.alpha.id, b.target, 1)).calls, 1);
});

test('迁移组 R1：A→B（工作区库带着没收尾的任务迁走）后再从 B 迁回 A（合并进已有目录）：A 的“已迁走”标记保留（规划写明），A 里那个库打开时照旧先问，不会在 A 里再执行一次', { timeout: 300_000 }, async (t) => {
  const fixture = await reloc.createFixture(t);
  await admitUnstartedTurn(fixture, { dataRoot: fixture.alpha.binding.paths.dataRootPath, conversationId: 'conversation-alpha-carried' });
  const b = await relocateOldHomeTo(fixture, 'b-home');
  const noticeFile = path.join(fixture.root, relocation.DATA_ROOT_MOVED_NOTICE_FILE);
  const before = await fs.readFile(noticeFile, 'utf8');
  assert.deepEqual((await relocation.readDataRootMovedNotice(fixture.root)).carriedWork.dataSets.map((item) => [item.id, item.settlement.state]), [[fixture.alpha.id, 'pending']]);
  const bDataRoot = rootAuthority.resolveVscodeRuntimeDataRoot({ globalStoragePath: b.target });
  const source = await reloc.openRuntime({ authority: new kernel.RootAuthority(() => bDataRoot) });
  const options = { movedBy: { id: INSTALLATION_A, label: 'VS Code（A）' }, installation: INSTALLATION_A };
  let staged;
  try {
    const plan = await relocation.planDataRootRelocation({ sourceRootPath: b.target, targetRootPath: fixture.root, sourceDatabase: source, installation: INSTALLATION_A });
    assert.deepEqual(plan.problems, []);
    assert.equal(plan.target.kind, 'limcode');
    assert.ok(plan.warnings.some((warning) => warning.includes(`“${fixture.alpha.id}”`) && /迁入之后那份“已迁走”标记保留，打开这些库时仍会先问你是否按中止收尾/.test(warning)),
      `规划写明标记保留：${JSON.stringify(plan.warnings)}`);
    staged = await relocation.stageDataRootRelocation(plan, source, options);
  } finally { await source.close(); }
  await relocation.completeDataRootRelocation(staged, async () => undefined, { ...options, pointerUnchanged: async () => true });
  assert.equal(await fs.readFile(noticeFile, 'utf8'), before, 'A 的“已迁走”标记原样保留');
  const gate = await relocatedWorkBeforeOpen({
    configurationRootPath: fixture.root, runtimeScopeRootPath: rootAuthority.resolveVscodeRuntimeDataSetScopeRoot(fixture.root, fixture.alpha.id)
  }).then(() => 'open', (error) => error.reason);
  assert.equal(gate, 'moved-work', 'A 里那个库打开时照旧先问（不会直接恢复、再执行一次）');
});

test('迁移组 R2：切换指针之前失败、指针读不出、新目录又看不到时，本安装进行中记录所指的迁移写下的标记不把旧目录当作已迁走（别的安装照旧）；放弃记录时按迁移 id 去掉它、放回它替换的标记，别的迁移 id 不动', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  await admitUnstartedTurn(fixture);
  const noticeFile = path.join(fixture.root, relocation.DATA_ROOT_MOVED_NOTICE_FILE);
  // An earlier relocation's notice (its work all settled here, as settleEarlierMovedWork leaves it).
  const earlier = `${JSON.stringify({
    kind: 'limcode-data-root-moved', targetRootPath: path.join(fixture.base, 'elsewhere'), relocationId: randomUUID(), movedAt: '2026-09-20T08:00:00.000Z',
    installation: { id: '/installations/c', label: 'VS Code（C）' }
  }, null, 2)}\n`;
  await fs.writeFile(noticeFile, earlier);
  const drive = path.join(fixture.base, 'usb');
  const target = path.join(drive, 'new-home');
  await fs.mkdir(drive);
  const options = { movedBy: { id: INSTALLATION_A, label: 'VS Code（A）' }, installation: INSTALLATION_A };
  const staged = await stageOldHome(fixture, target, options);
  const failure = await relocation.completeDataRootRelocation(staged, async () => { throw new Error('写指针失败'); },
    { ...options, pointerUnchanged: async () => { throw new Error('读不出指针'); } }).then(() => undefined, (error) => error);
  assert.match(String(failure?.message), /写指针失败/);
  assert.equal(relocation.dataRootRelocationCleanupState(failure), 'not-cleaned', '指针读不出：什么都不撤销');
  assert.equal((await relocation.readDataRootMovedNotice(fixture.root))?.relocationId, staged.relocationId);
  await reloc.markStagingOwnerDead(target);
  await fs.rename(drive, `${drive}.unplugged`);
  assert.equal(await relocatedWorkBeforeOpen(placementOf(fixture.root)).then(() => 'open', (error) => error.reason), 'moved-work', '别的安装：照旧按已迁走先问');
  assert.equal(await relocatedWorkBeforeOpen(placementOf(fixture.root), { unswitchedRelocationId: staged.relocationId }), undefined,
    '本安装的指针从没切换过去：不当作已迁走');
  assert.equal(await relocation.abandonDataRootMovedNotice(fixture.root, randomUUID()), false, '别的迁移 id：不动');
  assert.equal((await relocation.readDataRootMovedNotice(fixture.root))?.relocationId, staged.relocationId);
  assert.equal(await relocation.abandonDataRootMovedNotice(fixture.root, staged.relocationId), true);
  assert.equal(await fs.readFile(noticeFile, 'utf8'), earlier, '放回它替换的标记');
  await fs.rename(`${drive}.unplugged`, drive);
  assert.equal(await relocatedWorkBeforeOpen(placementOf(fixture.root)), undefined, '盘接回来之后旧目录照常打开（工作只有这一份）');
  assert.equal(await relocation.abandonDataRootMovedNotice(fixture.root, staged.relocationId), false, '再放弃一次：已经不是它的标记');
});

test('迁移组 R4：迁入已有 LimCode 目录失败撤销后，接收库的 CAS 与迁移前一致（本次复制进去的对象删掉，原有的不动）', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t);
  const target = path.join(fixture.base, 'existing-home');
  const existing = await reloc.createLimCodeTarget(target);
  const casRoot = existing.binding.paths.casRootPath;
  const list = async (directory) => {
    const out = [];
    const walk = async (at) => {
      for (const entry of await fs.readdir(at, { withFileTypes: true }).catch(() => [])) {
        const file = path.join(at, entry.name);
        if (entry.isDirectory()) await walk(file); else out.push(path.relative(directory, file));
      }
    };
    await walk(directory);
    return out.sort();
  };
  const before = await list(casRoot);
  const options = { movedBy: { id: INSTALLATION_A, label: 'VS Code（A）' }, installation: INSTALLATION_A };
  const staged = await stageOldHome(fixture, target, options);
  let during;
  const failure = await relocation.completeDataRootRelocation(staged, async () => {
    during = await list(casRoot);
    throw new Error('写指针失败');
  }, { ...options, pointerUnchanged: async () => true }).then(() => undefined, (error) => error);
  assert.equal(relocation.dataRootRelocationCleanupState(failure), 'cleaned');
  assert.ok(during.length > before.length, `前提：迁移往接收库的 CAS 里加了对象（${before.length} → ${during.length}）`);
  assert.deepEqual(await list(casRoot), before, '撤销后接收库的 CAS 与迁移前一致');
});

test('迁移组 R5：合并进已有目录时因目标删过而跳过的对话没有迁过去，不记进“已迁走”的任务（旧目录继续使用时不会被中止收尾）', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const carried = await admitUnstartedTurn(fixture, { conversationId: 'conversation-deleted-in-target' });
  const target = path.join(fixture.base, 'existing-home');
  const existing = await reloc.createLimCodeTarget(target);
  const { recordRuntimeDeletedConversations } = await load('backend/reliableKernel/runtimeMergeTombstones.js');
  await recordRuntimeDeletedConversations(target, { dataSetId: existing.binding.dataSetId, rootInstanceId: existing.binding.rootInstanceId }, [carried.conversationId]);
  const options = { movedBy: { id: INSTALLATION_A, label: 'VS Code（A）' }, installation: INSTALLATION_A };
  const staged = await stageOldHome(fixture, target, options);
  const result = await relocation.completeDataRootRelocation(staged, async () => undefined, { ...options, pointerUnchanged: async () => true });
  assert.deepEqual(result.merged.skippedConversationIds, [carried.conversationId], '合并跳过了它');
  assert.equal(reloc.conversationIds(existing.binding.paths.dataRootPath).includes(carried.conversationId), false);
  const notice = await relocation.readDataRootMovedNotice(fixture.root);
  assert.equal(notice.relocationId, staged.relocationId);
  assert.equal(notice.carriedWork, undefined, '没有迁过去的对话不记成“已迁走”');
  assert.equal(await relocatedWorkBeforeOpen(placementOf(fixture.root)), undefined, '旧目录照常打开，那条任务留在这里');
});

test('迁移组 R6：切换指针之前在目标记录里持久写下“切换中”；之后中断（指针读不出）时其它安装不提供撤销、如实说明；没写到“切换中”就中断的，按“可能没有切换”可以撤销', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'new-home');
  const markerFile = path.join(target, relocation.DATA_ROOT_RELOCATION_MARKER_FILE);
  const options = { movedBy: { id: INSTALLATION_A, label: 'VS Code（A）' }, installation: INSTALLATION_A };
  const staged = await stageOldHome(fixture, target, options);
  let during;
  const failure = await relocation.completeDataRootRelocation(staged, async () => {
    during = JSON.parse(await fs.readFile(markerFile, 'utf8'));
    throw new Error('写指针失败');
  }, { ...options, pointerUnchanged: async () => { throw new Error('读不出指针'); } }).then(() => undefined, (error) => error);
  assert.equal(relocation.dataRootRelocationCleanupState(failure), 'not-cleaned');
  assert.equal(during.state, 'complete');
  assert.match(String(during.switchingAt), /^\d{4}-\d\d-\d\dT/, '切换指针之前已记下切换中');
  await reloc.markStagingOwnerDead(target);
  const refused = await relocation.settleDataRootRelocationBeforeOpen(target, { installation: INSTALLATION_B }).then(() => undefined, (error) => error);
  assert.equal(refused?.reason, 'unpublished');
  assert.equal(refused.cause?.code, 'data-root-relocation-switching');
  assert.match(refused.message, /发起它的安装可能已经切换过来并在用这些数据，所以这里不提供撤销/);
  assert.doesNotMatch(refused.message, /可以撤销那次迁移后打开/);
  await assert.rejects(relocation.undoUnpublishedDataRootRelocation(target), { code: 'data-root-relocation-switching' });
  assert.equal(JSON.parse(await fs.readFile(markerFile, 'utf8')).state, 'complete', '没有撤销');

  // Interrupted before "switching" was written: it never switched, another installation may undo it.
  const marker = JSON.parse(await fs.readFile(markerFile, 'utf8'));
  delete marker.switchingAt;
  await fs.writeFile(markerFile, `${JSON.stringify(marker, null, 2)}\n`);
  const offered = await relocation.settleDataRootRelocationBeforeOpen(target, { installation: INSTALLATION_B }).then(() => undefined, (error) => error);
  assert.equal(offered?.reason, 'unpublished');
  assert.equal(offered.cause, undefined);
  assert.match(offered.message, /没有记下发起它的安装已经切换过去（它可能没有切换）/);
  assert.deepEqual(await relocation.undoUnpublishedDataRootRelocation(target), {});
  await assert.rejects(fs.stat(markerFile), { code: 'ENOENT' });
});

test('迁移组 R8：“已迁走”标记所指的目标记录读不出（不是不存在，例如 EIO）时旧目录按读不出拒绝打开，不当作迁移已不在进行', { timeout: 240_000 }, async (t) => {
  const fixture = await reloc.createFixture(t, { withAlpha: false });
  await admitUnstartedTurn(fixture);
  const { target } = await relocateOldHome(fixture);
  assert.equal(await relocatedWorkBeforeOpen(placementOf(fixture.root)).then(() => 'open', (error) => error.reason), 'moved-work');
  const markerFile = path.join(target, relocation.DATA_ROOT_RELOCATION_MARKER_FILE);
  const fsp = require('node:fs/promises');
  const realReadFile = fsp.readFile;
  const failed = [];
  fsp.readFile = async (file, ...rest) => {
    if (path.resolve(String(file)) === markerFile) {
      failed.push(file);
      throw Object.assign(new Error(`EIO: i/o error, open '${file}'`), { code: 'EIO' });
    }
    return realReadFile(file, ...rest);
  };
  let refused;
  try {
    refused = await relocatedWorkBeforeOpen(placementOf(fixture.root)).then(() => undefined, (error) => error);
  } finally { fsp.readFile = realReadFile; }
  assert.ok(failed.length > 0, '注入的失败确实落在目标记录上');
  assert.equal(refused?.reason, 'unreadable', String(refused?.stack));
  assert.equal(refused.cause?.code, 'EIO');
});

// ---------------------------------------------------------------------------------------------

function dataRootOf(fixture) {
  return fixture.current.binding.paths.dataRootPath;
}

function placementOf(configurationRootPath) {
  return { configurationRootPath, runtimeScopeRootPath: rootAuthority.resolveVscodeRuntimeDataSetScopeRoot(configurationRootPath, 'default') };
}

/** A project window of the old directory admitted a user message's Turn and closed before it called the model. */
async function admitUnstartedTurn(fixture, { dataRoot = dataRootOf(fixture), conversationId = 'conversation-carried' } = {}) {
  const origin = await openHost(dataRoot, countingProvider(), { folders: [PROJECT.uri], label: 'origin', runner: false, running: true });
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

/** A user message queued behind the Conversation's active Turn (admitted by nobody yet). */
async function queueMessage(fixture, conversationId, key = 'input-queued') {
  const origin = await openHost(dataRootOf(fixture), countingProvider(), { folders: [PROJECT.uri], label: 'queue', runner: false, running: true });
  try {
    const queued = await admitTurn(origin.app, conversationId, key);
    assert.equal(queued.admitted, false, '前提：排在进行中的 Turn 后面');
    return queued.intentId;
  } finally { await origin.close(); }
}

/** A user message given to the Conversation the way the Runner does, without running anything. */
async function admitTurn(app, conversationId, key) {
  const hostBootId = app.database.hostBootId;
  return app.database.conversationOwners.run(conversationId, () => app.turns.input({
    source: { kind: 'command', key }, conversationId,
    leaseOwnerId: `test:${hostBootId}`, hostBootId, leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    content: `消息 ${key}`, contentType: 'text/plain; charset=utf-8'
  }));
}

/**
 * Two background Processes the unstarted Turn `turnId` started, finished while its window was
 * gone: one completion already delivered to that Turn (pending), one not dispatched yet.
 */
async function finishedBackgroundProcesses(fixture, conversationId, turnId) {
  const origin = await openHost(dataRootOf(fixture), countingProvider(), { folders: [PROJECT.uri], label: 'origin', runner: false, running: true });
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
  const options = { movedBy: { id: INSTALLATION_A, label: 'VS Code（A）' }, installation: INSTALLATION_A };
  const staged = await stageOldHome(fixture, target, options);
  await relocation.completeDataRootRelocation(staged, async () => undefined, options);
  return { target, relocationId: staged.relocationId };
}

/** A relocation of the old home by installation A to `<base>/<name>` (the test's publish never switches a real pointer). */
async function relocateOldHomeTo(fixture, name, extra = {}) {
  const target = path.join(fixture.base, name);
  const options = { movedBy: { id: INSTALLATION_A, label: 'VS Code（A）' }, installation: INSTALLATION_A, ...extra };
  const staged = await stageOldHome(fixture, target, options);
  const result = await relocation.completeDataRootRelocation(staged, async () => undefined, { ...options, pointerUnchanged: async () => true });
  return { target, relocationId: staged.relocationId, result };
}

function alphaDataRoot(configurationRoot, id) {
  return rootAuthority.resolveVscodeRuntimeDataRoot({ globalStoragePath: rootAuthority.resolveVscodeRuntimeDataSetScopeRoot(configurationRoot, id) });
}

/**
 * Data set `id` of directory `root` opened as an ordinary window of the project would, recovered, and
 * given time to run what it finds: the model calls (waited for until `expected` arrived), tool calls
 * and process starts there.
 */
async function runsIn(id, root, expected) {
  const provider = countingProvider();
  const host = await openHost(alphaDataRoot(root, id), provider, { folders: [PROJECT.uri], label: `runs-${id}`, running: true });
  try {
    await host.recover();
    if (expected > 0) await eventually(async () => provider.calls.length >= expected, 60_000, `没有执行（${root}）`);
    await quiet();
    return { calls: provider.calls.length, ...host.executions };
  } finally { await host.close(); }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function pathExists(file) {
  return fs.access(file).then(() => true, () => false);
}

/** The online stage of a relocation of the old home (with this "window's" Runtime open). */
async function stageOldHome(fixture, target, options) {
  const plan = await reloc.planWithRuntime(fixture, target);
  assert.deepEqual(plan.problems, []);
  const source = await reloc.openRuntime(fixture.current);
  try { return await relocation.stageDataRootRelocation(plan, source, options); } finally { await source.close(); }
}

/**
 * Facade.open's order with the real openSettlingRelocatedWork: consent checked before the open, the
 * Runtime opened with its convergence held when there is carried work, settled, and only then the
 * hold released; the product runtime's startRecovery waits for that release (`released`; the caller
 * recovers). `wrap` stands in for a fault while settling; `opened` runs right after the open. A
 * refused open closed the Runtime again (`refused`, `closed`).
 */
async function openOldHome(fixture, provider, { by = INSTALLATION_B, wrap = (app) => app, opened, write = false } = {}) {
  const state = { hold: undefined, released: false, closed: false, host: undefined, refused: undefined };
  try {
    await openSettlingRelocatedWork(placementOf(fixture.root), by, async (hold) => {
      state.hold = hold;
      state.host = await openHost(dataRootOf(fixture), provider, { folders: [PROJECT.uri], label: 'old-home', write, holdRuntimeConvergence: hold });
      await opened?.(state.host);
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

/** openOldHome that must go ahead with carried work to settle, then the startup recovery. */
async function openSettleAndRecover(fixture, provider, by) {
  const opened = await openOldHome(fixture, provider, { by });
  assert.equal(opened.refused, undefined, `同意之后照常打开：${opened.refused?.stack}`);
  assert.deepEqual([opened.hold, opened.released], [true, true], '有迁走的任务：扣住打开，收尾完才放行');
  try {
    await opened.host.recover();
    await quiet();
  } finally { await opened.host.close(); }
  return opened;
}

async function turnRow(fixture, turnId, dataRoot = dataRootOf(fixture)) {
  return (await rowsOf(fixture, 'Turn', { id: turnId }, dataRoot))[0];
}

/** Rows of the old directory read with nothing of it open in this process (the POSIX lock rule). */
async function rowsOf(fixture, domain, where, dataRoot = dataRootOf(fixture)) {
  const host = await openHost(dataRoot, countingProvider(), { folders: [], label: 'reader', runner: false });
  try { return await rows(host.app, domain, where); } finally { await host.close(); }
}

/**
 * A window of the old directory. Its convergence is held from the open, as when it opens with carried
 * work to settle (openSettlingRelocatedWork), until recover() releases it first, as the product
 * runtime's startRecovery does; `running`: an ordinary window whose convergence runs from the start.
 * `executions` records what runs here besides the model: tool calls and process starts.
 */
async function openHost(dataRoot, provider, options) {
  const folders = [...options.folders];
  const executions = { tools: [], processes: [] };
  const app = await kernel.ReliableKernelApplication.open(
    new kernel.RootAuthority(() => dataRoot),
    { ...fixtureDependencies(provider, options.write === true, executions), holdRuntimeConvergence: options.holdRuntimeConvergence ?? options.running !== true }
  );
  countProcessStarts(app, executions);
  const runner = options.runner === false ? undefined : new ReliableConversationRunner(app, `${options.label}:${app.database.hostBootId}`, () => undefined);
  app.database.conversationOwners.setClaimEligibilityProbe(async (conversationId) => (await evaluateConversationHostEligibility({
    database: app.database,
    contentStore: app.contentStore,
    workspaceFolderUris: () => folders,
    workEnvironments: async () => []
  }, conversationId)).eligible);
  let closed = false;
  const host = {
    app,
    runner,
    executions,
    /** VscodeReliableKernelProductRuntime.startRecovery, in its order (no child Agents here). */
    async recover() {
      app.releaseRuntimeConvergence();
      await app.recover();
      await runner?.recoverStartup();
      await app.refreshExternalRuntimeWork();
    },
    async close() {
      if (closed) return;
      closed = true;
      stillOpen.delete(host);
      runner?.dispose();
      await app.beginHandoff().catch(() => undefined);
      await runner?.waitForIdle().catch(() => undefined);
      await app.close();
    }
  };
  stillOpen.add(host);
  return host;
}

/** Process starts of this window (ProcessControlPlane: prepare, dispatch, launch), recorded in `executions`. */
function countProcessStarts(app, executions) {
  for (const name of ['prepareStart', 'dispatchStart', 'launchDispatched']) {
    const original = app.processes[name].bind(app.processes);
    app.processes[name] = (...input) => { executions.processes.push(name); return original(...input); };
  }
}

function fixtureDependencies(provider, write, executions = { tools: [], processes: [] }) {
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
    createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) => {
      const dispatcher = new kernel.ReliableToolDispatcher({
        database, contentStore, effects: runtime.effects, files, fileMutations, processes, mcp, interactions,
        host: {
          definitions() { return write ? [writeTool] : []; },
          // A write proposes one file change that waits for the user's approval.
          async planFileMutation(_definition, input) {
            return [{ operation: 'create_file', workEnvironmentId: 'work-env-test', planningRoot: await captureFilePlanningRoot(database.binding.paths.dataRootPath), targetPath: `${input.toolCallId}.txt`, targetContent: 'x' }];
          },
          async cancelTurnWaits() {},
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
function countingProvider() {
  return scriptedProvider(null);
}

/** A model call that never answers: the Turn stays in flight in that window. */
function hangingProvider() {
  const calls = [];
  return { providerId: PROVIDER_ID, calls, async sendFullRequest(request) { calls.push(request.conversationId); await new Promise(() => {}); } };
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
    emptyConversationContextHandleStateStep(conversationId, now),
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

/** A worker that keeps running (see runWorker for one that is waited for). */
function spawnWorker(mode, input) {
  const child = spawn(process.execPath, [TEST_FILE], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LIMCODE_RELOCATED_OPENING_WORKER: mode, LIMCODE_RELOCATED_OPENING_INPUT: JSON.stringify(input) }
  });
  child.output = '';
  child.stdout.on('data', (chunk) => { child.output += chunk; });
  child.stderr.on('data', (chunk) => { child.output += chunk; });
  return child;
}

async function waitForFile(child, file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fs.stat(file).then(() => true, () => false)) return;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`worker exited early
${child.output}`);
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}
${child.output}`);
    await sleep(20);
  }
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
