import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { createVscodeStoragePaths } from '../capabilities/vscodeStorage/paths';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import { isPathInside } from '../capabilities/filesystem/pathContainment';
import { RUNTIME_KERNEL_EPOCH, createRuntimeRootPaths } from './contracts';
import { RootAuthority, parseHistoricalRootBinding, type HistoricalRootBinding } from './rootAuthority';
import { assertRuntimeHostsOffline, runtimeHostLivenessDirectory, withRuntimeDataRootAdmission } from './runtimeHostControl';
import { CUTOVER_JOURNAL_FILE, physicalCutoverRecoveryRequired } from './physicalCutover';

type VscodeStoragePaths = ReturnType<typeof createVscodeStoragePaths>;

export const VSCODE_RUNTIME_CONTROL_DIRECTORY = '.limcode-runtime';
export const VSCODE_RUNTIME_ACTIVE_DIRECTORY = 'active';
export const VSCODE_WORKSPACE_RUNTIMES_DIRECTORY = '.limcode-workspace-runtimes';
export const VSCODE_WORKSPACE_RUNTIME_SCOPES_DIRECTORY = 'scopes';
export const VSCODE_RUNTIME_SELECTION_FILE = '.limcode-runtime-selection.json';

const WORKSPACE_RUNTIME_ID_DOMAIN = 'limcode-vscode-workspace-runtime\0';
const RUNTIME_SELECTION_KIND = 'limcode-runtime-selection';

export type VscodeWorkspaceRuntimeScopeKind =
  | 'workspace-file'
  | 'folder'
  | 'folder-set'
  | 'empty';

export interface VscodeWorkspaceRuntimeScopeInput {
  workspaceFileUri?: string;
  workspaceFolderUris?: readonly string[];
}

export interface VscodeWorkspaceRuntimeScope {
  kind: VscodeWorkspaceRuntimeScopeKind;
  /** Workspace identity only; it never chooses the active Runtime data set. */
  key: string;
  /** Human-inspectable workspace identity. */
  identity: string;
}

export interface VscodeWorkspaceRuntimePlacement {
  scope: VscodeWorkspaceRuntimeScope;
  /** Shared configuration root selected by globalStatus. */
  configurationRootPath: string;
  /** Complete selected root passed to the cutover/reset coordinator. */
  runtimeScopeRootPath: string;
  /** Immutable SQLite/CAS root consumed by RootAuthority. */
  runtimeDataRootPath: string;
  usesLegacyRuntime: boolean;
}

export interface VscodeRuntimeDataSetCandidate {
  id: string;
  configurationRootPath: string;
  runtimeScopeRootPath: string;
  runtimeDataRootPath: string;
  dataSetId?: string;
  rootInstanceId?: string;
  runtimeKernelEpoch?: number;
  selected: boolean;
  source: 'fixed' | 'legacy' | 'workspace';
  /** A recognized interrupted physical cutover must finish before opening this root. */
  requiresRecovery?: true;
}

export interface VscodeRuntimeDataSetProblem {
  id: string;
  runtimeScopeRootPath: string;
  message: string;
}

export interface VscodeRuntimeDataSetInspection {
  candidates: VscodeRuntimeDataSetCandidate[];
  problems: VscodeRuntimeDataSetProblem[];
}

interface RuntimeDataSetSelection {
  kind: typeof RUNTIME_SELECTION_KIND;
  id: string;
  initialized: boolean;
  selectionRevision: number;
  selectedAt: string;
}

export class VscodeRuntimeDataSetSelectionRequiredError extends Error {
  public readonly code = 'runtime-dataset-selection-required';

  public constructor(
    public readonly candidates: readonly VscodeRuntimeDataSetCandidate[],
    public readonly problems: readonly VscodeRuntimeDataSetProblem[] = []
  ) {
    super(problems.length
      ? '发现无法使用的历史库，请查看原因并明确选择可用数据集；不会自动跳过异常库或创建空库。'
      : '发现多个已有运行数据集，请先选择当前数据集；工作区文件夹不会自动决定使用哪个数据库。');
    this.name = 'VscodeRuntimeDataSetSelectionRequiredError';
  }
}

