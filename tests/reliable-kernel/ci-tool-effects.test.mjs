import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire, Module } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { before, after } from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
const kernel = load('backend/reliableKernel/index.js');
const boundary = load('backend/reliableKernel/fileTargetBoundary.js');
const protocol = load('backend/reliableKernel/processProtocol.js');
const frozenTools = load('backend/reliableKernel/frozenToolDefinitions.js');
const { applyExactEditHunk } = load('shared/editHunkMatcher.js');
const { applyHunkEdit } = load('backend/capabilities/editStrategies.js');
const { readRemoteServerRawTextFile } = load('backend/capabilities/workEnvironmentProvider.js');
const repo = domain => kernel.DOMAIN_REPOSITORIES.domain(domain);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const EMPTY_TAIL_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

let temporary, authority, database, store, effects;
async function openRuntime(hostBootId) {
  database = await kernel.RuntimeDatabase.open(authority, { hostBootId });
  store = kernel.ContentAddressedStore.forDatabase(authority, database);
  effects = new kernel.EffectControlPlane(database, store);
}
before(async () => {
  temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-ci-tools-')));
  authority = new kernel.RootAuthority(() => path.join(temporary, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  await openRuntime('ci-tools-first');
});
after(async () => {
  await database?.close();
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
});
async function directory(name) {
  const root = path.join(temporary, name);
  await fs.mkdir(root, { recursive: true });
  return root;
}
async function createTurn(id) {
  const now = new Date().toISOString();
  await database.transaction([
    repo('Conversation').insert({ id: id + '-conversation', title: id, status: 'active', created_at: now, updated_at: now }),
    repo('Turn').insert({ id, conversation_id: id + '-conversation', status: 'active', created_at: now, updated_at: now, terminal_at: null }),
    repo('ExecutionLease').insert({ id: id + '-lease', conversation_id: id + '-conversation', turn_id: id,
      owner_id: 'ci-tools', host_boot_id: database.hostBootId, generation: 1n, acquired_at: now,
      expires_at: new Date(Date.now() + 600_000).toISOString() })
  ]);
}
async function rows(domain, where = {}) {
  return (await database.snapshotAll(repo(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 100 }))).snapshot;
}
async function readBody(id) {
  const metadata = (await rows('ContentObject', { id }))[0];
  return JSON.parse((await store.read(metadata)).toString('utf8'));
}
async function replacement(root, content = 'approved') {
  const planner = new kernel.LocalFileToolPlanner(input => kernel.resolvePathInsideBoundary('workspace', root, input));
  const [planned] = await planner.plan({ declaration: { name: 'write' } },
    { arguments: { path: 'note.txt', content } }, {});
  const dispatcher = Object.create(kernel.FileMutationDispatcher.prototype);
  dispatcher.resolveBoundary = () => ({ id: 'workspace', rootPath: root });
  dispatcher.readTargetBytes = async () => Buffer.from(content);
  const member = { ...planned, memberId: 'member', memberSeq: '1',
    baseContentObjectId: null, targetContentObjectId: 'target', targetDigest: null };
  return { dispatcher, member };
}

test('TE01 exact edit comparison wins over tolerant candidates without guessing different text', () => {
  const source = ' x  \n y\nx\ny\n';
  const changed = applyExactEditHunk(source, { oldContent: 'x\ny', newContent: 'X\nY', replaceAll: true });
  assert.equal(changed.matchStrategy, 'exact');
  assert.equal(changed.matchCount, 1);
  assert.equal(changed.content, ' x  \n y\nX\nY\n');
  const rejected = applyExactEditHunk(source, { oldContent: 'X  y', newContent: 'wrong' });
  assert.equal(rejected.matchCount, 0);
  assert.equal(rejected.content, source);
});

test('TE02 ordered Unicode hunks preserve BOM and the EOL of each replaceAll span', () => {
  const source = '\ufeff “a”  \r\n b\t\r\nmid🚀\n “a” \n b \n';
  const result = applyHunkEdit(source, [
    { oldContent: '"a"\nb', newContent: 'A\nB', replaceAll: true },
    { oldContent: 'A\nB', newContent: '完成' }
  ]);
  assert.equal(result.failed, 0);
  assert.equal(result.results[0].fallback.strategy, 'unicode');
  assert.equal(result.results[0].replacements, 2);
  assert.equal(result.newContent, '\ufeff完成\r\nmid🚀\nA\nB\n');
});

test('TE03 native local reads return large Unicode ranges and attachments without VS Code RPC', { timeout: 5_000 }, async () => {
  const root = await directory('local-read');
  const rpcCalls = [];
  class Uri {
    constructor(scheme, fsPath) {
      this.scheme = scheme;
      this.fsPath = path.resolve(fsPath);
      this.path = this.fsPath.split(path.sep).join('/');
    }
    static file(value) { return new Uri('file', value); }
    toString() { return this.scheme + '://' + this.path; }
    with(changes) { return new Uri(this.scheme, changes.path ?? this.fsPath); }
  }
  const rpc = operation => { rpcCalls.push(operation); return new Promise(() => {}); };
  const vscode = { Uri, FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 }, workspace: {
    workspaceFolders: [{ uri: Uri.file(root) }], fs: { stat: () => rpc('stat'), readFile: () => rpc('readFile') }
  } };
  const originalLoad = Module._load;
  let localFs;
  try {
    Module._load = function (request, ...rest) {
      return request === 'vscode' ? vscode : originalLoad.call(this, request, ...rest);
    };
    localFs = load('backend/capabilities/vscodeFs.js');
  } finally { Module._load = originalLoad; }
  const lines = Array.from({ length: 4_000 }, (_, index) => '第 ' + (index + 1) + ' 行 ' + '状态栏美化'.repeat(8));
  await fs.writeFile(path.join(root, 'large.txt'), lines.join('\n'));
  const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
  await fs.writeFile(path.join(root, 'image.png'), bytes);
  const environment = { id: 'local-read', kind: 'localFolder', source: 'workspaceFolder', name: 'local-read',
    uri: Uri.file(root).toString(), rootPath: root, displayPath: root, index: 0, available: true, createdAt: 1, updatedAt: 1 };
  const options = { workEnvironment: environment, accessibleWorkEnvironments: [environment], allowOutsideProjectPaths: false };
  const head = await localFs.readWorkspaceTextFile('large.txt', undefined, undefined, options);
  const ranged = await localFs.readWorkspaceTextFile('large.txt', 3_900, 3_903, options);
  const attachment = await localFs.readWorkspaceBinaryFile('image.png', 'image/png', options);
  assert.equal(head.totalLines, lines.length);
  assert.ok(head.endLine > 0 && head.endLine < lines.length);
  assert.deepEqual(ranged.lines.map(line => line.text), lines.slice(3_899, 3_903));
  assert.equal(ranged.startLine, 3_900);
  assert.equal(ranged.endLine, 3_903);
  assert.equal(attachment.data, bytes.toString('base64'));
  assert.deepEqual(rpcCalls, []);
});

