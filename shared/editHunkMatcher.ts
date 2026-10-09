export interface ExactEditHunk {
  oldContent: string;
  newContent: string;
  replaceAll?: boolean;
}

export interface ExactEditMatch {
  normalizedIndex: number;
  sourceStart: number;
  sourceEnd: number;
}

export interface ExactEditHunkResult {
  content: string;
  matches: ExactEditMatch[];
  matchCount: number;
  replacements: number;
  matchStrategy?: EditHunkMatchStrategy;
}

export type EditHunkMatchStrategy = 'exact' | 'trim_end' | 'trim' | 'unicode';

interface CanonicalText {
  text: string;
  /** sourceOffsets[n] is the source UTF-16 offset at canonical boundary n. */
  sourceOffsets: number[];
}

interface LineSpan {
  text: string;
  start: number;
  end: number;
  hasNewline: boolean;
}

/**
 * Searches exact text first, then complete lines with Codex's trim_end, trim, and Unicode
 * punctuation comparisons. One comparison tier is selected for the entire hunk, including
 * replaceAll. Every replacement uses the actual source range; untouched text stays unchanged.
 */
export function applyExactEditHunk(source: string, hunk: ExactEditHunk): ExactEditHunkResult {
  if (!hunk.oldContent) throw new TypeError('oldContent must be non-empty.');
  const canonicalSource = canonicalizeWithOffsets(source);
  const canonicalSearch = normalizeLineEndings(hunk.oldContent);
  if (!canonicalSearch) throw new TypeError('oldContent must be non-empty.');
  const exactIndexes = findNonOverlappingMatches(canonicalSource.text, canonicalSearch);
  const located = exactIndexes.length > 0
    ? { strategy: 'exact' as const, ranges: exactIndexes.map((start) => ({ start, end: start + canonicalSearch.length })) }
    : findLineMatches(canonicalSource.text, canonicalSearch);
  if (!located) return { content: source, matches: [], matchCount: 0, replacements: 0 };

  const matches = located.ranges.map(({ start: normalizedIndex, end }): ExactEditMatch => {
    const sourceStart = canonicalSource.sourceOffsets[normalizedIndex];
    const sourceEnd = canonicalSource.sourceOffsets[end];
    if (sourceStart === undefined || sourceEnd === undefined) {
      throw new Error('Edit match boundary could not be mapped to the source text.');
    }
    return { normalizedIndex, sourceStart, sourceEnd };
  });
  const fileEol = firstLineEnding(source)
    ?? firstLineEnding(hunk.oldContent)
    ?? firstLineEnding(hunk.newContent)
    ?? '\n';
  let content = source;
  const replacements = hunk.replaceAll === true ? matches : [matches[0]!];
  for (const match of [...replacements].sort((left, right) => right.sourceStart - left.sourceStart)) {
    const matchedSource = source.slice(match.sourceStart, match.sourceEnd);
    const replacementEol = firstLineEnding(matchedSource) ?? fileEol;
    const replacement = convertLineEndings(hunk.newContent, replacementEol);
    content = `${content.slice(0, match.sourceStart)}${replacement}${content.slice(match.sourceEnd)}`;
  }
  return { content, matches, matchCount: matches.length, replacements: replacements.length, matchStrategy: located.strategy };
}

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n|\r/g, '\n');
}

export function firstLineEnding(value: string): '\r\n' | '\n' | '\r' | undefined {
  const match = /\r\n|\r|\n/.exec(value);
  return match?.[0] as '\r\n' | '\n' | '\r' | undefined;
}

export function convertLineEndings(value: string, eol: '\r\n' | '\n' | '\r'): string {
  return normalizeLineEndings(value).replace(/\n/g, eol);
}

function canonicalizeWithOffsets(source: string): CanonicalText {
  let text = '';
  const sourceOffsets = [0];
  for (let sourceOffset = 0; sourceOffset < source.length;) {
    const code = source.charCodeAt(sourceOffset);
    if (code === 13) {
      sourceOffset += source.charCodeAt(sourceOffset + 1) === 10 ? 2 : 1;
      text += '\n';
      sourceOffsets.push(sourceOffset);
      continue;
    }
    sourceOffset += 1;
    text += source[sourceOffset - 1];
    sourceOffsets.push(sourceOffset);
  }
  return { text, sourceOffsets };
}

function findNonOverlappingMatches(content: string, search: string): number[] {
  const matches: number[] = [];
  for (let fromIndex = 0; fromIndex <= content.length;) {
    const found = content.indexOf(search, fromIndex);
    if (found < 0) break;
    matches.push(found);
    fromIndex = found + search.length;
  }
  return matches;
}

function findLineMatches(content: string, search: string): {
  strategy: Exclude<EditHunkMatchStrategy, 'exact'>;
  ranges: Array<{ start: number; end: number }>;
} | undefined {
  const sourceLines = lineSpans(content);
  const patternLines = search.split('\n');
  const includesLastNewline = search.endsWith('\n');
  if (includesLastNewline) patternLines.pop();
  if (patternLines.length > sourceLines.length) return undefined;
  const comparisons = [
    ['trim_end', (line: string) => line.replace(/\p{White_Space}+$/u, '')],
    ['trim', trimWhitespace],
    ['unicode', normalizePunctuation]
  ] as const;
  for (const [strategy, compare] of comparisons) {
    const pattern = patternLines.map(compare);
    const lines = sourceLines.map((line) => compare(line.text));
    const ranges: Array<{ start: number; end: number }> = [];
    for (let index = 0; index + pattern.length <= lines.length;) {
      const last = sourceLines[index + pattern.length - 1]!;
      if ((!includesLastNewline || last.hasNewline)
        && pattern.every((line, offset) => line === lines[index + offset])) {
        ranges.push({ start: sourceLines[index]!.start, end: last.end + (includesLastNewline ? 1 : 0) });
        index += pattern.length;
      } else {
        index += 1;
      }
    }
    if (ranges.length > 0) return { strategy, ranges };
  }
  return undefined;
}

function lineSpans(content: string): LineSpan[] {
  const lines: LineSpan[] = [];
  // A file's BOM belongs to the file header, outside a line replacement.
  for (let start = content.startsWith('\ufeff') ? 1 : 0; start < content.length;) {
    const newline = content.indexOf('\n', start);
    const end = newline < 0 ? content.length : newline;
    lines.push({ text: content.slice(start, end), start, end, hasNewline: newline >= 0 });
    if (newline < 0) break;
    start = newline + 1;
  }
  return lines;
}

function trimWhitespace(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}

/** The small punctuation table used by Codex apply-patch's seek_sequence. */
function normalizePunctuation(value: string): string {
  return trimWhitespace(value)
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018-\u201b]/g, "'")
    .replace(/[\u201c-\u201f]/g, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, ' ');
}