export class VscodeRuntimeDataSetError extends Error {
  public readonly code = 'runtime-dataset-invalid';

  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'VscodeRuntimeDataSetError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

/**
 * Resolves workspace context and the names of historical scope roots. Saved workspace files
 * take precedence; untitled workspaces use their sorted folder set. This identity no longer
 * selects Runtime data. Names and active editors never participate in identity.
 */
export function resolveVscodeWorkspaceRuntimeScope(
  input: VscodeWorkspaceRuntimeScopeInput
): VscodeWorkspaceRuntimeScope {
  const workspaceFileUri = normalizeUri(input.workspaceFileUri);
  const stableWorkspaceFileUri = /^untitled:/i.test(workspaceFileUri) ? '' : workspaceFileUri;
  const folderUris = [...new Set((input.workspaceFolderUris ?? []).map(normalizeUri).filter(isText))].sort();
  let kind: VscodeWorkspaceRuntimeScopeKind;
  let identity: string;
  if (stableWorkspaceFileUri) {
    kind = 'workspace-file';
    identity = stableWorkspaceFileUri;
  } else if (folderUris.length === 1) {
    kind = 'folder';
    identity = folderUris[0];
  } else if (folderUris.length > 1) {
    kind = 'folder-set';
    identity = JSON.stringify(folderUris);
  } else {
    kind = 'empty';
    identity = 'empty';
  }
  const digest = createHash('sha256')
    .update(WORKSPACE_RUNTIME_ID_DOMAIN)
    .update(kind)
    .update('\0')
    .update(identity)
    .digest('hex');
  return Object.freeze({ kind, key: `${kind}-${digest}`, identity });
}

/**
 * Runtime 数据根必须位于扩展自己的 settings/data root 内，不能把 RootBinding 指针写到
 * `globalStoragePath` 的共享父目录。配置 authority 仍留在 settings root，与 Runtime SQLite 解耦。
 */
export function resolveVscodeRuntimeDataRoot(paths: Pick<VscodeStoragePaths, 'globalStoragePath'>): string {
  return path.join(
    path.resolve(paths.globalStoragePath),
    VSCODE_RUNTIME_CONTROL_DIRECTORY,
    VSCODE_RUNTIME_ACTIVE_DIRECTORY
  );
}

/** Location of an existing historical workspace scope; new roots use the fixed default root. */
export function resolveVscodeWorkspaceRuntimeScopeRoot(
  paths: Pick<VscodeStoragePaths, 'globalStoragePath'>,
  scope: Pick<VscodeWorkspaceRuntimeScope, 'key'>
): string {
  return path.join(
    path.resolve(paths.globalStoragePath),
    VSCODE_WORKSPACE_RUNTIMES_DIRECTORY,
    VSCODE_WORKSPACE_RUNTIME_SCOPES_DIRECTORY,
    scope.key
  );
}

export function resolveVscodeRuntimeSelectionPath(
  paths: Pick<VscodeStoragePaths, 'globalStoragePath'>
): string {
  return path.join(path.resolve(paths.globalStoragePath), VSCODE_RUNTIME_SELECTION_FILE);
}

/**
 * A configuration root has one fixed Runtime selection. The workspace is retained as execution
 * context only. Existing roots stay in place, including their fenced RootBinding and CAS paths.
 * Callers hold the same admission through preparation and Host registration; this inner claim
 * also protects standalone callers. The normal selected-root path never enumerates old scopes.
 */
export async function resolveVscodeWorkspaceRuntimePlacement(
  paths: Pick<VscodeStoragePaths, 'globalStoragePath'>,
  scope: VscodeWorkspaceRuntimeScope
): Promise<VscodeWorkspaceRuntimePlacement> {
  const configurationRootPath = path.resolve(paths.globalStoragePath);
  return withRuntimeDataRootAdmission(configurationRootPath, async () => {
    const selection = await readRuntimeDataSetSelection(configurationRootPath);
    let candidate: VscodeRuntimeDataSetCandidate;
    if (selection) {
      candidate = await inspectCandidate(configurationRootPath, selection.id, selection, !selection.initialized);
    } else {
      const { candidates, problems } = await inspectCandidates(configurationRootPath);
      if (problems.length && candidates.length === 0) {
        throw new VscodeRuntimeDataSetError(
          `已有运行数据集均无法使用，原数据保持不变：\n${problems.map(problem => problem.message).join('\n')}`
        );
      }
      if (candidates.length > 1 || problems.length) {
        throw new VscodeRuntimeDataSetSelectionRequiredError(candidates, problems);
      }
      candidate = candidates[0] ?? await inspectCandidate(configurationRootPath, 'default', undefined, true);
      await assertConfigurationRootRuntimesOffline(configurationRootPath);
      await publishSelection(configurationRootPath, candidate.id, Boolean(candidate.dataSetId));
    }
    return Object.freeze({
      scope,
      configurationRootPath,
      runtimeScopeRootPath: candidate.runtimeScopeRootPath,
      runtimeDataRootPath: candidate.runtimeDataRootPath,
      usesLegacyRuntime: candidate.runtimeScopeRootPath === configurationRootPath
    });
  });
}

/** Explicit read-only enumeration for selection/history/storage tools; startup does not use it once selected. */
export async function listVscodeRuntimeDataSets(
  paths: Pick<VscodeStoragePaths, 'globalStoragePath'>
): Promise<VscodeRuntimeDataSetCandidate[]> {
  const root = path.resolve(paths.globalStoragePath);
  return enumerateCandidates(root, await readRuntimeDataSetSelection(root));
}

/** Read-only inventory for recovery UI; unavailable roots remain explicit, unselectable problems. */
export async function inspectVscodeRuntimeDataSets(
  paths: Pick<VscodeStoragePaths, 'globalStoragePath'>
): Promise<VscodeRuntimeDataSetInspection> {
  const root = path.resolve(paths.globalStoragePath);
  return inspectCandidates(root, await readRuntimeDataSetSelection(root));
}

/** Resolves an opaque candidate id without accepting arbitrary filesystem paths. */
export async function resolveVscodeRuntimeDataSet(
  paths: Pick<VscodeStoragePaths, 'globalStoragePath'>,
  id: string
): Promise<VscodeRuntimeDataSetCandidate> {
  const root = path.resolve(paths.globalStoragePath);
  const selection = await readRuntimeDataSetSelection(root);
  return inspectCandidate(root, id, selection, selection?.id === id && !selection.initialized);
}

/** Offline-only selection; every root in the configuration root must have no live/unknown Host. */
export async function selectVscodeRuntimeDataSet(
  paths: Pick<VscodeStoragePaths, 'globalStoragePath'>,
  id: string
): Promise<VscodeRuntimeDataSetCandidate> {
  const root = path.resolve(paths.globalStoragePath);
  return withRuntimeDataRootAdmission(root, async () => {
    const previous = await readRuntimeDataSetSelection(root);
    const candidate = await inspectCandidate(root, id, previous, previous?.id === id && !previous.initialized);
    if (previous?.id === id) return candidate;
    await assertConfigurationRootRuntimesOffline(root);
    await publishSelection(root, id, true, previous);
    return Object.freeze({ ...candidate, selected: true });
  });
}

/** Seal the fresh-root reservation after ensureCurrentRoot succeeds, before the Host opens. */
export async function completeVscodeRuntimeDataSetSelection(
  paths: Pick<VscodeStoragePaths, 'globalStoragePath'>
): Promise<void> {
  const root = path.resolve(paths.globalStoragePath);
  await withRuntimeDataRootAdmission(root, async () => {
    const selection = await readRuntimeDataSetSelection(root);
    if (!selection) throw new VscodeRuntimeDataSetError('当前运行数据集选择不存在。');
    const candidate = await inspectCandidate(root, selection.id, selection, false);
    if (candidate.requiresRecovery) throw new VscodeRuntimeDataSetError('运行数据集必须先完成现有cutover恢复。');
    if (!selection.initialized) await publishSelection(root, selection.id, true, selection);
  });
}

/** Builds RootAuthority from the immutable placement captured for this Extension Host activation. */
export function createVscodeRootAuthority(
  placement: Pick<VscodeWorkspaceRuntimePlacement, 'runtimeDataRootPath' | 'configurationRootPath'>
): RootAuthority {
  const runtimeDataRootPath = path.resolve(placement.runtimeDataRootPath);
  const configurationRootPath = path.resolve(placement.configurationRootPath);
  return new RootAuthority(() => runtimeDataRootPath, undefined, () => configurationRootPath);
}

/**
 * Offline assertion spanning every Runtime root contained in one configuration data root: the
 * legacy root and each workspace scope root. The legacy physical cutover filters/deletes shared
 * configuration records outside its own Runtime control tree, so checking only its own Host
 * liveness is not enough. Call only while holding the configuration-root admission
 * (RootAuthority.withRuntimeHostAdmission); the admission serializes the enumeration against new
 * scope registration. A scoped (non-configuration) root simply enumerates itself.
 */
export async function assertConfigurationRootRuntimesOffline(
  configurationRootPath: string,
  exceptHostBootId?: string
): Promise<void> {
  const configurationRoot = path.resolve(configurationRootPath);
  const defaultPaths = createRuntimeRootPaths(resolveVscodeRuntimeDataRoot({ globalStoragePath: configurationRoot }));
  await assertSafeRootPath(configurationRoot, runtimeHostLivenessDirectory(defaultPaths));
  await assertRuntimeHostsOffline(
    defaultPaths,
    exceptHostBootId
  );
  const scopesRoot = path.join(
    configurationRoot,
    VSCODE_WORKSPACE_RUNTIMES_DIRECTORY,
    VSCODE_WORKSPACE_RUNTIME_SCOPES_DIRECTORY
  );
  await assertSafeRootPath(configurationRoot, scopesRoot);
  for (const scopeKey of await directoryEntryNames(scopesRoot)) {
    const scopeRoot = path.join(scopesRoot, scopeKey);
    const info = await fs.lstat(scopeRoot);
    // A regular file cannot contain a Runtime Host. Keep it in the diagnostic inventory, but
    // never append a host-liveness path to it. Links and unknown filesystem kinds prove nothing.
    if (info.isFile()) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new VscodeRuntimeDataSetError(`运行数据集路径包含链接或无效目录：${scopeRoot}`);
    }
    const runtimePaths = createRuntimeRootPaths(resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot }));
    await assertSafeRootPath(configurationRoot, runtimeHostLivenessDirectory(runtimePaths));
    await assertRuntimeHostsOffline(
      runtimePaths,
      exceptHostBootId
    );
  }
}

