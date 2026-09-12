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

test('精确 epoch 3 启动时无损升级并保留既有 Conversation', async () => {
  const fixture = await createEpoch3RuntimeFixture('preserve-history');
  let runtime;
  try {
    const result = await new VscodeReliableKernelCutoverCoordinator(
      fixture.authority,
      fixture.runtimeScopeRoot
    ).ensureCurrentRoot();

    assert.equal(result.initialized, true);
    assert.equal(result.cutoverPerformed, false);
    assert.equal(result.epochMigratedFrom, kernel.PREVIOUS_RUNTIME_KERNEL_EPOCH);
    assert.equal(result.epochResetFrom, undefined);
    assert.equal(result.binding.runtimeKernelEpoch, kernel.RUNTIME_KERNEL_EPOCH);
    assert.equal(result.binding.dataSetId, fixture.previousBinding.dataSetId);
    assert.equal(result.binding.rootInstanceId, fixture.previousBinding.rootInstanceId);
    assert.equal(result.binding.rootGeneration, fixture.previousBinding.rootGeneration + 1);
    assert.equal(result.binding.pointerRevision, fixture.previousBinding.pointerRevision + 1);
    assert.equal(
      path.dirname(result.epochMigrationBackupPath),
      path.join(
        path.dirname(fixture.paths.dataRootPath),
        kernel.RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY
      )
    );
    await fs.access(path.join(result.epochMigrationBackupPath, 'limcode.epoch-3.sqlite'));
    await fs.access(path.join(result.epochMigrationBackupPath, 'root-binding.epoch-3.json'));
    assert.deepEqual(
      (await fs.readdir(result.epochMigrationBackupPath))
        .filter((name) => name.endsWith('-wal') || name.endsWith('-shm') || name.includes('.tmp')),
      []
    );

    runtime = await kernel.RuntimeDatabase.open(fixture.authority);
    const preserved = await runtime.snapshot([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').get(fixture.conversationId),
      kernel.DOMAIN_REPOSITORIES.domain('ContentObject').get(fixture.oldContentObjectId),
      kernel.DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({
        where: { conversation_id: fixture.conversationId },
        limit: 10
      })
    ]);
    assert.equal(preserved.snapshot[0]?.title, fixture.conversationTitle);
    assert.equal(preserved.snapshot[2]?.length, 1);
    const store = new kernel.ContentAddressedStore(fixture.authority, result.binding);
    const oldBytes = await store.read(preserved.snapshot[1]);
    assert.equal(JSON.parse(oldBytes.toString('utf8')).parts[0].text, fixture.oldMessageText);
    await assertMigratedLegacyChildContinuation(
      runtime,
      store,
      fixture.legacyContinuation
    );

    const newMessageText = '升级后继续发送的新消息';
    const newContent = await store.ingest(
      runtime,
      JSON.stringify({ role: 'user', parts: [{ text: newMessageText }] }),
      'application/vnd.limcode.message+json'
    );
    await runtime.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Message').insert({
        id: `${fixture.conversationId}_new_message`,
        created_at: '2026-08-21T16:00:00.000Z',
        updated_at: '2026-08-21T16:00:00.000Z',
        deleted_at: null
      }),
      kernel.DOMAIN_REPOSITORIES.domain('MessageRevision').insert({
        id: `${fixture.conversationId}_new_revision`,
        message_id: `${fixture.conversationId}_new_message`,
        revision_seq: 1n,
        role: 'user',
        content_object_id: newContent.id,
        created_at: '2026-08-21T16:00:00.000Z'
      }),
      kernel.DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
        id: `${fixture.conversationId}_new_current`,
        message_id: `${fixture.conversationId}_new_message`,
        revision_id: `${fixture.conversationId}_new_revision`,
        updated_at: '2026-08-21T16:00:00.000Z'
      }),
      kernel.DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insertWithNextSequence({
        id: `${fixture.conversationId}_new_membership`,
        conversation_id: fixture.conversationId,
        message_id: `${fixture.conversationId}_new_message`,
        created_at: '2026-08-21T16:00:00.000Z'
      }, {
        column: 'message_seq',
        scope: { conversation_id: fixture.conversationId }
      })
    ]);
    const continued = await runtime.snapshot([
      kernel.DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({
        where: { conversation_id: fixture.conversationId },
        limit: 10
      })
    ]);
    assert.equal(continued.snapshot[0]?.length, 2);
    await runtime.close();
    runtime = undefined;

    const database = new Database(fixture.paths.databasePath, { readonly: true, fileMustExist: true });
    try {
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM schema_manifest').get().count,
        91
      );
      for (const table of [
        'conversation_attachment_handle_link',
        'attachment_observation_link',
        'compression_block_observation_link'
      ]) {
        assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
      }
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM runtime_delivery_intent_link').get().count,
        1
      );
    } finally {
      database.close();
    }
  } finally {
    if (runtime) await runtime.close().catch(() => undefined);
    await fs.rm(fixture.runtimeScopeRoot, { recursive: true, force: true });
  }
});

