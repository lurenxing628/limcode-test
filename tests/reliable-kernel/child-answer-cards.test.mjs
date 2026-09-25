import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

const require = createRequire(import.meta.url);
const kernel = require(path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension', 'backend/reliableKernel/index.js'));
const row = (domain, value) => kernel.DOMAIN_REPOSITORIES.domain(domain).insert(value);
const at = (minute) => `2026-09-25T00:${String(minute).padStart(2, '0')}:00.000Z`;

/**
 * A parent Conversation whose child Agent answered several of its own Turns through ONE reused
 * AnswerBridge (the bridge only points at the newest submission). A second, closed child whose
 * run_agent call is outside the loaded window also delivered an answer. Every answer reached the
 * parent as its own consumed RuntimeDelivery.
 */
async function openRuntime(answers) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-child-answer-cards-'));
  let database;
  const close = async () => {
    if (database) await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  };
  try {
    const root = await kernel.resetCandidateRuntimeRoot(directory);
    database = await kernel.RuntimeDatabase.open(root.authority, { hostBootId: 'child-answer-cards' });
    const cas = new kernel.ContentAddressedStore(root.authority, root.binding);
    const toolArguments = await cas.ingest(database, '{"task":"调研"}', 'application/json');
    const answerBody = await cas.ingest(database, '子任务的回答', 'text/plain');
    const turn = (id, conversationId, minute) => row('Turn', { id, conversation_id: conversationId, status: 'terminated',
      created_at: at(minute), updated_at: at(minute), terminal_at: at(minute) });
    const child = (id, conversationId, status, sourceToolCallId, parentTurnId) => [
      row('ChildExecution', { id, child_conversation_id: conversationId, status, created_at: at(1), updated_at: at(1) }),
      row('ChildExecutionParentLink', { id: `${id}-parent`, child_execution_id: id, source_tool_call_id: sourceToolCallId,
        parent_child_execution_id: null, parent_turn_id: parentTurnId, created_at: at(1) })
    ];
    const answer = ({ submissionId, bridgeId, childTurnId, seq, parentTurnId, minute }) => [
      row('AnswerSubmission', { id: submissionId, answer_bridge_id: bridgeId, submission_seq: BigInt(seq), turn_id: childTurnId,
        interrupted: 0n, created_at: at(minute) }),
      row('AnswerPayload', { id: `${submissionId}-payload`, submission_id: submissionId, title: null,
        content_object_id: answerBody.id, byte_length: BigInt(answerBody.byte_length), created_at: at(minute) }),
      row('RuntimeInboxItem', { id: `${submissionId}-inbox`, dedupe_key: `answer:${bridgeId}:${submissionId}`,
        source_kind: 'answer_submission', source_id: submissionId, state: 'consumed', created_at: at(minute), updated_at: at(minute) }),
      row('RuntimeDelivery', { id: `${submissionId}-delivery`, inbox_item_id: `${submissionId}-inbox`, target_conversation_id: 'parent',
        target_turn_id: parentTurnId, phase: 'next_turn', attempt_seq: 1n, retry_of_delivery_id: null, state: 'consumed',
        failure_reason: null, created_at: at(minute), updated_at: at(minute) }),
      row('RuntimeDeliveryInputLink', { id: `${submissionId}-input`, delivery_id: `${submissionId}-delivery`,
        pending_turn_input_id: `${submissionId}-turn-input`, handled_at: at(minute), created_at: at(minute), updated_at: at(minute) })
    ];
    await database.transaction([
      row('Conversation', { id: 'parent', title: '主对话', status: 'active', created_at: at(0), updated_at: at(0) }),
      row('Conversation', { id: 'child', title: '调研子任务', status: 'active', created_at: at(1), updated_at: at(1) }),
      row('Conversation', { id: 'closed-child', title: '已关闭子任务', status: 'active', created_at: at(1), updated_at: at(1) }),
      turn('spawn-turn', 'parent', 1),
      row('ToolCall', { id: 'spawn-call', turn_id: 'spawn-turn', call_seq: 1n, tool_name: 'run_agent', status: 'terminal',
        arguments_object_id: toolArguments.id, created_at: at(1), updated_at: at(1) }),
      ...child('child-execution', 'child', 'idle', 'spawn-call', 'spawn-turn'),
      ...child('closed-execution', 'closed-child', 'closed', 'call-outside-window', 'spawn-turn'),
      row('AnswerBridge', { id: 'bridge', child_execution_id: 'child-execution', current_submission_id: null, status: 'open',
        created_at: at(1), updated_at: at(1) }),
      row('AnswerBridge', { id: 'closed-bridge', child_execution_id: 'closed-execution', current_submission_id: null, status: 'open',
        created_at: at(1), updated_at: at(1) })
    ]);
    let minute = 2;
    /** Commits one answer the way the kernel shapes it; `parentTurnId` reuses an existing Turn. */
    const commitAnswer = async (spec) => {
      minute += 2;
      const bridgeId = spec.closed ? 'closed-bridge' : 'bridge';
      const childConversation = spec.closed ? 'closed-child' : 'child';
      const childExecution = spec.closed ? 'closed-execution' : 'child-execution';
      const childTurnId = `${spec.id}-child-turn`;
      const submissionId = spec.failed
        ? kernel.stablePhaseFId('answer_submission', 'child-drive-failed', childExecution, childTurnId)
        : `${spec.id}-submission`;
      spec.submissionId = submissionId;
      const parentTurnId = spec.parentTurnId ?? `${spec.id}-parent-turn`;
      await database.transaction([
        turn(childTurnId, childConversation, minute),
        ...(spec.parentTurnId ? [] : [turn(parentTurnId, 'parent', minute + 1)]),
        ...answer({ submissionId, bridgeId, childTurnId, seq: spec.seq, parentTurnId, minute }),
        kernel.DOMAIN_REPOSITORIES.domain('AnswerBridge').update(bridgeId, { current_submission_id: submissionId, updated_at: at(minute) })
      ]);
    };
    for (const spec of answers) await commitAnswer(spec);
    return { database, close, commitAnswer };
  } catch (error) {
    await close();
    throw error;
  }
}

