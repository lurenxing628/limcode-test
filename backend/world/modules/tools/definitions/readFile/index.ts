import { TextDecoder } from 'node:util';
import { READ_TOOL_NAME, type InlineDataPart } from '../../../../../../shared/protocol';
import type { ToolDefinition, ToolDeps, ToolExecutionContext, ToolResultOut } from '../../registry';
import { staticToolScheduling } from '../../schedulingContract';
import { defineToolDefinitionModule } from '../types';
import { allowOutsideProjectPathsDefaultConfig, allowOutsideProjectPathsField, allowOutsideProjectPathsFromConfig, filePathPolicyDescription } from '../filePathPolicy';
import { compactReadPagesArgument, parseReadPageRange, resolveReadPageRange } from './pageRange';
import { readTextPages } from './textPages';
import { normalizeDisplayPath } from '../../../../../../shared/displayPath';
import { ToolArgumentError, toolArgumentRecord, isEmptyToolArgument } from '../../../../../../shared/toolArgumentUtils';

export type ReadFileMode = 'text' | 'attachment';

interface ReadFileItem {
  path?: string;
  startLine?: number;
  endLine?: number;
}

export interface ReadFileToolArgumentMetadata {
  ignoredFields?: string[];
  warning?: string;
}

export type ValidatedReadFileToolArguments = (
  | { source: 'path'; path: string; mode: ReadFileMode; startLine?: number; endLine?: number }
  | { source: 'items'; items: ReadFileItem[]; mode: 'text' }
  | { source: 'attachment'; attachmentId?: string; attachmentRef?: string; pages?: string }
) & ReadFileToolArgumentMetadata;

const READ_BATCH_MAX_ITEMS = 8;
const READ_BATCH_MAX_CONTENT_CHARS = 256 * 1024;

const READ_PDF_MIME_TYPE = 'application/pdf';
const READ_ATTACHMENT_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', READ_PDF_MIME_TYPE]);
const READ_MANAGED_TEXT_MIME_TYPES = new Set(['text/plain']);
const EXTENSION_MIME_MAP: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' };

export function readFileToolDescription(
  includeManagedAttachments: boolean,
  includeManagedPageRanges = includeManagedAttachments
): string {
  const parts = [
    'Read UTF-8 text from one local file path or a batch of up to 8 local text files. For the common single-file case, pass only { path }; mode is inferred as "attachment" for local PNG, JPEG, WebP, or PDF paths and as "text" otherwise. Use an explicit mode only when the caller needs to require one path behavior. Target priority is path, then a managed attachment handle, then items. Only the selected target is read; unused target fields and controls are reported. For independent text files, prefer one items batch; results preserve input order and each item keeps its own line range.',
    includeManagedAttachments
      ? 'A LimCode managed attachment catalog is present. To read a past user-supplied attachment that has no usable local path, use an exact non-empty attachmentId from that catalog. Never use an invented attachmentId or a file name as the id. A supplied path takes priority; otherwise the attachment takes priority over items. Unused mode and line fields do not affect managed reads.'
      : '',
    includeManagedPageRanges
      ? 'For managed TXT and PDF attachments, optional pages accepts "N" or "N-M", defaults to "1", and allows at most 4 consecutive pages. TXT uses stable text pages; PDF uses real PDF pages. Copy nextPages from the result to continue. Omit pages for images.'
      : '',
    filePathPolicyDescription(true)
  ];
  return parts.filter(Boolean).join(' ');
}

