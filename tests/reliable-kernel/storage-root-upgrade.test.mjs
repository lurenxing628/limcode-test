import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { before, after, test } from 'node:test';
import { kernel, kernelFile, compiled, Database, repo } from './fixtures/runtime-merge-fixture.mjs';
import { createPublishedRuntime, seedCommittedEpoch4To5 } from './fixtures/ci-storage-upgrade.mjs';

const require = createRequire(import.meta.url);
const placement = kernelFile('vscodeRootAuthority.js');
const registry = kernelFile('runtimeHistoryRegistry.js');
const { PACKED_CAS_FILE } = kernelFile('packedCasWorkerProtocol.js');
const { VscodeReliableKernelCutoverCoordinator: Cutover } = require(path.join(compiled,
  'backend/application/reliableKernel/VscodeReliableKernelCutoverCoordinator.js'));
let directory;
before(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-ci-upgrade-')); });
after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
const scope = name => placement.resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: [`file:///workspace/${name}`] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function loadCompiled(relative, dependencies, globals = {}) {
  const filename = path.join(compiled, relative);
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(filename, 'utf8'), {
    module, exports: module.exports, setImmediate, console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected compiled dependency: ${name}`);
      return dependencies[name];
    }, ...globals
  }, { filename });
  return module.exports;
}

test('真实extension在Runtime ready后才升级，deactivate停止新准入并等待在途升级', async t => {
  const opened = deferred(), opening = deferred(), upgrading = deferred(), release = deferred();
  const lifetime = require(path.join(compiled, 'vscode/runtimeDataSetUpgradeLifetime.js'));
  const { ApplicationStartup } = require(path.join(compiled, 'vscode/ApplicationStartup.js'));
  const events = [];
  let startup, isCurrent;
  const app = { async dispose() { events.push('dispose'); }, async startRuntimeRecovery() {}, dataRootPath: () => '/fixture' };
  const management = {
    openWithRuntimeDataSetSelection: (_context, open) => open(),
    upgradeHistoricalDataSetsOnStartup(context, current) {
      isCurrent = current;
      return lifetime.runRuntimeDataSetUpgrade(context, async () => {
        events.push('upgrade'); upgrading.resolve(); await release.promise;
        if (current()) events.push('next-source');
      });
    },
    async mergeHistoricalDataSetsInBackground(_context, _app, current) { if (current()) events.push('merge'); }
  };
  const extension = loadCompiled('vscode/extension.js', {
    vscode: { window: { async showErrorMessage() {}, async showWarningMessage() {} } },
    '../shared/extensionIdentity': { EXTENSION_BRAND: 'Fixture' },
    './ApplicationStartup': { ApplicationStartup },
    './commands/registerCommands': { registerCommands(_context, value) { startup = value; } },
    './panels/MainPanel': { MainPanel: { registerSerializer() {} } },
    './views/SidebarEntryView': { registerSidebarEntryView() {} },
    './runtimeDataSetUpgradeLifetime': lifetime,
    '../backend/application/reliableKernel/VscodeReliableKernelApplicationFacade': {
      VscodeReliableKernelApplicationFacade: { open() { opening.resolve(); return opened.promise; } }
    },
    './commands/runtimeDataSetManagement': management,
    './commands/dataRootRelocation': { async beforeDataRootOpen() {}, async afterDataRootOpened() {} },
    './runtimeOpeningWait': { createRuntimeOpeningWaitPresenter: () => ({ announce() {}, settle() {}, onWait() {}, end() {} }) },
    './watchers/GlobalSettingsWatcher': { registerGlobalSettingsWatcher() {} },
    './runtimeExclusiveMaintenance': { startExclusiveMaintenanceParticipant: () => ({ async dispose() {}, async unregister() {} }), takeNoticeKeptAcrossReload() {} },
    '../backend/application/runtimeBuildInfo': { RUNTIME_BUILD_INFO: {} },
    './lanMobileAccess': { async restoreLanMobileAccess() {} }
  });
  const context = { subscriptions: [], workspaceState: { get() {} } };
  t.after(async () => { opened.resolve(app); release.resolve(); await extension.deactivate(); });
  extension.activate(context);
  const ready = startup.wait();
  await opening.promise;
  assert.equal(startup.current(), undefined);
  assert.deepEqual(events, []);
  opened.resolve(app); await ready; await upgrading.promise;
  assert.equal(isCurrent(), true);
  let stopped = false;
  const stop = extension.deactivate().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(isCurrent(), false);
  assert.equal(lifetime.canStartRuntimeDataSetUpgrade(context), false);
  assert.equal(events.includes('dispose'), true);
  assert.equal(stopped, false);
  release.resolve(); await stop;
  assert.equal(events.includes('next-source'), false);
  assert.equal(events.includes('merge'), false);
});

async function currentRoot(name) {
  const root = path.join(directory, name);
  const paths = { globalStoragePath: root };
  const authority = new kernel.RootAuthority(() => placement.resolveVscodeRuntimeDataRoot(paths));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  return { root, paths, authority, binding };
}
async function bytesTree(root) {
  const values = {};
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else values[path.relative(root, filename)] = await fs.readFile(filename);
    }
  }
  await visit(root); return values;
}

test('并发窗口发布唯一固定选择，工作区变化保持同一历史身份', async () => {
  const f = await currentRoot('choice');
  const pointer = await fs.readFile(f.binding.paths.rootPointerPath);
  const selected = await Promise.all([scope('one'), scope('two')].map(value => placement.resolveVscodeWorkspaceRuntimePlacement(f.paths, value)));
  assert.ok(selected.every(value => value.runtimeScopeRootPath === f.root));
  const selection = JSON.parse(await fs.readFile(placement.resolveVscodeRuntimeSelectionPath(f.paths)));
  assert.equal(selection.id, 'default');
  assert.equal(selection.selectionRevision, 1);
  assert.deepEqual(await fs.readFile(f.binding.paths.rootPointerPath), pointer);
  assert.equal((await placement.resolveVscodeWorkspaceRuntimePlacement(f.paths, scope('three'))).runtimeDataRootPath,
    f.binding.paths.dataRootPath);
});

test('首次固定根不可用时原样归档并登记残留，默认选择在同一配置根建立', async () => {
  const f = await currentRoot('archive');
  await fs.writeFile(f.binding.paths.rootPointerPath, '{}');
  const original = await bytesTree(path.join(f.root, '.limcode-runtime'));
  const result = await placement.resolveVscodeWorkspaceRuntimePlacement(f.paths, scope('archive'));
  assert.equal(result.runtimeScopeRootPath, f.root);
  const backups = path.join(f.root, '.limcode-runtime-reset-backups');
  const names = await fs.readdir(backups);
  assert.equal(names.length, 1);
  const backup = path.join(backups, names[0]);
  assert.deepEqual(await bytesTree(backup), original);
  assert.ok([...(await registry.readRuntimeHistoryResidual(f.paths)).values()].some(row => row.location.containerPath === backup));
});

test('已初始化选择损坏时明确拒绝打开，不改选或替换现有库', async () => {
  const f = await currentRoot('corrupt-choice');
  await placement.resolveVscodeWorkspaceRuntimePlacement(f.paths, scope('first'));
  const before = await fs.readFile(f.binding.paths.databasePath);
  const filename = placement.resolveVscodeRuntimeSelectionPath(f.paths);
  await fs.writeFile(filename, '{invalid');
  await assert.rejects(placement.resolveVscodeWorkspaceRuntimePlacement(f.paths, scope('second')), { code: 'runtime-dataset-invalid' });
  assert.equal(await fs.readFile(filename, 'utf8'), '{invalid');
  assert.deepEqual(await fs.readFile(f.binding.paths.databasePath), before);
});

const publishedCases = [
  ['epoch3标准与legacy continuation', 3, {}],
  ['epoch3最早manifest变体', 3, { modelContextDetail: true }],
  ['epoch4标准', 4, {}],
  ['epoch4确切missing-link前驱', 4, { missingDeliveryLink: true }],
  ['epoch5冻结格式与pending当前head', 5, { contextHead: true }],
  ['epoch6已发布113领域', 6, { contextHead: true }]
];
async function published(name, epoch, options = {}) {
  return createPublishedRuntime(epoch, { attachment: true, ...options,
    configurationRoot: path.join(directory, name) });
}
async function assertPreserved(f, result) {
  assert.equal(result.binding.runtimeKernelEpoch, 7);
  assert.equal(result.binding.dataSetId, f.previous.dataSetId);
  assert.equal(result.binding.rootInstanceId, f.previous.rootInstanceId);
  assert.equal(await fs.readFile(f.settingsPath, 'utf8'), 'keep-settings');
  assert.equal(await fs.readFile(f.workspacePath, 'utf8'), 'keep-workspace');
  const db = await kernel.RuntimeDatabase.open(f.authority);
  try {
    const rows = (await db.snapshot([repo('Conversation').get(f.conversationId), repo('ContentObject').get(f.contentId),
      repo('Attachment').get(f.attachment.id), repo('ContentObject').get(f.attachment.content.id)])).snapshot;
    assert.equal(rows[0].title, f.title);
    const cas = kernel.ContentAddressedStore.forDatabase(f.authority, db);
    assert.equal(JSON.parse((await cas.read(rows[1])).toString()).parts[0].text, f.message);
    assert.equal(rows[2].content_object_id, f.attachment.content.id);
    assert.deepEqual(await cas.read(rows[3]), f.attachment.bytes);
    if (f.looseMessage) {
      const content = (await db.snapshot([repo('ContentObject').get(f.looseMessage.content.id)])).snapshot[0];
      assert.equal(JSON.parse((await cas.read(content)).toString()).parts[0].text, f.looseMessage.text);
    }
    if (f.legacyContinuation) {
      const legacy = f.legacyContinuation;
      const migrated = (await db.snapshot([repo('RuntimeDeliveryIntentLink').get(legacy.ids.deliveryIntentLinkId),
        repo('TurnIntentRevision').get(legacy.ids.turnIntentRevisionId)])).snapshot;
      assert.equal(migrated[0].delivery_id, legacy.deliveryId);
      const body = (await db.snapshot([repo('ContentObject').get(migrated[1].content_object_id)])).snapshot[0];
      assert.deepEqual(JSON.parse((await cas.read(body)).toString()), { kind: 'runtime_continuation', sourceTurnId: legacy.sourceTurnId, version: 1 });
    }
  } finally { await db.close(); }
}
function publishedRows(f, epoch = 5) {
  const db = new Database(f.paths.databasePath, { readonly: true });
  try {
    db.defaultSafeIntegers(true);
    const schemas = epoch === 6 ? kernel.EPOCH_6_RUNTIME_DOMAIN_SCHEMAS
      : epoch === 4 ? kernel.EPOCH_4_RUNTIME_DOMAIN_SCHEMAS : kernel.EPOCH_5_RUNTIME_DOMAIN_SCHEMAS;
    const tables = new Set(schemas.map(row => row.table));
    return {
      ddl: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
        .filter(row => tables.has(row.tbl_name) && (epoch === 6 || !['ix_runtime_delivery_04', 'ix_runtime_delivery_05'].includes(row.name))),
      rows: schemas.map(row => [row.table, db.prepare(`SELECT * FROM ${row.table} ORDER BY id`).all()])
    };
  } finally { db.close(); }
}

test('epoch4保留的已发布旧spawn请求没有sourceToolCallId，已接收答复无损升级并保留原始子任务标题', async () => {
  const f = await published('accepted-legacy-spawn', 4, { acceptedChildAnswer: {} });
  const answer = f.acceptedChildAnswer;
  assert.equal(Object.hasOwn(answer.request, 'sourceToolCallId'), false);
  const before = publishedRows(f, 4), casBefore = await bytesTree(f.paths.casRootPath);
  const result = await new Cutover(f.authority, f.scope).ensureCurrentRoot();
  assert.equal(result.epochMigratedFrom, 4);
  assert.deepEqual(publishedRows(f, 4), before);
  assert.deepEqual(await bytesTree(f.paths.casRootPath), casBefore);
  await assertPreserved(f, result);
  const db = new Database(f.paths.databasePath, { readonly: true });
  try {
    const presentation = db.prepare('SELECT * FROM runtime_delivery_answer_presentation WHERE delivery_id = ?').get(answer.deliveryId);
    for (const [field, expected] of Object.entries({
      conversation_id: f.conversationId, submission_id: answer.submissionId,
      child_execution_id: answer.childExecutionId, child_conversation_id: answer.childConversationId,
      answer_bridge_id: answer.answerBridgeId, source_turn_id: answer.childTurnId,
      peer_title_preview: answer.title, answer_title_preview: '旧答复标题', outcome: 'submitted',
      body_content_object_id: answer.envelopeContent.id, body_representation: 'historical-runtime-envelope'
    })) assert.equal(presentation[field], expected, field);
  } finally { db.close(); }
});

test('历史spawn请求显式sourceToolCallId冲突仍拒绝，保留原库、指针和正文', async () => {
  const f = await published('conflicting-spawn-source', 4, {
    acceptedChildAnswer: { sourceToolCallId: 'different-source-tool-call' }
  });
  const before = publishedRows(f, 4), casBefore = await bytesTree(f.paths.casRootPath);
  const pointer = await fs.readFile(f.paths.rootPointerPath);
  await assert.rejects(new Cutover(f.authority, f.scope).ensureCurrentRoot(), error =>
    error.code === 'runtime-epoch-migration-failed'
    && /Historical spawn request conflicts/.test(error.cause?.message));
  assert.deepEqual(publishedRows(f, 4), before);
  assert.deepEqual(await bytesTree(f.paths.casRootPath), casBefore);
  assert.deepEqual(await fs.readFile(f.paths.rootPointerPath), pointer);
});

function packedState(f) {
  const database = new Database(path.join(f.paths.casRootPath, PACKED_CAS_FILE), { readonly: true });
  try {
    return {
      metadata: database.prepare('SELECT singleton, data_set_id, root_instance_id, root_generation FROM cas_metadata').all(),
      bodies: database.prepare('SELECT digest, body FROM cas_body ORDER BY digest').all()
    };
  } finally { database.close(); }
}
const loosePath = (f, content) => path.join(f.paths.casRootPath, ...content.storage_key.split('/'));
async function packedFixture(name) {
  const f = await published(name, 6, { contextHead: true, packedBody: true });
  await assert.rejects(fs.stat(loosePath(f, f.content)), { code: 'ENOENT' });
  const before = {
    packed: packedState(f), rows: publishedRows(f, 6),
    looseMessage: await fs.readFile(loosePath(f, f.looseMessage.content)),
    attachment: await fs.readFile(loosePath(f, f.attachment.content))
  };
  assert.equal(before.packed.bodies.length, 1);
  assert.equal(before.packed.metadata[0].root_generation, f.previous.rootGeneration);
  return { f, before };
}
async function assertPackedPreserved(f, before, result) {
  await assertPreserved(f, result);
  assert.deepEqual(packedState(f), {
    metadata: [{ singleton: 1, data_set_id: result.binding.dataSetId,
      root_instance_id: result.binding.rootInstanceId, root_generation: result.binding.rootGeneration }],
    bodies: before.packed.bodies
  });
  assert.deepEqual(publishedRows(f, 6), before.rows);
  await assert.rejects(fs.stat(loosePath(f, f.content)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(loosePath(f, f.looseMessage.content)), before.looseMessage);
  assert.deepEqual(await fs.readFile(loosePath(f, f.attachment.content)), before.attachment);
}

test('发布epoch6的packed-only正文经Cutover升级可打开，mixed loose消息与附件保持原字节', async () => {
  const { f, before } = await packedFixture('packed-epoch6-cutover');
  const result = await new Cutover(f.authority, f.scope).ensureCurrentRoot();
  assert.equal(result.epochMigratedFrom, 6);
  assert.equal(result.binding.rootGeneration, f.previous.rootGeneration + 1);
  assert.equal(result.binding.pointerRevision, f.previous.pointerRevision + 1);
  await assertPackedPreserved(f, before, result);
});

test('epoch6 packed升级在数据库、CAS和指针持久边界中断后重入完成同一次升级', async () => {
  for (const point of ['after-database-commit', 'after-packed-cas-migration', 'after-pointer-publication']) {
    const { f, before } = await packedFixture(`packed-epoch6-${point}`);
    await assert.rejects(kernel.migratePreviousRuntimeEpochIfRequired(f.authority, {
      onFaultPoint(actual) { if (actual === point) throw new Error(`interrupt ${point}`); }
    }), new RegExp(`interrupt ${point}`));
    assert.equal(packedState(f).metadata[0].root_generation,
      f.previous.rootGeneration + (point === 'after-database-commit' ? 0 : 1));
    const result = await new Cutover(f.authority, f.scope).ensureCurrentRoot();
    assert.equal(result.binding.rootGeneration, f.previous.rootGeneration + 1);
    assert.equal(result.binding.pointerRevision, f.previous.pointerRevision + 1);
    await assertPackedPreserved(f, before, result);
    await assert.rejects(fs.access(f.paths.rootPendingPath), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(path.dirname(f.paths.dataRootPath),
      kernel.RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE)), { code: 'ENOENT' });
  }
});

function writePackedIdentity(f, identity) {
  const database = new Database(path.join(f.paths.casRootPath, PACKED_CAS_FILE));
  try {
    database.pragma('synchronous = FULL');
    database.prepare('UPDATE cas_metadata SET data_set_id = ?, root_instance_id = ?, root_generation = ? WHERE singleton = 1')
      .run(identity.dataSetId, identity.rootInstanceId, identity.rootGeneration);
    database.pragma('wal_checkpoint(TRUNCATE)');
  } finally { database.close(); }
}
async function completedPackedFixture(name) {
  const fixture = await packedFixture(name);
  const { f } = fixture;
  const result = await new Cutover(f.authority, f.scope).ensureCurrentRoot();
  const backupRoot = result.epochMigrationBackupPath;
  const journalPath = path.join(backupRoot, 'epoch-migration-journal.completed.json');
  const completionPath = path.join(backupRoot, kernel.RUNTIME_EPOCH_MIGRATION_COMPLETION_FILE);
  const journal = JSON.parse(await fs.readFile(journalPath)), completion = JSON.parse(await fs.readFile(completionPath));
  assert.equal(journal.fromEpoch, 6);
  assert.equal(completion.toEpoch, 7);
  delete journal.packedCasIdentityMigrated;
  delete completion.packedCasIdentityMigrated;
  await fs.writeFile(journalPath, JSON.stringify(journal));
  await fs.writeFile(completionPath, JSON.stringify(completion));
  // v0.0.43 completed the Runtime transaction and pointer while leaving this exact previous
  // packed identity in place. Reuse the real completed journal/receipt, including its backup.
  writePackedIdentity(f, f.previous);
  return { ...fixture, result, journalPath, completionPath, journal, completion };
}

test('旧版已完成6→7但packed仍旧代时由原completed凭据恢复，指针和正文保持', async () => {
  const { f, before, result, journalPath, completionPath, journal, completion } =
    await completedPackedFixture('packed-epoch6-completed');
  const pointer = await fs.readFile(f.paths.rootPointerPath);
  const backups = path.join(path.dirname(f.paths.dataRootPath), kernel.RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY);
  const names = await fs.readdir(backups);
  await assert.rejects(kernel.migratePreviousRuntimeEpochIfRequired(f.authority, {
    onFaultPoint(point) { if (point === 'after-packed-cas-migration') throw new Error('interrupt completed packed recovery'); }
  }), /interrupt completed packed recovery/);
  const reopened = await new Cutover(f.authority, f.scope).ensureCurrentRoot();
  assert.deepEqual(reopened.binding, result.binding);
  assert.deepEqual(await fs.readFile(f.paths.rootPointerPath), pointer);
  assert.deepEqual(await fs.readdir(backups), names);
  const recoveredJournal = JSON.parse(await fs.readFile(journalPath));
  const recoveredCompletion = JSON.parse(await fs.readFile(completionPath));
  assert.deepEqual(recoveredJournal, { ...journal, packedCasIdentityMigrated: true, updatedAt: recoveredJournal.updatedAt });
  assert.deepEqual(recoveredCompletion, { ...completion, packedCasIdentityMigrated: true, completedAt: recoveredCompletion.completedAt });
  assert.ok(Date.parse(recoveredJournal.updatedAt) >= Date.parse(journal.updatedAt));
  assert.ok(Date.parse(recoveredCompletion.completedAt) >= Date.parse(completion.completedAt));
  await assertPackedPreserved(f, before, reopened);
  assert.equal(await kernel.migratePreviousRuntimeEpochIfRequired(f.authority), undefined);
  assert.deepEqual(await f.authority.current(), result.binding);
});

test('旧completed凭据只接受确切前代packed身份，未知数据集、根和代数保持原状并拒绝', async () => {
  const { f, before, journalPath, completionPath, journal, completion } =
    await completedPackedFixture('packed-epoch6-unknown-identity');
  const pointer = await fs.readFile(f.paths.rootPointerPath);
  for (const identity of [
    { ...f.previous, dataSetId: 'unrelated-data-set' },
    { ...f.previous, rootInstanceId: 'unrelated-root' },
    { ...f.previous, rootGeneration: f.previous.rootGeneration + 2 }
  ]) {
    writePackedIdentity(f, identity);
    const packed = packedState(f);
    await assert.rejects(new Cutover(f.authority, f.scope).ensureCurrentRoot(), { code: 'packed-cas-corrupt' });
    assert.deepEqual(packedState(f), packed);
    assert.deepEqual(packed.bodies, before.packed.bodies);
    assert.deepEqual(await fs.readFile(f.paths.rootPointerPath), pointer);
    assert.deepEqual(JSON.parse(await fs.readFile(journalPath)), journal);
    assert.deepEqual(JSON.parse(await fs.readFile(completionPath)), completion);
  }
});

test('已完成packed代数迁移后再次出现旧身份视为漂移，保留凭据和正文并拒绝', async () => {
  const { f, before } = await packedFixture('packed-epoch6-after-rebound-drift');
  const result = await new Cutover(f.authority, f.scope).ensureCurrentRoot();
  const journalPath = path.join(result.epochMigrationBackupPath, 'epoch-migration-journal.completed.json');
  const completionPath = path.join(result.epochMigrationBackupPath, kernel.RUNTIME_EPOCH_MIGRATION_COMPLETION_FILE);
  const journal = await fs.readFile(journalPath), completion = await fs.readFile(completionPath);
  assert.equal(JSON.parse(journal).packedCasIdentityMigrated, true);
  assert.equal(JSON.parse(completion).packedCasIdentityMigrated, true);
  const pointer = await fs.readFile(f.paths.rootPointerPath);
  writePackedIdentity(f, f.previous);
  const packed = packedState(f);
  await assert.rejects(new Cutover(f.authority, f.scope).ensureCurrentRoot(), { code: 'packed-cas-corrupt' });
  assert.deepEqual(packedState(f), packed);
  assert.deepEqual(packed.bodies, before.packed.bodies);
  assert.deepEqual(await fs.readFile(f.paths.rootPointerPath), pointer);
  assert.deepEqual(await fs.readFile(journalPath), journal);
  assert.deepEqual(await fs.readFile(completionPath), completion);
});

test('旧packed恢复的completed journal与完成凭据不一致时拒绝，原身份和正文保持', async () => {
  const { f, before, journalPath, completionPath, journal, completion } =
    await completedPackedFixture('packed-epoch6-completion-mismatch');
  const changedCompletion = { ...completion, attemptId: `${completion.attemptId}-unrelated` };
  await fs.writeFile(completionPath, JSON.stringify(changedCompletion));
  const pointer = await fs.readFile(f.paths.rootPointerPath), packed = packedState(f);
  await assert.rejects(new Cutover(f.authority, f.scope).ensureCurrentRoot(),
    { code: 'runtime-epoch-migration-journal-invalid' });
  assert.deepEqual(packedState(f), packed);
  assert.deepEqual(packed.bodies, before.packed.bodies);
  assert.deepEqual(await fs.readFile(f.paths.rootPointerPath), pointer);
  assert.deepEqual(JSON.parse(await fs.readFile(journalPath)), journal);
  assert.deepEqual(JSON.parse(await fs.readFile(completionPath)), changedCompletion);
});

for (const [label, epoch, options] of publishedCases) test(`发布${label}升级到7，历史、附件、身份和旧CAS保持`, async () => {
  const f = await published(label, epoch, options);
  const casBefore = await bytesTree(f.paths.casRootPath);
  let rowsBefore;
  if (epoch === 5) {
    const schema = kernelFile('schema/publishedEpoch5.js');
    assert.equal(createHash('sha256').update(JSON.stringify({ domains: schema.EPOCH_5_RUNTIME_DOMAIN_SCHEMAS,
      triggers: schema.EPOCH_5_RUNTIME_SCHEMA_TRIGGERS, metadata: schema.EPOCH_5_RUNTIME_METADATA_SQL })).digest('hex'),
    '2dba9bcdb8341cd613808cb198f0fde920fe85316ee70a31c7158530b8e0fd3c');
    rowsBefore = publishedRows(f);
  }
  if (epoch === 6) rowsBefore = publishedRows(f, 6);
  const result = await new Cutover(f.authority, f.scope).ensureCurrentRoot();
  if (epoch === 6) {
    assert.deepEqual(publishedRows(f, 6), rowsBefore);
    assert.deepEqual(await bytesTree(f.paths.casRootPath), casBefore);
  }
  assert.equal(result.epochMigratedFrom, epoch);
  assert.equal(result.binding.rootGeneration, f.previous.rootGeneration + 1);
  assert.equal(result.binding.pointerRevision, f.previous.pointerRevision + 1);
  if (epoch === 5) {
    assert.deepEqual(publishedRows(f), rowsBefore);
    assert.deepEqual(await bytesTree(f.paths.casRootPath), casBefore);
    const db = new Database(f.paths.databasePath, { readonly: true });
    try {
      const state = db.prepare('SELECT context_root_id, state, revision, provenance_revision, content_object_id, requires_native_reset FROM conversation_context_handle_state WHERE conversation_id = ?').get(f.conversationId);
      assert.deepEqual(state, { context_root_id: f.contextRootId, state: 'pending', revision: 0,
        provenance_revision: 0, content_object_id: null, requires_native_reset: 1 });
      assert.equal(db.prepare('SELECT COUNT(*) FROM context_root_handle_catalog').pluck().get(), 0);
      assert.equal(db.prepare('SELECT COUNT(*) FROM schema_manifest').pluck().get(), 113);
    } finally { db.close(); }
    const readerFile = path.join(compiled, 'backend/reliableKernel/rootAuthority.js');
    const localRequire = createRequire(readerFile);
    const older = { exports: {} };
    const evaluate = vm.runInThisContext(`(function(require, module, exports, __filename, __dirname) {${readFileSync(readerFile, 'utf8')}\n})`, { filename: readerFile });
    evaluate(name => name === './contracts' ? { ...localRequire(name), RUNTIME_KERNEL_EPOCH: 5 } : localRequire(name),
      older, older.exports, readerFile, path.dirname(readerFile));
    const reader = new older.exports.RootAuthority(() => f.paths.dataRootPath);
    await assert.rejects(reader.current(), error => error.code === 'root-binding-invalid'
      && /runtimeKernelEpoch is newer than this extension/.test(error.cause?.message));
    await assert.rejects(reader.readHistoricalPointerForCutover(), { code: 'runtime-epoch-newer-than-extension' });
  }
  const backup = new Database(path.join(result.epochMigrationBackupPath, `limcode.epoch-${epoch}.sqlite`), { readonly: true });
  try {
    assert.equal(backup.prepare('SELECT runtime_kernel_epoch FROM root_binding').pluck().get(), epoch);
    assert.equal(backup.prepare('SELECT COUNT(*) FROM message_revision').pluck().get(), 1);
  } finally { backup.close(); }
  await assertPreserved(f, result);
  assert.equal((await new Cutover(f.authority, f.scope).ensureCurrentRoot()).epochMigratedFrom, undefined);
});

test('未知发布前驱DDL拒绝升级，原指针、历史与正文保持', async () => {
  const f = await published('drift', 5);
  const db = new Database(f.paths.databasePath);
  try { db.prepare("UPDATE schema_manifest SET client_mapping = 'detail' WHERE domain_key = 'Conversation'").run(); }
  finally { db.close(); }
  const pointer = await fs.readFile(f.paths.rootPointerPath), rows = publishedRows(f), cas = await bytesTree(f.paths.casRootPath);
  await assert.rejects(kernel.migratePreviousRuntimeEpochIfRequired(f.authority), { code: 'runtime-epoch-migration-schema-mismatch' });
  assert.deepEqual(await fs.readFile(f.paths.rootPointerPath), pointer);
  assert.deepEqual(publishedRows(f), rows);
  assert.deepEqual(await bytesTree(f.paths.casRootPath), cas);
  await assert.rejects(fs.access(f.paths.rootPendingPath), { code: 'ENOENT' });
});

test('身份未知的目标Host阻止离线升级，原库与选择不变', async t => {
  const f = await published('unknown-host', 4);
  const pointer = await fs.readFile(f.paths.rootPointerPath), bytes = await fs.readFile(f.paths.databasePath);
  const pid = 2147483647, kill = process.kill;
  await fs.mkdir(path.join(f.paths.dataRootPath, 'host-liveness'), { recursive: true });
  await fs.writeFile(path.join(f.paths.dataRootPath, 'host-liveness/unknown.json'), JSON.stringify({
    kind: 'limcode-runtime-host-liveness', dataSetId: f.previous.dataSetId, rootInstanceId: f.previous.rootInstanceId,
    rootGeneration: f.previous.rootGeneration, hostBootId: 'unknown-host', livenessId: 'unknown-liveness', processId: pid,
    startedAt: '2026-09-01T00:00:00.000Z', heartbeatAt: '2026-09-01T00:00:00.000Z'
  }));
  t.mock.method(process, 'kill', (processId, signal) => {
    if (processId === pid) throw Object.assign(new Error('inaccessible peer'), { code: 'EPERM' });
    return kill(processId, signal);
  });
  await assert.rejects(kernel.upgradeRuntimeDataSet({ globalStoragePath: f.cleanupRoot }, {
    candidateId: 'default', expectedDataSetId: f.previous.dataSetId, expectedRootInstanceId: f.previous.rootInstanceId
  }), error => error.code === 'runtime-hosts-active' && error.hosts.some(host => host.state === 'unknown'));
  assert.deepEqual(await fs.readFile(f.paths.rootPointerPath), pointer);
  assert.deepEqual(await fs.readFile(f.paths.databasePath), bytes);
});

test('发布3→4的pending准入边界恢复后继续升级到7', async () => {
  const f = await published('pending-3-to-4', 3);
  await fs.writeFile(f.paths.rootPendingPath, JSON.stringify({ ...f.previous, rootGeneration: f.previous.rootGeneration + 1,
    pointerRevision: f.previous.pointerRevision + 1, runtimeKernelEpoch: 4 }));
  const result = await kernel.upgradeRuntimeDataSet({ globalStoragePath: f.cleanupRoot }, {
    candidateId: 'default', expectedDataSetId: f.previous.dataSetId, expectedRootInstanceId: f.previous.rootInstanceId
  });
  assert.equal(result.previousEpoch, 3);
  await assertPreserved(f, result);
  await assert.rejects(fs.access(f.paths.rootPendingPath), { code: 'ENOENT' });
});

test('发布4→5提交后journal落后按提交事实恢复，再升级到7', async () => {
  const f = await published('committed-4-to-5', 4, { omitLegacyContinuation: true });
  const retired = await seedCommittedEpoch4To5(f);
  const result = await kernel.upgradeRuntimeDataSet({ globalStoragePath: f.cleanupRoot }, {
    candidateId: 'default', expectedDataSetId: f.previous.dataSetId, expectedRootInstanceId: f.previous.rootInstanceId
  });
  assert.equal(result.binding.rootGeneration, f.previous.rootGeneration + 2);
  await assertPreserved(f, result);
  const completed = JSON.parse(await fs.readFile(path.join(retired.backupRoot, kernel.RUNTIME_EPOCH_MIGRATION_COMPLETION_FILE)));
  assert.equal(completed.toEpoch, 5);
  assert.deepEqual(completed.nextBinding, retired.next);
  await assert.rejects(fs.access(retired.journalPath), { code: 'ENOENT' });
});

test('升级备份损坏时拒绝恢复，原历史与根指针保留', async () => {
  const f = await published('backup-corrupt', 4);
  await assert.rejects(kernel.migratePreviousRuntimeEpochIfRequired(f.authority, {
    onFaultPoint(point) { if (point === 'after-backup') throw new Error('stop after backup'); }
  }), /stop after backup/);
  const control = path.dirname(f.paths.dataRootPath);
  const journal = JSON.parse(await fs.readFile(path.join(control, kernel.RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE)));
  await fs.appendFile(path.join(control, kernel.RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY,
    journal.backupDirectoryName, 'limcode.epoch-4.sqlite'), 'corrupt');
  const pointer = await fs.readFile(f.paths.rootPointerPath);
  await assert.rejects(new Cutover(f.authority, f.scope).ensureCurrentRoot(), { code: 'runtime-epoch-migration-backup-invalid' });
  assert.deepEqual(await fs.readFile(f.paths.rootPointerPath), pointer);
  const db = new Database(f.paths.databasePath, { readonly: true });
  try { assert.equal(db.prepare('SELECT title FROM conversation WHERE id = ?').pluck().get(f.conversationId), f.title); }
  finally { db.close(); }
});

test('已发布升到6的中断先完成原目标，再独立升级到7', async () => {
  for (const point of ['after-writer-fence', 'after-backup', 'after-database-commit', 'after-pointer-publication']) {
    const f = await published(`pending-6-${point}`, 5, { contextHead: true });
    const casBefore = await bytesTree(f.paths.casRootPath);
    await assert.rejects(kernel.migratePreviousRuntimeEpochIfRequired(f.authority, {
      onFaultPoint(actual) { if (actual === point) throw new Error(`interrupt ${point}`); }
    }), new RegExp(`interrupt ${point}`));
    const control = path.dirname(f.paths.dataRootPath);
    const next6 = { ...f.previous, rootGeneration: f.previous.rootGeneration + 1,
      pointerRevision: f.previous.pointerRevision + 1, runtimeKernelEpoch: 6 };
    // Reuse the existing migrator's predecessor backup and exact persistent boundary as the
    // published target-6 fixture. Its journal keeps the original target throughout recovery.
    if (point !== 'after-writer-fence') {
      const currentJournal = path.join(control, kernel.RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE);
      const journal = JSON.parse(await fs.readFile(currentJournal));
      await fs.writeFile(path.join(control, kernel.PUBLISHED_EPOCH_TO_6_JOURNAL_FILE),
        JSON.stringify({ ...journal, toEpoch: 6, nextBinding: next6 }));
      await fs.rm(currentJournal);
    }
    if (point === 'after-database-commit' || point === 'after-pointer-publication') {
      const db = new Database(f.paths.databasePath);
      try {
        db.exec('BEGIN IMMEDIATE');
        db.prepare('UPDATE schema_manifest SET runtime_kernel_epoch = 6').run();
        db.prepare('UPDATE root_binding SET runtime_kernel_epoch = 6').run();
        db.exec('COMMIT');
        db.pragma('wal_checkpoint(TRUNCATE)');
      } finally { db.close(); }
    }
    if (point === 'after-pointer-publication') {
      await fs.writeFile(f.paths.rootPointerPath, JSON.stringify(next6));
      const manifest = JSON.parse(await fs.readFile(f.paths.runtimeEpochPath));
      await fs.writeFile(f.paths.runtimeEpochPath, JSON.stringify({ ...manifest, runtimeKernelEpoch: 6 }));
    } else await fs.writeFile(f.paths.rootPendingPath, JSON.stringify(next6));

    const result = await kernel.migratePreviousRuntimeEpochIfRequired(f.authority);
    assert.equal(result.previousEpoch, 6);
    assert.equal(result.binding.rootGeneration, f.previous.rootGeneration + 2);
    assert.equal(result.binding.pointerRevision, f.previous.pointerRevision + 2);
    const backups = path.join(control, kernel.RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY);
    const completed = await Promise.all((await fs.readdir(backups)).map(async name =>
      JSON.parse(await fs.readFile(path.join(backups, name, kernel.RUNTIME_EPOCH_MIGRATION_COMPLETION_FILE)))));
    assert.deepEqual(completed.map(row => row.toEpoch).sort(), [6, 7]);
    assert.deepEqual(completed.find(row => row.toEpoch === 6).nextBinding, next6);
    assert.deepEqual(await bytesTree(f.paths.casRootPath), casBefore);
    await assertPreserved(f, result);
    await assert.rejects(fs.access(path.join(control, kernel.PUBLISHED_EPOCH_TO_6_JOURNAL_FILE)), { code: 'ENOENT' });
  }
});
