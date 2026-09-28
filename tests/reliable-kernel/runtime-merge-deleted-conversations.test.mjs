// What the user deleted never comes back through a merge: deleted-conversation records written by the
// deletion command before it commits (runtimeMergeTombstones), identity continuations after a data-root
// relocation, closures kept across incarnations and foreign copies, and the other fixes of the B phase 2
// review (an interrupted foreign commit converges without its root or request; backup cleanup keeps its
// source meanwhile; a local data set that cannot be read defers a foreign merge; honest notices).
// Runs against the compiled extension.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compiled, createConfigurationRoot, Database, generateSyntheticSource, initializeScope, kernel, kernelFile, NOW, rawWrite,
  readLedgerRecord, seedConversations
} from './fixtures/runtime-merge-fixture.mjs';
import * as moving from './runtime-data-root-relocation-fixture.mjs';

const require = createRequire(import.meta.url);
const records = kernelFile('runtimeMergeTombstones.js');
const foreign = kernelFile('runtimeForeignHistory.js');
const foreignMerge = kernelFile('runtimeForeignHistoryMerge.js');
const { mergeHistoricalDataSetsOnline } = kernelFile('runtimeDataSetMerge.js');
const { prepareLargeMergeSources, runLargeMergeSession } = kernelFile('runtimeDataSetStreamedMerge.js');
const { withRuntimeDataRootAdmission, withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');
const { deleteRuntimeBackups, planRuntimeBackupCleanup } = kernelFile('runtimeBackupCleanup.js');
const { ConversationDeletionControlPlane } = kernelFile('conversationDeletion.js');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { createVscodeRootAuthority, resolveVscodeRuntimeMergeLedgerRoot } = kernelFile('vscodeRootAuthority.js');
const { stopAndDeleteConversation } = require(path.join(compiled, 'backend/application/reliableKernel/conversationDeleteCommand.js'));
const { archiveCurrentRuntimeRootForReset } = require(path.join(
  compiled, 'backend/application/reliableKernel/VscodeReliableKernelCutoverCoordinator.js'
));

const UNREADABLE = 'runtime-merge-records-unreadable';
const EXPIRED = 'runtime-data-set-merge-request-expired';

async function temporary(t, prefix = 'limcode-deleted-') {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}

/** The current configuration root (fixed root selected, workspace data set alpha, optionally beta). */
async function home(t, options = {}) {
  const base = await temporary(t);
  return { ...await createConfigurationRoot({ tmp: base, ...options }), base };
}

const ledgerRoot = (root) => resolveVscodeRuntimeMergeLedgerRoot({ globalStoragePath: root });
const identityOf = (binding) => ({ dataSetId: binding.dataSetId, rootInstanceId: binding.rootInstanceId });
const openWindow = (fixture) => kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `window-${randomUUID()}` });

async function archive(fixture, dataSet) {
  const authority = new RootAuthority(() => dataSet.binding.paths.dataRootPath, undefined, () => fixture.root);
  const archived = await archiveCurrentRuntimeRootForReset(authority, dataSet.scopeRoot);
  assert.equal(archived.archived, true);
  return archived.backupPath;
}

/** The foreign entry discovered in `containerPath` (a copied directory's scope, null: any) with its located root. */
async function found(root, containerPath, scope = null, previousDataRootPaths) {
  const entries = await foreign.discoverForeignRuntimeHistory({ configurationRootPath: root, ...(previousDataRootPaths ? { previousDataRootPaths } : {}) });
  const entry = entries.find((item) => item.location.containerPath === containerPath && (scope === null || item.scope === scope) && !item.archiveName);
  assert.ok(entry, `发现 ${containerPath}：${JSON.stringify(entries.map((item) => [item.location.containerPath, item.scope]))}`);
  const located = await foreign.locateForeignRuntimeRoot(root, entry.location);
  return { ...entry, root: located, label: `外来历史库（${entry.name}）` };
}

async function request(root, source) {
  await foreignMerge.requestForeignRuntimeHistoryMerge({ globalStoragePath: root }, {
    id: source.id, location: source.location, label: source.label,
    expectedDataSetId: source.root.recorded.dataSetId, expectedRootInstanceId: source.root.recorded.rootInstanceId
  });
}

/** One batch in a window of the current data set (none named: a startup batch). */
async function batch(fixture, options = {}) {
  const database = await openWindow(fixture);
  try {
    return await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database }, options);
  } finally { await database.close(); }
}

const explicit = (...ids) => ({ candidateIds: ids, requested: true });

function query(databasePath, sql) {
  const database = new Database(databasePath, { readonly: true });
  try { return database.prepare(sql).pluck().all(); } finally { database.close(); }
}
const conversationsIn = (databasePath) => query(databasePath, 'SELECT id FROM conversation ORDER BY id');
const conversations = (fixture) => conversationsIn(fixture.current.binding.paths.databasePath);
const brief = (report) => ({
  merged: report.merged.map((item) => [item.candidateId, item.insertedConversations, item.skippedConversations ?? 0]),
  blocked: report.blocked.map((item) => [item.candidateId, item.code]),
  deferred: report.deferred.map((item) => [item.candidateId, item.code]),
  failures: report.failures.map((item) => [item.candidateId, item.code])
});

/**
 * The deletion command as the window's facade runs it (nothing runs in these conversations), recording
 * the deleted ids under `root` for the data set of `database` unless `recordDeleted` is given.
 */
async function deleteWithCommand(authority, root, conversationId, recordDeleted) {
  const database = await kernel.RuntimeDatabase.open(authority, { hostBootId: `delete-${randomUUID()}` });
  try {
    const nothingRuns = async () => { throw new Error('nothing runs in this conversation'); };
    return await stopAndDeleteConversation({
      application: { database, conversationDeletion: new ConversationDeletionControlPlane(database) },
      conversations: { interrupt: nothingRuns }, childAgents: { interruptSubtree: nothingRuns }, pollMs: 20,
      recordDeleted: recordDeleted ? (ids) => recordDeleted(ids, database)
        : (ids) => records.recordRuntimeDeletedConversations(root, database.binding, ids)
    }, { conversationId, requestId: `delete-${randomUUID()}` });
  } finally { await database.close(); }
}

/** Deletion without the command (as before this version): no record is written. */
async function deleteUnrecorded(authority, conversationId) {
  const database = await kernel.RuntimeDatabase.open(authority, { hostBootId: `delete-${randomUUID()}` });
  try { await new ConversationDeletionControlPlane(database).delete(conversationId); } finally { await database.close(); }
}

