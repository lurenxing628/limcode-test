import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  compiled, countRows, createConfigurationRoot, generateSyntheticSource, MESSAGE_TYPE, modelRequestAggregate, NOW, removeConfigurationRoot,
  repo, withRuntime
} from './fixtures/runtime-merge-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** LIMCODE_LARGE_MERGE_MEMORY=1: the sizes of the design (50,000 and 400,000 rows); CI runs 5,000 and 20,000. */
const LARGE = process.env.LIMCODE_LARGE_MERGE_MEMORY === '1';
const SIZES = LARGE ? [50_000, 400_000] : [5_000, 20_000];
/**
 * V8 grows an isolate's young generation with the bytes that survive its scavenges, up to its cap,
 * so any long run ends with a larger one whatever it keeps (by tens of MB per thread). Both threads'
 * young generations are capped at a few MB here: what the two runs differ in is then only memory
 * that depends on the source.
 */
const MAIN_SEMI_SPACE_MB = 2;
const WORKER_LIMITS = { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 4 };

test(`内存上界：${SIZES.join(' 行与 ')} 行的来源各走一次大库会话（维护 worker 老生代上限 128 MB，两个线程的新生代都封顶在几 MB），峰值常驻内存相差不到 64 MB，都低于 600 MB`, {
  timeout: LARGE ? 3_600_000 : 600_000,
  skip: process.platform !== 'linux' ? 'VmHWM 只在 Linux 的 /proc 里有' : false
}, async (t) => {
  const peaks = [];
  for (const rows of SIZES) {
    const fixture = await createConfigurationRoot();
    t.after(() => removeConfigurationRoot(fixture.root));
    const written = await generateSyntheticSource(fixture.alpha, { rows });
    const sourceRows = countRows(fixture.alpha);
    assert.ok(sourceRows >= written && written >= rows, `来源 ${sourceRows} 行`);
    const child = await runChild(fixture.root, {
      // Every source here is a large one; the maintenance worker's heap is bounded.
      sizeLimits: { transactionRows: 1_000 }, workerResourceLimits: WORKER_LIMITS
    });
    assert.equal(child.code, 0, child.stderr);
    const report = JSON.parse(child.stdout);
    assert.deepEqual(report.results.map((result) => result.state), ['merged'], JSON.stringify(report));
    assert.equal(countRows(fixture.current), sourceRows, '逐行写入当前库');
    peaks.push(report.vmHwmKb / 1024);
    await removeConfigurationRoot(fixture.root);
  }
  const [smaller, larger] = peaks;
  t.diagnostic(`VmHWM：${SIZES[0]} 行 ${smaller.toFixed(1)} MB，${SIZES[1]} 行 ${larger.toFixed(1)} MB`);
  assert.ok(larger - smaller < 64, `峰值相差 ${(larger - smaller).toFixed(1)} MB`);
  assert.ok(larger < 600 && smaller < 600, `峰值 ${larger.toFixed(1)} MB`);
});

/** 2 万个正文对象：每个对话 10 条消息正文与 1 份请求配方，都不相同。 */
const HEAVY_CONVERSATIONS = 1_820;
const MiB = 1024 * 1024;

test('内存：约 2 万个正文对象、13 万行的来源走一次准备与大库会话——准备结果不随正文对象保留堆（< 2 MB），正文传输期间堆不随对象增长（< 2 MB），流式事务不留解码结果（< 4 MB），扫描与写入时来源私有副本的页缓存都封顶在 2 MiB', {
  timeout: 600_000
}, async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  await contentHeavySource(fixture.alpha, HEAVY_CONVERSATIONS);
  const child = await runMemoryChild(fixture.root, { sizeLimits: { transactionRows: 1_000 }, workerResourceLimits: WORKER_LIMITS });
  assert.equal(child.code, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  const [source] = report.prepared;
  assert.ok(source.casObjects >= 20_000 && source.rows >= 130_000 && source.databaseBytes > 16 * MiB, JSON.stringify(report.prepared));
  assert.deepEqual(report.results.map((result) => result.state), ['merged'], JSON.stringify(report.results));
  assert.equal(countRows(fixture.current), source.rows, '逐行写入当前库');
  assert.equal(report.links, source.casObjects, '每个正文对象都经过这次传输');
  const mb = (bytes) => `${(bytes / MiB).toFixed(2)} MB`;
  t.diagnostic(`准备结果保留 ${mb(report.preparedHeapGrowth)}，正文传输期间 ${mb(report.casHeapGrowth)}，流式事务期间 ${mb(report.streamHeapGrowth)}，`
    + `扫描时堆外常驻增长 ${mb(report.scanResidentGrowth)}（仅供参考），页缓存 ${JSON.stringify([report.scanPageCaches, report.streamPageCaches])}`);
  assert.ok(report.preparedHeapGrowth < 2 * MiB, `准备结果保留了 ${mb(report.preparedHeapGrowth)}`);
  assert.ok(report.casHeapGrowth < 2 * MiB, `正文传输期间堆增长 ${mb(report.casHeapGrowth)}`);
  assert.ok(report.streamHeapGrowth < 4 * MiB, `流式事务期间堆增长 ${mb(report.streamHeapGrowth)}`);
  for (const [phase, caches] of [['扫描', report.scanPageCaches], ['写入', report.streamPageCaches]]) {
    assert.ok(caches.length > 0, `${phase}时有来源私有副本的连接`);
    for (const [main, temp] of caches) {
      assert.ok(main < 0 && -main <= 2048 && temp < 0 && -temp <= 2048, `${phase}时页缓存 main ${main}、temp ${temp}（KiB 为负）`);
    }
  }
});

