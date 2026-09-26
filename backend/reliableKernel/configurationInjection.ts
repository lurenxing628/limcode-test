import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isPathInside } from '../capabilities/filesystem/pathContainment';
import { PHYSICAL_CUTOVER_MANIFEST, type PhysicalCutoverManifestEntry } from './generatedPhysicalCutoverManifest';
import {
  CUTOVER_CONTROL_DIRECTORY,
  filterPhysicalConfigurationRoot,
  treeDigest,
  verifyPhysicalConfigurationRoot
} from './physicalCutover';

const INJECTION_JOURNAL_KIND = 'limcode-configuration-injection-journal';
const INJECTION_RECEIPT_KIND = 'limcode-configuration-injection-receipt';
const INJECTION_JOURNAL_FILE = 'configuration-injection-journal.json';
const INJECTION_STAGING_DIRECTORY = 'configuration-injection-staging';
const INJECTION_BACKUPS_DIRECTORY = 'configuration-injection-backups';

interface InjectionStep {
  entryId: string;
  relativePath: string;
  sourceDigest: string;
  previousDigest?: string;
  state: 'staged' | 'previous-archived' | 'installed' | 'restored';
}

interface InjectionJournal {
  kind: typeof INJECTION_JOURNAL_KIND;
  contractRevision: string;
  attemptId: string;
  state: 'installing' | 'completed' | 'rolling-back' | 'rolled-back';
  backupDirectoryName: string;
  stagingDirectoryName: string;
  createdAt: string;
  updatedAt: string;
  steps: InjectionStep[];
}

export interface ConfigurationReadinessSummary {
  providerConfigCount: number;
  activeProviderConfigId: string;
  activeProviderHasModel: boolean;
  activeProviderHasCredential: boolean;
  mcpServerCount: number;
  enabledMcpServerCount: number;
}

export interface ConfigurationInjectionResult extends ConfigurationReadinessSummary {
  backupDirectoryName: string;
  installedEntryCount: number;
  sourceTreeDigest: string;
  installedTreeDigest: string;
}

export interface ConfigurationInjectionOptions {
  onStep?(entryId: string, state: InjectionStep['state']): Promise<void> | void;
}

/**
 * Copies only independent configuration from another LimCode data root. Source is never renamed,
 * rewritten or deleted. Target entries are journaled and backed up before replacement.
 */
