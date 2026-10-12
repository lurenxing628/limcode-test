import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { before, after } from 'node:test';
import {
  createHistoryFixture, openRuntime, openStore, seedConversation, modelAggregate, kernel,
  kernelFile, repo, NOW
} from './fixtures/ci-storage-history.mjs';
import {
  deferred, startService, fakePeer, runMaintenance, exclusive, control, publishHost, publishRequest,
  loadVscode, vscodeStub, dmsLock, freezeWindow
} from './fixtures/ci-storage-authority.mjs';
import {
  claimReplacementAfterWindowsRename, crashedOwnerWithTwoSuccessors, staleRecordRevisionPreservesCommit,
  staleCommonRevisionPreservesRootAndProxy, asyncReleasePreservesReplacementOwner,
  asyncJsonFsyncPreservesPublishedFile, syncJsonFsyncPreservesPublishedFile
} from './fixtures/ci-storage-authority-records.mjs';

let f, database, service;
before(async () => {
  f = await createHistoryFixture();
  database = await openRuntime(f.current);
  service = startService(f.current, { copyPath: path.join(f.base, 'main-copy.sqlite') });
  await service.ready;
});
after(async () => { await service?.stop(); await database?.close(); if (f) await fs.rm(f.base, { recursive: true, force: true }); });
const conversation = id => repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW });
const WORK = { kind: 'work', reason: '任务正在进行' };

test('Windows claim瞬态rename后保留接替owner', claimReplacementAfterWindowsRename);

test('durabilityCheckpoint写回mainfile，旧快照阻塞时拒绝，释放后成功', async t => {
  await database.transaction([conversation('barrier_before')]);
  assert.equal(await service.command('copy-main', { id: 'barrier_before' }), false);
  await database.durabilityCheckpoint();
  assert.equal(await service.command('copy-main', { id: 'barrier_before' }), true);
  const reader = startService(f.current, { mode: 'reader' });
  t.after(() => reader.stop());
  await reader.ready;
  await database.transaction([conversation('barrier_during_snapshot')]);
  await assert.rejects(database.durabilityCheckpoint(), /没能全部写回磁盘.*另一个窗口还在读旧的状态/);
  assert.equal(await service.command('copy-main', { id: 'barrier_during_snapshot' }), false);
  await reader.stop();
  await database.durabilityCheckpoint();
  assert.equal(await service.command('copy-main', { id: 'barrier_during_snapshot' }), true);
});

test('countDomainRows与另一宿主小事务交错，计数只含完整提交', async () => {
  await service.command('writer-open');
  const baseline = await database.countDomainRows();
  const [during] = await Promise.all([database.countDomainRows(), service.command('commit', { id: 'interleave_count_a' })]);
  const first = await database.countDomainRows();
  const [duringSecond] = await Promise.all([database.countDomainRows(), service.command('commit', { id: 'interleave_count_b' })]);
  const second = await database.countDomainRows();
  assert.ok([baseline, baseline + 3].includes(during));
  assert.ok([baseline + 3, baseline + 6].includes(duringSecond));
  assert.deepEqual([first, second], [baseline + 3, baseline + 6]);
});

test('relocatedWorkInventory跨宿主交错仍把新Conversation和活动Turn一起读出', async () => {
  const [during] = await Promise.all([database.relocatedWorkInventory(),
    service.command('commit', { id: 'interleave_inventory' })]);
  const afterCommit = await database.relocatedWorkInventory();
  const inspect = inventory => {
    for (const entry of inventory.conversations.filter(item => item.conversationId.startsWith('interleave_'))) {
      assert.deepEqual(entry.activeTurnIds, [`${entry.conversationId}_turn`]);
      assert.equal(entry.otherRuntimeWork, false);
    }
  };
  inspect(during); inspect(afterCommit);
  assert.ok(afterCommit.conversations.some(item => item.conversationId === 'interleave_inventory'));
  await service.command('writer-close');
});

test('两个真实窗口确认后才下线，全部下线后维护，发起方继续持有自身Runtime', async t => {
  const a = startService(f.current, { name: 'ci-window-a' });
  const b = startService(f.current, { name: 'ci-window-b' });
  t.after(async () => { await a.stop(); await b.stop(); });
  await Promise.all([a.ready, b.ready]);
  await Promise.all([a.command('window-open'), b.command('window-open')]);
  const outcome = await runMaintenance(f, database, 'two-real-windows', {}, async () => {
    await Promise.all([a.waitFor('offline'), b.waitFor('offline')]);
    assert.deepEqual((await exclusive.readExclusiveMaintenanceRequests(f.current.binding.paths)).map(item => item.phase), ['go']);
    return 'maintained';
  });
  assert.equal(outcome.state, 'completed');
  assert.equal(outcome.coordinated, true);
  for (const child of [a, b]) {
    assert.deepEqual(child.events.filter(item => ['confirm', 'release', 'offline'].includes(item.event)).map(item => item.event),
      ['confirm', 'release', 'offline']);
  }
  assert.equal((await database.snapshot([repo('Conversation').get('barrier_before')])).snapshot[0].id, 'barrier_before');
});

