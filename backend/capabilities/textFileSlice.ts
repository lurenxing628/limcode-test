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
  const fileLines = content.split(/\r?\n/);
  const from = normalizeStartLine(startLine);
  const to = normalizeEndLine(endLine, fileLines.length);
  const lines: FsReadLine[] = [];
  let budget = READ_SLICE_MAX_BYTES;

  for (let i = from; i <= to; i += 1) {
    const text = fileLines[i - 1] ?? '';
    const rendered = `${i} ${text}`;
    const cost = Buffer.byteLength(rendered, 'utf8') + (lines.length > 0 ? 1 : 0);
    // Always yield the first line, however long, so a read can never come back empty and stall.
    if (cost > budget && lines.length > 0) break;
    budget -= cost;
    lines.push({ line: i, text });
  }

  return {
    path,
    startLine: from,
    endLine: lines.length > 0 ? lines[lines.length - 1]!.line : to,
    totalLines: fileLines.length,
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
