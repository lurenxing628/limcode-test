import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { ReliableToolDispatcher } = require('../../dist/extension/backend/reliableKernel/toolDispatcher.js');
const {
  ANTIGRAVITY_INLINE_PROMPT_MAX_CHARS,
  ANTIGRAVITY_RUNNER_FILE,
  AntigravityEventReporter,
  antigravityFinalReport,
  encodeAntigravityRunnerRequest
} = require('../../dist/extension/backend/reliableKernel/antigravityRunner.js');
const { antigravityProcessCommand } = require('../../dist/extension/backend/reliableKernel/antigravityProcess.js');
const {
  antigravityTool,
  resolveAgyExecutable,
  validateAntigravityToolArguments
} = require('../../dist/extension/backend/world/modules/tools/definitions/antigravity/index.js');
const { buildModelHandleCatalog, resolveModelToolArguments } = require('../../dist/extension/backend/reliableKernel/modelHandleCatalog.js');

/** A stand-in for agy: prints the stream-json events the real CLI emits and edits one file. */
const FAKE_AGY = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
const get = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const prompt = get('-p') ?? '';
const model = get('--model');
const conversation = get('--conversation') ?? 'conv-new-1';
if (prompt.includes('FAIL_NOW')) { process.stderr.write('model quota exhausted\n'); process.exit(3); }
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const step = (update) => out({ event: 'step_update', step_update: { conversation_id: conversation, ...update } });
out({ event: 'init', conversation_id: conversation, init: { model, cwd: process.cwd(), tools: [], permission_mode: 'bypass' } });
step({ step_index: 0, state: 'DONE', step_type: 'user_input' });
step({ step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Path: 'out.txt' } } });
fs.writeFileSync('out.txt', 'hi');
step({ step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'write_file', duration_seconds: 0.1 });
step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'python missing.py' } } });
step({ step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', output: 'No such file' } });
step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: '写好了 out.txt' });
step({ step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '。' });
const taskFile = /已写入文件：(.+)/.exec(prompt)?.[1] ?? '';
out({ event: 'result', result: {
  conversation_id: conversation, status: 'SUCCESS', duration_seconds: 1.2, num_turns: 1,
  usage: { input_tokens: 10, output_tokens: 5 },
  response: JSON.stringify({ model, conversation, skip: args.includes('--dangerously-skip-permissions'),
    noQuestions: prompt.includes('不要停下来提问'), promptLength: prompt.length,
    task: taskFile ? fs.readFileSync(taskFile.trim(), 'utf8').length : 0 })
} });
`;

function fixtureDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'limcode-antigravity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const agyPath = path.join(directory, 'fake-agy.cjs');
  fs.writeFileSync(agyPath, FAKE_AGY, 'utf8');
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  return { directory, agyPath, workspace, logDirectory: path.join(directory, 'logs') };
}

function runRunner(request) {
  return spawnSync(process.execPath, [ANTIGRAVITY_RUNNER_FILE], {
    input: encodeAntigravityRunnerRequest(request),
    encoding: 'utf8'
  });
}

function finalAnswer(stdout) {
  const block = stdout.split('==== Antigravity 最终答复 ====\n')[1];
  return JSON.parse(block.split('\n')[0]);
}

test('AG01 reporter turns agy events into progress lines and a footer that names the conversation', () => {
  const lines = [];
  const reporter = new AntigravityEventReporter((line) => lines.push(line));
  const events = [
    { event: 'init', conversation_id: 'c-1', init: { model: 'gemini-4-neon-high' } },
    { event: 'step_update', step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' } },
    { event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'edit_file', tool_info: { parameters: { Path: 'a.ts' } } } },
    { event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'edit_file' } },
    { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: '改好了' } },
    { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: '' } },
    { event: 'result', result: { conversation_id: 'c-1', status: 'SUCCESS', response: '最终答复', duration_seconds: 3.4, num_turns: 2, usage: { input_tokens: 7, output_tokens: 3 } } }
  ];
  events.forEach((event, index) => reporter.handleLine(JSON.stringify(event), index));
  assert.deepEqual(lines, [
    '[0s] 已启动 Antigravity · gemini-4-neon-high · 对话 c-1',
    '[2s] 第2步 edit_file: a.ts',
    '[5s] 第3步 回复：改好了'
  ]);
  const report = antigravityFinalReport({ summary: reporter.summary, model: 'gemini-4-neon-high', exitCode: 0, stderrTail: '', answerPath: '/tmp/a.md' });
  assert.match(report, /==== Antigravity 最终答复 ====\n最终答复\n/);
  assert.match(report, /状态：SUCCESS · 模型 gemini-4-neon-high/);
  assert.match(report, /用时 3 秒 · 2 轮 · Token：输入 7 \/ 输出 3/);
  assert.match(report, /agy 对话 ID：c-1（要继续这段对话，用 operation=send 并传 agyConversationId）/);
  assert.match(report, /写入或编辑过的文件：a\.ts/);
});

test('AG02 runner drives agy headless with full permissions and reports progress, answer and changed files', (t) => {
  const f = fixtureDirectory(t);
  const result = runRunner({ agyPath: f.agyPath, prompt: '写一个 out.txt', model: 'gemini-3.8-flash-low', cwd: f.workspace, logDirectory: f.logDirectory });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'out.txt'), 'utf8'), 'hi');
  assert.match(result.stdout, /\[\d+s\] 第2步 write_file: out\.txt\n/);
  assert.match(result.stdout, /第3步 run_command: python missing\.py\n.*第3步 run_command 出错：No such file\n/);
  assert.match(result.stdout, /第4步 回复：写好了 out\.txt。\n/);
  const answer = finalAnswer(result.stdout);
  assert.deepEqual({ ...answer, promptLength: undefined }, {
    model: 'gemini-3.8-flash-low', conversation: 'conv-new-1', skip: true, noQuestions: true, promptLength: undefined, task: 0
  });
  // The footer comes after the answer, so the tail a completion delivers always carries it.
  const footer = result.stdout.slice(result.stdout.lastIndexOf('==== 运行信息 ===='));
  assert.match(footer, /agy 对话 ID：conv-new-1/);
  assert.match(footer, /写入或编辑过的文件：out\.txt/);
  const logPath = /agy 原始事件日志：(.+)/.exec(footer)[1];
  assert.match(fs.readFileSync(logPath, 'utf8'), /"event":"result"/);
});

test('AG03 send resumes the given agy conversation and a long task travels through a file', (t) => {
  const f = fixtureDirectory(t);
  const prompt = `继续：${'x'.repeat(ANTIGRAVITY_INLINE_PROMPT_MAX_CHARS + 10)}`;
  const result = runRunner({ agyPath: f.agyPath, prompt, model: 'gemini-4-neon-high', conversationId: 'conv-old-7', cwd: f.workspace, logDirectory: f.logDirectory });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const answer = finalAnswer(result.stdout);
  assert.equal(answer.conversation, 'conv-old-7');
  assert.ok(answer.promptLength < 1_000, 'agy gets a short pointer instead of the long task');
  assert.equal(answer.task, prompt.length);
  assert.match(result.stdout, /继续对话 conv-old-7/);
});

test('AG04 an agy failure exits non-zero with its error output in the footer', (t) => {
  const f = fixtureDirectory(t);
  const result = runRunner({ agyPath: f.agyPath, prompt: 'FAIL_NOW', model: 'gemini-4-neon-high', cwd: f.workspace, logDirectory: f.logDirectory });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /==== Antigravity 没有给出最终答复 ====\nagy 错误输出（末尾）：\nmodel quota exhausted/);
  assert.match(result.stdout, /状态：未完成 · agy 退出码 3/);
});

test('AG05 the background command reaches the runner through the platform shell', (t) => {
  const f = fixtureDirectory(t);
  const prompt = "带 'quotes' \"双引号\" $env:PATH `反引号` 和换行\n第二行";
  const command = antigravityProcessCommand({ agyPath: f.agyPath, prompt, model: 'gemini-4-neon-high', cwd: f.workspace, logDirectory: f.logDirectory },
    { nodeExecutable: process.execPath });
  assert.ok(!command.includes('quotes'), 'model-written text never appears in the shell command');
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: f.workspace, encoding: 'utf8' })
    : spawnSync('/bin/bash', ['-c', command], { cwd: f.workspace, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(finalAnswer(result.stdout).skip, true);
  assert.match(antigravityProcessCommand({ agyPath: 'a', prompt: 'p', model: 'm', cwd: 'c' }, { platform: 'linux', nodeExecutable: "/opt/it's/node", runnerFile: '/r.js' }),
    /^printf %s '[A-Za-z0-9+/=]+' \| ELECTRON_RUN_AS_NODE=1 '\/opt\/it'\\''s\/node' '\/r\.js'$/);
});

test('AG06 arguments: start/send need a prompt, send needs the conversation, read/stop need the process', () => {
  assert.deepEqual(validateAntigravityToolArguments({ prompt: ' 做事 ', model: 'gemini-4-neon-low' }), { operation: 'start', prompt: '做事', model: 'gemini-4-neon-low' });
  assert.deepEqual(validateAntigravityToolArguments({ operation: 'read', processId: 'p1', prompt: 'ignored' }), { operation: 'read', processId: 'p1' });
  assert.throws(() => validateAntigravityToolArguments({ operation: 'send', prompt: '继续' }), /agyConversationId/);
  assert.throws(() => validateAntigravityToolArguments({ operation: 'start', prompt: 'x', agyConversationId: 'c' }), /operation=send/);
  assert.throws(() => validateAntigravityToolArguments({ operation: 'stop' }), /processId/);
  assert.throws(() => validateAntigravityToolArguments({ prompt: 'x', model: 'gemini 4; rm' }), /model/);
  assert.equal(antigravityTool.declaration.metadata.defaultEnabled, false);
});

test('AG07 the model reads and stops by processRef/cursor like the command tool', () => {
  const catalog = buildModelHandleCatalog([{ processId: 'internal-process', nextOutputHandle: 'rk-process-output:cursor-one' }]);
  const processRef = catalog.entries.find((entry) => entry.kind === 'process').ref;
  const cursor = catalog.entries.find((entry) => entry.kind === 'cursor').ref;
  assert.deepEqual(resolveModelToolArguments('antigravity', { operation: 'read', processRef, cursor }, catalog),
    { operation: 'read', processId: 'internal-process', outputHandle: 'rk-process-output:cursor-one' });
  assert.deepEqual(resolveModelToolArguments('antigravity', { operation: 'stop', processRef }, catalog),
    { operation: 'stop', processId: 'internal-process' });
});

function dispatcherFixture(t, agyPath) {
  const starts = [];
  const waits = [];
  const settlements = [];
  const definitions = [{ ...antigravityTool, declaration: { ...antigravityTool.declaration, source: { kind: 'builtin', sourceId: 'antigravity' } } }];
  const authority = {
    snapshotId: 'authority',
    document: { toolPolicy: { preset: 'custom', allowedTools: ['antigravity'], toolConfigs: { antigravity: { config: { agyPath } } }, sourceConfigs: {} } },
    toolConfig: { config: { agyPath, executionTimeoutMinutes: 45 } }
  };
  const dependencies = {
    database: {}, contentStore: {}, files: {}, fileMutations: {}, mcp: {}, interactions: {},
    processes: {
      async prepareStart(request) { starts.push(request); return { effect: { effectIntentId: 'intent' }, request: { processId: 'process-1' } }; },
      async dispatchStart(id, wait) { waits.push(wait); return {}; }
    },
    effects: {
      subscribeToolModelResults() { return () => {}; },
      async readTerminalResult() { return null; },
      async settleWithoutEffect(input) { settlements.push(input); return { status: input.status }; }
    },
    host: { definitions() { return definitions; }, async resolveProcessCwd(input) { return path.join('/workspace', input.arguments.cwd ?? '.'); } }
  };
  const dispatcher = new ReliableToolDispatcher(dependencies);
  dispatcher.readReadySettlement = async () => undefined;
  t.after(() => dispatcher.dispose());
  return { dispatcher, authority, starts, waits, settlements };
}

test('AG08 start becomes a background process running the runner with the configured timeout', async (t) => {
  const f = fixtureDirectory(t);
  const d = dispatcherFixture(t, f.agyPath);
  const result = await d.dispatcher.dispatchAntigravity({ toolName: 'antigravity', toolCallId: 'call-1', arguments: { prompt: '修 bug', cwd: 'pkg' } },
    d.authority, new AbortController().signal);
  assert.deepEqual(result, { disposition: 'paused', toolCallId: 'call-1', reason: 'background_process', resumeKey: 'process-1' });
  assert.equal(d.starts.length, 1);
  assert.equal(d.starts[0].cwd, path.join('/workspace', 'pkg'));
  assert.equal(d.starts[0].executionTimeoutMs, 45 * 60_000);
  assert.ok(d.starts[0].command.includes(ANTIGRAVITY_RUNNER_FILE.split("'").join("''")));
  assert.ok(!d.starts[0].command.includes('修 bug'));
  assert.deepEqual(d.waits, [3_000]);
});

test('AG09 read and stop use the process paths; a missing agy is rejected instead of started', async (t) => {
  const f = fixtureDirectory(t);
  const d = dispatcherFixture(t, f.agyPath);
  const observed = [];
  d.dispatcher.readProcessOutput = async (input, args) => { observed.push(['read', args]); return 'read'; };
  d.dispatcher.stopProcess = async (input, args) => { observed.push(['stop', args]); return 'stop'; };
  const signal = new AbortController().signal;
  assert.equal(await d.dispatcher.dispatchAntigravity({ toolName: 'antigravity', toolCallId: 'r', arguments: { operation: 'read', processId: 'p', outputHandle: 'h' } }, d.authority, signal), 'read');
  assert.equal(await d.dispatcher.dispatchAntigravity({ toolName: 'antigravity', toolCallId: 's', arguments: { operation: 'stop', processId: 'p' } }, d.authority, signal), 'stop');
  assert.deepEqual(observed, [['read', { processId: 'p', outputHandle: 'h' }], ['stop', { processId: 'p' }]]);

  const missing = dispatcherFixture(t, path.join(f.directory, 'no-agy.exe'));
  await missing.dispatcher.dispatchAntigravity({ toolName: 'antigravity', toolCallId: 'm', arguments: { prompt: 'x' } }, missing.authority, signal);
  assert.equal(missing.starts.length, 0);
  assert.equal(missing.settlements[0].status, 'rejected');
  assert.match(missing.settlements[0].detail.reason, /找不到 agy/);
  assert.equal(resolveAgyExecutable({ agyPath: path.join(f.directory, 'no-agy.exe') }), undefined);
  assert.equal(resolveAgyExecutable({ agyPath: f.agyPath }), f.agyPath);
});
