import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { kernel, kernelFile, repo, removeConfigurationRoot } from './fixtures/runtime-merge-fixture.mjs';

const protocol = kernelFile('processProtocol.js');
const linuxOnly = { skip: process.platform !== 'linux' };
const CHILD_PID = '2147483600';
const WRAPPER_PID = '2147483601';
const STAT_PATH = `/proc/${CHILD_PID}/stat`;
const CMDLINE_PATH = `/proc/${WRAPPER_PID}/cmdline`;
const EMPTY_DIGEST = createHash('sha256').update('').digest('hex');
const MARKER = 'proc-stat-exit-race-verified\n';

function procStat(startTicks = '12345') {
  const fields = Array(20).fill('0');
  fields[0] = 'R';
  fields[19] = startTicks;
  return `${CHILD_PID} (test child) ${fields.join(' ')}\n`;
}

function interceptStat(t, readStat, launchPath) {
  const original = fsSync.readFileSync;
  t.mock.method(fsSync, 'readFileSync', function (file, ...args) {
    if (file === STAT_PATH) return readStat();
    if (launchPath && file === CMDLINE_PATH) return Buffer.from(`node\0${launchPath}\0`);
    return original.call(this, file, ...args);
  });
}

function identityFor(request) {
  return {
    kind: protocol.PROCESS_WRAPPER_PROTOCOL,
    processId: request.processId,
    stableNonce: request.stableNonce,
    wrapperPid: WRAPPER_PID,
    childPid: CHILD_PID,
    processGroupId: CHILD_PID,
    startFingerprint: `linux-proc:${CHILD_PID}:12345`,
    commandDigest: request.commandDigest,
    spoolLocator: request.spoolLocator,
    startedAt: new Date().toISOString()
  };
}

function exitReceiptFor(identity, request) {
  return {
    kind: identity.kind,
    processId: identity.processId,
    stableNonce: identity.stableNonce,
    wrapperPid: identity.wrapperPid,
    childPid: identity.childPid,
    processGroupId: identity.processGroupId,
    startFingerprint: identity.startFingerprint,
    commandDigest: identity.commandDigest,
    exitCode: '0', signal: null, exitedAt: new Date().toISOString(),
    retainedBytes: String(Buffer.byteLength(MARKER)), retainedChunks: '1',
    droppedBytes: '0', truncated: false, stopRequested: false,
    terminationReason: 'natural',
    executionDeadlineAt: new Date(Date.now() + request.executionTimeoutMs).toISOString(),
    maxOutputBytes: request.maxOutputBytes
  };
}

function manifestFor(identity) {
  return {
    kind: identity.kind, processId: identity.processId, stableNonce: identity.stableNonce,
    status: 'exited', nextChunkSeq: '2', retainedBytes: String(Buffer.byteLength(MARKER)),
    retainedChunks: '1', droppedBytes: '0', truncated: false,
    stdoutTailBytes: '0', stdoutTailSha256: EMPTY_DIGEST, stdoutTailBase64: '',
    stderrTailBytes: '0', stderrTailSha256: EMPTY_DIGEST, stderrTailBase64: '',
    updatedAt: new Date().toISOString()
  };
}

const writeJson = (file, value) => fsSync.writeFileSync(file, `${JSON.stringify(value)}\n`);

// These probes exercise the actual fs boundary. Parsing errors and denied/indeterminate reads
// must never be promoted to a missing child, even though ESRCH and ENOENT both mean it vanished.
test('Linux proc-stat normalizes only the read-time ESRCH disappearance', linuxOnly, async (t) => {
  await t.test('ESRCH becomes the existing missing-process error with its cause intact', (sub) => {
    const cause = Object.assign(new Error('ESRCH: no such process, read'), { code: 'ESRCH' });
    interceptStat(sub, () => { throw cause; });
    assert.throws(() => protocol.readLinuxStartFingerprint(CHILD_PID), (error) =>
      error.code === 'ENOENT' && error.cause === cause && error.message.includes(CHILD_PID));
  });
  for (const code of ['ENOENT', 'EACCES', 'EPERM', 'EIO', 'EAGAIN']) {
    await t.test(`${code} is not reclassified or hidden`, (sub) => {
      const cause = Object.assign(new Error(`original ${code}`), { code });
      interceptStat(sub, () => { throw cause; });
      assert.throws(() => protocol.readLinuxStartFingerprint(CHILD_PID), (error) => error === cause);
    });
  }
  for (const malformed of ['', `${CHILD_PID} (test child) R 0`, procStat('not-ticks')]) {
    await t.test(`malformed stat remains unprovable: ${JSON.stringify(malformed)}`, (sub) => {
      interceptStat(sub, () => malformed);
      assert.throws(() => protocol.readLinuxStartFingerprint(CHILD_PID), (error) =>
        error.code !== 'ENOENT' && /Cannot parse|Cannot read start time/.test(error.message));
    });
  }
  await t.test('valid stat keeps its exact start fingerprint', (sub) => {
    interceptStat(sub, () => procStat());
    assert.equal(protocol.readLinuxStartFingerprint(CHILD_PID), `linux-proc:${CHILD_PID}:12345`);
  });
});

