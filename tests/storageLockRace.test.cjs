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

const recordStore = require('../backend/capabilities/vscodeStorage/recordStore.ts');
const syncStorageResourceLock = require('../backend/capabilities/vscodeStorage/syncStorageResourceLock.ts');

Module._load = originalModuleLoad;
if (previousTsLoader) require.extensions['.ts'] = previousTsLoader;
else delete require.extensions['.ts'];

const windowsOnly = { skip: process.platform !== 'win32' };

function injectedPublicationError(source, destination) {
  return Object.assign(new Error(`EPERM: operation not permitted, rename '${source}' -> '${destination}'`), {
    code: 'EPERM',
    syscall: 'rename',
    path: String(source),
    dest: String(destination)
  });
}

function missingPathError(target) {
  return Object.assign(new Error(`ENOENT: no such file or directory, stat '${target}'`), {
    code: 'ENOENT',
    syscall: 'stat',
    path: String(target)
  });
}

function injectedFsError(code, syscall, target) {
  return Object.assign(new Error(`${code}: injected ${syscall} failure at '${target}'`), {
    code, syscall, path: String(target)
  });
}

for (const operation of ['read', 'rename']) {
  test(`async release retries a temporary ${operation} failure without repeating the action`, async () => {
    const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-lock-release-retry-'));
    const indexPath = path.join(rootPath, 'index.json');
    const lockPath = `${indexPath}.lock`;
    const ownerPath = path.join(lockPath, 'owner.json');
    const originalReadFile = fsp.readFile;
    const originalRename = fsp.rename;
    const fault = injectedFsError(operation === 'read' ? 'EACCES' : 'EBUSY', operation, ownerPath);
    let actionRuns = 0;
    let failures = 0;
    try {
      fsp.readFile = async (target, ...options) => {
        if (operation === 'read' && actionRuns === 1 && String(target) === ownerPath && failures++ < 2) throw fault;
        return originalReadFile(target, ...options);
      };
      fsp.rename = async (source, destination) => {
        if (operation === 'rename' && String(source) === lockPath && failures++ < 2) throw fault;
        return originalRename(source, destination);
      };
      const result = await recordStore.withRecordStoreTransaction(MockUri.file(indexPath), async () => {
        actionRuns += 1;
        return 'saved';
      });
      assert.equal(result, 'saved');
      assert.equal(actionRuns, 1);
      assert.ok(failures >= 3);
      assert.deepEqual(await fsp.readdir(rootPath), []);
      await recordStore.withRecordStoreTransaction(MockUri.file(indexPath), async () => { actionRuns += 1; });
      assert.equal(actionRuns, 2);
    } finally {
      fsp.readFile = originalReadFile;
      fsp.rename = originalRename;
      await fsp.rm(rootPath, { recursive: true, force: true });
    }
  });

  test(`a completed owner survives repeated ${operation} release failures and is released before the next action`, { timeout: 10_000 }, async () => {
    const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-lock-pending-release-'));
    const indexPath = path.join(rootPath, 'index.json');
    const lockPath = `${indexPath}.lock`;
    const ownerPath = path.join(lockPath, 'owner.json');
    const originalReadFile = fsp.readFile;
    const originalRename = fsp.rename;
    const fault = injectedFsError('EACCES', operation, ownerPath);
    let actionRuns = 0;
    let denyRelease = true;
    let failures = 0;
    let firstOwner;
    let recoveredOwner;
    try {
      fsp.readFile = async (target, ...options) => {
        if (operation === 'read' && actionRuns > 0 && String(target) === ownerPath && denyRelease) {
          failures += 1;
          throw fault;
        }
        return originalReadFile(target, ...options);
      };
      fsp.rename = async (source, destination) => {
        if (String(source) === lockPath) {
          if (operation === 'rename' && denyRelease) {
            failures += 1;
            throw fault;
          }
          recoveredOwner ??= JSON.parse(await originalReadFile(ownerPath, 'utf8'));
        }
        return originalRename(source, destination);
      };
      await assert.rejects(recordStore.withRecordStoreTransaction(MockUri.file(indexPath), async () => {
        firstOwner = JSON.parse(await originalReadFile(ownerPath, 'utf8'));
        actionRuns += 1;
      }), (error) => error.cause === fault && /release/.test(error.message));
      assert.ok(failures > 1 && failures <= 100, 'release retries must be bounded');
      await assert.rejects(recordStore.withRecordStoreTransaction(MockUri.file(indexPath), async () => {
        actionRuns += 1;
      }), (error) => error.cause === fault);
      assert.equal(actionRuns, 1, 'a new action cannot enter while the completed owner remains locked');
      assert.deepEqual(JSON.parse(await originalReadFile(ownerPath, 'utf8')), firstOwner);
      denyRelease = false;
      await recordStore.withRecordStoreTransaction(MockUri.file(indexPath), async () => {
        const nextOwner = JSON.parse(await originalReadFile(ownerPath, 'utf8'));
        assert.notEqual(nextOwner.ownerToken, firstOwner.ownerToken);
        assert.deepEqual(recoveredOwner, firstOwner, 'only the completed owner may be released during recovery');
        actionRuns += 1;
      });
      assert.equal(actionRuns, 2);
      assert.deepEqual(await fsp.readdir(rootPath), []);
    } finally {
      fsp.readFile = originalReadFile;
      fsp.rename = originalRename;
      await fsp.rm(rootPath, { recursive: true, force: true });
    }
  });
}

