// Shared fixtures of the large-merge tests: configuration roots with a selected data set and merge
// sources, Repository-written source content (ModelRequest aggregates as historical copies,
// collaboration messages, content identities, child Agents) and a synthetic source generator.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve('dist/extension');
export const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
export const kernel = kernelFile('index.js');
export const Database = require('better-sqlite3');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { projectFolderAssignmentSteps } = kernelFile('conversationProject.js');
const { attachmentObservationLinkId } = kernelFile('attachmentObservations.js');
const { stablePhaseDId } = kernelFile('effectControlPlane.js');
const { RUNTIME_DOMAIN_SCHEMAS } = kernelFile('schema/domainManifest.js');
const {
  resolveVscodeRuntimeDataRoot, resolveVscodeRuntimeMergeLedgerRoot, resolveVscodeWorkspaceRuntimeScope,
  resolveVscodeWorkspaceRuntimeScopeRoot, selectVscodeRuntimeDataSet
} = kernelFile('vscodeRootAuthority.js');

export const NOW = '2026-09-26T00:00:00.000Z';
export const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
export const SHARED_PROJECT = { uri: 'file:///workspace/shared', name: 'shared' };
export const SHARED_TEXT = JSON.stringify({ role: 'user', parts: [{ text: '各工作区都用过的同一段正文' }] });
export const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);

/** A configuration root with the fixed root selected and workspace data sets `alpha` (and `beta`). */
export async function createConfigurationRoot(options = {}) {
  const root = await fs.mkdtemp(path.join(options.tmp ?? os.tmpdir(), 'limcode-large-merge-'));
  const paths = { globalStoragePath: root };
  const current = await initialize(root, 'default');
  const alpha = await initializeScope(paths, 'alpha');
  const beta = options.beta ? await initializeScope(paths, 'beta') : undefined;
  await selectVscodeRuntimeDataSet(paths, 'default');
  return { root, paths, current, alpha, beta };
}

/**
 * Removes a configuration root and what its claims leave beside it: `<root>.runtime-admission` and
 * the tombstones of claims whose process was killed (`<root>.runtime-admission.generation-dead-*`,
 * kept there by design so stale contenders collide), which would otherwise pile up in the temp directory.
 */
export async function removeConfigurationRoot(root) {
  await fs.rm(root, { recursive: true, force: true });
  const prefix = `${path.basename(root)}.runtime-`;
  for (const name of await fs.readdir(path.dirname(root)).catch(() => [])) {
    if (name.startsWith(prefix)) await fs.rm(path.join(path.dirname(root), name), { recursive: true, force: true });
  }
}

export async function initializeScope(paths, name) {
  const scope = resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: [`file:///workspace/${name}`] });
  const scopeRoot = resolveVscodeWorkspaceRuntimeScopeRoot(paths, scope);
  await fs.mkdir(scopeRoot, { recursive: true });
  return initialize(scopeRoot, `workspace:${scope.key}`);
}

async function initialize(scopeRoot, id) {
  const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot }));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  return { id, scopeRoot, authority, binding };
}

export async function withRuntime(dataSet, run) {
  const runtime = await kernel.RuntimeDatabase.open(dataSet.authority, { hostBootId: `seed-${randomUUID()}` });
  try {
    return await run(runtime, kernel.ContentAddressedStore.loose(dataSet.authority, dataSet.binding));
  } finally { await runtime.close(); }
}

export function messageText(conversationId, index) {
  return JSON.stringify({ role: 'user', parts: [{ text: `${conversationId} 的第 ${index} 条消息` }] });
}

/** One terminated Turn per Conversation, an own message and the shared one. */
export async function seedConversations(dataSet, specs) {
  await withRuntime(dataSet, async (runtime, store) => {
    const shared = await store.ingest(runtime, SHARED_TEXT, MESSAGE_TYPE);
    for (const spec of specs) {
      const own = await store.ingest(runtime, messageText(spec.id, 0), MESSAGE_TYPE);
      await runtime.transaction(conversationSteps(spec, [own.id, shared.id]));
    }
  });
}

