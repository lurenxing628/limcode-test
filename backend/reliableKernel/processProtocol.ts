import { createHash } from 'node:crypto';
import { decodeCanonicalBase64 } from '../capabilities/canonicalBase64';
import { resolveWindowsPowerShell } from '../capabilities/windowsPowerShell';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RootBinding } from './contracts';

export const PROCESS_OUTPUT_MAX_CHUNK_BYTES = 65_536;
export const PROCESS_OUTPUT_MAX_TERMINAL_TAIL_BYTES_PER_STREAM = 32_768;
export const PROCESS_OUTPUT_MAX_FLUSH_DELAY_MS = 250;
export const PROCESS_SPOOL_DIRECTORY = 'process-spool';
export const PROCESS_WRAPPER_IDENTITY_FILE = 'identity.json';
export const PROCESS_WRAPPER_BOOTSTRAP_FILE = 'bootstrap-receipt.json';
export const PROCESS_WRAPPER_LAUNCH_FAILURE_FILE = 'launch-failure-receipt.json';
export const PROCESS_WRAPPER_MANIFEST_FILE = 'manifest.json';
export const PROCESS_WRAPPER_EXIT_RECEIPT_FILE = 'exit-receipt.json';
export const PROCESS_WRAPPER_STOP_REQUEST_FILE = 'stop-request.json';
export const PROCESS_WRAPPER_CHUNKS_DIRECTORY = 'chunks';
export const PROCESS_WRAPPER_PROTOCOL = 'limcode-process-wrapper';
export const DEFAULT_PROCESS_EXECUTION_TIMEOUT_MS = 120_000;
export const MIN_PROCESS_EXECUTION_TIMEOUT_MS = 1_000;
export const MAX_PROCESS_EXECUTION_TIMEOUT_MS = 600_000;
export const DEFAULT_PROCESS_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
export const MIN_PROCESS_MAX_OUTPUT_BYTES = 1024;
export const MAX_PROCESS_MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
export const PROCESS_TERMINATION_GRACE_MS = 2_000;

export type ProcessStreamKind = 'stdout' | 'stderr';
export type ProcessTerminationReason = 'natural' | 'manual' | 'timed_out' | 'output_limit_exceeded';

export interface ProcessWrapperLaunchRequest {
  kind: typeof PROCESS_WRAPPER_PROTOCOL;
  processId: string;
  stableNonce: string;
  command: string;
  cwd: string;
  commandDigest: string;
  spoolLocator: string;
  /** Null is accepted only for launch contracts written by an older runtime. */
  executionTimeoutMs: number | null;
  executionDeadlineAt: string | null;
  maxOutputBytes: number | null;
  createdAt: string;
}

export type ProcessWrapperBootstrapPhase = 'wrapper_spawned' | 'child_spawned' | 'identity_ready';

export interface ProcessWrapperBootstrapReceipt {
  kind: typeof PROCESS_WRAPPER_PROTOCOL;
  processId: string;
  stableNonce: string;
  wrapperPid: string;
  childPid: string | null;
  commandDigest: string;
  spoolLocator: string;
  phase: ProcessWrapperBootstrapPhase;
  updatedAt: string;
}

export interface ProcessWrapperLaunchFailureReceipt {
  kind: typeof PROCESS_WRAPPER_PROTOCOL;
  processId: string;
  stableNonce: string;
  wrapperPid: string;
  childPid: string | null;
  commandDigest: string;
  spoolLocator: string;
  phase: Exclude<ProcessWrapperBootstrapPhase, 'identity_ready'>;
  commandReleased: false;
  errorName: string;
  errorCode: string | null;
  errorMessage: string;
  failedAt: string;
}

export interface ProcessWrapperIdentity {
  kind: typeof PROCESS_WRAPPER_PROTOCOL;
  processId: string;
  stableNonce: string;
  wrapperPid: string;
  childPid: string;
  processGroupId: string;
  startFingerprint: string;
  commandDigest: string;
  spoolLocator: string;
  startedAt: string;
}

export interface ProcessWrapperManifest {
  kind: typeof PROCESS_WRAPPER_PROTOCOL;
  processId: string;
  stableNonce: string;
  status: 'running' | 'exited';
  nextChunkSeq: string;
  retainedBytes: string;
  retainedChunks: string;
  droppedBytes: string;
  truncated: boolean;
  stdoutTailBytes: string;
  stdoutTailSha256: string;
  stdoutTailBase64: string;
  stderrTailBytes: string;
  stderrTailSha256: string;
  stderrTailBase64: string;
  updatedAt: string;
}

