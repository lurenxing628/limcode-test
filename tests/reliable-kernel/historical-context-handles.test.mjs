import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
const {
  CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION,
  UnknownModelHandleReferenceError,
  buildModelHandleCatalog,
  mergeModelHandleCatalogs,
  modelHandleRef,
  modelHandleTarget,
  normalizeModelHandleCatalog,
  reconcileHistoricalModelHandleCatalogs,
  resolveModelToolArguments
} = load('backend/reliableKernel/modelHandleCatalog.js');
const {
  NATIVE_CHILD_HANDLE_PROJECTION_EVENT,
  forkInheritedChildTargets,
  readConversationChildHandles,
  readConversationContextHandleCatalog,
  readConversationContextHandleState,
  readNativeRequestContextHandleCatalog,
  withChildHandles
} = load('backend/reliableKernel/conversationChildHandles.js');
const { ReliableChildAgentCoordinator } = load('backend/reliableKernel/childAgentCoordinator.js');

const entry = (kind, ref, target) => ({ kind, ref, target });
const legacy = (...entries) => ({ entries });
const current = (entries, retiredRefs = []) => ({
  entries, retiredRefs, identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION
});
const recipe = (catalog, kind = 'reliable-agent-turn') => ({ kind, modelHandleCatalog: catalog });
const triples = catalog => catalog.entries.map(({ kind, ref, target }) => [kind, ref, target]).sort();
const ordinal = ref => Number(ref.slice(1));
const isConflict = error => error.code === 'MODEL_CONTEXT_CHILD_HANDLE_CONFLICT';

/** Repository reads and immutable CAS bytes; no provider or effect dispatch is involved. */
function historyFixture(initial = [], conversationId = 'history') {
  const domains = { Turn: [], ModelRequest: [], ContentObject: [], ToolCallSourceLink: [], ToolCallEvent: [] };
  const contents = new Map();
  const reads = [];
  let serial = 0;
  let reverseReads = false;
  const putContent = (id, value, contentType = 'application/json') => {
    domains.ContentObject.push({ id, content_type: contentType });
    contents.set(id, Buffer.from(JSON.stringify(value)));
    return id;
  };
  const append = ({ turn = 'turn-main', catalog, kind, native = [], conversation = conversationId, seq } = {}) => {
    const requestId = `request-${serial++}`;
    if (!domains.Turn.some(row => row.id === turn)) {
      domains.Turn.push({ id: turn, conversation_id: conversation, created_at: '2026-09-30T00:00:00.000Z' });
    }
    const recipeId = putContent(`recipe-${requestId}`, recipe(catalog, kind));
    domains.ModelRequest.push({ id: requestId, turn_id: turn, request_seq: BigInt(seq ?? serial), recipe_object_id: recipeId });
    native.forEach((projectionCatalog, index) => {
      const toolCallId = `native-call-${requestId}-${index}`;
      const projectionId = putContent(`projection-${requestId}-${index}`, {
        kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT, modelRequestId: requestId,
        toolCallId, toolModelResultId: `result-${toolCallId}`, toolName: 'bash',
        ...(projectionCatalog.identityContractRevision
          ? { modelHandleCatalog: projectionCatalog }
          : { childHandles: projectionCatalog.entries }),
        output: JSON.stringify({ status: 'succeeded', detail: { processRef: 'P1' } })
      }, 'application/vnd.limcode.native-child-handle-projection+json');
      domains.ToolCallSourceLink.push({ id: `source-${toolCallId}`, model_request_id: requestId, tool_call_id: toolCallId });
      domains.ToolCallEvent.push({ id: `event-${toolCallId}`, tool_call_id: toolCallId,
        event_kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT, content_object_id: projectionId });
    });
    return requestId;
  };
  const selected = read => (domains[read.domain] ?? []).filter(row =>
    Object.entries(read.where ?? {}).every(([key, value]) => row[key] === value));
  const fixture = {
    domains, contents, reads, append,
    reverse() { reverseReads = !reverseReads; },
    database: {
      async snapshotAll(read) { const rows = selected(read); return { snapshot: reverseReads ? rows.reverse() : rows }; },
      async snapshot(queries) {
        return { snapshot: queries.map(read => read.id !== undefined
          ? (domains[read.domain] ?? []).find(row => row.id === read.id) ?? null : selected(read)) };
      }
    },
    store: {
      async read(metadata) {
        reads.push(metadata.id);
        const bytes = contents.get(metadata.id);
        if (!bytes) throw new Error(`Missing CAS bytes for ${metadata.id}`);
        return Buffer.from(bytes);
      },
      async readMany(metadata) { return Promise.all(metadata.map(value => this.read(value))); }
    }
  };
  initial.forEach(append);
  return fixture;
}

const agentKinds = [
  { kind: 'child', prefix: 'A', argument: 'childRef', canonicalKey: 'answerBridgeId', targets: ['bridge-alpha', 'bridge-beta'],
    candidate: target => ({ answerBridgeId: target }),
    resolve: (ref, catalog) => resolveModelToolArguments('run_agent', { operation: 'read', childRef: ref }, catalog) },
  { kind: 'conversation', prefix: 'C', argument: 'conversationRef', canonicalKey: 'targetConversationId',
    targets: ['conversation-alpha', 'conversation-beta'], candidate: target => ({ kind: 'agent_collaboration', conversationId: target }),
    resolve: (ref, catalog) => resolveModelToolArguments('send_agent_message', { conversationRef: ref, text: 'hello' }, catalog) },
  { kind: 'collaborationMessage', prefix: 'M', argument: 'messageRef', canonicalKey: 'messageId',
    targets: ['collaboration-alpha', 'collaboration-beta'], candidate: target => ({ kind: 'agent_collaboration', messageId: target }),
    resolve: (ref, catalog) => resolveModelToolArguments('read_agent_messages', { messageRef: ref }, catalog) },
  { kind: 'conversationMessage', prefix: 'R', argument: 'messageRef', canonicalKey: 'messageId',
    targets: ['message-alpha', 'message-beta'], candidate: target => ({ kind: 'agent_collaboration', conversationMessageId: target }),
    resolve: (ref, catalog) => resolveModelToolArguments('read_agent_messages', { view: 'conversation', messageRef: ref }, catalog) },
  { kind: 'boardChannel', prefix: 'H', argument: 'channelRef', canonicalKey: 'channelId', targets: ['channel-alpha', 'channel-beta'],
    candidate: target => ({ kind: 'agent_collaboration', channelId: target }),
    resolve: (ref, catalog) => resolveModelToolArguments('agent_board', { operation: 'read', channelRef: ref }, catalog) },
  { kind: 'boardThread', prefix: 'T', argument: 'threadRef', canonicalKey: 'threadId', targets: ['thread-alpha', 'thread-beta'],
    candidate: target => ({ kind: 'agent_collaboration', threadId: target }),
    resolve: (ref, catalog) => resolveModelToolArguments('agent_board', { operation: 'read', threadRef: ref }, catalog) },
  { kind: 'boardPost', prefix: 'B', argument: 'postRef', canonicalKey: 'postId', targets: ['post-alpha', 'post-beta'],
    candidate: target => ({ kind: 'agent_collaboration', postId: target }),
    resolve: (ref, catalog) => resolveModelToolArguments('agent_board', { operation: 'read', postRef: ref }, catalog) }
];

