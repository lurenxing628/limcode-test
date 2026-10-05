import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = load('index.js');
const { RootAuthority } = load('rootAuthority.js');
const { prepareFrozenToolDefinitions, freezeToolDefinitions, resolveFrozenToolDefinitions,
  providerRequestToolDefinitions, FROZEN_TOOL_DEFINITIONS_CONTENT_TYPE } = load('frozenToolDefinitions.js');

test('frozen tools retain ordered immutable CAS identity across reuse/reopen and reject missing references', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-frozen-tools-'));
  let dataRoot = path.join(root, 'runtime');
  const authority = new RootAuthority(() => dataRoot);
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  let database = await kernel.RuntimeDatabase.open(authority, { hostBootId: 'frozen-tools-first' });
  try {
    let ingests = 0;
    const store = new kernel.ContentAddressedStore(authority, binding);
    const ingest = store.ingest.bind(store);
    store.ingest = (...args) => { ingests += 1; return ingest(...args); };
    const input = [{ name: 'b', description: 'B', parameters: { enum: ['first', 'second'] },
      source: { kind: 'mcp', sourceId: 'original' }, metadata: { nativeAsync: true }, defaultConfig: { enabled: true } },
      { name: 'a', description: 'A', parameters: {} }];
    const tools = prepareFrozenToolDefinitions(input);
    input[0].parameters.enum.reverse();
    input[0].source.sourceId = 'replacement';
    assert.throws(() => { tools[0].parameters.enum.push('poison'); }, TypeError);
    const reference = await freezeToolDefinitions(database, store, tools);
    const snapshot = database.snapshot.bind(database);
    let snapshots = 0;
    database.snapshot = (...args) => { snapshots += 1; return snapshot(...args); };
    assert.deepEqual(await freezeToolDefinitions(database, store, tools), reference);
    assert.equal(ingests, 1, 'same immutable revision is not serialized/hashed/ingested again');
    const recipe = { kind: 'reliable-agent-turn', toolsReference: reference };
    const resolved = await resolveFrozenToolDefinitions(database, store, recipe);
    assert.equal(resolved, tools);
    assert.equal(snapshots, 0, 'verified warm writer/reader hits do not query immutable metadata again');
    database.heartbeatFailure = new Error('fixture heartbeat failure');
    await assert.rejects(resolveFrozenToolDefinitions(database, store, recipe), /heartbeat failed/);
    database.heartbeatFailure = undefined;
    dataRoot = path.join(root, 'different-root');
    await assert.rejects(resolveFrozenToolDefinitions(database, store, recipe), /RootBinding|root|restart/i);
    await assert.rejects(freezeToolDefinitions(database, store, tools), /RootBinding|root|restart/i);
    dataRoot = path.join(root, 'runtime');
    assert.equal(snapshots, 0, 'stale owner checks also fail before SQL');
    let adapterReads = 0;
    const customDatabase = { binding: database.binding, snapshot: (...args) => { adapterReads += 1; return snapshot(...args); } };
    await resolveFrozenToolDefinitions(customDatabase, store, recipe);
    await resolveFrozenToolDefinitions(customDatabase, store, recipe);
    assert.equal(adapterReads, 2, 'custom adapters without the no-SQL fence keep registration validation');
    assert.deepEqual(resolved.map(tool => tool.name), ['b', 'a']);
    assert.deepEqual(resolved[0].parameters.enum, ['first', 'second']);
    assert.equal(resolved[0].source.sourceId, 'original');
    assert.throws(() => providerRequestToolDefinitions({ recipe }), /has not resolved/);
    assert.equal(providerRequestToolDefinitions({ recipe, resolvedTools: resolved }), resolved);
    assert.deepEqual(await freezeToolDefinitions(database, store, resolved), reference);
    assert.equal(ingests, 1, 'compression reuses the original resolved CAS identity');
    const legacy = { kind: 'reliable-agent-turn', tools: input };
    const before = JSON.stringify(legacy);
    assert.equal(await resolveFrozenToolDefinitions(database, store, legacy), input);
    assert.equal(JSON.stringify(legacy), before, 'legacy reader never rewrites inline recipe bytes');
    await assert.rejects(resolveFrozenToolDefinitions(database, store, { ...recipe, tools: [] }), /both inline/);
    await assert.rejects(resolveFrozenToolDefinitions(database, store, { toolsReference: { contentObjectId: 'missing' } }), /registered CAS/);
    // Register a real wrong-type body, so the failure tests type validation rather than absence.
    const wrong = await ingest(database, '{}', 'application/json');
    await assert.rejects(resolveFrozenToolDefinitions(database, store, { toolsReference: { contentObjectId: wrong.id } }), /correctly typed/);
    await database.close();
    await assert.rejects(resolveFrozenToolDefinitions(database, store, recipe), /closed/);
    await assert.rejects(freezeToolDefinitions(database, store, tools), /closed/);
    database = await kernel.RuntimeDatabase.open(authority, { hostBootId: 'frozen-tools-reopened' });
    const reopenedStore = new kernel.ContentAddressedStore(authority, binding);
    const restored = await resolveFrozenToolDefinitions(database, reopenedStore, JSON.parse(JSON.stringify(recipe)));
    assert.deepEqual(restored, tools);
    const registered = (await database.snapshot([kernel.DOMAIN_REPOSITORIES.domain('ContentObject').get(reference.contentObjectId)])).snapshot[0];
    assert.equal(registered.content_type, FROZEN_TOOL_DEFINITIONS_CONTENT_TYPE);
    assert.deepEqual(JSON.parse((await reopenedStore.read(registered)).toString('utf8')), { kind: 'frozen-tool-definitions', tools });
  } finally {
    await database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('effective tool snapshots reuse identity across Turns but track live inputs and protect mutable hosts', async () => {
  const { ReliableToolDispatcher } = load('toolDispatcher.js');
  const { immutableToolDefinition } = load('immutableToolDeclarations.js');
  const template = { execution: 'runtime', declaration: { name: 'read', description: 'Read',
    parameters: { type: 'object', properties: { path: { type: 'string' } } }, metadata: { nativeAsync: true } } };
  let tools = [immutableToolDefinition(template), immutableToolDefinition({ execution: 'runtime',
    declaration: { name: 'skills', description: 'Skills', parameters: {} } })];
  let skills = [{ id: 'demo', name: 'demo', description: 'First description', source: 'agents' }];
  const policy = { toolPolicy: { allowedTools: ['read', 'skills'], toolConfigs: {} },
    workEnvironmentPolicy: { enabled: false, allowedWorkEnvironmentIds: [] } };
  const dispatcher = new ReliableToolDispatcher({ host: { definitions: () => tools,
    skillDefinitions: () => skills }, effects: { subscribeToolModelResults: () => () => {} } });
  dispatcher.readAuthority = async turnId => ({ snapshotId: turnId,
    document: turnId === 'async' ? { ...policy, toolPolicy: { ...policy.toolPolicy,
      toolConfigs: { read: { nativeAsync: true } } } } : policy });
  const project = dispatcher.projectDefinition.bind(dispatcher);
  let projections = 0;
  dispatcher.projectDefinition = input => { projections += 1; return project(input); };
  const first = await dispatcher.definitions('first');
  assert.equal(await dispatcher.definitions('second'), first, 'equal effective toolsets share identity across Turns');
  assert.equal(projections, 2, 'warm immutable toolsets do not normalize or copy schemas again');
  assert.throws(() => first.reverse(), TypeError);
  assert.throws(() => { first[0].parameters.properties.path.type = 'number'; }, TypeError);
  assert.equal(first[0].metadata, undefined, 'declaration async flag alone is not authority');
  const asynchronous = await dispatcher.definitions('async');
  assert.notEqual(asynchronous, first);
  assert.equal(asynchronous[0].metadata.nativeAsync, true);
  assert.equal(await dispatcher.definitions('first'), first);
  skills = [{ ...skills[0], description: 'Updated description' }];
  const changedSkills = await dispatcher.definitions('first');
  assert.notEqual(changedSkills, first);
  assert.match(changedSkills[1].description, /Updated description/);
  assert.match(first[1].description, /First description/);
  tools = [template]; // Same mutable object may change; never cache its identity.
  const mutable = await dispatcher.definitions();
  template.declaration.parameters.properties.path.type = 'number';
  const changedSchema = await dispatcher.definitions();
  assert.notEqual(changedSchema, mutable);
  assert.equal(mutable[0].parameters.properties.path.type, 'string');
  assert.equal(changedSchema[0].parameters.properties.path.type, 'number');
  tools = structuredClone(tools); // Fresh mutable object with identical values also reuses the revision.
  assert.equal(await dispatcher.definitions(), changedSchema);
  assert.equal(Object.isFrozen(template.declaration.parameters), false, 'host templates are never frozen or mutated in place');
});
