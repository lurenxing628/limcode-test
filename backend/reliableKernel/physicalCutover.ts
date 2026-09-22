import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RootBinding } from './contracts';
import { PHYSICAL_CUTOVER_MANIFEST, type PhysicalCutoverManifestEntry } from './generatedPhysicalCutoverManifest';
import { RootAuthority, type HistoricalRootBinding } from './rootAuthority';

export const CUTOVER_CONTROL_DIRECTORY = '.limcode-runtime';
export const CUTOVER_REQUEST_FILE = 'cutover-request.json';
export const CUTOVER_JOURNAL_FILE = 'cutover-journal.json';
export const CUTOVER_BACKUPS_DIRECTORY = 'backups';
export const CUTOVER_COMPLETION_FILE = 'cutover-completion.json';

const CUTOVER_REQUEST_KIND = 'limcode-runtime-cutover-request';
const CUTOVER_JOURNAL_KIND = 'limcode-runtime-cutover-journal';
const CUTOVER_COMPLETION_KIND = 'limcode-runtime-cutover-completion';
const RECORDS_DIRECTORY = 'records';
const INDEX_FILE = 'index.json';

export interface PhysicalCutoverDrainProof {
  noActiveTurn: true;
  noBackgroundProcess: true;
  noPendingProviderStream: true;
  noPersistInflight: true;
}

export interface PhysicalCutoverRequest {
  kind: typeof CUTOVER_REQUEST_KIND;
  contractRevision: string;
  requestId: string;
  requestedAt: string;
  drain: PhysicalCutoverDrainProof;
}

export interface PhysicalCutoverResult {
  binding: RootBinding;
  initialized: boolean;
  cutoverPerformed: boolean;
  archiveDirectoryName?: string;
  archivedEntryCount: number;
  filteredEntryCount: number;
  preservedEntryCount: number;
}

export type PhysicalCutoverFaultPoint =
  | 'after-journal-created'
  | 'after-entry-planned'
  | 'after-entry-archived'
  | 'after-filter-replacement-created'
  | 'before-runtime-activation'
  | 'after-runtime-activation'
  | 'before-completion';

export interface PhysicalCutoverOptions {
  forceCopyInsteadOfRename?: boolean;
  onFaultPoint?(point: PhysicalCutoverFaultPoint, detail: { entryId?: string; requestId: string }): Promise<void> | void;
}

interface BindingIdentity {
  dataSetId: string;
  rootInstanceId: string;
  rootGeneration: number;
  pointerRevision: number;
  runtimeKernelEpoch: number;
}

interface CutoverJournalStep {
  entryId: string;
  sourceRelativePath: string;
  archiveRelativePath: string;
  action: 'archive-reset' | 'filter-by-scope' | 'runtime-active';
  sourceDigest: string;
  state: 'planned' | 'archived' | 'replacement-created' | 'restored';
  moveMode?: 'rename' | 'copy';
  replacementDigest?: string;
}

interface CutoverEntryResult {
  entryId: string;
  disposition: 'archive-reset-whole' | 'filter-by-scope' | 'preserve-whole' | 'preserve-in-place';
  state: 'absent' | 'archived' | 'filtered' | 'preserved';
  beforeDigest?: string;
  afterDigest?: string;
  keptRecordCount?: number;
  removedRecordCount?: number;
}

interface PhysicalCutoverJournal {
  kind: typeof CUTOVER_JOURNAL_KIND;
  contractRevision: string;
  requestId: string;
  attemptId: string;
  state: 'archiving' | 'activating' | 'completed' | 'rolling-back' | 'rolled-back';
  archiveDirectoryName: string;
  createdAt: string;
  updatedAt: string;
  previousBinding?: BindingIdentity;
  activatedBinding?: BindingIdentity;
  steps: CutoverJournalStep[];
  results: CutoverEntryResult[];
  preservedEvidence: Record<string, string>;
  unknownEvidence: Record<string, string>;
}

export async function persistPhysicalCutoverRequest(
  dataRootPathInput: string,
  drain: PhysicalCutoverDrainProof
): Promise<PhysicalCutoverRequest> {
  const dataRootPath = normalizedAbsolutePath(dataRootPathInput, 'cutover data root');
  requireCompleteDrainProof(drain);
  const existing = await readPhysicalCutoverRequest(dataRootPath);
  if (existing) return existing;
  const request: PhysicalCutoverRequest = {
    kind: CUTOVER_REQUEST_KIND,
    contractRevision: PHYSICAL_CUTOVER_MANIFEST.contractRevision,
    requestId: randomUUID(),
    requestedAt: new Date().toISOString(),
    drain
  };
  await writeDurableJson(cutoverRequestPath(dataRootPath), request);
  return request;
}

