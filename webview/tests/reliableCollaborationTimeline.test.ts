import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  MAX_PINNED_FAILED_COLLABORATION_CARDS,
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
    removedConversationIds: [],
    loadedFromFirstMessage: true
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
    removedConversationIds: [],
    loadedFromFirstMessage: true
  });
  assert.deepEqual(timeline, { beforeMessage: {}, afterMessage: {}, turnWithoutMessage: [], unbound: [] });
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
    removedConversationIds: [],
    loadedFromFirstMessage: true
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

test('failed deliveries are shown: an incoming one newer than every message is pinned below them, an outgoing card is marked failed', () => {
  const at = (ms: number) => new Date(ms).toISOString();
  const outgoingDelivery = (messageId: string, peer: string, state: string, attempt = '1') =>
    ({ id: `${messageId}-delivery-${attempt}`, inbox_item_id: `${messageId}-inbox`, target_conversation_id: peer, target_turn_id: null, state, attempt_seq: attempt });
  const timeline = projectCollaborationTimeline({
    conversationId: 'self',
    records: {
      Conversation: byId({ id: 'peer', title: '调研对话', status: 'active' }),
      CollaborationMessage: byId(
        { ...message('incoming-failed', '1', 'followup', '没送到'), created_at: at(2000) },
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
    messages: [{ id: 'self-message', role: 'user', createdAt: 1000 }],
    turnIdByMessageId: { 'self-message': 'self-turn' },
    removedConversationIds: [],
    loadedFromFirstMessage: true
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
    removedConversationIds: [],
    // Earlier history exists but is not loaded.
    loadedFromFirstMessage: false
  });
  const placed = (anchor: string) => (timeline.afterMessage[anchor] ?? []).map(card => card.messageId);
  assert.deepEqual(placed('first-user'), ['mid-turn']);
  assert.deepEqual(placed('first-reply'), ['between'], 'a later Turn no longer leaves the failure pinned at the bottom');
  assert.deepEqual(placed('second-user'), []);
  assert.equal([...Object.values(timeline.afterMessage), ...Object.values(timeline.beforeMessage)].flat().some(card => card.messageId === 'early'), false,
    'a failure older than a loaded window with earlier history is not guessed into it');
  assert.deepEqual(timeline.unbound.map(card => card.messageId), ['n2', 'n3', 'n4'], 'newer than every message: the newest three only');
  assert.ok(timeline.unbound.every(card => collaborationCardStatusLabel(card) === '投递失败'));
});

test('a failed incoming card with no loaded message before it still shows when nothing earlier exists', () => {
  const at = (ms: number) => new Date(ms).toISOString();
  const failed = (...cards: Array<[string, number | undefined]>) => ({
    Conversation: byId({ id: 'peer', title: '调研对话', status: 'active' }),
    CollaborationMessage: byId(...cards.map(([id, sentAt], index) => ({
      ...message(id, String(index + 1), 'followup', id),
      ...(sentAt === undefined ? {} : { created_at: at(sentAt) })
    }))),
    CollaborationMessageSourceLink: byId(...cards.map(([id]) => source(id, 'peer', 'peer-turn'))),
    CollaborationMessageTargetLink: byId(...cards.map(([id]) => target(id, 'self'))),
    RuntimeDelivery: byId(...cards.map(([id]) => delivery(id, null, 'failed')))
  });
  const project = (
    records: ReturnType<typeof failed>,
    messages: Array<{ id: string; role: string; createdAt?: number }>,
    loadedFromFirstMessage: boolean
  ) => {
    const timeline = projectCollaborationTimeline({
      conversationId: 'self', records, messages, turnIdByMessageId: {}, removedConversationIds: [], loadedFromFirstMessage
    });
    const ids = (buckets: Record<string, Array<{ messageId: string }>>) =>
      Object.fromEntries(Object.entries(buckets).map(([anchor, cards]) => [anchor, cards.map(card => card.messageId)]));
    return { before: ids(timeline.beforeMessage), after: ids(timeline.afterMessage), unbound: timeline.unbound.map(card => card.messageId) };
  };

  // A Conversation created for a task whose wake dead-lettered has no messages at all.
  assert.deepEqual(project(failed(['task', 1000]), [], true), { before: {}, after: {}, unbound: ['task'] });
  // The user typed into it later: the whole history is loaded and the failure precedes it.
  assert.deepEqual(project(failed(['task', 1000]), [{ id: 'u1', role: 'user', createdAt: 5000 }], true),
    { before: { u1: ['task'] }, after: {}, unbound: [] });
  // Loaded messages without creation times give nothing to compare with.
  assert.deepEqual(project(failed(['untimed', 1000]), [{ id: 'm1', role: 'user' }, { id: 'm2', role: 'model' }], false),
    { before: {}, after: {}, unbound: ['untimed'] });
  // Earlier history that is not loaded may hold the right position: the card waits for it.
  assert.deepEqual(project(failed(['early', 1000]), [{ id: 'm9', role: 'user', createdAt: 5000 }], false),
    { before: {}, after: {}, unbound: [] });
  // The pin keeps only the newest few, in an empty Conversation as well.
  assert.deepEqual(project(failed(['f1', 1], ['f2', 2], ['f3', 3], ['f4', 4]), [], true).unbound,
    ['f1', 'f2', 'f3', 'f4'].slice(-MAX_PINNED_FAILED_COLLABORATION_CARDS));
});

test('a card whose loaded Turn has no loaded message sits where that Turn started and stays visible across its first request', () => {
  const at = (ms: number) => new Date(ms).toISOString();
  type Timeline = ReturnType<typeof projectCollaborationTimeline>;
  type Card = Timeline['unbound'][number];
  // Every card the timeline shows, whichever place holds it.
  const shown = (timeline: Timeline) => Object.values(timeline)
    .flatMap((bucket: Card[] | Record<string, Card[]>) => Array.isArray(bucket) ? bucket : Object.values(bucket).flat())
    .map(card => card.messageId);
  const ids = (buckets: Record<string, Card[]>) =>
    Object.fromEntries(Object.entries(buckets).map(([anchor, cards]) => [anchor, cards.map(card => card.messageId)]));
  const placed = (timeline: Timeline) => ({
    before: ids(timeline.beforeMessage),
    after: ids(timeline.afterMessage),
    turnWithoutMessage: timeline.turnWithoutMessage.map(card => card.messageId),
    unbound: timeline.unbound.map(card => card.messageId)
  });
  // A task from the peer started `task-turn` at 3000; the result it sent back when that Turn ended is optional.
  const records = (task: { turnId: string | null; state: string }, options: { result?: boolean; turnLoaded?: boolean } = {}) => ({
    Conversation: byId({ id: 'peer', title: '调研对话', status: 'active' }),
    ...(options.turnLoaded === false ? {} : { Turn: byId({ id: 'task-turn', conversation_id: 'self', status: 'terminated', created_at: at(3000) }) }),
    CollaborationMessage: byId(
      { ...message('task', '1', 'followup', '请调研'), created_at: at(2000) },
      ...(options.result ? [{ ...message('result', '2', 'message', 'Task ended with status failed.'), created_at: at(4000) }] : [])
    ),
    CollaborationMessageSourceLink: byId(
      source('task', 'peer', 'peer-turn'),
      ...(options.result ? [source('result', 'self', 'task-turn', 'completion')] : [])
    ),
    CollaborationMessageTargetLink: byId(target('task', 'self'), ...(options.result ? [target('result', 'peer')] : [])),
    RuntimeDelivery: byId(
      delivery('task', task.turnId, task.state),
      ...(options.result ? [{ id: 'result-delivery-1', inbox_item_id: 'result-inbox', target_conversation_id: 'peer', target_turn_id: 'peer-turn', state: 'consumed', attempt_seq: '1' }] : [])
    )
  });
  const earlier = [{ id: 'u1', role: 'user', createdAt: 1000 }, { id: 'r1', role: 'model', createdAt: 1500 }];
  const earlierTurns = { u1: 'turn-1', r1: 'turn-1' };
  const project = (
    recordSet: ReturnType<typeof records>,
    messages: Array<{ id: string; role: string; createdAt?: number }>,
    turnIdByMessageId: Record<string, string>,
    loadedFromFirstMessage = true
  ) => projectCollaborationTimeline({ conversationId: 'self', records: recordSet, messages, turnIdByMessageId, removedConversationIds: [], loadedFromFirstMessage });
  const started = { turnId: 'task-turn', state: 'consumed' };

  // Across the first request: waiting, then running with nothing saved or streamed, then streaming, then saved.
  const waiting = project(records({ turnId: null, state: 'pending' }), earlier, earlierTurns);
  const running = project(records(started), earlier, earlierTurns);
  const streaming = project(records(started), [...earlier, { id: 'transient:request-1', role: 'model', createdAt: 3500 }],
    { ...earlierTurns, 'transient:request-1': 'task-turn' });
  const replied = project(records(started), [...earlier, { id: 'r2', role: 'model', createdAt: 3500 }], { ...earlierTurns, r2: 'task-turn' });
  for (const [stage, timeline] of Object.entries({ waiting, running, streaming, replied })) {
    assert.deepEqual(shown(timeline), ['task'], `the card stays visible while its Turn is ${stage}`);
  }
  assert.deepEqual(placed(waiting).unbound, ['task']);
  assert.deepEqual(placed(running), { before: {}, after: {}, turnWithoutMessage: ['task'], unbound: [] },
    'below every message while the first request has nothing to show');
  assert.deepEqual(placed(streaming).before, { 'transient:request-1': ['task'] }, 'a streaming reply holds it like the saved one');
  assert.deepEqual(placed(replied).before, { r2: ['task'] });

  // The first request ended without text (failed or stopped); the Turn sent its result back.
  const ended = records(started, { result: true });
  assert.deepEqual(placed(project(ended, earlier, earlierTurns)).turnWithoutMessage, ['task', 'result']);
  assert.deepEqual(placed(project(ended, [], {})).turnWithoutMessage, ['task', 'result'], 'a created Conversation with no message shows both');
  const later = [{ id: 'u3', role: 'user', createdAt: 6000 }, { id: 'r3', role: 'model', createdAt: 6500 }];
  const laterTurns = { u3: 'turn-3', r3: 'turn-3' };
  assert.deepEqual(placed(project(ended, [...earlier, ...later], { ...earlierTurns, ...laterTurns })),
    { before: {}, after: { r1: ['task', 'result'] }, turnWithoutMessage: [], unbound: [] },
    'after the last message created before that Turn started, not below newer ones');
  assert.deepEqual(placed(project(ended, later, laterTurns)).before, { u3: ['task', 'result'] },
    'above message 1 when that Turn is older than every message and message 1 is loaded');
  assert.deepEqual(shown(project(ended, later, laterTurns, false)), [],
    'a Turn older than a window that starts after message 1 waits for the earlier history');
  assert.deepEqual(shown(project(records(started, { result: true, turnLoaded: false }), earlier, earlierTurns)), [],
    'a Turn outside the loaded window is not guessed');
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
    removedConversationIds: [],
    loadedFromFirstMessage: true
  });
  assert.deepEqual(timeline.afterMessage['self-message'].map(card => [card.messageId, collaborationCardStatusLabel(card)]), [
    ['idle-message', '已送达，对方下一轮读取'],
    ['running-message', '已送达，对方本轮读取'],
    ['idle-result', '已送达，对方下一轮读取'],
    ['followup', '等待对方处理']
  ]);
});

