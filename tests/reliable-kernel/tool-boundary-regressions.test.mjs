import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = process.cwd();
const { readFileTool } = require(path.join(
  root,
  'dist/extension/backend/world/modules/tools/definitions/readFile/index.js'
));
const {
  LocalFileToolPlanner,
  resolvePathInsideBoundary
} = require(path.join(root, 'dist/extension/backend/reliableKernel/localFileToolPlanner.js'));
const { ReliableAgentLoop } = require(path.join(
  root,
  'dist/extension/backend/reliableKernel/agentLoop.js'
));
const { ReliableToolDispatcher } = require(path.join(
  root,
  'dist/extension/backend/reliableKernel/toolDispatcher.js'
));
const { createCommandTool } = require(path.join(
  root,
  'dist/extension/backend/world/modules/tools/definitions/command/index.js'
));

for (const toolName of ['shell', 'bash']) {
  for (const [fieldName, minimum, maximum] of [
    ['foregroundWaitMs', 0, 60000],
    ['executionTimeoutMs', 1000, 600000],
    ['maxOutputBytes', 1024, 1073741824]
  ]) {
    test(`${toolName} 的 ${fieldName} 声明与可靠执行器整数边界一致`, async () => {
      const stoppedBeforeProcessStart = new Error('stopped before process start');
      const dispatcher = {
        dependencies: {
          host: { async resolveProcessCwd() { throw stoppedBeforeProcessStart; } }
        }
      };
      const dispatch = (value) => ReliableToolDispatcher.prototype.dispatchProcess.call(
        dispatcher,
        {
          toolName,
          toolCallId: 'command-integer-contract',
          arguments: {
            command: 'echo contract-test',
            explanation: 'check command parameter boundaries without starting a process',
            foregroundWaitMs: 0,
            [fieldName]: value
          }
        },
        {},
        new AbortController().signal
      );
      const validValues = [minimum, maximum];
      const invalidValues = [minimum - 1, maximum + 1, minimum + 0.5, '1000', null];
      if (fieldName === 'foregroundWaitMs') invalidValues.push(undefined, 90000, 120000);
      else validValues.push(undefined);
      for (const value of validValues) {
        await assert.rejects(dispatch(value), (error) => error === stoppedBeforeProcessStart);
      }
      for (const value of invalidValues) {
        await assert.rejects(dispatch(value), new RegExp(`${fieldName} must be an integer from ${minimum} to ${maximum}`));
      }
      const tool = createCommandTool({ toolName, description: toolName });
      const field = tool.declaration.parameters.properties[fieldName];
      assert.equal(field.type, 'integer');
      assert.equal(field.minimum, minimum);
      assert.equal(field.maximum, maximum);
      if (fieldName === 'foregroundWaitMs') {
        assert.match(field.description, /0 to 60000/);
        assert.match(field.description, /executionTimeoutMs/);
        assert.ok(!tool.declaration.parameters.required?.includes(fieldName));
      }
    });
  }
}

function readDeps() {
  const calls = { binary: [], text: [] };
  return {
    calls,
    deps: {
      fs: {
        async readBinaryFile(filePath, mimeType) {
          calls.binary.push({ filePath, mimeType });
          return {
            path: filePath,
            name: path.basename(filePath),
            mimeType,
            data: 'cG5n',
            sizeBytes: 3
          };
        },
        async readFile(filePath) {
          calls.text.push(filePath);
          return {
            path: filePath,
            startLine: 1,
            endLine: 1,
            totalLines: 1,
            content: '1 text'
          };
        }
      }
    }
  };
}

test('read 省略 mode 时按 Windows PNG 扩展名读取附件，显式 text 仍拒绝', async () => {
  const filePath = 'D:/Lichi/card/h3/58DAE7EECAFAA3ABB90FF741FC0D0010.png';
  const inferred = readDeps();
  const inferredResult = await readFileTool.execute({ path: filePath }, inferred.deps, {
    settingsSnapshot: { enableMultimodalTools: true }
  });
  assert.equal(inferredResult.ok, true);
  assert.deepEqual(inferredResult.output, { mimeType: 'image/png', sizeBytes: 3 });
  assert.equal(inferred.calls.binary.length, 1);
  assert.equal(inferred.calls.text.length, 0);

  const explicitText = readDeps();
  const textResult = await readFileTool.execute({ path: filePath, mode: 'text' }, explicitText.deps);
  assert.equal(textResult.ok, false);
  assert.match(String(textResult.output), /mode="attachment"/);
  assert.equal(explicitText.calls.binary.length, 0);
  assert.equal(explicitText.calls.text.length, 0);
});

const editDefinition = { declaration: { name: 'edit' } };

async function planEdit(initialContent, hunks) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-local-file-planner-'));
  const target = path.join(parent, 'sample.ts');
  try {
    await fs.writeFile(target, initialContent, 'utf8');
    const planner = new LocalFileToolPlanner((inputPath) =>
      resolvePathInsideBoundary('workspace', parent, inputPath));
    const members = await planner.plan(
      editDefinition,
      {
        turnId: 'turn-local-file-planner',
        modelRequestId: 'model-local-file-planner',
        toolCallId: 'tool-local-file-planner',
        toolName: 'edit',
        arguments: { path: 'sample.ts', hunks }
      },
      { snapshotId: 'authority-local-file-planner', document: {} }
    );
    assert.equal(members.length, 1);
    return members[0].targetContent;
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
}