export async function readPhysicalCutoverRequest(dataRootPathInput: string): Promise<PhysicalCutoverRequest | undefined> {
  const dataRootPath = normalizedAbsolutePath(dataRootPathInput, 'cutover data root');
  const value = await readJsonIfExists(cutoverRequestPath(dataRootPath));
  if (value === undefined) return undefined;
  const record = requireRecord(value, 'PhysicalCutoverRequest');
  requireExactKeys(record, ['kind', 'contractRevision', 'requestId', 'requestedAt', 'drain'], 'PhysicalCutoverRequest');
  if (record.kind !== CUTOVER_REQUEST_KIND) throw new TypeError('PhysicalCutoverRequest.kind无效。');
  if (record.contractRevision !== PHYSICAL_CUTOVER_MANIFEST.contractRevision) {
    throw new TypeError('PhysicalCutoverRequest.contractRevision不是当前合同。');
  }
  const request: PhysicalCutoverRequest = {
    kind: CUTOVER_REQUEST_KIND,
    contractRevision: PHYSICAL_CUTOVER_MANIFEST.contractRevision,
    requestId: requireId(record.requestId, 'PhysicalCutoverRequest.requestId'),
    requestedAt: requireIsoTimestamp(record.requestedAt, 'PhysicalCutoverRequest.requestedAt'),
    drain: parseDrainProof(record.drain)
  };
  return request;
}

export interface ConfigurationFilterResult {
  filteredRootCount: number;
  keptRecordCount: number;
  removedRecordCount: number;
}

/** Filters a detached configuration copy; callers must never pass a live root with active writers. */
export async function filterPhysicalConfigurationRoot(dataRootPathInput: string): Promise<ConfigurationFilterResult> {
  const dataRootPath = normalizedAbsolutePath(dataRootPathInput, 'configuration staging root');
  let filteredRootCount = 0;
  let keptRecordCount = 0;
  let removedRecordCount = 0;
  for (const entry of PHYSICAL_CUTOVER_MANIFEST.filterByScope) {
    const absolute = entryPath(dataRootPath, entry.relativePath);
    if (!await exists(absolute)) continue;
    const counts = entry.relativePath === 'settings'
      ? await filterConversationSettings(absolute)
      : await filterScopeLinkRecordStore(absolute, new Set(entry.preservedScopeKinds ?? []));
    if (entry.relativePath === 'settings') await verifySettingsRoot(absolute);
    filteredRootCount += 1;
    keptRecordCount += counts.kept;
    removedRecordCount += counts.removed;
  }
  await verifyPhysicalConfigurationRoot(dataRootPath);
  return { filteredRootCount, keptRecordCount, removedRecordCount };
}

export async function verifyPhysicalConfigurationRoot(dataRootPathInput: string): Promise<void> {
  const dataRootPath = normalizedAbsolutePath(dataRootPathInput, 'configuration root');
  for (const entry of PHYSICAL_CUTOVER_MANIFEST.preserveWhole) {
    const absolute = entryPath(dataRootPath, entry.relativePath);
    if (!await exists(absolute)) continue;
    const stat = await fs.lstat(absolute);
    if (stat.isDirectory() && await exists(path.join(absolute, INDEX_FILE))) await verifyRecordStore(absolute);
    await verifyJsonTree(absolute);
  }
  for (const entry of PHYSICAL_CUTOVER_MANIFEST.filterByScope) {
    const absolute = entryPath(dataRootPath, entry.relativePath);
    if (!await exists(absolute)) continue;
    if (entry.relativePath === 'settings') await verifySettingsRoot(absolute, false);
    else await verifyRecordStore(absolute);
  }
}

export async function legacyRuntimeRequiresCutover(dataRootPathInput: string): Promise<boolean> {
  const dataRootPath = normalizedAbsolutePath(dataRootPathInput, 'cutover data root');
  for (const entry of PHYSICAL_CUTOVER_MANIFEST.archiveReset) {
    if (await exists(entryPath(dataRootPath, entry.relativePath))) return true;
  }
  const settingsPath = path.join(dataRootPath, 'settings');
  if (await exists(settingsPath)) {
    for (const name of await fs.readdir(settingsPath)) {
      if (isConversationSettingName(name)) return true;
    }
    if (await exists(path.join(settingsPath, PHYSICAL_CUTOVER_MANIFEST.conversationSettings.transactionRoot))) return true;
  }
  return false;
}

/**
 * Read-only startup-gate preflight: true when an interrupted cutover journal is present, i.e.
 * {@link recoverInterruptedPhysicalCutover} would complete or roll back durable file operations.
 */
export async function physicalCutoverRecoveryRequired(dataRootPathInput: string): Promise<boolean> {
  const dataRootPath = normalizedAbsolutePath(dataRootPathInput, 'cutover data root');
  return (await readJournal(dataRootPath)) !== undefined;
}

/**
 * Completes or rolls back an interrupted archive before ordinary Runtime startup. It never guesses:
 * a valid pointer different from previousBinding means activation committed; every other state rolls
 * back the pre-activation file operations before the request may be retried.
 */
export async function recoverInterruptedPhysicalCutover(
  dataRootPathInput: string,
  authority: RootAuthority
): Promise<'none' | 'completed' | 'rolled-back'> {
  const dataRootPath = normalizedAbsolutePath(dataRootPathInput, 'cutover data root');
  // Recovery can delete pending state, restore data trees, or finalize a completed journal.
  // Guard here as well as in startup: direct callers must not mutate a foreign/invalid root.
  await authority.readHistoricalPointerForCutover();
  const journal = await readJournal(dataRootPath);
  if (!journal) return 'none';
  if (journal.state === 'completed') {
    await finalizeCommittedCutover(dataRootPath, journal);
    return 'completed';
  }
  if (journal.state === 'activating') {
    const current = await currentIfValid(authority);
    if (current && !sameBindingIdentityRecord(journal.previousBinding, current)) {
      journal.activatedBinding = bindingIdentity(current);
      journal.state = 'completed';
      journal.updatedAt = new Date().toISOString();
      await writeJournal(dataRootPath, journal);
      await finalizeCommittedCutover(dataRootPath, journal);
      return 'completed';
    }
  }
  await rollbackCutover(dataRootPath, authority, journal);
  return 'rolled-back';
}

