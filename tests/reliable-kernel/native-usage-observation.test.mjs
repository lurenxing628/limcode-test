import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { before, after, test } from 'node:test';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const workspace = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '../..');
const temp = mkdtempSync(path.join(tmpdir(), 'limcode-native-usage-observation-'));
process.env.NODE_PATH = [path.join(workspace, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
let stream, control, estimator, projection, token, contextUsage, contextView;

const viewStubs = new Map([
  ['@webview/composables/useReliableConversation',
    'export function useReliableConversation() { return globalThis.__nativeUsageViewFixture.conversation; }'],
  ['@webview/stores/useGlobalSettingsStore',
    'export function useGlobalSettingsStore() { return globalThis.__nativeUsageViewFixture.settings; }'],
  ['@webview/stores/useModelProfileStore',
    'export function useModelProfileStore() { return { localProfileFor() { return { profile: { providerConfigId: "config", model: "gpt-6-astra" } }; } }; }'],
  ['@webview/domain/reliableDetailKey',
    'export function reliableKernelDetailKey(kind, id) { return `${kind}:${id}`; }'],
  ['@webview/components/ui/HoverTooltipPanel.vue',
    'import { defineComponent, h } from "vue"; export default defineComponent({ props: ["rows", "panelTitle"], setup(props, { slots }) { return () => h("div", { class: "usage-tooltip" }, [...(props.rows ?? []).map(row => h("div", { class: "usage-tooltip-row" }, `${row.label}: ${row.value}`)), ...(slots.default?.() ?? [])]); } });']
]);

before(async () => {
  for (const [name, source] of Object.entries({
    stream: 'backend/capabilities/llmStreamEventProjection.ts',
    control: 'backend/reliableKernel/modelProviderControlPlane.ts',
    estimator: 'backend/reliableKernel/contextTokenEstimator.ts',
    projection: 'backend/reliableKernel/modelFacingContextProjection.ts',
    token: 'webview/src/components/conversation/tokenUsageModel.ts',
    contextUsage: 'webview/src/components/conversation/contextUsageModel.ts'
  })) {
    await build({
      entryPoints: [path.join(workspace, source)],
      outfile: path.join(temp, `${name}.cjs`),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['vscode', 'better-sqlite3'],
      logLevel: 'silent'
    });
  }
  stream = require(path.join(temp, 'stream.cjs'));
  control = require(path.join(temp, 'control.cjs'));
  estimator = require(path.join(temp, 'estimator.cjs'));
  projection = require(path.join(temp, 'projection.cjs'));
  token = require(path.join(temp, 'token.cjs'));
  contextUsage = require(path.join(temp, 'contextUsage.cjs'));
  const { parse, compileScript } = require('@vue/compiler-sfc');
  await build({
    entryPoints: [path.join(workspace, 'webview/src/components/conversation/ReliableContextStatus.vue')],
    outfile: path.join(temp, 'context-view.cjs'),
    bundle: true, platform: 'node', format: 'cjs', external: ['vue'], logLevel: 'silent',
    plugins: [{
      name: 'native-usage-vue-feed-fixture',
      setup(buildOptions) {
        buildOptions.onLoad({ filter: /ReliableContextStatus\.vue$/ }, (args) => {
          const source = readFileSync(args.path, 'utf8');
          const { descriptor, errors } = parse(source, { filename: args.path });
          if (errors.length) throw new Error(String(errors[0]));
          return { contents: compileScript(descriptor, { id: 'native-usage-feed', inlineTemplate: true }).content,
            loader: 'ts', resolveDir: path.dirname(args.path) };
        });
        buildOptions.onResolve({ filter: /^@webview\// }, (args) => {
          if (!viewStubs.has(args.path)) throw new Error(`Unexpected view import ${args.path}`);
          return { path: args.path, namespace: 'native-usage-view-stub' };
        });
        buildOptions.onLoad({ filter: /.*/, namespace: 'native-usage-view-stub' }, (args) => ({
          contents: viewStubs.get(args.path), loader: 'ts'
        }));
      }
    }]
  });
  contextView = require(path.join(temp, 'context-view.cjs')).default;
});
after(() => rmSync(temp, { recursive: true, force: true }));

const observation = (responseId, streamSeq, usage, options = {}) => ({
  responseId, streamSeq, usage, ...options
});

test('100k+110k+120k 属链累计计费；最新物理响应只有 120k 输入，不能假装 330k 当前占用', () => {
  const aggregate = new stream.NativePhysicalUsageAccumulator();
  aggregate.beginResponse('resp-1');
  aggregate.observeUsage('resp-1', { promptTokenCount: 100_000, candidatesTokenCount: 1000 });
  aggregate.beginResponse('resp-2');
  aggregate.observeUsage('resp-2', { promptTokenCount: 110_000, candidatesTokenCount: 2000 });
  aggregate.beginResponse('resp-3');
  aggregate.observeUsage('resp-3', { promptTokenCount: 120_000, candidatesTokenCount: 3000 });
  assert.equal(aggregate.billingTotals().promptTokenCount, 330_000);
  assert.equal(aggregate.billingTotals().candidatesTokenCount, 6000);
  assert.equal(aggregate.latestUsage().promptTokenCount, 120_000);
  const latest = control.foldNativeResponseUsage(undefined,
    observation('resp-3', '15', { input_tokens: 120_000, output_tokens: 3000 }), '1', '1');
  assert.equal(latest.inputTokens, 120_000);
  assert.notEqual(latest.inputTokens, aggregate.billingTotals().promptTokenCount);
});

test('重连及同响应控制事件重复投递幂等；旧 response 不可能反向替换最新物理观测', () => {
  const aggregate = new stream.NativePhysicalUsageAccumulator();
  aggregate.beginResponse('resp-1');
  aggregate.observeUsage('resp-1', { promptTokenCount: 100_000 });
  aggregate.beginResponse('resp-2');
  aggregate.observeUsage('resp-2', { promptTokenCount: 110_000 });
  aggregate.beginResponse('resp-2');
  aggregate.observeUsage('resp-2', { promptTokenCount: 110_000 });
  aggregate.beginResponse('resp-3');
  aggregate.observeUsage('resp-3', { promptTokenCount: 120_000 });
  aggregate.beginResponse('resp-1');
  aggregate.observeUsage('resp-1', { promptTokenCount: 100_000 });
  assert.equal(aggregate.billingTotals().promptTokenCount, 330_000);
  const first = control.foldNativeResponseUsage(undefined,
    observation('resp-1', '10', { input_tokens: 100_000 }), '1', '1');
  const next = control.foldNativeResponseUsage(first,
    observation('resp-2', '20', { input_tokens: 110_000 }, { previousResponseId: 'resp-1' }), '1', '1');
  assert.deepEqual(control.foldNativeResponseUsage(next,
    observation('resp-2', '20', { input_tokens: 110_000 }, { previousResponseId: 'resp-1' }), '1', '1'), next);
  assert.deepEqual(control.foldNativeResponseUsage(next,
    observation('resp-1', '10', { input_tokens: 100_000 }), '1', '1'), next);
  assert.deepEqual(control.foldNativeResponseUsage(next,
    observation('resp-2', '1', { input_tokens: 110_000 }, { previousResponseId: 'resp-1' }), '1', '2'), next,
    '重连后同一物理 response 即使新 socket 的 streamSeq 重置，也不能重复计数');
  const resumed = control.foldNativeResponseUsage(next,
    observation('resp-3', '3', { input_tokens: 120_000 }, { previousResponseId: 'resp-2' }), '1', '2');
  assert.equal(resumed.physicalResponseCount, 3);
  assert.equal(resumed.inputTokens, 120_000);
  assert.deepEqual(control.foldNativeResponseUsage(resumed,
    observation('resp-1', '100', { input_tokens: 100_000 }), '1', '1'), resumed);
  assert.deepEqual(control.foldNativeResponseUsage(resumed,
    observation('resp-1', '1', { input_tokens: 100_000 }), '1', '3'), resumed,
    '跨 socket 旧 r1 重播无前驱不能以 count4/input100 倒退覆盖已提交 r3/input120');
  assert.deepEqual(control.foldNativeResponseUsage(resumed,
    observation('resp-1', '2', { input_tokens: 100_000 }, { previousResponseId: 'resp-old' }), '1', '3'), resumed,
    '跨 socket 错误前驱不构成 r3 的后继证据');
  const successor = control.foldNativeResponseUsage(resumed,
    observation('resp-4', '3', { input_tokens: 130_000 }, { previousResponseId: 'resp-3' }), '1', '3');
  assert.equal(successor.inputTokens, 130_000, '跨 socket 有真实前驱时允许新响应');
  assert.throws(() => control.foldNativeResponseUsage(next,
    observation('resp-2', '20', { input_tokens: 200_000 }, { previousResponseId: 'resp-1' }), '1', '1'), /conflict|不同|冲突/i);
});

test('迟到的前一响应完成事件必须按物理 responseId 入账，不能冒充新响应使用量', () => {
  const aggregate = new stream.NativePhysicalUsageAccumulator();
  aggregate.beginResponse('resp-1');
  aggregate.beginResponse('resp-2');
  aggregate.observeUsage('resp-1', { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 });
  assert.equal(aggregate.latestUsage(), undefined, 'r1.completed 不能给已经创建的 r2 冒充 input100');
  aggregate.observeUsage('resp-2', { promptTokenCount: 200, candidatesTokenCount: 20, totalTokenCount: 220 });
  assert.equal(aggregate.latestUsage().promptTokenCount, 200);
  assert.equal(aggregate.billingTotals().promptTokenCount, 300);
  assert.equal(aggregate.billingTotals().candidatesTokenCount, 30);
  assert.equal(aggregate.billingTotals().totalTokenCount, 330);
  aggregate.observeUsage('resp-forged', { promptTokenCount: 1, candidatesTokenCount: 1 });
  assert.equal(aggregate.billingTotals().promptTokenCount, 300, '未见 response.created 的账单不能按猜测认领');
});

test('原生无 usage 或覆盖证据不足时原样未知；缓存细项不误作独立输入或 0', () => {
  const unknown = control.foldNativeResponseUsage(undefined, observation('resp-1', '1', undefined), '1', '1');
  assert.equal(unknown.inputTokens, undefined);
  assert.equal(unknown.outputTokens, undefined);
  assert.equal(unknown.contextCovered, undefined);
  const cached = control.foldNativeResponseUsage(unknown,
    observation('resp-2', '2', {
      input_tokens: 120_000,
      input_tokens_details: { cached_tokens: 108_000 },
      output_tokens: 3500
    }, { previousResponseId: 'resp-1', contextRootId: 'root-initial' }), '1', '1');
  assert.equal(cached.inputTokens, 120_000);
  assert.equal(cached.outputTokens, 3500);
  assert.equal(cached.contextCovered, undefined, '仅 rootId 不构成真实覆盖证明');
  assert.equal(control.nativeResponseContextTokens(cached, 'root-initial'), undefined);
  const exact = control.foldNativeResponseUsage(undefined,
    observation('resp-1', '1', { input_tokens: 100_000 }, { contextRootId: 'root-initial', contextCovered: true }), '1', '1');
  assert.equal(control.nativeResponseContextTokens(exact, 'root-initial'), 100_000);
  assert.equal(control.nativeResponseContextTokens(exact, 'root-edited'), undefined);
  assert.equal(control.nativeResponseContextTokens({ ...exact, inputTokens: undefined }, 'root-initial'), undefined);
  assert.equal(control.nativeResponseContextTokens({ ...exact, contextCovered: undefined }, 'root-initial'), undefined);
});

test('试次/连接代/顺序防止旧回放上位；同 identity 不得用冲突 frontier 宣称精确', () => {
  const newer = control.foldNativeResponseUsage(undefined,
    observation('resp-2', '23', { input_tokens: 120_000 }), '2', '4');
  assert.deepEqual(control.foldNativeResponseUsage(newer,
    observation('resp-old', '10', { input_tokens: 100_000 }), '1', '4'), newer);
  assert.deepEqual(control.foldNativeResponseUsage(newer,
    observation('resp-old', '25', { input_tokens: 100_000 }), '2', '3'), newer);
  assert.deepEqual(control.foldNativeResponseUsage(newer,
    observation('resp-old', '22', { input_tokens: 100_000 }), '2', '4'), newer);
  assert.throws(() => control.foldNativeResponseUsage(newer,
    observation('resp-other', '23', { input_tokens: 120_000 }), '2', '4'), /conflict|不同|冲突/i);
  assert.throws(() => control.foldNativeResponseUsage(newer,
    observation('resp-2', '23', { input_tokens: 120_000 }, { contextRootId: 'root-forged', contextCovered: true }), '2', '4'), /conflict|不同|冲突/i);
});

test('任一物理响应无实际 usage 时链计费 input/total 不能把已知小计冒充完整总额', () => {
  const aggregate = new stream.NativePhysicalUsageAccumulator();
  aggregate.beginResponse('resp-1');
  aggregate.observeUsage('resp-1', { promptTokenCount: 100_000, candidatesTokenCount: 2000 });
  aggregate.beginResponse('resp-no-usage');
  aggregate.beginResponse('resp-3');
  aggregate.observeUsage('resp-3', { promptTokenCount: 120_000, candidatesTokenCount: 2500 });
  const partial = aggregate.billingTotals();
  assert.equal(partial.promptTokenCount, undefined);
  assert.equal(partial.candidatesTokenCount, undefined);
  assert.equal(partial.totalTokenCount, undefined);
  assert.equal(partial.nativeChainUsageIncomplete, true);
  const allUnknown = new stream.NativePhysicalUsageAccumulator();
  allUnknown.beginResponse('resp-unknown');
  assert.deepEqual(allUnknown.billingTotals(), { nativeChainUsageIncomplete: true },
    '全链没有任何 raw usage 时必须显式保留 native 未知，而不是生成假 0 或失去原生标记');
  assert.deepEqual(token.normalizeTokenUsage({ ...allUnknown.billingTotals(), nativeChainBilling: true }),
    { nativeChainBilling: true }, '无实际用量不能从标志推断出输入、输出、总额');
});


test('raw 某响应缺 total 时不得保留上一个 total 小计，细项缓存/思考部分可见不可当完整总和', () => {
  const aggregate = new stream.NativePhysicalUsageAccumulator();
  aggregate.beginResponse('r1');
  aggregate.observeUsage('r1', { promptTokenCount: 100, candidatesTokenCount: 10,
    totalTokenCount: 110, cachedContentTokenCount: 50, thoughtsTokenCount: 2 });
  aggregate.beginResponse('r2');
  aggregate.observeUsage('r2', { promptTokenCount: 200, candidatesTokenCount: 20 });
  const totals = aggregate.billingTotals();
  assert.equal(totals.promptTokenCount, 300);
  assert.equal(totals.candidatesTokenCount, 30);
  assert.equal(totals.totalTokenCount, 330,
    '两响应都有实际 input/output 时可有界计算总额，而不是残留 r1 的 total110');
  assert.equal(totals.cachedContentTokenCount, undefined,
    'r2 无缓存细项时 r1 的 cached50 不能成为全链已知缓存总额');
  assert.equal(totals.thoughtsTokenCount, undefined);
  assert.equal(totals.nativeChainUsageDetailsIncomplete, true);
  assert.equal(token.normalizeTokenUsage({ ...totals, nativeChainBilling: true }).output, 30,
    '底栏/明细不能因残留 total110-input300 被钳为 output0');
});

test('原生 latest 身份必须匹配实际当前 root 与试次；累计计费和已压缩 root 不标精确', () => {
  const latest = {
    responseId: 'resp-3', streamSeq: '7', attemptSeq: '1', socketGeneration: '2',
    physicalResponseCount: 3, inputTokens: 120_000, contextRootId: 'root-old', contextCovered: true
  };
  const stats = { attemptSeq: '1', socketGeneration: '2', nativeCapabilities: { steering: true }, nativeLatestResponseUsage: latest };
  assert.deepEqual(token.nativePhysicalContextUsage(stats, 'root-old'), {
    responseId: 'resp-3', inputTokens: 120_000, exact: true
  });
  assert.equal(token.nativePhysicalContextUsage(stats, 'root-compressed').exact, false);
  assert.equal(token.nativePhysicalContextUsage({ ...stats, socketGeneration: '3' }, 'root-old').exact, false);
  assert.equal(token.nativePhysicalContextUsage({ ...stats, nativeLatestResponseUsage: {
    ...latest, contextCovered: undefined
  } }, 'root-old').exact, false);
  assert.deepEqual(token.nativePhysicalContextUsage({ ...stats, nativeLatestResponseUsage: {
    ...latest, inputTokens: undefined
  } }, 'root-old'), { responseId: 'resp-3', exact: false });
  assert.equal(token.normalizeTokenUsage({ totalTokenCount: 330_000 }).input, undefined);
  assert.equal(token.nativePhysicalContextUsage(stats, 'root-compressed').inputTokens, 120_000,
    '可展示最近实际物理输入，但不能宣称压缩后 root 大小');
  assert.equal(token.currentRootEstimatedTokens('root-compressed', 16_000, 'root-old', 330_000), 16_000,
    '当前 root 的估算不能被上一个请求的链计费/估算覆盖');
  assert.equal(token.currentRootEstimatedTokens('root-compressed', undefined, 'root-old', 330_000), undefined,
    '当前 root 没有独立估算时不能沿用旧请求');
  assert.equal(token.currentRootEstimatedTokens('root-compressed', undefined, 'root-compressed', 18_000), 18_000,
    '仅 root 身份相同时才允许回退到请求的冻结估算');
  assert.equal(token.currentRootEstimatedTokens(undefined, undefined, 'root-old', 330_000), undefined,
    '不知道当前 root 时绝不以历史请求填充');
  assert.equal(token.currentRootEstimatedTokens('root-zero', 0, 'root-old', 330_000), 0,
    '真实的空 root 估算为 0，不是对缺失 usage 的臆测');
});

test('普通渠道原有系统提示与工具用量口径不受 native 物理计费调整影响', () => {
  const message = (id, seq, role, usageMetadata) => ({
    id, seq, createdAt: seq, status: 'materialized', role, usageMetadata
  });
  const entries = token.buildTokenUsageMessages([
    message('user-1', 1, 'user', { promptTokenCount: 10, totalTokenCount: 10 }),
    message('model-1', 2, 'model', { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 }),
    message('user-2', 3, 'user', { promptTokenCount: 5, totalTokenCount: 5 }),
    message('model-2', 4, 'model', { promptTokenCount: 140, candidatesTokenCount: 15, totalTokenCount: 155 })
  ]);
  assert.equal(entries.find((entry) => entry.kind === 'system')?.total, 110,
    '普通渠道系统提示仍按首次 total 减已知用户输入的原有口径');
  assert.equal(entries.find((entry) => entry.id === 'model-2')?.tool, 35,
    '普通渠道后续工具估算仍按连续两次输入增量扣用户输入的原有口径');
  assert.equal(token.buildTokenUsageMessages([
    message('model-total-only', 1, 'model', { totalTokenCount: 40 })
  ]).find((entry) => entry.id === 'model-total-only')?.total, 40,
  '普通渠道只有 total 的模型消息明细仍显示原有 total');
});

test('raw Responses 缓存是输入子集，不额外加钱；物理 usage 丢失依旧 unknown', () => {
  assert.deepEqual(stream.nativeUsageMetadataFromResponse({
    input_tokens: 120_000, output_tokens: 2500, total_tokens: 122_500,
    input_tokens_details: { cached_tokens: 110_000 },
    output_tokens_details: { reasoning_tokens: 500 }
  }), {
    promptTokenCount: 120_000,
    candidatesTokenCount: 2500,
    totalTokenCount: 122_500,
    cachedContentTokenCount: 110_000,
    thoughtsTokenCount: 500
  });
  assert.equal(stream.nativeUsageMetadataFromResponse({}), undefined);
  assert.equal(stream.nativeUsageMetadataFromResponse({ input_tokens: -1, output_tokens: Infinity }), undefined);
  assert.equal(token.normalizeTokenUsage({ candidatesTokenCount: 70, thoughtsTokenCount: 30 }).output, 100,
    '非 native 的 Gemini 等无 total 元数据仍需额外计入推理输出');
  assert.equal(token.normalizeTokenUsage({ candidatesTokenCount: 70, thoughtsTokenCount: 30,
    nativeChainBilling: true }).output, 70,
    'OpenAI 原生 output_tokens 已包括推理，不得再加一次');
  assert.equal(token.normalizeTokenUsage({ thoughtsTokenCount: 30, nativeChainBilling: true }).output, undefined,
    '原生只有 reasoning 子集时不能冒充完整 output 用量');
  assert.equal(token.buildTokenUsageMessages([{ id: 'reasoning-only', seq: 1, createdAt: 1,
    status: 'materialized', role: 'model',
    usageMetadata: { thoughtsTokenCount: 30, nativeChainBilling: true } }]).length, 0,
  '明细栏不可把只知 reasoning 子集包装为完整模型输出柱子');
  assert.equal(token.normalizeTokenUsage({ promptTokenCount: 300, candidatesTokenCount: 30,
    totalTokenCount: 110, nativeChainBilling: true }).output, 30,
    '真实 native output 不能被不一致的残留 total 钳成 0');
  assert.deepEqual(token.nativePhysicalContextUsage({
    attemptSeq: '1', socketGeneration: '1',
    nativeLatestResponseUsage: { responseId: 'resp-unknown', contextRootId: 'root-1', contextCovered: true }
  }, 'root-1'), { responseId: 'resp-unknown', exact: false });
  const nativeMessage = { id: 'model-billed', seq: 1, createdAt: 1, status: 'materialized', role: 'model',
    usageMetadata: { promptTokenCount: 330_000, candidatesTokenCount: 7000, nativeChainBilling: true } };
  assert.equal(token.buildTokenUsageMessages([nativeMessage]).some((entry) => entry.kind === 'system'), false,
    '不能把原生链 330k 计费推成系统提示体积');
  const nativeWithoutInput = { ...nativeMessage, id: 'native-unknown-input',
    usageMetadata: { candidatesTokenCount: 100, nativeChainBilling: true } };
  const laterOrdinary = { ...nativeMessage, id: 'later-ordinary', seq: 2, createdAt: 2,
    usageMetadata: { promptTokenCount: 120_000, candidatesTokenCount: 100 } };
  assert.equal(token.buildTokenUsageMessages([nativeWithoutInput, laterOrdinary])
    .some((entry) => entry.kind === 'system'), false,
    '更早 native 无实际输入时，不应从后来普通请求反推出系统提示体积');
});


function contextStatusFixture({ native = false, input = 24_000, estimated = 80_000 } = {}) {
  const request = {
    id: 'request', turn_id: 'turn', status: 'terminal', terminal_state: 'completed', request_seq: '1',
    provider_id: 'config', model_id: 'gpt-6-astra', context_window_tokens: 200_000,
    compression_threshold_tokens: 100_000, estimated_context_tokens: 150_000,
    created_at: '2026-09-25T12:00:00.000Z',
    usage_json: native
      ? { promptTokenCount: 330_000, candidatesTokenCount: 6000, nativeChainBilling: true }
      : { promptTokenCount: input, candidatesTokenCount: 1000 },
    stream_stats_json: native ? {
      attemptSeq: '1', socketGeneration: '1', nativeCapabilities: { asyncTools: true },
      nativeLatestResponseUsage: { responseId: 'resp-latest', inputTokens: input, contextRootId: 'root-request',
        attemptSeq: '1', socketGeneration: '1', streamSeq: '10', physicalResponseCount: 3 }
    } : { attemptSeq: '1', socketGeneration: '1' }
  };
  return {
    conversation: { conversationId: { value: 'conv' }, feed: {
      records: {
        Turn: { turn: { id: 'turn', conversation_id: 'conv', created_at: request.created_at } },
        ModelRequest: { request },
        ModelRequestMessageLink: { link: { id: 'link', model_request_id: 'request', message_id: 'message' } },
        ModelContextProjection: { projection: { owner_kind: 'model_request', owner_id: 'request', root_id: 'root-request' } },
        ConversationContextStatus: { head: { id: 'head', conversation_id: 'conv', root_id: 'root-after-output', estimated_tokens: estimated } }
      }, transientModelRequests: {}, details: {}, requestDetail() { throw new Error('No details needed'); }
    } },
    settings: {
      llmProviderConfigs: { configs: [{ id: 'config', provider: native ? 'openai-responses' : 'openai-compatible',
        model: 'gpt-6-astra', contextWindowTokens: 200_000, modelConfigs: [] }] },
      llm: { activeProviderConfigId: 'config' },
      llmCompression: { defaultConfigId: 'compression', modelBindings: [], providerBindings: [] },
      llmCompressionConfigs: { configs: [{ id: 'compression', kind: 'auto',
        trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 100_000 } }] }
    }
  };
}

async function renderContextStatus(fixture) {
  globalThis.__nativeUsageViewFixture = fixture;
  try {
    const { createSSRApp } = require('vue');
    const { renderToString } = require('@vue/server-renderer');
    return await renderToString(createSSRApp(contextView));
  } finally { delete globalThis.__nativeUsageViewFixture; }
}

function primaryContextLabel(html) {
  return /class="reliable-context-label"[^>]*>([^<]*)</.exec(html)?.[1];
}

test('状态框不显示文字前缀和解释段落，悬浮面板只保留必要字段', async () => {
  const html = await renderContextStatus(contextStatusFixture());
  assert.equal(primaryContextLabel(html), '24k / 200k');
  assert.deepEqual([...html.matchAll(/class="usage-tooltip-row">([^<]*)</g)].map(match => match[1]), [
    '模型: gpt-6-astra', '输入: 24,000 Token', '窗口: 200,000 Token', '占比: 12%', '压缩阈值: 100,000 Token'
  ]);
  for (const fixture of [contextStatusFixture(), contextStatusFixture({ native: true }), contextStatusFixture({ estimated: 95_000 })]) {
    assert.doesNotMatch(await renderContextStatus(fixture),
      /最近输入|待计量|非当前占用|不代表|尚未|仅用于|数据来源|预检决定|最近请求采用阈值|reliable-context-kind|（|）/);
  }
});

for (const native of [false, true]) test(`${native ? '原生' : '普通'}请求运行和重试期间沿用上一轮实际计量，新计量到达才更新`, async () => {
  const fixture = contextStatusFixture({ native, input: 24_000, estimated: 40_000 });
  const records = fixture.conversation.feed.records;
  const next = { ...records.ModelRequest.request, id: 'request-next', request_seq: '2',
    status: 'streaming', terminal_state: null, usage_json: null,
    stream_stats_json: { attemptSeq: '1', socketGeneration: '1', ...(native ? { nativeCapabilities: { asyncTools: true } } : {}) } };
  records.ModelRequest.next = next;
  records.ModelRequestMessageLink.next = { model_request_id: next.id, message_id: 'message-next' };
  records.ModelContextProjection.next = { owner_kind: 'model_request', owner_id: next.id, root_id: 'root-after-output' };
  for (const status of ['streaming', 'retrying']) {
    next.status = status;
    const running = await renderContextStatus(fixture);
    assert.equal(primaryContextLabel(running), '24k / 200k');
    assert.doesNotMatch(running, /待计量|最近输入|reliable-context-kind/);
  }
  next.status = 'streaming';
  if (native) {
    next.stream_stats_json.nativeLatestResponseUsage = { responseId: 'resp-next', inputTokens: 32_000,
      contextRootId: 'root-after-output', attemptSeq: '1', socketGeneration: '1', streamSeq: '3', physicalResponseCount: 1 };
  } else {
    next.usage_json = { promptTokenCount: 32_000, candidatesTokenCount: 1200 };
  }
  assert.equal(primaryContextLabel(await renderContextStatus(fixture)), '32k / 200k');
  next.status = 'terminal';
  next.terminal_state = 'completed';
  assert.equal(primaryContextLabel(await renderContextStatus(fixture)), '32k / 200k');
});

test('运行中回查上一轮计量只在本对话普通请求中取值，不取其它对话或压缩请求', async () => {
  const fixture = contextStatusFixture();
  const records = fixture.conversation.feed.records;
  records.ModelRequest.request.status = 'streaming';
  records.ModelRequest.request.usage_json = null;
  records.Turn.foreign = { id: 'foreign-turn', conversation_id: 'other', created_at: '2026-09-25T13:00:00.000Z' };
  records.ModelRequest.foreign = { ...records.ModelRequest.request, id: 'foreign-request', turn_id: 'foreign-turn',
    status: 'terminal', usage_json: { promptTokenCount: 999_000 } };
  records.ModelRequestMessageLink.foreign = { model_request_id: 'foreign-request', message_id: 'foreign-message' };
  records.ModelRequest.compression = { ...records.ModelRequest.request, id: 'compression-request', request_seq: '2',
    status: 'terminal', usage_json: { promptTokenCount: 888_000 } };
  const html = await renderContextStatus(fixture);
  assert.equal(primaryContextLabel(html), '? / 200k');
  assert.doesNotMatch(html, /待计量|999|888/);
});

test('回复提交使 root 前进后，底部保留最近实际输入，不用偏大的估算替代主数字', async () => {
  const html = await renderContextStatus(contextStatusFixture());
  assert.equal(primaryContextLabel(html), '24k / 200k', '楼层输入24k，不应被当前root的80k估算替换');
  assert.doesNotMatch(html, /最近输入|待计量|reliable-context-kind/);
  assert.doesNotMatch(html, /≈|当前估算|压缩预估/);
});

test('原生底部显示最近物理输入而非链累计计费，不要求它与楼层330k计费强行相等', async () => {
  const html = await renderContextStatus(contextStatusFixture({ native: true, input: 120_000, estimated: 80_000 }));
  assert.equal(primaryContextLabel(html), '120k / 200k');
  assert.doesNotMatch(html, /最近输入|待计量|reliable-context-kind/);
  assert.doesNotMatch(html, /330k|≈80k|is-over-threshold/);
});

test('预估只在临近压缩时单独提示，不替换实际主数字；关闭或手动压缩不提示', async () => {
  const fixture = contextStatusFixture({ estimated: 89_999 });
  const trigger = fixture.settings.llmCompressionConfigs.configs[0].trigger;
  assert.doesNotMatch(await renderContextStatus(fixture), /压缩预估/);
  fixture.conversation.feed.records.ConversationContextStatus.head.estimated_tokens = 90_000;
  const near = await renderContextStatus(fixture);
  assert.equal(primaryContextLabel(near), '24k / 200k');
  assert.match(near, /压缩预估: ≈90,000 Token/);
  assert.match(near, /临近压缩/);
  assert.doesNotMatch(near, /width:45%/, '进度条也不能把估算冒充实际输入');
  fixture.conversation.feed.records.ConversationContextStatus.head.estimated_tokens = 100_000;
  assert.match(await renderContextStatus(fixture), /预估达阈值/);
  trigger.mode = 'manual';
  assert.doesNotMatch(await renderContextStatus(fixture), /压缩预估|临近压缩|is-over-threshold/);
  trigger.mode = 'token_threshold';
  fixture.settings.llmCompressionConfigs.configs[0].kind = 'disabled';
  assert.doesNotMatch(await renderContextStatus(fixture), /压缩预估|临近压缩|is-over-threshold/);
});

test('未提供实际输入时常态保持未知，只有临近压缩的独立提示可用估算', async () => {
  const fixture = contextStatusFixture({ native: true });
  delete fixture.conversation.feed.records.ModelRequest.request.stream_stats_json.nativeLatestResponseUsage.inputTokens;
  const unknown = await renderContextStatus(fixture);
  assert.equal(primaryContextLabel(unknown), '? / 200k');
  assert.doesNotMatch(unknown, /330k|≈|压缩预估/);
  fixture.conversation.feed.records.ConversationContextStatus.head.estimated_tokens = 95_000;
  const near = await renderContextStatus(fixture);
  assert.equal(primaryContextLabel(near), '? / 200k');
  assert.match(near, /压缩预估: ≈95,000 Token/);
});

test('当前root实测优先：原生覆盖证明不被逻辑请求最初root否定，缺少证明不假称当前占用', async () => {
  const fixture = contextStatusFixture({ native: true, input: 24_000, estimated: 100_000 });
  const latest = fixture.conversation.feed.records.ModelRequest.request.stream_stats_json.nativeLatestResponseUsage;
  latest.contextRootId = 'root-after-output';
  latest.contextCovered = true;
  const exact = await renderContextStatus(fixture);
  assert.equal(primaryContextLabel(exact), '24k / 200k');
  assert.match(exact, /输入: 24,000 Token/);
  assert.doesNotMatch(exact, /压缩预估|最近输入/);
  delete latest.contextCovered;
  assert.match(await renderContextStatus(fixture), /压缩预估: ≈100,000 Token/);
});

test('压缩提示只占阈值前10%且最多16k的范围，不改变后端预算或把历史输入当当前超限', () => {
  const observation = { quality: 'recent', native: false, tokens: 5000 };
  const hint = (estimatedTokens, thresholdTokens) => contextUsage.compressionEstimateHint({
    automatic: true, observation, estimatedTokens, thresholdTokens
  });
  assert.equal(hint(179_999, 200_000), undefined);
  assert.equal(hint(183_999, 200_000), undefined);
  assert.deepEqual(hint(184_000, 200_000), { tokens: 184_000, atThreshold: false });
  assert.equal(hint(899, 1000), undefined, '小阈值不能因16k余量而始终展示估算');
  assert.deepEqual(hint(900, 1000), { tokens: 900, atThreshold: false });
  assert.equal(hint(undefined, 1000), undefined);
  assert.equal(hint(950, undefined), undefined);
  assert.equal(hint(-1, 1000), undefined);
  assert.equal(hint(Infinity, 1000), undefined);
});

test('实际输入保留零值，标记为预估的 usage 和缺物理计量的原生计费不能冒充实测', async () => {
  const fixture = contextStatusFixture({ input: 0, estimated: 10_000 });
  fixture.conversation.feed.records.ConversationContextStatus.head.root_id = 'root-request';
  const zero = await renderContextStatus(fixture);
  assert.equal(primaryContextLabel(zero), '0 / 200k');
  assert.match(zero, /输入: 0 Token/);
  fixture.conversation.feed.records.ModelRequest.request.usage_json = { promptTokenCount: 20_000, estimated: true };
  assert.equal(primaryContextLabel(await renderContextStatus(fixture)), '? / 200k');
  fixture.conversation.feed.records.ModelRequest.request.usage_json = { promptTokenCount: 330_000, nativeChainBilling: true };
  assert.equal(primaryContextLabel(await renderContextStatus(fixture)), '? / 200k');
});

test('已压缩root不因上一请求的大额实测而报警；缺当前root估算时也不借用旧估算', async () => {
  const fixture = contextStatusFixture({ input: 150_000, estimated: 16_000 });
  const compressed = await renderContextStatus(fixture);
  assert.equal(primaryContextLabel(compressed), '150k / 200k');
  assert.doesNotMatch(compressed, /最近输入|非当前占用/);
  assert.doesNotMatch(compressed, /is-over-threshold|压缩预估/);
  delete fixture.conversation.feed.records.ConversationContextStatus.head.estimated_tokens;
  const withoutEstimate = await renderContextStatus(fixture);
  assert.equal(primaryContextLabel(withoutEstimate), '150k / 200k');
  assert.doesNotMatch(withoutEstimate, /is-over-threshold|压缩预估/);
});

test('Vue feed 中压缩后编辑/追加的新 root 不常态展示估算，也不沿用旧压缩块或请求的数字', async () => {
  const { createSSRApp } = require('vue');
  const { renderToString } = require('@vue/server-renderer');
  const root = {
    id: 'head', conversation_id: 'conv', root_id: 'root-compressed',
    root_created_at: '2026-09-24T12:00:01.000Z', estimated_tokens: 60_000
  };
  const fixture = {
    conversation: {
      conversationId: { value: 'conv' },
      feed: {
        records: {
          Turn: { turn: { id: 'turn', conversation_id: 'conv', created_at: '2026-09-24T12:00:00.000Z' } },
          ModelRequest: { request: { id: 'request', turn_id: 'turn', status: 'terminal',
            request_seq: '1', model_id: 'gpt-6-astra', provider_id: 'config', context_window_tokens: 130_000,
            estimated_context_tokens: 100_000, created_at: '2026-09-24T12:00:00.000Z' } },
          ModelRequestMessageLink: { link: { model_request_id: 'request' } },
          ModelContextProjection: {
            projection: { owner_kind: 'model_request', owner_id: 'request', root_id: 'root-old' },
            compressionSource: { owner_kind: 'compression_block', owner_id: 'block',
              root_id: 'root-old', purpose: 'compression-source' }
          },
          CompressionBlock: { block: { id: 'block', conversation_id: 'conv', status: 'enabled',
            created_at: '2026-09-24T12:00:01.000Z' } },
          ConversationContextStatus: { head: root }
        },
        details: { 'compression-presentation:block': {
          status: 'ready', text: JSON.stringify({ calibratedTokensAfter: 80_000 })
        } },
        transientModelRequests: {},
        requestDetail() { throw new Error('Fixture detail is already available.'); }
      }
    },
    settings: {
      llmProviderConfigs: { configs: [{ id: 'config', provider: 'openai-responses',
        model: 'gpt-6-astra', contextWindowTokens: 130_000, modelConfigs: [] }] },
      llm: { activeProviderConfigId: 'config' },
      llmCompression: { defaultConfigId: 'compression', modelBindings: [], providerBindings: [] },
      llmCompressionConfigs: { configs: [{ id: 'compression', kind: 'auto',
        trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 100_000 } }] }
    }
  };
  globalThis.__nativeUsageViewFixture = fixture;
  try {
    const htmlForCurrentFeed = () => renderToString(createSSRApp(contextView));
    const compressed = await htmlForCurrentFeed();
    assert.match(compressed, /\? \/ 130k/, '压缩后没有实际观测且远离阈值，不再常态显示60k估算');
    assert.doesNotMatch(compressed, /≈60k|压缩预估/);
    assert.doesNotMatch(compressed, /80k/, '即使压缩块与 head 同事务创建，当前 root 独立估算也优先');
    root.root_id = 'root-edited-same-timestamp';
    root.estimated_tokens = null;
    const editedSameTimestamp = await htmlForCurrentFeed();
    assert.match(editedSameTimestamp, /\? \/ 130k/,
      '编辑生成的新 root 与历史压缩块时间戳完全相同时也必须显示未知');
    assert.doesNotMatch(editedSameTimestamp, /80k|≈100k|≈0k/,
      '历史 calibrated80k、旧请求100k 与伪0均不能作为新 root 当前占用');
    root.root_id = 'root-compressed';
    delete root.estimated_tokens;
    const compressedWithoutEstimate = await htmlForCurrentFeed();
    assert.match(compressedWithoutEstimate, /\? \/ 130k/,
      '即使恰同时间，压缩块无显式输出 root link 时不能假称校准归属');
    assert.doesNotMatch(compressedWithoutEstimate, /80k|≈100k|≈0k/);
    root.root_id = 'root-edited';
    root.root_created_at = '2026-09-24T12:00:03.000Z';
    root.estimated_tokens = 16_000;
    const edited = await htmlForCurrentFeed();
    assert.match(edited, /\? \/ 130k/);
    assert.doesNotMatch(edited, /≈16k|压缩预估/);
    assert.doesNotMatch(edited, /80k/);
    root.root_id = 'root-added';
    root.root_created_at = '2026-09-24T12:00:04.000Z';
    delete root.estimated_tokens;
    const unknown = await htmlForCurrentFeed();
    assert.match(unknown, /\? \/ 130k/);
    assert.doesNotMatch(unknown, /80k|≈100k/, '缺当前 root 估算不得沿用旧块/旧请求');
  } finally {
    delete globalThis.__nativeUsageViewFixture;
  }
});