test('an old live owner with the same PID is not treated as a completed local action', async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-lock-live-owner-'));
  const indexPath = path.join(rootPath, 'index.json');
  const lockPath = `${indexPath}.lock`;
  const ownerPath = path.join(lockPath, 'owner.json');
  const originalReadFile = fsp.readFile;
  const originalNow = Date.now;
  let clockOffset = 0;
  const owner = { ownerToken: 'live-owner', pid: process.pid, createdAt: Date.now() - 60_000, indexPath };
  try {
    await fsp.mkdir(lockPath);
    await fsp.writeFile(ownerPath, JSON.stringify(owner));
    Date.now = () => originalNow() + clockOffset;
    fsp.readFile = async (target, ...options) => {
      const raw = await originalReadFile(target, ...options);
      if (String(target) === ownerPath) clockOffset = 31_000;
      return raw;
    };
    let actionRuns = 0;
    await assert.rejects(recordStore.withRecordStoreTransaction(MockUri.file(indexPath), async () => {
      actionRuns += 1;
    }), /Timed out waiting for record store lock/);
    assert.equal(actionRuns, 0);
    assert.deepEqual(JSON.parse(await originalReadFile(ownerPath, 'utf8')), owner);
    assert.deepEqual(await fsp.readdir(rootPath), ['index.json.lock']);
  } finally {
    fsp.readFile = originalReadFile;
    Date.now = originalNow;
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test('a failed action retains both errors and still permits its completed owner to be released later', async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-lock-action-and-release-'));
  const indexPath = path.join(rootPath, 'index.json');
  const ownerPath = path.join(`${indexPath}.lock`, 'owner.json');
  const originalReadFile = fsp.readFile;
  const actionError = new Error('configuration write failed');
  const releaseError = injectedFsError('EIO', 'read', ownerPath);
  let actionRuns = 0;
  try {
    fsp.readFile = async (target, ...options) => {
      if (String(target) === ownerPath) throw releaseError;
      return originalReadFile(target, ...options);
    };
    await assert.rejects(recordStore.withRecordStoreTransaction(MockUri.file(indexPath), async () => {
      actionRuns += 1;
      throw actionError;
    }), (error) => error.cause === actionError && error.actionError === actionError
      && error.releaseError.cause === releaseError);
    fsp.readFile = originalReadFile;
    await recordStore.withRecordStoreTransaction(MockUri.file(indexPath), async () => { actionRuns += 1; });
    assert.equal(actionRuns, 2);
    assert.deepEqual(await fsp.readdir(rootPath), []);
  } finally {
    fsp.readFile = originalReadFile;
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test('release retries recheck the owner and a later queued recovery preserves its replacement', async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-lock-release-replacement-'));
  const indexPath = path.join(rootPath, 'index.json');
  const lockPath = `${indexPath}.lock`;
  const ownerPath = path.join(lockPath, 'owner.json');
  const originalReadFile = fsp.readFile;
  const originalRename = fsp.rename;
  const originalNow = Date.now;
  let clockOffset = 0;
  let replacement;
  let replacementReads = 0;
  let movedReplacement = false;
  try {
    fsp.rename = async (source, destination) => {
      if (String(source) === lockPath) {
        if (!replacement) {
          await originalRename(source, path.join(rootPath, 'released-original'));
          replacement = { ownerToken: 'replacement', pid: process.pid, createdAt: Date.now(), indexPath };
          await fsp.mkdir(lockPath);
          await fsp.writeFile(ownerPath, JSON.stringify(replacement));
          throw injectedFsError('EBUSY', 'rename', source);
        }
        movedReplacement = true;
      }
      return originalRename(source, destination);
    };
    await assert.rejects(recordStore.withRecordStoreTransaction(MockUri.file(indexPath), async () => undefined),
      (error) => /owner changed/.test(error.cause?.message));
    Date.now = () => originalNow() + clockOffset;
    fsp.readFile = async (target, ...options) => {
      const raw = await originalReadFile(target, ...options);
      if (String(target) === ownerPath && ++replacementReads >= 2) clockOffset = 31_000;
      return raw;
    };
    await assert.rejects(recordStore.withRecordStoreTransaction(MockUri.file(indexPath), async () => {
      assert.fail('replacement owner must remain locked');
    }), /Timed out waiting for record store lock/);
    assert.equal(movedReplacement, false);
    assert.deepEqual(JSON.parse(await originalReadFile(ownerPath, 'utf8')), replacement);
  } finally {
    fsp.readFile = originalReadFile;
    fsp.rename = originalRename;
    Date.now = originalNow;
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test('Windows publication denied without an owner reports the filesystem cause within bounded retries', { timeout: 5_000 }, async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-lock-publication-denied-'));
  const indexPath = path.join(rootPath, 'index.json');
  const lockPath = `${indexPath}.lock`;
  const originalRename = fsp.rename;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  let publicationAttempts = 0;
  let lastFault;
  try {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    fsp.rename = async (source, destination) => {
      if (String(destination) === lockPath) {
        publicationAttempts += 1;
        lastFault = injectedPublicationError(source, destination);
        throw lastFault;
      }
      return originalRename(source, destination);
    };
    await assert.rejects(recordStore.withRecordStoreTransaction(MockUri.file(indexPath), async () => {
      assert.fail('no action may run without publication');
    }), (error) => error.cause === lastFault && /publish without an existing owner/.test(error.message));
    assert.ok(publicationAttempts > 1 && publicationAttempts <= 100);
    assert.deepEqual(await fsp.readdir(rootPath), []);
  } finally {
    fsp.rename = originalRename;
    Object.defineProperty(process, 'platform', platformDescriptor);
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

for (const operation of ['create', 'read', 'recover']) {
  test(`acquisition ${operation} filesystem failure is not reported as contention`, async () => {
    const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-lock-io-error-'));
    const indexPath = path.join(rootPath, 'index.json');
    const lockPath = `${indexPath}.lock`;
    const ownerPath = path.join(lockPath, 'owner.json');
    const originalMkdir = fsp.mkdir;
    const originalReadFile = fsp.readFile;
    const originalRename = fsp.rename;
    const fault = injectedFsError(operation === 'create' ? 'EEXIST' : 'EIO', operation, lockPath);
    try {
      if (operation !== 'create') {
        await fsp.mkdir(lockPath);
        await fsp.writeFile(ownerPath, JSON.stringify({
          ownerToken: 'dead-owner', pid: 2_147_483_647, createdAt: Date.now() - 60_000, indexPath
        }));
      }
      fsp.mkdir = async (target, ...options) => {
        if (operation === 'create' && String(target).startsWith(`${lockPath}.candidate-`)) throw fault;
        return originalMkdir(target, ...options);
      };
      fsp.readFile = async (target, ...options) => {
        if (operation === 'read' && String(target) === ownerPath) throw fault;
        return originalReadFile(target, ...options);
      };
      fsp.rename = async (source, destination) => {
        if (operation === 'recover' && String(source) === lockPath) throw fault;
        return originalRename(source, destination);
      };
      await assert.rejects(recordStore.withRecordStoreTransaction(MockUri.file(indexPath), async () => {
        assert.fail('acquisition failed');
      }), (error) => error.cause === fault && !/Timed out/.test(error.message));
    } finally {
      fsp.mkdir = originalMkdir;
      fsp.readFile = originalReadFile;
      fsp.rename = originalRename;
      await fsp.rm(rootPath, { recursive: true, force: true });
    }
  });
}

test('cleanup failure after owner-fenced release preserves the committed result and the next operation', async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-lock-release-residue-'));
  const indexPath = path.join(rootPath, 'index.json');
  const lockPath = `${indexPath}.lock`;
  const originalRm = fsp.rm;
  const originalWarn = console.warn;
  const fault = injectedFsError('EACCES', 'rm', lockPath);
  const warnings = [];
  let residuePath;
  try {
    console.warn = (...args) => { warnings.push(args); };
    fsp.rm = async (target, ...options) => {
      if (String(target) === residuePath) throw fault;
      return originalRm(target, ...options);
    };
    const result = await recordStore.withRecordStoreTransaction(MockUri.file(indexPath), async () => {
      const owner = JSON.parse(await fsp.readFile(path.join(lockPath, 'owner.json'), 'utf8'));
      residuePath = `${lockPath}.generation-owner-${owner.ownerToken}`;
      await fsp.writeFile(indexPath, 'committed\n');
      return 'committed';
    });
    assert.equal(result, 'committed');
    assert.equal(await fsp.readFile(indexPath, 'utf8'), 'committed\n');
    await assert.rejects(fsp.stat(lockPath), { code: 'ENOENT' });
    assert.equal((await fsp.stat(residuePath)).isDirectory(), true);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][1], fault);
    await recordStore.withRecordStoreTransaction(MockUri.file(indexPath), async () => undefined);
    assert.equal(warnings.length, 1, 'released residue must not be registered as a pending lock');
  } finally {
    fsp.rm = originalRm;
    console.warn = originalWarn;
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

for (const scenario of ['owner-read-gap', 'delayed-stale-recovery', 'delayed-young-observation']) {
  test(`async record-store recovery preserves a replacement owner: ${scenario}`, async () => {
    const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-lock-owner-replacement-'));
    const indexPath = path.join(rootPath, 'index.json');
    const lockPath = `${indexPath}.lock`;
    const ownerPath = path.join(lockPath, 'owner.json');
    const originalReadFile = fsp.readFile;
    const originalRename = fsp.rename;
    const originalNow = Date.now;
    let clockOffset = 0;
    const fencePath = scenario === 'delayed-stale-recovery'
      ? `${lockPath}.generation-owner-original`
      : path.join(rootPath, 'released-original');
    let replacementPublished = false;
    let replacementReleased = false;
    let replacementFenced = false;
    const publishReplacement = async () => {
      await originalRename(lockPath, fencePath);
      await fsp.mkdir(lockPath);
      await fsp.writeFile(ownerPath, JSON.stringify({
        ownerToken: 'replacement', pid: process.pid, createdAt: Date.now(), indexPath
      }));
      replacementPublished = true;
    };
    try {
      Date.now = () => originalNow() + clockOffset;
      await fsp.mkdir(lockPath);
      const createdAt = Date.now() - (scenario === 'delayed-stale-recovery' ? 60_000
        : scenario === 'delayed-young-observation' ? 29_000 : 1_000);
      await fsp.writeFile(ownerPath, JSON.stringify({
        ownerToken: 'original',
        pid: scenario === 'owner-read-gap' ? process.pid : 2_147_483_647,
        createdAt,
        indexPath
      }));
      await fsp.utimes(lockPath, new Date(createdAt), new Date(createdAt));
      fsp.readFile = async function readAcrossOwnerReplacement(target, ...options) {
        if (String(target) === ownerPath && !replacementPublished && scenario === 'owner-read-gap') {
          await publishReplacement();
          throw missingPathError(target);
        }
        const raw = await originalReadFile.call(this, target, ...options);
        if (String(target) === ownerPath && !replacementPublished && scenario === 'delayed-young-observation') {
          await publishReplacement();
          clockOffset = 2_000;
          return raw;
        }
        if (String(target) === ownerPath && replacementPublished && !replacementReleased
          && JSON.parse(String(raw)).ownerToken === 'replacement') {
          await originalRename(lockPath, path.join(rootPath, 'released-replacement'));
          replacementReleased = true;
        }
        return raw;
      };
      fsp.rename = async function fenceAcrossOwnerReplacement(source, destination) {
        const fencing = String(source) === lockPath && String(destination).startsWith(`${lockPath}.generation-`);
        if (fencing && !replacementPublished && scenario === 'delayed-stale-recovery') {
          await publishReplacement();
        }
        const targetsReplacement = fencing && replacementPublished && !replacementReleased;
        const result = await originalRename.call(this, source, destination);
        if (targetsReplacement) replacementFenced = true;
        return result;
      };
      let actionRuns = 0;
      await recordStore.withRecordStoreTransaction(MockUri.file(indexPath), async () => { actionRuns += 1; });
      assert.equal(replacementPublished, true);
      assert.equal(replacementFenced, false, 'A recovery attempt moved a newer live writer out of its lock.');
      assert.equal(replacementReleased, true);
      assert.equal(actionRuns, 1);
    } finally {
      fsp.readFile = originalReadFile;
      fsp.rename = originalRename;
      Date.now = originalNow;
      await fsp.rm(rootPath, { recursive: true, force: true });
    }
  });
}

test('sync storage recovery preserves a replacement owner when the previous owner file disappears', async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-sync-owner-replacement-'));
  const resourcePath = path.join(rootPath, 'index.json');
  const lockPath = `${resourcePath}.lock`;
  const ownerPath = path.join(lockPath, 'owner.json');
  const originalReadFile = fs.readFileSync;
  const originalRename = fs.renameSync;
  let replacementPublished = false;
  let replacementReleased = false;
  let replacementFenced = false;
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(ownerPath, JSON.stringify({
      ownerToken: 'original', pid: process.pid, createdAt: Date.now(), resource: resourcePath
    }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.readFileSync = function readAcrossOwnerReplacement(target, ...options) {
      if (String(target) === ownerPath && !replacementPublished) {
        originalRename(lockPath, path.join(rootPath, 'released-original'));
        fs.mkdirSync(lockPath);
        fs.writeFileSync(ownerPath, JSON.stringify({
          ownerToken: 'replacement', pid: process.pid, createdAt: Date.now(), resource: resourcePath
        }));
        replacementPublished = true;
        throw missingPathError(target);
      }
      const raw = originalReadFile.call(this, target, ...options);
      if (String(target) === ownerPath && replacementPublished && !replacementReleased
        && JSON.parse(String(raw)).ownerToken === 'replacement') {
        originalRename(lockPath, path.join(rootPath, 'released-replacement'));
        replacementReleased = true;
      }
      return raw;
    };
    fs.renameSync = function fenceAcrossOwnerReplacement(source, destination) {
      const targetsReplacement = String(source) === lockPath && replacementPublished && !replacementReleased;
      const result = originalRename.call(this, source, destination);
      if (targetsReplacement) replacementFenced = true;
      return result;
    };
    let actionRuns = 0;
    syncStorageResourceLock.withSyncStorageResourceLock(resourcePath, () => { actionRuns += 1; });
    assert.equal(replacementPublished, true);
    assert.equal(replacementFenced, false, 'Recovery moved a newer live writer out of its lock.');
    assert.equal(replacementReleased, true);
    assert.equal(actionRuns, 1);
  } finally {
    fs.readFileSync = originalReadFile;
    fs.renameSync = originalRename;
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test('async release retains only stale generation fences', async () => {
  const rootPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-record-store-release-fence-'));
  const indexPath = path.join(rootPath, 'index.json');
  const lockPath = `${indexPath}.lock`;
  const originalNow = Date.now;
  try {
    for (const heldMs of [0, 31_000]) {
      let owner;
      await recordStore.withRecordStoreTransaction(MockUri.file(indexPath), async () => {
        owner = JSON.parse(await fsp.readFile(path.join(lockPath, 'owner.json'), 'utf8'));
        Date.now = () => originalNow() + heldMs;
      });
      Date.now = originalNow;
      const artifacts = (await fsp.readdir(rootPath)).filter((name) => name.startsWith('index.json.lock'));
      const fenceName = `index.json.lock.generation-owner-${owner.ownerToken}`;
      assert.deepEqual(artifacts, heldMs === 0 ? [] : [fenceName]);
      if (heldMs > 0) {
        assert.deepEqual(JSON.parse(await fsp.readFile(path.join(rootPath, fenceName, 'owner.json'), 'utf8')), owner);
      }
    }
  } finally {
    Date.now = originalNow;
    await fsp.rm(rootPath, { recursive: true, force: true });
  }
});

test('sync lock publication classification is invariant when canonical state flips absent to present', windowsOnly, async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-sync-lock-state-flip-'));
  const resourcePath = path.join(tempRoot, 'index.json');
  const lockPath = `${resourcePath}.lock`;
  const originalRenameSync = fs.renameSync;
  const originalStatSync = fs.statSync;
  let publicationAttempts = 0;
  let canonicalStats = 0;
  try {
    fs.renameSync = function injectedRenameSync(source, destination) {
      const isPublication = String(destination) === lockPath
        && String(source).startsWith(`${lockPath}.candidate-`);
      if (isPublication && publicationAttempts++ === 0) throw injectedPublicationError(source, destination);
      return originalRenameSync.call(this, source, destination);
    };
    fs.statSync = function injectedStatSync(target, ...rest) {
      if (String(target) === lockPath) {
        canonicalStats += 1;
        if (canonicalStats === 1) throw missingPathError(target);
        if (canonicalStats === 2) return { isDirectory: () => true };
      }
      return originalStatSync.call(this, target, ...rest);
    };

    let actionRuns = 0;
    syncStorageResourceLock.withSyncStorageResourceLock(resourcePath, () => { actionRuns += 1; }, {
      waitMs: 1_000,
      pollIntervalMs: 1,
      maxRetries: 6,
      retryDelayMs: 1
    });
    assert.equal(actionRuns, 1);
    assert.equal(publicationAttempts, 2);
  } finally {
    fs.renameSync = originalRenameSync;
    fs.statSync = originalStatSync;
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test('async record-store lock publication classification is invariant when canonical state flips absent to present', windowsOnly, async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-async-lock-state-flip-'));
  const transactionPath = path.join(tempRoot, 'index.json');
  const lockPath = `${transactionPath}.lock`;
  const originalRename = fsp.rename;
  const originalStat = fsp.stat;
  let publicationAttempts = 0;
  let canonicalStats = 0;
  try {
    fsp.rename = async (source, destination) => {
      const isPublication = String(destination) === lockPath
        && String(source).startsWith(`${lockPath}.candidate-`);
      if (isPublication && publicationAttempts++ === 0) throw injectedPublicationError(source, destination);
      return originalRename(source, destination);
    };
    fsp.stat = async (target, ...rest) => {
      if (String(target) === lockPath) {
        canonicalStats += 1;
        if (canonicalStats === 1) throw missingPathError(target);
        if (canonicalStats === 2) return { isDirectory: () => true };
      }
      return originalStat(target, ...rest);
    };

    let actionRuns = 0;
    await recordStore.withRecordStoreTransaction(MockUri.file(transactionPath), async () => {
      actionRuns += 1;
    });
    assert.equal(actionRuns, 1);
    assert.equal(publicationAttempts, 2);
  } finally {
    fsp.rename = originalRename;
    fsp.stat = originalStat;
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test('sync stale-generation race immediately re-enters acquisition after another contender fences it', windowsOnly, async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-sync-lock-stale-race-'));
  const resourcePath = path.join(tempRoot, 'index.json');
  const lockPath = `${resourcePath}.lock`;
  const ownerToken = 'stale-generation-owner';
  const quarantinePath = `${lockPath}.generation-owner-${ownerToken}`;
  const originalRenameSync = fs.renameSync;
  let injectedFenceRace = false;
  try {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({
      ownerToken,
      pid: 2_147_483_647,
      createdAt: Date.now() - 60_000,
      resource: path.resolve(resourcePath)
    })}\n`);
    fs.renameSync = function raceGenerationFence(source, destination) {
      if (!injectedFenceRace && String(source) === lockPath && String(destination) === quarantinePath) {
        injectedFenceRace = true;
        originalRenameSync.call(this, source, destination);
        throw Object.assign(new Error('EEXIST: another contender already fenced the generation'), {
          code: 'EEXIST', syscall: 'rename', path: String(source), dest: String(destination)
        });
      }
      return originalRenameSync.call(this, source, destination);
    };

    let actionRuns = 0;
    syncStorageResourceLock.withSyncStorageResourceLock(resourcePath, () => { actionRuns += 1; }, {
      waitMs: 0,
      staleMs: 0,
      invalidMetadataWaitMs: 0,
      pollIntervalMs: 1,
      maxRetries: 2,
      retryDelayMs: 0
    });
    assert.equal(injectedFenceRace, true);
    assert.equal(actionRuns, 1);
  } finally {
    fs.renameSync = originalRenameSync;
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});
