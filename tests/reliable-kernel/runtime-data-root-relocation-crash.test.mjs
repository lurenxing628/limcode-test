// Real SIGKILL at each phase of a data-root relocation (child: runtime-data-root-relocation-crash-child.mjs),
// then what the next startup does: the pointer names the old or the fully written new directory, the
// in-progress record undoes the target's changes, abandoned private copies are swept, and the same
// target can receive the relocation again.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  compiled, conversationIds, Database, indexIds, kernel, planWithRuntime, relocate, relocation, RootAuthority, rootAuthority, selectedDataSet
} from './runtime-data-root-relocation-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const checkout = path.resolve(here, '../..');
const { recoverInterruptedDataRootRelocation, sweepDataRootRelocationLeftovers, finalizeDataRootRelocation } = relocation;

async function runChild(t, scenario, kind) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `limcode-relocation-crash-${scenario}-`)));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const child = spawn(process.execPath, [path.join(here, 'runtime-data-root-relocation-crash-child.mjs'), scenario, base, kind], { stdio: 'inherit' });
  const signal = await new Promise((resolve) => child.on('exit', (_code, exitSignal) => resolve(exitSignal)));
  const log = await fs.readFile(path.join(base, 'child.log'), 'utf8').catch(() => '');
  const fixture = JSON.parse(await fs.readFile(path.join(base, 'fixture.json'), 'utf8'));
  const pointer = JSON.parse(await fs.readFile(path.join(base, 'pointer.json'), 'utf8'));
  return { base, signal, log, fixture, pointer };
}

async function assertOldHomeIntact(root) {
  const inspection = await rootAuthority.inspectVscodeRuntimeDataSets({ globalStoragePath: root });
  assert.deepEqual(inspection.problems, []);
  const selected = inspection.candidates.find((candidate) => candidate.selected);
  assert.equal(selected.id, 'default');
  assert.deepEqual(conversationIds(selected.runtimeDataRootPath), ['conversation_current_1', 'conversation_current_2']);
  const reopened = await kernel.RuntimeDatabase.open(new RootAuthority(() => selected.runtimeDataRootPath), { hostBootId: `restart-${Date.now()}` });
  await reopened.close();
  return selected;
}

for (const [scenario, kind] of [
  ['stage-precopy', 'empty'],
  ['precopy-backup', 'empty'],
  ['during-merge', 'empty'],
  ['before-complete-marker', 'empty'],
  ['before-publish', 'empty'],
  ['config-index', 'limcode'],
  ['during-merge', 'limcode'],
  ['after-merge-commit', 'limcode'],
  ['before-complete-marker', 'limcode'],
  ['before-publish', 'limcode']
]) {
  test(`SIGKILL ${scenario}（${kind === 'empty' ? '空目标' : '已有 LimCode 目标'}）：指针不动，下次启动按进行中记录撤销新目录里的改动、清理临时副本，之后可以再次迁移`, async (t) => {
    const run = await runChild(t, scenario, kind);
    assert.equal(run.signal, 'SIGKILL', run.log);
    const { root, target, relocationId, pid } = run.fixture;
    assert.equal(run.pointer.dataRootPath, root, '指针仍是旧目录');
    assert.equal(run.pointer.pendingRelocation?.relocationId, relocationId);

    if (kind === 'limcode' && scenario === 'before-complete-marker') {
      // Published insert-only journals did not have an `updated` field. They remain readable;
      // recovery must still prove the old or received fingerprint before restoring anything.
      const file = path.join(target, '.limcode-relocation-backups', relocationId, 'journal.jsonl');
      const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      for (const entry of lines) if (entry.op === 'merging') { assert.deepEqual(entry.updated, []); delete entry.updated; }
      await fs.writeFile(file, `${lines.map(entry => JSON.stringify(entry)).join('\n')}\n`);
    }

    // Next startup: the owner is gone, its changes in the target are undone, its copies swept.
    assert.equal(await recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId }), 'recovered');
    await sweepDataRootRelocationLeftovers(root);
    const selected = await assertOldHomeIntact(root);
    const controlRoot = path.dirname(selected.runtimeDataRootPath);
    assert.deepEqual((await fs.readdir(controlRoot)).filter((name) => name.includes(`-${pid}-`)), [], '旧目录控制根里没有预复制暂存');
    assert.deepEqual((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith('limcode-') && name.includes(`-${pid}-`)), [], '临时目录里没有私有副本');
    if (kind === 'empty') {
      // A maintenance claim held by the killed process stays (the claim protocol never deletes a dead
      // claim or its tombstone); nothing else of the attempt does.
      const remaining = (await fs.readdir(target).catch(() => [])).filter((name) => !/\.runtime-maintenance(\.generation-.+)?$/.test(name));
      assert.deepEqual(remaining, [], '本次在新目录里做的改动全部撤销');
    } else {
      const existing = await selectedDataSet(target);
      assert.deepEqual(conversationIds(existing.runtimeDataRootPath), scenario === 'after-merge-commit'
        ? ['conversation_current_1', 'conversation_existing_1'] : ['conversation_existing_1'], '目标库恢复到迁移之前');
      assert.deepEqual(await indexIds(path.join(target, 'agents')), ['agent-shared', 'agent-target-only'], '目标的设置索引完整');
      const shared = JSON.parse(await fs.readFile(path.join(target, 'agents', 'records', 'agent-shared.json'), 'utf8'));
      assert.equal(shared.agent.name, 'target version', '被替换的设置已放回');
      await assert.rejects(fs.stat(path.join(target, '.limcode-relocation-backups')), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(target, '.limcode-data-root-relocation.json')), { code: 'ENOENT' });
    }

    // The same target receives the relocation again.
    const current = { authority: new RootAuthority(() => selected.runtimeDataRootPath) };
    const fixture = { root, paths: { globalStoragePath: root }, current };
    const plan = await planWithRuntime(fixture, target);
    assert.deepEqual(plan.problems, []);
    assert.equal(plan.target.kind, kind);
    const { result } = await relocate(fixture, plan);
    assert.equal(result.merged.insertedConversations, scenario === 'after-merge-commit' ? 1 : 2);
    if (kind === 'limcode') {
      assert.deepEqual(await indexIds(path.join(target, 'agents')), ['agent-shared', 'agent-source-only', 'agent-target-only']);
    }
  });
}

