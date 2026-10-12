import assert from 'node:assert/strict';

import fs from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

import { createRequire } from 'node:module';

import test from 'node:test';

const require = createRequire(import.meta.url);

const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');

const load = file => require(path.join(compiled, file));

const { emptyConversationContextHandleStateStep } = load('backend/reliableKernel/conversationContextHandleState.js');

const { NativeRequestSession } = load('backend/reliableKernel/nativeRequestSession.js');

const { readConversationChildHandles, readNativeRequestChildHandles, NATIVE_CHILD_HANDLE_PROJECTION_EVENT } =
  load('backend/reliableKernel/conversationChildHandles.js');

const { resolveModelToolArguments } = load('backend/reliableKernel/modelHandleCatalog.js');

const capabilities = { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false, explicitCaching: true };

const definition = { name: 'run_agent', description: 'native child handle fixture', parameters: { type: 'object' } };

function nativeResultProjectionFixture(results) {
  const domains = new Map();
  const bodies = new Map();
  const put = (domain, row) => {
    if (!domains.has(domain)) domains.set(domain, new Map());
    domains.get(domain).set(row.id, row);
  };
  put('Conversation', { id: 'projection-conversation' });
  put('Turn', { id: 'projection-turn', conversation_id: 'projection-conversation' });
  const initialState = emptyConversationContextHandleStateStep('projection-conversation', '2026-09-30T00:00:00.000Z');
  put(initialState.domain, initialState.row);
  put('ModelRequest', { id: 'projection-request', turn_id: 'projection-turn' });
  for (const [index, result] of results.entries()) {
    const id = `projection-call-${index}`;
    const body = `result-body-${index}`;
    put('ToolCall', { id, turn_id: 'projection-turn', tool_name: result.name, status: 'terminal' });
    put('ToolCallSourceLink', { id: `source-${index}`, tool_call_id: id, model_request_id: 'projection-request' });
    put('ToolModelResult', { id: `result-${index}`, tool_call_id: id, message_revision_id: `revision-${index}` });
    put('MessageRevision', { id: `revision-${index}`, content_object_id: body });
    put('ContentObject', { id: body, content_type: 'application/json' });
    bodies.set(body, JSON.stringify(result.value));
  }
  const select = read => [...(domains.get(read.domain)?.values() ?? [])]
    .filter(row => Object.entries(read.where ?? {}).every(([key, value]) => row[key] === value));
  const database = {
    async snapshot(reads) { return { snapshot: reads.map(read => read.kind === 'get'
      ? domains.get(read.domain)?.get(read.id) ?? null : select(read).slice(0, read.limit)) }; },
    async snapshotAll(read) { return { snapshot: select(read) }; },
    async transaction(steps) {
      const apply = step => {
        if (step.kind === 'savepoint') { step.steps.forEach(apply); return; }
        if (step.kind === 'insert' || step.kind === 'insertWithNextSequence') {
          assert.equal(domains.get(step.domain)?.has(step.row.id) ?? false, false, 'projection must be frozen once');
          put(step.domain, { ...step.row });
        } else if (step.kind === 'update') {
          const current = domains.get(step.domain)?.get(step.id);
          assert.ok(current, 'updates require an existing fixture row');
          put(step.domain, { ...current, ...step.patch });
        } else if (step.kind === 'assert') {
          const current = domains.get(step.domain)?.get(step.id);
          assert.ok(current, 'assertions require an existing fixture row');
          for (const [key, value] of Object.entries(step.where)) assert.deepEqual(current[key], value);
        } else if (step.kind === 'assertNone') {
          assert.equal(select(step).length, 0);
        } else assert.fail(`Unsupported fixture transaction step: ${step.kind}`);
      };
      steps.forEach(apply);
      return {};
    }
  };
  let counter = 0;
  const contentStore = {
    async read(metadata) { assert.ok(bodies.has(metadata.id)); return Buffer.from(bodies.get(metadata.id)); },
    async readMany(metadata) { return Promise.all(metadata.map(value => this.read(value))); },
    async prepare(_database, content, contentType) {
      const metadata = { id: `projection-body-${counter++}`, content_type: contentType, sha256: 'fixture',
        byte_length: BigInt(Buffer.byteLength(content)), storage_key: `projection-${counter}` };
      bodies.set(metadata.id, content);
      put('ContentObject', metadata);
      return { metadata };
    }
  };
  const submitted = [];
  let ended = 0;
  const session = new NativeRequestSession({ database, contentStore, tools: {}, capabilities,
    modelRequestId: 'projection-request', turnId: 'projection-turn', providerId: 'projection-provider',
    modelHandleCatalog: { entries: [] }, now: () => new Date().toISOString(),
    budget: { planningInputCapacityTokens: 200000, compressionThresholdTokens: 180000, autoCompressionEnabled: false },
    modelProvider: { async readNativeLatestResponseUsage() { return {
      responseId: 'projection-response', streamSeq: '3', attemptSeq: '1', socketGeneration: '1',
      physicalResponseCount: 1, inputTokens: 150
    }; } },
    resolveAdapter: async () => ({ materializeNativeToolOutput: async outputs => outputs })
  });
  session.bindStream({ attemptSeq: '1', socketGeneration: '1' });
  session.responseOrder.push('projection-response');
  session.responses.set('projection-response', { responseId: 'projection-response', admissionBoundary: true,
    completed: true, boundarySeq: '3', syncRequired: false });
  for (const [index, result] of results.entries()) {
    session.calls.set(`projection-call-${index}`, { name: result.name, toolCallId: `projection-call-${index}`,
      toolModelResultId: `result-${index}`, providerCallId: `wire-${index}`, responseId: 'projection-response',
      providerOrdinal: index, asyncDeclared: true, admitted: true, settled: true, delivered: false });
  }
  session.calls.set('still-running', { name: 'slow_fixture', toolCallId: 'still-running', providerCallId: 'wire-slow',
    responseId: 'projection-response', providerOrdinal: results.length, asyncDeclared: true,
    admitted: true, settled: false, delivered: false });
  session.controller = { endLogicalRequest() { ended += 1; }, async submitToolResults(outputs) { submitted.push(outputs); } };
  return { session, database, contentStore, bodies, domains, submitted, ended: () => ended };
}

