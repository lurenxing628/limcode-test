import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { projectionDatabase, projection } from './ui-history-fixture.mjs';
import { createBehaviorRuntime } from './fixtures/runtime-behavior-fixture.mjs';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = (file) => require(path.join(compiled, file));

const kernel = load('backend/reliableKernel/index.js');
const {
  createLlmProviderCapability,
  planCompressionSummaryCalls
} = load('backend/capabilities/llmProvider.js');
const {
  projectSummaryModelSegments,
  projectSummaryModelWindow,
  withSummaryDispatchRefs
} = load('backend/reliableKernel/modelFacingContextProjection.js');
const { estimateTextTokens } = load('backend/reliableKernel/modelTokenEstimator.js');
const { applyReliableKernelDataMessage, createEmptyReliableKernelClientState } = load('shared/reliableKernelClientFeed.js');

function summaryProviderSettings(baseUrl, contextWindowTokens = 65_536) {
  return {
    id: 'perf-summary-provider',
    name: 'Perf Summary Provider',
    provider: 'openai-compatible',
    baseUrl,
    model: 'summary-model',
    models: [{ id: 'summary-model', name: 'summary-model' }],
    apiKey: 'dummy-key',
    toolCallFormat: 'function-call',
    openaiResponsesTransport: 'http',
    stream: false,
    retryOnError: false,
    retryForceAllErrors: false,
    retryMaxAttempts: 0,
    retryDelaySeconds: 0,
    enableMultimodalTools: true,
    contextWindowTokens,
    systemPromptPrefix: '',
    promptCache: { enabled: false, mode: 'key', ttl: '30m' },
    modelConfigs: [],
    createdAt: 1,
    updatedAt: 1
  };
}

