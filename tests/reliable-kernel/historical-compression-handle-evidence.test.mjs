import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
const { readHistoricalCompressionHandleCatalog } = load('backend/reliableKernel/historicalCompressionHandleCatalog.js');
const { conversationForkSnapshotCopyId } = load('backend/reliableKernel/conversationForkSnapshot.js');
const { stablePhaseFId } = load('backend/reliableKernel/phaseFIdentity.js');
const { rebuildHistoricalConversationContextHandleState, readConversationContextHandleCatalog: readCurrentCatalog } =
  load('backend/reliableKernel/conversationChildHandles.js');
const { emptyConversationContextHandleStateStep } = load('backend/reliableKernel/conversationContextHandleState.js');
// Legacy compression proofs are reconstructed explicitly; ordinary reads use durable current state.
const readConversationContextHandleCatalog = async (...args) => (await rebuildHistoricalConversationContextHandleState(...args)).catalog;
const { buildModelHandleCatalog, CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION,
  modelHandleRef, normalizeModelHandleCatalog, reconcileHistoricalModelHandleCatalogs } =
  load('backend/reliableKernel/modelHandleCatalog.js');

const attachment = { attachmentId: 'attachment-before', name: 'before.png', mimeType: 'image/png', sizeBytes: 1 };
const frozenAttachment = { kind: 'attachment', ref: 'F1', target: attachment.attachmentId,
  name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes };
const call = { role: 'model', parts: [{ functionCall: { name: 'bash', args: { command: 'start a process' } } }] };
const processResult = target => ({ kind: 'tool_pair', toolCall: { toolName: 'bash', arguments: { command: 'start a process' } },
  toolModelResult: { status: 'succeeded', detail: { processId: target, status: 'running' } } });
const message = (id, body) => ({ id, kind: 'message', body, type: 'application/vnd.limcode.message+json' });
const pair = (id, target) => ({ id, kind: 'tool_pair', body: processResult(target), type: 'application/vnd.limcode.tool-pair+json' });
const compression = (id, text = 'Summary only remembers P999 and A999.', native = false) => ({
  id, kind: 'compression', type: 'application/vnd.limcode.compression-contents+json',
  body: { kind: 'compression_contents', version: 1, contents: [{ role: 'user', parts: [
    native ? { providerContext: { provider: 'openai-responses', encryptedContent: 'opaque historical state' } } : { text }
  ] }] }
});

