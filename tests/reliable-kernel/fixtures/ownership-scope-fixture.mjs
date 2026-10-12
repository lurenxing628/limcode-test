import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const kernel = require(path.resolve('dist/extension/backend/reliableKernel/index.js'));
const { inProcessSqliteDatabasePaths } = require(path.resolve('dist/extension/backend/capabilities/filesystem/sqliteDatabaseFileGuard.js'));
let seed;

async function emptySeed() {
  if (seed) return seed;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-owner-seed-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'control', 'runtime'));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  const controlRoot = path.dirname(binding.paths.dataRootPath);
  const snapshot = path.join(directory, 'empty-control');
  await fs.cp(controlRoot, snapshot, { recursive: true });
  seed = { directory, authority, binding, controlRoot, snapshot, used: false };
  return seed;
}

// Each scene starts from the same offline empty data set, including its configuration,
// CAS, spool and owner files. Hosts and their real worker connections remain scene-local;
// the schema/manifest initializer only runs once.
export async function createOwnershipScope(label) {
  assert.deepEqual(inProcessSqliteDatabasePaths(), [], 'previous ownership Host must close its worker before the next scene');
  const h = await emptySeed();
  if (h.used) {
    await kernel.assertRuntimeHostsOffline(h.binding.paths);
    await fs.rm(h.controlRoot, { recursive: true, force: true });
    await fs.cp(h.snapshot, h.controlRoot, { recursive: true });
  }
  h.used = true;
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-owner-scene-${label}-`));
  return { outer, authority: h.authority, binding: h.binding, dataRoot: h.binding.paths.dataRootPath,
    databasePath: h.binding.paths.databasePath };
}

after(async () => { if (seed) await fs.rm(seed.directory, { recursive: true, force: true }); });