test('确认开始与重载前各发草稿保存请求，生产排空timer完成后才重载', async t => {
  const layer = loadVscode('vscode/runtimeExclusiveMaintenance.js');
  const file = await publishHost(f.current.binding, 'draft-peer');
  const saves = [], requested = deferred(), reloaded = deferred();
  let settle;
  const nativeTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    if (milliseconds === 250) {
      settle = () => callback(...args); requested.resolve(milliseconds);
      return nativeTimeout(() => {}, 0);
    }
    return nativeTimeout(callback, milliseconds, ...args);
  });
  t.mock.method(vscodeStub.commands, 'executeCommand', async id => {
    assert.equal(id, 'workbench.action.reloadWindow'); saves.push('reload'); reloaded.resolve();
  });
  const participant = layer.startExclusiveMaintenanceParticipant({
    exclusiveMaintenanceTarget: () => ({ paths: f.current.binding.paths, hostBootId: 'draft-peer' }),
    hasOwnedExecution: async () => false
  }, { countdownSeconds: 0, pollMs: 3600000, processId: 4500999, saveDrafts: () => { saves.push('save'); return 1; } });
  t.after(async () => {
    settle?.(); await participant.dispose(); await fs.rm(file, { force: true }); await participant.unregister();
    await fs.rm(path.join(exclusive.runtimeExclusiveMaintenanceDirectory(f.current.binding.paths), 'requests', 'draft-request.json'), { force: true });
  });
  await publishRequest(f.current.binding.paths, 'draft-request', 'prepare'); await participant.checkNow();
  await publishRequest(f.current.binding.paths, 'draft-request', 'confirm'); await participant.checkNow();
  await publishRequest(f.current.binding.paths, 'draft-request', 'go');
  const releasing = participant.checkNow();
  assert.equal(await requested.promise, 250);
  assert.deepEqual(saves, ['save', 'save']);
  settle(); await reloaded.promise; await releasing;
  assert.deepEqual(saves, ['save', 'save', 'reload']);
});

test('Host身份未知时不发布go、不执行维护', async t => {
  const file = path.join(f.current.binding.paths.dataRootPath, 'host-liveness', 'unknown.json');
  await fs.writeFile(file, '{');
  t.after(() => fs.rm(file, { force: true }));
  let runs = 0;
  const result = await runMaintenance(f, database, 'unknown-host', {}, async () => { runs++; });
  assert.equal(result.state, 'legacy-host');
  assert.equal(runs, 0);
  assert.deepEqual(await exclusive.readExclusiveMaintenanceRequests(f.current.binding.paths), []);
});

test('忙窗口结束前只在锁外等待，新窗口可取锁并加入协调', async t => {
  const busy = await fakePeer(t, f.current.binding, 'busy-peer', { busy: WORK });
  const waiting = deferred();
  const operation = runMaintenance(f, database, 'busy-outside-lock', { whenBusy: 'wait',
    onProgress: item => { if (item.stage === 'waiting-busy') waiting.resolve(); } }, async () => 'done');
  await waiting.promise;
  await control.withRuntimeDataRootAdmission(f.root, () => control.withRuntimeMaintenance(f.current.binding.paths, async () => {}));
  const late = await fakePeer(t, f.current.binding, 'late-peer', { startedAt: new Date().toISOString() });
  busy.setBusy(undefined);
  const completed = await operation;
  assert.equal(completed.state, 'completed', JSON.stringify(completed));
  assert.deepEqual([busy.releases(), late.releases()], [1, 1]);
});

test('go前取消不执行，go之后取消仍按协调提交权威完成', async t => {
  const peer = await fakePeer(t, f.current.binding, 'cancel-peer');
  let runs = 0;
  const beforeGo = await runMaintenance(f, database, 'cancel-before-go', { isCancelled: () => true }, async () => { runs++; });
  assert.equal(beforeGo.state, 'cancelled');
  assert.equal(peer.releases(), 0);
  const afterGo = await runMaintenance(f, database, 'cancel-after-go', { isCancelled: () => peer.releases() > 0 }, async () => { runs++; });
  assert.equal(afterGo.state, 'completed');
  assert.equal(runs, 1);
});