function fixture(items = [message('call', call), pair('result', 'process-historical')], overrides = {}) {
  const conversationId = 'historical-compression-conversation';
  const requestId = 'historical-compression-request';
  const rootId = 'historical-compression-root';
  const domains = { ModelRequest: [], Turn: [], ContentObject: [], ModelContextProjection: [], ContextSequenceRoot: [],
    AuthoritySnapshot: [], ConversationBranchLink: [], ConversationOriginLink: [], ChildExecution: [], ChildExecutionParentLink: [],
    ContextSegment: [], ContextSegmentSource: [], CompressionBlock: [], CompressionBlockSource: [] };
  const contents = new Map();
  const reads = [];
  const putContent = (id, value, type = 'application/json') => {
    const bytes = Buffer.isBuffer(value) ? Buffer.from(value)
      : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const metadata = { id, content_type: type, byte_length: BigInt(bytes.length),
      sha256: createHash('sha256').update(bytes).digest('hex'), storage_key: id };
    domains.ContentObject = domains.ContentObject.filter(row => row.id !== id);
    domains.ContentObject.push(metadata);
    contents.set(id, bytes);
    return metadata;
  };
  const putSegment = item => {
    const metadata = putContent(`content-${item.id}`, item.body, item.type);
    const segment = { id: item.id, segment_kind: item.kind, content_object_id: metadata.id };
    domains.ContextSegment.push(segment);
    return { node: { id: `node-${item.id}` }, segment, contentObject: metadata };
  };
  const records = items.map(putSegment);
  records.forEach((record, index) => { record.node.parent_node_id = index ? records[index - 1].node.id : null; });
  const root = { id: rootId, conversation_id: conversationId, segment_count: BigInt(records.length),
    root_node_id: records.at(-1).node.id, tail_node_id: null, tail_segment_count: 0n,
    created_at: '2026-09-30T00:00:00.000Z' };
  const structures = new Map([[rootId, { root, records }]]);
  domains.ContextSequenceRoot.push(root);
  const sourceHash = count => createHash('sha256').update(JSON.stringify(records.slice(0, count).map(record => ({
    segmentId: record.segment.id, contentObjectId: record.segment.content_object_id, segmentKind: record.segment.segment_kind
  })))).digest('hex');
  let recipe = { kind: 'reliable-context-compression', compressionMethodKind: 'llm_summary', trigger: 'manual',
    sourceRootId: rootId, sourceSegmentCount: records.length, sourceHash: sourceHash(records.length),
    attachmentCatalogState: { catalog: [attachment], placements: [{ kind: 'attachment_catalog_delta',
      afterSegmentId: items[0].id, entries: [attachment] }] }, modelHandleCatalog: { entries: [frozenAttachment] }, ...overrides };
  const syncRecipe = () => putContent('frozen-recipe', recipe);
  syncRecipe();
  domains.ModelRequest.push({ id: requestId, turn_id: 'historical-turn', recipe_object_id: 'frozen-recipe', request_seq: 1n });
  domains.Turn.push({ id: 'historical-turn', conversation_id: conversationId });
  domains.ModelContextProjection.push({ id: 'provider-projection', owner_kind: 'model_request', owner_id: requestId,
    purpose: 'provider-request', root_id: rootId });
  const selected = read => (domains[read.domain] ?? []).filter(row =>
    Object.entries(read.where ?? {}).every(([key, value]) => row[key] === value));
  const database = {
    async snapshotAll(read) { return { snapshot: selected(read) }; },
    async snapshot(queries) { return { snapshot: queries.map(query => query.id !== undefined
      ? (domains[query.domain] ?? []).find(row => row.id === query.id) ?? null : selected(query)) }; },
    async materializeContext(id) {
      const structure = structures.get(id);
      if (!structure || !domains.ContextSequenceRoot.some(row => row.id === id)) throw new Error('Missing historical root');
      return { snapshot: structure, snapshotCommitSeq: '1' };
    }
  };
  const store = {
    async read(metadata) {
      reads.push(metadata.id);
      const value = contents.get(metadata.id);
      if (!value) throw new Error(`Missing CAS ${metadata.id}`);
      if (value.length !== Number(metadata.byte_length)
        || createHash('sha256').update(value).digest('hex') !== metadata.sha256) throw new Error(`Invalid CAS ${metadata.id}`);
      return Buffer.from(value);
    },
    async readMany(metadata) { return Promise.all(metadata.map(value => this.read(value))); }
  };
  return { database, store, domains, contents, reads, records, root, structures, recipe, requestId, conversationId, putContent, putSegment, sourceHash,
    updateRecipe(change) { recipe = { ...recipe, ...change }; this.recipe = recipe; syncRecipe(); },
    input() { return { recipe, requestId, conversationId }; },
    addOriginals(summaryId, originals) {
      const blockId = `block-${summaryId}`;
      const summary = domains.ContextSegment.find(row => row.id === summaryId);
      domains.CompressionBlock.push({ id: blockId, conversation_id: conversationId, summary_object_id: summary.content_object_id });
      domains.ContextSegmentSource.push({ id: `source-${summaryId}`, segment_id: summaryId,
        source_kind: 'compression_block', source_id: blockId, source_revision: 0n });
      originals.forEach((item, index) => {
        const original = putSegment(item);
        domains.CompressionBlockSource.push({ id: `original-${summaryId}-${index}`, compression_block_id: blockId,
          segment_id: original.segment.id, position: BigInt(index) });
      });
    }
  };
}

test('published F-only compression retires its unfrozen projected P1 and reserves the next address without changing CAS', async () => {
  const history = fixture();
  const before = [...history.contents].map(([id, bytes]) => [id, bytes.toString('utf8')]);
  const projected = buildModelHandleCatalog(history.records.map(record =>
    history.contents.get(record.contentObject.id).toString('utf8')), history.recipe.modelHandleCatalog.entries);
  assert.equal(modelHandleRef(projected, 'process', 'process-historical'), 'P1', 'the published pure adapter collector showed P1');
  assert.equal(history.recipe.modelHandleCatalog.entries.some(value => value.kind === 'process'), false);
  const evidence = await readHistoricalCompressionHandleCatalog(history.database, history.store, history.input());
  assert.deepEqual(evidence.entries, [], 'an unrecorded derived reference never becomes an actionable guessed binding');
  assert.deepEqual(evidence.retiredRefs, ['P1']);
  const catalog = await readConversationContextHandleCatalog(history.database, history.store, history.conversationId);
  assert.deepEqual(catalog.retiredRefs, ['P1']);
  const next = buildModelHandleCatalog([{ processId: 'process-new' }], catalog);
  assert.equal(modelHandleRef(next, 'process', 'process-new'), 'P2');
  assert.deepEqual([...history.contents].map(([id, bytes]) => [id, bytes.toString('utf8')]), before);
});

test('already frozen references are preserved and derived attachment references never become retirement evidence', async () => {
  const history = fixture();
  history.updateRecipe({ modelHandleCatalog: { entries: [frozenAttachment,
    { kind: 'process', ref: 'P7', target: 'process-historical' }] } });
  assert.equal(await readHistoricalCompressionHandleCatalog(history.database, history.store, history.input()), undefined);
  const catalog = await readConversationContextHandleCatalog(history.database, history.store, history.conversationId);
  assert.equal(modelHandleRef(catalog, 'process', 'process-historical'), 'P7');
  assert.deepEqual(catalog.retiredRefs, []);
  const attachmentOnly = fixture([message('attachment', { role: 'user', parts: [{ inlineData: {
    attachmentId: 'attachment-unfrozen', mimeType: 'image/png', name: 'other.png', sizeBytes: 1
  } }] })]);
  assert.equal(await readHistoricalCompressionHandleCatalog(attachmentOnly.database, attachmentOnly.store,
    attachmentOnly.input()), undefined);
});