export async function injectPhysicalConfiguration(
  sourceRootPathInput: string,
  targetRootPathInput: string,
  options: ConfigurationInjectionOptions = {}
): Promise<ConfigurationInjectionResult> {
  const sourceRootPath = normalizedAbsolutePath(sourceRootPathInput, 'configuration source root');
  const targetRootPath = normalizedAbsolutePath(targetRootPathInput, 'configuration target root');
  if (sourceRootPath === targetRootPath) throw new Error('配置注入source与target不能相同。');
  await recoverInterruptedConfigurationInjection(targetRootPath);
  await verifyPhysicalConfigurationRoot(sourceRootPath);

  const attemptId = randomUUID();
  const stagingDirectoryName = `${timestampSlug()}-${attemptId.slice(0, 8)}`;
  const backupDirectoryName = stagingDirectoryName;
  const stagingRoot = path.join(targetRootPath, CUTOVER_CONTROL_DIRECTORY, INJECTION_STAGING_DIRECTORY, stagingDirectoryName);
  const backupRoot = path.join(targetRootPath, CUTOVER_CONTROL_DIRECTORY, INJECTION_BACKUPS_DIRECTORY, backupDirectoryName);
  await ensureSecureDirectory(stagingRoot);
  await ensureSecureDirectory(backupRoot);

  const sourceEvidence: Record<string, string> = {};
  const entries = injectableEntries();
  for (const entry of entries) {
    const sourcePath = safeJoinedPath(sourceRootPath, entry.relativePath);
    if (!await exists(sourcePath)) continue;
    const digest = await treeDigest(sourcePath);
    sourceEvidence[entry.id] = digest;
    await copyVerified(sourcePath, safeJoinedPath(stagingRoot, entry.relativePath), digest);
  }
  if (Object.keys(sourceEvidence).length === 0) throw new Error('源LimCode没有可注入的配置。');

  await filterPhysicalConfigurationRoot(stagingRoot);
  const sourceTreeDigest = digestEvidence(sourceEvidence);
  const journal: InjectionJournal = {
    kind: INJECTION_JOURNAL_KIND,
    contractRevision: PHYSICAL_CUTOVER_MANIFEST.contractRevision,
    attemptId,
    state: 'installing',
    backupDirectoryName,
    stagingDirectoryName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: []
  };
  await writeJournal(targetRootPath, journal);

  try {
    for (const entry of entries) {
      const stagedPath = safeJoinedPath(stagingRoot, entry.relativePath);
      if (!await exists(stagedPath)) continue;
      const targetPath = safeJoinedPath(targetRootPath, entry.relativePath);
      const backupPath = safeJoinedPath(backupRoot, entry.relativePath);
      const step: InjectionStep = {
        entryId: entry.id,
        relativePath: entry.relativePath,
        sourceDigest: await treeDigest(stagedPath),
        ...(await exists(targetPath) ? { previousDigest: await treeDigest(targetPath) } : {}),
        state: 'staged'
      };
      journal.steps.push(step);
      await writeJournal(targetRootPath, journal);
      await options.onStep?.(step.entryId, step.state);

      if (await exists(targetPath)) {
        await moveVerified(targetPath, backupPath, step.previousDigest!);
        step.state = 'previous-archived';
        await writeJournal(targetRootPath, journal);
        await options.onStep?.(step.entryId, step.state);
      }
      await moveVerified(stagedPath, targetPath, step.sourceDigest);
      step.state = 'installed';
      journal.updatedAt = new Date().toISOString();
      await writeJournal(targetRootPath, journal);
      await options.onStep?.(step.entryId, step.state);
    }

    await verifyPhysicalConfigurationRoot(targetRootPath);
    for (const entry of entries) {
      const expected = sourceEvidence[entry.id];
      if (expected === undefined) continue;
      const actual = await treeDigest(safeJoinedPath(sourceRootPath, entry.relativePath));
      if (actual !== expected) throw new Error(`配置源在注入期间发生变化：${entry.id}`);
    }
    const readiness = await inspectConfigurationReadiness(targetRootPath);
    if (!readiness.activeProviderHasModel) throw new Error('注入后的激活Provider没有模型。');
    const installedEvidence = Object.fromEntries(await Promise.all(journal.steps.map(async (step) => [
      step.entryId,
      await treeDigest(safeJoinedPath(targetRootPath, step.relativePath))
    ] as const)));
    const installedTreeDigest = digestEvidence(installedEvidence);
    journal.state = 'completed';
    journal.updatedAt = new Date().toISOString();
    await writeJournal(targetRootPath, journal);
    const receipt: ConfigurationInjectionResult & { kind: typeof INJECTION_RECEIPT_KIND; contractRevision: string; attemptId: string; completedAt: string } = {
      kind: INJECTION_RECEIPT_KIND,
      contractRevision: PHYSICAL_CUTOVER_MANIFEST.contractRevision,
      attemptId,
      completedAt: new Date().toISOString(),
      backupDirectoryName,
      installedEntryCount: journal.steps.length,
      sourceTreeDigest,
      installedTreeDigest,
      ...readiness
    };
    await writeDurableJson(path.join(backupRoot, 'configuration-injection-receipt.json'), receipt);
    await writeDurableJson(path.join(backupRoot, 'configuration-injection-journal.completed.json'), journal);
    await fs.rm(journalPath(targetRootPath), { force: true });
    await fs.rm(stagingRoot, { recursive: true, force: true });
    return receipt;
  } catch (error) {
    await rollbackInjection(targetRootPath, journal);
    throw error;
  }
}

export async function recoverInterruptedConfigurationInjection(targetRootPathInput: string): Promise<'none' | 'rolled-back'> {
  const targetRootPath = normalizedAbsolutePath(targetRootPathInput, 'configuration target root');
  const value = await readJsonIfExists(journalPath(targetRootPath));
  if (value === undefined) return 'none';
  const journal = parseJournal(value);
  await rollbackInjection(targetRootPath, journal);
  return 'rolled-back';
}

