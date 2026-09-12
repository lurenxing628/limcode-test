import assert from 'node:assert/strict';
import test from 'node:test';
import { READ_SLICE_MAX_BYTES, sliceTextFile } from '../../dist/extension/backend/capabilities/textFileSlice.js';

/** Roughly the 444 KB HTML that used to be unreadable: far past the budget, so it must come back sliced. */
function oversizedFile(lineCount = 12_000) {
  return Array.from({ length: lineCount }, (_, i) => `<div class="row-${i + 1}">状态栏美化的第 ${i + 1} 行</div>`).join('\n');
}

test('超出预算的文件返回首段切片而不是失败，并报出总行数供续读', () => {
  const content = oversizedFile();
  const result = sliceTextFile('007_状态栏美化.html', content, undefined, undefined);

  assert.equal(result.totalLines, 12_000);
  assert.equal(result.startLine, 1);
  assert.ok(result.endLine < result.totalLines, '整个文件不应一次返回');
  assert.ok(result.lines.length > 0);
  assert.ok(Buffer.byteLength(result.content, 'utf8') <= READ_SLICE_MAX_BYTES);
  assert.equal(result.lines[result.lines.length - 1].line, result.endLine);
});

test('从上一次的 endLine + 1 续读可以走到文件末尾', () => {
  const content = oversizedFile();
  let cursor = 1;
  let reads = 0;
  let lastEnd = 0;

  while (cursor <= 12_000 && reads < 20) {
    const result = sliceTextFile('007_状态栏美化.html', content, cursor, undefined);
    assert.equal(result.startLine, cursor);
    assert.ok(result.endLine >= cursor, '每次续读都必须有进展');
    lastEnd = result.endLine;
    cursor = result.endLine + 1;
    reads += 1;
  }

  assert.equal(lastEnd, 12_000);
  assert.ok(reads > 1, '这个体量本就该分多次读');
});

test('显式行范围在超大文件上依然精确生效', () => {
  const content = oversizedFile();
  const result = sliceTextFile('007_状态栏美化.html', content, 500, 504);

  assert.equal(result.startLine, 500);
  assert.equal(result.endLine, 504);
  assert.equal(result.totalLines, 12_000);
  assert.deepEqual(result.lines.map((line) => line.line), [500, 501, 502, 503, 504]);
  assert.match(result.content, /^500 <div class="row-500">/);
});

test('单行长度超过预算时仍返回该行，读取不会空转', () => {
  const content = `${'x'.repeat(READ_SLICE_MAX_BYTES * 2)}\n第二行`;
  const result = sliceTextFile('huge-one-liner.txt', content, undefined, undefined);

  assert.equal(result.startLine, 1);
  assert.equal(result.endLine, 1);
  assert.equal(result.totalLines, 2);
});

test('小文件一次读完，行号与内容保持原样', () => {
  const result = sliceTextFile('small.txt', 'alpha\nbeta\ngamma', undefined, undefined);

  assert.equal(result.totalLines, 3);
  assert.equal(result.endLine, 3);
  assert.equal(result.content, '1 alpha\n2 beta\n3 gamma');
});
