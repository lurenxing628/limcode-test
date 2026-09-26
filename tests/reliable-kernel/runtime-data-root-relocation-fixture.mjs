// Shared fixture of the data-root relocation tests (runtime-data-root-relocation*.test.mjs and the
// crash child). Everything runs against the compiled extension (LIMCODE_TEST_EXTENSION_ROOT or dist).
import { spawnSync } from 'node:child_process';
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
export const { RootAuthority } = kernelFile('rootAuthority.js');
const { projectFolderAssignmentSteps } = kernelFile('conversationProject.js');
export const relocation = kernelFile('runtimeDataRootRelocation.js');
export const rootAuthority = kernelFile('vscodeRootAuthority.js');
const {
  resolveVscodeRuntimeDataRoot, resolveVscodeWorkspaceRuntimeScope, resolveVscodeWorkspaceRuntimeScopeRoot, selectVscodeRuntimeDataSet
} = rootAuthority;

export const NOW = '2026-09-26T00:00:00.000Z';
const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
export const PROJECT = { uri: 'file:///workspace/relocation', name: 'relocation' };
export const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);
export const crossDevice = async () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); };

/** Stage online with this "window's" Runtime open, close it, then complete (exclusive). */
export async function relocate(fixture, plan, { publish, linkFile, relocationId } = {}) {
  const options = { ...(linkFile ? { linkFile } : {}), ...(relocationId ? { relocationId } : {}) };
  const source = await openRuntime(fixture.current);
  let staged;
  try {
    staged = await relocation.stageDataRootRelocation(plan, source, options);
  } finally {
    await source.close();
  }
  const result = await relocation.completeDataRootRelocation(staged, publish ?? (async () => undefined), options);
  return { staged, result };
}

/** Plan with this "window's" Runtime open (rows are counted through its Backup API). */
export async function planWithRuntime(fixture, targetRootPath) {
  const source = await openRuntime(fixture.current);
  try {
    return await relocation.planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath, sourceDatabase: source });
  } finally {
    await source.close();
  }
}

/** The old home: the selected default data set with two conversations, optionally a workspace data set, configuration and a user file. */
export async function createFixture(t, options = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-relocation-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return populateFixture(base, options);
}

export async function populateFixture(base, options = {}) {
  const root = path.join(base, 'old-home');
  await fs.mkdir(root);
  const paths = { globalStoragePath: root };
  const current = await initialize(root, 'default');
  let alpha;
  if (options.withAlpha !== false) {
    const scope = resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: ['file:///workspace/alpha'] });
    const scopeRoot = resolveVscodeWorkspaceRuntimeScopeRoot(paths, scope);
    await fs.mkdir(scopeRoot, { recursive: true });
    alpha = await initialize(scopeRoot, `workspace:${scope.key}`);
    await seed(alpha, [{ id: 'conversation_alpha_1', project: PROJECT }]);
  }
  await selectVscodeRuntimeDataSet(paths, 'default');
  await seed(current, [
    { id: 'conversation_current_1', project: PROJECT },
    { id: 'conversation_current_2', project: PROJECT }
  ]);
  await writeRecordStore(root, 'agents', 'agent', [
    { id: 'agent-shared', name: 'source version' },
    { id: 'agent-source-only', name: 'only in source' }
  ]);
  await fs.mkdir(path.join(root, 'settings'), { recursive: true });
  await fs.writeFile(path.join(root, 'settings', 'llm.json'), '{"activeProviderConfigId":"source"}\n');
  await fs.writeFile(path.join(root, 'notes.txt'), 'user file');
  return { base, root, paths, current, alpha };
}

/** An existing LimCode directory created at `root` with one conversation and its own agents. */
export async function createLimCodeTarget(root, { conversations = [{ id: 'conversation_existing_1', project: PROJECT }], agents } = {}) {
  await fs.mkdir(root, { recursive: true });
  const existing = await initialize(root, 'default');
  await selectVscodeRuntimeDataSet({ globalStoragePath: root }, 'default');
  await seed(existing, conversations);
  if (agents) await writeRecordStore(root, 'agents', 'agent', agents);
  return existing;
}

export async function initialize(scopeRoot, id) {
  const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot }));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  return { id, scopeRoot, authority, binding };
}

export function openRuntime(dataSet) {
  return kernel.RuntimeDatabase.open(dataSet.authority, { hostBootId: `window-${randomUUID()}` });
}

