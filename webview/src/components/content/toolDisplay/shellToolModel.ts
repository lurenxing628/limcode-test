import type { ToolCallEventRecord } from '@shared/protocol';
import { commandToolArgumentMetadata } from '@shared/commandToolArguments';
import type { ToolDisplayContext, ToolDisplaySection } from './types';

export interface ShellArgs {
  command?: string;
  cwd?: string;
  foregroundWaitMs?: number;
  force?: boolean;
  scheduling?: string;
  explanation?: string;
  mode?: string;
  processId?: string;
  processRef?: string;
  readonly?: string;
  wait?: string;
}

export interface ShellResultOutput {
  command?: string;
  exitCode?: number;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
  status?: string;
  processId?: string;
  running?: boolean;
  droppedChars?: number;
  mode?: string;
  inferredMode?: boolean;
  ignoredFields?: string[];
  warning?: string;
}

export function parseShellArgs(value: unknown): ShellArgs {
  const record = asRecord(value);
  if (!record) return {};
  return {
    command: stringValue(record.command),
    cwd: stringValue(record.cwd),
    foregroundWaitMs: numberValue(record.foregroundWaitMs),
    force: booleanValue(record.force),
    scheduling: stringValue(record.scheduling),
    explanation: stringValue(record.explanation),
    mode: stringValue(record.mode),
    processId: stringValue(record.processId),
    processRef: stringValue(record.processRef),
    readonly: stringValue(record.readonly),
    wait: stringValue(record.wait)
  };
}

export function parseShellCallArgs(argsJson: string): ShellArgs {
  if (!argsJson.trim()) return {};
  try {
    return parseShellArgs(JSON.parse(argsJson));
  } catch {
    return {};
  }
}

export function parseShellResultOutput(result: unknown): ShellResultOutput | undefined {
  const resultRecord = asRecord(result);
  const detailRecord = asRecord(resultRecord?.detail);
  const output = detailRecord && 'output' in detailRecord
    ? detailRecord.output
    : resultRecord && 'output' in resultRecord
      ? resultRecord.output
      : detailRecord ?? result;
  const outputRecord = asRecord(output);
  const parsed = typeof output === 'string' ? parseStringOutput(output)
    : outputRecord ? shellResultOutput(outputRecord) : undefined;
  // The reliable result keeps selection metadata beside output, not inside stdout/stderr.
  const metadata = shellPresentationMetadata({ ...outputRecord, ...resultRecord, ...detailRecord });
  return parsed || Object.keys(metadata).length > 0 ? { ...parsed, ...metadata } : undefined;
}

export function shellInputSections(args: ShellArgs, context: ToolDisplayContext): ToolDisplaySection[] {
  const sections: ToolDisplaySection[] = [];
  const metadata = commandArgumentMetadata(context.args);
  const rows = shellPresentationRows(metadata);
  if (rows.length > 0) sections.push({ kind: 'input', title: '操作', rows });
  const explanation = args.explanation?.trim();
  if (explanation) sections.push({ kind: 'input', title: '说明', text: explanation });
  const command = args.command?.trim();
  if (command) sections.push({ kind: 'input', title: metadata.ignoredFields?.includes('command') ? '未使用的命令' : '命令', text: command });

  const optionLines = [
    args.cwd?.trim() ? `工作目录 ${args.cwd.trim()}` : undefined,
    typeof args.foregroundWaitMs === 'number' && Number.isFinite(args.foregroundWaitMs) ? `前台等待 ${args.foregroundWaitMs} 毫秒` : undefined,
    typeof args.force === 'boolean' ? `强制执行 ${args.force ? '是' : '否'}` : undefined,
    args.scheduling?.trim() ? `执行方式 ${args.scheduling === 'parallel' ? '并行' : args.scheduling === 'serial' ? '依次' : args.scheduling.trim()}` : undefined,
    args.processRef?.trim() ? `进程 ${args.processRef.trim()}` : args.processId?.trim() ? '后台进程' : undefined
  ].filter((line): line is string => Boolean(line));
  if (optionLines.length > 0) sections.push({ kind: 'input', title: '参数', text: optionLines.join('\n') });

  if (sections.length === 0) sections.push({ kind: 'input', title: '输入', text: context.stringifyValue(context.args) });
  return sections;
}

