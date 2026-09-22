import * as vscode from 'vscode';
import { normalizeDebugCaptureSettings, type DebugCaptureSettings } from '../../../shared/debugCapture';
import type {
  AttachmentSettingsRecord,
  AppearanceSettingsRecord,
  CheckpointMaintenanceSettingsRecord,
  GlobalSettingsSection,
  GlobalSettingsSectionValue,
  LlmCompressionSettingsRecord,
  LlmSettingsRecord,
  NetworkSettingsRecord
} from '../../../shared/protocol';
import { createDefaultLlmCompressionSettings } from '../../../shared/protocol';
import { ATTACHMENT_SETTINGS_FILE, CHECKPOINT_MAINTENANCE_SETTINGS_FILE, LLM_COMPRESSION_SETTINGS_FILE, LLM_SETTINGS_FILE, STORAGE_VERSION } from './constants';
import { APPEARANCE_SETTINGS_FILE } from './constants';
import { SettingsRevisionConflictError } from '../settingsRevisionConflict';
import { readJson, writeJson } from './json';
import { createDefaultLlmSettings, normalizeLlmSettings } from './llmSettings';
import { normalizeLlmCompressionSettings } from './llmCompressionConfigs';
import { withRecordStoreTransaction } from './recordStore';
import { createMissingStorageRevision, createStorageRevision } from './storageRevision';

interface GlobalSettingsFile<T> {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  settings: T;
}

export interface GlobalSettingsFileResult {
  section: GlobalSettingsSection;
  settings: GlobalSettingsSectionValue;
  filePath: string;
  revision: string;
  previousSettings?: GlobalSettingsSectionValue;
}

type FileBackedGlobalSettingsSection = Exclude<GlobalSettingsSection, 'common' | 'llmProviderConfigs' | 'llmCompressionConfigs' | 'mcpServers'>;

const GLOBAL_SETTINGS_SECTION_SPECS: Record<FileBackedGlobalSettingsSection, {
  fileName: string;
  createDefault: () => GlobalSettingsSectionValue;
  normalize: (input: Partial<GlobalSettingsSectionValue> | undefined) => GlobalSettingsSectionValue;
}> = {
  network: {
    fileName: 'network.json',
    createDefault: () => ({ userAgent: '' }),
    normalize: (input) => normalizeNetworkSettings(input as Partial<NetworkSettingsRecord> | undefined)
  },
  debugCapture: {
    fileName: 'debug-capture.json',
    createDefault: normalizeDebugCaptureSettings,
    normalize: (input) => normalizeDebugCaptureSettings(input as Partial<DebugCaptureSettings> | undefined)
  },
  llm: {
    fileName: LLM_SETTINGS_FILE,
    createDefault: createDefaultLlmSettings,
    normalize: (input) => normalizeLlmSettings(input as Partial<LlmSettingsRecord> | undefined)
  },
  llmCompression: {
    fileName: LLM_COMPRESSION_SETTINGS_FILE,
    createDefault: createDefaultLlmCompressionSettings,
    normalize: (input) => normalizeLlmCompressionSettings(input as Partial<LlmCompressionSettingsRecord> | undefined)
  },
  checkpointMaintenance: {
    fileName: CHECKPOINT_MAINTENANCE_SETTINGS_FILE,
    createDefault: createDefaultCheckpointMaintenanceSettings,
    normalize: (input) => normalizeCheckpointMaintenanceSettings(input as Partial<CheckpointMaintenanceSettingsRecord> | undefined)
  },
  appearance: {
    fileName: APPEARANCE_SETTINGS_FILE,
    createDefault: createDefaultAppearanceSettings,
    normalize: (input) => normalizeAppearanceSettings(input as Partial<AppearanceSettingsRecord> | undefined)
  },
  attachments: {
    fileName: ATTACHMENT_SETTINGS_FILE,
    createDefault: createDefaultAttachmentSettings,
    normalize: (input) => normalizeAttachmentSettings(input as Partial<AttachmentSettingsRecord> | undefined)
  }
};