test('0.0.10至0.0.11的epoch 3 manifest可在生产深路径从fenced journal无损升级', async () => {
  const fixture = await createEpoch3RuntimeFixture('published-detail-deep-path', {
    modelContextProjectionClientMapping: 'detail',
    productionDepth: true
  });
  let runtime;
  try {
    assert.equal(fixture.modelContextProjectionClientMapping, 'detail');
    await assert.rejects(
      kernel.migratePreviousRuntimeEpochIfRequired(fixture.authority, {
        onFaultPoint(point) {
          if (point === 'before-backup') throw new Error('fault:before-backup');
        }
      }),
      /fault:before-backup/
    );

    const controlRoot = path.dirname(fixture.paths.dataRootPath);
    const journalPath = path.join(controlRoot, kernel.RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE);
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    assert.equal(journal.state, 'fenced');
    const backupTemporaryPath = path.join(
      controlRoot,
      kernel.RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY,
      journal.backupDirectoryName,
      `limcode.epoch-3.sqlite.${process.pid}.tmp`
    );
    assert.ok(
      backupTemporaryPath.length > 260,
      `production-depth epoch backup must exceed MAX_PATH, found ${backupTemporaryPath.length}`
    );
    assert.ok(backupTemporaryPath.length > fixture.paths.databasePath.length);
    await fs.access(fixture.paths.rootPendingPath);

    const recovered = await kernel.migratePreviousRuntimeEpochIfRequired(fixture.authority);
    assert.equal(recovered?.binding.runtimeKernelEpoch, kernel.RUNTIME_KERNEL_EPOCH);
    assert.equal(recovered?.binding.dataSetId, fixture.previousBinding.dataSetId);
    assert.equal(recovered?.binding.paths.databasePath, fixture.paths.databasePath);
    assert.equal(recovered?.binding.paths.databasePath.includes(windowsNamespacePrefix), false);
    await fs.access(path.join(recovered.backupPath, 'limcode.epoch-3.sqlite'));
    await assert.rejects(fs.access(journalPath), { code: 'ENOENT' });
    await assert.rejects(fs.access(fixture.paths.rootPendingPath), { code: 'ENOENT' });

    runtime = await kernel.RuntimeDatabase.open(fixture.authority);
    const preserved = await runtime.snapshot([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').get(fixture.conversationId),
      kernel.DOMAIN_REPOSITORIES.domain('ContentObject').get(fixture.oldContentObjectId)
    ]);
    assert.equal(preserved.snapshot[0]?.title, fixture.conversationTitle);
    const store = new kernel.ContentAddressedStore(fixture.authority, recovered.binding);
    const oldBytes = await store.read(preserved.snapshot[1]);
    assert.equal(JSON.parse(oldBytes.toString('utf8')).parts[0].text, fixture.oldMessageText);
    await assertMigratedLegacyChildContinuation(runtime, store, fixture.legacyContinuation);
  } finally {
    if (runtime) await runtime.close().catch(() => undefined);
    await fs.rm(fixture.cleanupRoot, { recursive: true, force: true });
  }
});

