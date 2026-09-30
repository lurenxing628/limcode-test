import type { FsFileDiffRecord, FsHunkEditRequest } from './types';

const DEFAULT_DIFF_CONTEXT_LINES = 3;
const MAX_LCS_CELLS = 1_000_000;
const MAX_MYERS_EDIT_DISTANCE = 4_000;
const MAX_MYERS_TRACE_CELLS = 2_000_000;
const MAX_DIFF_TEXT_CHARS = 120_000;

type DiffOpType = 'ctx' | 'add' | 'del';

interface RawDiffOp {
  type: DiffOpType;
  content: string;
}

interface NumberedDiffOp extends RawDiffOp {
  oldPos: number;
  newPos: number;
  oldNum?: number;
  newNum?: number;
}

export function buildFileDiffRecord(filePath: string, before: string, after: string, existed: boolean): FsFileDiffRecord | undefined {
  const result = buildUnifiedLineDiff(filePath, before, after, existed, DEFAULT_DIFF_CONTEXT_LINES);
  if (!result) return undefined;
  const truncated = truncateDiffText(result.text);
  return {
    format: 'unified',
    text: truncated.text,
    added: result.added,
    removed: result.removed,
    truncated: truncated.truncated
  };
}

export function buildFileReplacementHunks(before: string, after: string, contextLines = DEFAULT_DIFF_CONTEXT_LINES): FsHunkEditRequest[] {
  if (before === after) return [];
  const beforeLines = splitLinesForDiff(before);
  const afterLines = splitLinesForDiff(after);
  const ops = numberDiffOps(buildRawDiffOps(beforeLines, afterLines));
  const ranges = hunkRanges(ops, contextLines);
  return ranges
    .map((range) => replacementHunkFromOps(ops.slice(range.start, range.end)))
    .filter((hunk): hunk is FsHunkEditRequest => !!hunk);
}

function replacementHunkFromOps(ops: NumberedDiffOp[]): FsHunkEditRequest | undefined {
  const oldLines = ops.filter((op) => op.type !== 'add').map((op) => op.content);
  const newLines = ops.filter((op) => op.type !== 'del').map((op) => op.content);
  const oldContent = oldLines.join('\n');
  const newContent = newLines.join('\n');
  if (oldContent === newContent || oldContent.length === 0) return undefined;
  return { oldContent, newContent };
}

export function countDiffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk && (line.startsWith('+++') || line.startsWith('---'))) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

function buildUnifiedLineDiff(
  filePath: string, before: string, after: string, existed: boolean, contextLines: number
): { text: string; added: number; removed: number } | undefined {
  if (before === after) return undefined;
  const beforeLines = splitLinesForDiff(before);
  const afterLines = splitLinesForDiff(after);
  const ops = numberDiffOps(buildRawDiffOps(beforeLines, afterLines));
  const ranges = hunkRanges(ops, contextLines);
  if (ranges.length === 0) return undefined;
  const normalizedPath = normalizeDiffPath(filePath || 'file');
  const oldFile = existed ? `a/${normalizedPath}` : '/dev/null';
  const hunks = ranges.map((range) => formatHunk(ops.slice(range.start, range.end)));
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added += 1;
    else if (op.type === 'del') removed += 1;
  }
  return { text: [`--- ${oldFile}`, `+++ b/${normalizedPath}`, ...hunks].join('\n'), added, removed };
}