export async function withRuntime(dataSet, run) {
  const runtime = await openRuntime(dataSet);
  try {
    return await run(runtime, new kernel.ContentAddressedStore(dataSet.authority, dataSet.binding));
  } finally { await runtime.close(); }
}

export async function seed(dataSet, conversations) {
  await withRuntime(dataSet, async (runtime, store) => {
    for (const spec of conversations) {
      const content = await store.ingest(runtime, JSON.stringify({ role: 'user', parts: [{ text: `${spec.id} 的正文` }] }), MESSAGE_TYPE);
      const messageId = `${spec.id}_message`;
      await runtime.transaction([
        repo('Conversation').insert({ id: spec.id, title: spec.title ?? spec.id, status: 'active', created_at: NOW, updated_at: NOW }),
        ...projectFolderAssignmentSteps({ conversationId: spec.id, folder: spec.project, now: NOW }),
        repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
        repo('MessageRevision').insert({
          id: `${messageId}_revision`, message_id: messageId, revision_seq: 1n, role: 'user', content_object_id: content.id, created_at: NOW
        }),
        repo('MessageCurrentRevisionLink').insert({
          id: `${messageId}_current`, message_id: messageId, revision_id: `${messageId}_revision`, updated_at: NOW
        }),
        repo('MessagePartOfConversation').insert({
          id: `${messageId}_member`, conversation_id: spec.id, message_id: messageId, message_seq: 1n, created_at: NOW
        })
      ]);
    }
  });
}

/** An ordinary later write: a conversation renamed through its Repository. */
export async function renameConversation(dataSet, id, title) {
  await withRuntime(dataSet, async (runtime) => {
    await runtime.transaction([repo('Conversation').update(id, { title, updated_at: '2026-09-27T00:00:00.000Z' })]);
  });
}

export async function writeRecordStore(root, directory, key, records) {
  const store = path.join(root, directory);
  await fs.mkdir(path.join(store, 'records'), { recursive: true });
  const entries = [];
  for (const record of records) {
    const file = `records/${record.id}.json`;
    await fs.writeFile(path.join(store, file), `${JSON.stringify({ schemaVersion: 1, savedAt: NOW, [key]: record }, null, 2)}\n`);
    entries.push({ id: record.id, file, updatedAt: NOW });
  }
  await fs.writeFile(path.join(store, 'index.json'), `${JSON.stringify({ schemaVersion: 1, savedAt: NOW, records: entries }, null, 2)}\n`);
}

export async function indexIds(store) {
  return JSON.parse(await fs.readFile(path.join(store, 'index.json'), 'utf8')).records.map((entry) => entry.id).sort();
}

export function readDatabase(dataRootPath) {
  const database = new Database(path.join(dataRootPath, 'limcode.sqlite'), { readonly: true });
  return {
    database,
    ids(table) { return database.prepare(`SELECT id FROM ${table} ORDER BY id`).pluck().all(); },
    close() { database.close(); }
  };
}

export function conversationIds(dataRootPath) {
  const database = readDatabase(dataRootPath);
  try { return database.ids('conversation'); } finally { database.close(); }
}

export function databaseRows(databasePath) {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare('SELECT id, title, updated_at FROM conversation ORDER BY id').all();
  } finally { database.close(); }
}

export async function selectedDataSet(root) {
  return (await rootAuthority.inspectVscodeRuntimeDataSets({ globalStoragePath: root })).candidates.find((candidate) => candidate.selected);
}

export async function treeSnapshot(root) {
  const files = {};
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else files[path.relative(root, file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    }
  }
  await visit(root);
  return files;
}

/** Deletes what a confirmation would list by default (every deletable, non-optional item) plus `include`. */
export async function deleteAsConfirmed(input, include = []) {
  const plan = await relocation.planOldDataRootDeletion(input);
  const confirmedKeys = [
    ...plan.items.filter((item) => item.deletable && !item.optional).map((item) => item.key),
    ...include
  ];
  return { plan, result: await relocation.deleteOldDataRoot({ ...input, include, confirmedKeys }) };
}

/** The process that staged the relocation in `target` is gone (its pid no longer exists). */
export async function markStagingOwnerDead(target) {
  const file = path.join(target, relocation.DATA_ROOT_RELOCATION_MARKER_FILE);
  const marker = JSON.parse(await fs.readFile(file, 'utf8'));
  marker.owner = { processId: spawnSync(process.execPath, ['-e', '']).pid };
  await fs.writeFile(file, `${JSON.stringify(marker, null, 2)}\n`);
}
