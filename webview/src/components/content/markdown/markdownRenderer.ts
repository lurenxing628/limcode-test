import MarkdownIt from 'markdown-it';
import * as katex from 'katex';
import texmath from 'markdown-it-texmath';
import { LOCAL_FILE_LINK_DATA_ATTRIBUTE, normalizeLocalFileSource } from '@shared/localFileResources';
import { toWebviewImageSrc } from './localImageSource';

type MarkdownToken = {
  attrs: Array<[string, string]> | null;
  type: string;
  content: string;
  info: string;
  attrIndex(name: string): number;
  attrPush(attrData: [string, string]): void;
};

type MarkdownRenderer = {
  render(tokens: MarkdownToken[], options: MarkdownOptions, env: unknown): string;
  renderToken(tokens: MarkdownToken[], index: number, options: MarkdownOptions): string;
};

type MarkdownOptions = Record<string, unknown>;
type MarkdownRenderRule = (
  tokens: MarkdownToken[],
  index: number,
  options: MarkdownOptions,
  env: unknown,
  self: MarkdownRenderer
) => string;

type MarkdownParser = {
  options: MarkdownOptions;
  render(text: string): string;
  renderInline(text: string): string;
  parse(text: string, env: unknown): MarkdownToken[];
  use(plugin: unknown, options?: unknown): MarkdownParser;
  validateLink(url: string): boolean;
  linkify?: {
    set(options: { fuzzyLink?: boolean; fuzzyIP?: boolean }): void;
  };
  renderer: MarkdownRenderer & {
    rules: Record<string, MarkdownRenderRule | undefined>;
  };
};

type MarkdownItConstructor = new (options?: MarkdownOptions) => MarkdownParser;

export type MarkdownRenderedPart =
  | { kind: 'html'; html: string }
  | { kind: 'code'; code: string; language: string; info: string };

export interface StreamingMarkdownRendererDiagnostics {
  stableChars: number;
  stablePartCount: number;
  tailChars: number;
  incrementalDisabled: boolean;
  parseCalls: number;
  parsedChars: number;
}

export interface MarkdownRenderOptions {
  streaming?: boolean;
  preserveSoftBreaks?: boolean;
}

const FINAL_CACHE_LIMIT = 80;

// ChatView 本身会在 bridge 握手后按需加载；解析器随 ChatView 一起就绪，避免消息首帧后再发起 Markdown 分包请求。
const parser = createParser(MarkdownIt as unknown as MarkdownItConstructor);
const softBreakParser = createParser(MarkdownIt as unknown as MarkdownItConstructor, true);
const finalRenderCache = new Map<string, string>();
const finalPartCache = new Map<string, MarkdownRenderedPart[]>();

/** 渲染 Markdown。streaming=true 时不写入最终缓存，避免流式增量产生大量一次性 key。 */
export function renderMarkdown(text: string, options: MarkdownRenderOptions = {}): string {
  const normalized = text.trimStart();
  if (!normalized) return '';
  const renderParser = parserFor(options);
  const cacheKey = finalCacheKey(normalized, options.preserveSoftBreaks === true);

  if (!options.streaming) {
    const cached = finalRenderCache.get(cacheKey);
    if (cached !== undefined) {
      finalRenderCache.delete(cacheKey);
      finalRenderCache.set(cacheKey, cached);
      return cached;
    }
  }

  const html = renderParser.render(normalized);

  if (!options.streaming) rememberFinalRender(cacheKey, html);
  return html;
}

/** 渲染适合标题、摘要等单行容器的内联 Markdown，不生成段落等块级标签。 */
export function renderInlineMarkdown(text: string): string {
  const normalized = text.trim();
  if (!normalized) return '';
  return parser.renderInline(normalized);
}

/**
 * 渲染 Markdown 为可由 Vue 组合展示的片段。
 * fenced / indented code block 会拆成 code 片段，交给专门的代码块显示器处理。
 */
export function renderMarkdownParts(text: string, options: MarkdownRenderOptions = {}): MarkdownRenderedPart[] {
  const normalized = text.trimStart();
  if (!normalized) return [];
  const renderParser = parserFor(options);
  const cacheKey = finalCacheKey(normalized, options.preserveSoftBreaks === true);

  if (!options.streaming) {
    const cached = finalPartCache.get(cacheKey);
    if (cached !== undefined) {
      finalPartCache.delete(cacheKey);
      finalPartCache.set(cacheKey, cached);
      return cached;
    }
  }

  const tokens = renderParser.parse(normalized, {});
  const parts = tokensToRenderedParts(renderParser, tokens);

  if (!options.streaming) rememberFinalParts(cacheKey, parts);
  return parts;
}

/**
 * Stateful Codex-style renderer: completed top-level blocks become an immutable prefix;
 * only the final mutable block is reparsed for each streaming frame. Final output is still
 * rendered once as a whole document so reference/link/list semantics remain authoritative.
 */
