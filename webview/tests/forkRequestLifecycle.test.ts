import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyForkRequestError,
  decideForkClick,
  forkReadyNoticeLinked,
  forkRequestsToReplay,
  forkResultNavigation,
  forkResultResolves,
  markForkRequestSent,
  messageForkBlocked,
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
  }, 10, new Set([request.actionId]));
  assert.equal(outcome?.kind, 'rejected');
  assert.deepEqual(outcome?.requests, {});
  assert.equal(outcome?.request.actionId, request.actionId);
  assert.equal(outcome?.notice, '未创建分支：回合仍在运行');
});

test('failure hints never contradict the reason, and a replayed request says it is an earlier one', () => {
  const { requests, request } = sent({});
  const failed = applyForkRequestError(requests, {
    correlationId: 'request-1', message: 'Fork 源 Message Revision 已变化，请基于当前内容重新创建分支。'
  }, 10, new Set([request.actionId]));
  assert.equal(failed?.kind, 'failed');
  assert.doesNotMatch(failed?.notice ?? '', /重放同一分支命令/, 'a hint must not promise to replay what the reason says to redo');
  assert.match(failed?.notice ?? '', /可再次点击分支按钮/);
  const generic = applyForkRequestError(requests, { correlationId: 'request-1' }, 10, new Set([request.actionId]));
  assert.equal(generic?.notice, '分支结果尚未确认，可再次点击分支按钮重试。');

  const replayed = applyForkRequestError(requests, { correlationId: 'request-1', code: 'fork_rejected', message: '源消息已变化' }, 10, new Set());
  assert.equal(replayed?.notice, '之前的分支请求未创建分支：源消息已变化');
});

test('only a click in this Webview session, still on the source, opens the fork', () => {
  const { request } = sent({});
  const result = { sourceConversationId: 'source', messageId: 'message-a', expectedRevisionId: 'revision-1', commandId: request.actionId, conversationId: 'branch', status: 'accepted' as const };
  assert.deepEqual(forkResultNavigation(request, result, { clickedThisSession: true, activeConversationId: 'source' }), { kind: 'open' });
  assert.deepEqual(forkResultNavigation(request, result, { clickedThisSession: true, activeConversationId: 'elsewhere' }),
    { kind: 'notice', notice: { sourceConversationId: 'source', conversationId: 'branch', replayed: false } },
    'a user who moved on is not pulled back; the source offers the fork instead');
  assert.deepEqual(forkResultNavigation(request, result, { clickedThisSession: false, activeConversationId: 'source' }),
    { kind: 'notice', notice: { sourceConversationId: 'source', conversationId: 'branch', replayed: true } },
    'a result replayed after a reload never navigates by itself');
});

test('a fork is offered only while this view holds its branch link from the source', () => {
  const notice = { sourceConversationId: 'source', conversationId: 'branch', replayed: true };
  const link = (id: string, target: string, source: string) =>
    ({ [id]: { id, target_conversation_id: target, source_conversation_id: source } });
  assert.equal(forkReadyNoticeLinked(notice, link('l1', 'branch', 'source')), true);
  assert.equal(forkReadyNoticeLinked(notice, undefined), false, 'the fork was deleted with its link');
  assert.equal(forkReadyNoticeLinked(notice, link('l2', 'other-branch', 'source')), false);
  assert.equal(forkReadyNoticeLinked(notice, link('l3', 'branch', 'elsewhere')), false, 'a link from another source does not count');
});

test('the fork button is disabled for messages of the running turn, pending forks and unfinished messages', () => {
  const state = {
    activeTurnId: 'turn-2',
    pendingMessageIds: new Set(['pending']),
    revisionIdByMessageId: { done: 'r1', running: 'r2', pending: 'r3', streaming: 'r4' } as Record<string, string>,
    turnIdByMessageId: { done: 'turn-1', running: 'turn-2', pending: 'turn-1', streaming: 'turn-1' } as Record<string, string>
  };
  assert.equal(messageForkBlocked({ id: 'done', status: 'final' }, state), false, 'an earlier turn stays forkable while a later one runs');
  assert.equal(messageForkBlocked({ id: 'running', status: 'final' }, state), true);
  assert.equal(messageForkBlocked({ id: 'pending', status: 'final' }, state), true);
  assert.equal(messageForkBlocked({ id: 'streaming', status: 'streaming' }, state), true);
  assert.equal(messageForkBlocked({ id: 'no-revision', status: 'final' }, state), true);
  assert.equal(messageForkBlocked({ id: 'running', status: 'final' }, { ...state, activeTurnId: '' }), false, 'once the turn ends it can be forked');
});

test('an unconfirmed failure is kept for an explicit replay and never replayed by a new session', () => {
  const { requests, request } = sent({});
  const outcome = applyForkRequestError(requests, { correlationId: 'request-1', message: '历史刷新失败' }, 42, new Set());
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

  const failed = applyForkRequestError(requests, { correlationId: 'request-1' }, 5, new Set())!.requests;
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
  const failed = applyForkRequestError(requests, { correlationId: 'request-2' }, 1, new Set())!.requests;
  assert.deepEqual(forkRequestsToReplay(failed, 'source', 'session-1'), [], 'same session is not replayed');
  assert.deepEqual(forkRequestsToReplay(failed, 'source', 'session-2').map((request) => request.messageId), ['message-a']);
  assert.deepEqual([...pendingForkMessageIds(failed, 'source')], ['message-a']);
});

test('errors and results resolve only their exact command', () => {
  const { requests, request } = sent({});
  assert.equal(applyForkRequestError(requests, { correlationId: 'another-request' }, 1, new Set()), undefined);
  assert.equal(applyForkRequestError(requests, {}, 1, new Set()), undefined);
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
