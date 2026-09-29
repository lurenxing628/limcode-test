import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const kernel = await import(pathToFileURL(path.join(root, 'dist/extension/backend/reliableKernel/index.js')).href);

const attachmentId = 'attachment_2735bc846f82044819897ac3532e4bb8c027d918915bcfc0b066d1517de6a51d';
const processId = 'process_efaa5e81e57c18501a6806f90240e6cc5e1b508c75b79c8e1c4e831211021adf';
const cursor = 'rk-process-output:eyJwcm9jZXNzSWQiOiJwcm9jZXNzX2VmYWEifQ';
const answerBridgeId = 'answer_bridge_f33936856ac6208c8e65e63814a83d021aa1dad5d9bf654840cab9fbeed5fe0d';
const workEnvironmentId = 'work-env-local-0po7d9w';

function catalog() {
  return kernel.buildModelHandleCatalog([{
    attachmentId,
    name: 'image.png',
    mimeType: 'image/png',
    sizeBytes: 87_984,
    processId,
    nextOutputHandle: cursor,
    answerBridgeId,
    workEnvironmentId
  }]);
}

test('ModelRequest 短引用按类型编号并可还原现有工具参数', () => {
  const handles = catalog();
  assert.deepEqual(handles.entries.map(({ kind, ref }) => ({ kind, ref })), [
    { kind: 'attachment', ref: 'F1' },
    { kind: 'process', ref: 'P1' },
    { kind: 'child', ref: 'A1' },
    { kind: 'workEnvironment', ref: 'W1' },
    { kind: 'cursor', ref: 'O1' }
  ]);

  assert.deepEqual(kernel.resolveModelToolArguments('read', {
    attachmentRef: 'F1', startLine: 1, endLine: 1
  }, handles), {
    attachmentId, startLine: 1, endLine: 1
  });
  assert.deepEqual(kernel.resolveModelToolArguments('bash', {
    mode: 'output', processRef: 'P1', cursor: 'O1'
  }, handles), {
    mode: 'output', processId, outputHandle: cursor
  });
  assert.deepEqual(kernel.resolveModelToolArguments('read_agent_answer', {
    childRef: 'A1'
  }, handles), { answerBridgeId });
  assert.deepEqual(kernel.resolveModelToolArguments('switch_work_environment', {
    workEnvironmentRef: 'W1'
  }, handles), { workEnvironmentId });
  assert.deepEqual(kernel.resolveModelToolArguments('transfer', {
    transfers: [{ fromEnvironment: 'W1', fromPath: 'a', toEnvironment: 'current', toPath: 'b' }]
  }, handles), {
    transfers: [{ fromEnvironment: workEnvironmentId, fromPath: 'a', toEnvironment: 'current', toPath: 'b' }]
  });
  assert.throws(
    () => kernel.resolveModelToolArguments('read', { attachmentRef: 'F2' }, handles),
    (error) => error.code === 'UNKNOWN_MODEL_HANDLE_REFERENCE' && error.kind === 'attachment' && error.argument === 'attachmentRef'
  );
});

test('模型工具结果仅保留可操作短引用并移除内部流水 ID', () => {
  const handles = catalog();
  const projected = kernel.projectToolResultForModel('bash', {
    toolCallId: 'rk_tool_call_internal',
    status: 'succeeded',
    detail: {
      status: 'running',
      processId,
      processReceiptId: 'process_receipt_internal',
      originToolCallId: 'rk_tool_call_origin_internal',
      conversationId: 'conversation_internal',
      sourceTurnId: 'turn_internal',
      nextOutputHandle: cursor,
      hasMore: true,
      message: `continue ${processId}`
    }
  }, handles);

  assert.deepEqual(projected, {
    status: 'succeeded',
    detail: {
      status: 'running',
      processRef: 'P1',
      nextCursor: 'O1',
      hasMore: true,
      message: 'continue P1'
    }
  });
  const encoded = JSON.stringify(projected);
  assert.doesNotMatch(encoded, /rk_tool_call_internal|rk_tool_call_origin_internal|process_efaa|process_receipt_internal|conversation_internal|turn_internal|rk-process-output/);
});
