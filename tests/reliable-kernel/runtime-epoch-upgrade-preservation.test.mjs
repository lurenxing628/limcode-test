import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const kernel = require(path.resolve('dist/extension/backend/reliableKernel/index.js'));
const { VscodeReliableKernelCutoverCoordinator } = require(path.resolve(
  'dist/extension/backend/application/reliableKernel/VscodeReliableKernelCutoverCoordinator.js'
));
const { openRuntimeDataSetHistory } = require(path.resolve(
  'dist/extension/backend/reliableKernel/runtimeDataSetHistory.js'
));
const { persistPhysicalCutoverRequest, CUTOVER_JOURNAL_FILE } = require(path.resolve(
  'dist/extension/backend/reliableKernel/physicalCutover.js'
));
const { PHYSICAL_CUTOVER_MANIFEST } = require(path.resolve(
  'dist/extension/backend/reliableKernel/generatedPhysicalCutoverManifest.js'
));

for (const previousEpoch of [3, 4]) {
  test(`published epoch ${previousEpoch} upgrades to 5 with the conversation, message and CAS intact`, async () => {
    const fixture = await createPublishedRuntime(previousEpoch);
    let runtime;
    try {
      const result = await new VscodeReliableKernelCutoverCoordinator(
        fixture.authority, fixture.scope
      ).ensureCurrentRoot();
      assert.equal(result.epochMigratedFrom, previousEpoch);
      assert.equal(result.epochResetFrom, undefined);
      assert.equal(result.binding.dataSetId, fixture.previous.dataSetId);
      assert.equal(result.binding.rootInstanceId, fixture.previous.rootInstanceId);
      assert.equal(result.binding.rootGeneration, fixture.previous.rootGeneration + 1);
      assert.equal(result.binding.pointerRevision, fixture.previous.pointerRevision + 1);
      assert.equal(result.binding.runtimeKernelEpoch, 5);
      assert.equal(await fs.readFile(fixture.settingsPath, 'utf8'), 'keep-settings');
      assert.equal(await fs.readFile(fixture.workspacePath, 'utf8'), 'keep-workspace');

      const backup = new Database(path.join(
        result.epochMigrationBackupPath, `limcode.epoch-${previousEpoch}.sqlite`
      ), { readonly: true, fileMustExist: true });
      try {
        backup.defaultSafeIntegers(true);
        assert.equal(backup.prepare('SELECT runtime_kernel_epoch FROM root_binding').get().runtime_kernel_epoch,
          BigInt(previousEpoch));
        assert.equal(backup.prepare('SELECT count(*) AS n FROM conversation').get().n, 1n);
        assert.equal(backup.prepare('SELECT count(*) AS n FROM schema_manifest').get().n,
          BigInt(previousEpoch === 3 ? 87 : 91));
      } finally { backup.close(); }

      runtime = await kernel.RuntimeDatabase.open(fixture.authority);
      const preserved = await runtime.snapshot([
        kernel.DOMAIN_REPOSITORIES.domain('Conversation').get(fixture.conversationId),
        kernel.DOMAIN_REPOSITORIES.domain('ContentObject').get(fixture.contentId),
        kernel.DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({
          where: { conversation_id: fixture.conversationId }, limit: 10
        })
      ]);
      assert.equal(preserved.snapshot[0].title, fixture.title);
      assert.equal(preserved.snapshot[2].length, 1);
      const cas = new kernel.ContentAddressedStore(fixture.authority, result.binding);
      const bytes = await cas.read(preserved.snapshot[1]);
      assert.equal(JSON.parse(bytes.toString('utf8')).parts[0].text, fixture.message);
      if (fixture.legacyContinuation) {
        const legacy = fixture.legacyContinuation;
        const migrated = await runtime.snapshot([
          kernel.DOMAIN_REPOSITORIES.domain('RuntimeDeliveryIntentLink').get(legacy.ids.deliveryIntentLinkId),
          kernel.DOMAIN_REPOSITORIES.domain('TurnIntentRevision').get(legacy.ids.turnIntentRevisionId),
          kernel.DOMAIN_REPOSITORIES.domain('TurnExecutionPresetRevision').get(legacy.ids.presetRevisionId)
        ]);
        assert.equal(migrated.snapshot[0]?.delivery_id, legacy.deliveryId);
        assert.equal(migrated.snapshot[0]?.turn_intent_id, legacy.ids.turnIntentId);
        const objects = await runtime.snapshot([
          kernel.DOMAIN_REPOSITORIES.domain('ContentObject').get(migrated.snapshot[1].content_object_id),
          kernel.DOMAIN_REPOSITORIES.domain('ContentObject').get(migrated.snapshot[2].preset_object_id)
        ]);
        assert.deepEqual(JSON.parse((await cas.read(objects.snapshot[0])).toString('utf8')),
          { kind: 'runtime_continuation', sourceTurnId: legacy.sourceTurnId, version: 1 });
        assert.deepEqual(JSON.parse((await cas.read(objects.snapshot[1])).toString('utf8')),
          { kind: 'runtime_continuation' });
      }
      await runtime.close();
      runtime = undefined;

      const reopened = await new VscodeReliableKernelCutoverCoordinator(
        fixture.authority, fixture.scope
      ).ensureCurrentRoot();
      assert.equal(reopened.initialized, false);
      assert.equal(reopened.epochMigratedFrom, undefined);
      assert.equal(reopened.binding.dataSetId, fixture.previous.dataSetId);
    } finally {
      await runtime?.close().catch(() => undefined);
      await fs.rm(fixture.cleanupRoot, { recursive: true, force: true });
    }
  });
}

test('the earliest published epoch 3 manifest variant keeps history after upgrading', async () => {
  const fixture = await createPublishedRuntime(3, { modelContextDetail: true });
  try {
    const result = await new VscodeReliableKernelCutoverCoordinator(
      fixture.authority, fixture.scope
    ).ensureCurrentRoot();
    assert.equal(result.epochMigratedFrom, 3);
    assert.equal(result.binding.dataSetId, fixture.previous.dataSetId);
    const database = new Database(fixture.paths.databasePath, { readonly: true, fileMustExist: true });
    try { assert.equal(database.prepare('SELECT count(*) AS n FROM conversation').get().n, 1); }
    finally { database.close(); }
  } finally { await fs.rm(fixture.cleanupRoot, { recursive: true, force: true }); }
});