async function enumerateCandidates(
  configurationRootPath: string,
  selection?: RuntimeDataSetSelection
): Promise<VscodeRuntimeDataSetCandidate[]> {
  return (await inspectCandidates(configurationRootPath, selection, true)).candidates;
}

async function inspectCandidates(
  configurationRootPath: string,
  selection?: RuntimeDataSetSelection,
  strict = false
): Promise<VscodeRuntimeDataSetInspection> {
  const result: VscodeRuntimeDataSetInspection = { candidates: [], problems: [] };
  const entries: Array<{ id: string; runtimeScopeRootPath: string }> = [];
  const recordProblem = (id: string, runtimeScopeRootPath: string, error: unknown): void => {
    if (strict) throw error;
    result.problems.push({ id, runtimeScopeRootPath, message: error instanceof Error ? error.message : String(error) });
  };
  const defaultControl = path.join(configurationRootPath, VSCODE_RUNTIME_CONTROL_DIRECTORY);
  try {
    await assertSafeRootPath(configurationRootPath, defaultControl);
    if (await hasRuntimeArtifacts(defaultControl) || selection?.id === 'default') {
      entries.push({ id: 'default', runtimeScopeRootPath: configurationRootPath });
    }
  } catch (error) {
    recordProblem('default', configurationRootPath, error);
  }
  const scopesRoot = path.join(configurationRootPath, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY, VSCODE_WORKSPACE_RUNTIME_SCOPES_DIRECTORY);
  try {
    await assertSafeRootPath(configurationRootPath, scopesRoot);
    for (const key of (await directoryEntryNames(scopesRoot)).sort()) {
      entries.push({ id: `workspace:${key}`, runtimeScopeRootPath: path.join(scopesRoot, key) });
    }
  } catch (error) {
    // This identifies the unreadable container for display only; it is never a candidate id.
    recordProblem('workspace-scopes', scopesRoot, error);
  }
  if (selection && !entries.some(entry => entry.id === selection.id)
    && !result.problems.some(problem => problem.id === selection.id)) {
    entries.push({ id: selection.id, runtimeScopeRootPath: runtimeScopeRootForId(configurationRootPath, selection.id) });
  }
  for (const { id, runtimeScopeRootPath } of entries) {
    try {
      result.candidates.push(await inspectCandidate(
        configurationRootPath, id, selection, selection?.id === id && !selection.initialized
      ));
    } catch (error) {
      recordProblem(id, runtimeScopeRootPath, error);
    }
  }
  return result;
}

