import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { SingleResponseMeasurementReader } = require(path.join(compiled, 'backend/reliableKernel/singleResponseMeasurement.js'));
const { modelRequestObservedUsage, singleResponseMeasurement } = require(path.join(compiled, 'shared/modelRequestMeasurement.js'));
const { nativeSessionCapabilities } = require(path.join(compiled, 'shared/nativeSessionCapabilities.js'));

function fixture() {
  const request = { id: 'request', turn_id: 'turn', provider_id: 'provider', model_id: 'gpt-6-astra',
    recipe_object_id: 'recipe', authority_snapshot_id: 'authority', status: 'terminal', terminal_state: 'completed',
    usage_json: { nativeChainBilling: true, promptTokenCount: 537, candidatesTokenCount: 111, totalTokenCount: 648,
      cachedContentTokenCount: 500, thoughtsTokenCount: 11 },
    stream_stats_json: { attemptSeq: '1', socketGeneration: '1', providerStartedAt: 900,
      firstOutputAt: 1000, completedAt: 1210, streamOutputDurationMs: 210 } };
  const bodies = new Map([
    ['recipe', { kind: 'reliable-agent-turn', round: 1 }],
    ['authority-body', { model: { provider: 'openai-responses', providerConfigId: 'provider', modelId: 'gpt-6-astra', openaiResponsesTransport: 'http' } }],
    ['created-body', { kind: 'native_control', streamSeq: '1', content: { type: 'response.created', responseId: 'response',
      capabilities: { asyncTools: false, steering: false, reasoningUpdates: false, multiplexing: false, explicitCaching: false } } }],
    ['completed-body', { kind: 'native_control', streamSeq: '3', content: { type: 'response.completed', responseId: 'response',
      usage: { input_tokens: 537, output_tokens: 111, total_tokens: 648,
        input_tokens_details: { cached_tokens: 500 }, output_tokens_details: { reasoning_tokens: 11 } },
      timing: { startedAt: 1000, firstOutputAt: 1100, completedAt: 1200, ttftMs: 100, outputDurationMs: 100 } } }]
  ]);
  const controls = ['created', 'completed'].map((id, i) => ({ id, model_request_id: 'request', attempt_seq: 1n,
    socket_generation: 1n, stream_seq: BigInt(1 + i * 2), checkpoint_kind: 'native_control', content_object_id: `${id}-body` }));
  const metadata = [...bodies].map(([id]) => ({ id, byte_length: 1024n,
    content_type: id === 'recipe' ? 'application/vnd.limcode.model-request-recipe+json'
      : id === 'authority-body' ? 'application/vnd.limcode.turn-authority-snapshot+json'
      : 'application/vnd.limcode.model-stream-checkpoint+json' }));
  const tables = {
    ModelRequest: [request], ModelStreamCheckpoint: controls,
    ModelStreamFence: [{ id: 'fence', model_request_id: 'request', attempt_seq: 1n, socket_generation: 1n, terminal_stream_seq: 4n, outcome: 'completed' }],
    ContentObject: metadata, AuthoritySnapshot: [{ id: 'authority', turn_id: 'turn', content_object_id: 'authority-body' }]
  };
  let commit = '1', version = '1', reads = 0;
  const queries = [];
  const names = { model_request: 'ModelRequest', model_stream_checkpoint: 'ModelStreamCheckpoint',
    model_stream_fence: 'ModelStreamFence', content_object: 'ContentObject', authority_snapshot: 'AuthoritySnapshot' };
  const database = {
    inTransaction: true,
    pragma: name => { assert.equal(name, 'data_version'); return version; },
    prepare: sql => {
      const query = parameters => {
        queries.push({ sql, parameters });
        if (sql.includes('total_changes()')) return [{ value: commit }];
        if (sql === 'PRAGMA data_version') return [{ data_version: version }];
        const table = /FROM (\w+)/.exec(sql)?.[1];
        assert.ok(names[table], sql);
        const byRequest = sql.includes('model_request_id = ?');
        let matches = tables[names[table]].filter(row => row[byRequest ? 'model_request_id' : 'id'] === parameters[0]);
        const kind = /checkpoint_kind = '([^']+)'/.exec(sql)?.[1];
        if (kind) matches = matches.filter(row => row.checkpoint_kind === kind);
        const limit = /LIMIT (\d+)/.exec(sql)?.[1];
        if (limit) { assert.ok(Number(limit) <= 3); matches = matches.slice(0, Number(limit)); }
        return structuredClone(matches);
      };
      return { get: (...parameters) => query(parameters)[0], all: (...parameters) => query(parameters) };
    }
  };
  const store = { readVerifiedBytes: metadata => {
    reads++;
    if (!bodies.has(metadata.id)) throw new Error('CAS unavailable');
    return Buffer.from(JSON.stringify(bodies.get(metadata.id)));
  } };
  return { request, bodies, controls, metadata, tables, database, store, queries,
    reader: new SingleResponseMeasurementReader(database, store), get reads() { return reads; },
    localCommit() { commit = String(Number(commit) + 1); }, externalCommit() { version = String(Number(version) + 1); } };
}

