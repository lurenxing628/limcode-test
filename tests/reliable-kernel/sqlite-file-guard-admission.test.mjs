import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const {
  assertNotSqliteDatabaseFile,
  registerInProcessSqliteDatabase,
  sqliteDatabaseFileRefusal
} = require(path.join(compiled, 'backend/capabilities/filesystem/sqliteDatabaseFileGuard.js'));

async function fixture(run) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-sqlite-admission-')));
  const databasePath = path.join(root, 'runtime', 'limcode.sqlite');
  const targetPath = path.join(root, 'workspace', 'ordinary.bin');
  await fs.mkdir(path.dirname(databasePath));
  await fs.mkdir(path.dirname(targetPath));
  const release = registerInProcessSqliteDatabase(databasePath);
  try {
    await run({ databasePath, targetPath });
  } finally {
    release();
    await fs.rm(root, { recursive: true, force: true });
  }
}

for (const code of ['EACCES', 'EIO']) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    test(`SQLite admission refuses an accessible hard link when registered ${suffix || 'database'} stat fails with ${code}`, async () => fixture(async ({ databasePath, targetPath }) => {
      const registeredFile = `${databasePath}${suffix}`;
      await fs.writeFile(databasePath, 'database bytes');
      if (suffix) await fs.writeFile(registeredFile, 'sidecar bytes');
      await fs.link(registeredFile, targetPath);
      await fs.access(targetPath, constants.R_OK | constants.W_OK);
      const target = await fs.stat(targetPath, { bigint: true });
      const registered = await fs.stat(registeredFile, { bigint: true });
      assert.deepEqual([target.dev, target.ino], [registered.dev, registered.ino]);
      assert.ok(await sqliteDatabaseFileRefusal(targetPath), 'the registered hard link is protected before the stat fault');

      const originalStat = fs.stat;
      const fault = Object.assign(new Error(`${code}: injected registered-file stat failure`), {
        code, syscall: 'stat', path: registeredFile
      });
      let injected = 0;
      let reads = 0;
      fs.stat = async (file, ...options) => {
        if (String(file) === registeredFile) {
          injected += 1;
          throw fault;
        }
        return originalStat(file, ...options);
      };
      try {
        await assert.rejects(async () => {
          await assertNotSqliteDatabaseFile(targetPath);
          reads += 1;
          return fs.readFile(targetPath);
        }, (error) => error.code === code || error.cause?.code === code);
        assert.ok(injected > 0, 'the fault must reach the exact registered file');
        assert.equal(reads, 0, 'a failed identity check must not admit an in-process read');
      } finally {
        fs.stat = originalStat;
      }
    }));
  }
}

test('SQLite admission permits an ordinary file when the registered database is absent with ENOENT', async () => fixture(async ({ databasePath, targetPath }) => {
  await fs.writeFile(targetPath, 'ordinary bytes');
  await assert.rejects(fs.stat(databasePath, { bigint: true }), { code: 'ENOENT' });
  await assertNotSqliteDatabaseFile(targetPath);
  assert.equal(await fs.readFile(targetPath, 'utf8'), 'ordinary bytes');
}));

test('SQLite admission permits a missing ordinary target without replacing ENOENT', async () => fixture(async ({ databasePath, targetPath }) => {
  await fs.writeFile(databasePath, 'database bytes');
  assert.equal(await sqliteDatabaseFileRefusal(targetPath), undefined);
  await assertNotSqliteDatabaseFile(targetPath);
  await assert.rejects(fs.readFile(targetPath), { code: 'ENOENT' });
}));

test('SQLite admission still refuses the main-file hard link when its sidecars are absent with ENOENT', async () => fixture(async ({ databasePath, targetPath }) => {
  await fs.writeFile(databasePath, 'database bytes');
  await fs.link(databasePath, targetPath);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    await assert.rejects(fs.stat(`${databasePath}${suffix}`, { bigint: true }), { code: 'ENOENT' });
  }
  await assert.rejects(assertNotSqliteDatabaseFile(targetPath), { code: 'sqlite_database_file_refused' });
}));
