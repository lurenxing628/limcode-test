import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommandCapability, CommandOutputLimits, CommandRunArgs, CommandRunObserver, CommandRunResult, WorkEnvironmentCapabilityOptions } from './types';
import {
  BackgroundProcessManager,
  type BackgroundProcessPathsProvider
} from './backgroundProcessManager';
import {
  WORK_ENVIRONMENT_CAPABILITY,
  isLocalFolderWorkEnvironment,
  workEnvironmentDisplayName,
  workEnvironmentSupportsCapability
} from '../../shared/workEnvironmentCatalog';
import { isRemoteServerCommandEnvironment, runRemoteServerCommand } from './workEnvironmentProvider';
import { powerShellCommandSyntaxGuidance, resolveWindowsPowerShell } from './windowsPowerShell';

const DEFAULT_FOREGROUND_WAIT_MS = 30_000;
/** 后台进程完整日志 buffer 的上限（远大于给模型的软上限，避免过早丢弃可能被 output 读取的历史）。 */
const BACKGROUND_MAX_CHARS = 200_000;
/** Legacy capability declarations use zero to mean complete output; reliable mode pages by outputHandle. */
const DEFAULT_OUTPUT_LIMITS: CommandOutputLimits = { maxOutputLines: 0, maxOutputChars: 0 };
const STREAM_EVENT_FLUSH_INTERVAL_MS = 100;
const STREAM_EVENT_FLUSH_CHARS = 8 * 1024;
const MAX_STREAM_EVENT_DELTA_CHARS = 16 * 1024;
const PS_UTF8_PREFIX = [
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  "$PSDefaultParameterValues['*:Encoding'] = 'utf8'",
  // PowerShell 7 colours its own formatting and error views; the 5.1 fallback never did.
  "if ($null -ne $PSStyle) { $PSStyle.OutputRendering = 'PlainText'; $PSStyle.Formatting.Error = ''; $PSStyle.Formatting.ErrorAccent = ''; $PSStyle.Formatting.Warning = ''; $PSStyle.Formatting.Verbose = ''; $PSStyle.Formatting.Debug = '' }"
].join('; ') + '\n';

type ShellKind = 'powershell' | 'bash';
type StaticClassification = 'allow' | 'deny' | 'unknown';

interface CommandProfile {
  readonly kind: ShellKind;
  readonly toolName: 'shell' | 'bash';
  readonly executable: string;
  readonly description: string;
  readonly commandPrefix?: string;
}

interface CommandSafetyConfig {
  safe?: boolean;
  safeSubcommands?: string[];
  isDangerous?: (args: string[]) => boolean;
}

type ForegroundCommandControl = () => boolean;

