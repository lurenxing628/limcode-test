import type { CommandCapability } from '../../../../../capabilities/types';
import { powerShellCommandSyntaxGuidance, resolveWindowsPowerShell } from '../../../../../capabilities/windowsPowerShell';
import type { ToolConfigRecord } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { normalizeSchedulingHint } from '../../schedulingContract';
import { defineToolDefinitionModule } from '../types';

export const commandToolModule = defineToolDefinitionModule({
  id: 'command',
  create({ command }) {
    return createCommandTool(command);
  }
});

export function createCommandTool(command: CommandCapability): ToolDefinition {
  return {
    declaration: {
      name: command.toolName,
      description: command.description,
      parameters: {
        type: 'object',
        properties: {
          explanation: {
            type: 'string',
            description: 'Required for mode=execute. Briefly explain what the command will do and why. Optional for mode=output/kill so observation calls stay compact.'
          },
          mode: {
            type: 'string',
            description: 'Operation mode. Defaults to execute. execute starts a new command; output reads one resumable page from a background process; kill terminates a background process. output/kill require a processId returned by an earlier execute result.'
          },
          command: {
            type: 'string',
            description: command.toolName === 'shell'
              ? `PowerShell command to execute. Syntax: ${powerShellCommandSyntaxGuidance(resolveWindowsPowerShell().edition)} Required when mode=execute.`
              : 'Bash/Shell command to execute. Prefer joining multiple commands with &&. Quote paths that contain spaces. Required when mode=execute.'
          },
          cwd: {
            type: 'string',
            description: 'Working directory relative to the workspace root. Defaults to the workspace root. Only used when mode=execute.'
          },
          foregroundWaitMs: {
            type: 'integer',
            minimum: 0,
            maximum: 60000,
            description: 'Required for mode=execute. Integer milliseconds from 0 to 60000 to wait before returning a still-running command as a background process. Use 0 to background immediately. This does not terminate the command; executionTimeoutMs controls the hard deadline.'
          },
          executionTimeoutMs: {
            type: 'integer',
            minimum: 1000,
            maximum: 600000,
            default: 120000,
            description: 'Optional hard execution deadline in milliseconds, independent of foregroundWaitMs. Defaults to 120000; allowed range 1000-600000. The detached runtime terminates the process group at this deadline and reports timed_out.'
          },
          maxOutputBytes: {
            type: 'integer',
            minimum: 1024,
            maximum: 1073741824,
            default: 268435456,
            description: 'Optional combined stdout+stderr safety limit in bytes. Defaults to 268435456 (256 MiB); allowed range 1024-1073741824. Exceeding it terminates the process and reports output_limit_exceeded.'
          },
          processId: {
            type: 'string',
            description: 'Do not provide this when mode=execute. The runtime generates and returns processId when an execute command is moved to the background. Required only for mode=output or mode=kill; copy it from a previous shell/bash result or background notification.'
          },
          outputHandle: {
            type: 'string',
            description: 'Only for mode=output. Omit on the first read. When a result returns nextOutputHandle, pass that exact opaque value to continue from the next output chunk. Pages traverse retained history up to maxOutputBytes. Running-only liveStdout/liveStderr fields are provisional and do not advance this handle. Background completion is delivered proactively; do not poll unless the user explicitly requests a progress check.'
          },
          readonly: {
            type: 'string',
            description: 'Whether this command is read-only and does not modify files, system state, or network state. Use "true" for read-only commands; read-only commands may be auto-approved when the policy allows it.'
          },
          wait: {
            type: 'string',
            description: 'Legacy scheduling hint. Prefer the scheduling field. "true" means serial and "false" means parallel when scheduling is omitted.'
          },
          scheduling: {
            type: 'string',
            enum: ['parallel', 'serial'],
            description: 'Tool-call scheduling mode. Explicit parallel/serial wins. Without a hint, output reads and recognized read-only commands may run in parallel; other commands remain serial.'
          }
        }
      },
      metadata: {
        category: 'command',
        scope: 'command',
        riskLevel: 'command',
        readonly: false,
        defaultEnabled: true,
        requiresApproval: true,
        defaultAutoApproveExecution: true,
        checkpoint: { before: true, after: true }
      },
      configSchema: {
        fields: [
          {
            key: 'denyCommands',
            label: '命令黑名单',
            type: 'stringList',
            description: '命令文本包含任一黑名单片段时，后端会自动拒绝执行。',
            placeholder: '例如：format\nshutdown\nrm -rf /'
          },
          {
            key: 'allowCommands',
            label: '命令白名单',
            type: 'stringList',
            description: '配置非空时，仅命令文本包含白名单片段的命令可以执行；未匹配命令会由后端拒绝。',
            placeholder: '例如：git status\nnpm run compile'
          },
          {
            key: 'autoApproveReadonly',
            label: '只读命令自动跳过审批',
            type: 'boolean',
            description: '开启后，即使未开启"自动批准执行"，被模型标记为只读(readonly=true)或被后端识别为只读的命令也会自动批准。',
            defaultValue: true
          }
        ]
      },
      defaultConfig: {
        denyCommands: [],
        allowCommands: [],
        autoApproveReadonly: true
      }
    },
    execution: 'runtime',
    scheduling: (rawArgs) => resolveCommandScheduling(rawArgs),
    summary: summarizeCommandToolCall,
    async execute(rawArgs, deps, ctx) {
      const args = (rawArgs ?? {}) as CommandToolArgs;
      const config = normalizeCommandToolConfig(ctx?.config);
      const mode = args.mode === 'output' || args.mode === 'kill' ? args.mode : 'execute';

      if (mode === 'output') {
        const processId = (args.processId ?? '').trim();
        if (!processId) return { ok: false, output: '缺少 processId：mode=output 需要指定后台进程 id。' };
        return {
          ok: true,
          output: deps.command.readOutput(processId)
        };
      }

      if (mode === 'kill') {
        const processId = (args.processId ?? '').trim();
        if (!processId) return { ok: false, output: '缺少 processId：mode=kill 需要指定后台进程 id。' };
        return { ok: true, output: deps.command.kill(processId) };
      }

      const commandText = (args.command ?? '').trim();
      if (!commandText) return { ok: false, output: 'mode=execute 需要提供 command。' };
      if (typeof args.explanation !== 'string' || args.explanation.trim().length === 0) {
        return { ok: false, output: 'mode=execute 需要提供 explanation。' };
      }
      if (typeof args.foregroundWaitMs !== 'number' || !Number.isSafeInteger(args.foregroundWaitMs) || args.foregroundWaitMs < 0 || args.foregroundWaitMs > 60_000) {
        return { ok: false, output: 'foregroundWaitMs 为必填参数，需为 0 到 60000 的整数毫秒数（0 表示启动后立即转后台）。' };
      }
      if (args.executionTimeoutMs !== undefined && (
        typeof args.executionTimeoutMs !== 'number'
        || !Number.isSafeInteger(args.executionTimeoutMs)
        || args.executionTimeoutMs < 1_000
        || args.executionTimeoutMs > 600_000
      )) {
        return { ok: false, output: 'executionTimeoutMs 需为 1000 到 600000 的整数毫秒数。' };
      }
      if (args.maxOutputBytes !== undefined && (
        typeof args.maxOutputBytes !== 'number'
        || !Number.isSafeInteger(args.maxOutputBytes)
        || args.maxOutputBytes < 1_024
        || args.maxOutputBytes > 1_073_741_824
      )) {
        return { ok: false, output: 'maxOutputBytes 需为 1024 到 1073741824 的整数。' };
      }
      const deniedBy = firstMatchedCommandRule(commandText, config.denyCommands);
      if (deniedBy) return { ok: false, output: `命令已被工具策略黑名单拒绝：${deniedBy}` };

      const origin = ctx?.runId && ctx.conversationId && ctx.attemptId && ctx.generation !== undefined
        ? {
            sourceToolCallId: ctx.toolCallId,
            sourceRunId: ctx.runId,
            conversationId: ctx.conversationId,
            sourceAttemptId: ctx.attemptId,
            sourceGeneration: ctx.generation
          }
        : undefined;
      const result = await deps.command.run({
        command: args.command,
        cwd: args.cwd,
        foregroundWaitMs: args.foregroundWaitMs,
        executionTimeoutMs: args.executionTimeoutMs,
        maxOutputBytes: args.maxOutputBytes,
        executionId: ctx?.toolCallId,
        ...(origin ? { backgroundProcessOrigin: origin } : {}),
        ...(ctx?.signal ? { signal: ctx.signal } : {})
      }, {
        onEvent(event) {
          ctx?.emit({
            kind: event.kind,
            ...(event.delta !== undefined ? { delta: event.delta } : {}),
            ...(event.payload !== undefined ? { payload: event.payload } : {})
          });
        }
      }, { workEnvironment: ctx?.workEnvironment, accessibleWorkEnvironments: ctx?.accessibleWorkEnvironments });
      const ok = result.status === 'running' || result.exitCode === 0;
      return {
        ok,
        output: result,
        ...(result.status === 'running' && result.processId
          ? { backgroundProcesses: [{ id: result.processId, processId: result.processId, status: 'running' as const }] }
          : {})
      };
    }
  };
}

