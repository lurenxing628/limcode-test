import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { before, after } from 'node:test';
import {
  createHistoryFixture, initializeRoot, openRuntime, openStore, seedConversation, seedMessage,
  kernelFile, repo, rawSql, captureFiles, Database, NOW
} from './fixtures/ci-storage-history.mjs';
import { createPublishedRuntime } from './fixtures/ci-storage-upgrade.mjs';

const foreign = kernelFile('runtimeForeignHistory.js');
const foreignMerge = kernelFile('runtimeForeignHistoryMerge.js');
const registry = kernelFile('runtimeHistoryRegistry.js');
const { mergeHistoricalDataSetsOnline } = kernelFile('runtimeDataSetMerge.js');
const { openRuntimeDataSetHistory } = kernelFile('runtimeDataSetHistory.js');
const { readRuntimeDataSetMergeLedger } = kernelFile('runtimeDataSetMergeLedger.js');
const { resolveVscodeRuntimeMergeLedgerRoot } = kernelFile('vscodeRootAuthority.js');
const { configureWriterConnection } = kernelFile('databaseSchema.js');
const { PACKED_CAS_FILE } = kernelFile('packedCasWorkerProtocol.js');
let f, current, original, baseCopy, longBody, sequence = 0;

before(async () => {
  f = await createHistoryFixture();
  original = await initializeRoot(path.join(f.base, 'recorded-original'));
  const database = await openRuntime(original);
  try {
    const store = openStore(original, database);
    longBody = 'a'.repeat(32767) + '😀tail';
    await seedConversation(database, store, 'normal', longBody);
    await seedMessage(database, store, 'normal', 'normal_tool', 2, '工具结果正文', 'tool');
  } finally { await database.close(); }
  current = await openRuntime(f.current);
  baseCopy = await copyRoot(original);
});
after(async () => { await current?.close(); if (f) await fs.rm(f.base, { recursive: true, force: true }); });

async function copyRoot(dataSet = original) {
  sequence++;
  const container = path.join(f.base, `${path.basename(f.root)}.limcode-copied-2026-10-13T01-02-03-004Z-${sequence.toString(16).padStart(8, '0')}`);
  await fs.cp(dataSet.scopeRoot, container, { recursive: true });
  return locate(container);
}
async function locate(container) {
  const entries = await foreign.discoverForeignRuntimeHistory({ configurationRootPath: f.root });
  const entry = entries.find(item => item.location.containerPath === container && item.scope === 'default');
  assert.ok(entry, `未发现外来来源 ${container}`);
  const root = await foreign.locateForeignRuntimeRoot(f.root, entry.location);
  return { ...entry, root, databasePath: root.located.databasePath, label: `外来历史库 ${entry.name}` };
}
function locatedDataSet(source) { return { binding: { ...source.root.recorded, paths: source.root.located } }; }
async function merge(source, options = {}) {
  await registry.writeRuntimeHistoryPending(f.paths, { id: source.id, sourceKind: source.location.kind,
    location: source.location, identity: { dataSetId: source.root.recorded.dataSetId, rootInstanceId: source.root.recorded.rootInstanceId },
    label: source.label, reason: '用户合并历史', registeredAt: NOW });
  return mergeHistoricalDataSetsOnline(f.paths, { configurationRootPath: f.root, database: current },
    { candidateIds: [source.id], requested: true, ...options });
}
const record = async source => (await readRuntimeDataSetMergeLedger(f.paths)).get(source.id);
const sourceFiles = source => [source.databasePath, `${source.databasePath}-wal`, source.root.located.rootPointerPath,
  source.root.located.runtimeEpochPath, path.join(source.root.located.casRootPath, PACKED_CAS_FILE)];
