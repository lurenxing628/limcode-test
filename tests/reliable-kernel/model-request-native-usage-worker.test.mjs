import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiledRoot, 'backend/reliableKernel/index.js'));
const requestRepo = kernel.DOMAIN_REPOSITORIES.domain('ModelRequest');
const now = '2026-09-22T00:00:00.000Z';

const stats = (observation, identity = {}) => ({
  attemptSeq: '1', socketGeneration: '1', retryReason: null,
  ...(observation === undefined ? {} : { nativeLatestResponseUsage: observation }),
  ...identity
});
const response = (responseId, streamSeq, options = {}) => ({
  responseId, streamSeq, attemptSeq: '1', socketGeneration: '1', physicalResponseCount: 1,
  ...options
});

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-native-usage-worker-'));
  let database;
  try {
    const candidate = await kernel.resetCandidateRuntimeRoot(directory);
    database = await kernel.RuntimeDatabase.open(candidate.authority);
    const store = new kernel.ContentAddressedStore(candidate.authority, candidate.binding);
    const recipe = await store.ingest(database, '{}', 'application/json');
    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: 'conversation-usage', title: 'Physical response usage', status: 'active',
        created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: 'turn-usage', conversation_id: 'conversation-usage', status: 'active',
        created_at: now, updated_at: now, terminal_at: null
      }),
      requestRepo.insert({
        id: 'request-usage', turn_id: 'turn-usage', request_seq: 1n, status: 'prepared', terminal_state: null,
        provider_id: 'openai-responses', model_id: 'gpt-native', context_window_tokens: 130_000n,
        compression_threshold_tokens: 100_000n, estimated_context_tokens: 10_000n,
        authority_snapshot_id: 'authority-usage', settings_snapshot_object_id: null,
        recipe_object_id: recipe.id, usage_json: null, stream_stats_json: stats(undefined, { socketGeneration: '0' }),
        created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Operation').insert({
        id: 'operation-usage', owner_kind: 'model_request', owner_id: 'request-usage',
        operation_seq: 1n, tool_call_id: null, status: 'pending', created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Attempt').insert({
        id: 'attempt-usage', operation_id: 'operation-usage', attempt_seq: 1n,
        status: 'pending', created_at: now, updated_at: now, completed_at: null
      })
    ]);
    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Operation').update('operation-usage', { status: 'running', updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('Attempt').update('attempt-usage', { status: 'running', updated_at: now }),
      requestRepo.update('request-usage', { status: 'streaming',
        stream_stats_json: stats(), updated_at: now })
    ]);
    const read = async () => (await database.snapshot([requestRepo.get('request-usage')])).snapshot[0].stream_stats_json;
    const write = (value) => database.transaction([
      requestRepo.update('request-usage', { stream_stats_json: value, updated_at: now })
    ]);
    await run({ database, store, read, write });
  } finally {
    await database?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('SQLite worker 接受完整物理响应观测与有界 token；无 usage 维持未知', async () => {
  await fixture(async ({ read, write }) => {
    const initial = response('resp-1', '3', {
      inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0,
      contextRootId: 'root-initial', contextCovered: true
    });
    await write(stats(initial));
    assert.deepEqual((await read()).nativeLatestResponseUsage, initial);
    const unknown = response('resp-2', '4', {
      previousResponseId: 'resp-1', physicalResponseCount: 2, contextRootId: 'root-initial'
    });
    await write(stats(unknown));
    assert.deepEqual((await read()).nativeLatestResponseUsage, unknown);
    assert.equal((await read()).nativeLatestResponseUsage.inputTokens, undefined,
      '第二个真实响应缺 usage 不能继承上一个已知输入、伪造 0 或覆盖证明');
    await write(stats(unknown));
    assert.equal((await read()).nativeLatestResponseUsage.physicalResponseCount, 2,
      '真实 worker 上同一响应重复写入不增加物理响应计数');
  });
});

test('SQLite worker 原生统计 shape 精确拒绝未知键、cache 伪计数与畸形，同时回滚整个事务', async () => {
  await fixture(async ({ database, read, write }) => {
    const base = response('resp-1', '1', { inputTokens: 120_000, outputTokens: 2000 });
    const prepared = (await database.snapshot([requestRepo.get('request-usage')])).snapshot[0];
    await assert.rejects(database.transaction([requestRepo.insert({
      ...prepared, id: 'request-invalid', request_seq: 2n, status: 'prepared',
      stream_stats_json: { ...stats(undefined, { socketGeneration: '0' }), madeUp: true }
    })]), /invalid shape/i, 'prepared INSERT 也必须通过真实 worker 的 top-level 精确校验');
    assert.equal((await database.snapshot([requestRepo.get('request-invalid')])).snapshot[0], null);
    const malformed = [
      ['top-level unknown', { ...stats(base), madeUp: 1 }],
      ['nested unknown', stats({ ...base, surprise: true })],
      ['raw cache cannot masquerade as separate count', stats({ ...base, cachedTokens: 100_000 })],
      ['raw provider usage metadata is not an arbitrary JSON escape hatch', stats({ ...base, usage: { input_tokens: 10 } })],
      ['null object', stats(null)],
      ['array object', stats([])],
      ['missing responseId', stats((({ responseId, ...rest }) => rest)(base))],
      ['empty responseId', stats({ ...base, responseId: '' })],
      ['null predecessor ID', stats({ ...base, previousResponseId: null })],
      ['empty context root', stats({ ...base, contextRootId: '' })],
      ['wrong stream seq type', stats({ ...base, streamSeq: 1 })],
      ['negative stream seq', stats({ ...base, streamSeq: '-1' })],
      ['uncanonical stream seq', stats({ ...base, streamSeq: '01' })],
      ['future attempt', stats({ ...base, attemptSeq: '2' })],
      ['future socket generation', stats({ ...base, socketGeneration: '2' })],
      ['missing physical count', stats((({ physicalResponseCount, ...rest }) => rest)(base))],
      ['zero count', stats({ ...base, physicalResponseCount: 0 })],
      ['over saturation bound', stats({ ...base, physicalResponseCount: 9 })],
      ['fractional count', stats({ ...base, physicalResponseCount: 1.5 })],
      ['negative input', stats({ ...base, inputTokens: -1 })],
      ['unsafe input', stats({ ...base, inputTokens: Number.MAX_SAFE_INTEGER + 1 })],
      ['string input', stats({ ...base, inputTokens: '120000' })],
      ['negative output', stats({ ...base, outputTokens: -1 })],
      ['unsafe output', stats({ ...base, outputTokens: Number.MAX_SAFE_INTEGER + 1 })],
      ['string output', stats({ ...base, outputTokens: '2000' })],
      ['false coverage claim', stats({ ...base, contextRootId: 'root-initial', contextCovered: false })],
      ['true coverage without root', stats({ ...base, contextCovered: true })]
    ];
    const before = await read();
    for (const [caseName, value] of malformed) {
      await assert.rejects(write(value), undefined, caseName);
      assert.deepEqual(await read(), before, `${caseName}: invalid worker transaction changed SQLite`);
    }
  });
});

test('SQLite worker 同响应冲突、同代序号倒退、计数越级、旧 socket 回放全部 fail closed', async () => {
  await fixture(async ({ read, write }) => {
    const first = response('resp-1', '20', { inputTokens: 100_000 });
    await write(stats(first));
    const next = response('resp-2', '21', {
      previousResponseId: 'resp-1', physicalResponseCount: 2, inputTokens: 110_000
    });
    await write(stats(next));
    for (const [caseName, candidate] of [
      ['same response altered input', { ...next, inputTokens: 220_000 }],
      ['same response upgrades missing coverage', { ...next, contextRootId: 'root', contextCovered: true }],
      ['same response counter increments', { ...next, physicalResponseCount: 3 }],
      ['different response shares seq', { ...next, responseId: 'resp-3', physicalResponseCount: 3 }],
      ['different response rolls seq backwards', { ...next, responseId: 'resp-3', streamSeq: '19', physicalResponseCount: 3 }],
      ['different response skips count', { ...next, responseId: 'resp-3', streamSeq: '22', physicalResponseCount: 5 }]
    ]) {
      await assert.rejects(write(stats(candidate)), undefined, caseName);
      assert.deepEqual((await read()).nativeLatestResponseUsage, next, `${caseName}: worker must preserve committed facts`);
    }
    const socket2 = stats(next, { socketGeneration: '2' });
    await write(socket2);
    assert.deepEqual((await read()).nativeLatestResponseUsage, next,
      '重连期间允许旧 socket 最新观测留存，但不能冒充新代');
    await assert.rejects(write(stats(next, { socketGeneration: '1' })), /backwards|identity/i,
      '旧 socket 全列旧 stats 不能覆盖新代');
    await assert.rejects(write(stats({
      ...next, responseId: 'resp-old', streamSeq: '22', physicalResponseCount: 3
    }, { socketGeneration: '2' })), /old stream identity/i,
    '旧 socket 观测不能以新外层 identity 覆盖更高版本');
    const current = response('resp-3', '1', {
      socketGeneration: '2', previousResponseId: 'resp-2', physicalResponseCount: 3
    });
    await write(stats(current, { socketGeneration: '2' }));
    assert.deepEqual((await read()).nativeLatestResponseUsage, current,
      '新 socket 的独立 streamSeq 可从小值重新开始');
    await assert.rejects(write(stats(next, { socketGeneration: '2' })), /old stream identity/i);
    await assert.rejects(write(stats({ ...current, responseId: 'resp-old', streamSeq: '2',
      socketGeneration: '1', physicalResponseCount: 4 }, { socketGeneration: '2' })), /old stream identity/i);
    assert.deepEqual((await read()).nativeLatestResponseUsage, current);
  });
});

test('真实 SQLite/CAS：新 socket 不得用旧 r1 回放覆盖最新 r3；同 socket stateless 可缺前驱', async () => {
  await fixture(async ({ database, store, read, write }) => {
    const checkpoint = async (responseId, socketGeneration, streamSeq) => {
      const prepared = await store.prepare(database, JSON.stringify({ responseId, socketGeneration, streamSeq }),
        'application/vnd.limcode.native-control-checkpoint+json');
      const committed = await database.commitModelStreamEvent({
        modelRequestId: 'request-usage', checkpointId: `checkpoint-${socketGeneration}-${streamSeq}`,
        attemptSeq: 1n, socketGeneration: BigInt(socketGeneration), streamSeq: BigInt(streamSeq),
        checkpointKind: 'native_control', terminalFenceId: null,
        contentObject: prepared.metadata,
        ...(prepared.insert ? { contentInsert: prepared.insert } : {}),
        usage: null, terminalStats: null, now
      });
      assert.equal(committed.checkpointed, true, 'physical native_control checkpoint must commit to real SQLite/CAS');
    };
    for (const [responseId, streamSeq, count, inputTokens] of [
      ['resp-1', 10, 1, 100_000],
      ['resp-2', 20, 2, 110_000],
      ['resp-3', 30, 3, 130_000]
    ]) {
      await checkpoint(responseId, 1, streamSeq);
      await write(stats(response(responseId, String(streamSeq), {
        physicalResponseCount: count, inputTokens
        // Stateless HTTP may omit previousResponseId within the same socket generation.
      })));
    }
    const latest = (await read()).nativeLatestResponseUsage;
    assert.equal(latest.responseId, 'resp-3');
    await write(stats(latest, { socketGeneration: '2' }));
    await write(stats(latest, { socketGeneration: '2' }));
    assert.deepEqual((await read()).nativeLatestResponseUsage, latest, 'same responseId replay stays idempotent');
    await checkpoint('resp-1', 2, 1);
    for (const [label, fake] of [
      ['missing predecessor', response('resp-1', '1', {
        socketGeneration: '2', physicalResponseCount: 4, inputTokens: 100_000
      })],
      ['wrong predecessor', response('resp-1', '1', {
        socketGeneration: '2', previousResponseId: 'resp-1', physicalResponseCount: 8, inputTokens: 100_000
      })]
    ]) {
      const before = (await database.snapshot([requestRepo.get('request-usage')])).snapshotCommitSeq;
      await assert.rejects(write(stats(fake, { socketGeneration: '2' })), /predecessor|continuation/i, label);
      assert.equal((await database.snapshot([requestRepo.get('request-usage')])).snapshotCommitSeq, before,
        `${label}: failed fenced write must not commit`);
      assert.deepEqual((await read()).nativeLatestResponseUsage, latest,
        `${label}: stale physical r1 cannot replace r3 or increment its count`);
    }
    await checkpoint('resp-4', 2, 2);
    const next = response('resp-4', '2', {
      socketGeneration: '2', previousResponseId: 'resp-3', physicalResponseCount: 4
      // No raw usage and no Context root proof remain genuinely unknown.
    });
    await write(stats(next, { socketGeneration: '2' }));
    assert.deepEqual((await read()).nativeLatestResponseUsage, next);
    assert.equal((await read()).nativeLatestResponseUsage.inputTokens, undefined);
    assert.equal((await read()).nativeLatestResponseUsage.contextCovered, undefined);
  });
});

test('明确 retry 新 attempt 清除旧观测后，首物理响应可无前驱且旧 attempt 不能回写', async () => {
  await fixture(async ({ database, read, write }) => {
    const first = response('resp-first-attempt', '10', { inputTokens: 100_000 });
    await write(stats(first));
    const retry = stats(undefined, {
      attemptSeq: '2', socketGeneration: '0', retryReason: 'connection_interrupted',
      retryMaxAttempts: 1, retryDelayMs: 0, retryNotBeforeAt: 1
    });
    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Attempt').update('attempt-usage', {
        status: 'transient_failed', updated_at: now, completed_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Attempt').insert({
        id: 'attempt-retry', operation_id: 'operation-usage', attempt_seq: 2n,
        status: 'pending', created_at: now, updated_at: now, completed_at: null
      }),
      requestRepo.update('request-usage', {
        status: 'retrying', stream_stats_json: retry, updated_at: now
      })
    ]);
    assert.equal((await read()).nativeLatestResponseUsage, undefined);
    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Attempt').update('attempt-retry', {
        status: 'running', updated_at: now
      }),
      requestRepo.update('request-usage', {
        status: 'streaming', stream_stats_json: { ...retry, socketGeneration: '1' }, updated_at: now
      })
    ]);
    const next = response('resp-fresh-attempt', '1', {
      attemptSeq: '2', physicalResponseCount: 1
    });
    await write({ ...retry, socketGeneration: '1', nativeLatestResponseUsage: next });
    assert.deepEqual((await read()).nativeLatestResponseUsage, next,
      'a formally reset attempt has no old frontier to require a predecessor');
    await assert.rejects(write(stats(first)), /backwards|identity/i);
    assert.deepEqual((await read()).nativeLatestResponseUsage, next);
  });
});

