import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { before, after, test } from 'node:test';
import commandFixture from './fixtures/ci-storage-command-fixture.cjs';
import {
  kernel, load, roots, registry, relocation, NOW, temporaryRoot, initializeRoot,
  openDatabase, seedMessages, writeStore, selected, move, readRows, readBodies
} from './fixtures/ci-storage-relocation.mjs';
import { commands, globalStatus, MockUri, ui, context, openWindow, restoreVscodeLoader } from './fixtures/ci-storage-vscode.mjs';
import { runCommittedRelocationRecovery } from './fixtures/ci-storage-relocation-crash.mjs';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

let base, source, alpha, metadata, moved;
const ids = rows => rows.map(row => row.id);
const file = (root, relative) => path.join(root, relative);
const read = (root, relative) => fs.readFile(file(root, relative), 'utf8');

before(async () => {
  base = await temporaryRoot('limcode-ci-relocation-');
  source = await initializeRoot(file(base, 'source'));
  await roots.selectVscodeRuntimeDataSet({ globalStoragePath: source.root }, 'default');
  metadata = await seedMessages(source, [{ id: 'source-one' }, { id: 'source-two' }]);
  const scope = roots.resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: ['file:///workspace/retained'] });
  alpha = await initializeRoot(roots.resolveVscodeWorkspaceRuntimeScopeRoot({ globalStoragePath: source.root }, scope), `workspace:${scope.key}`);
  await seedMessages(alpha, [{ id: 'retained-source' }]);
  await writeStore(source.root, 'agents', 'agent', [{ id: 'shared', name: 'source version' }, { id: 'source-only', name: 'source only' }]);
  await writeStore(source.root, 'settings/llm-provider-configs', 'record', [{ id: 'provider', model: 'source model' }]);
  await fs.writeFile(file(source.root, 'settings/llm.json'), '{"activeProviderConfigId":"provider"}\n');
  await fs.writeFile(file(source.root, 'settings/conversation-source-one-llm.json'), '{"model":"conversation model"}\n');
  await fs.writeFile(file(source.root, 'AGENTS.md'), '# source global rules\n');
  await fs.mkdir(file(source.root, 'skills/a/references/nested'), { recursive: true });
  await fs.writeFile(file(source.root, 'skills/a/SKILL.md'), '# source skill\n');
  await fs.writeFile(file(source.root, 'skills/a/references/nested/details.md'), 'source nested reference\n');
  await fs.writeFile(file(source.root, 'notes.txt'), 'user file outside registered settings');
  const brokenScope = roots.resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: ['file:///workspace/broken'] });
  const broken = roots.resolveVscodeWorkspaceRuntimeScopeRoot({ globalStoragePath: source.root }, brokenScope);
  await fs.mkdir(broken, { recursive: true });
  await registry.writeRuntimeHistoryResidual({ globalStoragePath: source.root }, {
    id: `workspace:${brokenScope.key}`, sourceKind: 'local', location: { kind: 'local', candidateId: `workspace:${brokenScope.key}` },
    code: 'fixture-unreadable', message: '原位保留的不可读来源', checkedAt: NOW
  });
});

after(async () => {
  restoreVscodeLoader();
  if (base) await fs.rm(base, { recursive: true, force: true });
});

test('确认面板只按checked默认勾选，答复发送当前选择并清空下一面板', async () => {
  const pinia = await import('pinia');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const listeners = [], posted = [];
  globalThis.window = { addEventListener(type, listener) { if (type === 'message') listeners.push(listener); }, removeEventListener() {}, setTimeout, clearTimeout,
    acquireVsCodeApi() { return { postMessage(message) { posted.push(message); }, getState() { return {}; }, setState() {} }; } };
  const server = await createWebviewSsrServer();
  try {
    const { useDataRootPromptStore } = await server.ssrLoadModule('/src/stores/useDataRootPromptStore.ts');
    pinia.setActivePinia(pinia.createPinia());
    const store = useDataRootPromptStore();
    store.initialize();
    const deliver = payload => listeners.forEach(listener => listener({ data: { id: payload.flowId, type: 'dataRoot.prompt', payload } }));
    deliver({ flowId: 'first', title: '清理', sections: [{ lines: [], options: [{ key: 'complete', label: '完整', checked: true }, { key: 'replaced', label: '替换' }] }], actions: [] });
    assert.deepEqual([...store.include], ['complete']);
    store.toggle('complete', false);
    store.toggle('replaced', true);
    store.answer('delete');
    assert.deepEqual(posted.at(-1).payload, { action: 'answer', flowId: 'first', choice: 'delete', include: ['replaced'] });
    deliver({ flowId: 'next', title: '确认', sections: [], actions: [] });
    assert.deepEqual([...store.include], []);
    store.answer('cancel');
  } finally {
    await server.close();
    globalThis.window = previousWindow;
    if (previousPinia) pinia.setActivePinia(previousPinia);
  }
});

