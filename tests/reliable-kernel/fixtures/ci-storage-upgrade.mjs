// Exact published predecessors. This helper seeds history; it registers no tests or fault matrix.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { kernel, Database } from './runtime-merge-fixture.mjs';

export async function createPublishedRuntime(previousEpoch, options = {}) {
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
    const store = kernel.ContentAddressedStore.loose(authority, binding);
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
    const contextRootId = options.contextHead ? `${conversationId}_selected_context` : undefined;
    if (contextRootId) {
      const at = '2026-09-01T00:00:00.000Z';
      await runtime.transaction([
        kernel.DOMAIN_REPOSITORIES.domain('ContextSegment').insert({
          id: `${conversationId}_segment`, content_object_id: content.id, segment_kind: 'user', created_at: at
        }),
        kernel.DOMAIN_REPOSITORIES.domain('ContextSequenceNode').insert({
          id: `${conversationId}_node`, parent_node_id: null, segment_id: `${conversationId}_segment`, created_at: at
        }),
        kernel.DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insert({
          id: contextRootId, conversation_id: conversationId, root_seq: 1n, root_node_id: `${conversationId}_node`,
          tail_node_id: null, tail_segment_count: 0n, segment_count: 1n, estimated_tokens: 1n, created_at: at
        }),
        kernel.DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insert({
          id: `${conversationId}_discarded_context`, conversation_id: conversationId, root_seq: 2n,
          root_node_id: `${conversationId}_node`, tail_node_id: null, tail_segment_count: 0n,
          segment_count: 1n, estimated_tokens: 1n, created_at: at
        }),
        kernel.DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').insert({
          id: `${conversationId}_head`, conversation_id: conversationId, root_id: contextRootId, updated_at: at
        })
      ]);
    }
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
    const legacyContinuations = [];
    if (!options.omitLegacyContinuation && (previousEpoch === 3 || options.missingDeliveryLink)) {
      for (let index = 0; index < (options.continuationCount ?? 1); index++) {
        const childConversationId = index === 0 ? conversationId : `${conversationId}_continuation_${index}`;
        if (index !== 0) await runtime.transaction([
          kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
            id: childConversationId, title: `旧子任务 ${index}`, status: 'active',
            created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z'
          })
        ]);
        legacyContinuations.push(await seedLegacyChildRuntimeContinuation(runtime, store, childConversationId,
          index === 0 ? String(previousEpoch) : `${previousEpoch}_${index}`));
      }
    }
    const legacyContinuation = legacyContinuations[0];
    await runtime.close();
    runtime = undefined;

    const oldSchemas = previousEpoch === 3
      ? kernel.PREVIOUS_RUNTIME_DOMAIN_SCHEMAS
      : previousEpoch === 5 ? kernel.EPOCH_5_RUNTIME_DOMAIN_SCHEMAS
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
        // Current tables retain their data, but their indexes and manifest must describe the
        // exact published epoch. New indexes on retained tables are not removed by DROP TABLE.
        const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL");
        for (const schema of oldSchemas) {
          for (const { name } of indexes.all(schema.table)) database.exec(`DROP INDEX "${name.replaceAll('"', '""')}"`);
          schema.indexes.forEach((index, ordinal) => database.exec(kernel.createRuntimeDomainIndexSql(schema, index, ordinal)));
        }
        database.exec('DELETE FROM schema_manifest');
        const manifestRow = database.prepare('INSERT INTO schema_manifest VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const schema of oldSchemas) manifestRow.run(schema.key, schema.table, schema.schemaOwner, schema.repository, schema.codec,
          JSON.stringify(schema.mutations), schema.client, schema.deletePolicy, schema.resetPolicy,
          JSON.stringify(schema.indexes), kernel.domainSchemaDigest(schema), BigInt(previousEpoch));
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
      contentId: content.id, contextRootId, settingsPath, workspacePath, legacyContinuation, legacyContinuations,
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

export async function seedCommittedEpoch4To5(fixture) {
  const next = { ...fixture.previous, rootGeneration: fixture.previous.rootGeneration + 1,
    pointerRevision: fixture.previous.pointerRevision + 1, runtimeKernelEpoch: 5 };
  const control = path.dirname(fixture.paths.dataRootPath);
  const backupDirectoryName = '20260924T120000Z-deadbeef';
  const backupRoot = path.join(control, kernel.RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY, backupDirectoryName);
  await fs.mkdir(backupRoot, { recursive: true });
  await fs.writeFile(fixture.paths.rootPendingPath, JSON.stringify(next));
  const backupFile = path.join(backupRoot, 'limcode.epoch-4.sqlite');
  const source = new Database(fixture.paths.databasePath, { readonly: true });
  try { await source.backup(backupFile); } finally { source.close(); }
  await fs.writeFile(path.join(backupRoot, 'root-binding.epoch-4.json'), JSON.stringify(fixture.previous));
  await fs.writeFile(path.join(backupRoot, 'runtime-kernel-epoch.epoch-4.json'), await fs.readFile(fixture.paths.runtimeEpochPath));
  const db = new Database(fixture.paths.databasePath);
  try {
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    for (const schema of kernel.EPOCH_5_RUNTIME_DOMAIN_SCHEMAS) if (!tables.has(schema.table)) {
      db.exec(kernel.createRuntimeDomainTableSql(schema));
      schema.indexes.forEach((index, ordinal) => db.exec(kernel.createRuntimeDomainIndexSql(schema, index, ordinal)));
    }
    db.exec('DELETE FROM schema_manifest');
    const insert = db.prepare('INSERT INTO schema_manifest VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const schema of kernel.EPOCH_5_RUNTIME_DOMAIN_SCHEMAS) insert.run(schema.key, schema.table, schema.schemaOwner,
      schema.repository, schema.codec, JSON.stringify(schema.mutations), schema.client, schema.deletePolicy, schema.resetPolicy,
      JSON.stringify(schema.indexes), kernel.domainSchemaDigest(schema), 5);
    db.prepare('UPDATE root_binding SET runtime_kernel_epoch = 5, root_generation = ?, pointer_revision = ?')
      .run(next.rootGeneration, next.pointerRevision);
    db.exec('COMMIT');
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  const journalPath = path.join(control, kernel.RETIRED_EPOCH_TO_5_JOURNAL_FILE);
  await fs.writeFile(journalPath, JSON.stringify({
    kind: 'limcode-runtime-epoch-migration', fromEpoch: 4, toEpoch: 5, attemptId: 'published-boundary-fixture',
    state: 'backed_up', backupDirectoryName, previousBinding: fixture.previous, nextBinding: next,
    databaseBackupSha256: createHash('sha256').update(await fs.readFile(backupFile)).digest('hex'),
    createdAt: '2026-09-24T12:00:00.000Z', updatedAt: '2026-09-24T12:00:00.000Z'
  }));
  return { next, journalPath, backupRoot };
}