function conversationSteps(spec, contentIds) {
  const turnId = `${spec.id}_turn`;
  const steps = [
    repo('Conversation').insert({ id: spec.id, title: spec.title ?? spec.id, status: 'active', created_at: NOW, updated_at: NOW }),
    ...projectFolderAssignmentSteps({ conversationId: spec.id, folder: spec.project ?? SHARED_PROJECT, now: NOW }),
    repo('Turn').insert({ id: turnId, conversation_id: spec.id, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
    repo('TurnTermination').insert({ id: `${spec.id}_termination`, turn_id: turnId, terminal_status: 'completed', reason: 'fixture', created_at: NOW })
  ];
  for (const [index, contentId] of contentIds.entries()) {
    const messageId = `${spec.id}_message_${index}`;
    steps.push(
      repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
      repo('MessageRevision').insert({ id: `${messageId}_revision`, message_id: messageId, revision_seq: 1n, role: 'user', content_object_id: contentId, created_at: NOW }),
      repo('MessageCurrentRevisionLink').insert({ id: `${messageId}_current`, message_id: messageId, revision_id: `${messageId}_revision`, updated_at: NOW }),
      repo('MessagePartOfConversation').insert({
        id: `${messageId}_member`, conversation_id: spec.id, message_id: messageId, message_seq: BigInt(index + 1), created_at: NOW
      })
    );
  }
  return steps;
}

/** A historical ModelRequest aggregate: Operation, Attempt, request, checkpoints and (completed) fence. */
export function modelRequestAggregate(turnId, id, seq, { recipe, body, checkpoints, completed = true }) {
  const status = completed ? 'completed' : 'cancelled';
  const steps = [
    repo('Operation').insertHistoricalCopy({
      id: `${id}_operation`, owner_kind: 'model_request', owner_id: id, operation_seq: 1n, tool_call_id: null, status, created_at: NOW, updated_at: NOW
    }),
    repo('Attempt').insertHistoricalCopy({
      id: `${id}_attempt`, operation_id: `${id}_operation`, attempt_seq: 1n, status, created_at: NOW, updated_at: NOW, completed_at: NOW
    }),
    repo('ModelRequest').insertHistoricalCopy({
      id, turn_id: turnId, request_seq: seq, status: 'terminal', terminal_state: completed ? 'completed' : 'turn-interrupt-requested',
      provider_id: 'openai-responses', model_id: 'gpt-test', context_window_tokens: 130_000n, compression_threshold_tokens: 100_000n,
      estimated_context_tokens: 1_000n, authority_snapshot_id: 'authority-merge', settings_snapshot_object_id: null, recipe_object_id: recipe,
      usage_json: null, stream_stats_json: { attemptSeq: '1', socketGeneration: '0', retryReason: null }, created_at: NOW, updated_at: NOW
    })
  ];
  for (let index = 1; index <= checkpoints; index += 1) {
    steps.push(repo('ModelStreamCheckpoint').insertHistoricalCopy({
      id: `${id}_checkpoint_${index}`, model_request_id: id, attempt_seq: 1n, socket_generation: 0n,
      stream_seq: BigInt(index), checkpoint_kind: 'output_delta', content_object_id: body, created_at: NOW
    }));
  }
  if (completed) {
    steps.push(repo('ModelStreamFence').insertHistoricalCopy({
      id: `${id}_fence`, model_request_id: id, attempt_seq: 1n, socket_generation: 0n, terminal_stream_seq: BigInt(checkpoints),
      outcome: 'completed', created_at: NOW
    }));
  }
  return steps;
}

/** Collaboration messages (their message_seq is renumbered by a merge) with inbox items. */
export async function seedCollaborationMessages(dataSet, fromConversationId, toConversationId, ids) {
  await withRuntime(dataSet, async (runtime, store) => {
    for (const id of ids) {
      const payload = await store.ingest(runtime, `hello from ${id}`, 'text/vnd.limcode.collaboration-message');
      const inboxItemId = `${id}_inbox`;
      await runtime.transaction([
        repo('CollaborationMessage').insertWithNextSequence({ id, dedupe_key: `dedupe-${id}`, mode: 'message', created_at: NOW }, { column: 'message_seq', scope: {} }),
        repo('CollaborationMessageSourceLink').insert({
          id: `${id}_source`, message_id: id, conversation_id: fromConversationId, source_kind: 'tool', source_key: `source-${id}`,
          turn_id: `${fromConversationId}_turn`, tool_call_id: null, board_post_id: null, created_at: NOW
        }),
        repo('RuntimeInboxItem').insert({ id: inboxItemId, dedupe_key: `dedupe-${id}`, source_kind: 'collaboration_message', source_id: id, state: 'routed', created_at: NOW, updated_at: NOW }),
        repo('CollaborationMessageTargetLink').insert({ id: `${id}_target`, message_id: id, conversation_id: toConversationId, inbox_item_id: inboxItemId, anchor_turn_id: null, created_at: NOW }),
        repo('CollaborationMessagePayloadLink').insert({ id: `${id}_payload`, message_id: id, content_object_id: payload.id, created_at: NOW }),
        repo('RuntimeInboxPayloadLink').insert({ id: `${id}_inbox_payload`, inbox_item_id: inboxItemId, content_object_id: payload.id, created_at: NOW })
      ]);
    }
  });
}

/** The same attachment (a content identity) with its observation, as another window would record it. */
export async function seedAttachmentObservation(dataSet, createdAt, observationText, conversationId) {
  await withRuntime(dataSet, async (runtime, store) => {
    const imageBytes = Buffer.from('same screenshot bytes in both workspaces');
    const image = await store.ingest(runtime, imageBytes, 'image/png');
    const observation = await store.ingest(runtime, observationText, 'text/plain');
    const imageSha = sha256(imageBytes);
    const attachmentId = stablePhaseDId('attachment', JSON.stringify([imageSha, 'image/png', 'shot.png']));
    const profile = sha256('analysis-profile');
    await runtime.transaction([
      repo('Attachment').insert({
        id: attachmentId, sha256: imageSha, byte_length: String(imageBytes.length), mime_type: 'image/png',
        name: 'shot.png', storage_mode: 'cas', content_object_id: image.id, created_at: createdAt
      }),
      repo('AttachmentObservationLink').insert({
        id: attachmentObservationLinkId(attachmentId, profile), attachment_id: attachmentId,
        analysis_profile_sha256: profile, content_object_id: observation.id, created_at: createdAt
      }),
      ...(conversationId ? [repo('ConversationAttachmentHandleLink').insert({
        id: `${conversationId}_attachment_handle`, conversation_id: conversationId, attachment_id: attachmentId, handle_seq: 1n, created_at: createdAt
      })] : [])
    ]);
  });
}

/**
 * A source with everything a merge treats specially: `count` conversations, each with a completed
 * (checkpoints and fence) and a cancelled historical ModelRequest aggregate, collaboration messages
 * between them, a content identity shared with the target (project, message body, attachment) and a
 * child Agent. Deterministic ids under `prefix`.
 */
export async function seedRichSource(dataSet, prefix, count = 4) {
  const ids = Array.from({ length: count }, (_, index) => `${prefix}_conversation_${index}`);
  await seedConversations(dataSet, ids.map((id) => ({ id })));
  await withRuntime(dataSet, async (runtime, store) => {
    const recipe = await store.ingest(runtime, '{}', 'application/json');
    const body = await store.ingest(runtime, JSON.stringify({ role: 'model', parts: [{ text: '检查点' }] }), MESSAGE_TYPE);
    for (const id of ids) {
      await runtime.transaction([
        ...modelRequestAggregate(`${id}_turn`, `${id}_request_completed`, 1n, { recipe: recipe.id, body: body.id, checkpoints: 3 }),
        ...modelRequestAggregate(`${id}_turn`, `${id}_request_cancelled`, 2n, { recipe: recipe.id, body: body.id, checkpoints: 1, completed: false })
      ]);
    }
  });
  await seedCollaborationMessages(dataSet, ids[0], ids[1], [`${prefix}_collaboration_1`, `${prefix}_collaboration_2`]);
  await seedAttachmentObservation(dataSet, '2026-09-20T00:00:00.000Z', `${prefix} observed`, ids[0]);
  // A child Agent of the first conversation working in the second, as the Runtime records it.
  rawWrite(dataSet, (source) => {
    const childTurn = `${ids[1]}_task_turn`;
    source.prepare('INSERT INTO child_execution VALUES (?, ?, ?, ?, ?)').run(`${prefix}_child_exec`, ids[1], 'idle', NOW, NOW);
    source.prepare('INSERT INTO child_execution_parent_link VALUES (?, ?, ?, ?, ?, ?)')
      .run(`${prefix}_child_parent_link`, `${prefix}_child_exec`, `${prefix}_tool_call_spawn`, null, `${ids[0]}_turn`, NOW);
    source.prepare('INSERT INTO turn VALUES (?, ?, ?, ?, ?, ?)').run(childTurn, ids[1], 'terminated', NOW, NOW, NOW);
    source.prepare('INSERT INTO turn_termination VALUES (?, ?, ?, ?, ?)').run(`${childTurn}_termination`, childTurn, 'completed', 'fixture', NOW);
    source.prepare('INSERT INTO child_execution_turn_link VALUES (?, ?, ?, ?, ?)').run(`${prefix}_child_turn_link`, `${prefix}_child_exec`, 1, childTurn, NOW);
    source.prepare('INSERT INTO answer_bridge VALUES (?, ?, ?, ?, ?, ?)').run(`${prefix}_bridge`, `${prefix}_child_exec`, null, 'open', NOW, NOW);
  });
  return ids;
}

/**
 * A synthetic source of about `rows` rows written through Repositories, in transactions of about
 * 2,000 rows: conversations with a Turn, ten messages over a few shared bodies and four historical
 * ModelRequest aggregates each (63 rows per conversation). Returns the rows written.
 */
export async function generateSyntheticSource(dataSet, { rows, prefix = 'synthetic' }) {
  const perConversation = 3 + 10 * 4 + 4 * 5;
  const conversations = Math.max(1, Math.ceil(rows / perConversation));
  let written = 0;
  await withRuntime(dataSet, async (runtime, store) => {
    const bodies = [];
    for (let index = 0; index < 8; index += 1) bodies.push((await store.ingest(runtime, messageText(prefix, index), MESSAGE_TYPE)).id);
    const recipe = (await store.ingest(runtime, '{}', 'application/json')).id;
    let steps = [];
    for (let c = 0; c < conversations; c += 1) {
      const id = `${prefix}_${String(c).padStart(7, '0')}`;
      const turnId = `${id}_turn`;
      steps.push(
        repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
        repo('Turn').insert({ id: turnId, conversation_id: id, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
        repo('TurnTermination').insert({ id: `${id}_termination`, turn_id: turnId, terminal_status: 'completed', reason: 'fixture', created_at: NOW })
      );
      for (let m = 0; m < 10; m += 1) {
        const messageId = `${id}_m${m}`;
        steps.push(
          repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
          repo('MessageRevision').insert({ id: `${messageId}_r`, message_id: messageId, revision_seq: 1n, role: 'user', content_object_id: bodies[(c + m) % bodies.length], created_at: NOW }),
          repo('MessageCurrentRevisionLink').insert({ id: `${messageId}_c`, message_id: messageId, revision_id: `${messageId}_r`, updated_at: NOW }),
          repo('MessagePartOfConversation').insert({ id: `${messageId}_p`, conversation_id: id, message_id: messageId, message_seq: BigInt(m + 1), created_at: NOW })
        );
      }
      for (let r = 0; r < 4; r += 1) {
        steps.push(...modelRequestAggregate(turnId, `${id}_q${r}`, BigInt(r + 1), { recipe, body: bodies[r], checkpoints: 1, completed: true }));
      }
      written += perConversation;
      if (steps.length >= 2_000 || c === conversations - 1) {
        await runtime.transaction(steps);
        steps = [];
      }
    }
  });
  return written;
}

/** Writes constructed rows straight into an offline data set (states no public API produces). */
export function rawWrite(dataSet, write) {
  const database = new Database(dataSet.binding.paths.databasePath);
  try {
    database.pragma('foreign_keys = ON');
    const contentId = database.prepare('SELECT id FROM content_object WHERE sha256 = ?').pluck().get(sha256(SHARED_TEXT));
    database.exec('BEGIN IMMEDIATE');
    write(database, contentId);
    database.exec('COMMIT');
    const violations = database.pragma('foreign_key_check');
    if (violations.length > 0) throw new Error(`foreign key violations: ${JSON.stringify(violations)}`);
    database.pragma('wal_checkpoint(TRUNCATE)');
  } finally { database.close(); }
}

/**
 * Every row of every Runtime domain table, ordered by id (integers as decimal strings, BLOBs as hex). A
 * historical merge's commit markers (one per commit, keyed by its random commit id) count, not show.
 */
export function readAll(dataSet) {
  const reader = new Database(dataSet.binding.paths.databasePath, { readonly: true });
  try {
    reader.defaultSafeIntegers(true);
    const all = {};
    for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
      const found = reader.prepare(`SELECT * FROM "${schema.table}" ORDER BY id`).all();
      const markers = found.filter((row) => schema.table === 'command_receipt' && row.source_kind === 'internal'
        && String(row.source_key).startsWith('historical-merge-commit:'));
      const rows = found.filter((row) => !markers.includes(row))
        .map((row) => JSON.stringify(row, (_key, value) => typeof value === 'bigint' ? `${value}n`
          : value?.type === 'Buffer' && Array.isArray(value.data) ? Buffer.from(value.data).toString('hex') : value));
      if (markers.length > 0) rows.push(`historical merge commit markers: ${markers.length}`);
      if (rows.length > 0) all[schema.table] = rows;
    }
    return all;
  } finally { reader.close(); }
}

/** Imported-source row accounting excludes commit markers and receiving-root derived handle authority. */
export function countRows(dataSet) {
  const reader = new Database(dataSet.binding.paths.databasePath, { readonly: true });
  try {
    return RUNTIME_DOMAIN_SCHEMAS
      .filter(schema => schema.key !== 'ConversationContextHandleState' && schema.key !== 'ContextRootHandleCatalog')
      .reduce((sum, schema) => sum + Number(reader.prepare(`SELECT COUNT(*) FROM "${schema.table}"${schema.table === 'command_receipt'
      ? " WHERE NOT (source_kind = 'internal' AND source_key LIKE 'historical-merge-commit:%')" : ''}`).pluck().get()), 0);
  } finally { reader.close(); }
}

/** The target's SQLite files (closed) and the whole merge ledger, to be put back exactly. */
export async function saveState(fixture, dataSet) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-large-merge-saved-'));
  const database = dataSet.binding.paths.databasePath;
  for (const suffix of ['', '-wal']) {
    await fs.copyFile(`${database}${suffix}`, path.join(directory, `db${suffix}`)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
  const ledger = resolveVscodeRuntimeMergeLedgerRoot(fixture.paths);
  await fs.cp(ledger, path.join(directory, 'ledger'), { recursive: true }).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  return {
    async restore() {
      for (const suffix of ['', '-wal', '-shm']) await fs.rm(`${database}${suffix}`, { force: true });
      for (const suffix of ['', '-wal']) {
        await fs.copyFile(path.join(directory, `db${suffix}`), `${database}${suffix}`).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      }
      await fs.rm(ledger, { recursive: true, force: true });
      await fs.cp(path.join(directory, 'ledger'), ledger, { recursive: true }).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    },
    remove: () => fs.rm(directory, { recursive: true, force: true })
  };
}

export async function readLedgerRecord(fixture, candidateId) {
  const file = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'records', `${candidateId.replace(/:/g, '-')}.json`);
  return fs.readFile(file, 'utf8').then(JSON.parse, () => undefined);
}

export async function ledgerEntries(fixture, section) {
  return fs.readdir(path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), section)).then(
    (names) => names.filter((name) => name.endsWith('.json')).sort(), () => []);
}

/** Every file below `root` with its size and SHA-256 (the source must stay byte for byte). */
export async function treeSnapshot(root) {
  const files = {};
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else files[path.relative(root, file)] = { size: (await fs.stat(file)).size, sha256: sha256(await fs.readFile(file)) };
    }
  }
  await visit(root);
  return files;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
