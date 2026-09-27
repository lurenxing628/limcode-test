import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

// The SQLite worker reuses prepared statements per connection. A Runtime transaction is one
// synchronous worker call and better-sqlite3 frees a statement's native memory only after the
// thread returns to its event loop, so preparing per row made a large merge or relocation grow by
// tens of KiB per row. These tests pin the reuse contract: result modes, iterator re-entry, the LRU
// bound, and that no statement outlives its connection or schema.

const require = createRequire(import.meta.url);
const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiledRoot, 'backend/reliableKernel/index.js'));
// Required lazily so the worker-level tests below report their own assertion without this module.
const cacheModule = () => require(path.join(compiledRoot, 'backend/reliableKernel/runtimeStatementCache.js'));
const Database = require('better-sqlite3');
const NOW = '2026-09-26T00:00:00.000Z';

function memoryDatabase({ safeIntegers = true } = {}) {
  const database = new Database(':memory:');
  database.defaultSafeIntegers(safeIntegers);
  database.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL)');
  const insert = database.prepare('INSERT INTO t (id, n) VALUES (?, ?)');
  for (let index = 1; index <= 3; index += 1) insert.run(`row-${index}`, index);
  return database;
}

async function withRuntime(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-statement-cache-'));
  const opened = [];
  try {
    const candidate = await kernel.resetCandidateRuntimeRoot(directory);
    const open = async () => {
      const database = await kernel.RuntimeDatabase.open(candidate.authority);
      opened.push(database);
      return database;
    };
    await run({ open, binding: candidate.binding });
  } finally {
    for (const database of opened) await database.close().catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const receipts = (prefix, count) => Array.from({ length: count }, (_value, index) =>
  kernel.DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
    id: `${prefix}-receipt-${index}`, source_kind: 'statement-cache', source_key: `${prefix}:${index}`,
    conversation_id: null, turn_id: null, created_at: NOW
  }));
const conversations = (prefix, count) => Array.from({ length: count }, (_value, index) =>
  kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
    id: `${prefix}-conversation-${index}`, title: `会话 ${index}`, status: 'active', created_at: NOW, updated_at: NOW
  }));

