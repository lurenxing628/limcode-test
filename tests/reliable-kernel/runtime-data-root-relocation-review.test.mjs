// Review findings of the data-root relocation (reloc-safety R1–R6, #8 #11 #13 #15, reloc-perf F/H/#7
// and the temporary row limit), each as the behaviour it must have.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compiled, conversationIds, createFixture, relocationIdIn, createLimCodeTarget, Database, deleteAsConfirmed, indexIds, initialize, kernelFile, openRuntime,
  planWithRuntime, NOW, PROJECT, relocate, relocation, renameConversation, repo, RootAuthority, rootAuthority, seed, selectedDataSet, treeSnapshot,
  writeRecordStore
} from './runtime-data-root-relocation-fixture.mjs';

const {
  assertDataRootAvailable, invalidateDataRootRelocationRecord, planDataRootRelocation, planOldDataRootDeletion,
  deleteOldDataRoot, readDataRootRelocationRecord, sweepDataRootRelocationLeftovers
} = relocation;
const { inspectVscodeRuntimeDataSets, resolveVscodeWorkspaceRuntimeScope, resolveVscodeWorkspaceRuntimeScopeRoot } = rootAuthority;
const { runtimeDataSetFingerprint, writeRuntimeDataSetMergeLedgerRecord } = kernelFile('runtimeDataSetMergeLedger.js');
const { RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS } = kernelFile('runtimeDataSetMerge.js');

const itemsByKey = (plan) => new Map(plan.items.map((item) => [item.key, item]));

test('R1 回到旧目录后在旧目录继续写入：完成记录失效，删除旧目录被拒绝；没能标记失效（新目录当时不可达）时按指纹发现改动，改动过的库和设置不删', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const A = fixture.root;
  const B = path.join(fixture.base, 'B');
  await relocate(fixture, await planDataRootRelocation({ sourceRootPath: A, targetRootPath: B }));
  // "回到旧目录" while B is reachable: B's completion record is invalidated.
  await invalidateDataRootRelocationRecord(B);
  await seed(fixture.current, [{ id: 'conversation_written_in_A_after_return', project: PROJECT }]);
  const relocationId = await relocationIdIn(B);
  const refused = await planOldDataRootDeletion({ oldRootPath: A, currentRootPath: B, relocationId });
  assert.match(refused.problems.join('\n'), /回到过这个旧目录/);
  await assert.rejects(deleteOldDataRoot({ oldRootPath: A, currentRootPath: B, relocationId, confirmedKeys: [] }), { code: 'data-root-old-delete-refused' });
  assert.ok(conversationIds(fixture.current.binding.paths.dataRootPath).includes('conversation_written_in_A_after_return'));
  assert.equal((await readDataRootRelocationRecord(B))?.invalidated, true);

  // Same story when the return happened while B was unreachable (its record could not be marked).
  const other = await createFixture(t, { withAlpha: false });
  const C = path.join(other.base, 'C');
  await relocate(other, await planDataRootRelocation({ sourceRootPath: other.root, targetRootPath: C }));
  await seed(other.current, [{ id: 'conversation_written_after_move', project: PROJECT }]);
  await fs.writeFile(path.join(other.root, 'settings', 'llm.json'), '{"activeProviderConfigId":"changed"}\n');
  const { plan, result } = await deleteAsConfirmed({ oldRootPath: other.root, currentRootPath: C });
  const items = itemsByKey(plan);
  assert.deepEqual([items.get('data-set:default').deletable, items.get('data-set:default').reason], [false, '迁移之后这个历史库有新的改动']);
  assert.deepEqual([items.get('configuration:settings').deletable, items.get('configuration:settings').reason], [false, '迁移之后有改动']);
  assert.equal(items.get('configuration:agents').deletable, true);
  assert.equal(items.get('metadata').deletable, false);
  assert.equal(result.remainingDataSets, 1);
  assert.ok(conversationIds(other.current.binding.paths.dataRootPath).includes('conversation_written_after_move'), '迁移之后写的对话没有被删');
  assert.equal(await fs.readFile(path.join(other.root, 'settings', 'llm.json'), 'utf8'), '{"activeProviderConfigId":"changed"}\n');
  await assert.rejects(fs.stat(path.join(other.root, 'agents')), { code: 'ENOENT' }, '没有改动、确已迁移的设置照常删除');
});