function addConversation(source, id, active = false) {
  rawSql(locatedDataSet(source), database => {
    database.prepare('INSERT INTO conversation VALUES (?, ?, ?, ?, ?)').run(id, id, 'active', NOW, NOW);
    database.prepare('INSERT INTO turn VALUES (?, ?, ?, ?, ?, ?)').run(`${id}_turn`, id,
      active ? 'active' : 'terminated', NOW, NOW, active ? null : NOW);
    if (!active) database.prepare('INSERT INTO turn_termination VALUES (?, ?, ?, ?, ?)')
      .run(`${id}_termination`, `${id}_turn`, 'completed', 'fixture', NOW);
  });
}

test('Windows pathname缺卷号时只读桥接接受同inode的合法句柄身份', async t => {
  const file = path.join(f.base, 'volume-record.json');
  await fs.writeFile(file, '{"volume":"same file"}');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const lstat = fs.lstat, open = fs.open;
  t.mock.method(fs, 'lstat', async (input, ...args) => {
    const info = await lstat(input, ...args);
    if (String(input) === file && args[0]?.bigint) info.dev = 0n;
    return info;
  });
  t.mock.method(fs, 'open', async (input, ...args) => {
    const handle = await open(input, ...args);
    if (String(input) === file) {
      const stat = handle.stat.bind(handle);
      handle.stat = async (...options) => { const info = await stat(...options); info.dev = 123n; return info; };
    }
    return handle;
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try { assert.equal((await foreign.readLocatedRuntimeFile(file, new Set(), 1024)).toString(), '{"volume":"same file"}'); }
  finally { Object.defineProperty(process, 'platform', platform); }
});

test('外来正常合并只读located，mixed packed/loose正文复制且再次合并无新内容', async t => {
  const source = baseCopy;
  const before = await captureFiles(sourceFiles(source));
  const accessedRecorded = [];
  for (const method of ['open', 'lstat', 'stat', 'readFile', 'readdir']) {
    const originalMethod = fs[method];
    t.mock.method(fs, method, async (file, ...args) => {
      if (typeof file === 'string' && (file === original.scopeRoot || file.startsWith(`${original.scopeRoot}${path.sep}`))) {
        accessedRecorded.push([method, file]);
      }
      return originalMethod(file, ...args);
    });
  }
  const result = await merge(source);
  assert.equal(result.merged.length, 1, JSON.stringify(result));
  assert.equal(result.merged[0].insertedConversations, 1);
  assert.equal(result.merged[0].linkedCasObjects, 0);
  assert.deepEqual(accessedRecorded, []);
  const objects = (await current.snapshot([repo('ContentObject').list({ limit: 100 })])).snapshot[0];
  const store = openStore(f.current, current);
  const bodies = await Promise.all(objects.map(object => store.read(object)));
  assert.ok(bodies.some(bytes => bytes.toString().includes('😀tail')));
  assert.ok(bodies.some(bytes => bytes.toString().includes('工具结果正文')));
  assert.ok((await fs.stat(path.join(f.current.binding.paths.casRootPath, PACKED_CAS_FILE))).isFile());
  const again = await merge(source);
  assert.equal(again.merged[0].alreadyMerged, true);
  assert.equal((await record(source)).state, 'merged');
  assert.deepEqual(await captureFiles(sourceFiles(source)), before);
});

test('外来忙碌对话剔除，安全对话合并并持久化partial', async () => {
  const source = await copyRoot();
  addConversation(source, 'busy', true);
  addConversation(source, 'ready');
  const before = await captureFiles(sourceFiles(source));
  const result = await merge(source);
  assert.equal(result.merged[0].insertedConversations, 1, JSON.stringify(result));
  const partial = await record(source);
  assert.equal(partial.state, 'partial');
  assert.deepEqual(partial.excluded.map(item => item.conversationId), ['busy']);
  const [ready, busy] = (await current.snapshot([repo('Conversation').get('ready'), repo('Conversation').get('busy')])).snapshot;
  assert.equal(ready.id, 'ready');
  assert.equal(busy, null);
  assert.deepEqual(await captureFiles(sourceFiles(source)), before);
});

test('备份后来源变化推迟提交，目标无新增行且不写committing', async () => {
  const source = await copyRoot();
  addConversation(source, 'changing');
  const result = await merge(source, { async onFaultPoint(point) {
    if (point === 'after-target-backup') {
      const later = new Date(Date.now() + 1000);
      await fs.utimes(source.databasePath, later, later);
    }
  } });
  assert.equal(result.deferred[0].code, 'runtime-data-set-merge-source-changed', JSON.stringify(result));
  assert.equal((await current.snapshot([repo('Conversation').get('changing')])).snapshot[0], null);
  assert.equal(await record(source), undefined);
});

test('外来audit取消等worker退出、清理私有副本后才释放声明', async () => {
  const source = await copyRoot();
  const controller = new AbortController();
  const reason = new Error('本次历史核验取消');
  const hold = await foreignMerge.holdForeignHistoricalMergeSource(f.paths, source.id,
    { location: source.location, label: source.label }, { signal: controller.signal });
  let snapshotPath;
  try {
    const candidate = await hold.locate();
    await assert.rejects(hold.snapshot(candidate, { beforeOpen: async file => {
      snapshotPath = file;
      const audit = kernelFile('runtimeSnapshotAudit.js').auditRuntimeSnapshot(file,
        { binding: candidate.root.recorded }, { signal: controller.signal });
      controller.abort(reason);
      await audit;
    } }), error => error === reason);
    assert.equal(hold.held, true);
    await assert.rejects(fs.stat(snapshotPath), { code: 'ENOENT' });
  } finally { await hold.release(); }
  assert.equal(hold.held, false);
  assert.equal((await foreign.tryWithForeignRuntimeRootClaim(f.root, source.id,
    source.root.located.rootPointerPath, async () => true)).acquired, true);
});

test('已发布epoch3旧续接只在私有副本转换，原件保留并合并新正文', async () => {
  const published = await createPublishedRuntime(3, { configurationRoot: path.join(f.base, 'published-recorded') });
  const legacy = published.legacyContinuation;
  rawSql({ binding: { paths: published.paths } }, database => {
    database.prepare("UPDATE turn_intent SET state='cancelled' WHERE id=?").run(legacy.ids.turnIntentId);
    database.prepare("UPDATE child_execution_intent_link SET state='cancelled' WHERE id=?").run(legacy.ids.intentLinkId);
    database.prepare("UPDATE runtime_delivery SET state='failed', failure_reason='fixture-finished' WHERE id=?").run(legacy.deliveryId);
  });
  const source = await copyRoot({ scopeRoot: published.scope, binding: published.previous });
  assert.equal(source.root.recorded.runtimeKernelEpoch, 3);
  const before = await captureFiles(sourceFiles(source));
  const result = await merge(source);
  assert.equal(result.merged[0].insertedConversations, 1, JSON.stringify(result));
  const [revision, link] = (await current.snapshot([
    repo('TurnIntentRevision').get(legacy.ids.turnIntentRevisionId), repo('RuntimeDeliveryIntentLink').get(legacy.ids.deliveryIntentLinkId)
  ])).snapshot;
  const content = (await current.snapshot([repo('ContentObject').get(revision.content_object_id)])).snapshot[0];
  const converted = JSON.parse((await openStore(f.current, current).read(content)).toString());
  assert.deepEqual(converted, { kind: 'runtime_continuation', sourceTurnId: legacy.sourceTurnId, version: 1 });
  assert.equal(link.delivery_id, legacy.deliveryId);
  const overlay = source.root.upgradeCasOverlayRoot;
  assert.ok(path.relative(resolveVscodeRuntimeMergeLedgerRoot(f.paths), overlay).startsWith('foreign-upgrade-cas'));
  assert.ok((await fs.stat(path.join(overlay, ...content.storage_key.split('/')))).isFile());
  await assert.rejects(fs.stat(path.join(source.root.located.casRootPath, ...content.storage_key.split('/'))), { code: 'ENOENT' });
  assert.deepEqual(await captureFiles(sourceFiles(source)), before);
});

test('打开前被换成持锁数据库硬链接时拒绝且不关闭该描述符', async t => {
  const source = await copyRoot();
  const pointer = source.root.located.rootPointerPath;
  const open = fs.open;
  let swapped = false, closes = 0;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (String(file) !== pointer) return open(file, ...args);
    if (!swapped) {
      swapped = true;
      await fs.unlink(pointer);
      await fs.link(f.current.binding.paths.databasePath, pointer);
    }
    const handle = await open(file, ...args);
    const close = handle.close.bind(handle);
    handle.close = async () => { closes++; return close(); };
    return handle;
  });
  await assert.rejects(foreign.locateForeignRuntimeRoot(f.root, source.location), error => error.code === 'foreign-history-open-database');
  assert.equal(swapped, true);
  assert.equal(closes, 0);
  assert.equal((await current.snapshot([repo('Conversation').get('normal')])).snapshot[0].id, 'normal');
  await fs.unlink(pointer);
});