export function createCommandCapability(capabilityOptions: {
  paths?: BackgroundProcessPathsProvider;
  backgroundProcesses?: BackgroundProcessManager;
} = {}): CommandCapability {
  const profile = detectCommandProfile();
  const backgroundProcesses = capabilityOptions.backgroundProcesses ?? new BackgroundProcessManager({ paths: capabilityOptions.paths });
  const foregroundControls = new Map<string, ForegroundCommandControl>();
  return {
    toolName: profile.toolName,
    description: profile.description,
    run(args, observer, options, limits) {
      return runCommand(profile, backgroundProcesses, foregroundControls, args, observer, options, limits ?? DEFAULT_OUTPUT_LIMITS);
    },
    backgroundForeground(executionId) {
      const control = foregroundControls.get(executionId);
      return control?.() ?? false;
    },
    readOutput(processId, limits, options) {
      return backgroundProcesses.readOutput(processId, limits ?? DEFAULT_OUTPUT_LIMITS, {
        consume: options?.consume === true,
        claimTerminal: options?.claimTerminal === true
      });
    },
    kill(processId) {
      return backgroundProcesses.kill(processId);
    },
    quiesce() {
      for (const control of [...foregroundControls.values()]) control();
      foregroundControls.clear();
      backgroundProcesses.quiesce();
    },
    dispose() {
      for (const control of [...foregroundControls.values()]) control();
      foregroundControls.clear();
      backgroundProcesses.dispose();
    }
  };
}
function detectCommandProfile(): CommandProfile {
  if (process.platform === 'win32') {
    const powerShell = resolveWindowsPowerShell();
    return {
      kind: 'powershell',
      toolName: 'shell',
      executable: powerShell.executable,
      commandPrefix: PS_UTF8_PREFIX,
      description: `Run a non-interactive PowerShell command in the project workspace. Returns stdout, stderr, and exitCode.
Foreground/background behavior: foregroundWaitMs is only the tool-response budget. Reaching it moves the command to the background and returns processId; it does not terminate the command. foregroundWaitMs=0 backgrounds immediately.
Execution watchdog: executionTimeoutMs is the independent hard runtime deadline (default 120000ms, maximum 600000ms). maxOutputBytes limits combined stdout+stderr (default 256MiB). Either watchdog remains active after background handoff and reports timed_out or output_limit_exceeded.
Completion delivery: background completion and watchdog termination are reported proactively. Do not poll mode=output merely to wait; use it only for an explicit progress check or to follow a returned output handle. Use mode=kill to terminate manually.
Safety: built-in protection only blocks disk/filesystem formatting and direct root deletion; additional commands can be denied by the tool policy deny list.
Command syntax: ${powerShellCommandSyntaxGuidance(powerShell.edition)}
Encoding: the tool configures PowerShell input/output as UTF-8 by default. When reading non-UTF-8 files, specify the encoding explicitly in the command.`
    };
  }

  return {
    kind: 'bash',
    toolName: 'bash',
    executable: process.env.SHELL || '/bin/bash',
    description: `Run a non-interactive Bash/Shell command in the project workspace. Returns stdout, stderr, and exitCode.
Foreground/background behavior: foregroundWaitMs is only the tool-response budget. Reaching it moves the command to the background and returns processId; it does not terminate the command. foregroundWaitMs=0 backgrounds immediately.
Execution watchdog: executionTimeoutMs is the independent hard runtime deadline (default 120000ms, maximum 600000ms). maxOutputBytes limits combined stdout+stderr (default 256MiB). Either watchdog remains active after background handoff and reports timed_out or output_limit_exceeded.
Completion delivery: background completion and watchdog termination are reported proactively. Do not poll mode=output merely to wait; use it only for an explicit progress check or to follow a returned output handle. Use mode=kill to terminate manually.
Safety: built-in protection only blocks disk/filesystem formatting and direct root deletion; additional commands can be denied by the tool policy deny list.
Command syntax: prefer joining multiple commands with &&; quote paths that contain spaces; for long output, prefer piping to head -n N.`
  };
}

async function runCommand(profile: CommandProfile, backgroundProcesses: BackgroundProcessManager, foregroundControls: Map<string, ForegroundCommandControl>, args: CommandRunArgs, observer: CommandRunObserver | undefined, options: WorkEnvironmentCapabilityOptions = {}, limits: CommandOutputLimits = DEFAULT_OUTPUT_LIMITS): Promise<CommandRunResult> {
  const command = (args.command ?? '').trim();
  if (!command) return failedResult('', 'Missing required argument: command');

  const remoteEnvironment = isRemoteServerCommandEnvironment(options.workEnvironment) ? options.workEnvironment : undefined;
  if (!remoteEnvironment) {
    const environmentError = validateCommandWorkEnvironment(options);
    if (environmentError) return failedResult(command, environmentError);
  }

  const safetyKind: ShellKind = remoteEnvironment ? 'bash' : profile.kind;
  const safety = classifyCommand(safetyKind, command);
  if (safety === 'deny') {
    return failedResult(command, `安全拒绝: ${getDenyReason(safetyKind, command) ?? '命令被安全策略拒绝'}\n该操作命中内置格式化/根目录删除保护，无法绕过。`);
  }

  if (remoteEnvironment) {
    // TODO: 远程 SSH 分支暂不支持转后台，前台等待预算仍会作为远程命令终止上限；后台管理仅本地命令可用。
    const raw = await runRemoteServerCommand(remoteEnvironment, args, observer);
    return annotateResult('bash', { ...raw, status: raw.killed ? 'killed' : 'completed' });
  }

  const cwd = resolveWorkDir(args.cwd, options);
  const foregroundWaitMs = resolveForegroundWaitMs(args.foregroundWaitMs);
  const raw = await executeCommand(profile, backgroundProcesses, foregroundControls, command, cwd, foregroundWaitMs, limits, observer, args.executionId, args.backgroundProcessOrigin, args.signal);
  return annotateResult(profile.kind, raw);
}

