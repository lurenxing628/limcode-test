import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve('dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = kernelFile('index.js');
const Database = require('better-sqlite3');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { projectFolderAssignmentSteps } = kernelFile('conversationProject.js');
const {
  DATA_ROOT_RELOCATION_MARKER_FILE, DataRootUnavailableError, abandonStagedDataRootRelocation, assertDataRootAvailable,
  completeDataRootRelocation, deleteOldDataRoot, planDataRootRelocation, planOldDataRootDeletion, stageDataRootRelocation
} = kernelFile('runtimeDataRootRelocation.js');
const { readRuntimeDataSetMergeStates } = kernelFile('runtimeDataSetMerge.js');
const {
  inspectVscodeRuntimeDataSets, isVscodeRuntimeDataSetKept, resolveVscodeRuntimeDataRoot, resolveVscodeWorkspaceRuntimeScope,
  resolveVscodeWorkspaceRuntimeScopeRoot, selectVscodeRuntimeDataSet
} = kernelFile('vscodeRootAuthority.js');

const NOW = '2026-09-26T00:00:00.000Z';
const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
const PROJECT = { uri: 'file:///workspace/relocation', name: 'relocation' };
const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);
const crossDevice = async () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); };

test('迁移到空目录：当前库与其它库按原 id 迁入、设置逐文件复制、最后才切换指针；旧目录原样保留', async (t) => {
  const fixture = await createFixture(t);
  const target = path.join(fixture.base, 'moved', 'data');
  const sourceConfigBefore = await treeSnapshot(path.join(fixture.root, 'agents'));
  const plan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.target.kind, 'empty');
  assert.equal(plan.current.id, 'default');
  assert.deepEqual(plan.others.map((item) => item.id), [fixture.alpha.id]);
  assert.ok(plan.requiredBytes > 0 && plan.current.casBytes > 0);

  const published = [];
  const { result } = await relocate(fixture, plan, { publish: async () => { published.push(target); } });
  assert.deepEqual(published, [target], '指针只在全部完成后切换一次');
  assert.equal(result.merged.insertedConversations, 2);
  assert.deepEqual(result.others, { migrated: [fixture.alpha.id], leftBehind: [] });
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
  assert.equal(await isVscodeRuntimeDataSetKept(alpha), true, '其它历史库记为保留，不会被自动合并');
  assert.equal((await readRuntimeDataSetMergeStates({ globalStoragePath: target })).get(fixture.alpha.id)?.state, 'kept');
  const movedAlpha = readDatabase(alpha.runtimeDataRootPath);
  try { assert.deepEqual(movedAlpha.ids('conversation'), ['conversation_alpha_1']); }
  finally { movedAlpha.close(); }

  assert.deepEqual(await treeSnapshot(path.join(target, 'agents')), sourceConfigBefore, '设置记录逐字节复制');
  assert.equal(await fs.readFile(path.join(target, 'settings', 'llm.json'), 'utf8'), '{"activeProviderConfigId":"source"}\n');
  await assert.rejects(fs.stat(path.join(target, 'notes.txt')), { code: 'ENOENT' }, '未登记的用户文件不跟随迁移');
  const marker = JSON.parse(await fs.readFile(path.join(target, DATA_ROOT_RELOCATION_MARKER_FILE), 'utf8'));
  assert.equal(marker.state, 'complete');
  assert.equal(marker.sourceRootPath, fixture.root);

  // The old directory is untouched: same data sets, same conversations, same configuration.
  assert.deepEqual(await treeSnapshot(path.join(fixture.root, 'agents')), sourceConfigBefore);
  const old = readDatabase(fixture.current.binding.paths.dataRootPath);
  try { assert.deepEqual(old.ids('conversation'), ['conversation_current_1', 'conversation_current_2']); }
  finally { old.close(); }
  assert.equal((await inspectVscodeRuntimeDataSets(fixture.paths)).candidates.find((item) => item.selected)?.id, 'default');
  assert.equal(await fs.readFile(path.join(fixture.root, 'notes.txt'), 'utf8'), 'user file');

  // The moved root opens as an ordinary current Runtime.
  const authority = new RootAuthority(() => selected.runtimeDataRootPath);
  const reopened = await kernel.RuntimeDatabase.open(authority, { hostBootId: `window-${randomUUID()}` });
  try {
    const seen = (await reopened.snapshot([repo('Conversation').get('conversation_current_2')])).snapshot[0];
    assert.equal(seen?.id, 'conversation_current_2');
  } finally { await reopened.close(); }
});

