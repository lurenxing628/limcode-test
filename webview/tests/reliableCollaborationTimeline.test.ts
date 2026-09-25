import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collaborationCardKindLabel,
  collaborationCardLabel,
  collaborationCardPlacementLabel,
  collaborationCardStatusLabel,
  projectCollaborationTimeline
} from '../src/domain/reliableCollaborationTimeline.ts';
import { collaborationPeerLabel, rememberRemovedConversations, resolveCollaborationPeer } from '../src/domain/collaborationPeer.ts';
import { composeTimelineRows, latestTimelineSegmentStart, TIMELINE_MOUNT_LIMIT } from '../src/components/conversation/segmentedTimeline.ts';

const byId = <T extends { id: string }>(...rows: T[]) => Object.fromEntries(rows.map((row) => [row.id, row]));
const message = (id: string, seq: string, mode = 'message', preview = id, createdAt?: string) =>
  ({ id, message_seq: seq, mode, text_preview: preview, ...(createdAt ? { created_at: createdAt } : {}) });
const source = (id: string, conversationId: string, turnId: string | null, sourceKind = 'tool') =>
  ({ id: `${id}-source`, message_id: id, conversation_id: conversationId, source_kind: sourceKind, turn_id: turnId });
const target = (id: string, conversationId: string) =>
  ({ id: `${id}-target`, message_id: id, conversation_id: conversationId, inbox_item_id: `${id}-inbox` });
const delivery = (id: string, targetConversationId: string, turnId: string | null, state: string, attempt = '1') =>
  ({ id: `${id}-delivery-${attempt}`, inbox_item_id: `${id}-inbox`, target_conversation_id: targetConversationId,
    target_turn_id: turnId, state, attempt_seq: attempt });

function project(records: Parameters<typeof projectCollaborationTimeline>[0]['records'], messages: Array<{ id: string }> = [],
  turnIdByMessageId: Record<string, string> = {}, removedConversationIds: string[] = []) {
  return projectCollaborationTimeline({ conversationId: 'self', records, messages, turnIdByMessageId, removedConversationIds });
}

test('a 35-message Turn keeps an independent collaboration row in the newest bounded segment', () => {
  const messages = Array.from({ length: 35 }, (_, index) => ({ id: `m${index + 1}` }));
  const turnLinks = Object.fromEntries(messages.map(({ id }) => [id, 'turn-35']));
  const timeline = project({
    CollaborationMessage: byId(message('card', '1', 'followup', '请继续处理')),
    CollaborationMessageSourceLink: byId(source('card', 'peer', 'peer-turn')),
    CollaborationMessageTargetLink: byId(target('card', 'self')),
    RuntimeDelivery: byId(delivery('card', 'self', 'turn-35', 'consumed'))
  }, messages, turnLinks);
  assert.deepEqual(Object.keys(timeline.afterMessage), ['m35']);
  const rows = composeTimelineRows(messages, timeline);
  assert.equal(rows.length, 36);
  assert.deepEqual(rows.slice(latestTimelineSegmentStart(rows.length)).map((row) => row.id), [
    ...messages.slice(6).map((row) => row.id), 'collaboration:card'
  ]);
  assert.equal(rows.at(-1)?.kind, 'collaboration');
  assert.equal(rows.filter((row) => row.kind === 'message').length, 35, 'collaboration has no Message floor');
  assert.equal(collaborationCardPlacementLabel(timeline.afterMessage.m35[0]), '按回合归组，具体顺序待确认');
  assert.equal(TIMELINE_MOUNT_LIMIT, 30);
});

