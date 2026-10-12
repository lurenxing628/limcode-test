// Small offline sources; the core suite owns one live target writer.
import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openFullRuntime } from '../runtime-dataset-merge-full-runtime.mjs';
import { publishInitialRuntimeSelection } from './runtime-selection.mjs';

const require = createRequire(import.meta.url);
export const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
export const load = file => require(path.join(compiled, 'backend/reliableKernel', file));
export const kernel = load('index.js');
export const Database = require('better-sqlite3');
export const NOW = '2026-10-13T00:00:00.000Z';
export const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
export const repo = domain => kernel.DOMAIN_REPOSITORIES.domain(domain);
export const schemas = load('schema/domainManifest.js').RUNTIME_DOMAIN_SCHEMAS;
const schemaByKey = new Map(schemas.map(schema => [schema.key, schema]));
const roots = load('vscodeRootAuthority.js');
const schema = load('databaseSchema.js');
const histories = load('runtimeHistoryRegistry.js');
const ledgerModule = load('runtimeDataSetMergeLedger.js');
const mergeModule = load('runtimeDataSetMerge.js');
export const settled = require(path.join(compiled, 'backend/application/reliableKernel/historicalMergeSettlement.js'));
const here = path.dirname(fileURLToPath(import.meta.url));

export const conversation = (id, title = id) => ({ id, title, status: 'active', created_at: NOW, updated_at: NOW });
export const terminatedTurn = (id, conversationId) => ({ id, conversation_id: conversationId, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW });
export const identity = binding => ({ dataSetId: binding.dataSetId, rootInstanceId: binding.rootInstanceId });
export const loosePath = (binding, metadata) => path.join(binding.paths.casRootPath, ...metadata.storage_key.split('/'));

async function initialize(scopeRoot, id) {
  await fs.mkdir(scopeRoot, { recursive: true });
  const authority = new kernel.RootAuthority(() => roots.resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot }));
  // Empty fixture roots need the production DDL; a seed worker adds no exercised behavior here.
  const binding = await authority.initializeEmptyRoot(async value => {
    await fs.mkdir(value.paths.casRootPath, { recursive: true });
    const database = new Database(value.paths.databasePath);
    try {
      schema.configureWriterConnection(database);
      schema.initializeCurrentSchema(database, value);
    } finally { database.close(); }
  });
  return { scopeRoot, id, authority, binding };
}

export async function createHome() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-ci-merge-core-')));
  const root = path.join(base, 'home');
  const current = await initialize(root, 'default');
  const paths = { globalStoragePath: root };
  await publishInitialRuntimeSelection(paths, 'default');
  const settingsRoot = path.join(base, 'settings');
  const live = await openFullRuntime({ authority: current.authority, settingsRoot, hostLabel: 'ci-core',
    async send() { throw new Error('Imported history must never call the Provider.'); } });
  await live.startupRecovery();
  const home = { base, root, paths, current, settingsRoot, live, database: live.app.database };
  home.store = kernel.ContentAddressedStore.forDatabase(current.authority, home.database);
  home.source = async name => {
    const scope = roots.resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: [`file:///ci-merge/${name}`] });
    return initialize(roots.resolveVscodeWorkspaceRuntimeScopeRoot(paths, scope), `workspace:${scope.key}`);
  };
  home.close = async () => { await live.close(); await fs.rm(base, { recursive: true, force: true }); };
  return home;
}

export function read(dataSet, run) {
  const database = new Database(dataSet.binding.paths.databasePath, { readonly: true });
  database.defaultSafeIntegers(true);
  try { return run(database); } finally { database.close(); }
}

/** SQL is confined to deliberately constructed, offline fixtures. */
export function raw(dataSet, run) {
  const database = new Database(dataSet.binding.paths.databasePath);
  database.defaultSafeIntegers(true);
  database.pragma('foreign_keys = ON');
  try {
    database.transaction(() => run(database))();
    database.pragma('wal_checkpoint(TRUNCATE)');
  } finally { database.close(); }
}

