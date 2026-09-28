// A window preparing and running a large-merge session while measuring what it keeps
// (runtime-dataset-merge-streamed-memory.test.mjs). Run with --expose-gc.
//   <configurationRoot> <options JSON>
// Prints, in bytes: the heap the preparation keeps (after gc, against before it), the heap the CAS
// transfer holds near its end (after gc at every 1,000th object, against its first object), the
// resident memory outside the JavaScript heap the online scan adds (diagnostic only: other threads and
// the allocator make it vary by several MB), the heap the streamed transaction holds (after gc every 25
// chunks and after its last one, against right after the committing record), the page cache bound of
// every private source copy's connection right after the scan and after the last chunk (KiB, as
// PRAGMA cache_size gives it), and the session's results.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const { RuntimeDatabase } = kernelFile('runtimeDatabase.js');
const { prepareLargeMergeSources, runLargeMergeSession } = kernelFile('runtimeDataSetStreamedMerge.js');
const { withRuntimeDataRootAdmission, withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');
const { createVscodeRootAuthority, inspectVscodeRuntimeDataSets } = kernelFile('vscodeRootAuthority.js');
const { requireCompleteRuntimeDataSet } = kernelFile('runtimeStorageInspection.js');

if (typeof globalThis.gc !== 'function') throw new Error('Run with --expose-gc.');
// The private source copies' connections of this thread (the kernel's better-sqlite3 is this one).
const Database = require(require.resolve('better-sqlite3', { paths: [path.join(compiled, 'backend/reliableKernel')] }));
const copies = new Set();
const prepareStatement = Database.prototype.prepare;
Database.prototype.prepare = function prepare(...args) {
  if (this.readonly && path.basename(path.dirname(String(this.name))).startsWith('limcode-runtime-history-')) copies.add(this);
  return prepareStatement.apply(this, args);
};
const pageCaches = () => [...copies].filter((database) => database.open)
  .map((database) => [Number(database.pragma('main.cache_size', { simple: true })), Number(database.pragma('temp.cache_size', { simple: true }))]);
const heap = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; };
/** Resident memory outside this thread's JavaScript heap (native allocations such as SQLite page caches). */
const resident = () => {
  globalThis.gc();
  globalThis.gc();
  const usage = process.memoryUsage();
  return usage.rss - usage.heapTotal;
};

const [root, raw] = process.argv.slice(2);
const input = JSON.parse(raw ?? '{}');
const paths = { globalStoragePath: root };
const selected = (await inspectVscodeRuntimeDataSets(paths)).candidates.find((candidate) => candidate.selected);
const authority = createVscodeRootAuthority({ runtimeDataRootPath: selected.runtimeDataRootPath, configurationRootPath: selected.configurationRootPath });

const measured = { links: 0, casHeapGrowth: 0, streamHeapGrowth: 0, chunks: 0, scanPageCaches: [], streamPageCaches: [] };
let casStart;
let scanStart;
let committing;
const options = {
  ...(input.sizeLimits ? { sizeLimits: input.sizeLimits } : {}),
  ...(input.chunkRows ? { chunkRows: input.chunkRows } : {}),
  ...(input.workerResourceLimits ? { workerResourceLimits: input.workerResourceLimits } : {}),
  async linkFile(from, to) {
    measured.links += 1;
    if (measured.links === 1) casStart = heap();
    else if (measured.links % 1_000 === 0) measured.casHeapGrowth = Math.max(measured.casHeapGrowth, heap() - casStart);
    await fs.link(from, to);
  },
  onFaultPoint(point, detail = {}) {
    if (point === 'after-committing') committing = heap();
    if (point === 'after-chunk') {
      measured.chunks += 1;
      if (detail.chunk % 25 === 24) measured.streamHeapGrowth = Math.max(measured.streamHeapGrowth, heap() - committing);
    }
    if (point === 'after-last-chunk') {
      measured.streamHeapGrowth = Math.max(measured.streamHeapGrowth, heap() - committing);
      measured.streamPageCaches = pageCaches();
    }
  }
};
const onProgress = (progress) => {
  if (progress.stage === 'scan' && progress.rows === 0 && scanStart === undefined) scanStart = resident();
  // The stage after the scan: the connection is still open with what its page cache holds.
  if ((progress.stage === 'backup' || progress.stage === 'cas') && scanStart !== undefined && measured.scanResidentGrowth === undefined) {
    measured.scanResidentGrowth = resident() - scanStart;
    measured.scanPageCaches = pageCaches();
  }
};
// The window's own worker (the target's reads during the scan) gets a small young generation too.
const window = await RuntimeDatabase.open(authority, {
  hostBootId: `window-${randomUUID()}`, ...(input.workerResourceLimits ? { resourceLimits: input.workerResourceLimits } : {})
});
let preparation;
try {
  const before = heap();
  preparation = await prepareLargeMergeSources({ paths, target: { configurationRootPath: root, database: window }, options, onProgress });
  measured.preparedHeapGrowth = heap() - before;
} finally {
  await window.close();
}
const targetPaths = (await requireCompleteRuntimeDataSet(selected)).paths;
const session = await withRuntimeDataRootAdmission(root, () => withRuntimeMaintenance(targetPaths,
  () => runLargeMergeSession({ paths, prepared: preparation })));
process.stdout.write(JSON.stringify({
  ...measured,
  prepared: preparation.sources.map((source) => ({ rows: source.rows, databaseBytes: source.databaseBytes, casObjects: source.casObjects })),
  results: session.results.map((result) => ({ state: result.state, code: result.issue?.code, insertedRows: result.result?.insertedRows }))
}));
