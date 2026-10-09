import { isEmptyToolArgument, ToolArgumentError, toolArgumentRecord } from './toolArgumentUtils';

export interface ValidatedWriteToolArguments {
  path: string;
  content: string;
}

export interface ValidatedDeleteToolArguments {
  paths: string[];
}

/** A full-file write. Optional transport scaffolding and unrelated hints cannot change its action. */
export function validateWriteToolArguments(value: unknown): ValidatedWriteToolArguments {
  const args = toolArgumentRecord(value, 'write arguments');
  const path = requireFilePath(args.path, 'write.path');
  if (typeof args.content !== 'string') throw new ToolArgumentError('write.content must be a string.');
  requireSupportedBoolean(args, 'append', false, 'write replaces the complete file; use edit to insert content.');
  requireSupportedBoolean(args, 'dryRun', false, 'write does not support dryRun.');
  requireSupportedBoolean(args, 'overwrite', true, 'write does not support overwrite=false.');
  requireOperation(args, 'write');
  return { path, content: args.content };
}

/** Validates the complete deletion list before resolving or reading even its first target. */
export function validateDeleteToolArguments(value: unknown): ValidatedDeleteToolArguments {
  const args = toolArgumentRecord(value, 'delete arguments');
  if (!Array.isArray(args.paths) || args.paths.length === 0) throw new ToolArgumentError('delete.paths must be a non-empty array.');
  const paths = args.paths.map((path, index) => requireFilePath(path, `delete.paths[${index}]`));
  requireSupportedBoolean(args, 'dryRun', false, 'delete does not support dryRun.');
  requireSupportedBoolean(args, 'recursive', true, 'delete removes directories recursively; recursive=false is not supported.');
  requireOperation(args, 'delete');
  return { paths };
}

function requireFilePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ToolArgumentError(`${label} must be a non-empty string.`);
  return value.trim();
}

function requireSupportedBoolean(args: Record<string, unknown>, key: string, supported: boolean, message: string): void {
  const value = args[key];
  if (isEmptyToolArgument(value)) return;
  if (typeof value !== 'boolean') throw new ToolArgumentError(`${key} must be a boolean when provided.`);
  if (value !== supported) throw new ToolArgumentError(message);
}

function requireOperation(args: Record<string, unknown>, operation: 'write' | 'delete'): void {
  for (const key of ['mode', 'operation']) {
    const value = args[key];
    if (isEmptyToolArgument(value) || typeof value === 'string' && !value.trim()) continue;
    if (value !== operation) throw new ToolArgumentError(`${operation}.${key} cannot request another operation. Use the appropriate tool.`);
  }
}
