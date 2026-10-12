import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--ci' && arg !== '--list')) {
  throw new Error('Usage: run-local-tests.mjs [--ci] [--list]');
}
const directory = 'tests/reliable-kernel';
const files = fs.readdirSync(directory, { withFileTypes: true })
  .filter(entry => entry.isFile() && /\.test\.(?:mjs|cjs|js)$/.test(entry.name))
  .map(entry => `${directory}/${entry.name}`).sort();
if (files.length === 0) throw new Error('没有找到可靠内核行为测试。');
if (args.includes('--list')) {
  await new Promise((resolve, reject) => process.stdout.write(`${files.join('\n')}\n`, error => error ? reject(error) : resolve()));
} else {
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=3', ...files], {
    cwd: process.cwd(), stdio: 'inherit'
  });
  let stoppedBy;
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => {
    const handler = () => { stoppedBy ??= signal; child.kill(signal); };
    process.on(signal, handler);
    return [signal, handler];
  }));
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(code ?? 128 + (os.constants.signals[signal] ?? 1)));
  });
  for (const [signal, handler] of handlers) process.off(signal, handler);
  process.exitCode = stoppedBy ? 128 + os.constants.signals[stoppedBy] : status;
}
