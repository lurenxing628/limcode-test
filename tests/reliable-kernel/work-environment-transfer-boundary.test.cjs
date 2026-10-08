const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createWorkEnvironmentRuntimeCapability
} = require('../../dist/extension/backend/capabilities/workEnvironmentTransfer.js');

function localEnvironment(rootPath) {
  return {
    id: 'work-environment:transfer-boundary-test',
    kind: 'localFolder',
    source: 'workspaceFolder',
    name: 'transfer-boundary-test',
    uri: `file://${rootPath}`,
    rootPath,
    displayPath: rootPath,
    index: 0,
    available: true,
    createdAt: 1,
    updatedAt: 1
  };
}

function remoteEnvironment(rootPath) {
  return {
    id: 'work-environment:transfer-boundary-remote-test',
    kind: 'remoteServer',
    source: 'manual',
    name: 'transfer-boundary-remote-test',
    host: 'boundary.test.invalid',
    rootPath,
    displayPath: rootPath,
    index: 0,
    available: true,
    createdAt: 1,
    updatedAt: 1
  };
}

async function makeFixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-transfer-boundary-'));
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await fs.mkdir(path.join(root, 'tree', 'nested'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(root, 'inside.txt'), 'inside-data');
  await fs.writeFile(path.join(root, 'tree', 'top.txt'), 'top-data');
  await fs.writeFile(path.join(root, 'tree', 'nested', 'deep.txt'), 'deep-data');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside-secret');
  return { base, root, outside, environment: localEnvironment(root) };
}

async function trySymlink(target, linkPath, type) {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOSYS')) return false;
    throw error;
  }
}

async function entriesOf(dir) {
  return (await fs.readdir(dir)).sort();
}

function assertFailed(entry) {
  assert.equal(entry.success, false);
  assert.equal(typeof entry.error, 'string');
  assert.ok(entry.error.length > 0);
}

function run(capability, environment, transfers, context = {}) {
  return capability.transferFiles({ transfers }, undefined, {
    activeWorkEnvironment: environment,
    availableWorkEnvironments: [environment],
    ...context
  });
}

function item(fromPath, toPath, extra = {}) {
  return { fromEnvironment: 'current', fromPath, toEnvironment: 'current', toPath, ...extra };
}

test('allowOutsideProjectPaths=false 允许普通根内文件与目录递归传输', async (t) => {
  const { root, environment } = await makeFixture(t);
  const capability = createWorkEnvironmentRuntimeCapability();
  const result = await run(capability, environment, [
    item('inside.txt', 'sub/copy.txt'),
    item('tree', 'out', { type: 'directory' })
  ], { allowOutsideProjectPaths: false });
  assert.equal(result.failCount, 0, JSON.stringify(result.results));
  assert.equal(result.successCount, 2);
  assert.equal(await fs.readFile(path.join(root, 'sub', 'copy.txt'), 'utf8'), 'inside-data');
  assert.equal(await fs.readFile(path.join(root, 'out', 'top.txt'), 'utf8'), 'top-data');
  assert.equal(await fs.readFile(path.join(root, 'out', 'nested', 'deep.txt'), 'utf8'), 'deep-data');
});

test('本地目录传输在写入前拒绝自身、子目录及指向源目录的目标别名', async (t) => {
  const { root, environment } = await makeFixture(t);
  const transfers = [
    item('tree', 'tree', { type: 'directory', overwrite: true }),
    item('tree', 'tree/copy', { type: 'directory' })
  ];
  if (await trySymlink(path.join(root, 'tree'), path.join(root, 'alias-tree'), 'dir')) {
    transfers.push(item('tree', 'alias-tree/copy', { type: 'directory' }));
  }
  const before = await entriesOf(path.join(root, 'tree'));
  const result = await run(createWorkEnvironmentRuntimeCapability(), environment, transfers, {
    allowOutsideProjectPaths: false,
    signal: AbortSignal.timeout(5_000)
  });
  assert.equal(result.failCount, transfers.length);
  for (const entry of result.results) assert.match(entry.error, /自身或其子目录/);
  assert.deepEqual(await entriesOf(path.join(root, 'tree')), before);
  assert.equal(await fs.readFile(path.join(root, 'tree', 'top.txt'), 'utf8'), 'top-data');
});

