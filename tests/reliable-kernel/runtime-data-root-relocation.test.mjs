import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createFixture, createLimCodeTarget, crossDevice, databaseRows, deleteAsConfirmed, initialize, kernel, kernelFile, markStagingOwnerDead,
  openRuntime, planWithRuntime, readDatabase, relocate, relocation, repo, RootAuthority, rootAuthority, selectedDataSet, treeSnapshot,
  withRuntime, writeRecordStore, Database, NOW, PROJECT
} from './runtime-data-root-relocation-fixture.mjs';

const {
  DATA_ROOT_IDENTITY_FILE, DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY, DATA_ROOT_RELOCATION_MARKER_FILE, DataRootUnavailableError,
  abandonStagedDataRootRelocation, assertDataRootAvailable, ensureDataRootIdentity, finalizeDataRootRelocation, planDataRootRelocation,
  planOldDataRootDeletion, readDataRootIdentity, stageDataRootRelocation
} = relocation;
const { readRuntimeDataSetMergeStates } = kernelFile('runtimeDataSetMerge.js');
const {
  inspectVscodeRuntimeDataSets, isVscodeRuntimeDataSetKept, resolveVscodeWorkspaceRuntimeScope, resolveVscodeWorkspaceRuntimeScopeRoot
} = rootAuthority;

test('迁移到空目录：当前库与其它库按原 id 迁入、设置逐文件复制、完成记录写明来源指纹、最后才切换指针；旧目录的数据不变', async (t) => {
  const fixture = await createFixture(t);
  const target = path.join(fixture.base, 'moved', 'data');
  const sourceConfigBefore = await treeSnapshot(path.join(fixture.root, 'agents'));
  const plan = await planWithRuntime(fixture, target);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.target.kind, 'empty');
  assert.equal(plan.current.id, 'default');
  assert.equal(plan.current.rows, undefined, '迁入新建根不统计行数（按批写入，不受单事务上限）');
  assert.ok(plan.current.casBytes > 0 && plan.current.databaseBytes > 0);
  assert.deepEqual(plan.others.map((item) => item.id), [fixture.alpha.id]);
  assert.ok(plan.space.length > 0 && plan.space.every((space) => space.requiredBytes > 0));

  const published = [];
  const { result } = await relocate(fixture, plan, { publish: async (publication) => { published.push(publication); } });
  assert.equal(published.length, 1, '指针只在全部完成后切换一次');
  assert.equal(published[0].dataRootId, await readDataRootIdentity(target), '指针记录新目录的身份');
  assert.equal(result.merged.insertedConversations, 2);
  assert.deepEqual(result.others, { migrated: [fixture.alpha.id], covered: [], leftBehind: [] });
  assert.equal(result.configuration.replacedFiles, 0);
  assert.ok(result.configuration.copiedFiles >= 3);

  const inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: target });
  assert.deepEqual(inspection.problems, []);
  const selected = inspection.candidates.find((candidate) => candidate.selected);
  assert.equal(selected?.id, 'default');
  assert.notEqual(selected.dataSetId, fixture.current.binding.dataSetId, '新目录是全新的根，不复制旧 RootBinding');
  const moved = readDatabase(selected.runtimeDataRootPath);
  try {
    assert.deepEqual(moved.ids('conversation'), ['conversation_current_1', 'conversation_current_2']);
    assert.deepEqual(moved.database.pragma('foreign_key_check'), []);
  } finally { moved.close(); }
  const alpha = inspection.candidates.find((candidate) => candidate.id === fixture.alpha.id);
  assert.ok(alpha?.dataSetId, '其它历史库按原 id 成为新目录里的独立历史库');
  assert.equal(await isVscodeRuntimeDataSetKept(alpha), false, '迁移不再制造用户保留标记');
  const pending = await kernelFile('runtimeHistoryRegistry.js').readRuntimeHistoryPending({ globalStoragePath: target });
  assert.equal(pending.get(fixture.alpha.id)?.sourceKind, 'migration');
  assert.deepEqual(pending.get(fixture.alpha.id)?.identity, { dataSetId: alpha.dataSetId, rootInstanceId: alpha.rootInstanceId });

  assert.deepEqual(await treeSnapshot(path.join(target, 'agents')), sourceConfigBefore, '设置记录逐字节复制');
  assert.equal(await fs.readFile(path.join(target, 'settings', 'llm.json'), 'utf8'), '{"activeProviderConfigId":"source"}\n');
  await assert.rejects(fs.stat(path.join(target, 'notes.txt')), { code: 'ENOENT' }, '未登记的用户文件不跟随迁移');
  const marker = JSON.parse(await fs.readFile(path.join(target, DATA_ROOT_RELOCATION_MARKER_FILE), 'utf8'));
  assert.equal(marker.state, 'published', '切换指针之后记下已生效');
  assert.ok(marker.publishedAt);
  assert.equal(marker.sourceRootPath, fixture.root);
  assert.deepEqual(marker.migrated.map((item) => item.id), ['default', fixture.alpha.id]);
  assert.ok(marker.migrated.every((item) => typeof item.fingerprint.contentDigest === 'string'), '每个迁移过的库都记下来源内容指纹');
  assert.deepEqual(marker.configuration.map((item) => item.entry).sort(), ['agents', 'settings']);

  // The old directory's data is untouched (no cache or marker is written there either).
  assert.deepEqual(await treeSnapshot(path.join(fixture.root, 'agents')), sourceConfigBefore);
  const old = readDatabase(fixture.current.binding.paths.dataRootPath);
  try { assert.deepEqual(old.ids('conversation'), ['conversation_current_1', 'conversation_current_2']); }
  finally { old.close(); }
  assert.equal((await selectedDataSet(fixture.root))?.id, 'default');
  assert.equal(await fs.readFile(path.join(fixture.root, 'notes.txt'), 'utf8'), 'user file');
  await assert.rejects(fs.stat(path.join(fixture.root, '.limcode-runtime-merges')), { code: 'ENOENT' });

  // The moved root opens as an ordinary current Runtime.
  const reopened = await kernel.RuntimeDatabase.open(new RootAuthority(() => selected.runtimeDataRootPath), { hostBootId: `window-${randomUUID()}` });
  try {
    assert.equal((await reopened.snapshot([repo('Conversation').get('conversation_current_2')])).snapshot[0]?.id, 'conversation_current_2');
  } finally { await reopened.close(); }
});

