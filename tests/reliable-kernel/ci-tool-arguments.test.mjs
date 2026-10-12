import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { ReliableToolDispatcher } = require('../../dist/extension/backend/reliableKernel/toolDispatcher.js');
const { commandToolArgumentMetadata } = require('../../dist/extension/shared/commandToolArguments.js');
const { validateEditToolArguments } = require('../../dist/extension/shared/editToolArguments.js');
const { LocalFileToolPlanner, resolvePathInsideBoundary } = require('../../dist/extension/backend/reliableKernel/localFileToolPlanner.js');
const { readFileTool } = require('../../dist/extension/backend/world/modules/tools/definitions/readFile/index.js');
const { WorkEnvironmentTransferEffectDispatcher } = require('../../dist/extension/backend/reliableKernel/workEnvironmentTransferEffects.js');
const { buildModelHandleCatalog, resolveModelToolArguments, projectToolResultForModel } = require('../../dist/extension/backend/reliableKernel/modelHandleCatalog.js');
const { canonicalBase64MaxCharacters, decodeCanonicalBase64 } = require('../../dist/extension/backend/capabilities/canonicalBase64.js');

function dispatcherFixture(t, names) {
  const settlements = [];
  const definitions = names.map(name => ({
    declaration: {
      name, description: name, parameters: { type: 'object' },
      source: { kind: 'builtin', sourceId: name },
      metadata: { defaultAutoApproveExecution: false }, defaultConfig: {}
    },
    execute() { throw new Error('Unexpected direct execution'); }
  }));
  const authority = { snapshotId: 'authority', document: {
    toolPolicy: { preset: 'custom', allowedTools: names, toolConfigs: {}, sourceConfigs: {} },
    planReviewPolicy: { mode: 'off' }, workEnvironmentPolicy: { enabled: true }
  } };
  const dependencies = {
    database: {}, contentStore: {}, files: {}, fileMutations: {}, processes: {}, mcp: {},
    interactions: {
      pauseForExecutionApproval() { throw new Error('Invalid arguments reached approval'); }
    },
    effects: {
      subscribeToolModelResults() { return () => {}; },
      async finalizeReadyInOrder() { return []; },
      async readTerminalResult() { return null; },
      async settleWithoutEffect(input) {
        settlements.push(input);
        return { status: input.status };
      }
    },
    host: { definitions() { return definitions; } }
  };
  const dispatcher = new ReliableToolDispatcher(dependencies);
  dispatcher.readAuthority = async () => authority;
  dispatcher.turnTerminationRequested = async () => false;
  dispatcher.list = async () => [];
  t.after(() => dispatcher.dispose());
  return { dispatcher, dependencies, authority, definitions, settlements };
}

function prepareFreshBatch(f, inputs, frozenDecision) {
  f.dispatcher.resolveToolBatchPreflight = async () => ({
    definitions: f.definitions,
    baseAuthority: f.authority,
    freshCallIds: new Set(inputs.map(input => input.toolCallId)),
    toolCallsById: new Map(inputs.map((input, index) => [input.toolCallId, {
      id: input.toolCallId, call_seq: BigInt(index + 1)
    }])),
    frozenDecisionsById: new Map(frozenDecision
      ? inputs.map(input => [input.toolCallId, frozenDecision]) : []),
    providerDefinitionMismatches: new Map()
  });
}

function readFixture() {
  const calls = [];
  return { calls, dependencies: {
    fs: {
      async readFile(file, startLine, endLine) {
        calls.push({ kind: 'text', file, startLine, endLine });
        return { path: file, startLine: startLine ?? 1, endLine: endLine ?? 2,
          totalLines: 200, content: 'selected text' };
      },
      async readBinaryFile(file, mimeType) {
        calls.push({ kind: 'binary', file, mimeType });
        return { path: file, name: file, data: 'YQ==', sizeBytes: 1 };
      }
    },
    attachments: {
      async reference(id) {
        calls.push({ kind: 'attachment', id });
        return { inlineData: { attachmentId: id, mimeType: 'image/png', data: 'YQ==', sizeBytes: 1 } };
      }
    }
  } };
}

