import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { ReliableToolDispatcher } = require('../../dist/extension/backend/reliableKernel/toolDispatcher.js');
const { validateCommandToolArguments } = require('../../dist/extension/shared/commandToolArguments.js');
const { resolveModelToolArguments, buildModelHandleCatalog } = require('../../dist/extension/backend/reliableKernel/modelHandleCatalog.js');
const { readFileTool } = require('../../dist/extension/backend/world/modules/tools/definitions/readFile/index.js');

function fixture(names) {
  const settlements = [], executions = [];
  const definitions = names.map(name => ({ declaration: {
    name, description: name, parameters: { type: 'object' }, source: { kind: 'builtin', sourceId: name },
    metadata: { defaultAutoApproveExecution: false }, defaultConfig: {}
  }, execute() { throw new Error('Unexpected direct execution'); } }));
  const authority = { snapshotId: 'authority', document: {
    toolPolicy: { preset: 'custom', allowedTools: names, toolConfigs: {}, sourceConfigs: {} },
    planReviewPolicy: { mode: 'off' }, workEnvironmentPolicy: { enabled: true }
  } };
  const dispatcher = new ReliableToolDispatcher({
    database: {}, contentStore: {}, files: {}, fileMutations: {}, processes: {}, mcp: {},
    interactions: { pauseForExecutionApproval() { throw new Error('Malformed args must not open approval'); } },
    effects: {
      subscribeToolModelResults() { return () => {}; },
      async finalizeReadyInOrder() { return []; }, async readTerminalResult() { return null; },
      async settleWithoutEffect(input) { settlements.push(input); return { status: input.status }; }
    }, host: { definitions() { return definitions; } }
  });
  dispatcher.readAuthority = async () => authority;
  dispatcher.turnTerminationRequested = async () => false;
  dispatcher.list = async () => [];
  dispatcher.dispatchNoEffect = async (_definition, input) => {
    executions.push(input); return { disposition: 'settled', toolCallId: input.toolCallId, status: 'succeeded' };
  };
  return { dispatcher, authority, definitions, settlements, executions };
}

test('command defaults tolerate placeholders and unknown hints, but mode typos and process targets never launch', () => {
  const args = { command: 'pwd', explanation: 'locate project', mode: null, cwd: '', foregroundWaitMs: null, note: 'ignored' };
  const original = structuredClone(args);
  assert.equal(validateCommandToolArguments(args).mode, 'execute');
  assert.equal(validateCommandToolArguments(args).foregroundWaitMs, undefined);
  assert.deepEqual(args, original);
  assert.throws(() => validateCommandToolArguments({ ...args, mode: 'outpt' }), /mode must/);
  assert.throws(() => validateCommandToolArguments({ ...args, processRef: 'P1' }), /requires mode/);
  assert.throws(() => validateCommandToolArguments({ ...args, foregroundWaitMs: false }), /foregroundWaitMs/);
  const catalog = buildModelHandleCatalog([{ processId: 'process' }]);
  assert.throws(() => resolveModelToolArguments('bash', { mode: 'outpt', command: 'pwd', explanation: 'x' }, catalog), /mode must/);
});