export function readFileToolParameters(
  includeManagedAttachments: boolean,
  includeManagedPageRanges = includeManagedAttachments
): {
  type: 'object';
  properties: Record<string, unknown>;
} {
  const properties: Record<string, unknown> = {
    path: { type: 'string', description: 'The usual input, with priority over attachmentId and items: a local file path. Relative paths are resolved from the current work environment root; absolute paths are supported when allowed by tool policy or when they are inside an explicitly allowed local work environment root.' },
    mode: { type: 'string', enum: ['text', 'attachment'], description: 'Optional for path reads only. When omitted, recognized local PNG, JPEG, WebP, and PDF paths use "attachment"; all other paths use "text". Explicit "attachment" is supported only for those media paths.' },
    startLine: { type: 'integer', minimum: 1, description: 'Text path reads only. Optional 1-based start line (inclusive); omit it when not needed. A read longer than the per-read budget returns a leading slice instead of failing; compare the returned endLine with totalLines and continue from endLine + 1.' },
    endLine: { type: 'integer', minimum: 1, description: 'Text path reads only. Optional 1-based end line (inclusive); omit it when not needed.' },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: READ_BATCH_MAX_ITEMS,
      description: 'Optional batch of 1-8 independent local text reads, used only when path and attachmentId are absent. Each item has its own line range; root line fields are ignored. Attachments are not supported in a batch.',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Local text file path.' },
          startLine: { type: 'integer', minimum: 1, description: 'Optional 1-based inclusive start line. A read longer than the per-read budget returns a leading slice instead of failing; compare the returned endLine with totalLines and continue from endLine + 1.' },
          endLine: { type: 'integer', minimum: 1, description: 'Optional 1-based inclusive end line.' }
        },
        required: ['path']
      }
    }
  };
  if (includeManagedAttachments) {
    properties.attachmentId = {
      type: 'string',
      description: 'Rare optional input for a past user-supplied attachment, used when path is absent and with priority over items. Use only an exact non-empty id shown in the LimCode managed attachment catalog; omit it when unused.'
    };
  }
  if (includeManagedPageRanges) {
    properties.pages = {
      type: 'string',
      description: 'Managed TXT/PDF only. Optional "N" or "N-M" page range such as "1-4"; defaults to "1" and allows at most 4 consecutive pages. Omit for images and local path reads.'
    };
  }
  return { type: 'object', properties };
}

/** An execution-only copy. Provider facts must retain the original arguments. */
export function compactReadFileToolArguments(value: unknown): Record<string, unknown> {
  const source = toolArgumentRecord(value, 'read arguments');
  const result = { ...source };
  for (const key of ['path', 'attachmentId', 'attachmentRef', 'mode', 'startLine', 'endLine', 'pages']) {
    const field = result[key];
    if (isEmptyToolArgument(field) || typeof field === 'string' && !field.trim()) delete result[key];
  }
  if (typeof result.path === 'string') result.path = normalizeDisplayPath(result.path);
  for (const key of ['attachmentId', 'attachmentRef', 'mode']) {
    if (typeof result[key] === 'string') result[key] = (result[key] as string).trim();
  }
  if (isEmptyToolArgument(result.items) || isSyntheticEmptyReadItems(result.items)) delete result.items;
  if (result.pages !== undefined) result.pages = compactReadPagesArgument(result.pages);
  return result;
}

/** Public priority: path, then managed attachment, then items. Validate only the chosen target. */
export function validateReadFileToolArguments(value: unknown): ValidatedReadFileToolArguments {
  const args = compactReadFileToolArguments(value);
  if (args.path !== undefined) {
    const path = normalizeDisplayPath(requireReadText(args.path, 'read.path'));
    const explicitMode = normalizeReadMode(args.mode);
    if (args.mode !== undefined && !explicitMode) throw new ToolArgumentError('Invalid argument: mode. Expected "text" or "attachment".');
    const mode = effectiveLocalPathReadMode(path, explicitMode);
    const unused = ['attachmentId', 'attachmentRef', 'items', 'pages'];
    if (mode === 'attachment') {
      if (!inferMimeType(path)) throw new ToolArgumentError(unsupportedAttachmentMessage(path));
      return { source: 'path', path, mode, ...readUnusedMetadata('path', args, [...unused, 'startLine', 'endLine']) };
    }
    assertTextReadPath(path);
    return { source: 'path', path, mode, ...validateReadLineRange(args, 'read'), ...readUnusedMetadata('path', args, unused) };
  }
  if (args.attachmentId !== undefined || args.attachmentRef !== undefined) {
    const key = args.attachmentId !== undefined ? 'attachmentId' : 'attachmentRef';
    const attachment = requireReadText(args[key], `read.${key}`);
    const pages = args.pages === undefined ? undefined : parseReadPageRange(args.pages);
    if (pages && !pages.ok) throw new ToolArgumentError(pages.error);
    return { source: 'attachment', [key]: attachment, ...(pages?.ok ? { pages: pages.range.canonical } : {}),
      ...readUnusedMetadata('attachmentRef', args, ['items', 'mode', 'startLine', 'endLine', ...(key === 'attachmentId' ? ['attachmentRef'] : [])]) };
  }
  if (args.items !== undefined) {
    const items = normalizeReadItems(args.items);
    if (typeof items === 'string') throw new ToolArgumentError(items);
    return { source: 'items', items, mode: 'text', ...readUnusedMetadata('items', args, ['mode', 'pages', 'startLine', 'endLine']) };
  }
  throw new ToolArgumentError('Provide a non-empty path, attachmentRef, or items.');
}