test('TA01 kill policy uses the selected operation and preserves ignored raw command hints', t => {
  const f = dispatcherFixture(t, ['bash']);
  const raw = { mode: 'kill', processId: 'process', command: 'ls', readonly: 'true' };
  const original = structuredClone(raw);
  let policyArguments;
  const definition = f.definitions[0];
  definition.summary = args => { policyArguments = args; return 'stop process'; };
  const authority = { ...f.authority, toolConfig: {
    autoApproveExecution: false, config: { allowCommands: ['ls'], autoApproveReadonly: true }
  } };
  const decision = f.dispatcher.freezeDecision({
    toolName: 'bash', arguments: raw, definition: definition.declaration
  }, definition, authority);
  assert.equal(decision.executionGate, 'approval_required');
  assert.equal(policyArguments.mode, 'kill');
  assert.equal(policyArguments.processId, 'process');
  assert.equal(policyArguments.command, undefined);
  assert.equal(policyArguments.readonly, undefined);
  assert.deepEqual(raw, original);
});

test('TA02 execute defaults and clamped budgets reach the process request without changing raw args', async t => {
  const f = dispatcherFixture(t, ['bash']);
  const raw = { mode: 'execute', command: 'echo budgets', explanation: 'inspect process budgets',
    foregroundWaitMs: null, executionTimeoutMs: '99999999', maxOutputBytes: 512,
    processRef: 'P999', cursor: 'O999' };
  const original = structuredClone(raw);
  const starts = [], waits = [];
  f.dependencies.host.resolveProcessCwd = async input => {
    assert.equal(input.arguments.processRef, undefined);
    assert.equal(input.arguments.cursor, undefined);
    return '/fixture';
  };
  f.dependencies.processes = {
    async prepareStart(request) { starts.push(request); return { effect: { effectIntentId: 'intent' } }; },
    async dispatchStart(id, wait) {
      assert.equal(id, 'intent');
      waits.push(wait);
      return { terminal: { toolCallId: 'budgets', status: 'succeeded' } };
    }
  };
  const result = await f.dispatcher.dispatchProcess({ toolName: 'bash', toolCallId: 'budgets', arguments: raw },
    {}, new AbortController().signal);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(waits, [10_000]);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].command, raw.command);
  assert.equal(starts[0].cwd, '/fixture');
  assert.equal(starts[0].executionTimeoutMs, 600_000);
  assert.equal(starts[0].maxOutputBytes, 1_024);
  const metadata = commandToolArgumentMetadata(raw);
  assert.deepEqual(metadata.adjustedArguments, { executionTimeoutMs: 600_000, maxOutputBytes: 1_024 });
  assert.deepEqual(metadata.ignoredFields, ['processRef', 'cursor']);
  assert.deepEqual(raw, original);
});

test('TA03 selected path wins over meaningful invalid attachment and batch arguments', async () => {
  const f = readFixture();
  const raw = { path: 'selected.txt', mode: 'text', startLine: 120, endLine: 180,
    attachmentId: 17, items: [{ path: 'ignored.png', startLine: 0 }], pages: 'invalid' };
  const original = structuredClone(raw);
  const result = await readFileTool.execute(raw, f.dependencies);
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls, [{ kind: 'text', file: 'selected.txt', startLine: 120, endLine: 180 }]);
  assert.deepEqual(result.output.ignoredFields, ['attachmentRef', 'items', 'pages']);
  assert.equal(result.output.warning, '已选择 path；未使用参数：attachmentRef、items、pages。');
  assert.equal(result.output.files, undefined);
  assert.deepEqual(raw, original);
});