test('every malformed built-in settles before new approvals or work and preserves its raw arguments', async () => {
  const cases = [
    ['bash', { mode: 'outpt', command: 'pwd', explanation: 'x' }],
    ['shell', { mode: 'execute', command: 'pwd' }],
    ['ask_user', { question: 'Choose', options: [] }],
    ['submit_plan', { plan: '' }],
    ['write', { path: 'x', content: 'new', append: true }],
    ['delete', { paths: ['x'], recursive: false }],
    ['edit', { path: 'x', mode: 'insert', insert: { line: 0, content: 'x' } }],
    ['read', { path: 'x', startLine: false }],
    ['transfer', { transfers: [], verify: 'sha256' }],
    ['run_agent', { operation: 'send', prompt: 'hello' }],
    ['read_agent_answer', { prompt: 'missing child target' }],
    ['skills', { name: 'x', source: 'unknown' }],
    ['update_task_list', { mode: 'rewrite', items: [{ title: 'x', status: 'done' }] }]
  ];
  const f = fixture(cases.map(([name]) => name));
  for (const [toolName, args] of cases) {
    const original = structuredClone(args);
    const input = { turnId: 'turn', modelRequestId: 'request', toolCallId: toolName, toolName, arguments: args };
    const result = await f.dispatcher.dispatchInternal(input, {
      skipInitialFinalization: true, assumeFresh: true, skipProviderDefinitionCheck: true,
      definitions: f.definitions, authority: f.authority
    });
    assert.equal(result.status, 'failed', toolName);
    assert.deepEqual(args, original, toolName);
  }
  assert.equal(f.settlements.length, cases.length);
  assert.ok(f.settlements.every(s => s.detail.code === 'invalid_tool_arguments'));
  assert.equal(f.executions.length, 0);
});

test('mixed Read targets pass fresh admission and execute only the selected path without altering arguments', async () => {
  const f = fixture(['read']);
  const raw = { path: 'SidebarApp.vue', mode: 'text', startLine: 120, endLine: 180,
    items: [{ path: 'SidebarApp.vue', startLine: 120, endLine: 180 }, { path: 'SidebarApp.vue', startLine: 1, endLine: 80 }] };
  const original = structuredClone(raw);
  const reads = [];
  let observed;
  f.dispatcher.dispatchNoEffect = async (_definition, input) => {
    observed = await readFileTool.execute(input.arguments, {
      fs: { async readFile(file, startLine, endLine) {
        reads.push([file, startLine, endLine]);
        return { path: file, startLine, endLine, totalLines: 200, content: 'selected range' };
      } }
    });
    return { disposition: 'settled', toolCallId: input.toolCallId, status: observed.ok ? 'succeeded' : 'failed' };
  };
  const input = { turnId: 'turn', modelRequestId: 'request', toolCallId: 'mixed-read', toolName: 'read', arguments: raw };
  const frozen = f.dispatcher.freezeDecision({ ...input, definition: f.definitions[0].declaration }, f.definitions[0], f.authority);
  assert.notEqual(frozen.schedulingReason, 'invalid_tool_arguments');
  const result = await f.dispatcher.dispatchInternal(input, { skipInitialFinalization: true, assumeFresh: true, skipProviderDefinitionCheck: true,
    toolCall: { id: input.toolCallId, call_seq: 1n },
    definitions: f.definitions, authority: f.authority, frozenDecision: { ...frozen, executionGate: 'automatic' } });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(reads, [['SidebarApp.vue', 120, 180]]);
  assert.equal(observed.output.warning, '已选择 path；未使用参数：items。');
  assert.deepEqual(f.settlements, []);
  assert.deepEqual(raw, original);
});

test('malformed summaries freeze a serial slot; ignored command text cannot approve kill', () => {
  const f = fixture(['run_agent', 'bash']);
  const live = f.definitions[0];
  live.summary = live.scheduling = () => { throw new Error('Malformed arguments reached summary'); };
  const invalid = f.dispatcher.freezeDecision({ toolName: 'run_agent', arguments: { operation: 'typo' }, definition: live.declaration }, live, f.authority);
  assert.equal(invalid.schedulingMode, 'serial');
  assert.equal(invalid.schedulingReason, 'invalid_tool_arguments');
  const command = f.definitions[1];
  const authority = { ...f.authority, toolConfig: { autoApproveExecution: false, config: { allowCommands: ['ls'], autoApproveReadonly: true } } };
  const killed = f.dispatcher.freezeDecision({ toolName: 'bash', arguments: {
    mode: 'kill', processId: 'process', command: 'ls', readonly: 'true'
  }, definition: command.declaration }, command, authority);
  assert.equal(killed.executionGate, 'approval_required');
});

