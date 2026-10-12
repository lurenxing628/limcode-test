import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
import { after, test } from 'node:test';
import * as queue from './fixtures/recovery-guidance-fixture.mjs';
import * as recovery from './fixtures/recovery-runner-fixture.mjs';
import * as stream from './fixtures/recovery-stream-fixture.mjs';
import * as scheduler from './fixtures/recovery-scheduler-fixture.mjs';
import { createBehaviorRuntime, createBatchFixture, kernel, repo, rows, load, NOW } from './fixtures/runtime-behavior-fixture.mjs';

let shared, processFixture, completion;
async function runtime() { return shared ??= await createBehaviorRuntime('recovery'); }
after(async () => {
  await completion?.dispatcher.dispose(); await completion?.processes.dispose();
  await scheduler.close(); await processFixture?.close(); await shared?.close();
});

const ASK = { question: 'Continue?', options: [{ label: 'Continue' }, { label: 'Stop' }] };
const PLAN = { plan: 'Check committed work and continue.', taskList: { mode: 'rewrite',
  items: [{ title: 'Check work', status: 'pending', description: 'Read the committed result.' }] } };
const { BACKGROUND_ASK_USER_AUTO_ANSWER } = load('shared/askUser.js');
const { hasMatchingTerminalProcessReceipt } = load('backend/reliableKernel/runtimeProcessHistory.js');
const { ProcessCompletionDeliveryControlPlane } = load('backend/reliableKernel/processCompletionDelivery.js');

async function content(app, id) {
  const [metadata] = await rows(app.database, 'ContentObject', { id });
  return JSON.parse((await app.contentStore.read(metadata)).toString('utf8'));
}
async function finish(h, turnId, status = 'completed') {
  await h.app.turns.terminal({ source: { kind: 'internal', key: `${h.id}:finish:${turnId}` }, turnId,
    terminalStatus: status, reason: 'focused runtime lifecycle' });
}

// Queue controls use the production admission/revision APIs, including reopen and CAS conflicts.
test('guidance waits for the current model and tool batch then continues in FIFO order', () => queue.scenario1(runtime));
test('queued guidance edits, cancellation and hold survive reopen with the same revision', queue.scenario2);

test('only the frozen explicit Plan approval setting grants automatic approval', async () => {
  const f = await runtime();
  const h = await f.scope('plan-auto', { toolConfigs: { submit_plan: { config: { autoApprove: true } } } });
  const turn = await h.input('review plan');
  const input = await h.tool(turn.turnId, 'submit_plan', PLAN);
  assert.equal((await f.app.toolDispatcher.dispatch(input)).status, 'succeeded');
  const [toolLink] = await rows(f.app.database, 'InteractionToolCallLink', { tool_call_id: input.toolCallId });
  const [request] = await rows(f.app.database, 'InteractionRequest', { id: toolLink.request_id });
  const [response] = await rows(f.app.database, 'InteractionResponse', { request_id: request.id });
  assert.equal((await content(f.app, response.content_object_id)).decision, 'accept');
  assert.equal((await f.app.toolDispatcher.dispatch(input)).status, 'succeeded');
  assert.equal((await rows(f.app.database, 'InteractionResponse', { request_id: request.id })).length, 1);
  await finish(h, turn.turnId);
});

test('human cancellation and an automatic Ask response commit one durable decision', async () => {
  const f = await runtime();
  const h = await f.scope('ask-race', { toolConfigs: { ask_user: { config: { autoApprove: true } } } });
  const turn = await h.input('ask once');
  const input = await h.tool(turn.turnId, 'ask_user', ASK);
  const paused = await f.app.interactions.pauseForAskUser({ source: { kind: 'internal', key: `${h.id}:pause` },
    toolCallId: input.toolCallId, prompt: ASK });
  const results = await Promise.all([
    f.app.interactions.resolveAskUser({ source: { kind: 'internal', key: `${h.id}:auto` }, requestId: paused.requestId,
      response: { answer: { selectedOptionIndexes: [], customText: BACKGROUND_ASK_USER_AUTO_ANSWER } } }),
    f.app.interactions.resolveAskUser({ source: { kind: 'command', key: `${h.id}:cancel` }, requestId: paused.requestId,
      cancelled: true, response: { reason: 'User cancelled the question.' } })
  ]);
  assert.equal(results.filter(result => result.won).length, 1);
  assert.equal((await rows(f.app.database, 'InteractionResponse', { request_id: paused.requestId })).length, 1);
  assert.equal((await rows(f.app.database, 'ToolOutcome', { tool_call_id: input.toolCallId })).length, 1);
  await finish(h, turn.turnId);
});