const kinds = [
  { kind: 'process', prefix: 'P', argument: 'processRef', canonicalKey: 'processId', targets: ['process-alpha', 'process-beta'],
    candidate: target => ({ processId: target }),
    resolve: (ref, catalog) => resolveModelToolArguments('bash', { mode: 'output', processRef: ref }, catalog) },
  { kind: 'cursor', prefix: 'O', argument: 'cursor', canonicalKey: 'outputHandle', targets: ['rk-process-output:alpha', 'rk-process-output:beta'],
    candidate: target => ({ nextOutputHandle: target }),
    resolve: (ref, catalog) => {
      const withProcess = buildModelHandleCatalog([{ processId: 'process-cursor-check' }], catalog);
      return resolveModelToolArguments('bash', { mode: 'output',
        processRef: modelHandleRef(withProcess, 'process', 'process-cursor-check'), cursor: ref }, withProcess);
    } },
  { kind: 'workEnvironment', prefix: 'W', argument: 'workEnvironmentRef', canonicalKey: 'workEnvironmentId', targets: ['work-env-alpha', 'work-env-beta'],
    candidate: target => ({ workEnvironmentId: target }),
    resolve: (ref, catalog) => resolveModelToolArguments('switch_work_environment', { workEnvironmentRef: ref }, catalog) },
  ...agentKinds
];

for (const spec of kinds) for (const sameTurn of [false, true]) {
  test(`historical ${spec.prefix}1 reuse ${sameTurn ? 'within one Turn' : 'across Turns'} retires the ambiguous address`, async () => {
    const ref = `${spec.prefix}1`;
    const old = spec.targets.map(target => entry(spec.kind, ref, target));
    const fixture = historyFixture(old.map((value, index) => ({
      turn: sameTurn ? 'one-turn' : `turn-${index}`, catalog: legacy(value),
      kind: 'reliable-agent-turn'
    })));
    const before = [...fixture.contents].map(([id, bytes]) => [id, bytes.toString('utf8')]);
    const catalog = await readConversationContextHandleCatalog(fixture.database, fixture.store, 'history');
    assert.deepEqual(catalog.retiredRefs, [ref]);
    assert.equal(catalog.identityContractRevision, CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION);
    assert.equal(modelHandleTarget(catalog, spec.kind, ref), undefined);
    for (const target of spec.targets) {
      const fresh = modelHandleRef(catalog, spec.kind, target);
      assert.ok(fresh && ordinal(fresh) > 1, 'each canonical target remains addressable under a fresh reference');
      assert.equal(spec.resolve(fresh, catalog)[spec.canonicalKey], target);
    }
    assert.throws(() => spec.resolve(ref, catalog), error =>
      error instanceof UnknownModelHandleReferenceError && error.code === 'UNKNOWN_MODEL_HANDLE_REFERENCE'
      && error.kind === spec.kind && error.argument === spec.argument
      && error.message.includes(ref) && /已失效/.test(error.message) && /历史/.test(error.message));
    assert.deepEqual([...fixture.contents].map(([id, bytes]) => [id, bytes.toString('utf8')]), before,
      'repair freezes new request state without rewriting old recipes or native outputs');
    assert.equal(new Set(fixture.reads).size, 2, 'older requests of the same Turn must contribute evidence');
    assert.deepEqual(await readConversationChildHandles(fixture.database, fixture.store, 'history'), catalog.entries);
  });
}

test('same canonical target under multiple old addresses retires every involved address', () => {
  const catalog = reconcileHistoricalModelHandleCatalogs([
    legacy(entry('process', 'P1', 'process-shared')),
    legacy(entry('process', 'P2', 'process-shared'), entry('process', 'P12', 'process-unaffected'))
  ]);
  assert.deepEqual(catalog.retiredRefs, ['P1', 'P2']);
  assert.equal(modelHandleRef(catalog, 'process', 'process-unaffected'), 'P12');
  assert.equal(modelHandleRef(catalog, 'process', 'process-shared'), 'P13');
  for (const ref of catalog.retiredRefs) assert.equal(modelHandleTarget(catalog, 'process', ref), undefined);
});

test('a connected ambiguity retires all involved addresses rather than choosing one historical target', () => {
  const catalog = reconcileHistoricalModelHandleCatalogs([
    legacy(entry('process', 'P1', 'process-a'), entry('process', 'P2', 'process-b')),
    legacy(entry('process', 'P1', 'process-b'), entry('process', 'P2', 'process-c')),
    legacy(entry('process', 'P3', 'process-c'))
  ]);
  assert.deepEqual(catalog.retiredRefs, ['P1', 'P2', 'P3']);
  assert.equal(new Set(catalog.entries.map(value => value.target)).size, 3);
  assert.ok(catalog.entries.every(value => ordinal(value.ref) > 3));
});

test('historical repair is independent of request listing order and backwards wall clocks', async () => {
  const fixture = historyFixture([
    { turn: 'z-older', catalog: legacy(entry('process', 'P1', 'process-z'), entry('cursor', 'O4', 'rk-process-output:z')) },
    { turn: 'a-newer', catalog: legacy(entry('process', 'P1', 'process-a'), entry('cursor', 'O4', 'rk-process-output:a')) },
    { turn: 'z-older', catalog: legacy(entry('process', 'P30', 'process-retained')), seq: 99 }
  ]);
  fixture.domains.Turn[0].created_at = '2026-09-30T00:01:00.000Z';
  fixture.domains.Turn[1].created_at = '2026-09-30T00:00:59.000Z';
  const first = await readConversationContextHandleCatalog(fixture.database, fixture.store, 'history');
  fixture.reverse();
  const second = await readConversationContextHandleCatalog(fixture.database, fixture.store, 'history');
  assert.deepEqual(second, first);
  assert.equal(modelHandleRef(first, 'process', 'process-retained'), 'P30');
  assert.ok(ordinal(modelHandleRef(first, 'process', 'process-a')) > 30);
  assert.ok(ordinal(modelHandleRef(first, 'process', 'process-z')) > 30);
});

test('unambiguous process/cursor/environment and persistent Agent identities keep their historical refs', () => {
  const entries = [entry('process', 'P8', 'process-stable'), entry('cursor', 'O9', 'rk-process-output:stable'),
    entry('workEnvironment', 'W3', 'work-env-stable'), entry('child', 'A1', 'bridge-one'),
    entry('conversation', 'C1', 'conversation-one'), entry('collaborationMessage', 'M1', 'collaboration-one'),
    entry('conversationMessage', 'R1', 'message-one'), entry('boardChannel', 'H1', 'channel-one'),
    entry('boardThread', 'T1', 'thread-one'), entry('boardPost', 'B1', 'post-one')];
  const repaired = reconcileHistoricalModelHandleCatalogs([legacy(...entries), legacy(...entries.slice().reverse())]);
  assert.deepEqual(triples(repaired), triples({ entries }));
  assert.deepEqual(repaired.retiredRefs, []);
});

