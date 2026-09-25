import {
  EDIT_TOOL_NAME,
  SUBMIT_PLAN_TOOL_NAME,
  WRITE_TOOL_NAME,
  type ToolCallPreviewRecord
} from './protocol';

export type ToolCallPreviewKind = 'write' | 'edit' | 'command' | 'plan' | 'agent_answer' | 'generic';
export type ToolCallPreviewRenderMode = 'markdown' | 'text' | 'json';

export interface ToolCallPreviewPresentation {
  kind: ToolCallPreviewKind;
  title: string;
  subject?: string;
  detail: string;
  previewText?: string;
  renderMode?: ToolCallPreviewRenderMode;
}

interface PartialJsonStringField {
  value: string;
  closed: boolean;
}

export type ToolCallPreviewFieldName =
  | 'path'
  | 'title'
  | 'content'
  | 'plan'
  | 'command'
  | 'explanation'
  | 'oldContent'
  | 'newContent';

type PreviewStringRole = 'key' | 'field' | 'other';

/** Lexer state advances only across newly-arrived characters. */
export interface ToolCallPreviewIncrementalState {
  scannedChars: number;
  inString: boolean;
  stringRole?: PreviewStringRole;
  keyCandidate: string;
  keyStillRelevant: boolean;
  pendingKey?: ToolCallPreviewFieldName;
  awaitingColon: boolean;
  awaitingValue: boolean;
  escapeMode: 'none' | 'escaped' | 'unicode';
  unicodeDigits: string;
  fields: NonNullable<ToolCallPreviewRecord['argumentPreviewFields']>;
}

type ToolCallPreviewArguments = Pick<ToolCallPreviewRecord, 'argumentsText' | 'receivedChars'>;

/** Accumulates the complete current-epoch argument stream; replace discards every prior delta. */
export function appendToolCallPreviewArguments(
  current: ToolCallPreviewArguments | undefined,
  delta: string,
  replace: boolean
): ToolCallPreviewArguments {
  if (replace || !current) return { argumentsText: delta, receivedChars: delta.length };
  return {
    argumentsText: current.argumentsText + delta,
    receivedChars: current.receivedChars + delta.length
  };
}

/**
 * Advances the preview-field lexer over exactly one delta. This keeps total parsing work linear in
 * the provider stream length even when a UI frame is produced after every delta.
 */
export function advanceToolCallPreviewFields(
  current: ToolCallPreviewIncrementalState | undefined,
  delta: string,
  replace: boolean
): ToolCallPreviewIncrementalState {
  const state = replace || !current ? emptyIncrementalState() : cloneIncrementalState(current);
  const decodedByField = new Map<ToolCallPreviewFieldName, string[]>();
  for (let index = 0; index < delta.length; index += 1) {
    const char = delta[index]!;
    state.scannedChars += 1;
    if (state.inString) {
      if (state.escapeMode === 'unicode') {
        if (/^[0-9a-fA-F]$/.test(char)) {
          state.unicodeDigits += char;
          if (state.unicodeDigits.length === 4) {
            appendDecodedCharacter(state, String.fromCharCode(Number.parseInt(state.unicodeDigits, 16)), decodedByField);
            state.escapeMode = 'none';
            state.unicodeDigits = '';
          }
        } else {
          appendDecodedCharacter(state, `u${state.unicodeDigits}${char}`, decodedByField);
          state.escapeMode = 'none';
          state.unicodeDigits = '';
        }
        continue;
      }
      if (state.escapeMode === 'escaped') {
        if (char === 'u') {
          state.escapeMode = 'unicode';
          state.unicodeDigits = '';
        } else {
          appendDecodedCharacter(state, decodeSimpleEscape(char), decodedByField);
          state.escapeMode = 'none';
        }
        continue;
      }
      if (char === '\\') {
        state.escapeMode = 'escaped';
        continue;
      }
      if (char === '"') {
        closeIncrementalString(state);
        continue;
      }
      appendDecodedCharacter(state, char, decodedByField);
      continue;
    }

    if (state.awaitingColon) {
      if (/\s/.test(char)) continue;
      state.awaitingColon = false;
      if (char === ':') {
        state.awaitingValue = true;
        continue;
      }
      state.pendingKey = undefined;
    }
    if (state.awaitingValue) {
      if (/\s/.test(char)) continue;
      state.awaitingValue = false;
      if (char === '"') {
        openIncrementalString(state, state.pendingKey ? 'field' : 'other');
        continue;
      }
      state.pendingKey = undefined;
    }
    if (char === '"') openIncrementalString(state, 'key');
  }

  for (const [field, decoded] of decodedByField) {
    const prior = state.fields[field];
    const value = decoded.join('');
    state.fields[field] = {
      value: (prior?.value ?? '') + value,
      closed: prior?.closed ?? false
    };
  }
  return state;
}

