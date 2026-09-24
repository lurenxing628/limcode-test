import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
const { readConversationChildHandles, mergeConversationChildHandles } = load('backend/reliableKernel/conversationChildHandles.js');
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
  const domains = {
    Turn: [{ id: 'fork-turn', conversation_id: 'fork' }, { id: 'source-turn', conversation_id: 'source' }],
    ModelRequest: recipes.map((recipe, index) => ({ id: `copied-${index}`, turn_id: 'fork-turn', request_seq: BigInt(index), recipe_object_id: `recipe-${index}` })),
    ContentObject: recipes.map((_, index) => ({ id: `recipe-${index}` }))
  };
  const select = read => (domains[read.domain] ?? []).filter(row => Object.entries(read.where ?? {}).every(([key, value]) => row[key] === value));
  const reads = [];
  return {
    reads,
    domains,
    database: {
      async snapshotAll(read) { return { snapshot: select(read) }; },
      async snapshot(reads) { return { snapshot: reads.map(read => missing ? null : domains[read.domain].find(row => row.id === read.id)) }; }
    },
    store: { async read(metadata) { reads.push(metadata.id); return Buffer.from(JSON.stringify(recipes[Number(metadata.id.slice(7))])); } }
  };
}

test('copied fork request recipes preserve the complete historical mapping without scanning source turns', async () => {
  const fixture = recipeFixture([
    { kind: 'reliable-agent-turn', modelHandleCatalog: { entries: handles.slice(0, 1) } },
    { kind: 'reliable-agent-turn', modelHandleCatalog: { entries: handles.slice(0, 2) } },
    { kind: 'reliable-context-compression', modelHandleCatalog: { entries: handles } }
  ]);
  assert.deepEqual(await readConversationChildHandles(fixture.database, fixture.store, 'fork'), handles);
  assert.deepEqual(fixture.reads, ['recipe-2'], 'the latest cumulative recipe is sufficient even after many old requests');
  assert.deepEqual(await readConversationChildHandles(fixture.database, fixture.store, 'source'), []);
});

test('same-timestamp parent turns merge newest recipes without trusting hashed turn id order', async () => {
  const fixture = recipeFixture([
    { kind: 'reliable-agent-turn', modelHandleCatalog: { entries: handles.slice(0, 1) } },
    { kind: 'reliable-agent-turn', modelHandleCatalog: { entries: handles.slice(0, 2) } }
  ]);
  fixture.domains.Turn = ['z-old-turn', 'a-new-turn'].map(id => ({ id, conversation_id: 'fork', created_at: '2026-09-22T00:00:00.000Z' }));
  fixture.domains.ModelRequest[0].turn_id = 'z-old-turn';
  fixture.domains.ModelRequest[1].turn_id = 'a-new-turn';
  assert.deepEqual(await readConversationChildHandles(fixture.database, fixture.store, 'fork'), handles.slice(0, 2));
  assert.equal(fixture.reads.length, 2);
});

test('frozen history rejects missing CAS and conflicting targets or renamed child references', async () => {
  for (const entries of [[child('A1', 'different')], [child('A4', 'bridge-completed')]]) {
    assert.throws(() => mergeConversationChildHandles(handles, entries),
      error => error.code === 'MODEL_CONTEXT_CHILD_HANDLE_CONFLICT');
  }
  const duplicate = recipeFixture([{ kind: 'reliable-agent-turn', modelHandleCatalog: { entries: [...handles, child('A1', 'different')] } }]);
  await assert.rejects(readConversationChildHandles(duplicate.database, duplicate.store, 'fork'), /Duplicate model handle ref/);
  const missing = recipeFixture([{ kind: 'reliable-agent-turn' }], { missing: true });
  await assert.rejects(readConversationChildHandles(missing.database, missing.store, 'fork'), /ContentObject.*missing/);
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
