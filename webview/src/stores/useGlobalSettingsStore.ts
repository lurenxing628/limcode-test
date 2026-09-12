import { defineStore } from 'pinia';
import { normalizeDebugCaptureSettings, type DebugCaptureSettings } from '@shared/debugCapture';
import {
  GLOBAL_SETTINGS_SECTIONS,
  type AttachmentSettingsRecord,
  type AppearanceSettingsRecord,
  createMessageId,
  DEFAULT_LLM_COMPRESSION_TRIGGER_PERCENT,
  normalizeLlmCompressionBodyTargetTokens,
  normalizeLlmCompressionMaxDurationMinutes,
  DEFAULT_LLM_CONTEXT_WINDOW_TOKENS,
  DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
  DEFAULT_LLM_RETRY_DELAY_SECONDS,
  MAX_LLM_RETRY_DELAY_SECONDS,
  DEFAULT_LLM_RETRY_ON_ERROR,
  createDefaultLlmPromptCacheConfig,
  defaultLlmPromptCacheModeForProvider,
  defaultLlmPromptCacheTtlForProvider,
  type CheckpointMaintenanceSettingsRecord,
  type GlobalSettingsRecord,
  type NetworkSettingsRecord,
  type GlobalSettingsSection,
  type GlobalSettingsSectionValue,
  type GlobalSettingsSnapshotPayload,
  type GlobalSettingsUpdatePayload,
  type LlmGenerationConfigRecord,
  type LlmCompressionConfigRecord,
  type LlmCompressionConfigsRecord,
  type LlmCompressionModelBindingRecord,
  type LlmCompressionThresholdUnit,
  type LlmCompressionSettingsRecord,
  type LlmProviderKind,
  type LlmProviderHeadersRecord,
  type LlmOpenAIResponsesTransport,
  type LlmProviderConfigRecord,
  type LlmProviderModelConfigRecord,
  type LlmProviderModelRecord,
  type LlmPromptCacheConfigRecord,
  type LlmPromptCacheMode,
  type LlmPromptCacheTtl,
  type LlmRequestBodyJsonValue,
  type LlmRequestBodyRecord,
  type LlmProviderModelsSnapshotPayload,
  type LlmProviderConfigsRecord,
  type LlmSettingsRecord,
  type McpServerConfigRecord,
  type McpServersSettingsRecord,
  type McpServerTransportRecord
} from '@shared/protocol';
import { createDefaultLlmCompressionConfig } from '@shared/protocol';
import { normalizeOpenAIResponsesNativeSettings } from '@shared/openAIResponsesCapabilities';
import type { OpenAIResponsesNativeSettings } from '@shared/openAIResponsesNative';
import { bridge, BridgeMessageType } from '@webview/transport';

type SelectableCompressionMethodKind = 'openai_responses_compact' | 'llm_summary' | 'segmented_summary' | 'deterministic_summary';
const TOKEN_STEP = 1_000;
const CHANNEL_SETTINGS_SECTIONS = ['llm', 'llmProviderConfigs', 'llmCompression', 'llmCompressionConfigs'] as const satisfies readonly GlobalSettingsSection[];
type GlobalSettingsSectionMessages = Partial<Record<GlobalSettingsSection, string>>;

interface FetchedModelsDialogState {
  open: boolean;
  loading: boolean;
  configId: string;
  models: LlmProviderModelRecord[];
}

interface GlobalSettingsState {
  common: GlobalSettingsRecord;
  network: NetworkSettingsRecord;
  /** LLM 全局选择信息：只保存当前激活的可复用渠道配置 id。 */
  llm: LlmSettingsRecord;
  /** 全局范围内可复用的渠道配置集合。 */
  llmProviderConfigs: LlmProviderConfigsRecord;
  llmCompression: LlmCompressionSettingsRecord;
  llmCompressionConfigs: LlmCompressionConfigsRecord;
  /** 存档点维护：自动清理未使用 shadow 仓库的设置。 */
  checkpointMaintenance: CheckpointMaintenanceSettingsRecord;
  /** 外观：自定义流式状态文字。 */
  appearance: AppearanceSettingsRecord;
  /** 附件：控制 base64 小附件托管阈值。 */
  attachments: AttachmentSettingsRecord;
  mcpServers: McpServersSettingsRecord;
  debugCapture: DebugCaptureSettings;
  /** 各 section 的来源文件路径，用于在 UI 展示。 */
  filePaths: Partial<Record<GlobalSettingsSection, string>>;
  /** 各 section 最近一次已确认内容的指纹。 */
  revisions: Partial<Record<GlobalSettingsSection, string>>;
  /** 已确认内容，用来判断本地表单是否还有未保存修改。 */
  baselines: Partial<Record<GlobalSettingsSection, GlobalSettingsSectionValue>>;
  /** 本窗口有未保存修改时，暂存其他窗口发来的新内容。 */
  pendingExternalSnapshots: Partial<Record<GlobalSettingsSection, GlobalSettingsSnapshotPayload>>;
  externalChangedSections: Partial<Record<GlobalSettingsSection, boolean>>;
  /** 等待 llmProviderConfigs 保存完成后再持久化的 active provider id，避免 active id 先于新配置到达后端。 */
  pendingActiveProviderConfigIdAfterConfigsSave: string;
  /** 克隆压缩配置后待 llmCompressionConfigs 保存确认再持久化压缩绑定，避免绑定先于新配置到达后端被丢弃。 */
  flushCompressionBindingAfterConfigsSave: boolean;
  /** 已收到后端 snapshot 的全局设置 section。 */
  loadedSections: Partial<Record<GlobalSettingsSection, boolean>>;
  /** 已发起读取，正在等待后端 snapshot 的全局设置 section。 */
  loadingSettingsSections: Partial<Record<GlobalSettingsSection, boolean>>;
  /** 获取模型后等待用户选择导入的临时列表。 */
  fetchedModelsDialog: FetchedModelsDialogState;
  /** 已发起更新，正在等待后端 snapshot 确认的全局设置 section。 */
  pendingSettingsSections: Partial<Record<GlobalSettingsSection, boolean>>;
  failedSettingsSections: GlobalSettingsSectionMessages;
  status: string;
}

interface GlobalSettingsErrorOptions {
  requestType?: string;
  section?: GlobalSettingsSection;
  correlationId?: string;
  code?: 'settings_revision_conflict';
  actualRevision?: string;
}

function hasOutstandingSettingsWork(state: GlobalSettingsState): boolean {
  return Object.keys(state.loadingSettingsSections).length > 0 || Object.keys(state.pendingSettingsSections).length > 0;
}

function settleSettingsStatus(state: GlobalSettingsState, status: string): void {
  if (hasOutstandingSettingsWork(state) || Object.keys(state.failedSettingsSections).length > 0) return;
  state.status = status;
}

function settingsErrorStatus(requestType: string | undefined, message: string): string {
  if (requestType === BridgeMessageType.GlobalSettingsGet) return `设置读取失败：${message}`;
  if (requestType === BridgeMessageType.LlmProviderModelsGet) return `获取 LLM 列表失败：${message}`;
  return `设置保存失败：${message}`;
}

function emptyCommon(): GlobalSettingsRecord {
  return { dataFilePath: '', proxy: '', proxyShellAndMcp: false, activeDataRootPath: '', defaultDataRootPath: '' };
}

function emptyNetwork(): NetworkSettingsRecord {
  return { userAgent: '' };
}

function emptyLlm(): LlmSettingsRecord {
  return { activeProviderConfigId: '' };
}

function emptyLlmProviderConfigs(): LlmProviderConfigsRecord {
  return { configs: [] };
}

function emptyLlmCompression(): LlmCompressionSettingsRecord {
  return { providerBindings: [], modelBindings: [] };
}

function emptyLlmCompressionConfigs(): LlmCompressionConfigsRecord {
  return { configs: [] };
}

function emptyCheckpointMaintenance(): CheckpointMaintenanceSettingsRecord {
  return { autoCleanupEnabled: true, autoCleanupDays: 7, autoDismissEnabled: true, autoDismissSeconds: 5 };
}

function emptyAppearance(): AppearanceSettingsRecord {
  return {
    streamingTextPreparing: '...少女整理中',
    streamingTextWaiting: '...少女等待中',
    streamingTextThinking: '...少女思考中',
    streamingTextWriting: '...少女编写中',
    streamingTextToolExecuting: '...少女执行中'
  };
}

function emptyAttachments(): AttachmentSettingsRecord {
  return { maxStoredInlineFileMb: 20 };
}

function emptyMcpServers(): McpServersSettingsRecord {
  return { servers: [] };
}

function emptyFetchedModelsDialog(): FetchedModelsDialogState {
  return { open: false, loading: false, configId: '', models: [] };
}

function providerDefaultBaseUrl(provider: LlmProviderKind): string {
  switch (provider) {
    case 'claude':
      return 'https://api.anthropic.com/v1';
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta';
    case 'deepseek':
      return 'https://api.deepseek.com/v1';
    case 'openai-responses':
    case 'openai-compatible':
    default:
      return 'https://api.openai.com/v1';
  }
}

function providerDefaultContextWindow(_provider: LlmProviderKind): number {
  return DEFAULT_LLM_CONTEXT_WINDOW_TOKENS;
}

function providerDefaultPromptCache(provider: LlmProviderKind): LlmPromptCacheConfigRecord {
  return createDefaultLlmPromptCacheConfig(provider);
}

function createDefaultProviderConfig(name = '新渠道配置', provider: LlmProviderKind = 'openai-compatible'): LlmProviderConfigRecord {
  const now = Date.now();
  return {
    id: `llm-provider-config-${createMessageId()}`,
    name,
    provider,
    baseUrl: providerDefaultBaseUrl(provider),
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
    contextWindowTokens: providerDefaultContextWindow(provider),
    systemPromptPrefix: '',
    promptCache: providerDefaultPromptCache(provider),
    headers: {},
    generationConfig: {},
    requestBody: {},
    modelConfigs: [],
    createdAt: now,
    updatedAt: now
  };
}

function createModelConfigFromProviderConfig(config: LlmProviderConfigRecord, modelId: string): LlmProviderModelConfigRecord {
  const now = Date.now();
  const nativeResponses = normalizeOpenAIResponsesNativeSettings(config.nativeResponses);
  return {
    id: `llm-model-config-${slugId(modelId)}-${createMessageId()}`,
    modelId,
    toolCallFormat: config.toolCallFormat,
    openaiResponsesTransport: normalizeOpenAIResponsesTransport(config.openaiResponsesTransport),
    stream: config.stream !== false,
    retryOnError: config.retryOnError !== false,
    retryMaxAttempts: normalizeRetryMaxAttempts(config.retryMaxAttempts) ?? DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
    retryDelaySeconds: normalizeRetryDelaySeconds(config.retryDelaySeconds) ?? DEFAULT_LLM_RETRY_DELAY_SECONDS,
    enableMultimodalTools: config.enableMultimodalTools !== false,
    contextWindowTokens: normalizeTokenCount(config.contextWindowTokens) ?? providerDefaultContextWindow(config.provider),
    systemPromptPrefix: normalizeSystemPromptPrefix(config.systemPromptPrefix),
    promptCache: normalizePromptCacheForUi(config.promptCache, config.provider),
    ...(nativeResponses ? { nativeResponses } : {}),
    headers: sanitizeHeaders(config.headers) ?? {},
    generationConfig: normalizeGenerationConfigForUi(config.generationConfig) ?? {},
    requestBody: sanitizeRequestBody(config.requestBody) ?? {},
    createdAt: now,
    updatedAt: now
  };
}

function createDefaultMcpServerConfig(name = '新 MCP 服务', transportKind: McpServerTransportRecord['kind'] = 'stdio'): McpServerConfigRecord {
  const now = Date.now();
  const id = `mcp-${slugId(name)}-${createMessageId()}`;
  return {
    id,
    name,
    enabled: false,
    transport: transportKind === 'http'
      ? { kind: 'http', url: 'http://127.0.0.1:3000/mcp', headers: {} }
      : { kind: 'stdio', command: '', args: [], env: {} },
    createdAt: now,
    updatedAt: now
  };
}

function slugId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'server';
}

function isDuplicateMcpServerName(servers: readonly McpServerConfigRecord[], name: string, excludeServerId?: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  return servers.some((server) => server.id !== excludeServerId && server.name.trim().toLowerCase() === normalized);
}

function normalizeProviderConfigForUi(config: LlmProviderConfigRecord): LlmProviderConfigRecord {
  const model = config.model?.trim() ?? '';
  const provider = config.provider;
  const models = normalizeModelsForUi(config.models, model);
  return {
    ...config,
    provider,
    model,
    models,
    openaiResponsesTransport: normalizeOpenAIResponsesTransport(config.openaiResponsesTransport),
    stream: config.stream !== false,
    retryOnError: config.retryOnError !== false,
    retryMaxAttempts: normalizeRetryMaxAttempts(config.retryMaxAttempts) ?? DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
    retryDelaySeconds: normalizeRetryDelaySeconds(config.retryDelaySeconds) ?? DEFAULT_LLM_RETRY_DELAY_SECONDS,
    enableMultimodalTools: config.enableMultimodalTools !== false,
    contextWindowTokens: normalizeTokenCount(config.contextWindowTokens) ?? providerDefaultContextWindow(provider),
    systemPromptPrefix: normalizeSystemPromptPrefix(config.systemPromptPrefix),
    promptCache: normalizePromptCacheForUi(config.promptCache, provider),
    headers: sanitizeHeaders(config.headers) ?? {},
    generationConfig: normalizeGenerationConfigForUi(config.generationConfig) ?? {},
    requestBody: sanitizeRequestBody(config.requestBody) ?? {},
    modelConfigs: normalizeModelConfigsForUi(config.modelConfigs, models, provider)
  };
}