test('TA04 invalid media in a read batch rejects the text sibling before any IO', async () => {
  const f = readFixture();
  const raw = { items: [{ path: 'first.txt' }, { path: 'image.PNG' }] };
  const original = structuredClone(raw);
  const result = await readFileTool.execute(raw, f.dependencies);
  assert.equal(result.ok, false);
  assert.match(result.output, /Cannot read.*UTF-8 text/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(raw, original);
});

test('TA05 inferred images and managed attachments share two slots while a text read advances', async t => {
  const f = dispatcherFixture(t, ['read']);
  const inputs = [
    { turnId: 'turn', modelRequestId: 'request', toolCallId: 'inferred', toolName: 'read',
      arguments: { path: 'first.png', items: [{ path: 'ignored.txt' }] } },
    { turnId: 'turn', modelRequestId: 'request', toolCallId: 'managed', toolName: 'read',
      arguments: { attachmentId: 'managed-image' } },
    { turnId: 'turn', modelRequestId: 'request', toolCallId: 'third', toolName: 'read',
      arguments: { path: 'third.png', mode: null, startLine: null } },
    { turnId: 'turn', modelRequestId: 'request', toolCallId: 'text', toolName: 'read',
      arguments: { path: 'notes.txt' } }
  ];
  const original = structuredClone(inputs);
  prepareFreshBatch(f, inputs);
  let releaseMedia;
  const mediaGate = new Promise(resolve => { releaseMedia = resolve; });
  const started = [];
  let active = 0, maximum = 0;
  f.dispatcher.dispatchInternal = async input => {
    started.push(input.toolCallId);
    if (input.toolCallId !== 'text') {
      active += 1;
      maximum = Math.max(maximum, active);
      await mediaGate;
      active -= 1;
    }
    return { disposition: 'settled', toolCallId: input.toolCallId, status: 'succeeded' };
  };
  const running = f.dispatcher.dispatchBatch(inputs);
  let results;
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(active, 2);
    assert.ok(started.includes('inferred'));
    assert.ok(started.includes('managed'));
    assert.ok(started.includes('text'));
    assert.equal(started.includes('third'), false);
  } finally {
    releaseMedia();
    results = await running;
  }
  assert.equal(maximum, 2);
  assert.deepEqual(results.map(result => result.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);
  assert.equal(started.filter(id => id === 'third').length, 1);
  assert.deepEqual(inputs, original);
});

test('TA06 incomplete explicit edit branch rejects a complete alternative before path resolution', async () => {
  let resolverCalls = 0;
  const planner = new LocalFileToolPlanner(() => {
    resolverCalls += 1;
    throw new Error('Invalid edit reached path resolution');
  });
  const raw = { path: 'sample.txt', mode: 'insert', insert: { line: 1 },
    hunks: [{ oldContent: 'original', newContent: 'changed' }] };
  const original = structuredClone(raw);
  await assert.rejects(planner.plan({ declaration: { name: 'edit' } }, { arguments: raw }, {}),
    /edit\.insert must be complete/);
  assert.equal(resolverCalls, 0);
  assert.deepEqual(raw, original);
});

test('TA07 one hunk infers through empty placeholders and empty newContent removes the matched text', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-ci-edit-arguments-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const absolutePath = path.join(root, 'sample.txt');
  await fs.writeFile(absolutePath, 'remove keep');
  const planner = new LocalFileToolPlanner(input => resolvePathInsideBoundary('fixture', root, input));
  const raw = { path: 'sample.txt', hunks: [{ oldContent: 'remove ', newContent: '' }],
    insert: { line: null, content: '' }, delete: { startLine: null, endLine: null } };
  const original = structuredClone(raw);
  const validated = validateEditToolArguments(raw);
  assert.equal(validated.mode, 'hunk');
  assert.equal(validated.inferred, true);
  assert.deepEqual(validated.ignoredBranches, []);
  const members = await planner.plan({ declaration: { name: 'edit' } }, { arguments: raw }, {});
  assert.equal(members.length, 1);
  assert.equal(members[0].operation, 'replace_file');
  assert.equal(members[0].targetContent, 'keep');
  assert.equal(await fs.readFile(absolutePath, 'utf8'), 'remove keep');
  assert.deepEqual(raw, original);
});

