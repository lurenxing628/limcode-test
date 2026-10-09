import * as vscode from 'vscode';
import type {
  ConversationLlmSettingsRecord,
  ConversationSettingsRecord,
  GlobalSettingsRecord,
  GlobalSettingsSectionValue,
  LlmCompressionConfigsRecord,
  LlmCompressionSettingsRecord,
  LlmProviderConfigRecord,
  LlmProviderConfigsRecord,
  LlmSettingsRecord,
  McpServersSettingsRecord
} from '../../../shared/protocol';
import type { StorageCapability } from '../types';
import { CHECKPOINT_FEATURE_ENABLED } from '../../../shared/featureFlags';
import { loadGlobalSettingsFile, writeGlobalSettingsFile } from './globalSettings';
import { loadLlmProviderConfigsSettings, saveLlmProviderConfigsSettings } from './llmProviderConfigs';
import { loadLlmCompressionConfigsSettings, normalizeLlmCompressionSettings, saveLlmCompressionConfigsSettings } from './llmCompressionConfigs';
import { loadMcpServersSettings, saveMcpServersSettings } from './mcpServers';
import {
  createGlobalSettingsRecord,
  LIMCODE_GLOBAL_STATUS_LABEL,
  normalizeStatusDataRootPath,
  resolveDataRootUri,
  saveGlobalStatus
} from './globalStatus';
import { migrateStorageRoot } from './migration';
import { createVscodeStoragePaths } from './paths';
import { readJson, writeJson } from './json';
import {
  loadClientStateSkeletonFromStores,
  saveClientStateSkeletonToStores
} from './clientStateStore';
import {
  loadConversationHistoryPageFromStore,
  removeConversationHistoryEntryFromStore,
  upsertConversationHistoryEntryInStore
} from './conversationHistoryStore';
import { createShadowCheckpoint, detectSystemGit as detectSystemGitCommand, disabledShadowCheckpointRecord, restoreShadowCheckpoint } from './shadowCheckpoint';
import { openShadowCheckpointDiff, registerShadowDiffProvider } from './shadowDiff';
import { cleanupUnusedShadowWorktrees, collectShadowWorktreeStats, deleteShadowWorktrees } from './shadowCheckpointMaintenance';
import { withConversationDataTransaction } from './conversationDataStore';
import { conversationSettingsFileName } from './naming';
import { loadToolResultContent, stagePreparedToolResultContent, stageToolResultContent } from './toolResultStore';
import { ensureCurrentDataEpoch, resetManagedDataRoot } from './dataEpoch';

type StoragePaths = ReturnType<typeof createVscodeStoragePaths>;

