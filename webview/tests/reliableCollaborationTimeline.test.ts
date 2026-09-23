import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collaborationCardKindLabel,
  collaborationCardLabel,
  collaborationCardStatusLabel,
  projectCollaborationTimeline
} from '../src/domain/reliableCollaborationTimeline.ts';
import { collaborationPeerLabel, rememberRemovedConversations, resolveCollaborationPeer } from '../src/domain/collaborationPeer.ts';

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
    turnIdByMessageId: { 'user-message': 'user-turn', 'user-reply': 'user-turn', 'continuation-reply': 'started-turn' },
    removedConversationIds: []
  });
  const labels = (cards: ReturnType<typeof projectCollaborationTimeline>['unbound'] = []) => cards.map(card =>
    `${collaborationCardLabel(card)} · ${collaborationCardKindLabel(card)} · ${card.textPreview}`);
  assert.deepEqual(labels(timeline.beforeMessage['continuation-reply']), ['来自对话 调研对话 · 续派任务 · 请继续调研'],
    'a delivery that started a Turn precedes its reply');
  assert.deepEqual(labels(timeline.afterMessage['user-message']), [
    '来自对话 调研对话 · 消息 · 补充一条信息',
    '来自对话 gone… · 消息 · 来自已删除对话'
  ], 'mid-Turn deliveries follow the opening user message in sequence order');
  assert.deepEqual(labels(timeline.afterMessage['continuation-reply']), ['发往对话 调研对话 · 任务结果 · 调研结果']);
  assert.deepEqual(labels(timeline.unbound), ['来自对话 调研对话 · 续派任务 · 等你这轮结束']);
  assert.equal(timeline.unbound[0].status, 'waiting');
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
    turnIdByMessageId: { 'user-message': 'peer-turn' },
    removedConversationIds: []
  });
  assert.deepEqual(timeline, { beforeMessage: {}, afterMessage: {}, unbound: [] });
});

test('a peer outside the loaded conversations is unknown; only a removal or a deleted status reads as deleted', () => {
  const records = {
    Conversation: byId(
      { id: 'live', title: '实时标题', status: 'active' },
      { id: 'live-placeholder', title: '新对话-20260101-010101-001', status: 'active' },
      { id: 'status-deleted', title: '旧对话', status: 'deleted' }
    ),
    CollaborationPeerConversation: byId(
      { id: 'live-placeholder', title: '新对话', status: 'active', display_title: '首条用户消息' },
      { id: 'far', title: '新对话', status: 'active', display_title: '调研登录流程' },
      { id: 'removed-live', title: '会被删除', status: 'active', display_title: '会被删除' },
      { id: 'removed-at-snapshot', title: null, status: 'deleted', display_title: null }
    )
  };
  const label = (id: string) => collaborationPeerLabel(resolveCollaborationPeer(records, id, ['removed-live']));
  assert.equal(label('live'), '对话 实时标题');
  assert.equal(label('live-placeholder'), '对话 首条用户消息', 'a placeholder title shows what the sidebar shows');
  assert.equal(label('far'), '对话 调研登录流程', 'a peer outside the navigation list keeps its title');
  assert.equal(label('status-deleted'), '已删除的对话');
  assert.equal(label('removed-live'), '已删除的对话', 'a live Conversation removal marks the peer deleted');
  assert.equal(label('removed-at-snapshot'), '已删除的对话');
  assert.equal(label('conversation-3f9a2c7d'), '对话 3f9a2c…', 'a peer this view has no facts about is unknown, not deleted');

  const timeline = projectCollaborationTimeline({
    conversationId: 'self',
    records: {
      ...records,
      CollaborationMessage: byId(message('far-message', '1', 'message', '你好')),
      CollaborationMessageSourceLink: byId(source('far-message', 'far', 'far-turn')),
      CollaborationMessageTargetLink: byId(target('far-message', 'self')),
      RuntimeDelivery: byId(delivery('far-message', 'self-turn', 'consumed'))
    },
    messages: [{ id: 'self-message', role: 'user' }],
    turnIdByMessageId: { 'self-message': 'self-turn' },
    removedConversationIds: []
  });
  assert.deepEqual(timeline.afterMessage['self-message'].map(collaborationCardLabel), ['来自对话 调研登录流程']);
});