export function readFileToolResultMetadata(args: ValidatedReadFileToolArguments): ReadFileToolArgumentMetadata & { source: 'path' | 'attachmentRef' | 'items' } {
  return { source: args.source === 'attachment' ? 'attachmentRef' : args.source,
    ...(args.ignoredFields?.length ? { ignoredFields: [...args.ignoredFields], warning: args.warning } : {}) };
}

function readUnusedMetadata(source: 'path' | 'attachmentRef' | 'items', args: Record<string, unknown>, fields: string[]): ReadFileToolArgumentMetadata {
  const ignoredFields = [...new Set(fields.filter(key => !isEmptyToolArgument(args[key]))
    .map(key => key === 'attachmentId' ? 'attachmentRef' : key))];
  return ignoredFields.length ? { ignoredFields, warning: `已选择 ${source}；未使用参数：${ignoredFields.join('、')}。` } : {};
}

export const readFileToolModule = defineToolDefinitionModule({
  id: READ_TOOL_NAME,
  create() {
    return readFileTool;
  }
});

export const readFileTool: ToolDefinition = {
  declaration: {
    name: READ_TOOL_NAME,
    description: readFileToolDescription(true),
    parameters: readFileToolParameters(true),
    metadata: {
      category: 'filesystem',
      scope: 'file',
      riskLevel: 'read',
      readonly: true,
      defaultEnabled: true,
      checkpoint: { before: false, after: false }
    },
    configSchema: { fields: [allowOutsideProjectPathsField(true)] },
    defaultConfig: allowOutsideProjectPathsDefaultConfig(true)
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('parallel', 'readonly_file_read'),
  summary: summarizeReadFileToolCall,
  async execute(rawArgs, deps, ctx) {
    let validated: ValidatedReadFileToolArguments;
    try {
      validated = validateReadFileToolArguments(rawArgs);
    } catch (error) {
      if (!(error instanceof ToolArgumentError)) throw error;
      return { ok: false, output: error.message };
    }
    const result = await executeReadFileArguments(validated, deps, ctx);
    if (!validated.ignoredFields?.length) return result;
    const metadata = { ignoredFields: [...validated.ignoredFields], warning: validated.warning };
    const output = result.output;
    return { ...result, output: output !== null && typeof output === 'object' && !Array.isArray(output)
      ? { ...output, ...metadata }
      : { message: output, ...metadata } };
  }
};

async function executeReadFileArguments(
  validated: ValidatedReadFileToolArguments,
  deps: ToolDeps,
  ctx: ToolExecutionContext | undefined
): Promise<ToolResultOut> {
  if (validated.source === 'attachment' && validated.attachmentRef) {
    return { ok: false, output: 'attachmentRef must be resolved by the reliable tool dispatcher.' };
  }
  if (validated.source === 'items') {
    const files = await Promise.all(validated.items.map((item) => readTextFile(item, deps, ctx)));
    return { ok: true, output: { files: boundBatchReadOutput(files) } };
  }
  if (validated.source === 'attachment') {
    const attachmentId = validated.attachmentId!;
    if (!deps.attachments) {
      return { ok: false, output: 'Managed attachment resolver is unavailable.' };
    }
    const part = await deps.attachments.reference(attachmentId);
    if (READ_MANAGED_TEXT_MIME_TYPES.has(part.inlineData.mimeType)) {
      if (!deps.attachments.resolve) {
        return { ok: false, output: 'Managed text attachment content resolver is unavailable.' };
      }
      const resolved = await deps.attachments.resolve(attachmentId);
      return managedTextAttachmentResult(attachmentId, resolved, validated.pages);
    }
    if (!READ_ATTACHMENT_MIME_TYPES.has(part.inlineData.mimeType)) {
      return { ok: false, output: `Managed attachment MIME type is not supported by read: ${part.inlineData.mimeType}` };
    }
    if (ctx?.settingsSnapshot?.enableMultimodalTools === false) {
      return { ok: true, status: 'warning', output: '当前渠道未启用多模态工具，无法读取托管图片或 PDF。' };
    }
    if (part.inlineData.mimeType === READ_PDF_MIME_TYPE) {
      if (!deps.attachments.resolve) {
        return { ok: false, output: 'Managed PDF content resolver is unavailable.' };
      }
      const resolved = await deps.attachments.resolve(attachmentId);
      return managedPdfAttachmentResult(attachmentId, resolved, validated.pages);
    }
    if (validated.pages !== undefined) {
      return { ok: false, output: 'pages is not supported for image attachments.' };
    }
    return {
      ok: true,
      output: {
        attachmentId,
        name: part.inlineData.name ?? attachmentId,
        mimeType: part.inlineData.mimeType,
        sizeBytes: part.inlineData.sizeBytes ?? 0
      },
      parts: [part]
    };
  }
  const path = validated.path;
  if (validated.mode === 'attachment') {
    const mimeType = inferMimeType(path)!;
    if (ctx?.settingsSnapshot?.enableMultimodalTools === false) {
      return { ok: true, status: 'warning', output: multimodalDisabledMessage(mimeType) };
    }
    const file = await deps.fs.readBinaryFile(path, mimeType, {
      signal: ctx?.signal,
      workEnvironment: ctx?.workEnvironment,
      accessibleWorkEnvironments: ctx?.accessibleWorkEnvironments,
      allowOutsideProjectPaths: allowOutsideProjectPathsFromConfig(ctx?.config, true),
      ...(ctx?.skillDirectories ? { localReadOnlyRoots: ctx.skillDirectories } : {}),
      ...(ctx?.attachmentMaxBytes ? { maxBytes: ctx.attachmentMaxBytes } : {})
    });
    const part: InlineDataPart = {
      inlineData: {
        mimeType,
        data: file.data,
        name: file.name,
        sourcePath: file.path,
        storage: 'embedded',
        status: 'available',
        sizeBytes: file.sizeBytes
      }
    };
    return { ok: true, output: { mimeType, sizeBytes: file.sizeBytes }, parts: [part] };
  }

  const output = await readTextFile(validated, deps, ctx);
  return { ok: true, output };
}

function summarizeReadFileToolCall(rawArgs: unknown): string | undefined {
  let args: ValidatedReadFileToolArguments;
  try { args = validateReadFileToolArguments(rawArgs); }
  catch { return undefined; }
  if (args.source === 'attachment') return `${args.attachmentId ?? args.attachmentRef}[attachment]${args.pages ? `[pages=${args.pages}]` : ''}`;
  if (args.source === 'items') return `${args.items.length} text files`;
  const modeSuffix = `[${args.mode}]`;
  if (args.mode === 'attachment') return `${args.path}${modeSuffix}`;
  const range = lineRangeSuffix(args.startLine, args.endLine);
  return `${args.path}${modeSuffix}${range}`;
}

async function readTextFile(
  item: ReadFileItem,
  deps: ToolDeps,
  ctx: ToolExecutionContext | undefined
): Promise<{
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}> {
  const path = normalizeDisplayPath(item.path);
  if (!path) throw new TypeError('Read item path must be non-empty.');
  const text = await deps.fs.readFile(path, normalizeLineNumber(item.startLine), normalizeLineNumber(item.endLine), {
    signal: ctx?.signal,
    workEnvironment: ctx?.workEnvironment,
    accessibleWorkEnvironments: ctx?.accessibleWorkEnvironments,
    allowOutsideProjectPaths: allowOutsideProjectPathsFromConfig(ctx?.config, true),
    ...(ctx?.skillDirectories ? { localReadOnlyRoots: ctx.skillDirectories } : {})
  });
  return {
    path: text.path,
    startLine: text.startLine,
    endLine: text.endLine,
    totalLines: text.totalLines,
    content: text.content
  };
}

function managedTextAttachmentResult(attachmentId: string, part: InlineDataPart, pages: unknown): {
  ok: boolean;
  output: unknown;
} {
  const inlineData = part.inlineData;
  if (inlineData.attachmentId !== attachmentId) {
    return { ok: false, output: `Managed attachment resolver returned a different attachment id for ${attachmentId}.` };
  }
  if (!READ_MANAGED_TEXT_MIME_TYPES.has(inlineData.mimeType)) {
    return { ok: false, output: `Managed text attachment changed MIME type: ${inlineData.mimeType}` };
  }
  if (!inlineData.data) {
    return { ok: false, output: `Managed text attachment has no readable content: ${attachmentId}` };
  }

  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(inlineData.data, 'base64'));
  } catch {
    return { ok: false, output: `Managed text attachment is not valid UTF-8: ${attachmentId}` };
  }
  const selected = readTextPages(content, pages);
  if (!selected.ok) return { ok: false, output: selected.error };
  return {
    ok: true,
    output: {
      attachmentId,
      name: inlineData.name ?? attachmentId,
      mimeType: inlineData.mimeType,
      sizeBytes: inlineData.sizeBytes ?? Buffer.byteLength(content, 'utf8'),
      ...pageRangeOutput(selected.range),
      content: selected.content
    }
  };
}

