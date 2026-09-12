import { TextDecoder } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { READ_TOOL_NAME, type InlineDataPart } from '../../../../../../shared/protocol';
import type { ToolDefinition, ToolDeps, ToolExecutionContext } from '../../registry';
import { staticToolScheduling } from '../../schedulingContract';
import { defineToolDefinitionModule } from '../types';
import { allowOutsideProjectPathsDefaultConfig, allowOutsideProjectPathsField, allowOutsideProjectPathsFromConfig, filePathPolicyDescription } from '../filePathPolicy';
import { compactReadPagesArgument, resolveReadPageRange } from './pageRange';
import { readTextPages } from './textPages';

export type ReadFileMode = 'text' | 'attachment';

interface ReadFileItem {
  path?: string;
  startLine?: number;
  endLine?: number;
}

interface ReadFileArgs {
  path?: string;
  attachmentId?: string;
  pages?: string;
  mode?: ReadFileMode;
  startLine?: number;
  endLine?: number;
  items?: ReadFileItem[];
}

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
    'Read UTF-8 text from one local file path or a batch of up to 8 local text files. For the common single-file case, pass only { path }; mode is inferred as "attachment" for local PNG, JPEG, WebP, or PDF paths and as "text" otherwise. Use an explicit mode only when the caller needs to require one behavior. For independent text files, prefer one items batch; results preserve input order. For local reads, provide exactly one of path or items.',
    includeManagedAttachments
      ? 'A LimCode managed attachment catalog is present. To read a past user-supplied attachment that has no usable local path, use an exact non-empty attachmentId from that catalog. Never send an empty or invented attachmentId, and never use a file name as the id. When attachmentId is used, provide neither path nor items.'
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
    path: { type: 'string', description: 'The usual input: a local file path. Relative paths are resolved from the current work environment root; absolute paths are supported when allowed by tool policy or when they are inside an explicitly allowed local work environment root.' },
    mode: { type: 'string', enum: ['text', 'attachment'], description: 'Optional for path reads only. When omitted, recognized local PNG, JPEG, WebP, and PDF paths use "attachment"; all other paths use "text". Explicit "attachment" is supported only for those media paths.' },
    startLine: { type: 'number', description: 'Text path reads only. Optional 1-based start line (inclusive); omit it when not needed. A read longer than the per-read budget returns a leading slice instead of failing; compare the returned endLine with totalLines and continue from endLine + 1.' },
    endLine: { type: 'number', description: 'Text path reads only. Optional 1-based end line (inclusive); omit it when not needed.' },
    items: {
      type: 'array',
      maxItems: READ_BATCH_MAX_ITEMS,
      description: 'Optional batch of 2-8 independent local text reads. Use this instead of path; omit it for a single-file read. Attachments are not supported in a batch.',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Local text file path.' },
          startLine: { type: 'number', description: 'Optional 1-based inclusive start line. A read longer than the per-read budget returns a leading slice instead of failing; compare the returned endLine with totalLines and continue from endLine + 1.' },
          endLine: { type: 'number', description: 'Optional 1-based inclusive end line.' }
        },
        required: ['path']
      }
    }
  };
  if (includeManagedAttachments) {
    properties.attachmentId = {
      type: 'string',
      description: 'Rare optional input for a past user-supplied attachment. Use only an exact non-empty id shown in the LimCode managed attachment catalog. Omit this field for local path and batch reads; never send an empty or invented id.'
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

/** Removes only transport-generated Read placeholders; other tools keep their own empty-value rules. */
export function compactReadFileToolArguments(value: unknown): Record<string, unknown> {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const result: Record<string, unknown> = {};
  const path = normalizeDisplayPath(source.path);
  const attachmentId = normalizeAttachmentId(source.attachmentId);
  const attachmentRef = normalizeAttachmentId(source.attachmentRef);
  const compactItems = compactReadItems(source.items);
  const pages = compactReadPagesArgument(source.pages);
  if (path) result.path = path;
  if (attachmentId) result.attachmentId = attachmentId;
  if (attachmentRef) result.attachmentRef = attachmentRef;
  if (compactItems !== undefined) result.items = compactItems;
  if (pages !== undefined) result.pages = pages;

  const managedAttachment = !!attachmentId || !!attachmentRef;
  const mode = normalizeReadMode(source.mode);
  if (!managedAttachment && mode) result.mode = mode;
  else if (source.mode !== undefined && mode === undefined) result.mode = source.mode;

  // Provider-facing attachmentRef is resolved to attachmentId after completed calls leave the
  // capability adapter. Providers sometimes materialize unrelated optional line fields from the
  // flat schema; neither managed attachment handle accepts those path-only placeholders.
  if (!managedAttachment) {
    const startLine = normalizeLineNumber(source.startLine);
    const endLine = normalizeLineNumber(source.endLine);
    if (startLine !== undefined) result.startLine = startLine;
    if (endLine !== undefined) result.endLine = endLine;
  }
  return result;
}

function compactReadItems(value: unknown): unknown {
  if (value === undefined || isSyntheticEmptyReadItems(value)) return undefined;
  if (!Array.isArray(value)) return value;
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
    const source = candidate as Record<string, unknown>;
    const item: Record<string, unknown> = {};
    const path = normalizeDisplayPath(source.path);
    const startLine = normalizeLineNumber(source.startLine);
    const endLine = normalizeLineNumber(source.endLine);
    if (path) item.path = path;
    if (startLine !== undefined) item.startLine = startLine;
    if (endLine !== undefined) item.endLine = endLine;
    return item;
  });
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
    const args = compactReadFileToolArguments(rawArgs) as ReadFileArgs;
    const path = normalizeDisplayPath(args.path);
    const attachmentId = normalizeAttachmentId(args.attachmentId);
    // Some tool transports materialize optional schema fields as empty placeholders. Do not let an
    // empty items array (or minItems-shaped blank objects) turn a valid single-file call into a
    // false path/items conflict.
    const items = (path || attachmentId) && isSyntheticEmptyReadItems(args.items) ? undefined : args.items;
    if (items !== undefined) {
      if (path || attachmentId) return { ok: false, output: 'Provide exactly one of path, attachmentId, or items.' };
      if (args.pages !== undefined) return { ok: false, output: 'pages is supported only for managed TXT and PDF attachments.' };
      const explicitMode = normalizeReadMode(args.mode);
      if (args.mode !== undefined && !explicitMode) {
        return { ok: false, output: 'Invalid argument: mode. Expected "text" or "attachment".' };
      }
      if (explicitMode === 'attachment') {
        return { ok: false, output: 'Batch items support text mode only.' };
      }
      const normalizedItems = normalizeReadItems(items);
      if (typeof normalizedItems === 'string') return { ok: false, output: normalizedItems };
      const files = await Promise.all(normalizedItems.map((item) => readTextFile(item, deps, ctx)));
      return { ok: true, output: { files: boundBatchReadOutput(files) } };
    }
    const explicitMode = normalizeReadMode(args.mode);
    if (args.mode !== undefined && !explicitMode) {
      return { ok: false, output: 'Invalid argument: mode. Expected "text" or "attachment".' };
    }
    if (attachmentId) {
      if (path) return { ok: false, output: 'Provide exactly one of path, attachmentId, or items.' };
      if (normalizeLineNumber(args.startLine) !== undefined || normalizeLineNumber(args.endLine) !== undefined) {
        return { ok: false, output: 'startLine and endLine are not supported for managed attachments.' };
      }
      if (!deps.attachments) {
        return { ok: false, output: 'Managed attachment resolver is unavailable.' };
      }
      const part = await deps.attachments.reference(attachmentId);
      if (READ_MANAGED_TEXT_MIME_TYPES.has(part.inlineData.mimeType)) {
        if (!deps.attachments.resolve) {
          return { ok: false, output: 'Managed text attachment content resolver is unavailable.' };
        }
        const resolved = await deps.attachments.resolve(attachmentId);
        return managedTextAttachmentResult(attachmentId, resolved, args.pages);
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
        return managedPdfAttachmentResult(attachmentId, resolved, args.pages);
      }
      if (args.pages !== undefined) {
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
    if (!path) {
      return { ok: false, output: 'Missing required argument: path, attachmentId, or items' };
    }
    if (args.pages !== undefined) {
      return { ok: false, output: 'pages is supported only for managed TXT and PDF attachments.' };
    }
    const mimeType = inferMimeType(path);
    const isSupportedAttachment = !!mimeType && READ_ATTACHMENT_MIME_TYPES.has(mimeType);
    const mode = effectiveLocalPathReadMode(path, explicitMode);
    if (mode === 'attachment') {
      if (!isSupportedAttachment || !mimeType) {
        return { ok: false, output: unsupportedAttachmentMessage(path) };
      }
      if (ctx?.settingsSnapshot?.enableMultimodalTools === false) {
        return { ok: true, status: 'warning', output: multimodalDisabledMessage(mimeType) };
      }
      const file = await deps.fs.readBinaryFile(path, mimeType, {
        signal: ctx?.signal,
        workEnvironment: ctx?.workEnvironment,
        accessibleWorkEnvironments: ctx?.accessibleWorkEnvironments,
        allowOutsideProjectPaths: allowOutsideProjectPathsFromConfig(ctx?.config, true),
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

    if (isSupportedAttachment) {
      return { ok: false, output: `Cannot read ${mimeType} as UTF-8 text. Use mode="attachment" for ${path}.` };
    }
    const output = await readTextFile({ ...args, path }, deps, ctx);
    return { ok: true, output };
  }
};

function summarizeReadFileToolCall(rawArgs: unknown): string | undefined {
  const args = compactReadFileToolArguments(rawArgs) as ReadFileArgs;
  const attachmentId = normalizeAttachmentId(args.attachmentId);
  if (attachmentId) return `${attachmentId}[attachment]${args.pages ? `[pages=${args.pages}]` : ''}`;
  const path = normalizeDisplayPath(args.path);
  const items = Array.isArray(args.items) && !((path || attachmentId) && isSyntheticEmptyReadItems(args.items))
    ? args.items
    : undefined;
  if (items) return `${items.length} text files`;
  if (!path) return undefined;

  const mode = effectiveLocalPathReadMode(path, normalizeReadMode(args.mode));
  const modeSuffix = `[${mode}]`;
  if (mode === 'attachment') return `${path}${modeSuffix}`;
  const range = lineRangeSuffix(args.startLine, args.endLine);
  return `${path}${modeSuffix}${range}`;
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
    allowOutsideProjectPaths: allowOutsideProjectPathsFromConfig(ctx?.config, true)
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
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const item = candidate as ReadFileItem;
    return !normalizeDisplayPath(item.path)
      && normalizeLineNumber(item.startLine) === undefined
      && normalizeLineNumber(item.endLine) === undefined;
  });
}

function normalizeReadItems(value: unknown): ReadFileItem[] | string {
  if (!Array.isArray(value) || value.length < 2 || value.length > READ_BATCH_MAX_ITEMS) {
    return `items must contain 2-${READ_BATCH_MAX_ITEMS} text read requests.`;
  }
  const items: ReadFileItem[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return `items[${index}] must be an object.`;
    }
    const item = candidate as ReadFileItem;
    const path = normalizeDisplayPath(item.path);
    if (!path) return `items[${index}].path must be non-empty.`;
    items.push({ path, startLine: item.startLine, endLine: item.endLine });
  }
  return items;
}

function boundBatchReadOutput<T extends { content: string }>(files: T[]): Array<T & {
  contentTruncated?: boolean;
  omittedChars?: number;
}> {
  let remaining = READ_BATCH_MAX_CONTENT_CHARS;
  return files.map((file) => {
    if (file.content.length <= remaining) {
      remaining -= file.content.length;
      return file;
    }
    const content = remaining > 0 ? file.content.slice(0, remaining) : '';
    const omittedChars = file.content.length - content.length;
    remaining = 0;
    return { ...file, content, contentTruncated: true, omittedChars };
  });
}

function normalizeAttachmentId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDisplayPath(path: unknown): string {
  return typeof path === 'string' ? path.trim().replace(/\\+/g, '/') : '';
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