async function writeAliases(root, identity, continues) {
  const directory = path.join(ledgerRoot(root), 'aliases');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${identity.dataSetId}.${identity.rootInstanceId}.json`), JSON.stringify({
    version: 1, continues: continues.map((item) => ({ ...identityOf(item), relocationId: randomUUID(), at: new Date().toISOString() }))
  }));
}

async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

const crashAfterCommit = (point) => {
  if (point === 'after-row-commit') throw Object.assign(new Error('simulated crash after the commit'), { code: 'EIO' });
};

test('删除记录与身份延续：每次删除一个文件，按身份集合取并集；读不出、名字或格式不认识、是链接或目录的一律抛错，未写完的临时文件与非 .json 文件不算记录', async (t) => {
  const base = await temporary(t);
  const identity = { dataSetId: randomUUID(), rootInstanceId: randomUUID() };
  const other = { dataSetId: randomUUID(), rootInstanceId: randomUUID() };
  assert.deepEqual([...await records.readRuntimeDeletedConversations(base, [identity])], [], '没有记录就是没有删除');
  await records.recordRuntimeDeletedConversations(base, identity, ['c_1', 'c_1_child', 'c_1']);
  await records.recordRuntimeDeletedConversations(base, identity, ['c_2']);
  await records.recordRuntimeDeletedConversations(base, other, ['o_1']);
  const directory = path.join(ledgerRoot(base), 'deleted-conversations', `${identity.dataSetId}.${identity.rootInstanceId}`);
  const names = (await fs.readdir(directory)).sort();
  assert.equal(names.length, 2, '每次删除一个文件');
  for (const name of names) {
    assert.match(name, /^\d{8}T\d{9}Z-[0-9a-f]{8}\.json$/);
    const record = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
    assert.deepEqual(Object.keys(record).sort(), ['conversationIds', 'deletedAt', 'version']);
    assert.equal(record.version, 1);
    assert.ok(!Number.isNaN(Date.parse(record.deletedAt)));
  }
  assert.deepEqual([...await records.readRuntimeDeletedConversations(base, [identity])].sort(), ['c_1', 'c_1_child', 'c_2']);
  assert.deepEqual([...await records.readRuntimeDeletedConversations(base, [identity, other])].sort(), ['c_1', 'c_1_child', 'c_2', 'o_1'], '按身份集合取并集');
  await fs.writeFile(path.join(directory, '.20260928T000000000Z-0badf00d.json.123.tmp'), '{"version":');
  await fs.writeFile(path.join(directory, '.DS_Store'), 'finder');
  assert.equal((await records.readRuntimeDeletedConversations(base, [identity])).size, 3, '临时文件与非 .json 文件不算记录');

  const name = '20260928T010203004Z-0000abcd.json';
  const file = path.join(directory, name);
  const refused = async (label, write, pattern) => {
    await write();
    await assert.rejects(records.readRuntimeDeletedConversations(base, [identity]),
      (error) => error.code === UNREADABLE && pattern.test(error.message), label);
    await fs.rm(file, { recursive: true, force: true });
    await fs.rm(path.join(directory, 'notes.json'), { force: true });
  };
  const valid = { version: 1, conversationIds: ['x'], deletedAt: NOW };
  await refused('不认识的名字', () => fs.writeFile(path.join(directory, 'notes.json'), JSON.stringify(valid)), /不认识的文件 notes\.json/);
  await refused('不完整的 JSON', () => fs.writeFile(file, '{"version":1,"conversationIds":["x"'), /不是完整的 JSON/);
  for (const [label, value] of [
    ['别的版本', { ...valid, version: 2 }], ['多出的字段', { ...valid, reason: 'x' }], ['缺字段', { version: 1, conversationIds: ['x'] }],
    ['空列表', { ...valid, conversationIds: [] }], ['不是字符串的 id', { ...valid, conversationIds: [1] }], ['时间不对', { ...valid, deletedAt: 'yesterday' }],
    ['不是对象', ['x']]
  ]) {
    await refused(label, () => fs.writeFile(file, JSON.stringify(value)), /格式不认识/);
  }
  await refused('目录', () => fs.mkdir(file), /不是普通文件/);
  await refused('符号链接', () => fs.symlink(path.join(directory, names[0]), file), /不是普通文件/);
  const moved = `${directory}.real`;
  await fs.rename(directory, moved);
  await fs.symlink(moved, directory);
  await assert.rejects(records.readRuntimeDeletedConversations(base, [identity]), (error) => error.code === UNREADABLE && /符号链接/.test(error.message));
  await assert.rejects(records.recordRuntimeDeletedConversations(base, identity, ['c_3']), /符号链接/, '也不经链接写');
  await fs.rm(directory);
  await fs.rename(moved, directory);

  // Identity continuations: none without a file; the exact form only.
  assert.deepEqual(await records.readRuntimeIdentityAliases(base, identity), []);
  assert.deepEqual(await records.readRuntimeMergeTargetIdentities(base, identity), [identity]);
  await writeAliases(base, identity, [other]);
  assert.deepEqual((await records.readRuntimeIdentityAliases(base, identity)).map(identityOf), [other]);
  assert.deepEqual(await records.readRuntimeMergeTargetIdentities(base, identity), [identity, other]);
  const aliases = path.join(ledgerRoot(base), 'aliases', `${identity.dataSetId}.${identity.rootInstanceId}.json`);
  for (const value of [
    { version: 2, continues: [] }, { version: 1 }, { version: 1, continues: [{ ...other }] },
    { version: 1, continues: [{ ...other, relocationId: 'r', at: NOW, extra: 1 }] }, { version: 1, continues: [{ ...other, dataSetId: '../x', relocationId: 'r', at: NOW }] }
  ]) {
    await fs.writeFile(aliases, JSON.stringify(value));
    await assert.rejects(records.readRuntimeIdentityAliases(base, identity), (error) => error.code === UNREADABLE && /身份延续记录/.test(error.message));
  }
  await fs.writeFile(aliases, 'not json');
  await assert.rejects(records.readRuntimeMergeTargetIdentities(base, identity), (error) => error.code === UNREADABLE);
});

test('删除对话：删除命令在删除提交之前把整棵子树的对话 id 持久记到当前配置根；记不下时照常删除，结果如实说明', async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.current, [{ id: 'parent_1' }, { id: 'keep_1' }]);
  // A Subagent conversation parent_1 started: deleting parent_1 takes it (ConversationDeletionControlPlane).
  rawWrite(fixture.current, (database) => {
    database.prepare("INSERT INTO conversation (id, title, status, created_at, updated_at) VALUES (?, 'child', 'active', ?, ?)").run('parent_1_child', NOW, NOW);
    database.prepare('INSERT INTO child_execution VALUES (?, ?, ?, ?, ?)').run('parent_1_child_execution', 'parent_1_child', 'idle', NOW, NOW);
    database.prepare('INSERT INTO conversation_origin_link VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('parent_1_child_origin', 'parent_1_child', 'parent_1', 'parent_1_turn', null, null, NOW);
  });
  const recorded = [];
  const deleted = await deleteWithCommand(fixture.current.authority, fixture.root, 'parent_1', async (ids, database) => {
    const present = (await database.snapshot(ids.map((id) => kernel.DOMAIN_REPOSITORIES.domain('Conversation').get(id)))).snapshot;
    recorded.push({ ids: [...ids].sort(), stillThere: present.every((row) => row !== null) });
    await records.recordRuntimeDeletedConversations(fixture.root, database.binding, ids);
  });
  assert.deepEqual(recorded, [{ ids: ['parent_1', 'parent_1_child'], stillThere: true }], '整棵子树，在删除提交之前记下');
  assert.deepEqual([...deleted.deletedConversationIds].sort(), ['parent_1', 'parent_1_child']);
  assert.equal(deleted.deletionRecordError, undefined);
  assert.deepEqual([...await records.readRuntimeDeletedConversations(fixture.root, [identityOf(fixture.current.binding)])].sort(),
    ['parent_1', 'parent_1_child'], '记在当前配置根、按当前库身份');
  assert.deepEqual(conversations(fixture), ['keep_1']);

  // The records cannot be written (something else where their directory belongs): deleted anyway, and said so.
  const directory = path.join(ledgerRoot(fixture.root), 'deleted-conversations');
  await fs.rm(directory, { recursive: true });
  await fs.writeFile(directory, 'not a directory');
  const unrecorded = await deleteWithCommand(fixture.current.authority, fixture.root, 'keep_1');
  assert.deepEqual(unrecorded.deletedConversationIds, ['keep_1'], '记不下时照常删除');
  assert.match(unrecorded.deletionRecordError, /不是目录/, '结果说明没能记下');
  assert.deepEqual(conversations(fixture), []);
});

/**
 * The window's facade (VscodeReliableKernelApplicationFacade) with VS Code mocked, over the real Runtime
 * database of `fixture`'s current data set; `warnings` collects what it shows.
 */
async function openFacade(t, fixture) {
  const Module = require('node:module');
  const originalLoad = Module._load;
  const disposable = () => ({ dispose() {} });
  class EventEmitter {
    listeners = new Set();
    event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(value) { for (const listener of [...this.listeners]) listener(value); }
    dispose() { this.listeners.clear(); }
  }
  const warnings = [];
  const vscode = {
    EventEmitter,
    Uri: { parse: (text) => ({ toString: () => text }), joinPath: () => ({}) },
    ProgressLocation: { Notification: 15 },
    window: {
      registerWebviewViewProvider: disposable,
      onDidChangeActiveTextEditor: disposable,
      showWarningMessage: async (message) => { warnings.push(message); },
      showInformationMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      withProgress: async (_options, task) => task({ report() {} })
    },
    workspace: { onDidChangeWorkspaceFolders: disposable, workspaceFolders: [] },
    commands: { executeCommand: async () => undefined }
  };
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request.endsWith('/panels/MainPanel')) {
      return { MainPanel: {
        onDidChangeConversationPanelState: disposable, getOpenConversationPanelStates: () => [], createOrShow() {},
        refreshConversationTitle() {}, closePanelsByConversationId() {}
      } };
    }
    if (request.endsWith('/webview/getWebviewHtml')) return { getWebviewHtml: () => '', getUnavailableWebviewHtml: () => '' };
    return originalLoad.call(this, request, parent, isMain);
  };
  let Facade;
  try {
    ({ VscodeReliableKernelApplicationFacade: Facade } = require(path.join(
      compiled, 'backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js'
    )));
  } finally { Module._load = originalLoad; }
  const database = await openWindow(fixture);
  const nothingRuns = async () => { throw new Error('nothing runs in this conversation'); };
  const product = {
    debugCapture: { setListener() {} },
    toolHost: { setStateChangeListener() {} },
    ensureCapabilitiesReady: async () => undefined,
    application: {
      database,
      contentStore: new kernel.ContentAddressedStore(fixture.current.authority, fixture.current.binding),
      conversationDeletion: new ConversationDeletionControlPlane(database),
      modelProvider: { subscribeSteering: () => () => undefined },
      webviewFeed: { postToConversation() {}, reconnect() {} }
    },
    configuration: { agents: async () => [] },
    conversations: { interrupt: nothingRuns },
    childAgents: { interruptSubtree: nothingRuns },
    close: async () => undefined
  };
  const facade = new Facade({}, product, () => ({}), { configurationRootPath: fixture.root });
  t.after(async () => { await facade.dispose(); await database.close(); });
  return { facade, warnings };
}

test('删除对话经窗口：删除记录写在当前配置根、按打开的当前库身份；记不下时照常删除，并提示以后合并旧拷贝时这些对话可能会回来', async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.current, [{ id: 'window_1' }, { id: 'window_2' }]);
  const { facade, warnings } = await openFacade(t, fixture);
  assert.deepEqual(await facade.deleteConversation('window_1'), ['window_1']);
  assert.deepEqual([...await records.readRuntimeDeletedConversations(fixture.root, [identityOf(fixture.current.binding)])], ['window_1'],
    '窗口删除时记下，记在当前配置根、按当前库身份');
  assert.deepEqual(warnings, [], '记下了就不提示');

  const directory = path.join(ledgerRoot(fixture.root), 'deleted-conversations');
  await fs.rm(directory, { recursive: true });
  await fs.writeFile(directory, 'not a directory');
  assert.deepEqual(await facade.deleteConversation('window_2'), ['window_2'], '记不下时照常删除');
  assert.deepEqual(conversations(fixture), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^Limcode test：对话已删除，但没能记下删除记录，以后合并旧拷贝时这些对话可能会回来。（.*不是目录.*）$/);
});

test('删除命令记下的对话，任何合并都不会带回：账本没有闭包时本地库、外来归档、大库会话（含准备时的试算）都跳过它', async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.current, [{ id: 'own_1' }]);
  await seedConversations(fixture.alpha, [{ id: 'b_1' }, { id: 'b_2' }]);
  assert.deepEqual(brief(await batch(fixture, explicit(fixture.alpha.id))).merged, [[fixture.alpha.id, 2, 0]]);
  await deleteWithCommand(fixture.current.authority, fixture.root, 'b_1');
  // No merge closure at all (records lost, or merged by an older version): only the deletion record is left.
  await fs.rm(path.join(ledgerRoot(fixture.root), 'records'), { recursive: true, force: true });

  const local = await batch(fixture, explicit(fixture.alpha.id));
  assert.deepEqual(brief(local).merged, [[fixture.alpha.id, 0, 1]], '本地库：跳过删掉的 b_1');
  assert.deepEqual(conversations(fixture), ['b_2', 'own_1']);

  const source = await found(fixture.root, await archive(fixture, fixture.alpha));
  await request(fixture.root, source);
  const report = await batch(fixture, explicit(source.id));
  assert.deepEqual(brief(report), { merged: [[source.id, 0, 1]], blocked: [], deferred: [], failures: [] }, '外来归档：跳过删掉的 b_1');
  assert.deepEqual(conversations(fixture), ['b_2', 'own_1']);

  // A large source holding b_1 as well (never merged before: no closure of its own).
  const beta = await initializeScope(fixture.paths, 'beta');
  await seedConversations(beta, [{ id: 'b_1' }, { id: 'beta_1' }]);
  await generateSyntheticSource(beta, { rows: 120, prefix: 'beta_large' });
  const database = await openWindow(fixture);
  let preparation;
  try {
    preparation = await prepareLargeMergeSources({
      paths: fixture.paths, target: { configurationRootPath: fixture.root, database }, candidateIds: [beta.id], requested: true,
      options: { sizeLimits: { transactionRows: 50 }, chunkRows: 7 }
    });
  } finally { await database.close(); }
  assert.deepEqual(preparation.sources.map((item) => [item.candidateId, item.skippedConversations]), [[beta.id, 1]], '准备时的试算已跳过 b_1');
  const session = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
    () => runLargeMergeSession({ paths: fixture.paths, prepared: preparation })));
  assert.deepEqual(session.results.map((item) => [item.candidateId, item.state, item.result?.skippedConversations]), [[beta.id, 'merged', 1]]);
  assert.ok(!conversations(fixture).includes('b_1'), '大库会话也不带回 b_1');
  assert.ok(conversations(fixture).includes('beta_1'));
});

test('删除记录读不出（格式不认识、身份延续记录坏了）时合并推迟，不当作没有删除；修好之后照常合并', async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.alpha, [{ id: 'a_1' }]);
  const current = identityOf(fixture.current.binding);
  const directory = path.join(ledgerRoot(fixture.root), 'deleted-conversations', `${current.dataSetId}.${current.rootInstanceId}`);
  await fs.mkdir(directory, { recursive: true });
  const bad = path.join(directory, '20260928T010203004Z-0000abcd.json');
  await fs.writeFile(bad, JSON.stringify({ version: 2, conversationIds: ['a_1'], deletedAt: NOW }));
  const deferred = await batch(fixture, explicit(fixture.alpha.id));
  assert.deepEqual(brief(deferred), { merged: [], blocked: [], deferred: [[fixture.alpha.id, UNREADABLE]], failures: [] });
  assert.match(deferred.deferred[0].message, /当前库的删除记录读不出（删除记录 20260928T010203004Z-0000abcd\.json 的格式不认识），为免把你删掉的对话合并回来，这次不合并/);
  assert.deepEqual(conversations(fixture), [], '什么都没合并');
  assert.equal((await readLedgerRecord(fixture, fixture.alpha.id))?.state, undefined, '不记为失败');
  await fs.rm(bad);

  await writeAliases(fixture.root, current, []);
  await fs.writeFile(path.join(ledgerRoot(fixture.root), 'aliases', `${current.dataSetId}.${current.rootInstanceId}.json`), '{"version":1');
  assert.deepEqual(brief(await batch(fixture, explicit(fixture.alpha.id))).deferred, [[fixture.alpha.id, UNREADABLE]], '身份延续记录读不出也推迟');
  await fs.rm(path.join(ledgerRoot(fixture.root), 'aliases'), { recursive: true });
  assert.deepEqual(brief(await batch(fixture, explicit(fixture.alpha.id))).merged, [[fixture.alpha.id, 1, 0]]);
  assert.deepEqual(conversations(fixture), ['a_1']);
});

test('身份延续：当前库延续的旧身份下记的删除同样生效（按身份集合取并集）；与延续身份相同的本地库按当前库的旧身份拒绝', async (t) => {
  const fixture = await home(t, { beta: true });
  await seedConversations(fixture.alpha, [{ id: 'x_1' }, { id: 'x_2' }]);
  await seedConversations(fixture.beta, [{ id: 'y_1' }]);
  const earlier = { dataSetId: randomUUID(), rootInstanceId: randomUUID() };
  await writeAliases(fixture.root, identityOf(fixture.current.binding), [earlier, fixture.beta.binding]);
  // Deleted before a relocation, in the data set the current one continues (carried along by it).
  await records.recordRuntimeDeletedConversations(fixture.root, earlier, ['x_1']);
  const report = await batch(fixture, explicit(fixture.alpha.id));
  assert.deepEqual(brief(report).merged, [[fixture.alpha.id, 1, 1]]);
  assert.deepEqual(conversations(fixture), ['x_2']);
  const refused = await batch(fixture, explicit(fixture.beta.id));
  assert.deepEqual(brief(refused).blocked, [[fixture.beta.id, 'runtime-data-set-merge-continued-identity']]);
  assert.match(refused.blocked[0].message, /^这个历史库是当前历史库迁移数据目录之前的那一份（当前库延续了它），不合并/);
  assert.deepEqual(conversations(fixture), ['x_2']);
});

test('审查 A：提交后中断的外来合并，外来库被移走也在启动时按账本和当前库收敛；请求过期或已删也照样收敛，不误报过期', async (t) => {
  for (const variant of ['moved-away', 'expired', 'request-removed', 'large-preparation']) {
    const fixture = await home(t);
    await seedConversations(fixture.alpha, [{ id: 'crash_1' }, { id: 'crash_2' }]);
    await seedConversations(fixture.current, [{ id: 'own_1' }]);
    const archivePath = await archive(fixture, fixture.alpha);
    const source = await found(fixture.root, archivePath);
    await request(fixture.root, source);
    await batch(fixture, { ...explicit(source.id), onFaultPoint: crashAfterCommit });
    assert.equal((await readLedgerRecord(fixture, source.id)).state, 'committing', variant);
    assert.deepEqual(conversations(fixture), ['crash_1', 'crash_2', 'own_1'], '事务已提交');
    const requestFile = path.join(ledgerRoot(fixture.root), 'requests', `${source.id.replace(/:/g, '-')}.json`);
    if (variant === 'moved-away') await fs.rename(archivePath, path.join(fixture.base, 'moved-away'));
    if (variant === 'expired') {
      const stored = JSON.parse(await fs.readFile(requestFile, 'utf8'));
      stored.requestedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      await fs.writeFile(requestFile, JSON.stringify(stored));
    }
    if (variant === 'request-removed') await fs.rm(requestFile);

    let startup;
    if (variant === 'large-preparation') {
      // The large-merge preparation picks its sources the same way: the commit converges there as well.
      await fs.rename(archivePath, path.join(fixture.base, 'moved-away'));
      const database = await openWindow(fixture);
      try {
        const preparation = await prepareLargeMergeSources({ paths: fixture.paths, target: { configurationRootPath: fixture.root, database } });
        startup = { ...preparation.report, merged: preparation.report.merged };
        assert.deepEqual(preparation.sources, []);
      } finally { await database.close(); }
    } else startup = await batch(fixture);
    assert.deepEqual(startup.merged.map((item) => [item.candidateId, item.insertedConversations, item.recoveredCommit]), [[source.id, 2, true]], variant);
    assert.deepEqual([startup.blocked, startup.deferred, startup.failures], [[], [], []], `${variant}：不误报过期或推迟`);
    if (variant !== 'request-removed') assert.equal(startup.merged[0].label, source.label, '名称来自请求');
    const record = await readLedgerRecord(fixture, source.id);
    assert.equal(record.state, 'merged');
    assert.deepEqual([...record.mergedInto[0].conversationIds].sort(), ['crash_1', 'crash_2'], '这一批对话记入闭包');
    assert.equal(await exists(requestFile), false, '请求随结果删除');
    const database = await openWindow(fixture);
    try {
      const plan = await planRuntimeBackupCleanup(fixture.root, database);
      assert.ok(!plan.items.some((item) => /正在提交的合并/.test(item.reason ?? '')), `${variant}：当前控制根的备份不再被悬挂的合并拦住`);
    } finally { await database.close(); }
    assert.deepEqual(brief(await batch(fixture)), { merged: [], blocked: [], deferred: [], failures: [] }, '收敛之后不再重复');
  }
});

test('审查 A2：提交后中断期间清理备份不把这份外来库判为可删；收敛后可删，但删除前的复核又见到正在提交的合并时保留', async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.alpha, [{ id: 'crash_1' }, { id: 'crash_2' }]);
  await seedConversations(fixture.current, [{ id: 'own_1' }]);
  const archivePath = await archive(fixture, fixture.alpha);
  const source = await found(fixture.root, archivePath);
  await request(fixture.root, source);
  await batch(fixture, { ...explicit(source.id), onFaultPoint: crashAfterCommit });
  const itemOf = (plan) => plan.items.find((entry) => entry.path === archivePath);
  let database = await openWindow(fixture);
  try {
    const item = itemOf(await planRuntimeBackupCleanup(fixture.root, database));
    assert.deepEqual([item?.deletable, item?.reason], [false, '有进行中的操作（正在提交的合并），完成之后再清理']);
  } finally { await database.close(); }

  assert.deepEqual(brief(await batch(fixture)).merged, [[source.id, 2, 0]], '启动时收敛');
  database = await openWindow(fixture);
  try {
    const plan = await planRuntimeBackupCleanup(fixture.root, database);
    const item = itemOf(plan);
    assert.equal(item?.deletable, true, item?.reason);
    // Before the deletion another merge of it got as far as its commit and stopped there.
    const file = path.join(ledgerRoot(fixture.root), 'records', `${source.id.replace(/:/g, '-')}.json`);
    const merged = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...merged, state: 'committing', commitId: randomUUID() }));
    const result = await deleteRuntimeBackups(plan, database, [item.key]);
    assert.deepEqual(result.deleted, []);
    assert.match(result.kept.map((entry) => entry.reason).join('\n'), /有进行中的操作（正在提交的合并），完成之后再清理；这一项没有删除/);
    assert.equal(await exists(archivePath), true, '来源保留');
  } finally { await database.close(); }
});

test('审查 B1：同一候选 id 的记录被新化身覆盖后，旧身份的闭包按来源身份保留；旧身份的重置归档作为外来库合并不带回删掉的对话', async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.current, [{ id: 'own_1' }]);
  await seedConversations(fixture.alpha, [{ id: 'b_1' }, { id: 'b_2' }]);
  await batch(fixture);
  await deleteUnrecorded(fixture.current.authority, 'b_1');
  const archivePath = await archive(fixture, fixture.alpha);
  const fresh = await initializeScope(fixture.paths, 'alpha');
  assert.equal(fresh.id, fixture.alpha.id);
  await seedConversations(fresh, [{ id: 'n_1' }]);
  assert.deepEqual(brief(await batch(fixture)).merged, [[fresh.id, 1, 0]], '新化身合并，覆盖同一候选 id 的记录');
  const record = await readLedgerRecord(fixture, fixture.alpha.id);
  assert.deepEqual(record.mergedInto.map((entry) => [...entry.conversationIds].sort()), [['n_1']]);
  assert.deepEqual(record.formerMergedInto.map((entry) => [entry.source, entry.target, [...entry.conversationIds].sort()]),
    [[identityOf(fixture.alpha.binding), identityOf(fixture.current.binding), ['b_1', 'b_2']]], '旧身份的闭包按来源身份保留');

  const source = await found(fixture.root, archivePath);
  assert.equal(source.root.recorded.dataSetId, fixture.alpha.binding.dataSetId);
  await request(fixture.root, source);
  const report = await batch(fixture, explicit(source.id));
  assert.deepEqual(brief(report).merged, [[source.id, 0, 1]]);
  assert.deepEqual(conversations(fixture), ['b_2', 'n_1', 'own_1'], '删掉的 b_1 没有回来');
  // A refusal recorded for the candidate id keeps it as well.
  await rawWrite(fresh, (database) => database.prepare('UPDATE conversation SET title = ? WHERE id = ?').run('changed', 'n_1'));
  await batch(fixture, explicit(fresh.id));
  assert.equal((await readLedgerRecord(fixture, fixture.alpha.id)).state, 'blocked');
  assert.deepEqual((await readLedgerRecord(fixture, fixture.alpha.id)).formerMergedInto.map((entry) => [...entry.conversationIds].sort()), [['b_1', 'b_2']]);
});

test('审查 B1 对照：记录没被覆盖时同一份归档合并同样不带回删掉的对话', async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.current, [{ id: 'own_1' }]);
  await seedConversations(fixture.alpha, [{ id: 'b_1' }, { id: 'b_2' }]);
  await batch(fixture);
  await deleteUnrecorded(fixture.current.authority, 'b_1');
  const source = await found(fixture.root, await archive(fixture, fixture.alpha));
  await request(fixture.root, source);
  assert.deepEqual(brief(await batch(fixture, explicit(source.id))).merged, [[source.id, 0, 1]]);
  assert.deepEqual(conversations(fixture), ['b_2', 'own_1']);
});

test('审查 D：本地库一时读不出时外来合并推迟（无法证明它不是旧拷贝），恢复后按旧拷贝拒绝；本地合并的闭包也取同身份外来记录的并集', async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.current, [{ id: 'own_1' }]);
  await seedConversations(fixture.alpha, [{ id: 'a_1' }, { id: 'a_2' }]);
  const container = path.join(fixture.base, `${path.basename(fixture.root)}.limcode-copied-2026-09-28T01-02-03-004Z-0000d00d`);
  await fs.cp(fixture.root, container, { recursive: true });
  const pointer = fixture.alpha.binding.paths.rootPointerPath;
  const saved = await fs.readFile(pointer);
  await fs.writeFile(pointer, '{ not json');
  const entries = await foreign.discoverForeignRuntimeHistory({ configurationRootPath: fixture.root });
  const entry = entries.find((item) => item.location.containerPath === container && item.scope !== 'default');
  const source = { ...entry, root: await foreign.locateForeignRuntimeRoot(fixture.root, entry.location), label: 'alpha 的旧拷贝' };
  assert.equal(source.root.recorded.dataSetId, fixture.alpha.binding.dataSetId);
  await request(fixture.root, source);
  const report = await batch(fixture, explicit(source.id));
  assert.deepEqual(brief(report), { merged: [], blocked: [], deferred: [[source.id, 'runtime-data-set-merge-local-unreadable']], failures: [] });
  assert.match(report.deferred[0].message, /本地有 1 个历史库暂时读不出，无法确认这个外来历史库不是它的旧拷贝/);
  assert.deepEqual(conversations(fixture), ['own_1']);
  await fs.writeFile(pointer, saved);
  const again = await batch(fixture, explicit(source.id));
  assert.deepEqual(brief(again).blocked, [[source.id, 'runtime-data-set-merge-foreign-old-copy']], '恢复后按旧拷贝拒绝');
  assert.deepEqual(conversations(fixture), ['own_1']);

  // An earlier version merged a copy of alpha (its record under the foreign id) before alpha itself; the user
  // deleted one of those conversations since. Merging alpha leaves it out: its closure is every record of its identity.
  await seedConversations(fixture.current, [{ id: 'a_1' }]);
  await deleteUnrecorded(fixture.current.authority, 'a_1');
  const file = path.join(ledgerRoot(fixture.root), 'records', `${source.id.replace(/:/g, '-')}.json`);
  const current = identityOf(fixture.current.binding);
  await fs.writeFile(file, JSON.stringify({
    kind: 'limcode-runtime-data-set-merge', candidateId: source.id,
    source: { ...identityOf(fixture.alpha.binding), rootGeneration: 1, pointerRevision: 1, contentDigest: 'earlier' },
    state: 'merged', target: current, mergedAt: NOW, insertedRows: 10, reusedRows: 0, insertedConversations: 1,
    mergedInto: [{ target: current, conversationIds: ['a_1'] }], updatedAt: NOW
  }));
  const local = await batch(fixture, explicit(fixture.alpha.id));
  assert.deepEqual(brief(local).merged, [[fixture.alpha.id, 1, 1]]);
  assert.deepEqual(conversations(fixture), ['a_2', 'own_1'], '删掉的 a_1 不被同一个库的另一份带回');
});

test('审查 UI-1：合并时跳过了删掉的对话，列表状态带上跳过数（提示改为清理备份会保留这份），清理备份确实保留它', async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.current, [{ id: 'own_1' }]);
  await seedConversations(fixture.alpha, [{ id: 'b_1' }, { id: 'b_2' }]);
  await batch(fixture);
  await deleteWithCommand(fixture.current.authority, fixture.root, 'b_1');
  const archivePath = await archive(fixture, fixture.alpha);
  const source = await found(fixture.root, archivePath);
  await request(fixture.root, source);
  const report = await batch(fixture, explicit(source.id));
  assert.deepEqual(report.merged.map((item) => [item.label, item.skippedConversations]), [[source.label, 1]]);
  const { entries } = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root });
  const state = (await foreignMerge.readForeignRuntimeHistoryMergeStates(fixture.paths, entries)).get(source.id);
  assert.deepEqual([state.state, state.intoCurrent, state.changedSinceMerge, state.skippedConversations], ['merged', true, false, 1]);
  const database = await openWindow(fixture);
  try {
    const item = (await planRuntimeBackupCleanup(fixture.root, database)).items.find((entry) => entry.path === archivePath);
    assert.equal(item?.deletable, false);
    assert.match(item?.reason ?? '', /含 1 个当前库没有的对话（可能是你删掉的）/);
  } finally { await database.close(); }
});

test('审查 B2：迁移进含旧拷贝的目录后，迁移写下的身份延续让迁移前当前库的旧拷贝仍是旧拷贝：列表标出、合并拒绝，删掉的对话不回来', async (t) => {
  const fixture = await moving.createFixture(t, { withAlpha: false });
  const copied = path.join(fixture.base, 'copied');
  await fs.cp(fixture.root, copied, { recursive: true });
  await fs.rm(path.join(copied, 'notes.txt'));
  await deleteUnrecorded(fixture.current.authority, 'conversation_current_1');
  const plan = await moving.relocation.planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: copied });
  assert.deepEqual([plan.target.kind, plan.target.sameDataSet], ['copied', true]);
  const { result, staged } = await moving.relocate(fixture, plan);
  const aside = result.copiedDataMovedTo;
  const current = await moving.selectedDataSet(copied);
  assert.notEqual(current.dataSetId, fixture.current.binding.dataSetId, '迁移后当前库是新身份');
  assert.deepEqual((await records.readRuntimeIdentityAliases(copied, current)).map((entry) => [entry.dataSetId, entry.rootInstanceId, entry.relocationId]),
    [[fixture.current.binding.dataSetId, fixture.current.binding.rootInstanceId, staged.relocationId]], '迁移写下：新的当前库延续迁移前的那一个');

  const report = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: copied, previousDataRootPaths: [fixture.root] });
  const entry = report.entries.find((item) => item.location.containerPath === aside && item.scope === 'default' && !item.archiveName);
  assert.deepEqual(entry.sameAsLocal, { candidateId: current.id, selected: true, name: '当前历史库', continued: true }, '列表标为当前库的旧拷贝');
  const source = { ...entry, root: await foreign.locateForeignRuntimeRoot(copied, entry.location), label: '旧拷贝' };
  await request(copied, source);
  const authority = createVscodeRootAuthority({ runtimeDataRootPath: current.runtimeDataRootPath, configurationRootPath: copied });
  const database = await kernel.RuntimeDatabase.open(authority, { hostBootId: `window-${randomUUID()}` });
  let merged;
  try {
    merged = await mergeHistoricalDataSetsOnline({ globalStoragePath: copied }, { configurationRootPath: copied, database }, explicit(source.id));
  } finally { await database.close(); }
  assert.deepEqual(brief(merged).blocked, [[source.id, 'runtime-data-set-merge-foreign-old-copy']]);
  assert.match(merged.blocked[0].message, /^这个外来历史库是当前历史库（迁移数据目录之前的那一份）的旧拷贝（同一个库的另一份），不合并/);
  assert.deepEqual(moving.conversationIds(current.runtimeDataRootPath), ['conversation_current_2'], '迁移前删掉的对话没有回来');
});

test('审查 B2b：迁移前合并过、之后删掉的对话，迁移带走账本并写下身份延续后，合并旧拷贝里的那个库时不回来', async (t) => {
  const fixture = await moving.createFixture(t);
  const window = await moving.openRuntime(fixture.current);
  try { await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database: window }, {}); }
  finally { await window.close(); }
  await deleteUnrecorded(fixture.current.authority, 'conversation_alpha_1');
  const copied = path.join(fixture.base, 'copied');
  await fs.cp(fixture.root, copied, { recursive: true });
  await fs.rm(path.join(copied, 'notes.txt'));
  const plan = await moving.relocation.planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: copied });
  assert.equal(plan.target.kind, 'copied');
  const { result } = await moving.relocate(fixture, plan);
  const current = await moving.selectedDataSet(copied);
  assert.ok(!moving.conversationIds(current.runtimeDataRootPath).includes('conversation_alpha_1'));
  assert.deepEqual(await readLedgerRecord({ paths: { globalStoragePath: copied } }, fixture.alpha.id), await readLedgerRecord(fixture, fixture.alpha.id),
    '迁移带走了账本：alpha 并进迁移前当前库的闭包');

  const source = await found(copied, result.copiedDataMovedTo, fixture.alpha.id, [fixture.root]);
  assert.equal(source.root.recorded.dataSetId, fixture.alpha.binding.dataSetId, '拷贝里的是迁移前合并过的 alpha');
  await request(copied, source);
  const authority = createVscodeRootAuthority({ runtimeDataRootPath: current.runtimeDataRootPath, configurationRootPath: copied });
  const database = await kernel.RuntimeDatabase.open(authority, { hostBootId: `window-${randomUUID()}` });
  let merged;
  try {
    merged = await mergeHistoricalDataSetsOnline({ globalStoragePath: copied }, { configurationRootPath: copied, database }, explicit(source.id));
  } finally { await database.close(); }
  assert.deepEqual([merged.blocked, merged.deferred, merged.failures], [[], [], []]);
  assert.deepEqual(merged.merged.map((item) => [item.candidateId, item.skippedConversations]), [[source.id, 1]]);
  assert.ok(!moving.conversationIds(current.runtimeDataRootPath).includes('conversation_alpha_1'), '迁移前删掉的对话没有回来');
});

// --- Data-root relocation carries what merges must never bring back (the relocation's part) ---------------

/** One batch in a window of `current` (a selected data set of the configuration root `root`). */
async function mergeIntoCurrent(root, current, options = {}) {
  const authority = createVscodeRootAuthority({ runtimeDataRootPath: current.runtimeDataRootPath, configurationRootPath: root });
  const database = await kernel.RuntimeDatabase.open(authority, { hostBootId: `window-${randomUUID()}` });
  try {
    return await mergeHistoricalDataSetsOnline({ globalStoragePath: root }, { configurationRootPath: root, database }, options);
  } finally { await database.close(); }
}

/** Deletion records, merge ledger records and continuations under `root`, file by file. */
async function bookkeeping(root) {
  const result = {};
  for (const section of ['deleted-conversations', 'records', 'aliases']) {
    const directory = path.join(ledgerRoot(root), section);
    if (!await exists(directory)) continue;
    for (const [file, digest] of Object.entries(await moving.treeSnapshot(directory))) result[`${section}/${file}`] = digest;
  }
  return result;
}

const recordFileOf = (root, candidateId) => path.join(ledgerRoot(root), 'records', `${candidateId.replace(/:/g, '-')}.json`);

test('迁移带走删除记录：账本里没有闭包时（记录丢了，或被更早的版本合并），迁移前经删除命令删掉的对话，迁移后合并旧拷贝里的那个库也不回来', async (t) => {
  const fixture = await moving.createFixture(t);
  assert.deepEqual(brief(await batch(fixture)).merged, [[fixture.alpha.id, 1, 0]]);
  assert.deepEqual((await deleteWithCommand(fixture.current.authority, fixture.root, 'conversation_alpha_1')).deletedConversationIds, ['conversation_alpha_1']);
  await fs.rm(recordFileOf(fixture.root, fixture.alpha.id));
  const copied = path.join(fixture.base, 'copied');
  await fs.cp(fixture.root, copied, { recursive: true });
  await fs.rm(path.join(copied, 'notes.txt'));
  const plan = await moving.relocation.planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: copied });
  assert.deepEqual([plan.target.kind, plan.problems], ['copied', []]);
  const { result } = await moving.relocate(fixture, plan);
  const current = await moving.selectedDataSet(copied);
  assert.deepEqual([...await records.readRuntimeDeletedConversations(copied, [identityOf(fixture.current.binding)])], ['conversation_alpha_1'],
    '删除记录带到了新目录（按迁移前当前库的身份）');
  assert.deepEqual((await records.readRuntimeMergeTargetIdentities(copied, current)).map((identity) => identity.dataSetId),
    [current.dataSetId, fixture.current.binding.dataSetId]);
  assert.deepEqual(result.others.migrated, [fixture.alpha.id]);
  const alphaCopy = (await moving.rootAuthority.inspectVscodeRuntimeDataSets({ globalStoragePath: copied })).candidates.find((item) => item.id === fixture.alpha.id);
  assert.notEqual(alphaCopy.dataSetId, fixture.alpha.binding.dataSetId);
  assert.deepEqual((await records.readRuntimeIdentityAliases(copied, alphaCopy)).map((entry) => entry.dataSetId), [fixture.alpha.binding.dataSetId],
    '迁走的其它库换了身份，同样写下延续');

  const source = await found(copied, result.copiedDataMovedTo, fixture.alpha.id, [fixture.root]);
  await request(copied, source);
  const merged = await mergeIntoCurrent(copied, current, explicit(source.id));
  assert.deepEqual(brief(merged).merged, [[source.id, 0, 1]], '只靠带过来的删除记录跳过');
  assert.ok(!moving.conversationIds(current.runtimeDataRootPath).includes('conversation_alpha_1'), '迁移前删掉的对话没有回来');
});

test('迁移进已有 LimCode 数据的目录：目标自己的合并记录、删除记录和身份延续都保留，与带过去的取并集（同一候选 id 的记录按来源身份保留两边的闭包，延续展开旧目录当前库自己的延续）；没切换、或带过去的记录核对不一致时撤销，目标的这些记录原样恢复', async (t) => {
  const fixture = await moving.createFixture(t);
  const earlier = { dataSetId: randomUUID(), rootInstanceId: randomUUID() };
  await writeAliases(fixture.root, fixture.current.binding, [earlier]);
  await records.recordRuntimeDeletedConversations(fixture.root, earlier, ['conversation_earlier_1']);
  assert.deepEqual(brief(await batch(fixture)).merged, [[fixture.alpha.id, 1, 0]]);
  await deleteWithCommand(fixture.current.authority, fixture.root, 'conversation_alpha_1');

  // The target's own library under alpha's candidate id, merged into its current data set there, deleted from it since.
  const target = path.join(fixture.base, 'existing');
  const existing = await moving.createLimCodeTarget(target);
  const scope = moving.rootAuthority.resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: ['file:///workspace/alpha'] });
  const scopeRoot = moving.rootAuthority.resolveVscodeWorkspaceRuntimeScopeRoot({ globalStoragePath: target }, scope);
  await fs.mkdir(scopeRoot, { recursive: true });
  const theirs = await moving.initialize(scopeRoot, fixture.alpha.id);
  await moving.seed(theirs, [{ id: 'conversation_theirs_1', project: moving.PROJECT }]);
  const targetHome = { root: target, paths: { globalStoragePath: target }, current: existing };
  assert.deepEqual(brief(await batch(targetHome)).merged, [[fixture.alpha.id, 1, 0]]);
  await deleteWithCommand(existing.authority, target, 'conversation_theirs_1');
  const theirsEarlier = { dataSetId: randomUUID(), rootInstanceId: randomUUID() };
  await writeAliases(target, existing.binding, [theirsEarlier]);
  const keptRecord = await readLedgerRecord(targetHome, fixture.alpha.id);
  assert.deepEqual(keptRecord.mergedInto, [{ target: identityOf(existing.binding), conversationIds: ['conversation_theirs_1'] }]);
  const before = await bookkeeping(target);

  const plan = await moving.relocation.planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  assert.deepEqual([plan.target.kind, plan.problems], ['limcode', []]);
  // Not switched (the pointer write provably did not happen): undone.
  await assert.rejects(moving.relocate(fixture, plan, { publish: async () => { throw new Error('指针没有写成'); } }), /指针没有写成/);
  assert.deepEqual(await bookkeeping(target), before, '没切换就撤销：目标的记录原样恢复，带过去的都去掉');
  // The joined record damaged right after it was written: the check finds it, the relocation is undone.
  const recordFile = recordFileOf(target, fixture.alpha.id);
  const rename = fs.rename;
  let damaged = false;
  fs.rename = async function (from, to, ...rest) {
    const done = await rename.call(this, from, to, ...rest);
    if (!damaged && to === recordFile && !String(from).includes('.limcode-relocation-backups')) {
      damaged = true;
      await fs.writeFile(to, '{');
    }
    return done;
  };
  try {
    await assert.rejects(moving.relocate(fixture, plan),
      (error) => error.code === 'data-root-relocation-merge-records' && /带到新数据目录的合并记录与旧目录核对不一致，整体取消迁移/.test(error.message));
  } finally { fs.rename = rename; }
  assert.equal(damaged, true);
  assert.deepEqual(await bookkeeping(target), before, '核对不一致也撤销：目标的记录原样恢复');

  const { staged } = await moving.relocate(fixture, plan);
  const { formerMergedInto, ...record } = await readLedgerRecord(targetHome, fixture.alpha.id);
  assert.deepEqual(record, keptRecord, '目标自己的记录（状态、来源、闭包）不变');
  assert.deepEqual(formerMergedInto, [{
    source: identityOf(fixture.alpha.binding), target: identityOf(fixture.current.binding), conversationIds: ['conversation_alpha_1']
  }], '旧目录那条的闭包按它的来源身份保留');
  const deletions = async (identity) => [...await records.readRuntimeDeletedConversations(target, [identity])];
  assert.deepEqual(await deletions(existing.binding), ['conversation_theirs_1']);
  assert.deepEqual(await deletions(fixture.current.binding), ['conversation_alpha_1']);
  assert.deepEqual(await deletions(earlier), ['conversation_earlier_1']);
  assert.deepEqual((await records.readRuntimeIdentityAliases(target, existing.binding)).map((entry) => [entry.dataSetId, entry.relocationId === staged.relocationId]),
    [[theirsEarlier.dataSetId, false], [fixture.current.binding.dataSetId, true], [earlier.dataSetId, false]],
    '目标原有的延续在前，再是旧目录的当前库和它延续的更早身份');
});

test('迁移预检：旧目录的删除记录或身份延续读不出、已有 LimCode 目标里有同名但内容不同的删除记录时，拒绝并写明原因', async (t) => {
  const fixture = await moving.createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'existing');
  await moving.createLimCodeTarget(target);
  const problems = async () => (await moving.relocation.planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target })).problems.join('\n');
  await deleteWithCommand(fixture.current.authority, fixture.root, 'conversation_current_1');
  assert.equal(await problems(), '');
  const name = `${fixture.current.binding.dataSetId}.${fixture.current.binding.rootInstanceId}`;
  const [file] = await fs.readdir(path.join(ledgerRoot(fixture.root), 'deleted-conversations', name));
  const theirs = path.join(ledgerRoot(target), 'deleted-conversations', name);
  await fs.mkdir(theirs, { recursive: true });
  await fs.writeFile(path.join(theirs, file), JSON.stringify({ version: 1, conversationIds: ['conversation_other'], deletedAt: NOW }));
  assert.match(await problems(), /^新数据目录里已有同名但内容不同的删除记录（.+），无法合在一起。迁移要把删除记录、合并记录和身份延续带到新目录.*这次不迁移。$/m);
  await fs.rm(theirs, { recursive: true });
  const own = path.join(ledgerRoot(fixture.root), 'deleted-conversations', name, file);
  const text = await fs.readFile(own, 'utf8');
  await fs.writeFile(own, '{');
  assert.match(await problems(), /^旧目录里的删除记录读不出（删除记录 .+ 不是完整的 JSON）。.*这次不迁移。$/m);
  await fs.writeFile(own, text);
  await fs.mkdir(path.join(ledgerRoot(fixture.root), 'aliases'), { recursive: true });
  await fs.writeFile(path.join(ledgerRoot(fixture.root), 'aliases', `${name}.json`), JSON.stringify({ version: 2, continues: [] }));
  assert.match(await problems(), /^旧目录里历史库的身份延续记录读不出（身份延续记录 .+ 的格式不认识）。.*这次不迁移。$/m);
});

test('迁移合并也按删除记录：新目录的当前库里删掉的对话不被迁过去，旧目录里的这个库因此保留、不列为可删', async (t) => {
  const fixture = await moving.createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'existing');
  const existing = await moving.createLimCodeTarget(target, {
    conversations: [{ id: 'conversation_current_1', project: moving.PROJECT }, { id: 'conversation_existing_1', project: moving.PROJECT }]
  });
  const deleted = await deleteWithCommand(existing.authority, target, 'conversation_current_1');
  assert.deepEqual(deleted.deletedConversationIds, ['conversation_current_1']);
  const plan = await moving.relocation.planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target });
  assert.equal(plan.target.kind, 'limcode');
  const { result, staged } = await moving.relocate(fixture, plan, { publish: async () => undefined });
  assert.deepEqual([result.merged.insertedConversations, result.merged.skippedConversations], [1, 1]);
  assert.deepEqual(moving.conversationIds(existing.binding.paths.dataRootPath), ['conversation_current_2', 'conversation_existing_1'], '删掉的对话没有被迁回来');
  const deletion = await moving.relocation.planOldDataRootDeletion({ oldRootPath: fixture.root, currentRootPath: target, relocationId: staged.relocationId });
  const item = deletion.items.find((entry) => entry.key === 'data-set:default');
  assert.equal(item?.deletable, false, '只在旧目录里还有的对话所在的库不删');
  assert.equal(item?.reason, '迁移时有 1 个对话你在新目录的当前库里删除过，没有并过去，只在这里还有，所以保留');
});

test('审查低-4：外来正文一个对象同样大小、内容被改，合并记为失败，不发布这个对象、不提交任何行', async (t) => {
  const fixture = await home(t);
  const elsewhere = await createConfigurationRoot({ tmp: fixture.base });
  await seedConversations(elsewhere.current, [{ id: 'obj_1' }, { id: 'obj_2' }]);
  const container = path.join(fixture.base, `${path.basename(fixture.root)}.limcode-copied-2026-09-28T01-02-03-004Z-0000abcd`);
  await fs.cp(elsewhere.root, container, { recursive: true });
  const source = await found(fixture.root, container, 'default');
  const sha256Root = path.join(source.root.located.casRootPath, 'sha256');
  const prefix = (await fs.readdir(sha256Root)).sort()[0];
  const object = path.join(sha256Root, prefix, (await fs.readdir(path.join(sha256Root, prefix))).sort()[0]);
  const bytes = await fs.readFile(object);
  bytes[0] ^= 0xff;
  await fs.chmod(object, 0o644);
  await fs.writeFile(object, bytes);
  const objectsOfTarget = async () => {
    const root = path.join(fixture.current.binding.paths.casRootPath, 'sha256');
    const names = [];
    for (const part of await fs.readdir(root).catch(() => [])) names.push(...(await fs.readdir(path.join(root, part))).map((name) => `${part}/${name}`));
    return names;
  };
  await request(fixture.root, source);
  const report = await batch(fixture, explicit(source.id));
  assert.deepEqual(brief(report).failures, [[source.id, 'runtime-data-set-merge-source-cas-invalid']]);
  assert.deepEqual(conversations(fixture), []);
  assert.ok(!(await objectsOfTarget()).includes(path.relative(sha256Root, object)), '被改的对象没有发布');
  assert.equal((await readLedgerRecord(fixture, source.id)).state, 'failed');
});
