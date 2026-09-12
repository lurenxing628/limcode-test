import * as vscode from 'vscode';
import type {
  LlmCompressionConfigRecord,
  LlmCompressionConfigsRecord,
  LlmCompressionMethodKind,
  LlmCompressionSettingsRecord,
  LlmCompressionThresholdUnit,
  LlmCompressionTriggerMode
} from '../../../shared/protocol';
import {
  DEFAULT_LLM_COMPRESSION_SUMMARY_TARGET_TOKENS,
  DEFAULT_LLM_COMPRESSION_TRIGGER_PERCENT,
  createDefaultLlmCompressionConfig,
  normalizeLlmCompressionBodyTargetTokens,
  normalizeLlmCompressionMaxDurationMinutes
} from '../../../shared/protocol';
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
const CONFIGS_DIR = 'llm-compression-configs';
const DEFAULT_CONFIG_NAME = '默认压缩方法';
const REVISION_SECTION = 'llmCompressionConfigs';

export interface LlmCompressionConfigsSettingsResult {
  settings: LlmCompressionConfigsRecord;
  filePath: string;
  revision: string;
  previousSettings?: LlmCompressionConfigsRecord;
}

export async function loadLlmCompressionConfigsSettings(paths: StoragePaths): Promise<LlmCompressionConfigsSettingsResult> {
  const root = configsRootUri(paths);
  const indexUri = configsIndexUri(paths);
  const snapshot = await loadRecordStoreSnapshot<LlmCompressionConfigRecord, typeof RECORD_KEY>(root, indexUri, RECORD_KEY);
  if (snapshot && snapshot.records.length > 0) return compressionSettingsFromSnapshot(indexUri, snapshot);

  const config = normalizeLlmCompressionConfig(createDefaultLlmCompressionConfig(DEFAULT_CONFIG_NAME));
  try {
    const initialized = await commitRecordStoreSnapshot(root, indexUri, [config], RECORD_KEY, (record) => record.name, {
      expectedRevision: snapshot?.revision ?? missingRecordStoreRevision(indexUri),
      section: REVISION_SECTION,
      pruneMissing: true
    });
    return compressionSettingsFromSnapshot(indexUri, initialized);
  } catch (error) {
    if (!isSettingsRevisionConflictError(error)) throw error;
    const current = await loadRecordStoreSnapshot<LlmCompressionConfigRecord, typeof RECORD_KEY>(root, indexUri, RECORD_KEY);
    if (!current || current.records.length === 0) throw error;
    return compressionSettingsFromSnapshot(indexUri, current);
  }
}

export async function saveLlmCompressionConfigsSettings(
  paths: StoragePaths,
  settings: Partial<LlmCompressionConfigsRecord> | undefined,
  expectedRevision: string
): Promise<LlmCompressionConfigsSettingsResult> {
  const configs = normalizeConfigList(settings?.configs);
  if (configs.length === 0) throw new Error('至少需要保留一个压缩方法配置。');

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
    ...compressionSettingsFromSnapshot(indexUri, committed),
    previousSettings: compressionSettingsFromRecords(committed.previousRecords)
  };
}

