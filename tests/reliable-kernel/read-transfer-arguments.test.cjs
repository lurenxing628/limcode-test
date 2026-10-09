const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const compiled = (...parts) => path.join(process.cwd(), 'dist/extension', ...parts);
const { readFileTool, validateReadFileToolArguments, compactReadFileToolArguments } = require(compiled('backend/world/modules/tools/definitions/readFile/index.js'));
const { validateWorkEnvironmentTransferArguments, WorkEnvironmentTransferEffectDispatcher } = require(compiled('backend/reliableKernel/workEnvironmentTransferEffects.js'));

function readHarness() {
  const calls = [];
  return {
    calls,
    deps: {
      fs: {
        async readFile(file, startLine, endLine) {
          calls.push({ kind: 'text', file, startLine, endLine });
          return { path: file, startLine: startLine ?? 1, endLine: endLine ?? 2, totalLines: 2, content: 'a\nb' };
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
      },
      command: {}, workEnvironment: {}, skills: {}
    }
  };
}

test('read keeps original arguments and accepts placeholders and harmless hints in the execution copy', async () => {
  const raw = { path: 'a.txt', attachmentId: null, items: [{ note: 'unused hint' }], mode: '', startLine: null, endLine: [], pages: {}, note: 'read carefully' };
  const original = structuredClone(raw);
  assert.deepEqual(validateReadFileToolArguments(raw), { source: 'path', path: 'a.txt', mode: 'text' });
  assert.deepEqual(raw, original);
  const harness = readHarness();
  assert.equal((await readFileTool.execute(raw, harness.deps)).ok, true);
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(raw, original);
  assert.deepEqual(compactReadFileToolArguments({ path: 'a.txt', startLine: '400', extra: true }), { path: 'a.txt', startLine: '400', extra: true });
});

test('read rejects missing targets and invalid selected text ranges before any IO', async () => {
  const invalid = [
    {},
    { path: '', attachmentRef: null, items: [] },
    { items: [{ path: '', startLine: 1, endLine: 1 }, { path: '', startLine: 1, endLine: 1 }] },
    { path: 'a.txt', startLine: 0 },
    { path: 'a.txt', startLine: false },
    { path: 'a.txt', startLine: '400' },
    { path: 'a.txt', startLine: 1.5 },
    { path: 'a.txt', startLine: 3, endLine: 2 },
    { path: 'a.txt', mode: 'typo' },
    { path: 42, attachmentId: 'attachment-one' },
    { attachmentId: 'attachment-one', pages: '1-5' },
    { items: [{ path: 'a.txt' }, { path: 'b.txt', endLine: 0 }] }
  ];
  for (const raw of invalid) {
    const harness = readHarness();
    const result = await readFileTool.execute(raw, harness.deps);
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(harness.calls.length, 0, JSON.stringify(raw));
  }
});

test('read uses the top-level path for the observed mixed single-file and batch calls', async () => {
  const fixtures = [
    { path: 'tests/reliable-kernel/inline-attachment-display.test.mjs', startLine: 1, endLine: 260, mode: 'text',
      items: [{ path: '', startLine: 1, endLine: 1 }, { path: '', startLine: 1, endLine: 1 }] },
    { path: 'webview/src/components/sidebar/SidebarApp.vue', startLine: 120, endLine: 180, mode: 'text',
      items: [{ path: 'webview/src/components/sidebar/SidebarApp.vue', startLine: 120, endLine: 180 },
        { path: 'webview/src/components/sidebar/SidebarApp.vue', startLine: 1, endLine: 80 }] },
    { path: 'a.txt', items: [{ path: 'x.txt', startLine: 1 }, { path: 'y.txt', startLine: 1 }] }
  ];
  for (const raw of fixtures) {
    const original = structuredClone(raw);
    const harness = readHarness();
    const validated = validateReadFileToolArguments(raw);
    assert.equal(validated.source, 'path');
    assert.deepEqual(validated.ignoredFields, ['items']);
    assert.equal(validated.warning, '已选择 path；未使用参数：items。');
    const result = await readFileTool.execute(raw, harness.deps);
    assert.equal(result.ok, true);
    assert.deepEqual(harness.calls, [{ kind: 'text', file: raw.path, startLine: raw.startLine, endLine: raw.endLine }]);
    assert.deepEqual(result.output.ignoredFields, ['items']);
    assert.equal(result.output.warning, '已选择 path；未使用参数：items。');
    assert.equal(result.output.files, undefined);
    assert.deepEqual(raw, original);
  }
});

test('read reports lower-priority targets and fields without reading or validating them', async () => {
  const raw = { path: 'a.txt', attachmentId: 'attachment-one', items: [{ path: 'ignored.png', startLine: 0 }], pages: 'invalid' };
  const harness = readHarness();
  const result = await readFileTool.execute(raw, harness.deps);
  assert.equal(result.ok, true);
  assert.deepEqual(harness.calls, [{ kind: 'text', file: 'a.txt', startLine: undefined, endLine: undefined }]);
  assert.deepEqual(result.output.ignoredFields, ['attachmentRef', 'items', 'pages']);
  assert.equal(result.output.warning, '已选择 path；未使用参数：attachmentRef、items、pages。');

  const managed = readHarness();
  const attachment = await readFileTool.execute({ attachmentId: 'attachment-one', mode: 'typo', startLine: false, endLine: 0,
    items: [{ path: 'ignored.pdf' }] }, managed.deps);
  assert.equal(attachment.ok, true);
  assert.deepEqual(managed.calls, [{ kind: 'attachment', id: 'attachment-one' }]);
  assert.deepEqual(attachment.output.ignoredFields, ['items', 'mode', 'startLine', 'endLine']);
});

test('items-only reads permit one item and do not move root ranges or modes into its text read', async () => {
  const harness = readHarness();
  const raw = { items: [{ path: 'one.txt', startLine: 2, endLine: 5 }], mode: 'attachment', startLine: 200, endLine: 400, pages: 'invalid' };
  const original = structuredClone(raw);
  const result = await readFileTool.execute(raw, harness.deps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.output.files.map(file => file.path), ['one.txt']);
  assert.deepEqual(harness.calls, [{ kind: 'text', file: 'one.txt', startLine: 2, endLine: 5 }]);
  assert.deepEqual(result.output.ignoredFields, ['mode', 'pages', 'startLine', 'endLine']);
  assert.equal(result.output.warning, '已选择 items；未使用参数：mode、pages、startLine、endLine。');
  assert.deepEqual(raw, original);
});

test('read batch checks every media path before reading any member', async () => {
  for (const media of ['image.PNG', 'document.pdf', 'photo.jpeg', 'asset.webp']) {
    const harness = readHarness();
    const result = await readFileTool.execute({ items: [{ path: 'a.txt' }, { path: media }] }, harness.deps);
    assert.equal(result.ok, false);
    assert.match(result.output, /Cannot read.*UTF-8 text/);
    assert.equal(harness.calls.length, 0);
  }
  const harness = readHarness();
  const result = await readFileTool.execute({ items: [{ path: 'a.txt', startLine: 2 }, { path: 'b.txt', note: 'harmless' }], mode: null }, harness.deps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.output.files.map(file => file.path), ['a.txt', 'b.txt']);
  assert.equal(harness.calls[0].startLine, 2);
});

test('read preserves path mode inference and managed attachment targets', async () => {
  const media = readHarness();
  assert.equal((await readFileTool.execute({ path: 'image.png', mode: null, items: [{}] }, media.deps)).ok, true);
  assert.deepEqual(media.calls.map(call => call.kind), ['binary']);
  const image = readHarness();
  const imageResult = await readFileTool.execute({ path: 'image.png', startLine: 1 }, image.deps);
  assert.equal(imageResult.ok, true);
  assert.deepEqual(image.calls.map(call => call.kind), ['binary']);
  assert.deepEqual(imageResult.output.ignoredFields, ['startLine']);
  assert.deepEqual(validateReadFileToolArguments({ attachmentRef: 'F1', path: '', items: [], note: 'attachment' }), { source: 'attachment', attachmentRef: 'F1' });
  const managed = readHarness();
  assert.equal((await readFileTool.execute({ attachmentId: 'attachment-one', path: null, mode: 'attachment', startLine: null }, managed.deps)).ok, true);
  assert.deepEqual(managed.calls, [{ kind: 'attachment', id: 'attachment-one' }]);
});

const transferItem = overrides => ({ fromEnvironment: 'current', fromPath: 'a.txt', toEnvironment: 'current', toPath: 'b.txt', ...overrides });

test('transfer defaults empty optional fields, retains false, and ignores harmless extra fields', () => {
  const raw = { transfers: [transferItem({ type: null, overwrite: false, createDirs: false, note: 'copy once' })], verify: null, note: 'safe hint' };
  const original = structuredClone(raw);
  assert.deepEqual(validateWorkEnvironmentTransferArguments(raw), {
    transfers: [transferItem({ type: 'auto', overwrite: false, createDirs: false })], verify: 'size'
  });
  assert.deepEqual(raw, original);
  assert.equal(validateWorkEnvironmentTransferArguments({ transfers: [transferItem({ type: '', overwrite: null, createDirs: null })], verify: '' }).transfers[0].createDirs, true);
});

test('transfer accepts equivalent copy labels and whitespace placeholders without changing copy semantics', () => {
  const raw = { transfers: [transferItem({ mode: ' copy ', operation: ' ', move: ' ', deleteSource: false,
    removeSource: null, overwrite: false })], operation: ' copy ', mode: ' ', move: ' ', deleteSource: false };
  const original = structuredClone(raw);
  assert.deepEqual(validateWorkEnvironmentTransferArguments(raw), {
    transfers: [transferItem({ type: 'auto', overwrite: false, createDirs: true })], verify: 'size'
  });
  assert.deepEqual(raw, original);
  for (const key of ['move', 'deleteSource', 'removeSource']) {
    assert.throws(() => validateWorkEnvironmentTransferArguments({ transfers: [transferItem()], [key]: true }), { name: 'ToolArgumentError' });
  }
});

test('transfer rejects meaningful malformed options and incompatible move intent', () => {
  for (const raw of [
    { transfers: [transferItem({ type: 'fi1e' })] },
    { transfers: [transferItem({ overwrite: 0 })] },
    { transfers: [transferItem({ createDirs: 'false' })] },
    { transfers: [transferItem({ fromPath: null })] },
    { transfers: [transferItem(), {}] },
    { transfers: [transferItem()], verify: 'sha256' },
    { transfers: [transferItem()], verify: false },
    { transfers: [transferItem({ deleteSource: true })] },
    { transfers: [transferItem()], operation: 'move' }
  ]) assert.throws(() => validateWorkEnvironmentTransferArguments(raw), { name: 'ToolArgumentError' });
});

test('transfer validates new preparation before creating an effect and replays committed preparation', async () => {
  let prepared = 0;
  let request;
  const effects = { async prepareEffectIntent(input) { prepared += 1; request = input.request; return { effectIntentId: 'effect' }; } };
  const source = { kind: 'internal', key: 'transfer-prepare-test' };
  const input = { source, toolCallId: 'call', authoritySnapshotId: 'authority', arguments: { transfers: [transferItem({ type: 'bad' })] } };
  const fresh = new WorkEnvironmentTransferEffectDispatcher({ async snapshot() { return { snapshot: [[]] }; } }, effects);
  await assert.rejects(fresh.prepare(input), { name: 'ToolArgumentError' });
  assert.equal(prepared, 0);
  await fresh.prepare({ ...input, arguments: { transfers: [transferItem({ createDirs: false })], verify: null } });
  assert.equal(prepared, 1);
  assert.equal(request.arguments.transfers[0].createDirs, false);
  assert.equal(request.arguments.verify, 'size');
  const replay = new WorkEnvironmentTransferEffectDispatcher({ async snapshot() { return { snapshot: [[{ id: 'committed-receipt' }]] }; } }, effects);
  await replay.prepare(input);
  assert.equal(prepared, 2);
  assert.deepEqual(request.arguments, input.arguments);
});
