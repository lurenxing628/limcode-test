import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { authorityAt, compiled, extensionRoot, installVscode, saveGlobal, seedProvider, temporaryRoot, Uri } from './configuration-smoke-fixture.mjs';

const host = installVscode();
after(() => host.dispose());
const folder = (rootPath, name, index) => ({ uri: Uri.file(rootPath).toString(), rootPath, name, index });
const local = (id, rootPath) => ({ id, kind: 'localFolder', source: 'workspaceFolder', name: id, rootPath, available: true, createdAt: 1, updatedAt: 1 });

test('绑定B的真实authority冻结文件与命令根，长脚本非零退出持久收尾且移除B后拒绝', async t => {
  const root = await temporaryRoot(t, 'environment-smoke'), a = path.join(root, 'A'), b = path.join(root, 'B');
  await fs.mkdir(a); await fs.mkdir(b); await fs.writeFile(path.join(b, 'file.txt'), 'B');
  const { authority } = authorityAt(path.join(root, 'settings'));
  await seedProvider(authority);
  const folders = [folder(a, 'A', 0), folder(b, 'B', 1)];
  const { workEnvironmentIdFromUri } = compiled('shared/workEnvironmentCatalog.js');
  const aId = workEnvironmentIdFromUri(folders[0].uri), bId = workEnvironmentIdFromUri(folders[1].uri);
  await authority.synchronizeWorkspaceFolders(folders);
  await authority.mutations.setWorkEnvironmentPolicy({ scopeKind: 'global', enabled: false, allowedWorkEnvironmentIds: [aId, bId], defaultWorkEnvironmentId: aId });
  const frozen = JSON.parse((await authority.compile({ conversationId: 'bound-b', turnId: 'bound-turn', executorAgentId: 'main', intentKind: 'input',
    workspace: { uri: folders[1].uri } })).authoritySnapshot.content).workEnvironmentPolicy;
  const { resolveFrozenWorkEnvironmentBoundary } = compiled('backend/reliableKernel/workEnvironmentBoundary.js');
  const { resolvePathInsideBoundary } = compiled('backend/reliableKernel/localFileToolPlanner.js');
  const selected = resolveFrozenWorkEnvironmentBoundary(frozen, await authority.workEnvironments()).active;
  assert.equal(selected.id, bId);
  assert.equal((await resolvePathInsideBoundary(selected.id, selected.rootPath, 'file.txt')).absolutePath, path.join(b, 'file.txt'));
  const { VscodeReliableToolHost } = compiled('backend/application/reliableKernel/VscodeReliableToolHost.js');
  const toolHost = { async resolveEnvironments() { return { active: selected, allowed: [local(aId, a), selected] }; }, skillDirectoriesFor() { return []; } };
  const cwd = await VscodeReliableToolHost.prototype.resolveProcessCwd.call(toolHost, { arguments: {} }, {});
  assert.equal(cwd, b);
  const script = process.platform === 'win32'
    ? `# ${'padding'.repeat(5000)}\n[Console]::WriteLine((Get-Location).Path); [Console]::WriteLine('中文 😀'); exit 7 # trailing comment`
    : `# ${'padding'.repeat(5000)}\npwd -P; printf '中文 😀\\n'; exit 7 # trailing comment`;
  const wrapper = await startWrapper(t, script, cwd);
  await wrapper.exited;
  const { bootstrap, identity, manifest, receipt, output } = await wrapper.read();
  assert.deepEqual(output.trim().split(/\r?\n/), [await fs.realpath(b), '中文 😀']);
  assert.equal(bootstrap.phase, 'identity_ready');
  assert.equal(bootstrap.childPid, identity.childPid);
  assert.equal(manifest.status, 'exited');
  assert.equal(receipt.exitCode, '7');
  assert.equal(receipt.terminationReason, 'natural');
  assert.equal(receipt.stableNonce, identity.stableNonce);
  assert.equal(receipt.startFingerprint, identity.startFingerprint);
  await authority.synchronizeWorkspaceFolders([folders[0]]);
  assert.throws(() => resolveFrozenWorkEnvironmentBoundary(frozen, [local(aId, a)]), /已不可用/);
});

