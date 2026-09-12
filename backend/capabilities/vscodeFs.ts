import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  FsCapability,
  FsDeletePathResult,
  FsEditFileRequest,
  FsEditFileResult,
  FsFileChangeRecord,
  FsFileWriteAction,
  FsDeletePathTargetType,
  FsOpenPendingFileChangeDiffOptions,
  FsPendingFileChangeProposal,
  FsReadBinaryFileResult,
  FsReadFileResult,
  FsReadLine,
  FsWriteFileResult,
  WorkEnvironmentCapabilityOptions
} from './types';
import {
  WORK_ENVIRONMENT_CAPABILITY,
  isLocalFolderWorkEnvironment,
  workEnvironmentDisplayName,
  workEnvironmentSupportsCapability
} from '../../shared/workEnvironmentCatalog';
import {
  deleteRemoteServerPath,
  isRemoteServerCommandEnvironment,
  readRemoteServerRawTextFile,
  readRemoteServerTextFile,
  RemoteFileNotFoundError,
  writeRemoteServerTextFile
} from './workEnvironmentProvider';
import { sliceTextFile } from './textFileSlice';
import { buildFileDiffRecord, buildFileReplacementHunks } from './fileDiff';
import { applyHunkEdit, applyInsertEdit, applyDeleteEdit } from './editStrategies';
import { EXTENSION_BRAND, EXTENSION_COMMAND_IDS, LIVE_DIFF_SCHEME } from '../../shared/extensionIdentity';

/** Reading a file only to return a slice of it is cheap, so the ceiling guards memory, not usefulness. */
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_EDIT_READ_BYTES = 2 * 1024 * 1024;
const LIVE_DIFF_APPLY_COMMAND = EXTENSION_COMMAND_IDS.applyLiveDiffPreview;
const LIVE_DIFF_DOCUMENT_TTL_MS = 10 * 60 * 1000;

interface RawTextReadResult {
  path: string;
  existed: boolean;
  content: string;
}

let liveDiffProviderDisposable: vscode.Disposable | undefined;
const liveDiffDocuments = new Map<string, LiveDiffDocument>();

interface LiveDiffDocument {
  id: string;
  role: 'current' | 'proposed';
  path: string;
  content: string;
  saveHandled?: boolean;
  toolCallId?: string;
  conversationId?: string;
  onSave?: FsOpenPendingFileChangeDiffOptions['onSave'];
  proposal?: FsPendingFileChangeProposal;
}

/** 函数式 VSCode FS capability 适配器。 */
export function createVsCodeFsCapability(): FsCapability {
  return {
    readFile: (path, startLine, endLine, options) => readWorkspaceTextFile(path, startLine, endLine, options),
    readBinaryFile: (path, mimeType, options) => readWorkspaceBinaryFile(path, mimeType, options),
    writeFile: (path, content, options) => writeWorkspaceTextFile(path, content, options),
    proposeWriteFile: (path, content, options) => proposeWorkspaceTextFileWrite(path, content, options),
    editFile: (request, options) => editWorkspaceTextFile(request, options),
    proposeEditFile: (request, options) => proposeWorkspaceTextFileEdit(request, options),
    applyPendingFileChange: (proposal, options) => applyPendingWorkspaceFileChange(proposal, options),
    openPendingFileChangeDiff: (proposal, options) => openPendingWorkspaceFileChangeDiff(proposal, options),
    closePendingFileChangeDiff: (toolCallId, conversationId) => closePendingWorkspaceFileChangeDiff(toolCallId, conversationId),
    deletePath: (path, options) => deleteWorkspacePath(path, options)
  };
}

export async function readWorkspaceTextFile(relPath: string, startLine?: number, endLine?: number, options: WorkEnvironmentCapabilityOptions = {}): Promise<FsReadFileResult> {
  if (isRemoteServerCommandEnvironment(options.workEnvironment)) {
    return readRemoteServerTextFile(options.workEnvironment, relPath, startLine, endLine, {
      allowOutsideProjectPaths: options.allowOutsideProjectPaths,
      signal: options.signal
    });
  }
  const raw = await readWorkspaceRawTextFile(relPath, MAX_SOURCE_BYTES, options);
  if (!raw.existed) throw new Error(`File not found: ${relPath}`);
  return sliceTextFile(relPath, raw.content, startLine, endLine);
}