test('同一工作两个请求仅较早者执行，较新者superseded', async t => {
  const peer = await fakePeer(t, f.current.binding, 'same-work-peer', { busy: WORK });
  const waiting = deferred();
  let runs = 0;
  const ownParticipant = exclusive.startExclusiveMaintenanceParticipant(f.current.binding.paths, database.hostBootId, {
    busyReason: async () => undefined, confirm: async () => true, release: async () => assert.fail('发起方不能自重载')
  }, { pollMs: 2, processId: 4501000 });
  t.after(async () => { await ownParticipant.dispose(); await ownParticipant.unregister(); });
  await ownParticipant.checkNow();
  const first = runMaintenance(f, database, 'same-work', { whenBusy: 'wait',
    onProgress: item => { if (item.stage === 'waiting-busy') waiting.resolve(); } }, async () => { runs++; });
  await waiting.promise;
  const second = await runMaintenance(f, database, 'same-work', { requesterHostBootId: 'same-work-peer' }, async () => { runs++; });
  assert.equal(second.state, 'superseded');
  peer.setBusy(undefined);
  assert.equal((await first).state, 'completed');
  assert.equal(runs, 1);
});

test('beforeGo在确认后冻结，退回锁外及操作失败都解除冻结', async t => {
  const peer = await fakePeer(t, f.current.binding, 'before-go-peer');
  const log = [];
  let rounds = 0;
  await assert.rejects(runMaintenance(f, database, 'before-go-freeze', { whenBusy: 'wait', beforeGo: async () => {
    const round = ++rounds;
    assert.ok(peer.log.some(item => item[0] === 'confirm'));
    log.push(`freeze-${round}`);
    return { ...(round === 1 ? { busy: WORK } : {}), thaw: () => log.push(`thaw-${round}`) };
  } }, async () => { log.push('operation'); throw new Error('injected operation failure'); }), /injected operation failure/);
  assert.deepEqual(log, ['freeze-1', 'thaw-1', 'freeze-2', 'operation', 'thaw-2']);
  assert.equal(peer.releases(), 1);
  assert.equal((await database.snapshot([repo('Conversation').get('barrier_before')])).snapshot[0].id, 'barrier_before');
});

test('维护分块只提交完整模型聚合，缺Operation整笔回滚后仍可写', async () => {
  const initial = await openRuntime(f.alpha);
  let recipe;
  try {
    const store = openStore(f.alpha, initial);
    await seedConversation(initial, store, 'maintenance_seed');
    recipe = await store.ingest(initial, '{}', 'application/json');
  } finally { await initial.close(); }
  await control.withRuntimeMaintenance(f.alpha.binding.paths, async () => {
    const maintenance = await kernel.RuntimeDatabase.open(f.alpha.authority, { maintenance: true, hostBootId: 'ci-maintenance' });
    try {
      const [operation, attempt, request, fence] = modelAggregate('maintenance_seed_turn', 'complete_aggregate', recipe.id);
      await maintenance.maintenanceBegin();
      assert.equal((await maintenance.inspect()).synchronous, 2n);
      await maintenance.maintenanceAppend([request]);
      await maintenance.maintenanceAppend([operation, attempt, fence]);
      await maintenance.maintenanceCommit();
      assert.ok((await maintenance.snapshot([repo('ModelRequest').get('complete_aggregate')])).snapshot[0]);
      const [, , broken] = modelAggregate('maintenance_seed_turn', 'missing_aggregate', recipe.id);
      broken.row.request_seq = 2n;
      await maintenance.maintenanceBegin();
      await maintenance.maintenanceAppend([broken]);
      await maintenance.maintenanceAppend([conversation('rolled_back')]);
      await assert.rejects(maintenance.maintenanceCommit(), /must own exactly one Operation/);
      assert.equal((await maintenance.snapshot([repo('Conversation').get('rolled_back')])).snapshot[0], null);
      assert.equal((await maintenance.snapshot([repo('ModelRequest').get('missing_aggregate')])).snapshot[0], null);
      await maintenance.transaction([conversation('after_rollback')]);
    } finally { await maintenance.close(); }
  });
});