test('TA08 deletion validates its entire batch before resolving the first valid path', async () => {
  let resolverCalls = 0;
  const planner = new LocalFileToolPlanner(() => {
    resolverCalls += 1;
    throw new Error('Invalid delete reached path resolution');
  });
  const raw = { paths: ['first.txt', null] };
  const original = structuredClone(raw);
  await assert.rejects(planner.plan({ declaration: { name: 'delete' } }, { arguments: raw }, {}),
    { name: 'ToolArgumentError' });
  assert.equal(resolverCalls, 0);
  assert.deepEqual(raw, original);
});

test('TA09 new transfer rejects move and keeps false copy options; committed preparation owns re-entry', async () => {
  const item = { fromEnvironment: 'current', fromPath: 'a.txt', toEnvironment: 'current', toPath: 'b.txt' };
  const raw = { transfers: [{ ...item, overwrite: false, createDirs: false }], verify: null };
  const original = structuredClone(raw);
  const source = { kind: 'internal', key: 'transfer-arguments' };
  let committed = false, created = 0;
  const requests = [];
  let preparation;
  const database = { async snapshot() { return { snapshot: [committed ? [{ id: 'committed-receipt' }] : []] }; } };
  const effects = { async prepareEffectIntent(input) {
    requests.push(input);
    if (!committed) {
      created += 1;
      preparation = { effectIntentId: 'transfer-effect', request: input.request };
      committed = true;
    }
    return preparation;
  } };
  const dispatcher = new WorkEnvironmentTransferEffectDispatcher(database, effects);
  const input = { source, toolCallId: 'transfer', authoritySnapshotId: 'authority', arguments: raw };
  const incompatible = { ...raw, operation: 'move' };
  await assert.rejects(dispatcher.prepare({ ...input, arguments: incompatible }), { name: 'ToolArgumentError' });
  assert.equal(created, 0);
  assert.deepEqual(requests, []);
  const fresh = await dispatcher.prepare(input);
  assert.deepEqual(fresh.request.arguments, {
    transfers: [{ ...item, type: 'auto', overwrite: false, createDirs: false }], verify: 'size'
  });
  const replay = await dispatcher.prepare({ ...input, arguments: incompatible });
  assert.equal(replay, fresh);
  assert.equal(created, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].request.arguments, incompatible);
  assert.deepEqual(replay.request.arguments, fresh.request.arguments);
  assert.deepEqual(raw, original);
});

test('TA10 current process and cursor refs authorize output while diagnostics and nested results hide internal IDs', () => {
  const catalog = buildModelHandleCatalog([{ processId: 'internal-process', nextOutputHandle: 'rk-process-output:cursor-one' }]);
  const processRef = catalog.entries.find(entry => entry.kind === 'process').ref;
  const cursor = catalog.entries.find(entry => entry.kind === 'cursor').ref;
  const raw = { mode: 'output', processRef, cursor };
  const original = structuredClone(raw);
  assert.deepEqual(resolveModelToolArguments('bash', raw, catalog), {
    mode: 'output', processId: 'internal-process', outputHandle: 'rk-process-output:cursor-one'
  });
  assert.deepEqual(raw, original);
  assert.throws(() => resolveModelToolArguments('bash', {
    mode: 'output', processId: 'internal-process', processRef, cursor
  }, catalog), error => {
    assert.equal(error.code, 'UNKNOWN_MODEL_HANDLE_REFERENCE');
    assert.equal(error.kind, 'process');
    assert.doesNotMatch(error.message, /internal-process/);
    return true;
  });
  assert.throws(() => resolveModelToolArguments('bash', {
    mode: 'output', processRef, outputHandle: 'rk-process-output:cursor-one'
  }, catalog), error => error.code === 'UNKNOWN_MODEL_HANDLE_REFERENCE' && error.kind === 'cursor');
  let unknown;
  assert.throws(() => resolveModelToolArguments('bash', { mode: 'output', processRef: 'P999' }, catalog), error => {
    assert.equal(error.code, 'UNKNOWN_MODEL_HANDLE_REFERENCE');
    assert.match(error.message, /P999/);
    unknown = error.message;
    return true;
  });
  const failure = { status: 'failed', detail: { code: 'invalid_model_handle_reference', error: unknown } };
  assert.deepEqual(projectToolResultForModel('bash', failure, catalog), failure);
  const projected = projectToolResultForModel('example_mcp_tool', {
    status: 'succeeded', detail: { result: { structuredContent: {
      code: 'invalid_model_handle_reference', error: 'internal-process',
      nested: [{ code: 'invalid_model_handle_reference', error: 'internal-process' }]
    } } }
  }, catalog);
  assert.deepEqual(projected.detail.result.structuredContent, {
    code: 'invalid_model_handle_reference', error: processRef,
    nested: [{ code: 'invalid_model_handle_reference', error: processRef }]
  });
  assert.doesNotMatch(JSON.stringify(projected), /internal-process/);
});