test('sent and received cards keep their own sources, directions and newest delivery attempt', () => {
  const timeline = project({
    Conversation: byId({ id: 'peer', title: '调研对话', status: 'active' }),
    CollaborationMessage: byId(message('incoming', '1', 'followup', '启动任务'), message('outgoing', '2', 'message', '任务结束')),
    CollaborationMessageSourceLink: byId(source('incoming', 'peer', 'peer-turn'), source('outgoing', 'self', 'self-turn', 'completion')),
    CollaborationMessageTargetLink: byId(target('incoming', 'self'), target('outgoing', 'peer')),
    RuntimeDelivery: byId(delivery('incoming', 'self', null, 'failed'), delivery('incoming', 'self', 'self-turn', 'consumed', '2'),
      delivery('outgoing', 'peer', null, 'pending'))
  }, [{ id: 'm1' }], { m1: 'self-turn' });
  assert.deepEqual(timeline.afterMessage.m1.map((card) => card.messageId), ['incoming', 'outgoing']);
  const [incoming, outgoing] = timeline.afterMessage.m1;
  assert.equal(collaborationCardLabel(incoming), '来自对话 调研对话');
  assert.equal(collaborationCardKindLabel(incoming), '续派任务');
  assert.equal(incoming.status, 'settled');
  assert.equal(collaborationCardLabel(outgoing), '发往对话 调研对话');
  assert.equal(collaborationCardKindLabel(outgoing), '任务结果');
  assert.equal(collaborationCardStatusLabel(outgoing), '已送达，对方下一轮读取');
});

test('pending incoming delivery bound to a Turn does not impersonate a consumed delivery', () => {
  const timeline = project({
    CollaborationMessage: byId(message('pending', '1')),
    CollaborationMessageSourceLink: byId(source('pending', 'peer', 'peer-turn')),
    CollaborationMessageTargetLink: byId(target('pending', 'self')),
    RuntimeDelivery: byId(delivery('pending', 'self', 'self-turn', 'pending'))
  }, [{ id: 'm1' }], { m1: 'self-turn' });
  const card = timeline.afterMessage.m1[0];
  assert.equal(card.status, 'waiting');
  assert.equal(collaborationCardStatusLabel(card), '已送达，等待本轮处理');
});

test('no Message, loaded Turn without a Message, and transient reply all retain the card', () => {
  const records = {
    Turn: byId({ id: 'task-turn', conversation_id: 'self' }),
    CollaborationMessage: byId(message('task', '1')),
    CollaborationMessageSourceLink: byId(source('task', 'peer', null)),
    CollaborationMessageTargetLink: byId(target('task', 'self')),
    RuntimeDelivery: byId(delivery('task', 'self', 'task-turn', 'consumed'))
  };
  const empty = project(records);
  assert.deepEqual(composeTimelineRows([], empty).map((row) => row.id), ['collaboration:task']);
  assert.equal(empty.unlocated[0].placement, 'turn-without-message');
  assert.equal(collaborationCardPlacementLabel(empty.unlocated[0]), '所属回合暂无消息，位置待确认');
  const running = project(records, [{ id: 'transient:request' }], { 'transient:request': 'task-turn' });
  assert.deepEqual(composeTimelineRows([{ id: 'transient:request' }], running).map((row) => row.id),
    ['transient:request', 'collaboration:task']);
  assert.equal(running.afterMessage['transient:request'][0].messageId, 'task');
});

test('unbound, failed, no-delivery and unloaded Turn cards all remain independently pageable', () => {
  const ids = ['waiting', 'failed-1', 'failed-2', 'failed-3', 'failed-4', 'no-delivery', 'unloaded'];
  const timeline = project({
    CollaborationMessage: byId(...ids.map((id, index) => message(id, String(index + 1)))),
    CollaborationMessageSourceLink: byId(...ids.map((id) => source(id, 'peer', 'peer-turn'))),
    CollaborationMessageTargetLink: byId(...ids.map((id) => target(id, 'self'))),
    RuntimeDelivery: byId(delivery('waiting', 'self', null, 'pending'),
      ...ids.slice(1, 5).map((id) => delivery(id, 'self', null, 'failed')),
      delivery('unloaded', 'self', 'older-turn', 'consumed'))
  }, [{ id: 'm1' }], { m1: 'another-turn' });
  assert.deepEqual(timeline.unlocated.map((card) => card.messageId), ids);
  assert.equal(timeline.unlocated[0].status, 'waiting');
  assert.deepEqual(timeline.unlocated.slice(1, 5).map((card) => collaborationCardStatusLabel(card)),
    Array(4).fill('投递失败'));
  assert.equal(timeline.unlocated[5].status, 'unknown', 'absence of a delivery never means delivered');
  assert.equal(timeline.unlocated[6].placement, 'turn-not-loaded');
  assert.match(collaborationCardPlacementLabel(timeline.unlocated[1]), /位置待确认/);
  assert.equal(composeTimelineRows([{ id: 'm1' }], timeline).length, ids.length + 1);
});

