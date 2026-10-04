import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import {
  createConfigurationRoot, Database, kernel, kernelFile, NOW, rawWrite, removeConfigurationRoot,
  seedConversations, withRuntime
} from './fixtures/runtime-merge-fixture.mjs';

const { scanMergeRows, reinspectLargeMergeKeptWork } = kernelFile('runtimeDataSetStreamedMerge.js');
const { createRuntimeDataSetDatabaseSnapshot, isRuntimeSnapshotReaderPath } = kernelFile('runtimeStorageInspection.js');
const { toSqliteFilePath } = kernelFile('sqliteFilePath.js');
const { resolveVscodeRuntimeDataSet } = kernelFile('vscodeRootAuthority.js');
const { auditRuntimeSnapshot } = kernelFile('runtimeSnapshotAudit.js');
const { RUNTIME_DOMAIN_SCHEMAS } = kernelFile('schema/domainManifest.js');
const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);

function minimalSource() {
  const source = new Database(':memory:');
  source.defaultSafeIntegers(true);
  source.exec("CREATE TABLE root_binding(singleton INTEGER PRIMARY KEY, data_set_id TEXT, root_instance_id TEXT); INSERT INTO root_binding VALUES (1, 'source-data-set', 'source-root')");
  for (const schema of RUNTIME_DOMAIN_SCHEMAS) source.exec(`CREATE TABLE "${schema.table}" (${schema.columns.map((column) =>
    `"${column.name}" ${column.type}${column.name === 'id' ? ' PRIMARY KEY' : ''}`).join(',')})`);
  source.exec('CREATE TEMP TABLE limcode_merge_skip (domain TEXT, id TEXT, PRIMARY KEY(domain,id)) WITHOUT ROWID');
  return source;
}

test('全跳过的原始行仍每 250 行让出，保留行 0 条时也能在下一轮事件循环取消', async (t) => {
  const source = minimalSource();
  t.after(() => source.close());
  const insert = source.prepare('INSERT INTO conversation VALUES (?, ?, ?, ?, ?)');
  const skip = source.prepare("INSERT INTO temp.limcode_merge_skip VALUES ('Conversation', ?)");
  source.transaction(() => {
    for (let i = 0; i < 20_000; i++) {
      const id = `deleted_${i}`;
      insert.run(id, id, 'active', NOW, NOW);
      skip.run(id);
    }
  })();
  const abort = new AbortController();
  const requested = setImmediate(() => abort.abort());
  t.after(() => clearImmediate(requested));
  let targetReads = 0;
  await assert.rejects(scanMergeRows(source, {
    snapshot: async () => { targetReads++; return { snapshot: [] }; },
    mergeModelAggregates: async () => []
  }, { skipping: true, chunkRows: 10_000, signal: abort.signal }), (error) => error.name === 'AbortError');
  assert.equal(targetReads, 0, '没有保留行，不需要调用目标 reader');
  assert.equal(source.inTransaction, false, '取消释放来源 iterator');
});

test('按原始行让出仍保持 CollaborationMessage 的 message_seq 排序，过滤发生在解码前', async (t) => {
  const source = minimalSource();
  t.after(() => source.close());
  const insert = source.prepare('INSERT INTO collaboration_message VALUES (?, ?, ?, ?, ?)');
  for (const sequence of [40, 10, 30, 20, 50]) {
    insert.run(`message_${sequence}`, `key_${sequence}`, sequence, sequence === 20 ? 'invalid-skipped-mode' : 'message', NOW);
  }
  source.prepare("INSERT INTO temp.limcode_merge_skip VALUES ('CollaborationMessage', 'message_20')").run();
  const visited = [];
  const scan = await scanMergeRows(source, {
    snapshot: async (reads) => {
      for (const read of reads) if (read.domain === 'CollaborationMessage') visited.push(read.id);
      return { snapshot: reads.map(() => null) };
    },
    mergeModelAggregates: async () => []
  }, { skipping: true, chunkRows: 1 });
  assert.deepEqual(visited, ['message_10', 'message_30', 'message_40', 'message_50']);
  assert.equal(scan.rows, 4);
  assert.equal(scan.insertRows, 4);
});

async function fixture(t) {
  const f = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(f.root));
  await seedConversations(f.alpha, [{ id: 'removed' }, { id: 'kept' }]);
  const candidate = await resolveVscodeRuntimeDataSet(f.paths, f.alpha.id);
  return { ...f, candidate };
}

const hash = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');