test('跨设备（不能硬链接）时正文复制并核对；任何一步失败都不切换指针，新目录里本次做的改动全部撤销', async (t) => {
  const fixture = await createFixture(t);
  const target = path.join(fixture.base, 'fresh');
  const plan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  await assert.rejects(relocate(fixture, plan, {
    linkFile: crossDevice,
    publish: async () => { throw new Error('指针写入失败'); }
  }), (error) => {
    assert.match(error.message, /指针写入失败/);
    assert.equal(relocation.dataRootRelocationCleanupState(error), 'cleaned');
    return true;
  });
  await assert.rejects(fs.stat(target), { code: 'ENOENT' }, '本次创建的新目录被整体移除');

  // An existing directory holding only what operating systems drop there counts as empty and keeps it.
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, '.DS_Store'), '');
  const again = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  assert.equal(again.target.kind, 'empty');
  await assert.rejects(relocate(fixture, again, { linkFile: crossDevice, publish: async () => { throw new Error('再次失败'); } }));
  assert.deepEqual(await fs.readdir(target), ['.DS_Store']);

  // Success across devices: every CAS object was copied (not linked) and verified.
  const { result, staged } = await relocate(fixture, again, { linkFile: crossDevice, publish: async () => undefined });
  const contentObjects = readDatabase(fixture.current.binding.paths.dataRootPath);
  try { assert.equal(staged.precopied.copiedCasObjects, contentObjects.ids('content_object').length); }
  finally { contentObjects.close(); }
  assert.equal(staged.precopied.linkedCasObjects, 0);
  assert.equal(result.merged.copiedCasObjects, 0, '预复制之后，独占阶段不再复制正文');
});

