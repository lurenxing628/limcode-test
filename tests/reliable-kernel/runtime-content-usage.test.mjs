import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

// 按类型统计正文占用（历史与存储管理 → 查看存储占用，以及 inspectReliability）。真实 Runtime worker、
// 真实 CAS、编译后的 Facade 与命令层；只有 VS Code 和命令层这里用不到的依赖是桩。

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;

/** What the loaded modules showed or registered through VS Code; tests reset what they read. */
const ui = { picks: [], documents: [], messages: [], registered: new Map(), provider: undefined };
const vscode = {
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  Uri: { parse: (text) => ({ toString: () => text }), from: (parts) => ({ toString: () => JSON.stringify(parts) }) },
  ProgressLocation: { Notification: 15 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  window: {
    async showQuickPick(items) { const pick = ui.picks.shift(); return typeof pick === 'function' ? pick(items) : pick; },
    async withProgress(_options, task) { return task({ report() {} }); },
    async showTextDocument(document) { ui.documents.push(document.text); },
    async showInformationMessage(message) { ui.messages.push(['info', message]); },
    async showWarningMessage(message) { ui.messages.push(['warning', message]); },
    async showErrorMessage(message) { ui.messages.push(['error', message]); }
  },
  workspace: {
    registerTextDocumentContentProvider(_scheme, provider) { ui.provider = provider; return { dispose() {} }; },
    onDidCloseTextDocument() { return { dispose() {} }; },
    async openTextDocument(input) {
      return { text: typeof input?.content === 'string' ? input.content : ui.provider.provideTextDocumentContent(input) };
    }
  },
  commands: {
    registerCommand(id, callback) { ui.registered.set(id, callback); return { dispose() {} }; },
    async executeCommand() {}
  }
};

/** Data sets and directory statistics the stubbed storage inspection reports. */
const storageFixture = { candidates: [] };
const DIRECTORY_CATEGORIES = {
  sqlite: { fileCount: 3, bytes: '8192' },
  cas: { fileCount: 2, bytes: '512' },
  casTemporary: { fileCount: 0, bytes: '0' },
  processSpool: { fileCount: 0, bytes: '0' },
  diagnostics: { fileCount: 1, bytes: '100' },
  other: { fileCount: 2, bytes: '64' },
  historicalBackups: { fileCount: 0, bytes: '0' }
};
const managementStubs = {
  '../../backend/capabilities/vscodeStorage/globalStatus': {
    loadCommittedGlobalStatus: async () => undefined,
    resolveDataRootUri: () => ({ fsPath: '/fixture' })
  },
  '../../backend/capabilities/vscodeStorage/paths': { createVscodeStoragePaths: () => ({ globalStoragePath: '/fixture' }) },
  '../../backend/reliableKernel/vscodeRootAuthority': {
    inspectVscodeRuntimeDataSets: async () => ({ candidates: storageFixture.candidates, problems: [] }),
    resolveVscodeRuntimeDataSet: async (_paths, id) => storageFixture.candidates.find((candidate) => candidate.id === id),
    selectVscodeRuntimeDataSet: async () => { throw new Error('这里不切换历史库'); },
    VscodeRuntimeDataSetSelectionRequiredError: class extends Error {}
  },
  '../../backend/reliableKernel/runtimeDataSetHistory': {},
  '../../backend/reliableKernel/runtimeDataSetUpgrade': {},
  '../../backend/reliableKernel/runtimeDataSetMerge': {
    readRuntimeDataSetMergeStates: async () => new Map(),
    // Summaries of other libraries are read under that library's claims.
    withRuntimeDataSetReadClaims: async (_paths, _candidate, read) => read()
  },
  '../../backend/reliableKernel/runtimeDataSetPreflight': { summarizeRuntimeDataSet: async () => undefined },
  '../../backend/reliableKernel/runtimeExclusiveMaintenance': { EXCLUSIVE_MAINTENANCE_DEFAULTS: { busyWaitTimeoutMs: 60_000 } },
  '../../backend/reliableKernel/runtimeStorageInspection': {
    async inspectRuntimeDataSetStorage(_paths, id) {
      const candidate = storageFixture.candidates.find((entry) => entry.id === id);
      return {
        candidateId: id, dataSetId: candidate.dataSetId, observedAt: '2026-09-27T00:00:00.000Z',
        selected: candidate.selected, categories: DIRECTORY_CATEGORIES,
        total: { fileCount: 8, bytes: '8868' }, archiveReclaimsBytes: false
      };
    },
    deleteUnselectedRuntimeDataSet: async () => { throw new Error('这里不删除历史库'); }
  },
  '../runtimeDataSetUpgradeLifetime': { canStartRuntimeDataSetUpgrade: () => true, runRuntimeDataSetUpgrade: async (_context, run) => run() },
  '../runtimeExclusiveMaintenance': {}
};
const storageViewCalls = [];
const registerStubs = {
  '../panels/MainPanel': { MainPanel: {} },
  './runtimeDataSetManagement': { showRuntimeStorage: async (...args) => { storageViewCalls.push(args); } }
};
const loadedFrom = (parent, ...segments) => (parent?.filename ?? '').endsWith(path.join(...segments));
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  if (loadedFrom(parent, 'vscode', 'commands', 'runtimeDataSetManagement.js')
    && Object.prototype.hasOwnProperty.call(managementStubs, request)) return managementStubs[request];
  if (loadedFrom(parent, 'vscode', 'commands', 'registerCommands.js')
    && Object.prototype.hasOwnProperty.call(registerStubs, request)) return registerStubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiledRoot, 'backend/reliableKernel/index.js'));