async function renderParent(snapshot) {
  const pinia = await import('pinia');
  const { createSSRApp } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, atob,
    requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 0); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    acquireVsCodeApi() { return { postMessage() {}, getState() { return {}; }, setState() {} }; }
  };
  let server;
  try {
    server = await createWebviewSsrServer();
    const { default: MessageList } = await server.ssrLoadModule('/src/components/conversation/ReliableMessageList.vue');
    const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
    const timeline = await server.ssrLoadModule('/src/domain/reliableCollaborationTimeline.ts');
    globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
    const isolated = pinia.createPinia();
    pinia.setActivePinia(isolated);
    const feed = useReliableKernelClientFeedStore();
    feed.observe(snapshot);
    let setup;
    const app = createSSRApp(MessageList, {}).use(isolated);
    app.mixin({ created() { if (this.$.type.__name === MessageList.__name) setup = this.$.setupState; } });
    const html = await renderToString(app);
    const cards = setup.timelineRows.filter((entry) => entry.kind === 'collaboration').map((entry) => entry.card);
    return { html, cards, records: feed.records, timeline };
  } finally {
    if (server) await server.close();
    pinia.setActivePinia(previousPinia);
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
}

async function snapshotOf(database) {
  const feed = new kernel.BoundedClientFeed(database);
  const frames = [];
  try {
    await feed.connect({ activeConversationId: 'parent', send: (frame) => frames.push(frame) });
    return frames[0];
  } finally {
    feed.close();
  }
}

test('every answer a reused child bridge delivered keeps its card after a real snapshot', async () => {
  const answers = [{ id: 'first', seq: 1 }, { id: 'second', seq: 2 }, { id: 'closed', seq: 1, closed: true }];
  const runtime = await openRuntime(answers);
  try {
    const snapshot = await snapshotOf(runtime.database);
    const summary = snapshot.projections.subagentDeliverySummary;
    assert.deepEqual(summary.answerSubmissions.map((submission) => submission.id).sort(),
      answers.map((answer) => answer.submissionId).sort(), 'each answer delivery carries its own submission');
    assert.ok(summary.childExecutions.some((child) => child.id === 'closed-execution'),
      'a child outside the loaded window still names the peer of its delivered answer');
    assert.ok(summary.answerBridges.some((bridge) => bridge.id === 'closed-bridge'));

    const view = await renderParent(snapshot);
    assert.deepEqual(view.cards.map((card) => card.messageId).sort(),
      answers.map((answer) => `answer:${answer.submissionId}`).sort(), 'no earlier answer card vanishes on reload');
    assert.deepEqual(view.cards.map((card) => view.timeline.collaborationCardKindLabel(card)), ['最终结果', '最终结果', '最终结果']);
    assert.equal(view.cards.filter((card) => view.timeline.collaborationCardLabel(card) === '来自子 Agent 调研子任务').length, 2);
    for (const answer of answers) {
      assert.match(view.html, new RegExp(`data-timeline-row-key="collaboration:answer:${answer.submissionId}"`));
    }
  } finally {
    await runtime.close();
  }
});