for (const code of ['ESRCH', 'ENOENT']) {
  test(`foreground ${code} while the wrapper is reachable preserves the eventual receipt and output`, linuxOnly, async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-process-stat-race-'));
    let database;
    let processes;
    try {
      const candidate = await kernel.resetCandidateRuntimeRoot(parent);
      database = await kernel.RuntimeDatabase.open(candidate.authority, { hostBootId: 'process-stat-race' });
      const store = kernel.ContentAddressedStore.forDatabase(candidate.authority, database);
      const effects = new kernel.EffectControlPlane(database, store);
      processes = new kernel.ProcessControlPlane(database, store, effects, candidate.authority, candidate.binding);
      const now = new Date().toISOString();
      await database.transaction([
        repo('Conversation').insert({ id: 'conversation', title: 'race', status: 'active', created_at: now, updated_at: now }),
        repo('Turn').insert({ id: 'turn', conversation_id: 'conversation', status: 'active', created_at: now, updated_at: now, terminal_at: null }),
        repo('ExecutionLease').insert({ id: 'lease', conversation_id: 'conversation', turn_id: 'turn', owner_id: 'owner',
          host_boot_id: database.hostBootId, generation: 1n, acquired_at: now, expires_at: '2099-01-01T00:00:00.000Z' })
      ]);
      const toolCallId = 'tool';
      await effects.createToolCall({ source: { kind: 'callback', key: 'tool' }, toolCallId, turnId: 'turn',
        toolName: 'bash', arguments: { command: 'fixture command is never spawned' } });
      const prepared = await processes.prepareStart({ source: { kind: 'internal', key: 'prepare' }, toolCallId,
        command: 'fixture command is never spawned', cwd: parent });
      const identity = identityFor(prepared.request);
      const exitReceipt = exitReceiptFor(identity, prepared.request);
      const spoolPath = protocol.processSpoolPath(candidate.binding, prepared.request.spoolLocator);
      const launchPath = path.join(spoolPath, 'launch.json');
      await fs.mkdir(path.join(spoolPath, 'chunks'), { recursive: true });
      writeJson(path.join(spoolPath, protocol.PROCESS_WRAPPER_IDENTITY_FILE), identity);
      writeJson(launchPath, prepared.request);
      let launches = 0;
      t.mock.method(processes, 'launchDispatched', async () => {
        launches += 1;
        return { outcome: 'succeeded', identity };
      });
      let fingerprintReads = 0;
      interceptStat(t, () => {
        fingerprintReads += 1;
        // observeVerifiedIdentity already missed the receipt and verified the exact wrapper
        // command line. Publish its matching terminal evidence at the failing child read.
        fsSync.writeFileSync(path.join(spoolPath, 'chunks', protocol.processChunkFileName(1n, 'stdout')), MARKER);
        writeJson(path.join(spoolPath, protocol.PROCESS_WRAPPER_MANIFEST_FILE), manifestFor(identity));
        writeJson(path.join(spoolPath, protocol.PROCESS_WRAPPER_EXIT_RECEIPT_FILE), exitReceipt);
        throw Object.assign(new Error(`${code}: no such process, read`), { code });
      }, launchPath);

      const dispatched = await processes.dispatchStart(prepared.effect.effectIntentId, 5_000);
      assert.equal(fingerprintReads, 1, 'the exit race must actually be exercised once');
      assert.equal(launches, 1);
      assert.equal(dispatched.observation.outcome, 'succeeded');
      assert.equal(dispatched.observation.foreground.state, 'exited');
      assert.equal(dispatched.observation.foreground.receipt.exitCode, '0');
      assert.equal(dispatched.terminal.status, 'succeeded');
      const reads = [
        repo('Process').get(prepared.request.processId),
        repo('ProcessReceipt').list({ where: { process_id: prepared.request.processId }, limit: 2 }),
        repo('ProcessOutputChunk').list({ where: { process_id: prepared.request.processId }, limit: 2 }),
        repo('EffectReceipt').list({ where: { attempt_id: prepared.effect.attemptId }, limit: 2 }),
        repo('ToolOutcome').list({ where: { tool_call_id: toolCallId }, limit: 2 }),
        repo('ToolResultArtifact').list({ where: { tool_call_id: toolCallId, role: 'model_response' }, limit: 2 })
      ];
      const [processRow, receipts, chunks, effectReceipts, outcomes, artifacts] = (await database.snapshot(reads)).snapshot;
      assert.equal(processRow.status, 'exited');
      assert.equal(processRow.retained_bytes, BigInt(Buffer.byteLength(MARKER)));
      assert.equal(processRow.retained_chunks, 1n);
      assert.equal(processRow.dropped_bytes, 0n);
      assert.equal(processRow.truncated, 0n);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].outcome, 'succeeded');
      assert.equal(receipts[0].exit_code, 0n);
      assert.equal(chunks.length, 1);
      assert.equal(effectReceipts.length, 1);
      assert.equal(effectReceipts[0].outcome, 'succeeded');
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].status, 'succeeded');
      assert.equal(artifacts.length, 1);
      for (const row of [outcomes[0], artifacts[0]]) {
        const [metadata] = (await database.snapshot([repo('ContentObject').get(row.content_object_id)])).snapshot;
        const body = JSON.parse((await store.read(metadata)).toString('utf8'));
        assert.equal(body.status, 'succeeded');
        assert.equal(body.detail.exitCode, 0);
        assert.equal(body.detail.stdout, MARKER);
        assert.equal(body.detail.complete, true);
        assert.equal(body.detail.terminationReason, 'natural');
        assert.equal(body.detail.outputPreviewUnavailable, undefined);
      }
      const replay = await processes.reconcileStartReceipt(effectReceipts[0].id);
      assert.equal(replay.toolModelResultId, dispatched.terminal.toolModelResultId);
      assert.deepEqual((await database.snapshot(reads)).snapshot, [processRow, receipts, chunks, effectReceipts, outcomes, artifacts]);
      assert.equal(launches, 1, 'receipt reconciliation cannot redispatch the command');
    } finally {
      t.mock.restoreAll();
      await processes?.dispose();
      await database?.close();
      await removeConfigurationRoot(parent);
    }
  });
}