test('epoch 3 升级在四个持久化断点后都能继续完成且保留历史', async (t) => {
  for (const point of [
    'after-writer-fence',
    'after-backup',
    'after-database-commit',
    'after-pointer-publication'
  ]) {
    await t.test(point, async () => {
      const fixture = await createEpoch3RuntimeFixture(point);
      let runtime;
      try {
        await assert.rejects(
          kernel.migratePreviousRuntimeEpochIfRequired(fixture.authority, {
            onFaultPoint(observed) {
              if (observed === point) throw new Error(`fault:${point}`);
            }
          }),
          new RegExp(`fault:${point}`)
        );

        const recovered = await kernel.migratePreviousRuntimeEpochIfRequired(fixture.authority);
        assert.equal(recovered?.binding.runtimeKernelEpoch, kernel.RUNTIME_KERNEL_EPOCH);
        assert.equal(recovered?.binding.dataSetId, fixture.previousBinding.dataSetId);
        runtime = await kernel.RuntimeDatabase.open(fixture.authority);
        const conversation = await runtime.snapshot([
          kernel.DOMAIN_REPOSITORIES.domain('Conversation').get(fixture.conversationId)
        ]);
        assert.equal(conversation.snapshot[0]?.title, fixture.conversationTitle);
      } finally {
        if (runtime) await runtime.close().catch(() => undefined);
        await fs.rm(fixture.runtimeScopeRoot, { recursive: true, force: true });
      }
    });
  }
});

test('epoch 3 出现未知结构漂移时保持旧指针且不归档历史', async () => {
  const fixture = await createEpoch3RuntimeFixture('unknown-drift');
  try {
    const pointerBefore = await fs.readFile(fixture.paths.rootPointerPath, 'utf8');
    const database = new Database(fixture.paths.databasePath, { fileMustExist: true });
    try {
      database.exec('CREATE TABLE unsupported_epoch3_drift (id TEXT PRIMARY KEY)');
    } finally {
      database.close();
    }

    await assert.rejects(
      new VscodeReliableKernelCutoverCoordinator(
        fixture.authority,
        fixture.runtimeScopeRoot
      ).ensureCurrentRoot(),
      (error) => error?.code === 'runtime-epoch-migration-schema-mismatch'
    );
    assert.equal(await fs.readFile(fixture.paths.rootPointerPath, 'utf8'), pointerBefore);
    await assert.rejects(
      fs.access(path.join(fixture.runtimeScopeRoot, VSCODE_INCOMPATIBLE_RUNTIME_BACKUPS_DIRECTORY)),
      { code: 'ENOENT' }
    );
    await assert.rejects(fs.access(fixture.paths.rootPendingPath), { code: 'ENOENT' });
  } finally {
    await fs.rm(fixture.runtimeScopeRoot, { recursive: true, force: true });
  }
});

test('epoch 3 manifest只接受两个已发布指纹并拒绝任意mapping或错误digest', async () => {
  const fixture = await createEpoch3RuntimeFixture('unsupported-manifest-variant');
  try {
    const pointerBefore = await fs.readFile(fixture.paths.rootPointerPath, 'utf8');
    const modelContextProjection = kernel.PREVIOUS_RUNTIME_DOMAIN_SCHEMAS.find(
      (schema) => schema.key === 'ModelContextProjection'
    );
    assert.ok(modelContextProjection);
    const writeManifest = async (clientMapping, schemaDigest) => {
      const database = new Database(kernel.toSqliteFilePath(fixture.paths.databasePath), { fileMustExist: true });
      try {
        const result = database.prepare(`
          UPDATE schema_manifest
             SET client_mapping = @clientMapping,
                 schema_digest = @schemaDigest
           WHERE domain_key = 'ModelContextProjection'
        `).run({ clientMapping, schemaDigest });
        assert.equal(result.changes, 1);
        database.pragma('wal_checkpoint(TRUNCATE)');
      } finally {
        database.close();
      }
    };
    const assertRejectedBeforeFence = async () => {
      await assert.rejects(
        new VscodeReliableKernelCutoverCoordinator(
          fixture.authority,
          fixture.runtimeScopeRoot
        ).ensureCurrentRoot(),
        (error) => error?.code === 'runtime-epoch-migration-schema-mismatch'
          && /ModelContextProjection/.test(error.message)
      );
      assert.equal(await fs.readFile(fixture.paths.rootPointerPath, 'utf8'), pointerBefore);
      await assert.rejects(fs.access(fixture.paths.rootPendingPath), { code: 'ENOENT' });
      await assert.rejects(
        fs.access(path.join(
          path.dirname(fixture.paths.dataRootPath),
          kernel.RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE
        )),
        { code: 'ENOENT' }
      );
    };

    await writeManifest(
      'window',
      kernel.domainSchemaDigest({ ...modelContextProjection, client: 'window' })
    );
    await assertRejectedBeforeFence();
    await writeManifest('detail', '0'.repeat(64));
    await assertRejectedBeforeFence();
  } finally {
    await fs.rm(fixture.cleanupRoot, { recursive: true, force: true });
  }
});

