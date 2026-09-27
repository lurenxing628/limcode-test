import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  compiled, createConfigurationRoot, kernel, kernelFile, ledgerEntries, readAll, readLedgerRecord, saveState, seedRichSource, sha256, treeSnapshot
} from './fixtures/runtime-merge-fixture.mjs';

const { mergeHistoricalDataSetsOnline, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE } = kernelFile('runtimeDataSetMerge.js');
const { sweepDataRootRelocationLeftovers } = kernelFile('runtimeDataRootRelocation.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIMITS = { sizeLimits: { transactionRows: 50 }, chunkRows: 7 };

test('崩溃注入：会话在 committing 写入后、第 1 块、中间块、最后一块之后、提交前、提交后、merged 写入前、第二份来源开始前被杀，下次启动都能收敛：当前库要么是合并前，要么是这份合并后的参考结果，来源文件不变，没有残留', { timeout: 600_000 }, async (t) => {
  const fixture = await createConfigurationRoot({ beta: true });
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await seedRichSource(fixture.alpha, 'alpha', 4);
  await seedRichSource(fixture.beta, 'beta', 4);
  const initial = await saveState(fixture, fixture.current);
  t.after(() => initial.remove());
  const sources = { alpha: await sourceFiles(fixture.alpha), beta: await sourceFiles(fixture.beta) };
  const nothing = readAll(fixture.current);

  const full = await runChild(fixture, {});
  assert.equal(full.code, 0, full.stderr);
  const order = JSON.parse(full.stdout).prepared;
  const [first, second] = order.map((source) => source.candidateId);
  assert.deepEqual(JSON.parse(full.stdout).results.map((result) => result.state), ['merged', 'merged']);
  const both = readAll(fixture.current);
  await initial.restore();
  const firstRun = await runChild(fixture, { candidateIds: [first] });
  assert.equal(firstRun.code, 0, firstRun.stderr);
  const firstOnly = readAll(fixture.current);
  await initial.restore();
  const middle = Math.floor(order[0].rows / LIMITS.chunkRows / 2);
  assert.ok(middle > 1, '来源跨越很多块');

  const cases = [
    ['committing 写入后', { point: 'after-committing', candidateId: first }, nothing],
    ['第 1 块之后', { point: 'after-chunk', candidateId: first, chunk: 0 }, nothing],
    ['中间块之后', { point: 'after-chunk', candidateId: first, chunk: middle }, nothing],
    ['最后一块之后', { point: 'after-last-chunk', candidateId: first }, nothing],
    ['提交前（证据已写全）', { point: 'before-commit', candidateId: first }, nothing],
    ['提交后、收回预写日志前', { point: 'after-commit', candidateId: first }, firstOnly],
    ['merged 写入前', { point: 'before-merged-record', candidateId: first }, firstOnly],
    ['第二份来源开始前', { point: 'before-source', index: 1 }, firstOnly]
  ];
  for (const [name, fault, expected] of cases) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-large-merge-child-tmp-'));
    try {
      const killed = await runChild(fixture, { fault }, temporary);
      assert.equal(killed.signal, 'SIGKILL', `${name}：子进程在故障点被杀\n${killed.stderr}`);
      if (fault.point === 'after-commit' || fault.point === 'before-merged-record') {
        const wal = await fs.stat(`${fixture.current.binding.paths.databasePath}-wal`).then((stat) => stat.size, () => 0);
        if (fault.point === 'after-commit') assert.ok(wal > 0, `${name}：提交在预写日志里，还没收回`);
        else assert.equal(wal, 0, `${name}：写 merged 之前预写日志已经 TRUNCATE`);
      }
      // The next startup: leftovers of the dead process are swept, the ledger converges by measurement.
      await withTemporaryDirectory(temporary, () => sweepDataRootRelocationLeftovers(fixture.root));
      assert.deepEqual((await fs.readdir(temporary)).filter((entry) => entry.startsWith('limcode-')), [], `${name}：私有快照没有残留`);
      const converged = await mergeOnline(fixture, { sizeLimits: LIMITS.sizeLimits });
      assert.deepEqual(converged.failures, [], name);
      const rows = readAll(fixture.current);
      assert.deepEqual(rows, expected, `${name}：当前库${expected === nothing ? '等于合并前' : '等于这份合并后的参考结果'}`);
      const firstRecord = await readLedgerRecord(fixture, first);
      if (expected === nothing) {
        assert.equal(firstRecord, undefined, `${name}：撤掉 committing，放回原记录（没有）`);
        assert.ok(converged.deferred.some((issue) => issue.candidateId === first && issue.code === RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE), `${name}：仍等待大库会话`);
      } else {
        assert.equal(firstRecord?.state, 'merged', `${name}：按实测记为已合并`);
        assert.equal(firstRecord.mergedInto?.[0]?.conversationIds.length, 4, `${name}：插入的对话记入账本`);
      }
      assert.equal(await readLedgerRecord(fixture, second), undefined, `${name}：第二份没有记录`);
      assert.deepEqual(await ledgerEntries(fixture, 'commits'), [], `${name}：没有残留的提交凭据`);
      assert.deepEqual(await ledgerEntries(fixture, 'preparing'), [], `${name}：已死进程的准备记录被清理`);
      assert.deepEqual({ alpha: await sourceFiles(fixture.alpha), beta: await sourceFiles(fixture.beta) }, sources, `${name}：来源文件不变`);
      if (name === '中间块之后') {
        // And the next session completes it.
        const again = await runChild(fixture, {});
        assert.equal(again.code, 0, again.stderr);
        assert.deepEqual(readAll(fixture.current), both, '之后的会话合并完两份');
      }
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
      await initial.restore();
    }
  }
});

async function mergeOnline(fixture, options) {
  const database = await kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `window-${randomUUID()}` });
  try {
    return await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database }, options);
  } finally { await database.close(); }
}

/** The source's SQLite files and CAS objects, byte for byte. */
async function sourceFiles(dataSet) {
  const database = dataSet.binding.paths.databasePath;
  const files = {};
  for (const suffix of ['', '-wal']) {
    files[suffix || 'db'] = await fs.readFile(`${database}${suffix}`).then(sha256, () => 'absent');
  }
  return { files, cas: await treeSnapshot(dataSet.binding.paths.casRootPath) };
}

async function withTemporaryDirectory(directory, run) {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  try { return await run(); } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}

function runChild(fixture, input, temporary) {
  const script = path.join(HERE, 'runtime-dataset-merge-streamed-child.mjs');
  return new Promise((resolve) => {
    execFile(process.execPath, [script, fixture.root, JSON.stringify({ ...LIMITS, ...input })], {
      env: { ...process.env, LIMCODE_TEST_EXTENSION_ROOT: compiled, ...(temporary ? { TMPDIR: temporary } : {}) },
      maxBuffer: 16 * 1024 * 1024
    }, (error, stdout, stderr) => resolve({ signal: error?.signal ?? null, code: error ? error.code ?? null : 0, stdout, stderr }));
  });
}
