const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const workspaceFsCalls = [];
const neverSettles = (operation) => {
  workspaceFsCalls.push(operation);
  return new Promise(() => undefined);
};

class Uri {
  constructor(scheme, fsPath) {
    this.scheme = scheme;
    this.fsPath = path.resolve(fsPath);
    this.path = this.fsPath.split(path.sep).join('/');
  }

  static file(filePath) {
    return new Uri('file', filePath);
  }

  toString() {
    return `${this.scheme}://${this.path}`;
  }
}

const vscode = {
  Uri,
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  workspace: {
    workspaceFolders: [],
    fs: {
      stat: () => neverSettles('stat'),
      readFile: () => neverSettles('readFile')
    }
  }
};

const originalLoad = Module._load;
Module._load = function loadWithVscodeMock(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
const {
  readWorkspaceBinaryFile,
  readWorkspaceTextFile
} = require('../../dist/extension/backend/capabilities/vscodeFs.js');
Module._load = originalLoad;

function localEnvironment(rootPath) {
  return {
    id: 'work-environment:local-read-test',
    kind: 'localFolder',
    source: 'workspaceFolder',
    name: 'local-read-test',
    uri: `file://${rootPath}`,
    rootPath,
    displayPath: rootPath,
    index: 0,
    available: true,
    createdAt: 1,
    updatedAt: 1
  };
}

async function within(milliseconds, operation) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Local file read did not finish within ${milliseconds}ms.`)), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('本地文本和附件读取不依赖可能失联的VS Code文件系统RPC', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-vscode-fs-local-read-'));
  try {
    const environment = localEnvironment(root);
    vscode.workspace.workspaceFolders = [{ uri: Uri.file(root) }];
    await fs.writeFile(path.join(root, 'sample.txt'), 'first\nsecond\nthird', 'utf8');
    await fs.writeFile(path.join(root, 'sample.png'), Buffer.from([0, 1, 2, 253, 254, 255]));

    const options = {
      workEnvironment: environment,
      accessibleWorkEnvironments: [environment],
      allowOutsideProjectPaths: false
    };
    const text = await within(1_000, readWorkspaceTextFile('sample.txt', 2, 3, options));
    const binary = await within(1_000, readWorkspaceBinaryFile('sample.png', 'image/png', options));

    assert.equal(text.content, '2 second\n3 third');
    assert.equal(text.totalLines, 3);
    assert.equal(binary.data, Buffer.from([0, 1, 2, 253, 254, 255]).toString('base64'));
    assert.equal(binary.sizeBytes, 6);
    assert.deepEqual(workspaceFsCalls, []);
  } finally {
    vscode.workspace.workspaceFolders = [];
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('超过单次预算的本地文件返回首段切片，行范围照常精确生效', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-vscode-fs-large-read-'));
  try {
    const environment = localEnvironment(root);
    vscode.workspace.workspaceFolders = [{ uri: Uri.file(root) }];
    // 约 440KB，远超单次返回预算；从前这样的文件会直接以 File too large 抛错，
    // 连带 startLine/endLine 一起失效，只能绕道 shell 分段读。
    const lineCount = 12_000;
    const lines = Array.from({ length: lineCount }, (_, i) => `<div class="row-${i + 1}">状态栏美化的第 ${i + 1} 行</div>`);
    await fs.writeFile(path.join(root, 'large.html'), lines.join('\n'), 'utf8');

    const options = {
      workEnvironment: environment,
      accessibleWorkEnvironments: [environment],
      allowOutsideProjectPaths: false
    };
    const head = await within(5_000, readWorkspaceTextFile('large.html', undefined, undefined, options));
    const ranged = await within(5_000, readWorkspaceTextFile('large.html', 500, 504, options));

    assert.equal(head.totalLines, lineCount);
    assert.equal(head.startLine, 1);
    assert.ok(head.endLine < lineCount, '整个文件不应一次返回');
    assert.ok(head.lines.length > 0, '超限也必须返回可读内容');

    assert.equal(ranged.startLine, 500);
    assert.equal(ranged.endLine, 504);
    assert.equal(ranged.totalLines, lineCount);
    assert.deepEqual(workspaceFsCalls, []);
  } finally {
    vscode.workspace.workspaceFolders = [];
    await fs.rm(root, { recursive: true, force: true });
  }
});
