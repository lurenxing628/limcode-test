import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { syncDirectoryDurablySync } from '../capabilities/filesystem/durableDirectorySync';
import { resolveWindowsPowerShell } from '../capabilities/windowsPowerShell';
import * as path from 'node:path';
import {
  MAX_PROCESS_EXECUTION_TIMEOUT_MS,
  MAX_PROCESS_MAX_OUTPUT_BYTES,
  MIN_PROCESS_EXECUTION_TIMEOUT_MS,
  MIN_PROCESS_MAX_OUTPUT_BYTES,
  PROCESS_OUTPUT_MAX_CHUNK_BYTES,
  PROCESS_OUTPUT_MAX_FLUSH_DELAY_MS,
  PROCESS_OUTPUT_MAX_TERMINAL_TAIL_BYTES_PER_STREAM,
  PROCESS_TERMINATION_GRACE_MS,
  PROCESS_WRAPPER_BOOTSTRAP_FILE,
  PROCESS_WRAPPER_CHUNKS_DIRECTORY,
  PROCESS_WRAPPER_EXIT_RECEIPT_FILE,
  PROCESS_WRAPPER_IDENTITY_FILE,
  PROCESS_WRAPPER_LAUNCH_FAILURE_FILE,
  PROCESS_WRAPPER_MANIFEST_FILE,
  PROCESS_WRAPPER_PROTOCOL,
  PROCESS_WRAPPER_STOP_REQUEST_FILE,
  parseStopRequest,
  processChunkFileName,
  readDarwinProcessGroupFingerprints,
  readProcessStartFingerprint,
  type ProcessStopRequest,
  type ProcessStreamKind,
  type ProcessTerminationReason,
  type ProcessWrapperBootstrapPhase,
  type ProcessWrapperBootstrapReceipt,
  type ProcessWrapperExitReceipt,
  type ProcessWrapperIdentity,
  type ProcessWrapperLaunchFailureReceipt,
  type ProcessWrapperLaunchRequest,
  type ProcessWrapperManifest
} from './processProtocol';

const windowsProcessFingerprints = new Map<string, string>();
const PROCESS_WRAPPER_BOOTSTRAP_GATE_FILE = 'bootstrap.ready';
const PROCESS_WRAPPER_RENAME_MAX_ATTEMPTS = 6;
const PROCESS_WRAPPER_RENAME_RETRY_DELAY_MS = 15;

interface StreamState {
  tail: Buffer;
}

interface WrapperState {
  request: ProcessWrapperLaunchRequest;
  identity: ProcessWrapperIdentity;
  spoolPath: string;
  chunksPath: string;
  nextChunkSeq: bigint;
  retainedBytes: bigint;
  retainedChunks: bigint;
  droppedBytes: bigint;
  observedOutputBytes: bigint;
  truncated: boolean;
  stopRequested: boolean;
  terminationReason: Exclude<ProcessTerminationReason, 'natural'> | null;
  terminationWitnesses: Set<string>;
  forceKillTimer: NodeJS.Timeout | null;
  forceKillDueAt: number | null;
  deadlineTimer: NodeJS.Timeout | null;
  flushTimer: NodeJS.Timeout | null;
  stdout: StreamState;
  stderr: StreamState;
}

if (require.main === module) {
  runWrapper(process.argv[2]).catch((error) => {
    // Valid launch contracts publish a durable failure receipt before this bounded stderr fallback.
    console.error(`[limcode-process-wrapper] ${boundedErrorMessage(error)}`);
    process.exitCode = 1;
  });
}

