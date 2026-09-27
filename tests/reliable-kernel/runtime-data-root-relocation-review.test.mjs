// Review findings of the data-root relocation (reloc-safety R1–R6, #8 #11 #13 #15, reloc-perf F/H/#7
// and the temporary row limit), each as the behaviour it must have.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compiled, conversationIds, createFixture, relocationIdIn, createLimCodeTarget, Database, deleteAsConfirmed, indexIds, initialize, kernelFile, openRuntime,
  planWithRuntime, PROJECT, relocate, relocation, renameConversation, RootAuthority, rootAuthority, seed, selectedDataSet, treeSnapshot,
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
  const items = itemsByKey(await planOldDataRootDeletion({ oldRootPath: fixture.root, currentRootPath: target, relocationId: await relocationIdIn(target) }));
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
  assert.deepEqual(record.leftBehind.map(({ id, reason }) => ({ id, reason })), [{ id: other.alpha.id, reason: '新数据目录里已有同名历史库' }]);
  assert.match(record.leftBehind[0].hint, /已有同名的库，再迁移也不会带过来/, '设置页按原因说明能怎么处理');
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
  assert.equal(fresh.others[0].leaveBehind, undefined, '其它库总是进新建根，不再因行数留在旧目录');
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

test('其它历史库在线阶段已整库复制进新根：之后没变的直接保留，之后有写入的在独占阶段丢弃重做，迁移结果与来源一致', async (t) => {
  for (const changed of [false, true]) {
    const fixture = await createFixture(t);
    const target = path.join(fixture.base, `moved-${changed}`);
    const plan = await planWithRuntime(fixture, target);
    const source = await openRuntime(fixture.current);
    let staged;
    try { staged = await relocation.stageDataRootRelocation(plan, source, {}); }
    finally { await source.close(); }
    const receipt = staged.precopiedOthers[fixture.alpha.id]?.receipt;
    assert.ok(receipt && receipt.rows > 0, '在线阶段已复制其它库');
    assert.ok(staged.precopied.verification.size > 0, '当前库预复制带回已校验正文的元数据');
    const copiedDatabase = path.join(receipt.target.runtimeDataRootPath, 'limcode.sqlite');
    const copiedInode = (await fs.stat(copiedDatabase)).ino;
    if (changed) await seed(fixture.alpha, [{ id: 'conversation_alpha_after_stage', project: PROJECT }]);
    const result = await relocation.completeDataRootRelocation(staged, async () => undefined, {});
    const moved = await rootAuthority.resolveVscodeRuntimeDataSet({ globalStoragePath: target }, fixture.alpha.id);
    const finalDatabase = path.join(moved.runtimeDataRootPath, 'limcode.sqlite');
    if (changed) assert.notEqual((await fs.stat(finalDatabase)).ino, copiedInode, '来源变了：清空后重做');
    else assert.equal((await fs.stat(finalDatabase)).ino, copiedInode, '来源没变：在线复制原样保留，没有重做');
    assert.deepEqual(result.others.migrated, [fixture.alpha.id]);
    assert.deepEqual(conversationIds(moved.runtimeDataRootPath), conversationIds(fixture.alpha.binding.paths.dataRootPath));
    assert.equal(conversationIds(moved.runtimeDataRootPath).includes('conversation_alpha_after_stage'), changed);
  }
});

test('复审 bulk #2：在线复制过的其它库在独占阶段重做失败时，新目录里不留这个库的任何目录，迁移照常完成、它留在旧目录', async (t) => {
  const bulk = kernelFile('runtimeDataSetBulkCopy.js');
  const original = bulk.ensureRuntimeDataSetCopyCurrent;
  bulk.ensureRuntimeDataSetCopyCurrent = (paths, receipt, reset, options) => original(paths, receipt, async () => {
    await reset();
    throw Object.assign(new Error('注入：重做时磁盘已满'), { code: 'ENOSPC' });
  }, options);
  t.after(() => { bulk.ensureRuntimeDataSetCopyCurrent = original; });
  const fixture = await createFixture(t);
  const target = path.join(fixture.base, 'moved');
  const plan = await planWithRuntime(fixture, target);
  const source = await openRuntime(fixture.current);
  let staged;
  try { staged = await relocation.stageDataRootRelocation(plan, source, {}); } finally { await source.close(); }
  const copied = staged.precopiedOthers[fixture.alpha.id];
  assert.ok(copied, '在线阶段已复制 alpha');
  await seed(fixture.alpha, [{ id: 'conversation_alpha_after_stage', project: PROJECT }]);
  const result = await relocation.completeDataRootRelocation(staged, async () => undefined, {});
  assert.deepEqual(result.others.migrated, []);
  assert.match(result.others.leftBehind.find((entry) => entry.id === fixture.alpha.id)?.reason ?? '', /磁盘已满/);
  const scopeRoot = path.dirname(path.dirname(copied.receipt.target.runtimeDataRootPath));
  await assert.rejects(fs.stat(copied.createdPath), { code: 'ENOENT' }, '为它新建的目录全部删除');
  await assert.rejects(fs.stat(scopeRoot), { code: 'ENOENT' });
  const inspection = await rootAuthority.inspectVscodeRuntimeDataSets({ globalStoragePath: target });
  assert.deepEqual(inspection.candidates.map((candidate) => candidate.id), ['default'], '新目录里只有当前库，不会被当成待合并来源');
  assert.deepEqual(inspection.problems, []);
});

