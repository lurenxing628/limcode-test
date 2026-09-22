const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

class MockUri {
  constructor(fsPath) {
    this.scheme = 'file';
    this.fsPath = path.resolve(fsPath);
    this.path = this.fsPath.replaceAll('\\', '/');
  }

  static file(fsPath) {
    return new MockUri(fsPath);
  }

  static joinPath(base, ...segments) {
    return new MockUri(path.join(base.fsPath, ...segments));
  }

  toString() {
    return `file://${this.path}`;
  }
}

const vscodeMock = {
  Uri: MockUri,
  FileType: { File: 1, Directory: 2 },
  workspace: {
    fs: {
      createDirectory: (uri) => fsp.mkdir(uri.fsPath, { recursive: true }),
      readDirectory: async (uri) => (await fsp.readdir(uri.fsPath, { withFileTypes: true }))
        .map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]),
      readFile: (uri) => fsp.readFile(uri.fsPath),
      writeFile: async (uri, data) => {
        await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
        await fsp.writeFile(uri.fsPath, data);
      },
      delete: (uri) => fsp.rm(uri.fsPath, { recursive: true, force: false })
    }
  }
};

const previousTsLoader = require.extensions['.ts'];
const originalModuleLoad = Module._load;
require.extensions['.ts'] = function transpileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true
    },
    fileName: filename
  }).outputText;
  module._compile(output, filename);
};
Module._load = function loadWithVscodeMock(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalModuleLoad.call(this, request, parent, isMain);
};

const revision = require('../backend/capabilities/vscodeStorage/storageRevision.ts');
const recordStore = require('../backend/capabilities/vscodeStorage/recordStore.ts');
const syncStorageResourceLock = require('../backend/capabilities/vscodeStorage/syncStorageResourceLock.ts');
const globalSettings = require('../backend/capabilities/vscodeStorage/globalSettings.ts');
const globalStatus = require('../backend/capabilities/vscodeStorage/globalStatus.ts');

Module._load = originalModuleLoad;
if (previousTsLoader) require.extensions['.ts'] = previousTsLoader;
else delete require.extensions['.ts'];

test('内容指纹不受对象键插入顺序影响', () => {
  assert.equal(
    revision.createStorageRevision({ b: 2, a: { y: true, x: false } }),
    revision.createStorageRevision({ a: { x: false, y: true }, b: 2 })
  );
});