async function inspectCandidate(
  configurationRootPath: string,
  id: string,
  selection?: RuntimeDataSetSelection,
  allowEmpty = false
): Promise<VscodeRuntimeDataSetCandidate> {
  const runtimeScopeRootPath = runtimeScopeRootForId(configurationRootPath, id);
  const runtimeDataRootPath = resolveVscodeRuntimeDataRoot({ globalStoragePath: runtimeScopeRootPath });
  const expected = createRuntimeRootPaths(runtimeDataRootPath);
  await assertSafeRootPath(configurationRootPath, expected.dataRootPath);
  for (const filePath of [expected.rootPointerPath, expected.rootPendingPath, expected.databasePath, expected.casRootPath, expected.runtimeEpochPath]) {
    await assertSafeRootPath(configurationRootPath, filePath);
  }
  // Historical/pending pointers are inspected, never activated here. Exact epoch migration and
  // completed-pending recovery remain the responsibility of the existing offline startup gate.
  let binding: HistoricalRootBinding | undefined;
  let pending: HistoricalRootBinding | undefined;
  let requiresRecovery = false;
  try {
    const pointer = await readOptionalJson(expected.rootPointerPath);
    const pendingValue = await readOptionalJson(expected.rootPendingPath);
    if (pendingValue !== undefined) pending = parseHistoricalRootBinding(pendingValue);
    binding = pointer === undefined ? pending : parseHistoricalRootBinding(pointer);
  } catch (error) {
    throw new VscodeRuntimeDataSetError(`运行数据集 RootBinding 无效：${expected.rootPointerPath}`, error);
  }
  if (binding) {
    for (const candidateBinding of pending ? [binding, pending] : [binding]) {
      for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
        if (candidateBinding.paths[key] !== expected[key]) {
          throw new VscodeRuntimeDataSetError(`运行数据集路径与原 RootBinding 不一致：${expected.rootPointerPath}`);
        }
      }
    }
    try {
      await requirePathKind(expected.databasePath, 'file');
      await requirePathKind(expected.casRootPath, 'directory');
      await requirePathKind(expected.runtimeEpochPath, 'file');
      await validateCandidateEpoch(binding, pending);
    } catch (error) {
      // Physical cutover archives active before replacing it. Only its existing, matching
      // journal and archived active tree justify deferring completeness to the recovery gate.
      if (!await hasRecoverableArchivedActive(configurationRootPath, runtimeScopeRootPath, binding)) throw error;
      requiresRecovery = true;
    }
  } else if (!allowEmpty || await hasRuntimeArtifacts(path.dirname(expected.dataRootPath))) {
    throw new VscodeRuntimeDataSetError(`运行数据集缺少完整 RootBinding，不能当作新数据集初始化：${runtimeScopeRootPath}`);
  }
  return Object.freeze({
    id,
    configurationRootPath,
    runtimeScopeRootPath,
    runtimeDataRootPath,
    ...(binding ? {
      dataSetId: binding.dataSetId,
      rootInstanceId: binding.rootInstanceId,
      runtimeKernelEpoch: binding.runtimeKernelEpoch
    } : {}),
    ...(requiresRecovery ? { requiresRecovery: true as const } : {}),
    selected: selection?.id === id,
    source: id === 'default' ? binding ? 'legacy' : 'fixed' : 'workspace'
  });
}