test('当前库里有正在接收回复的模型请求：迁移整体失败、新目录清理干净、指针不动', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  await withRuntime(fixture.current, async (runtime, store) => {
    const recipe = await store.ingest(runtime, '{}', 'application/json');
    await runtime.transaction([
      repo('Turn').insert({ id: 'turn_streaming', conversation_id: 'conversation_current_1', status: 'active', created_at: NOW, updated_at: NOW, terminal_at: null }),
      repo('ModelRequest').insert({
        id: 'request_streaming', turn_id: 'turn_streaming', request_seq: 1n, status: 'prepared', terminal_state: null,
        provider_id: 'openai-responses', model_id: 'gpt-test', context_window_tokens: 130_000n,
        compression_threshold_tokens: 100_000n, estimated_context_tokens: 1_000n, authority_snapshot_id: 'authority-relocation',
        settings_snapshot_object_id: null, recipe_object_id: recipe.id, usage_json: null,
        stream_stats_json: { attemptSeq: '1', socketGeneration: '0', retryReason: null }, created_at: NOW, updated_at: NOW
      }),
      repo('Operation').insert({
        id: 'operation_streaming', owner_kind: 'model_request', owner_id: 'request_streaming', operation_seq: 1n,
        tool_call_id: null, status: 'pending', created_at: NOW, updated_at: NOW
      }),
      repo('Attempt').insert({
        id: 'attempt_streaming', operation_id: 'operation_streaming', attempt_seq: 1n, status: 'pending',
        created_at: NOW, updated_at: NOW, completed_at: null
      })
    ]);
  });
  const raw = new Database(fixture.current.binding.paths.databasePath);
  try { raw.prepare("UPDATE model_request SET status = 'streaming' WHERE id = 'request_streaming'").run(); }
  finally { raw.close(); }
  const target = path.join(fixture.base, 'streaming-target');
  const plan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  let published = false;
  await assert.rejects(relocate(fixture, plan, { publish: async () => { published = true; } }),
    { code: 'runtime-data-set-merge-streaming-model-request' });
  assert.equal(published, false);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('新目录里已有在该路径创建的 LimCode 数据：对话合并进它的当前库；设置按记录合并，同一项以当前为准，被替换的旧版本进备份；生效后收尾只删日志和数据库撤销副本', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'existing');
  const existing = await createLimCodeTarget(target, {
    agents: [{ id: 'agent-shared', name: 'target version' }, { id: 'agent-target-only', name: 'only in target' }]
  });
  await fs.mkdir(path.join(target, 'settings'), { recursive: true });
  await fs.writeFile(path.join(target, 'settings', 'llm.json'), '{"activeProviderConfigId":"target"}\n');
  await fs.writeFile(path.join(target, 'settings', 'only-target.json'), '{}\n');

  const plan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.target.kind, 'limcode');
  assert.ok(plan.warnings.some((warning) => warning.includes('已有 LimCode 数据')));
  const { result, staged } = await relocate(fixture, plan, { publish: async () => undefined });
  assert.equal(result.merged.insertedConversations, 2);
  const merged = readDatabase(existing.binding.paths.dataRootPath);
  try {
    assert.deepEqual(merged.ids('conversation'), ['conversation_current_1', 'conversation_current_2', 'conversation_existing_1']);
  } finally { merged.close(); }

  const index = JSON.parse(await fs.readFile(path.join(target, 'agents', 'index.json'), 'utf8'));
  assert.deepEqual(index.records.map((entry) => entry.id).sort(), ['agent-shared', 'agent-source-only', 'agent-target-only']);
  const shared = index.records.find((entry) => entry.id === 'agent-shared');
  assert.equal(JSON.parse(await fs.readFile(path.join(target, 'agents', shared.file), 'utf8')).agent.name, 'source version');
  assert.equal(await fs.readFile(path.join(target, 'settings', 'llm.json'), 'utf8'), '{"activeProviderConfigId":"source"}\n');
  assert.equal(await fs.readFile(path.join(target, 'settings', 'only-target.json'), 'utf8'), '{}\n');
  assert.ok(result.configuration.backupPath, '被替换的旧版本有备份');
  assert.equal(await fs.readFile(path.join(result.configuration.backupPath, 'settings', 'llm.json'), 'utf8'),
    '{"activeProviderConfigId":"target"}\n');
  const backedUpIndex = JSON.parse(await fs.readFile(path.join(result.configuration.backupPath, 'agents', 'index.json'), 'utf8'));
  assert.deepEqual(backedUpIndex.records.map((entry) => entry.id).sort(), ['agent-shared', 'agent-target-only']);

  const work = path.join(target, DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY, staged.relocationId);
  assert.ok((await fs.readdir(work)).some((name) => name.startsWith('database-')), '切换生效前保留目标库的撤销副本');
  await finalizeDataRootRelocation(target);
  assert.deepEqual(await fs.readdir(work), ['configuration'], '生效后只留下被替换的设置版本');
});

