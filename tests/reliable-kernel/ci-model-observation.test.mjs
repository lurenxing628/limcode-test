import assert from 'node:assert/strict';
import { before, after, afterEach, test } from 'node:test';
import { kernel, llm, sse, compatDelta, geminiChunk, claudeSse } from './fixtures/ci-model-provider-support.mjs';
import { openProviderRuntimeFixture } from './fixtures/ci-model-provider-runtime.mjs';
import { registerExtraObservationTests } from './fixtures/ci-model-extra-observation.mjs';

let fixture;
before(async () => { fixture = await openProviderRuntimeFixture(); });
after(async () => { await fixture?.close(); });
afterEach(() => fixture.setFetch(() => sse([compatDelta({ content: 'reply' }), compatDelta({}, 'stop')])));

test('Claude 绑定与 Gemini 文本尾签名各自提交，共享重启后首次请求保持正确回放', async () => {
  const claudeBodies = [];
  const geminiBodies = [];
  fixture.setFetch(entry => {
    if (entry.body.contents) {
      geminiBodies.push(entry.body);
      return sse([geminiChunk([{ text: 'answer' }]),
        geminiChunk([{ text: '', thoughtSignature: 'TEXT_TAIL_SIGNATURE' }], 'STOP')]);
    }
    claudeBodies.push(entry.body);
    const hasThinking = entry.body.messages.some(message => Array.isArray(message.content)
      && message.content.some(block => block.type === 'thinking'));
    if (hasThinking) return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message:
      'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. '
      + 'Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".' } }),
    { status: 400, headers: { 'content-type': 'application/json' } });
    return claudeSse([{ text: 'thinking', thought: true }, { text: 'answer' }]);
  });
  await fixture.createConversation('binding-persistence', 'claude');
  await fixture.turn('binding-persistence', 'first');
  const second = await fixture.turn('binding-persistence', 'second');
  assert.equal(claudeBodies.length, 4);
  assert.equal(claudeBodies[2].thinking.block_binding.prefix_mismatch_behavior, 'drop_block');
  const [learned] = await fixture.rows('ModelRequest', { turn_id: second });
  assert.equal(learned.stream_stats_json.claudeThinkingBinding, 'strip_thinking');
  await fixture.createConversation('gemini-signature', 'gemini');
  await fixture.turn('gemini-signature', 'first');
  await fixture.restart();
  const third = await fixture.turn('binding-persistence', 'third');
  assert.equal(claudeBodies.length, 5);
  assert.equal(JSON.stringify(claudeBodies[4]).includes('"type":"thinking"'), false);
  assert.equal((await fixture.rows('ModelRequest', { turn_id: third }))[0].stream_stats_json.claudeThinkingBinding,
    'strip_thinking');
  await fixture.turn('gemini-signature', 'second');
  assert.deepEqual(geminiBodies[1].contents.find(content => content.role === 'model').parts,
    [{ text: 'answer' }, { text: '', thoughtSignature: 'TEXT_TAIL_SIGNATURE' }]);
  const replay = fixture.requests.at(-1).request.context.find(segment => segment.messageRole === 'model');
  assert.deepEqual(JSON.parse(replay.content).parts,
    [{ text: 'answer' }, { text: '', thoughtSignature: 'gemini:TEXT_TAIL_SIGNATURE' }]);
});