test('created_at cannot place a failed delivery or a Turn without a Message among visible Messages', () => {
  const timeline = project({
    Turn: byId({ id: 'silent-turn', conversation_id: 'self', created_at: '2024-01-01T00:00:00Z' }),
    CollaborationMessage: byId(message('failed', '1', 'message', '失败', '2024-01-01T00:00:00Z'),
      message('silent', '2', 'message', '安静的任务', '2099-01-01T00:00:00Z')),
    CollaborationMessageSourceLink: byId(source('failed', 'peer', null), source('silent', 'self', 'silent-turn')),
    CollaborationMessageTargetLink: byId(target('failed', 'self'), target('silent', 'peer')),
    RuntimeDelivery: byId(delivery('failed', 'self', null, 'failed'), delivery('silent', 'peer', null, 'pending'))
  }, [{ id: 'm1' }, { id: 'm2' }], { m1: 'other-turn', m2: 'other-turn' });
  assert.deepEqual(timeline.unlocated.map((card) => card.messageId), ['failed', 'silent']);
  assert.deepEqual(timeline.afterMessage, {});
  assert.deepEqual(timeline.unlocated.map(collaborationCardPlacementLabel), [
    '投递未进入回合，位置待确认', '所属回合暂无消息，位置待确认'
  ]);
});

test('peer deletion needs a committed removal or deleted status, not a missing navigation row', () => {
  const records = {
    Conversation: byId({ id: 'live', title: '实时标题', status: 'active' },
      { id: 'status-deleted', title: '旧对话', status: 'deleted' }),
    CollaborationPeerConversation: byId({ id: 'far', title: '新对话', status: 'active', display_title: '调研登录流程' })
  };
  const label = (id: string) => collaborationPeerLabel(resolveCollaborationPeer(records, id, ['removed']));
  assert.equal(label('live'), '对话 实时标题');
  assert.equal(label('far'), '对话 调研登录流程');
  assert.equal(label('status-deleted'), '已删除的对话');
  assert.equal(label('removed'), '已删除的对话');
  assert.equal(label('conversation-3f9a2c7d'), '对话 3f9a2c…');
  assert.deepEqual(rememberRemovedConversations(['a', 'b'], [
    { type: 'Conversation', operation: 'remove', id: 'a' },
    { type: 'Message', operation: 'remove', id: 'other' }
  ]), ['b', 'a']);
  const timeline = project({
    ...records,
    CollaborationMessage: byId(message('deleted', '1')),
    CollaborationMessageSourceLink: byId(source('deleted', 'removed', 'other-turn')),
    CollaborationMessageTargetLink: byId(target('deleted', 'self')),
    RuntimeDelivery: byId(delivery('deleted', 'self', null, 'failed'))
  }, [], {}, ['removed']);
  assert.equal(collaborationCardLabel(timeline.unlocated[0]), '来自已删除的对话');
});

test('messages between other Conversations are not projected into this Conversation', () => {
  assert.deepEqual(project({
    CollaborationMessage: byId(message('foreign', '1')),
    CollaborationMessageSourceLink: byId(source('foreign', 'peer', 'peer-turn')),
    CollaborationMessageTargetLink: byId(target('foreign', 'other')),
    RuntimeDelivery: byId(delivery('foreign', 'other', null, 'pending'))
  }, [{ id: 'm1' }], { m1: 'peer-turn' }), { afterMessage: {}, unlocated: [] });
});