test('epoch 3 同名索引丢失 UNIQUE/列定义时拒绝升级', async () => {
  const fixture = await createEpoch3RuntimeFixture('same-name-index-drift');
  try {
    const pointerBefore = await fs.readFile(fixture.paths.rootPointerPath, 'utf8');
    const database = new Database(fixture.paths.databasePath, { fileMustExist: true });
    try {
      database.exec(`
        DROP INDEX ux_agent_conversation_link_01;
        CREATE INDEX ux_agent_conversation_link_01 ON agent_conversation_link (id);
      `);
    } finally {
      database.close();
    }
    await assert.rejects(
      new VscodeReliableKernelCutoverCoordinator(
        fixture.authority,
        fixture.runtimeScopeRoot
      ).ensureCurrentRoot(),
      (error) => error?.code === 'runtime-epoch-migration-schema-mismatch'
        && /index DDL drift is unsupported/.test(error.message)
    );
    assert.equal(await fs.readFile(fixture.paths.rootPointerPath, 'utf8'), pointerBefore);
    await assert.rejects(
      fs.access(path.join(fixture.runtimeScopeRoot, VSCODE_INCOMPATIBLE_RUNTIME_BACKUPS_DIRECTORY)),
      { code: 'ENOENT' }
    );
  } finally {
    await fs.rm(fixture.runtimeScopeRoot, { recursive: true, force: true });
  }
});

test('epoch 4 缺少 RuntimeDeliveryIntentLink 时原地增表并保留历史', async () => {
  const fixture = await createEpoch4WithoutRuntimeDeliveryIntentLinkFixture('preserve-history');
  let runtime;
  try {
    const pointerBefore = await fs.readFile(fixture.binding.paths.rootPointerPath, 'utf8');
    const result = await new VscodeReliableKernelCutoverCoordinator(
      fixture.authority,
      fixture.runtimeScopeRoot
    ).ensureCurrentRoot();
    assert.equal(result.initialized, false);
    assert.equal(result.cutoverPerformed, false);
    assert.equal(result.manifestMigrated, true);
    assert.equal(result.epochMigratedFrom, undefined);
    assert.equal(result.epochResetFrom, undefined);
    assert.deepEqual(result.binding, fixture.binding);
    assert.equal(await fs.readFile(fixture.binding.paths.rootPointerPath, 'utf8'), pointerBefore);

    runtime = await kernel.RuntimeDatabase.open(fixture.authority);
    const preserved = await runtime.snapshot([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').get(fixture.conversationId),
      kernel.DOMAIN_REPOSITORIES.domain('ContentObject').get(fixture.contentObjectId),
      kernel.DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({
        where: { conversation_id: fixture.conversationId },
        limit: 10
      })
    ]);
    assert.equal(preserved.snapshot[0]?.title, fixture.conversationTitle);
    assert.equal(preserved.snapshot[2]?.length, 1);
    const store = new kernel.ContentAddressedStore(fixture.authority, fixture.binding);
    assert.equal(
      JSON.parse((await store.read(preserved.snapshot[1])).toString('utf8')).parts[0].text,
      fixture.messageText
    );
    await assertMigratedLegacyChildContinuation(
      runtime,
      store,
      fixture.legacyContinuation
    );

    const database = new Database(fixture.binding.paths.databasePath, { readonly: true, fileMustExist: true });
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_manifest').get().count, 91);
      assert.equal(
        database.prepare(
          "SELECT COUNT(*) AS count FROM schema_manifest WHERE domain_key = 'RuntimeDeliveryIntentLink'"
        ).get().count,
        1
      );
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM runtime_delivery_intent_link').get().count, 1);
    } finally {
      database.close();
    }
  } finally {
    if (runtime) await runtime.close().catch(() => undefined);
    await fs.rm(fixture.runtimeScopeRoot, { recursive: true, force: true });
  }
});

