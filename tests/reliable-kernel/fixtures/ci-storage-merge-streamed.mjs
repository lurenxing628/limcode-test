import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  compiled, createConfigurationRoot, initializeScope, removeConfigurationRoot,
  Database, kernel, kernelFile, modelRequestAggregate, NOW, repo
} from './runtime-merge-fixture.mjs';

const { mergeHistoricalDataSetsOnline } = kernelFile('runtimeDataSetMerge.js');
const { prepareLargeMergeSources, runLargeMergeSession } = kernelFile('runtimeDataSetStreamedMerge.js');
const { withRuntimeDataRootAdmission, withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');
const { preparedContentObjectSteps } = kernelFile('contentObjectTransaction.js');
export const OPTIONS = { sizeLimits: { transactionRows: 0 }, chunkRows: 7 };
export const conversation = id => ({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW });
export const turn = id => ({ id: `${id}_turn`, conversation_id: id, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW });
export const termination = id => ({ id: `${id}_termination`, turn_id: `${id}_turn`, terminal_status: 'completed', reason: 'fixture', created_at: NOW });
const MESSAGE = 'application/vnd.limcode.message+json';

// One configuration root for the suite. A streamed session still closes the ordinary writer and
// opens the real maintenance writer; caching never crosses that production lifecycle boundary.
export async function createStreamFixture() {
  const fixture = await createConfigurationRoot({ beta: true });
  let writer, next = 0;
  return Object.assign(fixture, {
    async writer() {
      writer ??= await kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: 'ci-streamed-current' });
      return writer;
    },
    async closeCurrent() { if (writer) { const closing = writer; writer = undefined; await closing.close(); } },
    source: name => initializeScope(fixture.paths, `ci-streamed-${name}-${++next}`),
    async prepare(sources, options = {}) {
      return prepareLargeMergeSources({ paths: fixture.paths,
        target: { configurationRootPath: fixture.root, database: await this.writer() },
        candidateIds: sources.map(source => source.id), requested: true, options: { ...OPTIONS, ...options } });
    },
    async run(prepared, options = {}, signal) {
      await this.closeCurrent();
      return withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
        () => runLargeMergeSession({ paths: fixture.paths, prepared, options, ...(signal ? { signal } : {}) })));
    },
    async online(source, options = {}) {
      return mergeHistoricalDataSetsOnline(fixture.paths,
        { configurationRootPath: fixture.root, database: await this.writer() },
        { candidateIds: [source.id], requested: true, ...options });
    },
    async dispose() { await this.closeCurrent(); await removeConfigurationRoot(fixture.root); }
  });
}

export async function seedBare(source, ids) {
  const writer = await kernel.RuntimeDatabase.open(source.authority, { hostBootId: 'ci-streamed-seed' });
  try { await writer.transaction(ids.map(id => repo('Conversation').insert(conversation(id)))); }
  finally { await writer.close(); }
}