async function runWrapper(requestPathInput: string | undefined): Promise<void> {
  if (!requestPathInput) throw new Error('Process wrapper requires a launch request path.');
  const requestPath = path.resolve(requestPathInput);
  const spoolPath = path.dirname(requestPath);
  const request = parseLaunchRequest(JSON.parse(fs.readFileSync(requestPath, 'utf8')));
  if (path.basename(spoolPath) !== request.spoolLocator) throw new Error('Launch request spool locator mismatch.');
  const chunksPath = path.join(spoolPath, PROCESS_WRAPPER_CHUNKS_DIRECTORY);
  let bootstrapPhase: ProcessWrapperBootstrapPhase = 'wrapper_spawned';
  let childPid: string | null = null;
  let child!: ReturnType<typeof spawn>;
  let exitPromise!: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  let closePromise!: Promise<void>;
  let identity!: ProcessWrapperIdentity;
  let state!: WrapperState;
  writeBootstrapReceipt(request, spoolPath, bootstrapPhase, childPid);

  try {
    fs.mkdirSync(chunksPath, { recursive: true });

    child = process.platform === 'win32'
      ? spawnWindowsPowerShellCommand(request, spoolPath)
      : (() => {
          const bashExecutable = '/bin/bash';
          const bootstrapCommand = `IFS= read -r _ <&3 || exit 125; exec ${bashExecutable} -c ${shellQuote(request.command)}`;
          return spawn(bootstrapCommand, {
            cwd: request.cwd,
            shell: bashExecutable,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
            windowsHide: true
          });
        })();
    exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    closePromise = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.once('error', () => resolve());
    });
    if (!child.pid) {
      await exitPromise;
      throw new Error('Detached wrapper did not observe a child PID.');
    }
    childPid = String(child.pid);
    bootstrapPhase = 'child_spawned';
    writeBootstrapReceipt(request, spoolPath, bootstrapPhase, childPid);

    let startFingerprint: string;
    try {
      startFingerprint = readProcessStartFingerprint(childPid);
    } catch (error) {
      await abortBlockedChild(childPid, exitPromise);
      throw error;
    }
    if (process.platform === 'win32') windowsProcessFingerprints.set(childPid, startFingerprint);
    identity = {
      kind: PROCESS_WRAPPER_PROTOCOL,
      processId: request.processId,
      stableNonce: request.stableNonce,
      wrapperPid: String(process.pid),
      childPid,
      processGroupId: childPid,
      startFingerprint,
      commandDigest: request.commandDigest,
      spoolLocator: request.spoolLocator,
      startedAt: new Date().toISOString()
    };
    state = {
      request,
      identity,
      spoolPath,
      chunksPath,
      nextChunkSeq: 1n,
      retainedBytes: 0n,
      retainedChunks: 0n,
      droppedBytes: 0n,
      observedOutputBytes: 0n,
      truncated: false,
      stopRequested: false,
      terminationReason: null,
      terminationWitnesses: new Set(),
      forceKillTimer: null,
      forceKillDueAt: null,
      deadlineTimer: null,
      flushTimer: null,
      stdout: { tail: Buffer.alloc(0) },
      stderr: { tail: Buffer.alloc(0) }
    };
    try {
      writeAtomicJson(path.join(spoolPath, PROCESS_WRAPPER_IDENTITY_FILE), identity);
      writeManifest(state, 'running');
    } catch (error) {
      await abortBlockedChild(childPid, exitPromise);
      throw error;
    }
  } catch (error) {
    if (childPid && exitPromise) await abortBlockedChild(childPid, exitPromise).catch(() => undefined);
    try {
      writeLaunchFailureReceipt(request, spoolPath, bootstrapPhase, childPid, error);
    } catch (receiptError) {
      console.error(`[limcode-process-wrapper] launch failure receipt: ${boundedErrorMessage(receiptError, request, spoolPath)}`);
    }
    throw error;
  }

  child.stdout?.on('data', (chunk: Buffer | string) => retainOutput(state, 'stdout', Buffer.from(chunk)));
  child.stderr?.on('data', (chunk: Buffer | string) => retainOutput(state, 'stderr', Buffer.from(chunk)));
  const stopPoll = setInterval(() => {
    observeProcessGroup(state);
    observeStopRequest(state);
  }, Math.min(100, PROCESS_OUTPUT_MAX_FLUSH_DELAY_MS));
  state.deadlineTimer = scheduleExecutionDeadline(state);
  try {
    if (process.platform === 'win32') {
      writeAtomicBytes(
        path.join(spoolPath, PROCESS_WRAPPER_BOOTSTRAP_GATE_FILE),
        Buffer.from('ready\n', 'utf8')
      );
    } else {
      const bootstrapGate = child.stdio[3];
      if (!bootstrapGate || typeof (bootstrapGate as NodeJS.WritableStream).end !== 'function') {
        throw new Error('Detached wrapper bootstrap pipe is unavailable.');
      }
      (bootstrapGate as NodeJS.WritableStream).end('\n');
    }
  } catch (error) {
    clearInterval(stopPoll);
    clearWatchdogTimers(state);
    await abortBlockedChild(childPid, exitPromise).catch(() => undefined);
    try {
      writeLaunchFailureReceipt(request, spoolPath, 'child_spawned', childPid, error);
    } catch (receiptError) {
      console.error(`[limcode-process-wrapper] launch failure receipt: ${boundedErrorMessage(receiptError, request, spoolPath)}`);
    }
    throw error;
  }
  bootstrapPhase = 'identity_ready';
  try {
    writeBootstrapReceipt(request, spoolPath, bootstrapPhase, childPid);
  } catch (error) {
    // identity.json is already durable authority. Bootstrap progress is best-effort from here.
    console.error(`[limcode-process-wrapper] ${boundedErrorMessage(error, request, spoolPath)}`);
  }

  const exit = await exitPromise.finally(() => clearInterval(stopPoll));
  if (state.deadlineTimer) {
    clearTimeout(state.deadlineTimer);
    state.deadlineTimer = null;
  }
  await awaitTerminationEscalation(state);
  if (state.terminationReason === null) await terminateNaturalExitDescendants(state);
  clearWatchdogTimers(state);
  await drainChildOutputStreams(child, closePromise);

  cancelScheduledFlush(state);
  retainTerminalTail(state, 'stdout');
  retainTerminalTail(state, 'stderr');
  writeManifest(state, 'exited');
  const receipt: ProcessWrapperExitReceipt = {
    kind: PROCESS_WRAPPER_PROTOCOL,
    processId: identity.processId,
    stableNonce: identity.stableNonce,
    wrapperPid: identity.wrapperPid,
    childPid: identity.childPid,
    processGroupId: identity.processGroupId,
    startFingerprint: identity.startFingerprint,
    commandDigest: identity.commandDigest,
    exitCode: exit.code === null ? null : String(exit.code),
    signal: exit.signal,
    exitedAt: new Date().toISOString(),
    retainedBytes: state.retainedBytes.toString(),
    retainedChunks: state.retainedChunks.toString(),
    droppedBytes: state.droppedBytes.toString(),
    truncated: state.truncated,
    stopRequested: state.stopRequested,
    terminationReason: state.terminationReason ?? 'natural',
    executionDeadlineAt: request.executionDeadlineAt,
    maxOutputBytes: request.maxOutputBytes
  };
  // The atomic exit receipt is the only cross-host terminal authority.
  writeAtomicJson(path.join(spoolPath, PROCESS_WRAPPER_EXIT_RECEIPT_FILE), receipt);
}