test('R2 用户文件夹里有与已登记目录同名的文件夹：算用户文件，只能迁到新建的子文件夹；之后删除旧目录不碰用户文件', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const docs = path.join(fixture.base, 'Documents');
  await fs.mkdir(path.join(docs, 'attachments'), { recursive: true });
  await fs.writeFile(path.join(docs, 'attachments', 'my-photo.jpg'), 'user photo');
  await fs.mkdir(path.join(docs, 'workflows'), { recursive: true });
  await fs.writeFile(path.join(docs, 'workflows', 'team-process.md'), 'user notes');
  const plan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: docs });
  assert.equal(plan.target.kind, 'occupied');
  assert.deepEqual(plan.target.entries, ['attachments', 'workflows']);
  assert.equal(plan.target.suggestedPath, path.join(docs, 'LimCode'));
  assert.match(plan.problems.join('\n'), /只能放在其中新建的子文件夹里/, '不能直接迁进有用户文件的文件夹');

  const home = plan.target.suggestedPath;
  await relocate(fixture, await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: home }));
  await relocation.finalizeDataRootRelocation(home); // the reload into the new directory
  const moved = await selectedDataSet(home);
  const second = path.join(fixture.base, 'Elsewhere');
  const movedFixture = { ...fixture, root: home, paths: { globalStoragePath: home }, current: { authority: new RootAuthority(() => moved.runtimeDataRootPath) } };
  await relocate(movedFixture, await planDataRootRelocation({ sourceRootPath: home, targetRootPath: second }));
  await fs.writeFile(path.join(home, 'todo.txt'), 'dropped here later');
  const { plan: deletion } = await deleteAsConfirmed({ oldRootPath: home, currentRootPath: second });
  assert.deepEqual(deletion.kept.map((entry) => entry.name), ['todo.txt']);
  assert.equal(await fs.readFile(path.join(docs, 'attachments', 'my-photo.jpg'), 'utf8'), 'user photo');
  assert.equal(await fs.readFile(path.join(docs, 'workflows', 'team-process.md'), 'utf8'), 'user notes');
  assert.deepEqual((await fs.readdir(home)).sort(), ['todo.txt']);
});

test('R3 外置盘挂载点里被写出 settings/ 等零散内容：可用性检查不放行；指针记录了身份时，同名目录里的另一份数据也不放行', async (t) => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-relocation-mount-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const mountPoint = path.join(base, 'mnt', 'usb');
  const dataRoot = path.join(mountPoint, 'LimCode');
  await fs.mkdir(mountPoint, { recursive: true });
  await assert.rejects(assertDataRootAvailable(dataRoot), { reason: 'missing' });
  // The drive dropped out while a window still ran: saving a setting creates settings/ on the mount point.
  const { writeFileAtomicDurable } = await import(path.join(compiled, 'backend/capabilities/vscodeStorage/durableWrite.js'));
  await writeFileAtomicDurable(path.join(dataRoot, 'settings', 'llm.json'), '{}\n');
  await assert.rejects(assertDataRootAvailable(dataRoot), { reason: 'empty' });
  await assert.rejects(assertDataRootAvailable(dataRoot, randomUUID()), { reason: 'empty' });
  // Another LimCode directory at the same path (e.g. a different drive mounted there) is not the recorded one.
  await writeRecordStore(dataRoot, 'agents', 'agent', [{ id: 'a', name: 'a' }]);
  await assert.rejects(assertDataRootAvailable(dataRoot), { reason: 'empty' }, '没有记录身份时，设置记录存储也不算 LimCode 数据（reloc2 F3）');
  await initialize(dataRoot, 'default');
  await relocation.ensureDataRootIdentity(dataRoot);
  await assert.rejects(assertDataRootAvailable(dataRoot, randomUUID()), { reason: 'mismatch' });
});