test('暂态SQLITE_CANTOPEN不记录永久核验失败缓存', async t => {
  const source = await copyRoot();
  const open = fs.open;
  let copiedPath;
  t.mock.method(fs, 'open', async (file, flags, ...args) => {
    const handle = await open(file, flags, ...args);
    if (flags === 'wx') copiedPath = path.resolve(String(file));
    if (typeof flags === 'number' && String(file) === source.databasePath) {
      const close = handle.close.bind(handle);
      handle.close = async () => { const result = await close(); if (copiedPath) await fs.rm(copiedPath, { force: true }); return result; };
    }
    return handle;
  });
  const report = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: f.root });
  const entry = report.entries.find(item => item.id === source.id);
  assert.equal(entry.status, 'unavailable', JSON.stringify(entry));
  assert.equal(entry.code, 'foreign-history-audit-unavailable');
  await assert.rejects(fs.stat(path.join(resolveVscodeRuntimeMergeLedgerRoot(f.paths), 'foreign', `${source.id.replaceAll(':', '-')}.json`)), { code: 'ENOENT' });
});

test('启动发现仅目录和小JSON，不打开SQLite或扫描正文', async t => {
  const root = path.join(f.root, registry.RUNTIME_RESET_BACKUPS_DIRECTORY, '2026-reset');
  await fs.mkdir(root, { recursive: true });
  const open = fs.open;
  const opened = [];
  t.mock.method(fs, 'open', async (file, ...args) => { opened.push(String(file)); return open(file, ...args); });
  const entries = await foreign.discoverForeignRuntimeHistory({ configurationRootPath: f.root });
  assert.ok(entries.some(item => item.id === baseCopy.id));
  assert.equal(entries.some(item => item.location.containerPath === root), false);
  assert.ok(opened.every(file => file.endsWith('.json')), opened.join('\n'));
});