export function shellOutputSections(context: ToolDisplayContext): ToolDisplaySection[] {
  const output = parseShellResultOutput(context.result);
  const stdout = shellStreamText(context.events, 'stdout') || output?.stdout || '';
  const stderr = shellStreamText(context.events, 'stderr') || output?.stderr || '';
  const progress = shellProgressText(context.events, context.stringifyValue);
  const sections: ToolDisplaySection[] = [];

  if (stdout) sections.push({ kind: 'output', title: '标准输出', text: stdout });
  if (stderr) sections.push({ kind: 'output', title: '标准错误', text: stderr });
  if (progress) sections.push({ kind: 'output', title: '过程', text: progress });

  const exitInfo = shellExitInfo(output);
  if (exitInfo) sections.push({ kind: 'output', title: '执行信息', text: exitInfo });

  if (sections.length === 0 && context.result !== undefined) {
    sections.push({ kind: 'output', title: '输出', text: context.stringifyValue(context.result) });
  }

  const rows = shellPresentationRows(output);
  if (rows.length > 0) sections.push({ kind: 'output', title: '操作说明', rows });

  return sections;
}

export function shellStreamText(events: readonly ToolCallEventRecord[], kind: 'stdout' | 'stderr'): string {
  return events
    .filter((event) => event.kind === kind && typeof event.delta === 'string')
    .map((event) => event.delta)
    .join('');
}

export function shellProgressText(events: readonly ToolCallEventRecord[], stringifyValue: (value: unknown) => string): string {
  const progressEvents = events
    .filter((event) => event.kind === 'progress' && event.payload !== undefined)
    .map((event) => stringifyValue(withoutInternalIds(event.payload)));
  return progressEvents.join('\n');
}

export function shellExitInfo(output: ShellResultOutput | undefined): string {
  if (!output) return '';
  const lines = [
    output.status ? `status ${output.status}` : undefined,
    typeof output.running === 'boolean' ? `running ${output.running}` : undefined,
    typeof output.exitCode === 'number' ? `exitCode ${output.exitCode}` : undefined,
    typeof output.killed === 'boolean' ? `killed ${output.killed}` : undefined,
    typeof output.droppedChars === 'number' && output.droppedChars > 0 ? `droppedChars ${output.droppedChars}` : undefined
  ].filter((line): line is string => Boolean(line));
  return lines.join('\n');
}

function parseStringOutput(output: string): ShellResultOutput | undefined {
  const text = output.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    const record = asRecord(parsed);
    return record ? shellResultOutput(record) : undefined;
  } catch {
    return { stdout: output };
  }
}

function shellResultOutput(record: Record<string, unknown>): ShellResultOutput {
  return {
    command: stringValue(record.command),
    exitCode: numberValue(record.exitCode),
    killed: booleanValue(record.killed),
    stdout: stringValue(record.stdout),
    stderr: stringValue(record.stderr),
    status: stringValue(record.status),
    processId: stringValue(record.processId),
    running: booleanValue(record.running),
    droppedChars: numberValue(record.droppedChars),
    ...shellPresentationMetadata(record)
  };
}

function commandArgumentMetadata(value: unknown): ShellResultOutput {
  try {
    return shellPresentationMetadata(commandToolArgumentMetadata(value));
  } catch {
    return {};
  }
}

function shellPresentationMetadata(record: Record<string, unknown>): ShellResultOutput {
  const mode = stringValue(record.mode);
  const inferredMode = booleanValue(record.inferredMode);
  const ignoredFields = Array.isArray(record.ignoredFields)
    ? record.ignoredFields.filter((field): field is string => typeof field === 'string') : undefined;
  const warning = stringValue(record.warning);
  return {
    ...(mode ? { mode } : {}),
    ...(inferredMode !== undefined ? { inferredMode } : {}),
    ...(ignoredFields?.length ? { ignoredFields } : {}),
    ...(warning ? { warning } : {})
  };
}

function shellPresentationRows(output: ShellResultOutput | undefined): Array<{ label: string; value: string }> {
  if (!output) return [];
  const rows: Array<{ label: string; value: string }> = [];
  if (output.mode) rows.push({ label: '模式', value: `${output.mode}${output.inferredMode ? '（自动识别）' : ''}` });
  if (output.ignoredFields?.length) rows.push({ label: '未使用参数', value: output.ignoredFields.join('、') });
  if (output.warning) rows.push({ label: '说明', value: output.warning });
  return rows;
}

function withoutInternalIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutInternalIds);
  const record = asRecord(value);
  if (!record) return value;
  const omitted = new Set([
    'processId', 'processReceiptId', 'toolCallId', 'operationId', 'effectIntentId',
    'turnId', 'conversationId', 'sourceTurnId', 'deliveryId', 'inboxItemId'
  ]);
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => !omitted.has(key))
    .map(([key, nested]) => [key, withoutInternalIds(nested)]));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