for (const spec of agentKinds) {
  test(`published ${spec.prefix} aliases retire same-ref and same-target ambiguity, while current identities stay strict`, () => {
    const original = entry(spec.kind, `${spec.prefix}1`, spec.targets[0]);
    const changedTarget = { ...original, target: spec.targets[1] };
    const changedRef = { ...original, ref: `${spec.prefix}2` };
    for (const changed of [changedTarget, changedRef]) {
      const repaired = reconcileHistoricalModelHandleCatalogs([legacy(original), legacy(changed)]);
      assert.ok(repaired.retiredRefs.includes(original.ref));
      assert.ok(repaired.retiredRefs.includes(changed.ref));
      assert.ok(repaired.entries.every(value => ordinal(value.ref) > Math.max(ordinal(original.ref), ordinal(changed.ref))));
      assert.throws(() => reconcileHistoricalModelHandleCatalogs([current([original]), legacy(changed)]), isConflict);
      assert.throws(() => reconcileHistoricalModelHandleCatalogs([current([original]), current([changed])]), isConflict);
      assert.throws(() => mergeModelHandleCatalogs(legacy(original), legacy(changed)), isConflict,
        'an active published request keeps its strict frozen scope');
    }
  });

  test(`clock rollback history minted ${spec.prefix} aliases with published allocation recovers and then stays stable`, async () => {
    // The old allocator is the same seeded enumeration, without the new identity marker.
    // Published readConversationChildHandles selected the maximum Turn.created_at group;
    // the standalone v0.0.34 source VM reproduces these exact inputs and resulting catalogs.
    const publishedBuild = (values, seeds = []) => legacy(...buildModelHandleCatalog(values, seeds).entries);
    const fixture = historyFixture();
    const targetA = `${spec.kind}-before-clock-rollback`;
    const targetB = `${spec.kind}-after-clock-rollback`;
    const targetC = `${spec.kind}-after-compression`;
    const first = publishedBuild([spec.candidate(targetA)]);
    fixture.append({ turn: 'turn-before-clock-rollback', catalog: first });
    const second = publishedBuild([spec.candidate(targetB)], first.entries);
    fixture.append({ turn: 'turn-after-clock-rollback', catalog: second });
    fixture.domains.Turn[0].created_at = '2026-09-30T10:00:00.000Z';
    fixture.domains.Turn[1].created_at = '2026-09-30T09:00:00.000Z';
    assert.equal(modelHandleRef(second, spec.kind, targetB), `${spec.prefix}2`);

    const obsoleteTurn = fixture.domains.Turn.reduce((latest, value) =>
      value.created_at > latest.created_at ? value : latest);
    const obsoleteRequest = fixture.domains.ModelRequest.find(value => value.turn_id === obsoleteTurn.id);
    const staleSeeds = JSON.parse(fixture.contents.get(obsoleteRequest.recipe_object_id)).modelHandleCatalog.entries;
    assert.deepEqual(staleSeeds, first.entries, 'wall-clock selection lost the later reservation');
    const values = [`Compressed history retains ${spec.prefix}2 only as prose.`, spec.candidate(targetC)];
    if (spec.kind === 'child') values.push({ kind: 'runtime_status_card', childHandleTargets: [
      { answerBridgeId: targetB }, { answerBridgeId: targetC }, { answerBridgeId: targetA }
    ] });
    const third = publishedBuild(values, staleSeeds);
    assert.equal(modelHandleRef(third, spec.kind, targetC), `${spec.prefix}2`,
      'materialized tool results precede the runtime child status card, even when every child is included');
    fixture.append({ turn: 'turn-after-compression', catalog: third });
    fixture.domains.Turn[2].created_at = '2026-09-30T09:01:00.000Z';
    const before = [...fixture.contents].map(([id, value]) => [id, value.toString('utf8')]);
    const repaired = await readConversationContextHandleCatalog(fixture.database, fixture.store, 'history');
    assert.ok(repaired.retiredRefs.includes(`${spec.prefix}2`));
    const previousMaximum = Math.max(...[first, second, third].flatMap(catalog => catalog.entries.map(value => ordinal(value.ref))));
    for (const target of [targetB, targetC]) {
      assert.ok(ordinal(modelHandleRef(repaired, spec.kind, target)) > previousMaximum);
    }
    assert.equal(modelHandleRef(repaired, spec.kind, targetA), `${spec.prefix}1`);
    assert.deepEqual([...fixture.contents].map(([id, value]) => [id, value.toString('utf8')]), before);
    fixture.reverse();
    assert.deepEqual(await readConversationContextHandleCatalog(fixture.database, fixture.store, 'history'), repaired);
    fixture.append({ turn: 'new-contract-request', catalog: repaired });
    assert.deepEqual(await readConversationContextHandleCatalog(fixture.database, fixture.store, 'history'), repaired);
    const next = buildModelHandleCatalog([spec.candidate(`${spec.kind}-new-after-repair`)], repaired);
    assert.ok(ordinal(modelHandleRef(next, spec.kind, `${spec.kind}-new-after-repair`))
      > Math.max(...repaired.entries.map(value => ordinal(value.ref))));
    let dispatched = 0;
    for (const ref of repaired.retiredRefs) {
      assert.throws(() => {
        const argumentsForDispatch = spec.resolve(ref, next);
        dispatched += 1;
        return argumentsForDispatch;
      }, error => error instanceof UnknownModelHandleReferenceError && /已失效/.test(error.message));
    }
    assert.equal(dispatched, 0, 'retired refs never produce canonical arguments for dispatch');
  });
}

test('a repaired inherited child reference does not grant its fork a parent-child relation', async () => {
  const repaired = reconcileHistoricalModelHandleCatalogs([
    legacy(entry('child', 'A1', 'bridge-source-a')),
    legacy(entry('child', 'A1', 'bridge-source-b'))
  ]);
  const catalog = buildModelHandleCatalog([{ answerBridgeId: 'bridge-fork-own' }], repaired);
  const own = { answerBridgeId: 'bridge-fork-own', depth: 1, parentConversationId: 'fork' };
  const projection = { conversationId: 'fork', tasks: [own] };
  const coordinator = new ReliableChildAgentCoordinator({
    database: { hostBootId: 'fixture', async snapshot() { return { snapshot: [[{ target_conversation_id: 'fork' }]] }; } },
    children: { async readConversationChildHandles() { return catalog.entries; } }
  });
  assert.deepEqual(new Set(forkInheritedChildTargets(catalog.entries, new Set([own.answerBridgeId]))),
    new Set(['bridge-source-a', 'bridge-source-b']));
  for (const target of ['bridge-source-a', 'bridge-source-b']) {
    const ref = modelHandleRef(catalog, 'child', target);
    const resolved = resolveModelToolArguments('run_agent', { operation: 'read', childRef: ref }, catalog);
    assert.equal(resolved.answerBridgeId, target, 'repair restores an address, not ownership');
    for (const scope of ['direct', 'tree']) {
      await assert.rejects(coordinator.requireScopedChildTask(projection, resolved.answerBridgeId, scope), /属于分支来源对话/);
    }
  }
  assert.equal(await coordinator.requireScopedChildTask(projection, own.answerBridgeId, 'direct'), own);
  assert.throws(() => resolveModelToolArguments('run_agent', { operation: 'interrupt', childRef: 'A1' }, catalog),
    error => error instanceof UnknownModelHandleReferenceError && /已失效/.test(error.message));
});