export async function inspectConfigurationReadiness(dataRootPathInput: string): Promise<ConfigurationReadinessSummary> {
  const dataRootPath = normalizedAbsolutePath(dataRootPathInput, 'configuration root');
  const providers = await readStorePayloads(path.join(dataRootPath, 'settings', 'llm-provider-configs'));
  const llm = await readJsonIfExists(path.join(dataRootPath, 'settings', 'llm.json')) as { settings?: { activeProviderConfigId?: unknown } } | undefined;
  const activeProviderConfigId = typeof llm?.settings?.activeProviderConfigId === 'string' ? llm.settings.activeProviderConfigId : '';
  const active = providers.find((record) => record.id === activeProviderConfigId) ?? providers[0];
  const model = typeof active?.model === 'string' ? active.model.trim() : '';
  const apiKey = typeof active?.apiKey === 'string' ? active.apiKey.trim() : '';
  const headers = active?.headers && typeof active.headers === 'object' && !Array.isArray(active.headers)
    ? active.headers as Record<string, unknown>
    : {};
  const hasAuthorizationHeader = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization' && typeof headers[key] === 'string' && String(headers[key]).trim());
  const mcpServers = await readStorePayloads(path.join(dataRootPath, 'settings', 'mcp-servers'));
  return {
    providerConfigCount: providers.length,
    activeProviderConfigId: typeof active?.id === 'string' ? active.id : '',
    activeProviderHasModel: !!model,
    activeProviderHasCredential: !!apiKey || hasAuthorizationHeader,
    mcpServerCount: mcpServers.length,
    enabledMcpServerCount: mcpServers.filter((server) => server.enabled !== false).length
  };
}

async function rollbackInjection(targetRootPath: string, journal: InjectionJournal): Promise<void> {
  journal.state = 'rolling-back';
  journal.updatedAt = new Date().toISOString();
  await writeJournal(targetRootPath, journal);
  const stagingRoot = stagingRootPath(targetRootPath, journal);
  const backupRoot = backupRootPath(targetRootPath, journal);
  for (const step of [...journal.steps].reverse()) {
    const targetPath = safeJoinedPath(targetRootPath, step.relativePath);
    const backupPath = safeJoinedPath(backupRoot, step.relativePath);
    if (step.state === 'installed' && await exists(targetPath)) await fs.rm(targetPath, { recursive: true, force: true });
    if (step.previousDigest && await exists(backupPath)) {
      if (await exists(targetPath)) await fs.rm(targetPath, { recursive: true, force: true });
      await moveVerified(backupPath, targetPath, step.previousDigest);
    }
    step.state = 'restored';
    journal.updatedAt = new Date().toISOString();
    await writeJournal(targetRootPath, journal);
  }
  journal.state = 'rolled-back';
  journal.updatedAt = new Date().toISOString();
  await writeDurableJson(path.join(backupRoot, 'configuration-injection-journal.rolled-back.json'), journal);
  await fs.rm(journalPath(targetRootPath), { force: true });
  await fs.rm(stagingRoot, { recursive: true, force: true });
}

