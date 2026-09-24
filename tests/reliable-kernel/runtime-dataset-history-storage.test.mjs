import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve('dist/extension');
const kernel = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const Database = require('better-sqlite3');
const { RootAuthority } = kernel('rootAuthority.js');
const { configureWriterConnection, initializeCurrentSchema } = kernel('databaseSchema.js');
const { openRuntimeDataSetHistory } = kernel('runtimeDataSetHistory.js');
const { inspectRuntimeDataSetStorage, deleteUnselectedRuntimeDataSet } = kernel('runtimeStorageInspection.js');
const {
  resolveVscodeRuntimeDataRoot, resolveVscodeWorkspaceRuntimeScope,
  resolveVscodeWorkspaceRuntimeScopeRoot, resolveVscodeRuntimeSelectionPath, selectVscodeRuntimeDataSet,
  listVscodeRuntimeDataSets
} = kernel('vscodeRootAuthority.js');
const { ownProcessStartIdentity } = kernel('runtimeClaimPrimitives.js');
const { archiveCurrentRuntimeRootForReset, VSCODE_INCOMPATIBLE_RUNTIME_BACKUPS_DIRECTORY } = require(path.join(
  compiled, 'backend/application/reliableKernel/VscodeReliableKernelCutoverCoordinator.js'
));
const now = '2026-09-22T00:00:00.000Z';

test('历史读取保留会话和当前消息关系、分页及真实CAS codec，源文件零改写', async (t) => {
  const fixture = await createFixture(t);
  await seedHistory(fixture.old.binding);
  await publishHost(fixture.current.binding); // Another selected root may keep running.
  const before = await treeSnapshot(fixture.root);
  const reader = await openRuntimeDataSetHistory(fixture.paths, fixture.old.id);
  try {
    const first = await reader.listConversations({ limit: 1 });
    assert.deepEqual(first.items.map((item) => item.id), ['conversation-b']);
    assert.ok(first.next);
    const second = await reader.listConversations({ limit: 1, after: first.next });
    assert.deepEqual(second.items.map((item) => item.id), ['conversation-a']);
    assert.equal(second.next, undefined);
    const firstMessages = await reader.readMessages('conversation-a', { limit: 1 });
    assert.equal(firstMessages.items[0].text, '用户原文');
    assert.equal(firstMessages.items[0].role, 'user');
    assert.equal(firstMessages.next, '1');
    const secondMessages = await reader.readMessages('conversation-a', { limit: 1, after: firstMessages.next });
    assert.equal(secondMessages.items[0].revisionId, 'revision-model');
    assert.equal(secondMessages.items[0].role, 'model');
    assert.equal(secondMessages.items[0].text, '助手当前版本\n[附件 image.png]\n');
    assert.equal(secondMessages.next, undefined);
    await assert.rejects(reader.readMessages('missing'), /Conversation.*missing/);
    await assert.rejects(reader.readMessageText('conversation-b', 'message-user', { offset: 0 }), /does not belong/);
    await assert.rejects(reader.readMessages('conversation-a', { limit: 0 }), /limit/);
  } finally { await reader.close(); }
  assert.deepEqual(await treeSnapshot(fixture.root), before);
  await assert.rejects(reader.listConversations(), /closed/);
});

test('长消息内容有显式继续页且不截断Unicode字符', async (t) => {
  const fixture = await createFixture(t);
  const long = 'a'.repeat(32767) + '😀' + 'tail';
  await seedHistory(fixture.old.binding, long);
  const reader = await openRuntimeDataSetHistory(fixture.paths, fixture.old.id);
  try {
    const page = await reader.readMessages('conversation-a');
    const message = page.items[0];
    assert.equal(message.hasMoreText, true);
    assert.equal(message.text, 'a'.repeat(32767));
    const continuation = await reader.readMessageText('conversation-a', message.id, { offset: message.nextTextOffset });
    assert.equal(continuation.text, '😀tail');
    assert.equal(continuation.hasMore, false);
    assert.equal(message.text + continuation.text, long);
  } finally { await reader.close(); }
});

test('历史快照包含离线WAL已提交事实而不新建或改写源WAL/SHM', async (t) => {
  const fixture = await createFixture(t);
  const writer = new Database(fixture.old.binding.paths.databasePath);
  t.after(() => writer.close());
  configureWriterConnection(writer);
  writer.pragma('wal_autocheckpoint = 0');
  writer.prepare('INSERT INTO conversation VALUES (?, ?, ?, ?, ?)').run('wal-only', 'WAL记录', 'active', now, now);
  const before = await treeSnapshot(fixture.root);
  const reader = await openRuntimeDataSetHistory(fixture.paths, fixture.old.id);
  try { assert.deepEqual((await reader.listConversations()).items.map((item) => item.id), ['wal-only']); }
  finally { await reader.close(); }
  assert.deepEqual(await treeSnapshot(fixture.root), before);
});