test('R4/#8 已有 LimCode 目标在合并提交后失败：用迁移自己的备份恢复目标库；之后旧目录改过对话再迁移到同一目录照常成功', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'existing');
  const existing = await createLimCodeTarget(target);
  const plan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  assert.equal(plan.target.kind, 'limcode');
  await assert.rejects(relocate(fixture, plan, { publish: async () => { throw new Error('指针写入失败'); } }), /指针写入失败/);
  assert.deepEqual(conversationIds(existing.binding.paths.dataRootPath), ['conversation_existing_1'], '目标库恢复到迁移之前');
  const merges = path.join(path.dirname(existing.binding.paths.dataRootPath), 'merge-backups');
  assert.deepEqual(await fs.readdir(merges).catch(() => []), [], '这次合并留下的合并备份也一并撤销');

  await renameConversation(fixture.current, 'conversation_current_1', '改过的标题');
  const again = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  assert.deepEqual(again.problems, []);
  const { result } = await relocate(fixture, again);
  assert.equal(result.merged.insertedConversations, 2);
  const database = new Database(existing.binding.paths.databasePath, { readonly: true });
  try {
    assert.equal(database.prepare("SELECT title FROM conversation WHERE id = 'conversation_current_1'").pluck().get(), '改过的标题');
  } finally { database.close(); }
});

test('已有目标迁移复用预复制正文校验和唯一持久备份；备份包含迁移前记录并由迁移收尾', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'existing');
  const existing = await createLimCodeTarget(target);
  const uncheckpointed = path.join(fixture.base, 'uncheckpointed-target');
  await fs.mkdir(uncheckpointed);
  const receiving = await openRuntime(existing);
  try {
    await receiving.transaction([repo('Conversation').insert({
      id: 'conversation_only_in_wal', title: 'only in WAL', status: 'active', created_at: NOW, updated_at: NOW
    })]);
    for (const suffix of ['', '-wal']) await fs.copyFile(`${existing.binding.paths.databasePath}${suffix}`, path.join(uncheckpointed, `limcode.sqlite${suffix}`));
  } finally { await receiving.close(); }
  for (const suffix of ['-wal', '-shm']) await fs.rm(`${existing.binding.paths.databasePath}${suffix}`, { force: true });
  for (const suffix of ['', '-wal']) await fs.copyFile(path.join(uncheckpointed, `limcode.sqlite${suffix}`), `${existing.binding.paths.databasePath}${suffix}`);
  const plan = await planWithRuntime(fixture, target);
  const source = await openRuntime(fixture.current);
  let staged;
  try { staged = await relocation.stageDataRootRelocation(plan, source); }
  finally { await source.close(); }
  const targetCas = path.resolve(existing.binding.paths.casRootPath);
  const precopiedFiles = [...staged.precopied.verification.keys()].filter((file) => file.startsWith(`${targetCas}${path.sep}`));
  assert.ok(precopiedFiles.length > 0, '预复制已有正文文件校验记录');
  const streamed = [];
  const stream = fsSync.createReadStream;
  const copy = fs.copyFile;
  const runtimeBackup = kernelFile('runtimeDatabase.js').RuntimeDatabase.prototype.backupTo;
  const receivingPath = path.resolve(existing.binding.paths.databasePath);
  const originalMain = await fs.readFile(receivingPath);
  const originalWal = await fs.readFile(`${receivingPath}-wal`).catch((error) => { if (error.code === 'ENOENT') return undefined; throw error; });
  assert.ok(originalWal?.length > 0, '前提：目标有只在 WAL 里的已提交记录');
  let receivingCopies = 0;
  fsSync.createReadStream = function (file, ...options) {
    if (precopiedFiles.includes(String(file))) streamed.push(String(file));
    return stream.call(this, file, ...options);
  };
  fs.copyFile = function (from, destination, ...options) {
    if (path.resolve(String(from)) === receivingPath && String(destination).includes(relocation.DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY)) receivingCopies += 1;
    return copy.call(this, from, destination, ...options);
  };
  kernelFile('runtimeDatabase.js').RuntimeDatabase.prototype.backupTo = function (destination) {
    assert.notEqual(path.resolve(this.binding.paths.dataRootPath), path.resolve(existing.binding.paths.dataRootPath),
      '合并引擎必须复用迁移已持久化的备份，不再创建第二份');
    return runtimeBackup.call(this, destination);
  };
  let result;
  try { result = await relocation.completeDataRootRelocation(staged, async () => undefined); }
  finally {
    fsSync.createReadStream = stream;
    fs.copyFile = copy;
    kernelFile('runtimeDatabase.js').RuntimeDatabase.prototype.backupTo = runtimeBackup;
  }
  assert.deepEqual(streamed, [], '文件身份没变的预复制正文不再全读算摘要');
  assert.equal(receivingCopies, 1, '迁移前目标数据库文件只复制一次');
  const backupPath = path.join(target, relocation.DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY, staged.relocationId, 'database-receiving');
  assert.equal(result.merged.backupPath, backupPath);
  const backupFiles = originalWal === undefined ? ['limcode.sqlite'] : ['limcode.sqlite', 'limcode.sqlite-wal'];
  assert.deepEqual(await fs.readdir(backupPath), backupFiles, '撤销副本保留原来实际存在的 main/WAL 文件');
  assert.deepEqual(await fs.readFile(path.join(backupPath, 'limcode.sqlite')), originalMain, '原数据库物理字节完整保留');
  if (originalWal !== undefined) assert.deepEqual(await fs.readFile(path.join(backupPath, 'limcode.sqlite-wal')), originalWal, '原 WAL 物理字节完整保留');
  // Inspect a private readonly copy: opening a WAL-mode database may create empty WAL/SHM even
  // in readonly mode, so the production rollback snapshot itself must not be opened by this test.
  const inspection = path.join(fixture.base, 'inspect-rollback');
  await fs.mkdir(inspection);
  for (const file of backupFiles) await fs.copyFile(path.join(backupPath, file), path.join(inspection, file));
  const saved = new Database(path.join(inspection, 'limcode.sqlite'), { readonly: true, fileMustExist: true });
  try { assert.deepEqual(saved.prepare('SELECT id FROM conversation ORDER BY id').pluck().all(), ['conversation_existing_1', 'conversation_only_in_wal']); }
  finally { saved.close(); }
  assert.deepEqual(await fs.readdir(backupPath), backupFiles, '只读检查不向撤销副本添加 WAL/SHM');
  await relocation.finalizeDataRootRelocation(target);
  await assert.rejects(fs.stat(backupPath), { code: 'ENOENT' }, '迁移收尾统一清理自己的撤销副本');
});

