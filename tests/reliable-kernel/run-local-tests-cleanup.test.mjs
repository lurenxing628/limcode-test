import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const runner = path.join(process.cwd(), 'scripts', 'reliable-kernel', 'run-local-tests.mjs');
const WEBVIEW_TEST_FILES = [
  'reliableConversationProjection', 'segmentedTimeline', 'nativeConversationProjection', 'forkRequestLifecycle',
  'reliableCollaborationTimeline', 'summaryRebuildPreview', 'compressionTokenChange'
];
const BUILD_PREFIX = 'limcode-webview-tests-';

/** A checkout-shaped fixture: the runner builds its webview tests into <root>/node_modules/.cache. */
async function fixtureRoot(t, { longRunning = false, viteConfig = 'export default {};\n' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-run-local-tests-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'webview', 'tests'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', '.cache'), { recursive: true });
  if (viteConfig !== null) await fs.writeFile(path.join(root, 'vite.config.ts'), viteConfig);
  for (const [index, name] of WEBVIEW_TEST_FILES.entries()) {
    const body = longRunning && index === 0
      ? [
          "import fs from 'node:fs';",
          "import test from 'node:test';",
          "test('long running', async () => {",
          `  fs.writeFileSync(${JSON.stringify(path.join(root, 'started.json'))}, JSON.stringify({ pid: process.pid }));`,
          '  await new Promise((resolve) => setTimeout(resolve, 60_000));',
          '});'
        ].join('\n')
      : "import test from 'node:test';\ntest('fixture', () => {});";
    await fs.writeFile(path.join(root, 'webview', 'tests', `${name}.test.ts`), `${body}\n`);
  }
  return root;
}

function startRunner(root) {
  // Run it as a developer would; this file's own test-runner context must not leak into its suite.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = childProcess.spawn(process.execPath, [runner], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal, output })));
  return { child, exited };
}

async function builds(root) {
  return (await fs.readdir(path.join(root, 'node_modules', '.cache'))).filter((name) => name.startsWith(BUILD_PREFIX)).sort();
}

async function waitFor(check, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

test('本机测试入口启动时清理无主的 webview 构建目录，保留仍在运行的其它构建', async (t) => {
  // No vite config: the run fails right after preparing its own build directory.
  const root = await fixtureRoot(t, { viteConfig: null });
  const cache = path.join(root, 'node_modules', '.cache');
  const exitedOwner = childProcess.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(exitedOwner.stdout);
  assert.equal(alive(deadPid), false);
  const abandoned = `${BUILD_PREFIX}${deadPid}-abc123`;
  const live = `${BUILD_PREFIX}${process.pid}-def456`;
  const staleUnowned = `${BUILD_PREFIX}Xy12Zq`;
  const recentUnowned = `${BUILD_PREFIX}Ab34Cd`;
  for (const name of [abandoned, live, staleUnowned, recentUnowned]) {
    await fs.mkdir(path.join(cache, name, 'chunks'), { recursive: true });
  }
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  await fs.utimes(path.join(cache, staleUnowned), old, old);
  await fs.writeFile(path.join(cache, 'unrelated.json'), '{}');

  const { exited } = startRunner(root);
  const result = await exited;
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /vite\.config\.ts/);
  assert.deepEqual(await builds(root), [recentUnowned, live].sort(),
    '已退出进程与超龄的构建被清理；运行中的构建和本次自己的构建都不残留');
  assert.ok((await fs.readdir(cache)).includes('unrelated.json'));
});

test('本机测试入口收到 SIGTERM 时结束测试子进程并删除本次 webview 构建', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fixtureRoot(t, { longRunning: true });
  const { child, exited } = startRunner(root);
  let testPid;
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (testPid && alive(testPid)) process.kill(testPid, 'SIGKILL');
  });
  const started = await waitFor(async () => {
    try {
      return JSON.parse(await fs.readFile(path.join(root, 'started.json'), 'utf8'));
    } catch {
      return undefined;
    }
  }, 'the long-running webview test to start');
  testPid = started.pid;
  assert.equal((await builds(root)).length, 1, '测试运行期间存在本次的 webview 构建');

  child.kill('SIGTERM');
  const result = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve(undefined), 20_000))
  ]);
  assert.ok(result, '入口必须在测试子进程结束后退出，而不是等测试自然跑完');
  assert.equal(result.code, 128 + os.constants.signals.SIGTERM, result.output);
  assert.deepEqual(await builds(root), [], '中断后不能留下 webview 构建目录');
  await waitFor(() => !alive(testPid), 'the interrupted test process to exit', 10_000);
});