async function hasRecoverableArchivedActive(
  configurationRootPath: string,
  runtimeScopeRootPath: string,
  binding: HistoricalRootBinding
): Promise<boolean> {
  const journalPath = path.join(runtimeScopeRootPath, VSCODE_RUNTIME_CONTROL_DIRECTORY, CUTOVER_JOURNAL_FILE);
  await assertSafeRootPath(configurationRootPath, journalPath);
  if (!await physicalCutoverRecoveryRequired(runtimeScopeRootPath)) return false;
  const journal = await readOptionalJson(journalPath) as Record<string, unknown>;
  if (!['archiving', 'activating', 'rolling-back'].includes(String(journal.state))) return false;
  const previous = journal.previousBinding as Record<string, unknown> | undefined;
  if (!previous || ['dataSetId', 'rootInstanceId', 'rootGeneration', 'pointerRevision', 'runtimeKernelEpoch']
    .some((key) => previous[key] !== binding[key as keyof HistoricalRootBinding])) return false;
  if (!isText(journal.archiveDirectoryName) || path.basename(journal.archiveDirectoryName) !== journal.archiveDirectoryName
    || journal.archiveDirectoryName === '.' || journal.archiveDirectoryName === '..') return false;
  const steps = journal.steps as Array<Record<string, unknown>>;
  if (!steps.some((step) => step.entryId === 'control.previous-runtime-active'
    && step.sourceRelativePath === '.limcode-runtime/active' && step.archiveRelativePath === 'runtime-control/active'
    && step.action === 'runtime-active' && (step.state === 'planned' || step.state === 'archived')
    && typeof step.sourceDigest === 'string' && /^[a-f0-9]{64}$/.test(step.sourceDigest))) return false;
  const archivedActive = path.join(runtimeScopeRootPath, VSCODE_RUNTIME_CONTROL_DIRECTORY, 'backups', journal.archiveDirectoryName, 'runtime-control', 'active');
  await assertSafeRootPath(configurationRootPath, archivedActive);
  await requirePathKind(archivedActive, 'directory');
  // Digest/step replay remains solely in recoverInterruptedPhysicalCutover, after the Host gate.
  return true;
}