test('registry-owned attachment ambiguity still fails and attachment slots cannot be retired', () => {
  assert.throws(() => reconcileHistoricalModelHandleCatalogs([
    legacy(entry('attachment', 'F1', 'attachment-a')),
    legacy(entry('attachment', 'F1', 'attachment-b'))
  ]), isConflict);
  assert.throws(() => normalizeModelHandleCatalog(current([], ['F1'])));
});

test('new allocations exceed all historical ordinals, including a disappearing older request and retired slots', async () => {
  const fixture = historyFixture([
    { catalog: legacy(entry('process', 'P50', 'process-disappeared'), entry('cursor', 'O40', 'rk-process-output:old'),
      entry('workEnvironment', 'W30', 'work-env-old')) },
    { catalog: legacy(entry('process', 'P1', 'process-a'), entry('cursor', 'O1', 'rk-process-output:a'),
      entry('workEnvironment', 'W1', 'work-env-a')) },
    { catalog: legacy(entry('process', 'P1', 'process-b'), entry('cursor', 'O1', 'rk-process-output:b'),
      entry('workEnvironment', 'W1', 'work-env-b')) }
  ]);
  const repaired = await readConversationContextHandleCatalog(fixture.database, fixture.store, 'history');
  const allocated = buildModelHandleCatalog([{ processId: 'process-new', nextOutputHandle: 'rk-process-output:new',
    workEnvironmentId: 'work-env-new' }], repaired);
  for (const [kind, target, minimum] of [['process', 'process-new', 50], ['cursor', 'rk-process-output:new', 40],
    ['workEnvironment', 'work-env-new', 30]]) {
    assert.ok(ordinal(modelHandleRef(allocated, kind, target)) > minimum);
  }
  assert.deepEqual(allocated.retiredRefs, repaired.retiredRefs);
});

test('new frozen request and restart preserve repaired identities without retiring them again', async () => {
  const fixture = historyFixture([
    { turn: 'before', catalog: legacy(entry('process', 'P1', 'process-a')) },
    { turn: 'after', catalog: legacy(entry('process', 'P1', 'process-b')) }
  ]);
  const repaired = await readConversationContextHandleCatalog(fixture.database, fixture.store, 'history');
  fixture.append({ turn: 'upgrade-request', catalog: JSON.parse(JSON.stringify(repaired)) });
  fixture.reverse();
  const reopened = await readConversationContextHandleCatalog(fixture.database, fixture.store, 'history');
  assert.deepEqual(reopened, repaired);
  assert.deepEqual(await readConversationContextHandleCatalog(fixture.database, fixture.store, 'history'), repaired);
  assert.deepEqual(reconcileHistoricalModelHandleCatalogs([repaired, legacy(entry('process', 'P1', 'process-a'))]), repaired);
});

test('native reset remains required until an ordinary request freezes the same current identity state', async () => {
  const fixture = historyFixture([
    { turn: 'before', catalog: legacy(entry('process', 'P1', 'process-a')) },
    { turn: 'after', catalog: legacy(entry('process', 'P1', 'process-b')) }
  ]);
  const initial = await readConversationContextHandleState(fixture.database, fixture.store, 'history');
  assert.equal(initial.requiresNativeReset, true);
  fixture.append({ turn: 'compression-only', kind: 'reliable-context-compression', catalog: initial.catalog });
  assert.equal((await readConversationContextHandleState(fixture.database, fixture.store, 'history')).requiresNativeReset, true,
    'a compression request is not proof that an ordinary native chain adopted repaired identities');
  fixture.append({ turn: 'first-repaired-ordinary', catalog: {
    ...initial.catalog, entries: [...initial.catalog.entries.map(value => ({ ...value, name: 'display-name-only' })),
      entry('attachment', 'F1', 'attachment-unrelated')]
  } });
  assert.equal((await readConversationContextHandleState(fixture.database, fixture.store, 'history')).requiresNativeReset, false,
    'display metadata and attachment handles do not change the persistent context identity');
  fixture.append({ turn: 'later-merged-evidence', catalog: legacy(entry('process', 'P77', 'process-merged-late')) });
  assert.equal((await readConversationContextHandleState(fixture.database, fixture.store, 'history')).requiresNativeReset, true,
    'a previously frozen ordinary recipe cannot certify evidence added by a later history merge');
  const clean = historyFixture([{ catalog: legacy(entry('process', 'P1', 'process-only')) }]);
  assert.equal((await readConversationContextHandleState(clean.database, clean.store, 'history')).requiresNativeReset, false,
    'unambiguous history needs no provider-chain reset');
});

test('new-contract ambiguity remains a failure rather than another automatic historical repair', async () => {
  const fixture = historyFixture([
    { turn: 'first', catalog: current([entry('process', 'P3', 'process-a')], ['P1', 'P2']) },
    { turn: 'second', catalog: current([entry('process', 'P3', 'process-b')], ['P1', 'P2']) }
  ]);
  await assert.rejects(readConversationContextHandleCatalog(fixture.database, fixture.store, 'history'), isConflict);
  assert.throws(() => mergeModelHandleCatalogs(
    current([entry('cursor', 'O2', 'rk-process-output:a')]),
    current([entry('cursor', 'O3', 'rk-process-output:a')])
  ), isConflict);
});

test('native expansion of a repaired ordinary request adopts that complete scope until new external historical evidence arrives', async () => {
  const fixture = historyFixture([
    { turn: 'old-a', catalog: legacy(entry('process', 'P1', 'process-a')) },
    { turn: 'old-b', catalog: legacy(entry('process', 'P1', 'process-b')) }
  ]);
  const repaired = await readConversationContextHandleCatalog(fixture.database, fixture.store, 'history');
  const expanded = buildModelHandleCatalog([{ processId: 'process-added-in-native-chain' }], repaired);
  fixture.append({ turn: 'repaired-ordinary-with-native-output', catalog: repaired, native: [expanded] });
  const adopted = await readConversationContextHandleState(fixture.database, fixture.store, 'history');
  assert.deepEqual(adopted.catalog, expanded);
  assert.equal(adopted.requiresNativeReset, false,
    'the current ordinary request and its frozen native outputs already adopted the complete repaired scope');
  fixture.append({ turn: 'external-history-a', catalog: legacy(entry('process', 'P50', 'process-external-a')) });
  fixture.append({ turn: 'external-history-b', catalog: legacy(entry('process', 'P50', 'process-external-b')) });
  const changed = await readConversationContextHandleState(fixture.database, fixture.store, 'history');
  assert.deepEqual(changed.catalog.retiredRefs, ['P1', 'P50']);
  assert.equal(changed.requiresNativeReset, true, 'the new ambiguity was not adopted by the prior native scope');
});

