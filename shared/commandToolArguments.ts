import { isEmptyToolArgument, normalizeToolInteger, ToolArgumentError, toolArgumentRecord } from './toolArgumentUtils';

export type CommandToolMode = 'execute' | 'output' | 'kill';
export interface CommandToolArguments extends Record<string, unknown> {
  mode: CommandToolMode;
  command?: string;
  explanation?: string;
  processId?: string;
  outputHandle?: string;
  cwd?: string;
  foregroundWaitMs?: number;
  executionTimeoutMs?: number;
  maxOutputBytes?: number;
}

export function commandToolMode(value: unknown): CommandToolMode {
  const args = toolArgumentRecord(value, 'command arguments');
  const mode = typeof args.mode === 'string' ? args.mode.trim().toLowerCase() : args.mode;
  if (mode === undefined || mode === null || mode === '') {
    if (['processRef', 'processId', 'cursor', 'outputHandle'].some(key => !isEmptyToolArgument(args[key]))) {
      throw new ToolArgumentError('A process target requires mode="output" or mode="kill".');
    }
    return 'execute';
  }
  if (mode === 'execute' || mode === 'output' || mode === 'kill') return mode;
  throw new ToolArgumentError('mode must be "execute", "output", or "kill".');
}

/** Derived execution copy; harmless extras never select another operation. */
export function validateCommandToolArguments(value: unknown): CommandToolArguments {
  const source = toolArgumentRecord(value, 'command arguments');
  const args: CommandToolArguments = { ...source, mode: commandToolMode(source) };
  for (const key of ['cwd', 'foregroundWaitMs', 'executionTimeoutMs', 'maxOutputBytes', 'readonly', 'wait', 'scheduling', 'processId', 'processRef', 'outputHandle', 'cursor']) {
    if (isEmptyToolArgument(args[key])) delete args[key];
  }
  if (args.mode === 'execute') {
    args.command = requiredText(args.command, 'command');
    args.explanation = requiredText(args.explanation, 'explanation');
    for (const key of ['processId', 'processRef', 'outputHandle', 'cursor']) delete args[key];
    if (args.cwd !== undefined && typeof args.cwd !== 'string') throw new ToolArgumentError('cwd must be a string.');
    for (const [key, minimum, maximum] of COMMAND_BUDGETS) {
      if (args[key] !== undefined) args[key] = normalizeToolInteger(args[key], key, minimum, minimum, maximum);
    }
  } else {
    requiredText(args.processId ?? args.processRef, `mode=${args.mode}: processRef/processId`);
    if (args.mode === 'kill') {
      delete args.outputHandle;
      delete args.cursor;
    } else {
      if (args.outputHandle !== undefined) requiredText(args.outputHandle, 'cursor');
      if (args.cursor !== undefined) requiredText(args.cursor, 'cursor');
    }
    for (const key of ['command', 'cwd', 'foregroundWaitMs', 'executionTimeoutMs', 'maxOutputBytes', 'readonly']) delete args[key];
  }
  return args;
}

export function commandToolArgumentMetadata(value: unknown): Record<string, unknown> {
  const source = toolArgumentRecord(value, 'command arguments');
  const mode = commandToolMode(source);
  const ignoredFields = (mode === 'execute'
    ? ['processId', 'processRef', 'outputHandle', 'cursor']
    : ['command', 'cwd', 'foregroundWaitMs', 'executionTimeoutMs', 'maxOutputBytes', 'readonly', ...(mode === 'kill' ? ['outputHandle', 'cursor'] : [])])
    .filter(key => !isEmptyToolArgument(source[key]))
    .map(key => key === 'processId' ? 'processRef' : key === 'outputHandle' ? 'cursor' : key);
  const adjustedArguments: Record<string, number> = {};
  if (mode === 'execute') {
    for (const [key, minimum, maximum] of COMMAND_BUDGETS) {
      if (isEmptyToolArgument(source[key])) continue;
      try {
        const normalized = normalizeToolInteger(source[key], key, minimum, minimum, maximum);
        if (source[key] !== normalized) adjustedArguments[key] = normalized;
      } catch { /* Presentation must not reinterpret old execution facts. */ }
    }
  }
  const warnings = [
    ...(ignoredFields.length ? [`已选择 mode=${mode}；未使用参数：${[...new Set(ignoredFields)].join('、')}。`] : []),
    ...(Object.keys(adjustedArguments).length ? [`参数已调整为：${Object.entries(adjustedArguments).map(([key, adjusted]) => `${key}=${adjusted}`).join('、')}。`] : [])
  ];
  return { mode,
    ...(isEmptyToolArgument(source.mode) ? { inferredMode: true } : {}),
    ...(ignoredFields.length ? { ignoredFields: [...new Set(ignoredFields)] } : {}),
    ...(Object.keys(adjustedArguments).length ? { adjustedArguments } : {}),
    ...(warnings.length ? { warning: warnings.join(' ') } : {})
  };
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ToolArgumentError(`${name} must be a non-empty string.`);
  return value;
}

const COMMAND_BUDGETS = [
  ['foregroundWaitMs', 0, 60_000],
  ['executionTimeoutMs', 1_000, 600_000],
  ['maxOutputBytes', 1_024, 1_073_741_824]
] as const;