test('an invalid built-in fails individually while a valid sibling in the same batch executes', async () => {
  const f = fixture(['skills', 'echo']);
  const inputs = [
    { turnId: 'turn', modelRequestId: 'request', toolCallId: 'bad', toolName: 'skills', arguments: { name: 'x', source: 'invalid' } },
    { turnId: 'turn', modelRequestId: 'request', toolCallId: 'good', toolName: 'echo', arguments: { value: 'ok' } }
  ];
  const automatic = { executionGate: 'automatic', autoSubmitResult: true, schedulingMode: 'parallel', changeApplyMode: 'unsupported', changeApplyDelaySeconds: 0 };
  f.dispatcher.resolveToolBatchPreflight = async () => ({
    definitions: f.definitions, baseAuthority: f.authority, freshCallIds: new Set(['bad', 'good']),
    toolCallsById: new Map(inputs.map((input, index) => [input.toolCallId, { id: input.toolCallId, call_seq: BigInt(index + 1) }])),
    frozenDecisionsById: new Map(inputs.map(input => [input.toolCallId, automatic])), providerDefinitionMismatches: new Map()
  });
  const results = await f.dispatcher.dispatchBatch(inputs);
  assert.deepEqual(results.map(result => result.status), ['failed', 'succeeded']);
  assert.deepEqual(f.executions.map(input => input.toolCallId), ['good']);
  assert.equal(f.settlements.length, 1);
});

test('prepared process re-entry uses its frozen intent even when new arguments would fail', async () => {
  const f = fixture(['bash']);
  const dispatched = [];
  f.dispatcher.list = async domain => domain === 'Attempt' ? [{ id: 'attempt' }] : [{ id: 'intent', effect_kind: 'process_start' }];
  f.dispatcher.dependencies.processes = { async dispatchStart(...args) { dispatched.push(args); return { terminal: { toolCallId: 'old', status: 'succeeded' } }; } };
  const result = await f.dispatcher.dispatchProcess({ toolCallId: 'old', toolName: 'bash', arguments: { mode: 'old-mode' } },
    f.authority, new AbortController().signal, { id: 'operation' });
  assert.equal(result.status, 'succeeded');
  assert.equal(dispatched[0][0], 'intent');
  assert.equal(f.settlements.length, 0);
});

test('inferred image reads and managed attachments share the two-slot lane while text tools proceed', async () => {
  const f = fixture(['read', 'echo']);
  const inputs = [
    { path: 'a.png', items: [{ path: 'ignored.txt' }] }, { attachmentId: 'managed-pdf' },
    { path: 'c.png', mode: null, startLine: null }, { path: 'd.png', mode: 'attachment' }
  ].map((argumentsValue, index) => ({ turnId: 'turn', modelRequestId: 'request', toolCallId: `media-${index}`,
    toolName: 'read', arguments: argumentsValue }));
  inputs.push({ turnId: 'turn', modelRequestId: 'request', toolCallId: 'text', toolName: 'echo', arguments: {} });
  f.dispatcher.resolveToolBatchPreflight = async () => ({
    definitions: f.definitions, baseAuthority: f.authority, freshCallIds: new Set(inputs.map(input => input.toolCallId)),
    toolCallsById: new Map(), frozenDecisionsById: new Map(), providerDefinitionMismatches: new Map()
  });
  let releaseMedia, textStarted;
  const mediaGate = new Promise(resolve => { releaseMedia = resolve; });
  const textReady = new Promise(resolve => { textStarted = resolve; });
  let active = 0, maximum = 0;
  f.dispatcher.dispatchInternal = async input => {
    if (input.toolCallId === 'text') textStarted();
    else {
      active++; maximum = Math.max(maximum, active);
      await mediaGate;
      active--;
    }
    return { disposition: 'settled', toolCallId: input.toolCallId, status: 'succeeded' };
  };
  const running = f.dispatcher.dispatchBatch(inputs);
  try {
    await textReady;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(active, 2, 'inferred media reads must use the same bounded lane as explicit attachments');
  } finally {
    releaseMedia();
    await running;
  }
  assert.equal(maximum, 2);
});