test('真实 Gemini SDK 断流替换 durable Attempt，不执行失败流里的工具', async () => {
  let calls = 0;
  const bodies = [];
  fixture.setFetch(entry => {
    bodies.push(entry.body);
    if (++calls > 1) return sse([geminiChunk([{ text: 'recovered' }], 'STOP')]);
    let sent = false;
    return new Response(new ReadableStream({ pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(geminiChunk([
          { text: 'discarded', thought: true },
          { functionCall: { name: 'edit', args: { path: 'a', mode: 'hunk', hunks: [] }, id: 'partial-call' } }
        ]))}\n\n`));
      } else controller.error(new TypeError('terminated'));
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  await fixture.createConversation('sdk-retry', 'gemini');
  const turnId = await fixture.turn('sdk-retry', 'input', {
    retryPolicy: { enabled: true, maxRetries: 1, retryDelayMs: 1 }
  });
  const [request] = await fixture.rows('ModelRequest', { turn_id: turnId });
  assert.equal(request.terminal_state, 'completed');
  assert.equal(calls, 2);
  assert.deepEqual(bodies[1], bodies[0]);
  assert.deepEqual((await fixture.app.modelProvider.completedEvent(request.id)).content,
    { role: 'model', parts: [{ text: 'recovered' }] });
  const [operation] = await fixture.rows('Operation', { owner_kind: 'model_request', owner_id: request.id });
  assert.deepEqual((await fixture.rows('Attempt', { operation_id: operation.id })).map(attempt => attempt.status).sort(),
    ['completed', 'transient_failed']);
  assert.equal((await fixture.rows('ToolCall', { turn_id: turnId })).length, 0);
});

test('伪思考进度不续命，持久重试等待经接手仍保持并可取消', async context => {
  await fixture.createConversation('watchdog-handoff');
  const input = await fixture.input('watchdog-handoff', 'input', {
    retryPolicy: { enabled: true, maxRetries: 1, retryDelayMs: 60_000 }
  });
  const created = await fixture.request('watchdog-handoff', input.turnId, 'watchdog');
  const schedule = globalThis.setTimeout;
  const timers = [];
  let retryWaiting = () => {};
  context.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    if (milliseconds === 7 || milliseconds === 11 || milliseconds === 60_000) {
      // Keep native clearTimeout handles; only the fixture fires watchdog callbacks.
      const handle = schedule(() => {}, 60_000).unref();
      timers.push({ milliseconds, handle, fire() { clearTimeout(handle); callback(...args); } });
      if (milliseconds === 60_000) retryWaiting();
      return handle;
    }
    return schedule(callback, milliseconds, ...args);
  });
  const epoch = Date.now();
  const options = { epochNow: () => epoch, semanticTimeouts: { firstSemanticMs: 7, semanticIdleMs: 11 },
    retryDelaysMs: [0], adapterDrainTimeoutMs: 20 };
  const first = new kernel.ModelProviderControlPlane(fixture.app.database, fixture.app.contentStore, options);
  let progressSeen;
  const progressed = new Promise(resolve => { progressSeen = resolve; });
  let retryCommitted;
  const persistedRetry = new Promise(resolve => { retryCommitted = resolve; });
  let calls = 0;
  const adapter = { providerId: 'compatible', async sendFullRequest(request, controls) {
    calls += 1;
    await controls.onEvent({ kind: 'output_delta', streamSeq: '1', semanticProgress: false, content: {
      type: 'thought_progress', thoughtStartedAt: Date.now(), thoughtElapsedMs: 10
    } });
    progressSeen();
    await new Promise(resolve => controls.signal.addEventListener('abort', resolve, { once: true }));
  } };
  const running = first.dispatch(created.modelRequestId, adapter, { onTransientTerminal(observation) {
    if (observation.event.content.retrying) retryCommitted();
  } });
  const interrupted = assert.rejects(running, /handoff/);
  try {
    await progressed;
    assert.deepEqual(timers.map(timer => timer.milliseconds), [7]);
    timers.find(timer => timer.milliseconds === 7).fire();
    await persistedRetry;
    const [retrying] = await fixture.rows('ModelRequest', { id: created.modelRequestId });
    assert.equal(retrying.status, 'retrying');
    assert.equal(retrying.stream_stats_json.attemptSeq, '2');
    assert.equal(retrying.stream_stats_json.retryDelayMs, 60_000);
    assert.equal(retrying.stream_stats_json.retryNotBeforeAt, epoch + 60_000);
    await first.quiesceAllActiveDispatches(new kernel.ExecutionHandoffError('fixture handoff'));
    await interrupted;
    const caller = new AbortController();
    const second = new kernel.ModelProviderControlPlane(fixture.app.database, fixture.app.contentStore, options);
    const nextWaitArmed = new Promise(resolve => { retryWaiting = resolve; });
    const resumed = second.dispatch(created.modelRequestId, adapter, { reconnect: true, signal: caller.signal });
    const cancelled = assert.rejects(resumed, /cancelled/);
    await nextWaitArmed;
    assert.equal(calls, 1);
    assert.equal((await fixture.rows('ModelRequest', { id: created.modelRequestId }))[0]
      .stream_stats_json.retryNotBeforeAt, retrying.stream_stats_json.retryNotBeforeAt);
    caller.abort();
    await cancelled;
    assert.equal(calls, 1);
    assert.equal((await fixture.rows('ModelRequest', { id: created.modelRequestId }))[0].terminal_state,
      'cancelled-during-provider-retry-delay');
  } finally {
    await first.quiesceAllActiveDispatches(new kernel.ExecutionHandoffError('fixture cleanup'));
    for (const timer of timers) clearTimeout(timer.handle);
  }
});

test('可靠错误递归脱敏认证信息，同时保留 cause 和非秘密诊断', () => {
  const error = Object.assign(new Error('closed'), { transport: 'websocket', closeCode: 1011,
    apiKey: 'top-key', headers: { Authorization: 'Bearer top-secret', 'x-request-id': 'request' },
    cause: { message: 'socket reset', api_key: 'nested-key', headers: { 'x-request-id': 'cause' } } });
  const raw = llm.rawErrorFromUnknown(error, { rawResponse: { headers: new Headers({
    'content-type': 'application/json', authorization: 'Bearer response-secret', 'set-cookie': 'cookie-secret'
  }), body: { error: { code: 'closed' }, password: 'body-secret' } } });
  assert.equal(raw.transport, 'websocket');
  assert.equal(raw.closeCode, 1011);
  assert.deepEqual(raw.headers, { 'x-request-id': 'request' });
  assert.deepEqual(raw.cause, { message: 'socket reset', headers: { 'x-request-id': 'cause' } });
  assert.deepEqual(raw.rawResponse, { headers: { 'content-type': 'application/json' }, body: { error: { code: 'closed' } } });
  assert.doesNotMatch(JSON.stringify(raw), /top-key|top-secret|nested-key|response-secret|cookie-secret|body-secret/);
});

registerExtraObservationTests(test, { getFixture: () => fixture, kernel });