const DEFAULT_CHECKPOINT_AUTO_CLEANUP_DAYS = 7;
const DEFAULT_CHECKPOINT_AUTO_DISMISS_SECONDS = 5;
export const DEFAULT_ATTACHMENT_MAX_STORED_INLINE_FILE_MB = 20;

function normalizeNetworkSettings(input: Partial<NetworkSettingsRecord> | undefined): NetworkSettingsRecord {
  return { userAgent: typeof input?.userAgent === 'string' ? input.userAgent.trim() : '' };
}

export function createDefaultCheckpointMaintenanceSettings(): CheckpointMaintenanceSettingsRecord {
  return {
    autoCleanupEnabled: true,
    autoCleanupDays: DEFAULT_CHECKPOINT_AUTO_CLEANUP_DAYS,
    autoDismissEnabled: true,
    autoDismissSeconds: DEFAULT_CHECKPOINT_AUTO_DISMISS_SECONDS
  };
}

export function normalizeCheckpointMaintenanceSettings(input: Partial<CheckpointMaintenanceSettingsRecord> | undefined): CheckpointMaintenanceSettingsRecord {
  const autoCleanupEnabled = typeof input?.autoCleanupEnabled === 'boolean' ? input.autoCleanupEnabled : true;
  const rawDays = typeof input?.autoCleanupDays === 'number' && Number.isFinite(input.autoCleanupDays)
    ? Math.floor(input.autoCleanupDays)
    : DEFAULT_CHECKPOINT_AUTO_CLEANUP_DAYS;
  const autoDismissEnabled = typeof input?.autoDismissEnabled === 'boolean' ? input.autoDismissEnabled : true;
  const rawSeconds = typeof input?.autoDismissSeconds === 'number' && Number.isFinite(input.autoDismissSeconds)
    ? Math.floor(input.autoDismissSeconds)
    : DEFAULT_CHECKPOINT_AUTO_DISMISS_SECONDS;
  return {
    autoCleanupEnabled,
    autoCleanupDays: Math.min(3650, Math.max(1, rawDays)),
    autoDismissEnabled,
    autoDismissSeconds: Math.min(600, Math.max(1, rawSeconds))
  };
}

export const DEFAULT_APPEARANCE_STREAMING_TEXT_WAITING = '...少女等待中';
export const DEFAULT_APPEARANCE_STREAMING_TEXT_PREPARING = '...少女整理中';
export const DEFAULT_APPEARANCE_STREAMING_TEXT_THINKING = '...少女思考中';
export const DEFAULT_APPEARANCE_STREAMING_TEXT_WRITING = '...少女编写中';
export const DEFAULT_APPEARANCE_STREAMING_TEXT_TOOL_EXECUTING = '...少女执行中';

export function createDefaultAppearanceSettings(): AppearanceSettingsRecord {
  return {
    streamingTextPreparing: DEFAULT_APPEARANCE_STREAMING_TEXT_PREPARING,
    streamingTextWaiting: DEFAULT_APPEARANCE_STREAMING_TEXT_WAITING,
    streamingTextThinking: DEFAULT_APPEARANCE_STREAMING_TEXT_THINKING,
    streamingTextWriting: DEFAULT_APPEARANCE_STREAMING_TEXT_WRITING,
    streamingTextToolExecuting: DEFAULT_APPEARANCE_STREAMING_TEXT_TOOL_EXECUTING
  };
}

export function normalizeAppearanceSettings(input: Partial<AppearanceSettingsRecord> | undefined): AppearanceSettingsRecord {
  const sanitize = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return {
    streamingTextPreparing: sanitize(input?.streamingTextPreparing, DEFAULT_APPEARANCE_STREAMING_TEXT_PREPARING),
    streamingTextWaiting: sanitize(input?.streamingTextWaiting, DEFAULT_APPEARANCE_STREAMING_TEXT_WAITING),
    streamingTextThinking: sanitize(input?.streamingTextThinking, DEFAULT_APPEARANCE_STREAMING_TEXT_THINKING),
    streamingTextWriting: sanitize(input?.streamingTextWriting, DEFAULT_APPEARANCE_STREAMING_TEXT_WRITING),
    streamingTextToolExecuting: sanitize(input?.streamingTextToolExecuting, DEFAULT_APPEARANCE_STREAMING_TEXT_TOOL_EXECUTING)
  };
}