test('新目录里的 LimCode 数据冲突时整体取消：两边内容都不变，替换过的设置恢复原样', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'conflict');
  // Same conversation id, different content: the merge engine refuses the whole data set.
  const existing = await createLimCodeTarget(target, { conversations: [{ id: 'conversation_current_1', project: PROJECT, title: 'changed elsewhere' }] });
  await fs.mkdir(path.join(target, 'settings'), { recursive: true });
  await fs.writeFile(path.join(target, 'settings', 'llm.json'), '{"activeProviderConfigId":"target"}\n');
  const targetBefore = await treeSnapshot(path.join(target, 'settings'));
  const databaseBefore = databaseRows(existing.binding.paths.databasePath);
  const plan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  let published = false;
  await assert.rejects(relocate(fixture, plan, { publish: async () => { published = true; } }),
    { code: 'runtime-data-set-merge-conflict' });
  assert.equal(published, false);
  assert.deepEqual(await treeSnapshot(path.join(target, 'settings')), targetBefore);
  assert.deepEqual(databaseRows(existing.binding.paths.databasePath), databaseBefore);
  await assert.rejects(fs.stat(path.join(target, 'agents')), { code: 'ENOENT' }, '本次新建的设置目录已清理');
  await assert.rejects(fs.stat(path.join(target, DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY)), { code: 'ENOENT' });
});

test('预检：别处拷来的数据会被改名挪开并写明；当前目录内部、上级目录与普通文件都会被拒绝并说明原因；云同步目录给出警告', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const copied = path.join(fixture.base, 'copied');
  await fs.cp(fixture.root, copied, { recursive: true });
  await fs.rm(path.join(copied, 'notes.txt'));
  const copiedPlan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: copied });
  assert.equal(copiedPlan.target.kind, 'copied');
  assert.deepEqual(copiedPlan.problems, []);
  assert.ok(copiedPlan.warnings.some((warning) => /旧拷贝.*改名.*保留在旁边/.test(warning)));

  const inside = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: path.join(fixture.root, 'nested') });
  assert.match(inside.problems.join('\n'), /不能放在当前数据目录里面/);
  const parent = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: fixture.base });
  assert.match(parent.problems.join('\n'), /上级目录/);
  const same = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: fixture.root });
  assert.match(same.problems.join('\n'), /就是当前数据目录/);
  const file = path.join(fixture.base, 'a-file');
  await fs.writeFile(file, 'x');
  const onFile = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: file });
  assert.match(onFile.problems.join('\n'), /已经有一个文件/);
  const cloud = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: path.join(fixture.base, 'Dropbox', 'limcode') });
  assert.deepEqual(cloud.problems, []);
  assert.ok(cloud.warnings.some((warning) => warning.includes('云同步')));
});

test('中断的迁移：进程还在时别的窗口不能动它；进程不在后下次先按日志撤销再迁移；放弃的准备被撤销', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'interrupted');
  const plan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  const source = await openRuntime(fixture.current);
  try {
    // Staged, then the window died before the exclusive phase (nothing else was cleaned up).
    await stageDataRootRelocation(plan, source);
  } finally { await source.close(); }
  assert.ok((await fs.readdir(target)).includes('.limcode-runtime'));
  const whileAlive = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  assert.match(whileAlive.problems.join('\n'), /正在向这个目录迁移数据/, '准备它的进程还在：不当作半成品');

  await markStagingOwnerDead(target);
  const again = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  assert.deepEqual(again.problems, []);
  assert.equal(again.target.kind, 'empty', '半成品不当作已有 LimCode 数据');
  assert.equal(again.undoesEarlierAttempt, true);
  const { result, staged } = await relocate(fixture, again, { publish: async () => undefined });
  assert.equal(result.merged.insertedConversations, 2);
  assert.deepEqual(await fs.readdir(path.join(target, DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY)), [staged.relocationId], '上次的工作目录已撤销');

  // Abandoning a staged relocation (other windows did not yield) removes what it created.
  const second = path.join(fixture.base, 'abandoned');
  const secondPlan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: second });
  const reopened = await openRuntime(fixture.current);
  let abandoned;
  try { abandoned = await stageDataRootRelocation(secondPlan, reopened); }
  finally { await reopened.close(); }
  await abandonStagedDataRootRelocation(abandoned);
  await assert.rejects(fs.stat(second), { code: 'ENOENT' });
});