async function drainChildOutputStreams(
  child: ReturnType<typeof spawn>,
  closePromise: Promise<void>
): Promise<void> {
  let closed = false;
  await Promise.race([
    closePromise.then(() => { closed = true; }),
    new Promise((resolve) => setTimeout(resolve, PROCESS_OUTPUT_MAX_FLUSH_DELAY_MS))
  ]);
  if (closed) return;
  // A descendant that escaped the ordinary process group may still own the inherited pipes. It
  // must not keep the wrapper alive or delay the leader's exit receipt indefinitely.
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function retainOutput(state: WrapperState, streamKind: ProcessStreamKind, bytes: Buffer): void {
  if (bytes.length === 0) return;
  const previousObserved = state.observedOutputBytes;
  state.observedOutputBytes += BigInt(bytes.length);
  let accepted = bytes;
  if (state.request.maxOutputBytes !== null) {
    const remaining = BigInt(state.request.maxOutputBytes) - previousObserved;
    const acceptedLength = remaining <= 0n
      ? 0
      : Number(remaining < BigInt(bytes.length) ? remaining : BigInt(bytes.length));
    if (acceptedLength < bytes.length) {
      accepted = bytes.subarray(0, acceptedLength);
      state.droppedBytes += BigInt(bytes.length - acceptedLength);
      state.truncated = true;
    }
  }
  if (accepted.length > 0) retainAcceptedOutput(state, streamKind, accepted);
  if (
    state.request.maxOutputBytes !== null
    && state.observedOutputBytes >= BigInt(state.request.maxOutputBytes)
  ) {
    requestTermination(state, 'output_limit_exceeded');
  }
}

function retainAcceptedOutput(state: WrapperState, streamKind: ProcessStreamKind, bytes: Buffer): void {
  const stream = state[streamKind];
  const combined = Buffer.concat([stream.tail, bytes]);
  const tailBudget = PROCESS_OUTPUT_MAX_TERMINAL_TAIL_BYTES_PER_STREAM;
  const flushBytes = Math.max(0, combined.length - tailBudget);
  if (flushBytes > 0) retainRegularBytes(state, streamKind, combined.subarray(0, flushBytes));
  stream.tail = Buffer.from(combined.subarray(flushBytes));
  scheduleRunningFlush(state);
}

function retainRegularBytes(state: WrapperState, streamKind: ProcessStreamKind, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const length = Math.min(PROCESS_OUTPUT_MAX_CHUNK_BYTES, bytes.length - offset);
    writeChunk(state, streamKind, bytes.subarray(offset, offset + length));
    offset += length;
  }
}

function retainTerminalTail(state: WrapperState, streamKind: ProcessStreamKind): void {
  const stream = state[streamKind];
  const tail = stream.tail;
  if (tail.length === 0) return;
  writeChunk(state, streamKind, tail);
  stream.tail = Buffer.alloc(0);
}