test('a child answer delivered to this Conversation is the same card, labelled as that child Agent final result', () => {
  const answerRecords = (interrupted: number, state: string, turnId: string | null) => ({
    Conversation: byId({ id: 'child-conversation', title: '调研子任务', status: 'active' }),
    Turn: byId({ id: 'self-turn', conversation_id: 'self' }, { id: 'spawn-turn', conversation_id: 'self' }),
    ChildExecution: byId({ id: 'child-execution', child_conversation_id: 'child-conversation', status: 'idle' }),
    ChildExecutionParentLink: byId({ id: 'parent-link', child_execution_id: 'child-execution', parent_turn_id: 'spawn-turn' }),
    AnswerBridge: byId({ id: 'bridge', child_execution_id: 'child-execution' }),
    AnswerSubmission: byId({ id: 'submission', answer_bridge_id: 'bridge', interrupted }),
    RuntimeInboxItem: byId({ id: 'answer-inbox', source_kind: 'answer_submission', source_id: 'submission' }),
    RuntimeDelivery: byId({ id: 'answer-delivery', inbox_item_id: 'answer-inbox', target_conversation_id: 'self',
      target_turn_id: turnId, state, attempt_seq: '1' })
  });
  const timeline = project(answerRecords(0, 'consumed', 'self-turn'), [{ id: 'm1' }], { m1: 'self-turn' });
  const [card] = timeline.afterMessage.m1;
  assert.equal(card.messageId, 'answer:submission');
  assert.equal(collaborationCardLabel(card), '来自子 Agent 调研子任务');
  assert.equal(collaborationCardKindLabel(card), '最终结果');
  assert.equal(collaborationCardStatusLabel(card), '');

  const interrupted = project(answerRecords(1, 'pending', null)).unlocated[0];
  assert.equal(collaborationCardKindLabel(interrupted), '部分结果（已中断）');
  assert.equal(collaborationCardStatusLabel(interrupted), '等待下一轮处理');

  const foreground = answerRecords(0, 'consumed', 'self-turn');
  delete (foreground as Record<string, unknown>).RuntimeDelivery;
  const settledByWait = project(foreground, [{ id: 'm1' }], { m1: 'self-turn' });
  assert.deepEqual(settledByWait.afterMessage, {}, 'an answer that settled a waiting run_agent call stays with that tool call');
  assert.deepEqual(settledByWait.unlocated, []);
});

test('a collaboration message from a spawned child is labelled as that child Agent, others stay conversations', () => {
  const timeline = project({
    Conversation: byId({ id: 'child-conversation', title: '实现子任务', status: 'active' }, { id: 'peer', title: '调研对话', status: 'active' }),
    Turn: byId({ id: 'self-turn', conversation_id: 'self' }),
    ChildExecution: byId({ id: 'child-execution', child_conversation_id: 'child-conversation', status: 'active' }),
    ChildExecutionParentLink: byId({ id: 'parent-link', child_execution_id: 'child-execution', parent_turn_id: 'self-turn' }),
    CollaborationMessage: byId(message('from-child', '1', 'message', '进展'), message('from-peer', '2', 'message', '你好')),
    CollaborationMessageSourceLink: byId(source('from-child', 'child-conversation', 'child-turn'), source('from-peer', 'peer', 'peer-turn')),
    CollaborationMessageTargetLink: byId(target('from-child', 'self'), target('from-peer', 'self')),
    RuntimeDelivery: byId(delivery('from-child', 'self', 'self-turn', 'consumed'), delivery('from-peer', 'self', 'self-turn', 'consumed'))
  }, [{ id: 'm1' }], { m1: 'self-turn' });
  assert.deepEqual(timeline.afterMessage.m1.map((card) => [collaborationCardLabel(card), collaborationCardKindLabel(card)]), [
    ['来自子 Agent 实现子任务', '消息'],
    ['来自对话 调研对话', '消息']
  ]);
});