test('两个Host投影只改变本地可用性，preview按scope有界读取且反映peer新revision', async t => {
  const root = await temporaryRoot(t, 'host-preview-smoke'), a = folder(path.join(root, 'A'), 'A', 0), b = folder(path.join(root, 'B'), 'B', 0);
  const { authority: first, paths } = authorityAt(path.join(root, 'shared'), [a]);
  const { authority: second } = authorityAt(path.join(root, 'shared'), [b]);
  await first.synchronizeWorkspaceFolders([a]); await second.synchronizeWorkspaceFolders([b]);
  const remote = id => ({ id, kind: 'remoteServer', source: 'manual', name: id, host: `${id}.invalid`, available: true, createdAt: 1, updatedAt: 1 });
  await first.mutations.upsertWorkEnvironment(remote('remote-a')); await first.mutations.upsertWorkEnvironment(remote('remote-b'));
  await first.mutations.setWorkEnvironmentPolicy({ scopeKind: 'global', enabled: true,
    allowedWorkEnvironmentIds: ['remote-a', 'remote-b'], defaultWorkEnvironmentId: 'remote-a' });
  const viewA = await first.configurationClientState(), viewB = await second.configurationClientState();
  assert.deepEqual(viewA.workEnvironmentPolicies[0].allowedWorkEnvironmentIds, ['remote-a', 'remote-b']);
  assert.deepEqual(viewB.workEnvironmentPolicies[0].allowedWorkEnvironmentIds, ['remote-a', 'remote-b']);
  const { workEnvironmentIdFromUri } = compiled('shared/workEnvironmentCatalog.js');
  assert.equal(viewA.workEnvironments.find(record => record.id === workEnvironmentIdFromUri(a.uri)).available, true);
  assert.equal(viewB.workEnvironments.find(record => record.id === workEnvironmentIdFromUri(a.uri)).available, false);
  await fs.mkdir(paths.modelProfilesRootUri.fsPath, { recursive: true });
  await fs.writeFile(paths.modelProfilesIndexUri.fsPath, 'not a model catalog');
  const originalRead = fs.readFile, reads = [];
  t.mock.method(fs, 'readFile', (...args) => { reads.push(String(args[0])); return originalRead(...args); });
  const request = { conversationId: 'preview', executorAgentId: 'main' };
  assert.equal((await first.previewWorkEnvironment(request)).workEnvironmentId, 'remote-a');
  assert.ok(reads.length <= viewA.workEnvironments.length + 7, JSON.stringify(reads));
  assert.ok(reads.every(file => !file.includes('model-profiles')));
  await second.mutations.setWorkEnvironmentPolicy({ scopeKind: 'global', enabled: true,
    allowedWorkEnvironmentIds: ['remote-a', 'remote-b'], defaultWorkEnvironmentId: 'remote-b' });
  assert.equal((await first.previewWorkEnvironment(request)).workEnvironmentId, 'remote-b');
});