function injectableEntries(): PhysicalCutoverManifestEntry[] {
  const external = PHYSICAL_CUTOVER_MANIFEST.externalPreserve.filter((entry) =>
    entry.id === 'external.global-skills'
    || entry.id === 'external.global-agents-rule'
    || entry.id === 'external.global-claude-rule'
  );
  return [...PHYSICAL_CUTOVER_MANIFEST.preserveWhole, ...PHYSICAL_CUTOVER_MANIFEST.filterByScope, ...external]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function readStorePayloads(rootPath: string): Promise<Record<string, unknown>[]> {
  const indexValue = await readJsonIfExists(path.join(rootPath, 'index.json'));
  if (indexValue === undefined) return [];
  const index = indexValue as { records?: Array<{ id?: unknown; file?: unknown }> };
  if (!Array.isArray(index.records)) throw new Error(`配置record store index无效：${rootPath}`);
  const records: Record<string, unknown>[] = [];
  for (const indexed of index.records) {
    if (typeof indexed.id !== 'string' || typeof indexed.file !== 'string') throw new Error(`配置record store identity无效：${rootPath}`);
    const file = await readJsonIfExists(safeJoinedPath(rootPath, indexed.file));
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置record file无效：${indexed.id}`);
    const payloadKey = Object.keys(file).find((key) => key !== 'schemaVersion' && key !== 'savedAt');
    const payload = payloadKey ? (file as Record<string, unknown>)[payloadKey] : undefined;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (payload as Record<string, unknown>).id !== indexed.id) {
      throw new Error(`配置record payload无效：${indexed.id}`);
    }
    records.push(payload as Record<string, unknown>);
  }
  return records;
}

async function copyVerified(sourcePath: string, destinationPath: string, expectedDigest: string): Promise<void> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  await fs.cp(sourcePath, destinationPath, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, verbatimSymlinks: true });
  if (await treeDigest(destinationPath) !== expectedDigest) {
    await fs.rm(destinationPath, { recursive: true, force: true });
    throw new Error('配置copy摘要不一致。');
  }
}

async function moveVerified(sourcePath: string, destinationPath: string, expectedDigest: string): Promise<void> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  if (await exists(destinationPath)) throw new Error(`配置注入目标已存在：${destinationPath}`);
  try {
    await fs.rename(sourcePath, destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EXDEV') throw error;
    await copyVerified(sourcePath, destinationPath, expectedDigest);
    await fs.rm(sourcePath, { recursive: true, force: true });
  }
  if (await treeDigest(destinationPath) !== expectedDigest) throw new Error('配置move摘要不一致。');
}

function parseJournal(value: unknown): InjectionJournal {
  const journal = value as InjectionJournal;
  if (
    !journal || typeof journal !== 'object' || journal.kind !== INJECTION_JOURNAL_KIND
    || journal.contractRevision !== PHYSICAL_CUTOVER_MANIFEST.contractRevision
    || typeof journal.attemptId !== 'string' || !Array.isArray(journal.steps)
  ) throw new Error('configuration injection journal无效；拒绝猜测恢复。');
  return journal;
}

function digestEvidence(evidence: Record<string, string>): string {
  const canonical = Object.entries(evidence).sort(([left], [right]) => left.localeCompare(right));
  return randomlessDigest(JSON.stringify(canonical));
}

function randomlessDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function journalPath(targetRootPath: string): string {
  return path.join(targetRootPath, CUTOVER_CONTROL_DIRECTORY, INJECTION_JOURNAL_FILE);
}

function stagingRootPath(targetRootPath: string, journal: Pick<InjectionJournal, 'stagingDirectoryName'>): string {
  return path.join(targetRootPath, CUTOVER_CONTROL_DIRECTORY, INJECTION_STAGING_DIRECTORY, journal.stagingDirectoryName);
}

function backupRootPath(targetRootPath: string, journal: Pick<InjectionJournal, 'backupDirectoryName'>): string {
  return path.join(targetRootPath, CUTOVER_CONTROL_DIRECTORY, INJECTION_BACKUPS_DIRECTORY, journal.backupDirectoryName);
}

async function writeJournal(targetRootPath: string, journal: InjectionJournal): Promise<void> {
  await writeDurableJson(journalPath(targetRootPath), journal);
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
}

async function readJsonIfExists(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function ensureSecureDirectory(directoryPath: string): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await fs.chmod(directoryPath, 0o700);
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

function safeJoinedPath(rootPath: string, relativePath: string): string {
  if (path.posix.isAbsolute(relativePath) || relativePath.includes('\\')) throw new Error('配置路径不是安全相对路径。');
  const root = path.resolve(rootPath);
  const absolute = path.resolve(root, ...relativePath.split('/'));
  if (!isPathInside(root, absolute)) throw new Error('配置路径逃逸root。');
  return absolute;
}

function normalizedAbsolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) throw new TypeError(`${label}必须是规范绝对路径。`);
  return value;
}

function timestampSlug(): string {
  const date = new Date();
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}-${pad(date.getUTCMilliseconds(), 3)}`;
}
