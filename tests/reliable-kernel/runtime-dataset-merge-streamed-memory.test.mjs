import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compiled, countRows, createConfigurationRoot, generateSyntheticSource } from './fixtures/runtime-merge-fixture.mjs';

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
    t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
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
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
  const [smaller, larger] = peaks;
  t.diagnostic(`VmHWM：${SIZES[0]} 行 ${smaller.toFixed(1)} MB，${SIZES[1]} 行 ${larger.toFixed(1)} MB`);
  assert.ok(larger - smaller < 64, `峰值相差 ${(larger - smaller).toFixed(1)} MB`);
  assert.ok(larger < 600 && smaller < 600, `峰值 ${larger.toFixed(1)} MB`);
});

function runChild(root, input) {
  const script = path.join(HERE, 'runtime-dataset-merge-streamed-child.mjs');
  return new Promise((resolve) => {
    execFile(process.execPath, [`--max-semi-space-size=${MAIN_SEMI_SPACE_MB}`, script, root, JSON.stringify(input)], {
      env: { ...process.env, LIMCODE_TEST_EXTENSION_ROOT: compiled }, maxBuffer: 16 * 1024 * 1024
    }, (error, stdout, stderr) => resolve({ signal: error?.signal ?? null, code: error ? error.code ?? null : 0, stdout, stderr }));
  });
}