export interface ProcessWrapperExitReceipt {
  kind: typeof PROCESS_WRAPPER_PROTOCOL;
  processId: string;
  stableNonce: string;
  wrapperPid: string;
  childPid: string;
  processGroupId: string;
  startFingerprint: string;
  commandDigest: string;
  exitCode: string | null;
  signal: string | null;
  exitedAt: string;
  retainedBytes: string;
  retainedChunks: string;
  droppedBytes: string;
  truncated: boolean;
  stopRequested: boolean;
  terminationReason: ProcessTerminationReason;
  /** Null denotes a legacy wrapper that started before watchdog contracts existed. */
  executionDeadlineAt: string | null;
  maxOutputBytes: number | null;
}

export interface ProcessStopRequest {
  kind: typeof PROCESS_WRAPPER_PROTOCOL;
  processId: string;
  stableNonce: string;
  startFingerprint: string;
  processGroupId: string;
  commandDigest: string;
  requestedAt: string;
}

export interface ProcessSpoolChunk {
  chunkSeq: string;
  streamKind: ProcessStreamKind;
  path: string;
  byteLength: string;
}

export function processSpoolRoot(binding: RootBinding): string {
  return path.join(binding.paths.dataRootPath, PROCESS_SPOOL_DIRECTORY);
}

export function processSpoolPath(binding: RootBinding, spoolLocatorInput: string): string {
  const locator = requireLocator(spoolLocatorInput);
  const root = path.resolve(processSpoolRoot(binding));
  const candidate = path.resolve(root, locator);
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error('Process spool locator escapes the active RootBinding.');
  return candidate;
}

export function processChunkFileName(
  chunkSeqInput: string | bigint,
  streamKind: ProcessStreamKind
): string {
  const chunkSeq = typeof chunkSeqInput === 'bigint'
    ? chunkSeqInput
    : BigInt(requireDecimalString(chunkSeqInput, 'chunkSeq'));
  if (chunkSeq <= 0n) throw new TypeError('chunkSeq must be positive.');
  if (streamKind !== 'stdout' && streamKind !== 'stderr') throw new TypeError('Invalid process stream kind.');
  return `${chunkSeq.toString().padStart(20, '0')}-${streamKind}.bin`;
}