export async function performPhysicalCutover(
  dataRootPathInput: string,
  authority: RootAuthority,
  initializeRuntime: (binding: RootBinding) => Promise<void>,
  options: PhysicalCutoverOptions = {}
): Promise<PhysicalCutoverResult> {
  const dataRootPath = normalizedAbsolutePath(dataRootPathInput, 'cutover data root');
  await authority.readHistoricalPointerForCutover();
  const request = await readPhysicalCutoverRequest(dataRootPath);
  if (!request) throw new Error('缺少显式cutover request；拒绝归档真实数据。');
  requireCompleteDrainProof(request.drain);
  await recoverInterruptedPhysicalCutover(dataRootPath, authority);

  const previousBinding = await authority.readHistoricalPointerForCutover();
  const attemptId = randomUUID();
  const archiveDirectoryName = `${timestampSlug()}-${attemptId.slice(0, 8)}`;
  const preservedEvidence = await capturePreservedEvidence(dataRootPath);
  const preservedEntries = [...PHYSICAL_CUTOVER_MANIFEST.preserveWhole, ...PHYSICAL_CUTOVER_MANIFEST.externalPreserve];
  const journal: PhysicalCutoverJournal = {
    kind: CUTOVER_JOURNAL_KIND,
    contractRevision: PHYSICAL_CUTOVER_MANIFEST.contractRevision,
    requestId: request.requestId,
    attemptId,
    state: 'archiving',
    archiveDirectoryName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(previousBinding ? { previousBinding: bindingIdentity(previousBinding) } : {}),
    steps: [],
    results: preservedEntries.map((entry): CutoverEntryResult => ({
      entryId: entry.id,
      disposition: entry.disposition === 'preserve-whole' ? 'preserve-whole' : 'preserve-in-place',
      state: preservedEvidence[entry.id] ? 'preserved' : 'absent',
      ...(preservedEvidence[entry.id] ? {
        beforeDigest: preservedEvidence[entry.id],
        afterDigest: preservedEvidence[entry.id]
      } : {})
    })),
    preservedEvidence,
    unknownEvidence: await captureUnknownEvidence(dataRootPath)
  };
  await ensureSecureDirectory(archiveRootPath(dataRootPath, journal));
  await writeJournal(dataRootPath, journal);
  await fault(options, 'after-journal-created', request.requestId);

  let activationCommitted = false;
  try {
    for (const entry of PHYSICAL_CUTOVER_MANIFEST.archiveReset) {
      await archiveManifestEntry(dataRootPath, journal, entry, 'archive-reset', options);
    }
    for (const entry of PHYSICAL_CUTOVER_MANIFEST.filterByScope) {
      await filterManifestEntry(dataRootPath, journal, entry, options);
    }
    const activeRelativePath = path.posix.join(CUTOVER_CONTROL_DIRECTORY, 'active');
    if (await exists(entryPath(dataRootPath, activeRelativePath))) {
      await archivePath(dataRootPath, journal, {
        id: 'control.previous-runtime-active',
        relativePath: activeRelativePath
      }, 'runtime-active', options);
    }

    await verifyPreservedEvidence(dataRootPath, journal.preservedEvidence);
    await verifyUnknownEvidence(dataRootPath, journal.unknownEvidence);
    journal.state = 'activating';
    journal.updatedAt = new Date().toISOString();
    await writeJournal(dataRootPath, journal);
    await fault(options, 'before-runtime-activation', request.requestId);

    const binding = await authority.activateCutoverRoot(initializeRuntime);
    activationCommitted = true;
    journal.activatedBinding = bindingIdentity(binding);
    await fault(options, 'after-runtime-activation', request.requestId);
    journal.state = 'completed';
    journal.updatedAt = new Date().toISOString();
    await writeJournal(dataRootPath, journal);
    await fault(options, 'before-completion', request.requestId);
    await finalizeCommittedCutover(dataRootPath, journal);
    return resultFromJournal(binding, journal);
  } catch (error) {
    if (!activationCommitted) {
      const current = await currentIfValid(authority);
      activationCommitted = !!current && !sameBindingIdentityRecord(journal.previousBinding, current);
      if (activationCommitted && current) journal.activatedBinding = bindingIdentity(current);
    }
    if (activationCommitted) {
      journal.state = 'completed';
      journal.updatedAt = new Date().toISOString();
      await writeJournal(dataRootPath, journal).catch(() => undefined);
      const completionError = new Error('Runtime已原子激活，但完成回执写入失败；下次启动将只完成收尾，不回退旧写入器。');
      (completionError as Error & { cause?: unknown }).cause = error;
      throw completionError;
    }
    await rollbackCutover(dataRootPath, authority, journal);
    throw error;
  }
}

