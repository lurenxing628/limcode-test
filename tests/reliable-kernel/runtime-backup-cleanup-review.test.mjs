import { publishInitialRuntimeSelection } from './fixtures/runtime-selection.mjs';
// 清理备份（runtimeBackupCleanup）C 项第二部分的审查修复：H1 显示一致（拷贝里显示的消息在证明它的库里被删除、
// 编辑或重试替换时单列、默认不勾选，删除时替换的不能比列出时多）、L5 其它历史记录与正文文件、M1 已核对标记落盘后
// 放开 admission、L1 只读查看的登记、L2 备份目录逐项核对、L3 已核对标记绑定配置根、L4 历史库的名字、L6 外来库里的
// 临时文件、声明目录与诊断目录、L7 改名前最后一步与改名之后的目录比较、L9 读孪生库的摘要与读它的 id 之间的变化。
// Runs against the compiled extension.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve('dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = kernelFile('index.js');
const Database = require('better-sqlite3');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { projectFolderAssignmentSteps } = kernelFile('conversationProject.js');
const { deleteRuntimeBackups, planRuntimeBackupCleanup } = kernelFile('runtimeBackupCleanup.js');
const foreign = kernelFile('runtimeForeignHistory.js');
const { openRuntimeDataSetHistory } = kernelFile('runtimeDataSetHistory.js');
const {
  resolveVscodeRuntimeDataRoot, resolveVscodeWorkspaceRuntimeScope, resolveVscodeWorkspaceRuntimeScopeRoot, selectVscodeRuntimeDataSet
} = kernelFile('vscodeRootAuthority.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = '2026-09-26T00:00:00.000Z';
const LATER = '2026-09-27T00:00:00.000Z';
const MINUTE = 60_000;
const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
const PROJECT = { uri: 'file:///workspace/shared', name: 'shared' };
const BUSY = '正在被另一个窗口或操作使用（只读查看、核验、合并或清理备份）';
const COMPLETE = '显示的消息相同，正文文件也都在';
const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);

test('H1 当前库里被删除、编辑或重试替换的消息只在拷贝里还能看到：单列为可删、写明条数（replacedMessages），显示一致的拷贝才写“内容已完整”；删除时替换的消息不能比列出时多，改名之前和之后都复核', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one', 'conversation_two']);
  const before = await sourceBackup(fixture.current);
  let database = await openCurrent(t, fixture);
  // Deleting or retrying a message soft-deletes it; editing one makes a new revision current.
  await database.transaction(softDeleteSteps('conversation_one_message_1'));
  await editMessage(fixture.current, database, 'conversation_one_message_0');
  await database.close();
  const after = await sourceBackup(fixture.current);
  database = await openCurrent(t, fixture);

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  const replaced = itemAt(plan, before);
  assert.deepEqual([replaced.deletable, replaced.replacedMessages, replaced.conversations, replaced.revisions, replaced.reason],
    [true, 2, 2, 4, '其中 2 条消息在当前库里已被你删除、编辑或重试替换，删除这份后它们就再也看不到了']);
  const complete = itemAt(plan, after);
  assert.deepEqual([complete.deletable, complete.replacedMessages, complete.reason],
    [true, undefined, `可以删除：内容已完整在当前库里（其中 2 个对话、5 个消息版本都在，${COMPLETE}）`]);

  // One more message goes between the rename and the last check (deleting one takes no claim): name back.
  const late = await deleteRuntimeBackups(plan, database, [replaced.key], {
    async onFaultPoint(point) { if (point === 'after-rename') await database.transaction(softDeleteSteps('conversation_two_message_1')); }
  });
  assert.deepEqual(late.kept.map((entry) => entry.reason), ['当前库里刚刚又有 1 条这份备份里有的消息被删除、编辑或重试替换，已改回原名，保留']);
  assert.ok((await fs.lstat(before)).isDirectory());
  // Already replaced when the deletion begins: refused before any rename; the complete copy too.
  const points = [];
  const early = await deleteRuntimeBackups(plan, database, [replaced.key, complete.key], { onFaultPoint(point) { points.push(point); } });
  assert.deepEqual(points, []);
  assert.deepEqual(early.kept.map((entry) => entry.reason), [
    '列出之后这份备份有变化，请重新检查；这一项没有删除',
    '列出之后当前库里又有 1 条这份备份里有的消息被删除、编辑或重试替换，请重新检查；这一项没有删除'
  ]);
  // Checked again: ticked knowingly, both are deleted.
  const again = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual([itemAt(again, before).replacedMessages, itemAt(again, after).replacedMessages], [3, 1]);
  const done = await deleteRuntimeBackups(again, database, [itemAt(again, before).key, itemAt(again, after).key]);
  assert.deepEqual(done.deleted.map((entry) => entry.path).sort(), [before, after].sort(), JSON.stringify(done));
});