test('LocalFileToolPlanner 用 LF hunk 连续编辑 CRLF 文件并保留 CRLF', async () => {
  const target = await planEdit(
    'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n',
    [
      {
        oldContent: 'const a = 1;\nconst b = 2;',
        newContent: 'const a = 1;\nconst b = 20;'
      },
      {
        oldContent: 'const b = 20;\nconst c = 3;',
        newContent: 'const b = 20;\nconst c = 30;'
      }
    ]
  );
  assert.equal(target, 'const a = 1;\r\nconst b = 20;\r\nconst c = 30;\r\n');
});

test('LocalFileToolPlanner 的 replaceAll 保留每个 CRLF 匹配块的换行风格', async () => {
  const target = await planEdit(
    'start\r\na\r\nb\r\nmiddle\r\na\r\nb\r\nend\r\n',
    [{ oldContent: 'a\nb', newContent: 'x\ny', replaceAll: true }]
  );
  assert.equal(target, 'start\r\nx\r\ny\r\nmiddle\r\nx\r\ny\r\nend\r\n');
});

test('LocalFileToolPlanner 用 CRLF hunk 匹配 LF 文件时仍保留 LF', async () => {
  const target = await planEdit(
    'alpha\nbeta\ngamma\n',
    [{ oldContent: 'alpha\r\nbeta', newContent: 'ALPHA\r\nBETA' }]
  );
  assert.equal(target, 'ALPHA\nBETA\ngamma\n');
});

