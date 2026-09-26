// Review findings of the data-root relocation (reloc-safety R1–R6, #8 #11 #13 #15, reloc-perf F/H/#7
// and the temporary row limit), each as the behaviour it must have.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compiled, conversationIds, createFixture, createLimCodeTarget, Database, deleteAsConfirmed, indexIds, initialize, kernelFile, openRuntime,
  planWithRuntime, PROJECT, relocate, relocation, renameConversation, RootAuthority, rootAuthority, seed, selectedDataSet, writeRecordStore
} from './runtime-data-root-relocation-fixture.mjs';

const {
  DATA_ROOT_RELOCATION_MAX_ROWS, assertDataRootAvailable, invalidateDataRootRelocationRecord, planDataRootRelocation, planOldDataRootDeletion,
  deleteOldDataRoot, readDataRootRelocationRecord, sweepDataRootRelocationLeftovers
} = relocation;
const { inspectVscodeRuntimeDataSets, resolveVscodeWorkspaceRuntimeScope, resolveVscodeWorkspaceRuntimeScopeRoot } = rootAuthority;
const { runtimeDataSetFingerprint, writeRuntimeDataSetMergeLedgerRecord } = kernelFile('runtimeDataSetMergeLedger.js');

const itemsByKey = (plan) => new Map(plan.items.map((item) => [item.key, item]));

test('R1 回到旧目录后在旧目录继续写入：完成记录失效，删除旧目录被拒绝；没能标记失效（新目录当时不可达）时按指纹发现改动，改动过的库和设置不删', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const A = fixture.root;
  const B = path.join(fixture.base, 'B');
  await relocate(fixture, await planDataRootRelocation({ sourceRootPath: A, targetRootPath: B }));
  // "回到旧目录" while B is reachable: B's completion record is invalidated.
  await invalidateDataRootRelocationRecord(B);
  await seed(fixture.current, [{ id: 'conversation_written_in_A_after_return', project: PROJECT }]);
  const refused = await planOldDataRootDeletion({ oldRootPath: A, currentRootPath: B });
  assert.match(refused.problems.join('\n'), /回到过这个旧目录/);
  await assert.rejects(deleteOldDataRoot({ oldRootPath: A, currentRootPath: B, confirmedKeys: [] }), { code: 'data-root-old-delete-refused' });
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
  const items = itemsByKey(await planOldDataRootDeletion({ oldRootPath: fixture.root, currentRootPath: target }));
  assert.equal(items.get('configuration:AGENTS.md').deletable, true);
  assert.equal(items.get('configuration:skills').deletable, true);
  assert.equal(items.get('configuration:CLAUDE.md').deletable, false);
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
  const input = { oldRootPath: fixture.root, currentRootPath: target };
  const items = itemsByKey(await planOldDataRootDeletion(input));
  const mergeBackups = items.get('backup:default:merge-backups');
  const archives = items.get('backup:default:.limcode-runtime-backups');
  assert.deepEqual([mergeBackups.optional, mergeBackups.bytes, archives.optional, archives.bytes], [true, 1000, true, 2000]);
  await deleteAsConfirmed(input, ['backup:default:merge-backups']);
  await assert.rejects(fs.stat(path.join(controlRoot, 'merge-backups')), { code: 'ENOENT' }, '勾选的备份删除');
  assert.equal((await fs.readFile(path.join(fixture.root, '.limcode-runtime-backups', '2026-09-01', 'limcode.sqlite'), 'utf8')).length, 2000, '没勾选的归档保留');
  await assert.rejects(fs.stat(fixture.current.binding.paths.dataRootPath), { code: 'ENOENT' }, '迁移过且没改动的历史库删除');
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
  assert.deepEqual(result.others, { migrated: [], covered: [fixture.alpha.id], leftBehind: [] });
  assert.ok(!(await inspectVscodeRuntimeDataSets({ globalStoragePath: target })).candidates.some((candidate) => candidate.id === fixture.alpha.id));
  const items = itemsByKey(await planOldDataRootDeletion({ oldRootPath: fixture.root, currentRootPath: target }));
  assert.equal(items.get(`data-set:${fixture.alpha.id}`).deletable, true);
  assert.match(items.get(`data-set:${fixture.alpha.id}`).label, /已合并进当前库/);

  const other = await createFixture(t);
  const taken = path.join(other.base, 'taken');
  await createLimCodeTarget(taken);
  const scope = resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: ['file:///workspace/alpha'] });
  const takenScope = resolveVscodeWorkspaceRuntimeScopeRoot({ globalStoragePath: taken }, scope);
  await fs.mkdir(takenScope, { recursive: true });
  await initialize(takenScope, `workspace:${scope.key}`);
  const { result: takenResult } = await relocate(other, await planDataRootRelocation({ sourceRootPath: other.root, targetRootPath: taken }));
  assert.deepEqual(takenResult.others.leftBehind.map((item) => item.id), [other.alpha.id]);
  const record = await readDataRootRelocationRecord(taken);
  assert.deepEqual(record.leftBehind, [{ id: other.alpha.id, reason: '新数据目录里已有同名历史库' }]);
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

test('临时上限：当前库超过 25000 行时预检直接拒绝（目标不被创建）；其它库超限时留在旧目录', async (t) => {
  const fixture = await createFixture(t);
  const bulk = (databasePath, prefix) => {
    const database = new Database(databasePath);
    try {
      const insert = database.prepare("INSERT INTO conversation (id, title, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)");
      database.transaction(() => {
        for (let index = 0; index <= DATA_ROOT_RELOCATION_MAX_ROWS; index += 1) insert.run(`${prefix}_${index}`, 't', '2026-09-26T00:00:00.000Z', '2026-09-26T00:00:00.000Z');
      })();
    } finally { database.close(); }
  };
  bulk(fixture.alpha.binding.paths.databasePath, 'conversation_bulk_alpha');
  const target = path.join(fixture.base, 'moved');
  const withLargeOther = await planWithRuntime(fixture, target);
  assert.deepEqual(withLargeOther.problems, []);
  assert.match(withLargeOther.others[0].leaveBehind, /数据较多/);
  bulk(fixture.current.binding.paths.databasePath, 'conversation_bulk_current');
  const refused = await planWithRuntime(fixture, target);
  assert.match(refused.problems.join('\n'), /当前版本暂不能迁移；旧目录不受影响/);
  assert.ok(refused.current.rows > DATA_ROOT_RELOCATION_MAX_ROWS);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  const controlRoot = path.dirname(fixture.current.binding.paths.dataRootPath);
  assert.deepEqual((await fs.readdir(controlRoot)).filter((name) => name.startsWith('relocation-count-')), [], '计数用的副本已删除');
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
