import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { WorkEnvironmentRecord } from '../../shared/protocol';
import { isRemoteServerWorkEnvironment, workEnvironmentDisplayName } from '../../shared/workEnvironmentCatalog';
import type { CommandRunArgs, CommandRunObserver, CommandRunResult, FsDeletePathTargetType, FsReadFileResult } from './types';
import { sliceTextFile } from './textFileSlice';

const DEFAULT_REMOTE_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 120_000;
/** Remote reads travel as base64 over a shell, so the ceiling is well below the local one. */
const MAX_REMOTE_READ_BYTES = 2 * 1024 * 1024;

export interface RemotePathPolicyOptions {
  allowOutsideProjectPaths?: boolean;
  rejectProjectRoot?: boolean;
  signal?: AbortSignal;
}

export interface RemoteServerStreamHandle {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  done: Promise<CommandRunResult>;
}

export function isRemoteServerCommandEnvironment(environment: WorkEnvironmentRecord | undefined): environment is WorkEnvironmentRecord {
  return !!environment && isRemoteServerWorkEnvironment(environment);
}

export function assertRemoteServerCommandSupported(environment: WorkEnvironmentRecord): void {
  if (!isRemoteServerWorkEnvironment(environment)) {
    throw new Error(`工作环境不是远程服务器：${workEnvironmentDisplayName(environment)} (${environment.kind})`);
  }
  if (environment.available === false) {
    throw new Error(`当前工作环境不可用：${workEnvironmentDisplayName(environment)}`);
  }
  if (environment.password && !environment.identityFile) {
    throw new Error(`远程服务器 ${workEnvironmentDisplayName(environment)} 当前使用命令 provider 执行，暂不支持非交互密码登录；请配置 IdentityFile、SSH Agent 或本机 SSH config。`);
  }
  if (!remoteHost(environment)) {
    throw new Error(`远程服务器 ${workEnvironmentDisplayName(environment)} 缺少 Host。`);
  }
}

export class RemoteFileNotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RemoteFileNotFoundError';
  }
}

export async function runRemoteServerCommand(
  environment: WorkEnvironmentRecord,
  args: CommandRunArgs,
  observer?: CommandRunObserver
): Promise<CommandRunResult> {
  assertRemoteServerCommandSupported(environment);
  const command = (args.command ?? '').trim();
  if (!command) return failedRemoteResult('', 'Missing required argument: command');
  const cwd = resolveRemoteCwd(args.cwd, environment);
  const script = cwd ? `cd ${shQuote(cwd)} && ${command}` : command;
  return executeRemoteServerScript(environment, script, {
    timeout: resolveRemoteTimeout(args.foregroundWaitMs),
    observer,
    displayCommand: command,
    ...(args.signal ? { signal: args.signal } : {})
  });
}

export async function readRemoteServerTextFile(
  environment: WorkEnvironmentRecord,
  filePath: string,
  startLine?: number,
  endLine?: number,
  options: RemotePathPolicyOptions = {}
): Promise<FsReadFileResult> {
  const text = await readRemoteServerRawTextFile(environment, filePath, MAX_REMOTE_READ_BYTES, options);
  return sliceTextFile(filePath, text, startLine, endLine);
}

export async function readRemoteServerRawTextFile(
  environment: WorkEnvironmentRecord,
  filePath: string,
  maxBytes = MAX_REMOTE_READ_BYTES,
  options: RemotePathPolicyOptions = {}
): Promise<string> {
  assertRemoteServerCommandSupported(environment);
  const remotePath = resolveRemotePath(filePath, environment, undefined, options);
  const script = `set -euo pipefail
FILE=${shQuote(remotePath)}
if [ ! -e "$FILE" ]; then echo "file not found: $FILE" >&2; exit 44; fi
if [ ! -f "$FILE" ]; then echo "not a file: $FILE" >&2; exit 46; fi
bytes="$(wc -c < "$FILE" 2>/dev/null || printf '0')"
case "$bytes" in ''|*[!0-9]*) bytes=0 ;; esac
if [ "$bytes" -gt ${maxBytes} ]; then echo "File too large: ${remotePath} (${maxBytes} bytes limit)" >&2; exit 45; fi
base64 < "$FILE" | tr -d '\n\r'`;
  const result = await executeRemoteServerScript(environment, script, {
    timeout: DEFAULT_REMOTE_TIMEOUT_MS,
    displayCommand: `read ${remotePath}`,
    signal: options.signal
  });
  if (result.exitCode === 44) throw new RemoteFileNotFoundError(result.stderr || `远程文件不存在：${remotePath}`);
  if (result.exitCode !== 0 || result.killed) {
    throw new Error(result.stderr || `远程读取失败：${remotePath}`);
  }
  return Buffer.from(result.stdout.replace(/\s+/g, ''), 'base64').toString('utf8');
}