test('TE04 remote bytes added after the size check fail instead of returning a truncated prefix', { skip: process.platform === 'win32' }, async t => {
  const base = await directory('remote-read');
  const bin = path.join(base, 'bin'), root = path.join(base, 'root');
  await fs.mkdir(bin);
  await fs.mkdir(root);
  await fs.writeFile(path.join(bin, 'ssh'), '#!/bin/sh\nfor last do :; done\nsh -c "$last"\nprintf surplus\n');
  await fs.chmod(path.join(bin, 'ssh'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + (previousPath ?? '');
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  await fs.writeFile(path.join(root, 'growing.txt'), 'g'.repeat(128));
  const environment = { id: 'remote-read', kind: 'remoteServer', source: 'manual', name: 'remote-read',
    host: 'remote-read.test.invalid', rootPath: root, displayPath: root, index: 0, available: true, createdAt: 1, updatedAt: 1 };
  await assert.rejects(readRemoteServerRawTextFile(environment, 'growing.txt', 128), /File too large/);
});

test('TE05 committed skill and read results retain separate budgets and precise reread positions', () => {
  const skill = { name: 'demo', source: '.claude', baseDirectory: '/skills/demo', entryPath: '/skills/demo/SKILL.md',
    bodyStartLine: 5, body: Array.from({ length: 2_000 }, (_, index) => (index + 1) + '. Run "step"\t' + 'instruction '.repeat(10)).join('\n') };
  const read = { path: '/work/a.ts', startLine: 1, endLine: 500, totalLines: 900,
    content: Array.from({ length: 500 }, (_, index) => (index + 1) + ' ' + 'const value = compute(); '.repeat(4)).join('\n') };
  const skillResponse = { status: 'succeeded', detail: { ok: true, output: skill } };
  const readResponse = { status: 'succeeded', detail: read };
  const items = [
    { toolName: 'skills', callId: 'skill', response: skillResponse },
    { toolName: 'read', callId: 'read', response: readResponse }
  ];
  const [skillItem, readItem] = kernel.projectToolResultBatch(items).items;
  assert.equal(skillItem.truncated, true);
  assert.ok(skillItem.projectedTokens > kernel.TOOL_RESULT_MAX_TOKENS);
  assert.ok(skillItem.projectedTokens <= kernel.SKILL_TOOL_RESULT_MAX_TOKENS);
  const shownSkill = /Shown above: lines 1-(\d+) of the skill body/.exec(skillItem.response.output);
  assert.ok(shownSkill);
  assert.deepEqual(skillItem.reread, { kind: 'file', path: skill.entryPath, startLine: 5 + Number(shownSkill[1]) });
  assert.equal(readItem.truncated, true);
  const shown = readItem.response.detail;
  assert.equal(shown.content.split('\n').length, shown.endLine);
  assert.deepEqual(shown.rereadHint, { kind: 'file', path: read.path, startLine: shown.endLine + 1 });
  assert.equal(shown.totalLines, 900);
  const pair = (id, toolName, result) => ({ segmentId: 'pair-' + id, segmentKind: 'tool_pair', messageRole: null,
    contentType: 'application/vnd.limcode.context-tool-pair+json', content: JSON.stringify({ kind: 'tool_pair',
      toolCall: { id: 'tool-' + id, providerCallId: id, toolName, arguments: '{}' },
      toolModelResult: { id: 'result-' + id, result: JSON.stringify({ toolCallId: 'tool-' + id, ...result }) } }) });
  const projected = kernel.projectStoredModelFacingWindow([
    { segmentId: 'message', segmentKind: 'message', messageRole: 'model', contentType: 'application/vnd.limcode.message+json',
      content: JSON.stringify({ role: 'model', parts: [
        { id: 'skill', functionCall: { name: 'skills', args: {} } },
        { id: 'read', functionCall: { name: 'read', args: {} } }
      ] }) },
    pair('skill', 'skills', skillResponse), pair('read', 'read', readResponse)
  ]);
  assert.deepEqual(projected.contents.slice(1).map(content => content.parts[0].functionResponse.response),
    [skillItem.response, readItem.response]);
});

test('TE06 a newer editor write during the target CAS await survives approved replacement', async () => {
  const root = await directory('cas-race'), target = path.join(root, 'note.txt');
  await fs.writeFile(target, 'base');
  const { dispatcher, member } = await replacement(root);
  let targetLoads = 0;
  dispatcher.readTargetBytes = async () => {
    targetLoads++;
    await fs.writeFile(target, 'newer editor content');
    return Buffer.from('approved');
  };
  const result = await dispatcher.applyMember(member);
  assert.equal(targetLoads, 1);
  assert.equal(result.outcome, 'conflict');
  assert.equal(await fs.readFile(target, 'utf8'), 'newer editor content');
});

test('TE07 final symlink substitution at writable open preserves the outside target', async t => {
  const root = await directory('descriptor-race'), target = path.join(root, 'note.txt'), outside = path.join(temporary, 'outside.txt');
  await fs.writeFile(target, 'base');
  await fs.writeFile(outside, 'outside content');
  const { dispatcher, member } = await replacement(root);
  const originalOpen = fs.open;
  let substituted = false;
  t.mock.method(fs, 'open', async (input, ...rest) => {
    if (String(input) === target && typeof rest[0] === 'number' && (rest[0] & constants.O_RDWR) === constants.O_RDWR && !substituted) {
      substituted = true;
      await fs.rename(target, target + '.previous');
      await fs.symlink(outside, target, 'file');
    }
    return originalOpen(input, ...rest);
  });
  const result = await dispatcher.applyMember(member);
  assert.equal(substituted, true);
  assert.ok(['conflict', 'failed'].includes(result.outcome));
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside content');
  assert.equal(await fs.readFile(target + '.previous', 'utf8'), 'base');
});

test('TE08 a nonregular descriptor substituted after stat is rejected before reading and is closed', async t => {
  const root = await directory('nonregular-read'), target = path.join(root, 'note.txt');
  await fs.writeFile(target, 'base');
  const expected = await fs.lstat(target, { bigint: true });
  const originalOpen = fs.open;
  let reads = 0, closes = 0, substituted = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.readFile.bind(handle), originalClose = handle.close.bind(handle);
    if (process.platform === 'win32') {
      const originalStat = handle.stat.bind(handle);
      handle.stat = async (...statArgs) => {
        const stat = await originalStat(...statArgs);
        stat.isFile = () => false;
        substituted = true;
        return stat;
      };
    }
    handle.readFile = (...readArgs) => { reads++; return originalRead(...readArgs); };
    handle.close = (...closeArgs) => { closes++; return originalClose(...closeArgs); };
    return handle;
  });
  await assert.rejects(boundary.readFileWithIdentityFence(target, expected, async () => {
    if (process.platform !== 'win32' && !substituted) {
      await fs.rename(target, target + '.previous');
      await new Promise((resolve, reject) => execFile('mkfifo', [target], error => error ? reject(error) : resolve()));
      substituted = true;
    }
  }), /identity or type changed/);
  assert.equal(substituted, true);
  assert.equal(reads, 0);
  assert.equal(closes, 1);
});

