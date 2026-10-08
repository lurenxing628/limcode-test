import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiled, 'backend/reliableKernel/index.js'));
const repo = domain => kernel.DOMAIN_REPOSITORIES.domain(domain);
const emptyDigest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

test('process output reuses validated prefixes, checks new rows and invalidates foreign changes', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-output-prefix-'));
  let database, processes;
  try {
    const candidate = await kernel.resetCandidateRuntimeRoot(temporary);
    database = await kernel.RuntimeDatabase.open(candidate.authority);
    const store = kernel.ContentAddressedStore.forDatabase(candidate.authority, database);
    processes = new kernel.ProcessControlPlane(database, store, new kernel.EffectControlPlane(database, store), candidate.authority, candidate.binding);
    const processId = 'output-prefix-process', now = new Date().toISOString();
    const identity = { kind: kernel.PROCESS_WRAPPER_PROTOCOL, processId, stableNonce: '1'.repeat(32),
      wrapperPid: '2147483601', childPid: '2147483600', processGroupId: '2147483600',
      startFingerprint: 'fixture-fingerprint', commandDigest: 'a'.repeat(64), spoolLocator: 'output-prefix', startedAt: now };
    await database.transaction([repo('Process').insert({ id: processId, status: 'running', wrapper_nonce: identity.stableNonce,
      wrapper_pid: BigInt(identity.wrapperPid), child_pid: BigInt(identity.childPid), process_group_id: BigInt(identity.processGroupId),
      start_fingerprint: identity.startFingerprint, command_digest: identity.commandDigest, spool_locator: identity.spoolLocator,
      retained_bytes: 0n, retained_chunks: 0n, dropped_bytes: 0n, truncated: 0n, started_at: now, updated_at: now, completed_at: null })]);
    const spoolPath = kernel.processSpoolPath(candidate.binding, identity.spoolLocator);
    await fs.mkdir(path.join(spoolPath, 'chunks'), { recursive: true });
    const identityPath = path.join(spoolPath, kernel.PROCESS_WRAPPER_IDENTITY_FILE);
    await fs.writeFile(identityPath, JSON.stringify(identity));
    let chunkCount = 0, retainedBytes = 0, status = 'running';
    const publishManifest = () => fs.writeFile(path.join(spoolPath, kernel.PROCESS_WRAPPER_MANIFEST_FILE), JSON.stringify({
      kind: identity.kind, processId, stableNonce: identity.stableNonce, status,
      nextChunkSeq: String(chunkCount + 1), retainedBytes: String(retainedBytes), retainedChunks: String(chunkCount),
      droppedBytes: '0', truncated: false, stdoutTailBytes: '0', stdoutTailSha256: emptyDigest, stdoutTailBase64: '',
      stderrTailBytes: '0', stderrTailSha256: emptyDigest, stderrTailBase64: '', updatedAt: now
    }));
    const append = async text => {
      const bytes = Buffer.from(text);
      retainedBytes += bytes.length;
      await fs.writeFile(path.join(spoolPath, 'chunks', kernel.processChunkFileName(BigInt(++chunkCount), 'stdout')), bytes);
      await publishManifest();
    };
    const gets = [], originalSnapshot = database.snapshot.bind(database), originalSnapshotAll = database.snapshotAll.bind(database);
    let fullScans = 0;
    database.snapshot = async (reads, ...args) => {
      gets.push(...reads.filter(read => read.domain === 'ProcessOutputChunk' && read.kind === 'get').map(read => read.id));
      return originalSnapshot(reads, ...args);
    };
    database.snapshotAll = async (read, ...args) => {
      if (read.domain === 'ProcessOutputChunk') fullScans++;
      return originalSnapshotAll(read, ...args);
    };
    await append('one'); await append('two'); await append('three');
    assert.equal((await processes.reconcileOutput(processId)).insertedChunks, 3);
    gets.length = 0;
    assert.equal((await processes.reconcileOutput(processId)).insertedChunks, 0);
    assert.deepEqual(gets, [], 'unchanged running output does not reread its registered prefix');
    await append('four');
    gets.length = 0;
    assert.equal((await processes.reconcileOutput(processId)).insertedChunks, 1);
    assert.deepEqual(new Set(gets), new Set([kernel.stablePhaseDId('process_output_chunk', `${processId}:4`)]),
      'the new immutable suffix still receives ordinary identity and commit checks');

    await fs.writeFile(identityPath, JSON.stringify({ ...identity, stableNonce: 'wrong-spool' }));
    await assert.rejects(processes.reconcileOutput(processId), /identity does not match/);
    await fs.writeFile(identityPath, JSON.stringify(identity));
    status = 'exited'; await publishManifest();
    await database.transaction([repo('Process').update(processId, { status: 'exited', completed_at: now, updated_at: now })]);
    fullScans = 0;
    await processes.snapshotOutputForDetail(processId);
    assert.equal(fullScans, 1, 'the two terminal checks share one exact-prefix proof');
    fullScans = 0;
    await processes.snapshotOutputForDetail(processId);
    assert.equal(fullScans, 0, 'a verified terminal prefix is reused on later detail reads');

    // Use a separate OS process: opening/closing the live SQLite file in this process would drop
    // its POSIX locks. The foreign deletion must invalidate the cached proof and be recovered.
    const foreignWrite = (sql, parameters) => {
      const changed = spawnSync(process.execPath, ['-e',
        'const D=require(process.argv[1]); const d=new D(process.argv[2]); d.prepare(process.argv[3]).run(...JSON.parse(process.argv[4])); d.close();',
        require.resolve('better-sqlite3'), candidate.binding.paths.databasePath, sql, JSON.stringify(parameters)], { encoding: 'utf8' });
      assert.equal(changed.status, 0, changed.stderr);
    };
    foreignWrite('DELETE FROM process_output_chunk WHERE process_id = ? AND chunk_seq = 2', [processId]);
    gets.length = 0;
    assert.equal((await processes.reconcileOutput(processId)).insertedChunks, 1);
    assert.ok(gets.includes(kernel.stablePhaseDId('process_output_chunk', `${processId}:1`)), 'foreign changes force a fresh full-prefix proof');
    assert.equal((await processes.readOutputPage(processId)).stdout, 'onetwothreefour');

    await fs.rm(spoolPath, { recursive: true });
    await processes.dispose();
    processes = new kernel.ProcessControlPlane(database, store, new kernel.EffectControlPlane(database, store), candidate.authority, candidate.binding);
    let changedDuringTerminalScan = false;
    fullScans = 0;
    database.snapshotAll = async (read, ...args) => {
      const snapshot = await originalSnapshotAll(read, ...args);
      if (read.domain === 'ProcessOutputChunk') {
        fullScans++;
        if (!changedDuringTerminalScan) {
          changedDuringTerminalScan = true;
          foreignWrite('INSERT INTO conversation (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            ['unrelated-conversation', 'unrelated foreign write', 'active', now, now]);
        }
      }
      return snapshot;
    };
    const historical = await processes.snapshotOutputForDetail(processId);
    assert.equal(historical.retainedBytes, String(retainedBytes));
    assert.equal(changedDuringTerminalScan, true);
    assert.equal(fullScans, 2, 'a fence change retries the complete history scan without reopening a deleted spool');
    assert.equal((await processes.readOutputPage(processId)).stdout, 'onetwothreefour');

    foreignWrite('INSERT INTO conversation (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['before-fence-flood', 'force a cold proof', 'active', now, now]);
    fullScans = 0;
    database.snapshotAll = async (read, ...args) => {
      const snapshot = await originalSnapshotAll(read, ...args);
      if (read.domain === 'ProcessOutputChunk') {
        fullScans++;
        foreignWrite('INSERT INTO conversation (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          [`during-fence-flood-${fullScans}`, 'unrelated ongoing foreign writes', 'active', now, now]);
      }
      return snapshot;
    };
    await assert.rejects(processes.reconcileOutput(processId), error =>
      error.name === 'ProcessOutputSnapshotAdvancedError' && error.reason === 'proof_fence');
    assert.equal(fullScans, 4, 'unrelated writes do not create an unbounded no-progress retry loop');

    let firstInnerChange = true, afterReconcile = false, detailChanges = 0, reconciliations = 0;
    const advanceDetailFence = () => foreignWrite(
      'INSERT INTO conversation (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [`detail-proof-change-${++detailChanges}`, 'detail verification race', 'active', now, now]);
    const originalReconcile = processes.reconcileOutputBounded.bind(processes);
    processes.reconcileOutputBounded = async (...args) => {
      reconciliations++;
      const result = await originalReconcile(...args);
      advanceDetailFence();
      afterReconcile = true;
      return result;
    };
    fullScans = 0;
    database.snapshotAll = async (read, ...args) => {
      const snapshot = await originalSnapshotAll(read, ...args);
      if (read.domain === 'ProcessOutputChunk') {
        fullScans++;
        if (firstInnerChange || afterReconcile) {
          firstInnerChange = false;
          afterReconcile = false;
          advanceDetailFence();
        }
      }
      return snapshot;
    };
    const busyHistory = await processes.snapshotOutputForDetail(processId);
    assert.equal(busyHistory.retainedBytes, String(retainedBytes));
    assert.equal(reconciliations, 3, 'one inner failure leaves three attempts for the outer detail checks');
    assert.equal(fullScans, 7, 'inner and outer verification share the four failed-fence attempts');

    const originalValidate = candidate.authority.validate.bind(candidate.authority);
    candidate.authority.validate = async () => { throw new Error('fixture root fenced'); };
    try { await assert.rejects(processes.snapshotOutputForDetail(processId), /root fenced/); }
    finally { candidate.authority.validate = originalValidate; }
  } finally {
    await processes?.dispose();
    await database?.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
