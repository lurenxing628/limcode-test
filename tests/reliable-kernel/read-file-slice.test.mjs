import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { READ_SLICE_MAX_BYTES, sliceTextFile } from '../../dist/extension/backend/capabilities/textFileSlice.js';
import {
  readRemoteServerRawTextFile,
  readRemoteServerTextFile
} from '../../dist/extension/backend/capabilities/workEnvironmentProvider.js';

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
  const sourceLines = content.split('\n');
  for (const line of result.lines) assert.equal(line.text, sourceLines[line.line - 1]);
});

test('从上一次的 endLine + 1 续读可以走到文件末尾，且逐字节重建原文件', () => {
  const content = oversizedFile();
  let cursor = 1;
  let reads = 0;
  let lastEnd = 0;
  const seen = [];

  while (cursor <= 12_000 && reads < 20) {
    const result = sliceTextFile('007_状态栏美化.html', content, cursor, undefined);
    assert.equal(result.startLine, cursor);
    assert.ok(result.endLine >= cursor, '每次续读都必须有进展');
    seen.push(...result.lines.map((line) => line.text));
    lastEnd = result.endLine;
    cursor = result.endLine + 1;
    reads += 1;
  }

  assert.equal(lastEnd, 12_000);
  assert.ok(reads > 1, '这个体量本就该分多次读');
  assert.deepEqual(seen, content.split('\n'), '续读拼接必须与原文件逐行一致');
});

test('显式行范围在超大文件上依然精确生效', () => {
  const content = oversizedFile();
  const result = sliceTextFile('007_状态栏美化.html', content, 500, 504);

  assert.equal(result.startLine, 500);
  assert.equal(result.endLine, 504);
  assert.equal(result.totalLines, 12_000);
  assert.deepEqual(result.lines.map((line) => line.line), [500, 501, 502, 503, 504]);
  assert.deepEqual(result.lines.map((line) => line.text), content.split('\n').slice(499, 504));
});

test('单行长度超过预算时仍返回该行，读取不会空转', () => {
  const content = `${'x'.repeat(READ_SLICE_MAX_BYTES * 2)}\n第二行`;
  const result = sliceTextFile('huge-one-liner.txt', content, undefined, undefined);

  assert.equal(result.startLine, 1);
  assert.equal(result.endLine, 1);
  assert.equal(result.totalLines, 2);
  assert.deepEqual(result.lines, [{ line: 1, text: content.slice(0, content.indexOf('\n')) }]);
});

test('小文件一次读完，行号与内容保持原样', () => {
  const result = sliceTextFile('small.txt', 'alpha\nbeta\ngamma', undefined, undefined);

  assert.equal(result.totalLines, 3);
  assert.equal(result.endLine, 3);
  assert.equal(result.content, '1 alpha\n2 beta\n3 gamma');
});

// ---- 远端读取回归：本机 bash 替代 SSH transport ----
// fake ssh 只替换传输层：取最后一个参数（bash -lc '<script>'）在本机 shell 真实执行生成的远端脚本，
// 文件内容经真实 cat/管道流回；不是伪造的 SSH 服务器，也不 mock 被测代码。

const posixOnly = { skip: process.platform === 'win32' };

function remoteEnvironment(rootPath) {
  return {
    id: 'work-environment:remote-read-test',
    kind: 'remoteServer',
    source: 'manual',
    name: 'remote-read-test',
    host: 'remote-read.test.invalid',
    rootPath,
    displayPath: rootPath,
    index: 0,
    available: true,
    createdAt: 1,
    updatedAt: 1
  };
}