test('在线准备取消后清除pending，不进入独占关闭或切换', async () => {
  const f = commandFixture.fixture({ answers: [{ choice: 'relocate', include: [] }], cancelStage: true });
  await f.commands.relocateDataRoot(f.context, f.startup, f.request);
  assert.equal(f.status.pendingRelocation, undefined);
  assert.equal(f.cancellation.listeners.length, 0);
  assert.deepEqual(f.kinds().filter(kind => ['exclusive', 'close-runtime', 'complete', 'command'].includes(kind)), []);
});

test('冻结后新任务出现时解冻，下一轮空闲再关闭Runtime', async () => {
  let checks = 0;
  const f = commandFixture.fixture({ answers: [{ choice: 'relocate', include: [] }], busy: ({ frozen }) => frozen && ++checks === 1 });
  await f.commands.relocateDataRoot(f.context, f.startup, f.request);
  assert.deepEqual(f.kinds().filter(kind => ['locks', 'freeze', 'thaw', 'close-runtime'].includes(kind)),
    ['locks', 'freeze', 'thaw', 'locks', 'freeze', 'close-runtime', 'thaw']);
  assert.equal(f.frozen(), 0);
});

test('已切换指针后的收尾错误保留新根并按完成处理', async () => {
  const f = commandFixture.fixture({ answers: [{ choice: 'relocate', include: [] }], afterLocksError: new Error('EIO: cleanup') });
  await f.commands.relocateDataRoot(f.context, f.startup, f.request);
  assert.equal(f.kinds().includes('abandon'), false);
  assert.equal(f.status.dataRootPath, commandFixture.TARGET);
  assert.equal(f.status.pendingRelocation, undefined);
  assert.equal(f.calls.find(call => call[0] === 'error')[1], '数据目录迁移已完成');
});

test('带回删除闭包失败时回旧目录保持原指针', async () => {
  const f = commandFixture.fixture({
    lastMigration: { fromPath: '/data/older', toPath: commandFixture.SOURCE, migratedAt: NOW, relocationId: 'previous' },
    answers: [{ choice: 'return', include: [] }], carryBackError: new Error('删除记录读取失败'),
    movedNotice: { targetRootPath: commandFixture.SOURCE, relocationId: 'previous', movedAt: NOW,
      installation: { id: '/vscode/global-storage', label: 'Code' } }
  });
  await f.commands.returnToPreviousDataRoot(f.context, f.startup, f.request);
  assert.equal(f.kinds().includes('carry-back'), true);
  assert.equal(f.status.dataRootPath, commandFixture.SOURCE);
  assert.equal(f.calls.some(call => call[0] === 'status' && call[1].dataRootPath === '/data/older'), false);
  assert.match(JSON.stringify(f.calls.filter(call => call[0] === 'error')), /删除记录读取失败/);
});

test('新根只迁当前库及登记配置，旧来源原位、用户消息和CAS字节保留', async () => {
  moved = await move(source, file(base, 'moved'));
  assert.equal((await roots.inspectVscodeRuntimeDataSets({ globalStoragePath: moved.target.root })).candidates.length, 1);
  assert.deepEqual(ids(readRows(moved.target.binding.paths.dataRootPath, 'conversation')), ['source-one', 'source-two']);
  assert.deepEqual(ids(readRows(alpha.binding.paths.dataRootPath, 'conversation')), ['retained-source']);
  for (const relative of ['AGENTS.md', 'skills/a/SKILL.md', 'skills/a/references/nested/details.md', 'settings/llm.json', 'settings/conversation-source-one-llm.json', 'settings/llm-provider-configs/records/provider.json']) {
    assert.equal(await read(moved.target.root, relative), await read(source.root, relative), relative);
  }
  await assert.rejects(fs.stat(file(moved.target.root, 'notes.txt')), { code: 'ENOENT' });
  assert.deepEqual(await readBodies(moved.target, metadata), metadata.map(item => item.body));
  const pending = [...(await registry.readRuntimeHistoryPending({ globalStoragePath: moved.target.root })).values()];
  assert.equal(pending.find(item => item.identity?.dataSetId === alpha.binding.dataSetId).location.containerPath, path.dirname(alpha.binding.paths.dataRootPath));
  const residual = [...(await registry.readRuntimeHistoryResidual({ globalStoragePath: moved.target.root })).values()];
  assert.equal(residual.length, 1);
  assert.equal(residual[0].message, '原位保留的不可读来源');
  assert.equal(await read(source.root, 'notes.txt'), 'user file outside registered settings');
});

