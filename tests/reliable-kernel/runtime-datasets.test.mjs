import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  completeVscodeRuntimeDataSetSelection,
  listVscodeRuntimeDataSets,
  resolveVscodeRuntimeDataRoot,
  resolveVscodeRuntimeDataSet,
  resolveVscodeRuntimeSelectionPath,
  resolveVscodeWorkspaceRuntimePlacement,
  resolveVscodeWorkspaceRuntimeScope,
  resolveVscodeWorkspaceRuntimeScopeRoot,
  selectVscodeRuntimeDataSet,
  VscodeRuntimeDataSetSelectionRequiredError
} = require('../../dist/extension/backend/reliableKernel/vscodeRootAuthority.js');
const { RootAuthority } = require('../../dist/extension/backend/reliableKernel/rootAuthority.js');
const { ownProcessStartIdentity } = require('../../dist/extension/backend/reliableKernel/runtimeClaimPrimitives.js');
const { recoverInterruptedPhysicalCutover, persistPhysicalCutoverRequest } = require('../../dist/extension/backend/reliableKernel/physicalCutover.js');

const scope = (name) => resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: [`file:///workspace/${name}`] });
const fixture = async (run) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-runtime-datasets-'));
  try { await run(root, { globalStoragePath: root }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
};

async function createRoot(scopeRoot, epoch = 4) {
  const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot }));
  let binding = await authority.initializeEmptyRoot(async (next) => {
    await fs.mkdir(next.paths.casRootPath, { recursive: true });
    // Selection deliberately checks physical identity, not database schema/integrity. Runtime's
    // existing startup gate owns that validation, so this fixture never opens a real database.
    await fs.writeFile(next.paths.databasePath, 'selection-fixture');
  });
  if (epoch !== 4) {
    binding = { ...binding, runtimeKernelEpoch: epoch };
    await fs.writeFile(binding.paths.rootPointerPath, JSON.stringify(binding));
    const manifest = JSON.parse(await fs.readFile(binding.paths.runtimeEpochPath, 'utf8'));
    await fs.writeFile(binding.paths.runtimeEpochPath, JSON.stringify({ ...manifest, runtimeKernelEpoch: epoch }));
  }
  return binding;
}

test('无旧库时只预留固定默认根，初始化完成后根丢失不能隐式重建', async () => fixture(async (root, paths) => {
  assert.deepEqual(await listVscodeRuntimeDataSets(paths), []);
  const first = await resolveVscodeWorkspaceRuntimePlacement(paths, scope('first'));
  assert.equal(first.runtimeScopeRootPath, root);
  const selectionPath = resolveVscodeRuntimeSelectionPath(paths);
  assert.equal(JSON.parse(await fs.readFile(selectionPath, 'utf8')).initialized, false);
  await assert.rejects(completeVscodeRuntimeDataSetSelection(paths), { code: 'runtime-dataset-invalid' });
  await createRoot(root);
  await completeVscodeRuntimeDataSetSelection(paths);
  assert.equal(JSON.parse(await fs.readFile(selectionPath, 'utf8')).initialized, true);
  const second = await resolveVscodeWorkspaceRuntimePlacement(paths, scope('different'));
  assert.equal(second.runtimeDataRootPath, first.runtimeDataRootPath);
  await fs.rm(path.join(root, '.limcode-runtime'), { recursive: true });
  await assert.rejects(resolveVscodeWorkspaceRuntimePlacement(paths, scope('third')), { code: 'runtime-dataset-invalid' });
}));

test('唯一完整旧根原地复用，RootBinding、数据集身份和CAS不改写', async () => fixture(async (root, paths) => {
  const binding = await createRoot(root);
  await fs.writeFile(path.join(binding.paths.casRootPath, 'retained.bin'), 'retained');
  const before = await fs.readFile(binding.paths.rootPointerPath, 'utf8');
  const placement = await resolveVscodeWorkspaceRuntimePlacement(paths, scope('unrelated'));
  assert.equal(placement.runtimeScopeRootPath, root);
  assert.equal(await fs.readFile(binding.paths.rootPointerPath, 'utf8'), before);
  assert.equal(await fs.readFile(path.join(binding.paths.casRootPath, 'retained.bin'), 'utf8'), 'retained');
  const [candidate] = await listVscodeRuntimeDataSets(paths);
  assert.equal(candidate.id, 'default');
  assert.equal(candidate.dataSetId, binding.dataSetId);
  assert.equal(candidate.selected, true);
  await assert.rejects(fs.stat(path.join(root, '.limcode-workspace-runtimes', 'legacy-owner')), { code: 'ENOENT' });
}));