async function archiveManifestEntry(
  dataRootPath: string,
  journal: PhysicalCutoverJournal,
  entry: PhysicalCutoverManifestEntry,
  action: CutoverJournalStep['action'],
  options: PhysicalCutoverOptions
): Promise<void> {
  if (!await exists(entryPath(dataRootPath, entry.relativePath))) {
    journal.results.push({ entryId: entry.id, disposition: 'archive-reset-whole', state: 'absent' });
    await writeJournal(dataRootPath, journal);
    return;
  }
  await archivePath(dataRootPath, journal, entry, action, options);
  journal.results.push({
    entryId: entry.id,
    disposition: 'archive-reset-whole',
    state: 'archived',
    beforeDigest: journal.steps[journal.steps.length - 1].sourceDigest
  });
  await writeJournal(dataRootPath, journal);
}

async function archivePath(
  dataRootPath: string,
  journal: PhysicalCutoverJournal,
  entry: Pick<PhysicalCutoverManifestEntry, 'id' | 'relativePath'>,
  action: CutoverJournalStep['action'],
  options: PhysicalCutoverOptions
): Promise<CutoverJournalStep> {
  const sourcePath = entryPath(dataRootPath, entry.relativePath);
  const archiveRelativePath = archiveEntryRelativePath(entry.relativePath);
  const destinationPath = path.join(archiveRootPath(dataRootPath, journal), ...archiveRelativePath.split('/'));
  const sourceDigest = await treeDigest(sourcePath);
  const step: CutoverJournalStep = {
    entryId: entry.id,
    sourceRelativePath: entry.relativePath,
    archiveRelativePath,
    action,
    sourceDigest,
    state: 'planned'
  };
  journal.steps.push(step);
  journal.updatedAt = new Date().toISOString();
  await writeJournal(dataRootPath, journal);
  await fault(options, 'after-entry-planned', journal.requestId, entry.id);

  const moveMode = await movePathVerified(sourcePath, destinationPath, sourceDigest, options.forceCopyInsteadOfRename === true);
  step.moveMode = moveMode;
  step.state = 'archived';
  journal.updatedAt = new Date().toISOString();
  await writeJournal(dataRootPath, journal);
  await fault(options, 'after-entry-archived', journal.requestId, entry.id);
  return step;
}

async function filterManifestEntry(
  dataRootPath: string,
  journal: PhysicalCutoverJournal,
  entry: PhysicalCutoverManifestEntry,
  options: PhysicalCutoverOptions
): Promise<void> {
  const sourcePath = entryPath(dataRootPath, entry.relativePath);
  if (!await exists(sourcePath)) {
    journal.results.push({ entryId: entry.id, disposition: 'filter-by-scope', state: 'absent' });
    await writeJournal(dataRootPath, journal);
    return;
  }
  const step = await archivePath(dataRootPath, journal, entry, 'filter-by-scope', options);
  const archivedPath = path.join(archiveRootPath(dataRootPath, journal), ...step.archiveRelativePath.split('/'));
  await copyPathVerified(archivedPath, sourcePath, step.sourceDigest);
  let counts = { kept: 0, removed: 0 };
  if (entry.relativePath === 'settings') {
    counts = await filterConversationSettings(sourcePath);
    await verifySettingsRoot(sourcePath);
  } else {
    counts = await filterScopeLinkRecordStore(sourcePath, new Set(entry.preservedScopeKinds ?? []));
  }
  step.state = 'replacement-created';
  step.replacementDigest = await treeDigest(sourcePath);
  journal.results.push({
    entryId: entry.id,
    disposition: 'filter-by-scope',
    state: 'filtered',
    beforeDigest: step.sourceDigest,
    afterDigest: step.replacementDigest,
    keptRecordCount: counts.kept,
    removedRecordCount: counts.removed
  });
  journal.updatedAt = new Date().toISOString();
  await writeJournal(dataRootPath, journal);
  await fault(options, 'after-filter-replacement-created', journal.requestId, entry.id);
}

async function filterScopeLinkRecordStore(rootPath: string, preservedScopeKinds: Set<string>): Promise<{ kept: number; removed: number }> {
  if (preservedScopeKinds.size === 0) throw new Error(`过滤清单没有声明保留scope：${rootPath}`);
  const store = await readRecordStore(rootPath, true);
  if (!store) return { kept: 0, removed: 0 };
  const kept = [];
  const removedFiles: string[] = [];
  for (const indexed of store.index.records) {
    const loaded = store.records.get(indexed.file)!;
    const scopeKind = loaded.record.scopeKind;
    if (typeof scopeKind !== 'string') throw new Error(`Scope Link缺少scopeKind：${indexed.id}`);
    if (preservedScopeKinds.has(scopeKind)) kept.push(indexed);
    else removedFiles.push(indexed.file);
  }
  await writeDurableJson(path.join(rootPath, INDEX_FILE), {
    ...store.index,
    savedAt: new Date().toISOString(),
    records: kept
  });
  for (const relativeFile of removedFiles) await fs.rm(safeJoinedPath(rootPath, relativeFile), { force: true });
  await syncDirectory(path.join(rootPath, RECORDS_DIRECTORY));
  await verifyRecordStore(rootPath);
  return { kept: kept.length, removed: removedFiles.length };
}

async function filterConversationSettings(settingsRootPath: string): Promise<{ kept: number; removed: number }> {
  const entries = await fs.readdir(settingsRootPath, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (entry.isFile() && isConversationSettingName(entry.name)) {
      await fs.rm(path.join(settingsRootPath, entry.name), { force: true });
      removed += 1;
    }
  }
  const transactionRoot = path.join(settingsRootPath, PHYSICAL_CUTOVER_MANIFEST.conversationSettings.transactionRoot);
  if (await exists(transactionRoot)) {
    await fs.rm(transactionRoot, { recursive: true, force: true });
    removed += 1;
  }
  await syncDirectory(settingsRootPath);
  return { kept: Math.max(0, entries.length - removed), removed };
}

