import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyForkRequestError,
  decideForkClick,
  forkRequestsToReplay,
  forkResultResolves,
  markForkRequestSent,
  pendingForkMessageIds,
  restoreForkRequests,
  type ForkRequestRecords
} from '../src/composables/forkRequestLifecycle.ts';

let sequence = 0;
const nextCommand = () => {
  sequence += 1;
  return { commandId: `fork-command-${sequence}`, expectedVersion: 0, issuedAt: sequence };
};
const target = { sourceConversationId: 'source', messageId: 'message-a', expectedRevisionId: 'revision-1' };

function sent(requests: ForkRequestRecords, input = target, requestId = 'request-1', sessionId = 'session-1') {
  const decision = decideForkClick(requests, input, nextCommand);
  assert.equal(decision.kind, 'send');
  if (decision.kind !== 'send') throw new Error('unreachable');
  const request = markForkRequestSent(decision.request, requestId, sessionId);
  return { requests: { ...decision.requests, [request.actionId]: request }, request };
}

test('a permanent rejection drops the fork command', () => {
  const { requests, request } = sent({});
  const outcome = applyForkRequestError(requests, {
    correlationId: 'request-1', code: 'fork_rejected', message: '回合仍在运行'
  }, 10);
  assert.equal(outcome?.kind, 'rejected');
  assert.deepEqual(outcome?.requests, {});
  assert.equal(outcome?.request.actionId, request.actionId);
  assert.match(outcome?.notice ?? '', /回合仍在运行/);
});

test('an unconfirmed failure is kept for an explicit replay and never replayed by a new session', () => {
  const { requests, request } = sent({});
  const outcome = applyForkRequestError(requests, { correlationId: 'request-1', message: '历史刷新失败' }, 42);
  assert.equal(outcome?.kind, 'failed');
  const failed = outcome!.requests[request.actionId];
  assert.deepEqual(failed.failure, { message: '历史刷新失败', failedAt: 42 });
  assert.equal(failed.requestId, undefined);
  assert.deepEqual([...pendingForkMessageIds(outcome!.requests, 'source')], []);
  assert.deepEqual(forkRequestsToReplay(outcome!.requests, 'source', 'session-2'), [],
    'a reload must not silently create the branch the user saw failing');

  // The persisted failure survives a Webview reload unchanged.
  const restored = restoreForkRequests(JSON.parse(JSON.stringify(outcome!.requests)));
  assert.deepEqual(restored, outcome!.requests);

  // Clicking the same message revision replays the exact command, so a committed fork is reused.
  const replay = decideForkClick(restored, target, nextCommand);
  assert.equal(replay.kind, 'send');
  if (replay.kind !== 'send') return;
  assert.equal(replay.request.actionId, request.actionId);
  assert.equal(replay.request.payload.command.commandId, request.payload.command.commandId);
  assert.equal(replay.request.failure, undefined);
  assert.deepEqual(Object.keys(replay.requests), [request.actionId]);
});

test('a different message revision replaces a failed request but not an in-flight one', () => {
  const { requests, request } = sent({});
  const edited = { ...target, expectedRevisionId: 'revision-2' };
  const blocked = decideForkClick(requests, edited, nextCommand);
  assert.equal(blocked.kind, 'blocked');

  const failed = applyForkRequestError(requests, { correlationId: 'request-1' }, 5)!.requests;
  const replaced = decideForkClick(failed, edited, nextCommand);
  assert.equal(replaced.kind, 'send');
  if (replaced.kind !== 'send') return;
  assert.notEqual(replaced.request.actionId, request.actionId);
  assert.equal(replaced.request.payload.expectedRevisionId, 'revision-2');
  assert.deepEqual(Object.keys(replaced.requests), [replaced.request.actionId]);
});

test('a new Feed session re-sends only unconfirmed commands of the active conversation', () => {
  let { requests } = sent({});
  ({ requests } = sent(requests, { ...target, messageId: 'message-b' }, 'request-2'));
  ({ requests } = sent(requests, { ...target, sourceConversationId: 'other' }, 'request-3'));
  const failed = applyForkRequestError(requests, { correlationId: 'request-2' }, 1)!.requests;
  assert.deepEqual(forkRequestsToReplay(failed, 'source', 'session-1'), [], 'same session is not replayed');
  assert.deepEqual(forkRequestsToReplay(failed, 'source', 'session-2').map((request) => request.messageId), ['message-a']);
  assert.deepEqual([...pendingForkMessageIds(failed, 'source')], ['message-a']);
});

test('errors and results resolve only their exact command', () => {
  const { requests, request } = sent({});
  assert.equal(applyForkRequestError(requests, { correlationId: 'another-request' }, 1), undefined);
  assert.equal(applyForkRequestError(requests, {}, 1), undefined);
  const result = {
    sourceConversationId: 'source',
    messageId: 'message-a',
    expectedRevisionId: 'revision-1',
    commandId: request.actionId,
    conversationId: 'branch',
    status: 'accepted' as const
  };
  assert.equal(forkResultResolves(request, result), true);
  assert.equal(forkResultResolves(request, { ...result, expectedRevisionId: 'revision-2' }), false);
  assert.equal(forkResultResolves(request, { ...result, commandId: 'another' }), false);
  assert.equal(forkResultResolves(undefined, result), false);
});

test('restoring persisted requests drops incomplete or mismatched records', () => {
  const { requests, request } = sent({});
  const valid = JSON.parse(JSON.stringify(requests[request.actionId]));
  assert.deepEqual(restoreForkRequests({ [request.actionId]: valid, wrongKey: valid }), { [request.actionId]: valid });
  for (const broken of [
    { ...valid, payload: undefined },
    { ...valid, payload: { ...valid.payload, messageId: 'another-message' } },
    { ...valid, payload: { ...valid.payload, command: { ...valid.payload.command, commandId: 'another' } } },
    { ...valid, failure: { message: 1 } }
  ]) {
    assert.deepEqual(restoreForkRequests({ [request.actionId]: broken }), {});
  }
  assert.deepEqual(restoreForkRequests(null), {});
  assert.deepEqual(restoreForkRequests([valid]), {});
});