test('唯一旧workspace根原地选择，包括epoch 3有界升级入口', async () => fixture(async (root, paths) => {
  const old = scope('previous');
  const oldRoot = resolveVscodeWorkspaceRuntimeScopeRoot(paths, old);
  const binding = await createRoot(oldRoot, 3);
  const placement = await resolveVscodeWorkspaceRuntimePlacement(paths, scope('new-window'));
  assert.equal(placement.runtimeScopeRootPath, oldRoot);
  const [candidate] = await listVscodeRuntimeDataSets(paths);
  assert.equal(candidate.runtimeKernelEpoch, 3);
  assert.equal(candidate.dataSetId, binding.dataSetId);
  assert.equal(candidate.selected, true);
}));

test('多旧库必须显式选库，首窗口及当前folder不能抢占', async () => fixture(async (root, paths) => {
  await createRoot(root);
  const otherScope = scope('other');
  const otherRoot = resolveVscodeWorkspaceRuntimeScopeRoot(paths, otherScope);
  await createRoot(otherRoot);
  await assert.rejects(resolveVscodeWorkspaceRuntimePlacement(paths, otherScope), (error) => {
    assert.ok(error instanceof VscodeRuntimeDataSetSelectionRequiredError);
    assert.equal(error.code, 'runtime-dataset-selection-required');
    assert.deepEqual(error.candidates.map((item) => item.id), ['default', `workspace:${otherScope.key}`]);
    assert.ok(error.candidates.every((item) => !item.selected));
    return true;
  });
  await assert.rejects(fs.stat(resolveVscodeRuntimeSelectionPath(paths)), { code: 'ENOENT' });
  await selectVscodeRuntimeDataSet(paths, `workspace:${otherScope.key}`);
  const placement = await resolveVscodeWorkspaceRuntimePlacement(paths, scope('third'));
  assert.equal(placement.runtimeScopeRootPath, otherRoot);
}));

test('固定选择不受workspace保存、增删重排文件夹影响，正常启动不扫描旧scope', async () => fixture(async (root, paths) => {
  await createRoot(root);
  const first = await resolveVscodeWorkspaceRuntimePlacement(paths, scope('first'));
  const invalidSibling = resolveVscodeWorkspaceRuntimeScopeRoot(paths, scope('broken-old'));
  await fs.mkdir(path.join(invalidSibling, '.limcode-runtime'), { recursive: true });
  await fs.writeFile(path.join(invalidSibling, '.limcode-runtime', 'root-binding.json'), '{}');
  for (const input of [
    {},
    { workspaceFolderUris: ['file:///b', 'file:///a'] },
    { workspaceFolderUris: ['file:///a', 'file:///b'] },
    { workspaceFolderUris: ['file:///b'] },
    { workspaceFileUri: 'file:///saved.code-workspace', workspaceFolderUris: ['file:///a', 'file:///b'] }
  ]) {
    const placement = await resolveVscodeWorkspaceRuntimePlacement(paths, resolveVscodeWorkspaceRuntimeScope(input));
    assert.equal(placement.runtimeDataRootPath, first.runtimeDataRootPath);
  }
  await assert.rejects(listVscodeRuntimeDataSets(paths), { code: 'runtime-dataset-invalid' });
}));

test('活跃或身份不明Host拒绝切换，原选择完整保留', async () => fixture(async (root, paths) => {
  const current = await createRoot(root);
  await resolveVscodeWorkspaceRuntimePlacement(paths, scope('first'));
  const otherScope = scope('other');
  await createRoot(resolveVscodeWorkspaceRuntimeScopeRoot(paths, otherScope));
  const before = await fs.readFile(resolveVscodeRuntimeSelectionPath(paths), 'utf8');
  const livenessRoot = path.join(current.paths.dataRootPath, 'host-liveness');
  await fs.mkdir(livenessRoot);
  await fs.writeFile(path.join(livenessRoot, 'live-host.json'), JSON.stringify({
    kind: 'limcode-runtime-host-liveness',
    dataSetId: current.dataSetId,
    rootInstanceId: current.rootInstanceId,
    rootGeneration: current.rootGeneration,
    hostBootId: 'live-host',
    livenessId: 'live-host-record',
    processId: process.pid,
    processStartIdentity: ownProcessStartIdentity(),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString()
  }));
  await assert.rejects(selectVscodeRuntimeDataSet(paths, `workspace:${otherScope.key}`), { code: 'runtime-hosts-active' });
  assert.equal(await fs.readFile(resolveVscodeRuntimeSelectionPath(paths), 'utf8'), before);
  assert.equal((await resolveVscodeWorkspaceRuntimePlacement(paths, scope('attached'))).runtimeDataRootPath, current.paths.dataRootPath);
  // Idempotent selection does not switch the root and remains safe while attached.
  assert.equal((await selectVscodeRuntimeDataSet(paths, 'default')).selected, true);
  await fs.rm(livenessRoot, { recursive: true });
  assert.equal((await selectVscodeRuntimeDataSet(paths, `workspace:${otherScope.key}`)).selected, true);
}));