export function toolCallPreviewPresentation(preview: ToolCallPreviewRecord): ToolCallPreviewPresentation {
  const name = preview.name?.trim() || '工具';
  const path = previewStringField(preview, 'path');

  if (name === SUBMIT_PLAN_TOOL_NAME) {
    const plan = stringFieldPreview(preview, 'plan');
    return {
      kind: 'plan',
      title: '正在编写计划',
      detail: previewDetail(preview),
      ...(plan ? { previewText: plan, renderMode: 'markdown' as const } : {})
    };
  }

  if (name === WRITE_TOOL_NAME) {
    const content = stringFieldPreview(preview, 'content');
    return {
      kind: 'write',
      title: '正在生成文件内容',
      ...(path ? { subject: path } : {}),
      detail: previewDetail(preview),
      ...(content
        ? { previewText: content, renderMode: isMarkdownPath(path) ? 'markdown' as const : 'text' as const }
        : {})
    };
  }

  if (name === EDIT_TOOL_NAME) {
    const editPreview = editArgumentsPreview(preview);
    return {
      kind: 'edit',
      title: '正在准备文件修改',
      ...(path ? { subject: path } : {}),
      detail: previewDetail(preview),
      ...(editPreview ? { previewText: editPreview, renderMode: 'text' as const } : {})
    };
  }

  if (name === 'bash' || name === 'shell') {
    const command = stringFieldPreview(preview, 'command');
    const explanation = previewStringField(preview, 'explanation');
    return {
      kind: 'command',
      title: '正在组装命令',
      ...(explanation ? { subject: explanation } : {}),
      detail: previewDetail(preview),
      ...(command ? { previewText: command, renderMode: 'text' as const } : {})
    };
  }

  const argumentsPreview = genericArgumentsPreview(preview);
  return {
    kind: 'generic',
    title: `正在组装 ${name} 参数`,
    detail: previewDetail(preview),
    ...(argumentsPreview ? { previewText: argumentsPreview, renderMode: 'json' as const } : {})
  };
}

/** Parses one JSON string field while the enclosing JSON may still be incomplete. */
export function extractPartialJsonStringField(source: string, field: string): string | undefined {
  return extractPartialJsonStringFieldState(source, field)?.value || undefined;
}

export function genericArgumentsPreview(preview: ToolCallPreviewRecord): string | undefined {
  return preview.argumentsText.length > 0 ? preview.argumentsText : undefined;
}

function stringFieldPreview(preview: ToolCallPreviewRecord, field: string): string | undefined {
  return previewStringField(preview, field as ToolCallPreviewFieldName);
}

function previewStringField(
  preview: ToolCallPreviewRecord,
  field: ToolCallPreviewFieldName
): string | undefined {
  return previewStringFieldState(preview, field)?.value || undefined;
}

function previewStringFieldState(
  preview: ToolCallPreviewRecord,
  field: ToolCallPreviewFieldName
): PartialJsonStringField | undefined {
  return preview.argumentPreviewFields?.[field]
    ?? extractPartialJsonStringFieldState(preview.argumentsText, field);
}

function editArgumentsPreview(preview: ToolCallPreviewRecord): string | undefined {
  const oldContent = previewStringFieldState(preview, 'oldContent');
  const newContent = previewStringFieldState(preview, 'newContent');
  if (!oldContent && !newContent) return undefined;

  const sections: string[] = [];
  if (oldContent) sections.push(`--- 旧内容 ---\n${oldContent.value}`);
  if (newContent) {
    const replacement = newContent.value.length > 0
      ? newContent.value
      : newContent.closed
        ? '（空，将删除匹配内容）'
        : '';
    sections.push(`+++ 新内容 +++\n${replacement}`);
  }
  return sections.join('\n\n');
}

const PREVIEW_FIELD_NAMES = new Set<ToolCallPreviewFieldName>([
  'path', 'title', 'content', 'plan', 'command', 'explanation', 'oldContent', 'newContent'
]);

