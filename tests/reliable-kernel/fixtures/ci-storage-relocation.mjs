import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
export const load = file => require(path.join(compiled, file));
export const kernelFile = file => load(`backend/reliableKernel/${file}`);
export const kernel = kernelFile('index.js');
export const Database = require('better-sqlite3');
export const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);
export const relocation = kernelFile('runtimeDataRootRelocation.js');
export const roots = kernelFile('vscodeRootAuthority.js');
export const registry = kernelFile('runtimeHistoryRegistry.js');
const schema = kernelFile('databaseSchema.js');
export const NOW = '2026-10-01T00:00:00.000Z';
export const PROJECT = { uri: 'file:///workspace/ci-storage', name: 'storage' };

export async function temporaryRoot(prefix) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

export async function initializeRoot(root, id = 'default') {
  await fs.mkdir(root, { recursive: true });
  const authority = new kernel.RootAuthority(() => roots.resolveVscodeRuntimeDataRoot({ globalStoragePath: root }));
  const binding = await authority.initializeEmptyRoot(async value => {
    await fs.mkdir(value.paths.casRootPath, { recursive: true });
    const database = new Database(value.paths.databasePath);
    try { schema.configureWriterConnection(database); schema.initializeCurrentSchema(database, value); }
    finally { database.close(); }
  });
  return { root, id, authority, binding };
}

export const openDatabase = dataSet => kernel.RuntimeDatabase.open(dataSet.authority, { hostBootId: `ci-${randomUUID()}` });

export async function seedMessages(dataSet, specs) {
  const database = await openDatabase(dataSet);
  const store = kernel.ContentAddressedStore.forDatabase(dataSet.authority, database);
  try {
    const bodies = specs.map(spec => JSON.stringify({ role: 'user', parts: [{ text: spec.text ?? `${spec.id} 的原始用户输入` }] }));
    const prepared = await store.prepareBatch(database, bodies.map(content => ({ content, contentType: 'application/vnd.limcode.message+json' })));
    const steps = prepared.flatMap(entry => entry.insert ? [entry.insert] : []);
    for (const [index, spec] of specs.entries()) {
      const content = prepared[index].metadata;
      const messageId = `${spec.id}-message`;
      steps.push(
        repo('Conversation').insert({ id: spec.id, title: spec.title ?? spec.id, status: 'active', created_at: NOW, updated_at: NOW }),
        repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
        repo('MessageRevision').insert({ id: `${messageId}-revision`, message_id: messageId, revision_seq: 1n, role: 'user', content_object_id: content.id, created_at: NOW }),
        repo('MessageCurrentRevisionLink').insert({ id: `${messageId}-current`, message_id: messageId, revision_id: `${messageId}-revision`, updated_at: NOW }),
        repo('MessagePartOfConversation').insert({ id: `${messageId}-member`, conversation_id: spec.id, message_id: messageId, message_seq: 1n, created_at: NOW })
      );
    }
    await database.transaction(steps);
    return prepared.map(({ metadata }, index) => ({ ...metadata, body: bodies[index] }));
  } finally { await database.close(); }
}

export async function writeStore(root, directory, key, records) {
  const store = path.join(root, directory);
  await fs.mkdir(path.join(store, 'records'), { recursive: true });
  const entries = [];
  for (const record of records) {
    const file = `records/${record.id}.json`;
    await fs.writeFile(path.join(store, file), `${JSON.stringify({ schemaVersion: 1, savedAt: NOW, [key]: record })}\n`);
    entries.push({ id: record.id, file, updatedAt: NOW });
  }
  await fs.writeFile(path.join(store, 'index.json'), `${JSON.stringify({ schemaVersion: 1, savedAt: NOW, records: entries })}\n`);
}

export async function selected(root) {
  return (await roots.inspectVscodeRuntimeDataSets({ globalStoragePath: root })).candidates.find(item => item.selected);
}

/** Planning and online staging use one source connection; only completion requires it closed. */
export async function move(source, target, { publish = async () => {}, options = {} } = {}) {
  const database = await openDatabase(source);
  let plan, staged;
  try {
    plan = await relocation.planDataRootRelocation({ sourceRootPath: source.root, targetRootPath: target, sourceDatabase: database });
    if (plan.problems.length) throw new Error(plan.problems.join('\n'));
    staged = await relocation.stageDataRootRelocation(plan, database, options);
  } finally { await database.close(); }
  const result = await relocation.completeDataRootRelocation(staged, publish, { ...options, pointerUnchanged: async () => true });
  const current = await selected(target);
  return { plan, staged, result, target: { root: target, authority: new kernel.RootAuthority(() => current.runtimeDataRootPath), binding: await new kernel.RootAuthority(() => current.runtimeDataRootPath).current() } };
}

export function readRows(dataRoot, table, columns = '*') {
  const database = new Database(path.join(dataRoot, 'limcode.sqlite'), { readonly: true, fileMustExist: true });
  try { return database.prepare(`SELECT ${columns} FROM ${table} ORDER BY id`).all(); }
  finally { database.close(); }
}

export async function readBodies(dataSet, metadata) {
  const database = await openDatabase(dataSet);
  try {
    const store = kernel.ContentAddressedStore.forDatabase(dataSet.authority, database);
    const bodies = [];
    for (const entry of metadata) bodies.push((await store.read(entry)).toString());
    return bodies;
  }
  finally { await database.close(); }
}