test('only committed Conversation removals are remembered as deleted, newest last and bounded', () => {
  const remembered = rememberRemovedConversations(['a', 'b'], [
    { type: 'Conversation', operation: 'remove', id: 'c' },
    { type: 'Conversation', operation: 'upsert', id: 'd', record: { id: 'd' } },
    { type: 'Message', operation: 'remove', id: 'e' },
    { type: 'Conversation', operation: 'remove', id: 'a' }
  ], 3);
  assert.deepEqual(remembered, ['b', 'c', 'a']);
  assert.deepEqual(rememberRemovedConversations(['x'], undefined), ['x']);
});

test('failed deliveries are shown: an incoming one waits in the unbound list, an outgoing card is marked failed', () => {
  const outgoingDelivery = (messageId: string, peer: string, state: string, attempt = '1') =>
    ({ id: `${messageId}-delivery-${attempt}`, inbox_item_id: `${messageId}-inbox`, target_conversation_id: peer, target_turn_id: null, state, attempt_seq: attempt });
  const timeline = projectCollaborationTimeline({
    conversationId: 'self',
    records: {
      Conversation: byId({ id: 'peer', title: '调研对话', status: 'active' }),
      CollaborationMessage: byId(
        message('incoming-failed', '1', 'followup', '没送到'),
        message('outgoing-failed', '2', 'message', '发出但失败'),
        message('outgoing-retried', '3', 'message', '重试后送达'),
        message('outgoing-pending', '4', 'followup', '排队中')
      ),
      CollaborationMessageSourceLink: byId(
        source('incoming-failed', 'peer', 'peer-turn'),
        source('outgoing-failed', 'self', 'self-turn'),
        source('outgoing-retried', 'self', 'self-turn'),
        source('outgoing-pending', 'self', 'self-turn')
      ),
      CollaborationMessageTargetLink: byId(
        target('incoming-failed', 'self'),
        target('outgoing-failed', 'peer'),
        target('outgoing-retried', 'peer'),
        target('outgoing-pending', 'peer')
      ),
      RuntimeDelivery: byId(
        delivery('incoming-failed', null, 'failed'),
        outgoingDelivery('outgoing-failed', 'peer', 'failed'),
        outgoingDelivery('outgoing-retried', 'peer', 'failed', '1'),
        { ...outgoingDelivery('outgoing-retried', 'peer', 'consumed', '2'), target_turn_id: 'peer-turn' },
        outgoingDelivery('outgoing-pending', 'peer', 'pending')
      )
    },
    messages: [{ id: 'self-message', role: 'user' }],
    turnIdByMessageId: { 'self-message': 'self-turn' },
    removedConversationIds: []
  });
  assert.deepEqual(timeline.unbound.map((card) => [card.messageId, card.status]), [['incoming-failed', 'failed']]);
  assert.deepEqual(timeline.afterMessage['self-message'].map((card) => [card.messageId, card.status]), [
    ['outgoing-failed', 'failed'],
    ['outgoing-retried', 'settled'],
    ['outgoing-pending', 'waiting']
  ], 'the newest delivery attempt decides the outgoing state');
  assert.equal(collaborationCardStatusLabel(timeline.unbound[0]), '投递失败');
  assert.equal(collaborationCardStatusLabel(timeline.afterMessage['self-message'][2]), '等待对方处理');
});

