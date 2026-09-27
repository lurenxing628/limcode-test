import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';

// The Extension Host process also runs the Runtime database worker. SQLite's unix VFS keeps POSIX
// fcntl locks on the database and its -shm, and POSIX drops all of a process's locks on a file when
// the process closes ANY descriptor of it. A file tool that reads limcode.sqlite-shm in-process
// therefore releases the worker's write lock, read marks and DMS lock. Every in-process file entry
// point must refuse those files; shell commands (child processes) stay the way to inspect them.

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
class Uri {
  constructor(value) { this.scheme = 'file'; this.fsPath = path.resolve(value); this.path = this.fsPath; }
  static file(value) { return new Uri(value); }
  static parse(value) { return new Uri(value.replace(/^file:\/\//, '')); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  with(change) { return new Uri(change.path ?? this.fsPath); }
  toString() { return `file://${this.path}`; }
}
// workspace.fs serves file: URIs inside the Extension Host too, so the mock goes through node:fs.
const vscode = { Uri, FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 }, workspace: { workspaceFolders: [], fs: {
  createDirectory: (uri) => fs.mkdir(uri.fsPath, { recursive: true }),
  readFile: (uri) => fs.readFile(uri.fsPath),
  writeFile: (uri, bytes) => fs.writeFile(uri.fsPath, bytes),
  delete: (uri) => fs.rm(uri.fsPath, { recursive: true, force: true }),
  async stat(uri) { const s = await fs.stat(uri.fsPath); return { type: s.isDirectory() ? 2 : 1, size: s.size, ctime: s.ctimeMs, mtime: s.mtimeMs }; }
} } };
Module._load = function(request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain); };
after(() => { Module._load = originalLoad; });

const dist = (file) => require(path.join(process.cwd(), 'dist/extension', file));
const kernel = dist('backend/reliableKernel/index.js');
const { VscodeReliableToolHost } = dist('backend/application/reliableKernel/VscodeReliableToolHost.js');
const { LocalFileToolPlanner } = dist('backend/reliableKernel/localFileToolPlanner.js');
const { commandDeclarationCapability } = dist('backend/reliableKernel/builtinToolCatalog.js');
const { createBuiltinToolDefinitions } = dist('backend/world/modules/tools/definitions/index.js');
const { readFileTool } = dist('backend/world/modules/tools/definitions/readFile/index.js');
const { createVsCodeFsCapability } = dist('backend/capabilities/vscodeFs.js');
const { createWorkEnvironmentRuntimeCapability } = dist('backend/capabilities/workEnvironmentTransfer.js');
const Database = require('better-sqlite3');

const REFUSED = /拒绝在 LimCode 扩展宿主进程内访问 SQLite 数据库文件/;
const posixOnly = process.platform === 'win32' ? 'Windows uses LockFileEx, which is not released by closing another handle' : false;
const hasPython = childProcess.spawnSync('python3', ['-c', 'import fcntl'], { stdio: 'ignore' }).status === 0;

/** Whether another process could take the DMS byte exclusively, i.e. this process lost its shared lock. */
function dmsLockProbe(shmPath) {
  if (!hasPython || process.platform === 'win32') return 'refused';
  return childProcess.spawnSync('python3', ['-c', `
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR)
try:
    fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB, 1, 128)
    print('acquired')
except OSError:
    print('refused')
`, shmPath], { encoding: 'utf8' }).stdout.trim();
}

/**
 * Records every in-process call that opens a file by path (node:fs and node:fs/promises, callback,
 * sync, promise and stream forms). Compiled modules reach node:fs through live getters, so patching
 * the module objects covers them.
 */
function installOpenRecorder() {
  const opened = [];
  const restore = [];
  const pathOf = (value) => {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString();
    if (value instanceof URL) return value.pathname;
    return undefined;
  };
  const wrap = (owner, name, argumentIndexes = [0]) => {
    const original = owner[name];
    if (typeof original !== 'function') return;
    owner[name] = function(...args) {
      for (const index of argumentIndexes) {
        const target = pathOf(args[index]);
        if (target !== undefined) opened.push({ api: name, path: path.resolve(target) });
      }
      return original.apply(this, args);
    };
    restore.push(() => { owner[name] = original; });
  };
  for (const name of ['open', 'readFile', 'writeFile', 'appendFile', 'truncate']) wrap(nodeFs.promises, name);
  for (const name of ['copyFile', 'cp']) wrap(nodeFs.promises, name, [0, 1]);
  for (const name of ['open', 'openSync', 'readFile', 'readFileSync', 'writeFile', 'writeFileSync', 'appendFile',
    'appendFileSync', 'truncate', 'truncateSync', 'createReadStream', 'createWriteStream', 'openAsBlob']) wrap(nodeFs, name);
  for (const name of ['copyFile', 'copyFileSync', 'cp', 'cpSync']) wrap(nodeFs, name, [0, 1]);
  return { opened, uninstall() { for (const undo of restore.reverse()) undo(); } };
}

/** The recorded opens that reached `files` by name, real path or inode. */
function opensOf(recorder, files, from = 0) {
  const identities = files.map((file) => {
    try { return nodeFs.statSync(file, { bigint: true }); } catch { return undefined; }
  }).filter(Boolean);
  return recorder.opened.slice(from).filter((entry) => {
    let real = entry.path;
    try { real = nodeFs.realpathSync.native(entry.path); } catch { /* missing */ }
    if ([entry.path, real].some((candidate) => /limcode\.sqlite-shm$/i.test(candidate))) return true;
    try {
      const stat = nodeFs.statSync(entry.path, { bigint: true });
      return identities.some((identity) => identity.dev === stat.dev && identity.ino === stat.ino);
    } catch {
      return false;
    }
  });
}

function localEnvironment(rootPath, id = 'work-environment:sqlite-guard') {
  return {
    id, kind: 'localFolder', source: 'workspaceFolder', name: path.basename(rootPath), uri: `file://${rootPath}`, rootPath,
    displayPath: rootPath, index: 0, available: true, createdAt: 1, updatedAt: 1
  };
}

test('read 直接读取 limcode.sqlite-shm 被拒绝，并指向子进程 sqlite3 只读访问；本进程的 SQLite 锁保持不变', { skip: posixOnly }, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-read-shm-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'limcode.sqlite');
  const database = new Database(file);
  t.after(() => database.close());
  database.pragma('journal_mode = WAL');
  database.exec('CREATE TABLE t(v TEXT); INSERT INTO t(v) VALUES (\'seed\')');
  await fs.symlink(`${file}-shm`, path.join(root, 'alias.txt'));
  await fs.writeFile(path.join(root, 'notes.txt'), 'hello\n');
  const environment = localEnvironment(root);
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(root) }];
  const recorder = installOpenRecorder();
  try {
    assert.equal(dmsLockProbe(`${file}-shm`), 'refused', 'baseline: this process holds the DMS lock');
    const context = { workEnvironment: environment, accessibleWorkEnvironments: [environment], config: {} };
    const deps = { fs: createVsCodeFsCapability() };
    for (const args of [
      { path: `${file}-shm` },
      { path: 'limcode.sqlite-shm' },
      { path: 'alias.txt' },
      { items: [{ path: 'notes.txt' }, { path: `${file}-shm` }] }
    ]) {
      await assert.rejects(readFileTool.execute(args, deps, context), (error) => {
        assert.match(error.message, REFUSED, JSON.stringify(args));
        assert.match(error.message, /-shm 伴随文件/);
        assert.match(error.message, new RegExp(`sqlite3 -readonly "${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
        return true;
      });
    }
    assert.deepEqual(opensOf(recorder, [`${file}-shm`]), [], 'read must not open the -shm in this process');
    assert.equal(dmsLockProbe(`${file}-shm`), 'refused', 'read must not release the DMS lock');
    // An ordinary file beside the database still reads normally.
    assert.match((await readFileTool.execute({ path: 'notes.txt' }, deps, context)).output.content, /hello/);
  } finally {
    recorder.uninstall();
    vscode.workspace.workspaceFolders = [];
  }
});

test('一个 Runtime 的完整生命周期里，任何文件工具和附件入口都不在进程内打开 limcode.sqlite-shm', { skip: posixOnly }, async (t) => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-shm-lifecycle-')));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const project = path.join(parent, 'project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'source.txt'), 'transfer me\n');
  const environment = localEnvironment(parent);
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(parent) }];
  t.after(() => { vscode.workspace.workspaceFolders = []; });

  const recorder = installOpenRecorder();
  t.after(() => recorder.uninstall());
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);

  const command = commandDeclarationCapability();
  const definitions = createBuiltinToolDefinitions({ command })
    .filter((definition) => ['read', 'write', 'edit', 'delete', 'transfer'].includes(definition.declaration.name));
  const host = Object.create(VscodeReliableToolHost.prototype);
  Object.assign(host, {
    fs: createVsCodeFsCapability(),
    workEnvironment: createWorkEnvironmentRuntimeCapability(),
    commandDeclaration: command,
    skills: { list: () => [], lookup: () => ({ status: 'missing' }), async refresh() {} },
    options: {},
    configuration: {
      async workEnvironments() { return [environment]; },
      async loadGlobalSettings(section) { return { section, settings: { maxStoredInlineFileMb: 25 }, filePath: `settings/${section}.json` }; }
    },
    definitions: () => definitions,
    async cancelTurnWaits() {},
    async dispose() {}
  });
  host.filePlanner = new LocalFileToolPlanner((inputPath, authorityInput) => host.resolveFilePath(inputPath, authorityInput));

  const app = await kernel.ReliableKernelApplication.open(authority, {
    authorityCompiler: { async compile() { throw new Error('No live authority compilation in this fixture.'); } },
    resolveWorkEnvironment: async (id) => id === environment.id ? { id, rootPath: parent } : undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('Unexpected MCP call.'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: false, planReviewAllowed: false }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'settings/attachments.json' }; } },
    providers: { resolve() { throw new Error('No network Provider in this fixture.'); } },
    createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) =>
      new kernel.ReliableToolDispatcher({ database, contentStore, effects: runtime.effects, files, fileMutations, processes, mcp, interactions, host })
  });
  let closed = false;
  t.after(async () => { if (!closed) await app.close(); });

  const databasePath = app.database.binding.paths.databasePath;
  const shm = `${databasePath}-shm`;
  const liveFiles = [databasePath, `${databasePath}-wal`, shm];
  await fs.access(shm);
  // Other names for the live -shm: a symbolic link, an extension the read tool treats as an image,
  // and a hard link that no name or real-path rule can recognize.
  await fs.symlink(shm, path.join(project, 'alias.txt'));
  await fs.symlink(shm, path.join(project, 'alias.png'));
  await fs.link(shm, path.join(project, 'hard-link.bin'));
  assert.equal(dmsLockProbe(shm), 'refused', 'baseline: the Runtime worker holds the DMS lock');

  const conversationId = 'conversation-sqlite-guard';
  const turnId = 'turn-sqlite-guard';
  const now = new Date().toISOString();
  const frozen = await app.contentStore.prepare(app.database, JSON.stringify({
    conversationId,
    model: { enableMultimodalTools: true },
    planReviewPolicy: { mode: 'optional' },
    toolPolicy: {
      id: 'sqlite-guard-policy', preset: 'yolo',
      allowedTools: definitions.map((definition) => definition.declaration.name),
      toolConfigs: {}, sourceConfigs: {}
    },
    workEnvironmentPolicy: { enabled: true, allowedWorkEnvironmentIds: [environment.id], defaultWorkEnvironmentId: environment.id }
  }), 'application/json');
  await app.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: conversationId, title: 'SQLite guard', status: 'active', created_at: now, updated_at: now }),
    kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({ id: turnId, conversation_id: conversationId, status: 'active', created_at: now, updated_at: now, terminal_at: null }),
    kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
      id: 'lease-sqlite-guard', conversation_id: conversationId, turn_id: turnId, owner_id: 'sqlite-guard-test',
      host_boot_id: app.database.hostBootId, generation: 1n, acquired_at: now, expires_at: new Date(Date.now() + 600_000).toISOString()
    }),
    ...kernel.preparedContentSteps([frozen], 'sqlite_guard_authority'),
    kernel.DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').insert({ id: 'authority-sqlite-guard', turn_id: turnId, content_object_id: frozen.metadata.id, created_at: now })
  ]);

  const dispatcher = app.toolDispatcher;
  let sequence = 0;
  const callTool = async (toolName, args) => {
    const toolCallId = `sqlite-guard-call-${++sequence}`;
    await app.runtime.effects.createToolCall({ source: { kind: 'internal', key: `create:${toolCallId}` }, toolCallId, turnId, toolName, arguments: args });
    // dispatchBatch is the production path: a capability error settles as the model-visible failed result.
    const [result] = await dispatcher.dispatchBatch([{ turnId, modelRequestId: 'sqlite-guard-model', toolCallId, toolName, arguments: args }]);
    const [revision] = (await app.database.snapshot([kernel.DOMAIN_REPOSITORIES.domain('MessageRevision').get(result.messageRevisionId)])).snapshot;
    const [content] = (await app.database.snapshot([kernel.DOMAIN_REPOSITORIES.domain('ContentObject').get(revision.content_object_id)])).snapshot;
    return { status: result.status, modelText: (await app.contentStore.read(content)).toString('utf8') };
  };
  const toolWindow = recorder.opened.length;
  const shmRelative = path.relative(parent, shm);
  const calls = [
    ['read', { path: shm }],
    ['read', { path: shmRelative }],
    ['read', { path: path.join(project, 'alias.txt') }],
    ['read', { path: path.join(project, 'alias.png'), mode: 'attachment' }],
    ['read', { path: path.join(project, 'hard-link.bin') }],
    ['read', { items: [{ path: shm }, { path: path.join(project, 'source.txt') }] }],
    ['write', { path: shmRelative, content: 'overwritten' }],
    ['edit', { path: shmRelative, hunks: [{ oldContent: 'x', newContent: 'y' }] }],
    ['delete', { paths: [shmRelative] }],
    ['delete', { paths: [path.relative(parent, path.join(project, 'hard-link.bin'))] }],
    ['transfer', { transfers: [{ fromEnvironment: 'current', fromPath: shm, toEnvironment: environment.id, toPath: path.join(project, 'copied.bin') }] }],
    ['transfer', { transfers: [{ fromEnvironment: 'current', fromPath: path.join(project, 'source.txt'), toEnvironment: environment.id, toPath: shm, overwrite: true }] }],
    // Deleting a directory tree above the live database would unlink its -shm under the worker.
    ['delete', { paths: [path.relative(parent, path.dirname(databasePath))] }]
  ];
  for (const [toolName, args] of calls) {
    const { status, modelText } = await callTool(toolName, args);
    assert.equal(status, 'failed', `${toolName} ${JSON.stringify(args)} must fail: ${modelText}`);
    assert.match(modelText, REFUSED, `${toolName} ${JSON.stringify(args)} must tell the model why: ${modelText}`);
    assert.match(modelText, /sqlite3 -readonly/, `${toolName} must point to a child-process sqlite3`);
  }

  // Ordinary files in the same work environment keep working through the same tools.
  const normalRead = await callTool('read', { path: path.join(project, 'source.txt') });
  assert.equal(normalRead.status, 'succeeded', normalRead.modelText);
  assert.match(normalRead.modelText, /transfer me/);
  const normalTransfer = await callTool('transfer', { transfers: [{
    fromEnvironment: 'current', fromPath: path.join(project, 'source.txt'), toEnvironment: environment.id, toPath: path.join(project, 'copy.txt')
  }] });
  assert.equal(normalTransfer.status, 'succeeded', normalTransfer.modelText);
  assert.equal(await fs.readFile(path.join(project, 'copy.txt'), 'utf8'), 'transfer me\n');

  // Attachments reach local paths through the same process: user drops and provider references.
  await assert.rejects(app.attachments.resolveProviderInlineData({ sourcePath: shm }), REFUSED);
  await assert.rejects(app.attachments.prepareMessageContent({
    contentType: 'application/vnd.limcode.message+json',
    content: JSON.stringify({ role: 'user', parts: [{ inlineData: { sourcePath: path.join(project, 'hard-link.bin'), storage: 'localPath', mimeType: 'application/octet-stream' } }] })
  }), REFUSED);

  assert.deepEqual(opensOf(recorder, liveFiles, toolWindow), [], 'no tool or attachment call may open the live database files');
  assert.equal(dmsLockProbe(shm), 'refused', 'the Runtime worker must still hold the DMS lock');
  await fs.access(shm);
  assert.equal(await fs.readFile(path.join(project, 'source.txt'), 'utf8'), 'transfer me\n');

  // The Runtime keeps working and closes cleanly after all of it.
  await app.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { title: 'SQLite guard still writable', updated_at: new Date().toISOString() })
  ]);
  const [conversation] = (await app.database.snapshot([kernel.DOMAIN_REPOSITORIES.domain('Conversation').get(conversationId)])).snapshot;
  assert.equal(conversation.title, 'SQLite guard still writable');
  await app.close();
  closed = true;
  assert.deepEqual(opensOf(recorder, liveFiles.filter((file) => file !== databasePath)), [],
    'nothing in the whole Runtime lifecycle may open limcode.sqlite-shm or -wal in this process');
  recorder.uninstall();
  const reopened = new Database(databasePath, { readonly: true });
  try {
    assert.equal(reopened.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    reopened.close();
  }
});

test('SQLite 文件判定按名称、真实路径、同目录伴随文件和进程内 inode 生效，普通文件不受影响', async (t) => {
  const {
    registerInProcessSqliteDatabase,
    sqliteDatabaseFileRefusal
  } = dist('backend/capabilities/filesystem/sqliteDatabaseFileGuard.js');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-sqlite-guard-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const touch = async (relative, content = 'x') => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    return file;
  };
  const refused = async (target, options) => (await sqliteDatabaseFileRefusal(target, options))?.reason;

  // LimCode's own database names, any case, existing or not, in any data set or backup.
  for (const name of [
    'workspace-scope/limcode.sqlite', 'workspace-scope/limcode.sqlite-wal', 'workspace-scope/LIMCODE.SQLITE-SHM',
    'merge-backups/20260926/limcode.sqlite-journal', 'merge-backups/20260926/limcode.sqlite.4242.tmp',
    'backups/limcode.epoch-3.sqlite', 'backups/limcode.epoch-3.sqlite-shm',
    // Private copies staged in a data set's control root while this process backs up or reads them.
    'control/merge-precopy-4242-0f1e2d3c.sqlite', 'control/merge-precopy-4242-0f1e2d3c.sqlite-journal',
    'control/relocation-count-4242-0f1e2d3c.sqlite', 'control/relocation-count-4242-0f1e2d3c.sqlite-wal',
    'control/copy-verify-0f1e2d3c.sqlite', 'control/COPY-VERIFY-0F1E2D3C.SQLITE-SHM'
  ]) {
    assert.ok(await refused(path.join(root, name)), name);
  }
  // Any SQLite sidecar whose database sits beside it, and a database that still has sidecars.
  await touch('other/app.db');
  await touch('other/app.db-wal');
  await touch('other/cache.DB');
  for (const name of ['other/app.db-wal', 'other/app.db-shm', 'other/app.db-journal', 'other/app.db', 'other/cache.DB-SHM']) {
    assert.ok(await refused(path.join(root, name)), name);
  }
  // Look-alikes stay readable: no database beside the sidecar name, or no sidecar beside the name.
  await touch('plain/notes-shm');
  await touch('plain/limcode.json');
  await touch('plain/report.sqlite');
  for (const name of ['plain/notes-shm', 'plain/limcode.json', 'plain/report.sqlite', 'plain/missing.txt',
    'plain/copy-verify.sqlite', 'plain/merge-precopy-notes.txt', 'plain/old-relocation-count-1.sqlite']) {
    assert.equal(await refused(path.join(root, name)), undefined, name);
  }
  // A link resolves to the file it names. Windows may refuse file symbolic links without privilege.
  const fileLinked = await fs.symlink(path.join(root, 'other/app.db-wal'), path.join(root, 'plain/innocent.txt')).then(
    () => true,
    (error) => { if (process.platform === 'win32' && error.code === 'EPERM') return false; throw error; }
  );
  if (fileLinked) assert.ok(await refused(path.join(root, 'plain/innocent.txt')));
  await fs.mkdir(path.join(root, 'workspace-scope'), { recursive: true });
  await fs.symlink(path.join(root, 'workspace-scope'), path.join(root, 'plain/scope-link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok(await refused(path.join(root, 'plain/scope-link/limcode.sqlite')));

  // Files of a database opened in this process are refused under any name reaching the same inode,
  // and a recursive operation on a directory above it is refused; only while it is registered.
  const live = await touch('live/data/store.bin');
  await fs.link(live, path.join(root, 'plain/hard.bin'));
  assert.equal(await refused(path.join(root, 'plain/hard.bin')), undefined);
  const release = registerInProcessSqliteDatabase(live);
  try {
    assert.ok(await refused(path.join(root, 'plain/hard.bin')));
    assert.ok(await refused(path.join(root, 'live'), { recursive: true }));
    assert.ok(await refused(root, { recursive: true }));
    assert.equal(await refused(path.join(root, 'live')), undefined, 'listing or reading beside the database stays allowed');
    assert.equal(await refused(path.join(root, 'plain'), { recursive: true }), undefined);
  } finally {
    release();
  }
  assert.equal(await refused(path.join(root, 'plain/hard.bin')), undefined);
  assert.equal(await refused(path.join(root, 'live'), { recursive: true }), undefined);
});
