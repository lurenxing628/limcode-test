import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { before, after, test } from 'node:test';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const workspace = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '../..');
const temp = mkdtempSync(path.join(tmpdir(), 'limcode-native-response-metrics-'));
process.env.NODE_PATH = [path.join(workspace, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
let stream, control, runMetrics, streamStats;

before(async () => {
  for (const [name, source] of Object.entries({
    stream: 'backend/capabilities/llmStreamEventProjection.ts',
    control: 'backend/reliableKernel/modelProviderControlPlane.ts',
    runMetrics: 'webview/src/components/conversation/runMetricsModel.ts',
    streamStats: 'webview/src/reliability/modelRequestStreamStats.ts'
  })) {
    await build({
      entryPoints: [path.join(workspace, source)],
      outfile: path.join(temp, `${name}.cjs`),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['vscode', 'better-sqlite3'],
      alias: { '@shared': path.join(workspace, 'shared') },
      logLevel: 'silent'
    });
  }
  stream = require(path.join(temp, 'stream.cjs'));
  control = require(path.join(temp, 'control.cjs'));
  runMetrics = require(path.join(temp, 'runMetrics.cjs'));
  streamStats = require(path.join(temp, 'streamStats.cjs'));
});
after(() => rmSync(temp, { recursive: true, force: true }));

test('每个物理 response 各自计首字与输出用时，工具执行时间不计入任何 response', () => {
  const tracker = new stream.NativeResponseTimingTracker({ at: 1_000, mark: 0 });
  tracker.responseCreated('resp-1');
  tracker.outputObserved(1_800, 800);
  tracker.outputObserved(1_900, 900);
  assert.deepEqual(tracker.responseEnded('resp-1', 3_000, 2_000), {
    startedAt: 1_000, completedAt: 3_000, firstOutputAt: 1_800, ttftMs: 800, outputDurationMs: 1_200
  }, '首个 response 从请求开始算首字');
  // 工具从 2_000 跑到 12_000，结果在 12_000 提交。
  tracker.inputSubmitted(13_000, 12_000);
  tracker.responseCreated('resp-2');
  tracker.outputObserved(13_500, 12_500);
  assert.deepEqual(tracker.responseEnded('resp-2', 14_000, 13_000), {
    startedAt: 13_000, completedAt: 14_000, firstOutputAt: 13_500, ttftMs: 500, outputDurationMs: 500
  }, '续接 response 从提交工具结果算起，不含工具执行的 10 秒');
});

test('转向在上一 response 结束前提交时，后继从上一 response 结束算起；没有输出的 response 不给首字', () => {
  const tracker = new stream.NativeResponseTimingTracker({ at: 10_000, mark: 0 });
  tracker.responseCreated('resp-1');
  tracker.outputObserved(10_100, 100);
  tracker.inputSubmitted(10_500, 500);
  tracker.responseEnded('resp-1', 11_000, 1_000);
  tracker.responseCreated('resp-2');
  tracker.outputObserved(11_300, 1_300);
  assert.equal(tracker.responseEnded('resp-2', 12_000, 2_000).ttftMs, 300);
  tracker.responseCreated('resp-3');
  assert.deepEqual(tracker.responseEnded('resp-3', 12_500, 2_500), { startedAt: 12_000, completedAt: 12_500 });
});

test('不是正在解码的 response 结束时不产生计时，同一 response 不会结束两次', () => {
  const tracker = new stream.NativeResponseTimingTracker({ at: 1, mark: 0 });
  assert.equal(tracker.responseEnded('resp-replayed', 5, 5), undefined);
  tracker.responseCreated('resp-1');
  tracker.outputObserved(2, 1);
  assert.equal(tracker.responseEnded('resp-other', 3, 2), undefined);
  assert.ok(tracker.responseEnded('resp-1', 4, 3));
  assert.equal(tracker.responseEnded('resp-1', 4, 3), undefined);
});

test('原生控制事件不算模型输出，文字、思考和工具参数算', () => {
  const nativeOnly = { nativeEvent: { type: 'response.created', responseId: 'resp-1' } };
  assert.equal(stream.hasModelOutputChunk(nativeOnly), false);
  assert.equal(stream.hasStreamTimingChunk(nativeOnly), true, '请求级流计时的口径不变');
  assert.equal(stream.hasModelOutputChunk({ textDelta: 'hi' }), true);
  assert.equal(stream.hasModelOutputChunk({ partsDelta: [{ text: 'thinking', thought: true }] }), true);
  assert.equal(stream.hasModelOutputChunk({ toolCallArgumentDeltas: [{ index: 0, delta: '{' }] }), true);
});

function metricsPlane() {
  const state = {
    row: { id: 'request-1', status: 'streaming', stream_stats_json: { attemptSeq: '1', socketGeneration: '1', retryReason: null } },
    writes: 0
  };
  const plane = Object.create(control.ModelProviderControlPlane.prototype);
  plane.now = () => '2026-09-25T00:00:00.000Z';
  plane.database = {
    snapshot: async () => ({ snapshot: [state.row] }),
    transaction: async (steps) => {
      const update = steps.find((step) => step.kind === 'update' && step.domain === 'ModelRequest');
      state.row = { ...state.row, ...update.patch };
      state.writes += 1;
    }
  };
  return { plane, state };
}

function responseObservation(index, timing, usage) {
  return {
    responseId: `resp-${index}`,
    ...(index > 1 ? { previousResponseId: `resp-${index - 1}` } : {}),
    streamSeq: String(index * 10),
    ...(usage ? { usage } : {}),
    ...(timing ? { timing } : {})
  };
}

const timing = (startedAt, ttftMs, outputDurationMs) => ({
  startedAt,
  completedAt: startedAt + ttftMs + outputDurationMs,
  firstOutputAt: startedAt + ttftMs,
  ttftMs,
  outputDurationMs
});

test('请求记录按 response 累积首字与速度：重复回执不重复计入，缺计时的 response 不参与，最近 8 轮有界', async () => {
  const { plane, state } = metricsPlane();
  const metrics = () => state.row.stream_stats_json.nativeResponseMetrics;
  const first = responseObservation(1, timing(1_000, 800, 1_200),
    { input_tokens: 5_000, output_tokens: 240, output_tokens_details: { reasoning_tokens: 40 } });
  assert.equal(await plane.persistNativeResponseUsage('request-1', '1', '1', first), true);
  assert.deepEqual(metrics(), {
    responseCount: 1,
    first: { responseId: 'resp-1', ...timing(1_000, 800, 1_200), outputTokens: 240, reasoningTokens: 40 },
    recent: [{ responseId: 'resp-1', ...timing(1_000, 800, 1_200), outputTokens: 240, reasoningTokens: 40 }],
    ttftTotalMs: 800,
    ttftCount: 1,
    speedOutputTokens: 240,
    speedOutputDurationMs: 1_200
  });
  assert.equal(await plane.persistNativeResponseUsage('request-1', '1', '1', first), true);
  assert.equal(state.writes, 1, '同一 response 重复回执不写入，也不重复计入');

  assert.equal(await plane.persistNativeResponseUsage('request-1', '1', '1',
    responseObservation(2, undefined, { input_tokens: 5_300, output_tokens: 90 })), true);
  assert.equal(state.row.stream_stats_json.nativeLatestResponseUsage.responseId, 'resp-2');
  assert.equal(metrics().responseCount, 1, '重放而没有计时的 response 不进入速度统计，已有统计在后续写入中保留');

  assert.equal(await plane.persistNativeResponseUsage('request-1', '1', '1',
    responseObservation(3, timing(20_000, 500, 500), { input_tokens: 5_500, output_tokens: 100 })), true);
  assert.equal(metrics().responseCount, 2);
  assert.equal(metrics().speedOutputTokens, 340);
  assert.equal(metrics().speedOutputDurationMs, 1_700, '速度只用各 response 自己的输出用时，不含其间工具时间');
  assert.equal(metrics().ttftTotalMs, 1_300);
  assert.equal(metrics().ttftCount, 2);

  for (let index = 4; index <= 12; index += 1) {
    await plane.persistNativeResponseUsage('request-1', '1', '1',
      responseObservation(index, timing(index * 10_000, 100, 1_000), { output_tokens: 50 }));
  }
  assert.equal(metrics().responseCount, 11);
  assert.deepEqual(metrics().recent.map((entry) => entry.responseId),
    ['resp-5', 'resp-6', 'resp-7', 'resp-8', 'resp-9', 'resp-10', 'resp-11', 'resp-12']);
  assert.equal(metrics().first.responseId, 'resp-1', '首轮首字不随窗口滑动丢失');
  assert.equal(metrics().speedOutputTokens, 340 + 9 * 50, '总量覆盖窗口外的 response');

  const writes = state.writes;
  await assert.rejects(plane.persistNativeResponseUsage('request-1', '1', '1',
    responseObservation(13, { startedAt: 1, completedAt: 2, ttftMs: 1 })), /together/);
  assert.equal(state.writes, writes, '畸形计时在写入前拒绝');
});

test('页脚指标：原生请求运行中就按已结束的 response 给出首字与速度，每轮单列', () => {
  const recent = [
    { responseId: 'resp-3', ...timing(30_000, 400, 1_000), outputTokens: 60 },
    { responseId: 'resp-4', ...timing(40_000, 600, 2_000), outputTokens: 20 }
  ];
  const message = {
    id: 'message-1', conversationId: 'conversation-1', role: 'model', status: 'streaming',
    content: { role: 'model', parts: [] }, createdAt: 1_000, seq: 1,
    requestStartedAt: 1_000, firstChunkAt: 1_500,
    responseMetrics: {
      responseCount: 4,
      first: { responseId: 'resp-1', ...timing(1_000, 800, 1_000), outputTokens: 100 },
      recent,
      ttftTotalMs: 2_000,
      ttftCount: 4,
      speedOutputTokens: 300,
      speedOutputDurationMs: 6_000
    }
  };
  const live = runMetrics.modelRunMetrics(message, true);
  assert.equal(live.ttftMs, 800, '首字取首轮实测值');
  assert.equal(live.tokenSpeed, 50, '速度 = 各轮输出 Token 之和 / 各轮输出用时之和');
  assert.equal(live.totalMs, undefined, '运行中没有总耗');
  assert.equal(live.roundCount, 4);
  assert.equal(live.averageTtftMs, 500);
  assert.deepEqual(live.rounds.map((round) => [round.index, round.ttftMs, round.tokenSpeed]), [[3, 400, 60], [4, 600, 10]]);
  const finished = runMetrics.modelRunMetrics({ ...message, status: 'final', completedAt: 51_000 }, false);
  assert.equal(finished.totalMs, 50_000);
  assert.equal(finished.tokenSpeed, 50);
});

test('页脚指标：没有每轮记录的已结束原生请求不显示错误的首字和速度；普通请求运行中只有首字', () => {
  const base = {
    id: 'message-2', conversationId: 'conversation-1', role: 'model', content: { role: 'model', parts: [] },
    createdAt: 1_000, seq: 1, requestStartedAt: 1_000, firstChunkAt: 1_400, completedAt: 61_000,
    streamOutputDurationMs: 59_600
  };
  assert.deepEqual(runMetrics.modelRunMetrics({
    ...base, status: 'final', usageMetadata: { candidatesTokenCount: 900, nativeChainBilling: true }
  }, false), { totalMs: 60_000 }, '整条链的输出时间含工具执行，不能算速度');
  assert.deepEqual(runMetrics.modelRunMetrics({ ...base, status: 'streaming' }, true), { ttftMs: 400 });
  const plain = runMetrics.modelRunMetrics({
    ...base, status: 'final', streamOutputDurationMs: 2_000, completedAt: 3_400, usageMetadata: { candidatesTokenCount: 100 }
  }, false);
  assert.equal(plain.ttftMs, 400);
  assert.equal(plain.totalMs, 2_400);
  assert.equal(plain.tokenSpeed, 50);
});

test('Webview 读取请求记录里的每轮指标，形状不符时当作没有', () => {
  const valid = {
    responseCount: 1,
    first: { responseId: 'resp-1', ...timing(1_000, 800, 1_200), outputTokens: 240 },
    recent: [{ responseId: 'resp-1', ...timing(1_000, 800, 1_200), outputTokens: 240 }],
    ttftTotalMs: 800, ttftCount: 1, speedOutputTokens: 240, speedOutputDurationMs: 1_200
  };
  const request = { stream_stats_json: JSON.stringify({ attemptSeq: '1', nativeResponseMetrics: valid }) };
  assert.deepEqual(streamStats.modelRequestResponseMetrics(streamStats.modelRequestStreamStats(request)), valid);
  for (const broken of [
    { ...valid, recent: [] },
    { ...valid, first: { ...valid.first, ttftMs: -1 } },
    { ...valid, speedOutputTokens: '240' },
    { ...valid, recent: [{ startedAt: 1, completedAt: 2 }] }
  ]) {
    assert.equal(streamStats.modelRequestResponseMetrics({ nativeResponseMetrics: broken }), undefined);
  }
});