test('安装包形态（按 prune-package-dist.mjs 裁剪后的 dist）：SIGKILL 在合并提交进已有 LimCode 目标之后、写 received 之前，下次启动照样核对“目标只多了这次插入的行”并撤销；核对线程不在包里或加载就出错时报这个版本自身的问题（不当作暂时读不出、什么都不动），装回之后照常撤销', { timeout: 180_000 }, async (t) => {
  const run = await runChild(t, 'after-merge-commit', 'limcode');
  assert.equal(run.signal, 'SIGKILL', run.log);
  const { target, relocationId } = run.fixture;
  const receiving = (await selectedDataSet(target)).runtimeDataRootPath;
  const merged = ['conversation_current_1', 'conversation_current_2', 'conversation_existing_1'];
  assert.deepEqual(conversationIds(receiving), merged, '合并已提交进目标');
  const journal = await fs.readFile(path.join(target, '.limcode-relocation-backups', relocationId, 'journal.jsonl'), 'utf8').catch(() => '');
  assert.ok(journal.includes('"op":"merging"') && !journal.includes('"op":"received"'), journal);
  const entries = journal.trim().split('\n').map(line => JSON.parse(line));
  const merging = entries.find(entry => entry.op === 'merging');
  const before = entries.find(entry => entry.op === 'database').before.contentDigest;
  assert.equal(merging.inserted.filter(([domain]) => domain === 'ConversationContextHandleState').length, 1,
    '新对话的本地目录行也在撤销证据里');
  const provenance = merging.inserted.filter(([domain]) => domain === 'TimelineImportProvenance').map(([, id]) => id);
  assert.equal(provenance.length, 2, '新增来源证明和来源已有的同一证明都恰好记录一次');
  assert.equal(new Set(provenance).size, 2);
  const receivingReader = new Database(path.join(receiving, 'limcode.sqlite'), { readonly: true });
  try {
    const existing = receivingReader.prepare('SELECT id FROM timeline_import_provenance WHERE send_timeline_link_id = ?')
      .pluck().get('relocation_existing_send_timeline');
    assert.ok(existing && !provenance.includes(existing), '目标原有的来源证明不在撤销插入列表里');
  } finally { receivingReader.close(); }
  assert.equal(merging.updated.length, 1, '共享对话的目录更新有完整的前后证据');
  assert.equal(merging.updated[0].before.state, 'ready');
  assert.equal(merging.updated[0].after.state, 'pending');

  // The package as the VSIX carries it: the checkout's dist pruned to its Runtime closure.
  const packaged = await prunedPackage(run.base);
  const worker = path.join(packaged, 'backend/reliableKernel/runtimeDataRootRelocationWorker.js');
  assert.ok(await fs.stat(worker), '核对线程随安装包分发');

  // Without its worker (an earlier package) or with one that fails to load: this build's own defect,
  // said as such; never 'unreadable' (retried forever), and nothing in the target is touched.
  const markerFile = path.join(target, relocation.DATA_ROOT_RELOCATION_MARKER_FILE);
  const marker = await fs.readFile(markerFile, 'utf8');
  await fs.rename(worker, `${worker}.aside`);
  const missing = await recoverWithPackage(packaged, target, relocationId);
  assert.equal(missing.code, 'data-root-relocation-check-worker-failed', JSON.stringify(missing));
  assert.match(missing.message, /^撤销前的核对没能运行（.*Cannot find module.*）：这是这个 LimCode 版本自身的问题，不是目录读不出/s);
  await fs.writeFile(worker, "throw new Error('broken check worker');\n");
  const broken = await recoverWithPackage(packaged, target, relocationId);
  assert.equal(broken.code, 'data-root-relocation-check-worker-failed', JSON.stringify(broken));
  assert.match(broken.message, /broken check worker/);
  assert.deepEqual(conversationIds(receiving), merged, '什么都没有撤销');
  assert.equal(await fs.readFile(markerFile, 'utf8'), marker, '记录保持不变');

  // The packaged worker proves the entire old content, and refuses even a timestamp-only later
  // edit to the updated authority. These probes touch only private copies, never the target.
  await fs.rm(worker);
  await fs.rename(`${worker}.aside`, worker);
  for (const changed of [false, true, 'legacy-unlogged-update']) {
    const copy = path.join(run.base, `undo-proof-${changed}.sqlite`);
    for (const suffix of ['', '-wal']) await fs.copyFile(path.join(receiving, `limcode.sqlite${suffix}`), `${copy}${suffix}`)
      .catch(error => { if (suffix === '' || error.code !== 'ENOENT') throw error; });
    if (changed === true) {
      const database = new Database(copy);
      try { database.prepare('UPDATE conversation_context_handle_state SET updated_at = ? WHERE id = ?')
        .run('2026-09-28T00:00:00.000Z', merging.updated[0].after.id); }
      finally { database.close(); }
    }
    const proof = await new Promise((resolve, reject) => {
      const check = new Worker(worker, { workerData: { databasePath: copy, inserted: merging.inserted,
        ...(changed === 'legacy-unlogged-update' ? {} : { updated: merging.updated }) } });
      check.once('message', resolve);
      check.once('error', reject);
    });
    if (changed === 'legacy-unlogged-update') {
      assert.equal(proof.ok, true);
      assert.equal(typeof proof.digest, 'string');
      assert.notEqual(proof.digest, before, '旧日志缺少更新证据时保持严格拒绝撤销');
    } else assert.deepEqual(proof, { ok: true, digest: changed ? null : before }, '完整前态核验不忽略目录行的后续改动');
  }

  // The worker as packaged: the check runs in the package and the relocation is undone.
  assert.deepEqual(await recoverWithPackage(packaged, target, relocationId), { outcome: 'recovered' });
  assert.deepEqual(conversationIds((await selectedDataSet(target)).runtimeDataRootPath), ['conversation_current_1', 'conversation_existing_1'], '目标库恢复到迁移之前');
  const restored = new Database(path.join(receiving, 'limcode.sqlite'), { readonly: true });
  try {
    const row = restored.prepare('SELECT * FROM conversation_context_handle_state WHERE id = ?').safeIntegers(true)
      .get(merging.updated[0].before.id);
    assert.deepEqual(Object.fromEntries(Object.entries(row).map(([key, value]) =>
      [key, typeof value === 'bigint' ? value.toString() : value])), merging.updated[0].before, '目标已有目录逐字段恢复');
  } finally { restored.close(); }
  assert.deepEqual(await indexIds(path.join(target, 'agents')), ['agent-shared', 'agent-target-only'], '目标的设置索引完整');
  await assert.rejects(fs.stat(markerFile), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(target, '.limcode-relocation-backups')), { code: 'ENOENT' });
});