test('迁移预检不计算未复制删除记录的摘要，撤销在一次准入内只读取一次日志', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const { recordRuntimeDeletedConversations } = kernelFile('runtimeMergeTombstones.js');
  await recordRuntimeDeletedConversations(fixture.root, fixture.current.binding, ['conversation_deleted_before_relocation']);
  const target = path.join(fixture.base, 'moved');
  const stream = fsSync.createReadStream;
  const hashes = [];
  fsSync.createReadStream = function (file, ...options) {
    if (String(file).includes(`${path.sep}deleted-conversations${path.sep}`)) hashes.push(String(file));
    return stream.call(this, file, ...options);
  };
  let plan;
  try { plan = await planWithRuntime(fixture, target); }
  finally { fsSync.createReadStream = stream; }
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(hashes, [], '目标缺少记录时，预检只校验记录格式，不计算丢弃的复制摘要');
  const source = await openRuntime(fixture.current);
  let staged;
  try { staged = await relocation.stageDataRootRelocation(plan, source); }
  finally { await source.close(); }
  const read = fs.readFile;
  let journalReads = 0;
  fs.readFile = function (file, ...options) {
    if (path.basename(String(file)) === 'journal.jsonl') journalReads += 1;
    return read.call(this, file, ...options);
  };
  try { await relocation.abandonStagedDataRootRelocation(staged); }
  finally { fs.readFile = read; }
  assert.equal(journalReads, 1, '离线判断、变化检查与撤销复用同一份日志');
});