test('历史内容摘要错误、缺失关系及未知schema均明确失败，不返回空历史', async (t) => {
  const fixture = await createFixture(t);
  const seeded = await seedHistory(fixture.old.binding);
  await fs.writeFile(seeded.userFile, Buffer.alloc(Buffer.byteLength('用户原文'), 1));
  const reader = await openRuntimeDataSetHistory(fixture.paths, fixture.old.id);
  try { await assert.rejects(reader.readMessages('conversation-a'), /digest/); }
  finally { await reader.close(); }
  const database = new Database(fixture.old.binding.paths.databasePath);
  database.exec('ALTER TABLE conversation ADD COLUMN invented TEXT');
  database.close();
  const before = await treeSnapshot(fixture.root);
  await assert.rejects(openRuntimeDataSetHistory(fixture.paths, fixture.old.id), /DDL drift/);
  assert.deepEqual(await treeSnapshot(fixture.root), before);
});

test('历史消息关系缺失和旧epoch拒绝直接读取，且未执行迁移', async (t) => {
  const fixture = await createFixture(t);
  await seedHistory(fixture.old.binding);
  const database = new Database(fixture.old.binding.paths.databasePath);
  database.exec("DELETE FROM message_current_revision_link WHERE message_id = 'message-user'");
  database.close();
  const reader = await openRuntimeDataSetHistory(fixture.paths, fixture.old.id);
  try { await assert.rejects(reader.readMessages('conversation-a'), /no current revision/); }
  finally { await reader.close(); }
  const pointer = { ...fixture.old.binding, runtimeKernelEpoch: 3 };
  const epoch = JSON.parse(await fs.readFile(pointer.paths.runtimeEpochPath, 'utf8'));
  epoch.runtimeKernelEpoch = 3;
  await fs.writeFile(pointer.paths.rootPointerPath, JSON.stringify(pointer));
  await fs.writeFile(pointer.paths.runtimeEpochPath, JSON.stringify(epoch));
  const before = await treeSnapshot(fixture.root);
  await assert.rejects(openRuntimeDataSetHistory(fixture.paths, fixture.old.id), { code: 'runtime-history-offline-upgrade-required' });
  assert.deepEqual(await treeSnapshot(fixture.root), before);
});

test('空间统计按物理文件计CAS一次，独立分类临时残留、spool、诊断和历史备份', async (t) => {
  const fixture = await createFixture(t);
  await seedHistory(fixture.old.binding);
  const data = fixture.old.binding.paths.dataRootPath;
  const control = path.dirname(data);
  const additions = [
    [path.join(data, 'cas/tmp/residue.tmp'), 7], [path.join(data, 'process-spool/output.bin'), 11],
    [path.join(data, 'diagnostics/events.jsonl'), 13], [path.join(data, 'other.bin'), 17],
    [path.join(control, 'backups/old/sqlite'), 19], [path.join(control, 'epoch-migration-backups/epoch3/sqlite'), 23]
  ];
  for (const [file, length] of additions) {
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, Buffer.alloc(length));
  }
  const before = await treeSnapshot(fixture.root);
  const usage = await inspectRuntimeDataSetStorage(fixture.paths, fixture.old.id);
  assert.equal(usage.categories.cas.fileCount, 2); // 3 metadata rows share 2 physical storage keys.
  assert.deepEqual(usage.categories.casTemporary, { fileCount: 1, bytes: '7' });
  assert.deepEqual(usage.categories.processSpool, { fileCount: 1, bytes: '11' });
  assert.deepEqual(usage.categories.diagnostics, { fileCount: 1, bytes: '13' });
  assert.deepEqual(usage.categories.historicalBackups, { fileCount: 2, bytes: '42' });
  assert.equal(usage.archiveReclaimsBytes, false);
  assert.equal(BigInt(usage.total.bytes), Object.values(usage.categories).reduce((sum, category) => sum + BigInt(category.bytes), 0n));
  assert.deepEqual(await treeSnapshot(fixture.root), before);
});