test('Windows 私有 snapshot guard 比较 SQLite native 路径，支持长路径和 UNC', () => {
  for (const logical of ['C:\\Users\\test\\Temp\\limcode-runtime-history-1-private\\limcode.sqlite', '\\\\server\\share\\Temp\\limcode-runtime-history-1-private\\limcode.sqlite']) {
    const native = toSqliteFilePath(logical, 'win32');
    assert.notEqual(native, logical);
    assert.equal(isRuntimeSnapshotReaderPath(logical, native, 'win32'), true);
    assert.equal(isRuntimeSnapshotReaderPath(logical, `${native}-other`, 'win32'), false);
  }
});

test('40 万个跳过键留在 SQLite：过滤后重检不构造 JS 全量 Map、不阻塞窗口，原库字节不变', { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const count = 400_000;
  rawWrite(f.alpha, (db) => {
    const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
    for (let i = 0; i < count; i++) insert.run(`skipped_bulk_message_${i}`, NOW, NOW, null);
  });
  await withRuntime(f.alpha, (db) => db.transaction([
    repo('Turn').insert({ id: 'kept_active', conversation_id: 'kept', status: 'active', created_at: NOW, updated_at: NOW, terminal_at: null }),
    repo('Turn').insert({ id: 'removed_active', conversation_id: 'removed', status: 'active', created_at: NOW, updated_at: NOW, terminal_at: null })
  ]));
  const originalHash = await hash(f.alpha.binding.paths.databasePath);
  const snapshot = await createRuntimeDataSetDatabaseSnapshot(f.candidate, f.alpha.binding);
  t.after(() => snapshot.close());
  const source = snapshot.database;
  source.pragma('query_only = OFF');
  source.pragma('temp_store = FILE');
  source.pragma('temp.cache_size = -2048');
  source.exec('CREATE TEMP TABLE limcode_merge_skip (domain TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(domain,id)) WITHOUT ROWID');
  const insertSkip = source.prepare('INSERT INTO temp.limcode_merge_skip VALUES (?, ?)');
  source.transaction(() => {
    insertSkip.run('Conversation', 'removed');
    insertSkip.run('Turn', 'removed_active');
    for (let i = 0; i < count; i++) insertSkip.run('Message', `skipped_bulk_message_${i}`);
  })();
  source.pragma('query_only = ON');
  // Any return to the former main-thread Map materialization fails before the timing assertion.
  const prepare = source.prepare;
  let exportedRows = 0, exportedPages = 0;
  source.prepare = function (sql, ...args) {
    assert.doesNotMatch(sql, /SELECT\s+domain\s*,\s*id\s+FROM\s+temp\.limcode_merge_skip\s*;?\s*$/i, '跳过键不能全部搬到 JS');
    const statement = prepare.call(this, sql, ...args);
    if (/SELECT\s+domain\s*,\s*id\s+FROM\s+temp\.limcode_merge_skip/i.test(sql)) {
      assert.match(sql, /WHERE\s+\(domain,\s*id\)\s*>\s*\(\?,\s*\?\)/);
      const plan = prepare.call(this, `EXPLAIN QUERY PLAN ${sql}`).all('', '');
      assert.match(plan.map((row) => row.detail).join('\n'), /SEARCH .* USING PRIMARY KEY/);
      const all = statement.all;
      statement.all = function (...parameters) {
        const rows = all.apply(this, parameters);
        assert.equal(rows.length <= 250, true, '每页最多 250 个键');
        exportedRows += rows.length; exportedPages++;
        return rows;
      };
    }
    return statement;
  };
  assert.throws(() => source.prepare('SELECT domain, id FROM temp.limcode_merge_skip'), /跳过键不能全部搬到 JS/);
  const phases = {};
  source.backup = () => assert.fail('不能对整份临时索引走 Backup 最末的同步提交');
  const close = source.close;
  source.close = function (...args) {
    const started = performance.now();
    try { return close.apply(this, args); }
    finally { phases.closeMs = performance.now() - started; }
  };
  const handoff = snapshot.withClosedReader;
  let recheckStarted;
  snapshot.withClosedReader = async function (run) {
    phases.skipExportMs = performance.now() - recheckStarted;
    let workerFinished;
    try {
      return await handoff.call(this, async (copy) => {
        const started = performance.now();
        try { return await run(copy); }
        finally { workerFinished = performance.now(); phases.workerMs = workerFinished - started; }
      });
    } finally { if (workerFinished !== undefined) phases.reopenMs = performance.now() - workerFinished; }
  };
  let last = performance.now(), maxGap = 0, ticks = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
  }, 10);
  await new Promise((resolve) => setTimeout(resolve, 25));
  last = performance.now(); maxGap = 0; ticks = 0;
  const started = performance.now();
  recheckStarted = started;
  let inspection;
  try {
    inspection = await reinspectLargeMergeKeptWork(snapshot, f.alpha.binding);
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally { clearInterval(ticker); }
  const elapsedMs = performance.now() - started;
  t.diagnostic(JSON.stringify({ skippedRows: count, elapsedMs, maxGap, ticks, ...phases }));
  assert.equal(inspection.refused.length, 0);
  assert.equal(exportedRows, count + 2, '全部键经有界 keyset 页导出');
  assert.equal(exportedPages > 1, true);
  assert.deepEqual(inspection.turns.map((turn) => turn.turnId), ['kept_active']);
  assert.equal(source.open, false, '交给 worker 前关闭旧 reader');
  assert.notEqual(snapshot.database, source, 'worker 退出后使用新的 reader');
  assert.equal(snapshot.database.readonly, true);
  assert.equal(snapshot.database.inTransaction, false);
  assert.equal(ticks >= 3, true, '重检期间窗口事件循环持续运行');
  assert.equal(maxGap < 500, true, `主线程长时间阻塞：${maxGap} ms`);
  assert.equal(await hash(f.alpha.binding.paths.databasePath), originalHash, '原库文件不改动');
});