test('R5 全局规则（AGENTS.md / CLAUDE.md）和全局技能（skills/）随迁移复制并在预检里写明；删除旧目录时按摘要认定', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  await fs.writeFile(path.join(fixture.root, 'AGENTS.md'), '# 我的全局规则\n');
  await fs.writeFile(path.join(fixture.root, 'CLAUDE.md'), '# 我的全局规则 2\n');
  await fs.mkdir(path.join(fixture.root, 'skills', 'my-skill'), { recursive: true });
  await fs.writeFile(path.join(fixture.root, 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---\n');
  const target = path.join(fixture.base, 'moved');
  const plan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  assert.deepEqual(plan.problems, []);
  assert.ok(plan.warnings.some((warning) => /全局规则和技能（AGENTS\.md、CLAUDE\.md、skills）/.test(warning)));
  await relocate(fixture, plan);
  assert.equal(await fs.readFile(path.join(target, 'AGENTS.md'), 'utf8'), '# 我的全局规则\n');
  assert.equal(await fs.readFile(path.join(target, 'CLAUDE.md'), 'utf8'), '# 我的全局规则 2\n');
  assert.equal(await fs.readFile(path.join(target, 'skills', 'my-skill', 'SKILL.md'), 'utf8'), '---\nname: my-skill\n---\n');
  await fs.writeFile(path.join(fixture.root, 'CLAUDE.md'), '# 迁移之后改过\n');
  const items = itemsByKey(await planOldDataRootDeletion({ oldRootPath: fixture.root, currentRootPath: target, relocationId: await relocationIdIn(target) }));
  assert.equal(items.get('configuration:AGENTS.md').deletable, true);
  assert.equal(items.get('configuration:skills').deletable, true);
  assert.equal(items.get('configuration:CLAUDE.md').deletable, false);
});

test('#17 用户自己以 .lock、.tmp 结尾的文件（如检查点工作树里的）照常复制并核对；只跳过 LimCode 自己的锁和临时文件的确切名字', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const worktree = path.join(fixture.root, 'checkpoints', 'shadow', 'worktree');
  await fs.mkdir(worktree, { recursive: true });
  await fs.writeFile(path.join(worktree, 'yarn.lock'), 'user lock file\n');
  await fs.writeFile(path.join(worktree, 'draft.tmp'), 'user temporary file\n');
  await fs.writeFile(path.join(fixture.root, 'agents', `index.json.${process.pid}.${randomUUID()}.tmp`), 'LimCode temporary');
  const target = path.join(fixture.base, 'moved');
  const plan = await planWithRuntime(fixture, target);
  assert.deepEqual(plan.problems, []);
  await relocate(fixture, plan);
  const moved = path.join(target, 'checkpoints', 'shadow', 'worktree');
  assert.equal(await fs.readFile(path.join(moved, 'yarn.lock'), 'utf8'), 'user lock file\n');
  assert.equal(await fs.readFile(path.join(moved, 'draft.tmp'), 'utf8'), 'user temporary file\n');
  assert.deepEqual((await fs.readdir(path.join(target, 'agents'))).filter((name) => name.endsWith('.tmp')), [], 'LimCode 自己的临时文件不复制');
});

test('R6 settings/ 下嵌套的记录存储按记录 id 合并：目标独有的渠道和 MCP 仍在索引里，来源的记录加进来', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  await writeRecordStore(path.join(fixture.root, 'settings'), 'llm-provider-configs', 'config', [{ id: 'provider-source', name: 'source', apiKey: 'sk-source' }]);
  await writeRecordStore(path.join(fixture.root, 'settings'), 'mcp-servers', 'server', [{ id: 'mcp-source', name: 'source' }]);
  const target = path.join(fixture.base, 'existing');
  await createLimCodeTarget(target);
  await writeRecordStore(path.join(target, 'settings'), 'llm-provider-configs', 'config', [{ id: 'provider-target-only', name: 'target', apiKey: 'sk-target' }]);
  await writeRecordStore(path.join(target, 'settings'), 'mcp-servers', 'server', [{ id: 'mcp-target-only', name: 'target' }]);
  const plan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  assert.equal(plan.target.kind, 'limcode');
  await relocate(fixture, plan);
  assert.deepEqual(await indexIds(path.join(target, 'settings', 'llm-provider-configs')), ['provider-source', 'provider-target-only']);
  assert.deepEqual(await indexIds(path.join(target, 'settings', 'mcp-servers')), ['mcp-source', 'mcp-target-only']);
  const source = JSON.parse(await fs.readFile(path.join(target, 'settings', 'llm-provider-configs', 'records', 'provider-source.json'), 'utf8'));
  assert.equal(source.config.apiKey, 'sk-source');
});