test('跨设备（不能硬链接）时正文复制并核对；任何一步失败都不切换指针，新目录里本次创建的内容全部清理', async (t) => {
  const fixture = await createFixture(t);
  const target = path.join(fixture.base, 'fresh');
  const plan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  await assert.rejects(relocate(fixture, plan, {
    linkFile: crossDevice,
    publish: async () => { throw new Error('指针写入失败'); }
  }), /指针写入失败/);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' }, '本次创建的新目录被整体移除');

  // An existing empty directory with an unrelated file keeps both after a failed move.
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'keep.txt'), 'mine');
  const withFile = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  assert.equal(withFile.target.kind, 'empty');
  assert.equal(withFile.target.unrelatedEntries, 1);
  assert.ok(withFile.warnings.some((warning) => warning.includes('其它文件')));
  await assert.rejects(relocate(fixture, withFile, { linkFile: crossDevice, publish: async () => { throw new Error('再次失败'); } }));
  assert.deepEqual(await fs.readdir(target), ['keep.txt']);

  // Success across devices: every CAS object was copied (not linked) and verified.
  const { result, staged } = await relocate(fixture, withFile, { linkFile: crossDevice, publish: async () => undefined });
  const contentObjects = readDatabase(fixture.current.binding.paths.dataRootPath);
  try { assert.equal(staged.precopied.copiedCasObjects, contentObjects.ids('content_object').length); }
  finally { contentObjects.close(); }
  assert.equal(staged.precopied.linkedCasObjects, 0);
  assert.equal(result.merged.copiedCasObjects, 0, '预复制之后，独占阶段不再复制正文');
  assert.equal(result.merged.linkedCasObjects, 0);
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

test('新目录里已有在该路径创建的 LimCode 数据：对话合并进它的当前库；设置按记录合并，同一项以当前为准，被替换的旧版本进备份', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'existing');
  await fs.mkdir(target, { recursive: true });
  const existing = await initialize(target, 'default');
  await selectVscodeRuntimeDataSet({ globalStoragePath: target }, 'default');
  await seed(existing, [{ id: 'conversation_existing_1', project: PROJECT }]);
  await writeRecordStore(target, 'agents', 'agent', [
    { id: 'agent-shared', name: 'target version' },
    { id: 'agent-target-only', name: 'only in target' }
  ]);
  await fs.mkdir(path.join(target, 'settings'), { recursive: true });
  await fs.writeFile(path.join(target, 'settings', 'llm.json'), '{"activeProviderConfigId":"target"}\n');
  await fs.writeFile(path.join(target, 'settings', 'only-target.json'), '{}\n');

  const plan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.target.kind, 'limcode');
  assert.ok(plan.warnings.some((warning) => warning.includes('已有 LimCode 数据')));
  const { result } = await relocate(fixture, plan, { publish: async () => undefined });
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
});

test('新目录里的 LimCode 数据冲突时整体取消：两边内容都不变，替换过的设置恢复原样', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'conflict');
  await fs.mkdir(target, { recursive: true });
  const existing = await initialize(target, 'default');
  await selectVscodeRuntimeDataSet({ globalStoragePath: target }, 'default');
  // Same conversation id, different content: the merge engine refuses the whole data set.
  await seed(existing, [{ id: 'conversation_current_1', project: PROJECT, title: 'changed elsewhere' }]);
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
});

test('预检：别处拷来的数据、当前目录内部、上级目录与普通文件都会被拒绝并说明原因；云同步目录给出警告', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const copied = path.join(fixture.base, 'copied');
  await fs.cp(fixture.root, copied, { recursive: true });
  const copiedPlan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: copied });
  assert.equal(copiedPlan.target.kind, 'copied');
  assert.match(copiedPlan.problems.join('\n'), /拷贝过来/);

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