async function verifySettingsRoot(settingsRootPath: string, requireConversationFiltered = true): Promise<void> {
  for (const relativePath of await listTreeFiles(settingsRootPath)) {
    if (!relativePath.toLowerCase().endsWith('.json')) continue;
    JSON.parse(await fs.readFile(path.join(settingsRootPath, ...relativePath.split('/')), 'utf8'));
  }
  for (const section of PHYSICAL_CUTOVER_MANIFEST.settingsSections) {
    const sectionPath = entryPath(settingsRootPath, section.relativePath);
    if (!await exists(sectionPath)) continue;
    const stat = await fs.lstat(sectionPath);
    if (stat.isDirectory() && await exists(path.join(sectionPath, INDEX_FILE))) await verifyRecordStore(sectionPath);
    else if (stat.isFile() && sectionPath.toLowerCase().endsWith('.json')) JSON.parse(await fs.readFile(sectionPath, 'utf8'));
  }
  if (requireConversationFiltered) {
    for (const name of await fs.readdir(settingsRootPath)) {
      if (isConversationSettingName(name)) throw new Error(`Conversation设置未被过滤：${name}`);
    }
    if (await exists(path.join(settingsRootPath, PHYSICAL_CUTOVER_MANIFEST.conversationSettings.transactionRoot))) {
      throw new Error('Conversation设置事务目录未被过滤。');
    }
  }
}

async function capturePreservedEvidence(dataRootPath: string): Promise<Record<string, string>> {
  const evidence: Record<string, string> = {};
  for (const entry of [...PHYSICAL_CUTOVER_MANIFEST.preserveWhole, ...PHYSICAL_CUTOVER_MANIFEST.externalPreserve]) {
    const absolute = entryPath(dataRootPath, entry.relativePath);
    if (!await exists(absolute)) continue;
    if (entry.disposition === 'preserve-whole') {
      const stat = await fs.lstat(absolute);
      if (stat.isDirectory() && await exists(path.join(absolute, INDEX_FILE))) await verifyRecordStore(absolute);
      await verifyJsonTree(absolute);
    }
    evidence[entry.id] = await treeDigest(absolute);
  }
  return evidence;
}

async function verifyPreservedEvidence(dataRootPath: string, evidence: Record<string, string>): Promise<void> {
  const entries = new Map([...PHYSICAL_CUTOVER_MANIFEST.preserveWhole, ...PHYSICAL_CUTOVER_MANIFEST.externalPreserve].map((entry) => [entry.id, entry]));
  for (const [entryId, digest] of Object.entries(evidence)) {
    const entry = entries.get(entryId);
    if (!entry) throw new Error(`未知preserve evidence：${entryId}`);
    const absolute = entryPath(dataRootPath, entry.relativePath);
    if (!await exists(absolute) || await treeDigest(absolute) !== digest) throw new Error(`保留配置发生变化：${entryId}`);
  }
}

async function captureUnknownEvidence(dataRootPath: string): Promise<Record<string, string>> {
  const knownTopLevel = new Set<string>([CUTOVER_CONTROL_DIRECTORY]);
  for (const entry of [
    ...PHYSICAL_CUTOVER_MANIFEST.preserveWhole,
    ...PHYSICAL_CUTOVER_MANIFEST.filterByScope,
    ...PHYSICAL_CUTOVER_MANIFEST.archiveReset,
    ...PHYSICAL_CUTOVER_MANIFEST.externalPreserve
  ]) knownTopLevel.add(entry.relativePath.split('/')[0]);
  const evidence: Record<string, string> = {};
  if (!await exists(dataRootPath)) return evidence;
  for (const name of (await fs.readdir(dataRootPath)).sort()) {
    if (knownTopLevel.has(name)) continue;
    evidence[name] = await treeDigest(path.join(dataRootPath, name));
  }
  return evidence;
}

async function verifyUnknownEvidence(dataRootPath: string, evidence: Record<string, string>): Promise<void> {
  const current = await captureUnknownEvidence(dataRootPath);
  if (JSON.stringify(current) !== JSON.stringify(evidence)) throw new Error('未登记的用户数据文件在cutover期间发生变化。');
}

async function rollbackCutover(dataRootPath: string, authority: RootAuthority, journal: PhysicalCutoverJournal): Promise<void> {
  journal.state = 'rolling-back';
  journal.updatedAt = new Date().toISOString();
  await writeJournal(dataRootPath, journal);
  const expected = authority.expectedPaths();
  await fs.rm(expected.rootPendingPath, { force: true });

  for (const step of [...journal.steps].reverse()) {
    const sourcePath = entryPath(dataRootPath, step.sourceRelativePath);
    const archivedPath = path.join(archiveRootPath(dataRootPath, journal), ...step.archiveRelativePath.split('/'));
    const sourceExists = await exists(sourcePath);
    const archivedExists = await exists(archivedPath);
    if (!archivedExists) {
      if (step.state === 'planned' && sourceExists && await treeDigest(sourcePath) === step.sourceDigest) continue;
      throw new Error(`无法回滚${step.entryId}：归档副本缺失。`);
    }
    if (sourceExists) await fs.rm(sourcePath, { recursive: true, force: true });
    await movePathVerified(archivedPath, sourcePath, step.sourceDigest, false);
    step.state = 'restored';
    journal.updatedAt = new Date().toISOString();
    await writeJournal(dataRootPath, journal);
  }

  journal.state = 'rolled-back';
  journal.updatedAt = new Date().toISOString();
  await writeJournal(dataRootPath, journal);
  const rollbackReceipt = path.join(archiveRootPath(dataRootPath, journal), 'cutover-journal.rolled-back.json');
  await writeDurableJson(rollbackReceipt, journal);
  await fs.rm(cutoverJournalPath(dataRootPath), { force: true });
  await syncDirectory(controlRootPath(dataRootPath));
}

