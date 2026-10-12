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
    '../backend/application/runtimeBuildInfo': { RUNTIME_BUILD_INFO: {} }
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
  ['epoch5冻结格式与pending当前head', 5, { contextHead: true }]
];
async function published(name, epoch, options = {}) {
  return createPublishedRuntime(epoch, { attachment: true, ...options,
    configurationRoot: path.join(directory, name) });
}
async function assertPreserved(f, result) {
  assert.equal(result.binding.runtimeKernelEpoch, 6);
  assert.equal(result.binding.dataSetId, f.previous.dataSetId);
  assert.equal(result.binding.rootInstanceId, f.previous.rootInstanceId);
  assert.equal(await fs.readFile(f.settingsPath, 'utf8'), 'keep-settings');
  assert.equal(await fs.readFile(f.workspacePath, 'utf8'), 'keep-workspace');
  const db = await kernel.RuntimeDatabase.open(f.authority);
  try {
    const rows = (await db.snapshot([repo('Conversation').get(f.conversationId), repo('ContentObject').get(f.contentId),
      repo('Attachment').get(f.attachment.id), repo('ContentObject').get(f.attachment.content.id)])).snapshot;
    assert.equal(rows[0].title, f.title);
    const cas = kernel.ContentAddressedStore.loose(f.authority, result.binding);
    assert.equal(JSON.parse((await cas.read(rows[1])).toString()).parts[0].text, f.message);
    assert.equal(rows[2].content_object_id, f.attachment.content.id);
    assert.deepEqual(await cas.read(rows[3]), f.attachment.bytes);
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
function publishedRows(f) {
  const db = new Database(f.paths.databasePath, { readonly: true });
  try {
    db.defaultSafeIntegers(true);
    const tables = new Set(kernel.EPOCH_5_RUNTIME_DOMAIN_SCHEMAS.map(row => row.table));
    return {
      ddl: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
        .filter(row => tables.has(row.tbl_name) && !['ix_runtime_delivery_04', 'ix_runtime_delivery_05'].includes(row.name)),
      rows: kernel.EPOCH_5_RUNTIME_DOMAIN_SCHEMAS.map(row => [row.table, db.prepare(`SELECT * FROM ${row.table} ORDER BY id`).all()])
    };
  } finally { db.close(); }
}
for (const [label, epoch, options] of publishedCases) test(`发布${label}升级到6，历史、附件、身份和旧CAS保持`, async () => {
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
  const result = await new Cutover(f.authority, f.scope).ensureCurrentRoot();
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

test('发布3→4的pending准入边界恢复后继续升级到6', async () => {
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

test('发布4→5提交后journal落后按提交事实恢复，再升级到6', async () => {
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