async function managedPdfAttachmentResult(
  attachmentId: string,
  part: InlineDataPart,
  pages: unknown
): Promise<{ ok: boolean; output: unknown; parts?: InlineDataPart[] }> {
  const inlineData = part.inlineData;
  if (inlineData.attachmentId !== attachmentId) {
    return { ok: false, output: `Managed attachment resolver returned a different attachment id for ${attachmentId}.` };
  }
  if (inlineData.mimeType !== READ_PDF_MIME_TYPE) {
    return { ok: false, output: `Managed PDF attachment changed MIME type: ${inlineData.mimeType}` };
  }
  if (!inlineData.data) {
    return { ok: false, output: `Managed PDF attachment has no readable content: ${attachmentId}` };
  }

  try {
    // Argument inspection is also used during Runtime startup; only PDF reads need this parser.
    const { PDFDocument } = await import('pdf-lib');
    const sourceBytes = Buffer.from(inlineData.data, 'base64');
    const source = await PDFDocument.load(sourceBytes);
    const totalPages = source.getPageCount();
    if (totalPages < 1) return { ok: false, output: `Managed PDF attachment has no pages: ${attachmentId}` };
    const selected = resolveReadPageRange(pages, totalPages);
    if (!selected.ok) return { ok: false, output: selected.error };
    const output = await PDFDocument.create();
    const indexes = Array.from(
      { length: selected.range.end - selected.range.start + 1 },
      (_, index) => selected.range.start - 1 + index
    );
    const copiedPages = await output.copyPages(source, indexes);
    for (const page of copiedPages) output.addPage(page);
    const outputBytes = await output.save();
    const outputBuffer = Buffer.from(outputBytes);
    const outputName = pagedPdfName(inlineData.name ?? attachmentId, selected.range.returnedPages);
    return {
      ok: true,
      output: {
        attachmentId,
        name: inlineData.name ?? attachmentId,
        mimeType: inlineData.mimeType,
        sourceSizeBytes: inlineData.sizeBytes ?? sourceBytes.byteLength,
        sizeBytes: outputBuffer.byteLength,
        ...pageRangeOutput(selected.range)
      },
      parts: [{
        inlineData: {
          mimeType: READ_PDF_MIME_TYPE,
          data: outputBuffer.toString('base64'),
          name: outputName,
          storage: 'embedded',
          status: 'available',
          sizeBytes: outputBuffer.byteLength
        }
      }]
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, output: `Managed PDF attachment could not be paged: ${message}` };
  }
}

