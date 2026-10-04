import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
const { readConversationChildHandles, mergeConversationChildHandles } = load('backend/reliableKernel/conversationChildHandles.js');
const { buildModelHandleCatalog, CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION } = load('backend/reliableKernel/modelHandleCatalog.js');
const { emptyConversationContextHandleStateStep, pendingConversationContextHandleStateSteps } =
  load('backend/reliableKernel/conversationContextHandleState.js');
const { upgradeConversationContextHandles } = load('backend/reliableKernel/conversationContextHandleUpgrade.js');
const { LlmCapabilityFullRequestAdapter } = load('backend/reliableKernel/llmCapabilityProviderAdapter.js');
const { projectSummaryModelWindow } = load('backend/reliableKernel/modelFacingContextProjection.js');
const { expandTextCompressionSources } = load('backend/reliableKernel/compressionSourceReplay.js');
const { createLlmProviderCapability } = load('backend/capabilities/llmProvider.js');

const child = (ref, target) => ({ kind: 'child', ref, target });
const handles = [child('A1', 'bridge-completed'), child('A2', 'bridge-running'), child('A3', 'bridge-new')];
const textItem = (id, text, kind = 'message') => ({
  segmentId: id, segmentKind: kind, messageRole: 'user', contentType: 'application/vnd.limcode.message+json',
  content: JSON.stringify({ role: 'user', parts: [{ text }] })
});
const pairItem = (id, bridge, task) => ({
  segmentId: id, segmentKind: 'tool_pair', messageRole: 'user', contentType: 'application/json',
  content: JSON.stringify({ toolCall: { id, providerCallId: id, toolName: 'run_agent' },
    toolModelResult: { result: JSON.stringify({ answerBridgeId: bridge, status: 'running', task }) } })
});

function fullRequest(method, context, entries = handles) {
  return {
    kind: 'full-model-request', modelRequestId: 'request', conversationId: 'conversation', attemptSeq: '1',
    socketGeneration: '1', providerId: 'provider', modelId: 'model',
    authoritySnapshot: { model: { providerConfigId: 'provider', provider: 'openai-compatible', modelId: 'model' },
      toolPolicy: { allowedTools: [] }, compression: { config: {
        id: 'compression', kind: method, trigger: { mode: 'manual' }, llmSummary: { targetTokens: 8000 }
      }, provider: { providerConfigId: 'provider', provider: 'openai-compatible', modelId: 'model' } } },
    recipe: { kind: 'reliable-context-compression', sourceSegmentCount: context.length,
      compressionMethodKind: method, ...(method === 'provider_native' ? {} : { effectiveSummaryMaxTokens: 8000 }),
      modelHandleCatalog: { entries } },
    context, attachmentCatalogState: { catalog: [], placements: [] }
  };
}

async function captureCompact(request) {
  let captured;
  const adapter = new LlmCapabilityFullRequestAdapter('provider', {
    compact(input, emit) {
      captured = input;
      emit({ type: 'llm:compactDone', payload: { result: { contents: [{ role: 'user', parts: [{ text: 'summary' }] }] } } });
    }, abort() {}
  });
  await adapter.sendFullRequest(request, { onEvent: async () => {} });
  return captured;
}

test('successive text and native compactions keep completed A1 reserved and running/new child identities', async () => {
  const previous = textItem('summary', 'A1 completed OLD_TASK; A2 runs CHECK_BETA.', 'compression');
  for (const method of ['llm_summary', 'provider_native']) {
    const first = await captureCompact(fullRequest(method, [previous, pairItem('call2', 'bridge-running', 'CHECK_BETA')]));
    assert.match(JSON.stringify(first.contents), /"childRef":"A2"|\\"childRef\\":\\"A2\\"/);
    assert.doesNotMatch(JSON.stringify(first.contents), /"childRef":"A1"|\\"childRef\\":\\"A1\\"/);
    const second = await captureCompact(fullRequest(method, [previous, pairItem('call3', 'bridge-new', 'CHECK_GAMMA')]));
    assert.match(JSON.stringify(second.contents), /"childRef":"A3"|\\"childRef\\":\\"A3\\"/);
  }
});