function claimWorker(coordination) {
  const code = [
    'const boundary = require(' + JSON.stringify(path.join(compiled, 'backend/reliableKernel/fileTargetBoundary.js')) + ');',
    'const claims = require(' + JSON.stringify(path.join(compiled, 'backend/reliableKernel/runtimeClaimPrimitives.js')) + ');',
    'let release, retry; const gate = new Promise(done => { release = done; });',
    'const retryGate = new Promise(done => { retry = done; });',
    'process.on("message", async message => {',
    '  if (message.type === "exit") process.exit(0);',
    '  if (message.type === "release") { release(); return; }',
    '  if (message.type === "retry") { retry(); return; }',
    '  if (message.type !== "run") return;',
    '  if (message.waiter) { const delay = claims.delay; let paused = false;',
    '    claims.delay = ms => { if (!paused) { paused = true; process.send("blocked"); return retryGate; } return delay(ms); }; }',
    '  try { await boundary.withFileMutationTargets([{ root: message.root, target: message.target }], async () => {',
    '    process.send("entered"); await gate;',
    '  }); process.send("released"); process.disconnect(); }',
    '  catch (error) { process.send({ error: error.stack }); process.exitCode = 1; process.disconnect(); }',
    '}); process.send("ready");'
  ].join('\n');
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, TMPDIR: coordination, TMP: coordination, TEMP: coordination } });
  const messages = [], listeners = new Set();
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('message', value => { messages.push(value); for (const listener of listeners) listener(value); });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const wait = expected => {
    const failure = messages.find(message => message?.error);
    if (failure) return Promise.reject(new Error(failure.error));
    if (messages.includes(expected)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const listener = value => {
        if (value === expected || value?.error) {
          listeners.delete(listener);
          if (value?.error) reject(new Error(value.error));
          else resolve();
        }
      };
      listeners.add(listener);
      exited.then(({ code }) => {
        if (listeners.delete(listener)) reject(new Error('Claim worker exited before ' + expected + ': ' + code + ' ' + stderr));
      });
    });
  };
  return { child, messages, exited, wait, send: value => child.send(value) };
}