test('已完成pending根保留原位置交给既有恢复入口', async () => fixture(async (root, paths) => {
  const binding = await createRoot(root);
  await fs.rename(binding.paths.rootPointerPath, binding.paths.rootPendingPath);
  const placement = await resolveVscodeWorkspaceRuntimePlacement(paths, scope('first'));
  assert.equal(placement.runtimeDataRootPath, binding.paths.dataRootPath);
  await assert.rejects(fs.stat(binding.paths.rootPointerPath), { code: 'ENOENT' });
  assert.ok(await fs.stat(binding.paths.rootPendingPath));
}));

test('epoch 3升级已刷出epoch 4但未发布pointer的精确恢复窗口仍可选中', async () => fixture(async (root, paths) => {
  const binding = await createRoot(root, 3);
  const pending = {
    ...binding, runtimeKernelEpoch: 4,
    rootGeneration: binding.rootGeneration + 1, pointerRevision: binding.pointerRevision + 1
  };
  await fs.writeFile(binding.paths.rootPendingPath, JSON.stringify(pending));
  const epoch = JSON.parse(await fs.readFile(binding.paths.runtimeEpochPath, 'utf8'));
  await fs.writeFile(binding.paths.runtimeEpochPath, JSON.stringify({
    ...epoch, runtimeKernelEpoch: pending.runtimeKernelEpoch, rootGeneration: pending.rootGeneration
  }));
  const placement = await resolveVscodeWorkspaceRuntimePlacement(paths, scope('first'));
  assert.equal(placement.runtimeDataRootPath, binding.paths.dataRootPath);
  assert.equal(JSON.parse(await fs.readFile(binding.paths.rootPointerPath, 'utf8')).runtimeKernelEpoch, 3);
}));

test('真实进程在cutover归档active后退出，选库仍放行原journal恢复且不改写身份', async () => fixture(async (root, paths) => {
  const binding = await createRoot(root);
  await resolveVscodeWorkspaceRuntimePlacement(paths, scope('first'));
  const source = `
    const { RootAuthority } = require(${JSON.stringify(require.resolve('../../dist/extension/backend/reliableKernel/rootAuthority.js'))});
    const { persistPhysicalCutoverRequest, performPhysicalCutover } = require(${JSON.stringify(require.resolve('../../dist/extension/backend/reliableKernel/physicalCutover.js'))});
    (async () => {
      const root = ${JSON.stringify(root)};
      const authority = new RootAuthority(() => ${JSON.stringify(binding.paths.dataRootPath)});
      await persistPhysicalCutoverRequest(root, {
        noActiveTurn: true, noBackgroundProcess: true, noPendingProviderStream: true, noPersistInflight: true
      });
      await performPhysicalCutover(root, authority, async () => { throw new Error('initializer unexpectedly reached'); }, {
        onFaultPoint(point) { if (point === 'before-runtime-activation') process.exit(91); }
      });
    })().catch((error) => { console.error(error); process.exit(1); });
  `;
  const child = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8' });
  assert.equal(child.status, 91, child.stderr);
  await assert.rejects(fs.stat(binding.paths.databasePath), { code: 'ENOENT' });
  const placement = await resolveVscodeWorkspaceRuntimePlacement(paths, scope('after-crash'));
  assert.equal(placement.runtimeDataRootPath, binding.paths.dataRootPath);
  assert.equal((await resolveVscodeRuntimeDataSet(paths, 'default')).requiresRecovery, true);
  await assert.rejects(completeVscodeRuntimeDataSetSelection(paths), { code: 'runtime-dataset-invalid' });
  const authority = new RootAuthority(() => binding.paths.dataRootPath);
  assert.equal(await recoverInterruptedPhysicalCutover(root, authority), 'rolled-back');
  assert.deepEqual(await authority.current(), binding);
  assert.equal(await fs.readFile(binding.paths.databasePath, 'utf8'), 'selection-fixture');
  assert.equal((await resolveVscodeRuntimeDataSet(paths, 'default')).requiresRecovery, undefined);
}));