type CommandToolArgs = {
  command?: string;
  cwd?: string;
  foregroundWaitMs?: number;
  executionTimeoutMs?: number;
  maxOutputBytes?: number;
  mode?: string;
  processId?: string;
  outputHandle?: string;
  readonly?: string;
  wait?: string;
  scheduling?: string;
  explanation?: string;
};

function summarizeCommandToolCall(rawArgs: unknown): string | undefined {
  const args = (rawArgs ?? {}) as CommandToolArgs;
  const explanation = typeof args.explanation === 'string' ? args.explanation.trim() : '';
  if (!explanation) return undefined;
  return explanation.replace(/\s+/g, ' ');
}

/** 显式调度提示优先；无提示时仍使用本地分类避免把所有命令盲目并行。 */
function resolveCommandScheduling(rawArgs: unknown): { mode: 'parallel' | 'serial'; reason: string } {
  const args = isCommandArgsRecord(rawArgs) ? rawArgs : {};
  const classification = classifyCommandCall(rawArgs);
  const scheduling = normalizeSchedulingHint(args.scheduling);
  if (scheduling !== 'auto') return { mode: scheduling, reason: `model_selected_${scheduling}` };
  const wait = typeof args.wait === 'string' ? args.wait.trim().toLowerCase() : '';
  if (wait === 'false') return { mode: 'parallel', reason: 'legacy_wait_false' };
  if (wait === 'true') return { mode: 'serial', reason: 'legacy_wait_true' };
  if (classification.parallelSafe) return { mode: 'parallel', reason: classification.reason };
  return { mode: 'serial', reason: classification.reason };
}