test('复审 bulk #3：在线复制过的其它库在 stage 与 complete 之间被并入当前库时，删掉 stage 为它新建的全部目录', async (t) => {
  const { runtimeDataSetFingerprint, writeRuntimeDataSetMergeLedgerRecord } = kernelFile('runtimeDataSetMergeLedger.js');
  const fixture = await createFixture(t);
  const target = path.join(fixture.base, 'moved');
  const plan = await planWithRuntime(fixture, target);
  const source = await openRuntime(fixture.current);
  let staged;
  try { staged = await relocation.stageDataRootRelocation(plan, source, {}); } finally { await source.close(); }
  const copied = staged.precopiedOthers[fixture.alpha.id];
  assert.ok(copied);
  const alpha = (await rootAuthority.inspectVscodeRuntimeDataSets(fixture.paths)).candidates.find((candidate) => candidate.id === fixture.alpha.id);
  await writeRuntimeDataSetMergeLedgerRecord(fixture.paths, {
    candidateId: alpha.id, state: 'merged', source: await runtimeDataSetFingerprint(alpha),
    target: { dataSetId: fixture.current.binding.dataSetId, rootInstanceId: fixture.current.binding.rootInstanceId },
    mergedAt: '2026-09-20T00:00:00.000Z', insertedRows: 1, reusedRows: 0, insertedConversations: 1
  });
  const result = await relocation.completeDataRootRelocation(staged, async () => undefined, {});
  assert.deepEqual(result.others.covered, [fixture.alpha.id]);
  await assert.rejects(fs.stat(copied.createdPath), { code: 'ENOENT' });
  const inspection = await rootAuthority.inspectVscodeRuntimeDataSets({ globalStoragePath: target });
  assert.deepEqual(inspection.problems, [], '下次迁移预检不会误报无法读取的历史库');
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

test('目标是别处拷来的 LimCode 数据：整体改名挪到旁边永不删除；同一个库时说明是旧拷贝；迁移失败时改回原名', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const copied = path.join(fixture.base, 'copied');
  await fs.cp(fixture.root, copied, { recursive: true });
  await fs.rm(path.join(copied, 'notes.txt'));
  const before = await treeSnapshot(copied);
  const plan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: copied });
  assert.deepEqual([plan.target.kind, plan.target.sameDataSet], ['copied', true]);
  await assert.rejects(relocate(fixture, plan, { publish: async () => { throw new Error('指针写入失败'); } }), /指针写入失败/);
  assert.deepEqual(await treeSnapshot(copied), before, '失败时拷贝原样放回');
  assert.deepEqual((await fs.readdir(fixture.base)).filter((name) => name.includes('.limcode-copied-')), []);

  const { result } = await relocate(fixture, await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: copied }));
  assert.ok(result.copiedDataMovedTo?.startsWith(`${copied}.limcode-copied-`));
  assert.deepEqual(await treeSnapshot(result.copiedDataMovedTo), before, '拷贝整体保留在旁边');
  assert.deepEqual(conversationIds((await selectedDataSet(copied)).runtimeDataRootPath), ['conversation_current_1', 'conversation_current_2']);

  // A copy of another library is kept aside the same way (importing it for a manual merge is not available yet).
  const other = path.join(fixture.base, 'other-library');
  await createLimCodeTarget(other);
  const otherCopy = path.join(fixture.base, 'other-copy');
  await fs.cp(other, otherCopy, { recursive: true });
  const otherPlan = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: otherCopy });
  assert.deepEqual([otherPlan.target.kind, otherPlan.target.sameDataSet], ['copied', false]);
  assert.ok(otherPlan.warnings.some((warning) => /另一份 LimCode 数据.*不合并、不删除/.test(warning)));
});