test('a failed child run is labelled 执行失败 in its card, its live change and the queue, never 最终结果', async () => {
  const answers = [{ id: 'first', seq: 1 }, { id: 'broken', seq: 2, failed: true }];
  const runtime = await openRuntime(answers);
  const feed = new kernel.BoundedClientFeed(runtime.database);
  try {
    const frames = [];
    await feed.connect({ activeConversationId: 'parent', send: (frame) => frames.push(frame) });
    const snapshot = frames[0];
    const outcomes = Object.fromEntries(snapshot.projections.subagentDeliverySummary.answerSubmissions
      .map((submission) => [submission.id, submission.outcome]));
    assert.deepEqual(outcomes, { [answers[0].submissionId]: 'submitted', [answers[1].submissionId]: 'failed' },
      'the Host derives the outcome from the stable failed-submission id, not from the interrupted bit');

    const view = await renderParent(snapshot);
    const labels = Object.fromEntries(view.cards.map((card) => [card.messageId, view.timeline.collaborationCardKindLabel(card)]));
    assert.deepEqual(labels, { [`answer:${answers[0].submissionId}`]: '最终结果', [`answer:${answers[1].submissionId}`]: '执行失败' });
    assert.match(view.html, /执行失败/);

    // A failure committed while the view is open reaches it as a change carrying the same outcome.
    feed.acknowledge({ type: 'reliable-kernel.ack', sessionId: snapshot.sessionId, hostBootId: snapshot.hostBootId, messageSeq: snapshot.messageSeq });
    const late = { id: 'late', seq: 3, failed: true, parentTurnId: 'spawn-turn' };
    await runtime.commitAnswer(late);
    for (let attempt = 0; attempt < 200 && !frames[1]; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(frames[1]?.type, 'reliable-kernel.changes');
    const change = frames[1].changes.find((entry) => entry.type === 'AnswerSubmission' && entry.id === late.submissionId);
    assert.equal(change?.record.outcome, 'failed');
  } finally {
    feed.close();
    await runtime.close();
  }
});

test('the queue labels a waiting failed child run as 执行失败 and an interrupted one as a partial result', async () => {
  const pinia = await import('pinia');
  const { createSSRApp } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, atob,
    requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 0); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    acquireVsCodeApi() { return { postMessage() {}, getState() { return {}; }, setState() {} }; }
  };
  let server;
  try {
    server = await createWebviewSsrServer();
    const { default: QueuePanel } = await server.ssrLoadModule('/src/components/input/ReliableQueuePanel.vue');
    globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
    const isolated = pinia.createPinia();
    pinia.setActivePinia(isolated);
    let setup;
    const app = createSSRApp(QueuePanel, {}).use(isolated);
    app.mixin({ created() { if (this.$.type.__name === QueuePanel.__name) setup = this.$.setupState; } });
    await renderToString(app);
    const preview = (outcome) => setup.runtimeContinuationSource({
      kind: 'subagent', inboxItemId: 'inbox', sourceId: 'submission', submissionId: 'submission',
      childExecutionId: 'child-execution', childConversationId: 'child', childStatus: 'idle', outcome
    });
    const item = (outcome) => ({ id: 'intent', state: 'queued', preview: {
      version: 3, kind: 'runtime_continuation', revisionSeq: '1', sourceTurnId: 'turn', deliveryId: 'delivery',
      deliveryState: 'pending', phase: 'next_turn', source: preview(outcome)
    } });
    assert.equal(setup.stateLabel(item('failed')), '子 Agent 执行失败');
    assert.equal(setup.stateLabel(item('interrupted')), '子 Agent 部分结果');
    assert.equal(setup.stateLabel(item('submitted')), '子 Agent 最终结果');
    assert.match(setup.previewText(item('failed').preview), /执行失败$/);
    assert.equal(preview('unknown'), undefined, 'an unrecognized outcome is not shown as a final result');
  } finally {
    if (server) await server.close();
    pinia.setActivePinia(previousPinia);
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});