test('L2 备份目录按种类逐项核对：本地备份（C1）或外来库保留的备份里有它的种类不会写的内容（另一份数据库、说明文件、子目录、名为 .tmp 的目录）时整份保留；只有 .tmp 普通文件时算没写完', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  await seed(fixture.alpha, ['conversation_only_in_alpha']);
  const database = await openCurrent(t, fixture);
  const cases = {};
  const local = async (name, minutesAgo, prepare) => {
    const directory = await targetBackup(fixture.current, database, minutesAgo);
    await prepare?.(directory);
    await backdate(directory, minutesAgo);
    cases[name] = directory;
  };
  await local('otherDatabase', 300, (directory) => fs.copyFile(fixture.alpha.binding.paths.databasePath, path.join(directory, 'limcode-before-restore.sqlite')));
  await local('note', 280, (directory) => fs.writeFile(path.join(directory, 'README.txt'), 'mine'));
  await local('subdirectory', 260, (directory) => fs.mkdir(path.join(directory, 'extra')));
  await local('temporaryDirectory', 240, (directory) => fs.mkdir(path.join(directory, 'limcode.sqlite.1.tmp')));
  await local('writing', 220, (directory) => fs.writeFile(path.join(directory, 'limcode.sqlite.1.tmp'), 'partial'));
  await local('clean', 200);
  await targetBackup(fixture.current, database, 120);

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual(Object.fromEntries(Object.entries(cases).map(([name, directory]) => [name, itemAt(plan, directory).reason])), {
    otherDatabase: '备份目录里有不认识的内容（limcode-before-restore.sqlite），保留',
    note: '备份目录里有不认识的内容（README.txt），保留',
    subdirectory: '备份目录里有不认识的内容（extra），保留',
    temporaryDirectory: '备份目录里有不认识的内容（limcode.sqlite.1.tmp），保留',
    writing: '备份还没有写完（目录里有临时文件），保留',
    clean: `可以删除：内容已完整在当前库里（其中 1 个对话、2 个消息版本都在，${COMPLETE}）`
  });
});

test('L3 已核对标记绑定配置根：别处写的标记（没有身份、身份不同、配置根不同）不算，改回原名重新核对，含本地库没有的对话就保留；本配置根写的照常删完', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const other = await initialize(path.join(fixture.base, 'elsewhere'), 'elsewhere');
  await seed(other, ['conversation_only_there']);
  const archives = path.join(copiedDirectory(fixture, 1), '.limcode-runtime-backups');
  await fs.mkdir(archives, { recursive: true });
  const token = randomUUID();
  const identityFile = path.join(fixture.root, '.limcode-runtime-merges', 'backup-cleanup-identity.json');
  await fs.mkdir(path.dirname(identityFile), { recursive: true });
  await fs.writeFile(identityFile, JSON.stringify({ kind: 'limcode-backup-cleanup-identity', token }));
  const marks = {
    // Written before this check existed, or by another installation or machine.
    legacy: {},
    otherIdentity: { configurationRoot: fixture.root, cleanupIdentity: randomUUID() },
    // This configuration root copied elsewhere carries the token, not the path.
    otherRoot: { configurationRoot: path.join(fixture.base, 'Elsewhere'), cleanupIdentity: token },
    ours: { configurationRoot: fixture.root, cleanupIdentity: token }
  };
  const leftovers = {};
  for (const [index, [name, bound]] of Object.entries(marks).entries()) {
    const original = path.join(archives, archiveName(index + 1));
    const leftover = `${original}.deleting-0123456789abcdef`;
    await fs.cp(controlRoot(other), leftover, { recursive: true });
    await fs.writeFile(path.join(leftover, '.limcode-backup-cleanup-verified'), JSON.stringify({
      foreignId: 'foreign:archive:0000000000000000', kind: 'limcode-backup-cleanup-verified', name: path.basename(leftover), ...bound
    }));
    leftovers[name] = { original, leftover };
  }
  const database = await openCurrent(t, fixture);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual(plan.finishedDeletions, [leftovers.ours.leftover]);
  assert.deepEqual([...plan.restoredDeletions].sort(), [leftovers.legacy.original, leftovers.otherIdentity.original, leftovers.otherRoot.original].sort());
  for (const name of ['legacy', 'otherIdentity', 'otherRoot']) {
    const item = itemAt(plan, leftovers[name].original);
    assert.equal(item.deletable, false, name);
    assert.match(item.reason, /尚未完整合并.*原位保留/, name);
    assert.equal(await exists(path.join(leftovers[name].original, '.limcode-backup-cleanup-verified')), false, '改回原名时去掉不属于它的标记');
  }
  assert.equal(await exists(leftovers.ours.leftover), false);
});











