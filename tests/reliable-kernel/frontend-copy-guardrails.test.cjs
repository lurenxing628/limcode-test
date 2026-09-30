const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
}


test('thought cards render Markdown and merge adjacent reasoning output items', async (context) => {
  const { createWebviewSsrServer } = await import('./webview-ssr-server.mjs');
  const server = await createWebviewSsrServer();
  context.after(async () => server.close());

  const markdown = await server.ssrLoadModule('/src/components/content/markdown/markdownRenderer.ts');
  assert.equal(
    markdown.renderInlineMarkdown('**Assessing phase semantics**'),
    '<strong>Assessing phase semantics</strong>'
  );

  const softBreakSource = 'first reasoning line\nsecond reasoning line';
  const htmlFrom = (parts) => parts
    .filter((part) => part.kind === 'html')
    .map((part) => part.html)
    .join('');
  const commonmarkHtml = htmlFrom(markdown.renderMarkdownParts(softBreakSource));
  const thoughtHtml = htmlFrom(markdown.renderMarkdownParts(softBreakSource, { preserveSoftBreaks: true }));
  assert.equal(commonmarkHtml.includes('<br>'), false);
  assert.equal(thoughtHtml.includes('<br>'), true);
  assert.equal(htmlFrom(markdown.renderMarkdownParts(softBreakSource)), commonmarkHtml,
    'thought soft-break cache must not alter ordinary Markdown rendering');

  const streamingRenderer = markdown.createStreamingMarkdownPartsRenderer();
  const commonmarkStreamHtml = htmlFrom(streamingRenderer.render(softBreakSource, { streaming: true }));
  const thoughtStreamHtml = htmlFrom(streamingRenderer.render(softBreakSource, {
    streaming: true,
    preserveSoftBreaks: true
  }));
  assert.equal(commonmarkStreamHtml.includes('<br>'), false);
  assert.equal(thoughtStreamHtml.includes('<br>'), true,
    'switching one streaming renderer to thought mode must reset its prior CommonMark state');

  const thoughtView = source('webview/src/components/content/parts/ThoughtPartView.vue');
  assert.match(thoughtView, /v-html="previewHtml"/);
  assert.match(thoughtView, /<TextPartView[\s\S]*?\smarkdown(?:\s|\n)/);
  assert.match(thoughtView, /<TextPartView[\s\S]*?:text="text"[\s\S]*?:streaming="streaming"/,
    'expanded thought Markdown must consume the authoritative stream instead of reclassifying smoothed frames as final replacements');
  assert.doesNotMatch(thoughtView, /<TextPartView[\s\S]*?:text="displayedText"[\s\S]*?:show-streaming-indicator="false"/,
    'expanded thought Markdown must not smooth the already-smoothed preview stream a second time');
  assert.match(thoughtView, /preserve-soft-breaks/);
  const compressionCard = source('webview/src/components/conversation/ReliableCompressionCard.vue');
  assert.match(compressionCard, /const tokenChange = computed\(\(\) => compressionTokenChange\(\{/,
    'the saving comes from the shared Context-against-Context rule');
  assert.doesNotMatch(compressionCard, /contextBeforeTokens\.value \?\? beforeTokens\.value/,
    'an older record without a Context figure shows no saving instead of the full request (system + tools) minus the Context');
  assert.match(compressionCard, /resultSizeUncounted: resultSizeUncounted\.value/,
    'a record whose after-figure left the ciphertext summary out shows no saving');
  assert.match(compressionCard, /const beforeTokens = computed\(\(\) => positiveToken\(/,
    'a legacy 0 full-request figure from manual compression must not be shown or subtracted');
  assert.doesNotMatch(compressionCard, /Math\.max\(0, before - afterTokens\.value\)/,
    'a Context that grew must not be clamped to “节省约 0 Token”');
  assert.match(compressionCard, /`上下文增加约 \$\{formatTokenNumber\(-change\)\} Token`/,
    'a Context that grew is reported as an increase');
  assert.match(thoughtView, /props\.streaming \? '正在思考\.\.\.' : EMPTY_THOUGHT_LABEL/,
    'a finished thought without text (signature only) must not keep saying it is still thinking');
  assert.doesNotMatch(thoughtView, /<pre>\{\{ displayedText \}\}<\/pre>/);

  const previousWindow = globalThis.window;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {}
  };
  context.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });

  const { toRenderNodes } = await server.ssrLoadModule('/src/components/content/partRegistry.ts');
  const thought = (id, text) => ({
    text,
    thought: true,
    outputItem: { id, type: 'reasoning' }
  });
  const text = (id, value) => ({
    text: value,
    outputItem: { id, type: 'message' }
  });

  const merged = toRenderNodes([
    thought('reasoning-1', '**Analyzing context**'),
    thought('reasoning-2', '**Inspecting implementation**')
  ]);
  const single = toRenderNodes([thought('reasoning-1', '**Analyzing context**')]);
  assert.deepEqual(merged.map((node) => node.kind), ['thought']);
  assert.equal(merged[0].props.text, '**Analyzing context**\n**Inspecting implementation**');
  assert.equal(merged[0].key, single[0].key,
    'appending an adjacent reasoning item must preserve the thought component and its expanded state');

  const splitTextItems = toRenderNodes([text('message-1', 'first'), text('message-2', 'second')]);
  assert.deepEqual(splitTextItems.map((node) => node.kind), ['text', 'text']);

  const visibleTextBoundary = toRenderNodes([
    thought('reasoning-1', 'before text'),
    text('message-1', 'visible'),
    thought('reasoning-2', 'after text')
  ]);
  assert.deepEqual(visibleTextBoundary.map((node) => node.kind), ['thought', 'text', 'thought']);

  const toolBoundary = toRenderNodes([
    thought('reasoning-1', 'before tool'),
    { id: 'tool-1', functionCall: { name: 'read', args: {} } },
    thought('reasoning-2', 'after tool')
  ]);
  assert.deepEqual(toolBoundary.map((node) => node.kind), ['thought', 'functionCall', 'thought']);
});

async function createViteServer(context) {
  const { createWebviewSsrServer } = await import('./webview-ssr-server.mjs');
  const server = await createWebviewSsrServer();
  context.after(async () => server.close());
  return server;
}

function ready(text) {
  return { status: 'ready', text, nextOffset: Buffer.byteLength(text), complete: true };
}

test('retry源消息软删除后，transient输出锚定到上一条可见消息', async (context) => {
  const server = await createViteServer(context);
  const { projectReliableConversation } = await server.ssrLoadModule(
    '/src/domain/reliableConversationProjection.ts'
  );
  const projection = projectReliableConversation({
    conversationId: 'conversation-retry-anchor',
    records: {
      Turn: {
        retry: {
          id: 'turn-retry',
          conversation_id: 'conversation-retry-anchor',
          source_message_id: 'message-deleted',
          status: 'active',
          created_at: '2026-08-18T00:00:02.000Z'
        }
      },
      Message: {
        visible: {
          id: 'message-visible',
          conversation_id: 'conversation-retry-anchor',
          message_seq: '1',
          revision_id: 'revision-visible',
          role: 'user',
          created_at: '2026-08-18T00:00:00.000Z'
        },
        deleted: {
          id: 'message-deleted',
          conversation_id: 'conversation-retry-anchor',
          message_seq: '2',
          revision_id: 'revision-deleted',
          role: 'model',
          deleted_at: '2026-08-18T00:00:02.000Z',
          created_at: '2026-08-18T00:00:01.000Z'
        }
      },
      ModelRequest: {
        retry: {
          id: 'request-retry',
          turn_id: 'turn-retry',
          request_seq: '1',
          model_id: 'gpt-retry',
          status: 'streaming',
          created_at: '2026-08-18T00:00:02.100Z'
        }
      }
    },
    details: {
      'message-content:revision-visible': ready(JSON.stringify({
        role: 'user',
        parts: [{ text: '保留的问题' }]
      }))
    },
    transientModelRequests: {
      retry: {
        conversationId: 'conversation-retry-anchor',
        turnId: 'turn-retry',
        modelRequestId: 'request-retry',
        requestSeq: '1',
        providerId: 'provider-retry',
        modelId: 'gpt-retry',
        streamSeq: '1',
        text: '新的回答',
        thought: '',
        outputParts: [{ text: '新的回答' }],
        toolCalls: [],
        status: 'streaming',
        startedAt: Date.parse('2026-08-18T00:00:02.100Z'),
        updatedAt: Date.parse('2026-08-18T00:00:02.200Z')
      }
    }
  });

  assert.deepEqual(projection.messages.map((message) => message.id), [
    'message-visible',
    'transient:request-retry'
  ]);
  assert.equal(projection.messages[1].seq, 1.5);
  assert.equal(projection.messages[1].content.parts[0].text, '新的回答');
});

test('retry只有sourceTurn来源时，首个thought transient仍锚定到会话末尾', async (context) => {
  const server = await createViteServer(context);
  const { projectReliableConversation } = await server.ssrLoadModule(
    '/src/domain/reliableConversationProjection.ts'
  );
  const { hasVisibleStreamingTransientForTurn } = await server.ssrLoadModule(
    '/src/domain/reliableTransientActivity.ts'
  );
  const transientModelRequests = {
    retry: {
      conversationId: 'conversation-source-turn-retry',
      turnId: 'turn-retry',
      modelRequestId: 'request-retry',
      requestSeq: '1',
      providerId: 'provider-retry',
      modelId: 'gpt-retry',
      streamSeq: '1',
      text: '',
      thought: '**Planning Linux reproduction with Docker**',
      thoughtActive: true,
      outputParts: [{
        text: '**Planning Linux reproduction with Docker**',
        thought: true,
        outputItem: { id: 'reasoning-1', ordinal: 0 }
      }],
      toolCalls: [],
      status: 'streaming',
      startedAt: Date.parse('2026-08-19T04:31:04.682Z'),
      updatedAt: Date.parse('2026-08-19T04:31:04.715Z')
    }
  };
  const projection = projectReliableConversation({
    conversationId: 'conversation-source-turn-retry',
    records: {
      Turn: {
        source: {
          id: 'turn-source',
          conversation_id: 'conversation-source-turn-retry',
          status: 'terminated',
          created_at: '2026-08-19T04:30:00.000Z'
        },
        // Runtime retry intent has sourceTurnId only; its projected Turn has no source_message_id.
        retry: {
          id: 'turn-retry',
          conversation_id: 'conversation-source-turn-retry',
          status: 'active',
          created_at: '2026-08-19T04:30:55.277Z'
        }
      },
      Message: {
        tail: {
          id: 'message-source-tail',
          conversation_id: 'conversation-source-turn-retry',
          message_seq: '133',
          revision_id: 'revision-source-tail',
          role: 'model',
          created_at: '2026-08-19T04:30:35.636Z'
        }
      },
      MessageTurnLink: {
        tail: {
          id: 'message-turn-source-tail',
          message_id: 'message-source-tail',
          turn_id: 'turn-source',
          role: 'model',
          created_at: '2026-08-19T04:30:35.636Z'
        }
      },
      ModelRequest: {
        retry: {
          id: 'request-retry',
          turn_id: 'turn-retry',
          request_seq: '1',
          model_id: 'gpt-retry',
          status: 'streaming',
          created_at: '2026-08-19T04:30:55.748Z'
        }
      }
    },
    details: {
      'message-content:revision-source-tail': ready(JSON.stringify({
        role: 'model',
        parts: [{ text: '上一回合输出' }]
      }))
    },
    transientModelRequests
  });

  assert.deepEqual(projection.messages.map((message) => message.id), [
    'message-source-tail',
    'transient:request-retry'
  ]);
  assert.equal(projection.messages[1].seq, 133.5);
  assert.equal(projection.messages[1].content.parts[0].thought, true);
  assert.equal(
    projection.messages[1].content.parts[0].text,
    '**Planning Linux reproduction with Docker**'
  );
  assert.equal(hasVisibleStreamingTransientForTurn(
    transientModelRequests,
    'turn-retry',
    new Set(['request-retry'])
  ), true);
});

test('长流积压达到阈值时直刷，terminal时立即显示完整文本', async (context) => {
  const server = await createViteServer(context);
  const vue = await import('vue');
  const { useSmoothStreamingText } = await server.ssrLoadModule(
    '/src/components/content/useSmoothStreamingText.ts'
  );

  const frames = new Map();
  let nextFrameId = 1;
  const previousWindow = globalThis.window;
  globalThis.window = {
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis)
  };

  const renderer = vue.createRenderer({
    patchProp() {},
    insert() {},
    remove() {},
    createElement() { return {}; },
    createText() { return {}; },
    createComment() { return {}; },
    setText() {},
    setElementText() {},
    parentNode() { return null; },
    nextSibling() { return null; },
    querySelector() { return null; },
    setScopeId() {},
    cloneNode(node) { return node; },
    insertStaticContent() { return [{}, {}]; }
  });
  const source = vue.ref('a');
  const streaming = vue.ref(true);
  let smooth;
  const app = renderer.createApp(vue.defineComponent({
    setup() {
      smooth = useSmoothStreamingText(
        () => source.value,
        () => streaming.value,
        { animateReplace: true, flushLagChars: 2_048 }
      );
      return () => null;
    }
  }));
  app.mount({});
  context.after(() => {
    app.unmount();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });

  const runFrames = () => {
    let now = performance.now();
    while (frames.size > 0) {
      const batch = [...frames.values()];
      frames.clear();
      now += 16;
      for (const callback of batch) callback(now);
    }
  };

  await vue.nextTick();
  runFrames();
  assert.equal(smooth.displayedText.value, 'a');

  const burst = `a${'x'.repeat(2_048)}`;
  source.value = burst;
  await vue.nextTick();
  assert.equal(smooth.displayedText.value, burst, '大积压应在watch同步阶段直接刷新');
  assert.equal(frames.size, 0);

  const terminalTarget = `${burst}${'tail'.repeat(100)}`;
  source.value = terminalTarget;
  await vue.nextTick();
  assert.equal(smooth.displayedText.value, burst, '小积压在流中仍保留平滑输出');
  assert.equal(smooth.replacing.value, false, '活动流只能追加正文，不能进入会把展开内容淡出的最终替换动画');
  assert.ok(frames.size > 0);

  streaming.value = false;
  await vue.nextTick();
  assert.equal(smooth.displayedText.value, terminalTarget, 'terminal切换必须立即同步完整文本');
  assert.equal(smooth.replacing.value, false, '流式结束不能把思考正文淡出');
  assert.equal(frames.size, 0, 'terminal切换必须取消未执行的追赶帧');

  const textPartSource = fs.readFileSync(
    path.join(ROOT, 'webview/src/components/content/parts/TextPartView.vue'),
    'utf8'
  );
  assert.match(textPartSource, /\{ animateReplace: true, flushLagChars: 2_048 \}/);
});

test('long streamed Markdown keeps code-viewer state at terminal while historical bodies still defer', async (context) => {
  const server = await createViteServer(context);
  const vue = await import('vue');
  const pinia = await import('pinia');
  const previousWindow = globalThis.window;
  const previousPinia = pinia.getActivePinia();
  const frames = new Map();
  let nextFrameId = 0;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame(callback) { const id = ++nextFrameId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout, clearTimeout,
    acquireVsCodeApi() { return { postMessage() {}, getState() { return {}; }, setState() {} }; }
  };
  const apps = [];
  context.after(() => {
    for (const app of apps.reverse()) app.unmount();
    pinia.setActivePinia(previousPinia);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const { default: TextPart } = await server.ssrLoadModule('/src/components/content/parts/TextPartView.vue');
  const renderer = vue.createRenderer({
    patchProp() {}, insert() {}, remove() {},
    createElement() { return {}; }, createText() { return {}; }, createComment() { return {}; },
    setText() {}, setElementText() {}, parentNode() { return null; }, nextSibling() { return null; },
    querySelector() { return null; }, setScopeId() {}, cloneNode(node) { return node; },
    insertStaticContent() { return [{}, {}]; }
  });
  const mountPart = (props) => {
    const viewers = [];
    let state;
    // The production parser and keys drive a stateful child probe. A gap in renderedParts
    // unmounts it, just as the production template unmounts CodeBlockViewer for its plain fallback.
    const Viewer = vue.defineComponent({
      props: ['code'],
      setup(viewerProps) {
        const viewer = { props: viewerProps, softWrap: vue.ref(true), scrollTop: vue.ref(0), unmounted: false };
        vue.onBeforeUnmount(() => { viewer.unmounted = true; });
        viewers.push(viewer);
        return () => null;
      }
    });
    const app = renderer.createApp(vue.defineComponent({
      setup() {
        state = TextPart.setup(props, { expose() {} });
        return () => vue.h('div', state.keyedRenderedParts.value.map(({ part, key }) => part.kind === 'code'
          ? vue.h(Viewer, { key, code: part.code })
          : vue.h('span', { key })));
      }
    })).use(pinia.createPinia());
    app.provide(vue.ssrContextKey, { modules: new Set() });
    apps.push(app);
    app.mount({});
    return { state, viewers };
  };
  const body = '```js\n' + 'const value = 1;\n'.repeat(2000);
  const props = vue.reactive({ text: body, streaming: true, streamingPhase: 'writing',
    showStreamingIndicator: false, markdown: true, preserveSoftBreaks: false });
  const live = mountPart(props);
  assert.deepEqual(live.state.renderedParts.value.map(part => part.kind), ['code']);
  assert.equal(live.viewers.length, 1);
  const viewer = live.viewers[0];
  viewer.softWrap.value = false;
  viewer.scrollTop.value = 5006;
  props.text += '// final bytes\n```';
  await vue.nextTick();
  props.streaming = false;
  await vue.nextTick();
  assert.deepEqual(live.state.renderedParts.value.map(part => part.kind), ['code']);
  assert.equal(live.viewers.length, 1, 'terminal must not replace the existing code-viewer instance');
  assert.equal(viewer.softWrap.value, false);
  assert.equal(viewer.scrollTop.value, 5006);
  assert.match(viewer.props.code, /final bytes/, 'terminal flush includes the final unsmoothed bytes');
  assert.equal(frames.size, 0, 'an already rendered stream needs no historical fallback frames');

  // Streaming commits the HTML prefix in separate batches, while terminal parsing merges it.
  // Exercise Vue's child reconciliation, not just the parser's array, so a remount loses state.
  const prefixedProps = vue.reactive({ ...props, streaming: true,
    text: 'First paragraph\n\nSecond paragraph ' + 'x'.repeat(2_048) });
  const prefixed = mountPart(prefixedProps);
  prefixedProps.text += '\n\n```js\n' + 'const prefixed = 1;\n'.repeat(2_000);
  await vue.nextTick();
  assert.deepEqual(prefixed.state.renderedParts.value.map(part => part.kind), ['html', 'html', 'code']);
  assert.equal(prefixed.viewers.length, 1);
  const prefixedViewer = prefixed.viewers[0];
  prefixedViewer.softWrap.value = false;
  prefixedViewer.scrollTop.value = 5006;
  prefixedProps.text += '// final bytes\n```';
  await vue.nextTick();
  prefixedProps.streaming = false;
  await vue.nextTick();
  assert.deepEqual(prefixed.state.renderedParts.value.map(part => part.kind), ['html', 'code']);
  assert.equal(prefixed.viewers.length, 1, 'combining HTML fragments must preserve the code-viewer instance');
  assert.equal(prefixedViewer.unmounted, false);
  assert.equal(prefixedViewer.softWrap.value, false);
  assert.equal(prefixedViewer.scrollTop.value, 5006);
  assert.match(prefixedViewer.props.code, /final bytes/);

  const multiProps = vue.reactive({ ...props, streaming: true,
    text: 'P1 ' + 'a'.repeat(2_048) + '\n\nP2 ' + 'b'.repeat(2_048) });
  const multi = mountPart(multiProps);
  multiProps.text += '\n\nP3 ' + 'c'.repeat(2_048);
  await vue.nextTick();
  multiProps.text += '\n\n```js\n' + 'const first = 1;\n'.repeat(2_000)
    + '```\n\nBetween codes\n\n```js\nsecond();\n';
  await vue.nextTick();
  assert.deepEqual(multi.state.renderedParts.value.map(part => part.kind),
    ['html', 'html', 'html', 'code', 'html', 'code']);
  assert.equal(multi.viewers.length, 2);
  const [firstViewer, secondViewer] = multi.viewers;
  firstViewer.softWrap.value = false;
  firstViewer.scrollTop.value = 5006;
  secondViewer.scrollTop.value = 8008;
  multiProps.text += '```';
  await vue.nextTick();
  multiProps.streaming = false;
  await vue.nextTick();
  assert.deepEqual(multi.state.renderedParts.value.map(part => part.kind), ['html', 'code', 'html', 'code']);
  assert.equal(multi.viewers.length, 2, 'terminal parsing must not create or exchange either code viewer');
  assert.equal(firstViewer.unmounted, false);
  assert.equal(secondViewer.unmounted, false);
  assert.match(firstViewer.props.code, /const first = 1;/, 'the first instance must still own the first code');
  assert.doesNotMatch(firstViewer.props.code, /second\(\);/);
  assert.match(secondViewer.props.code, /second\(\);/, 'the second instance must still own the second code');
  assert.equal(firstViewer.softWrap.value, false);
  assert.equal(firstViewer.scrollTop.value, 5006);
  assert.equal(secondViewer.scrollTop.value, 8008);
  assert.equal(frames.size, 0);

  const history = mountPart(vue.reactive({ ...props, text: body + '```', streaming: false }));
  assert.deepEqual(history.state.renderedParts.value, []);
  assert.equal(history.viewers.length, 0);
  const runFrame = async () => {
    const batch = [...frames.values()]; frames.clear();
    for (const callback of batch) callback(performance.now());
    await vue.nextTick();
  };
  await runFrame();
  assert.deepEqual(history.state.renderedParts.value, [], 'pure history still paints plain text for its first frame');
  await runFrame();
  assert.deepEqual(history.state.renderedParts.value.map(part => part.kind), ['code']);
  assert.equal(history.viewers.length, 1, 'pure history renders its code viewer after the deferred parse');
});

test('failure without assistant output keeps an exact eligible request retry and never invents a Message', async (context) => {
  const server = await createViteServer(context);
  const { projectReliableConversation, modelRequestRetryForTurn, projectReliableTurnTermination } = await server.ssrLoadModule('/src/domain/reliableConversationProjection.ts');
  const records = {
    Turn: { turn: { id: 'turn', conversation_id: 'conversation', status: 'terminated' } },
    TurnTermination: { terminal: { id: 'terminal', turn_id: 'turn', terminal_status: 'failed', reason: '已用完 8 次自动重试：503', created_at: 10 } },
    Message: { user: { id: 'user', conversation_id: 'conversation', revision_id: 'revision', role: 'user', message_seq: '1', created_at: 1 } },
    MessageTurnLink: { link: { id: 'link', message_id: 'user', turn_id: 'turn', role: 'source' } },
    ModelRequest: { request: { id: 'request', turn_id: 'turn', request_seq: '1', status: 'terminal', terminal_state: 'provider_transient_temporary_service_error' } },
    ModelContextProjection: { projection: { id: 'projection', owner_kind: 'model_request', owner_id: 'request', root_id: 'root' } },
    ConversationContextStatus: { head: { id: 'head', conversation_id: 'conversation', root_id: 'root' } }
  };
  const projected = projectReliableConversation({ conversationId: 'conversation', records, details: { 'message-content:revision': ready(JSON.stringify({ role: 'user', parts: [{ text: 'hello' }] })) } });
  assert.deepEqual(projected.messages.map(message => message.role), ['user']);
  assert.equal(projected.terminationByMessageId.user.detail, '已用完 8 次自动重试：503');
  const retry = () => modelRequestRetryForTurn(records, 'conversation', 'turn');
  assert.deepEqual(retry().target, { kind: 'model_request', modelRequestId: 'request' });
  for (const terminal of ['completed', 'cancelled', 'native_chain_rebased']) {
    records.ModelRequest.request.terminal_state = terminal;
    assert.equal(retry().target, undefined, terminal);
  }
  records.ModelRequest.request.terminal_state = 'provider_failed';
  records.TurnTermination.terminal.terminal_status = 'interrupted';
  assert.equal(retry().target, undefined, 'a user stop is not a failed request');
  records.TurnTermination.terminal.terminal_status = 'failed';
  records.Turn.newer = { id: 'newer', conversation_id: 'conversation', status: 'active' };
  assert.equal(retry().target, undefined, 'new work cannot be stopped by a stale failure retry');
  delete records.Turn.newer;
  records.ConversationContextStatus.head.root_id = 'newer-root';
  assert.equal(retry().target, undefined, 'old requests cannot rewind newer context');
  records.ConversationContextStatus.head.root_id = 'root';
  records.ModelRequest.newer = { ...records.ModelRequest.request, id: 'newer', request_seq: '2' };
  assert.equal(retry().target, undefined, 'missing latest request projection fails closed');
  records.ModelContextProjection.newer = { ...records.ModelContextProjection.projection, id: 'projection-newer', owner_id: 'newer' };
  assert.equal(retry().target.modelRequestId, 'newer');
  assert.equal(projectReliableTurnTermination(records.TurnTermination.terminal, records).runId, 'turn', 'retry Turns without user Messages keep the durable identity');

  const row = (await server.ssrLoadModule('/src/components/conversation/ReliableTurnTerminationRow.vue')).default;
  const vue = await import('vue');
  const props = vue.reactive({ termination: projected.terminationByMessageId.user, retryModelRequestId: 'request', retryPending: false });
  const events = [];
  const app = vue.createSSRApp({});
  app.provide(vue.ssrContextKey, { modules: new Set() });
  const scope = vue.effectScope();
  context.after(() => scope.stop());
  const state = app.runWithContext(() => scope.run(() => row.setup(props, { emit: (...event) => events.push(event), expose() {} })));
  state.confirmingRequestId.value = 'request';
  const refreshed = projectReliableConversation({ conversationId: 'conversation', records, details: {
    'message-content:revision': ready(JSON.stringify({ role: 'user', parts: [{ text: 'hydrated user input' }] }))
  } });
  assert.notStrictEqual(refreshed.terminationByMessageId.user, props.termination);
  props.termination = refreshed.terminationByMessageId.user;
  await vue.nextTick();
  assert.equal(state.confirmingRequestId.value, 'request', 'detail hydration must preserve confirmation for the same durable failure');
  props.termination = { ...props.termination, detail: 'refreshed failure presentation' };
  await vue.nextTick();
  assert.equal(state.confirmingRequestId.value, 'request', 'presentation-only refresh must not cancel the selected retry');
  state.confirmRetry(); state.confirmRetry();
  assert.deepEqual(events, [['retry', 'request']], 'double confirmation can submit only the captured exact request once');
  state.confirmingRequestId.value = 'request'; props.retryModelRequestId = 'newer';
  state.confirmRetry();
  assert.equal(events.length, 1, 'a stale confirmation cannot silently switch targets');
  await vue.nextTick();
  const closesConfirmation = async (change, message) => {
    state.confirmingRequestId.value = 'newer';
    change();
    await vue.nextTick();
    assert.equal(state.confirmingRequestId.value, undefined, message);
  };
  await closesConfirmation(() => { props.retryModelRequestId = 'latest'; }, 'a different request closes the old confirmation');
  props.retryModelRequestId = 'newer'; await vue.nextTick();
  await closesConfirmation(() => { props.termination = { ...props.termination, id: 'different-termination' }; }, 'a different durable failure closes confirmation');
  await closesConfirmation(() => { props.termination = { ...props.termination, kind: 'interrupted' }; }, 'a changed termination status closes confirmation');
  await closesConfirmation(() => { props.retryBlockedReason = 'context changed'; }, 'lost retry eligibility closes confirmation');
  props.retryBlockedReason = undefined; await vue.nextTick();
  await closesConfirmation(() => { props.retryPending = true; }, 'a pending retry closes confirmation');
  state.confirmingRequestId.value = 'newer'; props.retryPending = true; state.confirmRetry();
  assert.equal(events.length, 1, 'pending retry remains locked');
  assert.match(source('webview/src/components/conversation/ReliableMessageList.vue'), /if \(conversationActionPending\.value\) return;/);
});

test('retry countdown ticks reactively to its deadline and stops replacement or detached timers', async (context) => {
  const server = await createViteServer(context);
  const { createReliableRetryClock } = await server.ssrLoadModule('/src/domain/reliableTransientActivity.ts');
  const { ref, computed } = await import('vue');
  let now = 1000, id = 0;
  const timers = new Map(); const observed = ref(now);
  const clock = createReliableRetryClock(value => { observed.value = value; }, {
    now: () => now, schedule: (callback, delay) => { timers.set(++id, { callback, delay }); return id; }, cancel: handle => timers.delete(handle)
  });
  const remaining = computed(() => Math.max(0, Math.ceil((4000 - observed.value) / 1000)));
  const tick = () => { const [key, item] = timers.entries().next().value; timers.delete(key); now += item.delay; item.callback(); };
  clock.start(4000); assert.equal(remaining.value, 3);
  tick(); assert.equal(remaining.value, 2); tick(); assert.equal(remaining.value, 1); tick(); assert.equal(remaining.value, 0);
  assert.equal(timers.size, 0, 'deadline ends the countdown without continuous polling');
  clock.start(10000); const stale = [...timers.values()][0].callback;
  clock.start(5000); assert.equal(timers.size, 1, 'replacement has one timer');
  stale(); assert.equal(timers.size, 1, 'late replaced callback is inert');
  clock.stop(); assert.equal(timers.size, 0);
  stale(); assert.equal(timers.size, 0, 'unmounted or cancelled callback cannot restart itself');
  const list = source('webview/src/components/conversation/ReliableMessageList.vue');
  assert.match(list, /request\?\.status === 'retrying' && !hasLaterSegment\.value/);
  assert.match(list, /else retryClock\.stop\(\)/);
  assert.match(list, /onBeforeUnmount\(\(\) => retryClock\.stop\(\)\)/);
  assert.match(list, /modelRequestRetryState\(latest, retryNow\.value\)/);
});

test('retry settings show the runtime ceiling and preserve explicit user retry budgets', async (context) => {
  const server = await createViteServer(context);
  const protocol = await server.ssrLoadModule('/@fs/' + path.join(ROOT, 'shared/protocol.ts'));
  assert.equal(protocol.DEFAULT_LLM_RETRY_MAX_ATTEMPTS, 8);
  assert.equal(protocol.normalizeLlmRetryMaxAttempts(undefined), undefined);
  for (const count of [0, 1, 4, 8, 10]) assert.equal(protocol.normalizeLlmRetryMaxAttempts(count), count);
  assert.equal(protocol.normalizeLlmRetryMaxAttempts(-1), 10);
  assert.equal(protocol.normalizeLlmRetryMaxAttempts(999), 10);
  const settings = source('webview/src/components/settings/global/LlmAdvancedConfigEditor.vue');
  assert.doesNotMatch(settings, /无限重试/);
  assert.match(settings, /min="0"/); assert.match(settings, /:max="MAX_RELIABLE_PROVIDER_RETRY_ATTEMPTS"/);
  assert.match(settings, /不包含原始请求/);
});

test('actual message list renders safe retries for anchored and message-less failures', async (context) => {
  const pinia = await import('pinia');
  const { createSSRApp, nextTick } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, atob,
    requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 0); },
    cancelAnimationFrame: clearTimeout,
    acquireVsCodeApi() { return { postMessage() {}, getState() { return {}; }, setState() {} }; }
  };
  context.after(() => {
    pinia.setActivePinia(previousPinia);
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  });
  const server = await createViteServer(context);
  const { default: MessageList } = await server.ssrLoadModule('/src/components/conversation/ReliableMessageList.vue');
  const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
  globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
  const isolated = pinia.createPinia();
  pinia.setActivePinia(isolated);
  const feed = useReliableKernelClientFeedStore();
  feed.projections.activeConversationWindow = { conversationId: 'retry-render' };
  feed.records = {
    Turn: { turn: { id: 'turn', conversation_id: 'retry-render', status: 'terminated' } },
    TurnTermination: { failure: { id: 'failure', turn_id: 'turn', terminal_status: 'failed',
      reason: 'Provider retries exhausted: fixture 503', created_at: '2026-09-30T00:00:00.000Z' } },
    ModelRequest: { request: { id: 'request', turn_id: 'turn', request_seq: '1',
      status: 'terminal', terminal_state: 'provider_transient_temporary_service_error' } },
    ModelContextProjection: { projection: { id: 'projection', owner_kind: 'model_request',
      owner_id: 'request', root_id: 'root' } },
    ConversationContextStatus: { head: { id: 'head', conversation_id: 'retry-render', root_id: 'root' } },
    Message: {}, MessageTurnLink: {}
  };
  const warnings = [];
  const render = async () => {
    const app = createSSRApp(MessageList, {}).use(isolated);
    app.config.warnHandler = message => warnings.push(message);
    return renderToString(app);
  };
  const retryButtons = html => (html.match(/aria-label="重试本轮模型请求"/g) ?? []).length;
  let html = await render();
  assert.equal(retryButtons(html), 1, 'a retry Turn without a Message still has one recovery entry');
  assert.match(html, /Provider retries exhausted: fixture 503/);
  assert.doesNotMatch(html, /还没有消息，发一条试试/, 'failure rows replace the misleading empty-conversation hint');

  feed.records.Message = { user: { id: 'user', conversation_id: 'retry-render', revision_id: 'revision',
    role: 'user', message_seq: '1', created_at: '2026-09-29T23:59:00.000Z' } };
  feed.records.MessageTurnLink = { link: { id: 'link', message_id: 'user', turn_id: 'turn', role: 'source' } };
  await nextTick();
  html = await render();
  assert.equal(retryButtons(html), 1, 'the user-anchored path does not duplicate the failure retry');

  feed.records.ConversationContextStatus.head.root_id = 'newer-root';
  await nextTick();
  html = await render();
  assert.equal(retryButtons(html), 0, 'a stale root never renders an actionable retry');
  assert.match(html, /上下文已改变/);
  feed.records.ConversationContextStatus.head.root_id = 'root';
  feed.records.Turn.newer = { id: 'newer', conversation_id: 'retry-render', status: 'active' };
  await nextTick();
  assert.equal(retryButtons(await render()), 0, 'an older failure cannot retry over a newer active Turn');
  delete feed.records.Turn.newer;
  feed.records.TurnTermination.failure.terminal_status = 'interrupted';
  await nextTick();
  assert.equal(retryButtons(await render()), 0, 'user cancellation does not become a failed-request retry');
  assert.deepEqual(warnings, [], 'the actual component tree has no undeclared-prop or lifecycle warnings');
});


test('provider context overflow compression has an explicit trigger label', async (context) => {
  const server = await createViteServer(context);
  const { parseReliableCompressionRequestPurpose } = await server.ssrLoadModule('/src/domain/reliableCompressionProjection.ts');
  const purpose = parseReliableCompressionRequestPurpose(JSON.stringify({
    kind: 'context_compression', trigger: 'auto', requestKind: 'context_compression_pre',
    blockId: 'block', methodKind: 'llm_summary', sourceSegmentCount: 4, triggerReason: 'provider_context_overflow'
  }));
  assert.equal(purpose.triggerReason, 'provider_context_overflow');
  assert.match(source('webview/src/components/conversation/ReliableCompressionCard.vue'), /provider_context_overflow.*模型上下文超限后压缩/);
});