const usage = require(path.join(compiledRoot, 'backend/reliableKernel/runtimeContentUsage.js'));
const { PACKED_CAS_FILE } = require(path.join(compiledRoot, 'backend/reliableKernel/packedCasWorkerProtocol.js'));
const NativeDatabase = require('better-sqlite3');

const MESSAGE = 'application/vnd.limcode.message+json';
const TOOL_RESULT = 'application/vnd.limcode.tool-model-result+json';
const MAINTAINER_SQL = 'SELECT content_type, COUNT(*), SUM(byte_length), MAX(byte_length) FROM content_object GROUP BY content_type';
const NOTE_DELETION = '删除对话目前不会释放正文空间。';
const NOTE_PER_RECORD = '这里按记录统计，同一正文被几种记录共用时会重复计入；磁盘实际占用以上方目录统计为准。';
const bytesLabel = (bytes) => `${bytes} B`;
const figures = ({ count, bytes, maxBytes }) => ({ count, bytes, maxBytes });

async function openRuntime(t, name) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-content-usage-${name}-`));
  const root = await kernel.resetCandidateRuntimeRoot(directory);
  const database = await kernel.RuntimeDatabase.open(root.authority, { hostBootId: `content-usage-${name}-${path.basename(directory)}` });
  const store = kernel.ContentAddressedStore.forDatabase(root.authority, database);
  t.after(async () => {
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { root, database, store };
}

/** The selected data set exactly as 历史与存储管理 lists the root this window has open. */
function currentCandidate(binding, overrides = {}) {
  return {
    id: 'default', source: 'fixed', selected: true,
    configurationRootPath: '/fixture', runtimeScopeRootPath: '/fixture',
    runtimeDataRootPath: binding.paths.dataRootPath,
    dataSetId: binding.dataSetId, rootInstanceId: binding.rootInstanceId, runtimeKernelEpoch: kernel.RUNTIME_KERNEL_EPOCH,
    ...overrides
  };
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function sourceFiles(directory) {
  const found = [];
  const walk = (current) => {
    for (const entry of require('node:fs').readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(entryPath); }
      else if (/\.(?:ts|vue)$/.test(entry.name)) found.push(entryPath);
    }
  };
  walk(directory);
  return found;
}

test('统计语句就是维护者给定的那条，只按序扫描覆盖索引，不建临时 B 树（有 ANALYZE 统计时也一样）', async (t) => {
  const { root, database, store } = await openRuntime(t, 'plan');
  for (let index = 0; index < 40; index += 1) {
    await store.ingest(database, `record-${index}`, index % 3 === 0 ? MESSAGE : index % 3 === 1 ? TOOL_RESULT : 'image/png');
  }
  const native = new NativeDatabase(root.binding.paths.databasePath, { readonly: true });
  t.after(() => native.close());
  const indexColumns = native.prepare("SELECT name FROM pragma_index_info('ux_content_object_01') ORDER BY seqno").all().map((row) => row.name);
  assert.deepEqual(indexColumns, ['content_type', 'sha256', 'byte_length']);
  const planOf = (connection) => connection.prepare(`EXPLAIN QUERY PLAN ${usage.RUNTIME_CONTENT_USAGE_SQL}`).all().map((step) => String(step.detail));
  const plan = planOf(native);
  assert.ok(plan.some((detail) => /\bUSING COVERING INDEX ux_content_object_01\b/.test(detail)), plan.join(' | '));
  assert.ok(!plan.some((detail) => /TEMP B-TREE/.test(detail)), plan.join(' | '));

  // The planner keeps the ordered covering scan once sqlite_stat1 exists (checked on a private copy).
  const copyPath = path.join(path.dirname(root.binding.paths.dataRootPath), 'analyzed-copy.sqlite');
  await native.backup(copyPath);
  const analyzed = new NativeDatabase(copyPath);
  t.after(() => analyzed.close());
  analyzed.exec('ANALYZE');
  assert.ok(analyzed.prepare("SELECT COUNT(*) AS count FROM sqlite_stat1 WHERE tbl = 'content_object'").get().count > 0);
  const analyzedPlan = planOf(analyzed);
  assert.ok(analyzedPlan.some((detail) => /\bUSING COVERING INDEX ux_content_object_01\b/.test(detail)), analyzedPlan.join(' | '));
  assert.ok(!analyzedPlan.some((detail) => /TEMP B-TREE/.test(detail)), analyzedPlan.join(' | '));
  // The worker runs exactly this statement (the plan above belongs to it).
  assert.equal(usage.RUNTIME_CONTENT_USAGE_SQL, MAINTAINER_SQL);
});

test('源码里写到的每个 vnd.limcode 类型都有归类，不会落进“其它”；归类表里也没有源码已不用的类型', () => {
  const effectSource = require('node:fs').readFileSync(path.resolve('backend/reliableKernel/effectControlPlane.ts'), 'utf8');
  const effectUnion = /export type PhaseDEffectKind =([^;]+);/.exec(effectSource);
  assert.ok(effectUnion, 'effectControlPlane.ts 里找不到 PhaseDEffectKind');
  const effectKinds = [...effectUnion[1].matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1]);
  assert.ok(effectKinds.length >= 8, `Effect 种类太少：${effectKinds.join(', ')}`);
  /** How each template placeholder expands; a new placeholder must be taught here first. */
  const placeholders = { effectKind: effectKinds };

  // The classification table itself is not a writer of these types.
  const classifier = path.resolve('backend/reliableKernel/runtimeContentUsage.ts');
  const found = new Map();
  for (const file of ['backend', 'shared', 'vscode'].flatMap((directory) => sourceFiles(path.resolve(directory)))) {
    if (file === classifier) continue;
    const text = require('node:fs').readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:application|text)\/vnd\.limcode\.[^'"`\s)\]]*/g)) {
      const literal = match[0];
      if (literal.endsWith('.') || literal.endsWith('*')) continue;
      let expanded = [literal];
      for (const [placeholder, rawName] of literal.matchAll(/\$\{([^}]*)\}/g)) {
        const name = rawName.trim();
        assert.ok(Object.prototype.hasOwnProperty.call(placeholders, name),
          `${path.relative(process.cwd(), file)}：类型模板 ${literal} 的占位符 ${placeholder} 没有展开规则`);
        expanded = expanded.flatMap((value) => placeholders[name].map((kind) => value.replace(placeholder, kind)));
      }
      for (const type of expanded) {
        assert.ok(!type.includes('${'), `${literal} 没有完全展开`);
        const files = found.get(type) ?? new Set();
        files.add(path.relative(process.cwd(), file));
        found.set(type, files);
      }
    }
  }
  assert.ok(found.has(MESSAGE) && found.size >= 45, `扫描到的类型太少（${found.size}），扫描范围可能不对`);
  for (const [type, files] of found) {
    const kind = usage.classifyRuntimeContentType(type);
    assert.notEqual(kind.category, 'other', `${type} 没有归类（出现在 ${[...files].join(', ')}）`);
    assert.ok(kind.label && kind.label !== '未知类型', `${type} 没有中文名`);
  }
  for (const type of usage.KNOWN_RUNTIME_CONTENT_TYPES.filter((entry) => entry.includes('/vnd.limcode.'))) {
    assert.ok(found.has(type), `归类表里的 ${type} 在源码中已经没有写入方`);
  }
  // Unknown Runtime types stay visible as themselves; foreign media types are attachments.
  assert.deepEqual(usage.classifyRuntimeContentType('application/vnd.limcode.future-kind+json'), { category: 'other', label: '未知类型' });
  assert.deepEqual(usage.classifyRuntimeContentType('application/vnd.limcode.effect-teleport+json'), { category: 'other', label: '未知类型' });
  assert.deepEqual(usage.classifyRuntimeContentType('not a media type'), { category: 'other', label: '未知类型' });
  assert.deepEqual(usage.classifyRuntimeContentType('constructor'), { category: 'other', label: '未知类型' });
  assert.deepEqual(usage.classifyRuntimeContentType('Image/PNG'), { category: 'attachment', label: '图片' });
  assert.deepEqual(usage.classifyRuntimeContentType('application/zip'), { category: 'attachment', label: '文件' });
  assert.deepEqual(usage.classifyRuntimeContentType('text/plain; charset=utf-8'), { category: 'sharedText', label: '纯文本' });
  assert.deepEqual(usage.classifyRuntimeContentType('application/octet-stream'), { category: 'processOutput', label: '进程原始输出等二进制' });
});