// ---------------------------------------------------------------------------------------------
// Fixtures

async function createFixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-backup-cleanup-review-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'LimCode');
  await fs.mkdir(root);
  const paths = { globalStoragePath: root };
  const current = await initialize(root, 'default');
  const scope = resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: ['file:///workspace/alpha'] });
  const scopeRoot = resolveVscodeWorkspaceRuntimeScopeRoot(paths, scope);
  await fs.mkdir(scopeRoot, { recursive: true });
  const alpha = await initialize(scopeRoot, `workspace:${scope.key}`);
  await selectVscodeRuntimeDataSet(paths, 'default');
  return { base, root, paths, current, alpha };
}

async function initialize(scopeRoot, id) {
  await fs.mkdir(scopeRoot, { recursive: true });
  const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot }));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  return { id, scopeRoot, authority, binding };
}

async function addWorkspaceDataSet(fixture, folder) {
  const scope = resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: [folder] });
  return initialize(resolveVscodeWorkspaceRuntimeScopeRoot(fixture.paths, scope), `workspace:${scope.key}`);
}

async function openCurrent(t, fixture) {
  const database = await kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `window-${randomUUID()}` });
  t.after(() => database.close().catch(() => undefined));
  return database;
}

async function withDataSet(dataSet, operation) {
  const runtime = await kernel.RuntimeDatabase.open(dataSet.authority, { hostBootId: `edit-${randomUUID()}` });
  try { return await operation(runtime); }
  finally { await runtime.close(); }
}