test('持久化只写既有 ModelRequest stats：重复回执不写，旧代失败，active request 能读到最新响应', async () => {
  let row = {
    id: 'request-1', status: 'streaming',
    stream_stats_json: { attemptSeq: '1', socketGeneration: '1', retryReason: null }
  };
  let writes = 0;
  const plane = Object.create(control.ModelProviderControlPlane.prototype);
  plane.now = () => '2026-01-01T00:00:00.000Z';
  plane.database = {
    snapshot: async () => ({ snapshot: [row] }),
    transaction: async (steps) => {
      const update = steps.find((step) => step.kind === 'update' && step.domain === 'ModelRequest');
      assert.ok(update && update.patch.stream_stats_json);
      row = { ...row, ...update.patch };
      writes += 1;
    }
  };
  const first = observation('resp-1', '10', { input_tokens: 100_000, output_tokens: 1000 });
  assert.equal(await plane.persistNativeResponseUsage(row.id, '1', '1', first), true);
  assert.equal((await plane.readNativeLatestResponseUsage(row.id)).inputTokens, 100_000);
  assert.equal((await plane.readNativeLatestResponseUsage(row.id)).physicalResponseCount, 1);
  assert.equal(await plane.persistNativeResponseUsage(row.id, '1', '1', first), true);
  assert.equal(writes, 1, '重复 stream checkpoint 必须保持写入幂等');
  assert.equal(await plane.persistNativeResponseUsage(row.id, '1', '0',
    observation('resp-stale', '12', { input_tokens: 1 })), false);
  assert.equal(writes, 1);
  assert.equal(await plane.persistNativeResponseUsage(row.id, '1', '1',
    observation('resp-2', '20', undefined, { previousResponseId: 'resp-1' })), true);
  assert.equal(writes, 2);
  const latest = await plane.readNativeLatestResponseUsage(row.id);
  assert.equal(latest.responseId, 'resp-2');
  assert.equal(latest.inputTokens, undefined);
  assert.equal(latest.physicalResponseCount, 2);
  assert.deepEqual(Object.keys(row.stream_stats_json).sort(),
    ['attemptSeq', 'nativeLatestResponseUsage', 'retryReason', 'socketGeneration']);
});


