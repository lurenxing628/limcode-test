import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { publishInitialRuntimeSelection } from './fixtures/runtime-selection.mjs';
const require = createRequire(import.meta.url);
const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT ?? path.resolve('dist/extension');
const registry = require(path.join(compiled, 'backend/reliableKernel/runtimeHistoryRegistry.js'));
const ledger = require(path.join(compiled, 'backend/reliableKernel/runtimeDataSetMergeLedger.js'));
const kernel = require(path.join(compiled, 'backend/reliableKernel/index.js'));
const { RootAuthority } = require(path.join(compiled, 'backend/reliableKernel/rootAuthority.js'));
const roots = require(path.join(compiled, 'backend/reliableKernel/vscodeRootAuthority.js'));

test('partial keeps only inserted conversation provenance across a later failure', async () => {
  const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-partial-ledger-'));
  const paths = { globalStoragePath };
  try {
    const source = { dataSetId: 'source', rootInstanceId: 'source-root', rootGeneration: 1, pointerRevision: 1, contentDigest: 'fixture' };
    const target = { dataSetId: 'target', rootInstanceId: 'target-root' };
    const excluded = [{ conversationId: 'bad', title: '旧对话', code: 'conflict', count: 1 }];
    await ledger.writeRuntimeDataSetMergeLedgerRecord(paths, { candidateId: 'default', source, target,
      state: 'partial', mergedAt: new Date().toISOString(), insertedRows: 1, reusedRows: 0,
      insertedConversations: 1, insertedConversationIds: ['good'], excluded });
    let record = (await ledger.readRuntimeDataSetMergeLedger(paths)).get('default');
    assert.equal(record.state, 'partial');
    assert.deepEqual(record.mergedInto[0].conversationIds, ['good']);
    assert.deepEqual(ledger.runtimeDataSetLastMerge(record).excluded, excluded);
    await ledger.writeRuntimeDataSetMergeLedgerRecord(paths, { candidateId: 'default', source, state: 'failed', code: 'unreadable', message: '读取失败' });
    record = (await ledger.readRuntimeDataSetMergeLedger(paths)).get('default');
    assert.deepEqual(record.lastMerged.excluded, excluded);
    assert.deepEqual(record.mergedInto[0].conversationIds, ['good']);
  } finally { await fs.rm(globalStoragePath, { recursive: true, force: true }); }
});

test('reset discovery repairs missing residual registration without making a pending merge', async () => {
  const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-reset-registry-'));
  const paths = { globalStoragePath };
  try {
    const current = await kernel.initializeEmptyRuntimeRoot(new RootAuthority(() => roots.resolveVscodeRuntimeDataRoot(paths)));
    await publishInitialRuntimeSelection(paths, 'default');
    const backup = path.join(globalStoragePath, '.limcode-workspace-runtimes', 'scopes', 'work', registry.RUNTIME_RESET_BACKUPS_DIRECTORY, '2026-backup');
    await fs.mkdir(backup, { recursive: true });
    await registry.reconcileRuntimeResetBackups(paths);
    let residuals = await registry.readRuntimeHistoryResidual(paths);
    assert.equal(residuals.size, 1);
    const residual = [...residuals.values()][0];
    assert.equal(residual.location.containerPath, backup);
    assert.equal(residual.sourceKind, 'reset');
    assert.equal((await registry.readRuntimeHistoryPending(paths)).size, 0);
    await registry.reconcileRuntimeResetBackups(paths);
    residuals = await registry.readRuntimeHistoryResidual(paths);
    assert.deepEqual([...residuals.values()], [residual]);
    await registry.writeRuntimeHistoryPending(paths, { id: residual.id, sourceKind: 'reset', location: residual.location,
      reason: '用户重新合并', registeredAt: '2000-01-01T00:00:00.000Z' });
    assert.equal((await registry.readRuntimeHistoryPending(paths)).size, 1);
    await ledger.writeRuntimeDataSetMergeLedgerRecord(paths, { candidateId: residual.id, state: 'merged',
      source: { dataSetId: 'source', rootInstanceId: 'source-root', rootGeneration: 1, pointerRevision: 1, contentDigest: 'fixture' },
      target: { dataSetId: current.dataSetId, rootInstanceId: current.rootInstanceId },
      mergedAt: new Date().toISOString(), insertedRows: 0, reusedRows: 0,
      insertedConversations: 0, insertedConversationIds: [] });
    await registry.removeRuntimeHistoryPending(paths, residual.id);
    await registry.removeRuntimeHistoryResidual(paths, residual.id);
    await registry.reconcileRuntimeResetBackups(paths);
    await registry.registerRuntimeResetBackup(paths, backup);
    assert.equal((await registry.readRuntimeHistoryResidual(paths)).size, 0, '完整合并后的物理重置备份不会被补登回未合并列表');
    assert.equal((await fs.stat(backup)).isDirectory(), true, '合并后的备份继续原位保留');
  } finally { await fs.rm(globalStoragePath, { recursive: true, force: true }); }
});

test('registry enumeration tolerates another window completing one source', async () => {
  const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-registry-read-'));
  const paths = { globalStoragePath };
  const originalReaddir = fs.readdir;
  try {
    for (const id of ['workspace:finished', 'workspace:waiting']) await registry.writeRuntimeHistoryPending(paths, {
      id, sourceKind: 'local', location: { kind: 'local', candidateId: id }, reason: '升级收敛', registeredAt: new Date().toISOString()
    });
    const file = await registry.runtimeHistoryRegistryFile(paths, 'pending', 'workspace:finished');
    let completed = false;
    fs.readdir = async function (directory, ...options) {
      const names = await originalReaddir.call(this, directory, ...options);
      if (!completed && path.resolve(directory) === path.dirname(file)) {
        completed = true;
        await registry.removeRuntimeHistoryPending(paths, 'workspace:finished');
      }
      return names;
    };
    assert.deepEqual([...(await registry.readRuntimeHistoryPending(paths)).keys()], ['workspace:waiting']);
    assert.equal(completed, true);
  } finally {
    fs.readdir = originalReaddir;
    await fs.rm(globalStoragePath, { recursive: true, force: true });
  }
});