/** Conversations with two messages each; ids are fixed, so seeding the same id elsewhere gives the same history ids. */
async function seed(dataSet, conversationIds, project = PROJECT) {
  await withDataSet(dataSet, async (runtime) => {
    const store = kernel.ContentAddressedStore.loose(dataSet.authority, runtime.binding);
    for (const id of conversationIds) {
      const turnId = `${id}_turn`;
      const steps = [
        repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
        ...projectFolderAssignmentSteps({ conversationId: id, folder: project, now: NOW }),
        repo('Turn').insert({ id: turnId, conversation_id: id, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
        repo('TurnTermination').insert({ id: `${id}_termination`, turn_id: turnId, terminal_status: 'completed', reason: 'fixture', created_at: NOW })
      ];
      for (const index of [0, 1]) {
        const content = await store.ingest(runtime, JSON.stringify({ role: 'user', parts: [{ text: `${id} 的第 ${index} 条消息` }] }), MESSAGE_TYPE);
        const messageId = `${id}_message_${index}`;
        steps.push(
          repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
          repo('MessageRevision').insert({
            id: `${messageId}_revision`, message_id: messageId, revision_seq: 1n, role: 'user', content_object_id: content.id, created_at: NOW
          }),
          repo('MessageCurrentRevisionLink').insert({ id: `${messageId}_current`, message_id: messageId, revision_id: `${messageId}_revision`, updated_at: NOW }),
          repo('MessagePartOfConversation').insert({
            id: `${messageId}_member`, conversation_id: id, message_id: messageId, message_seq: BigInt(index + 1), created_at: NOW
          })
        );
      }
      await runtime.transaction(steps);
    }
  });
}

/** What deleting or retrying a message does to it (turnControlPlane softDeleteEntrySteps). */
function softDeleteSteps(messageId) {
  return [
    repo('Message').assert(messageId, { deleted_at: null }),
    repo('Message').update(messageId, { deleted_at: LATER, updated_at: LATER })
  ];
}

/** What editing a message does to it: a new revision becomes the current one. */
async function editMessage(dataSet, runtime, messageId) {
  const store = kernel.ContentAddressedStore.loose(dataSet.authority, runtime.binding);
  const content = await store.ingest(runtime, JSON.stringify({ role: 'user', parts: [{ text: `${messageId} 改过之后` }] }), MESSAGE_TYPE);
  const revisionId = `${messageId}_revision_2`;
  await runtime.transaction([
    repo('Message').assert(messageId, { deleted_at: null }),
    repo('MessageCurrentRevisionLink').assert(`${messageId}_current`, { revision_id: `${messageId}_revision` }),
    repo('MessageRevision').insert({ id: revisionId, message_id: messageId, revision_seq: 2n, role: 'user', content_object_id: content.id, created_at: LATER }),
    repo('MessageCurrentRevisionLink').update(`${messageId}_current`, { revision_id: revisionId, updated_at: LATER })
  ]);
}

/**
 * A finished tool call (with the result given to the model, as the second message), a question with
 * its answer and a process with its output in a conversation's turn (fixed ids).
 */
async function addRecords(dataSet, conversationId) {
  return withDataSet(dataSet, async (runtime) => {
    const store = kernel.ContentAddressedStore.loose(dataSet.authority, runtime.binding);
    const body = async (text) => (await store.ingest(runtime, JSON.stringify({ text }), 'application/json')).id;
    const [argumentsId, promptId, answerId, outputId] = [
      await body('read_file README.md'), await body('继续吗？'), await body('继续'), await body('hello\n')
    ];
    const turnId = `${conversationId}_turn`;
    await runtime.transaction([
      repo('ToolCall').insert({
        id: `${conversationId}_tool`, turn_id: turnId, call_seq: 1n, tool_name: 'read_file', status: 'terminal',
        arguments_object_id: argumentsId, created_at: NOW, updated_at: NOW
      }),
      repo('ToolModelResult').insert({
        id: `${conversationId}_tool_result`, tool_call_id: `${conversationId}_tool`, message_revision_id: `${conversationId}_message_1_revision`, created_at: NOW
      }),
      repo('InteractionRequest').insert({
        id: `${conversationId}_question`, request_kind: 'question', status: 'answered', prompt_object_id: promptId, created_at: NOW, updated_at: NOW
      }),
      repo('InteractionResponse').insert({ id: `${conversationId}_answer`, request_id: `${conversationId}_question`, content_object_id: answerId, created_at: NOW }),
      repo('Process').insert({
        id: `${conversationId}_process`, status: 'exited', wrapper_nonce: 'nonce', wrapper_pid: 1n, child_pid: null, process_group_id: null,
        start_fingerprint: 'fingerprint', command_digest: 'digest', spool_locator: 'spool', retained_bytes: 6n, retained_chunks: 1n,
        dropped_bytes: 0n, truncated: 0n, started_at: NOW, updated_at: NOW, completed_at: NOW
      }),
      repo('ProcessReceipt').insert({
        id: `${conversationId}_process_receipt`, process_id: `${conversationId}_process`, outcome: 'succeeded',
        exit_code: 0n, exit_signal: null, wrapper_nonce: 'nonce', start_fingerprint: 'fingerprint', received_at: NOW
      }),
      repo('ProcessOutputChunk').insert({
        id: `${conversationId}_output`, process_id: `${conversationId}_process`, chunk_seq: 1n, stream_kind: 'stdout',
        content_object_id: outputId, byte_length: 6n, created_at: NOW
      })
    ]);
    return { outputContentId: outputId };
  });
}

/** Where a body of a data set is kept below its CAS (its content object's storage key, split). */
async function storageKey(dataSet, contentId) {
  return withDataSet(dataSet, async (runtime) => {
    const [row] = (await runtime.snapshot([{ kind: 'get', domain: 'ContentObject', id: contentId }])).snapshot;
    return row.storage_key.split('/');
  });
}

async function deleteConversation(dataSet, conversationId) {
  await withDataSet(dataSet, (runtime) => runtime.transaction([repo('Conversation').delete(conversationId)]));
}

/** A closed data set's whole control root copied into the archives directory of `scopeRoot` (as if restored by hand). */
async function copyAsArchive(dataSet, scopeRoot, name) {
  const target = path.join(scopeRoot, '.limcode-runtime-backups', name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(controlRoot(dataSet), target, { recursive: true });
  return target;
}

/** A pre-merge backup of a closed data set (Backup API copy beside its binding) inside a control root. */
async function backupInto(unit, dataSet, name) {
  const directory = path.join(unit, 'merge-backups', name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'root-binding.json'), `${JSON.stringify(dataSet.binding, null, 2)}\n`);
  const live = new Database(dataSet.binding.paths.databasePath, { readonly: true, fileMustExist: true });
  try { await live.backup(path.join(directory, 'limcode.sqlite')); }
  finally { live.close(); }
  return directory;
}

let backupSequence = 0;
function backupName(minutesAgo) {
  backupSequence += 1;
  const time = new Date(Date.now() - minutesAgo * MINUTE).toISOString().replace(/[-:.]/g, '');
  return `${time}-${String(backupSequence).padStart(6, '0')}-${randomUUID().slice(0, 8)}`;
}

/** The merge engine's target backup (ensureTargetBackup): binding beside an online Backup API copy. */
async function targetBackup(dataSet, database, minutesAgo) {
  const directory = path.join(controlRoot(dataSet), 'merge-backups', backupName(minutesAgo));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, 'root-binding.json'), `${JSON.stringify(database.binding, null, 2)}\n`);
  const temporary = path.join(directory, `limcode.sqlite.${process.pid}.tmp`);
  await database.backupTo(temporary);
  await Promise.all(['-wal', '-shm'].map((suffix) => fs.rm(`${temporary}${suffix}`, { force: true })));
  await fs.rename(temporary, path.join(directory, 'limcode.sqlite'));
  await backdate(directory, minutesAgo);
  return directory;
}