test('the exact epoch 4 missing-link predecessor upgrades and reconnects old child continuations', async () => {
  const fixture = await createPublishedRuntime(4, { missingDeliveryLink: true });
  let runtime;
  try {
    const result = await new VscodeReliableKernelCutoverCoordinator(
      fixture.authority, fixture.scope
    ).ensureCurrentRoot();
    assert.equal(result.epochMigratedFrom, 4);
    assert.equal(result.binding.dataSetId, fixture.previous.dataSetId);
    runtime = await kernel.RuntimeDatabase.open(fixture.authority);
    const legacy = fixture.legacyContinuation;
    const snapshot = await runtime.snapshot([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').get(fixture.conversationId),
      kernel.DOMAIN_REPOSITORIES.domain('RuntimeDeliveryIntentLink').get(legacy.ids.deliveryIntentLinkId)
    ]);
    assert.equal(snapshot.snapshot[0].title, fixture.title);
    assert.equal(snapshot.snapshot[1].delivery_id, legacy.deliveryId);
  } finally {
    await runtime?.close().catch(() => undefined);
    await fs.rm(fixture.cleanupRoot, { recursive: true, force: true });
  }
});

test('a committed epoch 4 WAL-only conversation survives the SQLite backup and upgrade', async () => {
  const fixture = await createPublishedRuntime(4);
  let writer;
  let runtime;
  try {
    writer = new Database(fixture.paths.databasePath);
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.prepare('INSERT INTO conversation VALUES (?, ?, ?, ?, ?)').run(
      'wal_only_before_upgrade', '未检查点的旧会话', 'active',
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
    );
    assert.ok((await fs.stat(`${fixture.paths.databasePath}-wal`)).size > 0);
    const result = await new VscodeReliableKernelCutoverCoordinator(
      fixture.authority, fixture.scope
    ).ensureCurrentRoot();
    assert.equal(result.epochMigratedFrom, 4);
    runtime = await kernel.RuntimeDatabase.open(fixture.authority);
    const snapshot = await runtime.snapshot([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').get('wal_only_before_upgrade')
    ]);
    assert.equal(snapshot.snapshot[0].title, '未检查点的旧会话');
  } finally {
    await runtime?.close().catch(() => undefined);
    writer?.close();
    await fs.rm(fixture.cleanupRoot, { recursive: true, force: true });
  }
});

test('a deep Runtime path upgrades with a durable backup and opens the preserved conversation', async () => {
  const fixture = await createPublishedRuntime(4, { deepPath: true });
  let runtime;
  try {
    const result = await new VscodeReliableKernelCutoverCoordinator(
      fixture.authority, fixture.scope
    ).ensureCurrentRoot();
    assert.ok(result.epochMigrationBackupPath.length > 260);
    const backup = new Database(kernel.toSqliteFilePath(path.join(
      result.epochMigrationBackupPath, 'limcode.epoch-4.sqlite'
    )), { readonly: true, fileMustExist: true });
    try { assert.equal(backup.prepare('SELECT count(*) AS n FROM conversation').get().n, 1); }
    finally { backup.close(); }
    runtime = await kernel.RuntimeDatabase.open(fixture.authority);
    const snapshot = await runtime.snapshot([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').get(fixture.conversationId)
    ]);
    assert.equal(snapshot.snapshot[0].title, fixture.title);
  } finally {
    await runtime?.close().catch(() => undefined);
    await fs.rm(fixture.cleanupRoot, { recursive: true, force: true });
  }
});

for (const oldState of ['pending-only', 'backed-up']) test(
  `an interrupted published 3→4 ${oldState} state recovers and continues to epoch 5`, async () => {
    const fixture = await createPublishedRuntime(3);
    try {
      const next4 = {
        ...fixture.previous, rootGeneration: fixture.previous.rootGeneration + 1,
        pointerRevision: fixture.previous.pointerRevision + 1, runtimeKernelEpoch: 4
      };
      await fs.writeFile(fixture.paths.rootPendingPath, `${JSON.stringify(next4)}\n`);
      if (oldState === 'backed-up') {
        const controlRoot = path.dirname(fixture.paths.dataRootPath);
        const backupDirectoryName = '20260924T120000Z-deadbeef';
        const backupRoot = path.join(controlRoot, kernel.RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY,
          backupDirectoryName);
        await fs.mkdir(backupRoot, { recursive: true });
        const backupFile = path.join(backupRoot, 'limcode.epoch-3.sqlite');
        const source = new Database(fixture.paths.databasePath, { readonly: true, fileMustExist: true });
        try { await source.backup(backupFile); } finally { source.close(); }
        const backupSha256 = createHash('sha256').update(await fs.readFile(backupFile)).digest('hex');
        await fs.writeFile(path.join(backupRoot, 'root-binding.epoch-3.json'),
          `${JSON.stringify(fixture.previous)}\n`);
        await fs.writeFile(path.join(backupRoot, 'runtime-kernel-epoch.epoch-3.json'),
          await fs.readFile(fixture.paths.runtimeEpochPath));
        await fs.writeFile(path.join(controlRoot, 'epoch-3-to-4-migration.json'), JSON.stringify({
          kind: 'limcode-runtime-epoch-migration', fromEpoch: 3, toEpoch: 4,
          attemptId: 'retired-fixture', state: 'backed_up', backupDirectoryName,
          previousBinding: fixture.previous, nextBinding: next4,
          databaseBackupSha256: backupSha256,
          createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z'
        }));
      }
      const result = await new VscodeReliableKernelCutoverCoordinator(
        fixture.authority, fixture.scope
      ).ensureCurrentRoot();
      assert.equal(result.binding.runtimeKernelEpoch, 5);
      assert.equal(result.binding.dataSetId, fixture.previous.dataSetId);
      const database = new Database(fixture.paths.databasePath, { readonly: true, fileMustExist: true });
      try { assert.equal(database.prepare('SELECT count(*) AS n FROM conversation').get().n, 1); }
      finally { database.close(); }
      await assert.rejects(fs.access(fixture.paths.rootPendingPath), { code: 'ENOENT' });
    } finally { await fs.rm(fixture.cleanupRoot, { recursive: true, force: true }); }
  }
);