test('同一 SQL 按不同模式先后取用，每次结果形状都与新 prepare 一致', () => {
  const statementCache = cacheModule();
  const database = memoryDatabase();
  try {
    statementCache.attachRuntimeStatementCache(database);
    const sql = 'SELECT id, n FROM t ORDER BY id';
    const objects = statementCache.prepareCached(database, sql).all();
    assert.deepEqual(objects[0], { id: 'row-1', n: 1n }, 'defaults follow the connection: object rows with BigInt');

    assert.deepEqual(statementCache.prepareCached(database, sql, { rows: 'pluck' }).all(), ['row-1', 'row-2', 'row-3']);
    assert.deepEqual(statementCache.prepareCached(database, sql).get(), { id: 'row-1', n: 1n }, 'pluck never leaks into the object statement');
    assert.deepEqual(statementCache.prepareCached(database, sql, { rows: 'raw' }).get(), ['row-1', 1n]);
    assert.deepEqual(statementCache.prepareCached(database, sql, { rows: 'expand' }).get(), { t: { id: 'row-1', n: 1n } });
    assert.deepEqual(statementCache.prepareCached(database, sql, { safeIntegers: false }).get(), { id: 'row-1', n: 1 });
    assert.equal(typeof statementCache.prepareCached(database, sql).get().n, 'bigint', 'number mode never leaks into the BigInt statement');
    assert.deepEqual(statementCache.prepareCached(database, sql, { rows: 'pluck', safeIntegers: false }).all(), ['row-1', 'row-2', 'row-3']);

    // Holding a statement while another caller takes the same SQL in another mode keeps both shapes.
    const heldPluck = statementCache.prepareCached(database, sql, { rows: 'pluck' });
    const heldNumbers = statementCache.prepareCached(database, sql, { safeIntegers: false });
    const heldObjects = statementCache.prepareCached(database, sql);
    assert.notEqual(heldPluck, heldObjects, 'each mode has its own statement');
    assert.deepEqual(heldPluck.all(), ['row-1', 'row-2', 'row-3']);
    assert.deepEqual(heldNumbers.get(), { id: 'row-1', n: 1 });
    assert.deepEqual(heldObjects.get(), { id: 'row-1', n: 1n });

    // A caller that changes the mode of a returned statement cannot change what the next caller sees.
    statementCache.prepareCached(database, sql).raw(true).safeIntegers(false);
    assert.deepEqual(statementCache.prepareCached(database, sql).get(), { id: 'row-1', n: 1n });
    statementCache.prepareCached(database, sql, { rows: 'pluck' }).pluck(false);
    assert.deepEqual(statementCache.prepareCached(database, sql, { rows: 'pluck' }).get(), 'row-1');

    // Statements without rows reject row shapes exactly as a fresh prepare does.
    assert.throws(() => statementCache.prepareCached(database, "UPDATE t SET n = n WHERE id = 'none'", { rows: 'pluck' }), TypeError);
    const run = statementCache.prepareCached(database, 'INSERT INTO t (id, n) VALUES (?, ?)').run('row-4', 4);
    assert.equal(typeof run.lastInsertRowid, 'bigint', 'run() results keep the connection integer mode');
  } finally {
    database.close();
  }

  const numbers = memoryDatabase({ safeIntegers: false });
  try {
    statementCache.attachRuntimeStatementCache(numbers);
    assert.deepEqual(statementCache.prepareCached(numbers, 'SELECT n FROM t WHERE id = ?').get('row-2'), { n: 2 },
      'a connection that defaults to numbers keeps numbers on reuse');
    assert.deepEqual(statementCache.prepareCached(numbers, 'SELECT n FROM t WHERE id = ?').get('row-3'), { n: 3 });
  } finally {
    numbers.close();
  }
});

test('迭代中重入同一 SQL 使用私有语句，不报 statement busy，也不进缓存', () => {
  const statementCache = cacheModule();
  const database = memoryDatabase();
  try {
    const cache = statementCache.attachRuntimeStatementCache(database);
    const sql = 'SELECT id, n FROM t ORDER BY id';
    const outer = statementCache.prepareCached(database, sql);
    const seen = [];
    for (const row of outer.iterate()) {
      assert.equal(outer.busy, true);
      const inner = statementCache.prepareCached(database, sql);
      assert.notEqual(inner, outer, 'the iterating statement is never handed out again');
      assert.equal(inner.all().length, 3);
      for (const nested of statementCache.prepareCached(database, sql).iterate()) seen.push(`${row.id}/${nested.id}`);
    }
    assert.equal(seen.length, 9);
    const after = cache.inspect();
    assert.equal(after.entries, 1, 'private statements for re-entry are not cached');
    assert.equal(after.busyBypasses, 6);
    assert.equal(statementCache.prepareCached(database, sql), outer, 'the cached statement is reused once iteration ends');

    // An iterator abandoned early is released by return(); the cached statement becomes usable again.
    const iterator = statementCache.prepareCached(database, sql).iterate();
    iterator.next();
    assert.notEqual(statementCache.prepareCached(database, sql), outer);
    iterator.return();
    assert.equal(statementCache.prepareCached(database, sql), outer);
  } finally {
    database.close();
  }
});

