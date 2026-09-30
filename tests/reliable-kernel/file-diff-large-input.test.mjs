import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { buildFileDiffRecord, buildFileReplacementHunks, countDiffStats } = require(path.join(
  process.cwd(), 'dist/extension/backend/capabilities/fileDiff.js'
));

function applyHunks(before, hunks) {
  for (const hunk of hunks) {
    const index = before.indexOf(hunk.oldContent);
    assert.notEqual(index, -1, 'every replacement matches its original context');
    before = before.slice(0, index) + hunk.newContent + before.slice(index + hunk.oldContent.length);
  }
  return before;
}

// Operation counts and patch reconstruction are deterministic; avoid machine-speed assertions.
test('70k fully replaced lines do not exceed the engine argument limit and retain full stats', () => {
  const before = Array.from({ length: 70_000 }, (_, i) => `old${i}`).join('\n');
  const after = Array.from({ length: 70_000 }, (_, i) => `new${i}`).join('\n');
  const record = buildFileDiffRecord('generated.txt', before, after, true);
  assert.equal(record.added, 70_000);
  assert.equal(record.removed, 70_000);
  assert.equal(record.truncated, true);
  assert.match(record.text, /@@ -1,70000 \+1,70000 @@/);
  assert.ok(record.text.length < 121_000);
  assert.equal(applyHunks(before, buildFileReplacementHunks(before, after)), after);
});

test('large repeated-line files preserve precise sparse replacement hunks', () => {
  const lines = Array.from({ length: 10_000 }, (_, i) => i % 50 === 0 ? `anchor ${i}` : 'repeated');
  const updated = [...lines];
  updated[2_000] = 'changed first anchor';
  updated[7_000] = 'changed second anchor';
  const before = lines.join('\n');
  const after = updated.join('\n');
  const record = buildFileDiffRecord('repeat.txt', before, after, true);
  assert.equal(record.added, 2);
  assert.equal(record.removed, 2);
  const hunks = buildFileReplacementHunks(before, after);
  assert.equal(hunks.length, 2);
  assert.equal(applyHunks(before, hunks), after);
});

test('literal header-like lines count as edited content, including Unicode', () => {
  const record = buildFileDiffRecord('目录/😀.txt', '--旧\ncontext\n', '++新😀\ncontext\n', true);
  assert.deepEqual({ added: record.added, removed: record.removed }, { added: 1, removed: 1 });
  assert.deepEqual(countDiffStats(record.text), { added: 1, removed: 1 });
  assert.equal(record.truncated, false);
});

test('create, delete, unchanged and CRLF preserve unified hunk coordinates', () => {
  const created = buildFileDiffRecord('new.txt', '', 'one\ntwo\n', false);
  assert.match(created.text, /^--- \/dev\/null\n\+\+\+ b\/new.txt\n@@ -0,0 \+1,2 @@/);
  assert.deepEqual({ added: created.added, removed: created.removed }, { added: 2, removed: 0 });
  const deleted = buildFileDiffRecord('old.txt', 'one\ntwo\n', '', true);
  assert.match(deleted.text, /@@ -1,2 \+0,0 @@/);
  assert.deepEqual({ added: deleted.added, removed: deleted.removed }, { added: 0, removed: 2 });
  assert.equal(buildFileDiffRecord('same.txt', 'same\n', 'same\n', true), undefined);
  assert.equal(buildFileDiffRecord('crlf.txt', 'one\r\ntwo\r\n', 'one\ntwo\n', true), undefined);
});

test('high-edit-distance fallback remains an exact executable replacement', () => {
  const before = Array.from({ length: 2_000 }, (_, i) => i % 2 ? 'shared' : `old${i}`).join('\n');
  const after = Array.from({ length: 2_000 }, (_, i) => i % 2 ? 'shared' : `new${i}`).join('\n');
  const hunks = buildFileReplacementHunks(before, after);
  assert.equal(applyHunks(before, hunks), after);
});
