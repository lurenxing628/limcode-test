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
    { name: 'submit_agent_answer', description: 'submit', parameters: { type: 'object' } },
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
          name: 'submit_agent_answer',
          arguments: { childRef: canonicalBridgeId, title: '完成', content: '正文' }
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

  assert.match(calls[0].argumentResolutionError, /未知子 Agent引用/);
  assert.equal(calls[1].argumentResolutionError, undefined);
  assert.deepEqual(createdBatch.entries[0].arguments, {
    childRef: canonicalBridgeId,
    title: '完成',
    content: '正文'
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