test('AgentLoop把未知短引用隔离为失败ToolCall并继续同批其它工具', async () => {
  const policy = {
    summary: null,
    displayAutoExpand: false,
    displayAutoOpenDiff: false,
    executionGate: 'immediate',
    changeApplyMode: 'unsupported',
    changeApplyDelaySeconds: 0,
    autoSubmitResult: true,
    schedulingMode: 'parallel',
    schedulingReason: 'test'
  };
  const canonicalBridgeId = `answer_bridge_${'a'.repeat(64)}`;
  let createdBatch;
  let invalidSettlements;
  let dispatchInputs;
  let confirmedBatches = 0;
  const batchAdmission = Object.freeze({ fixture: 'unknown-handle-batch-admission' });
  const loop = Object.create(ReliableAgentLoop.prototype);
  loop.database = {
    async snapshotAll() {
      return { snapshotCommitSeq: '0', snapshot: [] };
    }
  };
  loop.effects = {
    async createToolCallBatch(input) {
      createdBatch = input;
      return {
        receiptId: 'receipt-invalid-child-ref',
        batchId: input.batchId,
        calls: input.entries.map((entry, index) => ({
          toolCallId: entry.toolCallId,
          toolExecutionId: `execution-invalid-child-ref-${index}`,
          callSeq: String(index + 1),
          providerOrdinal: entry.providerOrdinal
        })),
        deduplicated: false,
        commitSeq: '1'
      };
    },
    async settleWithoutEffectBatch(input) {
      invalidSettlements = input;
      return input.settlements.map((entry) => ({
        toolCallId: entry.toolCallId,
        status: entry.status
      }));
    }
  };
  loop.tools = {
    async freezeCalls(inputs) {
      assert.equal(inputs.length, 2);
      return inputs.map(() => policy);
    },
    async confirmPreparedBatch(input) {
      confirmedBatches += 1;
      assert.equal(input.creation.batchId, input.batchId);
      assert.equal(input.calls.length, 2);
      return batchAdmission;
    },
    async dispatchBatch(inputs, options) {
      dispatchInputs = inputs;
      assert.equal(options.admission, batchAdmission);
      return inputs.map((input) => ({
        disposition: 'settled',
        toolCallId: input.toolCallId,
        status: 'succeeded'
      }));
    }
  };
  loop.lifecycleObserver = { observe() {} };
  loop.now = () => '2026-01-01T00:00:00.000Z';
  loop.readModelRequestToolDefinitions = async () => [
    { name: 'read_agent_answer', description: 'read answer', parameters: { type: 'object' } },
    { name: 'read', description: 'read', parameters: { type: 'object' } }
  ];

  const calls = await loop.prepareProviderToolBatch({
    turnId: 'turn-invalid-child-ref',
    modelRequestId: 'model-invalid-child-ref',
    messageId: 'message-invalid-child-ref',
    recipe: { tools: [], modelHandleCatalog: { entries: [] } },
    output: {
      content: { role: 'model', parts: [] },
      toolCalls: [
        {
          providerCallId: 'provider-invalid-child-ref',
          providerOrdinal: 0,
          name: 'read_agent_answer',
          arguments: { childRef: canonicalBridgeId }
        },
        {
          providerCallId: 'provider-valid-read',
          providerOrdinal: 1,
          name: 'read',
          arguments: { path: 'notes.txt' }
        }
      ]
    }
  });

  assert.match(calls[0].argumentResolutionError, /^childRef 只接受.*子 Agent 短引用（A#）/);
  assert.doesNotMatch(calls[0].argumentResolutionError, new RegExp(canonicalBridgeId));
  assert.equal(calls[1].argumentResolutionError, undefined);
  assert.deepEqual(createdBatch.entries[0].arguments, {
    childRef: canonicalBridgeId
  });

  const finalizedByDispatcher = await loop.dispatchProviderToolGroup({
    turnId: 'turn-invalid-child-ref',
    round: '1',
    modelRequestId: 'model-invalid-child-ref',
    calls
  });
  assert.equal(finalizedByDispatcher, true);
  assert.equal(invalidSettlements.settlements.length, 1);
  assert.equal(invalidSettlements.settlements[0].status, 'failed');
  assert.equal(invalidSettlements.settlements[0].detail.code, 'invalid_model_handle_reference');
  assert.equal(confirmedBatches, 1);
  assert.equal(dispatchInputs.length, 1);
  assert.equal(dispatchInputs[0].toolName, 'read');
});

test('已消费或重放的 Provider 准入证明必须重新检查持久化事实', async () => {
  const liveDefinition = {
    declaration: {
      name: 'echo',
      description: 'fixture echo',
      parameters: { type: 'object' },
      source: { kind: 'builtin', sourceId: 'fixture-echo' },
      metadata: { defaultAutoApproveExecution: true },
      defaultConfig: {}
    },
    scheduling: () => ({ mode: 'parallel', reason: 'fixture parallel' })
  };
  const frozenDefinition = {
    name: 'echo',
    description: 'fixture echo',
    parameters: { type: 'object' },
    source: { kind: 'builtin', sourceId: 'fixture-echo' },
    metadata: { defaultAutoApproveExecution: true },
    defaultConfig: {}
  };
  const authority = {
    snapshotId: 'authority-batch-admission',
    document: {
      toolPolicy: {
        preset: 'custom',
        allowedTools: ['echo'],
        toolConfigs: {},
        sourceConfigs: {}
      }
    }
  };
  const dispatcher = new ReliableToolDispatcher({
    database: {
      async snapshot() {
        throw new Error('full preflight fallback reached');
      }
    },
    contentStore: {},
    effects: { subscribeToolModelResults: () => () => undefined },
    files: {},
    fileMutations: {},
    processes: {},
    mcp: {},
    interactions: {},
    host: {
      definitions() {
        return [liveDefinition];
      }
    }
  });
  dispatcher.readAuthority = async () => authority;
  const dispatchInput = {
    turnId: 'turn-batch-admission',
    modelRequestId: 'model-batch-admission',
    toolCallId: 'tool-batch-admission',
    providerCallId: 'provider-batch-admission',
    toolName: 'echo',
    arguments: { value: 'checked' }
  };
  const [policy] = await dispatcher.freezeCalls([{ ...dispatchInput, definition: frozenDefinition }]);
  const creation = {
    receiptId: 'receipt-batch-admission',
    batchId: 'batch-admission',
    calls: [{
      toolCallId: dispatchInput.toolCallId,
      toolExecutionId: 'execution-batch-admission',
      callSeq: '1',
      providerOrdinal: 0
    }],
    deduplicated: false,
    commitSeq: '7'
  };
  const admission = dispatcher.confirmPreparedBatch({
    turnId: dispatchInput.turnId,
    modelRequestId: dispatchInput.modelRequestId,
    messageId: 'message-batch-admission',
    batchId: creation.batchId,
    recipeDefinitions: [frozenDefinition],
    calls: [{ ...dispatchInput, providerOrdinal: 0, policy }],
    creation
  });

  await dispatcher.resolveToolBatchPreflight(
    [dispatchInput],
    dispatchInput.turnId,
    admission
  );

  await assert.rejects(
    dispatcher.resolveToolBatchPreflight([dispatchInput], dispatchInput.turnId, admission),
    /full preflight fallback reached/
  );

  await dispatcher.freezeCalls([{ ...dispatchInput, definition: frozenDefinition }]);
  const replayAdmission = dispatcher.confirmPreparedBatch({
    turnId: dispatchInput.turnId,
    modelRequestId: dispatchInput.modelRequestId,
    messageId: 'message-batch-admission',
    batchId: creation.batchId,
    recipeDefinitions: [frozenDefinition],
    calls: [{ ...dispatchInput, providerOrdinal: 0, policy }],
    creation: { ...creation, deduplicated: true, commitSeq: undefined }
  });
  assert.equal(replayAdmission, undefined, 'deduplicated/recovery 创建不得获得快路径准入');
});

// 模型短引用边界回归：仅编译目录可授权的 refs，生产 ToolCall 不接受内部 canonical id。

const { buildModelHandleCatalog, resolveModelToolArguments, projectToolResultForModel } =
  require(path.join(root, 'dist/extension/backend/reliableKernel/modelHandleCatalog.js'));

const catalog = buildModelHandleCatalog([
  { attachmentId: 'internal-attachment', processId: 'internal-process', nextOutputHandle: 'rk-process-output:cursor-one',
    answerBridgeId: 'internal-child', workEnvironmentId: 'work-env-owned' },
  { kind: 'cross_conversation', conversationId: 'internal-conversation' }
]);
const ref = kind => catalog.entries.find(entry => entry.kind === kind).ref;
const rejected = (toolName, args, kind) => assert.throws(
  () => resolveModelToolArguments(toolName, args, catalog),
  error => error.code === 'UNKNOWN_MODEL_HANDLE_REFERENCE' && error.kind === kind
);

test('read, run_agent, switch_work_environment 只接受冻结短引用，不接受内部 ID', () => {
  assert.deepEqual(resolveModelToolArguments('read', { attachmentRef: ref('attachment') }, catalog),
    { attachmentId: 'internal-attachment' });
  assert.deepEqual(resolveModelToolArguments('run_agent', { childRef: ref('child') }, catalog),
    { answerBridgeId: 'internal-child' });
  assert.deepEqual(resolveModelToolArguments('switch_work_environment', { workEnvironmentRef: ref('workEnvironment') }, catalog),
    { workEnvironmentId: 'work-env-owned' });
  assert.throws(() => resolveModelToolArguments('read', { attachmentRef: 'internal-attachment' }, catalog), error => {
    assert.equal(error.code, 'UNKNOWN_MODEL_HANDLE_REFERENCE');
    assert.doesNotMatch(error.message, /internal-attachment/, '不能把被拒绝的 canonical ID 又回显给模型');
    return true;
  });
  for (const [tool, canonical, target, kind] of [
    ['read', 'attachmentId', 'internal-attachment', 'attachment'],
    ['run_agent', 'answerBridgeId', 'internal-child', 'child'],
    ['switch_work_environment', 'workEnvironmentId', 'work-env-owned', 'workEnvironment']
  ]) {
    rejected(tool, { [canonical]: target }, kind);
    rejected(tool, { [canonical]: target, [kind === 'child' ? 'childRef' : kind === 'attachment' ? 'attachmentRef' : 'workEnvironmentRef']: ref(kind) }, kind);
  }
  rejected('run_agent', { answerBridgeIds: ['internal-child'] }, 'child');
  rejected('run_agent', { childRefs: [ref('child')], answerBridgeIds: ['internal-child'] }, 'child');
  for (const args of [{ attachmentRef: 'F999' }, { attachmentRef: ref('process') }, { attachmentRef: 7 }]) {
    rejected('read', args, 'attachment');
  }
});

for (const tool of ['bash', 'shell']) {
  test(`${tool} 执行与后台观察只接受当前目录授权的 P#/O#，拒绝所有内部 ID`, () => {
    const processRef = ref('process');
    const cursor = ref('cursor');
    const output = { mode: 'output', processRef, cursor };
    assert.deepEqual(resolveModelToolArguments(tool, output, catalog), {
      mode: 'output', processId: 'internal-process', outputHandle: 'rk-process-output:cursor-one'
    });
    assert.deepEqual(output, { mode: 'output', processRef, cursor }, '短引用转换不得修改模型原参数');
    assert.deepEqual(resolveModelToolArguments(tool, { mode: 'output', processRef }, catalog),
      { mode: 'output', processId: 'internal-process' }, '首个输出页面不需要游标');
    assert.deepEqual(resolveModelToolArguments(tool, { mode: 'kill', processRef }, catalog),
      { mode: 'kill', processId: 'internal-process' });
    assert.deepEqual(resolveModelToolArguments(tool, { command: 'pwd', explanation: 'inspect', foregroundWaitMs: 0 }, catalog),
      { command: 'pwd', explanation: 'inspect', foregroundWaitMs: 0 });
    assert.throws(() => resolveModelToolArguments(tool, { mode: 'output' }, catalog), error => {
      assert.equal(error.code, 'UNKNOWN_MODEL_HANDLE_REFERENCE');
      assert.match(error.message, /mode=output 需要 processRef/);
      return true;
    });
    assert.throws(() => resolveModelToolArguments(tool, { mode: 'kill', processRef, cursor }, catalog), error => {
      assert.equal(error.code, 'UNKNOWN_MODEL_HANDLE_REFERENCE');
      assert.equal(error.kind, 'cursor');
      assert.match(error.message, /cursor 只用于 mode=output.*mode=kill 不接受 cursor/);
      return true;
    });

    for (const args of [
      { mode: 'output' }, { mode: 'kill' }, { mode: 'output', processRef: '' },
      { mode: 'output', processRef: 'P999' }, { mode: 'output', processRef: ref('child') },
      { mode: 'output', processRef: 3 },
      { mode: 'execute', processRef, command: 'pwd', foregroundWaitMs: 0 }
    ]) rejected(tool, args, 'process');
    for (const args of [
      { mode: 'output', processId: 'internal-process' },
      { mode: 'kill', processId: 'internal-process', processRef },
      { command: 'pwd', processId: 'internal-process', foregroundWaitMs: 0 }
    ]) rejected(tool, args, 'process');
    for (const args of [
      { mode: 'kill', processRef, cursor },
      { cursor, command: 'pwd', foregroundWaitMs: 0 },
      { mode: 'output', processRef, cursor: 'O999' },
      { mode: 'output', processRef, cursor: ref('conversation') },
      { mode: 'output', processRef, outputHandle: 'rk-process-output:cursor-one' },
      { mode: 'output', processRef, cursor, outputHandle: 'rk-process-output:cursor-one' }
    ]) rejected(tool, args, 'cursor');
  });
}

test('参数错误说明具体字段、应传形式和正确键名，不把有效引用说成未知', () => {
  const failure = (toolName, args, handles = catalog) => {
    try {
      resolveModelToolArguments(toolName, args, handles);
    } catch (error) {
      assert.equal(error.code, 'UNKNOWN_MODEL_HANDLE_REFERENCE');
      return error;
    }
    assert.fail(`${toolName} ${JSON.stringify(args)} 必须被拒绝`);
  };
  const processRef = ref('process');
  const cursor = ref('cursor');

  // 有效 P# 漏传 mode：是模式错误，不是未知进程。
  const missingMode = failure('bash', { processRef });
  assert.equal(missingMode.kind, 'process');
  assert.equal(missingMode.argument, 'processRef');
  assert.doesNotMatch(missingMode.message, /未知/);
  assert.match(missingMode.message, /processRef 只用于 mode=output.*mode=kill/);
  assert.match(missingMode.message, /未传 mode 时按 mode=execute/);
  assert.match(missingMode.message, new RegExp(`要读取或终止 ${processRef}，请同时传 mode=output 或 mode=kill`));
  const unknownWithExecute = failure('shell', { mode: 'execute', processRef: 'P999', command: 'pwd' });
  assert.match(unknownWithExecute.message, /mode=execute 用于执行新命令.*执行新命令时不要传 processRef/);
  assert.doesNotMatch(unknownWithExecute.message, /要读取或终止/, '未知 P# 不能被描述成可读取的进程');

  // 游标误用归为输出游标，不归为进程。
  const cursorMisuse = failure('bash', { command: 'pwd', foregroundWaitMs: 0, cursor });
  assert.equal(cursorMisuse.kind, 'cursor');
  assert.equal(cursorMisuse.argument, 'cursor');
  assert.match(cursorMisuse.message, /cursor 只用于 mode=output 的分页读取/);

  // mode=output 缺 processRef 时说明来源，不再提“目录授权”。
  const missingProcess = failure('bash', { mode: 'output' });
  assert.match(missingProcess.message, /mode=output 需要 processRef：请传之前 bash 结果或后台完成通知中给出的进程短引用（P#）/);
  assert.doesNotMatch(missingProcess.message, /目录授权/);

  // 内部键：点名错误字段和正确键，不回显内部值。
  for (const [toolName, args, canonicalKey, refKey, form] of [
    ['read', { attachmentId: 'internal-attachment' }, 'attachmentId', 'attachmentRef', '附件短引用（F#）'],
    ['bash', { mode: 'output', processId: 'internal-process' }, 'processId', 'processRef', '进程短引用（P#）'],
    ['shell', { mode: 'output', processRef, outputHandle: 'rk-process-output:cursor-one' }, 'outputHandle', 'cursor', '输出游标短引用（O#）'],
    ['run_agent', { operation: 'send', answerBridgeId: 'internal-child' }, 'answerBridgeId', 'childRef', '子 Agent 短引用（A#）'],
    ['run_agent', { operation: 'wait', answerBridgeIds: ['internal-child'] }, 'answerBridgeIds', 'childRefs', '由子 Agent 短引用（A#）组成的数组'],
    ['switch_work_environment', { workEnvironmentId: 'work-env-owned' }, 'workEnvironmentId', 'workEnvironmentRef', '工作环境短引用（W#）'],
    ['send_agent_message', { targetConversationId: 'internal-conversation', text: 'hi' }, 'targetConversationId', 'conversationRef', '对话短引用（C#）'],
    ['agent_board', { operation: 'post', notifyConversationIds: ['internal-conversation'] }, 'notifyConversationIds', 'notifyConversationRefs', '由对话短引用（C#）组成的数组']
  ]) {
    const error = failure(toolName, args);
    assert.equal(error.argument, canonicalKey);
    assert.equal(error.message, `${toolName} 不接受参数 ${canonicalKey}；请改用 ${refKey} 传入${form}。`);
  }

  // 短引用种类不对、当前上下文没有、或根本不是短引用，各自给出准确说明。
  assert.equal(failure('read', { attachmentRef: processRef }).message,
    `attachmentRef 收到的 ${processRef} 是进程引用；请使用上下文或工具结果中出现过的附件短引用（F#）。`);
  assert.equal(failure('read', { attachmentRef: 'F999' }).message,
    'attachmentRef=F999 不是当前可用的附件引用；请使用上下文或工具结果中出现过的附件短引用（F#）。');
  assert.equal(failure('run_agent', { operation: 'wait', childRefs: [ref('child'), 'A9'] }).argument, 'childRefs[1]');
  const history = buildModelHandleCatalog([], [{ kind: 'conversationMessage', ref: 'R1', target: 'history-message' }]);
  assert.match(failure('read_agent_messages', { messageRef: 'R1' }, history).message,
    /messageRef 收到的 R1 是对话历史消息引用.*请同时传 view=conversation/);

  // 被拒绝的内部 ID 既不回显，投影后也不会变成看似有效的短引用。
  for (const [toolName, args] of [
    ['read', { attachmentRef: 'internal-attachment' }],
    ['bash', { mode: 'output', processRef: 'internal-process' }],
    ['switch_work_environment', { workEnvironmentRef: 'work-env-owned' }]
  ]) {
    const error = failure(toolName, args);
    assert.match(error.message, /只接受上下文或工具结果中出现过的.*不接受内部 ID、名称或其它形式的值/);
    const projected = projectToolResultForModel(toolName, {
      status: 'failed', detail: { code: 'invalid_model_handle_reference', error: error.message }
    }, catalog);
    assert.equal(projected.detail.error, error.message);
    assert.doesNotMatch(projected.detail.error, /\b[FPOAWC][1-9]\d*\b/);
  }
});

const { transferFilesTool } = require(path.join(
  root,
  'dist/extension/backend/world/modules/tools/definitions/transferFiles/index.js'
));
const { createWorkEnvironmentRuntimeCapability } = require(path.join(
  root,
  'dist/extension/backend/capabilities/workEnvironmentTransfer.js'
));
const TRANSFER_ACCEPTED = '工具说明列出的工作环境短引用（W#），或表示当前工作环境的 current';

test('transfer 只接受工具说明列出的 W# 或 current，名称、active 与内部 ID 明确拒绝', () => {
  const toolName = transferFilesTool.declaration.name;
  assert.equal(toolName, 'transfer');
  const description = JSON.stringify(transferFilesTool.declaration);
  assert.match(description, /W# reference/);
  assert.doesNotMatch(description, /work environment id/i, '工具说明不能再要求模型传内部 ID');

  const transfers = [
    { fromEnvironment: ' current ', fromPath: 'a.txt', toEnvironment: ref('workEnvironment'), toPath: 'b.txt' }
  ];
  assert.deepEqual(resolveModelToolArguments(toolName, { transfers }, catalog), {
    transfers: [{ ...transfers[0], fromEnvironment: 'current', toEnvironment: 'work-env-owned' }]
  });
  const failure = (toEnvironment, extra = []) => {
    try {
      resolveModelToolArguments(toolName, { transfers: [{ ...transfers[0], toEnvironment }, ...extra] }, catalog);
    } catch (error) {
      assert.equal(error.code, 'UNKNOWN_MODEL_HANDLE_REFERENCE');
      assert.equal(error.kind, 'workEnvironment');
      return error;
    }
    assert.fail(`toEnvironment=${toEnvironment} 必须被拒绝`);
  };
  for (const value of ['work-env-owned', 'active', 'owned-server', 7]) {
    const error = failure(value);
    assert.equal(error.argument, 'transfers[0].toEnvironment');
    assert.equal(error.message,
      `transfers[0].toEnvironment 只接受${TRANSFER_ACCEPTED}；不接受内部 ID、名称或其它形式的值。`);
    const projected = projectToolResultForModel(toolName, {
      status: 'failed', detail: { code: 'invalid_model_handle_reference', error: error.message }
    }, catalog);
    assert.doesNotMatch(projected.detail.error, /\bW[1-9]\d*\b/, '被拒绝的内部 ID 不能投影成看似有效的 W#');
  }
  assert.equal(failure('W999').message,
    `transfers[0].toEnvironment=W999 不是当前可用的工作环境引用；请使用${TRANSFER_ACCEPTED}。`);
  assert.equal(failure(ref('process')).message,
    `transfers[0].toEnvironment 收到的 ${ref('process')} 是进程引用；请使用${TRANSFER_ACCEPTED}。`);
  assert.equal(failure(ref('workEnvironment'), [{ fromPath: 'c.txt', toEnvironment: 'current', toPath: 'd.txt' }]).message,
    `缺少 transfers[1].fromEnvironment；请提供${TRANSFER_ACCEPTED}。`);
});

test('transfer 经 AgentLoop 解析 W# 后由真实 capability 写入目标工作环境', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-transfer-ref-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const environment = async (id, name) => {
    const rootPath = path.join(base, name);
    await fs.mkdir(rootPath, { recursive: true });
    return {
      id, kind: 'localFolder', source: 'workspaceFolder', name, uri: `file://${rootPath}`, rootPath,
      displayPath: rootPath, index: 0, available: true, createdAt: 1, updatedAt: 1
    };
  };
  const source = await environment('work-env-local-transfer-source', 'source-folder');
  const target = await environment('work-env-local-transfer-target', 'target-folder');
  await fs.writeFile(path.join(source.rootPath, 'notes.txt'), 'transfer-by-short-ref');
  // Environment IDs reach the catalog through the transfer description, exactly as in production.
  const handles = buildModelHandleCatalog([`- ${source.id} · ${source.name}\n- ${target.id} · ${target.name}`]);
  const targetRef = handles.entries.find((entry) => entry.target === target.id).ref;
  assert.match(targetRef, /^W[1-9]\d*$/);

  const policy = {
    summary: null, displayAutoExpand: false, displayAutoOpenDiff: false, executionGate: 'immediate',
    changeApplyMode: 'unsupported', changeApplyDelaySeconds: 0, autoSubmitResult: true,
    schedulingMode: 'serial', schedulingReason: 'test'
  };
  const transferCall = (providerOrdinal, toEnvironment) => ({
    providerCallId: `provider-transfer-${providerOrdinal}`,
    providerOrdinal,
    name: transferFilesTool.declaration.name,
    arguments: {
      transfers: [{ fromEnvironment: 'current', fromPath: 'notes.txt', toEnvironment, toPath: `copied-${providerOrdinal}/notes.txt` }]
    }
  });
  let invalidSettlements;
  const executed = [];
  const loop = Object.create(ReliableAgentLoop.prototype);
  loop.database = { async snapshotAll() { return { snapshotCommitSeq: '0', snapshot: [] }; } };
  loop.effects = {
    async createToolCallBatch(input) {
      return {
        receiptId: 'receipt-transfer-ref', batchId: input.batchId,
        calls: input.entries.map((entry, index) => ({
          toolCallId: entry.toolCallId, toolExecutionId: `execution-transfer-ref-${index}`,
          callSeq: String(index + 1), providerOrdinal: entry.providerOrdinal
        })),
        deduplicated: false, commitSeq: '1'
      };
    },
    async settleWithoutEffectBatch(input) {
      invalidSettlements = input;
      return input.settlements.map((entry) => ({ toolCallId: entry.toolCallId, status: entry.status }));
    }
  };
  loop.tools = {
    async freezeCalls(inputs) { return inputs.map(() => policy); },
    async confirmPreparedBatch() { return Object.freeze({ fixture: 'transfer-ref-admission' }); },
    async dispatchBatch(inputs) {
      const results = [];
      for (const input of inputs) {
        const response = await transferFilesTool.execute(input.arguments, {
          workEnvironment: createWorkEnvironmentRuntimeCapability()
        }, { workEnvironment: source, workEnvironments: [source, target], config: {}, emit() {} });
        executed.push({ arguments: input.arguments, response });
        results.push({ disposition: 'settled', toolCallId: input.toolCallId, status: response.ok ? 'succeeded' : 'failed' });
      }
      return results;
    }
  };
  loop.lifecycleObserver = { observe() {} };
  loop.now = () => '2026-01-01T00:00:00.000Z';
  loop.readModelRequestToolDefinitions = async () => [
    { name: transferFilesTool.declaration.name, description: 'transfer', parameters: { type: 'object' } }
  ];

  const calls = await loop.prepareProviderToolBatch({
    turnId: 'turn-transfer-ref',
    modelRequestId: 'model-transfer-ref',
    messageId: 'message-transfer-ref',
    recipe: { tools: [], modelHandleCatalog: handles },
    output: {
      content: { role: 'model', parts: [] },
      toolCalls: [
        transferCall(0, targetRef),
        transferCall(1, 'active'),
        transferCall(2, target.id),
        transferCall(3, target.name)
      ]
    }
  });
  assert.equal(calls[0].argumentResolutionError, undefined);
  assert.equal(calls[0].arguments.transfers[0].toEnvironment, target.id);
  for (const call of calls.slice(1)) {
    assert.equal(call.argumentResolutionError,
      `transfers[0].toEnvironment 只接受${TRANSFER_ACCEPTED}；不接受内部 ID、名称或其它形式的值。`);
  }

  assert.equal(await loop.dispatchProviderToolGroup({
    turnId: 'turn-transfer-ref', round: '1', modelRequestId: 'model-transfer-ref', calls
  }), true);
  assert.equal(executed.length, 1, '只有解析成功的 W# 调用进入执行');
  assert.equal(executed[0].response.ok, true, JSON.stringify(executed[0].response.output));
  assert.equal(await fs.readFile(path.join(target.rootPath, 'copied-0', 'notes.txt'), 'utf8'), 'transfer-by-short-ref');
  assert.deepEqual(invalidSettlements.settlements.map((entry) => entry.detail.code),
    Array(3).fill('invalid_model_handle_reference'));

  // The capability itself matches only `current` and exact IDs; names and `active` are not selectors.
  const capability = createWorkEnvironmentRuntimeCapability();
  for (const selector of ['active', target.name]) {
    const result = await capability.transferFiles({
      transfers: [{ fromEnvironment: 'current', fromPath: 'notes.txt', toEnvironment: selector, toPath: 'by-selector.txt' }]
    }, undefined, { activeWorkEnvironment: source, availableWorkEnvironments: [source, target] });
    assert.equal(result.failCount, 1, selector);
    assert.match(result.results[0].error, /未知或当前策略不允许使用工作环境/);
  }
  await assert.rejects(fs.access(path.join(target.rootPath, 'by-selector.txt')));
});

test('未知短引用的内核失败保留 P999/C999，已知 canonical ID 仍脱敏', () => {
  // 目录目标 "999" 与未知短引用重叠，不能把 P999/C999 改写成似乎有权的 PC1/CC1。
  const overlapping = buildModelHandleCatalog([{ processId: 'internal-process' }],
    [{ kind: 'conversation', ref: 'C1', target: '999' }]);
  for (const [tool, args, unknown] of [
    ['bash', { mode: 'output', processRef: 'P999' }, 'P999'],
    ['send_agent_message', { conversationRef: 'C999' }, 'C999']
  ]) {
    let error;
    try {
      resolveModelToolArguments(tool, args, overlapping);
      assert.fail('未知短引用必须在内核解析时被拒绝');
    } catch (caught) {
      assert.equal(caught.code, 'UNKNOWN_MODEL_HANDLE_REFERENCE');
      error = caught.message;
    }
    assert.match(error, new RegExp(unknown));
    assert.deepEqual(projectToolResultForModel(tool, {
      status: 'failed', detail: { code: 'invalid_model_handle_reference', error }
    }, overlapping), {
      status: 'failed', detail: { code: 'invalid_model_handle_reference', error }
    });
  }
  assert.deepEqual(projectToolResultForModel('bash', {
    status: 'failed', detail: {
      code: 'invalid_model_handle_reference', error: '未知引用：P999；诊断 internal-process；目标 999'
    }
  }, overlapping), {
    status: 'failed', detail: {
      code: 'invalid_model_handle_reference', error: '未知引用：P999；诊断 P1；目标 C1'
    }
  }, '错误不能因为自报 code 就保留其它 canonical ID');
});

test('MCP 工具伪造引用失败 code 时不能绕过深层结果 ID 脱敏', () => {
  const result = projectToolResultForModel('example_mcp_tool', {
    status: 'succeeded',
    detail: {
      result: {
        structuredContent: {
          code: 'invalid_model_handle_reference',
          error: 'internal-process',
          nested: [{ code: 'invalid_model_handle_reference', error: 'internal-process' }]
        }
      }
    }
  }, buildModelHandleCatalog([{ processId: 'internal-process' }]));
  assert.deepEqual(result, {
    status: 'succeeded',
    detail: {
      result: {
        structuredContent: {
          code: 'invalid_model_handle_reference',
          error: 'P1',
          nested: [{ code: 'invalid_model_handle_reference', error: 'P1' }]
        }
      }
    }
  });
  assert.doesNotMatch(JSON.stringify(result), /internal-process/);
  assert.deepEqual(projectToolResultForModel('example_mcp_tool', {
    status: 'failed', detail: { code: 'invalid_model_handle_reference', error: 'internal-process' }
  }, buildModelHandleCatalog([{ processId: 'internal-process' }])), {
    status: 'failed', detail: { code: 'invalid_model_handle_reference', error: 'P1' }
  }, '失败外壳也不能由第三方结果自报 code 获得豁免');
  assert.deepEqual(projectToolResultForModel('example_mcp_tool', {
    status: 'succeeded', detail: { message: 'work-env-P999；未知引用 P999' }
  }, buildModelHandleCatalog([{ workEnvironmentId: 'work-env-P999' }])), {
    status: 'succeeded', detail: { message: 'W1；未知引用 P999' }
  }, '完整 canonical ID 可包含短引用外形，不得被词元保护误跳过');
});

for (const name of ['bash', 'shell']) {
  test(`${name} execute 必填 foregroundWaitMs，错误不执行命令；边界值仍可用`, async () => {
    const runs = [];
    const command = {
      toolName: name, description: 'Test command',
      async run(input) { runs.push(input); return { status: 'completed', exitCode: 0 }; }
    };
    const tool = createCommandTool(command);
    const properties = tool.declaration.parameters.properties;
    assert.match(properties.foregroundWaitMs.description, /Required for mode=execute/);
    assert.equal(properties.foregroundWaitMs.type, 'integer');
    const args = { command: 'pwd', explanation: 'Inspect working directory' };
    for (const invalid of [undefined, null, -1, 60_001, 0.5, '0']) {
      const response = await tool.execute({ ...args, foregroundWaitMs: invalid }, { command });
      assert.equal(response.ok, false);
      assert.match(response.output, /foregroundWaitMs/);
    }
    assert.equal(runs.length, 0);
    for (const wait of [0, 60_000]) {
      const response = await tool.execute({ ...args, foregroundWaitMs: wait }, { command });
      assert.equal(response.ok, true);
    }
    assert.deepEqual(runs.map(input => input.foregroundWaitMs), [0, 60_000]);
  });

  test(`${name} output/kill 缺失、类型错误或额外游标返回一致可诊断错误，合法 ID 可用`, async () => {
    const reads = [], kills = [];
    const command = {
      toolName: name, description: 'Test command',
      readOutput(processId) { reads.push(processId); return { processId, stdout: 'ready' }; },
      kill(processId) { kills.push(processId); return { processId, status: 'killed' }; }
    };
    const tool = createCommandTool(command);
    for (const mode of ['output', 'kill']) {
      for (const bad of [undefined, '', '   ', 3, {}, null]) {
        const response = await tool.execute({ mode, processId: bad }, { command });
        assert.equal(response.ok, false, `${mode} 必须拒绝 ${String(bad)}`);
        assert.match(response.output, /processId/);
        assert.match(response.output, new RegExp(`mode=${mode}`));
      }
      const valid = await tool.execute({ mode, processId: ' internal-process ' }, { command });
      assert.equal(valid.ok, true);
    }
    assert.deepEqual(reads, ['internal-process']);
    assert.deepEqual(kills, ['internal-process']);
    const killCursor = await tool.execute({ mode: 'kill', processId: 'internal-process', outputHandle: 'opaque' }, { command });
    assert.equal(killCursor.ok, false);
    assert.match(killCursor.output, /outputHandle/);
    assert.deepEqual(kills, ['internal-process'], 'kill 不应静默丢弃额外的输出游标');
  });
}
