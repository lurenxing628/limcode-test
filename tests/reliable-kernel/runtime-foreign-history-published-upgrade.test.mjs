// Foreign history left by released versions (published epochs 3/4/5): a reset archive and a copied data
// directory whose schema is exactly the published one are upgraded only in private copies
// (runtimeSnapshotUpgrade, run in a worker). They are verified, viewed read-only and merged, Child
// continuations an epoch-3 predecessor still stores in the old format are converted into the private
// overlay under the current configuration root and travel with the merge, the audit result is cached
// (a second listing upgrades nothing again) and the foreign files stay byte for byte as they were.
// Runs against the compiled extension.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compiled, createConfigurationRoot, Database, kernel, kernelFile, MESSAGE_TYPE, readLedgerRecord, repo, withRuntime
} from './fixtures/runtime-merge-fixture.mjs';

const require = createRequire(import.meta.url);
const workerThreads = require('node:worker_threads');
const foreign = kernelFile('runtimeForeignHistory.js');
const foreignMerge = kernelFile('runtimeForeignHistoryMerge.js');
const { mergeHistoricalDataSetsOnline } = kernelFile('runtimeDataSetMerge.js');
const { openRuntimeDataSetHistory } = kernelFile('runtimeDataSetHistory.js');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { resolveVscodeRuntimeMergeLedgerRoot } = kernelFile('vscodeRootAuthority.js');
const { archiveCurrentRuntimeRootForReset } = require(path.join(
  compiled, 'backend/application/reliableKernel/VscodeReliableKernelCutoverCoordinator.js'
));

const CREATED_AT = '2026-08-12T10:40:00.000Z';

/** Every entry below `root`: type, inode, size, times and content; any new file, sidecar or rewrite changes it. */
async function treeState(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      const stat = await fs.lstat(file, { bigint: true });
      const key = path.relative(root, file);
      if (entry.isDirectory()) { result[key] = `dir:${stat.ino}:${stat.mtimeNs}`; await visit(file); }
      else if (entry.isSymbolicLink()) result[key] = `link:${stat.ino}:${await fs.readlink(file)}`;
      else result[key] = `file:${stat.ino}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`;
    }
  }
  await visit(root);
  return result;
}

async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Counts the private-copy upgrades (runtimeSnapshotUpgradeWorker threads) started until the test ends. */
function countUpgrades(t) {
  const Original = workerThreads.Worker;
  const counter = { upgrades: 0 };
  workerThreads.Worker = class extends Original {
    constructor(file, ...rest) {
      if (String(file).endsWith('runtimeSnapshotUpgradeWorker.js')) counter.upgrades += 1;
      super(file, ...rest);
    }
  };
  t.after(() => { workerThreads.Worker = Original; });
  return counter;
}

/** A directory holding the current configuration root (the fixed root selected, workspace data set alpha). */
async function home(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-foreign-published-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { ...await createConfigurationRoot({ tmp: base }), base };
}

/** One Conversation with one user message, written by the current Runtime before the data set is relabeled. */
async function seedHistory(dataSet, prefix, { legacyContinuation = false } = {}) {
  return withRuntime(dataSet, async (runtime, store) => {
    const conversationId = `${prefix}_conversation`;
    const message = `${prefix} 升级前的旧消息正文`;
    const content = await store.ingest(runtime, JSON.stringify({ role: 'user', parts: [{ text: message }] }), MESSAGE_TYPE);
    await runtime.transaction([
      repo('Conversation').insert({ id: conversationId, title: `${prefix} 旧对话`, status: 'active', created_at: CREATED_AT, updated_at: CREATED_AT }),
      repo('Message').insert({ id: `${conversationId}_message`, created_at: CREATED_AT, updated_at: CREATED_AT, deleted_at: null }),
      repo('MessageRevision').insert({
        id: `${conversationId}_revision`, message_id: `${conversationId}_message`, revision_seq: 1n, role: 'user',
        content_object_id: content.id, created_at: CREATED_AT
      }),
      repo('MessageCurrentRevisionLink').insert({
        id: `${conversationId}_current`, message_id: `${conversationId}_message`, revision_id: `${conversationId}_revision`, updated_at: CREATED_AT
      }),
      repo('MessagePartOfConversation').insert({
        id: `${conversationId}_member`, conversation_id: conversationId, message_id: `${conversationId}_message`, message_seq: 1n, created_at: CREATED_AT
      })
    ]);
    const legacy = legacyContinuation ? await seedFinishedLegacyChildContinuation(runtime, store, conversationId, prefix) : undefined;
    return { conversationId, message, legacy };
  });
}