function executeCommand(profile: CommandProfile, backgroundProcesses: BackgroundProcessManager, foregroundControls: Map<string, ForegroundCommandControl>, command: string, cwd: string, foregroundWaitMs: number, limits: CommandOutputLimits, observer?: CommandRunObserver, executionId?: string, origin?: CommandRunArgs['backgroundProcessOrigin'], signal?: AbortSignal): Promise<CommandRunResult> {
  const wrappedCommand = `${profile.commandPrefix ?? ''}${command}`;
  return new Promise((resolve) => {
    const stdout = new AppendBuffer(BACKGROUND_MAX_CHARS);
    const stderr = new AppendBuffer(BACKGROUND_MAX_CHARS);
    let streamEvents = createStreamEventEmitter(observer);
    const startedAt = Date.now();
    let settled = false;
    let backgrounded = false;
    let aborted = false;
    let processId: string | undefined;

    const child = spawn(profile.executable, commandArgs(profile, wrappedCommand), {
      cwd,
      windowsHide: true,
      detached: profile.kind === 'bash' && process.platform !== 'win32',
      env: nonInteractiveEnv(profile.kind)
    });

    // 转入后台继续运行（不 kill），立即以 running 状态 resolve 前台 promise。
    // 触发时机：foregroundWaitMs>0 到点触发；foregroundWaitMs===0 生成子进程后立即触发。
    const abortForeground = (): boolean => {
      if (settled || backgrounded || aborted) return false;
      aborted = true;
      killProcessTree(child.pid, profile.kind);
      return true;
    };
    const onAbort = (): void => { abortForeground(); };
    const clearForegroundControl = (): void => {
      if (executionId && foregroundControls.get(executionId) === moveToBackground) {
        foregroundControls.delete(executionId);
      }
      signal?.removeEventListener('abort', onAbort);
    };

    const moveToBackground = (): boolean => {
      if (settled || aborted) return false;
      streamEvents.flush();
      try {
        const processRecord = backgroundProcesses.adopt({
          toolName: profile.toolName,
          command,
          cwd,
          ...(child.pid !== undefined ? { pid: child.pid } : {}),
          startedAt,
          stdout,
          stderr,
          ...(origin ? { origin } : {}),
          kill: () => killProcessTree(child.pid, profile.kind)
        });
        processId = processRecord.processId;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr.append(`${stderr.snapshot().text ? '\n' : ''}[LimCode] 无法持久化后台进程所有权，命令已终止：${message}`);
        killProcessTree(child.pid, profile.kind);
        settleForeground(1);
        return false;
      }
      backgrounded = true;
      settled = true;
      clearForegroundControl();
      if (foregroundWaitTimer) clearTimeout(foregroundWaitTimer);
      streamEvents = createStreamEventEmitter(undefined); // Tool Attempt 已终态；后续输出只归 ProcessManager。
      const out = stdout.snapshot();
      const err = stderr.snapshot();
      resolve({
        command,
        exitCode: null,
        killed: false,
        status: 'running',
        processId,
        running: true,
        stdout: out.text,
        stderr: err.text
      });
      return true;
    };

    const foregroundWaitTimer = foregroundWaitMs > 0 ? setTimeout(() => { moveToBackground(); }, foregroundWaitMs) : undefined;
    foregroundWaitTimer?.unref?.();
    if (executionId) foregroundControls.set(executionId, moveToBackground);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) abortForeground();

    const settleForeground = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearForegroundControl();
      if (foregroundWaitTimer) clearTimeout(foregroundWaitTimer);
      streamEvents.flush();
      const out = stdout.snapshot();
      const err = stderr.snapshot();
      resolve({
        command,
        exitCode,
        killed: aborted,
        status: aborted ? 'killed' : 'completed',
        stdout: out.text,
        stderr: err.text
      });
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout.append(chunk);
      if (processId) backgroundProcesses.noteOutput(processId);
      streamEvents.push('stdout', chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr.append(chunk);
      if (processId) backgroundProcesses.noteOutput(processId);
      streamEvents.push('stderr', chunk);
    });
    child.once('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      stderr.append(message);
      if (processId) backgroundProcesses.noteOutput(processId);
      streamEvents.push('stderr', message);
      if (backgrounded && processId) backgroundProcesses.finalizeAbnormalExit(processId, message, 1);
      else settleForeground(1);
    });
    child.once('close', (code, signal) => {
      const exitCode = code ?? (signal ? 1 : 0);
      if (backgrounded && processId) {
        streamEvents.flush();
        backgroundProcesses.finalizeNaturalExit(processId, exitCode);
      } else {
        settleForeground(exitCode);
      }
    });
    child.stdin?.end();

    // foregroundWaitMs=0：不做前台等待，子进程一启动即转入后台执行。
    if (foregroundWaitMs === 0) moveToBackground();
  });
}

