import * as vscode from 'vscode';
import type {
  LlmGenerationConfigRecord,
  LlmProviderConfigRecord,
  LlmProviderConfigsRecord,
  LlmProviderHeadersRecord,
  LlmProviderKind,
  LlmOpenAIResponsesTransport,
  LlmProviderModelConfigRecord,
  LlmProviderModelRecord,
  LlmPromptCacheConfigRecord,
  LlmPromptCacheMode,
  LlmPromptCacheTtl,
  LlmRequestBodyJsonValue,
  LlmRequestBodyRecord,
  LlmThinkingConfigRecord,
  LlmThinkingLevel,
  LlmToolCallFormat
} from '../../../shared/protocol';
import {
  DEFAULT_LLM_CONTEXT_WINDOW_TOKENS,
  DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
  DEFAULT_LLM_RETRY_DELAY_SECONDS,
  MAX_LLM_RETRY_DELAY_SECONDS,
  DEFAULT_LLM_RETRY_ON_ERROR,
  createDefaultLlmPromptCacheConfig,
  createMessageId,
  defaultLlmPromptCacheModeForProvider,
  defaultLlmPromptCacheTtlForProvider
} from '../../../shared/protocol';
import { normalizeOpenAIResponsesNativeSettings } from '../../../shared/openAIResponsesCapabilities';
import { DEFAULT_LLM_BASE_URL } from '../llmProvider';
import { isSettingsRevisionConflictError } from '../settingsRevisionConflict';
import type { StoragePaths } from './paths';
import { INDEX_FILE } from './constants';
import {
  commitRecordStoreSnapshot,
  loadRecordStoreSnapshot,
  missingRecordStoreRevision,
  type RecordStoreSnapshot
} from './recordStore';

const RECORD_KEY = 'config';
const CONFIGS_DIR = 'llm-provider-configs';
const DEFAULT_CONFIG_NAME = '默认渠道';
const REVISION_SECTION = 'llmProviderConfigs';

export interface LlmProviderConfigsSettingsResult {
  settings: LlmProviderConfigsRecord;
  filePath: string;
  revision: string;
  previousSettings?: LlmProviderConfigsRecord;
}

export async function loadLlmProviderConfigsSettings(paths: StoragePaths): Promise<LlmProviderConfigsSettingsResult> {
  const root = configsRootUri(paths);
  const indexUri = configsIndexUri(paths);
  const snapshot = await loadRecordStoreSnapshot<LlmProviderConfigRecord, typeof RECORD_KEY>(root, indexUri, RECORD_KEY);
  if (snapshot && snapshot.records.length > 0) return providerSettingsFromSnapshot(indexUri, snapshot);

  const config = createDefaultLlmProviderConfig({ name: DEFAULT_CONFIG_NAME });
  try {
    const initialized = await commitRecordStoreSnapshot(root, indexUri, [config], RECORD_KEY, (record) => record.name, {
      expectedRevision: snapshot?.revision ?? missingRecordStoreRevision(indexUri),
      section: REVISION_SECTION,
      pruneMissing: true
    });
    return providerSettingsFromSnapshot(indexUri, initialized);
  } catch (error) {
    if (!isSettingsRevisionConflictError(error)) throw error;
    const current = await loadRecordStoreSnapshot<LlmProviderConfigRecord, typeof RECORD_KEY>(root, indexUri, RECORD_KEY);
    if (!current || current.records.length === 0) throw error;
    return providerSettingsFromSnapshot(indexUri, current);
  }
}

export async function saveLlmProviderConfigsSettings(
  paths: StoragePaths,
  settings: Partial<LlmProviderConfigsRecord> | undefined,
  expectedRevision: string
): Promise<LlmProviderConfigsSettingsResult> {
  const configs = normalizeConfigList(settings?.configs);
  if (configs.length === 0) {
    throw new Error('至少需要保留一个渠道配置。');
  }

  const indexUri = configsIndexUri(paths);
  const committed = await commitRecordStoreSnapshot(
    configsRootUri(paths),
    indexUri,
    configs,
    RECORD_KEY,
    (record) => record.name,
    { expectedRevision, section: REVISION_SECTION, pruneMissing: true }
  );
  return {
    ...providerSettingsFromSnapshot(indexUri, committed),
    previousSettings: providerSettingsFromRecords(committed.previousRecords)
  };
}