/**
 * A Child continuation in the format published epoch 3 stored (the same rows as
 * runtime-epoch-upgrade-preservation's seedLegacyChildRuntimeContinuation), already finished: a foreign
 * root is never closed in place, so a queued intent or pending delivery there blocks its merge by design
 * (runtime-data-set-merge-foreign-unfinished-work). Cancelled intent and link and a failed delivery are
 * the states the kernel's own transitions leave (answerDelivery supersededContinuationSteps / expiry);
 * the upgrade converts the old-format bodies regardless of state.
 */
async function seedFinishedLegacyChildContinuation(runtime, store, conversationId, label) {
  const suffix = label.replace(/[^a-z0-9]+/gi, '_');
  const childExecutionId = `legacy_child_execution_${suffix}`;
  const sourceTurnId = `legacy_child_source_turn_${suffix}`;
  const deliveryId = `legacy_child_delivery_${suffix}`;
  const inboxItemId = `legacy_child_inbox_${suffix}`;
  const ids = kernel.childRuntimeDeliveryContinuationIds({ deliveryId, childExecutionId, sourceTurnId });
  const legacyIntent = await store.ingest(runtime,
    kernel.canonicalPlainJson({ kind: 'child-runtime-delivery-continuation', deliveryId, sourceTurnId }),
    kernel.CHILD_RUNTIME_DELIVERY_CONTINUATION_CONTENT_TYPE);
  const legacyPreset = await store.ingest(runtime,
    kernel.canonicalPlainJson({ kind: 'child-runtime-delivery-continuation' }), kernel.TURN_EXECUTION_PRESET_CONTENT_TYPE);
  await runtime.transaction([
    repo('AgentConversationLink').insert({
      id: `legacy_child_agent_link_${suffix}`, conversation_id: conversationId, agent_id: `legacy_child_agent_${suffix}`,
      role: 'default', created_at: CREATED_AT, updated_at: CREATED_AT
    }),
    repo('Turn').insert({ id: sourceTurnId, conversation_id: conversationId, status: 'terminated', created_at: CREATED_AT, updated_at: CREATED_AT, terminal_at: CREATED_AT }),
    repo('TurnTermination').insert({
      id: `legacy_child_termination_${suffix}`, turn_id: sourceTurnId, terminal_status: 'completed',
      reason: 'legacy continuation migration fixture', created_at: CREATED_AT
    }),
    repo('ChildExecution').insert({ id: childExecutionId, child_conversation_id: conversationId, status: 'idle', created_at: CREATED_AT, updated_at: CREATED_AT }),
    repo('ChildExecutionParentLink').insert({
      id: `legacy_child_parent_link_${suffix}`, child_execution_id: childExecutionId, source_tool_call_id: `legacy_child_source_tool_${suffix}`,
      parent_child_execution_id: null, parent_turn_id: null, created_at: CREATED_AT
    }),
    repo('ChildExecutionTurnLink').insert({
      id: `legacy_child_turn_link_${suffix}`, child_execution_id: childExecutionId, turn_seq: 1n, turn_id: sourceTurnId, created_at: CREATED_AT
    }),
    repo('AnswerBridge').insert({
      id: `legacy_child_answer_bridge_${suffix}`, child_execution_id: childExecutionId, current_submission_id: null,
      status: 'open', created_at: CREATED_AT, updated_at: CREATED_AT
    }),
    repo('RuntimeInboxItem').insert({
      id: inboxItemId, dedupe_key: `legacy-child-continuation:${suffix}`, source_kind: 'process_receipt',
      source_id: `legacy_child_source_${suffix}`, state: 'available', created_at: CREATED_AT, updated_at: CREATED_AT
    }),
    repo('RuntimeDelivery').insert({
      id: deliveryId, inbox_item_id: inboxItemId, target_conversation_id: conversationId, target_turn_id: null,
      phase: 'next_turn', attempt_seq: 1n, retry_of_delivery_id: null, state: 'pending', failure_reason: null,
      created_at: CREATED_AT, updated_at: CREATED_AT
    }),
    repo('CommandReceipt').insert({
      id: ids.commandReceiptId, source_kind: 'internal', source_key: ids.sourceKey, conversation_id: conversationId,
      turn_id: sourceTurnId, created_at: CREATED_AT
    }),
    repo('TurnIntent').insert({ id: ids.turnIntentId, conversation_id: conversationId, turn_id: null, state: 'queued', created_at: CREATED_AT, updated_at: CREATED_AT }),
    repo('TurnIntentRevision').insert({
      id: ids.turnIntentRevisionId, intent_id: ids.turnIntentId, revision_seq: 1n, content_object_id: legacyIntent.id, created_at: CREATED_AT
    }),
    repo('TurnExecutionPresetRevision').insert({
      id: ids.presetRevisionId, intent_id: ids.turnIntentId, revision_seq: 1n, preset_object_id: legacyPreset.id, created_at: CREATED_AT
    }),
    repo('ChildExecutionIntentLink').insert({
      id: ids.intentLinkId, child_execution_id: childExecutionId, intent_seq: 1n, turn_intent_id: ids.turnIntentId,
      state: 'pending', created_at: CREATED_AT, updated_at: CREATED_AT
    })
  ]);
  await runtime.transaction([
    repo('TurnIntent').update(ids.turnIntentId, { state: 'cancelled', updated_at: CREATED_AT }),
    repo('ChildExecutionIntentLink').update(ids.intentLinkId, { state: 'cancelled', updated_at: CREATED_AT }),
    repo('RuntimeDelivery').update(deliveryId, { state: 'failed', failure_reason: 'legacy-continuation-fixture', updated_at: CREATED_AT })
  ]);
  return { deliveryId, sourceTurnId, ids, legacyIntent, legacyPreset };
}