test('TE09 nested workspace claims wait for live owners and recover their verified death while unrelated roots progress', { timeout: 10_000 }, async () => {
  const root = await directory('claim-workspace'), nestedPath = path.join(root, 'nested');
  await fs.mkdir(nestedPath);
  const unrelatedPath = await directory('claim-unrelated'), coordination = await directory('claim-coordination');
  const planningRoot = await boundary.captureFilePlanningRoot(root);
  const nested = await boundary.captureFilePlanningRoot(nestedPath);
  const unrelated = await boundary.captureFilePlanningRoot(unrelatedPath);
  const holder = claimWorker(coordination), waiter = claimWorker(coordination), other = claimWorker(coordination);
  const workers = [holder, waiter, other];
  try {
    await Promise.all(workers.map(worker => worker.wait('ready')));
    holder.send({ type: 'run', root: planningRoot, target: path.join(nestedPath, 'note.txt') });
    await holder.wait('entered');
    waiter.send({ type: 'run', root: nested, target: path.join(nestedPath, 'note.txt'), waiter: true });
    await waiter.wait('blocked');
    assert.equal(waiter.messages.includes('entered'), false);
    other.send({ type: 'run', root: unrelated, target: path.join(unrelatedPath, 'note.txt') });
    await other.wait('entered');
    other.send({ type: 'release' });
    await other.wait('released');
    holder.send({ type: 'exit' });
    assert.equal((await holder.exited).code, 0);
    waiter.send({ type: 'retry' });
    await waiter.wait('entered');
    waiter.send({ type: 'release' });
    await waiter.wait('released');
    assert.equal((await waiter.exited).code, 0);
    assert.equal((await other.exited).code, 0);
  } finally {
    for (const worker of workers) if (worker.child.connected && worker.child.exitCode === null) worker.send({ type: 'exit' });
    await Promise.all(workers.map(worker => worker.exited));
  }
});