export function createVsCodeStorageCapability(context: vscode.ExtensionContext): StorageCapability {
  let currentPaths = createVscodeStoragePaths(resolveDataRootUri(context));
  let readyRootPath: string | undefined;
  let readinessCheck: { rootPath: string; promise: Promise<void> } | undefined;
  if (CHECKPOINT_FEATURE_ENABLED) registerShadowDiffProvider(context);

  function getPaths(): StoragePaths {
    currentPaths = createVscodeStoragePaths(resolveDataRootUri(context));
    return currentPaths;
  }

  async function ensurePathsReady(paths: StoragePaths): Promise<void> {
    if (readyRootPath === paths.globalStoragePath) return;
    if (readinessCheck?.rootPath === paths.globalStoragePath) return readinessCheck.promise;
    const promise = ensureCurrentDataEpoch(paths).then(() => {
      if (readinessCheck?.rootPath === paths.globalStoragePath) readyRootPath = paths.globalStoragePath;
    });
    readinessCheck = { rootPath: paths.globalStoragePath, promise };
    return promise;
  }

  async function getReadyPaths(): Promise<StoragePaths> {
    const paths = getPaths();
    await ensurePathsReady(paths);
    return paths;
  }

  async function loadCommonGlobalSettings(): Promise<{ section: 'common'; settings: GlobalSettingsRecord; filePath: string }> {
    return { section: 'common', settings: createGlobalSettingsRecord(context), filePath: LIMCODE_GLOBAL_STATUS_LABEL };
  }

  async function saveCommonGlobalSettings(settings: GlobalSettingsSectionValue): Promise<{ section: 'common'; settings: GlobalSettingsRecord; filePath: string }> {
    const input = settings as Partial<GlobalSettingsRecord> | undefined;
    const previousPaths = await getReadyPaths();
    const targetDataRootPath = normalizeStatusDataRootPath(context, input?.dataFilePath ?? '');
    const targetRootUri = resolveDataRootUri(context, targetDataRootPath);
    const migration = await migrateStorageRoot(previousPaths.globalStorageUri, targetRootUri);
    await saveGlobalStatus(
      context,
      targetDataRootPath,
      input?.proxy ?? '',
      migration.skipped ? undefined : { fromPath: migration.fromPath, toPath: migration.toPath, migratedAt: migration.migratedAt },
      input?.proxyShellAndMcp
    );
    return loadCommonGlobalSettings();
  }

  async function saveNormalizedLlmGlobalSettings(paths: StoragePaths, settings: GlobalSettingsSectionValue): Promise<{ section: 'llm'; settings: LlmSettingsRecord; filePath: string }> {
    await ensureLlmSettingsRoots(paths);
    const configs = (await loadLlmProviderConfigsSettings(paths)).settings.configs;
    const input = settings as Partial<LlmSettingsRecord> | undefined;
    const activeConfig = configs.find((config) => config.id === input?.activeProviderConfigId) ?? configs[0];
    await writeGlobalSettingsFile(paths.settingsRootUri, 'llm', { activeProviderConfigId: activeConfig?.id ?? '' });
    return loadNormalizedLlmGlobalSettings(paths);
  }

  return {
    get paths() { return getPaths(); },
    async ensureReady() {
      await ensurePathsReady(getPaths());
    },
    async resetDataRoot(options) {
      const paths = getPaths();
      const result = await resetManagedDataRoot(paths, options);
      readyRootPath = paths.globalStoragePath;
      readinessCheck = { rootPath: paths.globalStoragePath, promise: Promise.resolve() };
      return result;
    },
    async stageToolResultContent(content) {
      return stageToolResultContent(await getReadyPaths(), content);
    },
    async stagePreparedToolResultContent(content) {
      return stagePreparedToolResultContent(await getReadyPaths(), content);
    },
    async loadToolResultContent(artifact) {
      return loadToolResultContent(await getReadyPaths(), artifact);
    },
    async loadClientStateSkeleton(options) {
      const paths = await getReadyPaths();
      return loadClientStateSkeletonFromStores(paths, options);
    },
    async saveClientStateSkeleton(state) {
      const paths = await getReadyPaths();
      await saveClientStateSkeletonToStores(paths, state);
    },
    async loadConversationHistoryPage(request) {
      const paths = await getReadyPaths();
      return loadConversationHistoryPageFromStore(paths, request);
    },
    async upsertConversationHistoryEntry(entry, originLink) {
      const paths = await getReadyPaths();
      await upsertConversationHistoryEntryInStore(paths, entry, originLink);
    },
    async removeConversationHistoryEntry(conversationId) {
      const paths = await getReadyPaths();
      await removeConversationHistoryEntryFromStore(paths, conversationId);
    },

    async detectSystemGit() {
      if (!CHECKPOINT_FEATURE_ENABLED) {
        return { available: false, checkedAt: Date.now(), message: 'Checkpoint 功能当前已停用。' };
      }
      return detectSystemGitCommand();
    },
    async createShadowCheckpoint(request) {
      if (!CHECKPOINT_FEATURE_ENABLED) return disabledShadowCheckpointRecord(request);
      const paths = await getReadyPaths();
      return createShadowCheckpoint(paths, request);
    },
    async restoreShadowCheckpoint(request) {
      if (!CHECKPOINT_FEATURE_ENABLED) return { status: 'failed', message: 'Checkpoint 功能当前已停用。' };
      const paths = await getReadyPaths();
      return restoreShadowCheckpoint(paths, request);
    },
    async openShadowCheckpointDiff(request) {
      if (!CHECKPOINT_FEATURE_ENABLED) return { status: 'failed', message: 'Checkpoint 功能当前已停用。' };
      const paths = await getReadyPaths();
      return openShadowCheckpointDiff(paths, request);
    },
    async collectShadowWorktreeStats() {
      if (!CHECKPOINT_FEATURE_ENABLED) return [];
      const paths = await getReadyPaths();
      return collectShadowWorktreeStats(paths);
    },
    async deleteShadowWorktrees(storageKeys) {
      if (!CHECKPOINT_FEATURE_ENABLED) return { deletedStorageKeys: [] };
      const paths = await getReadyPaths();
      return deleteShadowWorktrees(paths, storageKeys);
    },
    async cleanupUnusedShadowWorktrees(maxAgeDays) {
      if (!CHECKPOINT_FEATURE_ENABLED) return { deletedStorageKeys: [] };
      const paths = await getReadyPaths();
      return cleanupUnusedShadowWorktrees(paths, maxAgeDays);
    },
    async loadGlobalSettings(section) {
      if (section === 'common') return loadCommonGlobalSettings();
      const paths = await getReadyPaths();
      if (section === 'llm') return loadNormalizedLlmGlobalSettings(paths);
      if (section === 'llmProviderConfigs') {
        const stored = await loadLlmProviderConfigsSettings(paths);
        await loadNormalizedLlmGlobalSettings(paths);
        return { section, settings: stored.settings, filePath: stored.filePath };
      }
      if (section === 'llmCompression') {
        const configs = (await loadLlmCompressionConfigsSettings(paths)).settings.configs;
        const stored = await loadGlobalSettingsFile(paths.settingsRootUri, 'llmCompression');
        const settings = normalizeLlmCompressionSettings(stored.settings as Partial<LlmCompressionSettingsRecord> | undefined, configs);
        if (JSON.stringify(settings) !== JSON.stringify(stored.settings)) await writeGlobalSettingsFile(paths.settingsRootUri, 'llmCompression', settings);
        return { section, settings, filePath: stored.filePath };
      }
      if (section === 'llmCompressionConfigs') {
        const stored = await loadLlmCompressionConfigsSettings(paths);
        return { section, settings: stored.settings, filePath: stored.filePath };
      }
      if (section === 'mcpServers') {
        const stored = await loadMcpServersSettings(paths);
        return { section, settings: stored.settings, filePath: stored.filePath };
      }
      await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
      return loadGlobalSettingsFile(paths.settingsRootUri, section);
    },
    async saveGlobalSettings(section, settings) {
      if (section === 'common') return saveCommonGlobalSettings(settings);
      const paths = await getReadyPaths();
      if (section === 'llm') return saveNormalizedLlmGlobalSettings(paths, settings);
      if (section === 'llmProviderConfigs') {
        const stored = await saveLlmProviderConfigsSettings(paths, settings as Partial<LlmProviderConfigsRecord> | undefined);
        await loadNormalizedLlmGlobalSettings(paths);
        return { section, settings: stored.settings, filePath: stored.filePath };
      }
      if (section === 'llmCompression') {
        const configs = (await loadLlmCompressionConfigsSettings(paths)).settings.configs;
        const normalized = normalizeLlmCompressionSettings(settings as Partial<LlmCompressionSettingsRecord> | undefined, configs);
        await writeGlobalSettingsFile(paths.settingsRootUri, 'llmCompression', normalized);
        const stored = await loadGlobalSettingsFile(paths.settingsRootUri, 'llmCompression');
        return { section, settings: stored.settings, filePath: stored.filePath };
      }
      if (section === 'llmCompressionConfigs') {
        const stored = await saveLlmCompressionConfigsSettings(paths, settings as Partial<LlmCompressionConfigsRecord> | undefined);
        return { section, settings: stored.settings, filePath: stored.filePath };
      }
      if (section === 'mcpServers') {
        const stored = await saveMcpServersSettings(paths, settings as Partial<McpServersSettingsRecord> | undefined);
        return { section, settings: stored.settings, filePath: stored.filePath };
      }
      await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
      await writeGlobalSettingsFile(paths.settingsRootUri, section, settings);
      return loadGlobalSettingsFile(paths.settingsRootUri, section);
    },
    async loadActiveLlmProviderConfig(conversationId) {
      const paths = await getReadyPaths();
      await ensureLlmSettingsRoots(paths);
      const configs = (await loadLlmProviderConfigsSettings(paths)).settings.configs;
      if (conversationId) {
        const conversationSettings = await this.loadConversationSettings(conversationId, 'llm');
        const llmSettings = conversationSettings?.settings as ConversationLlmSettingsRecord | undefined;
        const activeProviderConfigId = llmSettings?.activeProviderConfigId;
        const conversationConfig = activeProviderConfigId ? configs.find((config) => config.id === activeProviderConfigId) : undefined;
        if (conversationConfig) return applyConversationModelOverride(conversationConfig, llmSettings);
      }
      const stored = await loadNormalizedLlmGlobalSettings(paths);
      const activeConfigId = (stored.settings as LlmSettingsRecord).activeProviderConfigId;
      return configs.find((config) => config.id === activeConfigId) ?? configs[0]!;
    },
    async loadLlmProviderConfigById(configId) {
      const id = configId.trim();
      if (!id) return undefined;
      const paths = await getReadyPaths();
      await ensureLlmSettingsRoots(paths);
      return (await loadLlmProviderConfigsSettings(paths)).settings.configs.find((config) => config.id === id);
    },
    async loadActiveLlmCompressionConfig(providerConfigId, modelId) {
      const paths = await getReadyPaths();
      await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
      const configs = (await loadLlmCompressionConfigsSettings(paths)).settings.configs;
      const stored = await loadGlobalSettingsFile(paths.settingsRootUri, 'llmCompression');
      const settings = normalizeLlmCompressionSettings(stored.settings as Partial<LlmCompressionSettingsRecord> | undefined, configs);
      const model = modelId?.trim();
      const modelBinding = providerConfigId && model
        ? settings.modelBindings.find((candidate) => candidate.providerConfigId === providerConfigId && candidate.modelId === model)
        : undefined;
      const binding = providerConfigId
        ? settings.providerBindings.find((candidate) => candidate.providerConfigId === providerConfigId)
        : undefined;
      const id = modelBinding?.compressionConfigId ?? binding?.compressionConfigId ?? settings.defaultConfigId ?? configs[0]?.id;
      return configs.find((config) => config.id === id) ?? configs[0];
    },
    async loadLlmCompressionConfigById(configId) {
      const id = configId.trim();
      if (!id) return undefined;
      const paths = await getReadyPaths();
      return (await loadLlmCompressionConfigsSettings(paths)).settings.configs.find((config) => config.id === id);
    },
    async loadConversationSettings(conversationId, section) {
      const paths = await getReadyPaths();
      return withConversationDataTransaction(paths, conversationId, async () => {
        const uri = conversationSettingsUri(paths, conversationId, section);
        if (section === 'llm') {
          const settings = await readJson<ConversationLlmSettingsRecord>(uri);
          const normalized = normalizeConversationLlmSettings(conversationId, settings);
          if (normalized.activeProviderConfigId) {
            return { conversationId, section, settings: normalized, filePath: uri.fsPath };
          }

          const frozen = await freezeConversationLlmSettingsToCurrentGlobal(paths, conversationId, uri);
          return { conversationId, section, settings: frozen, filePath: uri.fsPath };
        }
        const settings = await readJson<ConversationSettingsRecord>(uri);
        return settings ? { conversationId, section, settings: normalizeConversationCommonSettings(conversationId, settings), filePath: uri.fsPath } : undefined;
      });
    },
    async saveConversationSettings(section, settings) {
      const paths = await getReadyPaths();
      const conversationId = (settings as ConversationSettingsRecord | ConversationLlmSettingsRecord).conversationId;
      const normalized = section === 'llm'
        ? normalizeConversationLlmSettings(conversationId, settings as Partial<ConversationLlmSettingsRecord>)
        : normalizeConversationCommonSettings(conversationId, settings as Partial<ConversationSettingsRecord>);
      const uri = conversationSettingsUri(paths, conversationId, section);
      await withConversationDataTransaction(paths, conversationId, async () => {
        await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
        await writeJson(uri, normalized);
      });
      return { conversationId, section, settings: normalized, filePath: uri.fsPath };
    }
  };
}