/**
 * Rewrites a closed data set into the exact schema a released version left (as
 * runtime-epoch-upgrade-preservation's createPublishedRuntime does): tables added since are dropped,
 * indexes and the manifest describe the published epoch, and the database, pointer and epoch manifest
 * record that epoch.
 */
async function relabelAsPublished({ databasePath, rootPointerPath, runtimeEpochPath }, epoch) {
  const oldSchemas = epoch === 3 ? kernel.PREVIOUS_RUNTIME_DOMAIN_SCHEMAS
    : epoch === 4 ? kernel.EPOCH_4_RUNTIME_DOMAIN_SCHEMAS : kernel.EPOCH_5_RUNTIME_DOMAIN_SCHEMAS;
  const oldKeys = new Set(oldSchemas.map((schema) => schema.key));
  const added = kernel.RUNTIME_DOMAIN_SCHEMAS.filter((schema) => !oldKeys.has(schema.key));
  const database = new Database(kernel.toSqliteFilePath(databasePath));
  try {
    database.defaultSafeIntegers(true);
    database.pragma('foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const schema of [...added].reverse()) database.exec(`DROP TABLE ${schema.table}`);
      const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL");
      for (const schema of oldSchemas) {
        for (const { name } of indexes.all(schema.table)) database.exec(`DROP INDEX "${name.replaceAll('"', '""')}"`);
        schema.indexes.forEach((index, ordinal) => database.exec(kernel.createRuntimeDomainIndexSql(schema, index, ordinal)));
      }
      database.exec('DELETE FROM schema_manifest');
      const manifestRow = database.prepare('INSERT INTO schema_manifest VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const schema of oldSchemas) manifestRow.run(schema.key, schema.table, schema.schemaOwner, schema.repository, schema.codec,
        JSON.stringify(schema.mutations), schema.client, schema.deletePolicy, schema.resetPolicy,
        JSON.stringify(schema.indexes), kernel.domainSchemaDigest(schema), BigInt(epoch));
      database.prepare('UPDATE root_binding SET runtime_kernel_epoch = ? WHERE singleton = 1').run(BigInt(epoch));
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
    database.pragma('wal_checkpoint(TRUNCATE)');
  } finally { database.close(); }
  for (const file of [rootPointerPath, runtimeEpochPath]) {
    await fs.writeFile(file, `${JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), runtimeKernelEpoch: epoch }, null, 2)}\n`);
  }
}

/** A published epoch-5 LimCode data directory made elsewhere, copied beside the current configuration root. */
async function publishedCopiedDirectory(fixture) {
  const elsewhere = await createConfigurationRoot({ tmp: fixture.base });
  const seeded = await seedHistory(elsewhere.current, 'copied_epoch_5');
  await relabelAsPublished(elsewhere.current.binding.paths, 5);
  const container = path.join(fixture.base, `${path.basename(fixture.root)}.limcode-copied-2026-09-28T01-02-03-004Z-00000005`);
  await fs.cp(elsewhere.root, container, { recursive: true });
  return { container, seeded };
}

/** A reset archive (v0.0.10–v0.0.20 “归档并重置”) of workspace data set alpha, left in published epoch 3. */
async function publishedArchive(fixture) {
  const seeded = await seedHistory(fixture.alpha, 'archive_epoch_3', { legacyContinuation: true });
  const paths = fixture.alpha.binding.paths;
  const authority = new RootAuthority(() => paths.dataRootPath, undefined, () => fixture.root);
  const archived = await archiveCurrentRuntimeRootForReset(authority, fixture.alpha.scopeRoot);
  assert.equal(archived.archived, true);
  const controlRoot = path.dirname(paths.rootPointerPath);
  const moved = (file) => path.join(archived.backupPath, path.relative(controlRoot, file));
  await relabelAsPublished({
    databasePath: moved(paths.databasePath), rootPointerPath: moved(paths.rootPointerPath), runtimeEpochPath: moved(paths.runtimeEpochPath)
  }, 3);
  return { container: archived.backupPath, casRootPath: moved(paths.casRootPath), seeded };
}

/** The foreign entry discovery finds in `containerPath` (a copied directory's default scope, or an archive) with its located root. */
async function found(fixture, containerPath, scope) {
  const entries = await foreign.discoverForeignRuntimeHistory({ configurationRootPath: fixture.root });
  const entry = entries.find((item) => item.location.containerPath === containerPath && (scope === undefined || item.scope === scope));
  assert.ok(entry, `发现 ${containerPath}：${JSON.stringify(entries.map((item) => [item.location.containerPath, item.scope]))}`);
  const root = await foreign.locateForeignRuntimeRoot(fixture.root, entry.location);
  return { ...entry, root, label: `外来历史库（${entry.name}）` };
}

async function merge(fixture, source) {
  await foreignMerge.requestForeignRuntimeHistoryMerge(fixture.paths, {
    id: source.id, location: source.location, label: source.label,
    expectedDataSetId: source.root.recorded.dataSetId, expectedRootInstanceId: source.root.recorded.rootInstanceId
  });
  const database = await kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `window-${randomUUID()}` });
  try {
    return await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database }, {
      candidateIds: [source.id], requested: true
    });
  } finally { await database.close(); }
}