export function normalizeLlmCompressionSettings(input: Partial<LlmCompressionSettingsRecord> | undefined, configs: LlmCompressionConfigRecord[] = []): LlmCompressionSettingsRecord {
  const configIds = new Set(configs.map((config) => config.id));
  const defaultConfigId = typeof input?.defaultConfigId === 'string' && (!configIds.size || configIds.has(input.defaultConfigId))
    ? input.defaultConfigId
    : configs[0]?.id;
  const providerBindings = (Array.isArray(input?.providerBindings) ? input.providerBindings : [])
    .map((binding) => {
      const providerConfigId = typeof binding?.providerConfigId === 'string' ? binding.providerConfigId.trim() : '';
      const compressionConfigId = typeof binding?.compressionConfigId === 'string' ? binding.compressionConfigId.trim() : '';
      if (!providerConfigId || !compressionConfigId || (configIds.size > 0 && !configIds.has(compressionConfigId))) return undefined;
      const createdAt = finiteTimestamp(binding.createdAt, Date.now());
      return {
        id: typeof binding.id === 'string' && binding.id.trim() ? binding.id.trim() : `llm-compression-binding-${providerConfigId}`,
        providerConfigId,
        compressionConfigId,
        role: 'default' as const,
        createdAt,
        updatedAt: finiteTimestamp(binding.updatedAt, createdAt)
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined);
  const modelBindings = (Array.isArray(input?.modelBindings) ? input.modelBindings : [])
    .map((binding) => {
      const providerConfigId = typeof binding?.providerConfigId === 'string' ? binding.providerConfigId.trim() : '';
      const modelId = typeof binding?.modelId === 'string' ? binding.modelId.trim() : '';
      const compressionConfigId = typeof binding?.compressionConfigId === 'string' ? binding.compressionConfigId.trim() : '';
      if (!providerConfigId || !modelId || !compressionConfigId || (configIds.size > 0 && !configIds.has(compressionConfigId))) return undefined;
      const createdAt = finiteTimestamp(binding.createdAt, Date.now());
      return {
        id: typeof binding.id === 'string' && binding.id.trim() ? binding.id.trim() : `llm-compression-model-binding-${providerConfigId}-${safeId(modelId)}`,
        providerConfigId,
        modelId,
        compressionConfigId,
        role: 'model' as const,
        createdAt,
        updatedAt: finiteTimestamp(binding.updatedAt, createdAt)
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== undefined);
  return { ...(defaultConfigId ? { defaultConfigId } : {}), providerBindings, modelBindings };
}

export function normalizeLlmCompressionConfig(input: Partial<LlmCompressionConfigRecord> | undefined): LlmCompressionConfigRecord {
  const fallback = createDefaultLlmCompressionConfig(DEFAULT_CONFIG_NAME);
  const createdAt = finiteTimestamp(input?.createdAt, fallback.createdAt);
  const kind = isKnownKind(input?.kind) ? input.kind : fallback.kind;
  const trigger = normalizeTrigger(input?.trigger);
  const llmSummary = normalizeLlmSummary(input?.llmSummary)
    ?? (isTextSummaryKind(kind) ? { targetTokens: DEFAULT_LLM_COMPRESSION_SUMMARY_TARGET_TOKENS } : undefined);
  return {
    id: stringOrDefault(input?.id, fallback.id),
    name: stringOrDefault(input?.name, fallback.name),
    kind,
    trigger,
    maxDurationMinutes: normalizeLlmCompressionMaxDurationMinutes(input?.maxDurationMinutes),
    bodyTargetTokens: normalizeLlmCompressionBodyTargetTokens(input?.bodyTargetTokens),
    ...(normalizeOpenAICompact(input?.openaiResponsesCompact) ? { openaiResponsesCompact: normalizeOpenAICompact(input?.openaiResponsesCompact) } : {}),
    ...(llmSummary ? { llmSummary } : {}),
    createdAt,
    updatedAt: finiteTimestamp(input?.updatedAt, createdAt)
  };
}

function normalizeConfigList(input: LlmCompressionConfigRecord[] | undefined): LlmCompressionConfigRecord[] {
  const byId = new Map<string, LlmCompressionConfigRecord>();
  for (const item of input ?? []) byId.set(item.id, normalizeLlmCompressionConfig({ ...item, updatedAt: Date.now() }));
  return sortConfigs([...byId.values()]);
}

function compressionSettingsFromSnapshot(
  indexUri: vscode.Uri,
  snapshot: RecordStoreSnapshot<LlmCompressionConfigRecord>
): LlmCompressionConfigsSettingsResult {
  return {
    settings: compressionSettingsFromRecords(snapshot.records),
    filePath: indexUri.fsPath,
    revision: snapshot.revision
  };
}

function compressionSettingsFromRecords(records: LlmCompressionConfigRecord[]): LlmCompressionConfigsRecord {
  return { configs: sortConfigs(records.map((record) => normalizeLlmCompressionConfig(record))) };
}

function configsRootUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(paths.settingsRootUri, CONFIGS_DIR);
}

function configsIndexUri(paths: StoragePaths): vscode.Uri {
  return vscode.Uri.joinPath(configsRootUri(paths), INDEX_FILE);
}

function sortConfigs(records: LlmCompressionConfigRecord[]): LlmCompressionConfigRecord[] {
  return [...records].sort((left, right) => left.createdAt - right.createdAt || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function normalizeTrigger(input: unknown): LlmCompressionConfigRecord['trigger'] {
  const record = isPlainObject(input) ? input : {};
  if (
    Object.prototype.hasOwnProperty.call(record, 'preserveLatestMessages')
    || Object.prototype.hasOwnProperty.call(record, 'reserveLatestUserMessageTokens')
  ) {
    throw new TypeError(
      'Compression trigger uses removed message-count/user-reserve fields; recreate it with the current schema.'
    );
  }
  const thresholdUnit: LlmCompressionThresholdUnit = isKnownThresholdUnit(record.thresholdUnit) ? record.thresholdUnit : 'percent';
  // 按百分比触发时阈值 Token 数是现算的派生量（运行时按 百分比 x 上下文窗口 取值，不读这个字段），
  // 存下来只会和前端序列化结果对不上，让该 section 永远处于未保存状态。
  const thresholdTokens = thresholdUnit === 'tokens' ? finitePositiveNumber(record.thresholdTokens) : undefined;
  const inputThresholdPercent = finitePercent(record.thresholdPercent);
  const mode: LlmCompressionTriggerMode = record.mode === 'manual' ? 'manual' : 'token_threshold';
  const thresholdPercent = inputThresholdPercent ?? DEFAULT_LLM_COMPRESSION_TRIGGER_PERCENT;
  return {
    mode,
    thresholdUnit,
    thresholdPercent,
    ...(thresholdTokens !== undefined ? { thresholdTokens } : {})
  };
}

function normalizeOpenAICompact(input: unknown): LlmCompressionConfigRecord['openaiResponsesCompact'] | undefined {
  if (!isPlainObject(input)) return undefined;
  return {
    ...(optionalString(input.providerConfigId) ? { providerConfigId: optionalString(input.providerConfigId) } : {}),
    ...(optionalString(input.model) ? { model: optionalString(input.model) } : {})
  };
}

function normalizeLlmSummary(input: unknown): LlmCompressionConfigRecord['llmSummary'] | undefined {
  if (!isPlainObject(input)) return undefined;
  return {
    ...(optionalString(input.providerConfigId) ? { providerConfigId: optionalString(input.providerConfigId) } : {}),
    ...(optionalString(input.model) ? { model: optionalString(input.model) } : {}),
    ...(optionalString(input.systemPrompt) ? { systemPrompt: optionalString(input.systemPrompt) } : {}),
    ...(optionalString(input.userPrompt) ? { userPrompt: optionalString(input.userPrompt) } : {}),
    targetTokens: finitePositiveNumber(input.targetTokens) ?? DEFAULT_LLM_COMPRESSION_SUMMARY_TARGET_TOKENS,
    ...(isPlainObject(input.generationConfig) ? { generationConfig: input.generationConfig } : {})
  };
}

function isTextSummaryKind(kind: LlmCompressionMethodKind): boolean {
  return kind === 'llm_summary'
    || kind === 'segmented_summary'
    || kind === 'deterministic_summary'
    || kind === 'manual_summary';
}

function isKnownKind(value: unknown): value is LlmCompressionMethodKind {
  return value === 'disabled' || value === 'openai_responses_compact' || value === 'llm_summary' || value === 'segmented_summary' || value === 'deterministic_summary' || value === 'manual_summary';
}

function isKnownThresholdUnit(value: unknown): value is LlmCompressionThresholdUnit {
  return value === 'percent' || value === 'tokens';
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function optionalString(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
}

function finiteTimestamp(value: unknown, fallback: number): number {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
}

function finitePositiveNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function finitePercent(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(100, Math.max(1, number));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