function writeChunk(state: WrapperState, streamKind: ProcessStreamKind, bytes: Buffer): void {
  if (bytes.length <= 0 || bytes.length > PROCESS_OUTPUT_MAX_CHUNK_BYTES) {
    throw new Error('Process wrapper chunk exceeds frozen maxChunkBytes.');
  }
  const fileName = processChunkFileName(state.nextChunkSeq, streamKind);
  writeAtomicBytes(path.join(state.chunksPath, fileName), bytes);
  state.nextChunkSeq += 1n;
  state.retainedBytes += BigInt(bytes.length);
  state.retainedChunks += 1n;
}

function observeStopRequest(state: WrapperState): void {
  if (state.terminationReason !== null) return;
  const requestPath = path.join(state.spoolPath, PROCESS_WRAPPER_STOP_REQUEST_FILE);
  let parsed: ProcessStopRequest;
  try {
    parsed = parseStopRequest(JSON.parse(fs.readFileSync(requestPath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    console.warn(`[limcode-process-wrapper] ignored invalid stop request: ${boundedErrorMessage(error)}`);
    return;
  }
  const identity = state.identity;
  if (
    parsed.processId !== identity.processId
    || parsed.stableNonce !== identity.stableNonce
    || parsed.startFingerprint !== identity.startFingerprint
    || parsed.processGroupId !== identity.processGroupId
    || parsed.commandDigest !== identity.commandDigest
  ) return;
  // Re-check the live child start fingerprint immediately before signaling its process group.
  // If the child just exited, leave the wrapper alive so its close path can publish the exit receipt.
  try {
    if (readProcessStartFingerprint(identity.childPid) !== identity.startFingerprint) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  requestTermination(state, 'manual');
}

function scheduleExecutionDeadline(state: WrapperState): NodeJS.Timeout | null {
  const deadlineAt = state.request.executionDeadlineAt;
  if (deadlineAt === null) return null;
  const delay = Math.max(0, Date.parse(deadlineAt) - Date.now());
  const timer = setTimeout(() => requestTermination(state, 'timed_out'), delay);
  timer.unref();
  return timer;
}

function requestTermination(
  state: WrapperState,
  reason: Exclude<ProcessTerminationReason, 'natural'>
): boolean {
  if (state.terminationReason !== null) return false;
  const identity = state.identity;
  // Capture process-group birth witnesses before the first signal. A later escalation only targets
  // the group while at least one original member remains, preventing PGID reuse from hitting an
  // unrelated process while still covering descendants whose group leader exits on SIGTERM.
  const witnesses = readProcessGroupFingerprints(identity.processGroupId);
  if (!witnesses.has(identity.startFingerprint)) return false;
  state.terminationWitnesses = witnesses;
  state.terminationReason = reason;
  state.stopRequested = reason === 'manual';
  signalProcessGroup(identity.processGroupId, 'SIGTERM');
  for (const witness of readProcessGroupFingerprints(identity.processGroupId)) {
    state.terminationWitnesses.add(witness);
  }
  state.forceKillDueAt = Date.now() + PROCESS_TERMINATION_GRACE_MS;
  state.forceKillTimer = setTimeout(() => {
    try {
      const current = readProcessGroupFingerprints(identity.processGroupId);
      if (![...current].some((fingerprint) => state.terminationWitnesses.has(fingerprint))) return;
      signalProcessGroup(identity.processGroupId, 'SIGKILL');
    } finally {
      state.forceKillTimer = null;
      state.forceKillDueAt = null;
    }
  }, PROCESS_TERMINATION_GRACE_MS);
  state.forceKillTimer.unref();
  return true;
}

function observeProcessGroup(state: WrapperState): void {
  const current = readProcessGroupFingerprints(state.identity.processGroupId);
  if (
    state.terminationWitnesses.size === 0
    || [...current].some((fingerprint) => state.terminationWitnesses.has(fingerprint))
    || current.has(state.identity.startFingerprint)
  ) {
    state.terminationWitnesses.add(state.identity.startFingerprint);
    for (const fingerprint of current) state.terminationWitnesses.add(fingerprint);
  }
}

/** A shell leader may exit after spawning ordinary background descendants in the same group. */
async function terminateNaturalExitDescendants(state: WrapperState): Promise<void> {
  if (process.platform === 'win32') return;
  const identity = state.identity;
  const current = readProcessGroupFingerprints(identity.processGroupId);
  if (current.size === 0) return;
  // This runs immediately after the recorded group leader exits. A still-populated PGID is the
  // command's surviving process group; the kernel cannot recycle it while those members remain.
  for (const fingerprint of current) state.terminationWitnesses.add(fingerprint);
  signalProcessGroup(identity.processGroupId, 'SIGTERM');
  const deadline = Date.now() + PROCESS_TERMINATION_GRACE_MS;
  let remaining = current;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    remaining = readProcessGroupFingerprints(identity.processGroupId);
    if (![...remaining].some((fingerprint) => state.terminationWitnesses.has(fingerprint))) return;
  }
  if ([...remaining].some((fingerprint) => state.terminationWitnesses.has(fingerprint))) {
    signalProcessGroup(identity.processGroupId, 'SIGKILL');
  }
}

function signalProcessGroup(processGroupId: string, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    const pid = Number(processGroupId);
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') return;
      }
      throw new Error(`taskkill failed for process tree ${pid}: ${(result.stderr || result.stdout || '').trim()}`);
    }
    return;
  }
  try {
    process.kill(-Number(processGroupId), signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function clearWatchdogTimers(state: WrapperState): void {
  if (state.deadlineTimer) clearTimeout(state.deadlineTimer);
  if (state.forceKillTimer) clearTimeout(state.forceKillTimer);
  state.deadlineTimer = null;
  state.forceKillTimer = null;
  state.forceKillDueAt = null;
}

async function awaitTerminationEscalation(state: WrapperState): Promise<void> {
  if (!state.forceKillTimer || state.forceKillDueAt === null) return;
  const current = readProcessGroupFingerprints(state.identity.processGroupId);
  const originalGroupStillExists = [...current]
    .some((fingerprint) => state.terminationWitnesses.has(fingerprint));
  if (!originalGroupStillExists) {
    clearTimeout(state.forceKillTimer);
    state.forceKillTimer = null;
    state.forceKillDueAt = null;
    return;
  }
  // An original witness proves this is still the same process group, so descendants discovered now
  // may safely witness the delayed group-wide SIGKILL even if the original leader exits meanwhile.
  for (const fingerprint of current) state.terminationWitnesses.add(fingerprint);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, state.forceKillDueAt! - Date.now()) + 25));
}

