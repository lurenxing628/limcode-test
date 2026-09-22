import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collaborationCardKindLabel,
  collaborationCardLabel,
  projectCollaborationTimeline
} from '../src/domain/reliableCollaborationTimeline.ts';

const message = (id: string, seq: string, mode: string, preview: string) => ({ id, message_seq: seq, mode, text_preview: preview });
const source = (messageId: string, conversationId: string, turnId: string, sourceKind = 'tool') =>
  ({ id: `${messageId}-source`, message_id: messageId, conversation_id: conversationId, source_kind: sourceKind, turn_id: turnId });
const target = (messageId: string, conversationId: string) =>
  ({ id: `${messageId}-target`, message_id: messageId, conversation_id: conversationId, inbox_item_id: `${messageId}-inbox` });
const delivery = (messageId: string, turnId: string | null, state: string, attempt = '1') =>
  ({ id: `${messageId}-delivery-${attempt}`, inbox_item_id: `${messageId}-inbox`, target_conversation_id: 'self', target_turn_id: turnId, state, attempt_seq: attempt });
const byId = <T extends { id: string }>(...rows: T[]) => Object.fromEntries(rows.map(row => [row.id, row]));

test('collaboration cards anchor to the first message of their delivery or sending Turn', () => {
  const records = {
    Conversation: byId({ id: 'peer', title: '调研对话', status: 'active' }),
    CollaborationMessage: byId(
      message('started', '1', 'followup', '请继续调研'),
      message('joined', '2', 'message', '补充一条信息'),
      message('queued', '3', 'followup', '等你这轮结束'),
      message('answered', '4', 'message', '调研结果'),
      message('orphan', '5', 'message', '来自已删除对话'),
      message('retried', '6', 'message', '第二次投递')
    ),
    CollaborationMessageSourceLink: byId(
      source('started', 'peer', 'peer-turn'), source('joined', 'peer', 'peer-turn'), source('queued', 'peer', 'peer-turn'),
      source('answered', 'self', 'started-turn', 'completion'), source('orphan', 'gone', 'gone-turn'), source('retried', 'peer', 'peer-turn')
    ),
    CollaborationMessageTargetLink: byId(
      target('started', 'self'), target('joined', 'self'), target('queued', 'self'),
      target('answered', 'peer'), target('orphan', 'self'), target('retried', 'self')
    ),
    RuntimeDelivery: byId(
      delivery('started', 'started-turn', 'consumed'), delivery('joined', 'user-turn', 'consumed'),
      delivery('queued', null, 'pending'), delivery('orphan', 'user-turn', 'consumed'),
      delivery('retried', null, 'failed', '1'), delivery('retried', 'unloaded-turn', 'consumed', '2')
    )
  };
  const timeline = projectCollaborationTimeline({
    conversationId: 'self',
    records,
    messages: [{ id: 'user-message', role: 'user' }, { id: 'user-reply', role: 'model' }, { id: 'continuation-reply', role: 'model' }],
    turnIdByMessageId: { 'user-message': 'user-turn', 'user-reply': 'user-turn', 'continuation-reply': 'started-turn' }
  });
  const labels = (cards: ReturnType<typeof projectCollaborationTimeline>['unbound'] = []) => cards.map(card =>
    `${collaborationCardLabel(card)} · ${collaborationCardKindLabel(card)} · ${card.textPreview}`);
  assert.deepEqual(labels(timeline.beforeMessage['continuation-reply']), ['来自对话 调研对话 · 续派任务 · 请继续调研'],
    'a delivery that started a Turn precedes its reply');
  assert.deepEqual(labels(timeline.afterMessage['user-message']), [
    '来自对话 调研对话 · 消息 · 补充一条信息',
    '来自已删除的对话 · 消息 · 来自已删除对话'
  ], 'mid-Turn deliveries follow the opening user message in sequence order');
  assert.deepEqual(labels(timeline.afterMessage['continuation-reply']), ['发往对话 调研对话 · 任务结果 · 调研结果']);
  assert.deepEqual(labels(timeline.unbound), ['来自对话 调研对话 · 续派任务 · 等你这轮结束']);
  assert.equal(timeline.unbound[0].waiting, true);
  assert.equal(Object.values(timeline.afterMessage).flat().some(card => card.messageId === 'retried'), false,
    'the newest attempt decides placement and a Turn outside the loaded window is not guessed');
});

test('messages between other Conversations are never projected into this timeline', () => {
  const timeline = projectCollaborationTimeline({
    conversationId: 'self',
    records: {
      CollaborationMessage: byId(message('foreign', '1', 'message', 'not ours')),
      CollaborationMessageSourceLink: byId(source('foreign', 'peer', 'peer-turn')),
      CollaborationMessageTargetLink: byId(target('foreign', 'other')),
      RuntimeDelivery: {}
    },
    messages: [{ id: 'user-message', role: 'user' }],
    turnIdByMessageId: { 'user-message': 'peer-turn' }
  });
  assert.deepEqual(timeline, { beforeMessage: {}, afterMessage: {}, unbound: [] });
});