function conversationSettingsUri(paths: StoragePaths, conversationId: string, section: string): vscode.Uri {
  return vscode.Uri.joinPath(paths.settingsRootUri, `conversation-${conversationSettingsFileName(conversationId)}-${section}.json`);
}

async function ensureLlmSettingsRoots(paths: StoragePaths): Promise<void> {
  await vscode.workspace.fs.createDirectory(paths.settingsRootUri);
}

async function loadNormalizedLlmGlobalSettings(paths: StoragePaths): Promise<{ section: 'llm'; settings: LlmSettingsRecord; filePath: string }> {
  await ensureLlmSettingsRoots(paths);
  const configs = (await loadLlmProviderConfigsSettings(paths)).settings.configs;
  const stored = await loadGlobalSettingsFile(paths.settingsRootUri, 'llm');
  const settings = stored.settings as LlmSettingsRecord;
  const activeConfig = configs.find((config) => config.id === settings.activeProviderConfigId) ?? configs[0];
  const normalized: LlmSettingsRecord = { activeProviderConfigId: activeConfig?.id ?? '' };
  if (settings.activeProviderConfigId !== normalized.activeProviderConfigId) {
    await writeGlobalSettingsFile(paths.settingsRootUri, 'llm', normalized);
    return loadGlobalSettingsFile(paths.settingsRootUri, 'llm') as Promise<{ section: 'llm'; settings: LlmSettingsRecord; filePath: string }>;
  }
  return stored as { section: 'llm'; settings: LlmSettingsRecord; filePath: string };
}

