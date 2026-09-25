import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NATIVE_STEERING_TRANSITIONS,
  nativeSteeringStateFollows,
  type NativeSteeringReceipt,
  type OpenAIResponsesSteeringState
} from '../../shared/openAIResponsesNative';
import { mergeSteeringReceipts, steeringReceiptsByConversationState } from '../src/composables/steeringReceipts';

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