async function withMockChatServer(responder, run) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    requests.push({ url: req.url, body, text: JSON.stringify(body) });
    const content = await responder(body, requests.length);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl-${requests.length}`,
      object: 'chat.completion',
      created: 1,
      model: 'summary-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 }
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    await run(baseUrl, requests);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runCompact(settings, request) {
  const capability = createLlmProviderCapability({
    settings: async () => settings,
    compressionSettings: async () => undefined
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Compact timed out')), 10_000);
      capability.compact(request, (event) => {
        if (event.type !== 'llm:compactDone' && event.type !== 'llm:compactError') return;
        clearTimeout(timer);
        resolve(event);
      });
    });
  } finally {
    capability.dispose();
  }
}

test('单窗口容纳旧摘要与新增片段时 segmented_summary 单通完成，不再额外发起二次合并请求', async () => {
  const methodConfig = {
    id: 'seg-single-pass',
    name: '分段摘要单通快径',
    kind: 'segmented_summary',
    trigger: { mode: 'manual' },
    llmSummary: { targetTokens: 1_200, reasoning: { mode: 'provider_default' } },
    createdAt: 1,
    updatedAt: 1
  };
  const request = {
    id: 'compact-single-pass',
    blockId: 'block-single-pass',
    conversationId: 'conv-single-pass',
    methodKind: 'segmented_summary',
    methodConfigSnapshot: methodConfig,
    priorSummaryContents: [{
      role: 'user',
      parts: [{ text: '[Context Summary]\n\n目标\n- 保持旧摘要锚点 OLD_ANCHOR_99\n\n下一步\n- 继续优化查询' }]
    }],
    contents: [{ role: 'user', parts: [{ text: '新增变更 DELTA_MARKER_77' }] }],
    segments: [[{ role: 'user', parts: [{ text: '新增变更 DELTA_MARKER_77' }] }]]
  };

  const plan = planCompressionSummaryCalls(request, { contextWindowTokens: 65_536 });
  assert.deepEqual(plan, { summaryCalls: 1, mergeCalls: 0 });

  await withMockChatServer(
    () => [
      '<analysis>先核对旧摘要与新增记录，确认只需保留最新状态。</analysis>',
      '<summary>',
      'Goal',
      '- Preserve OLD_ANCHOR_99 and apply DELTA_MARKER_77',
      '',
      'Constraints & Key Decisions',
      '- Epoch 7 schema remains frozen',
      '',
      'Work Status',
      '  - In Progress',
      '    - Updating compression single-pass path',
      '',
      'Next Steps',
      '- Run verification suite',
      '</summary>'
    ].join('\n'),
    async (baseUrl, requests) => {
      const settings = summaryProviderSettings(baseUrl, 65_536);
      const event = await runCompact(settings, {
        ...request,
        contents: [
          ...request.contents,
          {
            role: 'model',
            parts: [{
              functionCall: {
                name: 'edit_file',
                args: { filePath: 'backend/capabilities/llmProvider.ts' }
              }
            }]
          }
        ],
        segments: [[
          ...request.contents,
          {
            role: 'model',
            parts: [{
              functionCall: {
                name: 'edit_file',
                args: { filePath: 'backend/capabilities/llmProvider.ts' }
              }
            }]
          }
        ]]
      });
      assert.equal(event.type, 'llm:compactDone');
      assert.equal(requests.length, 1, 'single-window segmented_summary with priorSummary should issue 1 LLM call');
      const outputText = event.payload.result.contents[0].parts[0].text;
      assert.doesNotMatch(outputText, /<analysis>/, '<analysis> scratchpad must be stripped');
      assert.match(outputText, /OLD_ANCHOR_99/);
      assert.match(outputText, /DELTA_MARKER_77/);
      assert.match(outputText, /backend\/capabilities\/llmProvider\.ts/, 'omitted files section should retain touched file paths');
    }
  );
});

test('模型纯拒答文本仍回退到确定性摘要，不把拒答话术写入压缩结果', async () => {
  const methodConfig = {
    id: 'llm-refusal-fallback',
    name: '拒答回退校验',
    kind: 'llm_summary',
    trigger: { mode: 'manual' },
    llmSummary: { targetTokens: 1_000, reasoning: { mode: 'provider_default' } },
    createdAt: 1,
    updatedAt: 1
  };
  await withMockChatServer(
    () => 'Sorry, I cannot assist with summarizing this transcript.',
    async (baseUrl, requests) => {
      const event = await runCompact(summaryProviderSettings(baseUrl), {
        id: 'compact-refusal',
        blockId: 'block-refusal',
        conversationId: 'conv-refusal',
        methodKind: 'llm_summary',
        methodConfigSnapshot: methodConfig,
        contents: [{ role: 'user', parts: [{ text: '必须保留 EXACT_FALLBACK_FACT_404' }] }]
      });
      assert.equal(event.type, 'llm:compactDone');
      assert.equal(requests.length, 1);
      const outputText = event.payload.result.contents[0].parts[0].text;
      assert.doesNotMatch(outputText, /Sorry, I cannot assist/);
      assert.match(outputText, /EXACT_FALLBACK_FACT_404/);
    }
  );
});

test('摘要窗口对远期普通工具输出分级瘦身并消除双重转义，同时保留 dispatchRef、skills 与近端工具完整度', () => {
  const largePayload = Array.from({ length: 400 }, (_, i) => `line-${i}: const value_${i} = "${'x'.repeat(30)}";`).join('\n');
  const buildExchange = (turnIndex, toolName = 'grep') => {
    const callContent = withSummaryDispatchRefs([{
      role: 'model',
      parts: [{
        id: `call-${turnIndex}`,
        functionCall: { name: toolName, args: { query: `pattern_${turnIndex}`, context: largePayload } }
      }]
    }], { kind: 'context_segment', id: `seg-call-${turnIndex}` });
    const resultContent = withSummaryDispatchRefs([{
      role: 'user',
      parts: [{
        id: `call-${turnIndex}`,
        functionResponse: {
          name: toolName,
          response: { status: 'succeeded', matches: largePayload }
        }
      }]
    }], { kind: 'tool_call', id: `tool-${turnIndex}` });
    return [...callContent, ...resultContent];
  };

  const segments = [
    buildExchange(1, 'grep'),
    buildExchange(2, 'skills'),
    buildExchange(3, 'grep'),
    buildExchange(4, 'grep'),
    buildExchange(5, 'grep')
  ];
  const projected = projectSummaryModelSegments(segments);
  assert.deepEqual(projected.window.contents, projectSummaryModelWindow(segments.flat()).contents);

  const descriptors = projected.window.contents.flatMap((content) =>
    content.parts.map((part) => JSON.parse(part.text))
  );
  const oldGrepResult = descriptors.find((d) => d.kind === 'historical_tool_result' && d.callId === 'call-1');
  const skillResult = descriptors.find((d) => d.kind === 'historical_tool_result' && d.callId === 'call-2');
  const recentGrepResult = descriptors.find((d) => d.kind === 'historical_tool_result' && d.callId === 'call-5');

  assert.ok(oldGrepResult && /^D[\da-f]{64}$/.test(oldGrepResult.dispatchRef));
  assert.ok(skillResult && /^D[\da-f]{64}$/.test(skillResult.dispatchRef));
  assert.ok(recentGrepResult && /^D[\da-f]{64}$/.test(recentGrepResult.dispatchRef));

  assert.equal(typeof oldGrepResult.result, 'object');
  assert.equal(oldGrepResult.result.truncated, true);
  assert.equal(typeof oldGrepResult.result.preview, 'string');
  assert.equal(oldGrepResult.result.preview.includes('\\"truncated\\":true'), false, 'must not double-wrap truncated preview JSON');

  const oldTokens = estimateTextTokens(JSON.stringify(oldGrepResult.result));
  const skillTokens = estimateTextTokens(JSON.stringify(skillResult.result));
  const recentTokens = estimateTextTokens(JSON.stringify(recentGrepResult.result));
  assert.ok(oldTokens <= 550, `expected old grep result <= 550 tokens, got ${oldTokens}`);
  assert.ok(skillTokens > oldTokens * 2, `expected skills result (${skillTokens}) to keep full budget over old tool (${oldTokens})`);
  assert.ok(recentTokens > oldTokens * 2, `expected recent tool result (${recentTokens}) to keep richer detail over old tool (${oldTokens})`);
});

test('BoundedClientFeed 跨 210 轮命令收据与主回合滚动淘汰，不触发 commit_scope 全量快照风暴', async (t) => {
  const fixture = await createBehaviorRuntime('feed-turn-receipt-rollover');
  t.after(() => fixture.close());
  const scope = await fixture.scope('rollover-conv');
  const database = fixture.app.database;
  const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);
  const frames = [];
  let clientState = createEmptyReliableKernelClientState();

  const feed = new kernel.BoundedClientFeed(database);
  t.after(() => feed.close());
  const connection = await feed.connect({
    activeConversationId: scope.id,
    send: (frame) => {
      frames.push(frame);
      const applied = applyReliableKernelDataMessage(clientState, frame);
      assert.equal(applied.snapshotRequired, false);
      clientState = applied.state;
      setImmediate(() => {
        try {
          feed.acknowledge(applied.ack);
        } catch {
          // Ignore acknowledgements after test teardown.
        }
      });
    }
  });

  const body = await fixture.app.contentStore.ingest(
    database,
    JSON.stringify({ role: 'user', parts: [{ text: 'rollover message' }] }),
    'application/vnd.limcode.message+json'
  );

  for (let i = 1; i <= 210; i += 1) {
    const ts = new Date(Date.UTC(2026, 10, 18, 0, 0, i)).toISOString();
    const pad = String(i).padStart(4, '0');
    const turnId = `turn-${pad}`;
    const msgId = `msg-${pad}`;
    const revId = `rev-${pad}`;
    await database.transaction([
      repo('CommandReceipt').insert({
        id: `cmd-receipt-${pad}`,
        source_kind: 'command',
        source_key: `cmd-${pad}`,
        conversation_id: scope.id,
        turn_id: turnId,
        created_at: ts
      }),
      repo('Turn').insert({
        id: turnId,
        conversation_id: scope.id,
        status: 'terminated',
        created_at: ts,
        updated_at: ts,
        terminal_at: ts
      }),
      repo('TurnTermination').insert({
        id: `term-${pad}`,
        turn_id: turnId,
        terminal_status: 'completed',
        reason: 'done',
        created_at: ts
      }),
      repo('Message').insert({ id: msgId, created_at: ts, updated_at: ts, deleted_at: null }),
      repo('MessageRevision').insert({
        id: revId,
        message_id: msgId,
        revision_seq: 1n,
        role: 'user',
        content_object_id: body.id,
        created_at: ts
      }),
      repo('MessageCurrentRevisionLink').insert({
        id: `cur-${pad}`,
        message_id: msgId,
        revision_id: revId,
        updated_at: ts
      }),
      repo('MessagePartOfConversation').insert({
        id: `mem-${pad}`,
        conversation_id: scope.id,
        message_id: msgId,
        message_seq: BigInt(i),
        created_at: ts
      }),
      repo('MessageTurnLink').insert({
        id: `mtl-${pad}`,
        message_id: msgId,
        turn_id: turnId,
        role: 'input',
        created_at: ts
      })
    ]);
    await new Promise((resolve) => setImmediate(resolve));
  }

  const deadline = Date.now() + 5_000;
  while (feed.inspectSession(connection.sessionId).inflightMessageSeq !== null || feed.inspectSession(connection.sessionId).queuedBatches > 0) {
    if (Date.now() > deadline) throw new Error('Client feed did not drain in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const snapshotFrames = frames.filter((frame) => frame.type === 'reliable-kernel.snapshot');
  assert.equal(snapshotFrames.length, 1, 'must not trigger commit_scope full snapshots past 200 turns/receipts');
  const sessionView = feed.inspectSession(connection.sessionId);
  assert.ok(sessionView.maxMaterializedRecordsPerType <= 200, `expected max <= 200, got ${sessionView.maxMaterializedRecordsPerType}`);
  assert.equal(Object.keys(clientState.records.ConversationCommandReceipt ?? {}).length, 200);
  assert.equal(Object.keys(clientState.records.Turn ?? {}).length, 200);
  assert.equal(Object.keys(clientState.records.Message ?? {}).length, 200);
});

test('SQLite 关键投影查询无全表扫描，且消息计数支持带序号增量推进', (t) => {
  const f = projectionDatabase(t);
  f.conversation('conv-a');
  f.db.transaction(() => {
    for (let i = 1; i <= 500; i += 1) f.message(`m-${i}`, 'conv-a', i);
  })();

  const cache = new projection.ConversationHistoryMessageCounts(f.db);
  const fullSummarySql = () => f.queries.filter((sql) => sql.includes('COUNT(*) AS message_count'));
  const firstHistory = projection.executeConversationHistoryProjection(f.db, { scopeKind: 'all', pageIndex: 0, limit: 20 }, cache);
  assert.equal(Number(firstHistory.messageSummaries[0].message_count), 500);
  assert.equal(fullSummarySql().length, 1);

  // Appending message #501 with an explicit message_seq advances the cached frontier without a full recount.
  cache.beforeMutation({
    kind: 'insert',
    domain: 'MessagePartOfConversation',
    row: { conversation_id: 'conv-a', message_seq: 501n }
  });
  f.message('m-501', 'conv-a', 501);
  const secondHistory = projection.executeConversationHistoryProjection(f.db, { scopeKind: 'all', pageIndex: 0, limit: 20 }, cache);
  assert.equal(Number(secondHistory.messageSummaries[0].message_count), 501);
  assert.equal(fullSummarySql().length, 1, 'incremental message_seq > throughSeq must not trigger full history recount');

  const explainDetails = (sql, params = {}) =>
    f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params).map((row) => String(row.detail)).join('\n');

  const mcpPlan = explainDetails(`
    SELECT * FROM model_context_projection
     WHERE owner_kind = 'model_request' AND owner_id IN (@id0)
     ORDER BY id ASC
  `, { id0: 'req-1' });
  assert.doesNotMatch(mcpPlan, /SCAN model_context_projection\b/);
  assert.match(mcpPlan, /ux_model_context_projection_01/);

  const inboxPlan = explainDetails(`
    SELECT * FROM runtime_inbox_item
     WHERE source_kind = 'answer_submission' AND source_id IN (@id0)
     ORDER BY id ASC
  `, { id0: 'sub-1' });
  assert.doesNotMatch(inboxPlan, /SCAN runtime_inbox_item\b/);
  assert.match(inboxPlan, /ix_runtime_inbox_item_02/);

  const pageConvPlan = explainDetails(`
    WITH seed(id) AS (VALUES (@seed0)),
         page_conversation(id) AS (
           SELECT id FROM seed
           UNION
           SELECT origin.source_conversation_id
             FROM conversation_origin_link AS origin
             JOIN seed ON seed.id = origin.conversation_id
            WHERE origin.source_conversation_id IS NOT NULL
              AND origin.source_tool_call_id IS NOT NULL
         )
    SELECT conversation.id, conversation.title, conversation.status,
           conversation.created_at, conversation.updated_at
      FROM page_conversation
      CROSS JOIN conversation ON conversation.id = page_conversation.id
     ORDER BY conversation.updated_at DESC, conversation.id DESC
  `, { seed0: 'conv-a' });
  assert.doesNotMatch(pageConvPlan, /SCAN conversation\b/);

  // Verify CompressionBlock anchor resolution preserves exact highest-position anchor (never flattened to segment_id order).
  const ts = '2026-11-18T00:00:00.000Z';
  f.insert('content_object', {
    id: 'co-summary', content_type: 'text/plain', sha256: 'a'.repeat(64), byte_length: 4, storage_key: 'k', created_at: ts
  });
  for (const segId of ['seg-z-early', 'seg-a-late']) {
    f.insert('context_segment', { id: segId, content_object_id: 'co-summary', segment_kind: 'message', created_at: ts });
  }
  f.insert('context_segment_source', {
    id: 'css-early', segment_id: 'seg-z-early', source_kind: 'message_revision', source_id: 'r-m-1', source_revision: 0, created_at: ts
  });
  f.insert('context_segment_source', {
    id: 'css-late', segment_id: 'seg-a-late', source_kind: 'message_revision', source_id: 'r-m-500', source_revision: 0, created_at: ts
  });
  f.insert('turn', { id: 't-anchor', conversation_id: 'conv-a', status: 'terminated', created_at: ts, updated_at: ts, terminal_at: ts });
  f.insert('authority_snapshot', { id: 'auth-anchor', turn_id: 't-anchor', content_object_id: 'co-summary', created_at: ts });
  f.insert('compression_block', {
    id: 'cb-anchor', conversation_id: 'conv-a', status: 'committed', authority_snapshot_id: 'auth-anchor',
    title_object_id: 'co-summary', summary_object_id: 'co-summary', created_at: ts, updated_at: ts
  });
  // `seg-z-early` sorts first in ux_compression_block_source_01(compression_block_id, segment_id, position) if DESC were flattened,
  // while `seg-a-late` has higher position=1 and must win as anchor_message_id.
  f.insert('compression_block_source', { id: 'cbs-0', compression_block_id: 'cb-anchor', segment_id: 'seg-z-early', position: 0, created_at: ts });
  f.insert('compression_block_source', { id: 'cbs-1', compression_block_id: 'cb-anchor', segment_id: 'seg-a-late', position: 1, created_at: ts });

  const projectedBlock = projection.projectCompressionBlockRecord(f.db, 'cb-anchor');
  assert.equal(projectedBlock.anchor_message_id, 'm-500', 'anchor_message_id must resolve the highest position source');
});