test('foreground identity and receipt mismatches still fail closed', linuxOnly, async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-process-stat-identity-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const request = { processId: 'process', stableNonce: 'nonce', commandDigest: 'a'.repeat(64),
    spoolLocator: 'process', executionTimeoutMs: 10_000, maxOutputBytes: 1024 };
  const identity = identityFor(request);
  const receipt = exitReceiptFor(identity, request);
  const receiptPath = path.join(parent, protocol.PROCESS_WRAPPER_EXIT_RECEIPT_FILE);
  const observe = () => kernel.ProcessControlPlane.prototype.observeVerifiedIdentity.call({
    recordTerminalReceiptMetric() { assert.fail('unverified evidence cannot record terminal receipt'); }
  }, identity, parent);
  await t.test('ESRCH without terminal evidence stays running rather than inventing an exit', async (sub) => {
    interceptStat(sub, () => { throw Object.assign(new Error('ESRCH: no such process, read'), { code: 'ESRCH' }); }, path.join(parent, 'launch.json'));
    assert.deepEqual(await observe(), { state: 'running', processId: identity.processId });
  });
  await t.test('live child fingerprint mismatch is unknown', async (sub) => {
    interceptStat(sub, () => procStat('67890'), path.join(parent, 'launch.json'));
    const observed = await observe();
    assert.equal(observed.state, 'outcome_unknown');
    assert.match(observed.reason, /no longer matches.*start fingerprint/);
  });
  await t.test('permission failure remains unknown', async (sub) => {
    interceptStat(sub, () => { throw Object.assign(new Error('EACCES: denied proc stat'), { code: 'EACCES' }); }, path.join(parent, 'launch.json'));
    const observed = await observe();
    assert.equal(observed.state, 'outcome_unknown');
    assert.match(observed.reason, /EACCES/);
  });
  for (const field of ['stableNonce', 'startFingerprint', 'commandDigest', 'wrapperPid']) {
    await t.test(`atomic receipt ${field} mismatch after ESRCH is unknown`, async (sub) => {
      await fs.rm(receiptPath, { force: true });
      interceptStat(sub, () => { throw Object.assign(new Error('ESRCH: no such process, read'), { code: 'ESRCH' }); }, path.join(parent, 'launch.json'));
      assert.deepEqual(await observe(), { state: 'running', processId: identity.processId });
      writeJson(receiptPath, { ...receipt, [field]: field === 'commandDigest' ? 'b'.repeat(64) : field === 'wrapperPid' ? '1' : 'different' });
      const observed = await observe();
      assert.equal(observed.state, 'outcome_unknown');
      assert.match(observed.reason, /Atomic wrapper exit receipt identity mismatch/);
    });
  }
});