test('数据目录不可用：不存在、空目录、只有同名空文件夹或零散文件都不放行，也不创建任何东西；有 LimCode 结构时放行；记录了身份时逐项比对', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-relocation-availability-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const missing = path.join(base, 'unmounted', 'limcode');
  await assert.rejects(assertDataRootAvailable(missing), (error) => {
    assert.ok(error instanceof DataRootUnavailableError);
    assert.equal(error.code, 'data-root-unavailable');
    assert.equal(error.reason, 'missing');
    assert.match(error.message, /数据目录不可用/);
    return true;
  });
  await assert.rejects(fs.stat(path.join(base, 'unmounted')), { code: 'ENOENT' }, '检查本身不创建目录');
  const mountPoint = path.join(base, 'mount-point');
  await fs.mkdir(mountPoint);
  await fs.writeFile(path.join(mountPoint, '.DS_Store'), '');
  await assert.rejects(assertDataRootAvailable(mountPoint), { reason: 'empty' });
  await fs.mkdir(path.join(mountPoint, 'settings'));
  await fs.writeFile(path.join(mountPoint, 'settings', 'llm.json'), '{}\n');
  await fs.mkdir(path.join(mountPoint, 'agents'));
  await assert.rejects(assertDataRootAvailable(mountPoint), { reason: 'empty' }, '同名空文件夹或零散设置文件不算 LimCode 数据');
  assert.deepEqual((await fs.readdir(mountPoint)).sort(), ['.DS_Store', 'agents', 'settings']);
  await writeRecordStore(mountPoint, 'agents', 'agent', [{ id: 'a', name: 'a' }]);
  await fs.mkdir(path.join(mountPoint, '.limcode-workspace-runtimes', 'scopes'), { recursive: true });
  await assert.rejects(assertDataRootAvailable(mountPoint), { reason: 'empty' }, '设置记录存储或随手建出的 Runtime 目录都不算（任何一次保存或写入都可能在挂载点里建出它们）');
  await initialize(mountPoint, 'default');
  await assertDataRootAvailable(mountPoint);

  const rootId = await ensureDataRootIdentity(mountPoint);
  assert.equal(await ensureDataRootIdentity(mountPoint), rootId, '身份只写一次');
  await assertDataRootAvailable(mountPoint, rootId);
  await assert.rejects(assertDataRootAvailable(mountPoint, randomUUID()), { reason: 'mismatch' });
  const empty = path.join(base, 'empty');
  await fs.mkdir(empty);
  await assert.rejects(ensureDataRootIdentity(empty), /没有 LimCode 数据/, '身份只写进已有 LimCode 结构的目录');
  assert.deepEqual(await fs.readdir(empty), []);
});