export async function writeRemoteServerTextFile(
  environment: WorkEnvironmentRecord,
  filePath: string,
  content: string,
  options: RemotePathPolicyOptions = {}
): Promise<void> {
  assertRemoteServerCommandSupported(environment);
  const remotePath = resolveRemotePath(filePath, environment, undefined, options);
  const remoteDir = path.posix.dirname(remotePath);
  const tempPath = path.posix.join(remoteDir, `.${path.posix.basename(remotePath) || 'file'}.limcode-write-${Date.now()}-${randomBytes(4).toString('hex')}`);
  const mkdirResult = await executeRemoteServerScript(environment, `mkdir -p -- ${shQuote(remoteDir)}`, { timeout: DEFAULT_REMOTE_TIMEOUT_MS, displayCommand: `mkdir -p ${remoteDir}` });
  if (mkdirResult.exitCode !== 0 || mkdirResult.killed) throw new Error(mkdirResult.stderr || `远程目录创建失败：${remoteDir}`);

  const handle = openRemoteServerWriteStream(environment, tempPath);
  try {
    await new Promise<void>((resolve, reject) => {
      handle.stdin.once('error', reject);
      handle.stdin.end(Buffer.from(content, 'utf8'), () => resolve());
    });
    const writeResult = await handle.done;
    if (writeResult.exitCode !== 0 || writeResult.killed) throw new Error(writeResult.stderr || `远程文件写入失败：${remotePath}`);
    const renameResult = await executeRemoteServerScript(environment, `mv -f -- ${shQuote(tempPath)} ${shQuote(remotePath)}`, { timeout: DEFAULT_REMOTE_TIMEOUT_MS, displayCommand: `rename ${tempPath} -> ${remotePath}` });
    if (renameResult.exitCode !== 0 || renameResult.killed) throw new Error(renameResult.stderr || `远程文件替换失败：${remotePath}`);
  } catch (error) {
    await executeRemoteServerScript(environment, `rm -f -- ${shQuote(tempPath)}`, { timeout: DEFAULT_REMOTE_TIMEOUT_MS, displayCommand: `cleanup ${tempPath}` }).catch(() => undefined);
    throw error;
  }
}

export async function deleteRemoteServerPath(
  environment: WorkEnvironmentRecord,
  filePath: string,
  options: RemotePathPolicyOptions = {}
): Promise<{ path: string; targetType: FsDeletePathTargetType }> {
  assertRemoteServerCommandSupported(environment);
  const remotePath = resolveRemotePath(filePath, environment, undefined, { ...options, rejectProjectRoot: true });
  assertSafeRemoteDeleteTarget(remotePath, environment);
  const script = `set -euo pipefail
TARGET=${shQuote(remotePath)}
if [ ! -e "$TARGET" ]; then echo "path not found: $TARGET" >&2; exit 44; fi
if [ -d "$TARGET" ] && [ ! -L "$TARGET" ]; then
  rm -rf -- "$TARGET"
  printf 'directory'
else
  rm -f -- "$TARGET"
  printf 'file'
fi`;
  const result = await executeRemoteServerScript(environment, script, { timeout: DEFAULT_REMOTE_TIMEOUT_MS, displayCommand: `delete ${remotePath}` });
  if (result.exitCode === 44) throw new RemoteFileNotFoundError(result.stderr || `远程路径不存在：${remotePath}`);
  if (result.exitCode !== 0 || result.killed) throw new Error(result.stderr || `远程删除失败：${remotePath}`);
  return { path: remotePath, targetType: result.stdout.trim() === 'directory' ? 'directory' : 'file' };
}


export function openRemoteServerReadStream(
  environment: WorkEnvironmentRecord,
  remotePath: string,
  signal?: AbortSignal
): RemoteServerStreamHandle {
  assertRemoteServerCommandSupported(environment);
  return spawnRemoteServerScript(environment, `cat -- ${shQuote(remotePath)}`, {
    timeout: 0,
    displayCommand: `cat ${remotePath}`,
    captureStdout: false,
    signal
  });
}