function splitLinesForDiff(text: string): string[] {
  if (!text) return [];
  const lines = normalizeLineEndings(text).split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function buildRawDiffOps(beforeLines: string[], afterLines: string[]): RawDiffOp[] {
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }

  let oldEnd = beforeLines.length;
  let newEnd = afterLines.length;
  while (oldEnd > prefix && newEnd > prefix && beforeLines[oldEnd - 1] === afterLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const ops: RawDiffOp[] = [];
  for (let index = 0; index < prefix; index += 1) ops.push({ type: 'ctx', content: beforeLines[index] });
  for (const op of diffSegment(beforeLines.slice(prefix, oldEnd), afterLines.slice(prefix, newEnd))) ops.push(op);
  for (let index = oldEnd; index < beforeLines.length; index += 1) ops.push({ type: 'ctx', content: beforeLines[index] });
  return ops;
}

function diffSegment(oldLines: string[], newLines: string[]): RawDiffOp[] {
  if (oldLines.length === 0) return newLines.map((content) => ({ type: 'add', content }));
  if (newLines.length === 0) return oldLines.map((content) => ({ type: 'del', content }));

  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    // With no common line the exact edit script is already known. This common
    // generated-file case needs no Myers search or trace allocation.
    const oldValues = new Set(oldLines);
    if (!newLines.some((line) => oldValues.has(line))) return fullReplacementDiffOps(oldLines, newLines);
    return diffSegmentByMyers(oldLines, newLines) ?? fullReplacementDiffOps(oldLines, newLines);
  }

  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const dp = Array.from({ length: rows }, () => new Uint32Array(cols));

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      dp[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? dp[oldIndex + 1][newIndex + 1] + 1
        : Math.max(dp[oldIndex + 1][newIndex], dp[oldIndex][newIndex + 1]);
    }
  }

  const ops: RawDiffOp[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      ops.push({ type: 'ctx', content: oldLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (dp[oldIndex + 1][newIndex] >= dp[oldIndex][newIndex + 1]) {
      ops.push({ type: 'del', content: oldLines[oldIndex] });
      oldIndex += 1;
    } else {
      ops.push({ type: 'add', content: newLines[newIndex] });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) {
    ops.push({ type: 'del', content: oldLines[oldIndex] });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    ops.push({ type: 'add', content: newLines[newIndex] });
    newIndex += 1;
  }
  return ops;
}

function diffSegmentByMyers(oldLines: string[], newLines: string[]): RawDiffOp[] | undefined {
  const oldLength = oldLines.length;
  const newLength = newLines.length;
  const maxDistance = Math.min(oldLength + newLength, MAX_MYERS_EDIT_DISTANCE);
  let traceCells = 0;
  const furthest = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];

  for (let distance = 0; distance <= maxDistance; distance += 1) {
    traceCells += furthest.size;
    if (traceCells > MAX_MYERS_TRACE_CELLS) return undefined;
    trace.push(new Map(furthest));

    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const useDownMove = diagonal === -distance
        || (diagonal !== distance && getFurthest(furthest, diagonal - 1) < getFurthest(furthest, diagonal + 1));
      const previousDiagonal = useDownMove ? diagonal + 1 : diagonal - 1;
      let oldIndex = useDownMove ? getFurthest(furthest, previousDiagonal) : getFurthest(furthest, previousDiagonal) + 1;
      if (!Number.isFinite(oldIndex) || oldIndex < 0) oldIndex = 0;
      let newIndex = oldIndex - diagonal;

      while (
        oldIndex < oldLength
        && newIndex < newLength
        && newIndex >= 0
      ) {
        if (oldLines[oldIndex] !== newLines[newIndex]) break;
        oldIndex += 1;
        newIndex += 1;
      }

      furthest.set(diagonal, oldIndex);
      if (oldIndex >= oldLength && newIndex >= newLength) {
        return backtrackMyersDiff(trace, oldLines, newLines, distance);
      }
    }
  }

  return undefined;
}

function backtrackMyersDiff(trace: Array<Map<number, number>>, oldLines: string[], newLines: string[], editDistance: number): RawDiffOp[] {
  let oldIndex = oldLines.length;
  let newIndex = newLines.length;
  const reversed: RawDiffOp[] = [];

  for (let distance = editDistance; distance > 0; distance -= 1) {
    const furthest = trace[distance];
    const diagonal = oldIndex - newIndex;
    const useDownMove = diagonal === -distance
      || (diagonal !== distance && getFurthest(furthest, diagonal - 1) < getFurthest(furthest, diagonal + 1));
    const previousDiagonal = useDownMove ? diagonal + 1 : diagonal - 1;
    const previousOldRaw = getFurthest(furthest, previousDiagonal);
    const previousOld = Number.isFinite(previousOldRaw) ? previousOldRaw : 0;
    const previousNew = previousOld - previousDiagonal;

    while (oldIndex > previousOld && newIndex > previousNew) {
      reversed.push({ type: 'ctx', content: oldLines[oldIndex - 1] });
      oldIndex -= 1;
      newIndex -= 1;
    }

    if (useDownMove) {
      if (newIndex > 0) {
        reversed.push({ type: 'add', content: newLines[newIndex - 1] });
        newIndex -= 1;
      }
    } else if (oldIndex > 0) {
      reversed.push({ type: 'del', content: oldLines[oldIndex - 1] });
      oldIndex -= 1;
    }
  }

  while (oldIndex > 0 && newIndex > 0) {
    reversed.push({ type: 'ctx', content: oldLines[oldIndex - 1] });
    oldIndex -= 1;
    newIndex -= 1;
  }
  while (oldIndex > 0) {
    reversed.push({ type: 'del', content: oldLines[oldIndex - 1] });
    oldIndex -= 1;
  }
  while (newIndex > 0) {
    reversed.push({ type: 'add', content: newLines[newIndex - 1] });
    newIndex -= 1;
  }

  return reversed.reverse();
}