test('a text compression only withdraws addresses derived from its exact frozen prefix, never retained tail content', async () => {
  const history = fixture([message('call', call), pair('result', 'process-prefix'),
    message('tail-call', call), pair('tail-result', 'process-retained-tail')]);
  history.updateRecipe({ sourceSegmentCount: 2, sourceHash: history.sourceHash(2) });
  const evidence = await readHistoricalCompressionHandleCatalog(history.database, history.store, history.input());
  assert.deepEqual(evidence.retiredRefs, ['P1']);
  assert.ok(!history.reads.includes('content-tail-result'));
  assert.ok(!history.reads.includes('content-tail-call'));
});

test('short-reference prose in a frozen summary does not invent reference identities', async () => {
  const history = fixture([compression('summary')]);
  const before = [...history.contents].map(([id, bytes]) => [id, bytes.toString('utf8')]);
  assert.equal(await readHistoricalCompressionHandleCatalog(history.database, history.store, history.input()), undefined);
  assert.deepEqual([...history.contents].map(([id, bytes]) => [id, bytes.toString('utf8')]), before);
});

test('immutable sourceReplay selects original frozen content rather than summary prose', async () => {
  const history = fixture([compression('summary')], { sourceReplay: 'immutable_provenance' });
  history.addOriginals('summary', [message('original-call', call), pair('original-result', 'process-original')]);
  const evidence = await readHistoricalCompressionHandleCatalog(history.database, history.store, history.input());
  assert.deepEqual(evidence.retiredRefs, ['P1']);
  assert.deepEqual(evidence.entries, []);
  assert.ok(history.reads.includes('content-original-result'));
});

test('unknown legacy native-to-text producer withdraws the union of possible addresses without choosing targets', async () => {
  const history = fixture([compression('native', undefined, true), pair('later', 'process-later')]);
  history.addOriginals('native', [message('original-call', call), pair('original-result', 'process-original')]);
  const evidence = await readHistoricalCompressionHandleCatalog(history.database, history.store, history.input());
  assert.deepEqual(evidence.retiredRefs, ['P1', 'P2']);
  assert.deepEqual(evidence.entries, []);
  const next = buildModelHandleCatalog([{ processId: 'process-new' }], evidence);
  assert.equal(modelHandleRef(next, 'process', 'process-new'), 'P3');
});

test('published attachment-era native method names replay the complete raw prefix without guessing an expansion producer', async () => {
  for (const compressionMethodKind of ['openai_responses_compact', 'provider_native']) {
    const history = fixture([compression('native', undefined, true), message('call', call), pair('later', 'process-later')],
      { compressionMethodKind });
    history.addOriginals('native', [message('original-call', call), pair('original-result', 'process-original')]);
    const evidence = await readHistoricalCompressionHandleCatalog(history.database, history.store, history.input());
    assert.deepEqual(evidence.retiredRefs, ['P1']);
    assert.ok(!history.reads.includes('content-original-result'), 'the exact native method uses frozen raw source bytes');
  }
  const unknownCombination = fixture(undefined, { compressionMethodKind: 'openai_responses_compact',
    sourceReplay: 'immutable_provenance' });
  await assert.rejects(readHistoricalCompressionHandleCatalog(unknownCombination.database, unknownCombination.store,
    unknownCombination.input()), /has no immutable source replay/);
});

test('published OpenAI compaction only withdraws addresses its exact original collector could allocate', async () => {
  const history = fixture([message('canonical-fields', { kind: 'agent_collaboration', conversationId: 'peer',
    answerBridgeIds: ['unshown-plural-child'], nested: { processId: 'process-original', answerBridgeId: 'shown-child',
      outputHandle: 'rk-process-output:original', workEnvironmentId: 'work-env-original' } })],
  { compressionMethodKind: 'openai_responses_compact' });
  const evidence = await readHistoricalCompressionHandleCatalog(history.database, history.store, history.input());
  assert.deepEqual(evidence.retiredRefs, ['A1', 'O1', 'P1', 'W1']);
  const modern = buildModelHandleCatalog([{ kind: 'agent_collaboration', conversationId: 'peer',
    answerBridgeIds: ['unshown-plural-child'] }], evidence);
  assert.equal(modelHandleRef(modern, 'conversation', 'peer'), 'C1', 'old compaction never allocated collaboration addresses');
  assert.equal(modelHandleRef(modern, 'child', 'unshown-plural-child'), 'A2');
  const onlyModern = fixture([message('modern-only', { kind: 'agent_collaboration', conversationId: 'peer',
    answerBridgeIds: ['unshown-plural-child'] })], { compressionMethodKind: 'openai_responses_compact' });
  assert.equal(await readHistoricalCompressionHandleCatalog(onlyModern.database, onlyModern.store, onlyModern.input()), undefined);
});