test('allowOutsideProjectPaths=false 拒绝直接根外绝对路径且不改动任何目录', async (t) => {
  const { root, outside, environment } = await makeFixture(t);
  const rootBefore = await entriesOf(root);
  const outsideBefore = await entriesOf(outside);
  const capability = createWorkEnvironmentRuntimeCapability();
  const result = await run(capability, environment, [
    item(path.join(outside, 'secret.txt'), 'imported.txt'),
    item('inside.txt', path.join(outside, 'blocked.txt'))
  ], { allowOutsideProjectPaths: false });
  assert.equal(result.successCount, 0);
  assert.equal(result.failCount, 2);
  result.results.forEach(assertFailed);
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside-secret');
  assert.deepEqual(await entriesOf(root), rootBefore);
  assert.deepEqual(await entriesOf(outside), outsideBefore);
});

test('allowOutsideProjectPaths=false 拒绝经符号链接读取根外文件', async (t) => {
  const { root, outside, environment } = await makeFixture(t);
  if (!(await trySymlink(outside, path.join(root, 'link'), 'dir'))) {
    t.skip('当前平台无法创建目录符号链接（如 Windows 未授权），按平台模式跳过。');
    return;
  }
  const rootBefore = await entriesOf(root);
  const outsideBefore = await entriesOf(outside);
  const capability = createWorkEnvironmentRuntimeCapability();
  const result = await run(capability, environment, [
    item(path.join('link', 'secret.txt'), 'leaked.txt'),
    item(path.join(root, 'link', 'secret.txt'), 'leaked-abs.txt')
  ], { allowOutsideProjectPaths: false });
  assert.equal(result.successCount, 0);
  assert.equal(result.failCount, 2);
  result.results.forEach(assertFailed);
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside-secret');
  assert.deepEqual(await entriesOf(root), rootBefore);
  assert.deepEqual(await entriesOf(outside), outsideBefore);
});

test('allowOutsideProjectPaths=false 拒绝经符号链接向根外写入且不改动外部数据', async (t) => {
  const { root, outside, environment } = await makeFixture(t);
  if (!(await trySymlink(outside, path.join(root, 'link'), 'dir'))) {
    t.skip('当前平台无法创建目录符号链接（如 Windows 未授权），按平台模式跳过。');
    return;
  }
  const rootBefore = await entriesOf(root);
  const capability = createWorkEnvironmentRuntimeCapability();
  const result = await run(capability, environment, [
    item('inside.txt', path.join('link', 'pwned.txt')),
    item('inside.txt', path.join('link', 'secret.txt'), { overwrite: true })
  ], { allowOutsideProjectPaths: false });
  assert.equal(result.successCount, 0);
  assert.equal(result.failCount, 2);
  result.results.forEach(assertFailed);
  assert.deepEqual(await entriesOf(outside), ['secret.txt']);
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside-secret');
  assert.deepEqual(await entriesOf(root), rootBefore);
});

test('allowOutsideProjectPaths=false 目录传输的源或目标经符号链接指向根外时拒绝', async (t) => {
  const { root, outside, environment } = await makeFixture(t);
  if (!(await trySymlink(outside, path.join(root, 'link'), 'dir'))) {
    t.skip('当前平台无法创建目录符号链接（如 Windows 未授权），按平台模式跳过。');
    return;
  }
  const rootBefore = await entriesOf(root);
  const capability = createWorkEnvironmentRuntimeCapability();
  const result = await run(capability, environment, [
    item('link', 'out'),
    item('tree', path.join('link', 'backup'), { type: 'directory' })
  ], { allowOutsideProjectPaths: false });
  assert.equal(result.successCount, 0);
  assert.equal(result.failCount, 2);
  result.results.forEach(assertFailed);
  assert.deepEqual(await entriesOf(outside), ['secret.txt']);
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside-secret');
  assert.deepEqual(await entriesOf(root), rootBefore);
});