function readProcessGroupFingerprints(processGroupId: string): Set<string> {
  if (process.platform === 'win32') {
    const fingerprints = new Set<string>();
    try {
      process.kill(Number(processGroupId), 0);
      const fingerprint = windowsProcessFingerprints.get(processGroupId)
        ?? readProcessStartFingerprint(processGroupId);
      fingerprints.add(fingerprint);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ESRCH' && code !== 'EACCES' && code !== 'EPERM') {
        throw error;
      }
    }
    return fingerprints;
  }
  if (process.platform === 'darwin') return readDarwinProcessGroupFingerprints(processGroupId);
  if (process.platform !== 'linux') {
    throw Object.assign(
      new Error(`Process-group inspection is not supported on ${process.platform}/${process.arch}.`),
      { code: 'ENOSYS' }
    );
  }
  const expectedGroup = BigInt(processGroupId);
  const fingerprints = new Set<string>();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) continue;
      const fieldsFromState = stat.slice(close + 2).trim().split(/\s+/);
      const group = fieldsFromState[2];
      const startTicks = fieldsFromState[19];
      if (!group || !startTicks || BigInt(group) !== expectedGroup || !/^\d+$/.test(startTicks)) continue;
      fingerprints.add(`linux-proc:${BigInt(entry).toString()}:${BigInt(startTicks).toString()}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ESRCH' && code !== 'EACCES' && code !== 'EPERM') {
        throw error;
      }
    }
  }
  return fingerprints;
}

function scheduleRunningFlush(state: WrapperState): void {
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    try {
      flushRunningState(state);
    } catch (error) {
      // A live preview is observational. The final manifest and exit receipt still get their own
      // write attempt after the child exits, so a transient preview write cannot lose termination.
      console.warn(`[limcode-process-wrapper] live preview flush failed: ${boundedErrorMessage(error)}`);
    }
  }, PROCESS_OUTPUT_MAX_FLUSH_DELAY_MS);
  state.flushTimer.unref();
}

function cancelScheduledFlush(state: WrapperState): void {
  if (!state.flushTimer) return;
  clearTimeout(state.flushTimer);
  state.flushTimer = null;
}

function flushRunningState(state: WrapperState): void {
  writeManifest(state, 'running');
}

function writeManifest(state: WrapperState, status: ProcessWrapperManifest['status']): void {
  const stdoutTailBase64 = state.stdout.tail.toString('base64');
  const stderrTailBase64 = state.stderr.tail.toString('base64');
  const manifest: ProcessWrapperManifest = {
    kind: PROCESS_WRAPPER_PROTOCOL,
    processId: state.identity.processId,
    stableNonce: state.identity.stableNonce,
    status,
    nextChunkSeq: state.nextChunkSeq.toString(),
    retainedBytes: state.retainedBytes.toString(),
    retainedChunks: state.retainedChunks.toString(),
    droppedBytes: state.droppedBytes.toString(),
    truncated: state.truncated,
    stdoutTailBytes: String(state.stdout.tail.length),
    stdoutTailSha256: createHash('sha256').update(state.stdout.tail).digest('hex'),
    stdoutTailBase64,
    stderrTailBytes: String(state.stderr.tail.length),
    stderrTailSha256: createHash('sha256').update(state.stderr.tail).digest('hex'),
    stderrTailBase64,
    updatedAt: new Date().toISOString()
  };
  writeAtomicJson(path.join(state.spoolPath, PROCESS_WRAPPER_MANIFEST_FILE), manifest);
}

function parseLaunchRequest(value: unknown): ProcessWrapperLaunchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid process launch request.');
  const record = value as Record<string, unknown>;
  const legacyKeys = [
    'kind', 'processId', 'stableNonce', 'command', 'cwd', 'commandDigest', 'spoolLocator', 'createdAt'
  ].sort();
  const currentKeys = [
    ...legacyKeys,
    'executionTimeoutMs', 'executionDeadlineAt', 'maxOutputBytes'
  ].sort();
  const actual = Object.keys(record).sort();
  const legacy = sameKeys(actual, legacyKeys);
  if (!legacy && !sameKeys(actual, currentKeys)) {
    throw new TypeError('Process launch request fields do not match wrapper contract.');
  }
  if (record.kind !== PROCESS_WRAPPER_PROTOCOL) throw new TypeError('Invalid process launch request kind.');
  const text = (field: string): string => {
    const current = record[field];
    if (typeof current !== 'string' || current.length === 0) throw new TypeError(`Invalid launch request ${field}.`);
    return current;
  };
  const digest = text('commandDigest');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError('Invalid launch request commandDigest.');
  const locator = text('spoolLocator');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(locator)) throw new TypeError('Invalid launch request spoolLocator.');
  const createdAt = text('createdAt');
  if (!Number.isFinite(Date.parse(createdAt))) throw new TypeError('Invalid launch request createdAt.');

  let executionTimeoutMs: number | null = null;
  let executionDeadlineAt: string | null = null;
  let maxOutputBytes: number | null = null;
  if (!legacy) {
    executionTimeoutMs = nullableBoundedInteger(
      record.executionTimeoutMs,
      'executionTimeoutMs',
      MIN_PROCESS_EXECUTION_TIMEOUT_MS,
      MAX_PROCESS_EXECUTION_TIMEOUT_MS
    );
    executionDeadlineAt = nullableTimestamp(record.executionDeadlineAt, 'executionDeadlineAt');
    maxOutputBytes = nullableBoundedInteger(
      record.maxOutputBytes,
      'maxOutputBytes',
      MIN_PROCESS_MAX_OUTPUT_BYTES,
      MAX_PROCESS_MAX_OUTPUT_BYTES
    );
    const allNull = executionTimeoutMs === null && executionDeadlineAt === null && maxOutputBytes === null;
    const allPresent = executionTimeoutMs !== null && executionDeadlineAt !== null && maxOutputBytes !== null;
    if (!allNull && !allPresent) throw new TypeError('Process launch watchdog fields must be all present or all null.');
    if (allPresent) {
      const expectedDeadline = Date.parse(createdAt) + executionTimeoutMs!;
      if (Date.parse(executionDeadlineAt!) !== expectedDeadline) {
        throw new TypeError('Process launch executionDeadlineAt does not match createdAt + executionTimeoutMs.');
      }
    }
  }
  return {
    kind: PROCESS_WRAPPER_PROTOCOL,
    processId: text('processId'),
    stableNonce: text('stableNonce'),
    command: text('command'),
    cwd: text('cwd'),
    commandDigest: digest,
    spoolLocator: locator,
    executionTimeoutMs,
    executionDeadlineAt,
    maxOutputBytes,
    createdAt
  };
}

function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nullableBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Invalid launch request ${label}.`);
  }
  return value;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`Invalid launch request ${label}.`);
  }
  return value;
}

