import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
export const loadRelocationModule = file => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = loadRelocationModule('index.js');
const Database = require('better-sqlite3');
const relocation = loadRelocationModule('runtimeDataRootRelocation.js');
const schema = loadRelocationModule('databaseSchema.js');
const { resolveVscodeRuntimeDataRoot, selectVscodeRuntimeDataSet } = loadRelocationModule('vscodeRootAuthority.js');
const { projectFolderAssignmentSteps } = loadRelocationModule('conversationProject.js');
const { emptyConversationContextHandleStateStep, pendingConversationContextHandleStateSteps } = loadRelocationModule('conversationContextHandleState.js');
const { timelineImportProvenanceRow } = loadRelocationModule('timelinePosition.js');
const { PACKED_CAS_FILE } = loadRelocationModule('packedCasWorkerProtocol.js');
const repo = domain => kernel.DOMAIN_REPOSITORIES.domain(domain);
const NOW = '2026-10-13T00:00:00.000Z';
const PROJECT = { uri: 'file:///workspace/relocation', name: 'relocation' };
const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
const shared = 'conversation_current_1';
const imported = 'conversation_current_2';
const existing = 'conversation_existing_1';
const preservedDomains = [['conversation', 'Conversation'], ['message_revision', 'MessageRevision'],
  ['message_current_revision_link', 'MessageCurrentRevisionLink'], ['message_part_of_conversation', 'MessagePartOfConversation'],
  ['conversation_context_handle_state', 'ConversationContextHandleState'], ['collaboration_send_timeline_link', 'CollaborationSendTimelineLink'],
  ['timeline_import_provenance', 'TimelineImportProvenance']];
const plainRow = row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
  [key, typeof value === 'bigint' ? value.toString() : value]));

function rowsAt(databasePath) {
  const reader = new Database(databasePath, { readonly: true });
  try {
    reader.defaultSafeIntegers(true);
    return Object.fromEntries(preservedDomains.map(([table]) => [table,
      reader.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map(plainRow)]));
  } finally { reader.close(); }
}

async function liveRowsAt(database) {
  const { snapshot } = await database.snapshot(preservedDomains.map(([, domain]) =>
    repo(domain).list({ limit: 64, orderBy: { column: 'id', direction: 'asc' } })));
  return Object.fromEntries(preservedDomains.map(([table], index) => [table, snapshot[index].map(plainRow)]));
}

function packedBodiesAt(casRoot) {
  const reader = new Database(path.join(casRoot, PACKED_CAS_FILE), { readonly: true });
  try {
    return reader.prepare('SELECT hex(digest) AS digest, hex(body) AS bytes FROM cas_body ORDER BY digest').all();
  } finally { reader.close(); }
}

async function initialize(root) {
  await fs.mkdir(root);
  const authority = new kernel.RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: root }));
  const binding = await authority.initializeEmptyRoot(async value => {
    await fs.mkdir(value.paths.casRootPath);
    const database = new Database(value.paths.databasePath);
    try {
      schema.configureWriterConnection(database);
      schema.initializeCurrentSchema(database, value);
    } finally { database.close(); }
  });
  await selectVscodeRuntimeDataSet({ globalStoragePath: root }, 'default');
  return { root, authority, binding };
}