test('中断的迁移留下的半成品：下次按空目录处理并先清理；只清理 LimCode 自己新建的条目', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'interrupted');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'keep.txt'), 'mine');
  const plan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  const source = await openRuntime(fixture.current);
  try {
    // Staged, then the window died before the exclusive phase (nothing else was cleaned up).
    await stageDataRootRelocation(plan, source);
  } finally { await source.close(); }
  assert.ok((await fs.readdir(target)).includes('.limcode-runtime'));
  const again = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  assert.equal(again.target.kind, 'empty', '半成品不当作已有 LimCode 数据');
  const { result } = await relocate(fixture, again, { publish: async () => undefined });
  assert.equal(result.merged.insertedConversations, 2);

  // Abandoning a staged relocation (other windows did not yield) removes what it created.
  const second = path.join(fixture.base, 'abandoned');
  const secondPlan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: second });
  const reopened = await openRuntime(fixture.current);
  let staged;
  try { staged = await stageDataRootRelocation(secondPlan, reopened); }
  finally { await reopened.close(); }
  await abandonStagedDataRootRelocation(staged);
  await assert.rejects(fs.stat(second), { code: 'ENOENT' });
});

test('数据目录不可用（不存在、空目录）时明确报错，不创建任何东西；有 LimCode 数据时通过', async (t) => {
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
  assert.deepEqual(await fs.readdir(mountPoint), ['.DS_Store']);
  await fs.mkdir(path.join(mountPoint, 'settings'));
  await assertDataRootAvailable(mountPoint);
});

test('删除旧目录：没有迁移完成记录时拒绝；迁移后只删除 LimCode 条目，保留其它文件与指定保留项', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'new-home');
  const refused = await planOldDataRootDeletion({ oldRootPath: fixture.root, currentRootPath: target });
  assert.match(refused.problems.join('\n'), /找不到从这个目录迁移完成的记录/);
  const plan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  await relocate(fixture, plan, { publish: async () => undefined });
  await fs.writeFile(path.join(fixture.root, '.limcode-global-status.json'), '{}');
  await fs.mkdir(path.join(fixture.root, '.limcode-global-status.json.lock'));
  const deletion = await planOldDataRootDeletion({
    oldRootPath: fixture.root, currentRootPath: target, keepEntries: ['.limcode-global-status.json']
  });
  assert.deepEqual(deletion.problems, []);
  assert.deepEqual(deletion.unmigrated, [], '迁移过的历史库不算未迁移');
  // A data set created in the old directory after the move is named before deletion.
  const scope = resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: ['file:///workspace/later'] });
  const laterRoot = resolveVscodeWorkspaceRuntimeScopeRoot(fixture.paths, scope);
  await fs.mkdir(laterRoot, { recursive: true });
  await initialize(laterRoot, `workspace:${scope.key}`);
  assert.deepEqual((await planOldDataRootDeletion({ oldRootPath: fixture.root, currentRootPath: target })).unmigrated,
    [`workspace:${scope.key}`]);
  assert.ok(deletion.entries.includes('.limcode-runtime') && deletion.entries.includes('agents') && deletion.entries.includes('settings'));
  assert.ok(!deletion.entries.includes('notes.txt') && !deletion.entries.includes('.limcode-global-status.json'));
  assert.ok(deletion.bytes > 0);
  await deleteOldDataRoot({ oldRootPath: fixture.root, currentRootPath: target, keepEntries: ['.limcode-global-status.json'] });
  assert.deepEqual((await fs.readdir(fixture.root)).sort(), ['.limcode-global-status.json', '.limcode-global-status.json.lock', 'notes.txt']);
  // The moved data is intact.
  const selected = (await inspectVscodeRuntimeDataSets({ globalStoragePath: target })).candidates.find((item) => item.selected);
  const moved = readDatabase(selected.runtimeDataRootPath);
  try { assert.equal(moved.ids('conversation').length, 2); }
  finally { moved.close(); }
});

/** Stage online with this "window's" Runtime open, close it, then complete (exclusive). */
async function relocate(fixture, plan, { publish, linkFile } = {}) {
  const options = linkFile ? { linkFile } : {};
  const source = await openRuntime(fixture.current);
  let staged;
  try {
    staged = await stageDataRootRelocation(plan, source, options);
  } finally {
    await source.close();
  }
  const result = await completeDataRootRelocation(staged, publish ?? (async () => undefined), options);
  return { staged, result };
}