function normalizeModelsForUi(models: LlmProviderModelRecord[] | undefined, activeModel: string): LlmProviderModelRecord[] {
  const byId = new Map<string, LlmProviderModelRecord>();
  for (const item of models ?? []) {
    const id = item.id.trim();
    if (!id) continue;
    const name = item.name.trim() || id;
    const createdAt = item.createdAt?.trim();
    byId.set(id, { id, name, ...(createdAt ? { createdAt } : {}) });
  }
  if (activeModel && !byId.has(activeModel)) byId.set(activeModel, { id: activeModel, name: activeModel });
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeModelConfigsForUi(
  configs: LlmProviderModelConfigRecord[] | undefined,
  models: LlmProviderModelRecord[],
  provider: LlmProviderKind
): LlmProviderModelConfigRecord[] {
  const availableModelIds = new Set(models.map((model) => model.id));
  const byModelId = new Map<string, LlmProviderModelConfigRecord>();
  for (const config of configs ?? []) {
    const modelId = config.modelId?.trim() ?? '';
    if (!modelId || !availableModelIds.has(modelId)) continue;
    byModelId.set(modelId, normalizeModelConfigForUi(config, modelId, provider));
  }
  return [...byModelId.values()].sort((left, right) => {
    const leftIndex = models.findIndex((model) => model.id === left.modelId);
    const rightIndex = models.findIndex((model) => model.id === right.modelId);
    return leftIndex - rightIndex || left.modelId.localeCompare(right.modelId) || left.id.localeCompare(right.id);
  });
}

function normalizeModelConfigForUi(config: LlmProviderModelConfigRecord, modelId: string, provider: LlmProviderKind): LlmProviderModelConfigRecord {
  const now = Date.now();
  const nativeResponses = normalizeOpenAIResponsesNativeSettings(config.nativeResponses);
  return {
    id: config.id?.trim() || `llm-model-config-${createMessageId()}`,
    modelId,
    toolCallFormat: config.toolCallFormat === 'function-call' ? config.toolCallFormat : 'function-call',
    openaiResponsesTransport: normalizeOpenAIResponsesTransport(config.openaiResponsesTransport),
    stream: config.stream !== false,
    retryOnError: config.retryOnError !== false,
    retryMaxAttempts: normalizeRetryMaxAttempts(config.retryMaxAttempts) ?? DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
    retryDelaySeconds: normalizeRetryDelaySeconds(config.retryDelaySeconds) ?? DEFAULT_LLM_RETRY_DELAY_SECONDS,
    enableMultimodalTools: config.enableMultimodalTools !== false,
    contextWindowTokens: normalizeTokenCount(config.contextWindowTokens) ?? providerDefaultContextWindow(provider),
    systemPromptPrefix: normalizeSystemPromptPrefix(config.systemPromptPrefix),
    promptCache: normalizePromptCacheForUi(config.promptCache, provider),
    ...(nativeResponses ? { nativeResponses } : {}),
    headers: sanitizeHeaders(config.headers) ?? {},
    generationConfig: normalizeGenerationConfigForUi(config.generationConfig) ?? {},
    requestBody: sanitizeRequestBody(config.requestBody) ?? {},
    createdAt: Number.isFinite(config.createdAt) && config.createdAt > 0 ? config.createdAt : now,
    updatedAt: Number.isFinite(config.updatedAt) && config.updatedAt > 0 ? config.updatedAt : now
  };
}

function normalizeOpenAIResponsesTransport(value: unknown): LlmOpenAIResponsesTransport {
  return value === 'websocket' ? 'websocket' : 'http';
}

function normalizePromptCacheForUi(input: LlmPromptCacheConfigRecord | undefined, provider: LlmProviderKind): LlmPromptCacheConfigRecord {
  if (!input || typeof input !== 'object') return providerDefaultPromptCache(provider);
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

function normalizeRetryDelaySeconds(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const seconds = Math.floor(number);
  if (seconds <= 0) return 0;
  return Math.min(seconds, MAX_LLM_RETRY_DELAY_SECONDS);
}

function normalizeRetryMaxAttempts(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const attempts = Math.floor(number);
  if (attempts < -1) return -1;
  return attempts;
}

function normalizeSystemPromptPrefix(value: unknown): string {
  return typeof value === 'string' ? value : '';
}


function sanitizeModels(models: LlmProviderModelRecord[]): LlmProviderModelRecord[] {
  const byId = new Map<string, LlmProviderModelRecord>();
  for (const item of models) {
    const id = item.id.trim();
    if (!id) continue;
    const name = item.name.trim() || id;
    const createdAt = item.createdAt?.trim();
    byId.set(id, { id, name, ...(createdAt ? { createdAt } : {}) });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function sanitizeModelConfigs(
  configs: LlmProviderModelConfigRecord[] | undefined,
  models: LlmProviderModelRecord[],
  provider: LlmProviderKind
): LlmProviderModelConfigRecord[] {
  const availableModelIds = new Set(models.map((model) => model.id));
  const byModelId = new Map<string, LlmProviderModelConfigRecord>();
  for (const config of configs ?? []) {
    const modelId = config.modelId.trim();
    if (!modelId || !availableModelIds.has(modelId)) continue;
    byModelId.set(modelId, toPlainModelConfig({ ...config, modelId }, provider));
  }
  return [...byModelId.values()].sort((left, right) => {
    const leftIndex = models.findIndex((model) => model.id === left.modelId);
    const rightIndex = models.findIndex((model) => model.id === right.modelId);
    return leftIndex - rightIndex || left.modelId.localeCompare(right.modelId) || left.id.localeCompare(right.id);
  });
}

function sanitizePromptCache(input: LlmPromptCacheConfigRecord | undefined, provider: LlmProviderKind): LlmPromptCacheConfigRecord {
  return normalizePromptCacheForUi(input, provider);
}

function sanitizeHeaders(input: LlmProviderHeadersRecord | undefined): LlmProviderHeadersRecord | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const headers: LlmProviderHeadersRecord = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') continue;
    headers[key] = String(rawValue).trim();
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function normalizeGenerationConfigForUi(input: LlmGenerationConfigRecord | undefined): LlmGenerationConfigRecord | undefined {
  return sanitizeGenerationConfig(input);
}

function sanitizeGenerationConfig(input: LlmGenerationConfigRecord | undefined): LlmGenerationConfigRecord | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const config: LlmGenerationConfigRecord = {};
  assignFiniteNumber(config, 'temperature', input.temperature);
  assignFiniteNumber(config, 'topP', input.topP);
  assignFiniteNumber(config, 'topK', input.topK);
  assignFiniteNumber(config, 'maxOutputTokens', input.maxOutputTokens);

  const thinkingConfig = input.thinkingConfig;
  if (thinkingConfig && typeof thinkingConfig === 'object') {
    const nextThinking: NonNullable<LlmGenerationConfigRecord['thinkingConfig']> = {};
    if (typeof thinkingConfig.includeThoughts === 'boolean') nextThinking.includeThoughts = thinkingConfig.includeThoughts;
    assignFiniteNumber(nextThinking, 'thinkingBudget', thinkingConfig.thinkingBudget);
    if (isKnownThinkingLevel(thinkingConfig.thinkingLevel)) nextThinking.thinkingLevel = thinkingConfig.thinkingLevel;
    if (isKnownReasoningMode(thinkingConfig.reasoningMode)) nextThinking.reasoningMode = thinkingConfig.reasoningMode;
    if (Object.keys(nextThinking).length > 0) config.thinkingConfig = nextThinking;
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

function assignFiniteNumber(target: object, key: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  (target as Record<string, unknown>)[key] = value;
}

function isKnownThinkingLevel(value: unknown): value is NonNullable<NonNullable<LlmGenerationConfigRecord['thinkingConfig']>['thinkingLevel']> {
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

function isKnownReasoningMode(value: unknown): value is NonNullable<NonNullable<LlmGenerationConfigRecord['thinkingConfig']>['reasoningMode']> {
  return value === 'standard' || value === 'pro';
}

function sanitizeRequestBody(input: LlmRequestBodyRecord | undefined): LlmRequestBodyRecord | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record: LlmRequestBodyRecord = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) continue;
    const value = sanitizeJsonValue(rawValue);
    if (value !== undefined) record[key] = value;
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function sanitizeJsonValue(value: unknown): LlmRequestBodyJsonValue | undefined {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items: LlmRequestBodyJsonValue[] = [];
    for (const item of value) {
      const normalized = sanitizeJsonValue(item);
      if (normalized !== undefined) items.push(normalized);
    }
    return items;
  }
  if (value && typeof value === 'object') {
    const record: Record<string, LlmRequestBodyJsonValue> = {};
    for (const [rawKey, rawChild] of Object.entries(value as Record<string, unknown>)) {
      const key = rawKey.trim();
      if (!key) continue;
      const child = sanitizeJsonValue(rawChild);
      if (child !== undefined) record[key] = child;
    }
    return record;
  }
  return undefined;
}

function normalizeTokenCount(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function alignTokenCountToK(value: number): number {
  return Math.max(TOKEN_STEP, Math.round(value / TOKEN_STEP) * TOKEN_STEP);
}

function clampTokenCount(value: number, contextWindowTokens?: number): number {
  const aligned = alignTokenCountToK(value);
  const normalizedWindow = normalizeTokenCount(contextWindowTokens);
  const alignedWindow = normalizedWindow !== undefined && normalizedWindow >= TOKEN_STEP
    ? Math.floor(normalizedWindow / TOKEN_STEP) * TOKEN_STEP
    : undefined;
  return alignedWindow === undefined ? aligned : Math.min(alignedWindow, aligned);
}

function clampPercent(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(100, Math.max(1, number));
}

function percentFromTokens(tokens: number | undefined, contextWindowTokens: number | undefined): number | undefined {
  if (!tokens || !contextWindowTokens) return undefined;
  return Math.min(100, Math.max(1, (tokens / contextWindowTokens) * 100));
}

function tokensFromPercent(percent: number | undefined, contextWindowTokens: number | undefined): number | undefined {
  if (!percent || !contextWindowTokens) return undefined;
  return clampTokenCount((contextWindowTokens * percent) / 100, contextWindowTokens);
}

function resolveThresholdTokens(trigger: LlmCompressionConfigRecord['trigger'] | undefined, contextWindowTokens: number | undefined): number | undefined {
  const thresholdTokens = trigger?.thresholdUnit === 'tokens' ? normalizeTokenCount(trigger.thresholdTokens) : undefined;
  if (thresholdTokens !== undefined) return clampTokenCount(thresholdTokens, contextWindowTokens);
  return tokensFromPercent(clampPercent(trigger?.thresholdPercent) ?? DEFAULT_LLM_COMPRESSION_TRIGGER_PERCENT, contextWindowTokens);
}

function normalizeCompressionTriggerForUi(
  input: LlmCompressionConfigRecord['trigger'] | undefined,
  contextWindowTokens?: number
): LlmCompressionConfigRecord['trigger'] {
  const mode = input?.mode === 'manual' ? 'manual' : 'token_threshold';
  const thresholdUnit: LlmCompressionThresholdUnit = input?.thresholdUnit === 'tokens' ? 'tokens' : 'percent';
  const normalizedWindow = normalizeTokenCount(contextWindowTokens);
  const inputPercent = clampPercent(input?.thresholdPercent) ?? DEFAULT_LLM_COMPRESSION_TRIGGER_PERCENT;
  const inputTokens = thresholdUnit === 'tokens' ? normalizeTokenCount(input?.thresholdTokens) : undefined;
  const thresholdTokens = inputTokens !== undefined
    ? clampTokenCount(inputTokens, normalizedWindow)
    : tokensFromPercent(inputPercent, normalizedWindow);
  const thresholdPercent = percentFromTokens(thresholdTokens, normalizedWindow) ?? inputPercent;
  return {
    mode,
    thresholdUnit,
    thresholdPercent,
    ...(thresholdTokens !== undefined ? { thresholdTokens } : {})
  };
}

function normalizeCompressionConfigForUi(
  config: LlmCompressionConfigRecord,
  contextWindowTokens?: number
): LlmCompressionConfigRecord {
  return {
    ...config,
    maxDurationMinutes: normalizeLlmCompressionMaxDurationMinutes(config.maxDurationMinutes),
    bodyTargetTokens: normalizeLlmCompressionBodyTargetTokens(config.bodyTargetTokens),
    trigger: normalizeCompressionTriggerForUi(config.trigger, contextWindowTokens)
  };
}

/** 写时复制：从共享压缩配置克隆出一份归单个渠道独占的新配置（新 id、新名称、深拷贝嵌套字段避免引用共享）。 */
function cloneCompressionConfigFrom(source: LlmCompressionConfigRecord, name: string): LlmCompressionConfigRecord {
  const now = Date.now();
  const cloned = JSON.parse(JSON.stringify(source)) as LlmCompressionConfigRecord;
  return {
    ...cloned,
    id: `llm-compression-config-${createMessageId()}`,
    name,
    createdAt: now,
    updatedAt: now
  };
}

function thresholdAfterContextWindowChange(
  trigger: LlmCompressionConfigRecord['trigger'],
  previousWindowTokens: number | undefined,
  nextWindowTokens: number | undefined
): LlmCompressionConfigRecord['trigger'] {
  if (!nextWindowTokens) return normalizeCompressionTriggerForUi(trigger, nextWindowTokens);
  if (trigger.thresholdUnit !== 'tokens') {
    return normalizeCompressionTriggerForUi({
      ...trigger,
      thresholdPercent: clampPercent(trigger.thresholdPercent) ?? DEFAULT_LLM_COMPRESSION_TRIGGER_PERCENT,
      thresholdTokens: undefined
    }, nextWindowTokens);
  }
  const previousThresholdTokens = resolveThresholdTokens(trigger, previousWindowTokens);
  if (!previousThresholdTokens) return normalizeCompressionTriggerForUi(trigger, nextWindowTokens);
  const nextThresholdTokens = clampTokenCount(previousThresholdTokens, nextWindowTokens);
  return normalizeCompressionTriggerForUi({
    ...trigger,
    thresholdTokens: nextThresholdTokens,
    thresholdPercent: percentFromTokens(nextThresholdTokens, nextWindowTokens)
  }, nextWindowTokens);
}


function toPlainProviderConfig(config: LlmProviderConfigRecord): LlmProviderConfigRecord {
  const models = sanitizeModels(config.models);
  return {
    id: config.id,
    name: config.name.trim() || '未命名渠道',
    provider: config.provider,
    baseUrl: config.baseUrl.trim(),
    model: config.model.trim(),
    models,
    apiKey: config.apiKey.trim(),
    toolCallFormat: config.toolCallFormat,
    openaiResponsesTransport: normalizeOpenAIResponsesTransport(config.openaiResponsesTransport),
    stream: config.stream !== false,
    retryOnError: config.retryOnError !== false,
    retryMaxAttempts: normalizeRetryMaxAttempts(config.retryMaxAttempts) ?? DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
    retryDelaySeconds: normalizeRetryDelaySeconds(config.retryDelaySeconds) ?? DEFAULT_LLM_RETRY_DELAY_SECONDS,
    enableMultimodalTools: config.enableMultimodalTools !== false,
    ...(normalizeTokenCount(config.contextWindowTokens) ? { contextWindowTokens: normalizeTokenCount(config.contextWindowTokens) } : {}),
    systemPromptPrefix: normalizeSystemPromptPrefix(config.systemPromptPrefix),
    promptCache: sanitizePromptCache(config.promptCache, config.provider),
    ...(normalizeOpenAIResponsesNativeSettings(config.nativeResponses)
      ? { nativeResponses: normalizeOpenAIResponsesNativeSettings(config.nativeResponses) }
      : {}),
    ...(sanitizeHeaders(config.headers) ? { headers: sanitizeHeaders(config.headers) } : {}),
    ...(sanitizeGenerationConfig(config.generationConfig) ? { generationConfig: sanitizeGenerationConfig(config.generationConfig) } : {}),
    ...(sanitizeRequestBody(config.requestBody) ? { requestBody: sanitizeRequestBody(config.requestBody) } : {}),
    modelConfigs: sanitizeModelConfigs(config.modelConfigs, models, config.provider),
    createdAt: config.createdAt,
    updatedAt: config.updatedAt
  };
}

function toPlainModelConfig(config: LlmProviderModelConfigRecord, provider: LlmProviderKind): LlmProviderModelConfigRecord {
  return {
    id: config.id,
    modelId: config.modelId.trim(),
    toolCallFormat: config.toolCallFormat === 'function-call' ? config.toolCallFormat : 'function-call',
    openaiResponsesTransport: normalizeOpenAIResponsesTransport(config.openaiResponsesTransport),
    stream: config.stream !== false,
    retryOnError: config.retryOnError !== false,
    retryMaxAttempts: normalizeRetryMaxAttempts(config.retryMaxAttempts) ?? DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
    retryDelaySeconds: normalizeRetryDelaySeconds(config.retryDelaySeconds) ?? DEFAULT_LLM_RETRY_DELAY_SECONDS,
    enableMultimodalTools: config.enableMultimodalTools !== false,
    ...(normalizeTokenCount(config.contextWindowTokens) ? { contextWindowTokens: normalizeTokenCount(config.contextWindowTokens) ?? providerDefaultContextWindow(provider) } : { contextWindowTokens: providerDefaultContextWindow(provider) }),
    systemPromptPrefix: normalizeSystemPromptPrefix(config.systemPromptPrefix),
    promptCache: sanitizePromptCache(config.promptCache, provider),
    ...(normalizeOpenAIResponsesNativeSettings(config.nativeResponses)
      ? { nativeResponses: normalizeOpenAIResponsesNativeSettings(config.nativeResponses) }
      : {}),
    ...(sanitizeHeaders(config.headers) ? { headers: sanitizeHeaders(config.headers) } : {}),
    ...(sanitizeGenerationConfig(config.generationConfig) ? { generationConfig: sanitizeGenerationConfig(config.generationConfig) } : {}),
    ...(sanitizeRequestBody(config.requestBody) ? { requestBody: sanitizeRequestBody(config.requestBody) } : {}),
    createdAt: config.createdAt,
    updatedAt: config.updatedAt
  };
}

function toPlainMcpServer(server: McpServerConfigRecord): McpServerConfigRecord {
  return {
    id: server.id,
    name: server.name.trim() || server.id,
    enabled: server.enabled === true,
    transport: toPlainMcpTransport(server.transport),
    createdAt: server.createdAt,
    updatedAt: server.updatedAt
  };
}

function toPlainMcpTransport(transport: McpServerTransportRecord): McpServerTransportRecord {
  if (transport.kind === 'http') {
    const headers = sanitizeHeaders(transport.headers) ?? {};
    return { kind: 'http', url: transport.url.trim(), ...(Object.keys(headers).length > 0 ? { headers } : {}) };
  }
  const args = (transport.args ?? []).map((arg) => String(arg).trim()).filter(Boolean);
  const env = sanitizeHeaders(transport.env) ?? {};
  const cwd = transport.cwd?.trim();
  return {
    kind: 'stdio',
    command: transport.command.trim(),
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(cwd ? { cwd } : {})
  };
}

function toPlainGenerationConfig(config: LlmGenerationConfigRecord | undefined): LlmGenerationConfigRecord | undefined {
  const sanitized = sanitizeGenerationConfig(config);
  if (!sanitized) return undefined;
  return {
    ...sanitized,
    ...(sanitized.thinkingConfig ? { thinkingConfig: { ...sanitized.thinkingConfig } } : {})
  };
}

function toPlainCompressionConfig(config: LlmCompressionConfigRecord): LlmCompressionConfigRecord {
  const normalized = normalizeCompressionConfigForUi(config);
  const openaiResponsesCompact = normalized.openaiResponsesCompact;
  const llmSummary = normalized.llmSummary;
  const generationConfig = toPlainGenerationConfig(llmSummary?.generationConfig);

  return {
    id: normalized.id,
    name: normalized.name,
    kind: normalized.kind,
    maxDurationMinutes: normalized.maxDurationMinutes,
    bodyTargetTokens: normalized.bodyTargetTokens,
    trigger: {
      mode: normalized.trigger.mode,
      ...(normalized.trigger.thresholdTokens !== undefined ? { thresholdTokens: normalized.trigger.thresholdTokens } : {}),
      ...(normalized.trigger.thresholdPercent !== undefined ? { thresholdPercent: normalized.trigger.thresholdPercent } : {}),
      ...(normalized.trigger.thresholdUnit !== undefined ? { thresholdUnit: normalized.trigger.thresholdUnit } : {})
    },
    ...(openaiResponsesCompact ? {
      openaiResponsesCompact: {
        ...(openaiResponsesCompact.providerConfigId ? { providerConfigId: openaiResponsesCompact.providerConfigId } : {}),
        ...(openaiResponsesCompact.model ? { model: openaiResponsesCompact.model } : {})
      }
    } : {}),
    ...(llmSummary ? {
      llmSummary: {
        ...(llmSummary.providerConfigId ? { providerConfigId: llmSummary.providerConfigId } : {}),
        ...(llmSummary.model ? { model: llmSummary.model } : {}),
        ...(llmSummary.systemPrompt ? { systemPrompt: llmSummary.systemPrompt } : {}),
        ...(llmSummary.userPrompt ? { userPrompt: llmSummary.userPrompt } : {}),
        ...(llmSummary.targetTokens !== undefined ? { targetTokens: llmSummary.targetTokens } : {}),
        ...(generationConfig ? { generationConfig } : {})
      }
    } : {}),
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt
  };
}

function toPlainCompressionSettings(settings: LlmCompressionSettingsRecord): LlmCompressionSettingsRecord {
  const defaultConfigId = settings.defaultConfigId?.trim() ?? '';
  return {
    ...(defaultConfigId ? { defaultConfigId } : {}),
    providerBindings: settings.providerBindings.map((binding) => ({
      id: binding.id,
      providerConfigId: binding.providerConfigId,
      compressionConfigId: binding.compressionConfigId,
      role: 'default',
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt
    })),
    modelBindings: settings.modelBindings.map((binding) => ({
      id: binding.id,
      providerConfigId: binding.providerConfigId,
      modelId: binding.modelId,
      compressionConfigId: binding.compressionConfigId,
      role: 'model',
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt
    }))
  };
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameSerializableValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalSerializableValue(left)) === JSON.stringify(canonicalSerializableValue(right));
}

function canonicalSerializableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSerializableValue);
  if (isPlainJsonObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalSerializableValue(value[key])])
    );
  }
  return value;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function plainSettingsFromState(state: GlobalSettingsState, section: GlobalSettingsSection): GlobalSettingsSectionValue {
  switch (section) {
    case 'common':
      return {
        dataFilePath: state.common.dataFilePath,
        proxy: state.common.proxy,
        proxyShellAndMcp: state.common.proxyShellAndMcp,
        activeDataRootPath: state.common.activeDataRootPath,
        defaultDataRootPath: state.common.defaultDataRootPath
      };
    case 'network': return { userAgent: state.network.userAgent.trim() };
    case 'llm': return { activeProviderConfigId: state.llm.activeProviderConfigId };
    case 'llmProviderConfigs': return { configs: state.llmProviderConfigs.configs.map(toPlainProviderConfig) };
    case 'llmCompression': return toPlainCompressionSettings(state.llmCompression);
    case 'llmCompressionConfigs': return { configs: state.llmCompressionConfigs.configs.map(toPlainCompressionConfig) };
    case 'checkpointMaintenance': return { ...state.checkpointMaintenance };
    case 'appearance': return { ...state.appearance };
    case 'attachments': return { maxStoredInlineFileMb: state.attachments.maxStoredInlineFileMb };
    case 'mcpServers': return { servers: state.mcpServers.servers.map(toPlainMcpServer) };
    case 'debugCapture': return normalizeDebugCaptureSettings(state.debugCapture);
  }
}