test('#11 归档、合并备份和升级备份默认保留，只有勾选才删，并写明大小', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const controlRoot = path.dirname(fixture.current.binding.paths.dataRootPath);
  await fs.mkdir(path.join(controlRoot, 'merge-backups', '20260901T000000Z-aaaaaaaa'), { recursive: true });
  await fs.writeFile(path.join(controlRoot, 'merge-backups', '20260901T000000Z-aaaaaaaa', 'limcode.sqlite'), 'x'.repeat(1000));
  await fs.mkdir(path.join(fixture.root, '.limcode-runtime-backups', '2026-09-01'), { recursive: true });
  await fs.writeFile(path.join(fixture.root, '.limcode-runtime-backups', '2026-09-01', 'limcode.sqlite'), 'y'.repeat(2000));
  const target = path.join(fixture.base, 'moved');
  await relocate(fixture, await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target }));
  await assert.rejects(fs.stat(path.join(target, '.limcode-runtime-backups')), { code: 'ENOENT' }, '归档不随迁移复制');
  const input = { oldRootPath: fixture.root, currentRootPath: target, relocationId: await relocationIdIn(target) };
  const items = itemsByKey(await planOldDataRootDeletion(input));
  const mergeBackups = items.get('backup:default:merge-backups');
  const archives = items.get('backup:default:.limcode-runtime-backups');
  assert.deepEqual([mergeBackups.optional, mergeBackups.bytes, archives.optional, archives.bytes], [true, 1000, true, 2000]);
  await deleteAsConfirmed(input, ['backup:default:merge-backups']);
  await assert.rejects(fs.stat(path.join(controlRoot, 'merge-backups')), { code: 'ENOENT' }, '勾选的备份删除');
  assert.equal((await fs.readFile(path.join(fixture.root, '.limcode-runtime-backups', '2026-09-01', 'limcode.sqlite'), 'utf8')).length, 2000, '没勾选的归档保留');
  await assert.rejects(fs.stat(fixture.current.binding.paths.dataRootPath), { code: 'ENOENT' }, '迁移过且没改动的历史库删除');
});

test('盲审 F5：删除旧目录时勾选的归档逐份在当前目录的外来声明下删：正在被合并（声明被占）或只读查看（有登记）的那份保留并写明，其余照删；都空出来之后才删掉', async (t) => {
  const foreign = kernelFile('runtimeForeignHistory.js');
  const { registerForeignRuntimeHistoryView } = kernelFile('runtimeForeignHistoryViews.js');
  const fixture = await createFixture(t, { withAlpha: false });
  const archives = path.join(fixture.root, '.limcode-runtime-backups');
  const [FIRST, SECOND] = ['20260901-000000-000-aaaaaaaa', '20260902-000000-000-bbbbbbbb'];
  for (const name of [FIRST, SECOND]) {
    await fs.mkdir(path.join(archives, name), { recursive: true });
    await fs.writeFile(path.join(archives, name, 'limcode.sqlite'), name);
  }
  const target = path.join(fixture.base, 'moved');
  await relocate(fixture, await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target }));
  const input = { oldRootPath: fixture.root, currentRootPath: target, relocationId: await relocationIdIn(target) };
  const discovered = await foreign.discoverForeignRuntimeHistory({ configurationRootPath: target, previousDataRootPaths: [fixture.root] });
  const rootOf = (name) => discovered.find((entry) => entry.location.containerPath === path.join(archives, name));
  const [first, second] = [rootOf(FIRST), rootOf(SECOND)];
  assert.ok(first && second, '前提：当前目录把旧目录的两份归档都认作外来历史库');
  const pointer = (entry) => path.join(entry.location.containerPath, 'root-binding.json');
  const key = 'backup:default:.limcode-runtime-backups';

  // A merge of the first holds its claim (another async scope, as another window would).
  let release;
  let entered;
  const holding = new Promise((resolve) => { entered = resolve; });
  const held = foreign.tryWithForeignRuntimeRootClaim(target, first.id, pointer(first), async () => {
    entered();
    await new Promise((resolve) => { release = resolve; });
  });
  await holding;
  let deleted;
  try {
    deleted = (await deleteAsConfirmed(input, [key])).result;
  } finally { release(); await held; }
  assert.deepEqual(deleted.busy.map((entry) => entry.path), [path.join(archives, FIRST)]);
  assert.match(deleted.busy[0].reason, /正在被合并或查看/);
  assert.ok(!deleted.removed.includes(key), '这一项没有删完，不算已删');
  assert.equal(await fs.readFile(path.join(archives, FIRST, 'limcode.sqlite'), 'utf8'), FIRST, '被占用的那份保留');
  await assert.rejects(fs.stat(path.join(archives, SECOND)), { code: 'ENOENT' }, '没被占用的那份照删');
  assert.equal(deleted.remainingArchives, 1);

  // A read-only view of it is registered: kept as well.
  const view = await registerForeignRuntimeHistoryView(target, first.id);
  try {
    const again = (await deleteAsConfirmed(input, [key])).result;
    assert.deepEqual(again.busy.map((entry) => entry.path), [path.join(archives, FIRST)]);
  } finally { await view.release(); }
  assert.equal(await fs.readFile(path.join(archives, FIRST, 'limcode.sqlite'), 'utf8'), FIRST);

  const last = (await deleteAsConfirmed(input, [key])).result;
  assert.deepEqual([last.busy, last.removed.includes(key), last.remainingArchives], [[], true, 0]);
  await assert.rejects(fs.stat(archives), { code: 'ENOENT' });
});