export function createDefaultLlmProviderConfig(input: { name?: string } = {}): LlmProviderConfigRecord {
  const now = Date.now();
  return {
    id: createConfigId(),
    name: input.name?.trim() || DEFAULT_CONFIG_NAME,
    provider: 'openai-compatible',
    baseUrl: DEFAULT_LLM_BASE_URL,
    model: '',
    models: [],
    apiKey: '',
    toolCallFormat: 'function-call',
    openaiResponsesTransport: 'http',
    stream: true,
    retryOnError: DEFAULT_LLM_RETRY_ON_ERROR,
    retryMaxAttempts: DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
    retryDelaySeconds: DEFAULT_LLM_RETRY_DELAY_SECONDS,
    enableMultimodalTools: true,
    contextWindowTokens: DEFAULT_LLM_CONTEXT_WINDOW_TOKENS,
    systemPromptPrefix: '',
    promptCache: createDefaultLlmPromptCacheConfig('openai-compatible'),
    modelConfigs: [],
    createdAt: now,
    updatedAt: now
  };
}

export function normalizeLlmProviderConfig(input: Partial<LlmProviderConfigRecord> | undefined): LlmProviderConfigRecord {
  const fallback = createDefaultLlmProviderConfig();
  const createdAt = finiteTimestamp(input?.createdAt, fallback.createdAt);
  const updatedAt = finiteTimestamp(input?.updatedAt, createdAt);
  const model = typeof input?.model === 'string' && input.model.trim() ? input.model.trim() : fallback.model;
  const models = normalizeProviderModels(input?.models, model);
  const provider = isKnownProvider(input?.provider) ? input.provider : fallback.provider;
  const headers = normalizeHeaders(input?.headers);
  const generationConfig = normalizeGenerationConfig(input?.generationConfig);
  const requestBody = normalizeRequestBody(input?.requestBody);
  const promptCache = normalizePromptCache(input?.promptCache, provider);
  const modelConfigs = normalizeModelConfigs(input?.modelConfigs, models, provider);
  const contextWindowTokens = finitePositiveInteger(input?.contextWindowTokens) ?? providerDefaultContextWindow(provider);
  const nativeResponses = normalizeOpenAIResponsesNativeSettings(input?.nativeResponses);
  return {
    id: stringOrDefault(input?.id, fallback.id),
    name: stringOrDefault(input?.name, fallback.name),
    provider,
    baseUrl: stringOrDefault(input?.baseUrl, fallback.baseUrl),
    model,
    models,
    apiKey: typeof input?.apiKey === 'string' ? input.apiKey.trim() : fallback.apiKey,
    toolCallFormat: isKnownToolCallFormat(input?.toolCallFormat) ? input.toolCallFormat : fallback.toolCallFormat,
    openaiResponsesTransport: normalizeOpenAIResponsesTransport(input?.openaiResponsesTransport),
    stream: typeof input?.stream === 'boolean' ? input.stream : true,
    retryOnError: typeof input?.retryOnError === 'boolean' ? input.retryOnError : DEFAULT_LLM_RETRY_ON_ERROR,
    retryMaxAttempts: finiteRetryMaxAttempts(input?.retryMaxAttempts) ?? DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
    retryDelaySeconds: finiteRetryDelaySeconds(input?.retryDelaySeconds) ?? DEFAULT_LLM_RETRY_DELAY_SECONDS,
    enableMultimodalTools: typeof input?.enableMultimodalTools === 'boolean' ? input.enableMultimodalTools : true,
    contextWindowTokens,
    systemPromptPrefix: normalizeSystemPromptPrefix(input?.systemPromptPrefix),
    promptCache,
    ...(nativeResponses ? { nativeResponses } : {}),
    ...(headers ? { headers } : {}),
    ...(generationConfig ? { generationConfig } : {}),
    ...(requestBody ? { requestBody } : {}),
    modelConfigs,
    createdAt,
    updatedAt
  };
}

function normalizeConfigList(input: LlmProviderConfigRecord[] | undefined): LlmProviderConfigRecord[] {
  const byId = new Map<string, LlmProviderConfigRecord>();
  for (const item of input ?? []) {
    const config = normalizeLlmProviderConfig({ ...item, updatedAt: Date.now() });
    byId.set(config.id, config);
  }
  return sortConfigs([...byId.values()]);
}

function providerSettingsFromSnapshot(
  indexUri: vscode.Uri,
  snapshot: RecordStoreSnapshot<LlmProviderConfigRecord>
): LlmProviderConfigsSettingsResult {
  return {
    settings: providerSettingsFromRecords(snapshot.records),
    filePath: indexUri.fsPath,
    revision: snapshot.revision
  };
}

function providerSettingsFromRecords(records: LlmProviderConfigRecord[]): LlmProviderConfigsRecord {
  return { configs: sortConfigs(records.map((record) => normalizeLlmProviderConfig(record))) };
}

function configsRootUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(paths.settingsRootUri, CONFIGS_DIR);
}

function configsIndexUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(configsRootUri(paths), INDEX_FILE);
}

function createConfigId(): string {
  return `llm-provider-config-${createMessageId()}`;
}

function sortConfigs(records: LlmProviderConfigRecord[]): LlmProviderConfigRecord[] {
  return [...records].sort((left, right) => left.createdAt - right.createdAt || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function normalizeProviderModels(input: LlmProviderModelRecord[] | undefined, activeModel: string): LlmProviderModelRecord[] {
  const byId = new Map<string, LlmProviderModelRecord>();
  for (const item of input ?? []) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id) continue;
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id;
    const createdAt = typeof item.createdAt === 'string' && item.createdAt.trim() ? item.createdAt.trim() : undefined;
    byId.set(id, { id, name, ...(createdAt ? { createdAt } : {}) });
  }

  if (activeModel && !byId.has(activeModel)) {
    byId.set(activeModel, { id: activeModel, name: activeModel });
  }

  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeModelConfigs(
  input: unknown,
  models: LlmProviderModelRecord[],
  provider: LlmProviderKind
): LlmProviderModelConfigRecord[] {
  if (!Array.isArray(input)) return [];
  const availableModelIds = new Set(models.map((model) => model.id));
  const byModelId = new Map<string, LlmProviderModelConfigRecord>();
  for (const item of input) {
    if (!isPlainObject(item)) continue;
    const modelId = typeof item.modelId === 'string' ? item.modelId.trim() : '';
    if (!modelId || !availableModelIds.has(modelId)) continue;
    const now = Date.now();
    const createdAt = finiteTimestamp(item.createdAt, now);
    const updatedAt = finiteTimestamp(item.updatedAt, createdAt);
    const headers = normalizeHeaders(item.headers);
    const generationConfig = normalizeGenerationConfig(item.generationConfig);
    const requestBody = normalizeRequestBody(item.requestBody);
    const promptCache = normalizePromptCache(item.promptCache, provider);
    const nativeResponses = normalizeOpenAIResponsesNativeSettings(item.nativeResponses);
    byModelId.set(modelId, {
      id: stringOrDefault(item.id, `llm-model-config-${createMessageId()}`),
      modelId,
      toolCallFormat: isKnownToolCallFormat(item.toolCallFormat) ? item.toolCallFormat : 'function-call',
      openaiResponsesTransport: normalizeOpenAIResponsesTransport(item.openaiResponsesTransport),
      stream: typeof item.stream === 'boolean' ? item.stream : true,
      retryOnError: typeof item.retryOnError === 'boolean' ? item.retryOnError : DEFAULT_LLM_RETRY_ON_ERROR,
      retryMaxAttempts: finiteRetryMaxAttempts(item.retryMaxAttempts) ?? DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
      retryDelaySeconds: finiteRetryDelaySeconds(item.retryDelaySeconds) ?? DEFAULT_LLM_RETRY_DELAY_SECONDS,
      enableMultimodalTools: typeof item.enableMultimodalTools === 'boolean' ? item.enableMultimodalTools : true,
      contextWindowTokens: finitePositiveInteger(item.contextWindowTokens) ?? providerDefaultContextWindow(provider),
      systemPromptPrefix: normalizeSystemPromptPrefix(item.systemPromptPrefix),
      promptCache,
      ...(nativeResponses ? { nativeResponses } : {}),
      ...(headers ? { headers } : {}),
      ...(generationConfig ? { generationConfig } : {}),
      ...(requestBody ? { requestBody } : {}),
      createdAt,
      updatedAt
    });
  }
  return [...byModelId.values()].sort((left, right) => {
    const leftIndex = models.findIndex((model) => model.id === left.modelId);
    const rightIndex = models.findIndex((model) => model.id === right.modelId);
    return leftIndex - rightIndex || left.modelId.localeCompare(right.modelId) || left.id.localeCompare(right.id);
  });
}

function isKnownProvider(provider: unknown): provider is LlmProviderKind {
  return provider === 'openai-compatible' || provider === 'openai-responses' || provider === 'claude' || provider === 'gemini' || provider === 'deepseek';
}

function providerDefaultContextWindow(_provider: LlmProviderKind): number {
  return DEFAULT_LLM_CONTEXT_WINDOW_TOKENS;
}

function isKnownToolCallFormat(format: unknown): format is LlmToolCallFormat {
  return format === 'function-call';
}

function normalizeOpenAIResponsesTransport(value: unknown): LlmOpenAIResponsesTransport {
  return value === 'websocket' ? 'websocket' : 'http';
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeSystemPromptPrefix(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function finiteTimestamp(value: unknown, fallback: number): number {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
}

function finitePositiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function finiteRetryDelaySeconds(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const seconds = Math.floor(number);
  if (seconds <= 0) return 0;
  return Math.min(seconds, MAX_LLM_RETRY_DELAY_SECONDS);
}

function finiteRetryMaxAttempts(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const attempts = Math.floor(number);
  return attempts < -1 ? -1 : attempts;
}

function normalizeHeaders(input: unknown): LlmProviderHeadersRecord | undefined {
  if (!isPlainObject(input)) return undefined;
  const headers: LlmProviderHeadersRecord = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') continue;
    headers[key] = String(rawValue).trim();
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function normalizeGenerationConfig(input: unknown): LlmGenerationConfigRecord | undefined {
  if (!isPlainObject(input)) return undefined;
  const config: LlmGenerationConfigRecord = {};
  assignFiniteNumber(config, 'temperature', input.temperature);
  assignFiniteNumber(config, 'topP', input.topP);
  assignFiniteNumber(config, 'topK', input.topK);
  assignFiniteNumber(config, 'maxOutputTokens', input.maxOutputTokens);

  const thinkingConfig = normalizeThinkingConfig(input.thinkingConfig);
  if (thinkingConfig) config.thinkingConfig = thinkingConfig;

  return Object.keys(config).length > 0 ? config : undefined;
}

function normalizeThinkingConfig(input: unknown): LlmThinkingConfigRecord | undefined {
  if (!isPlainObject(input)) return undefined;
  const config: LlmThinkingConfigRecord = {};
  if (typeof input.includeThoughts === 'boolean') config.includeThoughts = input.includeThoughts;
  assignFiniteNumber(config, 'thinkingBudget', input.thinkingBudget);
  if (isKnownThinkingLevel(input.thinkingLevel)) config.thinkingLevel = input.thinkingLevel;
  if (isKnownReasoningMode(input.reasoningMode)) config.reasoningMode = input.reasoningMode;
  return Object.keys(config).length > 0 ? config : undefined;
}

function assignFiniteNumber(target: object, key: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  (target as Record<string, unknown>)[key] = value;
}

function isKnownThinkingLevel(value: unknown): value is LlmThinkingLevel {
  return value === 'not-set'
    || value === 'non-set'
    || value === 'none'
    || value === 'minimal'
    || value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'xhigh'
    || value === 'max';
}

function isKnownReasoningMode(value: unknown): value is NonNullable<LlmThinkingConfigRecord['reasoningMode']> {
  return value === 'standard' || value === 'pro';
}

function normalizePromptCache(input: unknown, provider: LlmProviderKind): LlmPromptCacheConfigRecord {
  if (!isPlainObject(input)) return createDefaultLlmPromptCacheConfig(provider);
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
    mode: normalizePromptCacheMode(input.mode, provider),
    ttl: normalizePromptCacheTtl(input.ttl, provider)
  };
}

function normalizePromptCacheMode(input: unknown, provider: LlmProviderKind): LlmPromptCacheMode {
  if (provider === 'openai-responses' && input === 'explicit') return 'explicit';
  return defaultLlmPromptCacheModeForProvider(provider);
}

function normalizePromptCacheTtl(input: unknown, provider: LlmProviderKind): LlmPromptCacheTtl {
  if (provider === 'openai-responses') return '30m';
  if (provider === 'claude') return input === '5m' || input === '1h' ? input : defaultLlmPromptCacheTtlForProvider(provider);
  return defaultLlmPromptCacheTtlForProvider(provider);
}

function normalizeRequestBody(input: unknown): LlmRequestBodyRecord | undefined {
  if (!isPlainObject(input)) return undefined;
  const record: LlmRequestBodyRecord = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) continue;
    const value = normalizeJsonValue(rawValue);
    if (value !== undefined) record[key] = value;
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function normalizeJsonValue(value: unknown): LlmRequestBodyJsonValue | undefined {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items: LlmRequestBodyJsonValue[] = [];
    for (const item of value) {
      const normalized = normalizeJsonValue(item);
      if (normalized !== undefined) items.push(normalized);
    }
    return items;
  }
  if (isPlainObject(value)) {
    const record: Record<string, LlmRequestBodyJsonValue> = {};
    for (const [rawKey, rawChild] of Object.entries(value)) {
      const key = rawKey.trim();
      if (!key) continue;
      const child = normalizeJsonValue(rawChild);
      if (child !== undefined) record[key] = child;
    }
    return record;
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