test('会话资格单一判定：缓存和多路复用本身不构成原生执行', () => {
  assert.equal(nativeSessionCapabilities(undefined), undefined);
  assert.equal(nativeSessionCapabilities({ explicitCaching: true, multiplexing: true }), undefined);
  for (const key of ['asyncTools', 'steering', 'reasoningUpdates']) {
    assert.equal(nativeSessionCapabilities({ [key]: true })[key], true);
  }
});

test('单响应恢复只读保留 raw usage，首输出来自确切物理计时；重复读取缓存不可变证据', async () => {
  const f = fixture();
  const before = structuredClone(f.request);
  const measurement = await f.reader.read(f.request);
  assert.equal(measurement.inputTokens, 537);
  assert.equal(measurement.timing.firstOutputAt, 1100);
  assert.equal(modelRequestObservedUsage({ ...f.request, single_response_measurement: measurement }).nativeChainBilling, false);
  assert.deepEqual(f.request, before);
  const reads = f.reads;
  assert.deepEqual(await f.reader.read(f.request), measurement);
  assert.equal(f.reads, reads, '同一提交代数不重复读取CAS正文');
  measurement.inputTokens = 999;
  assert.equal((await f.reader.read(f.request)).inputTokens, 537, '调用方不能改写缓存证据');
});

const rejected = [
  ['原生冻结配方', f => { f.bodies.get('recipe').nativeResponses = { asyncTools: true }; }],
  ['压缩配方', f => { f.bodies.get('recipe').kind = 'reliable-context-compression'; }],
  ['模型身份不一致', f => { f.bodies.get('authority-body').model.modelId = 'other'; }],
  ['非HTTP路径', f => { f.bodies.get('authority-body').model.openaiResponsesTransport = 'websocket'; }],
  ['跨试次控制回执', f => { f.controls[1].attempt_seq = 2n; }],
  ['终态栅栏不匹配', f => { f.tables.ModelStreamFence[0].socket_generation = 2n; }],
  ['结束身份不匹配', f => { f.bodies.get('completed-body').content.responseId = 'other'; }],
  ['原生准入', f => { f.bodies.get('created-body').content.capabilities.asyncTools = true; }],
  ['能力摘要缺失', f => { delete f.bodies.get('created-body').content.capabilities; }],
  ['能力字段非布尔', f => { f.bodies.get('created-body').content.capabilities.asyncTools = 'true'; }],
  ['存在第三个响应事件', f => { f.controls.push({ ...f.controls[0], id: 'another', stream_seq: 2n }); }],
  ['只剩完成回执', f => { f.controls.splice(0, 1); }],
  ['有未证明的前驱', f => { f.bodies.get('created-body').content.previousResponseId = 'old'; }],
  ['原始用量缺失', f => { delete f.bodies.get('completed-body').content.usage; }],
  ['输入用量不一致', f => { f.bodies.get('completed-body').content.usage.input_tokens = 538; }],
  ['缓存细项不一致', f => { f.bodies.get('completed-body').content.usage.input_tokens_details.cached_tokens = 501; }],
  ['计时缺失', f => { delete f.bodies.get('completed-body').content.timing; }],
  ['原生逐响应用量已存在', f => { f.request.stream_stats_json.nativeLatestResponseUsage = {}; }],
  ['超大配方', f => { f.metadata.find(row => row.id === 'recipe').byte_length = 3n * 1024n * 1024n; }],
  ['已结束但失败', f => { f.request.terminal_state = 'failed'; }]
];
for (const [label, change] of rejected) test(`历史恢复拒绝${label}，不能把缺证据猜成普通请求`, async () => {
  const f = fixture(); change(f);
  assert.equal(await f.reader.read(f.request), undefined);
});