export function createDefaultAttachmentSettings(): AttachmentSettingsRecord {
  return { maxStoredInlineFileMb: DEFAULT_ATTACHMENT_MAX_STORED_INLINE_FILE_MB };
}

export function normalizeAttachmentSettings(input: Partial<AttachmentSettingsRecord> | undefined): AttachmentSettingsRecord {
  const number = Number(input?.maxStoredInlineFileMb);
  const normalized = Number.isFinite(number)
    ? Math.floor(number)
    : DEFAULT_ATTACHMENT_MAX_STORED_INLINE_FILE_MB;
  return {
    maxStoredInlineFileMb: Math.min(200, Math.max(1, normalized))
  };
}

export async function ensureGlobalSettingsFile(root: vscode.Uri, section: GlobalSettingsSection): Promise<void> {
  await loadGlobalSettingsFile(root, section);
}

export async function loadGlobalSettingsFile(
  root: vscode.Uri,
  section: GlobalSettingsSection
): Promise<GlobalSettingsFileResult> {
  const uri = globalSettingsFileUri(root, section);
  const file = await readJson<unknown>(uri, { throwOnError: true });
  if (file === undefined) return initializeMissingGlobalSettingsFile(root, section);
  return materializeGlobalSettingsFile(root, section, file);
}

export async function writeGlobalSettingsFile(
  root: vscode.Uri,
  section: GlobalSettingsSection,
  settings: GlobalSettingsSectionValue,
  expectedRevision: string
): Promise<GlobalSettingsFileResult> {
  const uri = globalSettingsFileUri(root, section);
  return withRecordStoreTransaction(uri, async () => {
    const current = await readJson<unknown>(uri, { throwOnError: true });
    const previous = current === undefined
      ? undefined
      : materializeGlobalSettingsFile(root, section, current);
    const actualRevision = previous?.revision ?? missingGlobalSettingsRevision(uri, section);
    if (actualRevision !== expectedRevision) {
      throw new SettingsRevisionConflictError(section, expectedRevision, actualRevision);
    }
    const normalized = getFileBackedSpec(section).normalize(settings as Partial<GlobalSettingsSectionValue> | undefined);
    if (previous && createStorageRevision(normalized) === actualRevision) {
      return { ...previous, previousSettings: previous.settings };
    }
    const committed = await writeGlobalSettingsFileUnlocked(uri, section, settings);
    return {
      ...committed,
      ...(previous ? { previousSettings: previous.settings } : {})
    };
  });
}

export function globalSettingsFileUri(root: vscode.Uri, section: GlobalSettingsSection): vscode.Uri {
  return vscode.Uri.joinPath(root, getFileBackedSpec(section).fileName);
}

async function initializeMissingGlobalSettingsFile(
  root: vscode.Uri,
  section: GlobalSettingsSection
): Promise<GlobalSettingsFileResult> {
  const uri = globalSettingsFileUri(root, section);
  return withRecordStoreTransaction(uri, async () => {
    const current = await readJson<unknown>(uri, { throwOnError: true });
    if (current !== undefined) return materializeGlobalSettingsFile(root, section, current);
    return writeGlobalSettingsFileUnlocked(uri, section, getFileBackedSpec(section).createDefault());
  });
}

function materializeGlobalSettingsFile(
  root: vscode.Uri,
  section: GlobalSettingsSection,
  value: unknown
): GlobalSettingsFileResult {
  const uri = globalSettingsFileUri(root, section);
  const file = parseGlobalSettingsFile(section, uri, value);
  const settings = getFileBackedSpec(section).normalize(
    file.settings as Partial<GlobalSettingsSectionValue> | undefined
  );
  return {
    section,
    settings,
    filePath: uri.fsPath,
    revision: createStorageRevision(settings)
  };
}