export async function readWorkspaceBinaryFile(relPath: string, mimeType: string, options: WorkEnvironmentCapabilityOptions = {}): Promise<FsReadBinaryFileResult> {
  if (isRemoteServerCommandEnvironment(options.workEnvironment)) {
    throw new Error('当前远程工作环境暂不支持二进制附件读取。');
  }

  const normalizedPath = normalizeDisplayPath(relPath);
  if (!normalizedPath) throw new Error('Missing required argument: path');
  const normalizedMimeType = typeof mimeType === 'string' && mimeType.trim() ? mimeType.trim() : 'application/octet-stream';
  const uri = resolveWorkspacePath(normalizedPath, options, 'read');
  const stat = await workspaceFileStat(uri, options.signal);
  if (!stat) throw new Error(`File not found: ${normalizedPath}`);
  if (stat.type !== vscode.FileType.File) throw new Error(`Not a file: ${normalizedPath}`);
  const configuredMaxBytes = Number(options.maxBytes);
  const maxBytes = Number.isSafeInteger(configuredMaxBytes) && configuredMaxBytes > 0
    ? configuredMaxBytes
    : MAX_SOURCE_BYTES;
  if (stat.size > maxBytes) throw new Error(`File too large: ${stat.size} bytes (limit ${maxBytes}).`);
  const data = await readWorkspaceFileBytes(uri, options.signal);
  if (data.byteLength > maxBytes) throw new Error(`File too large: ${data.byteLength} bytes (limit ${maxBytes}).`);
  return {
    path: uri.fsPath || normalizedPath,
    name: path.basename(uri.fsPath || normalizedPath),
    mimeType: normalizedMimeType,
    data: Buffer.from(data).toString('base64'),
    sizeBytes: data.byteLength
  };
}

export async function writeWorkspaceTextFile(relPath: string, content: string, options: WorkEnvironmentCapabilityOptions = {}): Promise<FsWriteFileResult> {
  const result = await proposeWorkspaceTextFileWrite(relPath, content, options);
  if (result.action !== 'unchanged' && result.proposal) await writeWorkspaceRawTextFile(result.path, result.proposal.targetContent, options);
  const { pending: _pending, proposal: _proposal, ...written } = result;
  return written;
}

export async function proposeWorkspaceTextFileWrite(relPath: string, content: string, options: WorkEnvironmentCapabilityOptions = {}): Promise<FsWriteFileResult> {
  const path = normalizeDisplayPath(relPath);
  if (!path) throw new Error('Missing required argument: path');
  if (typeof content !== 'string') throw new Error('Missing required argument: content');

  const before = await readWorkspaceRawTextFile(path, MAX_EDIT_READ_BYTES, options);
  return buildWriteFileResult(path, before, content, true);
}

export async function editWorkspaceTextFile(
  request: FsEditFileRequest,
  options: WorkEnvironmentCapabilityOptions = {}
): Promise<FsEditFileResult> {
  const result = await proposeWorkspaceTextFileEdit(request, options);
  if (result.action !== 'unchanged' && result.proposal) await writeWorkspaceRawTextFile(result.path, result.proposal.targetContent, options);
  const { pending: _pending, proposal: _proposal, ...written } = result;
  return written;
}

export async function proposeWorkspaceTextFileEdit(
  request: FsEditFileRequest,
  options: WorkEnvironmentCapabilityOptions = {}
): Promise<FsEditFileResult> {
  const path = normalizeDisplayPath(request.path);
  if (!path) throw new Error('Missing required argument: path');

  const before = await readWorkspaceRawTextFile(path, MAX_EDIT_READ_BYTES, options);
  if (!before.existed) throw new Error(`File not found: ${path}`);

  const applied =
    request.mode === 'insert' ? applyInsertEdit(before.content, request.insert.line, request.insert.content)
    : request.mode === 'delete' ? applyDeleteEdit(before.content, request.delete.startLine, request.delete.endLine)
    : applyHunkEdit(before.content, request.hunks);

  if (applied.applied <= 0) {
    const firstError = applied.results.find((item) => !item.success)?.error ?? 'No edit operations were applied.';
    throw new Error(`edit(${request.mode}) failed: ${firstError}`);
  }

  const action = applied.newContent === before.content ? 'unchanged' : 'modified';
  const diff = action === 'unchanged' ? undefined : buildFileDiffRecord(path, before.content, applied.newContent, true);
  const change: FsFileChangeRecord = {
    path,
    action,
    added: diff?.added ?? 0,
    removed: diff?.removed ?? 0,
    ...(diff ? { diff } : {})
  };
  return {
    kind: 'file_edit.result',
    mode: request.mode,
    path,
    success: true,
    action,
    totalHunks: applied.totalHunks,
    applied: applied.applied,
    failed: applied.failed,
    ...(applied.fallbackMode ? { fallbackMode: applied.fallbackMode } : {}),
    results: applied.results,
    summary: editSummary(path, request.mode, action, applied.applied, applied.failed, applied.fallbackMode),
    changedFiles: action === 'unchanged' ? [] : [path],
    files: [change],
    ...(action !== 'unchanged'
      ? {
          pending: true,
          proposal: {
            kind: 'file_change.proposal',
            operation: 'edit',
            path,
            baseExisted: true,
            baseContent: before.content,
            targetContent: applied.newContent,
            applyHunks: request.mode === 'hunk' ? request.hunks : buildFileReplacementHunks(before.content, applied.newContent),
            editMode: request.mode,
            editResults: applied.results,
            ...(applied.fallbackMode ? { editFallbackMode: applied.fallbackMode } : {})
          }
        }
      : {})
  };
}

