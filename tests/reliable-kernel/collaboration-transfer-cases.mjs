import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { createWorkEnvironmentRuntimeCapability } = require(path.join(compiled, 'backend/capabilities/workEnvironmentTransfer.js'));

async function fixture(t, label) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-${label}-`));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root'), outside = path.join(base, 'outside');
  await fs.mkdir(path.join(root, 'tree'), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'inside.txt'), 'inside-data');
  await fs.writeFile(path.join(root, 'tree', 'item.txt'), 'tree-data');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside-secret');
  const environment = { id: 'transfer-root', kind: 'localFolder', source: 'workspaceFolder', name: 'transfer-root', uri: `file://${root}`,
    rootPath: root, displayPath: root, index: 0, available: true, createdAt: 1, updatedAt: 1 };
  const capability = createWorkEnvironmentRuntimeCapability();
  return { base, root, outside, environment,
    run(item, selected = environment) { return capability.transferFiles({ transfers: [{ fromEnvironment: 'current', toEnvironment: 'current', ...item }] }, undefined,
      { activeWorkEnvironment: selected, availableWorkEnvironments: [selected], allowOutsideProjectPaths: false }); } };
}

async function symlink(t, target, name, type) {
  try { await fs.symlink(target, name, type); return true; }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('当前平台未提供创建符号链接的权限'); return false; }
    throw error;
  }
}

export async function localRootTransfer(t) {
  const f = await fixture(t, 'transfer-local-root');
  if (!await symlink(t, f.outside, path.join(f.root, 'external'), 'dir')) return;
  const copied = await f.run({ fromPath: 'inside.txt', toPath: 'copied.txt' });
  assert.equal(copied.successCount, 1, JSON.stringify(copied.results));
  assert.equal(await fs.readFile(path.join(f.root, 'copied.txt'), 'utf8'), 'inside-data');
  const refused = await f.run({ fromPath: 'external/secret.txt', toPath: 'leaked.txt' });
  assert.equal(refused.failCount, 1);
  assert.equal(refused.successCount, 0);
  assert.equal(await fs.readFile(path.join(f.outside, 'secret.txt'), 'utf8'), 'outside-secret');
  await assert.rejects(fs.stat(path.join(f.root, 'leaked.txt')), { code: 'ENOENT' });
}

export async function overwriteSymlinkRefusal(t) {
  const f = await fixture(t, 'transfer-overwrite-link');
  if (!await symlink(t, path.join(f.outside, 'secret.txt'), path.join(f.root, 'alias.txt'), 'file')) return;
  const result = await f.run({ fromPath: 'inside.txt', toPath: 'alias.txt', overwrite: true });
  assert.equal(result.failCount, 1);
  assert.equal(result.successCount, 0);
  assert.equal(await fs.readFile(path.join(f.outside, 'secret.txt'), 'utf8'), 'outside-secret');
  assert.equal((await fs.lstat(path.join(f.root, 'alias.txt'))).isSymbolicLink(), true);
}

export async function directorySelfRefusal(t) {
  const f = await fixture(t, 'transfer-directory-self');
  const result = await f.run({ fromPath: 'tree', toPath: 'tree/copy', type: 'directory' });
  assert.equal(result.failCount, 1);
  assert.match(result.results[0].error, /自身或其子目录/);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'tree')), ['item.txt']);
  assert.equal(await fs.readFile(path.join(f.root, 'tree', 'item.txt'), 'utf8'), 'tree-data');
}

/** SSH alone is substituted; the production-generated remote bash guard executes unmodified. */
export async function remoteBashEscapeRefusal(t) {
  if (process.platform === 'win32') { t.skip('远程 bash transport 场景在 POSIX runner 执行'); return; }
  const f = await fixture(t, 'transfer-remote-escape');
  await fs.symlink('sub/../../outside', path.join(f.root, 'bad'), 'dir');
  const bin = path.join(f.base, 'bin');
  await fs.mkdir(bin);
  const fakeSsh = path.join(bin, 'ssh');
  await fs.writeFile(fakeSsh, '#!/bin/sh\nfor last do :; done\nexec sh -c "$last"\n');
  await fs.chmod(fakeSsh, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
  try {
    const remote = { id: 'transfer-remote', kind: 'remoteServer', source: 'manual', name: 'transfer-remote', host: 'fixture.invalid',
      rootPath: f.root, displayPath: f.root, index: 0, available: true, createdAt: 1, updatedAt: 1 };
    const result = await f.run({ fromPath: 'bad/secret.txt', toPath: 'leaked.txt' }, remote);
    assert.equal(result.failCount, 1, JSON.stringify(result.results));
    assert.equal(result.successCount, 0);
    assert.ok(result.results[0].error);
    assert.equal(await fs.readFile(path.join(f.outside, 'secret.txt'), 'utf8'), 'outside-secret');
    await assert.rejects(fs.stat(path.join(f.root, 'leaked.txt')), { code: 'ENOENT' });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}
