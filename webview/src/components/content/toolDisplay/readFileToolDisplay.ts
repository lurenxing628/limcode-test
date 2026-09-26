import { IconFileDescription } from '@tabler/icons-vue';
import type { ToolDisplayContext, ToolDisplayResolver, ToolDisplaySection } from './types';
import { normalizeDisplayPath } from '@shared/displayPath';

type ReadFileMode = 'text' | 'attachment';

interface ReadFileArgs {
  path?: string;
  attachmentId?: string;
  attachmentRef?: string;
  pages?: string;
  mode?: ReadFileMode;
  startLine?: number;
  endLine?: number;
}

interface ReadFileLineRecord {
  line?: number;
  text?: string;
}

interface ReadFileOutputRecord {
  path?: string;
  attachmentId?: string;
  name?: string;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  lines?: unknown;
  content?: unknown;
  contentTruncated?: unknown;
  omittedChars?: unknown;
  requestedPages?: unknown;
  returnedPages?: unknown;
  totalPages?: unknown;
  hasMore?: unknown;
  nextPages?: unknown;
  mimeType?: unknown;
  sizeBytes?: unknown;
}

export const readFileToolDisplay: ToolDisplayResolver = (context) => {
  const args = readFileArgs(context.args);
  const inputSections = readFileInputSections(args, context);
  const outputSections = readFileOutputSections(args, context);

  return {
    headerIcon: IconFileDescription,
    inputSections: inputSections ?? [],
    outputSections: outputSections ?? []
  };
};

function readFileInputSections(args: ReadFileArgs, context: ToolDisplayContext): ToolDisplaySection[] | undefined {
  const path = normalizeDisplayPath(args.path);
  const attachmentId = normalizedText(args.attachmentId);
  const attachmentRef = normalizedText(args.attachmentRef);
  if (!path && !attachmentId && !attachmentRef) return undefined;

  const rows = parameterRows([
    { label: '路径', value: path || undefined },
    { label: '附件', value: attachmentRef ?? (attachmentId ? '历史附件' : undefined) },
    { label: '页范围', value: args.pages },
    {
      label: '读取方式',
      value: attachmentId || attachmentRef ? '历史附件（自动识别）' : args.mode === 'attachment' ? '附件' : '文本'
    },
    { label: '行范围', value: !attachmentId && !attachmentRef && args.mode !== 'attachment' ? lineRangeText(args.startLine, args.endLine) : undefined }
  ]);

  return rows.length > 0
    ? [{ kind: 'input', title: '读取参数', rows, rowStyle: 'keyValue' }]
    : [{ kind: 'input', title: '输入', text: context.stringifyValue(context.args) }];
}

function readFileOutputSections(args: ReadFileArgs, context: ToolDisplayContext): ToolDisplaySection[] | undefined {
  if (context.result === undefined) return undefined;

  const output = toolOutput(context.result);
  const record = outputRecord(output);
  const path = normalizeDisplayPath(record?.path) || normalizeDisplayPath(args.path);
  const attachmentId = normalizedText(record?.attachmentId) || normalizedText(args.attachmentId);
  const displaySource = path || normalizedText(record?.name) || attachmentId;
  const mode: ReadFileMode = attachmentOutput(record) ? 'attachment' : args.mode ?? 'text';
  const modeSuffix = `[${mode}]`;
  const pagesSuffix = normalizedText(record?.returnedPages) || args.pages
    ? `[pages ${normalizedText(record?.returnedPages) ?? args.pages}]`
    : '';
  const rangeSuffix = mode === 'attachment' || attachmentId
    ? ''
    : lineRangeSuffix(record?.startLine ?? args.startLine, record?.endLine ?? args.endLine);
  const title = displaySource
    ? `读取结果 · ${displaySource}${modeSuffix}${pagesSuffix}${rangeSuffix}`
    : '读取结果';

  const section = readFileOutputSection(title, output);
  if (!section) return undefined;

  return [section];
}

function readFileArgs(value: unknown): ReadFileArgs {
  const record = asRecord(value);
  if (!record) return {};
  return {
    path: stringValue(record.path),
    attachmentId: normalizedText(record.attachmentId),
    attachmentRef: normalizedText(record.attachmentRef),
    pages: normalizedText(record.pages),
    mode: readFileMode(record.mode),
    startLine: numberValue(record.startLine),
    endLine: numberValue(record.endLine)
  };
}