async function seed(dataSet, database, conversations, source) {
  const store = kernel.ContentAddressedStore.forDatabase(dataSet.authority, database);
  const sends = source ? ['relocation_new_send', 'relocation_roundtrip_send'] : ['relocation_existing_send'];
  const texts = conversations.map(id => JSON.stringify({ role: 'user', parts: [{ text: `${id} 的正文` }] }));
  const prepared = await store.prepareBatch(database, [
    ...texts.map(content => ({ content, contentType: MESSAGE_TYPE })),
    ...sends.map(id => ({ content: `hello from ${id}`, contentType: 'text/vnd.limcode.collaboration-message' }))
  ]);
  const bodies = prepared.slice(0, conversations.length).map(({ metadata }, index) => ({ id: metadata.id,
    storageKey: metadata.storage_key, digest: metadata.sha256, text: texts[index] }));
  const steps = prepared.flatMap(entry => entry.insert ? [entry.insert] : []);
  for (const [index, id] of conversations.entries()) {
    const body = prepared[index].metadata;
    const message = `${id}_message`;
    steps.push(
      repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
      ...projectFolderAssignmentSteps({ conversationId: id, folder: PROJECT, now: NOW }),
      repo('Message').insert({ id: message, created_at: NOW, updated_at: NOW, deleted_at: null }),
      repo('MessageRevision').insert({ id: `${message}_revision`, message_id: message, revision_seq: 1n,
        role: 'user', content_object_id: body.id, created_at: NOW }),
      repo('MessageCurrentRevisionLink').insert({ id: `${message}_current`, message_id: message,
        revision_id: `${message}_revision`, updated_at: NOW }),
      repo('MessagePartOfConversation').insert({ id: `${message}_member`, conversation_id: id,
        message_id: message, message_seq: 1n, created_at: NOW })
    );
  }
  if (source) {
    steps.push(
      repo('ContextSequenceRoot').insert({ id: 'relocation_shared_root', conversation_id: shared, root_seq: 1n,
        root_node_id: null, tail_node_id: null, tail_segment_count: 0n, segment_count: 0n, estimated_tokens: 0n, created_at: NOW }),
      repo('ConversationContextHeadLink').insert({ id: 'relocation_shared_head', conversation_id: shared,
        root_id: 'relocation_shared_root', updated_at: NOW }),
      ...pendingConversationContextHandleStateSteps(shared, NOW, undefined, 'relocation_shared_root')
    );
  } else steps.push(emptyConversationContextHandleStateStep(shared, NOW));
  const from = source ? shared : existing;
  const to = source ? imported : shared;
  steps.push(
    repo('Turn').insert({ id: `${from}_turn`, conversation_id: from, status: 'terminated',
      created_at: NOW, updated_at: NOW, terminal_at: NOW }),
    repo('TurnTermination').insert({ id: `${from}_termination`, turn_id: `${from}_turn`,
      terminal_status: 'completed', reason: 'fixture', created_at: NOW })
  );
  for (const [index, id] of sends.entries()) {
    const payload = prepared[conversations.length + index].metadata;
    const inbox = `${id}_inbox`;
    steps.push(
      repo('CollaborationMessage').insertWithNextSequence({ id, dedupe_key: `dedupe-${id}`, mode: 'message',
        created_at: NOW }, { column: 'message_seq', scope: {} }),
      repo('CollaborationMessageSourceLink').insert({ id: `${id}_source`, message_id: id, conversation_id: from,
        source_kind: 'tool', source_key: `source-${id}`, turn_id: `${from}_turn`, tool_call_id: null, board_post_id: null, created_at: NOW }),
      repo('RuntimeInboxItem').insert({ id: inbox, dedupe_key: `dedupe-${id}`, source_kind: 'collaboration_message',
        source_id: id, state: 'routed', created_at: NOW, updated_at: NOW }),
      repo('CollaborationMessageTargetLink').insert({ id: `${id}_target`, message_id: id, conversation_id: to,
        inbox_item_id: inbox, anchor_turn_id: null, created_at: NOW }),
      repo('CollaborationMessagePayloadLink').insert({ id: `${id}_payload`, message_id: id, content_object_id: payload.id, created_at: NOW }),
      repo('RuntimeInboxPayloadLink').insert({ id: `${id}_inbox_payload`, inbox_item_id: inbox, content_object_id: payload.id, created_at: NOW })
    );
    const row = { id: `${id}_timeline`, conversation_id: from, message_id: id,
      predecessor_message_id: `${from}_message`, predecessor_message_seq: 1n,
      exchange_seq: BigInt(index + 1), position_basis: 'committed', created_at: NOW };
    const { exchange_seq, ...withoutSequence } = row;
    const provenance = timelineImportProvenanceRow(repo('CollaborationSendTimelineLink').insertHistoricalTimelineImport(withoutSequence, {
      sourceDataSetId: dataSet.binding.dataSetId, sourceRootInstanceId: dataSet.binding.rootInstanceId, sourceExchangeSeq: exchange_seq
    }));
    steps.push(repo('CollaborationSendTimelineLink').insertHistoricalCopy(row),
      ...(id === 'relocation_new_send' ? [] : [repo('TimelineImportProvenance').insertHistoricalCopy(provenance)]));
  }
  await database.transaction(steps);
  return bodies;
}