test('#13 已合并进当前库且之后没改动的旧库不再单独复制；迁不了的库记在新目录的完成记录里（设置页显示）', async (t) => {
  const fixture = await createFixture(t);
  const alpha = (await inspectVscodeRuntimeDataSets(fixture.paths)).candidates.find((candidate) => candidate.id === fixture.alpha.id);
  await writeRuntimeDataSetMergeLedgerRecord(fixture.paths, {
    candidateId: alpha.id, state: 'merged', source: await runtimeDataSetFingerprint(alpha),
    target: { dataSetId: fixture.current.binding.dataSetId, rootInstanceId: fixture.current.binding.rootInstanceId },
    mergedAt: '2026-09-20T00:00:00.000Z', insertedRows: 1, reusedRows: 0, insertedConversations: 1
  });
  const target = path.join(fixture.base, 'moved');
  const { result } = await relocate(fixture, await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target }));
  assert.deepEqual(result.leftBehind.map(item=>item.id), [fixture.alpha.id]);
  assert.ok(!(await inspectVscodeRuntimeDataSets({ globalStoragePath: target })).candidates.some((candidate) => candidate.id === fixture.alpha.id));
  const items = itemsByKey(await planOldDataRootDeletion({ oldRootPath: fixture.root, currentRootPath: target, relocationId: await relocationIdIn(target) }));
  assert.equal(items.get(`data-set:${fixture.alpha.id}`).deletable, false);
  assert.match(items.get(`data-set:${fixture.alpha.id}`).reason, /没有迁移/);

  const other = await createFixture(t);
  const taken = path.join(other.base, 'taken');
  await createLimCodeTarget(taken);
  const scope = resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: ['file:///workspace/alpha'] });
  const takenScope = resolveVscodeWorkspaceRuntimeScopeRoot({ globalStoragePath: taken }, scope);
  await fs.mkdir(takenScope, { recursive: true });
  await initialize(takenScope, `workspace:${scope.key}`);
  const { result: takenResult } = await relocate(other, await planDataRootRelocation({ sourceRootPath: other.root, targetRootPath: taken }));
  assert.deepEqual(takenResult.leftBehind.map((item) => item.id), [other.alpha.id]);
  const record = await readDataRootRelocationRecord(taken);
  assert.deepEqual(record.leftBehind.map(({ id, reason }) => ({ id, reason })), [{ id: other.alpha.id, reason: '旧数据原位保留，在新目录登记待合并，不另建历史库' }]);
  assert.match(record.leftBehind[0].hint, /立即合并全部/, '设置页按原因说明能怎么处理');
});

test('#15 新目录正被其它 LimCode 窗口使用时不迁入', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'in-use');
  const existing = await createLimCodeTarget(target);
  const window = await openRuntime(existing);
  try {
    const plan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
    assert.match(plan.problems.join('\n'), /正被其它 LimCode 窗口使用/);
  } finally { await window.close(); }
});