for (const method of ['localCommit', 'externalCommit']) test(`${method} 使历史证据缓存失效，包括删除控制回执`, async () => {
  const f = fixture();
  assert.ok(await f.reader.read(f.request));
  f.controls.splice(0, 1); f[method]();
  assert.equal(await f.reader.read(f.request), undefined);
});

test('缺失的CAS和根身份错误不能被当作计量缺失静默吞掉', async () => {
  const f = fixture(); f.bodies.delete('recipe');
  assert.throws(() => f.reader.read(f.request), /CAS unavailable/);
});

test('快照请求与当前请求不一致时不附加后来请求的证据', async () => {
  const f = fixture(); const snapshot = structuredClone(f.request);
  f.request.recipe_object_id = 'new-recipe';
  assert.equal(await f.reader.read(snapshot), undefined);
});

test('消费投影绑定配方、试次和输入用量，零输入不被当成未知', async () => {
  const f = fixture();
  f.request.usage_json.promptTokenCount = 0; f.request.usage_json.cachedContentTokenCount = 0; f.request.usage_json.totalTokenCount = 111;
  Object.assign(f.bodies.get('completed-body').content.usage, { input_tokens: 0, total_tokens: 111, input_tokens_details: { cached_tokens: 0 } });
  const measurement = await f.reader.read(f.request);
  assert.equal(measurement.inputTokens, 0);
  const projected = { ...f.request, single_response_measurement: measurement };
  assert.equal(modelRequestObservedUsage(projected).promptTokenCount, 0);
  assert.equal(singleResponseMeasurement({ ...projected, recipe_object_id: 'different' }), undefined);
  assert.equal(singleResponseMeasurement({ ...projected, single_response_measurement: { ...measurement, attemptSeq: '2' } }), undefined);
});


test('只读恢复必须处于一个SQLite快照，不能跨快照拼接证据', () => {
  const f = fixture(); f.database.inTransaction = false;
  assert.throws(() => f.reader.read(f.request), /one read snapshot/);
});

test('给客户端的计量只包含协议字段，不透传无关嵌套内容', async () => {
  const f = fixture(); const measurement = await f.reader.read(f.request);
  const parsed = singleResponseMeasurement({ ...f.request, single_response_measurement: {
    ...measurement, privateBody: 'not protocol data', timing: { ...measurement.timing, privateBody: 'not protocol data' }
  } });
  assert.equal(parsed.privateBody, undefined);
  assert.equal(parsed.timing.privateBody, undefined);
});


test('正常普通请求和有物理计量的原生请求不触发历史核验查询', () => {
  const f = fixture();
  f.request.usage_json.nativeChainBilling = false;
  assert.equal(f.reader.read(f.request), undefined);
  f.request.usage_json.nativeChainBilling = true;
  f.request.stream_stats_json.nativeLatestResponseUsage = { inputTokens: 537 };
  assert.equal(f.reader.read(f.request), undefined);
  assert.equal(f.queries.length, 0);
  assert.equal(f.reads, 0);
});