test('LRU 上限生效，占位符个数可变的 SQL 不进缓存', () => {
  const statementCache = cacheModule();
  assert.equal(statementCache.RUNTIME_STATEMENT_CACHE_MAX_ENTRIES, 256);
  const database = memoryDatabase();
  try {
    const cache = statementCache.attachRuntimeStatementCache(database, 4);
    const sql = (index) => `SELECT ${index} AS v, n FROM t WHERE id = ?`;
    const first = statementCache.prepareCached(database, sql(0));
    for (let index = 1; index <= 3; index += 1) statementCache.prepareCached(database, sql(index));
    assert.equal(statementCache.prepareCached(database, sql(0)), first, 'a recently used entry is kept');
    for (let index = 4; index <= 9; index += 1) statementCache.prepareCached(database, sql(index));
    let counters = cache.inspect();
    assert.equal(counters.entries, 4);
    assert.equal(counters.maxEntries, 4);
    assert.equal(counters.evictions, 6);
    assert.notEqual(statementCache.prepareCached(database, sql(0)), first, 'an evicted entry is prepared again');
    assert.deepEqual(first.get('row-1'), { v: 0n, n: 1n }, 'a caller holding an evicted statement can still use it');

    const before = cache.inspect();
    for (let size = 1; size <= 40; size += 1) {
      const ids = Array.from({ length: size }, (_value, index) => `row-${index + 1}`);
      statementCache.prepareUncached(database, `SELECT id FROM t WHERE id IN (${ids.map(() => '?').join(',')})`, { rows: 'pluck' }).all(...ids);
    }
    counters = cache.inspect();
    assert.equal(counters.entries, 4);
    assert.equal(counters.evictions, before.evictions, 'uncached statements never evict fixed SQL');
    assert.equal(counters.uncached - before.uncached, 40);
    assert.equal(counters.prepares - before.prepares, 40);
  } finally {
    database.close();
  }
});

test('按 id 列表读回：单个 id 与满块复用语句，只有末尾不满的块临时 prepare', async () => {
  // A commit reads back each AnswerSubmission it wrote by id; a large transaction must not make a
  // native prepare per row. Rows are inserted directly (no foreign keys) to reach this read alone.
  const statementCache = cacheModule();
  const projection = require(path.join(compiledRoot, 'backend/reliableKernel/clientProjection.js'));
  await withRuntime(async ({ open, binding }) => {
    await (await open()).close();
    const raw = new Database(binding.paths.databasePath);
    try {
      raw.defaultSafeIntegers(true);
      raw.pragma('foreign_keys = OFF');
      const insertBridge = raw.prepare("INSERT INTO answer_bridge (id, child_execution_id, current_submission_id, status, created_at, updated_at) VALUES (?, ?, NULL, 'open', ?, ?)");
      const insertSubmission = raw.prepare('INSERT INTO answer_submission (id, answer_bridge_id, submission_seq, turn_id, interrupted, created_at) VALUES (?, ?, 1, ?, 0, ?)');
      raw.transaction(() => {
        for (let index = 0; index < 1300; index += 1) {
          insertBridge.run(`bridge-${index}`, `child-${index}`, NOW, NOW);
          insertSubmission.run(`submission-${index}`, `bridge-${index}`, `turn-${index}`, NOW);
        }
      })();
      const cache = statementCache.attachRuntimeStatementCache(raw);
      try {
        const readOneByOne = (from, to) => {
          for (let index = from; index < to; index += 1) {
            const record = projection.projectAnswerSubmissionRecord(raw, `submission-${index}`);
            assert.equal(record.id, `submission-${index}`);
            assert.ok(record.outcome, 'the derived outcome is still projected');
          }
        };
        readOneByOne(0, 10);
        const warm = cache.inspect();
        readOneByOne(10, 510);
        const single = cache.inspect();
        assert.equal(single.prepares - warm.prepares, 0, '500 more single-id read-backs prepare nothing new');
        assert.equal(single.uncached - warm.uncached, 0);
        assert.ok(single.hits - warm.hits >= 1000, 'each read-back reuses its submission and bridge statements');

        const readTogether = (count) => {
          const ids = Array.from({ length: count }, (_value, index) => `submission-${index}`);
          const records = projection.projectAnswerSubmissionRecords(raw, ids);
          assert.deepEqual(records.map((record) => record.id).sort(), [...ids].sort());
        };
        readTogether(900);
        const afterFirstList = cache.inspect();
        // 900 ids: two full chunks of 400 and one of 100, for submissions and again for bridges.
        readTogether(900);
        const afterSecondList = cache.inspect();
        assert.equal(afterSecondList.prepares - afterFirstList.prepares, 2, 'only the two trailing partial chunks are prepared again');
        assert.equal(afterSecondList.uncached - afterFirstList.uncached, 2, 'partial chunks never enter the cache');
        assert.equal(afterSecondList.hits - afterFirstList.hits, 4, 'every full chunk reuses one statement');
        // 1300 ids: one more full chunk per query, still no more prepares.
        readTogether(1300);
        const afterLongerList = cache.inspect();
        assert.equal(afterLongerList.prepares - afterSecondList.prepares, 2);
        assert.equal(afterLongerList.hits - afterSecondList.hits, 6);
      } finally {
        statementCache.detachRuntimeStatementCache(raw);
      }
    } finally {
      raw.close();
    }
  });
});

