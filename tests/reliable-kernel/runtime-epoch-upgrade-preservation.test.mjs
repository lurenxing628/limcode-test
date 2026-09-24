import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

async function createPublishedRuntime(previousEpoch, options = {}) {
  const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-epoch-${previousEpoch}-upgrade-`));
  const scope = options.deepPath
    ? path.join(cleanupRoot, 'globalStorage', '.limcode-workspace-runtimes', 'scopes',
      `folder-${'a'.repeat(64)}`, `nested-${'b'.repeat(64)}`)
    : cleanupRoot;
  if (options.deepPath) await fs.mkdir(scope, { recursive: true });
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
    const content = await store.ingest(runtime,
      JSON.stringify({ role: 'user', parts: [{ text: message }] }),
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
      contentId: content.id, settingsPath, workspacePath, legacyContinuation };
  } catch (error) {
    await runtime?.close().catch(() => undefined);
    await fs.rm(cleanupRoot, { recursive: true, force: true });
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