test('TA11 one exact 20 MiB base64 attachment decodes fully and rejects a limit one byte smaller', () => {
  const limit = 20 * 1024 * 1024;
  const bytes = Buffer.alloc(limit, 0xa5);
  const encoded = bytes.toString('base64');
  assert.equal(encoded.length, canonicalBase64MaxCharacters(limit));
  const decoded = decodeCanonicalBase64(encoded, { maxBytes: limit });
  assert.equal(decoded.byteLength, limit);
  assert.equal(decoded.equals(bytes), true);
  assert.throws(() => decodeCanonicalBase64(encoded, { maxBytes: limit - 1 }),
    error => error instanceof RangeError && /exceeds 20971519 bytes/.test(error.message));
});

test('TA12 bad write settles before approval or file work while its valid read sibling executes', async t => {
  const f = dispatcherFixture(t, ['write', 'read']);
  const read = readFixture();
  const inputs = [
    { turnId: 'turn', modelRequestId: 'request', toolCallId: 'bad-write', toolName: 'write',
      arguments: { path: 'notes.txt', content: 'append', append: true } },
    { turnId: 'turn', modelRequestId: 'request', toolCallId: 'good-read', toolName: 'read',
      arguments: { path: 'notes.txt', startLine: 1, endLine: 2 } }
  ];
  const original = structuredClone(inputs);
  prepareFreshBatch(f, inputs, {
    executionGate: 'automatic', autoSubmitResult: true, schedulingMode: 'parallel',
    changeApplyMode: 'unsupported', changeApplyDelaySeconds: 0
  });
  let fileWork = 0;
  const executions = [];
  f.dispatcher.dispatchFile = async () => {
    fileWork += 1;
    throw new Error('Invalid write reached file planning');
  };
  f.dispatcher.dispatchNoEffect = async (_definition, input) => {
    executions.push(input.toolCallId);
    const result = await readFileTool.execute(input.arguments, read.dependencies);
    assert.equal(result.ok, true);
    return { disposition: 'settled', toolCallId: input.toolCallId, status: 'succeeded' };
  };
  const results = await f.dispatcher.dispatchBatch(inputs);
  assert.deepEqual(results.map(result => result.status), ['failed', 'succeeded']);
  assert.deepEqual(executions, ['good-read']);
  assert.deepEqual(read.calls, [{ kind: 'text', file: 'notes.txt', startLine: 1, endLine: 2 }]);
  assert.equal(fileWork, 0);
  assert.equal(f.settlements.length, 1);
  assert.equal(f.settlements[0].toolCallId, 'bad-write');
  assert.equal(f.settlements[0].detail.code, 'invalid_tool_arguments');
  assert.deepEqual(inputs, original);
});