test('a busy queued admission recovers without another user event', () => recovery.scenario1(runtime));
test('a lost assistant commit acknowledgment recovers without another model call', () => recovery.scenario2(runtime));
test('durable stop cancels local output recovery before another model request', () => recovery.scenario3(runtime));

test('a completed source result joins the running Turn and moves to next Turn when idle', async () => {
  const f = await runtime(), h = await f.scope('running-result');
  const source = await h.input('source'); await finish(h, source.turnId);
  const target = await h.input('running');
  const id = `${h.id}:inbox`;
  await f.app.database.transaction([repo('RuntimeInboxItem').insert({ id, dedupe_key: id,
    source_kind: 'process_receipt', source_id: `${id}:receipt`, state: 'available', created_at: NOW, updated_at: NOW })]);
  const router = new kernel.AutomaticRuntimeDeliveryRouter(f.app.database, f.app.contentStore);
  const decision = await router.resolve({ inboxItemId: id, targetConversationId: h.id, sourceTurnId: source.turnId });
  assert.equal(decision.phase, 'current_turn'); assert.equal(decision.targetTurnId, target.turnId);
  assert.equal(decision.sourceTurnId, source.turnId);
  await finish(h, target.turnId);
  assert.equal((await router.resolve({ inboxItemId: id, targetConversationId: h.id, sourceTurnId: source.turnId })).phase, 'next_turn');
});

async function processResult(h, id, sourceTurnId) {
  const app = h.app, payload = await app.contentStore.prepare(app.database, JSON.stringify({ kind: 'process_completion',
    processId: id, processReceiptId: `${id}:receipt`, sourceTurnId, conversationId: h.id }),
  'application/vnd.limcode.process-completion+json');
  await app.database.transaction([
    ...kernel.preparedContentSteps([payload], 'focused_process_result'),
    repo('Process').insert({ id, status: 'exited', wrapper_nonce: `${id}:nonce`, wrapper_pid: 0n, child_pid: null,
      process_group_id: null, start_fingerprint: `${id}:fingerprint`, command_digest: `${id}:command`,
      spool_locator: `${id}:spool`, retained_bytes: 0n, retained_chunks: 0n, dropped_bytes: 0n, truncated: 0n,
      started_at: NOW, updated_at: NOW, completed_at: NOW }),
    repo('ProcessCompletionSourceLink').insert({ id: `${id}:source`, process_id: id, conversation_id: h.id,
      source_turn_id: sourceTurnId, source_tool_call_id: `${id}:tool`, created_at: NOW }),
    repo('ProcessReceipt').insert({ id: `${id}:receipt`, process_id: id, outcome: 'succeeded', exit_code: 0n,
      exit_signal: null, wrapper_nonce: `${id}:nonce`, start_fingerprint: `${id}:fingerprint`, received_at: NOW }),
    repo('RuntimeInboxItem').insert({ id, dedupe_key: id, source_kind: 'process_receipt', source_id: `${id}:receipt`,
      state: 'available', created_at: NOW, updated_at: NOW }),
    repo('RuntimeInboxPayloadLink').insert({ id: `${id}:payload`, inbox_item_id: id, content_object_id: payload.metadata.id, created_at: NOW })
  ]); return id;
}