/** The merge engine's source backup (backupSource): an offline data set's Backup API copy. */
async function sourceBackup(dataSet) {
  const directory = path.join(controlRoot(dataSet), 'merge-source-backups', backupName(400));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, 'root-binding.json'), `${JSON.stringify(dataSet.binding, null, 2)}\n`);
  const live = new Database(dataSet.binding.paths.databasePath, { readonly: true, fileMustExist: true });
  try { await live.backup(path.join(directory, 'limcode.sqlite')); }
  finally { live.close(); }
  return directory;
}

async function backdate(directory, minutesAgo) {
  const time = new Date(Date.now() - minutesAgo * MINUTE);
  await fs.utimes(directory, time, time);
}

function archiveName(index) {
  return `2026090${index}-010203-004-abcdef1${index}`;
}

function backupNameAt(index) {
  return `20260901T01020${index}000Z-00000${index}-${randomUUID().slice(0, 8)}`;
}

function copiedDirectory(fixture, index) {
  return `${fixture.root}.limcode-copied-2026-09-0${index}T01-02-03-004Z-1234567${index}`;
}

function controlRoot(dataSet) {
  return path.dirname(dataSet.binding.paths.dataRootPath);
}

function itemAt(plan, directory) {
  const item = plan.items.find((entry) => entry.path === directory);
  assert.ok(item, `没有列出 ${directory}：${plan.items.map((entry) => entry.path).join(', ')}`);
  return item;
}

async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Every entry below `root`: type, size, times and content. */
async function treeState(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      const stat = await fs.lstat(file, { bigint: true });
      const key = path.relative(root, file);
      if (entry.isDirectory()) { result[key] = `dir:${stat.ino}:${stat.mtimeNs}`; await visit(file); }
      else result[key] = `file:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`;
    }
  }
  await visit(root);
  return result;
}

/** The pid of a process that has exited. */
async function exitedProcessId() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid;
}

/** Whether another process can take the configuration admission and the foreign root's claim right now. */
async function probe(root, id, pointer) {
  const result = await runChild(['probe', root, id, pointer]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function runChild(args) {
  const script = path.join(HERE, 'runtime-backup-cleanup-child.mjs');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, LIMCODE_TEST_EXTENSION_ROOT: compiled }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    // A child that hangs is ended with SIGTERM, never mistaken for the SIGKILL of its crash point.
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