test('compression fails closed when canonical child has no frozen reference', async () => {
  await assert.rejects(captureCompact(fullRequest('llm_summary', [pairItem('call2', 'bridge-running', 'CHECK_BETA')], [])),
    error => error.code === 'MODEL_CONTEXT_CHILD_HANDLE_CONFLICT');
});

function recipeFixture(recipes, { missing = false } = {}) {
  // An imported fork starts pending at its exact copied root. Only selected occurrences and
  // their compression-source prefixes establish bindings; unrelated recipes remain private.
  const now = '2026-10-04T00:00:00.000Z';
  const domains = {}, contents = new Map(), reads = [];
  const table = domain => domains[domain] ??= [];
  const putContent = (id, value, contentType = 'application/json') => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    contents.set(id, bytes);
    const metadata = { id, content_type: contentType, byte_length: BigInt(bytes.length),
      sha256: createHash('sha256').update(bytes).digest('hex'), storage_key: id, created_at: now };
    table('ContentObject').push(metadata);
    return metadata;
  };
  table('Conversation').push(...['fork', 'source'].map(id => ({ id })));
  table('ConversationBranchLink').push({ id: 'branch', source_conversation_id: 'source', target_conversation_id: 'fork' });
  table('Turn').push({ id: 'fork-turn', conversation_id: 'fork' }, { id: 'source-turn', conversation_id: 'source' });
  let visible = [];
  const addSegment = (key, contentId, kind, source) => {
    const segment = { id: `segment-${key}`, content_object_id: contentId, segment_kind: kind };
    const node = { id: `node-${key}`, parent_node_id: kind === 'compression' ? null : visible.at(-1)?.node.id ?? null,
      segment_id: segment.id };
    table('ContextSegment').push(segment); table('ContextSequenceNode').push(node);
    table('ContextSegmentSource').push({ id: `source-${key}`, segment_id: segment.id, ...source });
    if (kind === 'compression') visible = [];
    visible.push({ node, segment, contentObject: table('ContentObject').find(row => row.id === contentId) });
  };
  putContent('input-body', 'Copied input');
  table('MessageRevision').push({ id: 'input-revision', message_id: 'input-message', revision_seq: 1n,
    role: 'user', content_object_id: 'input-body' });
  table('MessagePartOfConversation').push({ id: 'input-member', conversation_id: 'fork', message_id: 'input-message' });
  addSegment('input', 'input-body', 'message', { source_kind: 'message_revision', source_id: 'input-revision', source_revision: 1n });
  recipes.forEach((recipe, index) => {
    const compression = recipe.kind === 'reliable-context-compression';
    const blockId = `block-${index}`;
    recipe = { ...recipe, ...(compression ? { blockId } : {}), ...(recipe.modelHandleCatalog ? { modelHandleCatalog: {
      ...recipe.modelHandleCatalog, identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION, retiredRefs: []
    } } : {}) };
    putContent(`recipe-${index}`, recipe);
    table('ModelRequest').push({ id: `copied-${index}`, turn_id: 'fork-turn', request_seq: BigInt(index),
      recipe_object_id: `recipe-${index}`, authority_snapshot_id: `authority-${index}`, ...(compression ? { stream_stats_json: { compressionPurpose: { blockId } } } : {}) });
    // Every retained address is present in its immutable output; unused lookup entries alone
    // cannot publish bindings in the current contract.
    putContent(`body-${index}`, (recipe.modelHandleCatalog?.entries ?? []).map(entry => entry.ref).join(' '), 'text/plain');
    table('AuthoritySnapshot').push({ id: `authority-${index}`, turn_id: 'fork-turn' });
    if (compression) {
      table('CompressionBlock').push({ id: blockId, conversation_id: 'fork', summary_object_id: `body-${index}`,
        authority_snapshot_id: `authority-${index}` });
      table('CompressionBlockSource').push(...visible.map(({ segment }, position) => ({
        id: `block-source-${index}-${position}`, compression_block_id: blockId, position: BigInt(position), segment_id: segment.id
      })));
      addSegment(index, `body-${index}`, 'compression', { source_kind: 'compression_block', source_id: blockId, source_revision: 0n });
    } else {
      table('MessageRevision').push({ id: `revision-${index}`, message_id: `message-${index}`, revision_seq: 1n,
        role: 'model', content_object_id: `body-${index}` });
      table('MessagePartOfConversation').push({ id: `member-${index}`, conversation_id: 'fork', message_id: `message-${index}` });
      table('ModelRequestMessageLink').push({ id: `producer-${index}`, model_request_id: `copied-${index}`, message_id: `message-${index}` });
      addSegment(index, `body-${index}`, 'message', { source_kind: 'message_revision', source_id: `revision-${index}`, source_revision: 1n });
    }
  });
  // This conflicting same-Turn retry has no occurrence in the selected root or source graph.
  putContent('recipe-discarded', { kind: 'reliable-agent-turn', modelHandleCatalog: {
    entries: [child('A1', 'discarded-bridge')], identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION, retiredRefs: []
  } });
  table('AuthoritySnapshot').push({ id: 'authority-discarded', turn_id: 'fork-turn' });
  table('ModelRequest').push({ id: 'discarded-request', turn_id: 'fork-turn', request_seq: 99n,
    recipe_object_id: 'recipe-discarded', authority_snapshot_id: 'authority-discarded' });
  if (missing) domains.ContentObject = table('ContentObject').filter(row => row.id !== 'recipe-0');
  const root = { id: 'selected-root', conversation_id: 'fork', root_node_id: visible.at(-1).node.id,
    tail_node_id: null, tail_segment_count: 0n, segment_count: BigInt(visible.length) };
  table('ContextSequenceRoot').push(root);
  table('ConversationContextHeadLink').push({ id: 'head', conversation_id: 'fork', root_id: root.id });
  table('ConversationContextHandleState').push(emptyConversationContextHandleStateStep('source', now).row,
    pendingConversationContextHandleStateSteps('fork', now, undefined, root.id).find(step => step.kind === 'insert').row);
  const select = read => {
    if (read.domain === 'Turn') throw new Error('Selected-root upgrade must not scan Turn history.');
    return table(read.domain).filter(row => Object.entries(read.where ?? {}).every(([key, value]) => row[key] === value));
  };
  const database = {
    conversationOwners: { async run(_id, run) { return run(); } },
    async withHistoryPreparation(run) { return run({ assertActive() {} }); },
    async snapshotAll(read) { return { snapshot: structuredClone(select(read)) }; },
    async snapshot(queries) { return { snapshot: queries.map(read => structuredClone(read.kind === 'get'
      ? table(read.domain).find(row => row.id === read.id) ?? null : select(read).slice(0, read.limit ?? Infinity))) }; },
    async materializeContext(rootId) {
      assert.equal(rootId, root.id);
      return { snapshotCommitSeq: '1', snapshot: structuredClone({ root, records: visible }) };
    },
    async transaction(steps) {
      const before = structuredClone(domains);
      const apply = step => {
        if (step.kind === 'savepoint') { step.steps.forEach(apply); return; }
        const rows = table(step.domain), row = rows.find(row => row.id === step.id);
        if (step.kind === 'assert') {
          assert.ok(row, `Missing ${step.domain} ${step.id}`);
          for (const [key, value] of Object.entries(step.where)) assert.deepEqual(row[key], value);
        } else if (step.kind === 'assertNone') assert.equal(select(step).length, 0);
        else if (step.kind === 'assertExactIds') assert.deepEqual(select(step).map(row => row.id).sort(), [...step.expectedIds].sort());
        else if (step.kind === 'insert') { assert.ok(!rows.some(value => value.id === step.row.id)); rows.push(structuredClone(step.row)); }
        else if (step.kind === 'update') { assert.ok(row); Object.assign(row, structuredClone(step.patch)); }
        else throw new Error(`Unsupported fixture transaction step: ${step.kind}`);
      };
      try { steps.forEach(apply); } catch (error) {
        for (const key of Object.keys(domains)) delete domains[key];
        Object.assign(domains, before); throw error;
      }
    }
  };
  const store = {
    async read(metadata) { reads.push(metadata.id); return Buffer.from(contents.get(metadata.id)); },
    async prepare(_database, text, contentType) {
      const id = `state-${createHash('sha256').update(text).digest('hex')}`;
      const existing = table('ContentObject').find(row => row.id === id);
      if (existing) return { metadata: existing };
      const metadata = putContent(id, text, contentType);
      domains.ContentObject.pop();
      return { metadata, insert: { kind: 'insert', domain: 'ContentObject', row: metadata } };
    }
  };
  return { reads, domains, database, store,
    async upgrade() { await upgradeConversationContextHandles(database, store, 'fork'); } };
}

