import type { EditToolMode } from '../../shared/protocol';
import type { FsHunkEditRequest } from './types';
import { applyExactEditHunk, convertLineEndings, firstLineEnding, normalizeLineEndings } from '../../shared/editHunkMatcher';

export interface EditApplyResult {
  mode: EditToolMode;
  newContent: string;
  totalHunks: number;
  applied: number;
  failed: number;
  results: EditApplyHunkResult[];
  fallbackMode?: string;
}

export interface EditApplyHunkResult {
  index: number;
  success: boolean;
  error?: string;
  startLine?: number;
  endLine?: number;
  appliedBy?: string;
  matchCount?: number;
  candidateLines?: number[];
  replacements?: number;
  fallback?: {
    strategy: string;
    message: string;
    originalHeader?: string;
    correctedHeader?: string;
  };
}

export function applyHunkEdit(originalContent: string, hunks: FsHunkEditRequest[]): EditApplyResult {
  let currentContent = originalContent;
  const results: EditApplyHunkResult[] = [];

  for (let index = 0; index < hunks.length; index += 1) {
    const hunk = hunks[index];
    if (!hunk || typeof hunk.oldContent !== 'string' || typeof hunk.newContent !== 'string') {
      results.push({ index, success: false, error: `Hunk ${index} must contain string oldContent and newContent.` });
      continue;
    }

    const oldContent = hunk.oldContent;
    const newContent = hunk.newContent;
    const replaceAll = hunk.replaceAll === true;
    if (!oldContent) {
      results.push({ index, success: false, error: `Hunk ${index} has empty oldContent. Provide existing file content to locate the replacement.`, matchCount: 0 });
      continue;
    }

    const applied = applyExactEditHunk(currentContent, { oldContent, newContent, replaceAll });
    const matches = applied.matches;
    const candidateLines = matches.slice(0, 20).map((match) => getLineNumberAtIndex(currentContent, match.sourceStart));
    if (matches.length === 0) {
      results.push({ index, success: false, error: `Hunk ${index}: no match found for oldContent after exact, whitespace, and Unicode punctuation comparisons.`, matchCount: 0 });
      continue;
    }

    const firstMatch = matches[0]!.sourceStart;
    const startLine = getLineNumberAtIndex(currentContent, firstMatch);
    const endLine = startLine + Math.max(countTextLines(newContent), 1) - 1;

    currentContent = applied.content;
    results.push({
      index,
      success: true,
      startLine,
      endLine,
      appliedBy: replaceAll ? 'search_replace_all' : 'search_replace_first',
      matchCount: applied.matchCount,
      replacements: applied.replacements,
      candidateLines,
      ...(applied.matchStrategy && applied.matchStrategy !== 'exact' ? { fallback: {
        strategy: applied.matchStrategy,
        message: `Matched existing source lines using ${applied.matchStrategy}.`
      } } : {})
    });
  }

  const applied = results.filter((item) => item.success).length;

  return {
    mode: 'hunk',
    newContent: currentContent,
    totalHunks: hunks.length,
    applied,
    failed: Math.max(0, hunks.length - applied),
    results
  };
}