export function openRemoteServerWriteStream(
  environment: WorkEnvironmentRecord,
  remotePath: string,
  signal?: AbortSignal
): RemoteServerStreamHandle {
  assertRemoteServerCommandSupported(environment);
  return spawnRemoteServerScript(environment, `cat > ${shQuote(remotePath)}`, {
    timeout: 0,
    displayCommand: `write ${remotePath}`,
    captureStdout: false,
    closeStdin: false,
    signal
  });
}

export function executeRemoteServerScript(
  environment: WorkEnvironmentRecord,
  script: string,
  options: { timeout?: number; observer?: CommandRunObserver; displayCommand?: string; signal?: AbortSignal } = {}
): Promise<CommandRunResult> {
  const handle = spawnRemoteServerScript(environment, script, options);
  return handle.done;
}

export function spawnRemoteServerScript(
  environment: WorkEnvironmentRecord,
  script: string,
  options: { timeout?: number; observer?: CommandRunObserver; displayCommand?: string; captureStdout?: boolean; closeStdin?: boolean; signal?: AbortSignal } = {}
): RemoteServerStreamHandle {
  assertRemoteServerCommandSupported(environment);
  const command = options.displayCommand ?? script;
  const child = spawn('ssh', buildSshArgs(environment, `bash -lc ${shQuote(script)}`), {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const done = new Promise<CommandRunResult>((resolve) => {
    const stdout = new OutputAccumulator(MAX_OUTPUT_CHARS);
    const stderr = new OutputAccumulator(MAX_OUTPUT_CHARS);
    let killed = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => {
      if (settled || killed) return;
      killed = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 1_500);
      forceKillTimer.unref?.();
    };
    const streamEvents = createStreamEventEmitter(options.observer);
    const timeout = options.timeout ?? DEFAULT_REMOTE_TIMEOUT_MS;
    const timer = timeout > 0
      ? setTimeout(abort, timeout)
      : undefined;
    timer?.unref?.();

    const settle = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', abort);
      streamEvents.flush();
      resolve({ command, exitCode, killed, stdout: stdout.value(), stderr: stderr.value() });
    };

    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    if (options.captureStdout !== false) child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    if (options.captureStdout !== false) {
      child.stdout?.on('data', (chunk: string) => {
        stdout.append(chunk);
        streamEvents.push('stdout', chunk);
      });
    }
    child.stderr?.on('data', (chunk: string) => {
      stderr.append(chunk);
      streamEvents.push('stderr', chunk);
    });
    child.once('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      stderr.append(message);
      streamEvents.push('stderr', message);
      settle(1);
    });
    child.once('close', (code, signal) => settle(killed ? (code ?? 1) : (code ?? (signal ? 1 : 0))));
  });

  if (options.closeStdin !== false) child.stdin.end();

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    done
  };
}

export function resolveRemotePath(input: string, environment: WorkEnvironmentRecord, cwd?: string, options: RemotePathPolicyOptions = {}): string {
  const text = normalizeRemoteInput(input);
  const base = resolveRemoteCwd(cwd, environment);
  const resolved = path.posix.isAbsolute(text)
    ? path.posix.normalize(text)
    : base
      ? path.posix.join(base, text)
      : text;
  return applyRemotePathPolicy(path.posix.normalize(resolved), environment, options);
}

export function resolveRemoteCwd(inputCwd: string | undefined, environment: WorkEnvironmentRecord): string | undefined {
  const base = normalizeOptionalRemotePath(environment.workdir) ?? normalizeOptionalRemotePath(environment.rootPath);
  const cwd = normalizeOptionalRemotePath(inputCwd);
  if (!cwd) return base;
  if (path.posix.isAbsolute(cwd)) return path.posix.normalize(cwd);
  return base ? path.posix.join(base, cwd) : path.posix.normalize(cwd);
}

export function remoteProjectRootPath(environment: WorkEnvironmentRecord): string | undefined {
  return resolveRemoteCwd(undefined, environment);
}

function applyRemotePathPolicy(remotePath: string, environment: WorkEnvironmentRecord, options: RemotePathPolicyOptions): string {
  if (options.allowOutsideProjectPaths === false) {
    const root = remoteProjectRootPath(environment);
    if (!root || !path.posix.isAbsolute(root)) {
      throw new Error(`当前远程工作环境缺少绝对 workdir/rootPath，无法限制项目外路径：${workEnvironmentDisplayName(environment)}`);
    }
    if (!path.posix.isAbsolute(remotePath) || !isRemotePathInside(remotePath, root)) {
      throw new Error(`路径超出当前远程工作环境根目录：${remotePath}（root=${root}）`);
    }
  }
  if (options.rejectProjectRoot === true) assertSafeRemoteDeleteTarget(remotePath, environment);
  return remotePath;
}

