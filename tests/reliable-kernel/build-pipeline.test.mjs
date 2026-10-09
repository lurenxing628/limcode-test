import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readZipArchive } from '../../scripts/reliable-kernel/lib/zip-archive.mjs';
import { loadContractDocuments, validateContractDocuments } from '../../scripts/reliable-kernel/lib/contract-model.mjs';

const require = createRequire(import.meta.url);
const { ZipFile } = require('yazl');
const root = process.cwd();
const packageScript = path.join(root, 'scripts/reliable-kernel/package-extension.mjs');
const validator = path.join(root, 'scripts/reliable-kernel/validators/package.mjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'limcode-build-pipeline-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return fs.realpathSync(directory);
}

function write(directory, relative, content) {
  const file = path.join(directory, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

async function zip(entries, options = {}) {
  const archive = new ZipFile();
  for (const [name, content] of entries) archive.addBuffer(Buffer.from(content), name, options);
  const chunks = [];
  archive.outputStream.on('data', chunk => chunks.push(chunk));
  const completed = new Promise((resolve, reject) => {
    archive.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    archive.outputStream.on('error', reject);
  });
  archive.end();
  return completed;
}

test('four target packages prepare once and keep explicit outputs distinct', t => {
  const directory = fixture(t);
  const trace = path.join(directory, 'calls.jsonl');
  const npm = write(directory, 'npm.cjs', `require('fs').appendFileSync(${JSON.stringify(trace)}, JSON.stringify({kind:'build',args:process.argv.slice(2)})+'\\n');`);
  write(directory, 'scripts/reliable-kernel/prune-package-dist.mjs', `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({kind:'prune'})+'\\n');`);
  const preload = write(directory, 'vsce.cjs', `const fs=require('fs'); const vsce=require(${JSON.stringify(require.resolve('@vscode/vsce'))}); vsce.createVSIX=async options=>fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({kind:'package',...options})+'\\n');`);
  const env = { ...process.env, npm_execpath: npm };
  delete env.NODE_TEST_CONTEXT;
  const result = childProcess.spawnSync(process.execPath, ['--require', preload, packageScript, '--all', '--out', 'test-{target}.vsix'], {
    cwd: directory, env, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(call => call.kind), ['build', 'prune', 'package', 'package', 'package', 'package']);
  assert.deepEqual(calls[0].args, ['run', 'build']);
  assert.deepEqual(calls.slice(2).map(call => call.target), ['linux-x64', 'win32-x64', 'darwin-x64', 'darwin-arm64']);
  assert.deepEqual(calls.slice(2).map(call => call.packagePath), calls.slice(2).map(call => path.join(directory, `test-${call.target}.vsix`)));
});

test('package preparation failure stops before pruning or publishing any package', t => {
  const directory = fixture(t);
  const npm = write(directory, 'npm.cjs', 'process.exit(7);');
  const result = childProcess.spawnSync(process.execPath, [packageScript, '--all'], {
    cwd: directory, env: { ...process.env, npm_execpath: npm }, encoding: 'utf8'
  });
  assert.equal(result.status, 7, result.stderr);
});

test('ZIP entries reuse their decompressed bytes and report missing entries', async () => {
  const archive = readZipArchive(await zip([['extension/a.js', 'exports.value = 1;']]));
  assert.deepEqual(archive.names, ['extension/a.js']);
  assert.equal(archive.read('extension/a.js'), archive.read('extension/a.js'));
  assert.equal(archive.read('extension/a.js').toString(), 'exports.value = 1;');
  assert.equal(archive.read('extension/missing.js'), undefined);
});

test('ZIP reads reject wrong CRC32 and decoded lengths before caching', async () => {
  const original = await zip([['extension/package.json', '{"name":"fixture"}']], { compress: false });
  const central = original.readUInt32LE(original.length - 6);
  const wrongCrc = Buffer.from(original);
  wrongCrc.writeUInt32LE(0, central + 16);
  wrongCrc.writeUInt32LE(0, 14);
  assert.throws(() => readZipArchive(wrongCrc).read('extension/package.json'), /CRC32/);
  const wrongLength = Buffer.from(original);
  wrongLength.writeUInt32LE(original.readUInt32LE(central + 24) + 1, central + 24);
  wrongLength.writeUInt32LE(original.readUInt32LE(22) + 1, 22);
  assert.throws(() => readZipArchive(wrongLength).read('extension/package.json'), /展开长度/);
  const corruptLocal = Buffer.from(original);
  corruptLocal.writeUInt32LE(0, 14);
  assert.throws(() => readZipArchive(corruptLocal).read('extension/package.json'), /local header/);
});

test('ZIP read limits apply to cached entries and inflation with a false declared size', async () => {
  const original = await zip([['extension/large.js', 'A'.repeat(16_384)]]);
  const archive = readZipArchive(original);
  assert.equal(archive.read('extension/large.js', 16_384).length, 16_384);
  assert.throws(() => archive.read('extension/large.js', 1_024), /读取上限/);
  const falseSize = Buffer.from(original);
  const central = falseSize.readUInt32LE(falseSize.length - 6);
  falseSize.writeUInt32LE(0, central + 24);
  falseSize.writeUInt32LE(0, 22);
  assert.throws(() => readZipArchive(falseSize).read('extension/large.js', 1_024), { code: 'ERR_BUFFER_TOO_LARGE' });
});

test('ZIP parsing rejects a malformed central directory and truncated entry payload', async () => {
  const original = await zip([['extension/a.js', 'exports.value = 1;']]);
  const malformed = Buffer.from(original);
  malformed.writeUInt32LE(original.length, malformed.length - 6);
  assert.throws(() => readZipArchive(malformed), /ZIP central-directory/);
  const truncated = Buffer.from(original);
  const central = truncated.readUInt32LE(truncated.length - 6);
  truncated.writeUInt32LE(original.length, central + 20);
  assert.throws(() => readZipArchive(truncated).read('extension/a.js'), /ZIP.*截断|ZIP local header/);
});

test('package metadata keeps its caller-specific ZIP expansion limit', async t => {
  const directory = fixture(t);
  const artifact = path.join(directory, 'large-provenance.vsix');
  fs.writeFileSync(artifact, await zip([
    ['extension/dist/build-provenance.json', JSON.stringify({ buildId: 'fixture', commitSha: 'a'.repeat(40),
      worktreeClean: true, mainEntrySha256: '0'.repeat(64), padding: 'A'.repeat(1_048_576) })],
    ['extension/dist/extension/compile-build-id.json', '{"buildId":"fixture"}']
  ]));
  write(directory, 'docs/architecture/reliable-kernel/contracts/gate-registry.json', JSON.stringify({
    gates: [{ id: 'installed', stages: ['G'] }], validatorGroups: [{ id: 'package', introducedAt: 'installed', checks: [
      { id: 'package.provenance-clean-commit' }
    ] }]
  }));
  const result = childProcess.spawnSync(process.execPath, [validator, '--artifact', artifact, `--commit=${'a'.repeat(40)}`], {
    cwd: directory, encoding: 'utf8'
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ZIP条目超过读取上限/);
});

test('webview-only identity refresh preserves backend provenance without querying the current Git state', t => {
  const directory = fixture(t);
  const old = { buildId: 'backend-A', commitSha: 'a'.repeat(40), worktreeClean: false };
  const metadata = write(directory, 'dist/extension/compile-build-id.json', JSON.stringify(old));
  const backend = write(directory, 'dist/extension/backend.js', 'exports.version = "A";');
  const result = childProcess.spawnSync(process.execPath, [path.join(root, 'scripts/reliable-kernel/write-compile-build-id.mjs'), '--webview'], {
    cwd: directory, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const refreshed = JSON.parse(fs.readFileSync(metadata, 'utf8'));
  assert.notEqual(refreshed.buildId, old.buildId);
  assert.equal(refreshed.commitSha, old.commitSha);
  assert.equal(refreshed.worktreeClean, old.worktreeClean);
  assert.equal(fs.readFileSync(backend, 'utf8'), 'exports.version = "A";');
});

test('webview-only refresh leaves missing backend provenance unknown', t => {
  const directory = fixture(t);
  const result = childProcess.spawnSync(process.execPath, [path.join(root, 'scripts/reliable-kernel/write-compile-build-id.mjs'), '--webview'], {
    cwd: directory, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const identity = JSON.parse(fs.readFileSync(path.join(directory, 'dist/extension/compile-build-id.json'), 'utf8'));
  assert.ok(identity.buildId);
  assert.equal(identity.commitSha, undefined);
  assert.equal(identity.worktreeClean, undefined);
});

test('plan bootstraps complete contract validation even when its registry removes coherence checks', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/reliable-kernel/validators/plan.mjs'), 'utf8').replace(/^import .*;\n/gm, '');
  for (const remove of [checks => [], checks => checks.filter(check => check.id !== 'plan.contract-coherence')]) {
    const documents = loadContractDocuments(root);
    const registry = documents['gate-registry.json'];
    const plan = registry.validatorGroups.find(group => group.id === 'plan');
    plan.checks = remove(plan.checks);
    const problems = validateContractDocuments(root, documents);
    assert.ok(problems.some(problem => problem.includes('plan稳定检查ID')));
    let calls = 0;
    let exitCode;
    const errors = [];
    try {
      vm.runInNewContext(source, {
        childProcess: { spawnSync: (_executable, args) => {
          calls += 1;
          assert.deepEqual(Array.from(args), [path.join(root, 'scripts/reliable-kernel/check-plan.mjs'), '--require-tracked']);
          return { status: 1, stdout: '', stderr: problems.join('\n') };
        } },
        fs: { ...fs, readFileSync: (file, ...args) => String(file).endsWith('/contracts/gate-registry.json')
          ? JSON.stringify(registry) : fs.readFileSync(file, ...args) },
        path,
        process: { cwd: () => root, execPath: process.execPath, exit: code => {
          exitCode = code;
          throw Object.assign(new Error('fixture process exit'), { fixtureExit: true });
        } },
        console: { error: message => errors.push(message), log() {}, warn() {} }
      });
    } catch (error) {
      if (!error.fixtureExit) throw error;
    }
    assert.equal(exitCode, 1, errors.join('\n'));
    assert.equal(calls, 1, 'a registry cannot omit its own bootstrap');
    assert.match(errors.join('\n'), /plan稳定检查ID/);
  }
});

test('package pruning keeps the path-started file diff worker and its dependencies', t => {
  const directory = fixture(t);
  const output = 'dist/extension/';
  for (const name of ['databaseWorker', 'packedCasWorker', 'processWrapper', 'runtimeSnapshotAuditWorker',
    'runtimeSnapshotUpgradeWorker', 'runtimeDataSetFactsWorker', 'runtimeDataRootRelocationWorker']) {
    write(directory, `${output}backend/reliableKernel/${name}.js`, 'exports.value = 1;');
  }
  write(directory, `${output}vscode/extension.js`, "require('../backend/capabilities/fileDiffAsync');");
  write(directory, `${output}backend/capabilities/fileDiffAsync.js`, "new Worker(path.join(__dirname, 'fileDiffWorker.js'));");
  write(directory, `${output}backend/capabilities/fileDiffWorker.js`, "require('./fileDiff');");
  write(directory, `${output}backend/capabilities/fileDiff.js`, 'exports.buildFileDiffRecord = () => {};');
  write(directory, `${output}backend/capabilities/unused.js`, 'exports.value = 1;');
  const result = childProcess.spawnSync(process.execPath, [path.join(root, 'scripts/reliable-kernel/prune-package-dist.mjs')], {
    cwd: directory, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['fileDiffAsync', 'fileDiffWorker', 'fileDiff']) {
    assert.ok(fs.existsSync(path.join(directory, `${output}backend/capabilities/${name}.js`)), `${name} must ship`);
  }
  assert.equal(fs.existsSync(path.join(directory, `${output}backend/capabilities/unused.js`)), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'dist/package-runtime-closure.json'), 'utf8'));
  assert.ok(manifest.seeds.includes('backend/capabilities/fileDiffWorker.js'));
});

test('package gate shares successful closure verification across its two checks', async t => {
  const directory = fixture(t);
  const trace = path.join(directory, 'reads.json');
  const artifact = path.join(directory, 'fixture.vsix');
  const workerNames = ['databaseWorker', 'packedCasWorker', 'runtimeSnapshotAuditWorker', 'runtimeSnapshotUpgradeWorker', 'runtimeDataSetFactsWorker', 'runtimeDataRootRelocationWorker'];
  const main = [
    "require('../backend/application/runtimeBuildIdentity');",
    "require('../backend/application/runtimeBuildInfo');",
    "new Worker(path.join(__dirname, '../backend/capabilities/fileDiffWorker.js'));",
    ...workerNames.map(name => `new Worker(path.join(__dirname, '../backend/reliableKernel/${name}.js'));`),
    "spawn(process.execPath, [path.join(__dirname, '../backend/reliableKernel/processWrapper.js')]);"
  ].join('\n');
  const sources = new Map([
    ['dist/extension/vscode/extension.js', main],
    ['dist/extension/backend/capabilities/fileDiffWorker.js', 'exports.value = 1;'],
    ['dist/extension/backend/application/runtimeBuildIdentity.js', "path.join(__dirname, '../../compile-build-id.json');"],
    ['dist/extension/backend/application/runtimeBuildInfo.js', "path.join(__dirname, '../../compile-build-id.json');"],
    ...[...workerNames, 'processWrapper'].map(name => [`dist/extension/backend/reliableKernel/${name}.js`, 'exports.value = 1;'])
  ]);
  // The hash stub isolates memoization from cryptography. No new content proof is generated.
  const manifest = { kind: 'limcode-package-runtime-closure', files: [...sources.keys()].map(file => ({ path: file, sha256: '0'.repeat(64) })),
    fileCount: sources.size, seeds: ['vscode/extension.js', 'backend/capabilities/fileDiffWorker.js', ...[...workerNames, 'processWrapper'].map(name => `backend/reliableKernel/${name}.js`)] };
  fs.writeFileSync(artifact, await zip([
    ['extension/dist/package-runtime-closure.json', JSON.stringify(manifest)],
    ...[...sources].map(([file, content]) => [`extension/${file}`, content])
  ]));
  write(directory, 'docs/architecture/reliable-kernel/contracts/gate-registry.json', JSON.stringify({
    gates: [{ id: 'installed', stages: ['G'] }], validatorGroups: [{ id: 'package', introducedAt: 'installed', checks: [
      { id: 'package.legacy-entry-unreachable' }, { id: 'package.dist-import-unreachable' }
    ] }]
  }));
  const preload = write(directory, 'trace.cjs', `
const fs=require('fs'); const crypto=require('crypto'); let reads=0,hashes=0;
const read=fs.readFileSync; fs.readFileSync=function(file,...args){if(String(file)===${JSON.stringify(artifact)}) reads++;return read.call(this,file,...args);};
crypto.createHash=function(){hashes++;return {update(){return this;},digest(){return '0'.repeat(64);}};};
process.on('exit',()=>fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify({reads,hashes})));
`);
  const result = childProcess.spawnSync(process.execPath, ['--require', preload, validator, '--artifact', artifact], {
    cwd: directory, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(trace, 'utf8')), { reads: 1, hashes: sources.size });
});

test('watch publishes each successful build identity and keeps the last output after errors', async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'limcode-watch-identity-')));
  childProcess.execFileSync('git', ['init', '-q'], { cwd: directory });
  childProcess.execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '-q', '--allow-empty', '-m', 'fixture'], { cwd: directory });
  write(directory, 'tsconfig.json', JSON.stringify({
    compilerOptions: { outDir: 'dist/extension', module: 'CommonJS', target: 'ES2020', types: [] }, include: ['main.ts']
  }));
  const source = write(directory, 'main.ts', 'export const value: number = 1;\n');
  const watcher = childProcess.spawn(process.execPath, [path.join(root, 'scripts/reliable-kernel/watch-extension.mjs')], {
    cwd: directory, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  watcher.stdout.on('data', chunk => { output += chunk; });
  watcher.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (watcher.exitCode === null && watcher.signalCode === null) {
      const closed = new Promise(resolve => watcher.once('close', resolve));
      watcher.kill();
      await closed;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const identity = () => {
    try { return JSON.parse(fs.readFileSync(path.join(directory, 'dist/extension/compile-build-id.json'), 'utf8')); }
    catch { return undefined; }
  };
  const until = async predicate => {
    const deadline = Date.now() + 15_000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline && watcher.exitCode === null, output);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  await until(() => identity()?.buildId);
  const first = identity();
  fs.writeFileSync(source, 'export const value: number = 2;\n');
  await until(() => {
    const buildId = identity()?.buildId;
    return buildId && buildId !== first.buildId;
  });
  const second = identity();
  assert.ok(second.buildId);
  assert.equal(second.commitSha, first.commitSha);
  assert.equal(second.worktreeClean, false);
  const compiled = path.join(directory, 'dist/extension/main.js');
  const validOutput = fs.readFileSync(compiled, 'utf8');
  assert.match(validOutput, /value = 2/);
  fs.writeFileSync(source, 'export const value: number = "wrong";\n');
  await until(() => output.includes('Found 1 error'));
  assert.equal(identity().buildId, second.buildId);
  assert.equal(fs.readFileSync(compiled, 'utf8'), validOutput);
});
