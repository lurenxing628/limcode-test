import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

async function displayFixture(t) {
  const server = await createWebviewSsrServer();
  t.after(() => server.close());
  const { readFileToolDisplay } = await server.ssrLoadModule('/src/components/content/toolDisplay/readFileToolDisplay.ts');
  return (args, result) => readFileToolDisplay({ toolName: 'read', args, result, events: [], stringifyValue: JSON.stringify });
}

const row = (section, label) => section.rows?.find(item => item.label === label)?.value;

test('read input chooses path and keeps ignored attachment/items visible in the original parameters', async (t) => {
  const display = await displayFixture(t);
  const args = {
    path: 'src\\actual.ts', startLine: 1, endLine: 3, attachmentRef: 'F1', pages: '1-2',
    items: [{ path: 0, startLine: false }], note: 'keep the original parameters'
  };
  const pending = display(args);
  assert.equal(row(pending.inputSections[0], '路径'), 'src/actual.ts');
  assert.equal(row(pending.inputSections[0], '附件'), undefined);
  assert.equal(row(pending.inputSections[0], '页范围'), undefined);
  assert.equal(row(pending.inputSections[0], '行范围'), 'L1-3');
  assert.equal(row(pending.inputSections[1], '未使用参数'), 'attachmentRef、items、pages');
  assert.match(row(pending.inputSections[1], '说明'), /已选择 path/);
  assert.deepEqual(JSON.parse(pending.inputSections.find(section => section.title === '原始参数').text), args);
});

test('managed attachment wins over items and ignores path-only fields without showing a local path', async (t) => {
  const display = await displayFixture(t);
  const args = { attachmentRef: 'F1', pages: '2', mode: 'typo', startLine: 10, endLine: 20, items: [{ path: 'unused.txt' }] };
  const shown = display(args, { name: 'notes.txt', attachmentId: 'internal-attachment', content: 'hello', returnedPages: '2', totalPages: 2 });
  assert.equal(row(shown.inputSections[0], '附件'), 'F1');
  assert.equal(row(shown.inputSections[0], '路径'), undefined);
  assert.equal(row(shown.inputSections[0], '读取方式'), '历史附件（自动识别）');
  assert.equal(row(shown.inputSections[0], '页范围'), '2');
  assert.equal(row(shown.inputSections[1], '未使用参数'), 'items、mode、startLine、endLine');
  assert.equal(shown.outputSections[0].title, '读取结果 · notes.txt[text][pages 2]');
  assert.match(shown.outputSections[0].text, /^hello/);
});

test('single-item batch stays text and reports ignored root mode, pages, and real zero/false ranges', async (t) => {
  const display = await displayFixture(t);
  const args = { items: [{ path: 'batch.txt', startLine: 2 }], mode: 'attachment', pages: '1', startLine: 0, endLine: false };
  const shown = display(args, { files: [{ path: 'batch.txt', startLine: 2, endLine: 2, content: '2 actual' }] });
  assert.equal(row(shown.inputSections[0], '路径'), 'batch.txt');
  assert.equal(row(shown.inputSections[0], '读取方式'), '文本');
  assert.equal(row(shown.inputSections[0], '行范围'), 'L2-');
  assert.equal(row(shown.inputSections[1], '未使用参数'), 'mode、pages、startLine、endLine');
  assert.equal(shown.outputSections[0].title, '读取结果 · batch.txt[text][L2-2]');
  assert.equal(shown.outputSections[0].text, '2 actual');
});

test('read warning survives root, output, and legacy detail envelopes while content remains visible', async (t) => {
  const display = await displayFixture(t);
  const args = { path: 'actual.txt', items: [{ path: 'unused.txt' }] };
  const payload = { path: 'actual.txt', content: '1 actual', startLine: 1, endLine: 1 };
  const metadata = { ignoredFields: ['items'], warning: '已选择 path；未使用参数：items。' };
  for (const result of [
    { ...payload, ...metadata },
    { ok: true, output: { ...payload, ...metadata } },
    { ok: true, output: payload, ...metadata },
    { detail: { ok: true, output: payload, ...metadata } },
    { detail: { ...payload, ...metadata } }
  ]) {
    const shown = display(args, result);
    assert.equal(shown.outputSections[0].title, '读取结果 · actual.txt[text][L1-1]');
    assert.equal(shown.outputSections[0].text, '1 actual');
    const explanation = shown.outputSections.find(section => section.title === '读取说明');
    assert.equal(row(explanation, '未使用参数'), 'items');
    assert.equal(row(explanation, '说明'), metadata.warning);
  }
  const failed = display(args, { detail: 'original failure', ...metadata });
  assert.equal(failed.outputSections[0].text, 'original failure');
  assert.equal(row(failed.outputSections[1], '说明'), metadata.warning);
});

test('empty optional branches stay quiet and local media mode is inferred before the result loads', async (t) => {
  const display = await displayFixture(t);
  const ordinary = display({ path: 'a.txt', attachmentRef: ' ', items: [], pages: null }, { path: 'a.txt', content: '1 body' });
  assert.equal(ordinary.inputSections.length, 1);
  assert.equal(ordinary.outputSections.length, 1);
  assert.equal(ordinary.outputSections[0].text, '1 body');
  const media = display({ path: 'photo.png', startLine: 0 });
  assert.equal(row(media.inputSections[0], '读取方式'), '附件');
  assert.equal(row(media.inputSections[0], '行范围'), undefined);
  assert.equal(row(media.inputSections[1], '未使用参数'), 'startLine');
  const invalid = display({ path: 'a.txt', mode: 'typo' }, { ok: false, output: 'Invalid mode' });
  assert.equal(row(invalid.inputSections[0], '读取方式'), '无效模式');
  assert.equal(invalid.outputSections[0].text, 'Invalid mode');
});