export interface TrustedCommandClassification {
  mode: 'execute' | 'output' | 'kill';
  readonly: boolean;
  parallelSafe: boolean;
  reason: string;
}

/**
 * 本地分类用于没有显式提示时给出合理默认值，也保留给诊断和展示使用。
 */
export function classifyCommandCall(rawArgs: unknown): TrustedCommandClassification {
  if (!isCommandArgsRecord(rawArgs)) {
    return untrustedExecuteClassification('invalid_arguments');
  }
  const mode = rawArgs.mode === 'output' || rawArgs.mode === 'kill' ? rawArgs.mode : 'execute';
  if (mode === 'output') {
    return { mode, readonly: true, parallelSafe: true, reason: 'trusted_process_output' };
  }
  if (mode === 'kill') {
    return { mode, readonly: false, parallelSafe: false, reason: 'process_kill_side_effect' };
  }

  const command = typeof rawArgs.command === 'string' ? rawArgs.command.trim() : '';
  if (!command) return untrustedExecuteClassification('missing_command');
  if (SHELL_CONTROL_PATTERN.test(command)) return untrustedExecuteClassification('shell_composition');
  const tokens = tokenizeSimpleCommand(command);
  if (!tokens || tokens.length === 0) return untrustedExecuteClassification('parse_failure');
  const executable = executableBasename(tokens[0]!);
  if (!isTrustedReadonlyInvocation(executable, tokens.slice(1))) {
    return untrustedExecuteClassification('untrusted_execute_command');
  }
  return {
    mode,
    readonly: true,
    parallelSafe: true,
    reason: `trusted_readonly_${executable}`
  };
}

