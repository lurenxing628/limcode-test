const assert = require('node:assert/strict');
const test = require('node:test');
const { applyExactEditHunk } = require('../../dist/extension/shared/editHunkMatcher.js');
const { applyHunkEdit } = require('../../dist/extension/backend/capabilities/editStrategies.js');

test('exact matches win globally and replaceAll stays within the selected comparison tier', () => {
  const source = ' x  \n y\nx\ny\n';
  const result = applyExactEditHunk(source, { oldContent: 'x\ny', newContent: 'X\nY', replaceAll: true });
  assert.equal(result.matchStrategy, 'exact');
  assert.equal(result.matchCount, 1);
  assert.equal(result.content, ' x  \n y\nX\nY\n');
  assert.equal(result.matches[0].sourceStart, source.indexOf('x\ny'));
  assert.equal(applyExactEditHunk('one two one', {
    oldContent: 'one', newContent: 'ONE', replaceAll: true
  }).content, 'ONE two ONE');
});

test('trim_end replaces actual source spans and preserves surrounding CRLF separators', () => {
  const source = 'alpha  \r\nbeta\t\r\nend\r\n';
  const result = applyExactEditHunk(source, { oldContent: 'alpha\nbeta', newContent: 'A\nB' });
  assert.equal(result.matchStrategy, 'trim_end');
  assert.equal(source.slice(result.matches[0].sourceStart, result.matches[0].sourceEnd), 'alpha  \r\nbeta\t');
  assert.equal(result.content, 'A\r\nB\r\nend\r\n');
});

test('trim_end wins over an earlier match that needs leading whitespace removed', () => {
  const source = ' alpha \n beta \nalpha  \nbeta\t\n';
  const result = applyExactEditHunk(source, { oldContent: 'alpha\nbeta', newContent: 'A\nB' });
  assert.equal(result.matchStrategy, 'trim_end');
  assert.equal(result.matchCount, 1);
  assert.equal(result.content, ' alpha \n beta \nA\nB\n');
});

test('trim matching preserves the BOM, UTF-16 offsets, and untouched Unicode text', () => {
  const source = '\ufeff \talpha  \r\n \tbeta\t\r\nsuffix🚀\r\n';
  const result = applyExactEditHunk(source, { oldContent: 'alpha\nbeta', newContent: '你好\n世界' });
  assert.equal(result.matchStrategy, 'trim');
  assert.equal(result.matches[0].sourceStart, 1);
  assert.equal(source.slice(result.matches[0].sourceStart, result.matches[0].sourceEnd), ' \talpha  \r\n \tbeta\t');
  assert.equal(result.content, '\ufeff你好\r\n世界\r\nsuffix🚀\r\n');
});

test('Unicode punctuation comparison uses the Codex dash, quote, and space table', () => {
  for (const [sourceText, oldContent] of [
    ['“Hello” — it’s fine', '"Hello" - it\'s fine'],
    ['«unchanged»\u00a0\u2212', '«unchanged» -'],
    ['\u2010\u2011\u2012\u2013\u2014\u2015\u2212', '-------'],
    ['\u2018\u2019\u201a\u201b', "''''"],
    ['\u201c\u201d\u201e\u201f', '""""'],
    ['a\u2002b\u2003c\u2004d\u2005e\u2006f\u2007g\u2008h\u2009i\u200aj\u202fk\u205fl\u3000m', 'a b c d e f g h i j k l m']
  ]) {
    const source = `🚀 prefix\r\n ${sourceText} \r\nend\n`;
    const result = applyExactEditHunk(source, { oldContent, newContent: 'changed' });
    assert.equal(result.matchStrategy, 'unicode', sourceText);
    assert.equal(result.matches[0].sourceStart, source.indexOf('\r\n') + 2);
    assert.equal(source.slice(result.matches[0].sourceStart, result.matches[0].sourceEnd), ` ${sourceText} `);
    assert.equal(result.content, '🚀 prefix\r\nchanged\r\nend\n');
  }
});

test('replaceAll applies non-overlapping tolerant matches using each matched EOL style', () => {
  const source = 'a  \r\nb\t\r\nseparator\na \nb  \n';
  const result = applyExactEditHunk(source, { oldContent: 'a\nb', newContent: 'A\nB', replaceAll: true });
  assert.equal(result.matchStrategy, 'trim_end');
  assert.equal(result.matchCount, 2);
  assert.equal(result.replacements, 2);
  assert.equal(result.content, 'A\r\nB\r\nseparator\nA\nB\n');
});

test('ordered hunks match the preceding replacement and explain tolerant matching', () => {
  const result = applyHunkEdit('  a  \r\n  b\t\r\nend', [
    { oldContent: 'a\nb', newContent: 'A\nB' },
    { oldContent: 'A\nB', newContent: 'finished' }
  ]);
  assert.equal(result.newContent, 'finished\r\nend');
  assert.equal(result.failed, 0);
  assert.equal(result.results[0].fallback.strategy, 'trim');
  assert.equal(result.results[1].fallback, undefined);
});

test('empty replacement deletes the matched real span including a requested final newline', () => {
  const source = 'a  \r\nb\t\r\nc';
  assert.equal(applyExactEditHunk(source, { oldContent: 'a\nb\n', newContent: '' }).content, 'c');
  assert.equal(applyExactEditHunk(source, { oldContent: 'a\nb', newContent: '' }).content, '\r\nc');
});

test('fallback does not guess case, internal spacing, missing lines, or final newlines', () => {
  for (const [source, oldContent] of [
    ['Alpha  beta\r\n', 'alpha beta'],
    ['alpha  beta\n', 'alpha beta'],
    ['one\n', 'one\ntwo'],
    ['a', 'a\n'],
    ['', ' '],
    ['\ufeff', ' '],
    ['one\n', 'one\n ']
  ]) {
    const result = applyExactEditHunk(source, { oldContent, newContent: 'changed' });
    assert.equal(result.matchCount, 0, `${JSON.stringify(source)} vs ${JSON.stringify(oldContent)}`);
    assert.equal(result.content, source);
  }
});