test('合成数据：每种类型的记录数、字节数与最大值准确，同一正文挂在两种类型下两边都计入', async (t) => {
  const { root, database, store } = await openRuntime(t, 'figures');
  const shared = 'S'.repeat(700);
  const records = [
    [MESSAGE, 'a'.repeat(100)], [MESSAGE, 'b'.repeat(250)], [MESSAGE, shared],
    [TOOL_RESULT, shared], [TOOL_RESULT, 'c'.repeat(40)],
    ['image/png', 'p'.repeat(300)],
    ['application/vnd.limcode.effect-file_mutation-receipt+json', 'r'.repeat(60)],
    ['application/vnd.limcode.effect-process_start+json', 'q'.repeat(30)],
    ['application/vnd.limcode.future-kind+json', 'u'.repeat(10)],
    ['text/plain; charset=utf-8', 't'.repeat(20)],
    ['text/plain', 's'.repeat(5)],
    ['application/octet-stream', 'o'.repeat(9)],
    ['text/markdown', '']
  ];
  const stored = [];
  for (const [type, text] of records) stored.push(await store.ingest(database, text, type));
  assert.equal(stored[2].sha256, stored[3].sha256, '同一正文在两种类型下是同一个 sha256');
  assert.notEqual(stored[2].id, stored[3].id, '两种类型各有一条 ContentObject');

  const expected = new Map();
  for (const [type, text] of records) {
    const bytes = Buffer.byteLength(text);
    const current = expected.get(type) ?? { contentType: type, count: 0, bytes: 0, maxBytes: 0 };
    expected.set(type, { contentType: type, count: current.count + 1, bytes: current.bytes + bytes, maxBytes: Math.max(current.maxBytes, bytes) });
  }
  const expectedRows = [...expected.values()]
    .map((row) => ({ contentType: row.contentType, count: String(row.count), bytes: String(row.bytes), maxBytes: String(row.maxBytes) }))
    .sort((left, right) => (left.contentType < right.contentType ? -1 : 1));
  const rows = await database.contentUsage();
  assert.deepEqual([...rows].sort((left, right) => (left.contentType < right.contentType ? -1 : 1)), expectedRows);

  // Shared bytes count once per type, but this small-body fixture has one packed row per digest.
  const recordBytes = records.reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0);
  const casFiles = (await listFiles(root.binding.paths.casRootPath)).filter((file) => file.includes(`${path.sep}sha256${path.sep}`));
  assert.equal(casFiles.length, 0, 'all fixture bodies fit the packed tier');
  const packed = new NativeDatabase(path.join(root.binding.paths.casRootPath, PACKED_CAS_FILE), { readonly: true, fileMustExist: true });
  try {
    const physical = packed.prepare('SELECT COUNT(*) AS count, SUM(length(body)) AS bytes FROM cas_body').get();
    assert.equal(physical.count, records.length - 1);
    assert.equal(physical.bytes, recordBytes - 700);
  } finally { packed.close(); }

  const report = usage.summarizeRuntimeContentUsage(rows);
  assert.equal(report.countedBy, 'content-object-record');
  assert.deepEqual(report.total, { count: String(records.length), bytes: String(recordBytes), maxBytes: '700' });
  const native = new NativeDatabase(root.binding.paths.databasePath, { readonly: true });
  t.after(() => native.close());
  assert.equal(String(native.prepare('SELECT COUNT(*) AS count FROM content_object').get().count), report.total.count);
  assert.deepEqual(report.categories.map((category) => category.key),
    ['message', 'toolModelResult', 'attachment', 'effectReceipt', 'effectRequest', 'sharedText', 'other', 'processOutput']);
  const byKey = new Map(report.categories.map((category) => [category.key, category]));
  assert.deepEqual(figures(byKey.get('message')), { count: '3', bytes: '1050', maxBytes: '700' });
  assert.deepEqual(figures(byKey.get('toolModelResult')), { count: '2', bytes: '740', maxBytes: '700' });
  assert.deepEqual(figures(byKey.get('sharedText')), { count: '3', bytes: '25', maxBytes: '20' });
  assert.deepEqual(byKey.get('sharedText').types.map((type) => type.contentType), ['text/plain; charset=utf-8', 'text/plain', 'text/markdown']);
  assert.deepEqual(byKey.get('other').types, [{
    contentType: 'application/vnd.limcode.future-kind+json', label: '未知类型', count: '1', bytes: '10', maxBytes: '10'
  }]);

  assert.deepEqual(usage.formatRuntimeContentUsage(report, bytesLabel), [
    '按类型统计的正文（只统计当前库，按数据库记录）：',
    '对话消息：3 条记录，合计 1050 B，最大单个 700 B',
    '  消息正文（message+json）：3 条，1050 B，最大 700 B',
    '工具结果：2 条记录，合计 740 B，最大单个 700 B',
    '  工具结果（tool-model-result+json）：2 条，740 B，最大 700 B',
    '附件：1 条记录，合计 300 B，最大单个 300 B',
    '  图片（image/png）：1 条，300 B，最大 300 B',
    '外部效果回执：1 条记录，合计 60 B，最大单个 60 B',
    '  文件修改回执（effect-file_mutation-receipt+json）：1 条，60 B，最大 60 B',
    '外部效果请求：1 条记录，合计 30 B，最大单个 30 B',
    '  启动进程请求（effect-process_start+json）：1 条，30 B，最大 30 B',
    '通用文本（多处共用）：3 条记录，合计 25 B，最大单个 20 B',
    '  注：用户输入、子 Agent 提示与回答、压缩标题与摘要、编辑前后的文件快照、协作看板和文本附件都可能使用这些类型。',
    '  纯文本（text/plain; charset=utf-8）：1 条，20 B，最大 20 B',
    '  纯文本（text/plain）：1 条，5 B，最大 5 B',
    '  Markdown 文本（text/markdown）：1 条，0 B，最大 0 B',
    '其它：1 条记录，合计 10 B，最大单个 10 B',
    '  注：未归类的类型按原样列出。',
    '  未知类型（application/vnd.limcode.future-kind+json）：1 条，10 B，最大 10 B',
    '进程原始输出：1 条记录，合计 9 B，最大单个 9 B',
    '  注：application/octet-stream 也用于写入或删除前的原文件快照，以及未识别格式的附件。',
    '  进程原始输出等二进制（application/octet-stream）：1 条，9 B，最大 9 B',
    `各类合计：${records.length} 条记录，${recordBytes} B`,
    NOTE_DELETION,
    NOTE_PER_RECORD
  ]);
});

