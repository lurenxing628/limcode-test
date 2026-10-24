import assert from 'node:assert/strict';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

let server, modelRunMetrics, normalizeTokenUsage, foldNativeResponseMetrics, parseNativeResponseMetrics, modelRequestResponseMetrics;
before(async () => {
  server = await createWebviewSsrServer();
  ({ modelRunMetrics } = await server.ssrLoadModule('/src/components/conversation/runMetricsModel.ts'));
  ({ normalizeTokenUsage } = await server.ssrLoadModule('/src/components/conversation/tokenUsageModel.ts'));
  ({ modelRequestResponseMetrics } = await server.ssrLoadModule('/src/reliability/modelRequestStreamStats.ts'));
  ({ foldNativeResponseMetrics, parseNativeResponseMetrics } = await server.ssrLoadModule(path.resolve('backend/reliableKernel/nativeResponseMetrics.ts')));
});
after(async () => { await server?.close(); });

test('整包回复按请求总耗时计算平均 TPS，不用首包后的收尾时间', () => {
  const metrics = modelRunMetrics({ requestStartedAt: 1000, firstChunkAt: 9557, completedAt: 9600,
    streamOutputDurationMs: 43, usageMetadata: { promptTokenCount: 97054, candidatesTokenCount: 56,
      thoughtsTokenCount: 66, totalTokenCount: 97176 } }, false);
  assert.equal(metrics.outputTokens, 122);
  assert.equal(metrics.speedDurationMs, 8600);
  assert.equal(metrics.tokenSpeed, 122 / 8.6);
  assert.equal(metrics.outputDurationMs, 43);
});

test('异常总量不把额外输入算成输出，正常 OpenAI 不重复加思考', () => {
  assert.equal(normalizeTokenUsage({ promptTokenCount: 222728, candidatesTokenCount: 255,
    thoughtsTokenCount: 162, totalTokenCount: 446050 }).output, 417);
  assert.equal(normalizeTokenUsage({ promptTokenCount: 100, candidatesTokenCount: 80,
    thoughtsTokenCount: 60, totalTokenCount: 180 }).output, 80);
  assert.equal(normalizeTokenUsage({ promptTokenCount: 100, candidatesTokenCount: 20,
    thoughtsTokenCount: 60, totalTokenCount: 180 }).output, 80);
  assert.equal(normalizeTokenUsage({ nativeChainBilling: true, candidatesTokenCount: 80, thoughtsTokenCount: 60 }).output, 80);
});

test('非流式回复可计算平均速度，计时未知和未结束时不猜速度', () => {
  assert.equal(modelRunMetrics({ requestStartedAt: 1000, firstChunkAt: 3000, completedAt: 3000,
    streamOutputDurationMs: 0, usageMetadata: { candidatesTokenCount: 100 } }, false).tokenSpeed, 50);
  assert.equal(modelRunMetrics({ firstChunkAt: 1000, completedAt: 2000,
    usageMetadata: { candidatesTokenCount: 100 } }, false).tokenSpeed, undefined);
  assert.equal(modelRunMetrics({ requestStartedAt: 1000, firstChunkAt: 2000,
    usageMetadata: { candidatesTokenCount: 100 } }, true).tokenSpeed, undefined);
});

test('原生多轮复用已有起止时间，超过八轮仍计入全部轮次并排除工具等待', () => {
  let response;
  for (let i = 0; i < 10; i++) {
    const startedAt = 1000 + i * 12000;
    response = foldNativeResponseMetrics(response, 'r' + i, { startedAt, firstOutputAt: startedAt + 1500,
      completedAt: startedAt + 2000, ttftMs: 1500, outputDurationMs: 500 }, { output_tokens: 100 });
  }
  response = modelRequestResponseMetrics({ nativeResponseMetrics: parseNativeResponseMetrics(response) });
  const metrics = modelRunMetrics({ responseMetrics: response }, true);
  assert.equal(response.recent.length, 8);
  assert.equal(metrics.speedDurationMs, 20000);
  assert.equal(metrics.tokenSpeed, 50);
  assert.equal(metrics.rounds[0].tokenSpeed, 50);
  assert.equal(metrics.rounds[0].speedDurationMs, 2000);
});

test('原生缺少用量的轮次不混入计速分母，首包即结束的轮次仍计速', () => {
  const first = foldNativeResponseMetrics(undefined, 'known', { startedAt: 1000, firstOutputAt: 3000,
    completedAt: 3000, ttftMs: 2000, outputDurationMs: 0 }, { output_tokens: 100 });
  const response = foldNativeResponseMetrics(first, 'unknown', { startedAt: 10000, firstOutputAt: 11000,
    completedAt: 12000, ttftMs: 1000, outputDurationMs: 1000 }, undefined);
  assert.equal(modelRunMetrics({ responseMetrics: response }, false).tokenSpeed, 50);
});

test('缺少累计请求耗时的原生记录不把流式速度当平均速度', () => {
  const response = foldNativeResponseMetrics(undefined, 'r1', { startedAt: 1000, firstOutputAt: 2000,
    completedAt: 3000, ttftMs: 1000, outputDurationMs: 1000 }, { output_tokens: 100 });
  delete response.speedTotalDurationMs;
  assert.equal(modelRunMetrics({ responseMetrics: response }, false).tokenSpeed, undefined);
  const next = foldNativeResponseMetrics(response, 'r2', { startedAt: 4000, completedAt: 5000 }, { output_tokens: 100 });
  assert.equal(next.speedTotalDurationMs, undefined);
});