async function writeAgents(root, source) {
  const agents = [{ id: 'agent-shared', name: source ? 'source version' : 'target version' },
    { id: source ? 'agent-source-only' : 'agent-target-only', name: source ? 'only in source' : 'only in target' }];
  await fs.mkdir(path.join(root, 'agents', 'records'), { recursive: true });
  const records = [];
  for (const agent of agents) {
    const file = `records/${agent.id}.json`;
    await fs.writeFile(path.join(root, 'agents', file), `${JSON.stringify({ schemaVersion: 1, savedAt: NOW, agent })}\n`);
    records.push({ id: agent.id, file, updatedAt: NOW });
  }
  await fs.writeFile(path.join(root, 'agents', 'index.json'), `${JSON.stringify({ schemaVersion: 1, savedAt: NOW, records })}\n`);
  await fs.writeFile(path.join(root, 'AGENTS.md'), source ? '# source rules\n' : '# target rules\n');
}

const configPaths = ['AGENTS.md', 'agents/index.json', 'agents/records/agent-shared.json', 'agents/records/agent-target-only.json'];
async function configurationAt(root) {
  return Object.fromEntries(await Promise.all(configPaths.map(async relative => [relative, await fs.readFile(path.join(root, relative), 'utf8')])));
}

/** Seed through each root's writer once; the source owner also plans and stages the relocation. */
export async function createCommittedRelocationFixture(base) {
  const source = await initialize(path.join(base, 'old-home'));
  const target = await initialize(path.join(base, 'target'));
  const targetDatabase = await kernel.RuntimeDatabase.open(target.authority);
  try { await seed(target, targetDatabase, [existing, shared], false); }
  finally { await targetDatabase.close(); }
  const database = await kernel.RuntimeDatabase.open(source.authority);
  try {
    const sourceBodies = await seed(source, database, [shared, imported], true);
    await writeAgents(source.root, true);
    await writeAgents(target.root, false);
    const before = { rows: rowsAt(target.binding.paths.databasePath), configuration: await configurationAt(target.root),
      packedBodies: packedBodiesAt(target.binding.paths.casRootPath), packedInode: (await fs.stat(path.join(target.binding.paths.casRootPath, PACKED_CAS_FILE))).ino,
      sourceRows: await liveRowsAt(database) };
    const fixture = { root: source.root, target: target.root, relocationId: randomUUID(),
      sourceBinding: source.binding, targetBinding: target.binding, sourceBodies, before };
    await fs.writeFile(path.join(base, 'fixture.json'), JSON.stringify(fixture));
    return { source, target, fixture, database };
  } catch (error) { await database.close(); throw error; }
}

