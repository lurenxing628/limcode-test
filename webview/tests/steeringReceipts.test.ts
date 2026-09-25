import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NATIVE_STEERING_TRANSITIONS,
  nativeSteeringStateFollows,
  type NativeSteeringReceipt,
  type OpenAIResponsesSteeringState
} from '../../shared/openAIResponsesNative';
import {
  STEERING_SUCCESS_NOTICE_MS,
  mergeSteeringReceipts,
  nextSteeringSuccessExpiry,
  persistSteeringDismissal,
  readSteeringDismissals,
  steeringReceiptPresentation,
  steeringReceiptsByConversationState,
  visibleSteeringReceipts,
  type SteeringDismissalState
} from '../src/composables/steeringReceipts';

const receipt = (conversationId: string, state: OpenAIResponsesSteeringState, updatedAt: number): NativeSteeringReceipt =>
  ({ submissionId: 'steer', conversationId, turnId: 'turn', state, updatedAt });
const stored = (conversationId: string) => steeringReceiptsByConversationState().value[conversationId]?.steer?.state;

test('every durable Host transition updates the view, including continuing → delivery_unknown', () => {
  let index = 0;
  for (const [from, targets] of Object.entries(NATIVE_STEERING_TRANSITIONS) as Array<[OpenAIResponsesSteeringState, readonly OpenAIResponsesSteeringState[]]>) {
    for (const to of targets) {
      const conversationId = `transition-${index += 1}`;
      mergeSteeringReceipts(conversationId, [receipt(conversationId, from, 1)]);
      mergeSteeringReceipts(conversationId, [receipt(conversationId, to, 2)]);
      assert.equal(stored(conversationId), to, `${from} → ${to} is a committed Host step the view must show`);
    }
  }
  const conversationId = 'continuing-unknown';
  mergeSteeringReceipts(conversationId, [receipt(conversationId, 'continuing', 1)]);
  mergeSteeringReceipts(conversationId, [receipt(conversationId, 'delivery_unknown', 2)]);
  assert.equal(stored(conversationId), 'delivery_unknown');
});

test('missed intermediate states are skipped forward, and no update moves a receipt backwards', () => {
  const states = Object.keys(NATIVE_STEERING_TRANSITIONS) as OpenAIResponsesSteeringState[];
  let index = 0;
  for (const from of states) {
    for (const to of states) {
      if (from === to) continue;
      const conversationId = `pair-${index += 1}`;
      mergeSteeringReceipts(conversationId, [receipt(conversationId, from, 1)]);
      mergeSteeringReceipts(conversationId, [receipt(conversationId, to, 2)]);
      assert.equal(stored(conversationId), nativeSteeringStateFollows(from, to) ? to : from, `${from} → ${to}`);
    }
  }
  assert.equal(nativeSteeringStateFollows('queued', 'completed'), true, 'a status read may skip the steps in between');
  assert.equal(nativeSteeringStateFollows('completed', 'continuing'), false);
  assert.equal(nativeSteeringStateFollows('failed', 'delivery_unknown'), false);
});