function registerCases(test) {

test('recovery of admitted unsettled native calls dispatches frozen canonical arguments and settles frozen unknown-reference errors', { timeout: 5000 }, async () => {
  const catalog = { entries: [{ kind: 'child', ref: 'A1', target: 'answer_bridge_original' }] };
  const unknownArgs = { operation: 'send', childRef: 'A999', prompt: 'must remain rejected' };
  let unknownMessage;
  try { resolveModelToolArguments('run_agent', unknownArgs, catalog); } catch (error) { unknownMessage = error.message; }
  const proofs = [
    { type: 'native_tool_call', responseId: 'response', toolName: 'run_agent', providerCallId: 'valid-send', providerOrdinal: 0,
      async: true, arguments: { operation: 'send', childRef: 'A1', prompt: 'continue' },
      resolvedArguments: { operation: 'send', answerBridgeId: 'answer_bridge_original', prompt: 'continue' }, modelHandleCatalog: catalog },
    { type: 'native_tool_call', responseId: 'response', toolName: 'run_agent', providerCallId: 'invalid-send', providerOrdinal: 1,
      async: true, arguments: unknownArgs, resolvedArguments: unknownArgs, argumentResolutionError: unknownMessage, modelHandleCatalog: catalog }
  ];
  const admissions = new Map(proofs.map(proof => [proof.providerCallId, { toolCallId: proof.providerCallId, declaredAsync: true }]));
  const terminals = new Map();
  const dispatched = [];
  const rejected = [];
  let complete;
  const completed = new Promise(resolve => { complete = resolve; });
  const settle = id => { terminals.set(id, { toolModelResultId: `result-${id}` }); if (terminals.size === 2) complete(); };
  const effects = {
    async listNativePendingWork() { return proofs.map(proof => ({ toolCallId: proof.providerCallId, settled: false, delivered: false,
      callContextSegmentId: `segment-${proof.providerCallId}` })); },
    async readNativeAdmission(id) { return admissions.get(id); },
    async readTerminalResult(id) { return terminals.get(id); },
    async settleWithoutEffect(input) { rejected.push(input); settle(input.toolCallId); return { terminal: terminals.get(input.toolCallId) }; }
  };
  const database = {
    async snapshotAll(query) {
      if (query.domain === 'ModelStreamCheckpoint') return { snapshot: proofs.map((_, index) => ({
        checkpoint_kind: 'native_tool_call', content_object_id: String(index), stream_seq: String(index + 1),
        attempt_seq: '1', socket_generation: '1'
      })) };
      return { snapshot: [] };
    },
    async snapshot(queries) { return { snapshot: queries.map(query => query.domain === 'ContentObject' ? { id: query.id } : null) }; }
  };
  // Reproduce the precise crash boundary: provider proof and admission are committed, neither
  // valid execution nor invalid-reference failure has settled yet. The original raw args remain.
  for (const proof of proofs) {
    assert.ok(await effects.readNativeAdmission(proof.providerCallId));
    assert.equal(await effects.readTerminalResult(proof.providerCallId), undefined);
  }
  const session = new NativeRequestSession({
    database, contentStore: { async read(metadata) { return Buffer.from(JSON.stringify({ content: proofs[Number(metadata.id)] })); } },
    effects, tools: {}, modelProvider: {
      async readNativeLatestResponseUsage() { return undefined; },
      nativeSteering: { async receiptsForTurn() { return []; } }
    },
    conversationId: 'parent', turnId: 'turn', modelRequestId: 'request', providerId: 'provider', modelId: 'gpt-6-astra',
    // Even a later runtime map must not reinterpret the frozen failed proof into a valid call.
    modelHandleCatalog: { entries: [...catalog.entries, { kind: 'child', ref: 'A999', target: 'answer_bridge_later' }] },
    capabilities, budget: { planningInputCapacityTokens: 128000, compressionThresholdTokens: 100000,
      autoCompressionEnabled: false }, initialContextRootId: 'fixture-frozen-context-root',
    resolveAdapter: async () => { throw new Error('not sending during recovery fixture'); },
    resolveDefinition: () => definition, resolveCallArguments: () => { throw new Error('recovery must use persisted resolution'); },
    freezePolicies: async () => { throw new Error('admitted calls do not refreeze policy'); },
    async dispatchCall(input) { dispatched.push(input); settle(input.toolCallId); return terminals.get(input.toolCallId); },
    toolCallIdFor: (_ordinal, providerId) => providerId, closeAdmittedCall: async () => {}, now: () => new Date().toISOString()
  });
  await session.reconcile();
  await completed;
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0].arguments, proofs[0].resolvedArguments);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].toolCallId, 'invalid-send');
  assert.equal(rejected[0].status, 'failed');
  assert.equal(rejected[0].detail.error, unknownMessage);
});
test('native async process results are bounded, actionable and durably replayed without changing receipts', async () => {
  const raw = { status: 'succeeded', detail: { status: 'background_started', processId: 'new-native-process',
    stdout: 'large output\n'.repeat(20000), hasMore: true, nextOutputHandle: 'rk-process-output:native-page' } };
  const fixture = nativeResultProjectionFixture([{ name: 'bash', value: raw }]);
  await fixture.session.pumpLoop();
  assert.equal(fixture.submitted.length, 1, 'the unsettled async sibling keeps this on the native delivery path');
  const output = fixture.submitted[0][0].output;
  assert.ok(output.length < 20000, 'the whole large receipt must never reach the wire');
  assert.doesNotMatch(output, /new-native-process|rk-process-output:native-page/);
  assert.match(output, /P1/);
  assert.match(output, /O1/);
  assert.deepEqual(resolveModelToolArguments('bash', { mode: 'output', processRef: 'P1', cursor: 'O1' },
    fixture.session.currentModelHandleCatalog()), { mode: 'output', processId: 'new-native-process', outputHandle: 'rk-process-output:native-page' });
  assert.equal(fixture.bodies.get('result-body-0'), JSON.stringify(raw), 'receipt bytes stay immutable');
  const restored = await readNativeRequestChildHandles(fixture.database, fixture.contentStore, 'projection-request');
  assert.ok(restored.some(entry => entry.kind === 'process' && entry.ref === 'P1' && entry.target === 'new-native-process'));
  fixture.session.childCatalog = { entries: restored };
  const replay = await fixture.session.buildFunctionCallOutput(fixture.session.calls.get('projection-call-0'));
  assert.equal(replay.output, output, 'already frozen delivery bytes must survive recovery unchanged');
  assert.equal(fixture.domains.get('ToolCallEvent').size, 1);
});
}

export { registerCases };