test('the client feed contract states the card placement and pinned-failure bound the timeline uses', () => {
  const contract = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'docs/architecture/reliable-kernel/contracts/client-feed.json'), 'utf8'));
  const rule = contract.collaborationProjection.deliveryState as string;
  assert.match(rule, new RegExp('failed-incoming-stays-visible-after-the-last-message-created-before-it-was-sent'
    + '-or-before-the-first-message-when-older-than-every-message-and-message-1-is-loaded-even-with-a-gap-after-it'
    + `-or-among-the-newest-${MAX_PINNED_FAILED_COLLABORATION_CARDS}-pinned-below-every-message`
    + '-when-newer-than-every-message-or-no-message-has-a-creation-time; '));
  assert.match(rule, /; a-failure-older-than-a-window-that-starts-after-message-1-appears-once-that-history-loads; /);
  assert.match(rule, /a-waiting-outgoing-message-or-result-reads-as-delivered-for-the-recipient-current-or-next-Turn/);
  const turnRule = contract.collaborationProjection.turnPlacement as string;
  assert.match(turnRule, /^incoming-at-the-first-loaded-message-of-its-delivery-Turn-and-outgoing-at-that-of-its-sending-Turn-a-streaming-reply-included; /);
  assert.match(turnRule, new RegExp('; a-loaded-Turn-without-a-loaded-message-places-its-cards-by-when-it-started-after-the-last-message-created-before-it'
    + '-or-before-the-first-message-when-older-than-every-message-and-message-1-is-loaded'
    + '-or-below-every-message-ahead-of-that-Turn-notices-when-newer-than-every-message; '));
  assert.match(turnRule, /; a-Turn-not-loaded-or-older-than-a-window-that-starts-after-message-1-is-not-guessed; the-empty-conversation-hint-never-stands-in-for-a-card$/);
});