export function listProcessSpoolChunks(spoolPath: string): ProcessSpoolChunk[] {
  const chunksRoot = path.join(spoolPath, PROCESS_WRAPPER_CHUNKS_DIRECTORY);
  let names: string[];
  try {
    names = fs.readdirSync(chunksRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.flatMap((name): ProcessSpoolChunk[] => {
    const match = /^(\d+)-(stdout|stderr)\.bin$/.exec(name);
    if (!match) return [];
    const sequence = BigInt(match[1]).toString();
    const filePath = path.join(chunksRoot, name);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return [];
    return [{
      chunkSeq: sequence,
      streamKind: match[2] as ProcessStreamKind,
      path: filePath,
      byteLength: BigInt(stat.size).toString()
    }];
  }).sort((left, right) => compareDecimal(left.chunkSeq, right.chunkSeq));
}

export function parseWrapperBootstrapReceipt(value: unknown): ProcessWrapperBootstrapReceipt {
  const record = exactRecord(value, [
    'kind', 'processId', 'stableNonce', 'wrapperPid', 'childPid', 'commandDigest',
    'spoolLocator', 'phase', 'updatedAt'
  ], 'ProcessWrapperBootstrapReceipt');
  if (record.kind !== PROCESS_WRAPPER_PROTOCOL) throw new TypeError('Invalid ProcessWrapperBootstrapReceipt.kind.');
  const phase = requireBootstrapPhase(record.phase);
  const childPid = record.childPid === null ? null : requireDecimalString(record.childPid, 'childPid');
  if ((phase === 'wrapper_spawned') !== (childPid === null)) {
    throw new TypeError('ProcessWrapperBootstrapReceipt childPid does not match phase.');
  }
  return {
    kind: PROCESS_WRAPPER_PROTOCOL,
    processId: requireText(record.processId, 'processId'),
    stableNonce: requireText(record.stableNonce, 'stableNonce'),
    wrapperPid: requireDecimalString(record.wrapperPid, 'wrapperPid'),
    childPid,
    commandDigest: requireSha256(record.commandDigest, 'commandDigest'),
    spoolLocator: requireLocator(record.spoolLocator),
    phase,
    updatedAt: requireIsoTimestamp(record.updatedAt, 'updatedAt')
  };
}

export function parseWrapperLaunchFailureReceipt(value: unknown): ProcessWrapperLaunchFailureReceipt {
  const record = exactRecord(value, [
    'kind', 'processId', 'stableNonce', 'wrapperPid', 'childPid', 'commandDigest',
    'spoolLocator', 'phase', 'commandReleased', 'errorName', 'errorCode', 'errorMessage', 'failedAt'
  ], 'ProcessWrapperLaunchFailureReceipt');
  if (record.kind !== PROCESS_WRAPPER_PROTOCOL) throw new TypeError('Invalid ProcessWrapperLaunchFailureReceipt.kind.');
  const phase = requireBootstrapPhase(record.phase);
  if (phase === 'identity_ready') throw new TypeError('Launch failure cannot follow identity_ready.');
  const childPid = record.childPid === null ? null : requireDecimalString(record.childPid, 'childPid');
  if ((phase === 'wrapper_spawned') !== (childPid === null)) {
    throw new TypeError('ProcessWrapperLaunchFailureReceipt childPid does not match phase.');
  }
  if (record.commandReleased !== false) throw new TypeError('Launch failure must prove commandReleased=false.');
  const errorCode = record.errorCode === null ? null : requireBoundedText(record.errorCode, 'errorCode', 128);
  return {
    kind: PROCESS_WRAPPER_PROTOCOL,
    processId: requireText(record.processId, 'processId'),
    stableNonce: requireText(record.stableNonce, 'stableNonce'),
    wrapperPid: requireDecimalString(record.wrapperPid, 'wrapperPid'),
    childPid,
    commandDigest: requireSha256(record.commandDigest, 'commandDigest'),
    spoolLocator: requireLocator(record.spoolLocator),
    phase,
    commandReleased: false,
    errorName: requireBoundedText(record.errorName, 'errorName', 128),
    errorCode,
    errorMessage: requireBoundedText(record.errorMessage, 'errorMessage', 2_048),
    failedAt: requireIsoTimestamp(record.failedAt, 'failedAt')
  };
}

export function parseWrapperIdentity(value: unknown): ProcessWrapperIdentity {
  const record = exactRecord(value, [
    'kind', 'processId', 'stableNonce', 'wrapperPid', 'childPid', 'processGroupId',
    'startFingerprint', 'commandDigest', 'spoolLocator', 'startedAt'
  ], 'ProcessWrapperIdentity');
  if (record.kind !== PROCESS_WRAPPER_PROTOCOL) throw new TypeError('Invalid ProcessWrapperIdentity.kind.');
  const childPid = requireDecimalString(record.childPid, 'childPid');
  const group = requireDecimalString(record.processGroupId, 'processGroupId');
  if (childPid !== group) throw new Error('Detached child process group must equal childPid.');
  return {
    kind: PROCESS_WRAPPER_PROTOCOL,
    processId: requireText(record.processId, 'processId'),
    stableNonce: requireText(record.stableNonce, 'stableNonce'),
    wrapperPid: requireDecimalString(record.wrapperPid, 'wrapperPid'),
    childPid,
    processGroupId: group,
    startFingerprint: requireText(record.startFingerprint, 'startFingerprint'),
    commandDigest: requireSha256(record.commandDigest, 'commandDigest'),
    spoolLocator: requireLocator(record.spoolLocator),
    startedAt: requireText(record.startedAt, 'startedAt')
  };
}

export function parseWrapperManifest(value: unknown): ProcessWrapperManifest {
  const record = exactRecord(value, [
    'kind', 'processId', 'stableNonce', 'status', 'nextChunkSeq', 'retainedBytes',
    'retainedChunks', 'droppedBytes', 'truncated',
    'stdoutTailBytes', 'stdoutTailSha256', 'stdoutTailBase64',
    'stderrTailBytes', 'stderrTailSha256', 'stderrTailBase64', 'updatedAt'
  ], 'ProcessWrapperManifest');
  if (record.kind !== PROCESS_WRAPPER_PROTOCOL) throw new TypeError('Invalid ProcessWrapperManifest.kind.');
  if (record.status !== 'running' && record.status !== 'exited') throw new TypeError('Invalid ProcessWrapperManifest.status.');
  if (typeof record.truncated !== 'boolean') throw new TypeError('Invalid ProcessWrapperManifest.truncated.');
  const manifest: ProcessWrapperManifest = {
    kind: PROCESS_WRAPPER_PROTOCOL,
    processId: requireText(record.processId, 'processId'),
    stableNonce: requireText(record.stableNonce, 'stableNonce'),
    status: record.status,
    nextChunkSeq: requireDecimalString(record.nextChunkSeq, 'nextChunkSeq'),
    retainedBytes: requireDecimalString(record.retainedBytes, 'retainedBytes'),
    retainedChunks: requireDecimalString(record.retainedChunks, 'retainedChunks'),
    droppedBytes: requireDecimalString(record.droppedBytes, 'droppedBytes'),
    truncated: record.truncated,
    stdoutTailBytes: requireDecimalString(record.stdoutTailBytes, 'stdoutTailBytes'),
    stdoutTailSha256: requireSha256(record.stdoutTailSha256, 'stdoutTailSha256'),
    stdoutTailBase64: requireCanonicalBase64(record.stdoutTailBase64, 'stdoutTailBase64'),
    stderrTailBytes: requireDecimalString(record.stderrTailBytes, 'stderrTailBytes'),
    stderrTailSha256: requireSha256(record.stderrTailSha256, 'stderrTailSha256'),
    stderrTailBase64: requireCanonicalBase64(record.stderrTailBase64, 'stderrTailBase64'),
    updatedAt: requireText(record.updatedAt, 'updatedAt')
  };
  if (manifest.status === 'exited' && (
    manifest.stdoutTailBytes !== '0'
    || manifest.stdoutTailBase64 !== ''
    || manifest.stderrTailBytes !== '0'
    || manifest.stderrTailBase64 !== ''
  )) {
    throw new TypeError('Exited ProcessWrapperManifest must not retain live tails.');
  }
  return manifest;
}

/**
 * Decodes the live preview embedded in the manifest itself. Because manifest.json is replaced
 * atomically, counters, both streams and their digests always describe one filesystem snapshot.
 */
export function processWrapperManifestLiveTails(
  manifest: ProcessWrapperManifest
): { stdout: Buffer; stderr: Buffer } {
  return {
    stdout: decodeManifestTail(
      manifest.stdoutTailBase64,
      manifest.stdoutTailBytes,
      manifest.stdoutTailSha256,
      'stdout'
    ),
    stderr: decodeManifestTail(
      manifest.stderrTailBase64,
      manifest.stderrTailBytes,
      manifest.stderrTailSha256,
      'stderr'
    )
  };
}

export function parseWrapperExitReceipt(value: unknown): ProcessWrapperExitReceipt {
  const legacyKeys = [
    'kind', 'processId', 'stableNonce', 'wrapperPid', 'childPid', 'processGroupId',
    'startFingerprint', 'commandDigest', 'exitCode', 'signal', 'exitedAt', 'retainedBytes',
    'retainedChunks', 'droppedBytes', 'truncated', 'stopRequested'
  ] as const;
  const currentKeys = [
    ...legacyKeys,
    'terminationReason', 'executionDeadlineAt', 'maxOutputBytes'
  ] as const;
  const { record, variant } = exactRecordVariant(value, [legacyKeys, currentKeys], 'ProcessWrapperExitReceipt');
  if (record.kind !== PROCESS_WRAPPER_PROTOCOL) throw new TypeError('Invalid ProcessWrapperExitReceipt.kind.');
  const hasExitCode = record.exitCode !== null;
  const hasSignal = record.signal !== null;
  if (hasExitCode === hasSignal) {
    throw new TypeError('ProcessWrapperExitReceipt must contain exactly one of exitCode or signal.');
  }
  if (hasExitCode) requireSignedDecimalString(record.exitCode, 'exitCode');
  if (hasSignal) requireText(record.signal, 'signal');
  if (typeof record.truncated !== 'boolean' || typeof record.stopRequested !== 'boolean') {
    throw new TypeError('Invalid ProcessWrapperExitReceipt flags.');
  }
  const terminationReason = variant === 0
    ? (record.stopRequested ? 'manual' : 'natural')
    : requireTerminationReason(record.terminationReason);
  const executionDeadlineAt = variant === 0
    ? null
    : requireNullableIsoTimestamp(record.executionDeadlineAt, 'executionDeadlineAt');
  const maxOutputBytes = variant === 0
    ? null
    : requireNullablePositiveSafeInteger(record.maxOutputBytes, 'maxOutputBytes');
  if ((terminationReason === 'manual') !== record.stopRequested) {
    throw new TypeError('stopRequested must exactly match terminationReason=manual.');
  }
  if (terminationReason === 'timed_out' && executionDeadlineAt === null) {
    throw new TypeError('timed_out receipt requires executionDeadlineAt.');
  }
  if (terminationReason === 'output_limit_exceeded' && maxOutputBytes === null) {
    throw new TypeError('output_limit_exceeded receipt requires maxOutputBytes.');
  }
  return {
    kind: PROCESS_WRAPPER_PROTOCOL,
    processId: requireText(record.processId, 'processId'),
    stableNonce: requireText(record.stableNonce, 'stableNonce'),
    wrapperPid: requireDecimalString(record.wrapperPid, 'wrapperPid'),
    childPid: requireDecimalString(record.childPid, 'childPid'),
    processGroupId: requireDecimalString(record.processGroupId, 'processGroupId'),
    startFingerprint: requireText(record.startFingerprint, 'startFingerprint'),
    commandDigest: requireSha256(record.commandDigest, 'commandDigest'),
    exitCode: record.exitCode as string | null,
    signal: record.signal as string | null,
    exitedAt: requireText(record.exitedAt, 'exitedAt'),
    retainedBytes: requireDecimalString(record.retainedBytes, 'retainedBytes'),
    retainedChunks: requireDecimalString(record.retainedChunks, 'retainedChunks'),
    droppedBytes: requireDecimalString(record.droppedBytes, 'droppedBytes'),
    truncated: record.truncated,
    stopRequested: record.stopRequested,
    terminationReason,
    executionDeadlineAt,
    maxOutputBytes
  };
}

export function parseStopRequest(value: unknown): ProcessStopRequest {
  const record = exactRecord(value, [
    'kind', 'processId', 'stableNonce', 'startFingerprint', 'processGroupId',
    'commandDigest', 'requestedAt'
  ], 'ProcessStopRequest');
  if (record.kind !== PROCESS_WRAPPER_PROTOCOL) throw new TypeError('Invalid ProcessStopRequest.kind.');
  return {
    kind: PROCESS_WRAPPER_PROTOCOL,
    processId: requireText(record.processId, 'processId'),
    stableNonce: requireText(record.stableNonce, 'stableNonce'),
    startFingerprint: requireText(record.startFingerprint, 'startFingerprint'),
    processGroupId: requireDecimalString(record.processGroupId, 'processGroupId'),
    commandDigest: requireSha256(record.commandDigest, 'commandDigest'),
    requestedAt: requireText(record.requestedAt, 'requestedAt')
  };
}

export function readProcessStartFingerprint(pidInput: string | number): string {
  switch (process.platform) {
    case 'win32': return readWindowsStartFingerprint(pidInput);
    case 'linux': return readLinuxStartFingerprint(pidInput);
    case 'darwin': return readDarwinStartFingerprint(pidInput);
    default: throw unsupportedProcessInspectionPlatform();
  }
}

export function isWrapperProcessReachable(wrapperPidInput: string, launchPathInput: string): boolean {
  switch (process.platform) {
    case 'linux': return isLinuxWrapperProcessReachable(wrapperPidInput, launchPathInput);
    case 'darwin': return isDarwinWrapperProcessReachable(wrapperPidInput, launchPathInput);
    case 'win32': {
      const wrapperPid = requireDecimalString(wrapperPidInput, 'wrapperPid');
      try {
        process.kill(Number(wrapperPid), 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
      }
    }
    default: throw unsupportedProcessInspectionPlatform();
  }
}

function readWindowsStartFingerprint(pidInput: string | number): string {
  const pid = typeof pidInput === 'number'
    ? BigInt(pidInput).toString()
    : requireDecimalString(pidInput, 'pid');
  try {
    process.kill(Number(pid), 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
      throw Object.assign(new Error(`Cannot read start time for process ${pid}.`), {
        code: 'ENOENT',
        cause: error
      });
    }
  }
  const script = `$p = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks.ToString())`;
  const result = spawnSync(resolveWindowsPowerShell().executable, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script
  ], { encoding: 'utf8', windowsHide: true, timeout: 3_000 });
  if (result.error) throw result.error;
  const ticks = result.stdout?.trim();
  if (result.status !== 0 || !ticks || !/^\d+$/.test(ticks)) {
    throw Object.assign(new Error(`Cannot read start time for process ${pid}.`), { code: 'ENOENT' });
  }
  return `win32-process:${pid}:${BigInt(ticks).toString()}`;
}

export function readLinuxStartFingerprint(pidInput: string | number): string {
  const pid = normalizePid(pidInput);
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const close = stat.lastIndexOf(')');
  if (close < 0) throw new Error(`Cannot parse /proc/${pid}/stat.`);
  const fieldsFromState = stat.slice(close + 2).trim().split(/\s+/);
  const startTicks = fieldsFromState[19];
  if (!startTicks || !/^\d+$/.test(startTicks)) throw new Error(`Cannot read start time for process ${pid}.`);
  return `linux-proc:${pid}:${BigInt(startTicks).toString()}`;
}

export function readDarwinStartFingerprint(pidInput: string | number): string {
  const pid = normalizePid(pidInput);
  assertProcessReachable(pid);
  const result = runDarwinPs(['-p', pid, '-o', 'pid=,pgid=,lstart=']);
  if (result.status !== 0) throw processInspectionMissing(pid);
  const row = parseDarwinProcessRows(result.stdout).find((entry) => entry.pid === pid);
  if (!row) throw processInspectionMissing(pid);
  return row.startFingerprint;
}

/** Reads one coherent Darwin process table so process-group witnesses share the same observation. */
export function readDarwinProcessGroupFingerprints(processGroupIdInput: string): Set<string> {
  if (process.platform !== 'darwin') throw unsupportedProcessInspectionPlatform();
  const processGroupId = requireDecimalString(processGroupIdInput, 'processGroupId');
  const result = runDarwinPs(['-axo', 'pid=,pgid=,lstart=']);
  if (result.status !== 0) {
    throw Object.assign(new Error('Cannot inspect the Darwin process table.'), { code: 'EIO' });
  }
  return new Set(
    parseDarwinProcessRows(result.stdout)
      .filter((entry) => entry.processGroupId === processGroupId)
      .map((entry) => entry.startFingerprint)
  );
}

/** Verifies that the recorded wrapper PID still runs the exact launch request path. */
export function isLinuxWrapperProcessReachable(wrapperPidInput: string, launchPathInput: string): boolean {
  const wrapperPid = requireDecimalString(wrapperPidInput, 'wrapperPid');
  const launchPath = path.resolve(launchPathInput);
  try {
    const commandLine = fs.readFileSync(`/proc/${wrapperPid}/cmdline`);
    const arguments_ = commandLine.toString('utf8').split('\0').filter(Boolean).map((entry) => path.resolve(entry));
    return arguments_.includes(launchPath);
  } catch {
    return false;
  }
}

function isDarwinWrapperProcessReachable(wrapperPidInput: string, launchPathInput: string): boolean {
  const wrapperPid = requireDecimalString(wrapperPidInput, 'wrapperPid');
  const launchPath = path.resolve(launchPathInput);
  try {
    assertProcessReachable(wrapperPid);
    const result = runDarwinPs(['-ww', '-p', wrapperPid, '-o', 'command=']);
    if (result.status !== 0) return false;
    const commandLine = result.stdout.trim();
    return commandLine === launchPath || commandLine.endsWith(` ${launchPath}`);
  } catch {
    return false;
  }
}

interface DarwinProcessRow {
  pid: string;
  processGroupId: string;
  startFingerprint: string;
}

function parseDarwinProcessRows(output: string): DarwinProcessRow[] {
  const rows: DarwinProcessRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = BigInt(match[1]!).toString();
    const processGroupId = BigInt(match[2]!).toString();
    const startedAt = match[3]!.trim().replace(/\s+/g, ' ');
    if (!startedAt) continue;
    const digest = createHash('sha256').update(startedAt, 'utf8').digest('hex');
    rows.push({ pid, processGroupId, startFingerprint: `darwin-ps:${pid}:${digest}` });
  }
  return rows;
}

function runDarwinPs(arguments_: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('/bin/ps', arguments_, {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 3_000,
    windowsHide: true
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '' };
}

function assertProcessReachable(pid: string): void {
  try {
    process.kill(Number(pid), 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw processInspectionMissing(pid, error);
  }
}

function normalizePid(pidInput: string | number): string {
  return typeof pidInput === 'number'
    ? BigInt(pidInput).toString()
    : requireDecimalString(pidInput, 'pid');
}

function processInspectionMissing(pid: string, cause?: unknown): Error {
  return Object.assign(new Error(`Cannot read start time for process ${pid}.`), { code: 'ENOENT', cause });
}

function unsupportedProcessInspectionPlatform(): Error {
  return Object.assign(
    new Error(`Process inspection is not supported on ${process.platform}/${process.arch}.`),
    { code: 'ENOSYS' }
  );
}

export function requireDecimalString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string.`);
  }
  return value;
}

export function requireSignedDecimalString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a signed decimal integer string.`);
  }
  return value;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  return exactRecordVariant(value, [keys], label).record;
}