async function makeRemoteFixture(t, sshScript) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-remote-read-'));
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });
  const fakeBin = path.join(base, 'bin');
  await fs.mkdir(fakeBin, { recursive: true });
  const fakeSsh = path.join(fakeBin, 'ssh');
  await fs.writeFile(fakeSsh, sshScript ?? '#!/bin/sh\nfor last do :; done\nexec sh -c "$last"\n');
  await fs.chmod(fakeSsh, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ''}`;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });
  const root = path.join(base, 'root');
  await fs.mkdir(root, { recursive: true });
  return { base, root, environment: remoteEnvironment(root) };
}

/** 与事故夹具同量级：10_000 行带 Unicode 编号内容，约 400 KB，远超旧 120_000 字符预览上限。 */
const REMOTE_LINE_COUNT = 10_000;

function numberedUnicodeLines(lineCount = REMOTE_LINE_COUNT) {
  return Array.from(
    { length: lineCount },
    (_, i) => `第 ${i + 1} 行：状态栏美化 remote-read 内容校验 ${String((i * 7919) % 97).padStart(2, '0')}`
  );
}

async function writeBigFixture(root) {
  const content = `${numberedUnicodeLines().join('\n')}\n`;
  assert.ok(
    Buffer.byteLength(content, 'utf8') > READ_SLICE_MAX_BYTES,
    '夹具必须超过单切片预算，否则覆盖不到续读与截断路径'
  );
  await fs.writeFile(path.join(root, 'big.txt'), content, 'utf8');
  return content;
}

test('远端公共读取对超大编号 Unicode 文件报出真实 totalLines 且切片内容逐行一致（本机 bash 替代 SSH transport）', posixOnly, async (t) => {
  const { root, environment } = await makeRemoteFixture(t);
  const content = await writeBigFixture(root);

  const result = await readRemoteServerTextFile(environment, 'big.txt', undefined, undefined);

  assert.equal(result.totalLines, REMOTE_LINE_COUNT + 1, '旧实现在此处会因预览截断报出错误总行数');
  assert.equal(result.startLine, 1);
  assert.ok(result.endLine < result.totalLines, '这个体量不应一次返回');
  assert.deepEqual(result, sliceTextFile('big.txt', content, undefined, undefined), '远端读取必须与本地无损读取+切片完全一致');
});

test('远端公共读取的显式中段行范围在旧预览上限之外依然精确（本机 bash 替代 SSH transport）', posixOnly, async (t) => {
  const { root, environment } = await makeRemoteFixture(t);
  const content = await writeBigFixture(root);

  const result = await readRemoteServerTextFile(environment, 'big.txt', 5000, 5004);

  assert.equal(result.totalLines, REMOTE_LINE_COUNT + 1);
  assert.deepEqual(result.lines.map((line) => line.line), [5000, 5001, 5002, 5003, 5004]);
  assert.deepEqual(result.lines.map((line) => line.text), content.split('\n').slice(4999, 5004));
});

test('远端公共读取按 endLine + 1 续读逐字节重建原文件（本机 bash 替代 SSH transport）', posixOnly, async (t) => {
  const { root, environment } = await makeRemoteFixture(t);
  const content = await writeBigFixture(root);
  const sourceLines = content.split('\n');

  let cursor = 1;
  const seen = [];
  while (cursor <= sourceLines.length) {
    const result = await readRemoteServerTextFile(environment, 'big.txt', cursor, undefined);
    assert.equal(result.startLine, cursor);
    assert.ok(result.lines.length > 0, '每次续读都必须有进展');
    seen.push(...result.lines.map((line) => line.text));
    cursor = result.endLine + 1;
  }

  assert.deepEqual(seen, sourceLines, '续读拼接必须与原文件逐字节一致');
});

test('远端原始读取在 maxBytes 边界上成功、超过一字节即失败，且小文件逐字节一致（本机 bash 替代 SSH transport）', posixOnly, async (t) => {
  const { root, environment } = await makeRemoteFixture(t);
  const exact = `${'BoundaryLine-状态-0123456789abcdef\n'.repeat(128)}`;
  const exactBytes = Buffer.byteLength(exact, 'utf8');
  await fs.writeFile(path.join(root, 'exact.txt'), exact, 'utf8');
  await fs.writeFile(path.join(root, 'over.txt'), `${exact}x`, 'utf8');
  await fs.writeFile(path.join(root, 'small.txt'), '第一行\n第二行 ✓\n', 'utf8');

  const ok = await readRemoteServerRawTextFile(environment, 'exact.txt', exactBytes);
  assert.equal(ok, exact, '恰好等于 maxBytes 的文件必须完整返回');
  assert.equal(Buffer.byteLength(ok, 'utf8'), exactBytes);

  await assert.rejects(
    readRemoteServerRawTextFile(environment, 'over.txt', exactBytes),
    /File too large/,
    '超过 maxBytes 一个字节也必须失败而不是截断'
  );

  const small = await readRemoteServerRawTextFile(environment, 'small.txt');
  assert.equal(small, '第一行\n第二行 ✓\n', '多字节 UTF-8 内容不得因分块损坏');
});

test('远端读取对大小检查之后多出的字节失败而不是截断（本机 bash 替代 SSH transport，传输层注入额外字节）', posixOnly, async (t) => {
  // 模拟"远端 wc 检查之后文件继续增长"：脚本真实输出 128 字节文件内容后，transport 再追加 7 字节，
  // 线上字节数超过已检查的大小，本地预算必须使读取失败而不是返回前缀。
  const shim = '#!/bin/sh\nfor last do :; done\nsh -c "$last"\nprintf surplus\n';
  const { root, environment } = await makeRemoteFixture(t, shim);
  const content = 'g'.repeat(128);
  await fs.writeFile(path.join(root, 'growing.txt'), content, 'utf8');

  await assert.rejects(
    readRemoteServerRawTextFile(environment, 'growing.txt', 128),
    /File too large/,
    '检查之后多出的字节必须触发失败而不是静默截断'
  );
});

test('远端读取在取消时拒绝并干净收尾（本机 bash 替代 SSH transport）', posixOnly, async (t) => {
  const { root, environment } = await makeRemoteFixture(t);
  await writeBigFixture(root);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    readRemoteServerTextFile(environment, 'big.txt', undefined, undefined, { signal: controller.signal }),
    (error) => error instanceof Error,
    '已取消的读取必须拒绝而不是返回部分内容'
  );
});

test('远端读取保留文件缺失与非文件错误（本机 bash 替代 SSH transport）', posixOnly, async (t) => {
  const { root, environment } = await makeRemoteFixture(t);
  await fs.mkdir(path.join(root, 'adir'));

  await assert.rejects(
    readRemoteServerRawTextFile(environment, 'missing.txt'),
    (error) => error instanceof Error && error.name === 'RemoteFileNotFoundError'
  );
  await assert.rejects(
    readRemoteServerRawTextFile(environment, 'adir'),
    /not a file/
  );
});