async function finalizeCommittedCutover(dataRootPath: string, journal: PhysicalCutoverJournal): Promise<void> {
  const archiveRoot = archiveRootPath(dataRootPath, journal);
  await ensureSecureDirectory(archiveRoot);
  const completion = {
    kind: CUTOVER_COMPLETION_KIND,
    contractRevision: PHYSICAL_CUTOVER_MANIFEST.contractRevision,
    requestId: journal.requestId,
    attemptId: journal.attemptId,
    archiveDirectoryName: journal.archiveDirectoryName,
    completedAt: new Date().toISOString(),
    activatedBinding: journal.activatedBinding,
    archivedEntryCount: journal.results.filter((entry) => entry.state === 'archived').length,
    filteredEntryCount: journal.results.filter((entry) => entry.state === 'filtered').length,
    preservedEntryCount: Object.keys(journal.preservedEvidence).length
  };
  await writeDurableJson(path.join(archiveRoot, CUTOVER_COMPLETION_FILE), completion);
  await writeDurableJson(path.join(archiveRoot, 'cutover-journal.completed.json'), journal);
  await fs.rm(cutoverRequestPath(dataRootPath), { force: true });
  await fs.rm(cutoverJournalPath(dataRootPath), { force: true });
  await syncDirectory(controlRootPath(dataRootPath));
}

function resultFromJournal(binding: RootBinding, journal: PhysicalCutoverJournal): PhysicalCutoverResult {
  return {
    binding,
    initialized: true,
    cutoverPerformed: true,
    archiveDirectoryName: journal.archiveDirectoryName,
    archivedEntryCount: journal.results.filter((entry) => entry.state === 'archived').length,
    filteredEntryCount: journal.results.filter((entry) => entry.state === 'filtered').length,
    preservedEntryCount: Object.keys(journal.preservedEvidence).length
  };
}

async function readRecordStore(rootPath: string, requireScope: boolean): Promise<{
  index: { schemaVersion: number; savedAt: string; records: Array<{ id: string; file: string; updatedAt: string }> };
  records: Map<string, { recordKey: string; record: Record<string, unknown> }>;
} | undefined> {
  const indexPath = path.join(rootPath, INDEX_FILE);
  if (!await exists(indexPath)) {
    const recordRoot = path.join(rootPath, RECORDS_DIRECTORY);
    if (await exists(recordRoot) && (await listJsonFiles(recordRoot)).length > 0) throw new Error(`Record store缺少index：${rootPath}`);
    return undefined;
  }
  const rawIndex = requireRecord(JSON.parse(await fs.readFile(indexPath, 'utf8')), `Record store index ${rootPath}`);
  if (!Array.isArray(rawIndex.records) || typeof rawIndex.schemaVersion !== 'number' || typeof rawIndex.savedAt !== 'string') {
    throw new Error(`Record store index格式无效：${rootPath}`);
  }
  const records = rawIndex.records.map((value, index) => parseIndexRecord(value, `${rootPath} index[${index}]`));
  const ids = new Set<string>();
  const files = new Set<string>();
  const loaded = new Map<string, { recordKey: string; record: Record<string, unknown> }>();
  for (const indexed of records) {
    if (ids.has(indexed.id) || files.has(indexed.file)) throw new Error(`Record store index包含重复identity：${rootPath}`);
    ids.add(indexed.id);
    files.add(indexed.file);
    const absolute = safeJoinedPath(rootPath, indexed.file);
    const rawFile = requireRecord(JSON.parse(await fs.readFile(absolute, 'utf8')), `Record file ${indexed.file}`);
    const payloadKeys = Object.keys(rawFile).filter((key) => key !== 'schemaVersion' && key !== 'savedAt');
    if (payloadKeys.length !== 1) throw new Error(`Record file payload key不唯一：${indexed.file}`);
    const recordKey = payloadKeys[0];
    const record = requireRecord(rawFile[recordKey], `Record payload ${indexed.file}`);
    if (record.id !== indexed.id) throw new Error(`Record file id与index不一致：${indexed.file}`);
    if (requireScope && typeof record.scopeKind !== 'string') throw new Error(`Scope Link缺少scopeKind：${indexed.file}`);
    loaded.set(indexed.file, { recordKey, record });
  }
  const recordRoot = path.join(rootPath, RECORDS_DIRECTORY);
  const actualFiles = await exists(recordRoot)
    ? (await listJsonFiles(recordRoot)).map((file) => `${RECORDS_DIRECTORY}/${file}`)
    : [];
  const expectedFiles = [...files].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) throw new Error(`Record store存在orphan或缺失文件：${rootPath}`);
  return {
    index: { schemaVersion: rawIndex.schemaVersion, savedAt: rawIndex.savedAt, records },
    records: loaded
  };
}