function exactRecordVariant(
  value: unknown,
  variants: readonly (readonly string[])[],
  label: string
): { record: Record<string, unknown>; variant: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  for (let variant = 0; variant < variants.length; variant += 1) {
    const expected = [...variants[variant]!].sort();
    if (actual.length === expected.length && actual.every((key, index) => key === expected[index])) {
      return { record, variant };
    }
  }
  throw new TypeError(`${label} fields do not match the current wrapper contract.`);
}

function requireBootstrapPhase(value: unknown): ProcessWrapperBootstrapPhase {
  if (value !== 'wrapper_spawned' && value !== 'child_spawned' && value !== 'identity_ready') {
    throw new TypeError('Invalid process wrapper bootstrap phase.');
  }
  return value;
}

function requireIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO timestamp.`);
  }
  return value;
}

function requireBoundedText(value: unknown, label: string, maximumLength: number): string {
  const text = requireText(value, label);
  if (text.length > maximumLength) throw new TypeError(`${label} exceeds ${maximumLength} characters.`);
  return text;
}

function requireTerminationReason(value: unknown): ProcessTerminationReason {
  if (!['natural', 'manual', 'timed_out', 'output_limit_exceeded'].includes(String(value))) {
    throw new TypeError('Invalid ProcessWrapperExitReceipt.terminationReason.');
  }
  return value as ProcessTerminationReason;
}

function requireNullableIsoTimestamp(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO timestamp or null.`);
  }
  return value;
}

function requireNullablePositiveSafeInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer or null.`);
  }
  return value;
}

function requireCanonicalBase64(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be canonical base64.`);
  }
  try {
    decodeCanonicalBase64(value);
  } catch {
    throw new TypeError(`${label} must be canonical base64.`);
  }
  return value;
}

function decodeManifestTail(
  encoded: string,
  byteLengthInput: string,
  expectedSha256: string,
  streamKind: ProcessStreamKind
): Buffer {
  const bytes = Buffer.from(encoded, 'base64');
  const byteLength = BigInt(byteLengthInput);
  if (byteLength > BigInt(PROCESS_OUTPUT_MAX_TERMINAL_TAIL_BYTES_PER_STREAM)) {
    throw new TypeError(`ProcessWrapperManifest ${streamKind} tail exceeds the frozen bound.`);
  }
  if (BigInt(bytes.byteLength) !== byteLength) {
    throw new TypeError(`ProcessWrapperManifest ${streamKind} tail length mismatch.`);
  }
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new TypeError(`ProcessWrapperManifest ${streamKind} tail digest mismatch.`);
  }
  return bytes;
}

function requireLocator(value: unknown): string {
  const locator = requireText(value, 'spoolLocator');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(locator)) throw new TypeError('Invalid process spool locator.');
  return locator;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${label} must be lowercase SHA-256.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value;
}

function compareDecimal(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