function normalizeConversationCommonSettings(conversationId: string, settings: Partial<ConversationSettingsRecord> | undefined): ConversationSettingsRecord {
  return { conversationId, name: typeof settings?.name === 'string' ? settings.name : '' };
}

async function freezeConversationLlmSettingsToCurrentGlobal(
  paths: StoragePaths,
  conversationId: string,
  uri: vscode.Uri
): Promise<ConversationLlmSettingsRecord> {
  await ensureLlmSettingsRoots(paths);
  const configs = (await loadLlmProviderConfigsSettings(paths)).settings.configs;
  const global = await loadNormalizedLlmGlobalSettings(paths);
  const activeProviderConfigId = (global.settings as LlmSettingsRecord).activeProviderConfigId;
  const activeConfig = configs.find((config) => config.id === activeProviderConfigId) ?? configs[0];
  const frozen = normalizeConversationLlmSettings(conversationId, { activeProviderConfigId: activeConfig?.id ?? '' });
  await writeJson(uri, frozen);
  return frozen;
}

function normalizeConversationLlmSettings(
  conversationId: string,
  settings: Partial<ConversationLlmSettingsRecord> | undefined = undefined
): ConversationLlmSettingsRecord {
  const modelOverrides = normalizeModelOverrides(settings?.modelOverrides);
  return {
    conversationId,
    activeProviderConfigId: typeof settings?.activeProviderConfigId === 'string' ? settings.activeProviderConfigId.trim() : '',
    ...(modelOverrides ? { modelOverrides } : {})
  };
}

function normalizeModelOverrides(value: ConversationLlmSettingsRecord['modelOverrides'] | undefined): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result: Record<string, string> = {};
  for (const [rawConfigId, rawModelId] of Object.entries(value)) {
    const configId = rawConfigId.trim();
    const modelId = rawModelId.trim();
    if (configId && modelId) result[configId] = modelId;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function applyConversationModelOverride(config: LlmProviderConfigRecord, settings: ConversationLlmSettingsRecord | undefined): LlmProviderConfigRecord {
  const model = settings?.modelOverrides?.[config.id]?.trim();
  if (!model || model === config.model || !modelExistsInConfig(config, model)) return config;
  return { ...config, model };
}

function modelExistsInConfig(config: LlmProviderConfigRecord, model: string): boolean {
  const id = model.trim();
  if (!id) return false;
  return config.model?.trim() === id || config.models.some((candidate) => candidate.id.trim() === id);
}