test('a failed incoming card sits where it was sent; only the newest few newer than every message stay pinned', () => {
  const at = (ms: number) => new Date(ms).toISOString();
  const timed = (id: string, seq: string, ms: number) => ({ ...message(id, seq, 'followup', id), created_at: at(ms) });
  const ids = ['early', 'mid-turn', 'between', 'n1', 'n2', 'n3', 'n4'];
  const times = [500, 1500, 3000, 6000, 7000, 8000, 9000];
  const timeline = projectCollaborationTimeline({
    conversationId: 'self',
    records: {
      Conversation: byId({ id: 'peer', title: '调研对话', status: 'active' }),
      CollaborationMessage: byId(...ids.map((id, index) => timed(id, String(index + 1), times[index]))),
      CollaborationMessageSourceLink: byId(...ids.map(id => source(id, 'peer', 'peer-turn'))),
      CollaborationMessageTargetLink: byId(...ids.map(id => target(id, 'self'))),
      RuntimeDelivery: byId(...ids.map(id => delivery(id, null, 'failed')))
    },
    messages: [
      { id: 'first-user', role: 'user', createdAt: 1000 },
      { id: 'first-reply', role: 'model', createdAt: 2000 },
      { id: 'second-user', role: 'user', createdAt: 5000 }
    ],
    turnIdByMessageId: { 'first-user': 'turn-a', 'first-reply': 'turn-a', 'second-user': 'turn-b' },
    removedConversationIds: []
  });
  const placed = (anchor: string) => (timeline.afterMessage[anchor] ?? []).map(card => card.messageId);
  assert.deepEqual(placed('first-user'), ['mid-turn']);
  assert.deepEqual(placed('first-reply'), ['between'], 'a later Turn no longer leaves the failure pinned at the bottom');
  assert.deepEqual(placed('second-user'), []);
  assert.equal(Object.values(timeline.afterMessage).flat().some(card => card.messageId === 'early'), false,
    'a failure older than the loaded window is not guessed into it');
  assert.deepEqual(timeline.unbound.map(card => card.messageId), ['n2', 'n3', 'n4'], 'newer than every message: the newest three only');
  assert.ok(timeline.unbound.every(card => collaborationCardStatusLabel(card) === '投递失败'));
});

test('an outgoing message or result waiting for the recipient says it arrived and when it is read', () => {
  const outgoing = (messageId: string, turnId: string | null) =>
    ({ id: `${messageId}-delivery-1`, inbox_item_id: `${messageId}-inbox`, target_conversation_id: 'peer', target_turn_id: turnId, state: 'pending', attempt_seq: '1' });
  const timeline = projectCollaborationTimeline({
    conversationId: 'self',
    records: {
      Conversation: byId({ id: 'peer', title: '调研对话', status: 'active' }),
      CollaborationMessage: byId(
        message('idle-message', '1', 'message', '下一轮再看'),
        message('running-message', '2', 'message', '本轮就能看到'),
        message('idle-result', '3', 'message', '任务结果'),
        message('followup', '4', 'followup', '请处理')
      ),
      CollaborationMessageSourceLink: byId(
        source('idle-message', 'self', 'self-turn'), source('running-message', 'self', 'self-turn'),
        source('idle-result', 'self', 'self-turn', 'completion'), source('followup', 'self', 'self-turn')
      ),
      CollaborationMessageTargetLink: byId(...['idle-message', 'running-message', 'idle-result', 'followup'].map(id => target(id, 'peer'))),
      RuntimeDelivery: byId(outgoing('idle-message', null), outgoing('running-message', 'peer-turn'), outgoing('idle-result', null), outgoing('followup', null))
    },
    messages: [{ id: 'self-message', role: 'user' }],
    turnIdByMessageId: { 'self-message': 'self-turn' },
    removedConversationIds: []
  });
  assert.deepEqual(timeline.afterMessage['self-message'].map(card => [card.messageId, collaborationCardStatusLabel(card)]), [
    ['idle-message', '已送达，对方下一轮读取'],
    ['running-message', '已送达，对方本轮读取'],
    ['idle-result', '已送达，对方下一轮读取'],
    ['followup', '等待对方处理']
  ]);
});