test('an exact epoch 4 upgrade recovers at every durable interruption without losing history', async (t) => {
  for (const point of [
    'after-writer-fence', 'before-backup', 'after-backup',
    'after-database-commit', 'after-pointer-publication'
  ]) {
    await t.test(point, async () => {
      const fixture = await createPublishedRuntime(4);
      try {
        await assert.rejects(kernel.migratePreviousRuntimeEpochIfRequired(fixture.authority, {
          onFaultPoint: (at) => { if (at === point) throw new Error(`interrupted at ${point}`); }
        }), /interrupted at/);
        const resumed = await new VscodeReliableKernelCutoverCoordinator(
          fixture.authority, fixture.scope
        ).ensureCurrentRoot();
        assert.equal(resumed.binding.dataSetId, fixture.previous.dataSetId);
        const database = new Database(fixture.paths.databasePath, { readonly: true, fileMustExist: true });
        try {
          assert.equal(database.prepare('SELECT count(*) AS n FROM conversation').get().n, 1);
          assert.equal(database.prepare('SELECT count(*) AS n FROM schema_manifest').get().n, 107);
        } finally { database.close(); }
      } finally { await fs.rm(fixture.cleanupRoot, { recursive: true, force: true }); }
    });
  }
});

test('epoch 4 schema drift leaves the old pointer and conversation untouched', async () => {
  const fixture = await createPublishedRuntime(4);
  try {
    const pointer = await fs.readFile(fixture.paths.rootPointerPath);
    const database = new Database(fixture.paths.databasePath);
    try {
      database.prepare("UPDATE schema_manifest SET client_mapping = 'detail' WHERE domain_key = 'Conversation'").run();
      database.pragma('wal_checkpoint(TRUNCATE)');
    } finally { database.close(); }
    await assert.rejects(
      new VscodeReliableKernelCutoverCoordinator(fixture.authority, fixture.scope).ensureCurrentRoot(),
      (error) => error?.code === 'runtime-epoch-migration-schema-mismatch'
    );
    assert.deepEqual(await fs.readFile(fixture.paths.rootPointerPath), pointer);
    const after = new Database(fixture.paths.databasePath, { readonly: true, fileMustExist: true });
    try {
      assert.equal(after.prepare('SELECT count(*) AS n FROM conversation').get().n, 1);
      assert.equal(after.prepare('SELECT runtime_kernel_epoch FROM root_binding').get().runtime_kernel_epoch, 4);
    } finally { after.close(); }
  } finally { await fs.rm(fixture.cleanupRoot, { recursive: true, force: true }); }
});

test('a damaged migration backup blocks recovery without replacing the old Runtime', async () => {
  const fixture = await createPublishedRuntime(4);
  try {
    await assert.rejects(kernel.migratePreviousRuntimeEpochIfRequired(fixture.authority, {
      onFaultPoint: (point) => { if (point === 'after-backup') throw new Error('stop after backup'); }
    }), /stop after backup/);
    const controlRoot = path.dirname(fixture.paths.dataRootPath);
    const journal = JSON.parse(await fs.readFile(
      path.join(controlRoot, kernel.RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE), 'utf8'
    ));
    const backupFile = path.join(controlRoot, kernel.RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY,
      journal.backupDirectoryName, 'limcode.epoch-4.sqlite');
    await fs.appendFile(backupFile, 'corrupt');
    const pointer = await fs.readFile(fixture.paths.rootPointerPath);
    await assert.rejects(
      new VscodeReliableKernelCutoverCoordinator(fixture.authority, fixture.scope).ensureCurrentRoot(),
      (error) => error?.code === 'runtime-epoch-migration-backup-invalid'
    );
    assert.deepEqual(await fs.readFile(fixture.paths.rootPointerPath), pointer);
    const database = new Database(fixture.paths.databasePath, { readonly: true, fileMustExist: true });
    try { assert.equal(database.prepare('SELECT count(*) AS n FROM conversation').get().n, 1); }
    finally { database.close(); }
  } finally { await fs.rm(fixture.cleanupRoot, { recursive: true, force: true }); }
});

for (const previousEpoch of [3, 4]) {
  test(`explicit epoch ${previousEpoch} data-set upgrade preserves history and attachments while another selected Runtime writes`, async () => {
    const fixture = await createPublishedRuntime(previousEpoch, { workspaceScope: true, attachment: true });
    const storagePaths = { globalStoragePath: fixture.cleanupRoot };
    const currentAuthority = kernel.createVscodeRootAuthority({
      configurationRootPath: fixture.cleanupRoot,
      runtimeDataRootPath: kernel.resolveVscodeRuntimeDataRoot(storagePaths)
    });
    let current;
    try {
      const currentBinding = await kernel.initializeEmptyRuntimeRoot(currentAuthority);
      await kernel.selectVscodeRuntimeDataSet(storagePaths, 'default');
      const selectionPath = kernel.resolveVscodeRuntimeSelectionPath(storagePaths);
      const selection = await fs.readFile(selectionPath);
      current = await kernel.RuntimeDatabase.open(currentAuthority);
      const input = upgradeInput(fixture);
      let concurrentWrite = false;
      const result = await kernel.upgradeRuntimeDataSet(storagePaths, input, {
        onFaultPoint: async (point) => {
          if (point !== 'after-backup') return;
          await current.transaction([kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
            id: 'current-during-old-upgrade', title: '当前库继续提交', status: 'active',
            created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z'
          })]);
          concurrentWrite = true;
        }
      });
      assert.equal(concurrentWrite, true);
      assert.equal(result.migrated, true);
      assert.equal(result.previousEpoch, previousEpoch);
      assert.equal(result.candidateId, input.candidateId);
      assert.equal(result.binding.dataSetId, fixture.previous.dataSetId);
      assert.equal(result.binding.rootInstanceId, fixture.previous.rootInstanceId);
      assert.deepEqual(await fs.readFile(selectionPath), selection);
      assert.deepEqual(await currentAuthority.current(), currentBinding);
      assert.equal((await current.snapshot([
        kernel.DOMAIN_REPOSITORIES.domain('Conversation').get('current-during-old-upgrade')
      ])).snapshot[0].title, '当前库继续提交');
      assert.equal(await fs.readFile(fixture.settingsPath, 'utf8'), 'keep-settings');
      assert.equal(await fs.readFile(fixture.workspacePath, 'utf8'), 'keep-workspace');
      assert.equal((await fs.readdir(path.join(fixture.paths.dataRootPath, 'host-liveness')))
        .filter(name => name.endsWith('.json')).length, 0);

      const reader = await openRuntimeDataSetHistory(storagePaths, input.candidateId);
      try {
        assert.equal((await reader.listConversations()).items[0].title, fixture.title);
        const messages = await reader.readMessages(fixture.conversationId);
        assert.equal(messages.items[0].text, `${fixture.message}\n[附件 preserved.bin]\n`);
      } finally { await reader.close(); }
      const cas = new kernel.ContentAddressedStore(fixture.authority, result.binding);
      assert.deepEqual(await cas.read(fixture.attachment.content), fixture.attachment.bytes);
      const backup = new Database(kernel.toSqliteFilePath(path.join(
        result.backupPath, `limcode.epoch-${previousEpoch}.sqlite`
      )), { readonly: true, fileMustExist: true });
      try {
        assert.equal(backup.prepare('SELECT runtime_kernel_epoch FROM root_binding').get().runtime_kernel_epoch, previousEpoch);
        assert.equal(backup.prepare('SELECT content_object_id FROM attachment WHERE id = ?')
          .get(fixture.attachment.id).content_object_id, fixture.attachment.content.id);
        assert.equal(backup.prepare('SELECT count(*) AS n FROM attachment_link').get().n, 1);
      } finally { backup.close(); }
      const upgraded = new Database(kernel.toSqliteFilePath(result.binding.paths.databasePath), { readonly: true, fileMustExist: true });
      try {
        assert.equal(upgraded.prepare('SELECT content_object_id FROM attachment WHERE id = ?')
          .get(fixture.attachment.id).content_object_id, fixture.attachment.content.id);
        assert.equal(upgraded.prepare('SELECT count(*) AS n FROM attachment_link').get().n, 1);
      } finally { upgraded.close(); }
    } finally {
      await current?.close();
      await fs.rm(fixture.cleanupRoot, { recursive: true, force: true });
    }
  });
}