test('copied fork sources preserve selected historical mappings without scanning source turns', async () => {
  const fixture = recipeFixture([
    { kind: 'reliable-agent-turn', modelHandleCatalog: { entries: handles.slice(0, 1) } },
    { kind: 'reliable-agent-turn', modelHandleCatalog: { entries: handles.slice(0, 2) } },
    { kind: 'reliable-context-compression', modelHandleCatalog: { entries: handles } }
  ]);
  await fixture.upgrade();
  assert.deepEqual(await readConversationChildHandles(fixture.database, fixture.store, 'fork'), handles);
  assert.deepEqual(fixture.reads.filter(id => id.startsWith('recipe-')).sort(), ['recipe-0', 'recipe-1', 'recipe-2'],
    'selected immutable sources require each producer recipe, including before same-Turn compression, but exclude discarded retries');
  assert.deepEqual(await readConversationChildHandles(fixture.database, fixture.store, 'source'), []);
});

test('same-timestamp parent turns retain selected canonical sources without trusting hashed turn id order', async () => {
  const fixture = recipeFixture([
    { kind: 'reliable-agent-turn', modelHandleCatalog: { entries: handles.slice(0, 1) } },
    { kind: 'reliable-agent-turn', modelHandleCatalog: { entries: handles.slice(0, 2) } }
  ]);
  fixture.domains.Turn.push(...['z-old-turn', 'a-new-turn'].map(id => ({ id, conversation_id: 'fork', created_at: '2026-09-22T00:00:00.000Z' })));
  fixture.domains.AuthoritySnapshot[0].turn_id = 'z-old-turn';
  fixture.domains.AuthoritySnapshot[1].turn_id = 'a-new-turn';
  fixture.domains.ModelRequest[0].turn_id = 'z-old-turn';
  fixture.domains.ModelRequest[1].turn_id = 'a-new-turn';
  await fixture.upgrade();
  assert.deepEqual(await readConversationChildHandles(fixture.database, fixture.store, 'fork'), handles.slice(0, 2));
  assert.equal(fixture.reads.filter(id => id.startsWith('recipe-')).length, 2);
});