test('统计查询不访问 CAS 目录：目录权限改成 000 时照样返回', async (t) => {
  if (process.platform === 'win32') { t.skip('Windows 没有 POSIX 目录权限'); return; }
  const { root, database, store } = await openRuntime(t, 'cas');
  const metadata = await store.ingest(database, 'hello content usage', MESSAGE);
  const casRoot = root.binding.paths.casRootPath;
  const mode = (await fs.stat(casRoot)).mode & 0o777;
  await fs.chmod(casRoot, 0o000);
  try {
    const denied = await fs.readFile(path.join(casRoot, ...metadata.storage_key.split('/'))).then(() => false, (error) => error.code === 'EACCES');
    if (!denied) { t.skip('当前用户不受目录权限限制（例如 root），无法验证'); return; }
    assert.deepEqual(await database.contentUsage(), [{ contentType: MESSAGE, count: '1', bytes: '19', maxBytes: '19' }]);
  } finally {
    await fs.chmod(casRoot, mode);
  }
});

test('统计业务只用 worker reader，RootBinding 检查保留且另一连接持写锁时照常返回', async (t) => {
  const { root, database, store } = await openRuntime(t, 'reader');
  await store.ingest(database, 'reader connection', MESSAGE);
  const counters = (cache) => ({ prepares: cache.prepares, hits: cache.hits, misses: cache.misses, uncached: cache.uncached });
  const before = (await database.inspect()).statementCache;
  await database.contentUsage();
  const first = (await database.inspect()).statementCache;
  await database.contentUsage();
  const second = (await database.inspect()).statementCache;
  // inspect itself still checks the live RootBinding on the writer; contentUsage only checks it
  // on the reader. Exact hit deltas keep every domain query off the writer connection.
  assert.deepEqual(counters(first.writer), { ...counters(before.writer), hits: before.writer.hits + 1 });
  assert.deepEqual(counters(second.writer), { ...counters(before.writer), hits: before.writer.hits + 2 });
  assert.equal(first.reader.misses - before.reader.misses, 1, '第一次在 reader 上准备语句');
  assert.equal(second.reader.hits - first.reader.hits, 2, '统计与 RootBinding 准入查询都复用 reader 缓存');

  const other = new NativeDatabase(root.binding.paths.databasePath);
  t.after(() => { if (other.open) other.close(); });
  other.exec('BEGIN IMMEDIATE');
  try {
    const started = performance.now();
    assert.deepEqual(await database.contentUsage(), [{ contentType: MESSAGE, count: '1', bytes: '17', maxBytes: '17' }]);
    assert.ok(performance.now() - started < 2_000, '不等写锁');
  } finally {
    other.exec('ROLLBACK');
    other.close();
  }
});