async function writeGlobalSettingsFileUnlocked(
  uri: vscode.Uri,
  section: GlobalSettingsSection,
  settings: GlobalSettingsSectionValue
): Promise<GlobalSettingsFileResult> {
  const spec = getFileBackedSpec(section);
  const normalized = spec.normalize(settings as Partial<GlobalSettingsSectionValue> | undefined);
  await writeJson(uri, {
    schemaVersion: STORAGE_VERSION,
    savedAt: new Date().toISOString(),
    settings: normalized
  } satisfies GlobalSettingsFile<GlobalSettingsSectionValue>);
  return {
    section,
    settings: normalized,
    filePath: uri.fsPath,
    revision: createStorageRevision(normalized)
  };
}

function missingGlobalSettingsRevision(uri: vscode.Uri, section: GlobalSettingsSection): string {
  return createMissingStorageRevision(`global-settings:${section}:${uri.toString()}`);
}

function parseGlobalSettingsFile(
  section: GlobalSettingsSection,
  uri: vscode.Uri,
  value: unknown
): GlobalSettingsFile<GlobalSettingsSectionValue> {
  const file = asPlainObject(value);
  if (!file) throw new Error(`全局设置文件结构无效：${uri.fsPath}`);
  if (file.schemaVersion !== STORAGE_VERSION) throw new Error(`全局设置文件版本无效：${uri.fsPath}`);
  if (typeof file.savedAt !== 'string' || !file.savedAt.trim()) {
    throw new Error(`全局设置文件缺少有效保存时间：${uri.fsPath}`);
  }
  if (!isValidGlobalSettingsSectionValue(section, file.settings)) {
    throw new Error(`全局设置「${section}」内容损坏：${uri.fsPath}`);
  }
  return {
    schemaVersion: STORAGE_VERSION,
    savedAt: file.savedAt,
    settings: file.settings
  };
}

function isValidGlobalSettingsSectionValue(section: GlobalSettingsSection, value: unknown): value is GlobalSettingsSectionValue {
  const record = asPlainObject(value);
  if (!record) return false;
  if (section === 'llm') return typeof record.activeProviderConfigId === 'string';
  if (section === 'network') return typeof record.userAgent === 'string';
  if (section === 'llmCompression') {
    return Array.isArray(record.providerBindings) && Array.isArray(record.modelBindings)
      && (record.defaultConfigId === undefined || typeof record.defaultConfigId === 'string');
  }
  if (section === 'checkpointMaintenance') {
    return typeof record.autoCleanupEnabled === 'boolean'
      && typeof record.autoCleanupDays === 'number'
      && Number.isFinite(record.autoCleanupDays)
      && typeof record.autoDismissEnabled === 'boolean'
      && typeof record.autoDismissSeconds === 'number'
      && Number.isFinite(record.autoDismissSeconds);
  }
  if (section === 'appearance') {
    return [
      record.streamingTextPreparing,
      record.streamingTextWaiting,
      record.streamingTextThinking,
      record.streamingTextWriting,
      record.streamingTextToolExecuting
    ].every((item) => typeof item === 'string');
  }
  if (section === 'attachments') {
    return typeof record.maxStoredInlineFileMb === 'number'
      && Number.isFinite(record.maxStoredInlineFileMb);
  }
  if (section === 'debugCapture') {
    return (record.scope === 'conversation' || record.scope === 'workspace')
      && (record.maxMiB === 8 || record.maxMiB === 16 || record.maxMiB === 32)
      && (record.maxMinutes === 5 || record.maxMinutes === 15 || record.maxMinutes === 30);
  }
  return false;
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function getFileBackedSpec(section: GlobalSettingsSection): (typeof GLOBAL_SETTINGS_SECTION_SPECS)[FileBackedGlobalSettingsSection] {
  if (section === 'common' || section === 'llmProviderConfigs' || section === 'llmCompressionConfigs' || section === 'mcpServers') {
    throw new Error(`Global settings section "${section}" is not stored by the generic file-backed settings handler.`);
  }
  return GLOBAL_SETTINGS_SECTION_SPECS[section];
}