async function createFixture(t, options = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-relocation-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'old-home');
  await fs.mkdir(root);
  const paths = { globalStoragePath: root };
  const current = await initialize(root, 'default');
  let alpha;
  if (options.withAlpha !== false) {
    const scope = resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: ['file:///workspace/alpha'] });
    const scopeRoot = resolveVscodeWorkspaceRuntimeScopeRoot(paths, scope);
    await fs.mkdir(scopeRoot, { recursive: true });
    alpha = await initialize(scopeRoot, `workspace:${scope.key}`);
    await seed(alpha, [{ id: 'conversation_alpha_1', project: PROJECT }]);
  }
  await selectVscodeRuntimeDataSet(paths, 'default');
  await seed(current, [
    { id: 'conversation_current_1', project: PROJECT },
    { id: 'conversation_current_2', project: PROJECT }
  ]);
  await writeRecordStore(root, 'agents', 'agent', [
    { id: 'agent-shared', name: 'source version' },
    { id: 'agent-source-only', name: 'only in source' }
  ]);
  await fs.mkdir(path.join(root, 'settings'), { recursive: true });
  await fs.writeFile(path.join(root, 'settings', 'llm.json'), '{"activeProviderConfigId":"source"}\n');
  await fs.writeFile(path.join(root, 'notes.txt'), 'user file');
  return { base, root, paths, current, alpha };
}

async function initialize(scopeRoot, id) {
  const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot }));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  return { id, scopeRoot, authority, binding };
}

function openRuntime(dataSet) {
  return kernel.RuntimeDatabase.open(dataSet.authority, { hostBootId: `window-${randomUUID()}` });
}

async function withRuntime(dataSet, run) {
  const runtime = await openRuntime(dataSet);
  try {
    return await run(runtime, new kernel.ContentAddressedStore(dataSet.authority, dataSet.binding));
  } finally { await runtime.close(); }
}

async function seed(dataSet, conversations) {
  await withRuntime(dataSet, async (runtime, store) => {
    for (const spec of conversations) {
      const content = await store.ingest(runtime, JSON.stringify({ role: 'user', parts: [{ text: `${spec.id} 的正文` }] }), MESSAGE_TYPE);
      const messageId = `${spec.id}_message`;
      await runtime.transaction([
        repo('Conversation').insert({ id: spec.id, title: spec.title ?? spec.id, status: 'active', created_at: NOW, updated_at: NOW }),
        ...projectFolderAssignmentSteps({ conversationId: spec.id, folder: spec.project, now: NOW }),
        repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
        repo('MessageRevision').insert({
          id: `${messageId}_revision`, message_id: messageId, revision_seq: 1n, role: 'user', content_object_id: content.id, created_at: NOW
        }),
        repo('MessageCurrentRevisionLink').insert({
          id: `${messageId}_current`, message_id: messageId, revision_id: `${messageId}_revision`, updated_at: NOW
        }),
        repo('MessagePartOfConversation').insert({
          id: `${messageId}_member`, conversation_id: spec.id, message_id: messageId, message_seq: 1n, created_at: NOW
        })
      ]);
    }
  });
}

async function writeRecordStore(root, directory, key, records) {
  const store = path.join(root, directory);
  await fs.mkdir(path.join(store, 'records'), { recursive: true });
  const entries = [];
  for (const record of records) {
    const file = `records/${record.id}.json`;
    await fs.writeFile(path.join(store, file), `${JSON.stringify({ schemaVersion: 1, savedAt: NOW, [key]: record }, null, 2)}\n`);
    entries.push({ id: record.id, file, updatedAt: NOW });
  }
  await fs.writeFile(path.join(store, 'index.json'), `${JSON.stringify({ schemaVersion: 1, savedAt: NOW, records: entries }, null, 2)}\n`);
}

function readDatabase(dataRootPath) {
  const database = new Database(path.join(dataRootPath, 'limcode.sqlite'), { readonly: true });
  return {
    database,
    ids(table) { return database.prepare(`SELECT id FROM ${table} ORDER BY id`).pluck().all(); },
    close() { database.close(); }
  };
}

function databaseRows(databasePath) {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare('SELECT id, title, updated_at FROM conversation ORDER BY id').all();
  } finally { database.close(); }
}

async function treeSnapshot(root) {
  const files = {};
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else files[path.relative(root, file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    }
  }
  await visit(root);
  return files;
}