test('开发诊断命令打开的 JSON 带上同一份按类型统计，数据库诊断里的大整数写成十进制文本', async (t) => {
  const { database, store } = await openRuntime(t, 'inspect');
  await store.ingest(database, 'inspect reliability', MESSAGE);
  await store.ingest(database, 'png bytes', 'image/png');
  const { VscodeReliableKernelApplicationFacade: Facade } = require(path.join(
    compiledRoot, 'backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js'
  ));
  const { registerCommands } = require(path.join(compiledRoot, 'vscode/commands/registerCommands.js'));
  const { EXTENSION_COMMAND_IDS } = require(path.join(compiledRoot, 'shared/extensionIdentity.js'));
  const facade = Object.assign(Object.create(Facade.prototype), {
    disposed: false,
    productClosed: false,
    product: {
      application: { database },
      recoveryState: () => ({ state: 'fixture' }),
      diagnostics: { inspect: async () => ({ events: [], spans: [] }) }
    }
  });
  registerCommands({ subscriptions: [], extensionMode: vscode.ExtensionMode.Development }, { wait: async () => facade, current: () => facade });
  ui.documents.length = 0;
  // The Data root scope (no conversation), exactly as the inspector's quick pick passes it.
  await ui.registered.get(EXTENSION_COMMAND_IDS.inspectReliability)({ conversationId: '' });
  assert.equal(ui.documents.length, 1);
  const snapshot = JSON.parse(ui.documents[0]);
  assert.deepEqual(snapshot.contentUsage, usage.summarizeRuntimeContentUsage(await database.contentUsage()));
  assert.deepEqual(snapshot.contentUsage.categories.map((category) => [category.key, category.count, category.bytes]),
    [['message', '1', '19'], ['attachment', '1', '9']]);
  assert.equal(snapshot.database.foreignKeys, '1');
  assert.equal(snapshot.database.readerBusyTimeoutMs, '5000');
});