test('a backwards clock between parent turns cannot discard or reassign a reserved child reference', async () => {
  const fixture = recipeFixture([
    { kind: 'reliable-agent-turn', modelHandleCatalog: { entries: handles.slice(0, 1) } },
    { kind: 'reliable-context-compression', modelHandleCatalog: { entries: handles.slice(0, 2) } }
  ]);
  fixture.domains.Turn.push(
    { id: 'old-turn', conversation_id: 'fork', created_at: '2026-09-22T00:01:00.000Z' },
    { id: 'new-turn', conversation_id: 'fork', created_at: '2026-09-22T00:00:59.000Z' }
  );
  fixture.domains.ModelRequest[0].turn_id = 'old-turn';
  fixture.domains.ModelRequest[1].turn_id = 'new-turn';
  fixture.domains.AuthoritySnapshot[0].turn_id = 'old-turn';
  fixture.domains.AuthoritySnapshot[1].turn_id = 'new-turn';
  await fixture.upgrade();
  const reserved = await readConversationChildHandles(fixture.database, fixture.store, 'fork');
  assert.deepEqual(reserved, handles.slice(0, 2));
  assert.deepEqual(buildModelHandleCatalog([{ answerBridgeId: 'bridge-new' }], reserved).entries, handles);
});

test('frozen history rejects missing CAS and conflicting targets or renamed child references', async () => {
  for (const entries of [[child('A1', 'different')], [child('A4', 'bridge-completed')]]) {
    assert.throws(() => mergeConversationChildHandles(handles, entries),
      error => error.code === 'MODEL_CONTEXT_CHILD_HANDLE_CONFLICT');
  }
  const duplicate = recipeFixture([{ kind: 'reliable-agent-turn', modelHandleCatalog: { entries: [...handles, child('A1', 'different')] } }]);
  await assert.rejects(duplicate.upgrade(), /Duplicate model handle ref/);
  const missing = recipeFixture([{ kind: 'reliable-agent-turn' }], { missing: true });
  await assert.rejects(missing.upgrade(), /ContentObject.*missing/);
  assert.throws(() => mergeConversationChildHandles(handles, [child('A2', 'other')]), /Conflicting/);
});