function commandArgs(profile: CommandProfile, wrappedCommand: string): string[] {
  return profile.kind === 'powershell'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrappedCommand]
    : ['-lc', wrappedCommand];
}

/** 追加式有界输出缓冲；后台化后由 BackgroundProcessManager 持有并持久化。 */

class AppendBuffer {
  private buffer = '';
  private droppedChars = 0;

  public constructor(private readonly maxChars: number) {}

  public append(value: string): void {
    if (!value) return;
    this.buffer += value;
    if (this.buffer.length > this.maxChars) {
      const overflow = this.buffer.length - this.maxChars;
      this.buffer = this.buffer.slice(overflow);
      this.droppedChars += overflow;
    }
  }

  /** 读取当前保留的全部日志正文。与调用次数无关，每次都返回当前已累积的完整内容。 */
  public snapshot(): { text: string; dropped: number } {
    return { text: this.buffer, dropped: this.droppedChars };
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
    for (const event of events) emitStreamDelta(observer, event.kind, event.delta);
  };

  const schedule = (): void => {
    if (timer || !observer?.onEvent) return;
    timer = setTimeout(flush, STREAM_EVENT_FLUSH_INTERVAL_MS);
    timer.unref?.();
  };

  return {
    push(kind, delta) {
      if (!observer?.onEvent || !delta) return;
      const last = pending[pending.length - 1];
      if (last?.kind === kind) last.delta += delta;
      else pending.push({ kind, delta });
      pendingChars += delta.length;
      if (pendingChars >= STREAM_EVENT_FLUSH_CHARS) flush();
      else schedule();
    },
    flush
  };
}

function emitStreamDelta(observer: CommandRunObserver | undefined, kind: StreamOutputKind, delta: string): void {
  for (let offset = 0; offset < delta.length; offset += MAX_STREAM_EVENT_DELTA_CHARS) {
    const chunk = delta.slice(offset, offset + MAX_STREAM_EVENT_DELTA_CHARS);
    try {
      observer?.onEvent?.({ kind, delta: chunk });
    } catch (error) {
      console.warn('[LimCode] Command stream observer failed:', error);
    }
  }
}

function resolveForegroundWaitMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULT_FOREGROUND_WAIT_MS;
  return Math.floor(value);
}

function resolveWorkDir(cwd: string | undefined, options: WorkEnvironmentCapabilityOptions): string {
  const root = workEnvironmentRootPath(options) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  if (!cwd?.trim()) return root;
  if (path.isAbsolute(cwd)) return cwd;
  return path.resolve(root, cwd);
}