function copiedProjection(history, { source = 'original-source', nearestSource = source } = {}) {
  const original = { ...history.root, id: 'immutable-original-root', conversation_id: source,
    created_at: '2026-09-29T00:00:00.000Z' };
  history.domains.ContextSequenceRoot.push(original);
  history.structures.set(original.id, { root: original, records: history.records });
  history.domains.ConversationBranchLink = [{ id: 'published-fork-branch', target_conversation_id: history.conversationId,
    source_conversation_id: nearestSource, created_at: history.root.created_at }];
  history.updateRecipe({ sourceRootId: original.id });
  return original;
}

test('published fork re-homed compression projections retain exact immutable source proof after nested source deletion', async () => {
  for (const nearestSource of ['original-source', 'intermediate-deleted-fork']) {
    const history = fixture();
    copiedProjection(history, { nearestSource });
    const queried = [];
    const snapshot = history.database.snapshot.bind(history.database);
    history.database.snapshot = async queries => { queried.push(...queries.map(query => query.domain)); return snapshot(queries); };
    const evidence = await readHistoricalCompressionHandleCatalog(history.database, history.store, history.input());
    assert.deepEqual(evidence.retiredRefs, ['P1']);
    assert.deepEqual(evidence.entries, []);
    assert.ok(!queried.includes('Conversation') && !queried.includes('AuthoritySnapshot'),
      'copy proof uses dataset-retained roots, not a live source conversation or current authority');
  }
});

test('a branch alone cannot validate an unrelated projection or a missing immutable original root', async () => {
  for (const damage of ['creation-time', 'shape', 'records', 'missing-root']) {
    const history = fixture();
    const original = copiedProjection(history);
    if (damage === 'creation-time') history.domains.ConversationBranchLink[0].created_at = '2026-09-28T00:00:00.000Z';
    else if (damage === 'shape') original.root_node_id = 'unrelated-node';
    else if (damage === 'records') history.structures.set(original.id, { root: original, records: [
      { ...history.records[0], segment: { ...history.records[0].segment, id: 'unrelated-segment' } }, ...history.records.slice(1)
    ] });
    else history.domains.ContextSequenceRoot = history.domains.ContextSequenceRoot.filter(row => row.id !== original.id);
    await assert.rejects(readHistoricalCompressionHandleCatalog(history.database, history.store, history.input()));
  }
});

function projectionlessChildCopy(history, { ancestors = [], humanTarget = false } = {}) {
  const originalConversation = 'original-source';
  const originalRequest = history.requestId;
  const originalTurn = history.domains.Turn[0].id;
  history.root.conversation_id = originalConversation;
  // The original provider projection is dataset-retained; its ModelRequest/Conversation need not survive.
  const scopes = [...ancestors, history.conversationId];
  let source = originalConversation;
  let copiedRequest = originalRequest;
  let copiedTurn = originalTurn;
  for (const scope of scopes) {
    const human = scope === history.conversationId && humanTarget;
    const tool = `spawn-${scope}`;
    const parentTurn = `spawn-turn-${scope}`;
    const childId = stablePhaseFId('child_execution', tool);
    history.domains.ContextSequenceRoot.push({ ...history.root, id: `retained-first-root-${scope}`,
      conversation_id: scope, created_at: '2026-10-01T00:00:00.000Z' });
    history.domains.ConversationBranchLink.push({ id: human ? 'human-fork-branch'
      : stablePhaseFId('conversation_branch_link', 'child-context-fork', scope),
      target_conversation_id: scope, source_conversation_id: source, source_message_revision_id: null,
      created_at: '2026-10-01T00:00:00.000Z' });
    history.domains.ConversationOriginLink.push({ id: human ? 'human-fork-origin'
      : stablePhaseFId('conversation_origin_link', 'child', tool), conversation_id: scope,
      source_conversation_id: source, source_turn_id: human ? null : parentTurn,
      source_tool_call_id: human ? null : tool, source_message_revision_id: null });
    if (!human) {
      history.domains.ChildExecution.push({ id: childId, child_conversation_id: scope, status: 'closed' });
      history.domains.ChildExecutionParentLink.push({ id: stablePhaseFId('child_execution_parent_link', tool),
        child_execution_id: childId, source_tool_call_id: tool, parent_turn_id: parentTurn });
    }
    copiedRequest = conversationForkSnapshotCopyId(scope, 'model_request', copiedRequest);
    copiedTurn = conversationForkSnapshotCopyId(scope, 'turn', copiedTurn);
    source = scope;
  }
  const authorityId = 'copied-original-authority';
  history.putContent('copied-authority-content', { kind: 'effective-turn-authority',
    conversationId: originalConversation, turnId: originalTurn });
  history.domains.AuthoritySnapshot.push({ id: authorityId, turn_id: copiedTurn,
    content_object_id: 'copied-authority-content' });
  Object.assign(history.domains.ModelRequest[0], { id: copiedRequest, turn_id: copiedTurn,
    status: 'terminal', authority_snapshot_id: authorityId });
  Object.assign(history.domains.Turn[0], { id: copiedTurn, status: 'terminated' });
  history.requestId = copiedRequest;
  history.input = () => ({ recipe: history.recipe, requestId: history.requestId, conversationId: history.conversationId });
  return { originalRequest, originalTurn, scopes };
}