function cloneSettingsValue<T extends GlobalSettingsSectionValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeSettingsSnapshot(section: GlobalSettingsSection, settings: GlobalSettingsSectionValue): GlobalSettingsSectionValue {
  if (section === 'llmProviderConfigs') {
    return { configs: (settings as LlmProviderConfigsRecord).configs.map((config) => toPlainProviderConfig(normalizeProviderConfigForUi(config))) };
  }
  if (section === 'llmCompressionConfigs') return { configs: (settings as LlmCompressionConfigsRecord).configs.map(toPlainCompressionConfig) };
  if (section === 'llmCompression') return toPlainCompressionSettings({ ...emptyLlmCompression(), ...settings as LlmCompressionSettingsRecord });
  return cloneSettingsValue(settings);
}

function mapSettingsRecordTimes(value: GlobalSettingsSectionValue, visit: (key: string, timestamp: number) => number): GlobalSettingsSectionValue {
  const copy = cloneSettingsValue(value) as unknown as Record<string, unknown>;
  for (const collection of ['configs', 'providerBindings', 'modelBindings', 'servers']) {
    const records = copy[collection];
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      if (!isPlainJsonObject(record) || typeof record.id !== 'string') continue;
      const key = JSON.stringify([collection, record.id]);
      if (typeof record.updatedAt === 'number') record.updatedAt = visit(key, record.updatedAt);
      if (collection === 'configs' && Array.isArray(record.modelConfigs)) {
        for (const model of record.modelConfigs) {
          if (isPlainJsonObject(model) && typeof model.id === 'string' && typeof model.updatedAt === 'number') {
            model.updatedAt = visit(JSON.stringify([collection, record.id, 'modelConfigs', model.id]), model.updatedAt);
          }
        }
      }
    }
  }
  return copy as unknown as GlobalSettingsSectionValue;
}

function sameSettingsContent(left: GlobalSettingsSectionValue, right: GlobalSettingsSectionValue): boolean {
  return sameSerializableValue(mapSettingsRecordTimes(left, () => 0), mapSettingsRecordTimes(right, () => 0));
}

const MERGE_MISSING = Symbol('merge-missing');
type MergeNodeValue = unknown | typeof MERGE_MISSING;

function mergeSettingsThreeWay(
  base: GlobalSettingsSectionValue,
  local: GlobalSettingsSectionValue,
  remote: GlobalSettingsSectionValue,
  localWinsConflicts = false
): { value: GlobalSettingsSectionValue; conflicts: string[] } {
  // 记录的更新时间是保存元数据，不与用户设置字段一起参与冲突判定。
  const timestamps = new Map<string, number>();
  for (const value of [base, local, remote]) mapSettingsRecordTimes(value, (key, timestamp) => { timestamps.set(key, timestamp); return timestamp; });
  const [alignedBase, alignedLocal, alignedRemote] = [base, local, remote].map((value) =>
    mapSettingsRecordTimes(value, (key, timestamp) => timestamps.get(key) ?? timestamp)
  );
  const merged = mergeNode(alignedBase, alignedLocal, alignedRemote, '$', localWinsConflicts);
  return {
    value: cloneSettingsValue(merged.value as GlobalSettingsSectionValue),
    conflicts: merged.conflicts
  };
}