test('only proven success and explicit failure appear in the composer; success closes after 4s', () => {
  const applied: NativeSteeringReceipt = {
    ...receipt('success-conversation', 'continuing', 20_000),
    modelRequestId: 'request', messageId: 'message',
    targetResponseId: 'before', successorResponseId: 'after', responseId: 'after'
  };
  for (const state of ['queued', 'sent', 'accepted', 'waiting_for_input'] as const) {
    const pending = { ...applied, state };
    assert.equal(steeringReceiptPresentation(pending).provenApplied, false);
    assert.match(steeringReceiptPresentation(pending).detail, /待确认/);
    assert.deepEqual(visibleSteeringReceipts([pending], 100_000), [], '中间回执不占输入区');
    assert.equal(nextSteeringSuccessExpiry([pending], 20_000), undefined);
  }
  mergeSteeringReceipts(applied.conversationId, [applied]);
  for (const successful of [applied, { ...applied, state: 'completed' as const, updatedAt: 30_000 }]) {
    const expiry = successful.updatedAt + STEERING_SUCCESS_NOTICE_MS;
    assert.equal(steeringReceiptPresentation(successful).label, '已生效');
    assert.deepEqual(visibleSteeringReceipts([successful], expiry - 1), [successful]);
    assert.equal(nextSteeringSuccessExpiry([successful], successful.updatedAt), expiry);
    assert.deepEqual(visibleSteeringReceipts([successful], expiry), []);
    assert.equal(nextSteeringSuccessExpiry([successful], expiry), undefined);
  }
  assert.equal(stored(applied.conversationId), 'continuing', '隐藏输入区提示不会删除持久回执');

  for (const state of ['continuing', 'completed'] as const) {
    const missingProof = { ...applied, state, successorResponseId: undefined };
    assert.deepEqual(visibleSteeringReceipts([missingProof], 100_000), [], '未证实生效不能显示为成功');
    assert.equal(nextSteeringSuccessExpiry([missingProof], 20_000), undefined);
    assert.match(steeringReceiptPresentation(missingProof).detail, /待确认/);
  }
  const conflicting = { ...applied, submissionId: 'other-steer' };
  assert.deepEqual(visibleSteeringReceipts([applied, conflicting], applied.updatedAt), [], '冲突回执不占输入区');
  assert.equal(nextSteeringSuccessExpiry([applied, conflicting], 20_000), undefined);
  const laterUnknown = { ...applied, state: 'delivery_unknown' as const, updatedAt: 40_000 };
  assert.deepEqual(visibleSteeringReceipts([laterUnknown], 100_000), [], '投递未知不生成无操作价值的提示');
  mergeSteeringReceipts(applied.conversationId, [laterUnknown]);
  assert.equal(stored(applied.conversationId), 'delivery_unknown', '隐藏提示也不丢失运行事实');
});

/** A stand-in for this view's persisted VS Code webview state, which survives a reload. */
function viewState(initial?: unknown): SteeringDismissalState & { value: unknown } {
  const state = {
    value: initial,
    read: () => state.value,
    write: (value: unknown) => { state.value = JSON.parse(JSON.stringify(value)); }
  };
  return state;
}

test('a closed failed steer stays closed after reload; intermediate and unknown states stay silent', () => {
  const state = viewState();
  const failed = { ...receipt('conversation-a', 'failed', 5), submissionId: 'failed-steer', message: '提供方拒绝' };
  const unknown = { ...receipt('conversation-a', 'delivery_unknown', 6), submissionId: 'unknown-steer' };
  const accepted = { ...receipt('conversation-a', 'accepted', 7), submissionId: 'live-steer' };
  for (const closed of [failed, unknown, accepted]) persistSteeringDismissal(state, closed);

  // Reload: the panel starts from nothing but this view's persisted state and the durable receipts.
  const restored = readSteeringDismissals(state, 'conversation-a');
  assert.deepEqual(visibleSteeringReceipts([failed, unknown, accepted], 10, restored), [],
    '关闭失败后，中间态和投递未知也不会撑开输入区');
  assert.deepEqual(Object.keys(restored), ['conversation-a\u0000failed-steer'], '仅保存真正显示过的失败提示');
  assert.deepEqual(readSteeringDismissals(state, 'conversation-b'), {}, 'dismissals are per Conversation');
});

test('persisted steering dismissals are bounded and tolerate malformed or failing view state', () => {
  const state = viewState();
  for (let index = 0; index < 80; index += 1) {
    persistSteeringDismissal(state, { ...receipt('conversation-a', 'failed', index), submissionId: `steer-${index}` });
  }
  const kept = Object.keys(readSteeringDismissals(state, 'conversation-a'));
  assert.equal(kept.length, 64);
  assert.ok(kept.some((key) => key.endsWith('steer-79')) && !kept.some((key) => key.endsWith('steer-0')), 'the newest dismissals are kept');
  for (let index = 0; index < 40; index += 1) {
    persistSteeringDismissal(state, { ...receipt(`conversation-${index}`, 'failed', 1), submissionId: 'steer' });
  }
  assert.equal(Object.keys(state.value as Record<string, unknown>).length, 32);

  assert.deepEqual(readSteeringDismissals(viewState('not an object'), 'conversation-a'), {});
  assert.deepEqual(readSteeringDismissals(viewState({ 'conversation-a': { steer: 7 } }), 'conversation-a'), {});
  const failing: SteeringDismissalState = { read: () => { throw new Error('no state'); }, write: () => { throw new Error('no state'); } };
  assert.doesNotThrow(() => persistSteeringDismissal(failing, receipt('conversation-a', 'failed', 1)));
  assert.deepEqual(readSteeringDismissals(failing, 'conversation-a'), {});
});