function assertSafeRemoteDeleteTarget(remotePath: string, environment: WorkEnvironmentRecord): void {
  const normalized = path.posix.normalize(remotePath);
  if (!normalized || normalized === '/') throw new Error('拒绝删除远程文件系统根目录。');
  if (!path.posix.isAbsolute(normalized)) throw new Error(`远程相对删除路径需要配置 workdir/rootPath：${normalized}`);
  const root = remoteProjectRootPath(environment);
  if (root && path.posix.isAbsolute(root) && sameRemotePath(normalized, root)) {
    throw new Error(`拒绝删除远程工作环境根目录：${normalized}`);
  }
}

function sameRemotePath(left: string, right: string): boolean {
  return path.posix.normalize(left) === path.posix.normalize(right);
}

function isRemotePathInside(candidate: string, root: string): boolean {
  const normalizedCandidate = path.posix.normalize(candidate);
  const normalizedRoot = path.posix.normalize(root);
  const relative = path.posix.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.posix.isAbsolute(relative));
}


export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildSshArgs(environment: WorkEnvironmentRecord, remoteCommand: string): string[] {
  const host = remoteHost(environment);
  if (!host) throw new Error(`远程服务器 ${workEnvironmentDisplayName(environment)} 缺少 Host。`);
  const target = environment.user ? `${environment.user}@${host}` : host;
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2'
  ];
  if (environment.identityFile?.trim()) args.push('-i', environment.identityFile.trim());
  if (environment.port && environment.port > 0) args.push('-p', String(Math.floor(environment.port)));
  args.push(target, remoteCommand);
  return args;
}

function remoteHost(environment: WorkEnvironmentRecord): string | undefined {
  return environment.host?.trim() || environment.name?.trim();
}

function normalizeRemoteInput(input: string): string {
  const text = input.trim().replace(/\\/g, '/');
  if (!text || text.includes('\0')) throw new Error(`非法远程路径：${input}`);
  return path.posix.normalize(text);
}

function normalizeOptionalRemotePath(input: string | undefined): string | undefined {
  if (typeof input !== 'string' || !input.trim()) return undefined;
  return normalizeRemoteInput(input);
}

function resolveRemoteTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULT_REMOTE_TIMEOUT_MS;
  return value;
}

function failedRemoteResult(command: string, stderr: string): CommandRunResult {
  return { command, exitCode: 1, killed: false, stdout: '', stderr };
}



class OutputAccumulator {
  private head = '';
  private tail = '';
  private totalLength = 0;
  private truncated = false;

  public constructor(private readonly maxChars: number) {}

  public append(value: string): void {
    if (!value) return;
    const nextTotal = this.totalLength + value.length;
    if (!this.truncated && nextTotal <= this.maxChars) {
      this.head += value;
      this.totalLength = nextTotal;
      return;
    }
    const half = Math.max(1, Math.floor(this.maxChars / 2));
    if (!this.truncated) {
      const combined = this.head + value;
      this.head = combined.slice(0, half);
      this.tail = combined.slice(-half);
      this.truncated = true;
    } else {
      this.tail = (this.tail + value).slice(-half);
    }
    this.totalLength = nextTotal;
  }

  public value(): string {
    if (!this.truncated) return this.head;
    return `${this.head}\n\n... (已截断，共 ${this.totalLength} 字符) ...\n\n${this.tail}`;
  }
}

type StreamOutputKind = 'stdout' | 'stderr';

function createStreamEventEmitter(observer?: CommandRunObserver): { push(kind: StreamOutputKind, delta: string): void; flush(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingChars = 0;
  const pending: Array<{ kind: StreamOutputKind; delta: string }> = [];

  const clearTimer = (): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const flush = (): void => {
    clearTimer();
    if (pending.length === 0) return;
    const events = pending.splice(0, pending.length);
    pendingChars = 0;
    for (const event of events) observer?.onEvent?.(event);
  };

  const schedule = (): void => {
    if (timer || !observer?.onEvent) return;
    timer = setTimeout(flush, 100);
    timer.unref?.();
  };

  return {
    push(kind, delta) {
      if (!observer?.onEvent || !delta) return;
      const last = pending[pending.length - 1];
      if (last?.kind === kind) last.delta += delta;
      else pending.push({ kind, delta });
      pendingChars += delta.length;
      if (pendingChars >= 8192) flush();
      else schedule();
    },
    flush
  };
}