test('SQLite worker 饱和计数止于 8、断裂前驱不得声明 Context 覆盖', async () => {
  await fixture(async ({ read, write }) => {
    let latest = response('resp-1', '1');
    await write(stats(latest));
    for (let number = 2; number <= 10; number += 1) {
      latest = response(`resp-${number}`, String(number), {
        previousResponseId: `resp-${number - 1}`,
        physicalResponseCount: Math.min(8, number)
      });
      await write(stats(latest));
    }
    assert.equal((await read()).nativeLatestResponseUsage.physicalResponseCount, 8);
    const broken = response('resp-11', '11', {
      previousResponseId: 'unrelated', physicalResponseCount: 8,
      contextRootId: 'root-initial', contextCovered: true
    });
    await assert.rejects(write(stats(broken)), /coverage|predecessor/i);
    delete broken.contextCovered;
    await write(stats(broken));
    assert.equal((await read()).nativeLatestResponseUsage.contextCovered, undefined);
  });
});

test('真实 ModelProviderControlPlane → SQLite worker：重复回执无新提交、缺 usage 不回填、旧代无提交', async () => {
  await fixture(async ({ database, read }) => {
    const plane = Object.create(kernel.ModelProviderControlPlane.prototype);
    plane.database = database;
    plane.now = () => now;
    const observation = (responseId, streamSeq, usage, extra = {}) => ({
      responseId, streamSeq, usage, ...extra
    });
    const first = observation('resp-1', '10', { input_tokens: 120_000, output_tokens: 2000,
      input_tokens_details: { cached_tokens: 100_000 } }, { contextRootId: 'root-initial' });
    assert.equal(await plane.persistNativeResponseUsage('request-usage', '1', '1', first), true);
    assert.equal((await read()).nativeLatestResponseUsage.inputTokens, 120_000);
    const committed = (await database.snapshot([requestRepo.get('request-usage')])).snapshotCommitSeq;
    assert.equal(await plane.persistNativeResponseUsage('request-usage', '1', '1', first), true);
    assert.equal((await database.snapshot([requestRepo.get('request-usage')])).snapshotCommitSeq, committed,
      '同响应重复投递无 worker commit');
    assert.equal(await plane.persistNativeResponseUsage('request-usage', '1', '0',
      observation('resp-old', '11', { input_tokens: 10 })), false);
    assert.equal((await database.snapshot([requestRepo.get('request-usage')])).snapshotCommitSeq, committed);
    assert.equal(await plane.persistNativeResponseUsage('request-usage', '1', '1',
      observation('resp-2', '12', undefined, { previousResponseId: 'resp-1' })), true);
    const latest = (await read()).nativeLatestResponseUsage;
    assert.equal(latest.responseId, 'resp-2');
    assert.equal(latest.inputTokens, undefined);
    assert.equal(latest.outputTokens, undefined);
    assert.equal(latest.contextCovered, undefined);
    assert.equal(latest.physicalResponseCount, 2);
  });
});