function toolOutput(result: unknown): unknown {
  const record = asRecord(result);
  return record && 'output' in record ? record.output : result;
}

function readFileOutputSection(title: string, output: unknown): ToolDisplaySection | undefined {
  if (typeof output === 'string') return output ? { kind: 'output', title, text: output } : undefined;

  const record = outputRecord(output);
  if (!record) return undefined;

  const lines = lineRecords(record.lines);
  if (lines.length > 0) return { kind: 'output', title, rows: readLineRows(lines), rowStyle: 'lineNumber' };

  if (attachmentOutput(record)) {
    const rows = parameterRows([
      { label: '文件类型', value: stringValue(record.mimeType) },
      { label: '大小', value: attachmentSizeText(record.sizeBytes) },
      { label: '请求页范围', value: normalizedText(record.requestedPages) },
      { label: '实际页范围', value: normalizedText(record.returnedPages) },
      { label: '总页数', value: integerText(record.totalPages) },
      { label: '下一范围', value: normalizedText(record.nextPages) }
    ]);
    return rows.length > 0 ? { kind: 'output', title, rows, rowStyle: 'keyValue' } : undefined;
  }

  if (typeof record.content === 'string') {
    const omittedChars = numberValue(record.omittedChars);
    const pageSummary = normalizedText(record.returnedPages)
      ? `\n\n[实际页范围 ${normalizedText(record.returnedPages)} / 共 ${integerText(record.totalPages) ?? '?'} 页${normalizedText(record.nextPages) ? `；下一范围 ${normalizedText(record.nextPages)}` : ''}]`
      : '';
    const truncationSummary = record.contentTruncated === true
      ? `\n\n[内容已截断${omittedChars !== undefined ? `，省略 ${omittedChars} 个字符` : ''}]`
      : '';
    return { kind: 'output', title, text: `${record.content}${pageSummary}${truncationSummary}` };
  }
  return undefined;
}

function outputRecord(value: unknown): ReadFileOutputRecord | undefined {
  const record = asRecord(value);
  return record ? record as ReadFileOutputRecord : undefined;
}

function lineRecords(value: unknown): ReadFileLineRecord[] {
  if (!Array.isArray(value)) return [];
  const lines: ReadFileLineRecord[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const line = numberValue(record?.line);
    if (line === undefined) continue;
    const text = typeof record?.text === 'string' ? record.text : '';
    lines.push({ line, text });
  }
  return lines;
}

function parameterRows(items: Array<{ label: string; value: string | undefined }>): Array<{ label: string; value: string }> {
  return items.filter((item): item is { label: string; value: string } => Boolean(item.value));
}

function readLineRows(lines: ReadFileLineRecord[]): Array<{ label: string; value: string }> {
  return lines
    .filter((line): line is { line: number; text?: string } => typeof line.line === 'number')
    .map((line) => ({ label: String(line.line), value: line.text ?? '' }));
}

function lineRangeText(startLine: number | undefined, endLine: number | undefined): string | undefined {
  const suffix = lineRangeSuffix(startLine, endLine);
  return suffix ? suffix.slice(1, -1) : undefined;
}

function lineRangeSuffix(startLine: number | undefined, endLine: number | undefined): string {
  const start = normalizeLineNumber(startLine);
  const end = normalizeLineNumber(endLine);
  if (start !== undefined && end !== undefined) return `[L${start}-${end}]`;
  if (start !== undefined) return `[L${start}-]`;
  if (end !== undefined) return `[L1-${end}]`;
  return '';
}

function normalizeLineNumber(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const line = Math.floor(value);
  return line > 0 ? line : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizedText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readFileMode(value: unknown): ReadFileMode | undefined {
  return value === 'text' || value === 'attachment' ? value : undefined;
}

function attachmentOutput(record: ReadFileOutputRecord | undefined): boolean {
  return typeof record?.mimeType === 'string'
    && typeof record?.sizeBytes === 'number'
    && typeof record?.content !== 'string';
}

function attachmentSizeText(value: unknown): string | undefined {
  const size = numberValue(value);
  return size === undefined ? undefined : `${size} bytes`;
}

function integerText(value: unknown): string | undefined {
  const number = numberValue(value);
  return number === undefined ? undefined : String(Math.floor(number));
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