export async function applyPendingWorkspaceFileChange(
  proposal: FsPendingFileChangeProposal,
  options: WorkEnvironmentCapabilityOptions = {}
): Promise<FsWriteFileResult | FsEditFileResult> {
  const preview = await previewPendingWorkspaceFileChange(proposal, options);
  if (preview.action !== 'unchanged') await writeWorkspaceRawTextFile(preview.path, preview.targetContent, options);
  return proposal.operation === 'write'
    ? buildWriteFileResult(preview.path, { path: preview.path, existed: preview.existed, content: preview.currentContent }, preview.targetContent, false)
    : buildEditFileResultFromAppliedProposal(proposal, preview);
}

export async function openPendingWorkspaceFileChangeDiff(
  proposal: FsPendingFileChangeProposal,
  options: FsOpenPendingFileChangeDiffOptions = {}
): Promise<{ status: 'opened' | 'failed'; message: string }> {
  try {
    const preview = await previewPendingWorkspaceFileChange(proposal, options);
    if (preview.action === 'unchanged') return { status: 'failed', message: '当前文件已经包含该变更，无需打开差异。' };
    ensureLiveDiffProviderRegistered();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const leftUri = liveDiffUri({ id, role: 'current', filePath: preview.path, content: preview.currentContent });
    const rightUri = liveDiffUri({
      id,
      role: 'proposed',
      filePath: preview.path,
      content: preview.targetContent,
      proposal,
      toolCallId: options.toolCallId,
      conversationId: options.conversationId,
      onSave: options.onSave
    });
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${preview.path}: 当前 ↔ 提案`, { preview: true });
    return { status: 'opened', message: '已打开实时差异视图。' };
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : '无法打开实时差异视图。' };
  }
}

function buildWriteFileResult(path: string, before: RawTextReadResult, targetContent: string, includeProposal: boolean): FsWriteFileResult {
  const action = before.existed ? (before.content === targetContent ? 'unchanged' : 'modified') : 'created';
  const diff = action === 'unchanged' ? undefined : buildFileDiffRecord(path, before.content, targetContent, before.existed);
  const change: FsFileChangeRecord = {
    path,
    action,
    added: diff?.added ?? 0,
    removed: diff?.removed ?? 0,
    ...(diff ? { diff } : {})
  };
  return {
    kind: 'file_write.result',
    path,
    success: true,
    ...(includeProposal && action !== 'unchanged' ? { pending: true } : {}),
    action,
    summary: writeSummary(path, action),
    changedFiles: action === 'unchanged' ? [] : [path],
    files: [change],
    ...(includeProposal && action !== 'unchanged'
      ? {
          proposal: {
            kind: 'file_change.proposal',
            operation: 'write',
            path,
            baseExisted: before.existed,
            baseContent: before.content,
            targetContent,
            applyHunks: before.existed ? buildFileReplacementHunks(before.content, targetContent) : [],
            writeAction: action
          }
        }
      : {})
  };
}

interface PendingFileChangePreview {
  path: string;
  existed: boolean;
  currentContent: string;
  targetContent: string;
  action: FsFileWriteAction;
  applied?: ReturnType<typeof applyHunkEdit>;
}

async function previewPendingWorkspaceFileChange(
  proposal: FsPendingFileChangeProposal,
  options: WorkEnvironmentCapabilityOptions
): Promise<PendingFileChangePreview> {
  if (!proposal || proposal.kind !== 'file_change.proposal') throw new Error('缺少可应用的文件变更提案。');
  const path = normalizeDisplayPath(proposal.path);
  if (!path) throw new Error('文件变更提案缺少路径。');
  const current = await readWorkspaceRawTextFile(path, MAX_EDIT_READ_BYTES, options);

  if (!current.existed) {
    if (proposal.baseExisted) throw new Error(`文件不存在，无法应用提案：${path}`);
    return {
      path,
      existed: false,
      currentContent: '',
      targetContent: proposal.targetContent,
      action: proposal.targetContent ? 'created' : 'unchanged'
    };
  }

  if (!proposal.baseExisted && proposal.operation === 'write') {
    throw new Error(`文件已存在，无法按“新建文件”提案应用：${path}`);
  }

  const hunks = proposal.applyHunks ?? [];
  if (hunks.length === 0) {
    if (current.content === proposal.targetContent) {
      return { path, existed: true, currentContent: current.content, targetContent: current.content, action: 'unchanged' };
    }
    if (current.content === proposal.baseContent) {
      return { path, existed: true, currentContent: current.content, targetContent: proposal.targetContent, action: 'modified' };
    }
    throw new Error('该变更提案没有可应用的 diff hunk。');
  }

  const applied = applyHunkEdit(current.content, hunks);
  if (applied.failed > 0 || applied.applied <= 0) {
    const firstError = applied.results.find((item) => !item.success)?.error ?? 'diff 内容无法匹配当前文件。';
    throw new Error(`无法应用 ${path} 的变更：${firstError}`);
  }
  return {
    path,
    existed: true,
    currentContent: current.content,
    targetContent: applied.newContent,
    action: applied.newContent === current.content ? 'unchanged' : 'modified',
    applied
  };
}

function buildEditFileResultFromAppliedProposal(
  proposal: FsPendingFileChangeProposal,
  preview: PendingFileChangePreview
): FsEditFileResult {
  const diff = preview.action === 'unchanged' ? undefined : buildFileDiffRecord(preview.path, preview.currentContent, preview.targetContent, true);
  const change: FsFileChangeRecord = {
    path: preview.path,
    action: preview.action === 'created' || preview.action === 'deleted' ? 'modified' : preview.action,
    added: diff?.added ?? 0,
    removed: diff?.removed ?? 0,
    ...(diff ? { diff } : {})
  };
  const applied = preview.applied;
  const appliedCount = applied?.applied ?? (preview.action === 'unchanged' ? 0 : 1);
  const failedCount = applied?.failed ?? 0;
  return {
    kind: 'file_edit.result',
    mode: proposal.editMode ?? 'hunk',
    path: preview.path,
    success: true,
    action: preview.action === 'unchanged' ? 'unchanged' : 'modified',
    totalHunks: applied?.totalHunks ?? proposal.applyHunks.length,
    applied: appliedCount,
    failed: failedCount,
    ...(proposal.editFallbackMode ? { fallbackMode: proposal.editFallbackMode } : {}),
    results: applied?.results ?? proposal.editResults ?? [],
    summary: editSummary(preview.path, proposal.editMode ?? 'hunk', preview.action === 'unchanged' ? 'unchanged' : 'modified', appliedCount, failedCount, proposal.editFallbackMode),
    changedFiles: preview.action === 'unchanged' ? [] : [preview.path],
    files: [change]
  };
}

function ensureLiveDiffProviderRegistered(): vscode.Disposable {
  if (liveDiffProviderDisposable) return liveDiffProviderDisposable;
  const contentProvider = vscode.workspace.registerTextDocumentContentProvider(LIVE_DIFF_SCHEME, {
    provideTextDocumentContent(uri) {
      return liveDiffDocuments.get(uri.toString())?.content ?? '';
    }
  });
  const applyCommand = vscode.commands.registerCommand(LIVE_DIFF_APPLY_COMMAND, () => {
    void applyLiveDiffPreviewFromActiveEditor();
  });
  liveDiffProviderDisposable = vscode.Disposable.from(contentProvider, applyCommand);
  return liveDiffProviderDisposable;
}

interface LiveDiffUriInput {
  id: string;
  role: LiveDiffDocument['role'];
  filePath: string;
  content: string;
  proposal?: FsPendingFileChangeProposal;
  toolCallId?: string;
  conversationId?: string;
  onSave?: FsOpenPendingFileChangeDiffOptions['onSave'];
}

function liveDiffUri(input: LiveDiffUriInput): vscode.Uri {
  const uri = vscode.Uri.from({
    scheme: LIVE_DIFF_SCHEME,
    authority: 'file-change',
    path: `/${normalizeDisplayPath(input.filePath) || 'file'}`,
    query: new URLSearchParams({ id: input.id, role: input.role }).toString()
  });
  const key = uri.toString();
  liveDiffDocuments.set(key, {
    id: input.id,
    role: input.role,
    path: normalizeDisplayPath(input.filePath) || input.filePath,
    content: input.content,
    ...(input.proposal ? { proposal: input.proposal } : {}),
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.onSave ? { onSave: input.onSave } : {})
  });
  setTimeout(() => liveDiffDocuments.delete(key), LIVE_DIFF_DOCUMENT_TTL_MS).unref?.();
  return uri;
}

async function applyLiveDiffPreviewFromActiveEditor(): Promise<void> {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (!activeUri || activeUri.scheme !== LIVE_DIFF_SCHEME) {
    await vscode.commands.executeCommand('workbench.action.files.save');
    return;
  }

  const document = liveDiffDocumentForApply(activeUri);
  if (!document?.proposal || !document.onSave) {
    void vscode.window.showWarningMessage(`${EXTENSION_BRAND} 当前差异预览没有可应用的文件变更。`);
    return;
  }
  if (document.saveHandled) return;
  document.saveHandled = true;

  await document.onSave({
    toolCallId: document.toolCallId,
    conversationId: document.conversationId,
    path: document.path,
    proposal: document.proposal
  });
  await closePendingWorkspaceFileChangeDiff(document.toolCallId, document.conversationId);
}

function liveDiffDocumentForApply(uri: vscode.Uri): LiveDiffDocument | undefined {
  const document = liveDiffDocuments.get(uri.toString());
  if (!document) return undefined;
  if (document.role === 'proposed') return document;
  return [...liveDiffDocuments.values()].find((candidate) => candidate.id === document.id && candidate.role === 'proposed');
}

export async function closePendingWorkspaceFileChangeDiff(toolCallId?: string, conversationId?: string): Promise<void> {
  const documents = liveDiffDocumentsForToolCall(toolCallId, conversationId);
  const uriKeys = new Set(documents.map((item) => item.uri.toString()));
  const tabsToClose: vscode.Tab[] = [];
  const shouldRevealConversation = activeTabMatchesLiveDiff(uriKeys);

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tabMatchesLiveDiff(tab, uriKeys)) tabsToClose.push(tab);
    }
  }

  if (tabsToClose.length > 0) {
    await vscode.window.tabGroups.close(tabsToClose, true);
  } else if (vscode.window.activeTextEditor?.document.uri.scheme === LIVE_DIFF_SCHEME) {
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  }

  if (shouldRevealConversation) {
    await vscode.commands.executeCommand(EXTENSION_COMMAND_IDS.openPanel, {
      ...(conversationId ? { conversationId, reuse: true } : {})
    });
  }
}

function liveDiffDocumentsForToolCall(toolCallId?: string, conversationId?: string): Array<{ uri: vscode.Uri; document: LiveDiffDocument }> {
  const entries = [...liveDiffDocuments.entries()]
    .map(([key, document]) => ({ uri: vscode.Uri.parse(key), document }));
  const proposed = entries.filter(({ document }) => {
    if (toolCallId && document.toolCallId === toolCallId) return true;
    return !toolCallId && conversationId !== undefined && document.conversationId === conversationId;
  });
  const ids = new Set(proposed.map(({ document }) => document.id));
  return entries.filter(({ document }) => ids.has(document.id));
}

function tabMatchesLiveDiff(tab: vscode.Tab, uriKeys: Set<string>): boolean {
  const input = tab.input;
  if (input instanceof vscode.TabInputTextDiff) {
    return uriKeys.has(input.original.toString()) || uriKeys.has(input.modified.toString());
  }
  if (input instanceof vscode.TabInputText) {
    return uriKeys.has(input.uri.toString());
  }
  return false;
}

function activeTabMatchesLiveDiff(uriKeys: Set<string>): boolean {
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (activeTab && tabMatchesLiveDiff(activeTab, uriKeys)) return true;
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  return !!activeUri && uriKeys.has(activeUri.toString());
}

export async function deleteWorkspacePath(relPath: string, options: WorkEnvironmentCapabilityOptions = {}): Promise<FsDeletePathResult> {
  const targetPath = normalizePathArg(relPath);
  if (!targetPath) throw new Error('Missing required argument: path');

  if (isRemoteServerCommandEnvironment(options.workEnvironment)) {
    const deleted = await deleteRemoteServerPath(options.workEnvironment, targetPath, { allowOutsideProjectPaths: options.allowOutsideProjectPaths });
    return deleteResult(targetPath, deleted.path, deleted.targetType);
  }

  const uri = resolveWorkspacePath(targetPath, options, 'write', { rejectProjectRoot: true });
  const stat = await workspaceFileStat(uri);
  if (!stat) throw new Error(`Path not found: ${targetPath}`);
  const targetType = fileTypeFromStat(stat, targetPath);
  assertSafeLocalDeleteTarget(uri, allowedLocalRootUris(options));
  await vscode.workspace.fs.delete(uri, { recursive: true });
  return deleteResult(targetPath, uri.fsPath || targetPath, targetType);
}

function deleteResult(inputPath: string, resolvedPath: string, targetType: FsDeletePathTargetType): FsDeletePathResult {
  return {
    inputPath,
    path: resolvedPath,
    targetType
  };
}


async function readWorkspaceRawTextFile(relPath: string, maxBytes: number, options: WorkEnvironmentCapabilityOptions): Promise<RawTextReadResult> {
  if (isRemoteServerCommandEnvironment(options.workEnvironment)) {
    try {
      const content = await readRemoteServerRawTextFile(options.workEnvironment, relPath, maxBytes, {
        allowOutsideProjectPaths: options.allowOutsideProjectPaths,
        signal: options.signal
      });
      return { path: relPath, existed: true, content };
    } catch (error) {
      if (error instanceof RemoteFileNotFoundError) return { path: relPath, existed: false, content: '' };
      throw error;
    }
  }

  const uri = resolveWorkspacePath(relPath, options, 'read');
  const stat = await workspaceFileStat(uri, options.signal);
  if (!stat) return { path: relPath, existed: false, content: '' };
  if (stat.type !== vscode.FileType.File) throw new Error(`Not a file: ${relPath}`);
  if (stat.size > maxBytes) throw new Error(`File too large: ${stat.size} bytes (limit ${maxBytes}).`);
  const data = await readWorkspaceFileBytes(uri, options.signal);
  return { path: relPath, existed: true, content: Buffer.from(data).toString('utf8') };
}

async function workspaceFileStat(uri: vscode.Uri, signal?: AbortSignal): Promise<vscode.FileStat | undefined> {
  try {
    if (isNodeFsWorkspaceUri(uri)) {
      const stat = await abortableFsCall(fs.stat(uri.fsPath), signal);
      return {
        type: stat.isFile()
          ? vscode.FileType.File
          : stat.isDirectory()
            ? vscode.FileType.Directory
            : vscode.FileType.Unknown,
        ctime: stat.ctimeMs,
        mtime: stat.mtimeMs,
        size: stat.size
      };
    }
    return await abortableFsCall(vscode.workspace.fs.stat(uri), signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return undefined;
  }
}

function readWorkspaceFileBytes(uri: vscode.Uri, signal?: AbortSignal): Promise<Uint8Array> {
  // Reliable turns intentionally keep running while a renderer reconnects. Local workspace reads
  // therefore cannot depend on vscode.workspace.fs RPC, which may remain pending on the detached
  // Extension Host even though its Node process and execution lease are still healthy.
  if (isNodeFsWorkspaceUri(uri)) {
    return abortableFsCall(fs.readFile(uri.fsPath), signal);
  }
  return abortableFsCall(vscode.workspace.fs.readFile(uri), signal);
}

function isNodeFsWorkspaceUri(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && !!uri.fsPath && path.isAbsolute(uri.fsPath);
}

function abortableFsCall<T>(operation: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(operation);
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('File operation cancelled.'));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error('File operation cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

async function writeWorkspaceRawTextFile(relPath: string, content: string, options: WorkEnvironmentCapabilityOptions): Promise<void> {
  if (isRemoteServerCommandEnvironment(options.workEnvironment)) {
    await writeRemoteServerTextFile(options.workEnvironment, relPath, content, { allowOutsideProjectPaths: options.allowOutsideProjectPaths });
    return;
  }

  const uri = resolveWorkspacePath(relPath, options, 'write');
  await vscode.workspace.fs.createDirectory(dirnameUri(uri));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}



interface WorkspacePathResolveOptions {
  rejectProjectRoot?: boolean;
}

function resolveWorkspacePath(
  relPath: string,
  options: WorkEnvironmentCapabilityOptions,
  mode: 'read' | 'write',
  resolveOptions: WorkspacePathResolveOptions = {}
): vscode.Uri {
  const workEnvironment = options.workEnvironment;
  if (workEnvironment?.available === false) {
    throw new Error(`当前工作环境不可用：${workEnvironmentDisplayName(workEnvironment)}`);
  }
  if (workEnvironment && mode === 'read' && !workEnvironmentSupportsCapability(workEnvironment, WORK_ENVIRONMENT_CAPABILITY.LocalFileRead)) {
    throw new Error(`当前工作环境暂不支持本地文件读取：${workEnvironmentDisplayName(workEnvironment)} (${workEnvironment.kind})`);
  }
  if (workEnvironment && mode === 'write' && !workEnvironmentSupportsCapability(workEnvironment, WORK_ENVIRONMENT_CAPABILITY.FileTransferWrite)) {
    throw new Error(`当前工作环境暂不支持本地文件写入：${workEnvironmentDisplayName(workEnvironment)} (${workEnvironment.kind})`);
  }

  const targetPath = normalizePathArg(relPath);
  if (!targetPath) throw new Error('Missing required argument: path');
  const root = projectRootUri(options);
  const isAbsolute = isAbsoluteLocalPath(targetPath);
  if (!isAbsolute && !root && resolveOptions.rejectProjectRoot === true) {
    throw new Error(`当前工作区缺少项目根目录，无法解析相对删除路径：${targetPath}`);
  }
  const uri = isAbsolute
    ? vscode.Uri.file(targetPath)
    : root
      ? vscode.Uri.file(path.resolve(root.fsPath, relativeLocalPath(targetPath)))
      : vscode.Uri.file(targetPath);

  if (options.allowOutsideProjectPaths === false) {
    const roots = allowedLocalRootUris(options);
    if (roots.length === 0) throw new Error('当前工作区缺少项目根目录，无法限制项目外路径。');
    assertLocalPathInsideAnyRoot(uri, roots);
  }
  if (resolveOptions.rejectProjectRoot === true) assertSafeLocalDeleteTarget(uri, allowedLocalRootUris(options));
  return uri;
}

function projectRootUri(options: WorkEnvironmentCapabilityOptions): vscode.Uri | undefined {
  const workEnvironment = options.workEnvironment;
  if (workEnvironment && workEnvironmentSupportsCapability(workEnvironment, WORK_ENVIRONMENT_CAPABILITY.LocalFileRead)) {
    const root = currentLocalRootUriFromWorkEnvironment(workEnvironment);
    if (root) return root;
  }
  return currentWorkspaceFolderRootUris()[0];
}

function allowedLocalRootUris(options: WorkEnvironmentCapabilityOptions): vscode.Uri[] {
  const roots: vscode.Uri[] = [];
  const add = (uri: vscode.Uri | undefined): void => {
    if (!uri?.fsPath) return;
    if (roots.some((existing) => sameLocalPath(existing.fsPath, uri.fsPath))) return;
    roots.push(uri);
  };

  const workspaceRoots = currentWorkspaceFolderRootUris();
  add(projectRootUri(options));
  for (const root of workspaceRoots) add(root);
  for (const environment of options.accessibleWorkEnvironments ?? []) {
    if (!environment.available || !isLocalFolderWorkEnvironment(environment)) continue;
    add(currentLocalRootUriFromWorkEnvironment(environment, workspaceRoots));
  }

  return roots;
}

function currentWorkspaceFolderRootUris(): vscode.Uri[] {
  const roots: vscode.Uri[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const uri = folder.uri;
    if (!uri?.fsPath) continue;
    if (roots.some((existing) => sameLocalPath(existing.fsPath, uri.fsPath))) continue;
    roots.push(uri);
  }
  return roots;
}

function currentLocalRootUriFromWorkEnvironment(
  environment: WorkEnvironmentCapabilityOptions['workEnvironment'],
  workspaceRoots: readonly vscode.Uri[] = currentWorkspaceFolderRootUris()
): vscode.Uri | undefined {
  const uri = localRootUriFromWorkEnvironment(environment);
  if (!uri) return undefined;
  // localFolder 环境由 VS Code workspace folder 自动同步。这里在真正解析/校验路径时
  // 再读取当前 workspaceFolders，避免新增 root 依赖 ECS 同步时序，也避免已移除 root
  // 因旧的 workEnvironment 快照仍被当作可访问根目录。
  if (
    environment
    && isLocalFolderWorkEnvironment(environment)
    && !workspaceRoots.some((root) => sameLocalPath(root.fsPath, uri.fsPath))
  ) {
    return undefined;
  }
  return uri;
}

function localRootUriFromWorkEnvironment(environment: WorkEnvironmentCapabilityOptions['workEnvironment']): vscode.Uri | undefined {
  if (!environment) return undefined;
  const rootPath = normalizePathArg(environment.rootPath);
  if (rootPath) return vscode.Uri.file(rootPath);
  return uriFromWorkEnvironmentUri(environment.uri);
}

function uriFromWorkEnvironmentUri(value: string | undefined): vscode.Uri | undefined {
  const text = normalizePathArg(value);
  if (!text) return undefined;
  try {
    return text.startsWith('file:') ? vscode.Uri.parse(text) : vscode.Uri.file(text);
  } catch {
    return undefined;
  }
}

function isAbsoluteLocalPath(input: string): boolean {
  return path.isAbsolute(input) || path.win32.isAbsolute(input) || path.posix.isAbsolute(input);
}

function relativeLocalPath(input: string): string {
  return input.replace(/[\\/]+/g, path.sep);
}

function assertLocalPathInsideAnyRoot(uri: vscode.Uri, roots: readonly vscode.Uri[]): void {
  const matched = roots.some((root) => localPathInsideRoot(uri, root));
  if (matched) return;
  const rootText = roots.map((root) => root.fsPath).join('；');
  throw new Error(`路径超出当前项目/工作环境根目录：${uri.fsPath}（roots=${rootText}）`);
}

function localPathInsideRoot(uri: vscode.Uri, root: vscode.Uri): boolean {
  const candidate = canonicalLocalPath(uri.fsPath);
  const rootPath = canonicalLocalPath(root.fsPath);
  const relative = path.relative(rootPath, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalLocalPath(input: string): string {
  const normalized = path.resolve(input);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sameLocalPath(left: string, right: string): boolean {
  return canonicalLocalPath(left) === canonicalLocalPath(right);
}

function assertSafeLocalDeleteTarget(uri: vscode.Uri, protectedRoots: readonly vscode.Uri[] | vscode.Uri | undefined): void {
  const target = path.resolve(uri.fsPath);
  const filesystemRoot = path.parse(target).root;
  if (!target || sameLocalPath(target, filesystemRoot)) throw new Error('拒绝删除本地文件系统根目录。');
  const roots = Array.isArray(protectedRoots) ? protectedRoots : protectedRoots ? [protectedRoots] : [];
  for (const root of roots) {
    if (sameLocalPath(target, root.fsPath)) throw new Error(`拒绝删除当前项目/工作环境根目录：${target}`);
  }
}

function fileTypeFromStat(stat: vscode.FileStat, targetPath: string): FsDeletePathTargetType {
  if ((stat.type & vscode.FileType.Directory) !== 0) return 'directory';
  if ((stat.type & vscode.FileType.File) !== 0 || (stat.type & vscode.FileType.SymbolicLink) !== 0) return 'file';
  throw new Error(`Unsupported path type: ${targetPath}`);
}

function dirnameUri(uri: vscode.Uri): vscode.Uri {
  const parts = uri.path.split('/');
  parts.pop();
  const dirPath = parts.join('/') || '/';
  return uri.with({ path: dirPath });
}

function normalizePathArg(path: string | undefined): string {
  return typeof path === 'string' ? path.trim() : '';
}

function normalizeDisplayPath(path: string | undefined): string {
  return typeof path === 'string' ? path.trim().replace(/\\+/g, '/') : '';
}

function writeSummary(path: string, action: FsWriteFileResult['action']): string {
  if (action === 'created') return `已创建 ${path}`;
  if (action === 'modified') return `已写入 ${path}`;
  if (action === 'deleted') return `已删除 ${path}`;
  return `${path} 内容未变化`;
}

function editSummary(path: string, mode: FsEditFileRequest['mode'], action: FsEditFileResult['action'], applied: number, failed: number, fallbackMode: string | undefined): string {
  if (action === 'unchanged') return `${path} 内容未变化`;
  const fallback = fallbackMode ? `，fallback=${fallbackMode}` : '';
  return `已用 ${mode} 模式修改 ${path}（成功 ${applied} 个操作，失败 ${failed} 个${fallback}）`;
}