test('strict parsing rejects malformed single catalogs and unknown contracts before reconciliation', async () => {
  const invalid = [
    null,
    'broken',
    [],
    {},
    { entries: 'broken' },
    { entries: null },
    { entries: {} },
    legacy(entry('process', 'P1', 'process-a'), entry('process', 'P1', 'process-b')),
    legacy(entry('child', 'A1', 'bridge-a'), entry('child', 'A1', 'bridge-b')),
    legacy(entry('conversation', 'C1', 'conversation-a'), entry('conversation', 'C2', 'conversation-a')),
    legacy(entry('cursor', 'P1', 'rk-process-output:a')),
    current([entry('process', 'P1', 'process-a')], ['P1']),
    current([], ['F1']),
    current([], ['Z1']),
    current([], ['A0']),
    { entries: [], identityContractRevision: '2099-01-01', retiredRefs: [] },
    { entries: [], identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION }
  ];
  for (const catalog of invalid) {
    assert.throws(() => normalizeModelHandleCatalog(catalog));
    const fixture = historyFixture([{ catalog }]);
    await assert.rejects(readConversationContextHandleCatalog(fixture.database, fixture.store, 'history'));
  }
});

test('published recipes with no catalog remain valid empty identity evidence', async () => {
  assert.deepEqual(normalizeModelHandleCatalog(undefined), { entries: [] });
  const fixture = historyFixture([{ catalog: undefined }]);
  const state = await readConversationContextHandleState(fixture.database, fixture.store, 'history');
  assert.deepEqual(state.catalog.entries, []);
  assert.deepEqual(state.catalog.retiredRefs, []);
  assert.equal(state.requiresNativeReset, false);
});

test('missing old CAS metadata or bytes is a failure even when a newer recipe is valid', async () => {
  for (const missing of ['metadata', 'bytes']) {
    const fixture = historyFixture([
      { catalog: legacy(entry('process', 'P1', 'process-a')) },
      { catalog: legacy(entry('process', 'P2', 'process-b')) }
    ]);
    const firstRecipe = fixture.domains.ModelRequest[0].recipe_object_id;
    if (missing === 'metadata') fixture.domains.ContentObject = fixture.domains.ContentObject.filter(row => row.id !== firstRecipe);
    else fixture.contents.delete(firstRecipe);
    await assert.rejects(readConversationContextHandleCatalog(fixture.database, fixture.store, 'history'), /missing|Missing|CAS/i);
  }
});

test('native output evidence from an older request participates even when its final recipe omitted the handle', async () => {
  const fixture = historyFixture([
    { turn: 'same-turn', catalog: legacy(), native: [legacy(entry('process', 'P1', 'process-native'))] },
    { turn: 'same-turn', catalog: legacy(entry('process', 'P1', 'process-later')) }
  ]);
  const catalog = await readConversationContextHandleCatalog(fixture.database, fixture.store, 'history');
  assert.deepEqual(catalog.retiredRefs, ['P1']);
  assert.notEqual(modelHandleRef(catalog, 'process', 'process-native'), 'P1');
  assert.notEqual(modelHandleRef(catalog, 'process', 'process-later'), 'P1');
  assert.ok(fixture.reads.includes('projection-request-0-0'));
});

test('a new native event on an old active request retains its legacy scope instead of claiming the new global contract', async () => {
  const native = legacy(entry('process', 'P1', 'process-old-active'));
  const fixture = historyFixture([
    { turn: 'old-active', catalog: legacy(), native: [native] },
    { turn: 'other-old-turn', catalog: legacy(entry('process', 'P1', 'process-other-history')) }
  ]);
  const projectionId = 'projection-request-0-0';
  const projection = JSON.parse(fixture.contents.get(projectionId).toString('utf8'));
  delete projection.childHandles;
  projection.modelHandleCatalog = native;
  fixture.contents.set(projectionId, Buffer.from(JSON.stringify(projection)));
  const requestLocal = await readNativeRequestContextHandleCatalog(fixture.database, fixture.store, 'request-0');
  assert.deepEqual(requestLocal, native, 'the new event shape does not promote the old request identity scope');
  const global = await readConversationContextHandleCatalog(fixture.database, fixture.store, 'history');
  assert.deepEqual(global.retiredRefs, ['P1']);
  assert.notEqual(modelHandleRef(global, 'process', 'process-old-active'), 'P1');
  assert.notEqual(modelHandleRef(global, 'process', 'process-other-history'), 'P1');
});

for (const spec of kinds) {
  test(`native ${spec.prefix} request scope rejects contradictory outputs in both replay and global historical reads`, async () => {
    const ref = `${spec.prefix}1`;
    const first = legacy(entry(spec.kind, ref, spec.targets[0]));
    const second = legacy(entry(spec.kind, ref, spec.targets[1]));
    const nativeConflict = historyFixture([{ catalog: legacy(), native: [first, second] }]);
    await assert.rejects(readNativeRequestContextHandleCatalog(nativeConflict.database, nativeConflict.store, 'request-0'), isConflict);
    await assert.rejects(readConversationContextHandleCatalog(nativeConflict.database, nativeConflict.store, 'history'), isConflict,
      'request-local corruption is not a repairable cross-request alias');
    const recipeConflict = historyFixture([{ catalog: first, native: [second] }]);
    await assert.rejects(readConversationContextHandleCatalog(recipeConflict.database, recipeConflict.store, 'history'), isConflict,
      'native outputs must also agree with their own frozen request recipe');
    const crossRequest = historyFixture([
      { turn: 'same-turn', catalog: first, native: [first] },
      { turn: 'same-turn', catalog: second, native: [second] }
    ]);
    const repaired = await readConversationContextHandleCatalog(crossRequest.database, crossRequest.store, 'history');
    assert.deepEqual(repaired.retiredRefs, [ref], 'individually valid request scopes still participate in cross-request repair');
  });
}

test('malformed native projection payloads are rejected rather than treated as empty historical evidence', async () => {
  for (const mutate of [
    projection => { projection.modelHandleCatalog = current([]); },
    projection => { delete projection.childHandles; },
    projection => { projection.extraIdentityField = 'unrecognized'; }
  ]) {
    const fixture = historyFixture([{ catalog: legacy(), native: [legacy(entry('process', 'P1', 'process-native'))] }]);
    const projectionId = 'projection-request-0-0';
    const projection = JSON.parse(fixture.contents.get(projectionId).toString('utf8'));
    mutate(projection);
    fixture.contents.set(projectionId, Buffer.from(JSON.stringify(projection)));
    await assert.rejects(readConversationContextHandleCatalog(fixture.database, fixture.store, 'history'), isConflict);
  }
});