test('TE10 approved physical edits recover the receipt gap and replay frozen results without another mutation', async () => {
  const root = await directory('durable-edit'), first = path.join(root, 'first'), second = path.join(root, 'second'), alias = path.join(root, 'alias');
  await fs.mkdir(first);
  await fs.mkdir(second);
  const originalContent = '\ufeffalpha\r\nbeta\r\ngamma\r\n';
  await fs.writeFile(path.join(first, 'note.txt'), originalContent);
  await fs.writeFile(path.join(second, 'note.txt'), originalContent);
  await fs.symlink(first, alias, 'junction');
  await createTurn('file-gap');
  const args = { path: 'alias/note.txt', mode: 'hunk', hunks: [{ oldContent: 'alpha', newContent: 'hunk-only' }],
    insert: { line: 2, content: 'unused' }, delete: { startLine: 2, endLine: 2 } };
  await effects.createToolCall({ source: { kind: 'internal', key: 'file-gap-create' }, toolCallId: 'file-gap-call',
    turnId: 'file-gap', toolName: 'edit', arguments: args });
  const planner = new kernel.LocalFileToolPlanner(input => kernel.resolvePathInsideBoundary('workspace', root, input));
  const members = await planner.plan({ declaration: { name: 'edit' } }, { arguments: args }, {});
  assert.equal(members[0].targetPath, 'first/note.txt');
  const files = new kernel.FileChangeControlPlane(database, store, effects);
  const proposal = await files.propose({ source: { kind: 'internal', key: 'file-gap-propose' }, toolCallId: 'file-gap-call', members });
  const approval = await files.decide({ source: { kind: 'command', key: 'file-gap-approve' },
    changeSetId: proposal.changeSetId, decision: 'approved' });
  const effectId = approval.preparedEffect.effectIntentId;
  args.mode = 'delete';
  args.hunks[0].newContent = 'later caller mutation';
  await fs.unlink(alias);
  await fs.symlink(second, alias, 'junction');
  const resolver = id => ({ id, rootPath: root });
  const dispatcher = new kernel.FileMutationDispatcher(database, store, effects, resolver);
  assert.equal(await effects.claimEffectDispatch(effectId), true);
  assert.equal((await dispatcher.executeDispatched(effectId)).outcome, 'succeeded');
  assert.equal(await fs.readFile(path.join(first, 'note.txt'), 'utf8'), '\ufeffhunk-only\r\nbeta\r\ngamma\r\n');
  assert.equal(await fs.readFile(path.join(second, 'note.txt'), 'utf8'), originalContent);
  const [intent] = await rows('EffectIntent', { id: effectId });
  assert.equal((await rows('EffectReceipt', { attempt_id: intent.attempt_id })).length, 0);
  const rebuiltEffects = new kernel.EffectControlPlane(database, store);
  const rebuiltFiles = new kernel.FileChangeControlPlane(database, store, rebuiltEffects);
  const recovered = await rebuiltFiles.recoverDispatchedEffect({ source: { kind: 'recovery', key: 'file-gap-recover' },
    effectIntentId: effectId, resolver });
  assert.equal(recovered.status, 'succeeded');
  const [outcome] = await rows('ToolOutcome', { tool_call_id: 'file-gap-call' });
  const result = await readBody(outcome.content_object_id);
  assert.equal(result.detail.mode, 'hunk');
  assert.deepEqual(result.detail.ignoredBranches, ['insert', 'delete']);
  const [call] = await rows('ToolCall', { id: 'file-gap-call' });
  assert.equal((await readBody(call.arguments_object_id)).mode, 'hunk');
  await fs.writeFile(path.join(first, 'note.txt'), 'later editor content');
  const replay = new kernel.FileMutationDispatcher(database, store, rebuiltEffects, () => assert.fail('terminal replay read workspace'));
  assert.equal((await replay.dispatchRecordAndReconcile(effectId)).terminal.status, 'succeeded');
  assert.deepEqual(await rows('ToolOutcome', { tool_call_id: 'file-gap-call' }), [outcome]);
  assert.equal((await rows('EffectReceipt', { attempt_id: intent.attempt_id })).length, 1);
  assert.equal(await fs.readFile(path.join(first, 'note.txt'), 'utf8'), 'later editor content');
});