async function deterministicSummary(contents, priorSummaryContents) {
  const capability = createLlmProviderCapability({ settings: async () => { throw new Error('No provider calls permitted'); } });
  try {
    const result = await new Promise((resolve, reject) => {
      capability.compact({ id: `deterministic-${priorSummaryContents ? 'second' : 'first'}`, blockId: 'block', conversationId: 'conversation',
        methodKind: 'deterministic_summary', methodConfigSnapshot: { id: 'deterministic', kind: 'deterministic_summary',
          trigger: { mode: 'manual' }, llmSummary: { targetTokens: 8000 } }, contents,
        ...(priorSummaryContents ? { priorSummaryContents } : {}) }, event => {
        if (event.type === 'llm:compactDone') resolve(event.payload.result.contents);
        if (event.type === 'llm:compactError') reject(new Error(event.payload.message));
      });
    });
    return result;
  } finally { capability.dispose(); }
}

test('deterministic summary preserves different historical tool calls/results through repeated compression', async () => {
  const calls = ['ALPHA', 'BETA', 'GAMMA'].flatMap((task, index) => [
    { role: 'model', parts: [{ id: `call-${index}`, functionCall: { name: 'run_agent', args: { prompt: `CHECK_${task}` } } }] },
    { role: 'user', parts: [{ id: `call-${index}`, functionResponse: { name: 'run_agent', response: { childRef: `A${index + 1}`, status: 'running' } } }] }
  ]);
  const first = await deterministicSummary(projectSummaryModelWindow(calls).contents);
  const second = await deterministicSummary([{ role: 'user', parts: [{ text: 'Keep existing delegated work running.' }] }], first);
  for (const contents of [first, second]) {
    const text = JSON.stringify(contents);
    for (const task of ['CHECK_ALPHA', 'CHECK_BETA', 'CHECK_GAMMA']) assert.ok(text.includes(task), task);
    for (const ref of ['A1', 'A2', 'A3']) assert.ok(text.includes(ref), ref);
  }
});

test('reused or absent provider call ids cannot overwrite different delegated task facts', async () => {
  const contents = projectSummaryModelWindow(['ONE', 'TWO', 'THREE', 'FOUR'].map((task, index) => ({
    role: 'model', parts: [{ ...(index < 2 ? { id: 'provider-reused-id' } : {}),
      functionCall: { name: 'run_agent', args: { prompt: `DISTINCT_${task}` } } }]
  }))).contents;
  const summary = JSON.stringify(await deterministicSummary(contents));
  for (const task of ['ONE', 'TWO', 'THREE', 'FOUR']) assert.ok(summary.includes(`DISTINCT_${task}`));
});

