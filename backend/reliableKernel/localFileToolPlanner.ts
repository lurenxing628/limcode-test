import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { validateEditToolArguments, type ValidatedEditToolArguments } from '../../shared/editToolArguments';
import { validateWriteToolArguments, validateDeleteToolArguments } from '../../shared/fileToolArguments';
import { applyDeleteEdit, applyHunkEdit, applyInsertEdit } from '../capabilities/editStrategies';
import { assertFilePlanningRoot, captureFilePlanningRoot, readFileWithIdentityFence, resolveFileTarget, resolvePlanningFileTarget, FilePathConflictError, type FilePlanningRoot } from './fileTargetBoundary';
import { assertNotSqliteDatabaseFile } from '../capabilities/filesystem/sqliteDatabaseFileGuard';
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
    const args = validateWriteToolArguments(input.arguments);
    const inputPath = args.path;
    const content = args.content;
    const resolved = await this.resolvePath(inputPath, authority);
    signal?.throwIfAborted();
    const { current, planningRoot, targetPath } = await inspectPlannedTarget(resolved, {}, signal);
    signal?.throwIfAborted();
    if (current.kind === 'directory') throw new Error(`write target is a directory: ${inputPath}`);
    const fileMember: FileChangeProposalMemberInput = {
      operation: current.kind === 'missing' ? 'create_file' : 'replace_file',
      workEnvironmentId: resolved.workEnvironmentId,
      planningRoot,
      targetPath,
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
      ...await planMissingParentDirectories(resolved, planningRoot, targetPath, signal),
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
    const { current, planningRoot, targetPath } = await inspectPlannedTarget(resolved, {}, signal);
    signal?.throwIfAborted();
    if (current.kind !== 'file') throw new Error(`edit target must be an existing regular file: ${inputPath}`);
    const source = decodeUtf8Exact(current.bytes);
    const target = applyEditArguments(source, args);
    return {
      operation: 'replace_file',
      workEnvironmentId: resolved.workEnvironmentId,
      planningRoot,
      targetPath,
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
    const args = validateDeleteToolArguments(input.arguments);
    const members: FileChangeProposalMemberInput[] = [];
    for (let index = 0; index < args.paths.length; index += 1) {
      signal?.throwIfAborted();
      const inputPath = args.paths[index];
      const resolved = await this.resolvePath(inputPath, authority);
      signal?.throwIfAborted();
      const { current, planningRoot, targetPath } = await inspectPlannedTarget(resolved, { recursive: true }, signal);
      signal?.throwIfAborted();
      members.push({
        operation: current.kind === 'directory' ? 'delete_directory_tree' : 'delete_file',
        workEnvironmentId: resolved.workEnvironmentId,
        planningRoot,
        targetPath,
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

async function inspectPlannedTarget(
  resolved: ResolvedLocalToolPath,
  options: { recursive?: boolean } = {},
  signal?: AbortSignal
): Promise<{ current: LocalTarget; planningRoot: FilePlanningRoot; targetPath: string }> {
  const relative = normalizedRelativeTarget(resolved);
  const planningRoot = await captureFilePlanningRoot(resolved.rootPath);
  const target = await resolvePlanningFileTarget(planningRoot, relative);
  const targetPath = path.relative(planningRoot.canonicalPath, target).split(path.sep).join('/');
  const checkBoundary = async () => {
    signal?.throwIfAborted();
    await assertFilePlanningRoot(resolved.rootPath, planningRoot);
    if (await resolvePlanningFileTarget(planningRoot, relative) !== target) {
      throw new FilePathConflictError('File planning alias changed its physical target while reading.');
    }
    return resolveFileTarget(planningRoot, targetPath, true);
  };
  await checkBoundary();
  const current = await inspectLocalTarget(target, options, checkBoundary, signal);
  await checkBoundary();
  return { current, planningRoot, targetPath };
}

async function inspectLocalTarget(
  absolutePath: string,
  options: { recursive?: boolean },
  checkBoundary: () => Promise<unknown>,
  signal?: AbortSignal
): Promise<LocalTarget> {
  // Planning reads the current bytes in the extension host process, which also holds SQLite connections.
  await assertNotSqliteDatabaseFile(absolutePath, options);
  let stat;
  try {
    stat = await fs.lstat(absolutePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Symbolic-link targets are not allowed: ${absolutePath}`);
  if (stat.isDirectory()) return { kind: 'directory' };
  if (!stat.isFile()) throw new Error(`Unsupported filesystem target type: ${absolutePath}`);
  const bytes = await readFileWithIdentityFence(absolutePath, stat, checkBoundary, signal);
  return { kind: 'file', bytes, digest: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * Missing write parents are explicit proposal members, not an untracked dispatcher side effect.
 * This makes approval, receipts and crash recovery cover every created directory as well as the
 * final file. Their ensure-only intent permits another approved write to create a shared parent
 * while this plan awaits approval. Existing components must be real directories, never links.
 */
async function planMissingParentDirectories(
  resolved: ResolvedLocalToolPath,
  planningRoot: FilePlanningRoot,
  relativeTarget: string,
  signal?: AbortSignal
): Promise<FileChangeProposalMemberInput[]> {
  signal?.throwIfAborted();
  await assertFilePlanningRoot(resolved.rootPath, planningRoot);
  const realRoot = planningRoot.canonicalPath;
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
        await resolveFileTarget(planningRoot, path.relative(realRoot, current));
        signal?.throwIfAborted();
        continue;
      } catch (error) {
        if (!isNotFound(error)) throw error;
        missingAncestor = true;
      }
    }
    members.push({
      operation: 'create_directory',
      ensureParentDirectory: true,
      workEnvironmentId: resolved.workEnvironmentId,
      planningRoot,
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

function decodeUtf8Exact(bytes: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
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