test('删除拒绝当前、确认身份漂移、活Host和未知Host，允许当前另库继续运行', async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(deleteUnselectedRuntimeDataSet(fixture.paths, 'default', fixture.current.binding.dataSetId), /selected/);
  await assert.rejects(deleteUnselectedRuntimeDataSet(fixture.paths, fixture.old.id, 'stale-confirmation'), /identity changed/);
  const host = await publishHost(fixture.old.binding);
  await assert.rejects(deleteUnselectedRuntimeDataSet(fixture.paths, fixture.old.id, fixture.old.binding.dataSetId), { code: 'runtime-hosts-active' });
  await assert.rejects(openRuntimeDataSetHistory(fixture.paths, fixture.old.id), { code: 'runtime-hosts-active' });
  await fs.writeFile(host, '{}');
  await assert.rejects(deleteUnselectedRuntimeDataSet(fixture.paths, fixture.old.id, fixture.old.binding.dataSetId), { code: 'runtime-hosts-active' });
  await fs.rm(host);
  await publishHost(fixture.current.binding);
  const result = await deleteUnselectedRuntimeDataSet(fixture.paths, fixture.old.id, fixture.old.binding.dataSetId);
  assert.equal(result.dataSetId, fixture.old.binding.dataSetId);
  await assert.rejects(fs.stat(fixture.old.scopeRoot), { code: 'ENOENT' });
  assert.ok((await fs.stat(fixture.current.binding.paths.databasePath)).isFile());
});

test('删除非当前legacy只删除完整Runtime控制树，保留配置及其它库；拒绝符号链接', async (t) => {
  const fixture = await createFixture(t);
  await selectVscodeRuntimeDataSet(fixture.paths, fixture.old.id);
  const settings = path.join(fixture.root, 'settings/keep.json');
  await fs.mkdir(path.dirname(settings), { recursive: true });
  await fs.writeFile(settings, '{"keep":true}');
  const link = path.join(fixture.current.binding.paths.casRootPath, 'unsafe');
  await fs.symlink(path.dirname(settings), link, 'dir');
  await assert.rejects(deleteUnselectedRuntimeDataSet(fixture.paths, 'default', fixture.current.binding.dataSetId), /symbolic/);
  await fs.rm(link);
  const reader = await openRuntimeDataSetHistory(fixture.paths, 'default');
  await deleteUnselectedRuntimeDataSet(fixture.paths, 'default', fixture.current.binding.dataSetId);
  try { await assert.rejects(reader.listConversations(), /缺少|缺失|missing/); }
  finally { await reader.close(); }
  assert.equal(await fs.readFile(settings, 'utf8'), '{"keep":true}');
  assert.ok((await fs.stat(fixture.old.binding.paths.databasePath)).isFile());
  await assert.rejects(fs.stat(path.join(fixture.root, '.limcode-runtime')), { code: 'ENOENT' });
});

test('删除旧workspace库会清理已释放维护锁的残留，后续历史库枚举仍可用', async (t) => {
  const fixture = await createFixture(t);
  await seedHistory(fixture.old.binding);
  const currentBefore = await treeSnapshot(path.dirname(fixture.current.binding.paths.dataRootPath));
  const settings = path.join(fixture.root, 'settings/keep.json');
  await fs.mkdir(path.dirname(settings), { recursive: true });
  await fs.writeFile(settings, '{"keep":true}');
  const originalRm = fs.rm;
  let releaseCleanupFailures = 0;
  const mock = t.mock.method(fs, 'rm', async (target, options) => {
    if (String(target).startsWith(fixture.old.scopeRoot + path.sep)
      && String(target).includes('.runtime-maintenance.generation-released-')) {
      releaseCleanupFailures += 1;
      // releaseClaimRecord permits this failure after its own bounded retries are exhausted.
      throw Object.assign(new Error('injected released-claim cleanup failure'), { code: 'EBUSY' });
    }
    return originalRm(target, options);
  });
  try {
    const result = await deleteUnselectedRuntimeDataSet(fixture.paths, fixture.old.id, fixture.old.binding.dataSetId);
    assert.equal(result.dataSetId, fixture.old.binding.dataSetId);
    assert.equal(releaseCleanupFailures, 1);
  } finally { mock.mock.restore(); }
  await assert.rejects(fs.stat(fixture.old.scopeRoot), { code: 'ENOENT' });
  assert.deepEqual((await listVscodeRuntimeDataSets(fixture.paths)).map(({ id, selected }) => ({ id, selected })),
    [{ id: 'default', selected: true }]);
  assert.deepEqual(await treeSnapshot(path.dirname(fixture.current.binding.paths.dataRootPath)), currentBefore);
  assert.equal(await fs.readFile(settings, 'utf8'), '{"keep":true}');
});

