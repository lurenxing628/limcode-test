import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

const require = createRequire(import.meta.url);
const kernel = require(path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension', 'backend/reliableKernel/index.js'));
const NativeDatabase = require('better-sqlite3');
const row = (domain, value) => kernel.DOMAIN_REPOSITORIES.domain(domain).insert(value);
const NOW = '2026-09-24T00:00:00.000Z';
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-collaboration-history-'));
  let database;
  const authority = await kernel.resetCandidateRuntimeRoot(directory);
  const open = async (hostBootId) => {
    database = await kernel.RuntimeDatabase.open(authority.authority, { hostBootId });
    return database;
  };
  try {
    await open('collaboration-history-original');
    const cas = new kernel.ContentAddressedStore(authority.authority, authority.binding);
    const payload = await cas.ingest(database, '来自另一个对话的真实 CAS 协作正文', 'text/vnd.limcode.collaboration-message');
    await database.transaction([
      row('Conversation', { id: 'target', title: '目标', status: 'active', created_at: NOW, updated_at: NOW }),
      row('Conversation', { id: 'sender', title: '研究同伴', status: 'active', created_at: NOW, updated_at: NOW }),
      row('Conversation', { id: 'gone', title: '会删除的同伴', status: 'active', created_at: NOW, updated_at: NOW }),
      row('Conversation', { id: 'other', title: '无关对话', status: 'active', created_at: NOW, updated_at: NOW }),
      row('Turn', { id: 'target-turn', conversation_id: 'target', status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW })
    ]);
    const envelope = (index, from, to, state, targetTurnId = null) => {
      const id = `collab-${String(index).padStart(3, '0')}`;
      return [
        kernel.DOMAIN_REPOSITORIES.domain('CollaborationMessage').insertWithNextSequence(
          { id, dedupe_key: id, mode: index % 3 === 0 ? 'followup' : 'message', created_at: NOW },
          { column: 'message_seq', scope: {} }
        ),
        row('CollaborationMessageSourceLink', { id: `${id}-source`, message_id: id, conversation_id: from,
          source_kind: 'tool', source_key: id, turn_id: from === 'target' ? 'target-turn' : null,
          tool_call_id: null, created_at: NOW }),
        row('RuntimeInboxItem', { id: `${id}-inbox`, dedupe_key: id, source_kind: 'collaboration_message',
          source_id: id, state: 'available', created_at: NOW, updated_at: NOW }),
        row('CollaborationMessageTargetLink', { id: `${id}-target`, message_id: id, conversation_id: to,
          inbox_item_id: `${id}-inbox`, anchor_turn_id: null, created_at: NOW }),
        row('CollaborationMessagePayloadLink', { id: `${id}-payload`, message_id: id,
          content_object_id: payload.id, created_at: NOW }),
        row('RuntimeDelivery', { id: `${id}-delivery-1`, inbox_item_id: `${id}-inbox`, target_conversation_id: to,
          target_turn_id: targetTurnId, phase: targetTurnId ? 'current_turn' : 'next_turn', attempt_seq: 1n,
          retry_of_delivery_id: null, state, failure_reason: state === 'failed' ? 'wake-dead-letter' : null,
          created_at: NOW, updated_at: NOW }),
        ...(state === 'consumed' ? [row('RuntimeDeliveryInputLink', {
          id: `${id}-input`, delivery_id: `${id}-delivery-1`, pending_turn_input_id: `${id}-turn-input`,
          handled_at: NOW, created_at: NOW, updated_at: NOW
        })] : [])
      ];
    };
    for (let start = 0; start < 241; start += 40) {
      await database.transaction(Array.from({ length: Math.min(40, 241 - start) }, (_value, offset) => {
        const index = start + offset;
        const from = index === 0 ? 'gone' : index % 2 ? 'target' : 'sender';
        const to = from === 'target' ? 'sender' : 'target';
        return envelope(index, from, to, index === 2 ? 'failed' : index === 4 ? 'consumed' : 'pending',
          index === 4 ? 'target-turn' : null);
      }).flat());
    }
    await database.transaction([
      ...envelope(241, 'other', 'sender', 'pending'),
      row('RuntimeDelivery', { id: 'collab-002-delivery-2', inbox_item_id: 'collab-002-inbox',
        target_conversation_id: 'target', target_turn_id: null, phase: 'next_turn', attempt_seq: 2n,
        retry_of_delivery_id: 'collab-002-delivery-1', state: 'failed', failure_reason: 'wake-dead-letter',
        created_at: NOW, updated_at: NOW })
    ]);
    const close = async () => {
      if (database) { await database.close(); database = undefined; }
      await fs.rm(directory, { recursive: true, force: true });
    };
    return { database: () => database, open, close, cas };
  } catch (error) {
    await database?.close();
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function sparseFixture(foreignCount = 100_000) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-collaboration-sparse-'));
  const root = await kernel.resetCandidateRuntimeRoot(directory);
  let database;
  let native;
  const close = async () => {
    native?.close();
    if (database) await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  };
  try {
    database = await kernel.RuntimeDatabase.open(root.authority, { hostBootId: 'sparse-seed' });
    const cas = new kernel.ContentAddressedStore(root.authority, root.binding);
    const payload = await cas.ingest(database, '稀疏对话协作正文', 'text/vnd.limcode.collaboration-message');
    const own = (id) => [
      kernel.DOMAIN_REPOSITORIES.domain('CollaborationMessage').insertWithNextSequence(
        { id, dedupe_key: id, mode: 'message', created_at: NOW }, { column: 'message_seq', scope: {} }
      ),
      row('CollaborationMessageSourceLink', { id: `${id}-source`, message_id: id,
        conversation_id: 'target', source_kind: 'tool', source_key: id,
        turn_id: null, tool_call_id: null, created_at: NOW }),
      row('RuntimeInboxItem', { id: `${id}-inbox`, dedupe_key: id, source_kind: 'collaboration_message',
        source_id: id, state: 'available', created_at: NOW, updated_at: NOW }),
      row('CollaborationMessageTargetLink', { id: `${id}-target`, message_id: id,
        conversation_id: 'sender', inbox_item_id: `${id}-inbox`, anchor_turn_id: null, created_at: NOW }),
      row('CollaborationMessagePayloadLink', { id: `${id}-payload`, message_id: id,
        content_object_id: payload.id, created_at: NOW }),
      row('RuntimeDelivery', { id: `${id}-delivery`, inbox_item_id: `${id}-inbox`,
        target_conversation_id: 'sender', target_turn_id: null, phase: 'next_turn',
        attempt_seq: 1n, retry_of_delivery_id: null, state: 'pending', failure_reason: null,
        created_at: NOW, updated_at: NOW })
    ];
    await database.transaction([
      row('Conversation', { id: 'target', title: '当前对话', status: 'active', created_at: NOW, updated_at: NOW }),
      row('Conversation', { id: 'sender', title: '研究对话', status: 'active', created_at: NOW, updated_at: NOW }),
      row('Conversation', { id: 'other', title: '其他对话', status: 'active', created_at: NOW, updated_at: NOW })
    ]);
    // More than 200 real owned envelopes precede the large unrelated span. They have no ordinary
    // Message or loaded Turn, so a bounded live snapshot cannot stand in for their history pages.
    for (let start = 0; start < 200; start += 25) {
      await database.transaction(Array.from({ length: 25 }, (_value, offset) =>
        own(`own-old-${String(start + offset).padStart(3, '0')}`)).flat());
    }
    await database.close();
    database = undefined;
    // Only the temporary fixture is changed, while the Runtime worker is closed. No schema or
    // RootBinding fingerprint is modified; all foreign messages have normal domain/link/CAS facts.
    native = new NativeDatabase(root.binding.paths.databasePath);
    native.pragma('foreign_keys = ON');
    const insertMessage = native.prepare('INSERT INTO collaboration_message(id,dedupe_key,message_seq,mode,created_at) VALUES (?,?,?,?,?)');
    const insertSource = native.prepare('INSERT INTO collaboration_message_source_link(id,message_id,conversation_id,source_kind,source_key,turn_id,tool_call_id,created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)');
    const insertInbox = native.prepare('INSERT INTO runtime_inbox_item(id,dedupe_key,source_kind,source_id,state,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertTarget = native.prepare('INSERT INTO collaboration_message_target_link(id,message_id,conversation_id,inbox_item_id,anchor_turn_id,created_at) VALUES (?, ?, ?, ?, NULL, ?)');
    const insertPayload = native.prepare('INSERT INTO collaboration_message_payload_link(id,message_id,content_object_id,created_at) VALUES (?, ?, ?, ?)');
    const insertDelivery = native.prepare('INSERT INTO runtime_delivery(id,inbox_item_id,target_conversation_id,target_turn_id,phase,attempt_seq,retry_of_delivery_id,state,failure_reason,created_at,updated_at) VALUES (?, ?, ?, NULL, ?, 1, NULL, ?, NULL, ?, ?)');
    native.transaction(() => {
      for (let index = 0; index < foreignCount; index += 1) {
        const id = `foreign-${String(index).padStart(6, '0')}`;
        const inboxId = `${id}-inbox`;
        insertMessage.run(id, id, BigInt(index + 201), 'message', NOW);
        insertSource.run(`${id}-source`, id, 'other', 'tool', id, NOW);
        insertInbox.run(inboxId, id, 'collaboration_message', id, 'available', NOW, NOW);
        insertTarget.run(`${id}-target`, id, 'sender', inboxId, NOW);
        insertPayload.run(`${id}-payload`, id, payload.id, NOW);
        insertDelivery.run(`${id}-delivery`, inboxId, 'sender', 'next_turn', 'pending', NOW, NOW);
      }
    })();
    native.close();
    native = undefined;
    database = await kernel.RuntimeDatabase.open(root.authority, { hostBootId: 'sparse-reopened' });
    await database.transaction(own('own-new'));
    return { database, root, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function assertPage(page) {
  assert.equal(page.responseBytes, bytes(page), 'exact self-inclusive wire byte count');
  assert.ok(page.responseBytes <= 524_288);
  assert.equal(typeof page.scanProgress, 'boolean');
  assert.ok(Number.isSafeInteger(page.scannedRows) && page.scannedRows >= 0 && page.scannedRows <= 4096,
    'one page inspects at most 4096 immutable global sequence candidates');
  assert.ok((page.records.CollaborationMessage?.length ?? 0) <= 200);
  for (const rows of Object.values(page.records)) {
    for (const record of rows) assert.ok(bytes(record) <= 2048, 'each record fits a bounded summary');
  }
  assert.equal(page.records.Message, undefined, 'not an ordinary Message page');
}

test('SQLite/CAS collaboration keyset crosses 200 without Message, scopes both directions and survives reopen/deletion', async () => {
  const f = await fixture();
  try {
    const read = () => new kernel.ClientHistoryReader(f.database());
    await assert.rejects(read().backwardCollaboration({ conversationId: 'target', limit: 3,
      beforeMessageSeq: '201' }), /cursor|beforeId/);
    const first = await read().backwardCollaboration({ conversationId: 'target', limit: 200 });
    assertPage(first);
    assert.equal(first.records.CollaborationMessage.length, 200);
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.records.CollaborationMessage.slice(0, 2).map((record) => record.id), ['collab-041', 'collab-042']);
    assert.equal(first.records.CollaborationMessage.some((record) => record.id === 'collab-241'), false,
      'foreign Conversation is isolated');
    assert.equal(first.records.CollaborationMessageSourceLink.length, 200);
    assert.equal(first.records.CollaborationMessageTargetLink.length, 200);
    assert.equal(first.records.RuntimeDelivery.length, 200);
    assert.equal(first.records.CollaborationPeerConversation.find((peer) => peer.id === 'sender')?.display_title, '研究同伴');
    const second = await read().backwardCollaboration({ conversationId: 'target', limit: 200,
      beforeMessageSeq: first.nextBeforeMessageSeq, beforeId: first.nextBeforeId });
    assertPage(second);
    assert.equal(second.records.CollaborationMessage.length, 41);
    assert.equal(second.hasMore, false);
    assert.equal(second.records.CollaborationMessage[0].id, 'collab-000');
    assert.equal(second.records.RuntimeDelivery.find((record) => record.inbox_item_id === 'collab-002-inbox')?.id,
      'collab-002-delivery-2', 'the newest delivery attempt is selected by attempt_seq, not created_at');
    assert.equal(second.records.Turn?.find((turn) => turn.id === 'target-turn')?.conversation_id, 'target');
    assert.equal(new Set([...first.records.CollaborationMessage, ...second.records.CollaborationMessage].map((record) => record.id)).size, 241);
    const empty = await read().backwardCollaboration({ conversationId: 'target', limit: 200,
      beforeMessageSeq: second.nextBeforeMessageSeq, beforeId: second.nextBeforeId });
    assertPage(empty);
    assert.equal(empty.hasMore, false);
    assert.deepEqual(empty.records, {});
    await new kernel.ConversationDeletionControlPlane(f.database()).delete('gone');
    const afterDeletion = await read().backwardCollaboration({ conversationId: 'target', limit: 50,
      beforeMessageSeq: first.nextBeforeMessageSeq, beforeId: first.nextBeforeId });
    assert.equal(afterDeletion.records.CollaborationPeerConversation.find((peer) => peer.id === 'gone')?.status, 'deleted');
    await f.database().close();
    await f.open('collaboration-history-reopened');
    const restarted = await read().backwardCollaboration({ conversationId: 'target', limit: 50,
      beforeMessageSeq: first.nextBeforeMessageSeq, beforeId: first.nextBeforeId });
    assertPage(restarted);
    assert.equal(restarted.records.CollaborationMessage[0].id, 'collab-000');
    assert.equal(restarted.records.CollaborationPeerConversation.find((peer) => peer.id === 'gone')?.status, 'deleted');
  } finally { await f.close(); }
});

test('100k foreign envelopes advance across empty pages to all 201 sparse own messages', async () => {
  const f = await sparseFixture();
  try {
    const native = new NativeDatabase(f.root.binding.paths.databasePath, { readonly: true });
    try {
      const plan = native.prepare(`EXPLAIN QUERY PLAN
        WITH bounded AS MATERIALIZED (
          SELECT message.id, message.message_seq
            FROM collaboration_message AS message INDEXED BY ux_collaboration_message_02
           WHERE message.message_seq < @beforeMessageSeq
           ORDER BY message.message_seq DESC LIMIT @scanLimit
        )
        SELECT bounded.id FROM bounded WHERE EXISTS (
          SELECT 1 FROM collaboration_message_source_link AS source
           WHERE source.message_id = bounded.id AND source.conversation_id = @conversationId
        ) OR EXISTS (
          SELECT 1 FROM collaboration_message_target_link AS target
           WHERE target.message_id = bounded.id AND target.conversation_id = @conversationId
        )`).all({ beforeMessageSeq: 100_201n, scanLimit: 4096n, conversationId: 'target' })
        .map((step) => step.detail);
      assert.ok(plan.some((step) => /ux_collaboration_message_02 \(message_seq<\?\)/.test(step)), plan.join(' | '));
      assert.ok(plan.some((step) => /ux_collaboration_message_source_link_01 \(message_id=\?\)/.test(step)), plan.join(' | '));
      assert.ok(plan.some((step) => /ux_collaboration_message_target_link_01 \(message_id=\?\)/.test(step)), plan.join(' | '));
      assert.equal(native.prepare('SELECT count(*) AS count FROM collaboration_message').get().count, 100_201);
    } finally { native.close(); }
    const reader = new kernel.ClientHistoryReader(f.database);
    const found = [];
    let cursor;
    let pages = 0;
    let emptyProgressPages = 0;
    do {
      const page = await reader.backwardCollaboration({
        conversationId: 'target', limit: 200,
        ...(cursor ? { beforeMessageSeq: cursor.nextBeforeMessageSeq, beforeId: cursor.nextBeforeId } : {})
      });
      assertPage(page);
      pages += 1;
      if (pages === 1) {
        assert.deepEqual(page.records.CollaborationMessage?.map((message) => message.id), ['own-new']);
        assert.equal(page.scanProgress, true);
      }
      if (pages === 2 || pages === 3) {
        assert.equal(page.records.CollaborationMessage, undefined, 'two or more 4096-row foreign-only pages are visible');
        assert.equal(page.scannedRows, 4096);
        assert.equal(page.hasMore, true);
      }
      if (cursor && page.nextBeforeMessageSeq) {
        assert.ok(BigInt(page.nextBeforeMessageSeq) < BigInt(cursor.nextBeforeMessageSeq),
          'each new scan cursor strictly moves backward, including an empty page');
      }
      if ((page.records.CollaborationMessage?.length ?? 0) === 0 && page.hasMore) {
        emptyProgressPages += 1;
        assert.equal(page.scanProgress, true);
        assert.ok(page.nextBeforeMessageSeq && page.nextBeforeId, 'a zero-row page supplies its inspected progress key');
      }
      found.push(...(page.records.CollaborationMessage ?? []).map((message) => message.id));
      cursor = page;
      assert.ok(pages < 40, 'every scan advances without an unbounded hidden retry');
    } while (cursor.hasMore);
    assert.ok(emptyProgressPages > 20, `${emptyProgressPages} zero-row progress pages expected`);
    assert.deepEqual(found, ['own-new', ...Array.from({ length: 200 }, (_value, index) =>
      `own-old-${String(index).padStart(3, '0')}`)],
      'each page is an ascending render bundle, while its keyset advances toward older global sequence keys');
    assert.equal(new Set(found).size, found.length, 'no match is repeated or skipped');
    assert.equal(cursor.records.CollaborationMessage.length, 200, 'the far historical page itself loads 200 owned rows');
    assert.equal(cursor.records.CollaborationMessageSourceLink.length, 200);
    assert.equal(cursor.records.CollaborationMessageTargetLink.length, 200);
    assert.ok(cursor.records.CollaborationMessageSourceLink.every((link) => link.conversation_id === 'target'));
    assert.ok(cursor.records.CollaborationMessageTargetLink.every((link) => link.conversation_id === 'sender'));
    assert.equal(cursor.records.Message, undefined, 'CollaborationMessage is never an ordinary Message');
    assert.equal(cursor.scanProgress, false);
    assert.equal(cursor.hasMore, false);

    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const pinia = await import('pinia');
    const { createSSRApp, nextTick } = await import('vue');
    const { renderToString } = await import('@vue/server-renderer');
    const previousPinia = pinia.getActivePinia();
    let server;
    let live;
    try {
      const posted = [];
      globalThis.window = {
        addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, atob,
        requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 0); },
        cancelAnimationFrame(id) { clearTimeout(id); },
        acquireVsCodeApi() { return { postMessage(message) { posted.push(structuredClone(message)); },
          getState() {}, setState() {} }; }
      };
      server = await createWebviewSsrServer();
      const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
      const { default: messageList } = await server.ssrLoadModule('/src/components/conversation/ReliableMessageList.vue');
      globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
      const scope = pinia.createPinia();
      pinia.setActivePinia(scope);
      const client = useReliableKernelClientFeedStore();
      live = new kernel.BoundedClientFeed(f.database);
      const frames = [];
      await live.connect({ activeConversationId: 'target', send: (frame) => frames.push(frame) });
      client.observe(frames[0]);
      const requests = () => posted.filter((message) => message.type === 'reliable-kernel.collaboration-history-request');
      const answer = async (request) => {
        const page = await reader.backwardCollaboration(request);
        client.observe({ type: 'reliable-kernel.collaboration-history-result', requestId: request.requestId,
          sessionId: request.sessionId, conversationId: request.conversationId, page });
        await nextTick();
        return page;
      };
      assert.equal(requests().length, 1, 'bootstrap is only one bounded read, not an automatic scan loop');
      const firstPage = await answer(requests()[0]);
      assert.equal(firstPage.scanProgress, true);
      assert.deepEqual(firstPage.records.CollaborationMessage.map((message) => message.id), ['own-new']);
      const mount = async () => {
        let setup;
        const app = createSSRApp(messageList, {}).use(scope);
        app.mixin({ created() { if (this.$.type.__name === messageList.__name) setup = this.$.setupState; } });
        return { html: await renderToString(app), setup };
      };
      let view = await mount();
      assert.match(view.html, /继续查找更早协作记录/);
      let lastSeq = BigInt(firstPage.nextBeforeMessageSeq);
      for (let click = 0; click < 2; click += 1) {
        view.setup.showEarlierCollaboration();
        assert.equal(requests().length, click + 2, 'one explicit click starts exactly one bounded request');
        view.setup.showEarlierCollaboration();
        assert.equal(requests().length, click + 2, 'the in-flight page cannot start an auto/busy retry');
        const page = await answer(requests()[click + 1]);
        assert.equal(page.records.CollaborationMessage, undefined, 'two consecutive user clicks inspect foreign-only windows');
        assert.equal(page.scannedRows, 4096);
        assert.equal(page.hasMore, true);
        assert.equal(page.scanProgress, true);
        assert.ok(BigInt(page.nextBeforeMessageSeq) < lastSeq);
        lastSeq = BigInt(page.nextBeforeMessageSeq);
        assert.equal(client.collaborationHistoryLoading, false);
        assert.equal(requests().length, click + 2, 'an empty page does not start the next scan itself');
        view = await mount();
        assert.match(view.html, /继续查找更早协作记录/);
      }
      let explicitPages = requests().length;
      while (client.collaborationHistoryHasMore) {
        view.setup.showEarlierCollaboration();
        explicitPages += 1;
        assert.equal(requests().length, explicitPages);
        const page = await answer(requests().at(-1));
        assertPage(page);
        if (page.hasMore) assert.ok(BigInt(page.nextBeforeMessageSeq) < lastSeq);
        if (page.nextBeforeMessageSeq) lastSeq = BigInt(page.nextBeforeMessageSeq);
        assert.ok(explicitPages < 40, 'one click cannot hide a full-history automatic loop');
        view = await mount();
      }
      assert.equal(client.collaborationHistoryLoading, false);
      assert.equal(client.collaborationHistoryHasMore, false);
      assert.equal(Object.keys(client.collaborationHistoryRecords.CollaborationMessage).length, 201);
      assert.equal(view.setup.timelineRows.filter((row) => row.kind === 'collaboration').length, 201);
      assert.ok(view.setup.collaborationTimeline.unlocated.length <= 3, 'Turn-less cards below the messages stay bounded');
      assert.equal(view.setup.messages.length, 0);
      assert.doesNotMatch(view.html, /继续查找更早协作记录/);
    } finally {
      live?.close();
      pinia.setActivePinia(previousPinia);
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      await server?.close();
    }
  } finally { await f.close(); }
});

test('a placeholder peer title reads at most 256 indexed Message memberships', async () => {
  const f = await fixture();
  try {
    const model = await f.cas.ingest(f.database(), JSON.stringify({ role: 'model', parts: [{ text: '早期模型记录' }] }),
      'application/vnd.limcode.message+json');
    const user = await f.cas.ingest(f.database(), JSON.stringify({ role: 'user', parts: [{ text: '第300条才出现的用户标题' }] }),
      'application/vnd.limcode.message+json');
    const payload = await f.cas.ingest(f.database(), '来自占位标题的对话', 'text/vnd.limcode.collaboration-message');
    await f.database().transaction([row('Conversation', {
      id: 'placeholder-peer', title: '新对话', status: 'active', created_at: NOW, updated_at: NOW
    })]);
    for (let start = 1; start <= 300; start += 50) {
      await f.database().transaction(Array.from({ length: Math.min(50, 301 - start) }, (_value, offset) => {
        const index = start + offset;
        const id = `peer-title-message-${index}`;
        const role = index === 300 ? 'user' : 'model';
        return [
          row('Message', { id, created_at: NOW, updated_at: NOW, deleted_at: null }),
          row('MessageRevision', { id: `${id}-revision`, message_id: id, revision_seq: 1n,
            role, content_object_id: role === 'user' ? user.id : model.id, created_at: NOW }),
          row('MessageCurrentRevisionLink', { id: `${id}-current`, message_id: id,
            revision_id: `${id}-revision`, updated_at: NOW }),
          row('MessagePartOfConversation', { id: `${id}-member`, conversation_id: 'placeholder-peer',
            message_id: id, message_seq: BigInt(index), created_at: NOW })
        ];
      }).flat());
    }
    const id = 'placeholder-peer-envelope';
    await f.database().transaction([
      kernel.DOMAIN_REPOSITORIES.domain('CollaborationMessage').insertWithNextSequence(
        { id, dedupe_key: id, mode: 'message', created_at: NOW }, { column: 'message_seq', scope: {} }),
      row('CollaborationMessageSourceLink', { id: `${id}-source`, message_id: id, conversation_id: 'placeholder-peer',
        source_kind: 'tool', source_key: id, turn_id: null, tool_call_id: null, created_at: NOW }),
      row('RuntimeInboxItem', { id: `${id}-inbox`, dedupe_key: id, source_kind: 'collaboration_message',
        source_id: id, state: 'available', created_at: NOW, updated_at: NOW }),
      row('CollaborationMessageTargetLink', { id: `${id}-target`, message_id: id,
        conversation_id: 'target', inbox_item_id: `${id}-inbox`, anchor_turn_id: null, created_at: NOW }),
      row('CollaborationMessagePayloadLink', { id: `${id}-payload`, message_id: id,
        content_object_id: payload.id, created_at: NOW }),
      row('RuntimeDelivery', { id: `${id}-delivery`, inbox_item_id: `${id}-inbox`,
        target_conversation_id: 'target', target_turn_id: null, phase: 'next_turn', attempt_seq: 1n,
        retry_of_delivery_id: null, state: 'pending', failure_reason: null, created_at: NOW, updated_at: NOW })
    ]);
    const page = await new kernel.ClientHistoryReader(f.database()).backwardCollaboration({ conversationId: 'target', limit: 200 });
    assertPage(page);
    assert.equal(page.records.CollaborationPeerConversation.find((peer) => peer.id === 'placeholder-peer')?.display_title,
      '新对话', 'no 300-message window query is allowed for an optional peer label');
  } finally { await f.close(); }
});

test('large CAS previews and peer labels reduce page rows before crossing the byte cap', async () => {
  const f = await fixture();
  try {
    const preview = await f.cas.ingest(f.database(), '汉'.repeat(1200), 'text/vnd.limcode.collaboration-message');
    const peers = Array.from({ length: 200 }, (_value, index) => `large-peer-${index}`);
    await f.database().transaction(peers.map((id) => row('Conversation', {
      id, title: '同伴'.repeat(800), status: 'active', created_at: NOW, updated_at: NOW
    })));
    for (let index = 0; index < 200; index += 25) {
      await f.database().transaction(peers.slice(index, index + 25).flatMap((peerId, offset) => {
        const id = `large-${String(index + offset).padStart(3, '0')}`;
        return [
          kernel.DOMAIN_REPOSITORIES.domain('CollaborationMessage').insertWithNextSequence(
            { id, dedupe_key: id, mode: 'message', created_at: NOW }, { column: 'message_seq', scope: {} }
          ),
          row('CollaborationMessageSourceLink', { id: `${id}-source`, message_id: id,
            conversation_id: 'target', source_kind: 'tool', source_key: id,
            turn_id: 'target-turn', tool_call_id: null, created_at: NOW }),
          row('RuntimeInboxItem', { id: `${id}-inbox`, dedupe_key: id, source_kind: 'collaboration_message',
            source_id: id, state: 'available', created_at: NOW, updated_at: NOW }),
          row('CollaborationMessageTargetLink', { id: `${id}-target`, message_id: id,
            conversation_id: peerId, inbox_item_id: `${id}-inbox`, anchor_turn_id: null, created_at: NOW }),
          row('CollaborationMessagePayloadLink', { id: `${id}-payload`, message_id: id,
            content_object_id: preview.id, created_at: NOW }),
          row('RuntimeDelivery', { id: `${id}-delivery`, inbox_item_id: `${id}-inbox`,
            target_conversation_id: peerId, target_turn_id: null, phase: 'next_turn',
            attempt_seq: 1n, retry_of_delivery_id: null, state: 'failed',
            failure_reason: '错误'.repeat(500), created_at: NOW, updated_at: NOW })
        ];
      }));
    }
    const read = () => new kernel.ClientHistoryReader(f.database());
    const first = await read().backwardCollaboration({ conversationId: 'target', limit: 200 });
    assertPage(first);
    assert.ok(first.records.CollaborationMessage.length < 200,
      'the reader must shrink the row count rather than exceed maxPageBytes');
    assert.ok(first.records.CollaborationMessage.length > 0);
    assert.equal(first.hasMore, true);
    const next = await read().backwardCollaboration({ conversationId: 'target', limit: 200,
      beforeMessageSeq: first.nextBeforeMessageSeq, beforeId: first.nextBeforeId });
    assertPage(next);
    assert.ok(next.records.CollaborationMessage.length > 0);
    assert.ok(BigInt(next.nextBeforeMessageSeq) < BigInt(first.nextBeforeMessageSeq));
    assert.equal(new Set([...first.records.CollaborationMessage, ...next.records.CollaborationMessage]
      .map((message) => message.id)).size,
    first.records.CollaborationMessage.length + next.records.CollaborationMessage.length);
  } finally { await f.close(); }
});

test('Host bridge fences historical replies after navigation and rejects a foreign Conversation request', async () => {
  const { ReliableKernelWebviewFeedBridge } = require(path.resolve(
    process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension',
    'backend/reliableKernel/webviewFeedBridge.js'
  ));
  const posted = [];
  let serial = 0;
  let resolvePage;
  const feed = {
    async connect(options) {
      serial += 1;
      const sessionId = `session-${serial}`;
      options.send({ type: 'reliable-kernel.snapshot', sessionId, hostBootId: 'host-boot',
        messageSeq: '1', snapshotCommitSeq: '0', projections: {} });
      return { sessionId, hostBootId: 'host-boot' };
    },
    disconnect() {}, acknowledge() {}, requestSnapshot() {}
  };
  const bridge = new ReliableKernelWebviewFeedBridge(
    feed,
    { async read() { throw new Error('No detail read expected'); } },
    (error) => { throw error; },
    undefined, undefined,
    { backwardCollaboration: () => new Promise((resolve) => { resolvePage = resolve; }) }
  );
  const clientId = bridge.attach({ async postMessage(value) { posted.push(structuredClone(value)); return true; } },
    { kind: 'mainPanel', conversationId: 'target' });
  try {
    bridge.reconnect(clientId, 'target');
    for (let attempt = 0; attempt < 100 && !posted.some((frame) => frame.type === 'reliable-kernel.snapshot'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const pendingRead = bridge.handleControl(clientId, {
      type: 'reliable-kernel.collaboration-history-request', requestId: 'first',
      sessionId: 'session-1', conversationId: 'target', limit: 20
    });
    for (let attempt = 0; attempt < 100 && !resolvePage; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(typeof resolvePage, 'function');
    bridge.reconnect(clientId, 'other');
    resolvePage({ records: {}, hasMore: false, responseBytes: 52 });
    await pendingRead;
    assert.equal(posted.filter((frame) => frame.type === 'reliable-kernel.collaboration-history-result').length, 0,
      'a completed read from the previous navigation must not post to the new panel');
    await bridge.handleControl(clientId, {
      type: 'reliable-kernel.collaboration-history-request', requestId: 'retired',
      sessionId: 'session-1', conversationId: 'target', limit: 20
    });
    assert.equal(posted.filter((frame) => frame.type === 'reliable-kernel.collaboration-history-result').length, 0);
    await bridge.handleControl(clientId, {
      type: 'reliable-kernel.collaboration-history-request', requestId: 'foreign',
      sessionId: 'session-2', conversationId: 'target', limit: 20
    });
    assert.ok(posted.some((frame) => frame.type === 'reliable-kernel.collaboration-history-error'
      && frame.requestId === 'foreign'));
  } finally { bridge.detach(clientId); bridge.close(); }
});

test('Host resynchronizes a failed collaboration result or error post without crossing sessions', async (t) => {
  const { ReliableKernelWebviewFeedBridge } = require(path.resolve(
    process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension',
    'backend/reliableKernel/webviewFeedBridge.js'
  ));
  for (const responseType of ['result', 'error']) {
    for (const failure of ['false', 'reject']) {
      await t.test(`${responseType} postMessage ${failure}`, async () => {
        const posted = [];
        const failures = [];
        let serial = 0;
        const feed = {
          async connect(options) {
            serial += 1;
            const sessionId = `post-failure-session-${serial}`;
            options.send({ type: 'reliable-kernel.snapshot', sessionId, hostBootId: 'host-boot',
              messageSeq: '1', snapshotCommitSeq: '0', projections: {} });
            return { sessionId, hostBootId: 'host-boot' };
          },
          disconnect() {}, acknowledge() {}, requestSnapshot() {}
        };
        const history = { async backwardCollaboration() {
          if (responseType === 'error') throw new Error('read unavailable');
          return { records: {}, hasMore: false, responseBytes: 52 };
        } };
        const bridge = new ReliableKernelWebviewFeedBridge(feed,
          { async read() { throw new Error('No detail read expected'); } },
          (error) => { failures.push(error); }, undefined, undefined, history);
        const clientId = bridge.attach({ async postMessage(value) {
          posted.push(structuredClone(value));
          if (value.type === `reliable-kernel.collaboration-history-${responseType}`
            && value.sessionId === 'post-failure-session-1') {
            if (failure === 'false') return false;
            throw new Error('renderer unavailable');
          }
          return true;
        } }, { kind: 'mainPanel', conversationId: 'target' });
        try {
          bridge.reconnect(clientId, 'target');
          for (let i = 0; i < 50 && serial < 1; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(serial, 1);
          await bridge.handleControl(clientId, { type: 'reliable-kernel.collaboration-history-request',
            requestId: 'failed-page', sessionId: 'post-failure-session-1', conversationId: 'target', limit: 20 });
          for (let i = 0; i < 160 && serial < 2; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(serial, 2, 'an uncloneable/dropped collaboration response must establish a fresh session');
          assert.ok(failures.length > 0);
          const beforeStale = posted.length;
          await bridge.handleControl(clientId, { type: 'reliable-kernel.collaboration-history-request',
            requestId: 'retired-page', sessionId: 'post-failure-session-1', conversationId: 'target', limit: 20 });
          assert.equal(posted.length, beforeStale, 'the retired session cannot replay its response');
          await bridge.handleControl(clientId, { type: 'reliable-kernel.collaboration-history-request',
            requestId: 'fresh-page', sessionId: 'post-failure-session-2', conversationId: 'target', limit: 20 });
          assert.ok(posted.some((item) => item.sessionId === 'post-failure-session-2'
            && item.requestId === 'fresh-page'
            && item.type === `reliable-kernel.collaboration-history-${responseType}`));
        } finally { bridge.detach(clientId); bridge.close(); }
      });
    }
  }
});

test('Vue SSR merges collaboration pages with ACKed live facts, fences old session/request, and renders no Message', async () => {
  const f = await fixture();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const pinia = await import('pinia');
  const { createSSRApp, nextTick } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const previousPinia = pinia.getActivePinia();
  let server;
  try {
    const posted = [];
    const pending = [];
    let dropCollaborationResponse = false;
    let client;
    globalThis.window = {
      addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, atob,
      requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 0); },
      cancelAnimationFrame(id) { clearTimeout(id); },
      acquireVsCodeApi() { return {
        postMessage(message) {
          const plain = structuredClone(message);
          posted.push(plain);
          if (plain.type !== 'reliable-kernel.collaboration-history-request' || dropCollaborationResponse) return;
          pending.push(new kernel.ClientHistoryReader(f.database()).backwardCollaboration(plain).then((page) => {
            client.observe({ type: 'reliable-kernel.collaboration-history-result', sessionId: plain.sessionId,
              conversationId: plain.conversationId, requestId: plain.requestId, page });
          }));
        },
        getState() {}, setState() {}
      }; }
    };
    server = await createWebviewSsrServer();
    const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
    const { default: messageList } = await server.ssrLoadModule('/src/components/conversation/ReliableMessageList.vue');
    globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
    const scope = pinia.createPinia();
    pinia.setActivePinia(scope);
    client = useReliableKernelClientFeedStore();
    const live = new kernel.BoundedClientFeed(f.database());
    const frames = [];
    try {
      await live.connect({ activeConversationId: 'target', send: (frame) => frames.push(frame) });
      client.observe(frames[0]);
      assert.equal(posted[0]?.type, 'reliable-kernel.ack', 'ACK is sent before optional page read');
      assert.equal(posted[1]?.type, 'reliable-kernel.collaboration-history-request');
      await Promise.all(pending);
      await nextTick();
      assert.equal(client.collaborationHistoryHasMore, true);
      assert.equal(Object.keys(client.collaborationHistoryRecords.CollaborationMessage ?? {}).length, 200,
        `collaboration page rejected: ${client.collaborationHistoryError ?? 'no error'}; scope=${client.collaborationHistoryConversationId}; id=${client.collaborationHistoryRequestId}`);
      assert.equal(client.requestEarlierCollaborationHistory('target'), true);
      const secondRequest = posted.at(-1);
      const loadedBeforeResponse = Object.keys(client.collaborationHistoryRecords.CollaborationMessage).length;
      client.observe({ type: 'reliable-kernel.collaboration-history-result', sessionId: secondRequest.sessionId,
        requestId: 'different-request', conversationId: 'target', page: {
          records: {}, hasMore: false, responseBytes: 52
        } });
      client.observe({ type: 'reliable-kernel.collaboration-history-result', sessionId: 'retired-session',
        requestId: secondRequest.requestId, conversationId: 'target', page: {
          records: {}, hasMore: false, responseBytes: 52
        } });
      assert.equal(Object.keys(client.collaborationHistoryRecords.CollaborationMessage).length, loadedBeforeResponse,
        'wrong requestId and old session cannot overwrite the in-flight page');
      assert.equal(client.collaborationHistoryLoading, true);
      await Promise.all(pending);
      await nextTick();
      assert.equal(client.collaborationHistoryHasMore, false);
      assert.equal(Object.keys(client.collaborationHistoryRecords.CollaborationMessage).length, 241);
      const oldRequest = posted.find((frame) => frame.type === 'reliable-kernel.collaboration-history-request');
      client.observe({ type: 'reliable-kernel.collaboration-history-result', sessionId: 'retired-session',
        requestId: oldRequest.requestId, conversationId: 'target', page: { records: {}, hasMore: false, responseBytes: 52 } });
      assert.equal(Object.keys(client.collaborationHistoryRecords.CollaborationMessage).length, 241);
      // Rebind the same Conversation to a new Webview session: history pages are never assumed
      // to belong to the new root merely because the public conversationId stayed the same.
      const replacement = new kernel.BoundedClientFeed(f.database());
      try {
        const newFrames = [];
        await replacement.connect({ activeConversationId: 'target', send: (frame) => newFrames.push(frame) });
        const originalSetTimeout = globalThis.setTimeout;
        let deadline;
        dropCollaborationResponse = true;
        globalThis.setTimeout = (callback, delay, ...args) => {
          if (delay === 20_000) {
            deadline = () => callback(...args);
            return { unref() {} };
          }
          return originalSetTimeout(callback, delay, ...args);
        };
        try {
          client.observe(newFrames[0]);
          assert.equal(Object.keys(client.collaborationHistoryRecords.CollaborationMessage ?? {}).length, 0);
          assert.equal(client.collaborationHistoryLoading, true);
          assert.equal(typeof deadline, 'function');
          deadline();
          assert.equal(client.collaborationHistoryLoading, false, 'a lost page cannot leave loading stuck');
          assert.match(client.collaborationHistoryError, /超时|重试/);
        } finally {
          globalThis.setTimeout = originalSetTimeout;
          dropCollaborationResponse = false;
        }
        assert.equal(client.requestEarlierCollaborationHistory('target'), true, 'the same keyset is retryable');
        await Promise.all(pending);
        assert.equal(Object.keys(client.collaborationHistoryRecords.CollaborationMessage).length, 200);
        assert.equal(client.requestEarlierCollaborationHistory('target'), true);
        await Promise.all(pending);
        assert.equal(Object.keys(client.collaborationHistoryRecords.CollaborationMessage).length, 241);
      } finally { replacement.close(); }
      let setup;
      const app = createSSRApp(messageList, {}).use(scope);
      app.mixin({ created() { if (this.$.type.__name === messageList.__name) setup = this.$.setupState; } });
      const html = await renderToString(app);
      assert.equal(setup.messages.length, 0, 'no ordinary Message was invented');
      assert.equal(Object.values(setup.collaborationTimeline.afterMessage).flat().length, 0);
      assert.equal(setup.timelineRows.filter((row) => row.kind === 'collaboration').length, 241,
        'live and historical overlap renders once');
      assert.equal(new Set(setup.timelineRows.map((row) => row.id)).size, setup.timelineRows.length);
      assert.match(html, /协作正文/);
      assert.match(html, /位置待确认/);
      assert.doesNotMatch(html, /还没有消息/);
    } finally { live.close(); }
  } finally {
    pinia.setActivePinia(previousPinia);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    await server?.close();
    await f.close();
  }
});