test('真实文件替换以原生身份保护外部改写，声明symlink根不授权目录外路径', async t => {
  const root = await temporaryRoot(t, 'native-file-smoke'), realRoot = path.join(root, 'real'), linked = path.join(root, 'linked');
  await fs.mkdir(realRoot); await fs.symlink(realRoot, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const target = path.join(realRoot, 'replace.txt'); await fs.writeFile(target, 'base');
  const { captureFilePlanningRoot } = compiled('backend/reliableKernel/fileTargetBoundary.js');
  const { FileMutationDispatcher } = compiled('backend/reliableKernel/fileEffects.js');
  // FileMutation binds its planned base and target bytes with these content identities.
  const contentId = text => createHash('sha256').update(text).digest('hex');
  const member = { memberId: 'replace', memberSeq: '1', operation: 'replace_file', workEnvironmentId: 'workspace',
    planningRoot: await captureFilePlanningRoot(realRoot), targetPath: 'replace.txt', baseDigest: contentId('base'), targetDigest: contentId('replaced') };
  const dispatcher = { resolveBoundary: id => ({ id, rootPath: realRoot }), readTargetBytes: async () => Buffer.from('replaced'),
    inspectActual: input => FileMutationDispatcher.prototype.inspectActual.call(dispatcher, input) };
  const first = await FileMutationDispatcher.prototype.applyMember.call(dispatcher, member);
  assert.equal(first.outcome, 'succeeded', first.error);
  await fs.writeFile(target, 'peer write');
  const conflict = await FileMutationDispatcher.prototype.applyMember.call(dispatcher, member);
  assert.equal(conflict.outcome, 'conflict');
  assert.equal(await fs.readFile(target, 'utf8'), 'peer write');
  const { VscodeReliableToolHost } = compiled('backend/application/reliableKernel/VscodeReliableToolHost.js');
  const environment = local('workspace', linked), toolHost = { async resolveEnvironments() { return { active: environment, allowed: [environment] }; }, skillDirectoriesFor() { return []; } };
  const mapped = await VscodeReliableToolHost.prototype.resolveFilePath.call(toolHost, target, {});
  assert.equal(mapped.absolutePath, path.join(linked, 'replace.txt'));
  await assert.rejects(VscodeReliableToolHost.prototype.resolveFilePath.call(toolHost, path.join(root, 'outside.txt'), {}), /绝对路径不属于/);
  const { toSqliteFilePath } = compiled('backend/reliableKernel/index.js');
  assert.equal(toSqliteFilePath('\\\\server\\share\\limcode.sqlite', 'win32'), '\\\\?\\UNC\\server\\share\\limcode.sqlite');
});

test('远程家目录从transport解析，真实读取与删除根保护一致', { skip: process.platform === 'win32' }, async t => {
  const root = await temporaryRoot(t, 'remote-home-smoke'), home = path.join(root, 'home');
  await fs.mkdir(path.join(home, 'proj'), { recursive: true });
  await fs.writeFile(path.join(home, 'proj', 'source.txt'), 'remote source');
  const nativeSpawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (file, args, options) => {
    if (file !== 'ssh') return nativeSpawn(file, args, options);
    const command = args.at(-1);
    if (command.includes('__limcode_remote_home=')) return nativeSpawn(process.execPath,
      ['-e', `process.stdout.write(${JSON.stringify(`Welcome to fixture\n__limcode_remote_home=${home}\n`)})`], options);
    // SSH is the fixture boundary; execute the production script without local login profiles.
    return nativeSpawn('/bin/sh', ['-c', command.replace(/^bash -lc /, 'bash -c ')], options);
  });
  const remote = compiled('backend/capabilities/workEnvironmentProvider.js');
  const environment = { id: 'remote-home-smoke', kind: 'remoteServer', source: 'manual', name: 'Remote', host: 'fixture.invalid',
    workdir: '~/proj/', available: true, createdAt: 1, updatedAt: 1 };
  const restricted = { allowOutsideProjectPaths: false };
  assert.equal(await remote.remoteHomeFor(environment), home);
  assert.equal(await remote.readRemoteServerRawTextFile(environment, 'source.txt', undefined, restricted), 'remote source');
  await assert.rejects(remote.deleteRemoteServerPath(environment, '~/proj/', restricted), /拒绝删除远程工作环境根目录/);
  await assert.rejects(remote.deleteRemoteServerPath(environment, '~/', { allowOutsideProjectPaths: true }), /拒绝删除/);
  assert.equal(await fs.readFile(path.join(home, 'proj', 'source.txt'), 'utf8'), 'remote source');
});

test('代理显式opt-in才注入，关闭恢复用户原有代理和NO_PROXY', t => {
  const { applyProxyEnvironment, currentProxyEnvironment, proxyForShellAndMcp } = compiled('backend/application/reliableKernel/proxyEnvironment.js');
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    applyProxyEnvironment(undefined);
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  });
  process.env.HTTP_PROXY = 'http://user-existing:9000'; process.env.NO_PROXY = 'internal.local';
  assert.equal(proxyForShellAndMcp({ proxy: '127.0.0.1:7897' }), undefined);
  applyProxyEnvironment('127.0.0.1:7897');
  assert.equal(currentProxyEnvironment(), 'http://127.0.0.1:7897/');
  assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:7897/');
  applyProxyEnvironment('127.0.0.1:7890');
  assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:7890/');
  applyProxyEnvironment(undefined);
  assert.equal(process.env.HTTP_PROXY, 'http://user-existing:9000');
  assert.equal(process.env.NO_PROXY, 'internal.local');
});