test('盲审 #5 开发诊断：按类型统计正文失败时只在 contentUsage 处写明，整份诊断照常打开', async (t) => {
  const { database } = await openRuntime(t, 'inspect-failing');
  const { VscodeReliableKernelApplicationFacade: Facade } = require(path.join(
    compiledRoot, 'backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js'
  ));
  const { registerCommands } = require(path.join(compiledRoot, 'vscode/commands/registerCommands.js'));
  const { EXTENSION_COMMAND_IDS } = require(path.join(compiledRoot, 'shared/extensionIdentity.js'));
  // The same open database, except that its per-type aggregate fails.
  database.contentUsage = async () => { throw new Error('Runtime reader worker exited (code 1).'); };
  t.after(() => { delete database.contentUsage; });
  const facade = Object.assign(Object.create(Facade.prototype), {
    disposed: false,
    productClosed: false,
    product: {
      application: { database },
      recoveryState: () => ({ state: 'fixture' }),
      diagnostics: { inspect: async () => ({ events: [], spans: [] }) }
    }
  });
  registerCommands({ subscriptions: [], extensionMode: vscode.ExtensionMode.Development }, { wait: async () => facade, current: () => facade });
  ui.documents.length = 0;
  await ui.registered.get(EXTENSION_COMMAND_IDS.inspectReliability)({ conversationId: '' });
  assert.equal(ui.documents.length, 1, '诊断照常打开');
  const snapshot = JSON.parse(ui.documents[0]);
  assert.deepEqual(snapshot.contentUsage, { unavailable: '按类型统计正文失败', detail: 'Runtime reader worker exited (code 1).' });
  assert.equal(snapshot.database.foreignKeys, '1', '其余诊断都在');
  assert.deepEqual(snapshot.recovery, { state: 'fixture' });
});