async function finalRequest(h, turnId) {
  const app = h.app, id = `${h.id}:final`, recipe = await app.contentStore.prepare(app.database, '{}', 'application/json');
  const [authority] = await rows(app.database, 'AuthoritySnapshot', { turn_id: turnId });
  await app.database.transaction([
    ...kernel.preparedContentSteps([recipe], 'focused_final_request'),
    repo('ModelRequest').insertHistoricalCopy({ id, turn_id: turnId, request_seq: 1n, status: 'terminal', terminal_state: 'completed',
      provider_id: 'behavior-provider', model_id: 'behavior-model', context_window_tokens: 1000n, compression_threshold_tokens: 900n,
      estimated_context_tokens: 1n, authority_snapshot_id: authority.id, settings_snapshot_object_id: null,
      recipe_object_id: recipe.metadata.id, usage_json: null, stream_stats_json: { attemptSeq: '1', socketGeneration: '1', retryReason: null },
      created_at: NOW, updated_at: NOW }),
    repo('Operation').insertHistoricalCopy({ id: `${id}:operation`, owner_kind: 'model_request', owner_id: id,
      operation_seq: 1n, tool_call_id: null, status: 'completed', created_at: NOW, updated_at: NOW }),
    repo('Attempt').insertHistoricalCopy({ id: `${id}:attempt`, operation_id: `${id}:operation`, attempt_seq: 1n,
      status: 'completed', created_at: NOW, updated_at: NOW, completed_at: NOW }),
    repo('ModelStreamFence').insertHistoricalCopy({ id: `${id}:fence`, model_request_id: id, attempt_seq: 1n, socket_generation: 1n,
      terminal_stream_seq: 1n, outcome: 'completed', created_at: NOW })
  ]); return id;
}

test('two queued process results are consumed by one admitted continuation', async () => {
  const f = await runtime(), h = await f.scope('coalesced-results');
  const finishing = await h.input('finishing');
  const router = new kernel.AutomaticRuntimeDeliveryRouter(f.app.database, f.app.contentStore);
  assert.equal((await router.establishFinalOutputFence({ turnId: finishing.turnId,
    modelRequestId: await finalRequest(h, finishing.turnId) })).established, true);
  const deliveries = [];
  for (const id of [`${h.id}:first`, `${h.id}:second`]) {
    const result = await f.app.runtime.deliveries.createAutomatic({ inboxItemId: await processResult(h, id, finishing.turnId),
      targetConversationId: h.id, sourceTurnId: finishing.turnId });
    deliveries.push(result.delivery.id);
    assert.equal((await f.app.turns.runtimeContinuation({ source: { kind: 'internal', key: `${id}:continue` },
      ...h.lease(), deliveryId: result.delivery.id, sourceTurnId: finishing.turnId })).admitted, false);
  }
  await finish(h, finishing.turnId);
  const admitted = await f.app.turns.admitNextQueued(h.lease()); assert.ok(admitted?.turnId);
  const states = [];
  for (const id of deliveries) {
    const [delivery] = await rows(f.app.database, 'RuntimeDelivery', { id });
    assert.deepEqual([delivery.state, delivery.target_turn_id], ['consumed', admitted.turnId]);
    const [link] = await rows(f.app.database, 'RuntimeDeliveryIntentLink', { delivery_id: id });
    const [intent] = await rows(f.app.database, 'TurnIntent', { id: link.turn_intent_id }); states.push(intent.state);
  }
  assert.deepEqual(states, ['admitted', 'cancelled']);
  for (const input of await rows(f.app.database, 'PendingTurnInput', { turn_id: admitted.turnId, input_kind: 'runtime_delivery', state: 'pending' })) {
    await f.app.runtime.deliveries.markInputHandled(input.id);
  }
  await finish(h, admitted.turnId);
  assert.equal(await f.app.turns.admitNextQueued(h.lease()), null);
});

test('stream reset keeps the committed tool effect and its model result exactly once', stream.scenario1);