test('来源拷来的目录在任何目标写入前拒绝，源和目标文件保留', async () => {
  const target = file(base, 'copied');
  await fs.cp(source.root, target, { recursive: true });
  const before = await read(target, 'AGENTS.md');
  const plan = await relocation.planDataRootRelocation({ sourceRootPath: source.root, targetRootPath: target });
  assert.equal(plan.target.kind, 'occupied');
  let changes = 0;
  await assert.rejects(relocation.stageDataRootRelocation(plan, { beforeTargetChange() { changes++; } }), { code: 'data-root-relocation-precondition' });
  assert.equal(changes, 0);
  assert.equal(await read(target, 'AGENTS.md'), before);
  assert.equal(await read(source.root, 'AGENTS.md'), before);
});

test('准备后目标被在线Host打开时拒绝提交，原记录不变', async () => {
  const database = await openDatabase(source);
  let staged;
  try {
    const plan = await relocation.planDataRootRelocation({ sourceRootPath: source.root, targetRootPath: moved.target.root, sourceDatabase: database });
    assert.deepEqual(plan.problems, []);
    staged = await relocation.stageDataRootRelocation(plan, database);
  } finally { await database.close(); }
  const host = await openDatabase(moved.target);
  try { await assert.rejects(relocation.completeDataRootRelocation(staged, async () => {}), { code: 'data-root-relocation-target-busy' }); }
  finally { await host.close(); }
  assert.deepEqual(ids(readRows(moved.target.binding.paths.dataRootPath, 'conversation')), ['source-one', 'source-two']);
});

test('迁移留下的技能深层文件后来修改时撤销held，用户内容和对话保留', async () => {
  const targetRoot = file(base, 'held');
  const database = await openDatabase(source);
  let staged;
  try {
    const plan = await relocation.planDataRootRelocation({ sourceRootPath: source.root, targetRootPath: targetRoot, sourceDatabase: database });
    staged = await relocation.stageDataRootRelocation(plan, database);
  } finally { await database.close(); }
  await assert.rejects(relocation.completeDataRootRelocation(staged, async () => { throw new Error('publish interrupted'); }));
  const markerFile = file(targetRoot, relocation.DATA_ROOT_RELOCATION_MARKER_FILE);
  const marker = JSON.parse(await fs.readFile(markerFile, 'utf8'));
  marker.owner = { processId: spawnSync(process.execPath, ['-e', '']).pid };
  await fs.writeFile(markerFile, JSON.stringify(marker));
  await fs.writeFile(file(targetRoot, 'skills/a/references/nested/details.md'), 'user edit after migration\n');
  assert.equal(await relocation.recoverInterruptedDataRootRelocation({ targetRootPath: targetRoot, relocationId: staged.relocationId }), 'held');
  assert.equal(await read(targetRoot, 'skills/a/references/nested/details.md'), 'user edit after migration\n');
  assert.deepEqual(ids(readRows((await selected(targetRoot)).runtimeDataRootPath, 'conversation')), ['source-one', 'source-two']);
});

test('旧目录后续新增对话和修改设置后清理保留这些内容与未迁来源', async () => {
  await seedMessages(source, [{ id: 'later-user-input', text: '迁移之后新增的输入' }]);
  await fs.writeFile(file(source.root, 'settings/llm.json'), '{"activeProviderConfigId":"later"}\n');
  const plan = await relocation.planOldDataRootDeletion({ oldRootPath: source.root, currentRootPath: moved.target.root, relocationId: moved.staged.relocationId });
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.items.find(item => item.key === 'data-set:default').deletable, false);
  assert.equal(plan.items.find(item => item.key === 'configuration:settings').deletable, false);
  const confirmedKeys = plan.items.filter(item => item.deletable && !item.optional).map(item => item.key);
  await relocation.deleteOldDataRoot({ oldRootPath: source.root, currentRootPath: moved.target.root, relocationId: moved.staged.relocationId, confirmedKeys });
  assert.ok(ids(readRows(source.binding.paths.dataRootPath, 'conversation')).includes('later-user-input'));
  assert.equal(await read(source.root, 'settings/llm.json'), '{"activeProviderConfigId":"later"}\n');
  assert.equal(await read(source.root, 'notes.txt'), 'user file outside registered settings');
  assert.deepEqual(ids(readRows(alpha.binding.paths.dataRootPath, 'conversation')), ['retained-source']);
});

