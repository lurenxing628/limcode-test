const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

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
      createDirectory: (uri) => fs.mkdir(uri.fsPath, { recursive: true }),
      readDirectory: async (uri) => (await fs.readdir(uri.fsPath, { withFileTypes: true }))
        .map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]),
      readFile: (uri) => fs.readFile(uri.fsPath),
      writeFile: async (uri, data) => {
        await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
        await fs.writeFile(uri.fsPath, data);
      },
      delete: (uri) => fs.rm(uri.fsPath, { recursive: true, force: false })
    }
  }
};

const originalModuleLoad = Module._load;
Module._load = function loadWithVscodeMock(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalModuleLoad.call(this, request, parent, isMain);
};
const recordStore = require(path.join(
  process.cwd(),
  'dist/extension/backend/capabilities/vscodeStorage/recordStore.js'
));
Module._load = originalModuleLoad;

const workerMode = process.env.LIMCODE_STORAGE_LOCK_WORKER;
if (workerMode) {
  runWorker(workerMode).then(
    () => process.exit(0),
    (error) => {
      console.error(error?.stack ?? error);
      process.exit(1);
    }
  );
} else {
  test('real processes serialize one global record store without loss, duplication, or workspace/session contamination', {
    skip: process.platform !== 'win32',
    timeout: 120_000
  }, async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-record-store-process-stress-'));
    try {
      const workerCount = 4;
      const recordsPerWorker = 12;
      await Promise.all(Array.from({ length: workerCount }, (_, worker) => spawnWorker('writer', {
        LIMCODE_STORAGE_ROOT: rootPath,
        LIMCODE_STORAGE_WORKER_ID: String(worker),
        LIMCODE_STORAGE_RECORD_COUNT: String(recordsPerWorker)
      })));
      await assertStoreIntegrity(rootPath, workerCount, recordsPerWorker);
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  test('a crashed owner is fenced as one stale generation while concurrent successors preserve the index', {
    skip: process.platform !== 'win32',
    timeout: 120_000
  }, async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-record-store-crash-stress-'));
    const readyPath = path.join(rootPath, 'holder-ready');
    let holder;
    try {
      holder = spawnWorkerProcess('holder', {
        LIMCODE_STORAGE_ROOT: rootPath,
        LIMCODE_STORAGE_READY_PATH: readyPath
      });
      await waitForFile(readyPath, 10_000);
      holder.kill('SIGKILL');
      await waitForExit(holder, 10_000);
      holder = undefined;

      const lockPath = path.join(rootPath, 'index.json.lock');
      const ownerPath = path.join(lockPath, 'owner.json');
      const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
      owner.createdAt = Date.now() - 31_000;
      await fs.writeFile(ownerPath, `${JSON.stringify(owner)}\n`, 'utf8');

      const successorCount = 3;
      await Promise.all(Array.from({ length: successorCount }, (_, worker) => spawnWorker('writer', {
        LIMCODE_STORAGE_ROOT: rootPath,
        LIMCODE_STORAGE_WORKER_ID: String(worker),
        LIMCODE_STORAGE_RECORD_COUNT: '4'
      })));
      await assertStoreIntegrity(rootPath, successorCount, 4);
      const lockArtifacts = (await fs.readdir(rootPath)).filter((name) => name.startsWith('index.json.lock'));
      const fenceName = `index.json.lock.generation-owner-${owner.ownerToken}`;
      assert.deepEqual(lockArtifacts, [fenceName]);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(rootPath, fenceName, 'owner.json'), 'utf8')), owner);
    } finally {
      if (holder) {
        holder.kill('SIGKILL');
        await waitForExit(holder, 10_000).catch(() => undefined);
      }
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });
}