test('相邻指针不能掩盖SQLite内身份漂移；pending恢复和未知文件系统入口均拒绝删除', async (t) => {
  const fixture = await createFixture(t);
  const database = new Database(fixture.old.binding.paths.databasePath);
  database.prepare('UPDATE root_binding SET data_set_id = ? WHERE singleton = 1').run('another-data-set');
  database.close();
  const before = await treeSnapshot(fixture.root);
  await assert.rejects(deleteUnselectedRuntimeDataSet(fixture.paths, fixture.old.id, fixture.old.binding.dataSetId), /RootBinding fence mismatch/);
  await assert.rejects(openRuntimeDataSetHistory(fixture.paths, fixture.old.id), /RootBinding fence mismatch/);
  assert.deepEqual(await treeSnapshot(fixture.root), before);
  await fs.writeFile(fixture.old.binding.paths.rootPendingPath, JSON.stringify(fixture.old.binding));
  await assert.rejects(deleteUnselectedRuntimeDataSet(fixture.paths, fixture.old.id, fixture.old.binding.dataSetId), /pending/);
  assert.ok((await fs.stat(fixture.old.binding.paths.databasePath)).isFile());
});

test('尚未确定当前数据集时允许只读历史但拒绝把未知当前库当作旧库删除', async (t) => {
  const fixture = await createFixture(t);
  await fs.rm(resolveVscodeRuntimeSelectionPath(fixture.paths));
  const before = await treeSnapshot(fixture.root);
  await assert.rejects(deleteUnselectedRuntimeDataSet(fixture.paths, fixture.old.id, fixture.old.binding.dataSetId), /Select a fixed current/);
  const reader = await openRuntimeDataSetHistory(fixture.paths, fixture.old.id);
  try { assert.deepEqual((await reader.listConversations()).items, []); }
  finally { await reader.close(); }
  assert.deepEqual(await treeSnapshot(fixture.root), before);
});

for (const scopeKind of ['default', 'workspace']) {
  test(`${scopeKind}真实reset归档计入历史备份，整库删除包含同scope多代备份且保留共享配置`, async (t) => {
    const fixture = await createFixture(t);
    const target = scopeKind === 'default' ? fixture.current : fixture.old;
    const survivor = scopeKind === 'default' ? fixture.old : fixture.current;
    await seedHistory(target.binding);
    const oldDataSetId = target.binding.dataSetId;
    const authority = new RootAuthority(() => target.binding.paths.dataRootPath, undefined, () => fixture.root);
    const archived = await archiveCurrentRuntimeRootForReset(authority, target.scopeRoot);
    assert.equal(archived.archived, true);
    assert.equal(path.dirname(archived.backupPath), path.join(target.scopeRoot, VSCODE_INCOMPATIBLE_RUNTIME_BACKUPS_DIRECTORY));
    target.binding = await initialize(target.scopeRoot);
    assert.notEqual(target.binding.dataSetId, oldDataSetId);
    const backupFiles = Object.values(await treeSnapshot(archived.backupPath));
    const backupBytes = backupFiles.reduce((sum, file) => sum + BigInt(file.size), 0n);
    await selectVscodeRuntimeDataSet(fixture.paths, survivor.id);
    const keep = path.join(fixture.root, 'settings/keep.json');
    const unrelated = path.join(fixture.root, 'independent-backups/keep.bin');
    for (const file of [keep, unrelated]) {
      await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'keep');
    }
    const usage = await inspectRuntimeDataSetStorage(fixture.paths, target.id);
    assert.deepEqual(usage.categories.historicalBackups, { fileCount: backupFiles.length, bytes: backupBytes.toString() });
    assert.equal(usage.archiveReclaimsBytes, false);
    const result = await deleteUnselectedRuntimeDataSet(fixture.paths, target.id, target.binding.dataSetId);
    assert.deepEqual(result.deleted, usage.total);
    await assert.rejects(fs.stat(path.join(target.scopeRoot, VSCODE_INCOMPATIBLE_RUNTIME_BACKUPS_DIRECTORY)), { code: 'ENOENT' });
    await assert.rejects(fs.stat(target.binding.paths.databasePath), { code: 'ENOENT' });
    assert.ok((await fs.stat(survivor.binding.paths.databasePath)).isFile());
    assert.equal(await fs.readFile(keep, 'utf8'), 'keep');
    assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep');
  });
}