function workEnvironmentRootPath(options: WorkEnvironmentCapabilityOptions): string | undefined {
  const workEnvironment = options.workEnvironment;
  if (workEnvironment && workEnvironmentSupportsCapability(workEnvironment, WORK_ENVIRONMENT_CAPABILITY.LocalCommand) && workEnvironment.available !== false) {
    const rootPath = workEnvironment.rootPath?.trim();
    if (rootPath) return rootPath;
  }
  return options.accessibleWorkEnvironments
    ?.find((environment) => environment.available !== false && isLocalFolderWorkEnvironment(environment) && workEnvironmentSupportsCapability(environment, WORK_ENVIRONMENT_CAPABILITY.LocalCommand) && environment.rootPath?.trim())
    ?.rootPath?.trim();
}

function validateCommandWorkEnvironment(options: WorkEnvironmentCapabilityOptions): string | undefined {
  const workEnvironment = options.workEnvironment;
  if (!workEnvironment) return undefined;
  if (!workEnvironmentSupportsCapability(workEnvironment, WORK_ENVIRONMENT_CAPABILITY.LocalCommand)) return `当前工作环境暂不支持本地命令执行：${workEnvironmentDisplayName(workEnvironment)} (${workEnvironment.kind})`;
  if (workEnvironment.available === false) return `当前工作环境不可用：${workEnvironmentDisplayName(workEnvironment)}`;
  if (!workEnvironment.rootPath?.trim()) return `当前工作环境缺少可执行根目录：${workEnvironmentDisplayName(workEnvironment)}`;
  return undefined;
}

function nonInteractiveEnv(kind: ShellKind): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CI: process.env.CI ?? '1',
    NO_COLOR: process.env.NO_COLOR ?? '1',
    // PowerShell only honours TERM, and unlike NO_COLOR it also covers a parse error, which aborts
    // the script before the UTF-8 prefix can run.
    ...(kind === 'powershell' ? { TERM: 'dumb' } : {}),
    PYTHONIOENCODING: 'utf-8',
    ...(kind === 'bash' ? { LANG: process.env.LANG || 'en_US.UTF-8' } : {})
  };
}

function killProcessTree(pid: number | undefined, kind: ShellKind): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
      return;
    }
    if (kind === 'bash') {
      try { process.kill(-pid, 'SIGTERM'); }
      catch { try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ } }
      const timer = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); }
        catch { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
      }, 500);
      timer.unref?.();
    }
  } catch {
    // process already exited
  }
}

function annotateResult(kind: ShellKind, result: CommandRunResult): CommandRunResult {
  let stderr = result.stderr;
  const append = (note: string): void => {
    stderr = stderr ? `${stderr}\n${note}` : note;
  };

  if (result.status === 'running' && result.processId) {
    append(`(命令已超时，转入后台继续运行；processId=${result.processId}。用 mode="output" + 该 processId 获取新增输出，或 mode="kill" 终止。)`);
  }

  if (result.exitCode === 1 && !stderr) {
    const cmd = result.command.trim();
    if (kind === 'powershell') {
      if (/^(select-string|sls|findstr|grep|rg)\b/i.test(cmd) || /\|\s*(select-string|sls|findstr|grep|rg)\b/i.test(cmd)) append('(退出码 1 表示无匹配结果，不是错误)');
      if (/^(fc|compare-object|diff)\b/i.test(cmd)) append('(退出码 1 表示文件有差异，不是错误)');
    } else {
      if (/^(grep|egrep|fgrep|rg|ag|ack)\b/i.test(cmd) || /\|\s*(grep|egrep|fgrep|rg|ag|ack)\b/i.test(cmd)) append('(退出码 1 表示无匹配结果，不是错误)');
      if (/^(diff|colordiff|cmp)\b/i.test(cmd)) append('(退出码 1 表示文件有差异，不是错误)');
    }
  }

  return { ...result, stderr };
}

function failedResult(command: string, stderr: string): CommandRunResult {
  return { command, exitCode: 1, killed: false, stdout: '', stderr };
}