/** One committed merge interrupted before received, then one ordinary startup recovery. */
export async function runCommittedRelocationRecovery(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-ci-relocation-crash-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./ci-storage-relocation-crash-child.mjs', import.meta.url)), base],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { errors += text; });
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exit.signal, 'SIGKILL', errors || `child exited ${exit.code}`);
  const fixture = JSON.parse(await fs.readFile(path.join(base, 'fixture.json'), 'utf8'));
  const pointerFile = path.join(base, 'pointer.json');
  const pointerBefore = await fs.readFile(pointerFile, 'utf8');
  const pointer = JSON.parse(pointerBefore);
  assert.equal(pointer.dataRootPath, fixture.root);
  assert.equal(pointer.pendingRelocation.relocationId, fixture.relocationId);
  const work = path.join(fixture.target, relocation.DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY, fixture.relocationId);
  const journal = (await fs.readFile(path.join(work, 'journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const merging = journal.find(entry => entry.op === 'merging');
  assert.ok(merging);
  assert.equal(journal.some(entry => entry.op === 'received'), false);
  assert.equal(merging.updated.length, 1);
  assert.equal(merging.updated[0].before.state, 'ready');
  assert.equal(merging.updated[0].after.state, 'pending');
  assert.equal(merging.inserted.filter(([domain]) => domain === 'ConversationContextHandleState').length, 1);
  const provenance = merging.inserted.filter(([domain]) => domain === 'TimelineImportProvenance').map(([, id]) => id);
  assert.equal(provenance.length, 2);
  assert.equal(new Set(provenance).size, 2);
  assert.equal(provenance.includes(fixture.before.rows.timeline_import_provenance[0].id), false);
  assert.deepEqual(rowsAt(fixture.targetBinding.paths.databasePath).conversation.map(row => row.id), [shared, imported, existing]);
  const mergedConfiguration = await configurationAt(fixture.target);
  assert.deepEqual(JSON.parse(mergedConfiguration['agents/index.json']).records.map(record => record.id).sort(),
    ['agent-shared', 'agent-source-only', 'agent-target-only'], '按id合并配置并保留双方独有记录');
  assert.equal(mergedConfiguration['agents/records/agent-shared.json'],
    await fs.readFile(path.join(fixture.root, 'agents/records/agent-shared.json'), 'utf8'), '共有记录按来源版本覆盖');
  assert.equal(mergedConfiguration['agents/records/agent-target-only.json'],
    fixture.before.configuration['agents/records/agent-target-only.json'], '目标独有配置保持原字节');
  assert.equal(mergedConfiguration['AGENTS.md'], await fs.readFile(path.join(fixture.root, 'AGENTS.md'), 'utf8'),
    '来源全局规则已生效');
  const rulesBackup = journal.find(entry => entry.op === 'replace' && entry.path === 'AGENTS.md');
  assert.ok(rulesBackup, '被替换的全局规则登记在撤销日志中');
  assert.equal(await fs.readFile(path.join(work, rulesBackup.backup), 'utf8'), fixture.before.configuration['AGENTS.md'],
    '原目标全局规则已按日志位置保存原字节备份');
  const importedBody = fixture.sourceBodies[1];
  const packedBeforeRecovery = packedBodiesAt(fixture.targetBinding.paths.casRootPath);
  const assertPackedBody = (rows, body) => assert.equal(rows.find(row => row.digest === body.digest.toUpperCase())?.bytes,
    Buffer.from(body.text).toString('hex').toUpperCase());
  assertPackedBody(packedBeforeRecovery, importedBody);
  for (const body of fixture.before.packedBodies) assert.deepEqual(packedBeforeRecovery.find(row => row.digest === body.digest), body, '已有packed正文仍保持原字节');

  assert.equal(await relocation.recoverInterruptedDataRootRelocation({ targetRootPath: fixture.target,
    relocationId: fixture.relocationId }), 'recovered');
  await relocation.sweepDataRootRelocationLeftovers(fixture.root);
  assert.equal(await fs.readFile(pointerFile, 'utf8'), pointerBefore, '恢复不切换当前目录');
  assert.deepEqual(rowsAt(fixture.targetBinding.paths.databasePath), fixture.before.rows, '原消息、handle和provenance完整恢复');
  assert.deepEqual(await configurationAt(fixture.target), fixture.before.configuration);
  await assert.rejects(fs.stat(path.join(fixture.target, 'agents/records/agent-source-only.json')), { code: 'ENOENT' });
  const packedAfterRecovery = packedBodiesAt(fixture.targetBinding.paths.casRootPath);
  for (const body of fixture.before.packedBodies) assert.deepEqual(packedAfterRecovery.find(row => row.digest === body.digest), body);
  assertPackedBody(packedAfterRecovery, importedBody);
  assert.equal((await fs.stat(path.join(fixture.targetBinding.paths.casRootPath, PACKED_CAS_FILE))).ino, fixture.before.packedInode,
    '撤销不替换或截断接收packed容器，新导入正文保留为不可变orphan');
  const metadataReader = new Database(fixture.targetBinding.paths.databasePath, { readonly: true });
  try { assert.equal(metadataReader.prepare('SELECT id FROM content_object WHERE id = ?').get(importedBody.id), undefined); }
  finally { metadataReader.close(); }
  await assert.rejects(fs.stat(path.join(fixture.target, relocation.DATA_ROOT_RELOCATION_MARKER_FILE)), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(fixture.target, relocation.DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY)), { code: 'ENOENT' });
  assert.deepEqual(rowsAt(fixture.sourceBinding.paths.databasePath), fixture.before.sourceRows, '旧目录的消息和领域行保持原样');
  const sourcePacked = packedBodiesAt(fixture.sourceBinding.paths.casRootPath);
  for (const body of fixture.sourceBodies) assert.equal(sourcePacked.find(row => row.digest === body.digest.toUpperCase())?.bytes,
    Buffer.from(body.text).toString('hex').toUpperCase());
}