test('TE11 immutable frozen tool CAS identity survives reuse and reopen without consulting live definitions', async t => {
  const input = [
    { name: 'b', description: 'B', parameters: { enum: ['first', 'second'] }, source: { kind: 'mcp', sourceId: 'original' } },
    { name: 'a', description: 'A', parameters: {} }
  ];
  const tools = frozenTools.prepareFrozenToolDefinitions(input);
  input[0].parameters.enum.reverse();
  input[0].source.sourceId = 'replacement';
  assert.throws(() => tools[0].parameters.enum.push('poison'), TypeError);
  let ingests = 0;
  const ingest = store.ingest.bind(store);
  t.mock.method(store, 'ingest', (...args) => { ingests++; return ingest(...args); });
  const reference = await frozenTools.freezeToolDefinitions(database, store, tools);
  assert.deepEqual(await frozenTools.freezeToolDefinitions(database, store, tools), reference);
  assert.equal(ingests, 1);
  const recipe = { kind: 'reliable-agent-turn', toolsReference: reference };
  assert.equal(await frozenTools.resolveFrozenToolDefinitions(database, store, recipe), tools);
  await database.close();
  await openRuntime('ci-tools-reopened');
  const restored = await frozenTools.resolveFrozenToolDefinitions(database, store, JSON.parse(JSON.stringify(recipe)));
  assert.deepEqual(restored.map(tool => tool.name), ['b', 'a']);
  assert.deepEqual(restored[0].parameters.enum, ['first', 'second']);
  assert.equal(restored[0].source.sourceId, 'original');
  await assert.rejects(frozenTools.resolveFrozenToolDefinitions(database, store,
    { toolsReference: { contentObjectId: 'missing-tools' } }), /registered CAS/);
});