test('旧窗口不能覆盖 record 设置集合的新提交', async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-settings-cas-records-'));
  const root = MockUri.file(tempRoot);
  const index = MockUri.joinPath(root, 'index.json');
  try {
    const missingRevision = recordStore.missingRecordStoreRevision(index);
    const first = await recordStore.commitRecordStoreSnapshot(
      root,
      index,
      [{ id: 'provider-a', name: 'A' }],
      'record',
      (item) => item.name,
      { expectedRevision: missingRevision, section: 'providers', pruneMissing: true }
    );
    const second = await recordStore.commitRecordStoreSnapshot(
      root,
      index,
      [...first.records, { id: 'provider-b', name: 'B' }],
      'record',
      (item) => item.name,
      { expectedRevision: first.revision, section: 'providers', pruneMissing: true }
    );

    await assert.rejects(
      recordStore.commitRecordStoreSnapshot(
        root,
        index,
        [{ id: 'provider-a', name: 'A from stale window' }],
        'record',
        (item) => item.name,
        { expectedRevision: first.revision, section: 'providers', pruneMissing: true }
      ),
      (error) => error?.settingsRevisionConflict === true
    );

    const stored = await recordStore.loadRecordStoreSnapshot(root, index, 'record');
    assert.equal(stored.revision, second.revision);
    assert.deepEqual(stored.records.map((item) => item.id), ['provider-a', 'provider-b']);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test('Windows rename 返回 EPERM 时会按已有锁竞争等待并重试', {
  skip: process.platform !== 'win32'
}, async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-record-store-win-contention-'));
  const transactionPath = path.join(tempRoot, 'authority');
  const lockPath = `${transactionPath}.lock`;
  const originalRename = fsp.rename;
  let injectedContentionErrors = 0;
  try {
    await fsp.mkdir(lockPath, { recursive: true });
    await fsp.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
      ownerToken: 'competing-owner',
      pid: process.pid,
      createdAt: Date.now(),
      indexPath: transactionPath
    }));

    fsp.rename = async (source, destination) => {
      const isCandidatePublication = destination === lockPath
        && String(source).startsWith(`${lockPath}.candidate-`);
      const lockExists = isCandidatePublication
        ? await fsp.stat(lockPath).then(() => true, () => false)
        : false;
      if (lockExists) {
        injectedContentionErrors += 1;
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${source}' -> '${destination}'`), {
          code: 'EPERM',
          syscall: 'rename',
          path: source,
          dest: destination
        });
      }
      return originalRename(source, destination);
    };

    let actionRuns = 0;
    await Promise.all([
      recordStore.withRecordStoreTransaction(MockUri.file(transactionPath), async () => { actionRuns += 1; }),
      new Promise((resolve) => setTimeout(resolve, 100))
        .then(() => fsp.rm(lockPath, { recursive: true, force: true }))
    ]);

    assert.ok(injectedContentionErrors > 0);
    assert.equal(actionRuns, 1);
    assert.deepEqual(
      (await fsp.readdir(tempRoot)).filter((entry) => entry.startsWith('authority.lock')),
      []
    );
  } finally {
    fsp.rename = originalRename;
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test('Windows 释放锁目录遇到精确的瞬态 rename busy 会有界重试', {
  skip: process.platform !== 'win32'
}, async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-record-store-win-release-'));
  const transactionPath = path.join(tempRoot, 'authority');
  const lockPath = `${transactionPath}.lock`;
  const originalRename = fsp.rename;
  let injectedReleaseErrors = 0;
  try {
    fsp.rename = async (source, destination) => {
      const isRelease = source === lockPath
        && String(destination).startsWith(`${lockPath}.generation-owner-`);
      if (isRelease && injectedReleaseErrors < 3) {
        injectedReleaseErrors += 1;
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${source}' -> '${destination}'`), {
          code: 'EPERM',
          syscall: 'rename',
          path: source,
          dest: destination
        });
      }
      return originalRename(source, destination);
    };

    let actionRuns = 0;
    await recordStore.withRecordStoreTransaction(MockUri.file(transactionPath), async () => {
      actionRuns += 1;
    });
    assert.equal(actionRuns, 1);
    assert.equal(injectedReleaseErrors, 3);
    assert.deepEqual(
      (await fsp.readdir(tempRoot)).filter((entry) => entry.startsWith('authority.lock')),
      []
    );
  } finally {
    fsp.rename = originalRename;
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test('Windows 同步资源锁同样精确识别获取竞争并重试释放 rename', {
  skip: process.platform !== 'win32'
}, async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-sync-lock-win-'));
  const resourcePath = path.join(tempRoot, 'authority.json');
  const lockPath = `${resourcePath}.lock`;
  const originalRenameSync = fs.renameSync;
  let publicationErrors = 0;
  let releaseErrors = 0;
  try {
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({
      ownerToken: 'competing-owner',
      pid: process.pid,
      createdAt: Date.now(),
      resource: path.resolve(resourcePath)
    })}\n`);

    fs.renameSync = function injectedRenameSync(source, destination) {
      const sourceText = String(source);
      const destinationText = String(destination);
      const isPublication = destinationText === lockPath
        && sourceText.startsWith(`${lockPath}.candidate-`);
      if (isPublication && publicationErrors < 2) {
        publicationErrors += 1;
        throw Object.assign(new Error('EPERM: injected sync lock contention'), {
          code: 'EPERM', syscall: 'rename', path: sourceText, dest: destinationText
        });
      }
      if (isPublication && fs.existsSync(lockPath)) {
        fs.rmSync(lockPath, { recursive: true, force: true });
      }
      const isRelease = sourceText === lockPath
        && destinationText.startsWith(`${lockPath}.generation-owner-`);
      if (isRelease && releaseErrors < 3) {
        releaseErrors += 1;
        throw Object.assign(new Error('EACCES: injected sync lock release contention'), {
          code: 'EACCES', syscall: 'rename', path: sourceText, dest: destinationText
        });
      }
      return originalRenameSync.call(this, source, destination);
    };

    let actionRuns = 0;
    syncStorageResourceLock.withSyncStorageResourceLock(resourcePath, () => {
      actionRuns += 1;
    }, { waitMs: 1_000, pollIntervalMs: 1, maxRetries: 6, retryDelayMs: 1 });
    assert.equal(actionRuns, 1);
    assert.equal(publicationErrors, 2);
    assert.equal(releaseErrors, 3);
    assert.deepEqual(
      (await fsp.readdir(tempRoot)).filter((entry) => entry.startsWith('authority.json.lock')),
      []
    );
  } finally {
    fs.renameSync = originalRenameSync;
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test('旧窗口不能覆盖普通设置文件的新提交', async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-settings-cas-file-'));
  const root = MockUri.file(tempRoot);
  try {
    const initial = await globalSettings.loadGlobalSettingsFile(root, 'appearance');
    const first = await globalSettings.writeGlobalSettingsFile(root, 'appearance', {
      ...initial.settings,
      streamingTextWaiting: '窗口 A 已保存'
    }, initial.revision);
    const beforeNoop = await fsp.readFile(first.filePath, 'utf8');
    const noop = await globalSettings.writeGlobalSettingsFile(root, 'appearance', first.settings, first.revision);
    assert.equal(noop.revision, first.revision);
    assert.equal(await fsp.readFile(first.filePath, 'utf8'), beforeNoop, 'unchanged settings must not republish timestamps');

    await assert.rejects(
      globalSettings.writeGlobalSettingsFile(root, 'appearance', {
        ...initial.settings,
        streamingTextWaiting: '窗口 B 的旧内容'
      }, initial.revision),
      (error) => error?.settingsRevisionConflict === true
    );

    const stored = await globalSettings.loadGlobalSettingsFile(root, 'appearance');
    assert.equal(stored.revision, first.revision);
    assert.equal(stored.settings.streamingTextWaiting, '窗口 A 已保存');
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test('两个 Extension Host 不能用旧 common 版本覆盖代理设置', async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-settings-common-cas-'));
  const createContext = () => {
    let projected;
    return {
      globalStorageUri: MockUri.file(tempRoot),
      globalState: {
        get: () => projected,
        update: async (_key, value) => { projected = value; }
      }
    };
  };
  const firstContext = createContext();
  const staleContext = createContext();
  try {
    const initial = await globalStatus.loadCommittedGlobalStatus(firstContext);
    const stale = await globalStatus.loadCommittedGlobalStatus(staleContext);
    assert.equal(globalStatus.globalStatusRevision(initial), globalStatus.globalStatusRevision(stale));

    const committed = await globalStatus.saveGlobalStatusExpected(
      firstContext,
      initial.dataRootPath,
      'http://proxy-a.example',
      globalStatus.globalStatusRevision(initial)
    );
    await assert.rejects(
      globalStatus.saveGlobalStatusExpected(
        staleContext,
        stale.dataRootPath,
        'http://stale-proxy.example',
        globalStatus.globalStatusRevision(stale)
      ),
      (error) => error?.settingsRevisionConflict === true
    );
    const reloaded = await globalStatus.loadCommittedGlobalStatus(staleContext);
    assert.equal(reloaded.proxy, 'http://proxy-a.example');
    assert.equal(globalStatus.globalStatusRevision(reloaded), globalStatus.globalStatusRevision(committed.current));
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test('损坏设置会报错且不会被默认值覆盖', async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-settings-corrupt-'));
  const root = MockUri.file(tempRoot);
  const target = path.join(tempRoot, 'appearance.json');
  const damaged = '{ definitely-not-json';
  try {
    await fsp.writeFile(target, damaged, 'utf8');
    await assert.rejects(globalSettings.loadGlobalSettingsFile(root, 'appearance'));
    assert.equal(await fsp.readFile(target, 'utf8'), damaged);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});
test('Windows 候选目录瞬态 busy(lockPath 不存在)的发布 rename 会重试后成功', {
  skip: process.platform !== 'win32'
}, async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-sync-lock-win-transient-'));
  const resourcePath = path.join(tempRoot, 'index.json');
  const lockPath = `${resourcePath}.lock`;
  const originalRenameSync = fs.renameSync;
  let transientErrors = 0;
  try {
    fs.renameSync = function injectedTransientCandidateBusy(source, destination) {
      const sourceText = String(source);
      const destinationText = String(destination);
      const isPublication = destinationText === lockPath
        && sourceText.startsWith(`${lockPath}.candidate-`);
      if (isPublication && transientErrors < 2 && !fs.existsSync(lockPath)) {
        transientErrors += 1;
        throw Object.assign(
          new Error(`EPERM: operation not permitted, rename '${sourceText}' -> '${destinationText}'`),
          { code: 'EPERM', syscall: 'rename', path: sourceText, dest: destinationText }
        );
      }
      return originalRenameSync.call(this, source, destination);
    };

    let actionRuns = 0;
    syncStorageResourceLock.withSyncStorageResourceLock(resourcePath, () => {
      actionRuns += 1;
    }, { waitMs: 1_000, pollIntervalMs: 1, maxRetries: 6, retryDelayMs: 1 });
    assert.equal(actionRuns, 1);
    assert.equal(transientErrors, 2);
    assert.deepEqual(
      (await fsp.readdir(tempRoot)).filter((entry) => entry.startsWith('index.json.lock')),
      []
    );
  } finally {
    fs.renameSync = originalRenameSync;
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test('Windows 候选目录持续 busy 时有界等待并报超时而非裸 EPERM', {
  skip: process.platform !== 'win32'
}, async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-sync-lock-win-stuck-'));
  const resourcePath = path.join(tempRoot, 'index.json');
  const lockPath = `${resourcePath}.lock`;
  const originalRenameSync = fs.renameSync;
  let attempts = 0;
  try {
    fs.renameSync = function injectedPersistentCandidateBusy(source, destination) {
      const sourceText = String(source);
      const destinationText = String(destination);
      const isPublication = destinationText === lockPath
        && sourceText.startsWith(`${lockPath}.candidate-`);
      if (isPublication) {
        attempts += 1;
        throw Object.assign(
          new Error('EPERM: injected persistent candidate busy'),
          { code: 'EPERM', syscall: 'rename', path: sourceText, dest: destinationText }
        );
      }
      return originalRenameSync.call(this, source, destination);
    };

    assert.throws(
      () => syncStorageResourceLock.withSyncStorageResourceLock(resourcePath, () => {}, {
        waitMs: 120, pollIntervalMs: 5, maxRetries: 6, retryDelayMs: 1
      }),
      (error) => error instanceof Error
        && error.message.includes('Timed out waiting for sync storage resource lock')
    );
    assert.ok(attempts > 1, 'deadline 内应多次重试发布 rename');
  } finally {
    fs.renameSync = originalRenameSync;
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test('Windows 候选目录 owner.json 写入失败不被误判为瞬态 rename busy', {
  skip: process.platform !== 'win32'
}, async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-sync-lock-win-writefail-'));
  const resourcePath = path.join(tempRoot, 'index.json');
  const lockPath = `${resourcePath}.lock`;
  const originalWriteFileSync = fs.writeFileSync;
  try {
    fs.writeFileSync = function injectedOwnerWriteFailure(target, ...rest) {
      const targetText = String(target);
      if (targetText.startsWith(`${lockPath}.candidate-`) && targetText.endsWith('owner.json')) {
        throw Object.assign(new Error('EACCES: injected owner.json write failure'), {
          code: 'EACCES', syscall: 'open', path: targetText
        });
      }
      return originalWriteFileSync.call(this, target, ...rest);
    };

    assert.throws(
      () => syncStorageResourceLock.withSyncStorageResourceLock(resourcePath, () => {}, {
        waitMs: 1_000, pollIntervalMs: 1, maxRetries: 6, retryDelayMs: 1
      }),
      (error) => error?.code === 'EACCES'
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});test('Windows 异步记录库锁候选目录瞬态 busy(lockPath 不存在)会重试后成功', {
  skip: process.platform !== 'win32'
}, async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-record-store-win-transient-'));
  const transactionPath = path.join(tempRoot, 'authority');
  const lockPath = `${transactionPath}.lock`;
  const originalRename = fsp.rename;
  let transientErrors = 0;
  try {
    fsp.rename = async (source, destination) => {
      const isPublication = destination === lockPath
        && String(source).startsWith(`${lockPath}.candidate-`);
      if (isPublication && transientErrors < 2) {
        const lockExists = await fsp.stat(lockPath).then(() => true, () => false);
        if (!lockExists) {
          transientErrors += 1;
          throw Object.assign(new Error('EPERM: injected transient candidate busy'), {
            code: 'EPERM', syscall: 'rename', path: String(source), dest: String(destination)
          });
        }
      }
      return originalRename(source, destination);
    };

    let actionRuns = 0;
    await recordStore.withRecordStoreTransaction(MockUri.file(transactionPath), async () => { actionRuns += 1; });
    assert.equal(actionRuns, 1);
    assert.equal(transientErrors, 2);
    assert.deepEqual(
      (await fsp.readdir(tempRoot)).filter((entry) => entry.startsWith('authority.lock')),
      []
    );
  } finally {
    fsp.rename = originalRename;
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});
