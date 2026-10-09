const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const compiled = (...parts) => path.join(process.cwd(), 'dist/extension', ...parts);
const { validateWriteToolArguments, validateDeleteToolArguments } = require(compiled('shared/fileToolArguments.js'));
const { LocalFileToolPlanner, resolvePathInsideBoundary } = require(compiled('backend/reliableKernel/localFileToolPlanner.js'));
const { writeTool } = require(compiled('backend/world/modules/tools/definitions/write/index.js'));
const { deleteTool } = require(compiled('backend/world/modules/tools/definitions/delete/index.js'));

test('single-operation file tools accept harmless hints and empty optional scaffolding without altering inputs', () => {
  const write = { path: ' a.txt ', content: '', append: false, dryRun: null, overwrite: true, mode: {}, note: 'clear intentionally', extra: 0 };
  const originalWrite = structuredClone(write);
  assert.deepEqual(validateWriteToolArguments(write), { path: 'a.txt', content: '' });
  assert.deepEqual(write, originalWrite);
  const remove = { paths: [' a.txt ', 'b.txt'], recursive: true, dryRun: false, mode: null, note: 'temporary files', extra: false };
  const originalDelete = structuredClone(remove);
  assert.deepEqual(validateDeleteToolArguments(remove), { paths: ['a.txt', 'b.txt'] });
  assert.deepEqual(remove, originalDelete);
});

const invalidWrite = [
  { path: 'a.txt', content: 'x', append: true },
  { path: 'a.txt', content: 'x', dryRun: true },
  { path: 'a.txt', content: 'x', overwrite: false },
  { path: 'a.txt', content: 'x', append: 0 },
  { path: 'a.txt', content: 'x', overwrite: 0 },
  { path: 'a.txt', content: 'x', dryRun: 'false' },
  { path: 'a.txt', content: 'x', mode: 'append' },
  { path: 'a.txt', content: null },
  { path: '', content: 'x' }
];
const invalidDelete = [
  { paths: ['a.txt'], dryRun: true },
  { paths: ['a.txt'], recursive: false },
  { paths: ['a.txt'], recursive: 0 },
  { paths: ['a.txt'], dryRun: 'false' },
  { paths: ['a.txt'], operation: 'move' },
  { paths: ['a.txt', null] },
  { paths: [] },
  { paths: 'a.txt' }
];

test('file planner rejects unsupported intent and validates the entire deletion batch before any path IO', async () => {
  let resolverCalls = 0;
  const planner = new LocalFileToolPlanner(() => { resolverCalls += 1; throw new Error('path resolver must not run'); });
  for (const [name, values] of [['write', invalidWrite], ['delete', invalidDelete]]) {
    for (const args of values) {
      await assert.rejects(planner.plan({ declaration: { name } }, { arguments: args }, {}), { name: 'ToolArgumentError' });
      assert.equal(resolverCalls, 0, JSON.stringify(args));
    }
  }
});

test('legacy definitions use the same file validators before invoking capabilities', async () => {
  let capabilityCalls = 0;
  const deps = { fs: {
    async proposeWriteFile() { capabilityCalls += 1; return { success: true }; },
    async deletePath(file) { capabilityCalls += 1; return { path: file }; }
  } };
  for (const args of invalidWrite) assert.equal((await writeTool.execute(args, deps)).ok, false);
  for (const args of invalidDelete) assert.equal((await deleteTool.execute(args, deps)).ok, false);
  assert.equal(capabilityCalls, 0);
  assert.equal((await writeTool.execute({ path: 'a.txt', content: '', note: 'empty is intentional' }, deps)).ok, true);
  assert.equal((await deleteTool.execute({ paths: ['a.txt'], recursive: true, note: 'harmless' }, deps)).ok, true);
  assert.equal(capabilityCalls, 2);
});

test('valid empty writes and recursive deletes produce reviewable proposals without changing files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-file-arguments-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'original');
  await fs.mkdir(path.join(root, 'folder'));
  await fs.writeFile(path.join(root, 'folder', 'child.txt'), 'retained');
  const planner = new LocalFileToolPlanner(input => resolvePathInsideBoundary('workspace', root, input));
  const [write] = await planner.plan({ declaration: { name: 'write' } }, { arguments: { path: 'a.txt', content: '', append: false, extra: true } }, {});
  assert.equal(write.operation, 'replace_file');
  assert.equal(write.targetContent, '');
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'original');
  const [remove] = await planner.plan({ declaration: { name: 'delete' } }, { arguments: { paths: ['folder'], recursive: true, dryRun: false, extra: true } }, {});
  assert.equal(remove.operation, 'delete_directory_tree');
  assert.equal(await fs.readFile(path.join(root, 'folder', 'child.txt'), 'utf8'), 'retained');
});