export function createStreamingMarkdownPartsRenderer() {
  let previousText = '';
  let previousPreserveSoftBreaks: boolean | undefined;
  let stableChars = 0;
  let stableParts: MarkdownRenderedPart[] = [];
  let incrementalDisabled = false;
  let parseCalls = 0;
  let parsedChars = 0;

  const renderStreamingChunk = (source: string, preserveSoftBreaks: boolean): MarkdownRenderedPart[] => {
    if (!source) return [];
    parseCalls += 1;
    parsedChars += source.length;
    return renderMarkdownParts(source, { streaming: true, preserveSoftBreaks });
  };

  const resetState = (): void => {
    previousText = '';
    stableChars = 0;
    stableParts = [];
    incrementalDisabled = false;
    parseCalls = 0;
    parsedChars = 0;
  };

  const reset = (): void => {
    resetState();
    previousPreserveSoftBreaks = undefined;
  };

  return {
    render(text: string, options: MarkdownRenderOptions = {}): MarkdownRenderedPart[] {
      const normalized = text.trimStart();
      const preserveSoftBreaks = options.preserveSoftBreaks === true;
      if (!normalized) {
        reset();
        return [];
      }
      if (!options.streaming) {
        const final = renderMarkdownParts(normalized, { streaming: false, preserveSoftBreaks });
        reset();
        return final;
      }

      if (previousPreserveSoftBreaks !== undefined && previousPreserveSoftBreaks !== preserveSoftBreaks) resetState();
      previousPreserveSoftBreaks = preserveSoftBreaks;
      const appendedToPrevious = previousText.length > 0
        && normalized.startsWith(previousText)
        && previousText.length >= stableChars;
      const definitionScanStart = appendedToPrevious ? previousText.lastIndexOf('\n') + 1 : 0;
      if (!appendedToPrevious) resetState();
      previousText = normalized;
      if (!incrementalDisabled && containsGlobalMarkdownDefinition(
        definitionScanStart > 0 ? normalized.slice(definitionScanStart) : normalized
      )) {
        incrementalDisabled = true;
      }
      if (incrementalDisabled) return renderStreamingChunk(normalized, preserveSoftBreaks);

      const tail = normalized.slice(stableChars);
      const commitIndex = findStreamingMarkdownCommitIndex(tail);
      if (commitIndex > 0) {
        const committed = tail.slice(0, commitIndex);
        stableParts = [...stableParts, ...renderStreamingChunk(committed, preserveSoftBreaks)];
        stableChars += commitIndex;
      }
      const mutableTail = normalized.slice(stableChars);
      return [...stableParts, ...renderStreamingChunk(mutableTail, preserveSoftBreaks)];
    },
    reset,
    diagnostics(): StreamingMarkdownRendererDiagnostics {
      return {
        stableChars,
        stablePartCount: stableParts.length,
        tailChars: Math.max(0, previousText.length - stableChars),
        incrementalDisabled,
        parseCalls,
        parsedChars
      };
    }
  };
}

export function findStreamingMarkdownCommitIndex(source: string): number {
  if (!source.includes('\n\n')) return 0;
  const lines = source.split('\n');
  let offset = 0;
  let previousBlank = false;
  let fence: { marker: '`' | '~'; length: number } | undefined;
  let displayMathOpen = false;
  let candidate = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    const lineStart = offset;
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    const outsideMultilineBlock = !fence && !displayMathOpen;
    if (outsideMultilineBlock && previousBlank && isSafeTopLevelBlockStart(line)) candidate = lineStart;

    if (fenceMatch) {
      const marker = fenceMatch[1]![0] as '`' | '~';
      const length = fenceMatch[1]!.length;
      if (!fence) {
        fence = { marker, length };
      } else {
        // CommonMark closing fences may contain only the marker and trailing spaces. A line such as
        // ```example inside the code body must not accidentally expose later blank lines as stable.
        const closingFence = new RegExp(`^\\s{0,3}${escapeRegExp(marker)}{${fence.length},}\\s*$`);
        if (fence.marker === marker && closingFence.test(line)) fence = undefined;
      }
    } else if (!fence && trimmed === '$$') {
      displayMathOpen = !displayMathOpen;
    }

    previousBlank = trimmed.length === 0 && !fence && !displayMathOpen;
    offset += line.length + 1;
  }
  return candidate;
}

function isSafeTopLevelBlockStart(line: string): boolean {
  if (!line.trim()) return false;
  if (/^(?:\t| {4})/.test(line)) return false;
  const trimmed = line.replace(/^ {0,3}/, '');
  if (/^(?:[-+*]|\d+[.)])\s+/.test(trimmed)) return false;
  if (/^>/.test(trimmed)) return false;
  if (/^\[[^\]]+\]:/.test(trimmed)) return false;
  return true;
}

