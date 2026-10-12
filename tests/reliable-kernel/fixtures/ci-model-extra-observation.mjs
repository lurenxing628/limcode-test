import assert from 'node:assert/strict';
import { load, sse, compatDelta } from './ci-model-provider-support.mjs';
import { registerCases as registerHistoricalMeasurement } from '../ci-parts/single-response-measurement.mjs';
const stream = load('backend/capabilities/llmStreamEventProjection.js');
const control = load('backend/reliableKernel/modelProviderControlPlane.js');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;

export function registerExtraObservationTests(test, { getFixture, kernel }) {
  test('committed HTTP usage survives live feed and detail handoff without native billing', async () => {
    const f = getFixture(); const id = 'ci-metrics-feed'; await f.createConversation(id);
    f.setFetch(() => sse([compatDelta({ content: 'METRICS_REPLY' }), {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 537, completion_tokens: 111, total_tokens: 648,
        prompt_tokens_details: { cached_tokens: 500 } }
    }]));
    const frames = []; const feed = new kernel.BoundedClientFeed(f.app.database);
    try {
      await feed.connect({ activeConversationId: id, send(frame) { frames.push(frame);
        queueMicrotask(() => feed.acknowledge({ sessionId: frame.sessionId, hostBootId: frame.hostBootId, messageSeq: frame.messageSeq })); } });
      const turnId = await f.turn(id, 'measure this reply');
      const [request] = await f.rows('ModelRequest', { turn_id: turnId });
      assert.equal(parse(request.usage_json).promptTokenCount, 537);
      assert.equal(parse(request.usage_json).candidatesTokenCount, 111);
      assert.notEqual(parse(request.usage_json).nativeChainBilling, true);
      const snapshot = (await f.app.database.clientProjectionSnapshot(id)).snapshot;
      const row = snapshot.activeTurnSummary.modelRequests.find(row => row.id === request.id);
      assert.equal(parse(row.usage_json).promptTokenCount, 537);
      const message = snapshot.activeConversationWindow.messages.find(row => row.role === 'model');
      const detail = await new kernel.ClientDetailReader(f.app.database, f.app.contentStore).read({
        kind: 'message-content', recordId: message.revision_id, offset: 0, maxBytes: 65536, conversationId: id });
      assert.ok(detail);
      assert.ok(frames.some(frame => frame.type === 'reliable-kernel.changes'));
      const after = (await f.rows('ModelRequest', { id: request.id }))[0];
      assert.deepEqual(parse(after.usage_json), parse(request.usage_json));
    } finally { feed.close(); }
  });

  test('physical usage checkpoints are idempotent and stale sockets cannot overwrite the worker', async () => {
    const f = getFixture(); const id = 'ci-native-metrics'; await f.createConversation(id);
    const input = await f.input(id, 'record physical usage');
    const made = await f.request(id, input.turnId, 'ci-native-metrics-request');
    const repo = kernel.DOMAIN_REPOSITORIES.domain('ModelRequest');
    await f.app.modelProvider.dispatch(made.modelRequestId, { providerId: 'compatible', async sendFullRequest(_request, controls) {
      const first = { responseId: 'metrics-r1', streamSeq: '10', usage: { input_tokens: 120000, output_tokens: 2000 }, contextRootId: 'root-initial' };
      assert.equal(await f.app.modelProvider.persistNativeResponseUsage(made.modelRequestId, '1', '1', first), true);
      const committed = (await f.app.database.snapshot([repo.get(made.modelRequestId)])).snapshotCommitSeq;
      await f.app.modelProvider.persistNativeResponseUsage(made.modelRequestId, '1', '1', first);
      assert.equal((await f.app.database.snapshot([repo.get(made.modelRequestId)])).snapshotCommitSeq, committed);
      assert.equal(await f.app.modelProvider.persistNativeResponseUsage(made.modelRequestId, '1', '0', { responseId: 'old', streamSeq: '11', usage: { input_tokens: 10 } }), false);
      await f.app.modelProvider.persistNativeResponseUsage(made.modelRequestId, '1', '1', { responseId: 'metrics-r2', streamSeq: '12', previousResponseId: 'metrics-r1' });
      const latest = await f.app.modelProvider.readNativeLatestResponseUsage(made.modelRequestId);
      assert.equal(latest.responseId, 'metrics-r2'); assert.equal(latest.inputTokens, undefined);
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: 'metrics complete' }] } });
    } });
  });

  test('response timing excludes the tool wait and a terminal response is counted once', () => {
    const tracker = new stream.NativeResponseTimingTracker({ at: 1000, mark: 0 });
    tracker.responseCreated('timing-r1'); tracker.outputObserved(1800, 800);
    assert.deepEqual(tracker.responseEnded('timing-r1', 3000, 2000), {
      startedAt: 1000, completedAt: 3000, firstOutputAt: 1800, ttftMs: 800, outputDurationMs: 1200 });
    tracker.inputSubmitted(13000, 12000); tracker.responseCreated('timing-r2'); tracker.outputObserved(13500, 12500);
    assert.equal(tracker.responseEnded('timing-r2', 14000, 13000).outputDurationMs, 500);
    assert.equal(tracker.responseEnded('timing-r2', 14001, 13001), undefined);
  });

  test('latest physical input stays separate from accumulated chain billing', () => {
    const aggregate = new stream.NativePhysicalUsageAccumulator();
    aggregate.beginResponse('billing-r1'); aggregate.observeUsage('billing-r1', { promptTokenCount: 100000, candidatesTokenCount: 1000 });
    aggregate.beginResponse('billing-r2'); aggregate.observeUsage('billing-r2', { promptTokenCount: 110000, candidatesTokenCount: 2000 });
    aggregate.beginResponse('billing-r3'); aggregate.observeUsage('billing-r3', { promptTokenCount: 120000, candidatesTokenCount: 3000 });
    assert.equal(aggregate.billingTotals().promptTokenCount, 330000);
    assert.equal(aggregate.latestUsage().promptTokenCount, 120000);
    aggregate.beginResponse('billing-unknown');
    assert.equal(aggregate.billingTotals().promptTokenCount, undefined);
  });

  test('physical context usage is root scoped and preserves zero and unknown input', () => {
    const known = control.foldNativeResponseUsage(undefined, { responseId: 'root-response', streamSeq: '1',
      usage: { input_tokens: 0, output_tokens: 5 }, contextRootId: 'root-current', contextCovered: true }, '1', '1');
    assert.equal(control.nativeResponseContextTokens(known, 'root-current'), 0);
    assert.equal(control.nativeResponseContextTokens(known, 'root-other'), undefined);
    const unknown = control.foldNativeResponseUsage(known, { responseId: 'root-next', streamSeq: '2', previousResponseId: 'root-response', contextRootId: 'root-current' }, '1', '1');
    assert.equal(unknown.inputTokens, undefined);
    assert.equal(control.nativeResponseContextTokens(unknown, 'root-current'), undefined);
  });
  registerHistoricalMeasurement(test);
}