function query(databasePath, sql, ...parameters) {
  const database = new Database(databasePath, { readonly: true });
  try { return database.prepare(sql).all(...parameters); } finally { database.close(); }
}

/** Lists the foreign roots twice: verified (not upgrade-failed / epoch-not-current), the second listing from the audit cache. */
async function assertVerifiedAndCached(fixture, source, counter) {
  const entryOf = async () => (await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root })).entries
    .find((entry) => entry.id === source.id);
  const before = counter.upgrades;
  const first = await entryOf();
  assert.equal(first?.status, 'verified', JSON.stringify(first));
  assert.equal(first.code, undefined);
  assert.ok(counter.upgrades > before, '核验在私有副本上升级了一次');
  const cache = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'foreign', `${source.id.replace(/:/g, '-')}.json`);
  assert.ok(await exists(cache), '核验结果缓存在当前配置根');
  const upgrades = counter.upgrades;
  const second = await entryOf();
  assert.deepEqual([second?.status, second?.code, second?.size], [first.status, first.code, first.size]);
  assert.equal(counter.upgrades, upgrades, '再次列出命中缓存，不再复制和升级');
}

/** The foreign root as readable history (a private, upgraded copy), never the root itself. */
async function assertReadable(fixture, source, seeded) {
  const reader = await openRuntimeDataSetHistory(fixture.paths, await foreign.locateForeignRuntimeRoot(fixture.root, source.location));
  try {
    const { items } = await reader.listConversations();
    assert.ok(items.some((item) => item.id === seeded.conversationId), JSON.stringify(items));
    const messages = await reader.readMessages(seeded.conversationId);
    assert.equal(messages.items.length, 1);
    assert.match(messages.items[0].text, new RegExp(seeded.message));
  } finally { await reader.close(); }
}

/** Merged once, listed as merged with nothing new, and a second merge into the target that already holds it only says so. */
async function assertMergedOnce(fixture, source, seeded) {
  const report = await merge(fixture, source);
  assert.deepEqual([report.deferred, report.blocked, report.failures], [[], [], []], JSON.stringify(report));
  assert.deepEqual(report.merged.map((item) => [item.candidateId, item.insertedConversations, item.alreadyMerged]), [[source.id, 1, undefined]]);
  assert.ok(query(fixture.current.binding.paths.databasePath, 'SELECT id FROM conversation WHERE id = ?', seeded.conversationId).length === 1);
  const record = await readLedgerRecord(fixture, source.id);
  assert.deepEqual([record.state, record.source.dataSetId], ['merged', source.root.recorded.dataSetId]);

  const { entries } = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root });
  const state = (await foreignMerge.readForeignRuntimeHistoryMergeStates(fixture.paths, entries)).get(source.id);
  assert.deepEqual([state?.state, state?.intoCurrent, state?.changedSinceMerge], ['merged', true, false],
    '升级后的副本指纹稳定：列表显示已合并、没有新变化');

  const again = await merge(fixture, source);
  assert.deepEqual([again.deferred, again.blocked, again.failures], [[], [], []], JSON.stringify(again));
  assert.deepEqual(again.merged.map((item) => [item.candidateId, item.alreadyMerged, item.insertedRows]), [[source.id, true, 0]],
    '已经包含这些对话的当前库再合并一次：没有冲突，只提示没有新内容');
}