test('冻结期间（本窗口正在迁移数据目录等）开发诊断与查看存储占用都是只读，照常可用；写命令被拒绝', async (t) => {
  const { database, store } = await openRuntime(t, 'frozen');
  await store.ingest(database, 'frozen message', MESSAGE);
  const { VscodeReliableKernelApplicationFacade: Facade } = require(path.join(
    compiledRoot, 'backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js'
  ));
  const { RuntimeWriteGate } = require(path.join(compiledRoot, 'backend/application/reliableKernel/runtimeWriteGate.js'));
  const { registerCommands } = require(path.join(compiledRoot, 'vscode/commands/registerCommands.js'));
  const { EXTENSION_COMMAND_IDS } = require(path.join(compiledRoot, 'shared/extensionIdentity.js'));
  const writeGate = new RuntimeWriteGate();
  t.after(writeGate.freeze('迁移数据目录', []));
  const facade = Object.assign(Object.create(Facade.prototype), {
    disposed: false,
    productClosed: false,
    writeGate,
    product: {
      application: { database },
      recoveryState: () => ({ state: 'fixture' }),
      diagnostics: { inspect: async () => ({ events: [], spans: [] }) }
    }
  });
  // The freeze is real: a write command of this window is refused.
  await assert.rejects(facade.renameConversationTitle('conversation', '新名字'), { message: '正在迁移数据目录，完成后再操作。' });
  registerCommands({ subscriptions: [], extensionMode: vscode.ExtensionMode.Development }, { wait: async () => facade, current: () => facade });
  ui.documents.length = 0;
  await ui.registered.get(EXTENSION_COMMAND_IDS.inspectReliability)({ conversationId: '' });
  assert.equal(ui.documents.length, 1, '开发诊断照常打开');
  assert.deepEqual(JSON.parse(ui.documents[0]).contentUsage, usage.summarizeRuntimeContentUsage(await database.contentUsage()));
  const management = require(path.join(compiledRoot, 'vscode/commands/runtimeDataSetManagement.js'));
  const current = currentCandidate(database.binding);
  storageFixture.candidates = [current];
  ui.documents.length = 0;
  await management.showRuntimeStorage({ subscriptions: [] }, current, { current: () => facade });
  assert.equal(ui.documents.length, 1, '查看存储占用照常打开');
  assert.ok(ui.documents[0].includes('按类型统计的正文（只统计当前库，按数据库记录）：'));
});