function pageRangeOutput(range: {
  requestedPages: string;
  returnedPages: string;
  totalPages: number;
  hasMore: boolean;
  nextPages?: string;
}): Record<string, unknown> {
  return {
    requestedPages: range.requestedPages,
    returnedPages: range.returnedPages,
    totalPages: range.totalPages,
    hasMore: range.hasMore,
    ...(range.nextPages ? { nextPages: range.nextPages } : {})
  };
}

function pagedPdfName(name: string, pages: string): string {
  const base = name.replace(/\.pdf$/i, '') || 'attachment';
  return `${base}.pages-${pages}.pdf`;
}

function isSyntheticEmptyReadItems(value: unknown): boolean {
  return Array.isArray(value) && value.every((candidate) => {
    if (isEmptyToolArgument(candidate)) return true;
    if (typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const item = candidate as Record<string, unknown>;
    return ['path', 'startLine', 'endLine', 'attachmentId', 'attachmentRef', 'mode', 'pages'].every((key) =>
      isEmptyToolArgument(item[key]) || typeof item[key] === 'string' && !(item[key] as string).trim());
  });
}

function normalizeReadItems(value: unknown): ReadFileItem[] | string {
  if (!Array.isArray(value) || value.length < 1 || value.length > READ_BATCH_MAX_ITEMS) {
    return `items must contain 1-${READ_BATCH_MAX_ITEMS} text read requests.`;
  }
  const items: ReadFileItem[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return `items[${index}] must be an object.`;
    }
    const item = candidate as Record<string, unknown>;
    try {
      const path = normalizeDisplayPath(requireReadText(item.path, `items[${index}].path`));
      for (const key of ['attachmentId', 'attachmentRef', 'pages']) {
        if (!isEmptyToolArgument(item[key])) throw new ToolArgumentError(`items[${index}].${key} is not supported in a text batch.`);
      }
      if (!isEmptyToolArgument(item.mode) && item.mode !== 'text') throw new ToolArgumentError('Batch items support text mode only.');
      assertTextReadPath(path);
      items.push({ path, ...validateReadLineRange(item, `items[${index}]`) });
    } catch (error) {
      if (!(error instanceof ToolArgumentError)) throw error;
      return error.message;
    }
  }
  return items;
}