/** 接受模型的只读声明，同时保留后端对常见只读命令的自动识别。 */
export function isReadonlyCommandCall(rawArgs: unknown): boolean {
  const args = isCommandArgsRecord(rawArgs) ? rawArgs : undefined;
  const hintedReadonly = typeof args?.readonly === 'string'
    && args.readonly.trim().toLowerCase() === 'true';
  return hintedReadonly || classifyCommandCall(rawArgs).readonly;
}

const SHELL_CONTROL_PATTERN = /[;&|<>`$\n\r\0]/;
const SIMPLE_READONLY_EXECUTABLES = new Set(['pwd', 'ls', 'grep', 'cat', 'head', 'tail', 'wc', 'stat']);
const READONLY_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'grep']);

function isCommandArgsRecord(value: unknown): value is CommandToolArgs {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function untrustedExecuteClassification(reason: string): TrustedCommandClassification {
  return { mode: 'execute', readonly: false, parallelSafe: false, reason };
}

function executableBasename(value: string): string {
  const basename = value.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  return basename.endsWith('.exe') ? basename.slice(0, -4) : basename;
}

function isTrustedReadonlyInvocation(executable: string, args: readonly string[]): boolean {
  if (SIMPLE_READONLY_EXECUTABLES.has(executable)) return true;
  if (executable === 'rg') {
    return !args.some((arg) => {
      const lower = arg.toLowerCase();
      return lower === '--pre'
        || lower.startsWith('--pre=')
        || lower === '--hostname-bin'
        || lower.startsWith('--hostname-bin=');
    });
  }
  if (executable === 'file') {
    return !args.some((arg) => (
      (arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).includes('C'))
      || arg.toLowerCase().startsWith('--compile')
    ));
  }
  if (executable === 'find') {
    return !args.some((arg) => {
      const lower = arg.toLowerCase();
      return [
        '-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'
      ].some((flag) => lower === flag || lower.startsWith(`${flag}=`));
    });
  }
  if (executable !== 'git') return false;
  const subcommand = args[0]?.toLowerCase() ?? '';
  if (!READONLY_GIT_SUBCOMMANDS.has(subcommand)) return false;
  return !args.slice(1).some((arg) => {
    const lower = arg.toLowerCase();
    const abbreviatedDangerousLongOption = lower.startsWith('--') && [
      '--output', '--ext-diff', '--textconv', '--open-files-in-pager'
    ].some((option) => option.startsWith(lower.split('=')[0]!));
    return arg.startsWith('-O')
      || (lower.startsWith('-o') && !lower.startsWith('--'))
      || abbreviatedDangerousLongOption;
  });
}

/** Tokenizes one command only. Shell operators are rejected before this parser runs. */
function tokenizeSimpleCommand(command: string): string[] | undefined {
  const tokens: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) {
        quote = undefined;
        tokenStarted = true;
        continue;
      }
      if (char === '\\' && quote === '"') {
        const next = command[index + 1];
        if (next === undefined) return undefined;
        token += next;
        tokenStarted = true;
        index += 1;
        continue;
      }
      token += char;
      tokenStarted = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(token);
        token = '';
        tokenStarted = false;
      }
      continue;
    }
    if (char === '\\') {
      const next = command[index + 1];
      if (next === undefined) return undefined;
      token += next;
      tokenStarted = true;
      index += 1;
      continue;
    }
    token += char;
    tokenStarted = true;
  }
  if (quote) return undefined;
  if (tokenStarted) tokens.push(token);
  return tokens;
}

interface NormalizedCommandToolConfig {
  denyCommands: string[];
  allowCommands: string[];
  autoApproveReadonly: boolean;
}

function normalizeCommandToolConfig(config: ToolConfigRecord | undefined): NormalizedCommandToolConfig {
  return {
    denyCommands: normalizeStringList(config?.denyCommands),
    allowCommands: normalizeStringList(config?.allowCommands),
    autoApproveReadonly: config?.autoApproveReadonly !== false
  };
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

function firstMatchedCommandRule(command: string, rules: readonly string[]): string | undefined {
  const normalizedCommand = command.toLowerCase();
  return rules.find((rule) => normalizedCommand.includes(rule.toLowerCase()));
}