test('epoch 4 拒绝未列入前驱合同的领域 mapping，且不改写历史或补表', async (t) => {
  for (const missingAdditiveDomain of [false, true]) {
    await t.test(missingAdditiveDomain ? '单表前驱包含额外 metadata 漂移' : '当前 schema 包含 metadata 漂移', async () => {
      const fixture = await createEpoch4WithoutRuntimeDeliveryIntentLinkFixture('metadata-drift');
      try {
        const coordinator = new VscodeReliableKernelCutoverCoordinator(
          fixture.authority,
          fixture.runtimeScopeRoot
        );
        if (!missingAdditiveDomain) await coordinator.ensureCurrentRoot();
        const pointerBefore = await fs.readFile(fixture.binding.paths.rootPointerPath, 'utf8');
        const schema = kernel.RUNTIME_DOMAIN_SCHEMAS.find((item) => item.key === 'Conversation');
        const clientMapping = schema.client === 'none' ? 'detail' : 'none';
        let manifestBefore;
        const database = new Database(fixture.binding.paths.databasePath, { fileMustExist: true });
        try {
          database.prepare(`
            UPDATE schema_manifest SET client_mapping = ?, schema_digest = ? WHERE domain_key = ?
          `).run(clientMapping, kernel.domainSchemaDigest({ ...schema, client: clientMapping }), schema.key);
          manifestBefore = database.prepare('SELECT * FROM schema_manifest WHERE domain_key = ?').get(schema.key);
        } finally {
          database.close();
        }

        await assert.rejects(coordinator.ensureCurrentRoot(), /Runtime manifest drift is unsupported/);
        assert.equal(await fs.readFile(fixture.binding.paths.rootPointerPath, 'utf8'), pointerBefore);
        await assert.rejects(fs.access(fixture.binding.paths.rootPendingPath), { code: 'ENOENT' });
        const inspection = new Database(fixture.binding.paths.databasePath, { readonly: true, fileMustExist: true });
        try {
          assert.deepEqual(
            inspection.prepare('SELECT * FROM schema_manifest WHERE domain_key = ?').get(schema.key),
            manifestBefore
          );
          assert.equal(
            inspection.prepare('SELECT title FROM conversation WHERE id = ?').get(fixture.conversationId).title,
            fixture.conversationTitle
          );
          assert.equal(
            inspection.prepare(
              "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'runtime_delivery_intent_link'"
            ).get().count,
            missingAdditiveDomain ? 0 : 1
          );
        } finally {
          inspection.close();
        }
      } finally {
        await fs.rm(fixture.runtimeScopeRoot, { recursive: true, force: true });
      }
    });
  }
});

test('epoch 4 单表 predecessor 含额外结构漂移时 fail closed 且历史原地保留', async () => {
  const fixture = await createEpoch4WithoutRuntimeDeliveryIntentLinkFixture('unknown-drift');
  try {
    const pointerBefore = await fs.readFile(fixture.binding.paths.rootPointerPath, 'utf8');
    const database = new Database(fixture.binding.paths.databasePath, { fileMustExist: true });
    try {
      database.exec('CREATE TABLE unsupported_epoch4_drift (id TEXT PRIMARY KEY)');
    } finally {
      database.close();
    }
    await assert.rejects(
      new VscodeReliableKernelCutoverCoordinator(
        fixture.authority,
        fixture.runtimeScopeRoot
      ).ensureCurrentRoot(),
      /Runtime physical table drift is unsupported/
    );
    assert.equal(await fs.readFile(fixture.binding.paths.rootPointerPath, 'utf8'), pointerBefore);
    const inspection = new Database(fixture.binding.paths.databasePath, { readonly: true, fileMustExist: true });
    try {
      assert.equal(
        inspection.prepare('SELECT title FROM conversation WHERE id = ?').get(fixture.conversationId).title,
        fixture.conversationTitle
      );
      assert.equal(
        inspection.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'runtime_delivery_intent_link'"
        ).get().count,
        0
      );
    } finally {
      inspection.close();
    }
  } finally {
    await fs.rm(fixture.runtimeScopeRoot, { recursive: true, force: true });
  }
});

test('epoch 4 单表 predecessor 含同名错误索引时 fail closed', async () => {
  const fixture = await createEpoch4WithoutRuntimeDeliveryIntentLinkFixture('same-name-index-drift');
  try {
    const pointerBefore = await fs.readFile(fixture.binding.paths.rootPointerPath, 'utf8');
    const database = new Database(fixture.binding.paths.databasePath, { fileMustExist: true });
    try {
      database.exec(`
        DROP INDEX ux_agent_conversation_link_01;
        CREATE INDEX ux_agent_conversation_link_01 ON agent_conversation_link (id);
      `);
    } finally {
      database.close();
    }
    await assert.rejects(
      new VscodeReliableKernelCutoverCoordinator(
        fixture.authority,
        fixture.runtimeScopeRoot
      ).ensureCurrentRoot(),
      /Runtime physical index DDL drift is unsupported/
    );
    assert.equal(await fs.readFile(fixture.binding.paths.rootPointerPath, 'utf8'), pointerBefore);
    const inspection = new Database(fixture.binding.paths.databasePath, { readonly: true, fileMustExist: true });
    try {
      assert.equal(
        inspection.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'runtime_delivery_intent_link'"
        ).get().count,
        0
      );
    } finally {
      inspection.close();
    }
  } finally {
    await fs.rm(fixture.runtimeScopeRoot, { recursive: true, force: true });
  }
});