// Mixed storage and one complete model aggregate are enough to exercise the real copy path. The
// source is generated once, with no scale loop, synthetic provider or repeated Runtime startup.
export async function seedRich(source, prefix, { partial = false } = {}) {
  const writer = await kernel.RuntimeDatabase.open(source.authority, { hostBootId: 'ci-streamed-rich' });
  try {
    const packed = kernel.ContentAddressedStore.forDatabase(source.authority, writer);
    const loose = kernel.ContentAddressedStore.loose(source.authority, source.binding);
    const ids = [`${prefix}_healthy`, `${prefix}_peer`, ...(partial ? [`${prefix}_conflict`, `${prefix}_child`, `${prefix}_invalid`] : [])];
    const bodies = [
      await packed.prepare(writer, JSON.stringify({ role: 'user', parts: [{ text: `${prefix} packed` }] }), MESSAGE),
      await loose.prepare(writer, JSON.stringify({ role: 'user', parts: [{ text: `${prefix} loose` }] }), MESSAGE),
      await packed.prepare(writer, JSON.stringify({ kind: 'reliable-agent-turn', conversationId: ids[0],
        turnId: `${ids[0]}_turn`, modelHandleCatalog: { entries: [] }, tools: [] }), 'application/json')
    ];
    if (partial) bodies.push(await packed.prepare(writer, JSON.stringify({ kind: 'reliable-agent-turn', conversationId: ids[4],
      turnId: `${ids[4]}_turn`, modelHandleCatalog: { entries: [] }, tools: [] }), 'application/json'));
    const payload = await packed.prepare(writer, `payload ${prefix}`, 'text/vnd.limcode.collaboration-message');
    const steps = [...preparedContentObjectSteps([...bodies, payload], `${prefix}_body`)];
    for (const id of ids) steps.push(repo('Conversation').insert(conversation(id)), repo('Turn').insert(turn(id)), repo('TurnTermination').insert(termination(id)));
    for (const [index, body] of bodies.slice(0, 2).entries()) {
      const message = `${prefix}_message_${index}`;
      steps.push(
        repo('Message').insert({ id: message, created_at: NOW, updated_at: NOW, deleted_at: null }),
        repo('MessageRevision').insert({ id: `${message}_revision`, message_id: message, revision_seq: 1n, role: 'user', content_object_id: body.metadata.id, created_at: NOW }),
        repo('MessageCurrentRevisionLink').insert({ id: `${message}_current`, message_id: message, revision_id: `${message}_revision`, updated_at: NOW }),
        repo('MessagePartOfConversation').insert({ id: `${message}_member`, conversation_id: ids[0], message_id: message, message_seq: BigInt(index + 1), created_at: NOW })
      );
    }
    const requestId = `${prefix}_request`;
    steps.push(...modelRequestAggregate(`${ids[0]}_turn`, requestId, 1n,
      { recipe: bodies[2].metadata.id, body: bodies[0].metadata.id, checkpoints: 2 }));
    const collaboration = `${prefix}_collaboration`;
    steps.push(
      repo('CollaborationMessage').insertWithNextSequence({ id: collaboration, dedupe_key: collaboration, mode: 'message', created_at: NOW }, { column: 'message_seq', scope: {} }),
      repo('CollaborationMessageSourceLink').insert({ id: `${collaboration}_source`, message_id: collaboration, conversation_id: ids[0], source_kind: 'tool', source_key: collaboration, turn_id: `${ids[0]}_turn`, tool_call_id: null, board_post_id: null, created_at: NOW }),
      repo('RuntimeInboxItem').insert({ id: `${collaboration}_inbox`, dedupe_key: collaboration, source_kind: 'collaboration_message', source_id: collaboration, state: 'routed', created_at: NOW, updated_at: NOW }),
      repo('CollaborationMessageTargetLink').insert({ id: `${collaboration}_target`, message_id: collaboration, conversation_id: ids[1], inbox_item_id: `${collaboration}_inbox`, anchor_turn_id: null, created_at: NOW }),
      repo('CollaborationMessagePayloadLink').insert({ id: `${collaboration}_payload`, message_id: collaboration, content_object_id: payload.metadata.id, created_at: NOW }),
      repo('RuntimeInboxPayloadLink').insert({ id: `${collaboration}_inbox_payload`, inbox_item_id: `${collaboration}_inbox`, content_object_id: payload.metadata.id, created_at: NOW })
    );
    if (partial) {
      steps.push(repo('ConversationOriginLink').insert({ id: `${prefix}_origin`, conversation_id: ids[3], source_conversation_id: ids[2], source_turn_id: `${ids[2]}_turn`, source_tool_call_id: null, source_message_revision_id: null, created_at: NOW }));
      steps.push(...modelRequestAggregate(`${ids[4]}_turn`, `${prefix}_invalid_request`, 1n,
        { recipe: bodies[3].metadata.id, body: bodies[0].metadata.id, checkpoints: 1 }));
    }
    await writer.transaction(steps);
    return { ids, requestId, bodies: bodies.slice(0, 2).map(body => body.metadata), expectedBodies: [
      JSON.stringify({ role: 'user', parts: [{ text: `${prefix} packed` }] }),
      JSON.stringify({ role: 'user', parts: [{ text: `${prefix} loose` }] })
    ] };
  } finally { await writer.close(); }
}

export function raw(source, operation) {
  const db = new Database(source.binding.paths.databasePath);
  try { db.pragma('foreign_keys = ON'); return db.transaction(() => operation(db))(); }
  finally { db.close(); }
}

export function runCrashChild(fixture, source, temporary) {
  const script = path.resolve('tests/reliable-kernel/runtime-dataset-merge-streamed-child.mjs');
  return new Promise(resolve => execFile(process.execPath, [script, fixture.root, JSON.stringify({
    ...OPTIONS, candidateIds: [source.id], requested: true, fault: { point: 'after-commit' }
  })], { env: { ...process.env, LIMCODE_TEST_EXTENSION_ROOT: compiled, TMPDIR: temporary }, maxBuffer: 1024 * 1024 },
  (error, stdout, stderr) => resolve({ code: error?.code ?? 0, signal: error?.signal ?? null, stdout, stderr })));
}

export async function assertMixedBodies(assert, source, info, database, targetAuthority) {
  const packedFile = kernelFile('packedCasWorkerProtocol.js').PACKED_CAS_FILE;
  assert.ok((await fs.stat(path.join(source.binding.paths.casRootPath, packedFile))).isFile());
  assert.ok((await fs.stat(path.join(source.binding.paths.casRootPath, ...info.bodies[1].storage_key.split('/')))).isFile());
  const store = kernel.ContentAddressedStore.forDatabase(targetAuthority, database);
  for (const [index, body] of info.bodies.entries()) {
    const [copied] = (await database.snapshot([repo('ContentObject').get(body.id)])).snapshot;
    assert.equal((await store.read(copied)).toString(), info.expectedBodies[index]);
  }
}