async function verifyRecordStore(rootPath: string): Promise<void> {
  await readRecordStore(rootPath, false);
}

async function verifyJsonTree(rootPath: string): Promise<void> {
  const stat = await fs.lstat(rootPath);
  if (stat.isFile()) {
    if (rootPath.toLowerCase().endsWith('.json')) JSON.parse(await fs.readFile(rootPath, 'utf8'));
    return;
  }
  if (!stat.isDirectory()) return;
  for (const relativePath of await listTreeFiles(rootPath)) {
    if (relativePath.toLowerCase().endsWith('.json')) JSON.parse(await fs.readFile(path.join(rootPath, ...relativePath.split('/')), 'utf8'));
  }
}

async function movePathVerified(sourcePath: string, destinationPath: string, expectedDigest: string, forceCopy: boolean): Promise<'rename' | 'copy'> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  if (await exists(destinationPath)) throw new Error(`归档目标已存在：${destinationPath}`);
  if (!forceCopy) {
    try {
      await fs.rename(sourcePath, destinationPath);
      await syncDirectory(path.dirname(sourcePath));
      await syncDirectory(path.dirname(destinationPath));
      if (await treeDigest(destinationPath) !== expectedDigest) throw new Error('rename后树摘要不一致。');
      return 'rename';
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EXDEV') throw error;
    }
  }
  await copyPathVerified(sourcePath, destinationPath, expectedDigest);
  await fs.rm(sourcePath, { recursive: true, force: true });
  await syncDirectory(path.dirname(sourcePath));
  return 'copy';
}

async function copyPathVerified(sourcePath: string, destinationPath: string, expectedDigest: string): Promise<void> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  await fs.cp(sourcePath, destinationPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    verbatimSymlinks: true
  });
  await syncTree(destinationPath);
  const actual = await treeDigest(destinationPath);
  if (actual !== expectedDigest) {
    await fs.rm(destinationPath, { recursive: true, force: true });
    throw new Error('copy后树摘要不一致。');
  }
}

export async function treeDigest(rootPathInput: string): Promise<string> {
  const rootPath = path.resolve(rootPathInput);
  const hash = createHash('sha256');
  await walk(rootPath, '');
  return hash.digest('hex');

  async function walk(absolute: string, relative: string): Promise<void> {
    const stat = await fs.lstat(absolute);
    const mode = (stat.mode & 0o777).toString(8);
    if (stat.isDirectory()) {
      hash.update(`D\0${relative}\0${mode}\0`);
      const names = (await fs.readdir(absolute)).sort();
      for (const name of names) await walk(path.join(absolute, name), relative ? `${relative}/${name}` : name);
      return;
    }
    if (stat.isFile()) {
      hash.update(`F\0${relative}\0${mode}\0${stat.size}\0`);
      for await (const chunk of createReadStream(absolute)) hash.update(chunk as Buffer);
      hash.update('\0');
      return;
    }
    if (stat.isSymbolicLink()) {
      hash.update(`L\0${relative}\0${await fs.readlink(absolute)}\0`);
      return;
    }
    throw new Error(`cutover不支持特殊文件：${relative || path.basename(rootPath)}`);
  }
}

