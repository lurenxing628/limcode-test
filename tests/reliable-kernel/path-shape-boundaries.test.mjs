import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

// 路径形态回归：Windows 盘符根 G:\、UNC、大小写、符号链接/junction 根目录下的合法路径不能被误判越界。
const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
class Uri {
  constructor(value) { this.scheme = 'file'; this.fsPath = path.resolve(value); this.path = this.fsPath; }
  static file(value) { return new Uri(value); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.path}`; }
}
Module._load = function(request, parent, isMain) {
  return request === 'vscode' ? { Uri } : originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const dist = (file) => require(path.join(process.cwd(), 'dist/extension', file));
// Windows 上非管理员建目录符号链接会 EPERM；junction 不需要权限，语义上同样是"根目录的另一种写法"。
const dirLinkType = process.platform === 'win32' ? 'junction' : 'dir';
const { isCanonicalPathInside, isPathBelow, isPathInside, isSamePath } = dist('backend/capabilities/filesystem/pathContainment.js');
const { realPath } = dist('backend/capabilities/filesystem/realPath.js');
const { FileMutationDispatcher } = dist('backend/reliableKernel/fileEffects.js');
const { readFileTool } = dist('backend/world/modules/tools/definitions/readFile/index.js');
const { normalizeDisplayPath } = dist('shared/displayPath.js');
const { VscodeReliableToolHost } = dist('backend/application/reliableKernel/VscodeReliableToolHost.js');

async function temporaryDirectory(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-path-shape-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('路径包含判断接受盘符根、UNC 共享根和 / 下的文件，Windows 不区分大小写', () => {
  const win = path.win32;
  assert.equal(isPathInside('G:\\', 'G:\\a.txt', win), true);
  assert.equal(isPathInside('G:\\', 'G:\\', win), true);
  assert.equal(isPathBelow('G:\\', 'G:\\', win), false);
  assert.equal(isPathInside('\\\\srv\\share\\', '\\\\srv\\share\\dir\\a.txt', win), true);
  assert.equal(isPathInside('/', '/tmp/a.txt', path.posix), true);
  assert.equal(isPathInside('g:\\limcode', 'G:\\LIMCODE\\src\\a.ts', win), true);
  assert.equal(isSamePath('g:\\limcode', 'G:\\Limcode\\', win), true);
  assert.equal(isSamePath('/work/Src', '/work/src', path.posix), false);
  for (const name of ['..env', '...']) {
    assert.equal(isPathInside('G:\\limcode', `G:\\limcode\\${name}`, win), true, name);
    assert.equal(isPathBelow('/work', `/work/${name}/x`, path.posix), true, name);
  }
});

test('路径包含判断拒绝上级目录、同前缀兄弟目录和其他盘', () => {
  const win = path.win32;
  assert.equal(isPathInside('G:\\limcode', 'G:\\', win), false);
  assert.equal(isPathInside('G:\\limcode', 'G:\\limcode\\..', win), false);
  assert.equal(isPathInside('G:\\limcode', 'G:\\limcode2\\a.txt', win), false);
  assert.equal(isPathInside('G:\\', 'H:\\a.txt', win), false);
  assert.equal(isPathInside('\\\\srv\\share\\', '\\\\srv\\other\\a.txt', win), false);
  assert.equal(isPathInside('/work', '/work-2/a', path.posix), false);
  assert.equal(isPathInside('/work', '/', path.posix), false);
});

test('realpath 对 realpath 的边界比较是精确的：接受带分隔符的根，不把大小写或 Unicode 折叠变体当成同一目录', () => {
  const win = path.win32;
  assert.equal(isCanonicalPathInside('G:\\', 'G:\\a.txt', win), true);
  assert.equal(isCanonicalPathInside('\\\\srv\\share\\', '\\\\srv\\share\\a.txt', win), true);
  assert.equal(isCanonicalPathInside('/', '/tmp/a.txt', path.posix), true);
  assert.equal(isCanonicalPathInside('C:\\ws', 'C:\\ws', win), true);
  assert.equal(isCanonicalPathInside('C:\\ws', 'C:\\ws\\..env', win), true);
  assert.equal(isCanonicalPathInside('C:\\ws', 'C:\\WS\\a.txt', win), false);
  assert.equal(isCanonicalPathInside('C:\\Users\\me\\work', 'C:\\Users\\me\\wor\u212A\\secret.txt', win), false);
  assert.equal(isCanonicalPathInside('C:\\ws', 'C:\\ws2\\a.txt', win), false);
});

test('文件写入/删除边界接受根目录本身带分隔符的工作区（盘符根 G:\\ 在 POSIX 上的等价是 /）', async (t) => {
  const directory = await temporaryDirectory(t);
  const target = path.join(directory, 'a.txt');
  await fs.writeFile(target, 'hello');
  const filesystemRoot = path.parse(directory).root;
  const dispatcher = { resolveBoundary: (id) => ({ id, rootPath: filesystemRoot }) };
  for (const targetPath of [path.relative(filesystemRoot, target), target]) {
    const actual = await FileMutationDispatcher.prototype.inspectActual.call(dispatcher, {
      workEnvironmentId: 'root-environment',
      targetPath
    });
    assert.equal(actual.kind, 'known', `${targetPath}: ${actual.error ?? ''}`);
    assert.match(actual.digest, /^[0-9a-f]{64}$/);
  }
});

test('read 保留 UNC 路径开头的两个反斜杠，不把 \\\\server\\share 变成 /server/share', async () => {
  const requested = [];
  const deps = {
    fs: {
      async readFile(filePath) {
        requested.push(filePath);
        return { path: filePath, startLine: 1, endLine: 1, totalLines: 1, content: '1 text' };
      }
    }
  };
  for (const [input, expected] of [
    ['\\\\wsl.localhost\\Ubuntu\\home\\u\\proj\\a.ts', '//wsl.localhost/Ubuntu/home/u/proj/a.ts'],
    ['\\\\srv\\share\\dir\\\\a.ts', '//srv/share/dir/a.ts'],
    ['G:\\limcode\\src\\a.ts', 'G:/limcode/src/a.ts'],
    ['src\\a.ts', 'src/a.ts']
  ]) {
    requested.length = 0;
    const result = await readFileTool.execute({ path: input, mode: 'text' }, deps);
    assert.equal(result.ok, true, String(result.output));
    assert.deepEqual(requested, [expected], input);
  }
});

test('显示路径统一成 /，只有带主机名和共享名的 UNC 开头保留 //', () => {
  assert.equal(normalizeDisplayPath('\\\\srv\\share\\proj\\build'), '//srv/share/proj/build');
  assert.equal(normalizeDisplayPath(' \\\\?\\C:\\x\\y '), '//?/C:/x/y');
  assert.equal(normalizeDisplayPath('\\\\srv'), '/srv');
  assert.equal(normalizeDisplayPath('G:\\\\limcode\\a.ts'), 'G:/limcode/a.ts');
  assert.equal(normalizeDisplayPath('src\\a.ts'), 'src/a.ts');
  assert.equal(normalizeDisplayPath(undefined), '');
});

test('原生 realpath 失败时文件写入/删除边界的调用点也走可移植实现', async (t) => {
  const directory = await temporaryDirectory(t);
  await fs.writeFile(path.join(directory, 'a.txt'), 'hello');
  const promises = require('node:fs').promises;
  const nativeRealpath = promises.realpath;
  promises.realpath = async () => { throw Object.assign(new Error('illegal operation on a directory'), { code: 'EISDIR' }); };
  t.after(() => { promises.realpath = nativeRealpath; });
  const dispatcher = { resolveBoundary: (id) => ({ id, rootPath: directory }) };
  const actual = await FileMutationDispatcher.prototype.inspectActual.call(dispatcher, { workEnvironmentId: 'ram-disk', targetPath: 'a.txt' });
  assert.equal(actual.kind, 'known', actual.error);
  assert.match(actual.digest, /^[0-9a-f]{64}$/);
});

test('原生 realpath 不支持的卷（EISDIR 等）回退到可移植实现，其它错误照常抛出', async (t) => {
  const directory = await temporaryDirectory(t);
  const unsupported = async () => { throw Object.assign(new Error('illegal operation on a directory'), { code: 'EISDIR' }); };
  assert.equal(await realPath(directory, unsupported), directory);
  const missing = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  await assert.rejects(realPath(directory, missing), { code: 'ENOENT' });
});

test('工作区根目录是符号链接时，模型给出的真实绝对路径和命令 cwd 映射回声明的根目录', async (t) => {
  const directory = await temporaryDirectory(t);
  const realRoot = path.join(directory, 'real', 'proj');
  const outside = path.join(directory, 'outside');
  const linkedRoot = path.join(directory, 'linked-proj');
  await fs.mkdir(path.join(realRoot, 'src'), { recursive: true });
  await fs.mkdir(outside);
  await fs.symlink(realRoot, linkedRoot, dirLinkType);
  const environment = { id: 'work-env-linked', available: true, kind: 'localFolder', rootPath: linkedRoot };
  const host = {
    async resolveEnvironments() { return { allowed: [environment], active: environment }; },
    skillDirectoriesFor() { return []; }
  };

  const resolveFile = (input) => VscodeReliableToolHost.prototype.resolveFilePath.call(host, input, {});
  const resolved = await resolveFile(path.join(realRoot, 'src', 'new.ts'));
  assert.equal(resolved.workEnvironmentId, environment.id);
  assert.equal(resolved.targetPath, 'src/new.ts');
  assert.equal(resolved.absolutePath, path.join(linkedRoot, 'src', 'new.ts'));
  await assert.rejects(resolveFile(path.join(outside, 'a.ts')), /绝对路径不属于冻结策略允许的本地工作环境/);

  // 只替换根前缀，不解析目标里的链接：链接本身仍交给规划器的符号链接检查，不能被换成它指向的目录。
  await fs.symlink(path.join(realRoot, 'src'), path.join(realRoot, 'srclink'), dirLinkType);
  await fs.symlink(path.join(realRoot, 'src'), path.join(outside, 'srclink'), dirLinkType);
  assert.equal((await resolveFile(path.join(realRoot, 'srclink'))).targetPath, 'srclink');
  assert.equal((await resolveFile(path.join(realRoot, 'srclink', 'x.ts'))).targetPath, 'srclink/x.ts');
  await assert.rejects(resolveFile(path.join(outside, 'srclink')), /绝对路径不属于冻结策略允许的本地工作环境/);

  const cwd = (value) => VscodeReliableToolHost.prototype.resolveProcessCwd.call(host, { arguments: { cwd: value } }, {});
  assert.equal(await cwd(path.join(realRoot, 'src')), path.join(linkedRoot, 'src'));
  assert.equal(await cwd('src'), path.join(linkedRoot, 'src'));
  await assert.rejects(cwd(outside), /command cwd escapes active work environment/);
});

const remote = dist('backend/capabilities/workEnvironmentProvider.js');
const { createWorkEnvironmentRuntimeCapability } = dist('backend/capabilities/workEnvironmentTransfer.js');
const posixOnly = { skip: process.platform === 'win32' };

function remoteEnvironment(id, fields) {
  return {
    id, kind: 'remoteServer', source: 'manual', name: id, host: `${id}.test.invalid`,
    index: 0, available: true, createdAt: 1, updatedAt: 1, ...fields
  };
}

// fake ssh 只替换传输层：取最后一个参数（bash -lc '<script>'）在本机 shell 真实执行；HOME 指向临时目录。
async function remoteHomeFixture(t, sshPreamble = '', homeSuffix = '') {
  const base = await temporaryDirectory(t);
  const fakeBin = path.join(base, 'bin');
  const home = path.join(base, 'home');
  const sshLog = path.join(base, 'ssh-calls.log');
  await fs.mkdir(fakeBin);
  await fs.mkdir(path.join(home, 'proj', 'src'), { recursive: true });
  await fs.writeFile(path.join(home, 'proj', 'src', 'a.ts'), 'remote-a');
  await fs.writeFile(path.join(home, 'other.txt'), 'outside-root');
  await fs.writeFile(path.join(fakeBin, 'ssh'), `#!/bin/sh\necho call >> '${sshLog}'\n${sshPreamble}for last do :; done\nexec sh -c "$last"\n`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = `${fakeBin}${path.delimiter}${saved.PATH ?? ''}`;
  process.env.HOME = `${home}${homeSuffix}`;
  t.sshCalls = async () => (await fs.readFile(sshLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return home;
}

test('远程路径 ~ 按登录用户家目录展开后再做 .. 归一和根目录判断', () => {
  const environment = remoteEnvironment('remote-tilde-pure', { workdir: '~/proj' });
  const home = '/home/u';
  assert.equal(remote.remoteProjectRootPath(environment, home), '/home/u/proj');
  assert.equal(remote.resolveRemoteCwd(undefined, environment, home), '/home/u/proj');
  assert.equal(remote.resolveRemoteCwd('~', environment, home), '/home/u');
  const restricted = { allowOutsideProjectPaths: false, home };
  assert.equal(remote.resolveRemotePath('src/a.ts', environment, undefined, restricted), '/home/u/proj/src/a.ts');
  assert.equal(remote.resolveRemotePath('~/proj/src/a.ts', environment, undefined, restricted), '/home/u/proj/src/a.ts');
  assert.equal(remote.resolveRemotePath('/home/u/proj/src/a.ts', environment, undefined, restricted), '/home/u/proj/src/a.ts');
  assert.throws(() => remote.resolveRemotePath('~/proj/../../etc/passwd', environment, undefined, restricted), /路径超出当前远程工作环境根目录：\/home\/etc\/passwd/);
  assert.throws(() => remote.resolveRemotePath('~/other.txt', environment, undefined, restricted), /路径超出/);
  assert.equal(remote.resolveRemotePath('~foo/a', remoteEnvironment('remote-tilde-literal', { workdir: '/srv' }), undefined, {}), '/srv/~foo/a');
  assert.throws(() => remote.remoteProjectRootPath(environment), /尚未解析登录用户的家目录/);
});

test('远程 workdir 写成 ~/proj 时读写删、命令 cwd 与传输都落在家目录下（本机 bash 替代 SSH transport）', posixOnly, async (t) => {
  const home = await remoteHomeFixture(t);
  const environment = remoteEnvironment('remote-tilde-e2e', { workdir: '~/proj' });
  const restricted = { allowOutsideProjectPaths: false };
  assert.equal(await remote.remoteHomeFor(environment), home);
  assert.equal(await remote.remoteHomeFor(remoteEnvironment('remote-no-tilde', { workdir: '/srv' }), ['src/a.ts']), undefined);

  assert.equal(await remote.readRemoteServerRawTextFile(environment, 'src/a.ts', undefined, restricted), 'remote-a');
  assert.equal(await remote.readRemoteServerRawTextFile(environment, '~/proj/src/a.ts', undefined, restricted), 'remote-a');
  assert.equal(await remote.readRemoteServerRawTextFile(environment, path.join(home, 'proj', 'src', 'a.ts'), undefined, restricted), 'remote-a');
  await assert.rejects(remote.readRemoteServerRawTextFile(environment, '~/other.txt', undefined, restricted), /路径超出/);

  const pwd = await remote.runRemoteServerCommand(environment, { command: 'pwd -P' });
  assert.equal(pwd.exitCode, 0, pwd.stderr);
  assert.equal(pwd.stdout.trim().split('\n').pop(), await fs.realpath(path.join(home, 'proj')));

  await remote.writeRemoteServerTextFile(environment, '~/proj/new.txt', 'written', restricted);
  assert.equal(await fs.readFile(path.join(home, 'proj', 'new.txt'), 'utf8'), 'written');
  await assert.rejects(remote.deleteRemoteServerPath(environment, '~/proj', restricted), /拒绝删除远程工作环境根目录/);
  assert.deepEqual(await remote.deleteRemoteServerPath(environment, 'new.txt', restricted), { path: path.join(home, 'proj', 'new.txt'), targetType: 'file' });

  const transferred = await createWorkEnvironmentRuntimeCapability().transferFiles({
    transfers: [{ fromEnvironment: 'current', fromPath: '~/proj/src/a.ts', toEnvironment: 'current', toPath: 'copy.ts' }]
  }, undefined, { activeWorkEnvironment: environment, availableWorkEnvironments: [environment], allowOutsideProjectPaths: false });
  assert.equal(transferred.failCount, 0, JSON.stringify(transferred.results));
  assert.equal(await fs.readFile(path.join(home, 'proj', 'copy.ts'), 'utf8'), 'remote-a');
});

test('远程家目录解析忽略登录 shell 打印到 stdout 的横幅', posixOnly, async (t) => {
  const home = await remoteHomeFixture(t, 'echo "Welcome to the test host"\n');
  assert.equal(await remote.remoteHomeFor(remoteEnvironment('remote-tilde-banner', { rootPath: '~' })), home);
});

test('远程根路径或 $HOME 带尾随 / 时，删除保护仍认出项目根、它的上级和家目录（本机 bash 替代 SSH transport）', posixOnly, async (t) => {
  const home = await remoteHomeFixture(t, '', '/');
  const restricted = { allowOutsideProjectPaths: false };
  const trailing = remoteEnvironment('remote-tilde-trailing', { workdir: '~/proj/' });
  assert.equal(await remote.remoteHomeFor(trailing), home);
  for (const target of ['.', './', '~/proj', '~/proj/', path.join(home, 'proj') + '/']) {
    await assert.rejects(remote.deleteRemoteServerPath(trailing, target, restricted), /拒绝删除远程工作环境根目录/, target);
  }
  const open = { allowOutsideProjectPaths: true };
  await assert.rejects(remote.deleteRemoteServerPath(trailing, '~', open), /拒绝删除包含远程工作环境根目录的上级目录/);
  await assert.rejects(remote.deleteRemoteServerPath(remoteEnvironment('remote-tilde-home-root', { workdir: '/srv/other' }), '~/', open), /拒绝删除远程登录用户的家目录/);
  assert.equal(await fs.readFile(path.join(home, 'proj', 'src', 'a.ts'), 'utf8'), 'remote-a');

  const transferred = await createWorkEnvironmentRuntimeCapability().transferFiles({
    transfers: [{ fromEnvironment: 'current', fromPath: 'src/a.ts', toEnvironment: 'current', toPath: '~/proj/copy.ts' }]
  }, undefined, { activeWorkEnvironment: trailing, availableWorkEnvironments: [trailing], allowOutsideProjectPaths: false });
  assert.equal(transferred.failCount, 0, JSON.stringify(transferred.results));
  assert.equal(await fs.readFile(path.join(home, 'proj', 'copy.ts'), 'utf8'), 'remote-a');
});

test('远程家目录每个连接只查询一次，并发调用合并', posixOnly, async (t) => {
  await remoteHomeFixture(t);
  const environment = remoteEnvironment('remote-tilde-cache', { rootPath: '~/proj' });
  const [first, second] = await Promise.all([remote.remoteHomeFor(environment), remote.remoteHomeFor(environment)]);
  assert.equal(first, second);
  assert.equal(await remote.remoteHomeFor(environment, ['~/x']), first);
  assert.equal(await t.sshCalls(), 1);
});

test('远程家目录查询中调用方取消时立即返回', posixOnly, async (t) => {
  await remoteHomeFixture(t, 'sleep 2\n');
  const controller = new AbortController();
  const started = Date.now();
  const pending = remote.remoteHomeFor(remoteEnvironment('remote-tilde-abort', { workdir: '~' }), [], controller.signal);
  setTimeout(() => controller.abort(new Error('caller cancelled')), 50);
  await assert.rejects(pending, /caller cancelled/);
  assert.ok(Date.now() - started < 1500, `取消后仍等待了 ${Date.now() - started}ms`);
});