test('explicit upgrade accepts a selected offline predecessor and validates current-epoch idempotency without selecting or starting it', async () => {
  const fixture = await createPublishedRuntime(4);
  const storagePaths = { globalStoragePath: fixture.cleanupRoot };
  try {
    await kernel.selectVscodeRuntimeDataSet(storagePaths, 'default');
    await fs.rm(kernel.runtimeHostLivenessDirectory(fixture.paths), { recursive: true, force: true });
    const selection = await fs.readFile(kernel.resolveVscodeRuntimeSelectionPath(storagePaths));
    const input = upgradeInput(fixture);
    const upgraded = await kernel.upgradeRuntimeDataSet(storagePaths, input);
    assert.equal(upgraded.migrated, true);
    const before = await preservedFiles(fixture);
    const repeated = await kernel.upgradeRuntimeDataSet(storagePaths, input);
    assert.equal(repeated.migrated, false);
    assert.equal(repeated.previousEpoch, undefined);
    assert.deepEqual(repeated.binding, upgraded.binding);
    assert.deepEqual(await preservedFiles(fixture), before);
    assert.deepEqual(await fs.readFile(kernel.resolveVscodeRuntimeSelectionPath(storagePaths)), selection);
    const database = new Database(kernel.toSqliteFilePath(fixture.paths.databasePath));
    database.exec('ALTER TABLE conversation ADD COLUMN invented TEXT');
    database.close();
    await assert.rejects(kernel.upgradeRuntimeDataSet(storagePaths, input), /DDL drift/);
    await assert.rejects(fs.access(fixture.paths.rootPendingPath), { code: 'ENOENT' });
  } finally { await fs.rm(fixture.cleanupRoot, { recursive: true, force: true }); }
});

test('explicit upgrade refuses changed identity and live or unverifiable target Hosts before changing the predecessor', async (t) => {
  const fixture = await createPublishedRuntime(4);
  const storagePaths = { globalStoragePath: fixture.cleanupRoot };
  try {
    const input = upgradeInput(fixture);
    const before = await preservedFiles(fixture);
    for (const field of ['expectedDataSetId', 'expectedRootInstanceId']) {
      await assert.rejects(kernel.upgradeRuntimeDataSet(storagePaths, { ...input, [field]: 'changed' }),
        { code: 'runtime-data-set-upgrade-identity-mismatch' });
    }
    for (const state of ['live', 'unknown']) await t.test(state, async () => {
      const hostPath = path.join(fixture.paths.dataRootPath, 'host-liveness/upgrade-peer.json');
      const inaccessiblePid = 2147483647;
      const originalKill = process.kill;
      await fs.writeFile(hostPath, JSON.stringify({
        kind: 'limcode-runtime-host-liveness', dataSetId: fixture.previous.dataSetId,
        rootInstanceId: fixture.previous.rootInstanceId, rootGeneration: fixture.previous.rootGeneration,
        hostBootId: 'upgrade-peer', livenessId: 'upgrade-peer-liveness',
        processId: state === 'live' ? process.pid : inaccessiblePid,
        startedAt: '2026-09-01T00:00:00.000Z', heartbeatAt: '2026-09-01T00:00:00.000Z'
      }));
      if (state === 'unknown') process.kill = function (pid, signal) {
        if (pid === inaccessiblePid) throw Object.assign(new Error('inaccessible peer'), { code: 'EPERM' });
        return Reflect.apply(originalKill, process, [pid, signal]);
      };
      try {
        await assert.rejects(kernel.upgradeRuntimeDataSet(storagePaths, input),
          error => error.code === 'runtime-hosts-active' && error.hosts.some(host => host.state === state));
      } finally {
        process.kill = originalKill;
        await fs.rm(hostPath);
      }
    });
    assert.deepEqual(await preservedFiles(fixture), before);
    await assert.rejects(fs.access(fixture.paths.rootPendingPath), { code: 'ENOENT' });
  } finally { await fs.rm(fixture.cleanupRoot, { recursive: true, force: true }); }
});