async function runWorker(mode) {
  const rootPath = requiredEnvironment('LIMCODE_STORAGE_ROOT');
  const root = MockUri.file(rootPath);
  const index = MockUri.file(path.join(rootPath, 'index.json'));
  if (mode === 'holder') {
    const readyPath = requiredEnvironment('LIMCODE_STORAGE_READY_PATH');
    await recordStore.withRecordStoreTransaction(index, async () => {
      await fs.writeFile(readyPath, 'ready\n', 'utf8');
      await new Promise((resolve) => {
        const timer = setInterval(() => undefined, 1_000);
        process.once('SIGTERM', () => {
          clearInterval(timer);
          resolve();
        });
      });
    });
    return;
  }
  if (mode !== 'writer') throw new Error(`Unknown worker mode: ${mode}`);
  const workerId = Number(requiredEnvironment('LIMCODE_STORAGE_WORKER_ID'));
  const recordCount = Number(requiredEnvironment('LIMCODE_STORAGE_RECORD_COUNT'));
  for (let ordinal = 0; ordinal < recordCount; ordinal += 1) {
    const id = `workspace-${workerId}:session-${ordinal}`;
    for (let attempt = 0; ; attempt += 1) {
      const snapshot = await recordStore.loadRecordStoreSnapshot(root, index, 'record');
      const records = snapshot?.records ?? [];
      if (records.some((record) => record.id === id)) break;
      const next = [...records, {
        id,
        workspaceId: `workspace-${workerId}`,
        sessionId: `session-${ordinal}`,
        writerPid: process.pid
      }].sort((left, right) => left.id.localeCompare(right.id));
      try {
        await recordStore.commitRecordStoreSnapshot(root, index, next, 'record', (record) => record.id, {
          expectedRevision: snapshot?.revision ?? recordStore.missingRecordStoreRevision(index),
          section: 'providers',
          pruneMissing: true
        });
        break;
      } catch (error) {
        if (!error?.settingsRevisionConflict || attempt >= 200) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1 + Math.floor(Math.random() * 4)));
      }
    }
  }
}

async function assertStoreIntegrity(rootPath, workerCount, recordsPerWorker) {
  const root = MockUri.file(rootPath);
  const indexUri = MockUri.file(path.join(rootPath, 'index.json'));
  const snapshot = await recordStore.loadRecordStoreSnapshot(root, indexUri, 'record');
  assert.ok(snapshot);
  const expectedCount = workerCount * recordsPerWorker;
  assert.equal(snapshot.records.length, expectedCount);
  assert.equal(new Set(snapshot.records.map((record) => record.id)).size, expectedCount);
  for (const record of snapshot.records) {
    const match = /^workspace-(\d+):session-(\d+)$/.exec(record.id);
    assert.ok(match, `unexpected record id: ${record.id}`);
    assert.equal(record.workspaceId, `workspace-${match[1]}`);
    assert.equal(record.sessionId, `session-${match[2]}`);
  }

  const index = JSON.parse(await fs.readFile(indexUri.fsPath, 'utf8'));
  assert.equal(index.records.length, expectedCount);
  assert.equal(new Set(index.records.map((record) => record.id)).size, expectedCount);
  assert.equal(new Set(index.records.map((record) => record.file)).size, expectedCount);
  const recordFiles = (await fs.readdir(path.join(rootPath, 'records')))
    .filter((name) => name.endsWith('.json'));
  assert.equal(recordFiles.length, expectedCount);
  for (const entry of index.records) {
    const stored = JSON.parse(await fs.readFile(path.join(rootPath, ...entry.file.split('/')), 'utf8'));
    assert.equal(stored.record.id, entry.id);
  }
}

function spawnWorker(mode, environment) {
  return waitForExit(spawnWorkerProcess(mode, environment), 120_000, true);
}

function spawnWorkerProcess(mode, environment) {
  return childProcess.spawn(process.execPath, [__filename], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...environment,
      LIMCODE_STORAGE_LOCK_WORKER: mode
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
}

function waitForExit(child, timeoutMs, rejectNonZero = false) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const settle = (code, signal) => {
      if (rejectNonZero && code !== 0) {
        reject(new Error(`storage worker failed (code=${code}, signal=${signal})\n${stdout}\n${stderr}`));
      } else {
        resolve({ code, signal, stdout, stderr });
      }
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      settle(child.exitCode, child.signalCode);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`storage worker timed out after ${timeoutMs}ms\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      settle(code, signal);
    });
  });
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.access(filePath);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment: ${name}`);
  return value;
}