test('连接关闭或 schema 变化后不复用旧语句，也不跨连接复用', async () => {
  const statementCache = cacheModule();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-statement-cache-unit-'));
  const file = path.join(directory, 'cache.sqlite');
  let first;
  let second;
  let other;
  try {
    first = new Database(file);
    first.pragma('journal_mode = WAL');
    first.defaultSafeIntegers(true);
    first.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL); INSERT INTO t VALUES ('row-1', 1)");
    const firstCache = statementCache.attachRuntimeStatementCache(first);
    assert.throws(() => statementCache.attachRuntimeStatementCache(first), /already attached/);
    const sql = 'SELECT n FROM t WHERE id = ?';
    const old = statementCache.prepareCached(first, sql);

    second = new Database(file);
    second.defaultSafeIntegers(true);
    const secondCache = statementCache.attachRuntimeStatementCache(second);
    const sibling = statementCache.prepareCached(second, sql);
    assert.notEqual(sibling, old, 'two connections never share a statement');
    assert.equal(sibling.database, second);

    // Another connection changes the main schema: the next revalidation drops every entry.
    other = new Database(file);
    other.exec('CREATE TABLE schema_probe (x); DROP TABLE schema_probe;');
    secondCache.revalidateSchema();
    assert.equal(secondCache.inspect().invalidations, 1);
    assert.equal(secondCache.inspect().entries, 0);
    const recompiled = statementCache.prepareCached(second, sql);
    assert.notEqual(recompiled, sibling);
    assert.deepEqual(recompiled.get('row-1'), { n: 1n });
    secondCache.revalidateSchema();
    assert.equal(secondCache.inspect().invalidations, 1, 'an unchanged schema keeps the cache');

    statementCache.detachRuntimeStatementCache(first);
    first.close();
    assert.throws(() => firstCache.prepare(sql), /closed/);
    assert.throws(() => statementCache.prepareCached(first, sql), /not open/);

    first = new Database(file);
    first.defaultSafeIntegers(true);
    statementCache.attachRuntimeStatementCache(first);
    const reopened = statementCache.prepareCached(first, sql);
    assert.notEqual(reopened, old, 'a reopened connection starts with an empty cache');
    assert.equal(reopened.database, first);
    assert.deepEqual(reopened.get('row-1'), { n: 1n });
  } finally {
    for (const database of [first, second, other]) if (database?.open) database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('worker 大批插入不逐行 prepare；读回、断言与再次事务都复用语句', async () => {
  await withRuntime(async ({ open }) => {
    const database = await open();
    const initial = (await database.inspect()).statementCache;
    assert.equal(initial.writer.maxEntries, 256);
    assert.equal(initial.reader.maxEntries, 256);

    const first = await database.transaction([
      ...receipts('first', 2000),
      ...conversations('first', 300),
      ...Array.from({ length: 300 }, (_value, index) => kernel.DOMAIN_REPOSITORIES.domain('Conversation')
        .assert(`first-conversation-${index}`, { status: 'active' }))
    ]);
    assert.equal(first.changes.length, 300, 'every client-visible insert is read back');
    const afterFirst = (await database.inspect()).statementCache.writer;
    const firstPrepares = afterFirst.prepares - initial.writer.prepares;
    assert.ok(firstPrepares > 0 && firstPrepares <= 20, `2600 steps used ${firstPrepares} native prepares`);
    assert.ok(afterFirst.hits - initial.writer.hits >= 2500, 'repeated steps reuse their statements');
    assert.ok(afterFirst.entries <= afterFirst.maxEntries);

    await database.transaction([...receipts('second', 500), ...conversations('second', 50)]);
    const afterSecond = (await database.inspect()).statementCache.writer;
    assert.equal(afterSecond.prepares, afterFirst.prepares, 'the same step shapes prepare nothing new');

    // BigInt columns keep their type through reused reader statements.
    const read = async () => (await database.snapshot([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').get('first-conversation-7'),
      kernel.DOMAIN_REPOSITORIES.domain('CommandReceipt').list({ where: { source_kind: 'statement-cache' }, limit: 3 })
    ])).snapshot;
    const cold = await read();
    const warm = await read();
    assert.deepEqual(warm, cold);
    assert.equal(warm[0].title, '会话 7');
    assert.equal(warm[1].length, 3);
    const reader = (await database.inspect()).statementCache.reader;
    assert.ok(reader.hits >= 2, 'the second snapshot reuses the reader statements');
  });
});

test('worker 读连接 LRU 有上限；关闭重开后缓存从空开始，schema 被改后整体作废', async () => {
  await withRuntime(async ({ open, binding }) => {
    let database = await open();
    const repositories = kernel.DOMAIN_REPOSITORIES.all();
    assert.ok(repositories.length * 3 > 256, 'the reads below need more distinct SQL than the LRU holds');
    for (const repository of repositories) {
      await database.snapshot([
        repository.get('statement-cache-missing'),
        repository.list({ limit: 1 }),
        repository.list({ limit: 1, orderBy: { column: 'id', direction: 'desc' } })
      ]);
    }
    const bounded = (await database.inspect()).statementCache.reader;
    assert.equal(bounded.entries, 256);
    assert.ok(bounded.evictions >= repositories.length * 3 - 256);

    await database.transaction([...receipts('before-close', 20), ...conversations('before-close', 5)]);
    const beforeClose = await database.inspect();
    assert.ok(beforeClose.statementCache.writer.entries > 0);
    await database.close();

    database = await open();
    const reopened = await database.inspect();
    assert.notEqual(reopened.workerThreadId, beforeClose.workerThreadId);
    for (const side of ['writer', 'reader']) {
      assert.equal(reopened.statementCache[side].entries, 0, `${side} starts empty after reopening`);
      assert.equal(reopened.statementCache[side].hits, 0);
      assert.equal(reopened.statementCache[side].prepares, 0);
    }
    await database.transaction([...receipts('after-reopen', 20), ...conversations('after-reopen', 5)]);
    const warmed = (await database.inspect()).statementCache.writer;
    assert.ok(warmed.misses > 0, 'the reopened worker prepares on its own connection');

    const external = new Database(binding.paths.databasePath);
    try {
      external.exec('CREATE TABLE statement_cache_schema_probe (x); DROP TABLE statement_cache_schema_probe;');
    } finally {
      external.close();
    }
    const invalidated = (await database.inspect()).statementCache;
    assert.equal(invalidated.writer.invalidations, 1);
    assert.equal(invalidated.writer.entries, 0);
    assert.equal(invalidated.reader.invalidations, 1);
    await database.transaction([...receipts('after-schema', 20), ...conversations('after-schema', 5)]);
    const recompiled = (await database.inspect()).statementCache.writer;
    assert.ok(recompiled.misses > warmed.misses, 'statements are prepared again after the schema moved');
    const rows = (await database.snapshot([kernel.DOMAIN_REPOSITORIES.domain('Conversation').get('after-schema-conversation-4')])).snapshot;
    assert.equal(rows[0].id, 'after-schema-conversation-4');
  });
});
