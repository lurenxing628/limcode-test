import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { validateEditToolArguments, type ValidatedEditToolArguments } from '../../shared/editToolArguments';
import { applyDeleteEdit, applyHunkEdit, applyInsertEdit } from '../capabilities/editStrategies';
import { isSamePath } from '../capabilities/filesystem/pathContainment';
import { realPath } from '../capabilities/filesystem/realPath';
import type { ToolDefinition } from '../world/modules/tools/registry';
import type {
  ReliableAgentToolDispatchInput
} from './agentLoop';
import type { FileChangeProposalMemberInput } from './fileEffects';
import type { ReliableToolDispatchAuthority } from './toolDispatcher';

export interface ResolvedLocalToolPath {
  workEnvironmentId: string;
  rootPath: string;
  targetPath: string;
  absolutePath: string;
}

export type LocalToolPathResolver = (
  inputPath: string,
  authority: ReliableToolDispatchAuthority
) => Promise<ResolvedLocalToolPath> | ResolvedLocalToolPath;

/** Pure planner for built-in write/edit/delete tools. It reads current bytes but never mutates them. */
export class LocalFileToolPlanner {
  public constructor(private readonly resolvePath: LocalToolPathResolver) {}

  public async plan(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority,
    signal?: AbortSignal
  ): Promise<FileChangeProposalMemberInput[]> {
    signal?.throwIfAborted();
    switch (definition.declaration.name) {
      case 'write':
        return this.planWrite(input, authority, signal);
      case 'edit':
        return [await this.planEdit(input, authority, signal)];
      case 'delete':
        return this.planDelete(input, authority, signal);
      default:
        throw new Error(`Unsupported local file proposal tool: ${definition.declaration.name}.`);
    }
  }

  private async planWrite(
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority,
    signal?: AbortSignal
  ): Promise<FileChangeProposalMemberInput[]> {
    const args = requireRecord(input.arguments, 'write arguments');
    const inputPath = requireText(args.path, 'write.path');
    const content = requireString(args.content, 'write.content');
    const resolved = await this.resolvePath(inputPath, authority);
    signal?.throwIfAborted();
    const current = await inspectLocalTarget(resolved.absolutePath);
    signal?.throwIfAborted();
    if (current.kind === 'directory') throw new Error(`write target is a directory: ${inputPath}`);
    const fileMember: FileChangeProposalMemberInput = {
      operation: current.kind === 'missing' ? 'create_file' : 'replace_file',
      workEnvironmentId: resolved.workEnvironmentId,
      targetPath: normalizedRelativeTarget(resolved),
      ...(current.kind === 'file' ? {
        baseDigest: current.digest,
        baseContent: current.bytes,
        baseContentType: 'application/octet-stream'
      } : {}),
      targetContent: content,
      contentType: 'text/plain; charset=utf-8'
    };
    if (current.kind !== 'missing') return [fileMember];
    return [
      ...await planMissingParentDirectories(resolved, signal),
      fileMember
    ];
  }

  private async planEdit(
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority,
    signal?: AbortSignal
  ): Promise<FileChangeProposalMemberInput> {
    const args = validateEditToolArguments(input.arguments);
    const inputPath = args.path;
    const resolved = await this.resolvePath(inputPath, authority);
    signal?.throwIfAborted();
    const current = await inspectLocalTarget(resolved.absolutePath);
    signal?.throwIfAborted();
    if (current.kind !== 'file') throw new Error(`edit target must be an existing regular file: ${inputPath}`);
    const source = decodeUtf8Exact(current.bytes, inputPath);
    const target = applyEditArguments(source, args);
    return {
      operation: 'replace_file',
      workEnvironmentId: resolved.workEnvironmentId,
      targetPath: normalizedRelativeTarget(resolved),
      baseDigest: current.digest,
      baseContent: current.bytes,
      baseContentType: 'text/plain; charset=utf-8',
      targetContent: target,
      contentType: 'text/plain; charset=utf-8'
    };
  }

  private async planDelete(
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority,
    signal?: AbortSignal
  ): Promise<FileChangeProposalMemberInput[]> {
    const args = requireRecord(input.arguments, 'delete arguments');
    if (!Array.isArray(args.paths) || args.paths.length === 0) {
      throw new TypeError('delete.paths must be a non-empty array.');
    }
    const members: FileChangeProposalMemberInput[] = [];
    for (let index = 0; index < args.paths.length; index += 1) {
      signal?.throwIfAborted();
      const inputPath = requireText(args.paths[index], `delete.paths[${index}]`);
      const resolved = await this.resolvePath(inputPath, authority);
      signal?.throwIfAborted();
      const current = await inspectLocalTarget(resolved.absolutePath);
      signal?.throwIfAborted();
      members.push({
        operation: current.kind === 'directory' ? 'delete_directory_tree' : 'delete_file',
        workEnvironmentId: resolved.workEnvironmentId,
        targetPath: normalizedRelativeTarget(resolved),
        baseDigest: current.kind === 'file'
          ? current.digest
          : current.kind === 'directory'
            ? 'directory'
            : null,
        ...(current.kind === 'file' ? {
          baseContent: current.bytes,
          baseContentType: 'application/octet-stream'
        } : {})
      });
    }
    return members;
  }
}