test('行数上限只管合并进已有 LimCode 数据：迁入新建根时当前库和其它库都不受限；已有目标时当前库超限在任何协调之前拒绝，目标不改动', async (t) => {
  const fixture = await createFixture(t);
  const bulk = (databasePath, prefix) => {
    const database = new Database(databasePath);
    try {
      const insert = database.prepare("INSERT INTO conversation (id, title, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)");
      database.transaction(() => {
        for (let index = 0; index <= RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS; index += 1) insert.run(`${prefix}_${index}`, 't', '2026-09-26T00:00:00.000Z', '2026-09-26T00:00:00.000Z');
      })();
    } finally { database.close(); }
  };
  bulk(fixture.alpha.binding.paths.databasePath, 'conversation_bulk_alpha');
  bulk(fixture.current.binding.paths.databasePath, 'conversation_bulk_current');
  const fresh = await planWithRuntime(fixture, path.join(fixture.base, 'moved'));
  assert.deepEqual(fresh.problems, [], '新建根按批写入，不受单事务上限');
  assert.equal(fresh.current.rows, undefined, '迁入新建根不统计行数');
  assert.match(fresh.others[0].leaveBehind, /原位保留/, '其它来源无论大小都不另建运行库');
  const existing = path.join(fixture.base, 'existing');
  await createLimCodeTarget(existing);
  const before = await treeSnapshot(existing);
  const refused = await planWithRuntime(fixture, existing);
  assert.equal(refused.target.kind, 'limcode');
  assert.match(refused.problems.join('\n'), /合并一次最多 \d+ 行），当前版本暂不能迁移到这个目录；旧目录不受影响/);
  assert.ok(refused.current.rows > RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS, '合并进已有目标时统计当前库的行数');
  assert.deepEqual(await treeSnapshot(existing), before, '预检不改动已有目标');
  const controlRoot = path.dirname(fixture.current.binding.paths.dataRootPath);
  assert.deepEqual((await fs.readdir(controlRoot)).filter((name) => name.startsWith('relocation-count-')), [], '计数不在旧目录里做副本');
});

test('空间预估按盘核对：新目录约 2×数据库、临时目录 1×数据库、旧目录 1×数据库，同一块盘合计；只遍历一次', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const plan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: path.join(fixture.base, 'moved') });
  const database = plan.current.databaseBytes;
  assert.ok(database > 0);
  // In this test everything lives on one disk: one entry naming every use.
  assert.equal(plan.space.length, 1);
  assert.match(plan.space[0].label, /新数据目录、临时目录、旧数据目录/);
  assert.ok(plan.space[0].requiredBytes >= 4 * database + 64 * 1024 * 1024, `required ${plan.space[0].requiredBytes} for database ${database}`);
});

test('崩溃残留：已结束进程的快照目录、预复制暂存和计数副本被清理；还在运行的进程和较新的无主文件不动', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const deadPid = (await import('node:child_process')).spawnSync(process.execPath, ['-e', '']).pid;
  const tag = randomUUID().slice(0, 6);
  const temporary = os.tmpdir();
  const deadSnapshot = path.join(temporary, `limcode-runtime-history-${deadPid}-${tag}`);
  const liveSnapshot = path.join(temporary, `limcode-runtime-history-${process.pid}-${tag}`);
  const oldUnowned = path.join(temporary, `limcode-merge-precopy-${tag}`);
  for (const directory of [deadSnapshot, liveSnapshot, oldUnowned]) {
    await fs.mkdir(directory);
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
  }
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  await fs.utimes(oldUnowned, twoDaysAgo, twoDaysAgo);
  const controlRoot = path.dirname(fixture.current.binding.paths.dataRootPath);
  const deadStaging = path.join(controlRoot, `merge-precopy-${deadPid}-${randomUUID()}.sqlite`);
  const deadCount = path.join(controlRoot, `relocation-count-${deadPid}-${randomUUID()}.sqlite-wal`);
  const freshLegacy = path.join(controlRoot, `merge-precopy-${randomUUID()}.sqlite`);
  for (const file of [deadStaging, deadCount, freshLegacy]) await fs.writeFile(file, 'x');
  const { removed } = await sweepDataRootRelocationLeftovers(fixture.root);
  assert.deepEqual(removed.filter((file) => file.includes(tag) || file.startsWith(controlRoot)).sort(), [deadStaging, deadCount, deadSnapshot, oldUnowned].sort());
  await fs.stat(liveSnapshot);
  await fs.stat(freshLegacy);
});
