import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { boundClientRecordSummary, clientWireBytes } = require(path.join(compiled, 'backend/reliableKernel/clientWireData.js'));
const { foldNativeResponseMetrics } = require(path.join(compiled, 'backend/reliableKernel/nativeResponseMetrics.js'));
const bounds = require(path.join(compiled, 'backend/reliableKernel/clientFeedBounds.js'));
let server, projectReliableConversation, modelRunMetrics;
before(async () => {
  server = await createWebviewSsrServer();
  ({ projectReliableConversation } = await server.ssrLoadModule('/src/domain/reliableConversationProjection.ts'));
  ({ modelRunMetrics } = await server.ssrLoadModule('/src/components/conversation/runMetricsModel.ts'));
});
after(async () => server?.close());

function request(extra = {}) {
  return { id: 'request-metrics', turn_id: 'turn-metrics', request_seq: '1', status: 'terminal', terminal_state: 'completed',
    provider_id: 'provider', model_id: 'model', created_at: '2026-09-25T10:00:00.000Z', updated_at: '2026-09-25T10:00:05.000Z',
    usage_json: null, stream_stats_json: { attemptSeq: '1', socketGeneration: '1', retryReason: null }, ...extra };
}
function project(requests, links = [{ id: 'link-metrics', model_request_id: 'request-metrics', message_id: 'message-metrics' }]) {
  return projectReliableConversation({ conversationId: 'conversation-metrics', details: {}, records: {
    Message: { 'message-metrics': { id: 'message-metrics', conversation_id: 'conversation-metrics', role: 'model',
      revision_id: 'revision-metrics', message_seq: '2', display_seq: '2', created_at: '2026-09-25T10:00:04.000Z' } },
    ModelRequest: Object.fromEntries(requests.map(row => [row.id, boundClientRecordSummary(row, 'ModelRequest')])),
    ModelRequestMessageLink: Object.fromEntries(links.map(row => [row.id, row]))
  } }).messages[0];
}

test('原生首轮和最近 8 轮计量有独立硬上限，snapshot JSON 与 changes 对象得到同一纯数据摘要', () => {
  let metrics;
  for (let i = 0; i < 12; i += 1) {
    metrics = foldNativeResponseMetrics(metrics, `${i}`.padStart(4, '0') + '界'.repeat(508), {
      startedAt: 1000 + i * 100, firstOutputAt: 1010 + i * 100, completedAt: 1060 + i * 100, ttftMs: 10, outputDurationMs: 50
    }, { output_tokens: 7, output_tokens_details: { reasoning_tokens: 2 } });
  }
  const raw = request({
    usage_json: { promptTokenCount: 0, candidatesTokenCount: 84, nativeChainBilling: true, provider_debug: 'x'.repeat(100_000) },
    stream_stats_json: { attemptSeq: '1', socketGeneration: '2', retryReason: null, nativeResponseMetrics: metrics,
      providerStartedAt: 1000, completedAt: 2260, failure: { message: 'x'.repeat(100_000) } }
  });
  const summary = boundClientRecordSummary(raw, 'ModelRequest');
  assert.ok(clientWireBytes(summary) > bounds.CLIENT_WINDOW_RECORD_SUMMARY_MAX_BYTES, '测试确实越过旧的 2 KiB 上限');
  assert.ok(clientWireBytes(summary) <= bounds.CLIENT_MODEL_REQUEST_SUMMARY_MAX_BYTES);
  assert.deepEqual(summary.stream_stats_json.nativeResponseMetrics, metrics, '身份不能截短、轮次不能丢弃或重算');
  assert.equal(summary.stream_stats_json.nativeResponseMetrics.recent.length, 8);
  assert.equal(summary.stream_stats_json.failure, undefined);
  assert.deepEqual(summary.usage_json, { promptTokenCount: 0, candidatesTokenCount: 84, nativeChainBilling: true });
  assert.deepEqual(summary, boundClientRecordSummary({ ...raw,
    usage_json: JSON.stringify(raw.usage_json), stream_stats_json: JSON.stringify(raw.stream_stats_json)
  }, 'ModelRequest'));
  assert.deepEqual(summary, boundClientRecordSummary(summary, 'ModelRequest'), '历史页经过 worker 和 bridge 两次投影应幂等');
  assert.deepEqual(summary, structuredClone(summary));
  const message = project([raw]);
  const footer = modelRunMetrics(message, false);
  assert.equal(footer.ttftMs, 10);
  assert.equal(footer.tokenSpeed, 140);
  assert.equal(footer.roundCount, 12);
  assert.equal(footer.rounds.length, 8);
  assert.equal(footer.rounds[0].index, 5);
  const contract = JSON.parse(fs.readFileSync('docs/architecture/reliable-kernel/contracts/client-feed.json', 'utf8'));
  assert.equal(contract.snapshot.modelRequestSummaryMaxBytes, bounds.CLIENT_MODEL_REQUEST_SUMMARY_MAX_BYTES);
});