test('new native projections carry retirement state into the next batch and preserve frozen wire output', async () => {
  const repaired = reconcileHistoricalModelHandleCatalogs([
    legacy(entry('process', 'P1', 'process-a')),
    legacy(entry('process', 'P1', 'process-b'))
  ]);
  const nativeCatalog = buildModelHandleCatalog([{ processId: 'process-native' }], repaired);
  const fixture = historyFixture([{ catalog: repaired, native: [nativeCatalog] }]);
  const projectionBefore = fixture.contents.get('projection-request-0-0').toString('utf8');
  const restored = await readNativeRequestContextHandleCatalog(fixture.database, fixture.store, 'request-0');
  assert.deepEqual(restored, nativeCatalog);
  assert.deepEqual(restored.retiredRefs, ['P1']);
  const next = buildModelHandleCatalog([{ processId: 'process-next' }], withChildHandles(restored, []));
  assert.ok(ordinal(modelHandleRef(next, 'process', 'process-next')) > ordinal(modelHandleRef(restored, 'process', 'process-native')));
  assert.deepEqual(next.retiredRefs, ['P1']);
  assert.equal(fixture.contents.get('projection-request-0-0').toString('utf8'), projectionBefore);
});

test('native context additions retain source attachment identities without allocating outside the attachment registry', () => {
  const sourceAttachment = entry('attachment', 'F1', 'attachment-source');
  const sourceProcess = entry('process', 'P2', 'process-source');
  const source = current([sourceAttachment, sourceProcess], ['P1']);
  const addedProcess = entry('process', 'P4', 'process-new');
  const additions = current([entry('attachment', 'F2', 'attachment-new'), addedProcess], ['P1']);
  const extended = withChildHandles(source, additions);
  assert.deepEqual(triples(extended), triples({ entries: [sourceAttachment, sourceProcess, addedProcess] }));
  assert.equal(modelHandleRef(extended, 'attachment', 'attachment-source'), 'F1');
  assert.equal(modelHandleRef(extended, 'attachment', 'attachment-new'), undefined);
  assert.equal(modelHandleTarget(extended, 'attachment', 'F2'), undefined);
  assert.deepEqual(extended.retiredRefs, ['P1']);
  assert.deepEqual(source, current([sourceAttachment, sourceProcess], ['P1']), 'the registry-owned source catalog remains frozen');
  const conflictingAttachmentAddition = current([entry('attachment', 'F1', 'attachment-other'), addedProcess], ['P1']);
  assert.deepEqual(withChildHandles(source, conflictingAttachmentAddition), extended,
    'attachment identities from native context evidence never supersede or conflict with the registry-owned source');
});

test('copied fork recipes carry repaired state without consulting the live source conversation', async () => {
  const repaired = reconcileHistoricalModelHandleCatalogs([
    legacy(entry('process', 'P1', 'process-a')), legacy(entry('process', 'P1', 'process-b'))
  ]);
  const fixture = historyFixture([
    { conversation: 'fork', turn: 'copied-before', catalog: legacy(entry('process', 'P1', 'process-a')) },
    { conversation: 'fork', turn: 'copied-after', catalog: legacy(entry('process', 'P1', 'process-b')) },
    { conversation: 'fork', turn: 'copied-repaired', catalog: repaired },
    { conversation: 'source', turn: 'source-only', catalog: current([entry('process', 'P2', 'process-unrelated')]) }
  ], 'fork');
  const inherited = await readConversationContextHandleCatalog(fixture.database, fixture.store, 'fork');
  assert.deepEqual(inherited, repaired);
  assert.ok(!fixture.reads.includes('recipe-request-3'), 'source runtime state is not authority for copied immutable history');
  const forkNext = buildModelHandleCatalog([{ processId: 'process-fork-new' }], inherited);
  assert.ok(ordinal(modelHandleRef(forkNext, 'process', 'process-fork-new')) > 3);
  assert.deepEqual(forkNext.retiredRefs, ['P1']);
});

test('later historical merge evidence is rechecked after a repaired request was already frozen', async () => {
  const fixture = historyFixture([
    { turn: 'before', catalog: legacy(entry('process', 'P1', 'process-a')) },
    { turn: 'after', catalog: legacy(entry('process', 'P1', 'process-b')) }
  ]);
  const repaired = await readConversationContextHandleCatalog(fixture.database, fixture.store, 'history');
  fixture.append({ turn: 'already-repaired', catalog: repaired });
  fixture.append({ turn: 'merged-old-history', catalog: legacy(entry('process', 'P1', 'process-c'), entry('process', 'P77', 'process-high')) });
  const merged = await readConversationContextHandleCatalog(fixture.database, fixture.store, 'history');
  for (const value of repaired.entries) assert.equal(modelHandleRef(merged, value.kind, value.target), value.ref,
    'valid current-contract identities remain unchanged');
  assert.deepEqual(merged.retiredRefs, ['P1']);
  assert.ok(ordinal(modelHandleRef(merged, 'process', 'process-c')) > 77);
  const next = buildModelHandleCatalog([{ processId: 'process-after-merge' }], merged);
  assert.ok(ordinal(modelHandleRef(next, 'process', 'process-after-merge')) > 77);
});

const integrationKernel = load('backend/reliableKernel/index.js');
const { LlmCapabilityFullRequestAdapter: HistoricalIntegrationAdapter } =
  load('backend/reliableKernel/llmCapabilityProviderAdapter.js');
const { LlmEventType: historicalIntegrationEvents } = load('backend/world/modules/llm/events.js');

