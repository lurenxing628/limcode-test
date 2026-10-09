import type { EditToolMode } from './protocol';
import { isEmptyToolArgument, ToolArgumentError, toolArgumentRecord } from './toolArgumentUtils';

export type EditBranchName = 'hunks' | 'insert' | 'delete';

export interface EditArgumentAnalysis {
  explicitMode?: EditToolMode;
  activeBranches: EditBranchName[];
  selectedMode?: EditToolMode;
  ignoredBranches: EditBranchName[];
  inferred: boolean;
}

export interface ValidatedEditHunk {
  oldContent: string;
  newContent: string;
  replaceAll: boolean;
}

export interface EditToolResultMetadata {
  mode: EditToolMode;
  ignoredBranches?: EditBranchName[];
  inferredMode?: boolean;
  warning?: string;
}

/** Describes branch selection without claiming that a pending or rejected edit was applied. */
export function editToolResultMetadata(
  mode: EditToolMode,
  metadata: { ignoredBranches?: readonly EditBranchName[]; inferredMode?: boolean }
): EditToolResultMetadata {
  const ignoredBranches = metadata.ignoredBranches ?? [];
  return {
    mode,
    ...(ignoredBranches.length > 0 ? {
      ignoredBranches: [...ignoredBranches],
      warning: `已选择 mode=${mode}；未执行分支：${ignoredBranches.join('、')}。`
    } : {}),
    ...(metadata.inferredMode ? { inferredMode: true } : {})
  };
}

export type ValidatedEditToolArguments =
  | { path: string; mode: 'hunk'; hunks: ValidatedEditHunk[]; ignoredBranches: EditBranchName[]; inferred: boolean }
  | { path: string; mode: 'insert'; insert: { line: number; content: string }; ignoredBranches: EditBranchName[]; inferred: boolean }
  | { path: string; mode: 'delete'; delete: { startLine: number; endLine: number }; ignoredBranches: EditBranchName[]; inferred: boolean };

/**
 * Validates the edit discriminated union at the shared tool/effect boundary.
 * A supplied mode is the only execution authority: other non-empty branches are ignored and
 * reported, never applied. Without mode, exactly one non-empty branch is required.
 */
export function validateEditToolArguments(value: unknown): ValidatedEditToolArguments {
  const args = requireRecord(value, 'edit arguments');
  const path = requireNonEmptyString(args.path, 'edit.path');
  const analysis = inspectEditToolArguments(args);
  if (!isMissingEditMode(args.mode) && analysis.explicitMode === undefined) {
    throw new ToolArgumentError('edit.mode must be one of "hunk", "insert", or "delete". No file was changed.');
  }
  if (!analysis.selectedMode) {
    const reason = analysis.activeBranches.length === 0
      ? 'No non-empty edit branch was supplied.'
      : `Conflicting branches: ${analysis.activeBranches.join(', ')}. Add mode and keep only the intended branch.`;
    throw new ToolArgumentError(`edit arguments must select exactly one edit branch. ${reason} No file was changed.`);
  }
  const ignoredBranches = analysis.ignoredBranches;
  const inferred = analysis.inferred;
  switch (analysis.selectedMode) {
    case 'hunk':
      return { path, mode: 'hunk', hunks: validateHunks(args.hunks), ignoredBranches, inferred };
    case 'insert':
      return { path, mode: 'insert', insert: validateInsert(args.insert), ignoredBranches, inferred };
    case 'delete':
      return { path, mode: 'delete', delete: validateDelete(args.delete), ignoredBranches, inferred };
  }
}

/** Read-only branch analysis for summaries and UI. It never validates or executes an edit. */
export function inspectEditToolArguments(value: unknown): EditArgumentAnalysis {
  const args = asRecord(value);
  if (!args) return { activeBranches: [], ignoredBranches: [], inferred: false };
  const explicitMode = normalizeEditMode(args.mode);
  const activeBranches = (['hunks', 'insert', 'delete'] as const)
    .filter((branch) => !isEmptyBranchPlaceholder(branch, args[branch]));
  const selectedMode = explicitMode ?? (isMissingEditMode(args.mode) && activeBranches.length === 1
    ? activeBranches[0] === 'hunks' ? 'hunk' : activeBranches[0] : undefined);
  const selectedBranch = explicitMode === 'hunk' ? 'hunks' : explicitMode;
  return {
    ...(explicitMode ? { explicitMode } : {}),
    activeBranches,
    ...(selectedMode ? { selectedMode } : {}),
    ignoredBranches: explicitMode ? activeBranches.filter((branch) => branch !== selectedBranch) : [],
    inferred: explicitMode === undefined && selectedMode !== undefined
  };
}