async function syncTree(rootPath: string): Promise<void> {
  const stat = await fs.lstat(rootPath);
  if (stat.isFile()) {
    const handle = await fs.open(rootPath, process.platform === 'win32' ? 'r+' : 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    return;
  }
  if (!stat.isDirectory()) return;
  for (const name of await fs.readdir(rootPath)) await syncTree(path.join(rootPath, name));
  await syncDirectory(rootPath);
}

async function listTreeFiles(rootPath: string): Promise<string[]> {
  const result: string[] = [];
  await visit(rootPath, '');
  return result.sort();
  async function visit(absolute: string, relative: string): Promise<void> {
    const stat = await fs.lstat(absolute);
    if (stat.isFile()) {
      result.push(relative);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const name of await fs.readdir(absolute)) await visit(path.join(absolute, name), relative ? `${relative}/${name}` : name);
  }
}

async function listJsonFiles(directoryPath: string): Promise<string[]> {
  return (await fs.readdir(directoryPath, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
}

async function readJournal(dataRootPath: string): Promise<PhysicalCutoverJournal | undefined> {
  const value = await readJsonIfExists(cutoverJournalPath(dataRootPath));
  if (value === undefined) return undefined;
  const journal = value as PhysicalCutoverJournal;
  if (
    !journal || typeof journal !== 'object' || journal.kind !== CUTOVER_JOURNAL_KIND
    || journal.contractRevision !== PHYSICAL_CUTOVER_MANIFEST.contractRevision
    || typeof journal.requestId !== 'string' || typeof journal.attemptId !== 'string'
    || !Array.isArray(journal.steps) || !Array.isArray(journal.results)
    || typeof journal.archiveDirectoryName !== 'string'
  ) throw new Error('cutover journal无效；拒绝猜测恢复。');
  return journal;
}

async function writeJournal(dataRootPath: string, journal: PhysicalCutoverJournal): Promise<void> {
  await writeDurableJson(cutoverJournalPath(dataRootPath), journal);
}

async function currentIfValid(authority: RootAuthority): Promise<RootBinding | undefined> {
  try {
    return await authority.current();
  } catch {
    return undefined;
  }
}

function bindingIdentity(binding: RootBinding | HistoricalRootBinding): BindingIdentity {
  return {
    dataSetId: binding.dataSetId,
    rootInstanceId: binding.rootInstanceId,
    rootGeneration: binding.rootGeneration,
    pointerRevision: binding.pointerRevision,
    runtimeKernelEpoch: binding.runtimeKernelEpoch
  };
}

function sameBindingIdentityRecord(previous: BindingIdentity | undefined, current: RootBinding): boolean {
  return !!previous
    && previous.dataSetId === current.dataSetId
    && previous.rootInstanceId === current.rootInstanceId
    && previous.rootGeneration === current.rootGeneration
    && previous.pointerRevision === current.pointerRevision
    && previous.runtimeKernelEpoch === current.runtimeKernelEpoch;
}

function parseIndexRecord(value: unknown, label: string): { id: string; file: string; updatedAt: string } {
  const record = requireRecord(value, label);
  const id = requireId(record.id, `${label}.id`);
  const file = requireSafeRecordFile(record.file, `${label}.file`);
  const updatedAt = requireIsoTimestamp(record.updatedAt, `${label}.updatedAt`);
  return { id, file, updatedAt };
}

function requireSafeRecordFile(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.startsWith(`${RECORDS_DIRECTORY}/`) || !value.toLowerCase().endsWith('.json')) {
    throw new TypeError(`${label}不是安全records JSON路径。`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError(`${label}包含不安全路径片段。`);
  }
  return value;
}

function safeJoinedPath(rootPath: string, relativePath: string): string {
  const absolute = path.resolve(rootPath, ...relativePath.split('/'));
  const normalizedRoot = path.resolve(rootPath);
  if (absolute !== normalizedRoot && !absolute.startsWith(`${normalizedRoot}${path.sep}`)) throw new Error('路径逃逸cutover root。');
  return absolute;
}

function entryPath(dataRootPath: string, relativePath: string): string {
  return safeJoinedPath(dataRootPath, relativePath);
}

function archiveEntryRelativePath(sourceRelativePath: string): string {
  if (sourceRelativePath === `${CUTOVER_CONTROL_DIRECTORY}/active`) return 'runtime-control/active';
  return `entries/${sourceRelativePath}`;
}

function controlRootPath(dataRootPath: string): string {
  return path.join(dataRootPath, CUTOVER_CONTROL_DIRECTORY);
}

function cutoverRequestPath(dataRootPath: string): string {
  return path.join(controlRootPath(dataRootPath), CUTOVER_REQUEST_FILE);
}

function cutoverJournalPath(dataRootPath: string): string {
  return path.join(controlRootPath(dataRootPath), CUTOVER_JOURNAL_FILE);
}

function archiveRootPath(dataRootPath: string, journal: Pick<PhysicalCutoverJournal, 'archiveDirectoryName'>): string {
  return path.join(controlRootPath(dataRootPath), CUTOVER_BACKUPS_DIRECTORY, journal.archiveDirectoryName);
}

async function ensureSecureDirectory(directoryPath: string): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await fs.chmod(directoryPath, 0o700);
}

async function writeDurableJson(filePath: string, value: unknown): Promise<void> {
  await ensureSecureDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, 0o600);
  await syncDirectory(path.dirname(filePath));
}

async function readJsonIfExists(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  await syncDirectoryDurably(directoryPath);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

function normalizedAbsolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) throw new TypeError(`${label}必须是规范绝对路径。`);
  return value;
}

function isConversationSettingName(name: string): boolean {
  return name.startsWith(PHYSICAL_CUTOVER_MANIFEST.conversationSettings.filePrefix)
    && PHYSICAL_CUTOVER_MANIFEST.conversationSettings.fileSuffixes.some((suffix) => name.endsWith(suffix));
}

function parseDrainProof(value: unknown): PhysicalCutoverDrainProof {
  const record = requireRecord(value, 'PhysicalCutoverDrainProof');
  requireExactKeys(record, ['noActiveTurn', 'noBackgroundProcess', 'noPendingProviderStream', 'noPersistInflight'], 'PhysicalCutoverDrainProof');
  const proof = record as unknown as PhysicalCutoverDrainProof;
  requireCompleteDrainProof(proof);
  return proof;
}

function requireCompleteDrainProof(value: PhysicalCutoverDrainProof): void {
  if (
    value.noActiveTurn !== true || value.noBackgroundProcess !== true
    || value.noPendingProviderStream !== true || value.noPersistInflight !== true
  ) throw new TypeError('cutover drain proof必须全部为true。');
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label}必须是对象。`);
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new TypeError(`${label}字段不符合当前合同。`);
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new TypeError(`${label}无效。`);
  return value;
}

function requireIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${label}不是ISO时间。`);
  return value;
}

function timestampSlug(): string {
  const date = new Date();
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}-${pad(date.getUTCMilliseconds(), 3)}`;
}

async function fault(options: PhysicalCutoverOptions, point: PhysicalCutoverFaultPoint, requestId: string, entryId?: string): Promise<void> {
  await options.onFaultPoint?.(point, { ...(entryId ? { entryId } : {}), requestId });
}