test('task-list preserves frozen arguments and replays the canonical CAS result', async () => {
  const f = await runtime(), h = await f.scope('task-durable'), turn = await h.input('task');
  const args = { mode: 'rewrite', items: [{ title: ' Verify ', status: 'in_progress', description: null, delete: false }] };
  const original = JSON.stringify(args), input = await h.tool(turn.turnId, 'update_task_list', args);
  const command = { source: { kind: 'internal', key: `${h.id}:settle` }, toolCallId: input.toolCallId, operation: args };
  const first = await f.app.interactions.settleTaskList(command); assert.equal(first.terminal.status, 'succeeded');
  assert.equal(JSON.stringify(args), original);
  const [call] = await rows(f.app.database, 'ToolCall', { id: input.toolCallId });
  assert.deepEqual(await content(f.app, call.arguments_object_id), JSON.parse(original));
  const [outcome] = await rows(f.app.database, 'ToolOutcome', { tool_call_id: input.toolCallId });
  assert.deepEqual((await content(f.app, outcome.content_object_id)).detail.operation,
    { kind: 'task_list.operation', mode: 'rewrite', items: [{ title: 'Verify', status: 'in_progress' }] });
  assert.equal((await f.app.interactions.settleTaskList(command)).deduplicated, true);
  assert.equal((await rows(f.app.database, 'ToolOutcome', { tool_call_id: input.toolCallId })).length, 1);
  await finish(h, turn.turnId);
});

test('Ask replays its existing durable prompt before validating changed replay arguments', async () => {
  const f = await runtime(), h = await f.scope('ask-durable'), turn = await h.input('question');
  const input = await h.tool(turn.turnId, 'ask_user', ASK);
  const command = { source: { kind: 'internal', key: `${h.id}:pause` }, toolCallId: input.toolCallId, prompt: ASK };
  const pause = await f.app.interactions.pauseForAskUser(command);
  const [request] = await rows(f.app.database, 'InteractionRequest', { id: pause.requestId });
  const prompt = await content(f.app, request.prompt_object_id);
  assert.equal((await f.app.interactions.pauseForAskUser({ ...command, prompt: { options: [] } })).deduplicated, true);
  await f.app.interactions.resolveAskUser({ source: { kind: 'command', key: `${h.id}:answer` }, requestId: pause.requestId,
    response: { answer: { selectedOptionIndexes: [0] } } });
  assert.equal((await f.app.interactions.pauseForAskUser({ ...command, prompt: null })).deduplicated, true);
  assert.deepEqual(await content(f.app, request.prompt_object_id), prompt);
  assert.equal((await rows(f.app.database, 'InteractionRequest', { id: pause.requestId })).length, 1);
  await finish(h, turn.turnId);
});

test('terminal Process evidence rejects a receipt from another nonce identity', () => {
  const process = { id: 'process', status: 'outcome_unknown', wrapper_nonce: 'actual', start_fingerprint: 'fingerprint', completed_at: NOW };
  const receipt = { process_id: 'process', outcome: 'outcome_unknown', exit_code: null, exit_signal: null,
    wrapper_nonce: 'another-start', start_fingerprint: 'fingerprint' };
  assert.equal(hasMatchingTerminalProcessReceipt(process, receipt), false);
});