test('删除旧目录：没有迁移完成记录时拒绝；迁移后只删除迁移过去且没有改动的内容，保留其它文件、指定保留项和迁移之后才有的历史库', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'new-home');
  const refused = await planOldDataRootDeletion({ oldRootPath: fixture.root, currentRootPath: target, relocationId: randomUUID() });
  assert.match(refused.problems.join('\n'), /找不到从这个目录迁移完成的记录/);
  const plan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  const { staged } = await relocate(fixture, plan, { publish: async () => undefined });
  const switched = await planOldDataRootDeletion({ oldRootPath: fixture.root, currentRootPath: target });
  assert.match(switched.problems.join('\n'), /切换过来的/, '指针没有记下迁移 id（只切换、没复制）时从不删除');
  const other = await planOldDataRootDeletion({ oldRootPath: fixture.root, currentRootPath: target, relocationId: randomUUID() });
  assert.match(other.problems.join('\n'), /不是切换到这里的那次迁移留下的/);
  await fs.writeFile(path.join(fixture.root, '.limcode-global-status.json'), '{}');
  await fs.mkdir(path.join(fixture.root, '.limcode-global-status.json.lock'));
  const keepEntries = ['.limcode-global-status.json'];
  const deletion = await planOldDataRootDeletion({ oldRootPath: fixture.root, currentRootPath: target, keepEntries, relocationId: staged.relocationId });
  assert.deepEqual(deletion.problems, []);
  const byKey = new Map(deletion.items.map((item) => [item.key, item]));
  assert.equal(byKey.get('data-set:default')?.deletable, true);
  assert.equal(byKey.get('configuration:agents')?.deletable, true);
  assert.equal(byKey.get('configuration:settings')?.deletable, true);
  assert.equal(byKey.get('metadata')?.deletable, true);
  assert.deepEqual(deletion.kept.map((entry) => entry.name), ['notes.txt']);

  // A data set created in the old directory after the move stays, and so does the bookkeeping it needs.
  const scope = resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: ['file:///workspace/later'] });
  const laterRoot = resolveVscodeWorkspaceRuntimeScopeRoot(fixture.paths, scope);
  await fs.mkdir(laterRoot, { recursive: true });
  await initialize(laterRoot, `workspace:${scope.key}`);
  const { plan: withLater } = await deleteAsConfirmed({ oldRootPath: fixture.root, currentRootPath: target, keepEntries });
  const later = withLater.items.find((item) => item.key === `data-set:workspace:${scope.key}`);
  assert.deepEqual([later?.deletable, later?.reason], [false, '没有迁移到当前目录']);
  assert.equal(withLater.items.find((item) => item.key === 'metadata')?.deletable, false);
  assert.deepEqual((await fs.readdir(fixture.root)).sort(),
    ['.limcode-global-status.json', '.limcode-global-status.json.lock', '.limcode-runtime-selection.json', '.limcode-workspace-runtimes', 'notes.txt']);
  assert.ok((await inspectVscodeRuntimeDataSets(fixture.paths)).candidates.some((candidate) => candidate.id === `workspace:${scope.key}` && candidate.dataSetId));
  // The moved data is intact.
  const moved = readDatabase((await selectedDataSet(target)).runtimeDataRootPath);
  try { assert.equal(moved.ids('conversation').length, 2); }
  finally { moved.close(); }
});

test('迁移留下同名库：新根登记旧位置，后续清理previousDataRoots不会丢掉它', async (t) => {
  const fixture = await createFixture(t);
  const target = path.join(fixture.base, 'same-name-target');
  const targetDataSet = await createLimCodeTarget(target);
  const scopeRoot = rootAuthority.resolveVscodeRuntimeDataSetScopeRoot(target, fixture.alpha.id);
  await initialize(scopeRoot, fixture.alpha.id);
  const registry = kernelFile('runtimeHistoryRegistry.js');
  const record = { id: fixture.alpha.id, sourceKind: 'local', location: { kind: 'local', candidateId: fixture.alpha.id },
    identity: { dataSetId: fixture.alpha.binding.dataSetId, rootInstanceId: fixture.alpha.binding.rootInstanceId },
    code: 'fixture-retained', message: '旧目录残留', checkedAt: NOW };
  await registry.writeRuntimeHistoryResidual(fixture.paths, record);
  await registry.writeRuntimeHistoryResidual({ globalStoragePath: target }, { ...record, message: '新目录残留' });
  const plan = await planWithRuntime(fixture, target);
  assert.deepEqual(plan.problems, []);
  const { result } = await relocate(fixture, plan);
  const residuals = [...(await registry.readRuntimeHistoryResidual({ globalStoragePath: target })).values()];
  assert.deepEqual(residuals.map(item => item.message).sort(), ['新目录残留', '旧目录残留']);
  assert.deepEqual(result.others.leftBehind.map(item => item.id), [fixture.alpha.id]);
  const pending = [...(await kernelFile('runtimeHistoryRegistry.js').readRuntimeHistoryPending({ globalStoragePath: target })).values()];
  const left = pending.find(item => item.identity?.dataSetId === fixture.alpha.binding.dataSetId);
  assert.equal(left?.sourceKind, 'migration');
  assert.equal(left?.location.containerPath, path.dirname(fixture.alpha.binding.paths.dataRootPath));
  assert.equal(left?.location.baseDataRootPath, fixture.root);
  const database = await openRuntime(targetDataSet);
  try {
    const report = await kernelFile('runtimeDataSetMerge.js').mergeHistoricalDataSetsOnline({ globalStoragePath: target },
      { configurationRootPath: target, database }, { candidateIds: [left.id] });
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.blocked, []);
    assert.equal(report.merged[0]?.candidateId, left.id, JSON.stringify(report));
  } finally { await database.close(); }

  assert.deepEqual(await kernelFile('runtimeForeignHistory.js').previousDataRootsWithoutForeignHistory({
    configurationRootPath: target, previousDataRootPaths: [fixture.root]
  }), []);
});
