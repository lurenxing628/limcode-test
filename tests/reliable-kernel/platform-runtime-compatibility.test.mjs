import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const root = process.cwd();
const distRoot = path.join(root, 'dist/extension');
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const kernel = require(path.join(distRoot, 'backend/reliableKernel/index.js'));
const processProtocol = require(path.join(distRoot, 'backend/reliableKernel/processProtocol.js'));
const durableDirectorySync = require(path.join(
  distRoot,
  'backend/capabilities/filesystem/durableDirectorySync.js'
));
const windowsPowerShell = require(path.join(distRoot, 'backend/capabilities/windowsPowerShell.js'));
const {
  VSCODE_INCOMPATIBLE_RUNTIME_BACKUPS_DIRECTORY,
  VscodeReliableKernelCutoverCoordinator
} = require(path.join(
  distRoot,
  'backend/application/reliableKernel/VscodeReliableKernelCutoverCoordinator.js'
));

const physicalCutover = require(path.join(distRoot, 'backend/reliableKernel/physicalCutover.js'));
const { PHYSICAL_CUTOVER_MANIFEST } = require(path.join(
  distRoot, 'backend/reliableKernel/generatedPhysicalCutoverManifest.js'
));
const windowsOnly = { skip: process.platform !== 'win32' };
const darwinOnly = { skip: process.platform !== 'darwin' };
const windowsPathSeparator = String.fromCharCode(92);
const windowsNamespacePrefix = `${windowsPathSeparator}${windowsPathSeparator}?${windowsPathSeparator}`;