test('TE12 observed MCP results with damaged nested attachments replay their receipt and never invoke again', async () => {
  await createTurn('mcp-result');
  const attachments = new kernel.AttachmentIngestService(database, store, {
    async loadGlobalSettings() { return { settings: { maxStoredInlineFileMb: 1 } }; }
  });
  const mcpEffects = new kernel.EffectControlPlane(database, store, { attachments });
  await mcpEffects.createToolCall({ source: { kind: 'internal', key: 'mcp-result-create' }, toolCallId: 'mcp-result-call',
    turnId: 'mcp-result', toolName: 'fixture_mcp', arguments: {} });
  let invocations = 0;
  const dispatcher = new kernel.McpEffectDispatcher(database, mcpEffects, {
    async toolAnnotations() { return {}; },
    async callTool() {
      invocations++;
      return { content: [{ type: 'text', text: 'External action returned useful evidence' }],
        structuredContent: { text: 'Useful attachment sibling',
          inlineData: { mimeType: 'image/png', data: '%%%INVALID%%%', storage: 'embedded', status: 'available' } } };
    }
  }, { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } });
  const prepared = await dispatcher.prepare({ source: { kind: 'internal', key: 'mcp-result-prepare' },
    toolCallId: 'mcp-result-call', serverId: 'fixture', toolName: 'action' });
  const observed = await dispatcher.dispatch(prepared.effectIntentId);
  assert.equal(observed.observation.outcome, 'succeeded');
  assert.equal(observed.terminal.status, 'succeeded');
  assert.equal(observed.observation.automaticRetry, false);
  assert.ok(observed.observation.attachmentError);
  assert.equal(observed.observation.result.structuredContent.text, 'Useful attachment sibling');
  const [receipt] = await rows('EffectReceipt', { attempt_id: prepared.attemptId });
  const durable = await readBody(receipt.response_object_id);
  assert.equal(durable.result.content[0].text, 'External action returned useful evidence');
  assert.equal(durable.outcome, 'succeeded');
  assert.equal(durable.automaticRetry, false);
  const recovered = await dispatcher.recoverDispatched({ source: { kind: 'recovery', key: 'mcp-result-recover' },
    effectIntentId: prepared.effectIntentId });
  assert.equal(recovered.status, 'succeeded');
  assert.equal(invocations, 1);
  assert.equal((await rows('EffectReceipt', { attempt_id: prepared.attemptId })).length, 1);
});