async function historicalRuntimeIntegration(nativeEnabled, verify) {
  const { default: fs } = await import('node:fs/promises');
  const { default: os } = await import('node:os');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'historical-context-runtime-'));
  const authority = new integrationKernel.RootAuthority(() => path.join(directory, 'runtime'));
  await integrationKernel.initializeEmptyRuntimeRoot(authority);
  const providerId = 'historical-integration-provider';
  const conversationId = 'historical-integration-conversation';
  const nativeCapabilities = { asyncTools: true, steering: true, reasoningUpdates: true,
    multiplexing: false, explicitCaching: true };
  const fullRequests = [];
  const wireRequests = [];
  const capability = {
    start(request, emit, options) {
      wireRequests.push(request);
      assert.equal(Boolean(options?.native), nativeEnabled);
      if (nativeEnabled) {
        const responseId = `historical-response-${wireRequests.length}`;
        emit({ type: historicalIntegrationEvents.NativeControl, payload: {
          requestId: request.id, event: { type: 'response.created', responseId, capabilities: nativeCapabilities }
        } });
        emit({ type: historicalIntegrationEvents.NativeControl, payload: {
          requestId: request.id, event: { type: 'response.completed', responseId }
        } });
      }
      emit({ type: historicalIntegrationEvents.Done, payload: {
        requestId: request.id, content: { role: 'model', parts: [{ text: 'continued existing history' }] }
      } });
    },
    abort() {}, cancelRetry() {},
    compact() { assert.fail('this fixture must continue the existing compressed history without another compression'); }
  };
  const projectedAdapter = new HistoricalIntegrationAdapter(providerId, capability);
  const adapter = {
    providerId,
    estimateFullRequestInput(request) { return projectedAdapter.estimateFullRequestInput(request); },
    materializeNativeToolOutput(outputs) { return projectedAdapter.materializeNativeToolOutput(outputs); },
    async sendFullRequest(request, controls) {
      fullRequests.push(request);
      await projectedAdapter.sendFullRequest(request, controls);
    }
  };
  const authorityDocument = request => ({
    kind: 'effective-turn-authority', turnId: request.turnId, conversationId,
    executorAgentId: request.executorAgentId,
    model: { providerConfigId: providerId, provider: 'openai-responses', modelId: 'gpt-6-astra',
      baseUrl: 'https://historical-integration.invalid/v1', openaiResponsesTransport: 'http',
      ...(nativeEnabled ? { nativeResponses: { enabled: true, asyncTools: true, steering: true,
        reasoningUpdates: true, multiplexing: false } } : {}),
      retryPolicy: { enabled: false, maxRetries: 0 } },
    modelProfile: { compressionThresholdTokens: 100000, contextWindowTokens: 128000,
      tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
    toolPolicy: { id: 'historical-tools', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
    planReviewPolicy: { mode: 'never' }, systemPrompt: { id: 'historical-prompt', text: '' },
    runtimeContext: { id: null, name: '', template: '' },
    workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
  });
  const dependencies = {
    authorityCompiler: { async compile(request) { return {
      turnId: request.turnId, executorAgentId: request.executorAgentId,
      executionPreset: { content: JSON.stringify({ providerConfigId: providerId, modelId: 'gpt-6-astra' }) },
      authoritySnapshot: { content: JSON.stringify(authorityDocument(request)) }
    }; } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { assert.fail('unused MCP'); } },
    mcpPolicyGate: { async authorize() { assert.fail('unused MCP authorization'); } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments',
      settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }; } },
    providers: { resolve() { return adapter; } },
    toolDispatcher: { definitions() { return []; }, async dispatch() { assert.fail('no tools should execute'); } }
  };
  let app;
  const rows = async (domain, where = {}) => (await app.database.snapshotAll(
    integrationKernel.DOMAIN_REPOSITORIES.domain(domain).list({ where,
      orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;
  try {
    app = await integrationKernel.ReliableKernelApplication.open(authority, dependencies);
    const now = '2026-09-30T00:00:00.000Z';
    const insert = (domain, row) => integrationKernel.DOMAIN_REPOSITORIES.domain(domain).insert(row);
    const historical = (domain, row) => integrationKernel.DOMAIN_REPOSITORIES.domain(domain).insertHistoricalCopy(row);
    const original = await app.contentStore.ingest(app.database, 'Original history once referred to P1.', 'text/plain');
    const summary = await app.contentStore.ingest(app.database, JSON.stringify({
      kind: 'compression_contents', version: 1,
      contents: [{ role: 'user', parts: [{ text: 'Retained compressed summary: an earlier process was called P1.' }] }]
    }), 'application/vnd.limcode.compression-contents+json');
    const oldMetadata = [original, summary];
    const steps = [
      insert('Conversation', { id: conversationId, title: 'existing compressed history', status: 'active',
        created_at: now, updated_at: now }),
      insert('AgentConversationLink', { id: 'historical-agent-link', conversation_id: conversationId,
        agent_id: 'historical-agent', role: 'default', created_at: now, updated_at: now })
    ];
    for (const [index, target] of ['historical-process-a', 'historical-process-b'].entries()) {
      const turnId = `historical-completed-turn-${index}`;
      const requestId = `historical-completed-request-${index}`;
      const authorityContent = await app.contentStore.ingest(app.database, JSON.stringify(authorityDocument({
        turnId, executorAgentId: 'historical-agent'
      })), 'application/json');
      const oldRecipe = await app.contentStore.ingest(app.database, JSON.stringify(index === 1 ? {
        ...recipe(legacy(entry('process', 'P1', target)), 'reliable-context-compression'),
        compressionMethodKind: 'llm_summary', trigger: 'manual', sourceRootId: 'historical-original-root',
        sourceSegmentCount: 1, attachmentCatalogState: { catalog: [], placements: [] },
        sourceHash: createHash('sha256').update(JSON.stringify([{ segmentId: 'historical-original-segment',
          contentObjectId: original.id, segmentKind: 'system' }])).digest('hex')
      } : recipe(legacy(entry('process', 'P1', target)))), 'application/json');
      oldMetadata.push(authorityContent, oldRecipe);
      steps.push(
        insert('Turn', { id: turnId, conversation_id: conversationId, status: 'terminated',
          created_at: now, updated_at: now, terminal_at: now }),
        insert('TurnTermination', { id: `${turnId}-termination`, turn_id: turnId,
          terminal_status: 'completed', reason: 'completed before upgrade', created_at: now }),
        insert('AuthoritySnapshot', { id: `${turnId}-authority`, turn_id: turnId,
          content_object_id: authorityContent.id, created_at: now }),
        historical('ModelRequest', { id: requestId, turn_id: turnId, request_seq: 1n,
          status: 'terminal', terminal_state: 'completed', provider_id: providerId, model_id: 'gpt-6-astra',
          context_window_tokens: 128000n, compression_threshold_tokens: 100000n, estimated_context_tokens: 30n,
          authority_snapshot_id: `${turnId}-authority`, settings_snapshot_object_id: null,
          recipe_object_id: oldRecipe.id, usage_json: null,
          stream_stats_json: { attemptSeq: '1', socketGeneration: '1', retryReason: null },
          created_at: now, updated_at: now }),
        historical('Operation', { id: `${requestId}-operation`, owner_kind: 'model_request', owner_id: requestId,
          operation_seq: 1n, tool_call_id: null, status: 'completed', created_at: now, updated_at: now }),
        historical('Attempt', { id: `${requestId}-attempt`, operation_id: `${requestId}-operation`,
          attempt_seq: 1n, status: 'completed', created_at: now, updated_at: now, completed_at: now }),
        historical('ModelStreamFence', { id: `${requestId}-fence`, model_request_id: requestId,
          attempt_seq: 1n, socket_generation: 1n, terminal_stream_seq: 1n, outcome: 'completed', created_at: now })
      );
    }
    steps.push(
      insert('ContextSegment', { id: 'historical-original-segment', content_object_id: original.id,
        segment_kind: 'system', created_at: now }),
      insert('ContextSegmentSource', { id: 'historical-original-source', segment_id: 'historical-original-segment',
        source_kind: 'system', source_id: 'historical-original-system', source_revision: 0n, created_at: now }),
      insert('ContextSequenceNode', { id: 'historical-original-node', parent_node_id: null,
        segment_id: 'historical-original-segment', created_at: now }),
      insert('ContextSequenceRoot', { id: 'historical-original-root', conversation_id: conversationId,
        root_seq: 1n, root_node_id: 'historical-original-node', tail_node_id: null,
        tail_segment_count: 0n, segment_count: 1n, estimated_tokens: 30n, created_at: now }),
      insert('ModelContextProjection', { id: 'historical-compression-request-projection', owner_kind: 'model_request',
        owner_id: 'historical-completed-request-1', root_id: 'historical-original-root', purpose: 'provider-request', created_at: now }),
      insert('CompressionBlock', { id: 'historical-compression-block', conversation_id: conversationId,
        status: 'enabled', authority_snapshot_id: 'historical-completed-turn-1-authority',
        title_object_id: original.id, summary_object_id: summary.id, created_at: now, updated_at: now }),
      insert('CompressionBlockSource', { id: 'historical-compression-source',
        compression_block_id: 'historical-compression-block', segment_id: 'historical-original-segment',
        position: 0n, created_at: now }),
      insert('ModelContextProjection', { id: 'historical-compression-projection', owner_kind: 'compression_block',
        owner_id: 'historical-compression-block', root_id: 'historical-original-root', purpose: 'compression-source', created_at: now }),
      insert('ContextSegment', { id: 'historical-summary-segment', content_object_id: summary.id,
        segment_kind: 'compression', created_at: now }),
      insert('ContextSegmentSource', { id: 'historical-summary-source', segment_id: 'historical-summary-segment',
        source_kind: 'compression_block', source_id: 'historical-compression-block', source_revision: 0n, created_at: now }),
      insert('ContextSequenceNode', { id: 'historical-summary-node', parent_node_id: null,
        segment_id: 'historical-summary-segment', created_at: now }),
      insert('ContextSequenceRoot', { id: 'historical-summary-root', conversation_id: conversationId,
        root_seq: 2n, root_node_id: 'historical-summary-node', tail_node_id: null,
        tail_segment_count: 0n, segment_count: 1n, estimated_tokens: 30n, created_at: now }),
      insert('ConversationContextHeadLink', { id: 'historical-context-head', conversation_id: conversationId,
        root_id: 'historical-summary-root', updated_at: now })
    );
    await app.database.transaction(steps);
    const before = await Promise.all(oldMetadata.map(async metadata => [metadata.id,
      (await app.contentStore.read(metadata)).toString('utf8')]));
    const continueConversation = async key => {
      const started = await app.turns.input({ source: { kind: 'command', key }, conversationId,
        leaseOwnerId: 'historical-test-owner', hostBootId: app.database.hostBootId,
        leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), content: 'Continue this existing conversation.' });
      const [lease] = await rows('ExecutionLease', { turn_id: started.turnId });
      const fence = { id: lease.id, conversationId: lease.conversation_id, turnId: lease.turn_id,
        ownerId: lease.owner_id, hostBootId: lease.host_boot_id, generation: BigInt(lease.generation) };
      const result = await integrationKernel.runWithExecutionLeaseFence(fence, () => app.agentLoop.drive(started.turnId));
      assert.equal(result.terminalStatus, 'completed', JSON.stringify(await rows('TurnTermination', { turn_id: started.turnId })));
      assert.equal(result.modelRequestIds.length, 1, 'one input reaches exactly one new model request');
      return result;
    };
    await verify({ rows, continueConversation, fullRequests, wireRequests, async reopen() {
      await app.close();
      app = await integrationKernel.ReliableKernelApplication.open(authority, dependencies);
    }, async frozenRecipe(id) {
      const [request] = await rows('ModelRequest', { id });
      const [metadata] = await rows('ContentObject', { id: request.recipe_object_id });
      return JSON.parse((await app.contentStore.read(metadata)).toString('utf8'));
    }, async assertOldBytes() {
      assert.deepEqual(await Promise.all(oldMetadata.map(async metadata => [metadata.id,
        (await app.contentStore.read(metadata)).toString('utf8')])), before);
    } });
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

for (const nativeEnabled of [false, true]) {
  test(`production ${nativeEnabled ? 'native' : 'ordinary'} Agent loop continues old compressed P1-reuse history without rewriting CAS`,
    { timeout: 30000 }, async () => {
      await historicalRuntimeIntegration(nativeEnabled, async fixture => {
        const first = await fixture.continueConversation('historical-first-after-upgrade');
        assert.equal(fixture.fullRequests.length, 1);
        assert.equal(fixture.wireRequests.length, 1, 'the actual LLM capability is reached once');
        const frozen = await fixture.frozenRecipe(first.modelRequestIds[0]);
        assert.deepEqual(frozen, fixture.fullRequests[0].recipe, 'provider receives the persisted immutable recipe');
        assert.equal(frozen.modelHandleCatalog.identityContractRevision, CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION);
        assert.deepEqual(frozen.modelHandleCatalog.retiredRefs, ['P1']);
        assert.equal(modelHandleTarget(frozen.modelHandleCatalog, 'process', 'P1'), undefined);
        for (const target of ['historical-process-a', 'historical-process-b']) {
          assert.ok(ordinal(modelHandleRef(frozen.modelHandleCatalog, 'process', target)) > 1);
        }
        const system = fixture.wireRequests[0].systemInstruction.parts.map(part => part.text ?? '').join('\n');
        assert.match(system, /Retired historical references: P1/);
        assert.ok(fixture.wireRequests[0].contents.some(content => content.parts.some(part =>
          'text' in part && part.text.includes('Retained compressed summary'))), 'existing summary remains model-visible');
        if (nativeEnabled) {
          assert.equal(frozen.nativeReasoning.forceFullReason, 'context_handle_identity_repair');
          assert.equal(frozen.nativeReasoning.resetCache, true);
          assert.equal(fixture.wireRequests[0].openAIResponsesContinuation.forceFullReason, 'context_handle_identity_repair');
        } else assert.equal(frozen.nativeReasoning, undefined);
        await fixture.assertOldBytes();
        await fixture.reopen();
        const second = await fixture.continueConversation('historical-second-after-reopen');
        assert.equal(fixture.fullRequests.length, 2);
        assert.equal(fixture.wireRequests.length, 2, 'the next input sends once after reopening the same Runtime root');
        const next = await fixture.frozenRecipe(second.modelRequestIds[0]);
        assert.deepEqual(next.modelHandleCatalog, frozen.modelHandleCatalog);
        if (nativeEnabled) {
          assert.equal(next.nativeReasoning.forceFullReason, undefined, 'repair does not reset every native round');
          assert.notEqual(next.nativeReasoning.resetCache, true);
          assert.equal(fixture.wireRequests[1].openAIResponsesContinuation.forceFullReason, undefined);
        }
        await fixture.assertOldBytes();
      });
    });
}