function requireReadText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ToolArgumentError(`${label} must be a non-empty string.`);
  return value.trim();
}

function validateReadLineRange(args: Record<string, unknown>, label: string): { startLine?: number; endLine?: number } {
  const range: { startLine?: number; endLine?: number } = {};
  for (const key of ['startLine', 'endLine'] as const) {
    const value = args[key];
    if (isEmptyToolArgument(value) || typeof value === 'string' && !value.trim()) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ToolArgumentError(`${label}.${key} must be a positive integer.`);
    range[key] = value;
  }
  if (range.endLine !== undefined && range.endLine < (range.startLine ?? 1)) throw new ToolArgumentError(`${label}.endLine must not be smaller than startLine.`);
  return range;
}

function assertTextReadPath(path: string): void {
  const mimeType = inferMimeType(path);
  if (mimeType) throw new ToolArgumentError(`Cannot read ${mimeType} as UTF-8 text. Use mode="attachment" for ${path}.`);
}

/**
 * Keeps a batch within one read's budget. A slice that does not fit keeps whole lines only and its
 * endLine becomes the last line kept, so "continue from endLine + 1" stays true for every file.
 */
function boundBatchReadOutput<T extends { content: string; startLine: number; endLine: number }>(files: T[]): Array<T & {
  contentTruncated?: boolean;
  omittedChars?: number;
}> {
  let remaining = READ_BATCH_MAX_CONTENT_CHARS;
  return files.map((file) => {
    if (file.content.length <= remaining) {
      remaining -= file.content.length;
      return file;
    }
    const cut = remaining > 0 ? file.content.lastIndexOf('\n', remaining) : -1;
    const content = cut > 0 ? file.content.slice(0, cut) : '';
    const keptLines = content ? content.split('\n').length : 0;
    const omittedChars = file.content.length - content.length;
    remaining = 0;
    return { ...file, content, endLine: file.startLine + keptLines - 1, contentTruncated: true, omittedChars };
  });
}

function lineRangeSuffix(startLine: number | undefined, endLine: number | undefined): string {
  const start = normalizeLineNumber(startLine);
  const end = normalizeLineNumber(endLine);
  if (start !== undefined && end !== undefined) return `[L${start}-${end}]`;
  if (start !== undefined) return `[L${start}-]`;
  if (end !== undefined) return `[L1-${end}]`;
  return '';
}

function normalizeLineNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const line = Math.floor(value);
  return line > 0 ? line : undefined;
}

export function effectiveLocalPathReadMode(path: unknown, explicitMode?: ReadFileMode): ReadFileMode {
  if (explicitMode) return explicitMode;
  const normalizedPath = normalizeDisplayPath(path);
  const mimeType = inferMimeType(normalizedPath);
  return mimeType && READ_ATTACHMENT_MIME_TYPES.has(mimeType) ? 'attachment' : 'text';
}

function normalizeReadMode(value: unknown): ReadFileMode | undefined {
  return value === 'text' || value === 'attachment' ? value : undefined;
}

function multimodalDisabledMessage(mimeType: string): string {
  return `当前渠道未启用多模态工具，模型不具备读取 ${mimeType} 附件内容的能力。read 现在只能读取文本文件；如需查看图片、PDF 等附件，请在渠道配置中启用多模态工具。`;
}

function unsupportedAttachmentMessage(filePath: string): string {
  return `mode="attachment" only supports .png, .jpg, .jpeg, .webp, and .pdf files. Unsupported path: ${filePath}`;
}

function inferMimeType(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return undefined;
  return EXTENSION_MIME_MAP[filePath.slice(dot).toLowerCase()];
}