function repeatedDispatchContext() {
  return [1, 2].flatMap(index => [
    {
      segmentId: `dispatch-message-${index}`, segmentKind: 'message', messageRole: 'model',
      contentType: 'application/vnd.limcode.message+json',
      content: JSON.stringify({ role: 'model', parts: [{ id: 'provider-reused-id', functionCall: {
        name: 'run_agent', args: { operation: 'send', childRef: 'A1', prompt: 'Repeat the same delegated instruction.' }
      } }] })
    },
    {
      segmentId: `dispatch-result-${index}`, segmentKind: 'tool_pair', messageRole: 'user',
      contentType: 'application/json',
      content: JSON.stringify({
        toolCall: { id: `internal-dispatch-${index}`, providerCallId: 'provider-reused-id', toolName: 'run_agent' },
        toolModelResult: { result: JSON.stringify({ answerBridgeId: 'bridge-completed', status: 'running' }) }
      })
    }
  ]);
}

test('text summaries preserve separate identical dispatches when provider call ids repeat', async () => {
  const captured = await captureCompact(fullRequest('llm_summary', repeatedDispatchContext()));
  const first = await deterministicSummary(captured.contents);
  const second = await deterministicSummary([{ role: 'user', parts: [{ text: 'Retain both delegated dispatches.' }] }], first);
  for (const contents of [first, second]) {
    const text = JSON.stringify(contents);
    assert.ok(text.match(/historical_tool_call/g)?.length >= 2, 'identical calls from separate dispatches remain separate facts');
    assert.equal(text.match(/historical_tool_result/g)?.length, 2, 'identical results from separate dispatches remain separate facts');
  }
  const descriptors = captured.contents.flatMap(content => content.parts.map(part => JSON.parse(part.text)));
  for (const kind of ['historical_tool_call', 'historical_tool_result']) {
    const refs = descriptors.filter(descriptor => descriptor.kind === kind).map(descriptor => descriptor.dispatchRef);
    assert.equal(new Set(refs).size, 2);
    assert.ok(refs.every(ref => /^D[\da-f]{64}$/.test(ref)), 'summary identities are opaque dispatch references');
    for (const contents of [first, second]) {
      for (const ref of refs) assert.ok(JSON.stringify(contents).includes(ref), `dispatch ${ref} survives repeated compression`);
    }
  }
  assert.doesNotMatch(JSON.stringify(captured.contents), /internal-dispatch-|dispatch-message-|dispatch-result-/);
  const replay = await captureCompact(fullRequest('llm_summary', repeatedDispatchContext()));
  assert.deepEqual(replay.contents, captured.contents, 'the same immutable dispatch sources produce stable summary identities');
});

test('native compression retains provider call ids without text-summary dispatch metadata', async () => {
  const captured = await captureCompact(fullRequest('provider_native', repeatedDispatchContext()));
  const parts = captured.contents.flatMap(content => content.parts);
  assert.equal(parts.filter(part => part.functionCall).length, 2);
  assert.equal(parts.filter(part => part.functionResponse).length, 2);
  assert.ok(parts.every(part => part.id === 'provider-reused-id'));
  assert.doesNotMatch(JSON.stringify(captured.contents), /dispatchRef|summaryDispatchRef|internal-dispatch-/);
});

function provenanceFixture({ gap = false, cycle = false, missing = false } = {}) {
  const original = pairItem('original', 'bridge-running', 'CHECK_BETA');
  const old = textItem('old-summary', 'Incorrect historical alias A1 belongs to CHECK_BETA', 'compression');
  const domains = {
    ContextSegmentSource: [
      { id: 'source', segment_id: old.segmentId, source_kind: 'compression_block', source_id: 'old-block', source_revision: 0n },
      { id: 'fork-source', segment_id: old.segmentId, source_kind: 'compression_block', source_id: 'fork-block', source_revision: 0n }
    ],
    CompressionBlock: [
      { id: 'old-block', conversation_id: 'owner', summary_object_id: 'summary-object' },
      { id: 'fork-block', conversation_id: 'fork', summary_object_id: 'summary-object' }
    ],
    CompressionBlockSource: missing ? [] : [{ id: 'block-source', compression_block_id: 'old-block', position: gap ? 1n : 0n,
      segment_id: cycle ? old.segmentId : original.segmentId }],
    ContextSegment: [{ id: old.segmentId, content_object_id: 'summary-object', segment_kind: 'compression' },
      { id: original.segmentId, content_object_id: 'original-object', segment_kind: original.segmentKind }],
    ContentObject: [{ id: 'summary-object', content_type: old.contentType, byte_length: old.content.length },
      { id: 'original-object', content_type: original.contentType, byte_length: original.content.length }]
  };
  const read = query => query.kind === 'get' ? domains[query.domain]?.find(row => row.id === query.id)
    : (domains[query.domain] ?? []).filter(row => Object.entries(query.where ?? {}).every(([key, value]) => row[key] === value));
  return { old, original, database: {
    async snapshot(queries) { return { snapshot: queries.map(read) }; },
    async snapshotAll(query) { return { snapshot: read(query) }; }
  }, store: { async read(metadata) { return Buffer.from(metadata.id === 'summary-object' ? old.content : original.content); } } };
}

