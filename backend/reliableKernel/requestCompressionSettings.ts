import type { ChatModelOverrideRecord, LlmGenerationConfigRecord, LlmRequestBodyRecord } from '../../shared/protocol';
import { DEFAULT_LLM_COMPRESSION_OUTPUT_RESERVE_TOKENS, canonicalLlmProviderKind } from '../../shared/protocol';
import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import {
  frozenCompressionPolicy,
  frozenContextProfile,
  frozenModelSelection,
  readFrozenTurnAuthority,
  type FrozenContextProfile
} from './frozenAuthority';
import { canonicalPlainJson, normalizePlainJson, type PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';

export interface RequestCompressionSettings {
  model: ChatModelOverrideRecord;
  modelProfile: FrozenContextProfile;
  compression: PlainJsonValue;
}

export interface RequestGenerationSettings {
  model: ChatModelOverrideRecord;
  generationConfig: LlmGenerationConfigRecord;
  requestBody: LlmRequestBodyRecord;
  thinkingControlledByBody: boolean;
}

export interface CompressionSettingsAuthority {
  loadRequestGenerationSettings?(model: ChatModelOverrideRecord, conversationId: string): Promise<RequestGenerationSettings>;
  loadRequestCompressionSettings(model: ChatModelOverrideRecord, generationConfig?: LlmGenerationConfigRecord): Promise<RequestCompressionSettings>;
}

/** 单次请求可以独立选择压缩设置；空设置引用明确表示使用本轮原配置。 */
export function applyRequestCompressionSettings(
  authority: PlainJsonValue,
  settings: PlainJsonValue | undefined
): PlainJsonValue {
  if (record(settings) && Object.prototype.hasOwnProperty.call(settings, 'requestGeneration')) {
    const generation = settings.requestGeneration;
    if (!record(authority) || !record(authority.model) || !record(generation) || !record(generation.generationConfig)
      || !sameModelSelection(generation.model, authority)) throw new Error('请求生成设置不能更换本轮模型。');
    authority = normalizePlainJson({ ...authority, model: {
      ...authority.model, generationConfig: generation.generationConfig,
      maxOutputTokens: generation.generationConfig.maxOutputTokens ?? DEFAULT_LLM_COMPRESSION_OUTPUT_RESERVE_TOKENS,
      requestBody: generation.requestBody, thinkingControlledByBody: generation.thinkingControlledByBody,
      thinkingConfig: generation.generationConfig.thinkingConfig ?? {}
    } }, '请求生成设置');
  }
  if (!record(settings) || !Object.prototype.hasOwnProperty.call(settings, 'requestCompression')) return authority;
  const selected = settings.requestCompression;
  if (!record(authority) || !record(selected) || !record(selected.modelProfile) || !record(selected.compression)) {
    throw new TypeError('请求压缩设置不完整。');
  }
  if (!sameModelSelection(selected.model, authority)) {
    throw new Error('请求压缩设置不能更换本轮的模型选择。');
  }
  const effective = normalizePlainJson({
    ...authority,
    modelProfile: { ...(record(authority.modelProfile) ? authority.modelProfile : {}), ...selected.modelProfile },
    compression: selected.compression
  }, '请求压缩设置');
  const profile = frozenContextProfile(effective);
  const enabled = selected.compression.enabled;
  const config = selected.compression.config;
  if (typeof enabled !== 'boolean' || !record(config)
    || selected.compression.methodKind !== config.kind || enabled !== (config.kind !== 'disabled')
    || selected.compression.thresholdTokens !== profile.compressionThresholdTokens) {
    throw new TypeError('请求压缩开关或阈值不一致。');
  }
  frozenCompressionPolicy(effective);
  return effective;
}

export async function readRequestSettings(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  contentObjectId: string
): Promise<PlainJsonValue> {
  const result = await database.snapshot([DOMAIN_REPOSITORIES.domain('ContentObject').get(contentObjectId)]);
  const row = result.snapshot[0];
  if (!row || Array.isArray(row)) throw new Error('请求设置记录不存在。');
  return normalizePlainJson(JSON.parse((await contentStore.read(row as ContentObjectMetadata)).toString('utf8')), '请求设置');
}

export async function readRequestTurnAuthority(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  authoritySnapshotId: string,
  turnId?: string,
  settingsSnapshotContentObjectId?: string
) {
  const frozen = await readFrozenTurnAuthority(database, contentStore, authoritySnapshotId, turnId);
  if (!settingsSnapshotContentObjectId) return frozen;
  const settings = await readRequestSettings(database, contentStore, settingsSnapshotContentObjectId);
  return { ...frozen, document: applyRequestCompressionSettings(frozen.document, settings) };
}

/**
 * 两边都先规范化再比较：升级前冻结的请求设置快照里仍是原 DeepSeek 渠道类型（'deepseek'），
 * 而 frozenModelSelection 已把它读作 OpenAI 兼容。
 */
function sameModelSelection(value: PlainJsonValue | undefined, authority: PlainJsonValue): boolean {
  if (!record(value)) return false;
  const provider = canonicalLlmProviderKind(value.provider);
  const selection = provider ? { ...value, provider } : value;
  return canonicalPlainJson(selection) === canonicalPlainJson(frozenModelSelection(authority));
}

function record(value: unknown): value is { [key: string]: PlainJsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