test('explicit upgrade refuses a symbolic Host directory without modifying the predecessor or outside fixture', async () => {
  const fixture = await createPublishedRuntime(3, { attachment: true });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-upgrade-outside-hosts-'));
  try {
    const sentinel = path.join(outside, 'sentinel.txt');
    await fs.writeFile(sentinel, 'outside-preserved');
    const hostDirectory = kernel.runtimeHostLivenessDirectory(fixture.paths);
    await fs.rm(hostDirectory, { recursive: true, force: true });
    await fs.symlink(outside, hostDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    const before = await preservedFiles(fixture);
    const casBefore = await fileDigests(fixture.paths.casRootPath);
    const outsideBefore = await fileDigests(outside);
    await assert.rejects(kernel.upgradeRuntimeDataSet({ globalStoragePath: fixture.cleanupRoot }, upgradeInput(fixture)),
      /symbolic link/i);
    assert.deepEqual(await preservedFiles(fixture), before);
    assert.deepEqual(await fileDigests(fixture.paths.casRootPath), casBefore);
    assert.deepEqual(await fileDigests(outside), outsideBefore);
    await assert.rejects(fs.access(fixture.paths.rootPendingPath), { code: 'ENOENT' });
  } finally {
    await fs.rm(fixture.cleanupRoot, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('explicit upgrade rejects unknown predecessor DDL and unsupported epochs without replacing the root', async (t) => {
  for (const drift of ['schema', 'epoch']) await t.test(drift, async () => {
    const fixture = await createPublishedRuntime(4);
    try {
      if (drift === 'schema') {
        const database = new Database(kernel.toSqliteFilePath(fixture.paths.databasePath));
        database.exec('ALTER TABLE conversation ADD COLUMN invented TEXT');
        database.close();
      } else {
        const manifest = JSON.parse(await fs.readFile(fixture.paths.runtimeEpochPath, 'utf8'));
        await fs.writeFile(fixture.paths.runtimeEpochPath, JSON.stringify({ ...manifest, runtimeKernelEpoch: 2 }));
        await fs.writeFile(fixture.paths.rootPointerPath, JSON.stringify({ ...fixture.previous, runtimeKernelEpoch: 2 }));
      }
      const before = await preservedFiles(fixture);
      await assert.rejects(kernel.upgradeRuntimeDataSet({ globalStoragePath: fixture.cleanupRoot }, upgradeInput(fixture)), {
        code: drift === 'schema' ? 'runtime-epoch-migration-schema-mismatch' : 'runtime-epoch-migration-unsupported'
      });
      assert.deepEqual(await preservedFiles(fixture), before);
      await assert.rejects(fs.access(fixture.paths.rootPendingPath), { code: 'ENOENT' });
    } finally { await fs.rm(fixture.cleanupRoot, { recursive: true, force: true }); }
  });
});

test('explicit upgrade refuses physical cutover requests and recovery journals instead of archiving or resetting', async (t) => {
  for (const state of ['requested', 'interrupted']) await t.test(state, async () => {
    const fixture = await createPublishedRuntime(4);
    try {
      if (state === 'requested') {
        await persistPhysicalCutoverRequest(fixture.scope, {
          noActiveTurn: true, noBackgroundProcess: true, noPendingProviderStream: true, noPersistInflight: true
        });
      } else {
        await fs.writeFile(path.join(fixture.scope, '.limcode-runtime', CUTOVER_JOURNAL_FILE), JSON.stringify({
          kind: 'limcode-runtime-cutover-journal', contractRevision: PHYSICAL_CUTOVER_MANIFEST.contractRevision,
          requestId: 'upgrade-refuses-cutover', attemptId: 'upgrade-cutover-attempt', state: 'archiving',
          archiveDirectoryName: 'upgrade-cutover-backup', steps: [], results: [],
          createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
          preservedEvidence: {}, unknownEvidence: {}
        }));
      }
      const before = await preservedFiles(fixture);
      await assert.rejects(kernel.upgradeRuntimeDataSet({ globalStoragePath: fixture.cleanupRoot }, upgradeInput(fixture)),
        { code: 'runtime-data-set-upgrade-cutover-required' });
      assert.deepEqual(await preservedFiles(fixture), before);
      await assert.rejects(fs.access(fixture.paths.rootPendingPath), { code: 'ENOENT' });
    } finally { await fs.rm(fixture.cleanupRoot, { recursive: true, force: true }); }
  });
});

test('explicit upgrade resumes each exact pending migration boundary without requiring complete history first', async (t) => {
  for (const point of [
    'after-writer-fence', 'before-backup', 'after-backup', 'after-database-commit', 'after-pointer-publication'
  ]) await t.test(point, async () => {
    const fixture = await createPublishedRuntime(4);
    const storagePaths = { globalStoragePath: fixture.cleanupRoot };
    try {
      const input = upgradeInput(fixture);
      await assert.rejects(kernel.upgradeRuntimeDataSet(storagePaths, input, {
        onFaultPoint: at => { if (at === point) throw new Error(`stop at ${point}`); }
      }), /stop at/);
      const result = await kernel.upgradeRuntimeDataSet(storagePaths, input);
      assert.equal(result.migrated, true);
      assert.equal(result.binding.runtimeKernelEpoch, 5);
      assert.equal(result.binding.dataSetId, fixture.previous.dataSetId);
      await fs.access(path.join(result.backupPath, 'limcode.epoch-4.sqlite'));
      const reader = await openRuntimeDataSetHistory(storagePaths, input.candidateId);
      try { assert.equal((await reader.readMessages(fixture.conversationId)).items[0].text, fixture.message); }
      finally { await reader.close(); }
      await assert.rejects(fs.access(fixture.paths.rootPendingPath), { code: 'ENOENT' });
    } finally { await fs.rm(fixture.cleanupRoot, { recursive: true, force: true }); }
  });
  await t.test('published 3-to-4 pending fence', async () => {
    const fixture = await createPublishedRuntime(3);
    try {
      await fs.writeFile(fixture.paths.rootPendingPath, JSON.stringify({
        ...fixture.previous, rootGeneration: fixture.previous.rootGeneration + 1,
        pointerRevision: fixture.previous.pointerRevision + 1, runtimeKernelEpoch: 4
      }));
      const result = await kernel.upgradeRuntimeDataSet({ globalStoragePath: fixture.cleanupRoot }, upgradeInput(fixture));
      assert.equal(result.previousEpoch, 3);
      assert.equal(result.binding.runtimeKernelEpoch, 5);
      await assert.rejects(fs.access(fixture.paths.rootPendingPath), { code: 'ENOENT' });
    } finally { await fs.rm(fixture.cleanupRoot, { recursive: true, force: true }); }
  });
});

test('automatic discovery upgrades independent histories after one failure and finalizes a published migration journal', async () => {
  const failed = await createPublishedRuntime(3, { workspaceScope: `folder-${'a'.repeat(64)}` });
  const storagePaths = { globalStoragePath: failed.cleanupRoot };
  let current;
  try {
    const intact = await createPublishedRuntime(4, {
      configurationRoot: failed.cleanupRoot, workspaceScope: `folder-${'b'.repeat(64)}`
    });
    const interrupted = await createPublishedRuntime(4, {
      configurationRoot: failed.cleanupRoot, workspaceScope: `folder-${'c'.repeat(64)}`
    });
    const missingId = `workspace:folder-${'d'.repeat(64)}`;
    await fs.mkdir(path.join(failed.cleanupRoot, '.limcode-workspace-runtimes', 'scopes', missingId.slice(10)));
    const damaged = new Database(kernel.toSqliteFilePath(failed.paths.databasePath), { readonly: true, fileMustExist: true });
    let key;
    try {
      key = damaged.prepare(`SELECT content.storage_key FROM content_object content
        JOIN turn_intent_revision revision ON revision.content_object_id = content.id
        WHERE revision.id = ?`).get(failed.legacyContinuation.ids.turnIntentRevisionId).storage_key;
    } finally { damaged.close(); }
    await fs.writeFile(path.join(failed.paths.casRootPath, ...key.split('/')), 'damaged continuation');
    await assert.rejects(kernel.upgradeRuntimeDataSet(storagePaths, upgradeInput(interrupted), {
      onFaultPoint: point => { if (point === 'after-pointer-publication') throw new Error('stop after pointer'); }
    }), /stop after pointer/);

    const currentAuthority = kernel.createVscodeRootAuthority({
      configurationRootPath: failed.cleanupRoot,
      runtimeDataRootPath: kernel.resolveVscodeRuntimeDataRoot(storagePaths)
    });
    await kernel.initializeEmptyRuntimeRoot(currentAuthority);
    await kernel.selectVscodeRuntimeDataSet(storagePaths, 'default');
    current = await kernel.RuntimeDatabase.open(currentAuthority);
    const selectionPath = kernel.resolveVscodeRuntimeSelectionPath(storagePaths);
    const selection = await fs.readFile(selectionPath);
    const report = await kernel.upgradeDiscoveredRuntimeDataSets(storagePaths);
    assert.equal(report.stopped, false);
    assert.deepEqual(report.results.map(item => item.candidateId), [upgradeInput(intact).candidateId, upgradeInput(interrupted).candidateId]);
    assert.ok(report.results.every(item => item.migrated && item.binding.runtimeKernelEpoch === 5 && item.backupPath));
    const failure = report.failures.find(item => item.candidateId === upgradeInput(failed).candidateId);
    assert.equal(failure.stage, 'upgrade');
    assert.equal(failure.code, 'runtime-epoch-migration-failed');
    assert.match(failure.message, /Historical Runtime SQLite migration failed/);
    assert.match(failure.message, /CAS bytes/);
    assert.ok(report.failures.some(item => item.candidateId === missingId && item.stage === 'discovery'));
    assert.deepEqual(await fs.readFile(selectionPath), selection);
    assert.equal((await kernel.resolveVscodeRuntimeDataSet(storagePaths, upgradeInput(failed).candidateId)).runtimeKernelEpoch, 3);
    await assert.rejects(fs.access(path.join(path.dirname(interrupted.paths.dataRootPath),
      kernel.RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE)), { code: 'ENOENT' });
    const reader = await openRuntimeDataSetHistory(storagePaths, upgradeInput(intact).candidateId);
    try { assert.equal((await reader.readMessages(intact.conversationId)).items[0].text, intact.message); }
    finally { await reader.close(); }
    await current.transaction([kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
      id: 'current-after-background-upgrade', title: '后台升级后仍可使用', status: 'active',
      created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z'
    })]);
  } finally {
    await current?.close();
    await fs.rm(failed.cleanupRoot, { recursive: true, force: true });
  }
});

test('automatic discovery stops between sources after deactivation and leaves the selected source for startup', async () => {
  const selected = await createPublishedRuntime(4);
  const storagePaths = { globalStoragePath: selected.cleanupRoot };
  try {
    const first = await createPublishedRuntime(3, {
      configurationRoot: selected.cleanupRoot, workspaceScope: `folder-${'a'.repeat(64)}`
    });
    const second = await createPublishedRuntime(4, {
      configurationRoot: selected.cleanupRoot, workspaceScope: `folder-${'b'.repeat(64)}`
    });
    await kernel.selectVscodeRuntimeDataSet(storagePaths, 'default');
    const selectedBefore = await preservedFiles(selected);
    const report = await kernel.upgradeDiscoveredRuntimeDataSets(storagePaths, {
      shouldContinue: () => JSON.parse(readFileSync(first.paths.rootPointerPath, 'utf8')).runtimeKernelEpoch !== 5
    });
    assert.equal(report.stopped, true);
    assert.equal(report.failures.length, 0);
    assert.deepEqual(report.results.map(item => item.candidateId), [upgradeInput(first).candidateId]);
    assert.deepEqual(await preservedFiles(selected), selectedBefore);
    assert.equal((await kernel.resolveVscodeRuntimeDataSet(storagePaths, upgradeInput(second).candidateId)).runtimeKernelEpoch, 4);
    const excluded = await kernel.upgradeDiscoveredRuntimeDataSets(storagePaths, {
      excludeCandidateIds: [upgradeInput(second).candidateId]
    });
    assert.deepEqual(excluded.results, []);
    assert.deepEqual(excluded.failures, []);
    const resumed = await kernel.upgradeDiscoveredRuntimeDataSets(storagePaths);
    assert.deepEqual(resumed.results.map(item => item.candidateId), [upgradeInput(second).candidateId]);
    assert.deepEqual(await preservedFiles(selected), selectedBefore);
  } finally { await fs.rm(selected.cleanupRoot, { recursive: true, force: true }); }
});

test('automatic discovery returns a selection failure and can stop before any inspection', async () => {
  const fixture = await createPublishedRuntime(4);
  const storagePaths = { globalStoragePath: fixture.cleanupRoot };
  try {
    await fs.writeFile(kernel.resolveVscodeRuntimeSelectionPath(storagePaths), '{invalid-json');
    const before = await preservedFiles(fixture);
    const stopped = await kernel.upgradeDiscoveredRuntimeDataSets(storagePaths, { shouldContinue: () => false });
    assert.deepEqual(stopped, { results: [], failures: [], stopped: true });
    const report = await kernel.upgradeDiscoveredRuntimeDataSets(storagePaths);
    assert.equal(report.results.length, 0);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].stage, 'discovery');
    assert.equal(report.failures[0].candidateId, undefined);
    assert.ok(report.failures[0].code);
    assert.ok(report.failures[0].message);
    assert.deepEqual(await preservedFiles(fixture), before);
  } finally { await fs.rm(fixture.cleanupRoot, { recursive: true, force: true }); }
});

function upgradeInput(fixture) {
  return {
    candidateId: fixture.scope === fixture.cleanupRoot ? 'default' : `workspace:${path.basename(fixture.scope)}`,
    expectedDataSetId: fixture.previous.dataSetId,
    expectedRootInstanceId: fixture.previous.rootInstanceId
  };
}

async function preservedFiles(fixture) {
  const files = [fixture.paths.databasePath, fixture.paths.rootPointerPath, fixture.paths.runtimeEpochPath,
    fixture.settingsPath, fixture.workspacePath];
  return Object.fromEntries(await Promise.all(files.map(async file => [file,
    createHash('sha256').update(await fs.readFile(file)).digest('hex')])));
}

async function fileDigests(root) {
  const files = {};
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else files[path.relative(root, file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    }
  }
  await visit(root);
  return files;
}

async function createPublishedRuntime(previousEpoch, options = {}) {
  const cleanupRoot = options.configurationRoot
    ?? await fs.mkdtemp(path.join(os.tmpdir(), `limcode-epoch-${previousEpoch}-upgrade-`));
  const scope = options.deepPath
    ? path.join(cleanupRoot, 'globalStorage', '.limcode-workspace-runtimes', 'scopes',
      `folder-${'a'.repeat(64)}`, `nested-${'b'.repeat(64)}`)
    : options.workspaceScope
      ? path.join(cleanupRoot, '.limcode-workspace-runtimes', 'scopes', typeof options.workspaceScope === 'string'
        ? options.workspaceScope : `folder-${'a'.repeat(64)}`)
      : cleanupRoot;
  if (scope !== cleanupRoot) await fs.mkdir(scope, { recursive: true });
  const authority = new kernel.RootAuthority(() => path.join(scope, '.limcode-runtime', 'active'));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  const conversationId = `conversation_preserved_epoch_${previousEpoch}`;
  const title = `升级前对话 ${previousEpoch}`;
  const message = `旧消息与附件内容 ${previousEpoch}`;
  const settingsPath = path.join(scope, 'settings-preserved.json');
  const workspacePath = path.join(scope, 'workspace-preserved.txt');
  let runtime;
  try {
    runtime = await kernel.RuntimeDatabase.open(authority);
    const store = new kernel.ContentAddressedStore(authority, binding);
    const attachmentBytes = Buffer.from([0, 1, 2, 127, 128, 255]);
    const attachmentContent = options.attachment
      ? await store.ingest(runtime, attachmentBytes, 'application/octet-stream') : undefined;
    const attachmentId = `${conversationId}_attachment`;
    const content = await store.ingest(runtime,
      JSON.stringify({ role: 'user', parts: [{ text: message }, ...(attachmentContent
        ? [{ inlineData: { attachmentId, name: 'preserved.bin', mimeType: 'application/octet-stream' } }] : [])] }),
      'application/vnd.limcode.message+json');
    await runtime.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId, title, status: 'active',
        created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z'
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Message').insert({
        id: `${conversationId}_message`, created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z', deleted_at: null
      }),
      kernel.DOMAIN_REPOSITORIES.domain('MessageRevision').insert({
        id: `${conversationId}_revision`, message_id: `${conversationId}_message`,
        revision_seq: 1n, role: 'user', content_object_id: content.id,
        created_at: '2026-09-01T00:00:00.000Z'
      }),
      kernel.DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
        id: `${conversationId}_current`, message_id: `${conversationId}_message`,
        revision_id: `${conversationId}_revision`, updated_at: '2026-09-01T00:00:00.000Z'
      }),
      kernel.DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insert({
        id: `${conversationId}_member`, conversation_id: conversationId,
        message_id: `${conversationId}_message`, message_seq: 1n,
        created_at: '2026-09-01T00:00:00.000Z'
      })
    ]);
    if (attachmentContent) await runtime.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Attachment').insert({
        id: attachmentId, sha256: attachmentContent.sha256, byte_length: attachmentContent.byte_length,
        mime_type: 'application/octet-stream', name: 'preserved.bin', storage_mode: 'cas',
        content_object_id: attachmentContent.id, created_at: '2026-09-01T00:00:00.000Z'
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AttachmentLink').insert({
        id: `${attachmentId}_link`, message_revision_id: `${conversationId}_revision`, attachment_id: attachmentId,
        position: 0n, created_at: '2026-09-01T00:00:00.000Z'
      })
    ]);
    const legacyContinuation = previousEpoch === 3 || options.missingDeliveryLink
      ? await seedLegacyChildRuntimeContinuation(runtime, store, conversationId, String(previousEpoch))
      : undefined;
    await runtime.close();
    runtime = undefined;

    const oldSchemas = previousEpoch === 3
      ? kernel.PREVIOUS_RUNTIME_DOMAIN_SCHEMAS
      : options.missingDeliveryLink
        ? kernel.EPOCH_4_MISSING_DELIVERY_LINK_SCHEMAS
        : kernel.EPOCH_4_RUNTIME_DOMAIN_SCHEMAS;
    const oldKeys = new Set(oldSchemas.map((schema) => schema.key));
    const added = kernel.RUNTIME_DOMAIN_SCHEMAS.filter((schema) => !oldKeys.has(schema.key));
    const database = new Database(kernel.toSqliteFilePath(binding.paths.databasePath));
    try {
      database.defaultSafeIntegers(true);
      database.pragma('foreign_keys = OFF');
      database.exec('BEGIN IMMEDIATE');
      try {
        for (const schema of [...added].reverse()) database.exec(`DROP TABLE ${schema.table}`);
        const dropManifest = database.prepare('DELETE FROM schema_manifest WHERE domain_key = ?');
        for (const schema of added) dropManifest.run(schema.key);
        database.prepare('UPDATE schema_manifest SET runtime_kernel_epoch = ?').run(BigInt(previousEpoch));
        if (previousEpoch === 3 && options.modelContextDetail) {
          database.prepare(`UPDATE schema_manifest SET client_mapping = 'detail', schema_digest = ?
            WHERE domain_key = 'ModelContextProjection'`).run(kernel.EPOCH_3_MODEL_CONTEXT_DETAIL_SCHEMA_DIGEST);
        }
        database.prepare('UPDATE root_binding SET runtime_kernel_epoch = ? WHERE singleton = 1').run(BigInt(previousEpoch));
        database.exec('COMMIT');
      } catch (error) { database.exec('ROLLBACK'); throw error; }
      database.pragma('wal_checkpoint(TRUNCATE)');
    } finally { database.close(); }
    const previous = { ...binding, paths: { ...binding.paths }, runtimeKernelEpoch: previousEpoch };
    const epochManifest = JSON.parse(await fs.readFile(binding.paths.runtimeEpochPath, 'utf8'));
    epochManifest.runtimeKernelEpoch = previousEpoch;
    await fs.writeFile(binding.paths.runtimeEpochPath, `${JSON.stringify(epochManifest, null, 2)}\n`);
    await fs.writeFile(binding.paths.rootPointerPath, `${JSON.stringify(previous, null, 2)}\n`);
    await fs.writeFile(settingsPath, 'keep-settings');
    await fs.writeFile(workspacePath, 'keep-workspace');
    return { scope, cleanupRoot, authority, paths: binding.paths, previous, conversationId, title, message,
      contentId: content.id, settingsPath, workspacePath, legacyContinuation,
      ...(attachmentContent ? { attachment: { id: attachmentId, content: attachmentContent, bytes: attachmentBytes } } : {}) };
  } catch (error) {
    await runtime?.close().catch(() => undefined);
    await fs.rm(options.configurationRoot ? scope : cleanupRoot, { recursive: true, force: true });
    throw error;
  }
}