test('published projectionless child copies prove their original frozen source through retained projection and exact copy ids', async () => {
  for (const options of [{}, { ancestors: ['older-child'] }, { ancestors: ['older-child', 'newer-child'], humanTarget: true }]) {
    const history = fixture();
    projectionlessChildCopy(history, options);
    assert.equal(history.domains.ModelContextProjection.some(row => row.owner_id === history.requestId), false);
    const evidence = await readHistoricalCompressionHandleCatalog(history.database, history.store, history.input());
    assert.deepEqual(evidence.retiredRefs, ['P1']);
    assert.deepEqual(evidence.entries, []);
  }
});

test('the immediate deleted child source remains provable from its named scope, retained root and exact two-hop ids', async () => {
  const history = fixture();
  projectionlessChildCopy(history, { ancestors: ['deleted-child'], humanTarget: true });
  const deleted = 'deleted-child';
  history.domains.ConversationBranchLink = history.domains.ConversationBranchLink.filter(row => row.target_conversation_id !== deleted);
  history.domains.ConversationOriginLink = history.domains.ConversationOriginLink.filter(row => row.conversation_id !== deleted);
  const childIds = new Set(history.domains.ChildExecution.filter(row => row.child_conversation_id === deleted).map(row => row.id));
  history.domains.ChildExecution = history.domains.ChildExecution.filter(row => !childIds.has(row.id));
  history.domains.ChildExecutionParentLink = history.domains.ChildExecutionParentLink.filter(row => !childIds.has(row.child_execution_id));
  const evidence = await readHistoricalCompressionHandleCatalog(history.database, history.store, history.input());
  assert.deepEqual(evidence.retiredRefs, ['P1']);
});

test('projectionless copy proof rejects absent or conflicting parent, original projection, authority and unknown deeper lineage', async () => {
  for (const damage of ['parent', 'branch-id', 'request-id', 'turn-authority', 'original-projection', 'unknown-deep-source']) {
    const history = fixture();
    projectionlessChildCopy(history, damage === 'unknown-deep-source' ? { ancestors: ['hidden-child', 'deleted-child'] } : {});
    if (damage === 'parent') history.domains.ChildExecutionParentLink = [];
    else if (damage === 'branch-id') history.domains.ConversationBranchLink[0].id = 'unproved-child-branch';
    else if (damage === 'request-id') {
      history.domains.ModelRequest[0].id = 'unproved-copied-request';
      history.requestId = 'unproved-copied-request';
    } else if (damage === 'turn-authority') history.putContent('copied-authority-content', {
      kind: 'effective-turn-authority', conversationId: 'original-source', turnId: 'foreign-original-turn'
    });
    else if (damage === 'original-projection') history.domains.ModelContextProjection = [];
    else {
      history.domains.ConversationBranchLink = history.domains.ConversationBranchLink.filter(row =>
        row.target_conversation_id !== 'deleted-child' && row.target_conversation_id !== 'hidden-child');
    }
    await assert.rejects(readHistoricalCompressionHandleCatalog(history.database, history.store, history.input()));
  }
});

test('current compression catalogs need no historical derivation and current collisions with withdrawal evidence still fail', async () => {
  const history = fixture();
  history.updateRecipe({ modelHandleCatalog: { entries: [], retiredRefs: [],
    identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION } });
  assert.equal(await readHistoricalCompressionHandleCatalog(history.database, history.store, history.input()), undefined);
  const current = normalizeModelHandleCatalog({ entries: [{ kind: 'process', ref: 'P1', target: 'process-current' }],
    retiredRefs: [], identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION });
  assert.throws(() => reconcileHistoricalModelHandleCatalogs([current, normalizeModelHandleCatalog({
    entries: [], retiredRefs: ['P1'], identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION
  })]), error => error.code === 'MODEL_CONTEXT_CHILD_HANDLE_CONFLICT');
});

test('pre-short-reference compression does not synthesize P handles from its canonical source', async () => {
  const history = fixture();
  delete history.recipe.modelHandleCatalog;
  delete history.recipe.attachmentCatalogState;
  history.updateRecipe({ compressionMethodKind: 'openai_responses_compact' });
  assert.equal(await readHistoricalCompressionHandleCatalog(history.database, history.store, history.input()), undefined);
  assert.deepEqual(history.reads, []);
  const catalog = await readConversationContextHandleCatalog(history.database, history.store, history.conversationId);
  assert.deepEqual(catalog.retiredRefs, []);
  assert.equal(modelHandleRef(buildModelHandleCatalog([{ processId: 'process-new' }], catalog), 'process', 'process-new'), 'P1');
});

