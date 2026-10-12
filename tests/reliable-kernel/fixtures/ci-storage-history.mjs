import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
export const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
export const kernelFile = file => require(path.join(compiled, 'backend/reliableKernel', file));
export const kernel = kernelFile('index.js');
export const Database = require('better-sqlite3');
export const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);
export const NOW = '2026-10-13T00:00:00.000Z';
export const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
const roots = kernelFile('vscodeRootAuthority.js');
const schema = kernelFile('databaseSchema.js');

// Empty fixture roots need DDL, not a seed Runtime per root. Production initialization owns the binding.
export async function initializeRoot(scopeRoot, id = 'default') {
  const authority = new kernel.RootAuthority(() => roots.resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot }));
  const binding = await authority.initializeEmptyRoot(async value => {
    await fs.mkdir(value.paths.casRootPath, { recursive: true });
    const database = new Database(value.paths.databasePath);
    try { schema.configureWriterConnection(database); schema.initializeCurrentSchema(database, value); }
    finally { database.close(); }
  });
  return { id, scopeRoot, authority, binding };
}

export async function createHistoryFixture() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-ci-history-')));
  const root = path.join(base, 'current');
  const paths = { globalStoragePath: root };
  const current = await initializeRoot(root);
  const scope = roots.resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: ['file:///ci-history'] });
  const alpha = await initializeRoot(roots.resolveVscodeWorkspaceRuntimeScopeRoot(paths, scope), `workspace:${scope.key}`);
  await roots.selectVscodeRuntimeDataSet(paths, 'default');
  return { base, root, paths, current, alpha };
}

export const openRuntime = dataSet => kernel.RuntimeDatabase.open(dataSet.authority, { hostBootId: `ci-history-${randomUUID()}` });
export const openStore = (dataSet, database) => kernel.ContentAddressedStore.forDatabase(dataSet.authority, database);

export async function seedMessage(database, store, conversationId, messageId, sequence, text, role = 'user') {
  const content = await store.ingest(database, role === 'tool' ? JSON.stringify({
    detail: { content: text }, status: 'succeeded', toolCallId: `${messageId}_call`
  }) : JSON.stringify({ role, parts: [{ text }] }), role === 'tool'
    ? 'application/vnd.limcode.tool-model-result+json' : MESSAGE_TYPE);
  await database.transaction([
    repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
    repo('MessageRevision').insert({ id: `${messageId}_revision`, message_id: messageId,
      revision_seq: 1n, role, content_object_id: content.id, created_at: NOW }),
    repo('MessageCurrentRevisionLink').insert({ id: `${messageId}_current`, message_id: messageId,
      revision_id: `${messageId}_revision`, updated_at: NOW }),
    repo('MessagePartOfConversation').insert({ id: `${messageId}_member`, conversation_id: conversationId,
      message_id: messageId, message_seq: BigInt(sequence), created_at: NOW })
  ]);
  return content;
}

export async function seedConversation(database, store, id, text = `${id} 正文`) {
  await database.transaction([
    repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
    repo('Turn').insert({ id: `${id}_turn`, conversation_id: id, status: 'terminated', created_at: NOW,
      updated_at: NOW, terminal_at: NOW }),
    repo('TurnTermination').insert({ id: `${id}_termination`, turn_id: `${id}_turn`, terminal_status: 'completed',
      reason: 'fixture', created_at: NOW })
  ]);
  return seedMessage(database, store, id, `${id}_message`, 1, text);
}

export function modelAggregate(turnId, id, contentId) {
  return [
    repo('Operation').insertHistoricalCopy({ id: `${id}_operation`, owner_kind: 'model_request', owner_id: id,
      operation_seq: 1n, tool_call_id: null, status: 'completed', created_at: NOW, updated_at: NOW }),
    repo('Attempt').insertHistoricalCopy({ id: `${id}_attempt`, operation_id: `${id}_operation`, attempt_seq: 1n,
      status: 'completed', created_at: NOW, updated_at: NOW, completed_at: NOW }),
    repo('ModelRequest').insertHistoricalCopy({ id, turn_id: turnId, request_seq: 1n, status: 'terminal', terminal_state: 'completed',
      provider_id: 'openai-responses', model_id: 'gpt-test', context_window_tokens: 130000n, compression_threshold_tokens: 100000n,
      estimated_context_tokens: 1000n, authority_snapshot_id: 'authority-ci-history', settings_snapshot_object_id: null,
      recipe_object_id: contentId, usage_json: null, stream_stats_json: { attemptSeq: '1', socketGeneration: '0', retryReason: null },
      created_at: NOW, updated_at: NOW }),
    repo('ModelStreamFence').insertHistoricalCopy({ id: `${id}_fence`, model_request_id: id, attempt_seq: 1n,
      socket_generation: 0n, terminal_stream_seq: 0n, outcome: 'completed', created_at: NOW })
  ];
}

export function readSql(dataSet, body) {
  const database = new Database(dataSet.binding.paths.databasePath, { readonly: true });
  database.defaultSafeIntegers(true);
  try { return body(database); } finally { database.close(); }
}
export function rawSql(dataSet, body) {
  const database = new Database(dataSet.binding.paths.databasePath);
  schema.configureWriterConnection(database);
  try { body(database); database.pragma('wal_checkpoint(TRUNCATE)'); } finally { database.close(); }
}
export function insertOrphan(dataSet, id) {
  rawSql(dataSet, database => {
    database.prepare('INSERT INTO operation VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`${id}_operation`, 'model_request', `${id}_request`, 1, null, 'completed', NOW, NOW);
    database.prepare('INSERT INTO attempt VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`${id}_attempt`, `${id}_operation`, 1, 'completed', NOW, NOW, NOW);
  });
}
export function insertUnknownProcess(dataSet, status = 'outcome_unknown') {
  rawSql(dataSet, database => {
    database.prepare(`INSERT INTO process VALUES ('history_unknown', ?, 'nonce', 2147483647, NULL, NULL,
      'fingerprint', 'digest', 'old-spool', 0, 0, 0, 0, ?, ?, ?)`).run(status, NOW, NOW, NOW);
    database.prepare(`INSERT INTO process_receipt VALUES
      ('history_unknown_receipt', 'history_unknown', 'outcome_unknown', NULL, NULL, 'nonce', 'fingerprint', ?)`).run(NOW);
  });
}

export async function captureFiles(files) {
  const entries = await Promise.all(files.map(async file => {
    try {
      const info = await fs.lstat(file, { bigint: true });
      return [file, { ino: info.ino, size: info.size, mtime: info.mtimeNs, bytes: await fs.readFile(file) }];
    } catch (error) { if (error.code === 'ENOENT') return [file, undefined]; throw error; }
  }));
  return Object.fromEntries(entries);
}