test('冻结拒绝新输入并保留草稿，读取可用无模型调用，解冻后同输入准入', async t => {
  const window = await freezeWindow(f.alpha);
  t.after(() => window.close());
  t.mock.method(console, 'error', () => {});
  const { BridgeMessageType } = loadVscode('shared/protocol.js');
  const { emptyConversationContextHandleStateStep } = kernelFile('conversationContextHandleState.js');
  await window.app.database.transaction([conversation('freeze-conversation'), emptyConversationContextHandleStateStep('freeze-conversation', NOW),
    repo('AgentConversationLink').insert({ id: 'freeze-agent-link', conversation_id: 'freeze-conversation', agent_id: 'agent-main',
      role: 'default', created_at: NOW, updated_at: NOW })]);
  const thaw = window.facade.freezeNewWork('迁移数据目录');
  const payload = { conversationId: 'freeze-conversation', text: '尚未发送的原文',
    command: { commandId: 'freeze-input', expectedVersion: 0, issuedAt: Date.now() } };
  const refused = (await window.send({ type: BridgeMessageType.TurnStart, payload })).find(message => message.type === BridgeMessageType.TurnInputResult);
  assert.equal(refused.payload.status, 'rejected');
  assert.equal(refused.payload.admitted, false);
  assert.equal(payload.text, '尚未发送的原文');
  assert.equal(window.provider.calls, 0);
  const ping = await window.send({ type: BridgeMessageType.Ping, payload: { text: '只读' } });
  assert.equal(ping.find(message => message.type === BridgeMessageType.Pong).payload.text, '只读');
  thaw();
  const accepted = (await window.send({ type: BridgeMessageType.TurnStart, payload })).find(message => message.type === BridgeMessageType.TurnInputResult);
  assert.equal(accepted.payload.admitted, true);
  await window.provider.started;
  assert.equal(window.provider.calls, 1);
  await window.runner.waitForIdle();
});

test('正式read拒绝SQLite-shm及别名，不打开受保护文件且普通文件可读', async t => {
  const shm = `${f.current.binding.paths.databasePath}-shm`;
  const alias = path.join(f.base, 'shm-alias.txt');
  await fs.link(shm, alias);
  await fs.writeFile(path.join(f.base, 'notes.txt'), '普通正文');
  const prior = await dmsLock(shm);
  const { readFileTool } = loadVscode('backend/world/modules/tools/definitions/readFile/index.js');
  const { createVsCodeFsCapability } = loadVscode('backend/capabilities/vscodeFs.js');
  const environment = { id: 'ci-file-environment', kind: 'localFolder', source: 'workspaceFolder', name: 'fixture',
    uri: `file://${f.base}`, rootPath: f.base, displayPath: f.base, index: 0, available: true, createdAt: 1, updatedAt: 1 };
  const context = { workEnvironment: environment, accessibleWorkEnvironments: [environment], config: {} };
  const open = fs.open, read = fs.readFile;
  const touched = [];
  t.mock.method(fs, 'open', async (file, ...args) => { touched.push(String(file)); return open(file, ...args); });
  t.mock.method(fs, 'readFile', async (file, ...args) => { touched.push(String(file)); return read(file, ...args); });
  await assert.rejects(readFileTool.execute({ path: alias }, { fs: createVsCodeFsCapability() }, context),
    /拒绝在 LimCode 扩展宿主进程内访问 SQLite 数据库文件/);
  assert.equal(touched.some(file => file === shm || file === alias), false);
  assert.equal(await dmsLock(shm), prior);
  assert.notEqual(prior, 'acquired');
  assert.match((await readFileTool.execute({ path: path.join(f.base, 'notes.txt') }, { fs: createVsCodeFsCapability() }, context)).output.content, /普通正文/);
});

test('SQLite已登记硬链接身份检查EACCES时不准入读取', async t => {
  const guard = loadVscode('backend/capabilities/filesystem/sqliteDatabaseFileGuard.js');
  const alias = path.join(f.base, 'database-alias.bin');
  await fs.link(f.current.binding.paths.databasePath, alias);
  const stat = fs.stat;
  let reads = 0, faults = 0;
  t.mock.method(fs, 'stat', async (file, ...args) => {
    if (String(file) === f.current.binding.paths.databasePath) { faults++;
      throw Object.assign(new Error('injected registered-file stat'), { code: 'EACCES', syscall: 'stat' }); }
    return stat(file, ...args);
  });
  await assert.rejects(async () => { await guard.assertNotSqliteDatabaseFile(alias); reads++; await fs.readFile(alias); },
    error => error.code === 'EACCES' || error.cause?.code === 'EACCES');
  assert.ok(faults > 0); assert.equal(reads, 0);
});

test('崩溃owner后两个真实后继串行提交，索引正文不丢不重', crashedOwnerWithTwoSuccessors);
test('旧record revision遭冲突时已提交新记录保持', staleRecordRevisionPreservesCommit);
test('旧common revision不能覆盖当前配置根和代理', staleCommonRevisionPreservesRootAndProxy);
test('异步锁release恢复保留替换owner，不执行旧action', asyncReleasePreservesReplacementOwner);
test('异步原子JSON先fsync再发布，fsync失败保持旧文件', asyncJsonFsyncPreservesPublishedFile);
test('同步原子JSON先fsync再发布，fsync失败保持旧文件', syncJsonFsyncPreservesPublishedFile);
