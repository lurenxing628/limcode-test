import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT ?? path.resolve('dist/extension');
const registry = require(path.join(compiled, 'backend/reliableKernel/runtimeHistoryRegistry.js'));
const ledger = require(path.join(compiled, 'backend/reliableKernel/runtimeDataSetMergeLedger.js'));

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
  } finally { await fs.rm(globalStoragePath, { recursive: true, force: true }); }
});