test('allowOutsideProjectPaths=false 覆盖已存在的符号链接目标时拒绝且不改动其指向文件', async (t) => {
  const { root, environment } = await makeFixture(t);
  await fs.writeFile(path.join(root, 'victim.txt'), 'keep-me');
  if (!(await trySymlink(path.join(root, 'victim.txt'), path.join(root, 'alias.txt'), 'file'))) {
    t.skip('当前平台无法创建文件符号链接（如 Windows 未授权），按平台模式跳过。');
    return;
  }
  const rootBefore = await entriesOf(root);
  const capability = createWorkEnvironmentRuntimeCapability();
  const result = await run(capability, environment, [
    item('inside.txt', 'alias.txt', { overwrite: true })
  ], { allowOutsideProjectPaths: false });
  assert.equal(result.successCount, 0);
  assert.equal(result.failCount, 1);
  result.results.forEach(assertFailed);
  assert.equal(await fs.readFile(path.join(root, 'victim.txt'), 'utf8'), 'keep-me');
  assert.ok((await fs.lstat(path.join(root, 'alias.txt'))).isSymbolicLink());
  assert.deepEqual(await entriesOf(root), rootBefore);
});

test('allowOutsideProjectPaths=false 当根目录自身是符号链接时仍以真实根为边界', async (t) => {
  const { base, root } = await makeFixture(t);
  const alias = path.join(base, 'root-alias');
  if (!(await trySymlink(root, alias, 'dir'))) {
    t.skip('当前平台无法创建目录符号链接（如 Windows 未授权），按平台模式跳过。');
    return;
  }
  const baseBefore = await entriesOf(base);
  const aliasEnvironment = localEnvironment(alias);
  const capability = createWorkEnvironmentRuntimeCapability();
  const allowed = await run(capability, aliasEnvironment, [
    item('inside.txt', 'copy.txt'),
    item('tree', 'out', { type: 'directory' })
  ], { allowOutsideProjectPaths: false });
  assert.equal(allowed.failCount, 0, JSON.stringify(allowed.results));
  assert.equal(await fs.readFile(path.join(root, 'copy.txt'), 'utf8'), 'inside-data');
  assert.equal(await fs.readFile(path.join(root, 'out', 'nested', 'deep.txt'), 'utf8'), 'deep-data');
  const rootBefore = await entriesOf(root);
  const rejected = await run(capability, aliasEnvironment, [
    item('inside.txt', path.join('..', 'escape.txt')),
    item(path.join('..', 'outside', 'secret.txt'), 'imported.txt')
  ], { allowOutsideProjectPaths: false });
  assert.equal(rejected.successCount, 0);
  assert.equal(rejected.failCount, 2);
  rejected.results.forEach(assertFailed);
  assert.deepEqual(await entriesOf(base), baseBefore);
  assert.deepEqual(await entriesOf(root), rootBefore);
});

test('allowOutsideProjectPaths 缺省与显式 true 时根外绝对路径传输保持可用', async (t) => {
  const { root, outside, environment } = await makeFixture(t);
  const capability = createWorkEnvironmentRuntimeCapability();
  const implicit = await run(capability, environment, [
    item(path.join(outside, 'secret.txt'), 'imported.txt')
  ]);
  assert.equal(implicit.failCount, 0, JSON.stringify(implicit.results));
  assert.equal(await fs.readFile(path.join(root, 'imported.txt'), 'utf8'), 'outside-secret');
  const explicit = await run(capability, environment, [
    item('inside.txt', path.join(outside, 'exported.txt'))
  ], { allowOutsideProjectPaths: true });
  assert.equal(explicit.failCount, 0, JSON.stringify(explicit.results));
  assert.equal(await fs.readFile(path.join(outside, 'exported.txt'), 'utf8'), 'inside-data');
});