export function applyInsertEdit(originalContent: string, line: number, content: string): EditApplyResult {
  const offsets = lineStartOffsets(originalContent);
  const totalLines = offsets.length;

  if (!Number.isFinite(line) || line < 1) {
    return {
      mode: 'insert',
      newContent: originalContent,
      totalHunks: 1,
      applied: 0,
      failed: 1,
      results: [{ index: 0, success: false, error: `Invalid line number: ${line}. Must be a positive integer (1-based).` }]
    };
  }
  if (line > totalLines + 1) {
    return {
      mode: 'insert',
      newContent: originalContent,
      totalHunks: 1,
      applied: 0,
      failed: 1,
      results: [{ index: 0, success: false, error: `Line ${line} is out of range. The file has ${totalLines} lines. Use line ${totalLines + 1} to append at the end.` }]
    };
  }

  const eol = firstLineEnding(originalContent) ?? firstLineEnding(content) ?? '\n';
  const insertText = convertLineEndings(content, eol);
  const sourceEndsWithEol = /(?:\r\n|\r|\n)$/.test(originalContent);
  let newContent: string;
  if (line === totalLines + 1) {
    const prefix = originalContent && !sourceEndsWithEol ? eol : '';
    const suffix = sourceEndsWithEol && insertText && !/(?:\r\n|\r|\n)$/.test(insertText) ? eol : '';
    newContent = `${originalContent}${prefix}${insertText}${suffix}`;
  } else {
    const insertOffset = offsets[line - 1]!;
    const suffix = insertText && !/(?:\r\n|\r|\n)$/.test(insertText) ? eol : '';
    newContent = `${originalContent.slice(0, insertOffset)}${insertText}${suffix}${originalContent.slice(insertOffset)}`;
  }
  const endLine = line + Math.max(countTextLines(insertText), 1) - 1;
  return {
    mode: 'insert',
    newContent,
    totalHunks: 1,
    applied: 1,
    failed: 0,
    results: [{ index: 0, success: true, startLine: line, endLine, appliedBy: 'line_number', replacements: 1 }]
  };
}

export function applyDeleteEdit(originalContent: string, startLine: number, endLine: number): EditApplyResult {
  const offsets = lineStartOffsets(originalContent);
  const totalLines = offsets.length;

  if (!Number.isFinite(startLine) || startLine < 1 || !Number.isFinite(endLine) || endLine < 1) {
    return {
      mode: 'delete',
      newContent: originalContent,
      totalHunks: 1,
      applied: 0,
      failed: 1,
      results: [{ index: 0, success: false, error: `Invalid line range: startLine=${startLine}, endLine=${endLine}. Both must be positive integers (1-based).` }]
    };
  }
  if (startLine > endLine) {
    return {
      mode: 'delete',
      newContent: originalContent,
      totalHunks: 1,
      applied: 0,
      failed: 1,
      results: [{ index: 0, success: false, error: `Invalid line range: startLine (${startLine}) must be ≤ endLine (${endLine}).` }]
    };
  }
  if (startLine > totalLines) {
    return {
      mode: 'delete',
      newContent: originalContent,
      totalHunks: 1,
      applied: 0,
      failed: 1,
      results: [{ index: 0, success: false, error: `Line ${startLine} is out of range. The file has ${totalLines} lines.` }]
    };
  }

  const clampedEnd = Math.min(endLine, totalLines);
  const deleteStart = offsets[startLine - 1]!;
  const deleteEnd = clampedEnd === totalLines ? originalContent.length : offsets[clampedEnd]!;
  const deleteCount = clampedEnd - startLine + 1;
  const newContent = `${originalContent.slice(0, deleteStart)}${originalContent.slice(deleteEnd)}`;
  return {
    mode: 'delete',
    newContent,
    totalHunks: 1,
    applied: 1,
    failed: 0,
    results: [{ index: 0, success: true, startLine, endLine: clampedEnd, appliedBy: 'line_number', replacements: deleteCount }]
  };
}

function lineStartOffsets(text: string): number[] {
  const contentStart = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const starts = [contentStart];
  for (let index = contentStart; index < text.length;) {
    const code = text.charCodeAt(index);
    if (code === 13) {
      index += text.charCodeAt(index + 1) === 10 ? 2 : 1;
      if (index < text.length) starts.push(index);
      continue;
    }
    index += 1;
    if (code === 10 && index < text.length) starts.push(index);
  }
  return starts;
}

function getLineNumberAtIndex(content: string, index: number): number {
  let line = 1;
  for (let offset = 0; offset < index;) {
    const code = content.charCodeAt(offset);
    if (code === 13) {
      offset += content.charCodeAt(offset + 1) === 10 ? 2 : 1;
      line += 1;
      continue;
    }
    offset += 1;
    if (code === 10) line += 1;
  }
  return line;
}

function countTextLines(text: string): number {
  return text ? normalizeLineEndings(text).split('\n').length : 0;
}
