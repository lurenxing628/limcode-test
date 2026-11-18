import type { FsReadFileResult, FsReadLine } from './types';

/**
 * Largest slice handed back to the model in one read. The file itself may be far larger; the reader
 * reports totalLines alongside the slice so the next read can continue from endLine + 1.
 */
export const READ_SLICE_MAX_BYTES = 256 * 1024;

export function sliceTextFile(
  path: string,
  content: string,
  startLine: number | undefined,
  endLine: number | undefined
): FsReadFileResult {
  const from = normalizeStartLine(startLine);
  const maxRequestedLine = typeof endLine === 'number' && Number.isFinite(endLine)
    ? Math.max(1, Math.floor(endLine))
    : Number.POSITIVE_INFINITY;
  const lines: FsReadLine[] = [];
  let budget = READ_SLICE_MAX_BYTES;
  let budgetExhausted = false;
  let totalLines = 0;
  let lineStart = 0;

  while (true) {
    totalLines += 1;
    const newlineIndex = content.indexOf('\n', lineStart);
    const rawEnd = newlineIndex === -1 ? content.length : newlineIndex;
    if (!budgetExhausted && totalLines >= from && totalLines <= maxRequestedLine) {
      const lineEnd = rawEnd > lineStart && content.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd;
      const text = content.slice(lineStart, lineEnd);
      const rendered = `${totalLines} ${text}`;
      const cost = Buffer.byteLength(rendered, 'utf8') + (lines.length > 0 ? 1 : 0);
      // Always yield the first line, however long, so a read can never come back empty and stall.
      if (cost > budget && lines.length > 0) {
        budgetExhausted = true;
      } else {
        budget -= cost;
        lines.push({ line: totalLines, text });
      }
    }
    if (newlineIndex === -1) break;
    lineStart = newlineIndex + 1;
  }

  const to = normalizeEndLine(endLine, totalLines);
  return {
    path,
    startLine: from,
    endLine: lines.length > 0 ? lines[lines.length - 1]!.line : to,
    totalLines,
    lines,
    content: lines.map((line) => `${line.line} ${line.text}`).join('\n')
  };
}

export function normalizeStartLine(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

export function normalizeEndLine(value: number | undefined, totalLines: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return totalLines;
  return Math.min(totalLines, Math.max(1, Math.floor(value)));
}