test('领域预算不是无限放宽：超限显式失败，普通文本记录仍使用原来的 2 KiB 摘要', () => {
  assert.throws(() => boundClientRecordSummary(request({
    usage_json: { cacheCreationInputTokensDetails: { invalid: 'x'.repeat(bounds.CLIENT_MODEL_REQUEST_SUMMARY_MAX_BYTES) } }
  }), 'ModelRequest'), /measurement byte limit/);
  assert.throws(() => boundClientRecordSummary(request({ stream_stats_json: '{"attemptSeq":"1"…' }), 'ModelRequest'));
  assert.ok(clientWireBytes(boundClientRecordSummary({ id: 'message', body: 'x'.repeat(5000) }, 'Message')) <= 2048);
});

test('缺失的用量与 provider 时间保持未知，Message/ModelRequest 的创建时间不是首字或请求计时', () => {
  const empty = project([request()]);
  assert.equal(empty.usageMetadata, undefined);
  assert.equal(empty.firstChunkAt, undefined);
  assert.equal(empty.requestStartedAt, undefined);
  assert.deepEqual(modelRunMetrics(empty, false), {});

  // Completion is measured but first output is not; never replace it with Message.createdAt.
  const ended = project([request({ stream_stats_json: { providerStartedAt: 1000, completedAt: 3000 } })]);
  assert.deepEqual(modelRunMetrics(ended, false), { totalMs: 2000 });
  assert.equal(ended.usageMetadata, undefined);
  const onlyEnd = project([request({ stream_stats_json: { completedAt: Date.parse('2026-09-25T10:00:05.000Z') } })]);
  assert.deepEqual(modelRunMetrics(onlyEnd, false), {});
});

test('零值仍是真实计量，不向同 Turn 的无关联消息或相邻请求借用指标', () => {
  const own = request({ usage_json: { promptTokenCount: 0, candidatesTokenCount: 0, cachedContentTokenCount: 0 },
    stream_stats_json: { providerStartedAt: 1000, firstOutputAt: 1000, completedAt: 1500, streamOutputDurationMs: 500 } });
  const other = request({ id: 'neighbor-request', request_seq: '2', usage_json: { promptTokenCount: 999, candidatesTokenCount: 123 },
    stream_stats_json: { providerStartedAt: 2000, firstOutputAt: 2100, completedAt: 2500 } });
  const message = project([own, other]);
  assert.equal(message.usageMetadata.promptTokenCount, 0);
  assert.equal(message.usageMetadata.candidatesTokenCount, 0);
  assert.equal(message.usageMetadata.cachedContentTokenCount, 0);
  const metrics = modelRunMetrics(message, false);
  assert.equal(metrics.ttftMs, 0);
  assert.equal(metrics.totalMs, 500);
  assert.equal(metrics.tokenSpeed, 0);
  const unlinked = project([own, other], []);
  assert.equal(unlinked.usageMetadata, undefined);
  assert.deepEqual(modelRunMetrics(unlinked, false), {});
});