function getFurthest(furthest: Map<number, number>, diagonal: number): number {
  return furthest.get(diagonal) ?? Number.NEGATIVE_INFINITY;
}

function fullReplacementDiffOps(oldLines: string[], newLines: string[]): RawDiffOp[] {
  return [
    ...oldLines.map((content) => ({ type: 'del' as const, content })),
    ...newLines.map((content) => ({ type: 'add' as const, content }))
  ];
}

function numberDiffOps(rawOps: RawDiffOp[]): NumberedDiffOp[] {
  let oldLine = 1;
  let newLine = 1;
  return rawOps.map((op) => {
    const base: NumberedDiffOp = { type: op.type, content: op.content, oldPos: oldLine, newPos: newLine };
    if (op.type === 'ctx') {
      base.oldNum = oldLine;
      base.newNum = newLine;
      oldLine += 1;
      newLine += 1;
      return base;
    }
    if (op.type === 'del') {
      base.oldNum = oldLine;
      oldLine += 1;
      return base;
    }
    base.newNum = newLine;
    newLine += 1;
    return base;
  });
}

function hunkRanges(ops: NumberedDiffOp[], contextLines: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index].type === 'ctx') continue;
    const start = Math.max(0, index - contextLines);
    const end = Math.min(ops.length, index + contextLines + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  return ranges;
}

function formatRangeStart(start: number, count: number): string {
  return `${Math.max(0, start)},${count}`;
}

function formatHunk(ops: NumberedDiffOp[]): string {
  const oldCount = ops.filter((op) => op.type !== 'add').length;
  const newCount = ops.filter((op) => op.type !== 'del').length;
  const first = ops[0];
  const firstOldNum = ops.find((op) => op.oldNum !== undefined)?.oldNum;
  const firstNewNum = ops.find((op) => op.newNum !== undefined)?.newNum;
  const oldStart = oldCount > 0 ? (firstOldNum ?? 0) : Math.max(0, first.oldPos - 1);
  const newStart = newCount > 0 ? (firstNewNum ?? 0) : Math.max(0, first.newPos - 1);
  const lines = ops.map((op) => {
    if (op.type === 'add') return `+${op.content}`;
    if (op.type === 'del') return `-${op.content}`;
    return ` ${op.content}`;
  });
  return [`@@ -${formatRangeStart(oldStart, oldCount)} +${formatRangeStart(newStart, newCount)} @@`, ...lines].join('\n');
}

function truncateDiffText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DIFF_TEXT_CHARS) return { text, truncated: false };
  let headLength = Math.floor(MAX_DIFF_TEXT_CHARS * 0.68);
  let tailStart = text.length - (MAX_DIFF_TEXT_CHARS - headLength);
  // Never split a Unicode surrogate pair at either truncation boundary.
  if (/[\uD800-\uDBFF]/.test(text[headLength - 1])) headLength -= 1;
  if (/[\uDC00-\uDFFF]/.test(text[tailStart])) tailStart += 1;
  return {
    text: `${text.slice(0, headLength)}\n\n... diff 已截断，共 ${text.length} 字符 ...\n\n${text.slice(tailStart)}`,
    truncated: true
  };
}

function normalizeDiffPath(filePath: string): string {
  return filePath.trim().replace(/\\+/g, '/').replace(/^\.\//, '').replace(/^\/+/, '') || 'file';
}