test('TE13 Linux ESRCH observes the late matching exit receipt and replays the original process output', { skip: process.platform !== 'linux' }, async t => {
  await createTurn('process-race');
  const processes = new kernel.ProcessControlPlane(database, store, effects, authority, database.binding);
  t.after(() => processes.dispose());
  await effects.createToolCall({ source: { kind: 'callback', key: 'process-race-create' }, toolCallId: 'process-race-call',
    turnId: 'process-race', toolName: 'bash', arguments: { command: 'fixture command is never spawned', explanation: 'exit race' } });
  const prepared = await processes.prepareStart({ source: { kind: 'internal', key: 'process-race-prepare' },
    toolCallId: 'process-race-call', command: 'fixture command is never spawned', cwd: temporary });
  const childPid = '2147483600', wrapperPid = '2147483601', output = 'proc-stat-exit-race-verified\n';
  const identity = { kind: protocol.PROCESS_WRAPPER_PROTOCOL, processId: prepared.request.processId,
    stableNonce: prepared.request.stableNonce, wrapperPid, childPid, processGroupId: childPid,
    startFingerprint: 'linux-proc:' + childPid + ':12345', commandDigest: prepared.request.commandDigest,
    spoolLocator: prepared.request.spoolLocator, startedAt: new Date().toISOString() };
  const exit = { ...identity, exitCode: '0', signal: null, exitedAt: new Date().toISOString(),
    retainedBytes: String(Buffer.byteLength(output)), retainedChunks: '1', droppedBytes: '0', truncated: false,
    stopRequested: false, terminationReason: 'natural',
    executionDeadlineAt: new Date(Date.now() + prepared.request.executionTimeoutMs).toISOString(),
    maxOutputBytes: prepared.request.maxOutputBytes };
  delete exit.spoolLocator;
  delete exit.startedAt;
  const manifest = { kind: identity.kind, processId: identity.processId, stableNonce: identity.stableNonce,
    status: 'exited', nextChunkSeq: '2', retainedBytes: String(Buffer.byteLength(output)), retainedChunks: '1',
    droppedBytes: '0', truncated: false, stdoutTailBytes: '0', stdoutTailSha256: EMPTY_TAIL_DIGEST, stdoutTailBase64: '',
    stderrTailBytes: '0', stderrTailSha256: EMPTY_TAIL_DIGEST, stderrTailBase64: '', updatedAt: new Date().toISOString() };
  const spool = protocol.processSpoolPath(database.binding, prepared.request.spoolLocator);
  const launchPath = path.join(spool, 'launch.json');
  await fs.mkdir(path.join(spool, 'chunks'), { recursive: true });
  const writeJson = (file, value) => fsSync.writeFileSync(file, JSON.stringify(value) + '\n');
  writeJson(path.join(spool, protocol.PROCESS_WRAPPER_IDENTITY_FILE), identity);
  writeJson(launchPath, prepared.request);
  let launches = 0, fingerprints = 0;
  t.mock.method(processes, 'launchDispatched', async () => { launches++; return { outcome: 'succeeded', identity }; });
  const readFile = fsSync.readFileSync;
  t.mock.method(fsSync, 'readFileSync', (file, ...args) => {
    if (file === '/proc/' + wrapperPid + '/cmdline') return Buffer.from('node\0' + launchPath + '\0');
    if (file !== '/proc/' + childPid + '/stat') return readFile(file, ...args);
    fingerprints++;
    fsSync.writeFileSync(path.join(spool, 'chunks', protocol.processChunkFileName(1n, 'stdout')), output);
    writeJson(path.join(spool, protocol.PROCESS_WRAPPER_MANIFEST_FILE), manifest);
    writeJson(path.join(spool, protocol.PROCESS_WRAPPER_EXIT_RECEIPT_FILE), exit);
    throw Object.assign(new Error('ESRCH: no such process, read'), { code: 'ESRCH' });
  });
  const dispatched = await processes.dispatchStart(prepared.effect.effectIntentId, 5_000);
  assert.equal(fingerprints, 1);
  assert.equal(launches, 1);
  assert.equal(dispatched.observation.foreground.state, 'exited');
  assert.equal(dispatched.terminal.status, 'succeeded');
  const [process] = await rows('Process', { id: prepared.request.processId });
  const [receipt] = await rows('EffectReceipt', { attempt_id: prepared.effect.attemptId });
  const [outcome] = await rows('ToolOutcome', { tool_call_id: 'process-race-call' });
  const [artifact] = await rows('ToolResultArtifact', { tool_call_id: 'process-race-call', role: 'model_response' });
  assert.equal(process.status, 'exited');
  assert.equal(process.retained_chunks, 1n);
  assert.equal((await readBody(outcome.content_object_id)).detail.stdout, output);
  assert.equal((await readBody(artifact.content_object_id)).detail.stdout, output);
  assert.equal((await processes.reconcileStartReceipt(receipt.id)).toolModelResultId, dispatched.terminal.toolModelResultId);
  assert.equal((await rows('EffectReceipt', { attempt_id: prepared.effect.attemptId })).length, 1);
  assert.equal(launches, 1);
});