async function abortBlockedChild(
  childPid: string,
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
): Promise<void> {
  try {
    if (process.platform === 'win32') signalProcessGroup(childPid, 'SIGKILL');
    else process.kill(-Number(childPid), 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  await exitPromise.catch(() => undefined);
}

function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

function spawnWindowsPowerShellCommand(
  request: ProcessWrapperLaunchRequest,
  spoolPath: string
): ReturnType<typeof spawn> {
  const powerShell = resolveWindowsPowerShell();
  const needsDesktopStatusFix = powerShell.edition === 'desktop';
  const gatePath = path.join(spoolPath, PROCESS_WRAPPER_BOOTSTRAP_GATE_FILE);
  const quotedGatePath = `'${gatePath.split("'").join("''")}'`;
  const prelude = [
    ...(needsDesktopStatusFix ? [
      `$limcodeCommandText = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(request.command, 'utf8').toString('base64')}'))`,
      `$limcodeTokens = $null; $limcodeParseErrors = $null`,
      `$limcodeCommandAst = [System.Management.Automation.Language.Parser]::ParseInput($limcodeCommandText, [ref]$limcodeTokens, [ref]$limcodeParseErrors)`,
      `$limcodeLastStatement = @($limcodeCommandAst.EndBlock.Statements)[-1]`,
      `$limcodeLastPipelineElement = if ($limcodeLastStatement -is [System.Management.Automation.Language.PipelineAst] -and $limcodeLastStatement.PipelineElements.Count -eq 1) { $limcodeLastStatement.PipelineElements[0] } else { $null }`,
      `$limcodeParenExpression = if ($limcodeLastPipelineElement -is [System.Management.Automation.Language.CommandExpressionAst] -and $limcodeLastPipelineElement.Expression -is [System.Management.Automation.Language.ParenExpressionAst]) { $limcodeLastPipelineElement.Expression } else { $null }`,
      `$limcodeParenPipelineElements = if ($null -ne $limcodeParenExpression) { @($limcodeParenExpression.Pipeline.PipelineElements) } else { @() }`,
      `$limcodeParenCommandName = if ($limcodeParenPipelineElements.Count -eq 1 -and $limcodeParenPipelineElements[0] -is [System.Management.Automation.Language.CommandAst]) { $limcodeParenPipelineElements[0].GetCommandName() } else { $null }`,
      `$limcodeErrorCount = $Error.Count`
    ] : []),
    `$LASTEXITCODE = $null`
  ].join('; ');
  const checkExitStatus = [
    `$limcodeCommandSucceeded = $?; $limcodeNativeExitCode = $LASTEXITCODE`,
    `if (-not $limcodeCommandSucceeded) { if ($null -ne $limcodeNativeExitCode -and $limcodeNativeExitCode -ne 0) { exit $limcodeNativeExitCode }; exit 1 }`
  ];
  const epilogue = [
    ...checkExitStatus,
    ...(needsDesktopStatusFix ? [
      `$limcodeCommandAddedError = $Error.Count -gt $limcodeErrorCount`,
      // Resolve the direct parenthesized command after execution so script-defined functions and aliases win.
      `$limcodeParenCommandInfo = if ($null -ne $limcodeParenCommandName) { Get-Command -Name $limcodeParenCommandName -ErrorAction SilentlyContinue } else { $null }`,
      `$limcodeParenthesizedNativeCommand = $null -ne $limcodeParenCommandInfo -and ($limcodeParenCommandInfo.CommandType -eq [System.Management.Automation.CommandTypes]::Application -or $limcodeParenCommandInfo.CommandType -eq [System.Management.Automation.CommandTypes]::ExternalScript)`,
      `if ($limcodeParenthesizedNativeCommand -and $null -ne $limcodeNativeExitCode -and $limcodeNativeExitCode -ne 0) { exit $limcodeNativeExitCode }`,
      `if ($null -ne $limcodeParenExpression -and $limcodeCommandAddedError) { exit 1 }`
    ] : []),
    `exit 0`
  ].join('; ');
  // Semicolons would put the whole script on one line, so a trailing `#` comment in the command would
  // comment the epilogue out and lose the exit code, and a parse error would report its column against
  // the prelude. Newlines fix both; the prelude stays a single line so the reported line number is
  // always the command's own line plus one.
  const script = `${prelude}\n${request.command}\n${epilogue}`;
  const scriptPath = path.join(spoolPath, 'command.ps1');
  fs.writeFileSync(scriptPath, `\uFEFF${script}`, 'utf8');
  const bootstrap = [
    `$ProgressPreference = 'SilentlyContinue'`,
    `$gatePath = ${quotedGatePath}`,
    `while (-not (Test-Path -LiteralPath $gatePath)) { Start-Sleep -Milliseconds 10 }`,
    `Remove-Item -LiteralPath $gatePath -Force -ErrorAction SilentlyContinue`,
    `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`,
    `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)`,
    `if ($null -ne $PSStyle) { $PSStyle.OutputRendering = 'PlainText'; $PSStyle.Formatting.Error = ''; $PSStyle.Formatting.ErrorAccent = ''; $PSStyle.Formatting.Warning = ''; $PSStyle.Formatting.Verbose = ''; $PSStyle.Formatting.Debug = '' }`,
    // Group policies (AllSigned/Restricted) reject unsigned script files, and the process-scope
    // -ExecutionPolicy Bypass cannot override them — but execution policies only govern script
    // files. Once the gate opens, read the spooled script back and run it as in-memory command
    // text, the same trust level as an inline -Command, instead of loading the .ps1 as a script.
    // ReadAllText honors the BOM, so 5.1 still decodes the spooled UTF-8 correctly, and creating
    // the ScriptBlock parses the whole text up front, preserving whole-file parse semantics.
    `$limcodeScriptText = [System.IO.File]::ReadAllText('${scriptPath.split("'").join("''")}')`,
    `. ([ScriptBlock]::Create($limcodeScriptText))`,
    ...checkExitStatus,
    `exit 0`
  ].join('; ');
  return spawn(powerShell.executable, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-OutputFormat',
    'Text',
    '-Command',
    bootstrap
  ], {
    cwd: request.cwd,
    env: { ...process.env, TERM: 'dumb', PYTHONIOENCODING: 'utf-8' },
    // The Wrapper process itself is detached. A second detached PowerShell with piped output exits
    // before the bootstrap gate on Windows, so it remains attached to the durable Wrapper.
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
}

function writeBootstrapReceipt(
  request: ProcessWrapperLaunchRequest,
  spoolPath: string,
  phase: ProcessWrapperBootstrapPhase,
  childPid: string | null
): void {
  const receipt: ProcessWrapperBootstrapReceipt = {
    kind: PROCESS_WRAPPER_PROTOCOL,
    processId: request.processId,
    stableNonce: request.stableNonce,
    wrapperPid: String(process.pid),
    childPid,
    commandDigest: request.commandDigest,
    spoolLocator: request.spoolLocator,
    phase,
    updatedAt: new Date().toISOString()
  };
  writeAtomicJson(path.join(spoolPath, PROCESS_WRAPPER_BOOTSTRAP_FILE), receipt);
}

function writeLaunchFailureReceipt(
  request: ProcessWrapperLaunchRequest,
  spoolPath: string,
  phase: Exclude<ProcessWrapperBootstrapPhase, 'identity_ready'>,
  childPid: string | null,
  error: unknown
): void {
  const candidate = error as { name?: unknown; code?: unknown };
  const receipt: ProcessWrapperLaunchFailureReceipt = {
    kind: PROCESS_WRAPPER_PROTOCOL,
    processId: request.processId,
    stableNonce: request.stableNonce,
    wrapperPid: String(process.pid),
    childPid,
    commandDigest: request.commandDigest,
    spoolLocator: request.spoolLocator,
    phase,
    commandReleased: false,
    errorName: boundedMetadataText(candidate.name, 'Error', 128),
    errorCode: typeof candidate.code === 'string'
      ? boundedMetadataText(candidate.code, 'UNKNOWN', 128)
      : null,
    errorMessage: boundedErrorMessage(error, request, spoolPath),
    failedAt: new Date().toISOString()
  };
  writeAtomicJson(path.join(spoolPath, PROCESS_WRAPPER_LAUNCH_FAILURE_FILE), receipt);
}

function writeAtomicJson(filePath: string, value: unknown): void {
  writeAtomicBytes(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

function writeAtomicBytes(filePath: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  renameAtomicFileSync(temporary, filePath);
  syncDirectoryDurablySync(path.dirname(filePath));
}

function renameAtomicFileSync(sourcePath: string, targetPath: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(sourcePath, targetPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transientWindowsBusy = process.platform === 'win32'
        && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY');
      if (!transientWindowsBusy || attempt >= PROCESS_WRAPPER_RENAME_MAX_ATTEMPTS) throw error;
      const delayMs = PROCESS_WRAPPER_RENAME_RETRY_DELAY_MS * attempt;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}

function boundedErrorMessage(
  error: unknown,
  request?: ProcessWrapperLaunchRequest,
  spoolPath?: string
): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const [sensitive, replacement] of [
    [request?.command, '[command]'],
    [request?.cwd, '[cwd]'],
    [spoolPath, '[spool]']
  ] as const) {
    if (sensitive) message = message.split(sensitive).join(replacement);
  }
  return boundedMetadataText(message.replace(/[\r\n\t]+/g, ' '), 'Unknown wrapper failure.', 2_048);
}

function boundedMetadataText(value: unknown, fallback: string, maximumLength: number): string {
  const text = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
    : '';
  return (text || fallback).slice(0, maximumLength);
}
