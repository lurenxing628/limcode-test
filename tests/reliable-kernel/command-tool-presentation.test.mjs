import assert from 'node:assert/strict';
import test from 'node:test';
import { EffectControlPlane } from '../../dist/extension/backend/reliableKernel/effectControlPlane.js';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

async function terminalDetail(toolName, args, detail) {
  const plane = Object.create(EffectControlPlane.prototype);
  plane.requireContentObject = async (id) => {
    assert.equal(id, 'frozen-arguments');
    return { id };
  };
  plane.contentStore = {
    async read(metadata) {
      assert.equal(metadata.id, 'frozen-arguments');
      return Buffer.from(JSON.stringify(args));
    }
  };
  return plane.toolTerminalDetail({ tool_name: toolName, arguments_object_id: 'frozen-arguments' }, detail);
}

for (const toolName of ['bash', 'shell']) {
  test(`${toolName} terminal presentation reports ignored execution fields without changing the observed result`, async () => {
    const args = {
      mode: 'output', processId: 'existing-process', command: 'unused command', cwd: 'unused-folder',
      foregroundWaitMs: 0, executionTimeoutMs: 1000, maxOutputBytes: 1024, readonly: false
    };
    const original = structuredClone(args);
    const detail = { ok: true, output: { stdout: 'ready', status: 'running' }, existingFact: 'preserved' };
    const result = await terminalDetail(toolName, args, detail);
    assert.equal(result.mode, 'output');
    assert.deepEqual(result.ignoredFields, ['command', 'cwd', 'foregroundWaitMs', 'executionTimeoutMs', 'maxOutputBytes', 'readonly']);
    assert.match(result.warning, /mode=output.*foregroundWaitMs.*readonly/);
    assert.equal(result.output, detail.output);
    assert.equal(result.existingFact, 'preserved');
    assert.deepEqual(args, original);
    assert.equal(detail.mode, undefined);
  });
}

test('command metadata does not impose new execution validation on existing outcomes', async () => {
  const detail = { error: 'original failure' };
  assert.equal(await terminalDetail('bash', { mode: 'unsupported', command: 'ignored' }, detail), detail);
  assert.equal(await terminalDetail('bash', { mode: 'output', command: 'ignored' }, detail).then(result => result.mode), 'output');
  assert.equal(await terminalDetail('bash', { command: '' }, detail).then(result => result.inferredMode), true);
  assert.equal(await terminalDetail('read', {}, detail), detail);
  assert.equal(await terminalDetail('bash', {}, 'plain result'), 'plain result');
});

test('command input and all result envelopes keep ignored fields and warning visible', async (t) => {
  const server = await createWebviewSsrServer();
  t.after(() => server.close());
  const { parseShellArgs, parseShellResultOutput, shellInputSections, shellOutputSections } =
    await server.ssrLoadModule('/src/components/content/toolDisplay/shellToolModel.ts');
  const args = { mode: 'output', processRef: 'P1', command: 'unused command', foregroundWaitMs: 0 };
  const detail = await terminalDetail('bash', args, { ok: true, output: { stdout: 'ready', status: 'running' } });
  const base = { toolName: 'bash', args, events: [], stringifyValue: JSON.stringify };
  const input = shellInputSections(parseShellArgs(args), base);
  const inputOperation = input.find(section => section.title === '操作');
  assert.equal(inputOperation.rows.find(row => row.label === '模式').value, 'output');
  assert.equal(inputOperation.rows.find(row => row.label === '未使用参数').value, 'command、foregroundWaitMs');
  assert.equal(input.find(section => section.title === '未使用的命令').text, 'unused command');

  const flatOutput = { ...detail.output, mode: detail.mode, ignoredFields: detail.ignoredFields, warning: detail.warning };
  for (const result of [detail, { detail }, { status: 'succeeded', detail }, flatOutput]) {
    const parsed = parseShellResultOutput(result);
    assert.equal(parsed.stdout, 'ready');
    assert.deepEqual(parsed.ignoredFields, ['command', 'foregroundWaitMs']);
    assert.equal(parsed.warning, detail.warning);
    const output = shellOutputSections({ ...base, result });
    assert.equal(output.find(section => section.title === '标准输出').text, 'ready');
    const operation = output.find(section => section.title === '操作说明');
    assert.equal(operation.rows.find(row => row.label === '未使用参数').value, 'command、foregroundWaitMs');
    assert.equal(operation.rows.find(row => row.label === '说明').value, detail.warning);
  }
  const failed = shellOutputSections({ ...base, result: { detail: { error: 'Missing explanation', mode: 'execute' } } });
  assert.match(failed.find(section => section.title === '输出').text, /Missing explanation/);
  assert.deepEqual(shellOutputSections(base), []);
});