test('historical compression rejects missing ownership, selector, projection, bounds and CAS evidence', async () => {
  const invalid = [
    history => history.updateRecipe({ sourceSegmentCount: 0 }),
    history => history.updateRecipe({ sourceSegmentCount: 3 }),
    history => history.updateRecipe({ sourceSegmentCount: 1, sourceHash: history.sourceHash(1) }),
    history => history.updateRecipe({ sourceRootId: 'another-root' }),
    history => history.updateRecipe({ sourceHash: '0'.repeat(64) }),
    history => history.updateRecipe({ compressionMethodKind: 'unknown-producer' }),
    history => history.updateRecipe({ sourceReplay: 'unknown-selector' }),
    history => history.updateRecipe({ sourceReplay: 'immutable_provenance', trigger: 'auto' }),
    history => { history.domains.ModelContextProjection = []; },
    history => { history.domains.ModelContextProjection.push({ ...history.domains.ModelContextProjection[0], id: 'duplicate' }); },
    history => { history.domains.ModelContextProjection[0].purpose = 'different-purpose'; },
    history => { history.root.conversation_id = 'foreign-conversation'; },
    history => { history.domains.Turn[0].conversation_id = 'foreign-conversation'; },
    history => { history.contents.delete('content-result'); },
    history => { history.contents.delete('frozen-recipe'); },
    history => { history.domains.ContentObject = history.domains.ContentObject.filter(row => row.id !== 'frozen-recipe'); }
  ];
  for (const mutate of invalid) {
    const history = fixture();
    mutate(history);
    await assert.rejects(readHistoricalCompressionHandleCatalog(history.database, history.store, history.input()));
  }
  const mismatchedRecipe = fixture();
  await assert.rejects(readHistoricalCompressionHandleCatalog(mismatchedRecipe.database, mismatchedRecipe.store, {
    ...mismatchedRecipe.input(), recipe: { ...mismatchedRecipe.recipe, sourceSegmentCount: 1 }
  }), /differs from its frozen/);
});

test('immutable or native expansion fails closed when originals are absent, foreign or discontinuous', async () => {
  for (const native of [false, true]) for (const broken of ['missing', 'foreign', 'order']) {
    const history = fixture([compression('summary', undefined, native)], native ? {} : { sourceReplay: 'immutable_provenance' });
    if (broken !== 'missing') {
      history.addOriginals('summary', [message('original-call', call), pair('original-result', 'process-original')]);
      if (broken === 'foreign') history.domains.CompressionBlock[0].conversation_id = 'foreign-conversation';
      else history.domains.CompressionBlockSource[0].position = 9n;
    }
    await assert.rejects(readHistoricalCompressionHandleCatalog(history.database, history.store, history.input()));
  }
});

function rejectedPartialNativeHistory() {
  const history = fixture([message('old', { role: 'user', parts: [{ text: JSON.stringify({ processId: 'never-projected-process' }) }] }),
    message('retained', { role: 'user', parts: [{ text: 'retained tail' }] })],
  { compressionMethodKind: 'provider_native', sourceSegmentCount: 1, blockId: 'failed-native-block' });
  history.updateRecipe({ sourceHash: history.sourceHash(1) });
  Object.assign(history.domains.ModelRequest[0], { status: 'terminal', terminal_state: 'provider_failed', usage_json: null,
    stream_stats_json: { attemptSeq: '1', socketGeneration: '1', retryReason: null,
      failure: { category: 'permanent', message: 'Provider-native compression requires the complete frozen model-visible window.' } } });
  return history;
}

test('retained published failed Anthropic partial-native attempt does not poison future handle reads', async () => {
  const history = rejectedPartialNativeHistory();
  const before = [...history.contents].map(([id, bytes]) => [id, bytes.toString('utf8')]);
  assert.equal(await readHistoricalCompressionHandleCatalog(history.database, history.store, history.input()), undefined);
  const catalog = await readConversationContextHandleCatalog(history.database, history.store, history.conversationId);
  assert.deepEqual(catalog.retiredRefs, []);
  assert.equal(modelHandleRef(buildModelHandleCatalog([{ processId: 'next-process' }], catalog), 'process', 'next-process'), 'P1');
  assert.deepEqual([...history.contents].map(([id, bytes]) => [id, bytes.toString('utf8')]), before);
});

