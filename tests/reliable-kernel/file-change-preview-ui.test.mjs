import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

const DIFF = '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -20,1 +20,2 @@\n-old value\n+new value\n+second value\n';
const EDIT_ARGS = { path: 'src/example.ts', mode: 'hunk',
  hunks: [{ oldContent: 'old value', newContent: 'new value\nsecond value' }],
  insert: { line: 1, content: 'unused-branch-content' }, delete: { startLine: 1, endLine: 1 } };

test('file tools render changes first and keep call parameters behind a closed details control', async t => {
  const pinia = await import('pinia');
  const { createSSRApp } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const oldPinia = pinia.getActivePinia();
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const posted = [];
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, atob,
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
    acquireVsCodeApi() { return { postMessage(message) { posted.push(message); }, getState() {}, setState() {} }; }
  };
  const server = await createWebviewSsrServer();
  globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
  t.after(async () => {
    await server.close();
    pinia.setActivePinia(oldPinia);
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
  });
  const { default: Card } = await server.ssrLoadModule('/src/components/content/parts/FunctionCallPartView.vue');
  const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
  const { useReliableConversation } = await server.ssrLoadModule('/src/composables/useReliableConversation.ts');
  const { reliableKernelDetailDemandSignature } = await server.ssrLoadModule('/src/domain/reliableDetailKey.ts');

  function fixture(name, args, result = { mode: 'hunk', ignoredBranches: ['insert', 'delete'],
    warning: '已选择 mode=hunk；未执行分支：insert、delete。', operations: [{ effectReceiptId: 'internal-receipt' }] }) {
    const activePinia = pinia.createPinia();
    pinia.setActivePinia(activePinia);
    const feed = useReliableKernelClientFeedStore();
    const requests = [];
    feed.requestDetail = (kind, recordId, options) => requests.push({ kind, recordId, options });
    const part = { id: 'provider-call', functionCall: { name, args } };
    feed.projections.activeConversationWindow = { conversationId: 'conversation' };
    feed.records = {
      Turn: { turn: { id: 'turn', conversation_id: 'conversation', status: 'active' } },
      ModelRequest: { request: { id: 'request', turn_id: 'turn', request_seq: '1', status: 'terminal' } },
      Message: { message: { id: 'message', conversation_id: 'conversation', message_seq: '1', role: 'model',
        revision_id: 'revision', created_at: '2026-10-09T10:00:00.000Z' } },
      MessageTurnLink: { link: { id: 'link', message_id: 'message', turn_id: 'turn', role: 'model' } },
      ToolCall: { call: { id: 'call', turn_id: 'turn', call_seq: '1', tool_name: name, status: 'terminal' } },
      ToolCallSourceLink: { source: { id: 'source', tool_call_id: 'call', model_request_id: 'request',
        message_id: 'message', provider_call_id: 'provider-call', provider_ordinal: 0 } },
      ToolCallPolicySnapshot: { policy: { id: 'policy', tool_call_id: 'call',
        display_auto_expand: 0, display_auto_open_diff: 0 } },
      ToolOutcome: { outcome: { id: 'outcome', tool_call_id: 'call', status: 'succeeded' } }
    };
    feed.details['message-content:revision'] = { status: 'ready', text: JSON.stringify({ role: 'model', parts: [part] }) };
    feed.details['tool-arguments-content:call'] = { status: 'ready', text: JSON.stringify(args) };
    feed.details['tool-result-content:call'] = { status: 'ready', text: JSON.stringify({ detail: result }) };
    const conversation = useReliableConversation();
    const render = (state = {}) => {
      const app = createSSRApp(Card, { part, messageId: 'message', toolOrdinal: 0 }).use(activePinia);
      if (Object.keys(state).length) app.mixin({ created() {
        if (this.$.type.__name === Card.__name) Object.assign(this.$.setupState, state);
      } });
      return renderToString(app);
    };
    function member(operation = 'replace_file', id = 'member', targetPath = 'src/example.ts') {
      feed.records.FileChangeSet = { set: { id: 'set', tool_call_id: 'call', status: 'applied' } };
      feed.records.FileChangeSetMember ??= {};
      feed.records.FileChangeSetMember[id] = { id, change_set_id: 'set', member_seq: id === 'member' ? '1' : '2',
        operation, target_path: targetPath };
    }
    function ready(id = 'member', diff = DIFF) {
      feed.details[`file-change-diff:${id}`] = { status: 'ready', text: JSON.stringify({
        path: feed.records.FileChangeSetMember[id].target_path,
        ...(diff ? { diff: { text: diff, added: 2, removed: 1 } } : {})
      }) };
    }
    return { feed, render, member, ready, requests, conversation };
  }

  for (const [name, args, operation] of [
    ['edit', EDIT_ARGS, 'replace_file'],
    ['write', { path: 'src/example.ts', content: 'new value\nsecond value' }, 'create_file'],
    ['write', { path: 'src/example.ts', content: 'new value\nsecond value' }, 'replace_file'],
    ['delete', { paths: ['src/example.ts'] }, 'delete_file']
  ]) await t.test(`${name} ${operation}: expanded diff, hidden parameters`, async () => {
    const f = fixture(name, args);
    f.member(operation);
    f.ready();
    const html = await f.render();
    assert.match(html, /is-expanded[^>]*tool-call-card/);
    assert.match(html, /tool-diff-view/);
    assert.match(html, /src\/example\.ts/);
    assert.match(html, /tool-diff-line-number[^>]*>20</);
    assert.match(html, /new value/);
    assert.match(html, /tool-call-details/);
    assert.doesNotMatch(html, /修改参数|写入参数|请求删除路径|原始参数|unused-branch-content|internal-receipt/);
    assert.equal(posted.filter(message => message.type === 'tool.diff.open').length, 0,
      'inline preview does not automatically open an editor');
  });

  await t.test('call details can still be opened explicitly', async () => {
    const f = fixture('edit', EDIT_ARGS);
    f.member(); f.ready();
    const html = await f.render({ callDetailsExpanded: true });
    assert.match(html, /修改参数/);
    assert.match(html, /原始参数/);
    assert.match(html, /unused-branch-content/);
    assert.match(html, /tool-diff-view/);
  });

  await t.test('cold, late and failed diff details retain file entries and the diff editor action', async () => {
    const f = fixture('edit', EDIT_ARGS);
    const before = reliableKernelDetailDemandSignature({ hydrate: true, callId: 'call', targets: [] });
    await f.render();
    f.member();
    const after = reliableKernelDetailDemandSignature({ hydrate: true, callId: 'call', targets: [
      { kind: 'file-change-diff', recordId: 'member' }
    ] });
    assert.notEqual(after, before, 'arrival of a member re-triggers detail demand');
    const cold = await f.render();
    assert.match(cold, /src\/example\.ts/);
    assert.match(cold, /查看差异/);
    assert.ok(f.requests.some(request => request.kind === 'file-change-diff' && request.recordId === 'member'));
    f.feed.details['file-change-diff:member'] = { status: 'error', terminalError: true, error: 'fixture error' };
    const failed = await f.render();
    assert.match(failed, /查看差异/);
    assert.match(failed, /src\/example\.ts/);
    assert.doesNotMatch(failed, /无法可靠归因|状态未知/);
    f.ready();
    assert.match(await f.render(), /new value/);
    const history = { FileChangeSet: f.feed.records.FileChangeSet, FileChangeSetMember: f.feed.records.FileChangeSetMember };
    f.feed.historyConversationId = 'conversation';
    f.feed.historyRecords = history;
    delete f.feed.records.FileChangeSet;
    delete f.feed.records.FileChangeSetMember;
    assert.match(await f.render(), /new value/, 'paged history uses the same preview');
  });

  await t.test('multiple files and empty file/directory changes stay visible without invented counts', async () => {
    for (const operation of ['create_file', 'replace_file', 'delete_file', 'create_directory', 'delete_directory_tree']) {
      const f = fixture(operation.startsWith('delete') ? 'delete' : 'write', { path: 'src/example.ts', paths: ['src/example.ts'] });
      f.member(operation); f.ready('member', '');
      f.member('replace_file', 'second-member', 'src/second.ts'); f.ready('second-member', '');
      const html = await f.render();
      assert.match(html, /src\/example\.ts/);
      assert.match(html, /src\/second\.ts/);
      assert.doesNotMatch(html, /tool-diff-file-stat is-add|tool-diff-file-stat is-delete/);
      if (operation === 'delete_directory_tree') assert.match(html, /删除目录/);
    }
  });

  await t.test('bash and shell stay collapsed with their explanation even when diffs are available', async () => {
    for (const name of ['bash', 'shell']) {
      const f = fixture(name, { mode: 'execute', command: 'node generator.mjs',
        explanation: '生成文件并检查结果', cwd: 'private-working-directory' }, {
        stdout: 'generated successfully', exitCode: 0,
        files: [{ path: 'src/example.ts', action: 'modified', diff: { text: DIFF, added: 2, removed: 1 } }]
      });
      const collapsed = await f.render();
      assert.doesNotMatch(collapsed, /is-expanded[^>]*tool-call-card|tool-diff-view|generated successfully|private-working-directory|is-preview/);
      assert.match(collapsed, /生成文件并检查结果/);
      const expanded = await f.render({ expanded: true });
      assert.match(expanded, /tool-diff-view/);
      assert.match(expanded, /generated successfully/);
      assert.match(expanded, /生成文件并检查结果/);
      assert.doesNotMatch(expanded, /private-working-directory|is-preview/);
      f.member(); f.ready();
      assert.doesNotMatch(await f.render(), /is-expanded[^>]*tool-call-card|tool-diff-view|is-preview/);
    }
  });

  await t.test('ordinary command output stays hidden until the command is expanded', async () => {
    const f = fixture('bash', { command: 'npm test', explanation: '运行测试' }, { stdout: 'tests passed', exitCode: 0 });
    const collapsed = await f.render();
    assert.match(collapsed, /运行测试/);
    assert.doesNotMatch(collapsed, /is-expanded[^>]*tool-call-card|tests passed/);
    const expanded = await f.render({ expanded: true });
    assert.match(expanded, /tests passed/);
    assert.doesNotMatch(expanded, /tool-diff-view|无法可靠归因|观察到工作区/);
    f.feed.records.ToolCallPolicySnapshot.policy.display_auto_expand = 1;
    assert.match(await f.render(), /is-expanded[^>]*tool-call-card/);
  });

  await t.test('failed edits show the error; no diff is invented from hunk arguments', async () => {
    const f = fixture('edit', EDIT_ARGS, { error: 'No matching hunk' });
    f.feed.records.ToolOutcome.outcome.status = 'failed';
    const html = await f.render();
    assert.match(html, /No matching hunk/);
    assert.doesNotMatch(html, /tool-diff-view|unused-branch-content/);
  });
});