/** Content-heavy source: per conversation ten distinct message bodies and a distinct request recipe. */
async function contentHeavySource(dataSet, count) {
  await withRuntime(dataSet, async (runtime, store) => {
    let steps = [];
    for (let c = 0; c < count; c += 1) {
      const id = `heavy_${String(c).padStart(6, '0')}`;
      const turnId = `${id}_turn`;
      const objects = await store.prepareBatch(runtime, [
        ...Array.from({ length: 10 }, (_, m) => ({ content: JSON.stringify({ role: 'user', parts: [{ text: `${id} ${m}` }] }), contentType: MESSAGE_TYPE })),
        { content: JSON.stringify({ recipe: id }), contentType: 'application/json' }
      ]);
      for (const object of objects) if (object.insert) steps.push(object.insert);
      const ids = objects.map((object) => object.metadata.id);
      steps.push(
        repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
        repo('Turn').insert({ id: turnId, conversation_id: id, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
        repo('TurnTermination').insert({ id: `${id}_termination`, turn_id: turnId, terminal_status: 'completed', reason: 'fixture', created_at: NOW })
      );
      for (let m = 0; m < 10; m += 1) {
        const messageId = `${id}_m${m}`;
        steps.push(
          repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
          repo('MessageRevision').insert({ id: `${messageId}_r`, message_id: messageId, revision_seq: 1n, role: 'user', content_object_id: ids[m], created_at: NOW }),
          repo('MessageCurrentRevisionLink').insert({ id: `${messageId}_c`, message_id: messageId, revision_id: `${messageId}_r`, updated_at: NOW }),
          repo('MessagePartOfConversation').insert({ id: `${messageId}_p`, conversation_id: id, message_id: messageId, message_seq: BigInt(m + 1), created_at: NOW })
        );
      }
      for (let r = 0; r < 4; r += 1) steps.push(...modelRequestAggregate(turnId, `${id}_q${r}`, BigInt(r + 1), { recipe: ids[10], body: ids[r], checkpoints: 1, completed: true }));
      if (steps.length >= 2_000 || c === count - 1) {
        await runtime.transaction(steps);
        steps = [];
      }
    }
  });
}

function runMemoryChild(root, input) {
  const script = path.join(HERE, 'runtime-dataset-merge-streamed-memory-child.mjs');
  return new Promise((resolve) => {
    execFile(process.execPath, ['--expose-gc', '--max-semi-space-size=1', script, root, JSON.stringify(input)], {
      env: { ...process.env, LIMCODE_TEST_EXTENSION_ROOT: compiled }, maxBuffer: 16 * 1024 * 1024
    }, (error, stdout, stderr) => resolve({ signal: error?.signal ?? null, code: error ? error.code ?? null : 0, stdout, stderr }));
  });
}

function runChild(root, input) {
  const script = path.join(HERE, 'runtime-dataset-merge-streamed-child.mjs');
  return new Promise((resolve) => {
    execFile(process.execPath, [`--max-semi-space-size=${MAIN_SEMI_SPACE_MB}`, script, root, JSON.stringify(input)], {
      env: { ...process.env, LIMCODE_TEST_EXTENSION_ROOT: compiled }, maxBuffer: 16 * 1024 * 1024
    }, (error, stdout, stderr) => resolve({ signal: error?.signal ?? null, code: error ? error.code ?? null : 0, stdout, stderr }));
  });
}