test('已发布第 5 代的拷来目录：在私有副本上升级后核验通过并缓存、只读查看与合并成功，再合并只提示没有新内容；拷来目录一字节不变', async (t) => {
  const fixture = await home(t);
  const { container, seeded } = await publishedCopiedDirectory(fixture);
  const before = await treeState(container);
  const counter = countUpgrades(t);
  const source = await found(fixture, container, 'default');
  assert.equal(source.root.recorded.runtimeKernelEpoch, 5);

  await assertVerifiedAndCached(fixture, source, counter);
  await assertReadable(fixture, source, seeded);
  await assertMergedOnce(fixture, source, seeded);
  assert.deepEqual(await treeState(container), before, '拷来目录逐字节、逐 inode 不变');
});

test('已发布第 3 代的“归档并重置”归档（带旧格式子 Agent 续接）：转换出的正文只进当前配置根的私有覆盖目录，随合并进当前库；归档一字节不变', async (t) => {
  const fixture = await home(t);
  const { container, casRootPath, seeded } = await publishedArchive(fixture);
  const before = await treeState(container);
  const counter = countUpgrades(t);
  const source = await found(fixture, container);
  assert.equal(source.location.kind, 'archive');
  assert.equal(source.root.recorded.runtimeKernelEpoch, 3);
  const overlay = source.root.upgradeCasOverlayRoot;
  assert.ok(overlay && path.relative(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), overlay).startsWith('foreign-upgrade-cas'),
    `覆盖目录在当前配置根的合并账本下：${overlay}`);

  await assertVerifiedAndCached(fixture, source, counter);
  await assertReadable(fixture, source, seeded);
  await assertMergedOnce(fixture, source, seeded);

  // The converted continuation bodies: present in the current data set and the private overlay, never in the archive.
  const legacy = seeded.legacy;
  const [intentObject] = query(fixture.current.binding.paths.databasePath, `SELECT content.* FROM turn_intent_revision revision
    JOIN content_object content ON content.id = revision.content_object_id WHERE revision.id = ?`, legacy.ids.turnIntentRevisionId);
  const [presetObject] = query(fixture.current.binding.paths.databasePath, `SELECT content.* FROM turn_execution_preset_revision revision
    JOIN content_object content ON content.id = revision.preset_object_id WHERE revision.id = ?`, legacy.ids.presetRevisionId);
  assert.notEqual(intentObject.id, legacy.legacyIntent.id, '续接意图改指转换后的新正文');
  assert.notEqual(presetObject.id, legacy.legacyPreset.id);
  const [link] = query(fixture.current.binding.paths.databasePath, 'SELECT * FROM runtime_delivery_intent_link WHERE id = ?', legacy.ids.deliveryIntentLinkId);
  assert.deepEqual([link?.delivery_id, link?.turn_intent_id], [legacy.deliveryId, legacy.ids.turnIntentId]);
  const runtime = await kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `reader-${randomUUID()}` });
  try {
    const objects = (await runtime.snapshot([
      repo('ContentObject').get(intentObject.id), repo('ContentObject').get(presetObject.id)
    ])).snapshot;
    const cas = kernel.ContentAddressedStore.loose(fixture.current.authority, fixture.current.binding);
    assert.deepEqual(JSON.parse((await cas.read(objects[0])).toString('utf8')),
      { kind: 'runtime_continuation', sourceTurnId: legacy.sourceTurnId, version: 1 });
    assert.deepEqual(JSON.parse((await cas.read(objects[1])).toString('utf8')), { kind: 'runtime_continuation' });
  } finally { await runtime.close(); }
  for (const object of [intentObject, presetObject]) {
    const key = String(object.storage_key).split('/');
    assert.ok(await exists(path.join(overlay, ...key)), `转换出的正文在私有覆盖目录：${object.storage_key}`);
    assert.equal(await exists(path.join(casRootPath, ...key)), false, '归档的正文目录里没有新写的正文');
  }
  assert.deepEqual(await treeState(container), before, '归档逐字节、逐 inode 不变');
});