test('仅cutover request不能掩盖丢失数据库，首次未完成pending仍保持拒绝', async () => {
  await fixture(async (root, paths) => {
    const binding = await createRoot(root);
    await persistPhysicalCutoverRequest(root, {
      noActiveTurn: true, noBackgroundProcess: true, noPendingProviderStream: true, noPersistInflight: true
    });
    await fs.rm(binding.paths.databasePath);
    await assert.rejects(resolveVscodeWorkspaceRuntimePlacement(paths, scope('request-only')), { code: 'runtime-dataset-invalid' });
    await assert.rejects(fs.stat(resolveVscodeRuntimeSelectionPath(paths)), { code: 'ENOENT' });
  });
  await fixture(async (root, paths) => {
    const binding = await createRoot(root);
    await fs.rename(binding.paths.rootPointerPath, binding.paths.rootPendingPath);
    await fs.rm(binding.paths.dataRootPath, { recursive: true });
    await assert.rejects(resolveVscodeWorkspaceRuntimePlacement(paths, scope('incomplete-pending')), { code: 'runtime-dataset-invalid' });
    await assert.rejects(fs.stat(resolveVscodeRuntimeSelectionPath(paths)), { code: 'ENOENT' });
  });
});

test('损坏指针、无binding数据、丢失CAS和epoch身份漂移均拒绝且不发布新选择', async () => {
  for (const mode of ['malformed', 'unbound', 'missing-cas', 'epoch-mismatch']) {
    await fixture(async (root, paths) => {
      const binding = await createRoot(root);
      if (mode === 'malformed') await fs.writeFile(binding.paths.rootPointerPath, '{}');
      if (mode === 'unbound') await fs.rm(binding.paths.rootPointerPath);
      if (mode === 'missing-cas') await fs.rm(binding.paths.casRootPath, { recursive: true });
      if (mode === 'epoch-mismatch') {
        const epoch = JSON.parse(await fs.readFile(binding.paths.runtimeEpochPath, 'utf8'));
        await fs.writeFile(binding.paths.runtimeEpochPath, JSON.stringify({ ...epoch, dataSetId: 'wrong-data-set' }));
      }
      await assert.rejects(resolveVscodeWorkspaceRuntimePlacement(paths, scope('first')), { code: 'runtime-dataset-invalid' });
      await assert.rejects(fs.stat(resolveVscodeRuntimeSelectionPath(paths)), { code: 'ENOENT' });
      assert.equal(await fs.readFile(binding.paths.databasePath, 'utf8'), 'selection-fixture');
    });
  }
});

test('已选指针损坏不能回退，candidate id和RootBinding路径不能越界', async () => fixture(async (root, paths) => {
  const binding = await createRoot(root);
  await resolveVscodeWorkspaceRuntimePlacement(paths, scope('first'));
  await assert.rejects(resolveVscodeRuntimeDataSet(paths, 'workspace:../../outside'), { code: 'runtime-dataset-invalid' });
  await fs.writeFile(resolveVscodeRuntimeSelectionPath(paths), '{invalid');
  await assert.rejects(resolveVscodeWorkspaceRuntimePlacement(paths, scope('second')), { code: 'runtime-dataset-invalid' });
  await fs.rm(resolveVscodeRuntimeSelectionPath(paths));
  await fs.writeFile(binding.paths.rootPointerPath, JSON.stringify({
    ...binding, paths: { ...binding.paths, databasePath: path.join(root, 'another.sqlite') }
  }));
  await assert.rejects(resolveVscodeWorkspaceRuntimePlacement(paths, scope('third')), { code: 'runtime-dataset-invalid' });
}));

test('并发空窗口通过同一admission发布单个完整固定选择', async () => fixture(async (root, paths) => {
  const placements = await Promise.all([
    resolveVscodeWorkspaceRuntimePlacement(paths, scope('one')),
    resolveVscodeWorkspaceRuntimePlacement(paths, scope('two')),
    resolveVscodeWorkspaceRuntimePlacement(paths, resolveVscodeWorkspaceRuntimeScope({}))
  ]);
  assert.ok(placements.every((placement) => placement.runtimeScopeRootPath === root));
  const selection = JSON.parse(await fs.readFile(resolveVscodeRuntimeSelectionPath(paths), 'utf8'));
  assert.equal(selection.id, 'default');
  assert.equal(selection.selectionRevision, 1);
  assert.deepEqual((await fs.readdir(root)).filter((entry) => entry.endsWith('.tmp')), []);
}));