test('目录元数据同步保持普通文件严格语义并兼容当前平台', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-directory-sync-'));
  try {
    const result = await durableDirectorySync.syncDirectoryDurably(directory);
    assert.equal(typeof result, 'boolean');
    if (process.platform !== 'win32') assert.equal(result, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('跨平台进程指纹可稳定识别当前进程', () => {
  const first = processProtocol.readProcessStartFingerprint(process.pid);
  const second = processProtocol.readProcessStartFingerprint(process.pid);
  assert.equal(first, second);
  const expected = process.platform === 'win32'
    ? new RegExp(`^win32-process:${process.pid}:\\d+$`)
    : process.platform === 'linux'
      ? new RegExp(`^linux-proc:${process.pid}:\\d+$`)
      : process.platform === 'darwin'
        ? new RegExp(`^darwin-ps:${process.pid}:[a-f0-9]{64}$`)
        : undefined;
  assert.ok(expected, `unsupported test platform: ${process.platform}/${process.arch}`);
  assert.match(first, expected);
});

test('SQLite Windows原生边界转换drive与UNC长路径且保持逻辑路径独立', () => {
  const drivePath = [
    'C:',
    'Users',
    'tester',
    'AppData',
    'Roaming',
    'Code',
    'User',
    'globalStorage',
    'your-publisher.limcode-test',
    'd'.repeat(180),
    'limcode.sqlite'
  ].join(windowsPathSeparator);
  const driveNativePath = `${windowsNamespacePrefix}${drivePath}`;
  assert.equal(kernel.toSqliteFilePath(drivePath, 'win32'), driveNativePath);
  assert.equal(kernel.toSqliteFilePath(driveNativePath, 'win32'), driveNativePath);

  const uncPath = [
    '',
    '',
    'server',
    'share',
    'u'.repeat(180),
    'limcode.sqlite'
  ].join(windowsPathSeparator);
  const uncNativePath = [
    '',
    '',
    '?',
    'UNC',
    'server',
    'share',
    'u'.repeat(180),
    'limcode.sqlite'
  ].join(windowsPathSeparator);
  assert.equal(kernel.toSqliteFilePath(uncPath, 'win32'), uncNativePath);
  assert.equal(kernel.toSqliteFilePath(uncNativePath, 'win32'), uncNativePath);
  assert.equal(kernel.toSqliteFilePath('/var/lib/limcode/limcode.sqlite', 'linux'), '/var/lib/limcode/limcode.sqlite');
  assert.throws(
    () => kernel.toSqliteFilePath(['relative', 'limcode.sqlite'].join(windowsPathSeparator), 'win32'),
    /must be absolute on Windows/
  );
});


test('macOS Wrapper核验要求PID存活且命令行包含精确launch路径', darwinOnly, async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-wrapper-reachable-'));
  const launchPath = path.join(parent, 'launch path.json');
  await fs.writeFile(launchPath, '{}\n');
  const child = childProcess.spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1_000)', launchPath],
    { stdio: 'ignore' }
  );
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const deadline = Date.now() + 2_000;
    while (!processProtocol.isWrapperProcessReachable(String(child.pid), launchPath)) {
      if (Date.now() >= deadline) assert.fail('Darwin wrapper command line did not become observable.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(
      processProtocol.isWrapperProcessReachable(String(child.pid), path.join(parent, 'other.json')),
      false
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGKILL');
      });
    }
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('完整初始化后遗留 pending RootBinding 会被严格校验并原子提交', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-pending-root-recovery-'));
  let runtime;
  try {
    const candidate = await kernel.resetCandidateRuntimeRoot(parent);
    runtime = await kernel.RuntimeDatabase.open(candidate.authority);
    await runtime.close();
    runtime = undefined;
    await fs.rename(candidate.binding.paths.rootPointerPath, candidate.binding.paths.rootPendingPath);

    const competingAuthority = new kernel.RootAuthority(() => candidate.binding.paths.dataRootPath);
    const [recovered, competing] = await Promise.all([
      candidate.authority.current(),
      competingAuthority.current()
    ]);
    assert.equal(recovered.dataSetId, candidate.binding.dataSetId);
    assert.equal(recovered.rootInstanceId, candidate.binding.rootInstanceId);
    assert.equal(recovered.rootGeneration, candidate.binding.rootGeneration);
    assert.equal(recovered.runtimeKernelEpoch, candidate.binding.runtimeKernelEpoch);
    assert.equal(competing.dataSetId, recovered.dataSetId);
    await fs.access(candidate.binding.paths.rootPointerPath);
    await assert.rejects(fs.access(candidate.binding.paths.rootPendingPath), { code: 'ENOENT' });
  } finally {
    if (runtime) await runtime.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('身份不匹配的 pending RootBinding 继续 fail closed', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-pending-root-reject-'));
  let runtime;
  try {
    const candidate = await kernel.resetCandidateRuntimeRoot(parent);
    runtime = await kernel.RuntimeDatabase.open(candidate.authority);
    await runtime.close();
    runtime = undefined;
    await fs.rename(candidate.binding.paths.rootPointerPath, candidate.binding.paths.rootPendingPath);
    const epoch = JSON.parse(await fs.readFile(candidate.binding.paths.runtimeEpochPath, 'utf8'));
    epoch.rootGeneration += 1;
    await fs.writeFile(candidate.binding.paths.runtimeEpochPath, `${JSON.stringify(epoch, null, 2)}\n`);

    await assert.rejects(
      candidate.authority.current(),
      (error) => error?.code === 'root-binding-pending'
    );
    await fs.access(candidate.binding.paths.rootPendingPath);
    await assert.rejects(fs.access(candidate.binding.paths.rootPointerPath), { code: 'ENOENT' });
  } finally {
    if (runtime) await runtime.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('旧版本扩展遇到更高 epoch RootBinding 时在迁移前明确拒绝且不写入运行时数据', async () => {
  const runtimeScopeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-newer-epoch-guard-'));
  try {
    const paths = kernel.createRuntimeRootPaths(path.join(runtimeScopeRoot, '.limcode-runtime', 'active'));
    const newerBinding = {
      paths,
      dataSetId: 'newer-data-set',
      rootInstanceId: 'newer-root-instance',
      rootGeneration: 1,
      pointerRevision: 1,
      runtimeKernelEpoch: kernel.RUNTIME_KERNEL_EPOCH + 1
    };
    await fs.mkdir(path.dirname(paths.rootPointerPath), { recursive: true });
    await fs.writeFile(paths.rootPointerPath, `${JSON.stringify(newerBinding, null, 2)}\n`);
    const pointerBefore = await fs.readFile(paths.rootPointerPath, 'utf8');
    const authority = new kernel.RootAuthority(() => paths.dataRootPath);

    assert.throws(
      () => kernel.parseHistoricalRootBinding(newerBinding),
      /newer than this extension/
    );
    await assert.rejects(
      new VscodeReliableKernelCutoverCoordinator(authority, runtimeScopeRoot).ensureCurrentRoot(),
      (error) => error?.code === 'runtime-epoch-newer-than-extension'
        && !error.message.includes('Invalid historical RootBinding pointer')
    );
    assert.equal(await fs.readFile(paths.rootPointerPath, 'utf8'), pointerBefore);
    await assert.rejects(fs.access(paths.rootPendingPath), { code: 'ENOENT' });
    await assert.rejects(fs.access(paths.runtimeEpochPath), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(path.dirname(paths.dataRootPath), 'epoch-3-to-4-migration.json')), { code: 'ENOENT' });
  } finally {
    await fs.rm(runtimeScopeRoot, { recursive: true, force: true });
  }
});

test('当前 epoch RootBinding 可作为历史读取结果正常解析', async () => {
  const runtimeScopeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-current-epoch-binding-'));
  try {
    const paths = kernel.createRuntimeRootPaths(path.join(runtimeScopeRoot, '.limcode-runtime', 'active'));
    const binding = {
      paths,
      dataSetId: 'current-data-set',
      rootInstanceId: 'current-root-instance',
      rootGeneration: 2,
      pointerRevision: 3,
      runtimeKernelEpoch: kernel.RUNTIME_KERNEL_EPOCH
    };
    await fs.mkdir(path.dirname(paths.rootPointerPath), { recursive: true });
    await fs.writeFile(paths.rootPointerPath, `${JSON.stringify(binding, null, 2)}\n`);

    assert.deepEqual(await new kernel.RootAuthority(() => paths.dataRootPath).readHistoricalPointerForCutover(), binding);
  } finally {
    await fs.rm(runtimeScopeRoot, { recursive: true, force: true });
  }
});

test('当前 epoch 下畸形 RootBinding 仍报告真实 historical pointer invalid', async () => {
  const runtimeScopeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-malformed-epoch-binding-'));
  try {
    const paths = kernel.createRuntimeRootPaths(path.join(runtimeScopeRoot, '.limcode-runtime', 'active'));
    const malformedBinding = {
      paths,
      dataSetId: 'malformed-data-set',
      rootInstanceId: 'malformed-root-instance',
      rootGeneration: 0,
      pointerRevision: 1,
      runtimeKernelEpoch: kernel.RUNTIME_KERNEL_EPOCH
    };
    await fs.mkdir(path.dirname(paths.rootPointerPath), { recursive: true });
    await fs.writeFile(paths.rootPointerPath, `${JSON.stringify(malformedBinding, null, 2)}\n`);

    await assert.rejects(
      new kernel.RootAuthority(() => paths.dataRootPath).readHistoricalPointerForCutover(),
      (error) => error?.code === 'root-binding-invalid'
        && error.message.includes('Invalid historical RootBinding pointer')
    );
  } finally {
    await fs.rm(runtimeScopeRoot, { recursive: true, force: true });
  }
});
test('historical reader 完整校验优先于 future epoch 分类', async (t) => {
  const runtimeScopeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-historical-schema-fence-'));
  try {
    const paths = kernel.createRuntimeRootPaths(path.join(runtimeScopeRoot, '.limcode-runtime', 'active'));
    const binding = {
      paths,
      dataSetId: 'future-data-set',
      rootInstanceId: 'future-root-instance',
      rootGeneration: 1,
      pointerRevision: 1,
      runtimeKernelEpoch: kernel.RUNTIME_KERNEL_EPOCH + 1
    };
    const invalid = [
      ...Object.keys(binding).map((key) => [`missing ${key}`, (value) => { delete value[key]; }]),
      ['extra key', (value) => { value.unexpected = true; }],
      ['empty dataSetId', (value) => { value.dataSetId = ''; }],
      ['invalid rootInstanceId', (value) => { value.rootInstanceId = 1; }],
      ['generation zero', (value) => { value.rootGeneration = 0; }],
      ['unsafe generation', (value) => { value.rootGeneration = Number.MAX_SAFE_INTEGER + 1; }],
      ['revision zero', (value) => { value.pointerRevision = 0; }],
      ['unsafe revision', (value) => { value.pointerRevision = Number.MAX_SAFE_INTEGER + 1; }],
      ['unsafe epoch', (value) => { value.runtimeKernelEpoch = Number.MAX_SAFE_INTEGER + 1; }],
      ['fractional epoch', (value) => { value.runtimeKernelEpoch += 0.5; }],
      ['string epoch', (value) => { value.runtimeKernelEpoch = String(value.runtimeKernelEpoch); }],
      ...Object.keys(paths).flatMap((key) => [
        [`missing path ${key}`, (value) => { delete value.paths[key]; }],
        [`relative path ${key}`, (value) => { value.paths[key] = 'relative/path'; }],
        [`unnormalized path ${key}`, (value) => { value.paths[key] += `${path.sep}..${path.sep}other`; }]
      ])
    ];
    await fs.mkdir(path.dirname(paths.rootPointerPath), { recursive: true });
    const authority = new kernel.RootAuthority(() => paths.dataRootPath);
    for (const [name, mutate] of invalid) {
      await t.test(name, async () => {
        const malformed = structuredClone(binding);
        mutate(malformed);
        await fs.writeFile(paths.rootPointerPath, `${JSON.stringify(malformed)}\n`);
        const before = await physicalCutover.treeDigest(runtimeScopeRoot);
        await assert.rejects(authority.readHistoricalPointerForCutover(), { code: 'root-binding-invalid' });
        assert.equal(await physicalCutover.treeDigest(runtimeScopeRoot), before);
      });
    }
    await t.test('complete future pointer has the dedicated error', async () => {
      await fs.writeFile(paths.rootPointerPath, `${JSON.stringify(binding)}\n`);
      await assert.rejects(authority.readHistoricalPointerForCutover(), {
        code: 'runtime-epoch-newer-than-extension'
      });
    });
  } finally {
    await fs.rm(runtimeScopeRoot, { recursive: true, force: true });
  }
});

test('future/invalid pointer fences physical recovery and request before any mutation', async (t) => {
  const entrypoints = {
    startup: (authority, scope) => new VscodeReliableKernelCutoverCoordinator(authority, scope).ensureCurrentRoot(),
    recovery: (authority, scope) => physicalCutover.recoverInterruptedPhysicalCutover(scope, authority),
    cutover: (authority, scope) => physicalCutover.performPhysicalCutover(scope, authority, async () => {
      assert.fail('fenced pointer must never initialize a Runtime');
    })
  };
  for (const [entrypoint, invoke] of Object.entries(entrypoints)) {
    for (const pointerKind of ['future', 'invalid']) {
      for (const artifact of ['archiving', 'activating', 'completed', 'request-only', 'invalid-journal', 'invalid-request', 'none']) {
        await t.test(`${entrypoint}: ${pointerKind} + ${artifact}`, async () => {
          const scope = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-physical-future-fence-'));
          try {
            const paths = kernel.createRuntimeRootPaths(path.join(scope, '.limcode-runtime', 'active'));
            const control = path.dirname(paths.rootPointerPath);
            const binding = {
              paths,
              dataSetId: 'future-data-set',
              rootInstanceId: 'future-root-instance',
              rootGeneration: pointerKind === 'invalid' ? 0 : 2,
              pointerRevision: 2,
              runtimeKernelEpoch: kernel.RUNTIME_KERNEL_EPOCH + 1
            };
            await fs.mkdir(paths.casRootPath, { recursive: true });
            await fs.writeFile(paths.databasePath, 'future database bytes: never open as SQLite');
            await fs.writeFile(path.join(paths.casRootPath, 'keep.bin'), Buffer.from([0, 1, 255, 42]));
            await fs.writeFile(paths.runtimeEpochPath, JSON.stringify({ futureEpoch: binding.runtimeKernelEpoch }));
            await fs.writeFile(paths.rootPointerPath, `${JSON.stringify(binding)}\n`);
            await fs.writeFile(paths.rootPendingPath, `${JSON.stringify(binding)}\n`);
            const requestPath = path.join(control, physicalCutover.CUTOVER_REQUEST_FILE);
            const journalPath = path.join(control, physicalCutover.CUTOVER_JOURNAL_FILE);
            let request;
            if (artifact !== 'none') {
              request = await physicalCutover.persistPhysicalCutoverRequest(scope, {
                noActiveTurn: true, noBackgroundProcess: true,
                noPendingProviderStream: true, noPersistInflight: true
              });
            }
            if (['archiving', 'activating', 'completed'].includes(artifact)) {
              const archiveRoot = path.join(control, physicalCutover.CUTOVER_BACKUPS_DIRECTORY, 'interrupted-fixture');
              const archivedActive = path.join(archiveRoot, 'runtime-control', 'active');
              await fs.mkdir(archivedActive, { recursive: true });
              await fs.writeFile(path.join(archivedActive, 'old-data.bin'), 'archived predecessor');
              const { paths: _paths, ...identity } = binding;
              await fs.writeFile(journalPath, JSON.stringify({
                kind: 'limcode-runtime-cutover-journal',
                contractRevision: PHYSICAL_CUTOVER_MANIFEST.contractRevision,
                requestId: request.requestId,
                attemptId: 'interrupted-attempt',
                state: artifact,
                archiveDirectoryName: 'interrupted-fixture',
                createdAt: '2026-09-18T00:00:00.000Z',
                updatedAt: '2026-09-18T00:00:00.000Z',
                previousBinding: { ...identity, runtimeKernelEpoch: kernel.RUNTIME_KERNEL_EPOCH },
                ...(artifact === 'completed' ? { activatedBinding: identity } : {}),
                steps: [{
                  entryId: 'control.previous-runtime-active',
                  sourceRelativePath: '.limcode-runtime/active',
                  archiveRelativePath: 'runtime-control/active',
                  action: 'runtime-active',
                  sourceDigest: await physicalCutover.treeDigest(archivedActive),
                  state: 'archived',
                  moveMode: 'rename'
                }],
                results: [], preservedEvidence: {}, unknownEvidence: {}
              }));
            } else if (artifact === 'invalid-journal') {
              await fs.writeFile(journalPath, '{invalid journal');
            } else if (artifact === 'invalid-request') {
              await fs.writeFile(requestPath, '{invalid request');
            }
            const watched = [journalPath, requestPath, paths.rootPointerPath, paths.rootPendingPath, paths.runtimeEpochPath];
            const readWatched = () => Promise.all(watched.map(async (file) => {
              try { return await fs.readFile(file); }
              catch (error) { if (error.code === 'ENOENT') return null; throw error; }
            }));
            const beforeFiles = await readWatched();
            const beforeTree = await physicalCutover.treeDigest(scope);
            const authority = new kernel.RootAuthority(() => paths.dataRootPath);
            let rejection;
            try { await invoke(authority, scope); } catch (error) { rejection = error; }
            // Check bytes AND the complete tree, even when the eventual error code looks correct.
            assert.deepEqual(await readWatched(), beforeFiles, 'journal/request/pointer/pending/epoch changed');
            assert.equal(await physicalCutover.treeDigest(scope), beforeTree, 'data/archive tree changed');
            assert.equal(rejection?.code, pointerKind === 'future'
              ? 'runtime-epoch-newer-than-extension' : 'root-binding-invalid');
          } finally {
            await fs.rm(scope, { recursive: true, force: true });
          }
        });
      }
    }
  }
});

for (const previousEpoch of [3, 4]) test(`旧 epoch ${previousEpoch} 整根归档到 epoch 5，配置和 Workspace保持原样`, async () => {
  const runtimeScopeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-runtime-epoch-reset-'));
  let runtime;
  try {
    const dataRootPath = path.join(runtimeScopeRoot, '.limcode-runtime', 'active');
    const paths = kernel.createRuntimeRootPaths(dataRootPath);
    assert.ok(previousEpoch > 0);
    const previousBinding = {
      paths,
      dataSetId: 'previous-data-set',
      rootInstanceId: 'previous-root-instance',
      rootGeneration: 7,
      pointerRevision: 9,
      runtimeKernelEpoch: previousEpoch
    };
    const previousEpochManifest = {
      kind: 'limcode-runtime-kernel-epoch',
      runtimeKernelEpoch: previousEpoch,
      dataSetId: previousBinding.dataSetId,
      rootInstanceId: previousBinding.rootInstanceId,
      rootGeneration: previousBinding.rootGeneration,
      initializedAt: '2026-08-12T10:32:06.768Z'
    };
    const preservedSettingsPath = path.join(runtimeScopeRoot, 'settings-preserved.json');
    const preservedWorkspacePath = path.join(runtimeScopeRoot, 'workspace-source.ts');
    const archivedSentinelRelativePath = path.join('active', 'previous-runtime-sentinel.txt');

    await fs.mkdir(paths.casRootPath, { recursive: true });
    await fs.writeFile(paths.databasePath, 'previous-runtime-database\n');
    await fs.writeFile(paths.runtimeEpochPath, `${JSON.stringify(previousEpochManifest, null, 2)}\n`);
    await fs.writeFile(paths.rootPointerPath, `${JSON.stringify(previousBinding, null, 2)}\n`);
    await fs.writeFile(
      path.join(path.dirname(paths.rootPointerPath), archivedSentinelRelativePath),
      'previous-runtime\n'
    );
    await fs.writeFile(preservedSettingsPath, 'preserved-setting\n');
    await fs.writeFile(preservedWorkspacePath, 'preserved-workspace\n');

    const authority = new kernel.RootAuthority(() => dataRootPath);
    const result = await new VscodeReliableKernelCutoverCoordinator(
      authority,
      runtimeScopeRoot
    ).ensureCurrentRoot();

    assert.equal(result.initialized, true);
    assert.equal(result.cutoverPerformed, false);
    assert.equal(result.epochResetFrom, previousEpoch);
    assert.equal(result.binding.runtimeKernelEpoch, kernel.RUNTIME_KERNEL_EPOCH);
    assert.equal(
      path.dirname(result.epochResetBackupPath),
      path.join(runtimeScopeRoot, VSCODE_INCOMPATIBLE_RUNTIME_BACKUPS_DIRECTORY)
    );
    assert.equal(
      await fs.readFile(path.join(result.epochResetBackupPath, archivedSentinelRelativePath), 'utf8'),
      'previous-runtime\n'
    );
    const archivedPointer = JSON.parse(await fs.readFile(
      path.join(result.epochResetBackupPath, 'root-binding.json'),
      'utf8'
    ));
    assert.equal(archivedPointer.runtimeKernelEpoch, previousEpoch);
    assert.equal(await fs.readFile(preservedSettingsPath, 'utf8'), 'preserved-setting\n');
    assert.equal(await fs.readFile(preservedWorkspacePath, 'utf8'), 'preserved-workspace\n');
    assert.equal(await fs.readFile(path.join(result.epochResetBackupPath, 'active', 'limcode.sqlite'), 'utf8'), 'previous-runtime-database\n');

    const current = await authority.current();
    assert.equal(current.runtimeKernelEpoch, kernel.RUNTIME_KERNEL_EPOCH);
    assert.notEqual(current.dataSetId, previousBinding.dataSetId);
    runtime = await kernel.RuntimeDatabase.open(authority);
    assert.equal(runtime.binding.dataSetId, current.dataSetId);
  } finally {
    if (runtime) await runtime.close().catch(() => undefined);
    await fs.rm(runtimeScopeRoot, { recursive: true, force: true });
  }
});

test('Windows PowerShell Wrapper 发布完整启动、输出和退出证据', windowsOnly, async () => {
  const result = await runPlatformWrapper({ command: "Write-Output 'wrapper-ok'", timeoutMs: 10_000 });
  try {
    assert.equal(result.run.status, 0, result.run.stderr);
    assert.equal(result.bootstrap.phase, 'identity_ready');
    assert.equal(result.bootstrap.childPid, result.identity.childPid);
    assert.equal(result.identity.startFingerprint.startsWith('win32-process:'), true);
    assert.equal(result.manifest.status, 'exited');
    assert.equal(result.receipt.exitCode, '0');
    assert.equal(result.receipt.terminationReason, 'natural');
    assert.match(result.output, /wrapper-ok/);
    assert.equal(result.run.stderr, '');
    await assert.rejects(fs.access(path.join(result.spoolPath, 'bootstrap.ready')), { code: 'ENOENT' });
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

test('Windows PowerShell Wrapper 超时会终止进程树并发布终态收据', windowsOnly, async () => {
  const startedAt = Date.now();
  const result = await runPlatformWrapper({ command: 'Start-Sleep -Seconds 30', timeoutMs: 1_200 });
  try {
    assert.equal(result.run.status, 0, result.run.stderr);
    assert.equal(result.receipt.terminationReason, 'timed_out');
    assert.equal(result.receipt.stopRequested, false);
    assert.ok(Date.now() - startedAt < 8_000, 'timeout termination exceeded its bounded grace period');
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

test('macOS Bash Wrapper发布完整启动、输出和退出证据', darwinOnly, async () => {
  const result = await runPlatformWrapper({ command: "printf 'wrapper-ok\\n'", timeoutMs: 10_000 });
  try {
    assert.equal(result.run.status, 0, result.run.stderr);
    assert.equal(result.bootstrap.phase, 'identity_ready');
    assert.equal(result.bootstrap.childPid, result.identity.childPid);
    assert.match(result.identity.startFingerprint, /^darwin-ps:\d+:[a-f0-9]{64}$/);
    assert.equal(result.manifest.status, 'exited');
    assert.equal(result.receipt.exitCode, '0');
    assert.equal(result.receipt.terminationReason, 'natural');
    assert.match(result.output, /wrapper-ok/);
    assert.equal(result.run.stderr, '');
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

test('macOS Bash Wrapper超时会终止进程组并发布终态收据', darwinOnly, async () => {
  const startedAt = Date.now();
  const result = await runPlatformWrapper({ command: 'sleep 30', timeoutMs: 1_200 });
  try {
    assert.equal(result.run.status, 0, result.run.stderr);
    assert.equal(result.receipt.terminationReason, 'timed_out');
    assert.equal(result.receipt.stopRequested, false);
    assert.ok(Date.now() - startedAt < 8_000, 'timeout termination exceeded its bounded grace period');
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

test('PowerShell 6不能启用core语义，解析器继续选择已验证的7', () => {
  const source = readFileSync(path.join(distRoot, 'backend/capabilities/windowsPowerShell.js'), 'utf8');
  const resolve = (majors) => {
    const candidates = new Map(majors.map((major, index) => [`C:\\shell-${index}\\pwsh.exe`, major]));
    const module = { exports: {} };
    vm.runInNewContext(source, {
      module,
      exports: module.exports,
      process: { platform: 'win32', env: { PATH: [...candidates.keys()].map(path.win32.dirname).join(';') } },
      require(name) {
        if (name === 'node:path') return path.win32;
        if (name === 'node:fs') return { statSync: () => ({ isFile: () => true }) };
        if (name === 'node:child_process') {
          return { spawnSync: (candidate) => ({ status: 0, stdout: String(candidates.get(candidate)) }) };
        }
        throw new Error(`Unexpected resolver dependency: ${name}`);
      }
    });
    return { ...module.exports.resolveWindowsPowerShell() };
  };
  assert.deepEqual(resolve([6]), { executable: 'powershell.exe', edition: 'desktop' });
  assert.deepEqual(resolve([6, 7]), { executable: 'C:\\shell-1\\pwsh.exe', edition: 'core' });
});
 
function envWithoutPowerShellDiscovery() {
  // A PowerShell 7 parent exports its module paths; a forced 5.1 child must rebuild its own.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !['path', 'programfiles', 'programw6432', 'programfiles(x86)', 'psmodulepath'].includes(key.toLowerCase())
  ));
  env.PATH = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)
    .filter((directory) => !existsSync(path.join(directory.trim().replace(/^"(.*)"$/, '$1'), 'pwsh.exe')))
    .join(path.delimiter);
  return env;
}

function resolveWindowsPowerShellInChild({ cwd, env }) {
  const modulePath = path.join(distRoot, 'backend/capabilities/windowsPowerShell.js');
  const result = childProcess.spawnSync(process.execPath, [
    '-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(modulePath)}).resolveWindowsPowerShell()));`
  ], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return JSON.parse(result.stdout);
}

test('Windows命令壳解析拒绝无法验证为7+的相对PATH候选并回退5.1', windowsOnly, async () => {
  // 相对 PATH 里的 pwsh.exe：候选必须先绝对化再验证；启动不了的文件被探测拒绝，
  // 不得因为文件名就叫 pwsh.exe 而启用 core 语义，也不得随 cwd 漂移出另一个身份。
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-psrelative-'));
  try {
    const anchor = path.join(parent, 'anchor');
    const fakeDirectory = path.join(anchor, 'ps7');
    await fs.mkdir(fakeDirectory, { recursive: true });
    await fs.writeFile(path.join(fakeDirectory, 'pwsh.exe'), 'not a powershell runtime');
    const env = envWithoutPowerShellDiscovery();
    env.PATH = 'ps7';
    const runtime = resolveWindowsPowerShellInChild({ cwd: anchor, env });
    assert.deepEqual(runtime, { executable: 'powershell.exe', edition: 'desktop' });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('相对PATH发现的真实PowerShell 7以稳定的绝对路径返回', {
  skip: process.platform !== 'win32' || windowsPowerShell.resolveWindowsPowerShell().edition !== 'core'
}, async () => {
  const real = windowsPowerShell.resolveWindowsPowerShell();
  const realDirectory = path.dirname(real.executable);
  const anchor = path.parse(realDirectory).root;
  const relativeDirectory = path.relative(anchor, realDirectory);
  assert.ok(relativeDirectory.length > 0 && !path.isAbsolute(relativeDirectory), relativeDirectory);
  const env = envWithoutPowerShellDiscovery();
  // 引号、尾随空项和大小写重复项都不得改变解析结果或候选身份。
  env.PATH = [
    `"${relativeDirectory}"`,
    `${relativeDirectory.toUpperCase()}${path.delimiter}`,
    'limcode-definitely-missing'
  ].join(path.delimiter);
  const runtime = resolveWindowsPowerShellInChild({ cwd: anchor, env });
  assert.equal(runtime.edition, 'core');
  assert.equal(runtime.executable, real.executable);
  assert.ok(path.isAbsolute(runtime.executable), runtime.executable);
});


test('解析器跳过验证失败的候选并继续找到真正的PowerShell 7', {
  skip: process.platform !== 'win32' || windowsPowerShell.resolveWindowsPowerShell().edition !== 'core'
}, async () => {
  const real = windowsPowerShell.resolveWindowsPowerShell();
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-pssweep-'));
  try {
    const fakeDirectory = path.join(parent, 'ps-first');
    await fs.mkdir(fakeDirectory);
    await fs.writeFile(path.join(fakeDirectory, 'pwsh.exe'), 'not a powershell runtime');
    const env = envWithoutPowerShellDiscovery();
    env.PATH = [fakeDirectory, path.dirname(real.executable)].join(path.delimiter);
    const runtime = resolveWindowsPowerShellInChild({ cwd: parent, env });
    assert.equal(runtime.edition, 'core');
    assert.equal(runtime.executable, real.executable);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('Windows包装器实际拉起解析到的PowerShell版本', windowsOnly, async () => {
  const runtime = windowsPowerShell.resolveWindowsPowerShell();
  const result = await runPlatformWrapper({
    command: '[Console]::Out.Write($PSVersionTable.PSEdition)',
    timeoutMs: 15_000,
    suffix: 'edition'
  });
  try {
    assert.equal(result.run.status, 0, result.run.stderr);
    assert.equal(result.output.trim(), runtime.edition === 'core' ? 'Core' : 'Desktop');
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

test('PowerShell 7下管道链式操作符可直接透传给包装器', { skip: process.platform !== 'win32' || windowsPowerShell.resolveWindowsPowerShell().edition !== 'core' }, async () => {
  const result = await runPlatformWrapper({
    command: "Write-Output 'chain-a' && Write-Output 'chain-b'",
    timeoutMs: 15_000,
    suffix: 'chain'
  });
  try {
    assert.equal(result.run.status, 0, result.run.stderr);
    assert.equal(result.receipt.exitCode, '0');
    assert.match(result.output, /chain-a/);
    assert.match(result.output, /chain-b/);
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

test('PowerShell 7的错误与表格输出不再夹带自身的ANSI着色', windowsOnly, async () => {
  const result = await runPlatformWrapper({
    command: "Get-ChildItem -LiteralPath '.' | Format-Table Name; Get-Content -LiteralPath 'C:\limcode-does-not-exist\a.txt'",
    timeoutMs: 15_000,
    suffix: 'ansi'
  });
  try {
    // TERM=dumb 在启动时就关掉了 PowerShell 自身的着色，连 $PSStyle.Reset 拔不掉的尾巴一并没了。
    assert.deepEqual(result.output.match(/\u001b\[[0-9;]*m/g) ?? [], []);
    assert.match(result.output, /limcode-does-not-exist/);
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

test('Windows语法错误不执行部分命令并保留原始输入诊断', windowsOnly, async () => {
  for (const [suffix, env] of [['current', undefined], ['desktop', envWithoutPowerShellDiscovery()]]) {
    const result = await runPlatformWrapper({
      command: "Write-Output 'must-not-run'\nWrite-Output 'b'\n$x = ( 1; 2 )",
      timeoutMs: 15_000,
      suffix: `parseansi_${suffix}`,
      env
    });
    try {
      assert.equal(result.receipt.exitCode, '1');
      assert.doesNotMatch(result.output, /^must-not-run\r?$/m);
      assert.match(result.output, /\$x = \( 1; 2 \)/);
      assert.doesNotMatch(result.output, /\u001b\[[0-9;]*m/g);
    } finally {
      await fs.rm(result.parent, { recursive: true, force: true });
    }
  }
});

test('Windows包装器在禁止脚本文件的进程策略下仍执行命令文本', windowsOnly, async () => {
  // 只限制测试子进程，不改注册表、用户策略或组策略；同样的 Restricted 策略会拒绝加载 unsigned .ps1。
  for (const [suffix, env] of [['current', undefined], ['desktop', envWithoutPowerShellDiscovery()]]) {
    const result = await runPlatformWrapper({
      command: '[Console]::Out.Write("$((Get-ExecutionPolicy)) policy-ok 中文"); exit 7',
      timeoutMs: 15_000,
      suffix: `restricted_${suffix}`,
      executionPolicy: 'Restricted',
      env
    });
    try {
      assert.equal(result.bootstrap.phase, 'identity_ready');
      assert.equal(result.receipt.exitCode, '7');
      assert.equal(result.output, 'Restricted policy-ok 中文');
    } finally {
      await fs.rm(result.parent, { recursive: true, force: true });
    }
  }
});

test('命令末尾的行注释不会吞掉退出码判定', windowsOnly, async () => {
  // 用分号拼成一行时，# 之后的整条退出码判定链都会变成注释，真实退出码 3 会退化成 1。
  const result = await runPlatformWrapper({
    command: "cmd /c exit 3 # 顺手写个注释",
    timeoutMs: 15_000,
    suffix: 'trailingcomment'
  });
  try {
    assert.equal(result.receipt.exitCode, '3');
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

test('单引号here-string管给解释器时内容完全字面，不需要转义', windowsOnly, async () => {
  // 工具描述推荐用这条路径代替先落盘：双引号、反斜杠、反引号、${x} 都应原样到达 node，退出码也照常回传。
  const result = await runPlatformWrapper({
    command: [
      "@'",
      'console.log("q\\"q b\\\\b `t ${x} 中文");',
      'process.exit(3);',
      "'@ | node -"
    ].join('\n'),
    timeoutMs: 15_000,
    suffix: 'herestring'
  });
  try {
    assert.match(result.output, /q"q b\\b `t \$\{x\} 中文/);
    assert.equal(result.receipt.exitCode, '3');
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

test('Windows包装器支持超过命令行上限的Unicode内联脚本并保留退出码', windowsOnly, async () => {
  const result = await runPlatformWrapper({
    command: [
      "@'",
      `// ${'长脚本'.repeat(8192)}`,
      'console.log("long-inline 中文 😀");',
      'process.exit(7);',
      "'@ | node -"
    ].join('\n'),
    timeoutMs: 15_000,
    suffix: 'long_inline'
  });
  try {
    assert.equal(result.bootstrap.phase, 'identity_ready');
    assert.equal(result.output.trim(), 'long-inline 中文 😀');
    assert.equal(result.receipt.exitCode, '7');
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

test('Windows PowerShell 5.1文件执行保留长脚本Unicode和括号原生退出码', windowsOnly, async () => {
  const env = envWithoutPowerShellDiscovery();
  const result = await runPlatformWrapper({
    command: [
      `# ${'长脚本'.repeat(8192)}`,
      '[Console]::Out.Write("$($PSVersionTable.PSEdition) 中文 😀")',
      '(cmd /c exit 7)'
    ].join('\n'),
    env,
    timeoutMs: 15_000,
    suffix: 'desktop_long_unicode'
  });
  try {
    assert.equal(result.output, 'Desktop 中文 😀');
    assert.equal(result.receipt.exitCode, '7');
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

test('Windows包装器为子进程统一设置Python标准流UTF8编码', windowsOnly, async () => {
  const result = await runPlatformWrapper({
    command: "node -p 'process.env.PYTHONIOENCODING'",
    env: { ...process.env, PYTHONIOENCODING: 'ascii' },
    timeoutMs: 15_000,
    suffix: 'python_encoding'
  });
  try {
    assert.equal(result.output.trim(), 'utf-8');
    assert.equal(result.receipt.exitCode, '0');
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

test('Windows包装器的Python内联脚本保留中文emoji与退出码', windowsOnly, async (context) => {
  const python = childProcess.spawnSync('python', ['--version'], {
    stdio: 'ignore', windowsHide: true, timeout: 5_000
  });
  if (python.error || python.status !== 0) {
    context.skip('This end-to-end check requires Python on PATH.');
    return;
  }
  const result = await runPlatformWrapper({
    command: [
      "@'",
      'import sys',
      'print(sys.stdout.encoding)',
      'print("中文测试 😀")',
      'sys.exit(7)',
      "'@ | python -"
    ].join('\n'),
    env: { ...process.env, PYTHONIOENCODING: 'ascii' },
    timeoutMs: 15_000,
    suffix: 'python_unicode'
  });
  try {
    assert.match(result.output, /^utf-8\r?\n中文测试 😀\r?\n$/);
    assert.equal(result.receipt.exitCode, '7');
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

test('PowerShell 7括号内已恢复的链式命令不会被5.1修正误报失败', {
  skip: process.platform !== 'win32' || windowsPowerShell.resolveWindowsPowerShell().edition !== 'core'
}, async () => {
  const result = await runPlatformWrapper({
    command: "(Get-Item -LiteralPath './limcode-missing-item' -ErrorAction SilentlyContinue || Write-Output 'recovered')",
    timeoutMs: 15_000,
    suffix: 'parenthesized_recovery'
  });
  try {
    assert.equal(result.output.trim(), 'recovered');
    assert.equal(result.receipt.exitCode, '0');
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

test('Windows解析错误等待身份记录完成后才退出并保留诊断', windowsOnly, async () => {
  const result = await runPlatformWrapper({
    command: "Write-Output 'must-not-run'\n$broken = ( 1; 2 )",
    timeoutMs: 15_000,
    suffix: 'parse_after_identity',
    fingerprintDelayMs: 1_500
  });
  try {
    assert.equal(result.bootstrap.phase, 'identity_ready');
    assert.equal(result.bootstrap.childPid, result.identity.childPid);
    assert.equal(result.receipt.exitCode, '1');
    assert.match(result.output, /\$broken/);
    assert.doesNotMatch(result.output, /^must-not-run\r?$/m);
    assert.doesNotMatch(result.output, /\u001b\[/);
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

test('concurrent Windows cold starts all publish durable bootstrap and identity evidence', windowsOnly, async () => {
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => runPlatformWrapper({
    command: `Write-Output 'cold-${index}'`,
    timeoutMs: 15_000,
    suffix: `cold_${index}`
  })));
  try {
    for (const [index, result] of results.entries()) {
      assert.equal(result.run.status, 0, result.run.stderr);
      assert.equal(result.bootstrap.phase, 'identity_ready');
      assert.equal(result.bootstrap.childPid, result.identity.childPid);
      assert.match(result.output, new RegExp(`cold-${index}`));
    }
  } finally {
    await Promise.all(results.map((result) => fs.rm(result.parent, { recursive: true, force: true })));
  }
});

test('a pre-identity Windows spawn failure leaves bounded durable failure evidence', windowsOnly, async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-wrapper-failure-'));
  const spoolLocator = 'process_win32_failure';
  const spoolPath = path.join(parent, spoolLocator);
  await fs.mkdir(spoolPath);
  const command = "Write-Output 'must-not-run'";
  const createdAt = new Date().toISOString();
  const request = {
    kind: processProtocol.PROCESS_WRAPPER_PROTOCOL,
    processId: 'process_win32_failure',
    stableNonce: '0123456789abcdef0123456789abcdef',
    command,
    cwd: path.join(parent, 'missing-cwd'),
    commandDigest: createHash('sha256').update(command).digest('hex'),
    spoolLocator,
    executionTimeoutMs: 10_000,
    executionDeadlineAt: new Date(Date.parse(createdAt) + 10_000).toISOString(),
    maxOutputBytes: 1024 * 1024,
    createdAt
  };
  const launchPath = path.join(spoolPath, 'launch.json');
  await fs.writeFile(launchPath, `${JSON.stringify(request, null, 2)}\n`);
  try {
    const run = await runWrapperProcess(launchPath, 15_000);
    assert.notEqual(run.status, 0);
    const bootstrap = processProtocol.parseWrapperBootstrapReceipt(JSON.parse(
      await fs.readFile(path.join(spoolPath, processProtocol.PROCESS_WRAPPER_BOOTSTRAP_FILE), 'utf8')
    ));
    const failure = processProtocol.parseWrapperLaunchFailureReceipt(JSON.parse(
      await fs.readFile(path.join(spoolPath, processProtocol.PROCESS_WRAPPER_LAUNCH_FAILURE_FILE), 'utf8')
    ));
    assert.equal(bootstrap.phase, 'wrapper_spawned');
    assert.equal(failure.phase, 'wrapper_spawned');
    assert.equal(failure.commandReleased, false);
    assert.equal(failure.childPid, null);
    assert.ok(failure.errorMessage.length <= 2_048);
    assert.doesNotMatch(failure.errorMessage, /must-not-run/);
    await assert.rejects(fs.access(path.join(spoolPath, 'identity.json')), { code: 'ENOENT' });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('host consumes durable pre-identity failure instead of waiting for outcome_unknown', windowsOnly, async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-wrapper-host-failure-'));
  const candidate = await kernel.resetCandidateRuntimeRoot(parent);
  const database = await kernel.RuntimeDatabase.open(candidate.authority, { hostBootId: 'wrapper-host-failure' });
  const store = new kernel.ContentAddressedStore(candidate.authority, candidate.binding);
  const effects = new kernel.EffectControlPlane(database, store);
  const processes = new kernel.ProcessControlPlane(
    database,
    store,
    effects,
    candidate.authority,
    candidate.binding
  );
  try {
    const now = new Date().toISOString();
    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: 'wrapper-host-failure', title: 'failure', status: 'active', created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: 'wrapper-host-failure-turn', conversation_id: 'wrapper-host-failure', status: 'active',
        created_at: now, updated_at: now, terminal_at: null
      }),
      kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
        id: 'wrapper-host-failure-lease', conversation_id: 'wrapper-host-failure',
        turn_id: 'wrapper-host-failure-turn', owner_id: 'wrapper-host-failure-owner',
        host_boot_id: database.hostBootId, generation: 1n, acquired_at: now,
        expires_at: '2099-01-01T00:00:00.000Z'
      })
    ]);
    const toolCallId = 'wrapper-host-failure-tool';
    await effects.createToolCall({
      source: { kind: 'callback', key: toolCallId },
      toolCallId,
      turnId: 'wrapper-host-failure-turn',
      toolName: 'shell',
      arguments: { command: "Write-Output 'must-not-run'" }
    });
    const prepared = await processes.prepareStart({
      source: { kind: 'internal', key: toolCallId },
      toolCallId,
      command: "Write-Output 'must-not-run'",
      cwd: path.join(parent, 'missing-cwd')
    });
    const startedAt = Date.now();
    const dispatched = await processes.dispatchStart(prepared.effect.effectIntentId);
    assert.equal(dispatched.observation.state, 'launch_failed');
    assert.match(dispatched.observation.launch.error, /Wrapper launch failed during wrapper_spawned/);
    assert.ok(Date.now() - startedAt < 5_000, 'durable failure should beat the old fixed wait window');
  } finally {
    await processes.dispose().catch(() => undefined);
    await database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
});

async function runPlatformWrapper({ command, timeoutMs, suffix = 'test', env, fingerprintDelayMs = 0, executionPolicy }) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-wrapper-${process.platform}-`));
  const spoolLocator = `process_${process.platform}_${suffix}`;
  const spoolPath = path.join(parent, spoolLocator);
  await fs.mkdir(spoolPath);
  const createdAt = new Date().toISOString();
  const request = {
    kind: processProtocol.PROCESS_WRAPPER_PROTOCOL,
    processId: spoolLocator,
    stableNonce: '0123456789abcdef0123456789abcdef',
    command,
    cwd: parent,
    commandDigest: createHash('sha256').update(command).digest('hex'),
    spoolLocator,
    executionTimeoutMs: timeoutMs,
    executionDeadlineAt: new Date(Date.parse(createdAt) + timeoutMs).toISOString(),
    maxOutputBytes: 1024 * 1024,
    createdAt
  };
  const launchPath = path.join(spoolPath, 'launch.json');
  await fs.writeFile(launchPath, `${JSON.stringify(request, null, 2)}\n`);
  const preloadPath = fingerprintDelayMs || executionPolicy ? path.join(parent, 'wrapper-preload.cjs') : undefined;
  if (preloadPath) {
    await fs.writeFile(preloadPath, [
      ...(fingerprintDelayMs ? [
        `const protocol = require(${JSON.stringify(path.join(distRoot, 'backend/reliableKernel/processProtocol.js'))});`,
        'const readFingerprint = protocol.readProcessStartFingerprint;',
        `protocol.readProcessStartFingerprint = (pid) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${fingerprintDelayMs}); return readFingerprint(pid); };`
      ] : []),
      ...(executionPolicy ? [
        "const childProcess = require('node:child_process');",
        'const spawn = childProcess.spawn;',
        'childProcess.spawn = (file, args, options) => {',
        "  const index = args.indexOf('-Command');",
        '  if (index !== -1) {',
        '    args = [...args];',
        `    args[index + 1] = ${JSON.stringify(`Set-ExecutionPolicy -Scope Process -ExecutionPolicy ${executionPolicy} -Force; `)} + args[index + 1];`,
        '  }',
        '  return spawn(file, args, options);',
        '};'
      ] : [])
    ].join('\n'));
  }
  const run = await runWrapperProcess(launchPath, 15_000, env, preloadPath);
  assert.equal(run.status, 0, run.stderr);

  const bootstrap = processProtocol.parseWrapperBootstrapReceipt(JSON.parse(
    await fs.readFile(path.join(spoolPath, processProtocol.PROCESS_WRAPPER_BOOTSTRAP_FILE), 'utf8')
  ));
  const identity = JSON.parse(await fs.readFile(path.join(spoolPath, 'identity.json'), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(spoolPath, 'manifest.json'), 'utf8'));
  const receipt = JSON.parse(await fs.readFile(path.join(spoolPath, 'exit-receipt.json'), 'utf8'));
  const chunkRoot = path.join(spoolPath, 'chunks');
  const chunks = (await fs.readdir(chunkRoot)).sort();
  const output = Buffer.concat(await Promise.all(chunks.map((name) => fs.readFile(path.join(chunkRoot, name))))).toString('utf8');
  return { parent, spoolPath, run, bootstrap, identity, manifest, receipt, output };
}

function runWrapperProcess(launchPath, timeoutMs, env, preloadPath) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [
      ...(preloadPath ? ['--require', preloadPath] : []),
      path.join(distRoot, 'backend/reliableKernel/processWrapper.js'),
      launchPath
    ], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`wrapper test timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr });
    });
  });
}