test('failed partial-native history still requires exact local failure and intact immutable evidence', async () => {
  for (const mutate of [
    h => { h.domains.ModelRequest[0].terminal_state = 'completed'; },
    h => { h.domains.ModelRequest[0].status = 'prepared'; },
    h => { h.domains.ModelRequest[0].stream_stats_json.failure.message = 'network failure'; },
    h => { delete h.domains.ModelRequest[0].stream_stats_json.failure; },
    h => { h.domains.ModelRequest[0].stream_stats_json.failure.category = 'transient'; },
    h => { h.domains.ModelRequest[0].stream_stats_json.failure.status = 500; },
    h => { h.domains.ModelRequest[0].stream_stats_json.failure.code = 'UNRELATED'; },
    h => { h.domains.ModelRequest[0].stream_stats_json.lastStreamSeq = '1'; },
    h => { h.domains.ModelRequest[0].stream_stats_json.firstOutputAt = 1; },
    h => { h.domains.ModelRequest[0].usage_json = { inputTokens: 1 }; },
    h => { delete h.recipe.blockId; h.updateRecipe({}); },
    h => h.updateRecipe({ sourceHash: '0'.repeat(64) }),
    h => h.contents.delete('content-old'),
    h => { h.domains.Turn[0].conversation_id = 'foreign'; },
    h => h.updateRecipe({ compressionMethodKind: 'openai_responses_compact' }),
    h => h.updateRecipe({ sourceReplay: 'immutable_provenance' }),
    h => { h.domains.ModelStreamCheckpoint = [{ id: 'output', model_request_id: h.requestId }]; },
    h => { h.domains.ModelStreamFence = [{ id: 'fence', model_request_id: h.requestId }]; },
    h => { h.domains.CompressionBlock.push({ id: h.recipe.blockId }); }
  ]) {
    const history = rejectedPartialNativeHistory(); mutate(history);
    await assert.rejects(readHistoricalCompressionHandleCatalog(history.database, history.store, history.input()));
  }
});


test('rejected partial-native failure retains fork and projectionless child provenance checks', async () => {
  for (const copy of [h => copiedProjection(h), h => projectionlessChildCopy(h),
    h => projectionlessChildCopy(h, { ancestors: ['older-child'], humanTarget: true })]) {
    const history = rejectedPartialNativeHistory();
    copy(history);
    assert.equal(await readHistoricalCompressionHandleCatalog(history.database, history.store, history.input()), undefined);
    const catalog = await readConversationContextHandleCatalog(history.database, history.store, history.conversationId);
    assert.deepEqual(catalog.retiredRefs, []);
    history.updateRecipe({ sourceHash: '0'.repeat(64) });
    await assert.rejects(readHistoricalCompressionHandleCatalog(history.database, history.store, history.input()), /frozen hash/);
  }
});