/**
 * The compiled extension pruned as the VSIX is (scripts/reliable-kernel/prune-package-dist.mjs), in
 * `base`; its bare requires (better-sqlite3) resolve from the checkout's node_modules, as the VSIX
 * carries them.
 */
async function prunedPackage(base) {
  const packageRoot = path.join(base, 'package');
  await fs.mkdir(path.join(packageRoot, 'dist'), { recursive: true });
  await fs.cp(compiled, path.join(packageRoot, 'dist', 'extension'), { recursive: true });
  await fs.symlink(path.join(checkout, 'node_modules'), path.join(packageRoot, 'node_modules'), 'dir');
  execFileSync(process.execPath, [path.join(checkout, 'scripts/reliable-kernel/prune-package-dist.mjs')], { cwd: packageRoot, stdio: 'pipe' });
  const closure = JSON.parse(await fs.readFile(path.join(packageRoot, 'dist', 'package-runtime-closure.json'), 'utf8'));
  assert.equal(closure.kind, 'limcode-package-runtime-closure', '确实按安装包裁剪过');
  return path.join(packageRoot, 'dist', 'extension');
}

/** The next startup's recovery, run in its own process by the packaged Runtime. */
function recoverWithPackage(extensionRoot, target, relocationId) {
  const script = `
    const relocation = require(${JSON.stringify(path.join(extensionRoot, 'backend/reliableKernel/runtimeDataRootRelocation.js'))});
    relocation.recoverInterruptedDataRootRelocation({ targetRootPath: ${JSON.stringify(target)}, relocationId: ${JSON.stringify(relocationId)} }).then(
      (outcome) => process.stdout.write(JSON.stringify({ outcome })),
      (error) => process.stdout.write(JSON.stringify({ code: error && error.code, message: String(error && error.message) })));`;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', script], { cwd: checkout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

test('SIGKILL 在切换指针之后：指针指向完整写好的新目录，打开后收尾删除日志；旧目录完整', async (t) => {
  const run = await runChild(t, 'after-publish', 'empty');
  assert.equal(run.signal, 'SIGKILL', run.log);
  const { root, target } = run.fixture;
  assert.equal(run.pointer.dataRootPath, target);
  assert.equal(run.pointer.pendingRelocation, undefined, '进行中记录随指针一起清除');
  const moved = await selectedDataSet(target);
  assert.deepEqual(conversationIds(moved.runtimeDataRootPath), ['conversation_current_1', 'conversation_current_2']);
  // Killed before the record was confirmed: only an opener whose pointer names this relocation confirms and finalizes it.
  await finalizeDataRootRelocation(target);
  assert.ok(await fs.stat(path.join(target, '.limcode-relocation-backups')), '指针没有指明这次迁移的打开者不收尾');
  await finalizeDataRootRelocation(target, { publishedRelocationId: run.pointer.lastMigration.relocationId });
  assert.equal(JSON.parse(await fs.readFile(path.join(target, relocation.DATA_ROOT_RELOCATION_MARKER_FILE), 'utf8')).state, 'finalized');
  await assert.rejects(fs.stat(path.join(target, '.limcode-relocation-backups')), { code: 'ENOENT' }, '空目标没有被替换的设置：备份目录收尾后不留');
  await assertOldHomeIntact(root);
});

test('SIGKILL 在完成记录之后、切换指针之前，用户继续用旧目录改了对话：下次启动撤销那次迁移，再迁移到同一目录不冲突', async (t) => {
  const run = await runChild(t, 'before-publish', 'empty');
  assert.equal(run.signal, 'SIGKILL', run.log);
  const { root, target } = run.fixture;
  const selected = await assertOldHomeIntact(root);
  const current = { authority: new RootAuthority(() => selected.runtimeDataRootPath) };
  const { renameConversation } = await import('./runtime-data-root-relocation-fixture.mjs');
  await renameConversation(current, 'conversation_current_1', '重启后改名');
  // Even without the in-progress record (e.g. cleared by hand), the next relocation undoes that attempt first.
  const fixture = { root, paths: { globalStoragePath: root }, current };
  const plan = await planWithRuntime(fixture, target);
  assert.equal(plan.undoesEarlierAttempt, true);
  const { result } = await relocate(fixture, plan);
  assert.equal(result.merged.insertedConversations, 2);
});