test('查看存储占用：当前库在目录统计之后按分类列出正文，并附两条说明', async (t) => {
  const { root, database, store } = await openRuntime(t, 'view');
  await store.ingest(database, 'view message', MESSAGE);
  await store.ingest(database, 'view tool result', TOOL_RESULT);
  const management = require(path.join(compiledRoot, 'vscode/commands/runtimeDataSetManagement.js'));
  const current = currentCandidate(database.binding);
  const other = { ...currentCandidate(database.binding), id: 'workspace:old', source: 'workspace', selected: false,
    runtimeDataRootPath: '/fixture/old/.limcode-runtime/active', dataSetId: 'old', rootInstanceId: 'old-instance' };
  storageFixture.candidates = [current, other];
  let usageCalls = 0;
  const openRuntimeOf = (target) => ({
    product: { application: { database: { binding: target.binding, async contentUsage() { usageCalls += 1; return target.contentUsage(); } } } }
  });
  const startupWith = (application) => ({ current: () => application });
  const show = async (candidate, startup) => {
    ui.documents.length = 0;
    await management.showRuntimeStorage({ subscriptions: [] }, candidate, startup);
    assert.equal(ui.documents.length, 1);
    return ui.documents[0];
  };

  // 历史与存储管理 → 查看存储占用 → 当前库.
  ui.documents.length = 0;
  ui.picks.push((items) => items.find((item) => item.action === 'storage'), (items) => items.find((item) => item.candidate?.id === 'default'));
  await management.manageRuntimeDataSets({ subscriptions: [] }, startupWith(openRuntimeOf(database)));
  assert.equal(ui.documents.length, 1);
  const lines = ui.documents[0].split('\n');
  const directoryNote = lines.indexOf('这里统计文件逻辑大小，运行中的库可能继续变化。历史正文不是可随意清除的缓存；保留归档不会释放其磁盘占用。');
  assert.ok(lines.includes('SQLite 数据库：3 个文件，8 KiB'));
  assert.ok(directoryNote > 0);
  assert.deepEqual(lines.slice(directoryNote + 1), [
    '',
    '按类型统计的正文（只统计当前库，按数据库记录）：',
    '工具结果：1 条记录，合计 16 B，最大单个 16 B',
    '  工具结果（tool-model-result+json）：1 条，16 B，最大 16 B',
    '对话消息：1 条记录，合计 12 B，最大单个 12 B',
    '  消息正文（message+json）：1 条，12 B，最大 12 B',
    '各类合计：2 条记录，28 B',
    NOTE_DELETION,
    NOTE_PER_RECORD
  ]);
  assert.equal(usageCalls, 1);

  // Another library: no per-type statistics, and the open database is not asked.
  const otherView = await show(other, startupWith(openRuntimeOf(database)));
  assert.ok(otherView.includes('按类型统计正文只对当前库提供。'));
  assert.ok(!otherView.includes('按类型统计的正文（'));
  assert.equal(usageCalls, 1);

  // The runtime of this window has not opened the current library (not started, or another root).
  const unavailable = '按类型统计正文要经本窗口已打开的当前库读取；本窗口还没有打开它，暂时无法统计。';
  assert.ok((await show(current, startupWith(undefined))).includes(unavailable));
  assert.ok((await show(current, undefined)).includes(unavailable));
  const elsewhere = { binding: { ...database.binding, rootInstanceId: 'replaced-instance' }, contentUsage: () => database.contentUsage() };
  assert.ok((await show(current, startupWith(openRuntimeOf(elsewhere)))).includes(unavailable));
  const moved = { binding: { ...database.binding, paths: { ...database.binding.paths, dataRootPath: path.join(root.binding.paths.dataRootPath, 'copy') } },
    contentUsage: () => database.contentUsage() };
  assert.ok((await show(current, startupWith(openRuntimeOf(moved)))).includes(unavailable));
  assert.equal(usageCalls, 1);

  // A failed read is reported in place in words, its own text only in the log (盲审 #5); the directory statistics are still shown.
  const failing = { binding: database.binding, contentUsage: async () => { throw new Error('Runtime reader worker exited (code 1).'); } };
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
  let failedView;
  try {
    failedView = await show(current, startupWith(openRuntimeOf(failing)));
  } finally {
    console.warn = warn;
  }
  assert.ok(failedView.includes('SQLite 数据库：3 个文件，8 KiB'));
  assert.ok(failedView.endsWith('\n\n按类型统计正文失败（详细原因已写入日志），稍后再打开一次试试。'));
  assert.doesNotMatch(failedView, /worker exited/);
  assert.ok(warnings.some((line) => line.includes('Runtime reader worker exited (code 1).')), warnings.join('\n'));
});

test('开发命令的“磁盘占用”入口把窗口启动句柄交给存储视图', async () => {
  const { registerCommands } = require(path.join(compiledRoot, 'vscode/commands/registerCommands.js'));
  const { EXTENSION_COMMAND_IDS } = require(path.join(compiledRoot, 'shared/extensionIdentity.js'));
  const context = { subscriptions: [], extensionMode: vscode.ExtensionMode.Development };
  const application = { inspectReliability: async () => { throw new Error('这里只看磁盘占用'); } };
  const startup = { wait: async () => application, current: () => application };
  registerCommands(context, startup);
  storageViewCalls.length = 0;
  await ui.registered.get(EXTENSION_COMMAND_IDS.inspectReliability)({ conversationId: '__storage__' });
  assert.equal(storageViewCalls.length, 1);
  const [passedContext, candidate, passedStartup] = storageViewCalls[0];
  assert.equal(passedContext, context);
  assert.equal(candidate, undefined);
  assert.equal(passedStartup, startup);
});