test('归档备份根为符号链接时统计和删除均拒绝，尚未删除完整候选或外部内容', async (t) => {
  const fixture = await createFixture(t);
  const external = path.join(fixture.root, 'settings');
  await fs.mkdir(external, { recursive: true });
  await fs.writeFile(path.join(external, 'keep.json'), 'keep');
  await fs.symlink(external, path.join(fixture.old.scopeRoot, VSCODE_INCOMPATIBLE_RUNTIME_BACKUPS_DIRECTORY), 'dir');
  await assert.rejects(inspectRuntimeDataSetStorage(fixture.paths, fixture.old.id), /symbolic/);
  await assert.rejects(deleteUnselectedRuntimeDataSet(fixture.paths, fixture.old.id, fixture.old.binding.dataSetId), /symbolic/);
  assert.ok((await fs.stat(fixture.old.binding.paths.databasePath)).isFile());
  assert.equal(await fs.readFile(path.join(external, 'keep.json'), 'utf8'), 'keep');
});

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-storage-test-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const paths = { globalStoragePath: root };
  const scope = resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: ['file:///history-fixture'] });
  const oldRoot = resolveVscodeWorkspaceRuntimeScopeRoot(paths, scope);
  const current = await initialize(root);
  const old = await initialize(oldRoot);
  await selectVscodeRuntimeDataSet(paths, 'default');
  return { root, paths, current: { binding: current, scopeRoot: root, id: 'default' },
    old: { binding: old, scopeRoot: oldRoot, id: `workspace:${scope.key}` } };
}

async function initialize(scopeRoot) {
  const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot }));
  return authority.initializeEmptyRoot(async (binding) => {
    await fs.mkdir(binding.paths.casRootPath, { recursive: true });
    const database = new Database(binding.paths.databasePath);
    try { configureWriterConnection(database); initializeCurrentSchema(database, binding); }
    finally { database.close(); }
  });
}

async function seedHistory(binding, userText = '用户原文') {
  const database = new Database(binding.paths.databasePath);
  configureWriterConnection(database);
  try {
    for (const id of ['conversation-a', 'conversation-b']) database.prepare('INSERT INTO conversation VALUES (?, ?, ?, ?, ?)').run(id, id, 'active', now, now);
    const user = await content(database, binding, 'content-user', userText, 'text/plain');
    const model = await content(database, binding, 'content-model', JSON.stringify({ role: 'model', parts: [
      { text: '助手当前版本' }, { inlineData: { mimeType: 'image/png', name: 'image.png', attachmentId: 'fixture-attachment' } }
    ] }), 'application/vnd.limcode.message+json');
    database.prepare('INSERT INTO content_object VALUES (?, ?, ?, ?, ?, ?)').run('duplicate-metadata', 'application/octet-stream', model.sha256, model.bytes, model.key, now);
    for (const [suffix, sequence, objectId, role] of [['user', 1, 'content-user', 'user'], ['model', 2, 'content-model', 'model']]) {
      database.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(`message-${suffix}`, now, now, null);
      database.prepare('INSERT INTO message_revision VALUES (?, ?, ?, ?, ?, ?)').run(`revision-${suffix}`, `message-${suffix}`, 1, role, objectId, now);
      database.prepare('INSERT INTO message_current_revision_link VALUES (?, ?, ?, ?)').run(`current-${suffix}`, `message-${suffix}`, `revision-${suffix}`, now);
      database.prepare('INSERT INTO message_part_of_conversation VALUES (?, ?, ?, ?, ?)').run(`membership-${suffix}`, 'conversation-a', `message-${suffix}`, sequence, now);
    }
    return { userFile: user.file };
  } finally { database.close(); }
}

async function content(database, binding, id, source, type) {
  const bytes = Buffer.byteLength(source);
  const sha256 = createHash('sha256').update(source).digest('hex');
  const key = `sha256/${sha256.slice(0, 2)}/${sha256}`;
  const file = path.join(binding.paths.casRootPath, key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source);
  database.prepare('INSERT INTO content_object VALUES (?, ?, ?, ?, ?, ?)').run(id, type, sha256, bytes, key, now);
  return { bytes, sha256, key, file };
}

async function publishHost(binding) {
  const target = path.join(binding.paths.dataRootPath, 'host-liveness/fixture.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify({ dataSetId: binding.dataSetId, rootInstanceId: binding.rootInstanceId,
    rootGeneration: binding.rootGeneration, hostBootId: 'fixture-host', livenessId: 'fixture-liveness', processId: process.pid,
    processStartIdentity: ownProcessStartIdentity(), startedAt: now, heartbeatAt: now }));
  return target;
}

async function treeSnapshot(root) {
  const files = {};
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else {
        const stat = await fs.stat(file);
        files[path.relative(root, file)] = { size: stat.size, mtime: stat.mtimeMs,
          sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') };
      }
    }
  }
  await visit(root);
  return files;
}