export function resolvePathInsideBoundary(
  workEnvironmentId: string,
  rootPathInput: string,
  inputPath: string
): ResolvedLocalToolPath {
  const rootPath = path.resolve(requireText(rootPathInput, 'work environment rootPath'));
  const absolutePath = path.resolve(rootPath, requireText(inputPath, 'file path'));
  const relative = path.relative(rootPath, absolutePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes work environment ${workEnvironmentId}: ${inputPath}`);
  }
  if (!relative) throw new Error('A file tool cannot target the work environment root itself.');
  return {
    workEnvironmentId: requireText(workEnvironmentId, 'workEnvironmentId'),
    rootPath,
    targetPath: relative.split(path.sep).join('/'),
    absolutePath
  };
}

type LocalTarget =
  | { kind: 'missing' }
  | { kind: 'file'; bytes: Buffer; digest: string }
  | { kind: 'directory' };

async function inspectLocalTarget(absolutePath: string): Promise<LocalTarget> {
  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Symbolic-link targets are not allowed: ${absolutePath}`);
  if (stat.isDirectory()) return { kind: 'directory' };
  if (!stat.isFile()) throw new Error(`Unsupported filesystem target type: ${absolutePath}`);
  const bytes = await fs.readFile(absolutePath);
  return { kind: 'file', bytes, digest: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * Missing write parents are explicit proposal members, not an untracked dispatcher side effect.
 * This makes approval, receipts and crash recovery cover every created directory as well as the
 * final file. Existing path components must be real directories and may not be symbolic links.
 */
async function planMissingParentDirectories(
  resolved: ResolvedLocalToolPath,
  signal?: AbortSignal
): Promise<FileChangeProposalMemberInput[]> {
  signal?.throwIfAborted();
  const relativeTarget = normalizedRelativeTarget(resolved);
  const realRoot = await realPath(path.resolve(resolved.rootPath));
  const realTarget = path.resolve(realRoot, relativeTarget.split('/').join(path.sep));
  const parent = path.dirname(realTarget);
  const relativeParent = path.relative(realRoot, parent);
  if (!relativeParent) return [];
  if (relativeParent === '..' || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) {
    throw new Error('Write parent escapes its declared work environment boundary.');
  }

  const members: FileChangeProposalMemberInput[] = [];
  let current = realRoot;
  let missingAncestor = false;
  for (const component of relativeParent.split(path.sep).filter(Boolean)) {
    signal?.throwIfAborted();
    current = path.join(current, component);
    if (!missingAncestor) {
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error(`Symbolic-link write parents are not allowed: ${current}`);
        if (!stat.isDirectory()) throw new Error(`Write parent component is not a directory: ${current}`);
        const canonical = await realPath(current);
        signal?.throwIfAborted();
        if (!isSamePath(canonical, current)) {
          throw new Error(`Write parent does not resolve to its declared boundary path: ${current}`);
        }
        continue;
      } catch (error) {
        if (!isNotFound(error)) throw error;
        missingAncestor = true;
      }
    }
    members.push({
      operation: 'create_directory',
      workEnvironmentId: resolved.workEnvironmentId,
      targetPath: path.relative(realRoot, current).split(path.sep).join('/')
    });
  }
  return members;
}

function applyEditArguments(source: string, args: ValidatedEditToolArguments): string {
  const applied = args.mode === 'hunk'
    ? applyHunkEdit(source, args.hunks)
    : args.mode === 'insert'
      ? applyInsertEdit(source, args.insert.line, args.insert.content)
      : applyDeleteEdit(source, args.delete.startLine, args.delete.endLine);
  if (applied.failed > 0) {
    throw new Error(applied.results.find((result) => !result.success)?.error ?? `edit ${args.mode} failed.`);
  }
  return applied.newContent;
}

function normalizedRelativeTarget(resolved: ResolvedLocalToolPath): string {
  const relative = path.relative(path.resolve(resolved.rootPath), path.resolve(resolved.absolutePath));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Resolved file target is outside its declared work environment boundary.');
  }
  const declared = resolved.targetPath.split('/').join(path.sep);
  if (path.normalize(declared) !== path.normalize(relative)) {
    throw new Error('Resolved file targetPath does not match absolutePath/rootPath evidence.');
  }
  return relative.split(path.sep).join('/');
}

function decodeUtf8Exact(bytes: Buffer, label: string): string {
  const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) throw new Error(`${label} is not canonical UTF-8 text.`);
  return decoded;
}

function requireRecord(value: PlainJsonValue, label: string): { [key: string]: PlainJsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  const text = requireString(value, label).trim();
  if (!text) throw new TypeError(`${label} must be non-empty.`);
  return text;
}

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

type PlainJsonValue = import('./plainJson').PlainJsonValue;