test('私有只读快照保留WAL事实、mixed正文分页与Unicode续页，源文件不改写', async () => {
  const source = await copyRoot();
  const writer = new Database(source.databasePath);
  configureWriterConnection(writer);
  writer.pragma('wal_autocheckpoint=0');
  writer.prepare('INSERT INTO conversation VALUES (?, ?, ?, ?, ?)').run('wal-only', 'WAL提交', 'active', NOW, NOW);
  const before = await captureFiles(sourceFiles(source));
  let reader;
  try {
    reader = await openRuntimeDataSetHistory(f.paths, await foreign.locateForeignRuntimeRoot(f.root, source.location));
    assert.ok((await reader.listConversations()).items.some(item => item.id === 'wal-only'));
    const first = await reader.readMessages('normal', { limit: 1 });
    assert.equal(first.items[0].hasMoreText, true);
    const tail = await reader.readMessageText('normal', first.items[0].id, { offset: first.items[0].nextTextOffset });
    assert.equal(first.items[0].text + tail.text, longBody);
    const second = await reader.readMessages('normal', { limit: 1, after: first.next });
    assert.equal(second.items[0].role, 'tool');
    assert.match(second.items[0].text, /工具结果正文/);
    await reader.close(); reader = undefined;
    assert.deepEqual(await captureFiles(sourceFiles(source)), before);
  } finally { await reader?.close(); writer.close(); }
});