test('allowOutsideProjectPaths 缺省与显式 true 时经符号链接的传输保持可用', async (t) => {
  const { root, outside, environment } = await makeFixture(t);
  if (!(await trySymlink(outside, path.join(root, 'link'), 'dir'))) {
    t.skip('当前平台无法创建目录符号链接（如 Windows 未授权），按平台模式跳过。');
    return;
  }
  const capability = createWorkEnvironmentRuntimeCapability();
  const implicit = await run(capability, environment, [
    item(path.join('link', 'secret.txt'), 'via-link.txt')
  ]);
  assert.equal(implicit.failCount, 0, JSON.stringify(implicit.results));
  assert.equal(await fs.readFile(path.join(root, 'via-link.txt'), 'utf8'), 'outside-secret');
  const explicit = await run(capability, environment, [
    item('inside.txt', path.join('link', 'written.txt'))
  ], { allowOutsideProjectPaths: true });
  assert.equal(explicit.failCount, 0, JSON.stringify(explicit.results));
  assert.equal(await fs.readFile(path.join(outside, 'written.txt'), 'utf8'), 'inside-data');
});

const posixOnly = { skip: process.platform === 'win32' };

async function makeRemoteFixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-transfer-boundary-remote-'));
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });
  const fakeBin = path.join(base, 'bin');
  await fs.mkdir(fakeBin, { recursive: true });
  // 仅替换 SSH transport：fake ssh 取最后参数（bash -lc '<script>'）在本机 shell 执行真实生成的脚本。
  const fakeSsh = path.join(fakeBin, 'ssh');
  await fs.writeFile(fakeSsh, '#!/bin/sh\nfor last do :; done\nexec sh -c "$last"\n');
  await fs.chmod(fakeSsh, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ''}`;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });
  const root = path.join(base, 'rroot');
  const outside = path.join(base, 'routside');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(root, 'real.txt'), 'remote-inside');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'remote-secret');
  return { base, root, outside, environment: remoteEnvironment(root) };
}

test('远程目录枚举每个隐藏项一次且不包含父目录（真实 bash 脚本）', posixOnly, async (t) => {
  const { root, environment } = await makeRemoteFixture(t);
  const source = path.join(root, 'source');
  await fs.mkdir(path.join(source, '.git', '.config'), { recursive: true });
  const files = { '.x': 'one', '..named': 'two', '.git/.config/item.txt': 'three', 'visible.txt': 'four' };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(source, name), body);
  const result = await run(createWorkEnvironmentRuntimeCapability(), environment, [
    item('source', 'destination', { type: 'directory' })
  ], { allowOutsideProjectPaths: false });
  assert.equal(result.failCount, 0, JSON.stringify(result.results));
  assert.equal(result.results[0].files, Object.keys(files).length);
  for (const [name, body] of Object.entries(files)) {
    assert.equal(await fs.readFile(path.join(root, 'destination', name), 'utf8'), body);
  }
  assert.deepEqual(await entriesOf(path.join(root, 'destination')), ['..named', '.git', '.x', 'visible.txt']);
});

test('远程同端点目录拒绝自身及经真实路径别名进入源子目录', posixOnly, async (t) => {
  const { root, environment } = await makeRemoteFixture(t);
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await fs.symlink(source, path.join(root, 'source-alias'), 'dir');
  // Different catalog IDs and roots do not make the same SSH target a different filesystem.
  const target = { ...environment, id: 'same-ssh-target-alias', rootPath: path.join(root, 'source-alias') };
  const result = await run(createWorkEnvironmentRuntimeCapability(), environment, [
    item('source', 'source', { type: 'directory', overwrite: true }),
    item('source', 'source/copy', { type: 'directory' }),
    { ...item('source', 'copy', { type: 'directory' }), toEnvironment: target.id }
  ], { availableWorkEnvironments: [environment, target], signal: AbortSignal.timeout(30_000) });
  assert.equal(result.failCount, 3, JSON.stringify(result.results));
  for (const entry of result.results) assert.match(entry.error, /自身或其子目录/);
  assert.deepEqual(await entriesOf(source), []);
});

test('远程目录符号链接回到当前递归祖先时在创建该目标目录前拒绝', posixOnly, async (t) => {
  const { root, environment } = await makeRemoteFixture(t);
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await fs.symlink(source, path.join(source, 'loop'), 'dir');
  const result = await run(createWorkEnvironmentRuntimeCapability(), environment, [
    item('source', 'destination', { type: 'directory' })
  ], { allowOutsideProjectPaths: false, signal: AbortSignal.timeout(30_000) });
  assert.equal(result.failCount, 1, JSON.stringify(result.results));
  assert.match(result.results[0].error, /符号链接形成循环/);
  assert.deepEqual(await entriesOf(path.join(root, 'destination')), []);
});

test('普通远程目录链接可重复指向同一非祖先目录并遵守根外路径策略', posixOnly, async (t) => {
  const { root, outside, environment } = await makeRemoteFixture(t);
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await fs.symlink(outside, path.join(source, 'first'), 'dir');
  await fs.symlink(outside, path.join(source, 'second'), 'dir');
  const capability = createWorkEnvironmentRuntimeCapability();
  const allowed = await run(capability, environment, [
    item('source', 'destination', { type: 'directory' })
  ], { signal: AbortSignal.timeout(30_000) });
  assert.equal(allowed.failCount, 0, JSON.stringify(allowed.results));
  assert.equal(allowed.results[0].files, 2);
  for (const alias of ['first', 'second']) {
    assert.equal(await fs.readFile(path.join(root, 'destination', alias, 'secret.txt'), 'utf8'), 'remote-secret');
  }
  const refused = await run(capability, environment, [
    item('source', 'restricted', { type: 'directory' })
  ], { allowOutsideProjectPaths: false, signal: AbortSignal.timeout(30_000) });
  assert.equal(refused.failCount, 1, JSON.stringify(refused.results));
  assert.match(refused.results[0].error, /超出当前远程工作环境根目录/);
  assert.deepEqual(await entriesOf(path.join(root, 'restricted')), []);
});

test('不同远程机器上的相同目录路径允许传输', posixOnly, async (t) => {
  const { root, environment } = await makeRemoteFixture(t);
  await fs.mkdir(path.join(root, 'empty'));
  const target = { ...environment, id: 'different-ssh-target', host: 'another.boundary.test.invalid' };
  const result = await run(createWorkEnvironmentRuntimeCapability(), environment, [
    { ...item('empty', 'empty', { type: 'directory' }), toEnvironment: target.id }
  ], { availableWorkEnvironments: [environment, target], signal: AbortSignal.timeout(30_000) });
  assert.equal(result.failCount, 0, JSON.stringify(result.results));
  assert.equal(result.results[0].files, 0);
});

test('远程受限传输在同脚本真实路径守卫下拒绝符号链接逃逸（本机 bash 替代 SSH transport）', posixOnly, async (t) => {
  const { root, outside, environment } = await makeRemoteFixture(t);
  await fs.symlink(outside, path.join(root, 'link'), 'dir');
  const capability = createWorkEnvironmentRuntimeCapability();
  const allowed = await run(capability, environment, [
    item('real.txt', 'copy.txt')
  ], { allowOutsideProjectPaths: false });
  assert.equal(allowed.failCount, 0, JSON.stringify(allowed.results));
  assert.equal(await fs.readFile(path.join(root, 'copy.txt'), 'utf8'), 'remote-inside');
  const rootBefore = await entriesOf(root);
  const rejected = await run(capability, environment, [
    item(path.join('link', 'secret.txt'), 'leaked.txt'),
    item('real.txt', path.join('link', 'pwned.txt'))
  ], { allowOutsideProjectPaths: false });
  assert.equal(rejected.successCount, 0);
  assert.equal(rejected.failCount, 2);
  rejected.results.forEach(assertFailed);
  assert.deepEqual(await entriesOf(outside), ['secret.txt']);
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'remote-secret');
  assert.deepEqual(await entriesOf(root), rootBefore);
  const explicit = await run(capability, environment, [
    item(path.join('link', 'secret.txt'), 'imported.txt')
  ], { allowOutsideProjectPaths: true });
  assert.equal(explicit.failCount, 0, JSON.stringify(explicit.results));
  assert.equal(await fs.readFile(path.join(root, 'imported.txt'), 'utf8'), 'remote-secret');
});

test('远程受限守卫对以换行结尾的真实根名保持字节精确（本机 bash 替代 SSH transport）', posixOnly, async (t) => {
  const { base } = await makeRemoteFixture(t);
  const realRoot = path.join(base, 'realroot\n');
  const sibling = path.join(base, 'realroot');
  await fs.mkdir(realRoot, { recursive: true });
  await fs.mkdir(sibling, { recursive: true });
  await fs.writeFile(path.join(realRoot, 'real.txt'), 'newline-root-data');
  await fs.writeFile(path.join(sibling, 'secret.txt'), 'sibling-secret');
  const logicalRoot = path.join(base, 'logroot');
  await fs.symlink(realRoot, logicalRoot, 'dir');
  await fs.symlink(sibling, path.join(realRoot, 'esc'), 'dir');
  const newlineEnvironment = remoteEnvironment(logicalRoot);
  const capability = createWorkEnvironmentRuntimeCapability();
  const allowed = await run(capability, newlineEnvironment, [
    item('real.txt', 'copy.txt')
  ], { allowOutsideProjectPaths: false });
  assert.equal(allowed.failCount, 0, JSON.stringify(allowed.results));
  assert.equal(await fs.readFile(path.join(realRoot, 'copy.txt'), 'utf8'), 'newline-root-data');
  const rejected = await run(capability, newlineEnvironment, [
    item(path.join('esc', 'secret.txt'), 'leaked.txt'),
    item('real.txt', path.join('esc', 'pwned.txt'))
  ], { allowOutsideProjectPaths: false });
  assert.equal(rejected.successCount, 0);
  assert.equal(rejected.failCount, 2);
  rejected.results.forEach(assertFailed);
  assert.deepEqual(await entriesOf(sibling), ['secret.txt']);
  assert.equal(await fs.readFile(path.join(sibling, 'secret.txt'), 'utf8'), 'sibling-secret');
  assert.deepEqual(await entriesOf(realRoot), ['copy.txt', 'esc', 'real.txt']);
});

test('远程受限守卫拒绝相对符号链接目标残留 .. 的尾段逃逸（本机 bash 替代 SSH transport）', posixOnly, async (t) => {
  const { root, outside, environment } = await makeRemoteFixture(t);
  // 必须保留字面 'sub/../../routside'（path.join 会归并掉 ..），且 sub 不存在才构成尾段逃逸。
  await fs.symlink('sub/../../routside', path.join(root, 'bad'), 'dir');
  const rootBefore = await entriesOf(root);
  const capability = createWorkEnvironmentRuntimeCapability();
  const result = await run(capability, environment, [
    item(path.join('bad', 'secret.txt'), 'leaked.txt'),
    item('real.txt', path.join('bad', 'pwned.txt'))
  ], { allowOutsideProjectPaths: false });
  assert.equal(result.successCount, 0);
  assert.equal(result.failCount, 2);
  result.results.forEach(assertFailed);
  assert.deepEqual(await entriesOf(outside), ['secret.txt']);
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'remote-secret');
  assert.deepEqual(await entriesOf(root), rootBefore);
});