test('连续迁移与回旧目录经真实协调冻结关闭，登记仍指向最初来源且保留对话', async t => {
  const storage = file(base, 'vscode-storage');
  await fs.mkdir(storage);
  const ctx = context(storage);
  await globalStatus.saveGlobalStatus(ctx, moved.target.root, '');
  const first = await openWindow(t, moved.target.root);
  ui.calls.length = 0;
  ui.picked = file(base, 'coordinated');
  await commands.relocateDataRoot(ctx, first.startup, { clientId: 'storage' });
  assert.equal(first.window.closed, true);
  assert.equal(first.window.frozenWhenClosed, 1);
  assert.equal((await globalStatus.loadCommittedGlobalStatus(ctx)).dataRootPath, ui.picked);
  assert.deepEqual(ids(readRows((await selected(ui.picked)).runtimeDataRootPath, 'conversation')), ['source-one', 'source-two']);
  const pending = [...(await registry.readRuntimeHistoryPending({ globalStoragePath: ui.picked })).values()];
  assert.equal(pending.find(item => item.identity?.dataSetId === alpha.binding.dataSetId).location.containerPath, path.dirname(alpha.binding.paths.dataRootPath));
  const residual = [...(await registry.readRuntimeHistoryResidual({ globalStoragePath: ui.picked })).values()];
  assert.equal(residual[0].location.baseDataRootPath, source.root);
  assert.equal((await roots.inspectVscodeRuntimeDataSets({ globalStoragePath: ui.picked })).candidates.length, 1);
  assert.deepEqual(ids(readRows(alpha.binding.paths.dataRootPath, 'conversation')), ['retained-source']);
  const second = await openWindow(t, ui.picked);
  await commands.returnToPreviousDataRoot(ctx, second.startup, { clientId: 'storage' });
  assert.equal(second.window.closed, true);
  assert.equal((await globalStatus.loadCommittedGlobalStatus(ctx)).dataRootPath, moved.target.root);
  assert.deepEqual(ids(readRows(moved.target.binding.paths.dataRootPath, 'conversation')), ['source-one', 'source-two']);
});

test('另一个窗口切换目录后旧窗口配置读写被固定根栅栏拒绝', async () => {
  const storage = file(base, 'pinned-storage');
  await fs.mkdir(storage);
  const ctx = context(storage);
  await globalStatus.saveGlobalStatus(ctx, moved.target.root, '');
  const { pinnedDataRootPaths } = load('backend/application/reliableKernel/VscodeReliableKernelProductRuntime.js');
  const getPaths = pinnedDataRootPaths(ctx, moved.target.root);
  assert.equal(getPaths().globalStorageUri.fsPath, moved.target.root);
  await globalStatus.saveGlobalStatus(context(storage), file(base, 'elsewhere'), '');
  await globalStatus.loadCommittedGlobalStatus(ctx);
  assert.throws(getPaths, /数据目录已在其它窗口切换/);
});

test('不同Workspace共享固定当前Runtime根，工作环境身份保持独立', async () => {
  const first = roots.resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: ['file:///workspace/first'] });
  const second = roots.resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: ['file:///workspace/second'] });
  assert.notEqual(first.key, second.key);
  const a = await roots.resolveVscodeWorkspaceRuntimePlacement({ globalStoragePath: moved.target.root }, first);
  const b = await roots.resolveVscodeWorkspaceRuntimePlacement({ globalStoragePath: moved.target.root }, second);
  assert.equal(a.runtimeDataRootPath, b.runtimeDataRootPath);
  assert.equal(a.runtimeDataRootPath, moved.target.binding.paths.dataRootPath);
});

test('共享环境目录保持持久available，各窗口快照按自身环境投影', async () => {
  const { createVscodeStoragePaths } = load('backend/capabilities/vscodeStorage/paths.js');
  const { VscodeConfigurationAuthority } = load('backend/reliableKernel/vscodeConfigurationAuthority.js');
  const { loadRecordStore } = load('backend/capabilities/vscodeStorage/recordStore.js');
  const { workEnvironmentIdFromUri } = load('shared/workEnvironmentCatalog.js');
  const paths = createVscodeStoragePaths(MockUri.file(file(base, 'configuration')));
  const first = new VscodeConfigurationAuthority(() => paths), second = new VscodeConfigurationAuthority(() => paths);
  const env = label => ({ uri: MockUri.file(file(base, label)).toString(), name: label, rootPath: file(base, label), index: 0 });
  const a = env('first-env'), b = env('second-env');
  await first.synchronizeWorkspaceFolders([a]);
  await second.synchronizeWorkspaceFolders([b]);
  const stored = await loadRecordStore(paths.workEnvironmentsRootUri, paths.workEnvironmentsIndexUri, 'workEnvironment');
  assert.equal(stored.find(item => item.id === workEnvironmentIdFromUri(a.uri)).available, true);
  assert.equal(stored.find(item => item.id === workEnvironmentIdFromUri(b.uri)).available, true);
  const snapshot = await first.configurationClientState();
  assert.equal(snapshot.workEnvironments.find(item => item.id === workEnvironmentIdFromUri(a.uri)).available, true);
  assert.equal(snapshot.workEnvironments.find(item => item.id === workEnvironmentIdFromUri(b.uri)).available, false);
});

test('合并提交后未记received便中断，恢复保留接收库原消息配置与CAS', runCommittedRelocationRecovery);
