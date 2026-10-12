import assert from 'node:assert/strict';

import path from 'node:path';

import { createRequire } from 'node:module';

import test from 'node:test';

const require = createRequire(import.meta.url);

const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');

const { SingleResponseMeasurementReader } = require(path.join(compiled, 'backend/reliableKernel/singleResponseMeasurement.js'));

const { modelRequestObservedUsage, singleResponseMeasurement } = require(path.join(compiled, 'shared/modelRequestMeasurement.js'));

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

function registerCases(test) {

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
}

export { registerCases };