async function validateCandidateEpoch(binding: HistoricalRootBinding, pending?: HistoricalRootBinding): Promise<void> {
  let value: unknown;
  try { value = await readOptionalJson(binding.paths.runtimeEpochPath); }
  catch (error) { throw new VscodeRuntimeDataSetError(`运行数据集epoch无法读取：${binding.paths.runtimeEpochPath}`, error); }
  const manifest = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (
    !manifest
    || Object.keys(manifest).sort().join(',') !== 'dataSetId,initializedAt,kind,rootGeneration,rootInstanceId,runtimeKernelEpoch'
    || manifest.kind !== 'limcode-runtime-kernel-epoch' || !isText(manifest.initializedAt)
  ) throw new VscodeRuntimeDataSetError(`运行数据集epoch无效：${binding.paths.runtimeEpochPath}`);
  const matches = (candidate: HistoricalRootBinding): boolean =>
    manifest.dataSetId === candidate.dataSetId && manifest.rootInstanceId === candidate.rootInstanceId
    && manifest.rootGeneration === candidate.rootGeneration && manifest.runtimeKernelEpoch === candidate.runtimeKernelEpoch;
  if (matches(binding)) return;
  // An exact published predecessor can write the current epoch manifest immediately before
  // publishing its pending pointer. Candidate selection must preserve that recovery window.
  if (
    (binding.runtimeKernelEpoch === 3 || binding.runtimeKernelEpoch === 4)
    && pending?.runtimeKernelEpoch === RUNTIME_KERNEL_EPOCH
    && pending.dataSetId === binding.dataSetId && pending.rootInstanceId === binding.rootInstanceId
    && pending.rootGeneration === binding.rootGeneration + 1
    && pending.pointerRevision === binding.pointerRevision + 1 && matches(pending)
  ) return;
  // The old 3→4 upgrader may also have been interrupted by a previously installed VSIX.
  if (
    binding.runtimeKernelEpoch === 3 && pending?.runtimeKernelEpoch === 4
    && pending.dataSetId === binding.dataSetId && pending.rootInstanceId === binding.rootInstanceId
    && pending.rootGeneration === binding.rootGeneration + 1
    && pending.pointerRevision === binding.pointerRevision + 1 && matches(pending)
  ) return;
  throw new VscodeRuntimeDataSetError(`运行数据集epoch身份与RootBinding不一致：${binding.paths.runtimeEpochPath}`);
}

function runtimeScopeRootForId(configurationRootPath: string, id: string): string {
  if (id === 'default') return configurationRootPath;
  const key = id.startsWith('workspace:') ? id.slice('workspace:'.length) : '';
  if (!/^(workspace-file|folder|folder-set|empty)-[a-f0-9]{64}$/.test(key)) {
    throw new VscodeRuntimeDataSetError(`运行数据集标识无效：${id}`);
  }
  return resolveVscodeWorkspaceRuntimeScopeRoot({ globalStoragePath: configurationRootPath }, { key });
}