test('原生wrapper读取确切用户stop请求，真实进程树结束并持久收尾', async t => {
  const executable = process.execPath.replace(/'/g, "''");
  const command = process.platform === 'win32'
    ? `$child = Start-Process -FilePath '${executable}' -ArgumentList '-e','setInterval(()=>{},1000)' -PassThru; [Console]::WriteLine('grandchild=' + $child.Id); Wait-Process -Id $child.Id`
    : `"${process.execPath}" -e 'setInterval(()=>{},1000)' & echo "grandchild=$!"; wait`;
  const result = await startWrapper(t, command), protocol = compiled('backend/reliableKernel/processProtocol.js');
  const identity = protocol.parseWrapperIdentity(JSON.parse(await waitForFile(result.spool, 'identity.json')));
  const output = await waitForOutput(result.spool, text => /grandchild=(\d+)\r?\n/.test(text));
  const grandchild = output.match(/grandchild=(\d+)\r?\n/)[1];
  await result.stop(identity);
  await result.exited;
  const { receipt } = await result.read();
  assert.equal(receipt.stopRequested, true);
  assert.equal(receipt.terminationReason, 'manual');
  assert.equal(receipt.startFingerprint, identity.startFingerprint);
  assert.throws(() => protocol.readProcessStartFingerprint(identity.childPid), { code: 'ENOENT' });
  assert.throws(() => protocol.readProcessStartFingerprint(grandchild), { code: 'ENOENT' });
});

test('真实技能发现与授权加载保留namespace，显式关闭及symlink逃逸被拒绝', async t => {
  const root = await temporaryRoot(t, 'skill-smoke'), home = path.join(root, 'home'), project = path.join(root, 'project');
  const skillDir = path.join(home, '.claude', 'skills', 'suite', 'skills', 'check');
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(path.join(skillDir, 'references'), { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: check\ndescription: Check a report.\n---\n# Body\n');
  await fs.writeFile(path.join(skillDir, 'references', 'guide.md'), 'skill reference');
  await fs.writeFile(path.join(root, 'secret.txt'), 'outside');
  const previousFolders = host.vscode.workspace.workspaceFolders;
  host.vscode.workspace.workspaceFolders = [{ uri: Uri.file(project) }];
  t.after(() => { host.vscode.workspace.workspaceFolders = previousFolders; });
  const { createSkillCatalogCapability } = compiled('backend/capabilities/skillCatalog.js');
  const catalog = createSkillCatalogCapability({ globalStorageUri: Uri.file(path.join(root, 'data')), globalState: { get() {} } },
    { homeDir: home, codexHome: path.join(home, '.codex') });
  await catalog.refresh();
  const found = catalog.lookup('suite:check');
  assert.equal(found.status, 'found');
  assert.equal((await catalog.readBody(found.skill)).text, '# Body');
  const { skillCatalogWithinPolicy } = compiled('backend/world/modules/skill/policy.js');
  const bounded = skillCatalogWithinPolicy(catalog, { sourceConfigs: { [found.skill.source]: { enabled: true, disabledSkills: [found.skill.id] } } });
  assert.equal(bounded.lookup('suite:check').disabled.id, found.skill.id);
  const { readWorkspaceTextFile } = compiled('backend/capabilities/vscodeFs.js');
  const options = { allowOutsideProjectPaths: false, localReadOnlyRoots: [skillDir] };
  assert.match((await readWorkspaceTextFile(path.join(skillDir, 'references', 'guide.md'), undefined, undefined, options)).content, /skill reference/);
  await fs.symlink(root, path.join(skillDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readWorkspaceTextFile(path.join(skillDir, 'escape', 'secret.txt'), undefined, undefined, options), /路径超出当前项目/);
});

async function startWrapper(t, command, cwd) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-native-wrapper-smoke-')), spool = path.join(root, 'process_smoke');
  let child, identity, completed = false;
  const protocol = compiled('backend/reliableKernel/processProtocol.js');
  const stop = async value => {
    const file = path.join(spool, protocol.PROCESS_WRAPPER_STOP_REQUEST_FILE);
    await fs.writeFile(`${file}.tmp`, JSON.stringify({ kind: protocol.PROCESS_WRAPPER_PROTOCOL, processId: value.processId,
      stableNonce: value.stableNonce, startFingerprint: value.startFingerprint, processGroupId: value.processGroupId,
      commandDigest: value.commandDigest, requestedAt: new Date().toISOString() }));
    await fs.rename(`${file}.tmp`, file);
  };
  let exited;
  t.after(async () => {
    try {
      if (child && !completed) {
        identity ??= await fs.readFile(path.join(spool, 'identity.json'), 'utf8').then(text => protocol.parseWrapperIdentity(JSON.parse(text))).catch(() => undefined);
        if (identity) await stop(identity);
        else child.kill('SIGTERM');
        await exited;
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  await fs.mkdir(spool);
  const createdAt = new Date().toISOString(), launch = path.join(spool, 'launch.json');
  // ProcessLaunchRequest requires the command digest to bind stop/receipt evidence to this launch.
  await fs.writeFile(launch, JSON.stringify({ kind: protocol.PROCESS_WRAPPER_PROTOCOL, processId: 'process_smoke',
    stableNonce: '0123456789abcdef0123456789abcdef', command, cwd: cwd ?? root,
    commandDigest: createHash('sha256').update(command).digest('hex'), spoolLocator: 'process_smoke', createdAt,
    executionTimeoutMs: 10000, executionDeadlineAt: new Date(Date.parse(createdAt) + 10000).toISOString(), maxOutputBytes: 1024 * 1024 }));
  child = childProcess.spawn(process.execPath, [path.join(extensionRoot, 'backend/reliableKernel/processWrapper.js'), launch],
    { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => { completed = true; code === 0 ? resolve() : reject(new Error(`wrapper exited ${code}: ${stderr}`)); });
  });
  return { spool, exited,
    async stop(value) { identity = value; await stop(value); },
    async read() {
      const read = async name => JSON.parse(await fs.readFile(path.join(spool, name), 'utf8'));
      return { bootstrap: protocol.parseWrapperBootstrapReceipt(await read(protocol.PROCESS_WRAPPER_BOOTSTRAP_FILE)),
        identity: protocol.parseWrapperIdentity(await read('identity.json')), manifest: protocol.parseWrapperManifest(await read('manifest.json')),
        receipt: protocol.parseWrapperExitReceipt(await read('exit-receipt.json')), output: await readOutput(spool) };
    }
  };
}

async function readOutput(spool) {
  const directory = path.join(spool, 'chunks');
  const files = (await fs.readdir(directory)).filter(file => !file.endsWith('.tmp')).sort();
  return Buffer.concat(await Promise.all(files.map(file => fs.readFile(path.join(directory, file))))).toString('utf8');
}

async function waitForFile(directory, name) {
  return watchUntil(directory, () => fs.readFile(path.join(directory, name), 'utf8'));
}

async function waitForOutput(spool, predicate) {
  return watchUntil(spool, async () => {
    const protocol = compiled('backend/reliableKernel/processProtocol.js');
    const manifest = protocol.parseWrapperManifest(JSON.parse(await fs.readFile(path.join(spool, 'manifest.json'), 'utf8')));
    const output = Buffer.from(manifest.stdoutTailBase64, 'base64').toString('utf8');
    return predicate(output) ? output : undefined;
  });
}

async function watchUntil(directory, probe) {
  let watcher, timer;
  try {
    return await new Promise((resolve, reject) => {
      const check = () => probe().then(value => { if (value !== undefined) resolve(value); }, error => {
        if (error.code !== 'ENOENT') reject(error);
      });
      watcher = watch(directory, check);
      watcher.on('error', reject);
      timer = setTimeout(() => reject(new Error(`No fixture evidence in ${directory}`)), 5000);
      check();
    });
  } finally { watcher?.close(); if (timer) clearTimeout(timer); }
}