test('不受支持的更旧Runtime epoch启动时整根归档并创建当前RootBinding', async () => {
  const runtimeScopeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-runtime-epoch-reset-'));
  let runtime;
  try {
    const dataRootPath = path.join(runtimeScopeRoot, '.limcode-runtime', 'active');
    const paths = kernel.createRuntimeRootPaths(dataRootPath);
    const previousEpoch = kernel.RUNTIME_KERNEL_EPOCH - 2;
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

async function createEpoch4WithoutRuntimeDeliveryIntentLinkFixture(label) {
  const runtimeScopeRoot = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-epoch4-link-${label}-`));
  const dataRootPath = path.join(runtimeScopeRoot, '.limcode-runtime', 'active');
  const authority = new kernel.RootAuthority(() => dataRootPath);
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  const conversationId = `conversation_epoch4_${label.replace(/[^a-z0-9]+/gi, '_')}`;
  const conversationTitle = `现有epoch4对话-${label}`;
  const messageText = `原地增表前的历史消息-${label}`;
  let runtime;
  try {
    runtime = await kernel.RuntimeDatabase.open(authority);
    const store = new kernel.ContentAddressedStore(authority, binding);
    const content = await store.ingest(
      runtime,
      JSON.stringify({ role: 'user', parts: [{ text: messageText }] }),
      'application/vnd.limcode.message+json'
    );
    await runtime.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId,
        title: conversationTitle,
        status: 'active',
        created_at: '2026-08-20T10:00:00.000Z',
        updated_at: '2026-08-20T10:00:00.000Z'
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Message').insert({
        id: `${conversationId}_message`,
        created_at: '2026-08-20T10:00:00.000Z',
        updated_at: '2026-08-20T10:00:00.000Z',
        deleted_at: null
      }),
      kernel.DOMAIN_REPOSITORIES.domain('MessageRevision').insert({
        id: `${conversationId}_revision`,
        message_id: `${conversationId}_message`,
        revision_seq: 1n,
        role: 'user',
        content_object_id: content.id,
        created_at: '2026-08-20T10:00:00.000Z'
      }),
      kernel.DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
        id: `${conversationId}_current`,
        message_id: `${conversationId}_message`,
        revision_id: `${conversationId}_revision`,
        updated_at: '2026-08-20T10:00:00.000Z'
      }),
      kernel.DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insert({
        id: `${conversationId}_membership`,
        conversation_id: conversationId,
        message_id: `${conversationId}_message`,
        message_seq: 1n,
        created_at: '2026-08-20T10:00:00.000Z'
      })
    ]);
    const legacyContinuation = await seedLegacyChildRuntimeContinuation(
      runtime,
      store,
      conversationId,
      label
    );
    await runtime.close();
    runtime = undefined;

    const database = new Database(kernel.toSqliteFilePath(binding.paths.databasePath), { fileMustExist: true });
    try {
      database.defaultSafeIntegers(true);
      database.exec('BEGIN IMMEDIATE');
      try {
        database.exec('DROP TABLE runtime_delivery_intent_link');
        database.prepare(
          "DELETE FROM schema_manifest WHERE domain_key = 'RuntimeDeliveryIntentLink'"
        ).run();
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      database.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      database.close();
    }
    return {
      authority,
      runtimeScopeRoot,
      binding,
      conversationId,
      conversationTitle,
      contentObjectId: content.id,
      messageText,
      legacyContinuation
    };
  } catch (error) {
    if (runtime) await runtime.close().catch(() => undefined);
    await fs.rm(runtimeScopeRoot, { recursive: true, force: true });
    throw error;
  }
}

async function createEpoch3RuntimeFixture(label, options = {}) {
  const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-epoch3-${label}-`));
  const runtimeScopeRoot = options.productionDepth
    ? path.join(
        cleanupRoot,
        'globalStorage',
        '.limcode-workspace-runtimes',
        'scopes',
        `folder-${'a'.repeat(64)}`
      )
    : cleanupRoot;
  const dataRootPath = path.join(runtimeScopeRoot, '.limcode-runtime', 'active');
  const authority = new kernel.RootAuthority(() => dataRootPath);
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  const conversationId = `conversation_epoch3_${label.replace(/[^a-z0-9]+/gi, '_')}`;
  const conversationTitle = `历史对话-${label}`;
  const oldMessageText = `升级前保留的历史消息-${label}`;
  let runtime;
  try {
    runtime = await kernel.RuntimeDatabase.open(authority);
    const store = new kernel.ContentAddressedStore(authority, binding);
    const oldContent = await store.ingest(
      runtime,
      JSON.stringify({ role: 'user', parts: [{ text: oldMessageText }] }),
      'application/vnd.limcode.message+json'
    );
    await runtime.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId,
        title: conversationTitle,
        status: 'active',
        created_at: '2026-08-12T10:32:06.768Z',
        updated_at: '2026-08-12T10:32:06.768Z'
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Message').insert({
        id: `${conversationId}_old_message`,
        created_at: '2026-08-12T10:32:06.768Z',
        updated_at: '2026-08-12T10:32:06.768Z',
        deleted_at: null
      }),
      kernel.DOMAIN_REPOSITORIES.domain('MessageRevision').insert({
        id: `${conversationId}_old_revision`,
        message_id: `${conversationId}_old_message`,
        revision_seq: 1n,
        role: 'user',
        content_object_id: oldContent.id,
        created_at: '2026-08-12T10:32:06.768Z'
      }),
      kernel.DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
        id: `${conversationId}_old_current`,
        message_id: `${conversationId}_old_message`,
        revision_id: `${conversationId}_old_revision`,
        updated_at: '2026-08-12T10:32:06.768Z'
      }),
      kernel.DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insert({
        id: `${conversationId}_old_membership`,
        conversation_id: conversationId,
        message_id: `${conversationId}_old_message`,
        message_seq: 1n,
        created_at: '2026-08-12T10:32:06.768Z'
      })
    ]);
    const legacyContinuation = await seedLegacyChildRuntimeContinuation(
      runtime,
      store,
      conversationId,
      label
    );
    await runtime.close();
    runtime = undefined;

    const database = new Database(kernel.toSqliteFilePath(binding.paths.databasePath), { fileMustExist: true });
    try {
      database.defaultSafeIntegers(true);
      database.exec('BEGIN IMMEDIATE');
      try {
        database.exec('DROP TABLE runtime_delivery_intent_link');
        database.exec('DROP TABLE compression_block_observation_link');
        database.exec('DROP TABLE attachment_observation_link');
        database.exec('DROP TABLE conversation_attachment_handle_link');
        database.prepare(`
          DELETE FROM schema_manifest
           WHERE domain_key IN (
             'ConversationAttachmentHandleLink',
             'AttachmentObservationLink',
             'CompressionBlockObservationLink',
             'RuntimeDeliveryIntentLink'
           )
        `).run();
        database.prepare(
          'UPDATE schema_manifest SET runtime_kernel_epoch = @epoch'
        ).run({ epoch: BigInt(kernel.PREVIOUS_RUNTIME_KERNEL_EPOCH) });
        const modelContextProjection = kernel.PREVIOUS_RUNTIME_DOMAIN_SCHEMAS.find(
          (schema) => schema.key === 'ModelContextProjection'
        );
        assert.ok(modelContextProjection);
        const modelContextProjectionClientMapping = options.modelContextProjectionClientMapping ?? 'summary';
        const modelContextProjectionSchemaDigest = kernel.domainSchemaDigest({
          ...modelContextProjection,
          client: modelContextProjectionClientMapping
        });
        if (modelContextProjectionClientMapping === 'detail') {
          assert.equal(
            modelContextProjectionSchemaDigest,
            kernel.EPOCH_3_MODEL_CONTEXT_DETAIL_SCHEMA_DIGEST
          );
        } else if (modelContextProjectionClientMapping === 'summary') {
          assert.equal(
            modelContextProjectionSchemaDigest,
            kernel.EPOCH_3_MODEL_CONTEXT_SUMMARY_SCHEMA_DIGEST
          );
        }
        const manifestUpdate = database.prepare(`
          UPDATE schema_manifest
             SET client_mapping = @clientMapping,
                 schema_digest = @schemaDigest
           WHERE domain_key = 'ModelContextProjection'
             AND runtime_kernel_epoch = @epoch
        `).run({
          clientMapping: modelContextProjectionClientMapping,
          schemaDigest: modelContextProjectionSchemaDigest,
          epoch: BigInt(kernel.PREVIOUS_RUNTIME_KERNEL_EPOCH)
        });
        assert.equal(manifestUpdate.changes, 1);
        database.prepare(
          'UPDATE root_binding SET runtime_kernel_epoch = @epoch WHERE singleton = 1'
        ).run({ epoch: BigInt(kernel.PREVIOUS_RUNTIME_KERNEL_EPOCH) });
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      database.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      database.close();
    }

    const previousBinding = {
      ...binding,
      paths: { ...binding.paths },
      runtimeKernelEpoch: kernel.PREVIOUS_RUNTIME_KERNEL_EPOCH
    };
    const epochManifest = JSON.parse(await fs.readFile(binding.paths.runtimeEpochPath, 'utf8'));
    epochManifest.runtimeKernelEpoch = kernel.PREVIOUS_RUNTIME_KERNEL_EPOCH;
    await fs.writeFile(
      binding.paths.runtimeEpochPath,
      `${JSON.stringify(epochManifest, null, 2)}\n`
    );
    await fs.writeFile(
      binding.paths.rootPointerPath,
      `${JSON.stringify(previousBinding, null, 2)}\n`
    );
    return {
      authority,
      cleanupRoot,
      runtimeScopeRoot,
      paths: binding.paths,
      previousBinding,
      modelContextProjectionClientMapping: options.modelContextProjectionClientMapping ?? 'summary',
      conversationId,
      conversationTitle,
      oldContentObjectId: oldContent.id,
      oldMessageText,
      legacyContinuation
    };
  } catch (error) {
    if (runtime) await runtime.close().catch(() => undefined);
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

async function assertMigratedLegacyChildContinuation(runtime, store, expected) {
  const snapshot = await runtime.snapshot([
    kernel.DOMAIN_REPOSITORIES.domain('RuntimeDeliveryIntentLink').get(expected.ids.deliveryIntentLinkId),
    kernel.DOMAIN_REPOSITORIES.domain('TurnIntentRevision').get(expected.ids.turnIntentRevisionId),
    kernel.DOMAIN_REPOSITORIES.domain('TurnExecutionPresetRevision').get(expected.ids.presetRevisionId)
  ]);
  const link = snapshot.snapshot[0];
  const revision = snapshot.snapshot[1];
  const preset = snapshot.snapshot[2];
  assert.equal(link?.delivery_id, expected.deliveryId);
  assert.equal(link?.turn_intent_id, expected.ids.turnIntentId);

  const contents = await runtime.snapshot([
    kernel.DOMAIN_REPOSITORIES.domain('ContentObject').get(revision.content_object_id),
    kernel.DOMAIN_REPOSITORIES.domain('ContentObject').get(preset.preset_object_id)
  ]);
  assert.deepEqual(
    JSON.parse((await store.read(contents.snapshot[0])).toString('utf8')),
    { kind: 'runtime_continuation', sourceTurnId: expected.sourceTurnId, version: 1 }
  );
  assert.deepEqual(
    JSON.parse((await store.read(contents.snapshot[1])).toString('utf8')),
    { kind: 'runtime_continuation' }
  );

  const effects = new kernel.EffectControlPlane(runtime, store);
  const children = new kernel.ChildExecutionControlPlane(runtime, store, effects, {
    authorityCompiler: {
      async compile() {
        assert.fail('migrated continuation replay must not compile new authority');
      }
    }
  });
  const replay = await children.queueRuntimeDeliveryContinuation({
    deliveryId: expected.deliveryId,
    childExecutionId: expected.childExecutionId,
    sourceTurnId: expected.sourceTurnId
  });
  assert.equal(replay?.deduplicated, true);
  assert.equal(replay?.turnIntentId, expected.ids.turnIntentId);
}

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
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !['path', 'programfiles', 'programw6432', 'programfiles(x86)'].includes(key.toLowerCase())
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
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !['path', 'programfiles', 'programw6432', 'programfiles(x86)'].includes(key.toLowerCase())
  ));
  env.PATH = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)
    .filter((directory) => !existsSync(path.join(directory.trim().replace(/^"(.*)"$/, '$1'), 'pwsh.exe')))
    .join(path.delimiter);
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