test('real persisted Anthropic partial-native adapter failure remains readable after restart without a provider call',
  { timeout: 60000 }, async () => {
    const kernel = load('backend/reliableKernel/index.js');
    const capabilities = load('shared/modelCapabilities.js');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'historical-native-rejection-'));
    const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
    await kernel.initializeEmptyRuntimeRoot(root);
    const provider = { providerConfigId: 'historical-claude', provider: 'claude', modelId: 'claude-sonnet-4-6',
      baseUrl: 'https://historical.invalid' };
    const modelCapabilities = { ...capabilities.resolveModelCapabilities({ ...provider, transport: 'http' }),
      nativeCompaction: { kind: 'anthropic_messages', availability: 'verified', reason: 'fixture' } };
    const executionPlan = capabilities.resolveCompressionExecutionPlan({ kind: 'provider_native', fallbacks: [] }, modelCapabilities);
    const summaryReasoning = capabilities.resolveSummaryReasoning({ mode: 'provider_default', capabilities: modelCapabilities });
    let providerCalls = 0;
    const adapter = new kernel.LlmCapabilityFullRequestAdapter(provider.providerConfigId, {
      start() { providerCalls += 1; assert.fail('ordinary provider send is forbidden'); },
      compact() { providerCalls += 1; assert.fail('partial native provider send is forbidden'); },
      abort() {}, dispose() {}
    });
    const options = {
      authorityCompiler: { async compile(input) { return { turnId: input.turnId, executorAgentId: input.executorAgentId,
        executionPreset: { content: JSON.stringify({ providerConfigId: provider.providerConfigId, modelId: provider.modelId }) },
        authoritySnapshot: { content: JSON.stringify({
          kind: 'effective-turn-authority', turnId: input.turnId, conversationId: input.conversationId,
          executorAgentId: input.executorAgentId,
          model: { providerConfigId: provider.providerConfigId, provider: provider.provider, modelId: provider.modelId },
          modelProfile: { compressionThresholdTokens: 150000, contextWindowTokens: 200000,
            tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
          compression: { enabled: true, methodKind: 'provider_native', executionPlan, thresholdTokens: 150000,
            config: { id: 'native-compression', name: 'Historical native compression', kind: 'provider_native',
              trigger: { mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: 150000 } },
            provider: { ...provider, capabilities: modelCapabilities, summaryReasoning,
              contextWindowTokens: 200000, maxOutputTokens: 16000 } },
          toolPolicy: { id: 'tools', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
          systemPrompt: { id: 'prompt', text: '' }, runtimeContext: { id: null, name: '', template: '' },
          workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
        }) }
      }; } },
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { assert.fail('no MCP'); } },
      mcpPolicyGate: { async authorize() { assert.fail('no MCP authorization'); } },
      attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments',
        settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }; } },
      providers: { resolve() { return adapter; } },
      toolDispatcher: { definitions() { return []; }, async dispatch() { assert.fail('no tool effects'); } }
    };
    let app;
    try {
      app = await kernel.ReliableKernelApplication.open(root, options);
      const rows = async (domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain)
        .list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 100 }))).snapshot;
      const now = new Date().toISOString();
      await app.database.transaction([
        kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'failed-history', title: 'Historical failed native request',
          status: 'active', created_at: now, updated_at: now }),
        emptyConversationContextHandleStateStep('failed-history', now),
        kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'historical-agent-link',
          conversation_id: 'failed-history', agent_id: 'historical-agent', role: 'default', created_at: now, updated_at: now })
      ]);
      const input = key => ({ source: { kind: 'command', key }, conversationId: 'failed-history', leaseOwnerId: 'historical-owner',
        hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), content: key });
      const original = await app.turns.input(input('old history'));
      await app.turns.terminal({ source: { kind: 'internal', key: 'end-original' }, turnId: original.turnId,
        terminalStatus: 'completed', reason: 'fixture' });
      const current = await app.turns.input(input('retained tail'));
      const [authority] = await rows('AuthoritySnapshot', { turn_id: current.turnId });
      const sourceRootId = await app.context.currentHeadRootId('failed-history');
      const { records } = await app.context.materializeStructure(sourceRootId);
      assert.equal(records.length, 2);
      // Current request creation freezes a marked catalog. Exercise the same partial Anthropic
      // rejection through the real writer, CAS, preflight and failure commit. The explicit legacy
      // reconstruction cases above separately retain the published unmarked-recipe coverage.
      const recipe = { kind: 'reliable-context-compression', requestKind: 'context_compression_manual', trigger: 'manual',
        compressionMethodKind: 'provider_native', sourceRootId, sourceSegmentCount: 1, blockId: 'failed-native-block',
        sourceHash: createHash('sha256').update(JSON.stringify(records.slice(0, 1).map(record => ({
          segmentId: record.segment.id, contentObjectId: record.segment.content_object_id, segmentKind: record.segment.segment_kind
        })))).digest('hex'), attachmentCatalogState: { catalog: [], placements: [] },
        modelHandleCatalog: { entries: [], retiredRefs: [], identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION } };
      const created = await app.modelProvider.createModelRequest({ turnId: current.turnId, contextRootId: sourceRootId,
        authoritySnapshotId: authority.id, idempotencyKey: 'published-partial-native', recipe });
      await assert.rejects(app.modelProvider.dispatch(created.modelRequestId, adapter), /must freeze the complete model-visible Context projection/);
      assert.equal(providerCalls, 0);
      const [failed] = await rows('ModelRequest', { id: created.modelRequestId });
      assert.equal(failed.status, 'terminal');
      assert.equal(failed.terminal_state, 'provider_failed');
      assert.equal(failed.stream_stats_json.socketGeneration, '0', 'real kernel preparation rejects before opening a provider socket');
      assert.deepEqual(failed.stream_stats_json.failure, { category: 'permanent',
        message: 'Provider-native compression must freeze the complete model-visible Context projection.' });
      assert.equal(failed.usage_json, null);
      for (const domain of ['ModelStreamCheckpoint', 'ModelStreamFence']) {
        assert.deepEqual(await rows(domain, { model_request_id: created.modelRequestId }), []);
      }
      assert.deepEqual(await rows('CompressionBlock'), []);
      const [operation] = await rows('Operation', { owner_kind: 'model_request', owner_id: created.modelRequestId });
      assert.equal(operation.status, 'failed');
      assert.deepEqual((await rows('Attempt', { operation_id: operation.id })).map(row => row.status), ['failed']);
      await app.turns.terminal({ source: { kind: 'internal', key: 'end-rejected' }, turnId: current.turnId,
        terminalStatus: 'failed', reason: 'Historical partial-native rejection' });
      await app.close();
      app = await kernel.ReliableKernelApplication.open(root, options);
      const catalog = await readCurrentCatalog(app.database, app.contentStore, 'failed-history');
      assert.deepEqual(catalog.retiredRefs, []);
      assert.equal(modelHandleRef(buildModelHandleCatalog([{ processId: 'new-process' }], catalog), 'process', 'new-process'), 'P1');
      assert.deepEqual((await rows('ModelRequest', { id: created.modelRequestId }))[0], failed, 'historical facts are not rewritten');
      assert.equal(providerCalls, 0);
    } finally {
      if (app) await app.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