const COMPLETED_AT = '2026-10-12T00:00:00.000Z';
async function notificationFixture(id, status = 'outcome_unknown') {
  const h = processFixture ??= await createBatchFixture();
  const body = await h.store.ingest(h.database, '{}', 'application/json');
  await h.database.transaction([
    repo('Conversation').insert({ id: `${id}:conversation`, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
    repo('Turn').insert({ id: `${id}:turn`, conversation_id: `${id}:conversation`, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
    repo('TurnTermination').insert({ id: `${id}:termination`, turn_id: `${id}:turn`, terminal_status: 'completed', reason: 'fixture', created_at: NOW }),
    repo('Process').insert({ id, status, wrapper_nonce: `${id}:nonce`, wrapper_pid: 2147483647n, child_pid: 1n,
      process_group_id: 1n, start_fingerprint: `${id}:fingerprint`, command_digest: 'a'.repeat(64), spool_locator: 'missing-spool',
      retained_bytes: 0n, retained_chunks: 0n, dropped_bytes: 0n, truncated: 0n, started_at: NOW, updated_at: NOW, completed_at: COMPLETED_AT }),
    repo('ProcessCompletionSourceLink').insert({ id: `${id}:source`, process_id: id, conversation_id: `${id}:conversation`,
      source_turn_id: `${id}:turn`, source_tool_call_id: `${id}:tool`, created_at: NOW }),
    repo('ProcessReceipt').insert({ id: `${id}:receipt`, process_id: id, outcome: status === 'exited' ? 'succeeded' : status,
      exit_code: status === 'exited' ? 0n : null, exit_signal: null, wrapper_nonce: `${id}:nonce`, start_fingerprint: `${id}:fingerprint`, received_at: NOW }),
    repo('Operation').insert({ id: `${id}:operation`, owner_kind: 'process', owner_id: id, operation_seq: 1n,
      tool_call_id: null, status: 'completed', created_at: NOW, updated_at: NOW }),
    repo('Attempt').insert({ id: `${id}:attempt`, operation_id: `${id}:operation`, attempt_seq: 1n, status: 'completed',
      created_at: NOW, updated_at: NOW, completed_at: NOW }),
    repo('EffectIntent').insert({ id: `${id}:intent`, attempt_id: `${id}:attempt`, effect_kind: 'process_exit', dispatch_state: 'receipt_written',
      request_object_id: body.id, created_at: NOW, updated_at: NOW }),
    repo('ProcessCompletionDispatch').insert({ id: `${id}:dispatch`, process_receipt_id: `${id}:receipt`, state: 'pending',
      claim_owner_host_boot_id: null, claim_generation: 0n, claim_expires_at: null, attempt_count: 0n, failure_count: 0n,
      next_attempt_at: null, last_error: null, created_at: NOW, updated_at: NOW, completed_at: null })
  ]);
  if (!completion) {
    const effects = new kernel.EffectControlPlane(h.database, h.store);
    const processes = new kernel.ProcessControlPlane(h.database, h.store, effects, h.authority, h.binding);
    const deliveries = new kernel.RuntimeDeliveryControlPlane(h.database, h.store);
    const dispatcher = new ProcessCompletionDeliveryControlPlane(h.database, h.store, processes, deliveries, { now: () => NOW });
    completion = { processes, dispatcher };
  }
  return h;
}

test('an unknown Process result notifies once using its verified completion time', async () => {
  const id = 'notification-unknown', h = await notificationFixture(id);
  const report = await completion.dispatcher.scanNow(); assert.equal(report.completionsCreated, 1);
  const [process] = await rows(h.database, 'Process', { id }); assert.equal(process.status, 'outcome_unknown');
  const [link] = await rows(h.database, 'RuntimeInboxPayloadLink', { inbox_item_id: (await rows(h.database, 'RuntimeInboxItem', { source_id: `${id}:receipt` }))[0].id });
  const [metadata] = await rows(h.database, 'ContentObject', { id: link.content_object_id });
  const payload = JSON.parse((await h.store.read(metadata)).toString('utf8'));
  assert.equal(payload.completedAt, COMPLETED_AT); assert.notEqual(payload.completedAt, NOW);
  assert.equal((await completion.dispatcher.scanNow()).completionsCreated, 0);
});

test('changed Process evidence after the read cannot commit a completion notification', async () => {
  const id = 'notification-changed', h = await notificationFixture(id, 'exited');
  const reconcile = completion.processes.reconcileOutput.bind(completion.processes);
  completion.processes.reconcileOutput = async processId => {
    if (processId === id) await h.database.transaction([repo('Process').update(id, { status: 'running', completed_at: null })]);
    return reconcile(processId);
  };
  try {
    const report = await completion.dispatcher.scanNow(); assert.equal(report.completionsCreated, 0); assert.equal(report.failures, 1);
    assert.deepEqual(await rows(h.database, 'RuntimeInboxItem', { source_id: `${id}:receipt` }), []);
  } finally { completion.processes.reconcileOutput = reconcile; }
});

test('ordinary native calls share one bounded tool lane', scheduler.scenario1);
test('serial tool policy fences earlier and later generations', scheduler.scenario2);
test('child startup releases its scheduler slot at durable admission', scheduler.scenario3);


test('process output reuses registered prefixes and invalidates an external rewrite', async () => {
  const h = processFixture ??= await createBatchFixture();
  const store = h.store, database = h.database;
  const effects = new kernel.EffectControlPlane(database, store);
  const processes = new kernel.ProcessControlPlane(database, store, effects, h.authority, h.binding);
  const id = 'registered-prefix', now = new Date().toISOString();
  const identity = { kind: kernel.PROCESS_WRAPPER_PROTOCOL, processId: id, stableNonce: '1'.repeat(32),
    wrapperPid: '2147483601', childPid: '2147483600', processGroupId: '2147483600',
    startFingerprint: 'prefix-fixture', commandDigest: 'a'.repeat(64), spoolLocator: id, startedAt: now };
  await database.transaction([repo('Process').insert({ id, status: 'running', wrapper_nonce: identity.stableNonce,
    wrapper_pid: BigInt(identity.wrapperPid), child_pid: BigInt(identity.childPid), process_group_id: BigInt(identity.processGroupId),
    start_fingerprint: identity.startFingerprint, command_digest: identity.commandDigest, spool_locator: id,
    retained_bytes: 0n, retained_chunks: 0n, dropped_bytes: 0n, truncated: 0n, started_at: now, updated_at: now, completed_at: null })]);
  const spool = kernel.processSpoolPath(h.binding, id);
  await fs.mkdir(path.join(spool, 'chunks'), { recursive: true });
  await fs.writeFile(path.join(spool, kernel.PROCESS_WRAPPER_IDENTITY_FILE), JSON.stringify(identity));
  let count = 0, bytes = 0;
  const append = async value => {
    const body = Buffer.from(value); bytes += body.length;
    await fs.writeFile(path.join(spool, 'chunks', kernel.processChunkFileName(BigInt(++count), 'stdout')), body);
    const emptyDigest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    await fs.writeFile(path.join(spool, kernel.PROCESS_WRAPPER_MANIFEST_FILE), JSON.stringify({
      kind: identity.kind, processId: id, stableNonce: identity.stableNonce, status: 'running',
      nextChunkSeq: String(count + 1), retainedBytes: String(bytes), retainedChunks: String(count),
      droppedBytes: '0', truncated: false, stdoutTailBytes: '0', stdoutTailSha256: emptyDigest, stdoutTailBase64: '',
      stderrTailBytes: '0', stderrTailSha256: emptyDigest, stderrTailBase64: '', updatedAt: now }));
  };
  const originalSnapshot = database.snapshot.bind(database), gets = [];
  database.snapshot = async (reads, ...args) => {
    gets.push(...reads.filter(read => read.domain === 'ProcessOutputChunk' && read.kind === 'get').map(read => read.id));
    return originalSnapshot(reads, ...args);
  };
  try {
    await append('one'); await append('two');
    assert.equal((await processes.reconcileOutput(id)).insertedChunks, 2);
    gets.length = 0;
    assert.equal((await processes.reconcileOutput(id)).insertedChunks, 0);
    assert.deepEqual(gets, [], 'the unchanged registered prefix is reused');
    await append('three'); gets.length = 0;
    assert.equal((await processes.reconcileOutput(id)).insertedChunks, 1);
    assert.deepEqual(new Set(gets), new Set([kernel.stablePhaseDId('process_output_chunk', `${id}:3`)]));
    // A distinct OS process preserves POSIX SQLite locks while changing the live database.
    const changed = spawnSync(process.execPath, ['-e',
      'const D=require(process.argv[1]);const d=new D(process.argv[2]);d.prepare("DELETE FROM process_output_chunk WHERE process_id=? AND chunk_seq=1").run(process.argv[3]);d.close();',
      require.resolve('better-sqlite3'), h.binding.paths.databasePath, id], { encoding: 'utf8' });
    assert.equal(changed.status, 0, changed.stderr); gets.length = 0;
    assert.equal((await processes.reconcileOutput(id)).insertedChunks, 1);
    assert.ok(gets.includes(kernel.stablePhaseDId('process_output_chunk', `${id}:2`)), 'a foreign change invalidates the cached prefix');
    assert.equal((await processes.readOutputPage(id)).stdout, 'onetwothree');
  } finally { database.snapshot = originalSnapshot; await processes.dispose(); await fs.rm(spool, { recursive: true, force: true }); }
});