const POWERSHELL_HARD_GUARDS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^(?:&\s*)?format(?:\.com)?(?:\s+|$).*\b[a-zA-Z]:/i, reason: '禁止格式化磁盘' },
  { pattern: /^(?:&\s*)?Format-Volume(?:\s|$)/i, reason: '禁止格式化文件系统/卷' },
  { pattern: /^(?:&\s*)?(?:Remove-Item|rm|del|erase|rmdir|rd)\b(?=.*(?:-(?:Recurse|r)\b|-[a-z]*r[a-z]*\b|\/s\b))(?=.*(?:-(?:Force|f)\b|-[a-z]*f[a-z]*\b|\/q\b)).*(?:^|\s)(?:--\s+)?["']?(?:[a-zA-Z]:[\\\/]|[\\\/])(?:\*|\.{1,2})?["']?(?=\s|$)/i, reason: '禁止递归强制删除根路径' }
];

const BASH_HARD_GUARDS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^(?:(?:sudo(?:\s+-\S+)*|command|builtin|nohup)\s+|env(?:\s+\S+=\S+|\s+-\S+)*\s+)*mkfs(?:\.[a-z0-9_+-]+)?(?:\s|$)/i, reason: '禁止格式化文件系统' },
  { pattern: /^(?:(?:sudo(?:\s+-\S+)*|command|builtin|nohup)\s+|env(?:\s+\S+=\S+|\s+-\S+)*\s+)*rm\b(?=.*\s-[^\s]*r)(?=.*\s-[^\s]*f).*(?:^|\s)(?:--\s+)?["']?\/(?:\*|\.{1,2})?["']?(?=\s|$)/i, reason: '禁止递归强制删除根目录' }
];

const COMMON_SAFE: Record<string, CommandSafetyConfig> = {
  git: { safeSubcommands: ['status', 'log', 'diff', 'show', 'branch', 'tag', 'remote', 'config', 'rev-parse', 'ls-files', 'grep'] },
  npm: { safeSubcommands: ['list', 'ls', 'view', 'info', 'show', 'outdated', 'audit', 'config list', 'config get', 'why', 'explain'] },
  pnpm: { safeSubcommands: ['list', 'ls', 'why', 'config list', 'outdated', 'audit'] },
  yarn: { safeSubcommands: ['list', 'info', 'why', 'config list', 'versions'] },
  node: { safeSubcommands: ['--version', '-v'] },
  python: { safeSubcommands: ['--version', '-V'] },
  python3: { safeSubcommands: ['--version', '-V'] },
  pip: { safeSubcommands: ['list', 'show', 'freeze', 'check'] },
  pip3: { safeSubcommands: ['list', 'show', 'freeze', 'check'] },
  docker: { safeSubcommands: ['ps', 'images', 'info', 'version', 'inspect', 'logs', 'stats', 'top'] },
  rg: { safe: true },
  grep: { safe: true },
  jq: { safe: true }
};

const POWERSHELL_SAFE: Record<string, CommandSafetyConfig> = {
  ...COMMON_SAFE,
  dir: { safe: true },
  type: { safe: true },
  more: { safe: true },
  findstr: { safe: true },
  where: { safe: true },
  echo: { safe: true },
  pwd: { safe: true },
  cd: { safe: true },
  ls: { safe: true },
  cat: { safe: true },
  'get-childitem': { safe: true },
  'get-content': { safe: true },
  'get-item': { safe: true },
  'test-path': { safe: true },
  'resolve-path': { safe: true },
  'select-string': { safe: true },
  'select-object': { safe: true },
  'sort-object': { safe: true },
  'where-object': { safe: true },
  'get-process': { safe: true },
  'get-service': { safe: true },
  'get-command': { safe: true },
  'get-location': { safe: true },
  'compare-object': { safe: true },
  fc: { safe: true },
  ipconfig: { isDangerous: (args) => args.some((arg) => /^\/(release|renew|flushdns|registerdns)/i.test(arg)) },
  ping: { safe: true }
};

const BASH_SAFE: Record<string, CommandSafetyConfig> = {
  ...COMMON_SAFE,
  ls: { safe: true },
  cat: { safe: true },
  head: { safe: true },
  tail: { safe: true },
  wc: { safe: true },
  stat: { safe: true },
  file: { safe: true },
  pwd: { safe: true },
  cd: { safe: true },
  echo: { safe: true },
  printf: { safe: true },
  find: { isDangerous: (args) => args.some((arg) => /^(-exec|-execdir|-delete|-ok|-okdir)$/.test(arg)) },
  sed: { isDangerous: (args) => args.some((arg) => /^-[a-zA-Z]*i/.test(arg)) },
  awk: { safe: true },
  sort: { safe: true },
  uniq: { safe: true },
  cut: { safe: true },
  tr: { safe: true },
  diff: { safe: true },
  cmp: { safe: true },
  uname: { safe: true },
  whoami: { safe: true },
  id: { safe: true },
  ps: { safe: true },
  df: { safe: true },
  du: { safe: true },
  env: { safe: true },
  printenv: { safe: true },
  which: { safe: true },
  date: { safe: true },
  sleep: { safe: true },
  ping: { isDangerous: (args) => !args.some((arg) => arg === '-c') },
  curl: { isDangerous: (args) => args.some((arg) => /^(-X|--request|-d|--data|--data-raw|--data-binary|-F|--form|--upload-file|-T|--delete)$/.test(arg)) },
  wget: { isDangerous: () => true }
};

function classifyCommand(kind: ShellKind, command: string): StaticClassification {
  const trimmed = command.trim();
  if (!trimmed) return 'deny';
  if (getHardGuardReason(kind, trimmed)) return 'deny';

  const statements = splitStatements(trimmed);
  let allAllow = true;
  for (const stmt of statements) {
    const result = classifySingleStatement(kind, stmt);
    if (result === 'deny') return 'deny';
    if (result === 'unknown') allAllow = false;
  }
  return allAllow ? 'allow' : 'unknown';
}

function classifySingleStatement(kind: ShellKind, stmt: string): StaticClassification {
  const cleaned = kind === 'bash'
    ? stmt.replace(/\s+[12]?>\s*\/dev\/null\b/g, '').replace(/\s+2>&1\b/g, '').replace(/\s+<\s*\/dev\/null\b/g, '')
    : stmt;
  if (/(?:^|[^\-])(?:>>?|2>>?)\s*[^&]/.test(cleaned)) return 'unknown';

  const tokens = stmt.trim().split(/\s+/);
  const firstToken = tokens[0]?.toLowerCase().replace(/\.exe$/, '');
  if (!firstToken) return 'unknown';
  const config = (kind === 'powershell' ? POWERSHELL_SAFE : BASH_SAFE)[firstToken];
  if (!config) return 'unknown';
  if (config.safe) return 'allow';

  const restArgs = tokens.slice(1);
  if (config.isDangerous) return config.isDangerous(restArgs) ? 'unknown' : 'allow';
  if (config.safeSubcommands) {
    const rest = stmt.slice(tokens[0].length).trim().toLowerCase();
    for (const sub of config.safeSubcommands) {
      if (rest.startsWith(sub.toLowerCase())) return 'allow';
    }
    return 'unknown';
  }
  return 'unknown';
}

function splitStatements(command: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | undefined;
  let escaped = false;

  const pushCurrent = (): void => {
    const text = current.trim();
    if (text) result.push(text);
    current = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && quote !== 'single') {
      current += char;
      escaped = true;
      continue;
    }

    if (char === '`' && quote !== 'single') {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if ((quote === 'single' && char === "'") || (quote === 'double' && char === '"')) quote = undefined;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char === "'" ? 'single' : 'double';
      current += char;
      continue;
    }

    if (char === ';' || char === '|' || char === '&' || char === '\n' || char === '\r') {
      pushCurrent();
      if ((char === '|' || char === '&') && command[index + 1] === char) index += 1;
      if (char === '\r' && command[index + 1] === '\n') index += 1;
      continue;
    }

    current += char;
  }

  pushCurrent();
  return result;
}

function getDenyReason(kind: ShellKind, command: string): string | null {
  return getHardGuardReason(kind, command);
}

function getHardGuardReason(kind: ShellKind, command: string): string | null {
  const hardGuards = kind === 'powershell' ? POWERSHELL_HARD_GUARDS : BASH_HARD_GUARDS;
  for (const statement of splitStatements(command.trim())) {
    for (const { pattern, reason } of hardGuards) if (pattern.test(statement)) return reason;
  }
  return null;
}