function containsGlobalMarkdownDefinition(source: string): boolean {
  return /^\s{0,3}\[[^\]]+\]:\s*\S+/m.test(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokensToRenderedParts(parser: MarkdownParser, tokens: MarkdownToken[]): MarkdownRenderedPart[] {
  const parts: MarkdownRenderedPart[] = [];
  let htmlTokens: MarkdownToken[] = [];

  const flushHtml = (): void => {
    if (htmlTokens.length === 0) return;
    const html = parser.renderer.render(htmlTokens, parser.options, {}).trim();
    if (html) parts.push({ kind: 'html', html });
    htmlTokens = [];
  };

  for (const token of tokens) {
    if (token.type === 'fence' || token.type === 'code_block') {
      flushHtml();
      parts.push({
        kind: 'code',
        code: token.content,
        language: languageFromInfo(token.info),
        info: token.info?.trim() ?? ''
      });
      continue;
    }

    htmlTokens.push(token);
  }

  flushHtml();
  return parts;
}

function languageFromInfo(info: string | undefined): string {
  const trimmed = info?.trim() ?? '';
  if (!trimmed) return '';
  const classMatch = trimmed.match(/^\{\.?([\w+#.-]+)/);
  return classMatch?.[1] ?? trimmed.split(/\s+/)[0] ?? '';
}

function parserFor(options: MarkdownRenderOptions): MarkdownParser {
  return options.preserveSoftBreaks === true ? softBreakParser : parser;
}

function finalCacheKey(text: string, preserveSoftBreaks: boolean): string {
  return `${preserveSoftBreaks ? 'soft-breaks' : 'commonmark'}\0${text}`;
}

function rememberFinalRender(cacheKey: string, html: string): void {
  finalRenderCache.set(cacheKey, html);
  trimFinalCache(finalRenderCache);
}

function rememberFinalParts(cacheKey: string, parts: MarkdownRenderedPart[]): void {
  finalPartCache.set(cacheKey, parts);
  trimFinalCache(finalPartCache);
}

function trimFinalCache(cache: Map<string, unknown>): void {
  if (cache.size <= FINAL_CACHE_LIMIT) return;

  const oldestKey = cache.keys().next().value as string | undefined;
  if (oldestKey !== undefined) cache.delete(oldestKey);
}

function createParser(MarkdownItCtor: MarkdownItConstructor, preserveSoftBreaks = false): MarkdownParser {
  const parser = new MarkdownItCtor({
    html: false,
    linkify: true,
    typographer: false,
    breaks: preserveSoftBreaks
  });

  parser.use(texmath, {
    engine: katex,
    delimiters: ['dollars', 'brackets', 'beg_end', 'gitlab'],
    katexOptions: {
      throwOnError: false,
      strict: 'warn',
      trust: false,
      maxSize: 8,
      maxExpand: 1000
    }
  });

  // markdown-it 的 linkify 默认会把裸域名自动转为链接。
  // 许多常见文件名后缀同时也是合法 TLD，例如 libil2cpp.so、archive.zip、script.sh。
  // 聊天内容里这些更常表示文件名，不应被误渲染成网页；只自动识别带协议的 URL / 邮箱，
  // 显式 Markdown 链接（[text](url)）仍由 markdown-it 正常处理。
  parser.linkify?.set({ fuzzyLink: false, fuzzyIP: false });

  // markdown-it 默认拒绝 file:。本地图片会转换成 Webview 资源 URI，本地文件链接
  // 则由点击事件交给 Extension Host 使用 vscode.open；脚本协议仍由默认校验拦截。
  const defaultValidateLink = parser.validateLink.bind(parser);
  parser.validateLink = (url: string) => /^file:/i.test(url.trim()) || defaultValidateLink(url);

  const defaultLinkOpen = parser.renderer.rules.link_open;
  parser.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const hrefIndex = tokens[index].attrIndex('href');
    const currentHref = hrefIndex >= 0 ? tokens[index].attrs?.[hrefIndex]?.[1] : undefined;
    if (typeof currentHref === 'string' && normalizeLocalFileSource(currentHref)) {
      setTokenAttr(tokens[index], LOCAL_FILE_LINK_DATA_ATTRIBUTE, currentHref);
      setTokenAttr(tokens[index], 'href', '#');
    } else {
      setTokenAttr(tokens[index], 'target', '_blank');
      setTokenAttr(tokens[index], 'rel', 'noreferrer noopener');
    }
    return defaultLinkOpen ? defaultLinkOpen(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
  };

  const defaultImage = parser.renderer.rules.image;
  parser.renderer.rules.image = (tokens, index, options, env, self) => {
    const srcIndex = tokens[index].attrIndex('src');
    const currentSrc = srcIndex >= 0 ? tokens[index].attrs?.[srcIndex]?.[1] : undefined;
    if (typeof currentSrc === 'string') {
      setTokenAttr(tokens[index], 'src', toWebviewImageSrc(currentSrc));
    }
    setTokenAttr(tokens[index], 'loading', 'lazy');
    setTokenAttr(tokens[index], 'referrerpolicy', 'no-referrer');
    return defaultImage ? defaultImage(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
  };

  return parser;
}

function setTokenAttr(token: MarkdownToken, name: string, value: string): void {
  const attrIndex = token.attrIndex(name);
  if (attrIndex < 0) {
    token.attrPush([name, value]);
    return;
  }
  if (token.attrs) token.attrs[attrIndex] = [name, value];
}