export function insert(database, domain, row) {
  const schema = schemaByKey.get(domain);
  const encoded = repo(domain).codec.encodeInsert(row);
  const columns = Object.keys(encoded);
  database.prepare(`INSERT INTO "${schema.table}" (${columns.map(name => `"${name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .run(...Object.values(encoded));
}

export async function content(dataSet, text, contentType = MESSAGE_TYPE) {
  const store = kernel.ContentAddressedStore.loose(dataSet.authority, dataSet.binding);
  const metadata = { ...store.identity(text, contentType), created_at: NOW };
  await store.publish(text, contentType);
  raw(dataSet, database => {
    if (!database.prepare('SELECT id FROM content_object WHERE id=?').get(metadata.id)) insert(database, 'ContentObject', metadata);
  });
  return metadata;
}

export function insertMessage(database, conversationId, metadata, suffix = 'message', seq = 1n) {
  const id = `${conversationId}_${suffix}`;
  insert(database, 'Message', { id, created_at: NOW, updated_at: NOW, deleted_at: null });
  insert(database, 'MessageRevision', { id: `${id}_revision`, message_id: id, revision_seq: 1n, role: 'user', content_object_id: metadata.id, created_at: NOW });
  insert(database, 'MessageCurrentRevisionLink', { id: `${id}_current`, message_id: id, revision_id: `${id}_revision`, updated_at: NOW });
  insert(database, 'MessagePartOfConversation', { id: `${id}_member`, conversation_id: conversationId, message_id: id, message_seq: seq, created_at: NOW });
  return id;
}

export async function seed(dataSet, specs, { messages = false } = {}) {
  const body = messages ? await content(dataSet, JSON.stringify({ role: 'user', parts: [{ text: `body ${specs[0].id}` }] })) : undefined;
  raw(dataSet, database => {
    for (const spec of specs) {
      insert(database, 'Conversation', conversation(spec.id, spec.title));
      insert(database, 'Turn', terminatedTurn(`${spec.id}_turn`, spec.id));
      insert(database, 'TurnTermination', { id: `${spec.id}_termination`, turn_id: `${spec.id}_turn`, terminal_status: 'completed', reason: 'fixture', created_at: NOW });
      if (body) insertMessage(database, spec.id, body);
    }
  });
  return body;
}

export async function packedMessage(dataSet, conversationId, text, after) {
  const database = await kernel.RuntimeDatabase.open(dataSet.authority, { hostBootId: `packed-seed-${randomUUID()}` });
  try {
    const store = kernel.ContentAddressedStore.forDatabase(dataSet.authority, database);
    const metadata = await store.ingest(database, JSON.stringify({ role: 'user', parts: [{ text }] }), MESSAGE_TYPE);
    await database.transaction([
      repo('Message').insert({ id: `${conversationId}_packed`, created_at: NOW, updated_at: NOW, deleted_at: null }),
      repo('MessageRevision').insert({ id: `${conversationId}_packed_revision`, message_id: `${conversationId}_packed`, revision_seq: 1n, role: 'user', content_object_id: metadata.id, created_at: NOW }),
      repo('MessageCurrentRevisionLink').insert({ id: `${conversationId}_packed_current`, message_id: `${conversationId}_packed`, revision_id: `${conversationId}_packed_revision`, updated_at: NOW }),
      repo('MessagePartOfConversation').insert({ id: `${conversationId}_packed_member`, conversation_id: conversationId, message_id: `${conversationId}_packed`, message_seq: 2n, created_at: NOW })
    ]);
    await after?.(database, store);
    return metadata;
  } finally { await database.close(); }
}

export async function pending(home, source, registeredAt = NOW) {
  await histories.writeRuntimeHistoryPending(home.paths, { id: source.id, sourceKind: 'local',
    location: { kind: 'local', candidateId: source.id }, identity: identity(source.binding), reason: 'CI merge source', registeredAt });
}

export const ledgerRoot = home => roots.resolveVscodeRuntimeMergeLedgerRoot(home.paths);
export const ledger = async (home, source) => (await ledgerModule.readRuntimeDataSetMergeLedger(home.paths)).get(source.id);
export const ledgerFile = (home, source) => path.join(ledgerRoot(home), 'records', `${source.id.replace(/:/g, '-')}.json`);
export const merge = (home, sources, options = {}) => mergeModule.mergeHistoricalDataSetsOnline(home.paths,
  { configurationRootPath: home.root, database: home.database }, { candidateIds: sources.map(source => source.id), requested: true,
    confirmSettlement: async () => true, settleSourceWork: settled.settleHistoricalMergeSourceOffline, ...options });

export async function bareTurn(dataSet, conversationId, suffix = 'active') {
  const id = `${conversationId}_${suffix}`;
  raw(dataSet, database => insert(database, 'Turn', { id, conversation_id: conversationId, status: 'active', created_at: NOW, updated_at: NOW, terminal_at: null }));
  return id;
}

export function child(database, parentId, childId) {
  insert(database, 'Conversation', conversation(childId));
  insert(database, 'ChildExecution', { id: `${childId}_execution`, child_conversation_id: childId, status: 'idle', created_at: NOW, updated_at: NOW });
  insert(database, 'ConversationOriginLink', { id: `${childId}_origin`, conversation_id: childId,
    source_conversation_id: parentId, source_turn_id: `${parentId}_turn`, source_tool_call_id: null, source_message_revision_id: null, created_at: NOW });
}

export async function collaboration(dataSet, from, to, id) {
  const payload = await content(dataSet, `payload ${id}`, 'text/vnd.limcode.collaboration-message');
  raw(dataSet, database => {
    const seq = database.prepare('SELECT COALESCE(MAX(message_seq),0)+1 AS n FROM collaboration_message').get().n;
    insert(database, 'CollaborationMessage', { id, dedupe_key: id, mode: 'message', message_seq: seq, created_at: NOW });
    insert(database, 'CollaborationMessageSourceLink', { id: `${id}_source`, message_id: id, conversation_id: from,
      source_kind: 'tool', source_key: id, turn_id: `${from}_turn`, tool_call_id: null, board_post_id: null, created_at: NOW });
    insert(database, 'RuntimeInboxItem', { id: `${id}_inbox`, dedupe_key: id, source_kind: 'collaboration_message', source_id: id, state: 'routed', created_at: NOW, updated_at: NOW });
    insert(database, 'CollaborationMessageTargetLink', { id: `${id}_target`, message_id: id, conversation_id: to, inbox_item_id: `${id}_inbox`, anchor_turn_id: null, created_at: NOW });
    insert(database, 'CollaborationMessagePayloadLink', { id: `${id}_payload`, message_id: id, content_object_id: payload.id, created_at: NOW });
    insert(database, 'RuntimeInboxPayloadLink', { id: `${id}_inbox_payload`, inbox_item_id: `${id}_inbox`, content_object_id: payload.id, created_at: NOW });
  });
}

export async function aggregate(dataSet, conversationId, id, { checkpoints = 5, toolsReference } = {}) {
  const recipe = await content(dataSet, JSON.stringify({ kind: 'reliable-agent-turn', conversationId,
    turnId: `${conversationId}_turn`, modelHandleCatalog: { entries: [] }, ...(toolsReference ? { toolsReference } : { tools: [] }) }), 'application/json');
  const body = await content(dataSet, JSON.stringify({ role: 'model', parts: [{ text: `checkpoint ${id}` }] }));
  const steps = [
    ['Operation', { id: `${id}_operation`, owner_kind: 'model_request', owner_id: id, operation_seq: 1n, tool_call_id: null, status: 'completed', created_at: NOW, updated_at: NOW }],
    ['Attempt', { id: `${id}_attempt`, operation_id: `${id}_operation`, attempt_seq: 1n, status: 'completed', created_at: NOW, updated_at: NOW, completed_at: NOW }],
    ['ModelRequest', { id, turn_id: `${conversationId}_turn`, request_seq: 1n, status: 'terminal', terminal_state: 'completed',
      provider_id: 'openai-responses', model_id: 'fixture', context_window_tokens: 130000n, compression_threshold_tokens: 100000n,
      estimated_context_tokens: 1000n, authority_snapshot_id: 'fixture', settings_snapshot_object_id: null, recipe_object_id: recipe.id,
      usage_json: null, stream_stats_json: { attemptSeq: '1', socketGeneration: '0', retryReason: null }, created_at: NOW, updated_at: NOW }]
  ];
  for (let seq = 1; seq <= checkpoints; seq++) steps.push(['ModelStreamCheckpoint', { id: `${id}_checkpoint_${seq}`, model_request_id: id,
    attempt_seq: 1n, socket_generation: 0n, stream_seq: BigInt(seq), checkpoint_kind: 'output_delta', content_object_id: body.id, created_at: NOW }]);
  steps.push(['ModelStreamFence', { id: `${id}_fence`, model_request_id: id, attempt_seq: 1n, socket_generation: 0n,
    terminal_stream_seq: BigInt(checkpoints), outcome: 'completed', created_at: NOW }]);
  raw(dataSet, database => { for (const [domain, row] of steps) insert(database, domain, row); });
  return { recipe, body, steps };
}

export async function target(home, name) {
  const root = path.join(home.base, name);
  const dataSet = await initialize(root, 'default');
  return { root, dataSet, runtimeDataRootPath: dataSet.binding.paths.dataRootPath };
}

export const copy = (home, source, destination, options = {}) => load('runtimeHostControl.js').withRuntimeDataRootAdmission(destination.root,
  () => load('runtimeDataSetBulkCopy.js').copyRuntimeDataSetIntoEmptyRoot(home.paths,
    { candidateId: source.id, expectedDataSetId: source.binding.dataSetId, expectedRootInstanceId: source.binding.rootInstanceId },
    { configurationRootPath: destination.root, runtimeDataRootPath: destination.runtimeDataRootPath }, options));

export function domainRows(dataSet) {
  return read(dataSet, database => Object.fromEntries(schemas.map(schema => [schema.key,
    database.prepare(`SELECT * FROM "${schema.table}" ORDER BY id`).all()])));
}

export function startChild(file, args) {
  const child = execFile(process.execPath, [path.join(here, '..', file), ...args], {
    env: { ...process.env, LIMCODE_TEST_EXTENSION_ROOT: compiled }, maxBuffer: 1024 * 1024
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
  return { child, exited };
}

export async function waitForFile(file, child) {
  let watcher;
  let stop;
  let ready;
  const exists = () => fs.stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  try {
    const arrived = new Promise((resolve, reject) => {
      ready = resolve;
      watcher = watch(path.dirname(file), async (_event, name) => {
        if (String(name) === path.basename(file) && await exists()) resolve();
      });
      stop = setTimeout(() => reject(new Error(`Child did not publish ${path.basename(file)}`)), 15000);
      child.exited.then(result => reject(new Error(`Child exited before ready: ${JSON.stringify(result)}`)), reject);
    });
    if (await exists()) ready();
    await arrived;
  } finally { watcher?.close(); clearTimeout(stop); }
}

/** A Facade over the same writer, so the test observes the real user warning. */
export async function deletionFacade(home) {
  const Module = require('node:module');
  const original = Module._load;
  const warnings = [];
  const disposable = () => ({ dispose() {} });
  class EventEmitter {
    listeners = new Set();
    event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  }
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return { EventEmitter, ProgressLocation: { Notification: 15 },
      Uri: { parse: text => ({ toString: () => text }), joinPath: () => ({}) },
      window: { registerWebviewViewProvider: disposable, onDidChangeActiveTextEditor: disposable,
        showWarningMessage: async message => { warnings.push(message); }, showInformationMessage: async () => undefined,
        showErrorMessage: async () => undefined, withProgress: async (_options, task) => task({ report() {} }) },
      workspace: { onDidChangeWorkspaceFolders: disposable, workspaceFolders: [] }, commands: { executeCommand: async () => undefined } };
    if (request.endsWith('/panels/MainPanel')) return { MainPanel: { onDidChangeConversationPanelState: disposable,
      getOpenConversationPanelStates: () => [], createOrShow() {}, refreshConversationTitle() {}, closePanelsByConversationId() {} } };
    if (request.endsWith('/webview/getWebviewHtml')) return { getWebviewHtml: () => '', getUnavailableWebviewHtml: () => '' };
    return original.call(this, request, parent, isMain);
  };
  let Facade;
  try { ({ VscodeReliableKernelApplicationFacade: Facade } = require(path.join(compiled,
    'backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js'))); }
  finally { Module._load = original; }
  const nothingRuns = async () => { throw new Error('This fixture has no active work.'); };
  const product = {
    debugCapture: { setListener() {} }, toolHost: { setStateChangeListener() {} }, ensureCapabilitiesReady: async () => undefined,
    application: { database: home.database, contentStore: home.store,
      conversationDeletion: new (load('conversationDeletion.js').ConversationDeletionControlPlane)(home.database),
      modelProvider: { subscribeSteering: () => () => undefined }, webviewFeed: { postToConversation() {}, reconnect() {} } },
    configuration: { agents: async () => [] }, conversations: { interrupt: nothingRuns }, childAgents: { interruptSubtree: nothingRuns }, close: async () => undefined
  };
  return { facade: new Facade({}, product, () => ({}), { configurationRootPath: home.root }), warnings };
}