test('估算口径：Provider 观测只校准首响应根；压缩后窗口计算不能使用累计计费', () => {
  assert.deepEqual(estimator.nativePromptCalibration({
    nativeCapabilities: { steering: true },
    nativeInitialPromptTokenCount: 100_000,
    nativeLatestResponseUsage: { responseId: 'resp-3', inputTokens: 120_000 }
  }), { native: true, promptTokens: 100_000 });
  assert.deepEqual(estimator.nativePromptCalibration({
    nativeCapabilities: { steering: true },
    nativeLatestResponseUsage: { responseId: 'resp-3', inputTokens: 120_000 }
  }), { native: true });
  assert.deepEqual(estimator.nativePromptCalibration({
    nativeLatestResponseUsage: { responseId: 'resp-3', inputTokens: 120_000 }
  }), { native: true }, '仅有物理观测的 native 请求不能被当成非 native 用终态链计费校准');
  const billing = { promptTokenCount: 330_000, totalTokenCount: 336_000, nativeChainBilling: true };
  assert.equal(estimator.providerPromptTokens(billing), undefined,
    'native 聚合输出无 item 回退提交时也不能将累计计费写入新 Context root');
  assert.equal(estimator.providerTotalTokens(billing), undefined,
    'native 聚合 total 不是某个完整 provider prompt 的 Context 占用');
  assert.equal(estimator.providerPromptTokens({ promptTokenCount: 120_000 }), 120_000,
    '普通 provider 原有单请求观察保持可用');
  const english = estimator.estimateTextTokens('hello world '.repeat(1000));
  const chinese = estimator.estimateTextTokens('你好世界'.repeat(1000));
  assert.ok(english > 0 && chinese > 0);
  const calibration = projection.providerTokenCalibration(120_000, 60_000);
  assert.equal(projection.calibrateEstimatorToProvider(10_000, calibration), 20_000);
  const budget = projection.calculateFullRequestPlanningBudget({
    contextWindowTokens: 130_000, compressionThresholdTokens: 100_000,
    breakdown: { systemTokens: 1000, toolSchemaTokens: 1000, providerFramingTokens: 0,
      contextTokens: 10_000, currentInputTokens: 1000, runtimeDeliveryTokens: 0,
      turnReminderTokens: 0, mediaTokens: 0, fixedTokens: 2000, bodyTokens: 11_000,
      fullTokens: 13_000 }
  });
  assert.ok(budget.planningInputCapacityTokens < 130_000);
});