export function hasRequestedEditHunks(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

export function hasRequestedEditInsert(value: unknown): boolean {
  try {
    validateInsert(value);
    return true;
  } catch {
    return false;
  }
}

export function hasRequestedEditDelete(value: unknown): boolean {
  try {
    validateDelete(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeEditMode(value: unknown): EditToolMode | undefined {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : value;
  return mode === 'hunk' || mode === 'insert' || mode === 'delete' ? mode : undefined;
}

function isMissingEditMode(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string' && value.trim() === '';
}

function validateHunks(value: unknown): ValidatedEditHunk[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolArgumentError('edit.hunks must be complete: provide a non-empty array with oldContent and newContent for each hunk.');
  }
  return value.map((entry, index) => {
    const hunk = requireCompleteRecord(entry, ['oldContent', 'newContent'], `edit.hunks[${index}]`);
    const oldContent = requireString(hunk.oldContent, `edit.hunks[${index}].oldContent`);
    const newContent = requireString(hunk.newContent, `edit.hunks[${index}].newContent`);
    if (!oldContent) throw new ToolArgumentError(`edit.hunks[${index}].oldContent must be non-empty.`);
    if (!isEmptyToolArgument(hunk.replaceAll) && !isMissingEditMode(hunk.replaceAll)
      && typeof hunk.replaceAll !== 'boolean') {
      throw new ToolArgumentError(`edit.hunks[${index}].replaceAll must be a boolean when provided.`);
    }
    return { oldContent, newContent, replaceAll: hunk.replaceAll === true };
  });
}

function validateInsert(value: unknown): { line: number; content: string } {
  const insert = requireCompleteRecord(value, ['line', 'content'], 'edit.insert');
  const line = requirePositiveInteger(insert.line, 'edit.insert.line');
  const content = requireString(insert.content, 'edit.insert.content');
  if (!content) throw new ToolArgumentError('edit.insert.content must be non-empty.');
  return { line, content };
}

function validateDelete(value: unknown): { startLine: number; endLine: number } {
  const deletion = requireCompleteRecord(value, ['startLine', 'endLine'], 'edit.delete');
  const startLine = requirePositiveInteger(deletion.startLine, 'edit.delete.startLine');
  const endLine = requirePositiveInteger(deletion.endLine, 'edit.delete.endLine');
  if (endLine < startLine) throw new ToolArgumentError('edit.delete.endLine must be greater than or equal to startLine.');
  return { startLine, endLine };
}

function isEmptyBranchPlaceholder(branch: EditBranchName, value: unknown): boolean {
  if (isMissingEditMode(value)) return true;
  if (Array.isArray(value)) {
    if (value.length === 0) return true;
    return branch === 'hunks' && value.every((entry) => isEmptyEditRecord(entry, branch));
  }
  return isEmptyEditRecord(value, branch);
}

/** Extra keys do not supply edit information. Declared values such as 0, false, "unused",
 * and real line numbers still make the branch active. */
function isEmptyEditRecord(value: unknown, branch: EditBranchName): boolean {
  const record = asRecord(value);
  if (!record) return false;
  const allowed = branch === 'hunks' ? ['oldContent', 'newContent', 'replaceAll']
    : branch === 'insert' ? ['line', 'content'] : ['startLine', 'endLine'];
  return Object.entries(record).every(([key, field]) => {
    if (!allowed.includes(key)) return true;
    if (field === undefined || field === null) return true;
    if (key === 'replaceAll') return isEmptyToolArgument(field) || isMissingEditMode(field);
    return ['oldContent', 'newContent', 'content'].includes(key) && field === '';
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  return toolArgumentRecord(value, label);
}

function requireCompleteRecord(value: unknown, required: readonly string[], label: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record || required.some((key) => record[key] === undefined || record[key] === null)) {
    throw new ToolArgumentError(`${label} must be complete: provide ${required.join(' and ')}.`);
  }
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new ToolArgumentError(`${label} must be a string.`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const text = requireString(value, label).trim();
  if (!text) throw new ToolArgumentError(`${label} must be non-empty.`);
  return text;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ToolArgumentError(`${label} must be a positive integer.`);
  }
  return value;
}