function mergeNode(
  base: MergeNodeValue,
  local: MergeNodeValue,
  remote: MergeNodeValue,
  path: string,
  localWinsConflicts: boolean
): { value: MergeNodeValue; conflicts: string[] } {
  if (sameMergeValue(local, remote)) return { value: cloneMergeValue(local), conflicts: [] };
  if (sameMergeValue(local, base)) return { value: cloneMergeValue(remote), conflicts: [] };
  if (sameMergeValue(remote, base)) return { value: cloneMergeValue(local), conflicts: [] };

  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
    const keyed = mergeKeyedArrays(base, local, remote, path, localWinsConflicts);
    if (keyed) return keyed;
  }
  if (isPlainJsonObject(base) && isPlainJsonObject(local) && isPlainJsonObject(remote)) {
    const output: Record<string, unknown> = {};
    const conflicts: string[] = [];
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    for (const key of [...keys].sort()) {
      const child = mergeNode(
        Object.prototype.hasOwnProperty.call(base, key) ? base[key] : MERGE_MISSING,
        Object.prototype.hasOwnProperty.call(local, key) ? local[key] : MERGE_MISSING,
        Object.prototype.hasOwnProperty.call(remote, key) ? remote[key] : MERGE_MISSING,
        `${path}.${key}`,
        localWinsConflicts
      );
      conflicts.push(...child.conflicts);
      if (child.value !== MERGE_MISSING) output[key] = child.value;
    }
    return { value: output, conflicts };
  }
  return { value: cloneMergeValue(local), conflicts: localWinsConflicts ? [] : [path] };
}

function mergeKeyedArrays(
  base: unknown[],
  local: unknown[],
  remote: unknown[],
  path: string,
  localWinsConflicts: boolean
): { value: MergeNodeValue; conflicts: string[] } | undefined {
  const baseMap = keyedArrayMap(base);
  const localMap = keyedArrayMap(local);
  const remoteMap = keyedArrayMap(remote);
  if (!baseMap || !localMap || !remoteMap) return undefined;
  const order = [...remoteMap.keys(), ...[...localMap.keys()].filter((key) => !remoteMap.has(key))];
  const output: unknown[] = [];
  const conflicts: string[] = [];
  for (const key of order) {
    const child = mergeNode(
      baseMap.get(key) ?? MERGE_MISSING,
      localMap.get(key) ?? MERGE_MISSING,
      remoteMap.get(key) ?? MERGE_MISSING,
      `${path}[${JSON.stringify(key)}]`,
      localWinsConflicts
    );
    conflicts.push(...child.conflicts);
    if (child.value !== MERGE_MISSING) output.push(child.value);
  }
  return { value: output, conflicts };
}

function keyedArrayMap(values: unknown[]): Map<string, unknown> | undefined {
  if (values.length === 0) return new Map();
  const result = new Map<string, unknown>();
  for (const value of values) {
    const key = mergeRecordKey(value);
    if (!key || result.has(key)) return undefined;
    result.set(key, value);
  }
  return result;
}

function mergeRecordKey(value: unknown): string | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  if (typeof value.id === 'string' && value.id) return `id:${value.id}`;
  if (typeof value.providerConfigId === 'string' && typeof value.modelId === 'string') {
    return `provider-model:${value.providerConfigId}:${value.modelId}`;
  }
  if (typeof value.providerConfigId === 'string' && value.providerConfigId) return `provider:${value.providerConfigId}`;
  return undefined;
}

function sameMergeValue(left: MergeNodeValue, right: MergeNodeValue): boolean {
  if (left === MERGE_MISSING || right === MERGE_MISSING) return left === right;
  return sameSerializableValue(left, right);
}

