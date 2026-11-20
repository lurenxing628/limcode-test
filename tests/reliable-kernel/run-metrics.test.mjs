import assert from 'node:assert/strict';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

let server, modelRunMetrics, normalizeTokenUsage, cacheHit, foldNativeResponseMetrics, parseNativeResponseMetrics, modelRequestResponseMetrics;
before(async () => {
  server = await createWebviewSsrServer();
  ({ modelRunMetrics } = await server.ssrLoadModule('/src/components/conversation/runMetricsModel.ts'));
  ({ normalizeTokenUsage } = await server.ssrLoadModule('/src/components/conversation/tokenUsageModel.ts'));
  cacheHit = await server.ssrLoadModule('/src/components/conversation/cacheHitModel.ts');
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

test('单条命中率按总输入（含缓存）计算，估算用量和没有输入的请求不计入', () => {
  // Claude 的 promptTokenCount 已由接入库合成 input + cache_creation + cache_read。
  assert.equal(cacheHit.cacheHitRatio({ promptTokenCount: 223404, cachedContentTokenCount: 199118 }), 199118 / 223404);
  assert.equal(cacheHit.cacheHitRatio({ promptTokenCount: 1000 }), undefined);
  assert.equal(cacheHit.formatCacheHitPercent(199118 / 223404), '89%');
  assert.equal(cacheHit.formatCacheHitPercent(0.004), '<1%');
  assert.equal(cacheHit.formatCacheHitPercent(0.996), '99%');
  assert.equal(cacheHit.formatCacheHitPercent(0), '0%');
  const identity = { providerId: 'p', turnId: 't' };
  assert.equal(cacheHit.cacheHitSample({ promptTokenCount: 1000, estimated: true }, identity), undefined);
  assert.equal(cacheHit.cacheHitSample({ promptTokenCount: 0, cachedContentTokenCount: 0 }, identity), undefined);
  assert.deepEqual(cacheHit.cacheHitSample({ promptTokenCount: 100, cachedContentTokenCount: 120 }, identity),
    { ...identity, input: 100, cached: 100 });
});

test('汇总按 Token 加权；报过缓存的渠道缺字段按 0 计，从未报过的渠道单独记为未报告', () => {
  const sample = (providerId, turnId, input, cached) => ({ providerId, turnId, input, ...(cached !== undefined ? { cached } : {}) });
  const summary = cacheHit.summarizeCacheHits([
    sample('gemini', 't2', 1000, 900),
    sample('gemini', 't2', 1000),
    sample('relay', 't1', 5000)
  ]);
  assert.equal(summary.requests, 3);
  assert.equal(summary.unreported, 1);
  assert.equal(summary.inputTokens, 2000);
  assert.equal(summary.cachedTokens, 900);
  assert.equal(summary.ratio, 0.45);
  assert.equal(cacheHit.summarizeCacheHits([sample('relay', 't1', 5000)]).ratio, undefined);
});

test('底栏只取最近 100 次，最近一轮按最新请求所在的轮次统计，渠道是否报告看全部已加载请求', () => {
  const newestFirst = [
    { providerId: 'gemini', turnId: 'latest', createdAt: 3000, input: 1000 },
    { providerId: 'gemini', turnId: 'latest', createdAt: 2000, input: 1000 },
    ...Array.from({ length: 120 }, (_, index) => ({
      providerId: 'gemini', turnId: `old-${index}`, createdAt: 1000 - index, input: 100, cached: 100
    }))
  ];
  const { recent, latestTurn } = cacheHit.recentCacheHitSummaries(newestFirst);
  assert.equal(recent.requests, cacheHit.CACHE_HIT_RECENT_REQUEST_LIMIT);
  assert.equal(recent.inputTokens, 2000 + 98 * 100);
  assert.equal(recent.cachedTokens, 98 * 100);
  assert.equal(recent.lastAt, 3000);
  assert.equal(recent.firstAt, 1000 - 97);
  // 最近一轮两次都没带缓存字段，但同一渠道更早报过：按 0% 计，而不是"未报告"。
  assert.equal(latestTurn.requests, 2);
  assert.equal(latestTurn.unreported, 0);
  assert.equal(latestTurn.ratio, 0);
  assert.deepEqual(cacheHit.recentCacheHitSummaries([]).latestTurn, undefined);
});