test('explicit immutable provenance rebuild replaces corrupt text aliases before text or native compaction', async () => {
  const fixture = provenanceFixture();
  assert.deepEqual(await expandTextCompressionSources(fixture.database, fixture.store, 'owner', [fixture.old]), [fixture.old]);
  const source = await expandTextCompressionSources(fixture.database, fixture.store, 'owner', [fixture.old], { sourceReplay: 'immutable_provenance' });
  assert.equal(source.length, 1);
  assert.equal(source[0].content, fixture.original.content);
  for (const method of ['llm_summary', 'provider_native']) {
    const request = fullRequest(method, [fixture.old]);
    request.recipe.sourceReplay = 'immutable_provenance';
    request.compressionSourceContext = source;
    const captured = await captureCompact(request);
    assert.doesNotMatch(JSON.stringify(captured), /Incorrect historical alias/);
    assert.match(JSON.stringify(captured.contents), /CHECK_BETA/);
    assert.match(JSON.stringify(captured.contents), /"childRef":"A2"|\\"childRef\\":\\"A2\\"/);
  }
});

test('immutable provenance reconstruction rejects absent, cyclic and non-contiguous source graphs', async () => {
  for (const options of [{ gap: true }, { cycle: true }, { missing: true }]) {
    const fixture = provenanceFixture(options);
    await assert.rejects(expandTextCompressionSources(fixture.database, fixture.store, 'owner', [fixture.old], { sourceReplay: 'immutable_provenance' }),
      error => error.code === 'MODEL_CONTEXT_NATIVE_SOURCE_INVALID');
  }
});

test('process, cursor and environment identities survive compression recipes and inherited fork history', async () => {
  const persistent = [
    ...handles,
    { kind: 'process', ref: 'P1', target: 'process-old' },
    { kind: 'process', ref: 'P2', target: 'process-retained' },
    { kind: 'cursor', ref: 'O1', target: 'rk-process-output:old-page' },
    { kind: 'workEnvironment', ref: 'W1', target: 'work-env-old' }
  ];
  const fixture = recipeFixture([{ kind: 'reliable-context-compression', modelHandleCatalog: { entries: persistent } }]);
  await fixture.upgrade();
  const remembered = await readConversationChildHandles(fixture.database, fixture.store, 'fork');
  const { buildModelHandleCatalog, resolveModelToolArguments } = load('backend/reliableKernel/modelHandleCatalog.js');
  const after = buildModelHandleCatalog([
    'Summary: old build used P1/O1 in W1.', { processId: 'process-retained' },
    { processId: 'process-new', workEnvironmentId: 'work-env-new' }
  ], remembered);
  assert.equal(resolveModelToolArguments('bash', { mode: 'output', processRef: 'P1', cursor: 'O1' }, after).processId, 'process-old');
  assert.equal(resolveModelToolArguments('bash', { mode: 'output', processRef: 'P2' }, after).processId, 'process-retained');
  assert.equal(resolveModelToolArguments('bash', { mode: 'output', processRef: 'P3' }, after).processId, 'process-new');
  assert.equal(resolveModelToolArguments('switch_work_environment', { workEnvironmentRef: 'W1' }, after).workEnvironmentId, 'work-env-old');
  assert.equal(resolveModelToolArguments('switch_work_environment', { workEnvironmentRef: 'W2' }, after).workEnvironmentId, 'work-env-new');
});