async function readRuntimeDataSetSelection(configurationRootPath: string): Promise<RuntimeDataSetSelection | undefined> {
  const selectionPath = resolveVscodeRuntimeSelectionPath({ globalStoragePath: configurationRootPath });
  await assertSafeRootPath(configurationRootPath, selectionPath);
  let value: unknown;
  try {
    value = await readOptionalJson(selectionPath);
  } catch (error) {
    throw new VscodeRuntimeDataSetError(`运行数据集选择指针无法读取：${selectionPath}`, error);
  }
  if (value === undefined) return undefined;
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (
    !record || Object.keys(record).sort().join(',') !== 'id,initialized,kind,selectedAt,selectionRevision'
    || record.kind !== RUNTIME_SELECTION_KIND || !isText(record.id)
    || typeof record.initialized !== 'boolean' || !Number.isSafeInteger(record.selectionRevision)
    || Number(record.selectionRevision) < 1 || !isText(record.selectedAt)
  ) throw new VscodeRuntimeDataSetError(`运行数据集选择指针无效：${selectionPath}`);
  runtimeScopeRootForId(configurationRootPath, record.id);
  if (!record.initialized && record.id !== 'default') {
    throw new VscodeRuntimeDataSetError(`只有固定默认根允许首次初始化：${selectionPath}`);
  }
  return record as unknown as RuntimeDataSetSelection;
}

async function publishSelection(
  configurationRootPath: string,
  id: string,
  initialized: boolean,
  previous?: RuntimeDataSetSelection
): Promise<RuntimeDataSetSelection> {
  const selection: RuntimeDataSetSelection = {
    kind: RUNTIME_SELECTION_KIND,
    id,
    initialized,
    selectionRevision: (previous?.selectionRevision ?? 0) + 1,
    selectedAt: new Date().toISOString()
  };
  const target = resolveVscodeRuntimeSelectionPath({ globalStoragePath: configurationRootPath });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(configurationRootPath, { recursive: true });
  try {
    const handle = await fs.open(temporary, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(selection, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
    await syncDirectoryDurably(configurationRootPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return selection;
}

/** Empty control/active directories are harmless; any actual entry requires an existing binding. */
async function hasRuntimeArtifacts(controlPath: string): Promise<boolean> {
  for (const entry of await directoryEntryNames(controlPath)) {
    if (entry !== VSCODE_RUNTIME_ACTIVE_DIRECTORY) return true;
    const activePath = path.join(controlPath, entry);
    await requirePathKind(activePath, 'directory');
    if ((await directoryEntryNames(activePath)).length > 0) return true;
  }
  return false;
}

/** Reject links below the configured root so candidate ids cannot escape their root via aliases. */
async function assertSafeRootPath(configurationRootPath: string, target: string): Promise<void> {
  const relative = path.relative(configurationRootPath, target);
  if (!isPathInside(configurationRootPath, target)) {
    throw new VscodeRuntimeDataSetError(`运行数据集路径越过配置根：${target}`);
  }
  let current = configurationRootPath;
  const segments = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let info;
    try { info = await fs.lstat(current); }
    catch (error) { if (isMissingPathError(error)) return; throw error; }
    if (info.isSymbolicLink() || (index < segments.length - 1 && !info.isDirectory())) {
      throw new VscodeRuntimeDataSetError(`运行数据集路径包含链接或无效目录：${current}`);
    }
  }
}

async function requirePathKind(target: string, kind: 'file' | 'directory'): Promise<void> {
  let info;
  try { info = await fs.lstat(target); }
  catch (error) { throw new VscodeRuntimeDataSetError(`运行数据集文件缺失：${target}`, error); }
  if (!(kind === 'file' ? info.isFile() : info.isDirectory())) {
    throw new VscodeRuntimeDataSetError(`运行数据集文件类型无效：${target}`);
  }
}

async function readOptionalJson(filePath: string): Promise<unknown | undefined> {
  let text: string;
  try { text = await fs.readFile(filePath, 'utf8'); }
  catch (error) { if (isMissingPathError(error)) return undefined; throw error; }
  return JSON.parse(text);
}

function normalizeUri(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

async function directoryEntryNames(directoryPath: string): Promise<string[]> {
  try {
    return await fs.readdir(directoryPath);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
