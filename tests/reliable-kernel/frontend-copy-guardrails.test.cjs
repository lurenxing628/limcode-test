const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
}


test('渠道保存请求不制造脱离本地状态的 updatedAt', () => {
  const store = source('webview/src/stores/useGlobalSettingsStore.ts');
  const saveMethod = store.match(/saveLlmProviderConfigs\(\): void \{[\s\S]*?\n    \},\n    queueLlmCompressionConfigsAutoSave/)?.[0];

  assert.ok(saveMethod, 'saveLlmProviderConfigs source is missing');
  assert.doesNotMatch(saveMethod, /updatedAt:\s*Date\.now\(\)/);
});

test('guidance queue uses a passive bolt and waits for the current response and tools', () => {
  const queue = source('webview/src/components/input/ReliableQueuePanel.vue');

  assert.match(queue, /IconBolt class="reliable-queue-guide-icon"/);
  assert.match(queue, /引导消息/);
  assert.match(queue, /等待当前回复和工具完成/);
  assert.match(queue, /IconPencil/);
  assert.match(queue, /IconTrash/);
  assert.match(queue, /IconGripVertical/);
  assert.match(queue, /IconPlayerPause/);
  assert.match(queue, /editGuidance/);
  assert.match(queue, /cancelGuidance/);
  assert.match(queue, /reorderGuidance/);
  assert.match(queue, /setGuidancePaused/);
  assert.doesNotMatch(queue, /force-send|promoteTurnIntent|立即执行/);
});


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
  assert.match(compressionCard, /const before = contextBeforeTokens\.value \?\? beforeTokens\.value;/,
    'the saving compares Context with Context, never the full request (system + tools) with the Context');
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