async function seedLegacyChildRuntimeContinuation(runtime, store, conversationId, label) {
  const suffix = label.replace(/[^a-z0-9]+/gi, '_');
  const createdAt = '2026-08-12T10:40:00.000Z';
  const childExecutionId = `legacy_child_execution_${suffix}`;
  const sourceTurnId = `legacy_child_source_turn_${suffix}`;
  const deliveryId = `legacy_child_delivery_${suffix}`;
  const inboxItemId = `legacy_child_inbox_${suffix}`;
  const ids = kernel.childRuntimeDeliveryContinuationIds({
    deliveryId,
    childExecutionId,
    sourceTurnId
  });
  const legacyIntent = await store.ingest(
    runtime,
    kernel.canonicalPlainJson({
      kind: 'child-runtime-delivery-continuation',
      deliveryId,
      sourceTurnId
    }),
    kernel.CHILD_RUNTIME_DELIVERY_CONTINUATION_CONTENT_TYPE
  );
  const legacyPreset = await store.ingest(
    runtime,
    kernel.canonicalPlainJson({ kind: 'child-runtime-delivery-continuation' }),
    kernel.TURN_EXECUTION_PRESET_CONTENT_TYPE
  );
  await runtime.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
      id: `legacy_child_agent_link_${suffix}`,
      conversation_id: conversationId,
      agent_id: `legacy_child_agent_${suffix}`,
      role: 'default',
      created_at: createdAt,
      updated_at: createdAt
    }),
    kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
      id: sourceTurnId,
      conversation_id: conversationId,
      status: 'terminated',
      created_at: createdAt,
      updated_at: createdAt,
      terminal_at: createdAt
    }),
    kernel.DOMAIN_REPOSITORIES.domain('TurnTermination').insert({
      id: `legacy_child_termination_${suffix}`,
      turn_id: sourceTurnId,
      terminal_status: 'completed',
      reason: 'legacy continuation migration fixture',
      created_at: createdAt
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ChildExecution').insert({
      id: childExecutionId,
      child_conversation_id: conversationId,
      status: 'idle',
      created_at: createdAt,
      updated_at: createdAt
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').insert({
      id: `legacy_child_parent_link_${suffix}`,
      child_execution_id: childExecutionId,
      source_tool_call_id: `legacy_child_source_tool_${suffix}`,
      parent_child_execution_id: null,
      parent_turn_id: null,
      created_at: createdAt
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').insert({
      id: `legacy_child_turn_link_${suffix}`,
      child_execution_id: childExecutionId,
      turn_seq: 1n,
      turn_id: sourceTurnId,
      created_at: createdAt
    }),
    kernel.DOMAIN_REPOSITORIES.domain('AnswerBridge').insert({
      id: `legacy_child_answer_bridge_${suffix}`,
      child_execution_id: childExecutionId,
      current_submission_id: null,
      status: 'open',
      created_at: createdAt,
      updated_at: createdAt
    }),
    kernel.DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').insert({
      id: inboxItemId,
      dedupe_key: `legacy-child-continuation:${suffix}`,
      source_kind: 'process_receipt',
      source_id: `legacy_child_source_${suffix}`,
      state: 'available',
      created_at: createdAt,
      updated_at: createdAt
    }),
    kernel.DOMAIN_REPOSITORIES.domain('RuntimeDelivery').insert({
      id: deliveryId,
      inbox_item_id: inboxItemId,
      target_conversation_id: conversationId,
      target_turn_id: null,
      phase: 'next_turn',
      attempt_seq: 1n,
      retry_of_delivery_id: null,
      state: 'pending',
      failure_reason: null,
      created_at: createdAt,
      updated_at: createdAt
    }),
    kernel.DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
      id: ids.commandReceiptId,
      source_kind: 'internal',
      source_key: ids.sourceKey,
      conversation_id: conversationId,
      turn_id: sourceTurnId,
      created_at: createdAt
    }),
    kernel.DOMAIN_REPOSITORIES.domain('TurnIntent').insert({
      id: ids.turnIntentId,
      conversation_id: conversationId,
      turn_id: null,
      state: 'queued',
      created_at: createdAt,
      updated_at: createdAt
    }),
    kernel.DOMAIN_REPOSITORIES.domain('TurnIntentRevision').insert({
      id: ids.turnIntentRevisionId,
      intent_id: ids.turnIntentId,
      revision_seq: 1n,
      content_object_id: legacyIntent.id,
      created_at: createdAt
    }),
    kernel.DOMAIN_REPOSITORIES.domain('TurnExecutionPresetRevision').insert({
      id: ids.presetRevisionId,
      intent_id: ids.turnIntentId,
      revision_seq: 1n,
      preset_object_id: legacyPreset.id,
      created_at: createdAt
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').insert({
      id: ids.intentLinkId,
      child_execution_id: childExecutionId,
      intent_seq: 1n,
      turn_intent_id: ids.turnIntentId,
      state: 'pending',
      created_at: createdAt,
      updated_at: createdAt
    })
  ]);
  return { deliveryId, childExecutionId, sourceTurnId, ids };
}
