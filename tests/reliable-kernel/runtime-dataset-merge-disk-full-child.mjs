// A large-merge session on a disk that is really full (runtime-dataset-merge-streamed-review.test.mjs):
// run inside `unshare -Urm` with a small tmpfs mounted at <directory>, which holds the configuration
// root; private copies go to TMPDIR, outside it.   <directory>
// Every free-space check is told there is plenty (the tmpfs is smaller than their 64 MiB margin; the
// checks have tests of their own), so what is exercised is the full disk itself: two sources are
// prepared, the tmpfs is filled up to a little room, and the first source's transaction meets it in
// SQLite (SQLITE_FULL from the target's WAL). After the room is given back a second preparation and
// session merge both. Prints what it saw as JSON.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createConfigurationRoot, kernel, kernelFile, ledgerEntries, readAll, readLedgerRecord, seedRichSource
} from './fixtures/runtime-merge-fixture.mjs';

const { prepareLargeMergeSources, runLargeMergeSession } = kernelFile('runtimeDataSetStreamedMerge.js');
const { withRuntimeDataRootAdmission, withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');

const plenty = async () => Number.MAX_SAFE_INTEGER;
const OPTIONS = { sizeLimits: { transactionRows: 50 }, chunkRows: 7, freeSpace: plenty };
/** Room left on the tmpfs for the session's own small files (records, the private instance's), not its WAL. */
const ROOM_BYTES = 160 * 1024;
const [directory] = process.argv.slice(2);
const fixture = await createConfigurationRoot({ tmp: directory, beta: true });
await seedRichSource(fixture.alpha, 'alpha', 4);
await seedRichSource(fixture.beta, 'beta', 4);

const prepare = async () => {
  const window = await kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `window-${randomUUID()}` });
  try {
    return await prepareLargeMergeSources({ paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, options: OPTIONS });
  } finally { await window.close(); }
};
const session = (preparation) => withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
  () => runLargeMergeSession({ paths: fixture.paths, prepared: preparation })));

const before = readAll(fixture.current);
const preparation = await prepare();
const filler = path.join(directory, 'filler');
const handle = await fs.open(filler, 'w');
const block = Buffer.alloc(64 * 1024, 1);
let filled = 0;
try {
  for (;;) {
    try { filled += (await handle.write(block, 0, block.length)).bytesWritten; } catch (error) {
      if (error.code !== 'ENOSPC') throw error;
      break;
    }
  }
  await handle.truncate(Math.max(0, filled - ROOM_BYTES));
} finally { await handle.close(); }
const full = await session(preparation);
const wal = await fs.stat(`${fixture.current.binding.paths.databasePath}-wal`).then((info) => info.size, () => 0);
await fs.rm(filler);
const after = readAll(fixture.current);
const records = await Promise.all(preparation.sources.map((source) => readLedgerRecord(fixture, source.candidateId)));
const commits = await ledgerEntries(fixture, 'commits');

const again = await session(await prepare());
process.stdout.write(JSON.stringify({
  prepared: preparation.sources.length,
  filled,
  results: full.results.map((result) => ({ state: result.state, code: result.issue?.code, reason: result.reason, message: result.issue?.message })),
  walAfter: wal,
  unchanged: JSON.stringify(after) === JSON.stringify(before),
  records: records.map((record) => record?.state ?? null),
  commits,
  again: again.results.map((result) => result.state)
}));
