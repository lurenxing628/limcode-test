import { spawn } from 'node:child_process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

const children = new Set();
let stoppedBy;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
  stoppedBy ??= signal;
  for (const child of children) child.kill(signal);
});

function run(command, args, options = {}) {
  if (stoppedBy) return Promise.resolve(128 + os.constants.signals[stoppedBy]);
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  children.add(child);
  return new Promise((resolve, reject) => {
    child.once('error', error => { children.delete(child); reject(error); });
    child.once('close', (code, signal) => {
      children.delete(child);
      resolve(code ?? 128 + (os.constants.signals[signal] ?? 1));
    });
  });
}

function npm(args) {
  return process.env.npm_execpath
    ? run(process.execPath, [process.env.npm_execpath, ...args])
    : run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { shell: process.platform === 'win32' });
}

async function core() {
  return run(process.execPath, ['scripts/reliable-kernel/run-local-tests.mjs', '--ci']);
}

async function browser() {
  if (!process.env.LIMCODE_TEST_BROWSER_PATH) {
    const args = ['playwright', 'install', '--only-shell', ...(process.env.GITHUB_ACTIONS ? ['--with-deps'] : []), 'chromium'];
    const status = await npm(['exec', '--offline', '--', ...args]);
    if (status !== 0) return status;
  }
  return run(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1',
    'tests/webview-session-thinking.browser.mjs',
    'tests/webview-agent-status-panel.browser.mjs',
    'tests/webview-file-change-preview.browser.mjs'
  ]);
}

const started = performance.now();
const results = await Promise.allSettled([core(), browser(), npm(['run', 'typecheck:webview'])]);
for (const result of results) if (result.status === 'rejected') console.error(result.reason);
const failed = results.some(result => result.status === 'rejected' || result.value !== 0);
console.log(`类型检查、核心套件与浏览器验证完成，用时 ${((performance.now() - started) / 1000).toFixed(1)} 秒。`);
process.exitCode = stoppedBy ? 128 + os.constants.signals[stoppedBy] : failed ? 1 : 0;