function cloneMergeValue(value: MergeNodeValue): MergeNodeValue {
  if (value === MERGE_MISSING) return MERGE_MISSING;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

let modelFetchTimeout: number | undefined;
const LLM_PROVIDER_CONFIGS_AUTOSAVE_DELAY_MS = 400;
const LLM_COMPRESSION_CONFIGS_AUTOSAVE_DELAY_MS = 400;
const SETTINGS_SAVE_ACK_TIMEOUT_MS = 5_000;
const SETTINGS_FLUSH_TIMEOUT_MS = 12_000;
let llmProviderConfigsAutoSaveTimer: number | undefined;
let llmCompressionConfigsAutoSaveTimer: number | undefined;

type PendingGlobalSettingsUpdate = Omit<GlobalSettingsUpdatePayload, 'expectedRevision'>;
interface SectionSaveAttempt { requestId: string; payload: PendingGlobalSettingsUpdate; expectedRevision: string }
interface SectionSaveCoordinator {
  inFlight?: SectionSaveAttempt;
  queued?: PendingGlobalSettingsUpdate;
  awaitingConflictSnapshot?: boolean;
  timeout?: number;
  recoveryRequestId?: string;
  paused?: boolean;
  ignoredReplyIds: Set<string>;
}
const sectionSaveCoordinators = new Map<GlobalSettingsSection, SectionSaveCoordinator>();

function coordinatorFor(section: GlobalSettingsSection): SectionSaveCoordinator {
  let coordinator = sectionSaveCoordinators.get(section);
  if (!coordinator) {
    coordinator = { ignoredReplyIds: new Set() };
    sectionSaveCoordinators.set(section, coordinator);
  }
  return coordinator;
}

function clearSectionSaveTimeout(coordinator: SectionSaveCoordinator): void {
  if (coordinator.timeout !== undefined) window.clearTimeout(coordinator.timeout);
  coordinator.timeout = undefined;
}

function ignoreSettingsReply(coordinator: SectionSaveCoordinator, requestId: string | undefined): void {
  if (!requestId) return;
  coordinator.ignoredReplyIds.add(requestId);
  if (coordinator.ignoredReplyIds.size > 64) {
    coordinator.ignoredReplyIds.delete(coordinator.ignoredReplyIds.values().next().value!);
  }
}

function clearLlmProviderConfigsAutoSaveTimer(): void {
  if (llmProviderConfigsAutoSaveTimer === undefined) return;
  window.clearTimeout(llmProviderConfigsAutoSaveTimer);
  llmProviderConfigsAutoSaveTimer = undefined;
}

function clearLlmCompressionConfigsAutoSaveTimer(): void {
  if (llmCompressionConfigsAutoSaveTimer === undefined) return;
  window.clearTimeout(llmCompressionConfigsAutoSaveTimer);
  llmCompressionConfigsAutoSaveTimer = undefined;
}

function hasPendingLlmProviderConfigsSave(): boolean {
  const coordinator = sectionSaveCoordinators.get('llmProviderConfigs');
  return llmProviderConfigsAutoSaveTimer !== undefined || !!coordinator?.inFlight || !!coordinator?.queued;
}

function hasPendingLlmCompressionConfigsSave(): boolean {
  const coordinator = sectionSaveCoordinators.get('llmCompressionConfigs');
  return llmCompressionConfigsAutoSaveTimer !== undefined || !!coordinator?.inFlight || !!coordinator?.queued;
}

function hasPendingSectionSave(section: GlobalSettingsSection): boolean {
  const coordinator = sectionSaveCoordinators.get(section);
  if (coordinator?.paused) return false;
  const timerPending = section === 'llmProviderConfigs'
    ? llmProviderConfigsAutoSaveTimer !== undefined
    : section === 'llmCompressionConfigs' && llmCompressionConfigsAutoSaveTimer !== undefined;
  return !!coordinator?.inFlight || !!coordinator?.queued || timerPending;
}

function isSectionDirty(state: GlobalSettingsState, section: GlobalSettingsSection): boolean {
  const baseline = state.baselines[section];
  const contentDirty = baseline !== undefined
    && !sameSettingsContent(plainSettingsFromState(state, section), baseline);
  return contentDirty || state.pendingSettingsSections[section] === true || hasPendingSectionSave(section);
}

function clearModelFetchTimeout(): void {
  if (modelFetchTimeout === undefined) return;
  window.clearTimeout(modelFetchTimeout);
  modelFetchTimeout = undefined;
}

function startModelFetchTimeout(onTimeout: () => void): void {
  clearModelFetchTimeout();
  modelFetchTimeout = window.setTimeout(onTimeout, 60_000);
}

/** 全局设置（数据目录 + LLM 渠道配置）表单 store。组件只读 state + 调 action，传输细节收口在此。 */
export const useGlobalSettingsStore = defineStore('globalSettings', {
  state: (): GlobalSettingsState => ({
    common: emptyCommon(),
    network: emptyNetwork(),
    llm: emptyLlm(),
    llmProviderConfigs: emptyLlmProviderConfigs(),
    llmCompression: emptyLlmCompression(),
    llmCompressionConfigs: emptyLlmCompressionConfigs(),
    checkpointMaintenance: emptyCheckpointMaintenance(),
    appearance: emptyAppearance(),
    attachments: emptyAttachments(),
    mcpServers: emptyMcpServers(),
    debugCapture: normalizeDebugCaptureSettings(),
    filePaths: {},
    revisions: {},
    baselines: {},
    pendingExternalSnapshots: {},
    externalChangedSections: {},
    pendingActiveProviderConfigIdAfterConfigsSave: '',
    flushCompressionBindingAfterConfigsSave: false,
    loadedSections: {},
    loadingSettingsSections: {},
    fetchedModelsDialog: emptyFetchedModelsDialog(),
    pendingSettingsSections: {},
    failedSettingsSections: {},
    status: ''
  }),
  getters: {
    hasExternalSettingsChange(state): boolean {
      return Object.keys(state.externalChangedSections).length > 0;
    },
    activeLlmProviderConfig(state): LlmProviderConfigRecord | undefined {
      return state.llmProviderConfigs.configs.find((config) => config.id === state.llm.activeProviderConfigId)
        ?? state.llmProviderConfigs.configs[0];
    },
    activeCompressionConfig(state): LlmCompressionConfigRecord | undefined {
      const activeProviderId = state.llm.activeProviderConfigId;
      const binding = activeProviderId ? state.llmCompression.providerBindings.find((item) => item.providerConfigId === activeProviderId) : undefined;
      const id = binding?.compressionConfigId ?? state.llmCompression.defaultConfigId;
      return state.llmCompressionConfigs.configs.find((config) => config.id === id) ?? state.llmCompressionConfigs.configs[0];
    },
    compressionConfigForActiveModel(state): (modelId: string) => LlmCompressionConfigRecord | undefined {
      return (modelId: string) => {
        const providerConfigId = state.llm.activeProviderConfigId || state.llmProviderConfigs.configs[0]?.id || '';
        const model = modelId.trim();
        const modelBinding = providerConfigId && model
          ? state.llmCompression.modelBindings.find((item) => item.providerConfigId === providerConfigId && item.modelId === model)
          : undefined;
        const providerBinding = providerConfigId ? state.llmCompression.providerBindings.find((item) => item.providerConfigId === providerConfigId) : undefined;
        const id = modelBinding?.compressionConfigId ?? providerBinding?.compressionConfigId ?? state.llmCompression.defaultConfigId;
        return state.llmCompressionConfigs.configs.find((config) => config.id === id) ?? state.llmCompressionConfigs.configs[0];
      };
    }
  },
  actions: {
    enqueueSettingsUpdate(payload: PendingGlobalSettingsUpdate): void {
      const coordinator = coordinatorFor(payload.section);
      coordinator.queued = { ...payload, settings: cloneSettingsValue(payload.settings) };
      this.markPendingSettingSection(payload.section);
      if (coordinator.paused && coordinator.inFlight) {
        this.recoverSettingsSave(payload.section);
        return;
      }
      coordinator.paused = false;
      this.pumpSettingsUpdate(payload.section);
    },
    pumpSettingsUpdate(section: GlobalSettingsSection): void {
      const coordinator = coordinatorFor(section);
      if (coordinator.paused || coordinator.inFlight || coordinator.awaitingConflictSnapshot || this.externalChangedSections[section] || !coordinator.queued) return;
      const expectedRevision = this.revisions[section];
      if (!expectedRevision) {
        if (!this.loadingSettingsSections[section]) {
          this.markLoadingSettingSection(section);
          bridge.request(BridgeMessageType.GlobalSettingsGet, { section });
        }
        this.failedSettingsSections[section] = '尚未取得最新设置，已暂停保存并重新读取。';
        return;
      }
      const payload = coordinator.queued;
      coordinator.queued = undefined;
      const requestId = createMessageId();
      try {
        coordinator.inFlight = { requestId, payload, expectedRevision };
        clearSectionSaveTimeout(coordinator);
        coordinator.timeout = window.setTimeout(() => this.recoverSettingsSave(section), SETTINGS_SAVE_ACK_TIMEOUT_MS);
        bridge.request(BridgeMessageType.GlobalSettingsUpdate, { ...payload, expectedRevision }, { requestId });
      } catch (error) {
        clearSectionSaveTimeout(coordinator);
        coordinator.inFlight = undefined;
        coordinator.queued = payload;
        coordinator.paused = true;
        this.clearPendingSettingSection(section);
        const message = `设置保存请求发送失败：${messageFromError(error)}`;
        this.failedSettingsSections[section] = message;
        this.status = `设置保存失败：${message}`;
      }
    },
    recoverSettingsSave(section: GlobalSettingsSection): void {
      const coordinator = coordinatorFor(section);
      clearSectionSaveTimeout(coordinator);
      ignoreSettingsReply(coordinator, coordinator.recoveryRequestId);
      const requestId = createMessageId();
      coordinator.recoveryRequestId = requestId;
      coordinator.paused = false;
      this.markLoadingSettingSection(section);
      coordinator.timeout = window.setTimeout(() => {
        ignoreSettingsReply(coordinator, requestId);
        coordinator.recoveryRequestId = undefined;
        coordinator.timeout = undefined;
        coordinator.paused = true;
        this.clearLoadingSettingSection(section);
        this.clearPendingSettingSection(section);
        this.failedSettingsSections[section] = '无法确认设置是否保存，本地修改已保留，请重新读取后重试。';
        this.status = this.failedSettingsSections[section]!;
      }, SETTINGS_SAVE_ACK_TIMEOUT_MS);
      try {
        bridge.request(BridgeMessageType.GlobalSettingsGet, { section }, { requestId });
      } catch (error) {
        this.setError(`无法核对设置：${messageFromError(error)}`, {
          section, correlationId: requestId, requestType: BridgeMessageType.GlobalSettingsGet
        });
      }
    },
    flushForExecution(): Promise<void> {
      if (llmProviderConfigsAutoSaveTimer !== undefined) this.saveLlmProviderConfigs();
      if (llmCompressionConfigsAutoSaveTimer !== undefined) this.saveLlmCompressionConfigs();
      return new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          unsubscribe();
          window.clearTimeout(timeout);
          if (error) reject(error);
          else resolve();
        };
        const check = () => {
          for (const section of CHANNEL_SETTINGS_SECTIONS) {
            if (this.externalChangedSections[section] || this.failedSettingsSections[section]) {
              finish(new Error(this.failedSettingsSections[section] || '设置有未处理的修改冲突，请先在设置页确认。'));
              return;
            }
          }
          if (CHANNEL_SETTINGS_SECTIONS.every((section) => !isSectionDirty(this, section) && !this.loadingSettingsSections[section])) finish();
        };
        const unsubscribe = this.$subscribe(check, { detached: true, flush: 'sync' });
        const timeout = window.setTimeout(() => finish(new Error('设置尚未确认保存，已暂停本次操作，请检查设置页。')), SETTINGS_FLUSH_TIMEOUT_MS);
        check();
      });
    },
    markLoadingSettingSection(section: GlobalSettingsSection): void {
      this.loadingSettingsSections[section] = true;
      delete this.failedSettingsSections[section];
    },
    clearLoadingSettingSection(section: GlobalSettingsSection): void {
      delete this.loadingSettingsSections[section];
    },
    markPendingSettingSection(section: GlobalSettingsSection): void {
      this.pendingSettingsSections[section] = true;
      delete this.failedSettingsSections[section];
    },
    clearPendingSettingSection(section: GlobalSettingsSection): void {
      delete this.pendingSettingsSections[section];
    },
    requestAll(): void {
      this.status = '正在读取设置...';
      for (const section of GLOBAL_SETTINGS_SECTIONS) {
        const coordinator = coordinatorFor(section);
        if (coordinator.inFlight || coordinator.queued || coordinator.paused) {
          this.recoverSettingsSave(section);
          continue;
        }
        this.markLoadingSettingSection(section);
        bridge.request(BridgeMessageType.GlobalSettingsGet, { section });
      }
    },
    reconcilePendingSettings(): void {
      for (const section of GLOBAL_SETTINGS_SECTIONS) {
        const coordinator = coordinatorFor(section);
        if (coordinator.inFlight || coordinator.queued || coordinator.paused) this.recoverSettingsSave(section);
      }
    },
    requestChannelSettings(): void {
      for (const section of CHANNEL_SETTINGS_SECTIONS) {
        if (this.loadedSections[section] || this.loadingSettingsSections[section]) continue;
        this.markLoadingSettingSection(section);
        bridge.request(BridgeMessageType.GlobalSettingsGet, { section });
      }
    },
    saveCommon(): void {
      this.status = '正在保存设置，并按需迁移、删除旧数据目录中的插件数据...';
      this.enqueueSettingsUpdate({
        section: 'common',
        settings: {
          dataFilePath: this.common.dataFilePath,
          proxy: this.common.proxy,
          proxyShellAndMcp: this.common.proxyShellAndMcp,
          activeDataRootPath: this.common.activeDataRootPath,
          defaultDataRootPath: this.common.defaultDataRootPath
        }
      });
    },
    saveNetwork(): void {
      this.enqueueSettingsUpdate({
        section: 'network',
        settings: { userAgent: this.network.userAgent.trim() }
      });
    },
    setDebugCaptureSettings(patch: Partial<DebugCaptureSettings>): void {
      this.debugCapture = normalizeDebugCaptureSettings({ ...this.debugCapture, ...patch });
      this.enqueueSettingsUpdate({ section: 'debugCapture', settings: normalizeDebugCaptureSettings(this.debugCapture) });
    },
    ensureDebugCaptureSettings(): void {
      if (this.loadedSections.debugCapture || this.loadingSettingsSections.debugCapture) return;
      this.markLoadingSettingSection('debugCapture');
      bridge.request(BridgeMessageType.GlobalSettingsGet, { section: 'debugCapture' });
    },
    saveLlm(): void {
      this.status = '正在保存当前渠道选择...';
      this.enqueueSettingsUpdate({
        section: 'llm',
        settings: {
          activeProviderConfigId: this.llm.activeProviderConfigId
        }
      });
    },
    ensureCheckpointMaintenance(): void {
      if (this.loadedSections.checkpointMaintenance || this.loadingSettingsSections.checkpointMaintenance) return;
      this.markLoadingSettingSection('checkpointMaintenance');
      bridge.request(BridgeMessageType.GlobalSettingsGet, { section: 'checkpointMaintenance' });
    },
    setCheckpointMaintenance(patch: Partial<CheckpointMaintenanceSettingsRecord>): void {
      const next = { ...this.checkpointMaintenance, ...patch };
      next.autoCleanupDays = Math.min(3650, Math.max(1, Math.floor(next.autoCleanupDays || 7)));
      next.autoDismissSeconds = Math.min(600, Math.max(1, Math.floor(next.autoDismissSeconds || 5)));
      this.checkpointMaintenance = next;
      this.saveCheckpointMaintenance();
    },
    saveCheckpointMaintenance(): void {
      this.status = '正在保存存档点维护设置...';
      this.enqueueSettingsUpdate({
        section: 'checkpointMaintenance',
        settings: {
          autoCleanupEnabled: this.checkpointMaintenance.autoCleanupEnabled,
          autoCleanupDays: this.checkpointMaintenance.autoCleanupDays,
          autoDismissEnabled: this.checkpointMaintenance.autoDismissEnabled,
          autoDismissSeconds: this.checkpointMaintenance.autoDismissSeconds
        }
      });
    },
    ensureAppearance(): void {
      if (this.loadedSections.appearance || this.loadingSettingsSections.appearance) return;
      this.markLoadingSettingSection('appearance');
      bridge.request(BridgeMessageType.GlobalSettingsGet, { section: 'appearance' });
    },
    saveAppearance(): void {
      this.status = '正在保存外观设置...';
      this.enqueueSettingsUpdate({
        section: 'appearance',
        settings: {
          streamingTextPreparing: this.appearance.streamingTextPreparing,
          streamingTextWaiting: this.appearance.streamingTextWaiting,
          streamingTextThinking: this.appearance.streamingTextThinking,
          streamingTextWriting: this.appearance.streamingTextWriting,
          streamingTextToolExecuting: this.appearance.streamingTextToolExecuting
        }
      });
    },
    ensureAttachments(): void {
      if (this.loadedSections.attachments || this.loadingSettingsSections.attachments) return;
      this.markLoadingSettingSection('attachments');
      bridge.request(BridgeMessageType.GlobalSettingsGet, { section: 'attachments' });
    },
    setAttachmentSettings(patch: Partial<AttachmentSettingsRecord>): void {
      const next = { ...this.attachments, ...patch };
      next.maxStoredInlineFileMb = Math.min(200, Math.max(1, Math.floor(Number(next.maxStoredInlineFileMb) || 20)));
      this.attachments = next;
      this.saveAttachments();
    },
    saveAttachments(): void {
      this.status = '正在保存附件设置...';
      this.enqueueSettingsUpdate({
        section: 'attachments',
        settings: {
          maxStoredInlineFileMb: this.attachments.maxStoredInlineFileMb
        }
      });
    },
    ensureMcpServers(): void {
      if (this.loadedSections.mcpServers || this.loadingSettingsSections.mcpServers) return;
      this.markLoadingSettingSection('mcpServers');
      bridge.request(BridgeMessageType.GlobalSettingsGet, { section: 'mcpServers' });
    },
    saveMcpServers(refreshMcpTools = false): void {
      this.status = refreshMcpTools ? '正在尝试获取 MCP 工具...' : '正在保存 MCP 服务...';
      this.enqueueSettingsUpdate({
        section: 'mcpServers',
        settings: {
          servers: this.mcpServers.servers.map(toPlainMcpServer)
        },
        ...(refreshMcpTools ? { refreshMcpTools: true } : {})
      });
    },
    createMcpServer(name = '新 MCP 服务', transportKind: McpServerTransportRecord['kind'] = 'stdio'): void {
      const resolved = name.trim() || '新 MCP 服务';
      if (isDuplicateMcpServerName(this.mcpServers.servers, resolved)) return;
      this.mcpServers.servers.push(createDefaultMcpServerConfig(resolved, transportKind));
      this.saveMcpServers();
    },
    updateMcpServer(serverId: string, patch: Partial<McpServerConfigRecord>): void {
      const server = this.mcpServers.servers.find((candidate) => candidate.id === serverId);
      if (!server) return;
      if (typeof patch.name === 'string' && isDuplicateMcpServerName(this.mcpServers.servers, patch.name, serverId)) return;
      Object.assign(server, patch, { updatedAt: Date.now() });
      this.saveMcpServers();
    },
    deleteMcpServer(serverId: string): void {
      const next = this.mcpServers.servers.filter((server) => server.id !== serverId);
      if (next.length === this.mcpServers.servers.length) return;
      this.mcpServers.servers = next;
      this.saveMcpServers();
    },
    testMcpServer(serverId: string): void {
      const server = this.mcpServers.servers.find((candidate) => candidate.id === serverId);
      if (!server) return;
      server.enabled = true;
      server.updatedAt = Date.now();
      this.saveMcpServers(true);
    },
    queueLlmProviderConfigsAutoSave(): void {
      clearLlmProviderConfigsAutoSaveTimer();
      this.markPendingSettingSection('llmProviderConfigs');
      this.status = '正在自动保存渠道配置...';
      llmProviderConfigsAutoSaveTimer = window.setTimeout(() => {
        llmProviderConfigsAutoSaveTimer = undefined;
        this.saveLlmProviderConfigs();
      }, LLM_PROVIDER_CONFIGS_AUTOSAVE_DELAY_MS);
    },
    saveLlmProviderConfigs(): void {
      clearLlmProviderConfigsAutoSaveTimer();
      this.status = '正在自动保存渠道配置...';
      this.enqueueSettingsUpdate({
        section: 'llmProviderConfigs',
        settings: {
          configs: this.llmProviderConfigs.configs.map((config) => {
            const plain = toPlainProviderConfig(config);
            return {
              ...plain,
              name: plain.name.trim() || '未命名渠道',
              apiKey: plain.apiKey.trim(),
              baseUrl: plain.baseUrl.trim(),
              model: plain.model.trim()
            };
          })
        }
      });
    },
    queueLlmCompressionConfigsAutoSave(): void {
      clearLlmCompressionConfigsAutoSaveTimer();
      this.markPendingSettingSection('llmCompressionConfigs');
      this.status = '正在自动保存压缩配置...';
      llmCompressionConfigsAutoSaveTimer = window.setTimeout(() => {
        llmCompressionConfigsAutoSaveTimer = undefined;
        this.saveLlmCompressionConfigs();
      }, LLM_COMPRESSION_CONFIGS_AUTOSAVE_DELAY_MS);
    },
    saveLlmCompression(): void {
      this.status = '正在保存压缩绑定...';
      try {
        this.enqueueSettingsUpdate({ section: 'llmCompression', settings: toPlainCompressionSettings(this.llmCompression) });
      } catch (error) {
        const message = `压缩绑定保存请求发送失败：${messageFromError(error)}`;
        this.clearPendingSettingSection('llmCompression');
        this.failedSettingsSections.llmCompression = message;
        this.status = `设置保存失败：${message}`;
      }
    },
    saveLlmCompressionConfigs(): void {
      clearLlmCompressionConfigsAutoSaveTimer();
      this.status = '正在保存压缩配置...';
      try {
        this.enqueueSettingsUpdate({
          section: 'llmCompressionConfigs',
          settings: {
            configs: this.llmCompressionConfigs.configs.map(toPlainCompressionConfig)
          }
        });
      } catch (error) {
        const message = `压缩配置保存请求发送失败：${messageFromError(error)}`;
        if (!hasPendingLlmCompressionConfigsSave()) this.clearPendingSettingSection('llmCompressionConfigs');
        this.failedSettingsSections.llmCompressionConfigs = message;
        this.status = `设置保存失败：${message}`;
      }
    },
    selectCompressionConfigForActiveProvider(configId: string, deferPersist = false): void {
      if (!this.llmCompressionConfigs.configs.some((config) => config.id === configId)) return;
      const providerConfigId = this.llm.activeProviderConfigId || this.activeLlmProviderConfig?.id || '';
      if (!providerConfigId) {
        if (this.llmCompression.defaultConfigId === configId) return;
        this.llmCompression.defaultConfigId = configId;
      } else {
        const now = Date.now();
        const existing = this.llmCompression.providerBindings.find((item) => item.providerConfigId === providerConfigId);
        if (existing) {
          if (existing.compressionConfigId === configId) return;
          existing.compressionConfigId = configId;
          existing.updatedAt = now;
        } else {
          this.llmCompression.providerBindings.push({ id: `llm-compression-binding-${providerConfigId}`, providerConfigId, compressionConfigId: configId, role: 'default', createdAt: now, updatedAt: now });
        }
      }
      // 新配置刚被克隆/新建时，绑定必须等 llmCompressionConfigs 保存确认后再持久化，否则后端会以“配置不存在”丢弃绑定。
      if (deferPersist) {
        this.flushCompressionBindingAfterConfigsSave = true;
        return;
      }
      this.saveLlmCompression();
    },
    selectCompressionConfigForActiveModel(modelId: string, configId: string, deferPersist = false): void {
      if (!this.llmCompressionConfigs.configs.some((config) => config.id === configId)) return;
      const providerConfigId = this.llm.activeProviderConfigId || this.activeLlmProviderConfig?.id || '';
      const model = modelId.trim();
      if (!providerConfigId || !model) return;
      const now = Date.now();
      const existing = this.llmCompression.modelBindings.find((item) => item.providerConfigId === providerConfigId && item.modelId === model);
      if (existing) {
        if (existing.compressionConfigId === configId) return;
        existing.compressionConfigId = configId;
        existing.updatedAt = now;
      } else {
        this.llmCompression.modelBindings.push({
          id: `llm-compression-model-binding-${providerConfigId}-${slugId(model)}`,
          providerConfigId,
          modelId: model,
          compressionConfigId: configId,
          role: 'model',
          createdAt: now,
          updatedAt: now
        });
      }
      if (deferPersist) {
        this.flushCompressionBindingAfterConfigsSave = true;
        return;
      }
      this.saveLlmCompression();
    },
    createCompressionConfig(name = '新压缩方法'): void {
      const config = createDefaultLlmCompressionConfig(name.trim() || '新压缩方法');
      this.llmCompressionConfigs.configs.push(config);
      this.llmCompression.defaultConfigId = config.id;
      this.saveLlmCompressionConfigs();
      this.saveLlmCompression();
    },
    /** 判断某压缩配置是否已被指定渠道独占（未共享给默认、模型或其他渠道），独占才可原地编辑，否则需写时复制。 */
    isCompressionConfigOwnedByActiveProvider(providerConfigId: string, configId: string): boolean {
      if (!providerConfigId || !configId) return false;
      if (this.llmCompression.defaultConfigId === configId) return false;
      const providerRefs = this.llmCompression.providerBindings.filter((binding) => binding.compressionConfigId === configId);
      const modelRefs = this.llmCompression.modelBindings.filter((binding) => binding.compressionConfigId === configId);
      return providerRefs.length === 1 && providerRefs[0].providerConfigId === providerConfigId && modelRefs.length === 0;
    },
    /** 判断某压缩配置是否已被指定模型独占。 */
    isCompressionConfigOwnedByActiveModel(providerConfigId: string, modelId: string, configId: string): boolean {
      const model = modelId.trim();
      if (!providerConfigId || !model || !configId) return false;
      if (this.llmCompression.defaultConfigId === configId) return false;
      const providerRefs = this.llmCompression.providerBindings.filter((binding) => binding.compressionConfigId === configId);
      const modelRefs = this.llmCompression.modelBindings.filter((binding) => binding.compressionConfigId === configId);
      return providerRefs.length === 0
        && modelRefs.length === 1
        && modelRefs[0].providerConfigId === providerConfigId
        && modelRefs[0].modelId === model;
    },
    /** 所有压缩编辑动作的统一入口：确保当前活动渠道拥有一份可独占编辑的压缩配置，共享时写时复制。 */
    ensureCompressionConfigForActiveProvider(): LlmCompressionConfigRecord | undefined {
      const providerConfigId = this.llm.activeProviderConfigId || this.activeLlmProviderConfig?.id || '';
      const current = this.activeCompressionConfig;

      // A｜无活动渠道：保持原有“编辑默认配置”行为。新建默认配置时同样延迟持久化 defaultConfigId。
      if (!providerConfigId) {
        if (current) return current;
        const created = createDefaultLlmCompressionConfig('默认压缩方法');
        this.llmCompressionConfigs.configs.push(created);
        this.llmCompression.defaultConfigId = created.id;
        this.saveLlmCompressionConfigs();
        this.flushCompressionBindingAfterConfigsSave = true;
        return created;
      }

      const providerName = this.llmProviderConfigs.configs.find((config) => config.id === providerConfigId)?.name?.trim();

      // B｜有活动渠道但解析不到配置：为该渠道新建独立配置，不动 defaultConfigId。
      if (!current) {
        const created = createDefaultLlmCompressionConfig(providerName ? `${providerName} 压缩` : '压缩方法');
        this.llmCompressionConfigs.configs.push(created);
        this.saveLlmCompressionConfigs();
        this.selectCompressionConfigForActiveProvider(created.id, true);
        return created;
      }

      // C｜已被该渠道独占：直接原地编辑。
      if (this.isCompressionConfigOwnedByActiveProvider(providerConfigId, current.id)) return current;

      // D｜共享（默认 / configs[0] / 被别的渠道引用）：写时复制出一份归本渠道独占。
      const clone = cloneCompressionConfigFrom(current, providerName ? `${providerName} 压缩` : current.name);
      this.llmCompressionConfigs.configs.push(clone);
      this.saveLlmCompressionConfigs();
      this.selectCompressionConfigForActiveProvider(clone.id, true);
      return clone;
    },
    /** 确保当前活动渠道下的某个模型拥有独立压缩配置；模型专属压缩配置也整体替代渠道默认压缩配置。 */
    ensureCompressionConfigForActiveModel(modelId: string): LlmCompressionConfigRecord | undefined {
      const providerConfigId = this.llm.activeProviderConfigId || this.activeLlmProviderConfig?.id || '';
      const model = modelId.trim();
      if (!providerConfigId || !model) return undefined;
      const provider = this.llmProviderConfigs.configs.find((config) => config.id === providerConfigId);
      const modelRecord = provider?.models.find((item) => item.id === model);
      if (!provider || !modelRecord) return undefined;

      const binding = this.llmCompression.modelBindings.find((item) => item.providerConfigId === providerConfigId && item.modelId === model);
      const current = binding ? this.llmCompressionConfigs.configs.find((config) => config.id === binding.compressionConfigId) : undefined;
      if (current && this.isCompressionConfigOwnedByActiveModel(providerConfigId, model, current.id)) return current;

      const source = current ?? this.activeCompressionConfig ?? createDefaultLlmCompressionConfig('默认压缩方法');
      const clone = cloneCompressionConfigFrom(source, `${provider.name} · ${modelRecord.name || model} 压缩`);
      this.llmCompressionConfigs.configs.push(clone);
      this.saveLlmCompressionConfigs();
      this.selectCompressionConfigForActiveModel(model, clone.id, true);
      return clone;
    },
    updateCompressionConfig(configId: string, patch: Partial<LlmCompressionConfigRecord>): void {
      const config = this.llmCompressionConfigs.configs.find((item) => item.id === configId);
      if (!config) return;
      Object.assign(config, patch, { updatedAt: Date.now() });
      this.queueLlmCompressionConfigsAutoSave();
    },
    updateActiveCompressionTrigger(patch: Partial<LlmCompressionConfigRecord['trigger']>): void {
      const config = this.ensureCompressionConfigForActiveProvider();
      if (!config) return;
      const nextTrigger = normalizeCompressionTriggerForUi(
        { ...config.trigger, ...patch },
        this.activeLlmProviderConfig?.contextWindowTokens
      );
      if (sameSerializableValue(config.trigger, nextTrigger)) {
        this.selectCompressionConfigForActiveProvider(config.id);
        return;
      }
      config.trigger = nextTrigger;
      config.updatedAt = Date.now();
      this.queueLlmCompressionConfigsAutoSave();
      this.selectCompressionConfigForActiveProvider(config.id);
    },
    setActiveCompressionMaxDurationMinutes(value: number): void {
      const config = this.ensureCompressionConfigForActiveProvider();
      if (!config) return;
      this.updateCompressionConfig(config.id, { maxDurationMinutes: normalizeLlmCompressionMaxDurationMinutes(value) });
      this.selectCompressionConfigForActiveProvider(config.id);
    },
    setActiveCompressionBodyTargetTokens(value: number): void {
      const config = this.ensureCompressionConfigForActiveProvider();
      if (!config) return;
      this.updateCompressionConfig(config.id, { bodyTargetTokens: normalizeLlmCompressionBodyTargetTokens(value) });
      this.selectCompressionConfigForActiveProvider(config.id);
    },
    setActiveCompressionMethodKind(kind: SelectableCompressionMethodKind): void {
      const config = this.ensureCompressionConfigForActiveProvider();
      if (!config) return;
      config.kind = kind;
      if (kind === 'openai_responses_compact' && !config.openaiResponsesCompact) {
        config.openaiResponsesCompact = {};
      }
      if ((kind === 'llm_summary' || kind === 'segmented_summary') && !config.llmSummary) {
        config.llmSummary = createDefaultLlmCompressionConfig('临时').llmSummary;
      }
      config.updatedAt = Date.now();
      this.queueLlmCompressionConfigsAutoSave();
      this.selectCompressionConfigForActiveProvider(config.id);
    },
    setActiveCompressionProviderConfig(providerConfigId: string): void {
      const config = this.ensureCompressionConfigForActiveProvider();
      if (!config) return;
      const id = providerConfigId.trim();
      const applyProvider = <T extends { providerConfigId?: string }>(target: T): T => {
        if (id) target.providerConfigId = id;
        else delete target.providerConfigId;
        return target;
      };
      config.openaiResponsesCompact = applyProvider({ ...(config.openaiResponsesCompact ?? {}) });
      config.llmSummary = applyProvider({ ...(config.llmSummary ?? createDefaultLlmCompressionConfig('临时').llmSummary ?? {}) });
      config.updatedAt = Date.now();
      this.queueLlmCompressionConfigsAutoSave();
      this.selectCompressionConfigForActiveProvider(config.id);
    },
    updateModelCompressionTrigger(modelId: string, patch: Partial<LlmCompressionConfigRecord['trigger']>): void {
      const config = this.ensureCompressionConfigForActiveModel(modelId);
      if (!config) return;
      const modelConfig = this.activeLlmProviderConfig?.modelConfigs.find((item) => item.modelId === modelId.trim());
      const contextWindowTokens = modelConfig?.contextWindowTokens ?? this.activeLlmProviderConfig?.contextWindowTokens;
      const nextTrigger = normalizeCompressionTriggerForUi({ ...config.trigger, ...patch }, contextWindowTokens);
      if (sameSerializableValue(config.trigger, nextTrigger)) {
        this.selectCompressionConfigForActiveModel(modelId, config.id);
        return;
      }
      config.trigger = nextTrigger;
      config.updatedAt = Date.now();
      this.queueLlmCompressionConfigsAutoSave();
      this.selectCompressionConfigForActiveModel(modelId, config.id);
    },
    setModelCompressionMethodKind(modelId: string, kind: SelectableCompressionMethodKind): void {
      const config = this.ensureCompressionConfigForActiveModel(modelId);
      if (!config) return;
      config.kind = kind;
      if (kind === 'openai_responses_compact' && !config.openaiResponsesCompact) {
        config.openaiResponsesCompact = {};
      }
      if ((kind === 'llm_summary' || kind === 'segmented_summary') && !config.llmSummary) {
        config.llmSummary = createDefaultLlmCompressionConfig('临时').llmSummary;
      }
      config.updatedAt = Date.now();
      this.queueLlmCompressionConfigsAutoSave();
      this.selectCompressionConfigForActiveModel(modelId, config.id);
    },
    setModelCompressionMaxDurationMinutes(modelId: string, value: number): void {
      const config = this.ensureCompressionConfigForActiveModel(modelId);
      if (!config) return;
      this.updateCompressionConfig(config.id, { maxDurationMinutes: normalizeLlmCompressionMaxDurationMinutes(value) });
      this.selectCompressionConfigForActiveModel(modelId, config.id);
    },
    setModelCompressionBodyTargetTokens(modelId: string, value: number): void {
      const config = this.ensureCompressionConfigForActiveModel(modelId);
      if (!config) return;
      this.updateCompressionConfig(config.id, { bodyTargetTokens: normalizeLlmCompressionBodyTargetTokens(value) });
      this.selectCompressionConfigForActiveModel(modelId, config.id);
    },
    setModelCompressionProviderConfig(modelId: string, providerConfigId: string): void {
      const config = this.ensureCompressionConfigForActiveModel(modelId);
      if (!config) return;
      const id = providerConfigId.trim();
      const applyProvider = <T extends { providerConfigId?: string }>(target: T): T => {
        if (id) target.providerConfigId = id;
        else delete target.providerConfigId;
        return target;
      };
      config.openaiResponsesCompact = applyProvider({ ...(config.openaiResponsesCompact ?? {}) });
      config.llmSummary = applyProvider({ ...(config.llmSummary ?? createDefaultLlmCompressionConfig('临时').llmSummary ?? {}) });
      config.updatedAt = Date.now();
      this.queueLlmCompressionConfigsAutoSave();
      this.selectCompressionConfigForActiveModel(modelId, config.id);
    },



    selectLlmProviderConfig(configId: string): void {
      if (!this.llmProviderConfigs.configs.some((config) => config.id === configId)) return;
      this.llm.activeProviderConfigId = configId;
      this.saveLlm();
    },
    createLlmProviderConfig(name = '新渠道配置', provider: LlmProviderKind = 'openai-compatible'): void {
      const config = createDefaultProviderConfig(name.trim() || '新渠道配置', provider);
      this.llmProviderConfigs.configs.push(config);
      this.llm.activeProviderConfigId = config.id;
      this.pendingActiveProviderConfigIdAfterConfigsSave = config.id;
      this.saveLlmProviderConfigs();
    },
    renameLlmProviderConfig(configId: string, name: string): void {
      const config = this.llmProviderConfigs.configs.find((candidate) => candidate.id === configId);
      if (!config) return;
      config.name = name.trim() || config.name;
      config.updatedAt = Date.now();
      this.saveLlmProviderConfigs();
    },
    updateActiveLlmProviderConfig(patch: Partial<LlmProviderConfigRecord>): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      Object.assign(config, patch, { updatedAt: Date.now() });
      this.queueLlmProviderConfigsAutoSave();
    },
    updateActiveLlmContextWindowTokens(value: number | undefined): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      const previousWindowTokens = normalizeTokenCount(config.contextWindowTokens);
      const nextWindowTokens = normalizeTokenCount(value);
      if (nextWindowTokens !== undefined) config.contextWindowTokens = nextWindowTokens;
      else delete config.contextWindowTokens;
      config.updatedAt = Date.now();
      this.queueLlmProviderConfigsAutoSave();

      // 清空窗口不应触发写时复制，故在 ensure 之前早退。
      if (nextWindowTokens === undefined) return;
      const compressionConfig = this.ensureCompressionConfigForActiveProvider();
      if (!compressionConfig) return;
      compressionConfig.trigger = thresholdAfterContextWindowChange(
        compressionConfig.trigger,
        previousWindowTokens,
        nextWindowTokens
      );
      compressionConfig.updatedAt = Date.now();
      this.queueLlmCompressionConfigsAutoSave();
      this.selectCompressionConfigForActiveProvider(compressionConfig.id);
    },
    updateActiveLlmGenerationConfig(generationConfig: LlmGenerationConfigRecord | undefined): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      config.generationConfig = normalizeGenerationConfigForUi(generationConfig) ?? {};
      config.updatedAt = Date.now();
      this.queueLlmProviderConfigsAutoSave();
    },
    updateActiveLlmRequestBody(requestBody: LlmRequestBodyRecord | undefined): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      config.requestBody = sanitizeRequestBody(requestBody) ?? {};
      config.updatedAt = Date.now();
      this.queueLlmProviderConfigsAutoSave();
    },
    updateActiveLlmPromptCache(promptCache: LlmPromptCacheConfigRecord | undefined): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      config.promptCache = sanitizePromptCache(promptCache, config.provider);
      config.updatedAt = Date.now();
      this.queueLlmProviderConfigsAutoSave();
    },
    updateActiveLlmNativeResponses(nativeResponses: OpenAIResponsesNativeSettings | undefined): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      const normalized = normalizeOpenAIResponsesNativeSettings(nativeResponses);
      if (normalized) config.nativeResponses = normalized;
      else delete config.nativeResponses;
      config.updatedAt = Date.now();
      this.queueLlmProviderConfigsAutoSave();
    },
    updateActiveLlmHeaders(headers: LlmProviderHeadersRecord | undefined): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      config.headers = sanitizeHeaders(headers) ?? {};
      config.updatedAt = Date.now();
      this.queueLlmProviderConfigsAutoSave();
    },
    createModelConfigForActiveConfig(modelId: string): LlmProviderModelConfigRecord | undefined {
      const config = this.activeLlmProviderConfig;
      const id = modelId.trim();
      if (!config || !id || !config.models.some((model) => model.id === id)) return undefined;
      const existing = config.modelConfigs.find((candidate) => candidate.modelId === id);
      if (existing) return existing;
      const created = createModelConfigFromProviderConfig(config, id);
      config.modelConfigs = sanitizeModelConfigs([...(config.modelConfigs ?? []), created], config.models, config.provider);
      config.updatedAt = Date.now();
      this.saveLlmProviderConfigs();
      this.ensureCompressionConfigForActiveModel(id);
      return created;
    },
    updateActiveModelConfig(modelConfigId: string, patch: Partial<LlmProviderModelConfigRecord>): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      const modelConfig = config.modelConfigs.find((candidate) => candidate.id === modelConfigId);
      if (!modelConfig) return;
      Object.assign(modelConfig, patch, { updatedAt: Date.now() });
      config.modelConfigs = sanitizeModelConfigs(config.modelConfigs, config.models, config.provider);
      config.updatedAt = Date.now();
      this.queueLlmProviderConfigsAutoSave();
    },
    updateActiveModelConfigContextWindowTokens(modelConfigId: string, value: number | undefined): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      const modelConfig = config.modelConfigs.find((candidate) => candidate.id === modelConfigId);
      if (!modelConfig) return;
      const previousWindowTokens = normalizeTokenCount(modelConfig.contextWindowTokens);
      const nextWindowTokens = normalizeTokenCount(value);
      if (nextWindowTokens !== undefined) modelConfig.contextWindowTokens = nextWindowTokens;
      else modelConfig.contextWindowTokens = providerDefaultContextWindow(config.provider);
      modelConfig.updatedAt = Date.now();
      config.updatedAt = Date.now();
      this.queueLlmProviderConfigsAutoSave();

      if (nextWindowTokens === undefined) return;
      const compressionConfig = this.ensureCompressionConfigForActiveModel(modelConfig.modelId);
      if (!compressionConfig) return;
      compressionConfig.trigger = thresholdAfterContextWindowChange(
        compressionConfig.trigger,
        previousWindowTokens,
        nextWindowTokens
      );
      compressionConfig.updatedAt = Date.now();
      this.queueLlmCompressionConfigsAutoSave();
      this.selectCompressionConfigForActiveModel(modelConfig.modelId, compressionConfig.id);
    },
    updateActiveModelConfigGenerationConfig(modelConfigId: string, generationConfig: LlmGenerationConfigRecord | undefined): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      const modelConfig = config.modelConfigs.find((candidate) => candidate.id === modelConfigId);
      if (!modelConfig) return;
      modelConfig.generationConfig = normalizeGenerationConfigForUi(generationConfig) ?? {};
      modelConfig.updatedAt = Date.now();
      config.updatedAt = Date.now();
      this.queueLlmProviderConfigsAutoSave();
    },
    updateActiveModelConfigRequestBody(modelConfigId: string, requestBody: LlmRequestBodyRecord | undefined): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      const modelConfig = config.modelConfigs.find((candidate) => candidate.id === modelConfigId);
      if (!modelConfig) return;
      modelConfig.requestBody = sanitizeRequestBody(requestBody) ?? {};
      modelConfig.updatedAt = Date.now();
      config.updatedAt = Date.now();
      this.queueLlmProviderConfigsAutoSave();
    },
    updateActiveModelConfigPromptCache(modelConfigId: string, promptCache: LlmPromptCacheConfigRecord | undefined): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      const modelConfig = config.modelConfigs.find((candidate) => candidate.id === modelConfigId);
      if (!modelConfig) return;
      modelConfig.promptCache = sanitizePromptCache(promptCache, config.provider);
      modelConfig.updatedAt = Date.now();
      config.updatedAt = Date.now();
      this.queueLlmProviderConfigsAutoSave();
    },
    updateActiveModelConfigNativeResponses(modelConfigId: string, nativeResponses: OpenAIResponsesNativeSettings | undefined): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      const modelConfig = config.modelConfigs.find((candidate) => candidate.id === modelConfigId);
      if (!modelConfig) return;
      const normalized = normalizeOpenAIResponsesNativeSettings(nativeResponses);
      if (normalized) modelConfig.nativeResponses = normalized;
      else delete modelConfig.nativeResponses;
      modelConfig.updatedAt = Date.now();
      config.updatedAt = Date.now();
      this.queueLlmProviderConfigsAutoSave();
    },
    updateActiveModelConfigHeaders(modelConfigId: string, headers: LlmProviderHeadersRecord | undefined): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      const modelConfig = config.modelConfigs.find((candidate) => candidate.id === modelConfigId);
      if (!modelConfig) return;
      modelConfig.headers = sanitizeHeaders(headers) ?? {};
      modelConfig.updatedAt = Date.now();
      config.updatedAt = Date.now();
      this.queueLlmProviderConfigsAutoSave();
    },
    deleteModelConfigFromActiveConfig(modelConfigId: string): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      const removed = config.modelConfigs.find((candidate) => candidate.id === modelConfigId);
      const next = config.modelConfigs.filter((candidate) => candidate.id !== modelConfigId);
      if (next.length === config.modelConfigs.length) return;
      if (removed) this.cleanupCompressionForDeletedModel(config.id, removed.modelId);
      config.modelConfigs = next;
      config.updatedAt = Date.now();
      this.saveLlmProviderConfigs();
    },
    requestModelsForActiveConfig(): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      const requestConfig = toPlainProviderConfig(config);
      this.status = '正在获取 LLM 列表…';
      this.fetchedModelsDialog = { open: true, loading: true, configId: requestConfig.id, models: [] };
      try {
        bridge.request(BridgeMessageType.LlmProviderModelsGet, { config: requestConfig });
        startModelFetchTimeout(() => {
          this.status = '获取 LLM 列表超时，请检查 Base URL、API Key 或网络代理设置。';
          this.fetchedModelsDialog = { open: true, loading: false, configId: requestConfig.id, models: [] };
        });
      } catch (error) {
        this.status = `获取 LLM 列表请求发送失败：${error instanceof Error ? error.message : String(error)}`;
        this.closeFetchedModelsDialog();
      }
    },
    closeFetchedModelsDialog(): void {
      this.fetchedModelsDialog = emptyFetchedModelsDialog();
    },
    addFetchedModelsToConfig(models: LlmProviderModelRecord[]): void {
      const configId = this.fetchedModelsDialog.configId;
      const config = this.llmProviderConfigs.configs.find((candidate) => candidate.id === configId);
      const selected = sanitizeModels(models);
      if (!config || selected.length === 0) {
        this.closeFetchedModelsDialog();
        return;
      }
      const selectedIds = new Set(selected.map((model) => model.id));
      config.models = sanitizeModels([
        ...config.models.filter((model) => !selectedIds.has(model.id)),
        ...selected
      ]);
      if (!config.model) config.model = selected[0]?.id ?? '';
      config.updatedAt = Date.now();
      this.status = `已添加 ${selected.length} 个 LLM`;
      this.closeFetchedModelsDialog();
      this.saveLlmProviderConfigs();
    },
    addModelToActiveConfig(modelId: string, modelName?: string): void {
      const config = this.activeLlmProviderConfig;
      const id = modelId.trim();
      if (!config || !id) return;
      const name = modelName?.trim() || id;
      const models = sanitizeModels([...config.models.filter((model) => model.id !== id), { id, name }]);
      config.models = models;
      config.model = id;
      config.updatedAt = Date.now();
      this.saveLlmProviderConfigs();
    },
    selectActiveConfigModel(modelId: string): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      this.selectLlmProviderConfigModel(config.id, modelId);
    },
    selectLlmProviderConfigModel(configId: string, modelId: string): void {
      const config = this.llmProviderConfigs.configs.find((candidate) => candidate.id === configId);
      const id = modelId.trim();
      if (!config || !config.models.some((model) => model.id === id)) return;
      config.model = id;
      config.updatedAt = Date.now();
      this.saveLlmProviderConfigs();
    },
    removeModelFromActiveConfig(modelId: string): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      config.models = config.models.filter((model) => model.id !== modelId);
      config.modelConfigs = config.modelConfigs.filter((modelConfig) => modelConfig.modelId !== modelId);
      this.cleanupCompressionForDeletedModel(config.id, modelId);
      if (config.model === modelId) config.model = config.models[0]?.id ?? '';
      config.updatedAt = Date.now();
      this.saveLlmProviderConfigs();
    },
    clearModelsFromActiveConfig(): void {
      const config = this.activeLlmProviderConfig;
      if (!config) return;
      for (const modelConfig of config.modelConfigs) {
        this.cleanupCompressionForDeletedModel(config.id, modelConfig.modelId);
      }
      config.models = [];
      config.model = '';
      config.modelConfigs = [];
      config.updatedAt = Date.now();
      this.saveLlmProviderConfigs();
    },
    deleteLlmProviderConfig(configId: string): void {
      if (this.llmProviderConfigs.configs.length <= 1) {
        this.status = '至少需要保留一个渠道配置';
        return;
      }
      const nextConfigs = this.llmProviderConfigs.configs.filter((config) => config.id !== configId);
      if (nextConfigs.length === this.llmProviderConfigs.configs.length) return;
      this.llmProviderConfigs.configs = nextConfigs;
      if (this.llm.activeProviderConfigId === configId) {
        this.llm.activeProviderConfigId = nextConfigs[0]?.id ?? '';
        this.pendingActiveProviderConfigIdAfterConfigsSave = this.llm.activeProviderConfigId;
      }
      this.cleanupCompressionForDeletedProvider(configId);
      this.saveLlmProviderConfigs();
    },
    /** 删除渠道时清理其压缩绑定，并回收仅被这些绑定引用的孤儿压缩配置（默认配置除外）。 */
    cleanupCompressionForDeletedProvider(providerConfigId: string): void {
      const removedConfigIds = [
        ...this.llmCompression.providerBindings.filter((binding) => binding.providerConfigId === providerConfigId).map((binding) => binding.compressionConfigId),
        ...this.llmCompression.modelBindings.filter((binding) => binding.providerConfigId === providerConfigId).map((binding) => binding.compressionConfigId)
      ];
      if (removedConfigIds.length === 0) return;
      this.llmCompression.providerBindings = this.llmCompression.providerBindings.filter((binding) => binding.providerConfigId !== providerConfigId);
      this.llmCompression.modelBindings = this.llmCompression.modelBindings.filter((binding) => binding.providerConfigId !== providerConfigId);
      for (const configId of removedConfigIds) this.deleteCompressionConfigIfOrphan(configId);
      this.saveLlmCompression();
    },
    /** 删除模型专属配置时清理其压缩绑定，并回收孤儿压缩配置。 */
    cleanupCompressionForDeletedModel(providerConfigId: string, modelId: string): void {
      const model = modelId.trim();
      const removed = this.llmCompression.modelBindings.find((binding) => binding.providerConfigId === providerConfigId && binding.modelId === model);
      if (!removed) return;
      this.llmCompression.modelBindings = this.llmCompression.modelBindings.filter((binding) => !(binding.providerConfigId === providerConfigId && binding.modelId === model));
      this.deleteCompressionConfigIfOrphan(removed.compressionConfigId);
      this.saveLlmCompression();
    },
    deleteCompressionConfigIfOrphan(configId: string): void {
      if (!configId || configId === this.llmCompression.defaultConfigId) return;
      const referencedByProvider = this.llmCompression.providerBindings.some((binding) => binding.compressionConfigId === configId);
      const referencedByModel = this.llmCompression.modelBindings.some((binding) => binding.compressionConfigId === configId);
      if (referencedByProvider || referencedByModel) return;
      this.llmCompressionConfigs.configs = this.llmCompressionConfigs.configs.filter((config) => config.id !== configId);
      if (this.llmCompressionConfigs.configs.length === 0) {
        const created = createDefaultLlmCompressionConfig('默认压缩方法');
        this.llmCompressionConfigs.configs.push(created);
        this.llmCompression.defaultConfigId = created.id;
      }
      this.saveLlmCompressionConfigs();
    },
    /** 外部修改冲突时，保留当前表单并基于最新版本重新保存。 */
    dismissExternalSettingsChange(section?: GlobalSettingsSection): void {
      const sections = section ? [section] : Object.keys(this.pendingExternalSnapshots) as GlobalSettingsSection[];
      for (const item of sections) {
        const payload = this.pendingExternalSnapshots[item];
        if (!payload || coordinatorFor(item).inFlight) continue;
        const baseline = this.baselines[item];
        const local = plainSettingsFromState(this, item);
        const merged = baseline
          ? mergeSettingsThreeWay(baseline, local, payload.settings, true).value
          : local;
        this.applyCommittedMetadata(payload);
        this.applySectionSettings(item, merged);
        delete this.pendingExternalSnapshots[item];
        delete this.externalChangedSections[item];
        const coordinator = coordinatorFor(item);
        coordinator.paused = false;
        coordinator.awaitingConflictSnapshot = false;
        coordinator.queued = undefined;
        if (!sameSettingsContent(merged, payload.settings)) {
          this.enqueueSettingsUpdate({ section: item, settings: plainSettingsFromState(this, item) });
        }
      }
    },
    /** 外部修改冲突时，丢弃本地未确认内容并载入磁盘版本。 */
    applyExternalSettingsChange(section?: GlobalSettingsSection): void {
      const sections = section ? [section] : Object.keys(this.pendingExternalSnapshots) as GlobalSettingsSection[];
      for (const item of sections) {
        const payload = this.pendingExternalSnapshots[item];
        if (!payload || coordinatorFor(item).inFlight) continue;
        const coordinator = coordinatorFor(item);
        coordinator.paused = false;
        clearSectionSaveTimeout(coordinator);
        coordinator.queued = undefined;
        coordinator.awaitingConflictSnapshot = false;
        if (item === 'llmProviderConfigs') {
          clearLlmProviderConfigsAutoSaveTimer();
          this.pendingActiveProviderConfigIdAfterConfigsSave = '';
        }
        if (item === 'llmCompressionConfigs') {
          clearLlmCompressionConfigsAutoSaveTimer();
          this.flushCompressionBindingAfterConfigsSave = false;
        }
        this.applyCommittedMetadata(payload);
        this.applySectionSettings(item, payload.settings);
        delete this.pendingExternalSnapshots[item];
        delete this.externalChangedSections[item];
        this.clearPendingSettingSection(item);
      }
      settleSettingsStatus(this, '已载入外部设置');
    },
    applySnapshot(payload: GlobalSettingsSnapshotPayload, correlationId?: string): void {
      const section = payload.section;
      payload = { ...payload, settings: normalizeSettingsSnapshot(section, payload.settings) };
      const coordinator = coordinatorFor(section);
      if (correlationId && coordinator.ignoredReplyIds.has(correlationId)) return;
      if (correlationId && coordinator.recoveryRequestId === correlationId) {
        clearSectionSaveTimeout(coordinator);
        coordinator.recoveryRequestId = undefined;
        ignoreSettingsReply(coordinator, correlationId);
        const attempted = coordinator.inFlight;
        if (attempted && sameSettingsContent(attempted.payload.settings, payload.settings)) {
          this.applySnapshot(payload, attempted.requestId);
          return;
        }
        if (attempted) {
          ignoreSettingsReply(coordinator, attempted.requestId);
          coordinator.inFlight = undefined;
          coordinator.queued = { section, settings: plainSettingsFromState(this, section) };
        }
        coordinator.paused = false;
        coordinator.awaitingConflictSnapshot = false;
        this.resolveExternalSnapshot(payload);
        return;
      }
      const localAttempt = correlationId && coordinator.inFlight?.requestId === correlationId
        ? coordinator.inFlight
        : undefined;

      if (localAttempt) {
        clearSectionSaveTimeout(coordinator);
        ignoreSettingsReply(coordinator, localAttempt.requestId);
        ignoreSettingsReply(coordinator, coordinator.recoveryRequestId);
        coordinator.recoveryRequestId = undefined;
        coordinator.inFlight = undefined;
        coordinator.paused = false;
        coordinator.awaitingConflictSnapshot = false;
        const current = plainSettingsFromState(this, section);
        const merged = mergeSettingsThreeWay(localAttempt.payload.settings, current, payload.settings, true);
        this.applyCommittedMetadata(payload);
        this.applySectionSettings(section, merged.value);
        this.flushDependentSettingsAfterCommittedSnapshot(payload);
        if (coordinator.queued) {
          coordinator.queued.settings = plainSettingsFromState(this, section);
        } else if (!sameSettingsContent(merged.value, payload.settings)) {
          coordinator.queued = { section, settings: plainSettingsFromState(this, section) };
        }
        const pendingExternal = this.pendingExternalSnapshots[section];
        if (pendingExternal && pendingExternal.revision !== payload.revision) {
          this.resolveExternalSnapshot(pendingExternal);
        } else {
          delete this.pendingExternalSnapshots[section];
          delete this.externalChangedSections[section];
        }
        this.pumpSettingsUpdate(section);
        this.refreshPendingSettingSection(section);
        settleSettingsStatus(this, '设置已同步');
        return;
      }

      this.clearLoadingSettingSection(section);
      if (this.loadedSections[section] && this.revisions[section] === payload.revision) {
        this.pumpSettingsUpdate(section);
        settleSettingsStatus(this, '设置已同步');
        return;
      }
      if (!this.loadedSections[section]) {
        this.applyCommittedMetadata(payload);
        this.applySectionSettings(section, payload.settings);
        this.pumpSettingsUpdate(section);
        this.refreshPendingSettingSection(section);
        settleSettingsStatus(this, '设置已同步');
        return;
      }
      if (coordinator.inFlight) {
        this.stageExternalSnapshot(payload);
        return;
      }
      if (isSectionDirty(this, section) || coordinator.awaitingConflictSnapshot) {
        this.resolveExternalSnapshot(payload);
        return;
      }
      this.applyCommittedMetadata(payload);
      this.applySectionSettings(section, payload.settings);
      this.pumpSettingsUpdate(section);
      this.refreshPendingSettingSection(section);
      settleSettingsStatus(this, '设置已同步');
    },
    resolveExternalSnapshot(payload: GlobalSettingsSnapshotPayload): boolean {
      const section = payload.section;
      const baseline = this.baselines[section];
      if (!baseline) {
        this.applyCommittedMetadata(payload);
        this.applySectionSettings(section, payload.settings);
        return true;
      }
      const local = plainSettingsFromState(this, section);
      const merged = mergeSettingsThreeWay(baseline, local, payload.settings);
      if (merged.conflicts.length > 0) {
        this.stageExternalSnapshot(payload, true);
        coordinatorFor(section).awaitingConflictSnapshot = false;
        coordinatorFor(section).paused = true;
        this.clearLoadingSettingSection(section);
        this.clearPendingSettingSection(section);
        this.failedSettingsSections[section] = '其他窗口也修改了这项设置，请选择保留当前或载入外部。';
        this.status = `其他窗口也修改了这项设置，本地内容已保留，请选择保留当前或载入外部。`;
        return false;
      }
      this.applyCommittedMetadata(payload);
      this.applySectionSettings(section, merged.value);
      delete this.pendingExternalSnapshots[section];
      delete this.externalChangedSections[section];
      coordinatorFor(section).paused = false;
      coordinatorFor(section).awaitingConflictSnapshot = false;
      if (coordinatorFor(section).queued) coordinatorFor(section).queued!.settings = plainSettingsFromState(this, section);
      this.pumpSettingsUpdate(section);
      this.refreshPendingSettingSection(section);
      return true;
    },
    stageExternalSnapshot(payload: GlobalSettingsSnapshotPayload, conflicting = false): void {
      this.pendingExternalSnapshots[payload.section] = {
        ...payload,
        settings: cloneSettingsValue(payload.settings)
      };
      if (conflicting) this.externalChangedSections[payload.section] = true;
    },
    applyCommittedMetadata(payload: GlobalSettingsSnapshotPayload): void {
      this.loadedSections[payload.section] = true;
      this.filePaths[payload.section] = payload.filePath;
      this.revisions[payload.section] = payload.revision;
      this.baselines[payload.section] = cloneSettingsValue(payload.settings);
      this.clearLoadingSettingSection(payload.section);
      delete this.failedSettingsSections[payload.section];
    },
    applySectionSettings(section: GlobalSettingsSection, value: GlobalSettingsSectionValue): void {
      if (section === 'llm') this.llm = { ...emptyLlm(), ...(value as LlmSettingsRecord) };
      else if (section === 'network') this.network = { ...emptyNetwork(), ...(value as NetworkSettingsRecord) };
      else if (section === 'llmProviderConfigs') {
        const settings = value as LlmProviderConfigsRecord;
        this.llmProviderConfigs = { configs: settings.configs.map(normalizeProviderConfigForUi) };
      } else if (section === 'llmCompression') {
        this.llmCompression = { ...emptyLlmCompression(), ...(value as LlmCompressionSettingsRecord) };
      } else if (section === 'llmCompressionConfigs') {
        const settings = value as LlmCompressionConfigsRecord;
        this.llmCompressionConfigs = { configs: settings.configs.map((config) => normalizeCompressionConfigForUi(config)) };
      } else if (section === 'checkpointMaintenance') {
        this.checkpointMaintenance = { ...emptyCheckpointMaintenance(), ...(value as CheckpointMaintenanceSettingsRecord) };
      } else if (section === 'appearance') {
        this.appearance = { ...emptyAppearance(), ...(value as AppearanceSettingsRecord) };
      } else if (section === 'attachments') {
        this.attachments = { ...emptyAttachments(), ...(value as AttachmentSettingsRecord) };
      } else if (section === 'debugCapture') {
        this.debugCapture = normalizeDebugCaptureSettings(value as DebugCaptureSettings);
      } else if (section === 'mcpServers') {
        const settings = value as McpServersSettingsRecord;
        this.mcpServers = { servers: [...(settings.servers ?? [])].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)) };
      } else this.common = { ...emptyCommon(), ...(value as Partial<GlobalSettingsRecord>) };
    },
    flushDependentSettingsAfterCommittedSnapshot(payload: GlobalSettingsSnapshotPayload): void {
      if (payload.section === 'llmProviderConfigs' && this.pendingActiveProviderConfigIdAfterConfigsSave) {
        const pendingId = this.pendingActiveProviderConfigIdAfterConfigsSave;
        this.pendingActiveProviderConfigIdAfterConfigsSave = '';
        const configs = (payload.settings as LlmProviderConfigsRecord).configs;
        this.llm.activeProviderConfigId = configs.some((config) => config.id === pendingId)
          ? pendingId
          : configs[0]?.id ?? '';
        this.saveLlm();
      }
      if (payload.section === 'llmCompressionConfigs' && this.flushCompressionBindingAfterConfigsSave) {
        this.flushCompressionBindingAfterConfigsSave = false;
        this.saveLlmCompression();
      }
    },
    refreshPendingSettingSection(section: GlobalSettingsSection): void {
      if (hasPendingSectionSave(section)) this.markPendingSettingSection(section);
      else this.clearPendingSettingSection(section);
    },
    applyLlmProviderModelsSnapshot(payload: LlmProviderModelsSnapshotPayload): void {
      clearModelFetchTimeout();
      const config = this.llmProviderConfigs.configs.find((candidate) => candidate.id === payload.configId);
      if (!config) return;
      const models = sanitizeModels(payload.models);
      this.fetchedModelsDialog = { open: true, loading: false, configId: payload.configId, models };
      this.status = models.length ? `已获取 ${models.length} 个 LLM，请选择要添加的 LLM` : '没有获取到 LLM';
    },
    setError(message: string, options: GlobalSettingsErrorOptions = {}): void {
      clearModelFetchTimeout();
      if (options.requestType === BridgeMessageType.LlmProviderModelsGet) {
        this.closeFetchedModelsDialog();
        this.status = settingsErrorStatus(options.requestType, message);
        return;
      }

      this.closeFetchedModelsDialog();
      if (options.section) {
        const coordinator = coordinatorFor(options.section);
        if (options.correlationId && coordinator.ignoredReplyIds.has(options.correlationId)) return;
        if (options.correlationId && coordinator.recoveryRequestId === options.correlationId) {
          clearSectionSaveTimeout(coordinator);
          ignoreSettingsReply(coordinator, coordinator.recoveryRequestId);
          coordinator.recoveryRequestId = undefined;
        }
        if (options.correlationId && coordinator.inFlight?.requestId === options.correlationId) {
          clearSectionSaveTimeout(coordinator);
          const failed = coordinator.inFlight;
          ignoreSettingsReply(coordinator, failed.requestId);
          coordinator.inFlight = undefined;
          coordinator.queued = coordinator.queued ?? failed.payload;
        }
        if (options.code === 'settings_revision_conflict') {
          coordinator.awaitingConflictSnapshot = true;
          const latest = this.pendingExternalSnapshots[options.section];
          if (latest) {
            this.resolveExternalSnapshot(latest);
          } else {
            this.recoverSettingsSave(options.section);
          }
          return;
        }
        coordinator.paused = true;
        this.clearLoadingSettingSection(options.section);
        this.refreshPendingSettingSection(options.section);
        this.failedSettingsSections[options.section] = message;
      } else {
        this.loadingSettingsSections = {};
        this.pendingSettingsSections = {};
      }
      this.status = settingsErrorStatus(options.requestType, message);
    }
  }
});