test('私有 reader 交接拒绝事务、活动 iterator 和硬链接；worker 失败也先退出再恢复 reader', async (t) => {
  const f = await fixture(t);
  const snapshot = await createRuntimeDataSetDatabaseSnapshot(f.candidate, f.alpha.binding);
  t.after(() => snapshot.close());
  const source = snapshot.database;
  let handed = false;
  const handoff = async () => { handed = true; };
  source.exec('BEGIN');
  await assert.rejects(snapshot.withClosedReader(handoff), /idle private read-only snapshot/);
  source.exec('ROLLBACK');
  const iterator = source.prepare('SELECT id FROM conversation').iterate();
  iterator.next();
  await assert.rejects(snapshot.withClosedReader(handoff), /busy|iterat/i);
  iterator.return();
  assert.equal(source.open, true);
  const link = `${source.name}.hardlink`;
  await fs.link(source.name, link);
  try { await assert.rejects(snapshot.withClosedReader(handoff), /separate, link-free/); }
  finally { await fs.rm(link); }
  assert.equal(handed, false);
  await assert.rejects(snapshot.withClosedReader(async (copy) => {
    assert.equal(source.open, false);
    assert.throws(() => snapshot.database, /reader is closed/);
    return auditRuntimeSnapshot(copy, { binding: { ...f.alpha.binding, rootInstanceId: 'wrong-root' }, unfinishedWork: 'finalize' });
  }), /RootBinding|root_instance|binding|root instance/i);
  assert.equal(snapshot.database.open, true);
  assert.equal(snapshot.database.readonly, true);
  assert.notEqual(snapshot.database, source);
  assert.equal(snapshot.database.prepare('SELECT COUNT(*) AS count FROM conversation').get().count, 2n);
});


test('跳过索引导出中取消保留原 reader，临时索引清理 EBUSY 只记日志不覆盖重检结果', async (t) => {
  const f = await fixture(t);
  const snapshot = await createRuntimeDataSetDatabaseSnapshot(f.candidate, f.alpha.binding);
  t.after(() => snapshot.close());
  const source = snapshot.database;
  source.pragma('query_only = OFF');
  source.exec("CREATE TEMP TABLE limcode_merge_skip (domain TEXT, id TEXT, PRIMARY KEY(domain,id)) WITHOUT ROWID; INSERT INTO temp.limcode_merge_skip VALUES ('Conversation','removed')");
  source.pragma('query_only = ON');
  const abort = new AbortController();
  const requested = setImmediate(() => abort.abort());
  try {
    await assert.rejects(reinspectLargeMergeKeptWork(snapshot, f.alpha.binding, abort.signal), (error) => error.name === 'AbortError');
  } finally { clearImmediate(requested); }
  assert.equal(snapshot.database, source, '导出被取消，尚未关闭私有 reader');
  assert.equal(source.open, true);
  const remove = fs.rm;
  const warn = console.warn;
  let abandoned;
  const warnings = [];
  fs.rm = async (file, ...args) => {
    if (!abandoned && String(file).includes('limcode-runtime-history-')) {
      abandoned = String(file);
      throw Object.assign(new Error('scanner holds temporary index'), { code: 'EBUSY' });
    }
    return remove(file, ...args);
  };
  console.warn = (...args) => warnings.push(args);
  try {
    const inspection = await reinspectLargeMergeKeptWork(snapshot, f.alpha.binding);
    assert.deepEqual(inspection, { refused: [], turns: [], intents: [] });
    assert.equal(snapshot.database.open, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][0], /临时跳过索引没有删掉/);
    assert.ok(abandoned);
  } finally {
    fs.rm = remove;
    console.warn = warn;
    if (abandoned) await remove(abandoned, { recursive: true, force: true });
  }
});