function emptyIncrementalState(): ToolCallPreviewIncrementalState {
  return {
    scannedChars: 0,
    inString: false,
    keyCandidate: '',
    keyStillRelevant: true,
    awaitingColon: false,
    awaitingValue: false,
    escapeMode: 'none',
    unicodeDigits: '',
    fields: {}
  };
}

function cloneIncrementalState(current: ToolCallPreviewIncrementalState): ToolCallPreviewIncrementalState {
  return {
    ...current,
    fields: Object.fromEntries(Object.entries(current.fields).map(([field, value]) => [
      field,
      value ? { ...value } : value
    ]))
  };
}

function openIncrementalString(state: ToolCallPreviewIncrementalState, role: PreviewStringRole): void {
  state.inString = true;
  state.stringRole = role;
  state.escapeMode = 'none';
  state.unicodeDigits = '';
  if (role === 'key') {
    state.keyCandidate = '';
    state.keyStillRelevant = true;
  } else if (role === 'field' && state.pendingKey) {
    state.fields[state.pendingKey] = { value: '', closed: false };
  }
}

function closeIncrementalString(state: ToolCallPreviewIncrementalState): void {
  const role = state.stringRole;
  state.inString = false;
  state.stringRole = undefined;
  state.escapeMode = 'none';
  state.unicodeDigits = '';
  if (role === 'key') {
    state.pendingKey = state.keyStillRelevant && PREVIEW_FIELD_NAMES.has(state.keyCandidate as ToolCallPreviewFieldName)
      ? state.keyCandidate as ToolCallPreviewFieldName
      : undefined;
    state.awaitingColon = true;
    return;
  }
  if (role === 'field' && state.pendingKey) {
    const field = state.fields[state.pendingKey];
    if (field) field.closed = true;
  }
  state.pendingKey = undefined;
}

function appendDecodedCharacter(
  state: ToolCallPreviewIncrementalState,
  value: string,
  decodedByField: Map<ToolCallPreviewFieldName, string[]>
): void {
  if (state.stringRole === 'key') {
    if (!state.keyStillRelevant) return;
    state.keyCandidate += value;
    state.keyStillRelevant = [...PREVIEW_FIELD_NAMES].some((field) => field.startsWith(state.keyCandidate));
    return;
  }
  if (state.stringRole !== 'field' || !state.pendingKey) return;
  const chunks = decodedByField.get(state.pendingKey) ?? [];
  chunks.push(value);
  decodedByField.set(state.pendingKey, chunks);
}

function decodeSimpleEscape(value: string): string {
  if (value === 'n') return '\n';
  if (value === 'r') return '\r';
  if (value === 't') return '\t';
  if (value === 'b') return '\b';
  if (value === 'f') return '\f';
  return value;
}

function extractPartialJsonStringFieldState(source: string, field: string): PartialJsonStringField | undefined {
  const marker = `"${escapeRegExp(field)}"\\s*:\\s*"`;
  const match = new RegExp(marker).exec(source);
  if (!match || match.index === undefined) return undefined;
  const start = match.index + match[0].length;
  return decodeJsonStringFragment(source.slice(start));
}

/**
 * Decodes only complete JSON escape sequences. An escape split across stream chunks is withheld
 * until complete so the decoded value remains append-only for the streaming Markdown renderer.
 */
function decodeJsonStringFragment(source: string): PartialJsonStringField {
  let value = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '"') return { value, closed: true };
    if (char !== '\\') {
      value += char;
      index += 1;
      continue;
    }

    if (index + 1 >= source.length) return { value, closed: false };
    const escaped = source[index + 1]!;
    if (escaped === 'u') {
      if (index + 6 > source.length) return { value, closed: false };
      const hex = source.slice(index + 2, index + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 6;
        continue;
      }
      value += 'u';
      index += 2;
      continue;
    }

    if (escaped === 'n') value += '\n';
    else if (escaped === 'r') value += '\r';
    else if (escaped === 't') value += '\t';
    else if (escaped === 'b') value += '\b';
    else if (escaped === 'f') value += '\f';
    else if (escaped === '"') value += '"';
    else if (escaped === '\\') value += '\\';
    else if (escaped === '/') value += '/';
    else value += escaped;
    index += 2;
  }
  return { value, closed: false };
}

function previewDetail(preview: ToolCallPreviewRecord): string {
  return `已接收 ${formatCharacterCount(preview.receivedChars)} 个参数字符`;
}

function isMarkdownPath(path: string | undefined): boolean {
  return !!path && /\.(?:md|markdown|mdx)$/i.test(path.trim());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatCharacterCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}
