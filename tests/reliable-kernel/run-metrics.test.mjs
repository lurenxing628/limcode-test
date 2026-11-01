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

test('整包到达的回复不计速，既不用几毫秒的收尾时间也不把首字等待算进去', () => {
  const metrics = modelRunMetrics({ requestStartedAt: 1000, firstChunkAt: 9557, completedAt: 9600,
    streamOutputDurationMs: 43, usageMetadata: { promptTokenCount: 97054, candidatesTokenCount: 56,
      thoughtsTokenCount: 66, totalTokenCount: 97176 } }, false);
  assert.equal(metrics.outputTokens, 122);
  assert.equal(metrics.outputDurationMs, 43);
  assert.equal(metrics.tokenSpeed, undefined);
});

test('速度按首字到结束计算，长上下文的首字等待不拉低速度', () => {
  // 真实请求：4 万 Token 上下文，首字等待 1.7 秒，800 Token 用 4.3 秒输出完。
  const metrics = modelRunMetrics({ requestStartedAt: 1792931974511, firstChunkAt: 1792931976229,
    completedAt: 1792931980575, streamOutputDurationMs: 4346, usageMetadata: { cachedContentTokenCount: 43136,
      candidatesTokenCount: 800, promptTokenCount: 43476, thoughtsTokenCount: 0, totalTokenCount: 44276 } }, false);
  assert.equal(metrics.tokenSpeed, 800 / 4.346);
  assert.equal(metrics.ttftMs, 1718);
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

test('非流式回复和出字不足半秒的回复不计速，计时未知和未结束时不猜速度', () => {
  assert.equal(modelRunMetrics({ requestStartedAt: 1000, firstChunkAt: 3000, completedAt: 3000,
    streamOutputDurationMs: 0, usageMetadata: { candidatesTokenCount: 100 } }, false).tokenSpeed, undefined);
  assert.equal(modelRunMetrics({ requestStartedAt: 1000, firstChunkAt: 3000, completedAt: 3499,
    streamOutputDurationMs: 499, usageMetadata: { candidatesTokenCount: 100 } }, false).tokenSpeed, undefined);
  assert.equal(modelRunMetrics({ firstChunkAt: 1000, completedAt: 2000,
    usageMetadata: { candidatesTokenCount: 100 } }, false).tokenSpeed, 100);
  assert.equal(modelRunMetrics({ requestStartedAt: 1000, firstChunkAt: 2000,
    usageMetadata: { candidatesTokenCount: 100 } }, true).tokenSpeed, undefined);
});

test('原生多轮按每轮输出耗时计速，超过八轮仍计入全部轮次并排除工具与首字等待', () => {
  let response;
  for (let i = 0; i < 10; i++) {
    const startedAt = 1000 + i * 12000;
    response = foldNativeResponseMetrics(response, 'r' + i, { startedAt, firstOutputAt: startedAt + 1500,
      completedAt: startedAt + 2000, ttftMs: 1500, outputDurationMs: 500 }, { output_tokens: 100 });
  }
  response = modelRequestResponseMetrics({ nativeResponseMetrics: parseNativeResponseMetrics(response) });
  const metrics = modelRunMetrics({ responseMetrics: response }, true);
  assert.equal(response.recent.length, 8);
  assert.equal(metrics.outputDurationMs, 5000);
  assert.equal(metrics.tokenSpeed, 200);
  assert.equal(metrics.rounds[0].tokenSpeed, 200);
  assert.equal(metrics.rounds[0].outputDurationMs, 500);
});

test('原生缺少用量或整包到达的轮次都不混入计速', () => {
  let response = foldNativeResponseMetrics(undefined, 'burst', { startedAt: 1000, firstOutputAt: 3000,
    completedAt: 3040, ttftMs: 2000, outputDurationMs: 40 }, { output_tokens: 100 });
  response = foldNativeResponseMetrics(response, 'unknown', { startedAt: 10000, firstOutputAt: 11000,
    completedAt: 12000, ttftMs: 1000, outputDurationMs: 1000 }, undefined);
  assert.equal(modelRunMetrics({ responseMetrics: response }, false).tokenSpeed, undefined);
  response = foldNativeResponseMetrics(response, 'timed', { startedAt: 20000, firstOutputAt: 21000,
    completedAt: 22000, ttftMs: 1000, outputDurationMs: 1000 }, { output_tokens: 150 });
  assert.equal(modelRunMetrics({ responseMetrics: response }, false).tokenSpeed, 150);
});

test('旧版本写入的累计请求耗时仍可读取，但不参与计速', () => {
  const response = foldNativeResponseMetrics(undefined, 'r1', { startedAt: 1000, firstOutputAt: 2000,
    completedAt: 3000, ttftMs: 1000, outputDurationMs: 1000 }, { output_tokens: 100 });
  const parsed = parseNativeResponseMetrics({ ...response, speedTotalDurationMs: 2000 });
  assert.equal(parsed.speedTotalDurationMs, undefined);
  assert.equal(modelRunMetrics({ responseMetrics: parsed }, false).tokenSpeed, 100);
});
