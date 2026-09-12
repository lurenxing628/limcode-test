import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { normalizePlainJson, type PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';
import type { FrozenWorkEnvironmentBoundaryPolicy } from './workEnvironmentBoundary';
import { MAX_LLM_RETRY_DELAY_SECONDS } from '../../shared/protocol';
import type { ChatModelOverrideRecord, LlmCompressionConfigRecord, LlmProviderKind } from '../../shared/protocol';

export interface FrozenContextProfile {
  contextWindowTokens: number;
  compressionThresholdTokens: number;
  tokenEstimator: {
    kind: 'utf8-bytes-ceil';
    bytesPerToken: number;
  };
}

export interface FrozenTurnAuthority {
  snapshot: DomainRow;
  turn: DomainRow;
  document: PlainJsonValue;
  turnId: string;
  conversationId: string;
}

export interface FrozenProviderRetryPolicy {
  enabled: boolean;
  /** Number of retries after the original Provider attempt. */
  maxRetries: number;
  /** Fixed wait before each retry; 0 keeps the kernel automatic exponential backoff. */
  retryDelayMs: number;
}

export interface FrozenCompressionPolicy {
  enabled: boolean;
  methodKind: LlmCompressionConfigRecord['kind'];
  config: LlmCompressionConfigRecord;
  triggerMode: LlmCompressionConfigRecord['trigger']['mode'];
  thresholdTokens: number;
  provider: {
    providerConfigId: string;
    provider: LlmProviderKind;
    modelId: string;
    contextWindowTokens: number;
    maxOutputTokens: number;
    retryPolicy: FrozenProviderRetryPolicy;
  };
}

export async function readFrozenTurnAuthority(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  authoritySnapshotId: string,
  expectedTurnId?: string
): Promise<FrozenTurnAuthority> {
  const snapshotRead = await database.snapshot([
    DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').get(requireId(authoritySnapshotId, 'authoritySnapshotId'))
  ]);
  const snapshot = requireRow(snapshotRead.snapshot[0], `AuthoritySnapshot ${authoritySnapshotId}`);
  const turnId = requireId(snapshot.turn_id, 'AuthoritySnapshot.turn_id');
  if (expectedTurnId !== undefined && turnId !== requireId(expectedTurnId, 'expectedTurnId')) {
    throw new Error('AuthoritySnapshot belongs to another Turn.');
  }
  const linked = await database.snapshot([
    DOMAIN_REPOSITORIES.domain('ContentObject').get(requireId(
      snapshot.content_object_id,
      'AuthoritySnapshot.content_object_id'
    )),
    DOMAIN_REPOSITORIES.domain('Turn').get(turnId)
  ]);
  const contentObject = requireRow(linked.snapshot[0], `AuthoritySnapshot ${authoritySnapshotId} ContentObject`);
  const turn = requireRow(linked.snapshot[1], `Turn ${turnId}`);
  const bytes = await contentStore.read(contentObject as ContentObjectMetadata);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(
      `AuthoritySnapshot ${authoritySnapshotId} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return {
    snapshot,
    turn,
    document: normalizePlainJson(parsed, `AuthoritySnapshot ${authoritySnapshotId}`),
    turnId,
    conversationId: requireId(turn.conversation_id, 'Turn.conversation_id')
  };
}

export function frozenInteractionAutoApproval(
  document: PlainJsonValue,
  toolName: 'ask_user' | 'submit_plan'
): boolean {
  if (!isRecord(document) || !isRecord(document.toolPolicy)) return false;
  const policy = document.toolPolicy;
  if (!Array.isArray(policy.allowedTools) || !policy.allowedTools.includes(toolName) || !isRecord(policy.toolConfigs)) {
    return false;
  }
  const tool = policy.toolConfigs[toolName];
  return isRecord(tool) && isRecord(tool.config) && tool.config.autoApprove === true;
}

export function frozenModelIdentity(document: PlainJsonValue): { providerId: string; modelId: string } {
  if (!isRecord(document) || !isRecord(document.model)) {
    throw new Error('AuthoritySnapshot is missing frozen model identity.');
  }
  return {
    providerId: requireText(document.model.providerConfigId, 'AuthoritySnapshot.model.providerConfigId'),
    modelId: requireText(document.model.modelId, 'AuthoritySnapshot.model.modelId')
  };
}

/** Exact effective provider/model selection frozen for one Turn. */
export function frozenModelSelection(document: PlainJsonValue): ChatModelOverrideRecord {
  if (!isRecord(document) || !isRecord(document.model)) {
    throw new Error('AuthoritySnapshot is missing frozen model selection.');
  }
  const provider = document.model.provider;
  if (!isProviderKind(provider)) throw new Error('AuthoritySnapshot.model.provider is invalid.');
  return {
    providerConfigId: requireText(
      document.model.providerConfigId,
      'AuthoritySnapshot.model.providerConfigId'
    ),
    provider,
    model: requireText(document.model.modelId, 'AuthoritySnapshot.model.modelId')
  };
}

/**
 * Retry authority is frozen with the Turn. Legacy snapshots predate this field and retain their
 * original one-retry contract instead of inheriting mutable live settings.
 */
export function frozenProviderRetryPolicy(document: PlainJsonValue): FrozenProviderRetryPolicy {
  if (!isRecord(document) || !isRecord(document.model)) {
    throw new Error('AuthoritySnapshot is missing frozen model retry authority.');
  }
  return normalizeFrozenRetryPolicy(
    document.model.retryPolicy,
    'model.retryPolicy',
    { enabled: true, maxRetries: 1, retryDelayMs: 0 }
  );
}

export function frozenContextProfile(document: PlainJsonValue): FrozenContextProfile {
  if (!isRecord(document) || !isRecord(document.modelProfile)) {
    throw new Error('AuthoritySnapshot is missing frozen modelProfile context settings.');
  }
  const threshold = document.modelProfile.compressionThresholdTokens;
  const contextWindow = document.modelProfile.contextWindowTokens;
  const estimator = document.modelProfile.tokenEstimator;
  if (!Number.isSafeInteger(threshold) || (threshold as number) <= 0) {
    throw new Error('Frozen modelProfile.compressionThresholdTokens must be a positive integer.');
  }
  if (!Number.isSafeInteger(contextWindow) || (contextWindow as number) <= 0) {
    throw new Error('Frozen modelProfile.contextWindowTokens must be a positive integer.');
  }
  if ((threshold as number) > (contextWindow as number)) {
    throw new Error('Frozen modelProfile.compressionThresholdTokens cannot exceed contextWindowTokens.');
  }
  if (
    !isRecord(estimator)
    || estimator.kind !== 'utf8-bytes-ceil'
    || !Number.isSafeInteger(estimator.bytesPerToken)
    || (estimator.bytesPerToken as number) <= 0
  ) throw new Error('Frozen modelProfile token estimator is unsupported or incomplete.');
  return {
    contextWindowTokens: contextWindow as number,
    compressionThresholdTokens: threshold as number,
    tokenEstimator: {
      kind: 'utf8-bytes-ceil',
      bytesPerToken: estimator.bytesPerToken as number
    }
  };
}

/** 解析已固定的有效配置；新请求可由独立请求设置覆盖压缩部分，重放不读当前配置。 */
export function frozenCompressionPolicy(document: PlainJsonValue): FrozenCompressionPolicy | undefined {
  if (!isRecord(document) || !isRecord(document.compression)) return undefined;
  const compression = document.compression;
  if (compression.enabled !== true) return undefined;
  const config = compression.config;
  const provider = compression.provider;
  if (!isRecord(config) || !isRecord(provider)) {
    throw new Error('AuthoritySnapshot compression policy is incomplete.');
  }
  const methodKind = requireCompressionKind(compression.methodKind);
  if (config.kind !== methodKind) throw new Error('Frozen compression method/config kind mismatch.');
  const trigger = config.trigger;
  if (!isRecord(trigger) || (trigger.mode !== 'manual' && trigger.mode !== 'token_threshold')) {
    throw new Error('Frozen compression trigger is invalid.');
  }
  const thresholdTokens = positiveSafeInteger(compression.thresholdTokens, 'compression.thresholdTokens');
  const providerKind = provider.provider;
  if (!isProviderKind(providerKind)) throw new Error('Frozen compression provider kind is invalid.');
  return {
    enabled: true,
    methodKind,
    config: normalizePlainJson(config, 'AuthoritySnapshot.compression.config') as unknown as LlmCompressionConfigRecord,
    triggerMode: trigger.mode,
    thresholdTokens,
    provider: {
      providerConfigId: requireText(provider.providerConfigId, 'AuthoritySnapshot.compression.provider.providerConfigId'),
      provider: providerKind,
      modelId: requireText(provider.modelId, 'AuthoritySnapshot.compression.provider.modelId'),
      contextWindowTokens: positiveSafeInteger(
        provider.contextWindowTokens,
        'compression.provider.contextWindowTokens'
      ),
      maxOutputTokens: positiveSafeInteger(
        provider.maxOutputTokens,
        'compression.provider.maxOutputTokens'
      ),
      retryPolicy: normalizeFrozenRetryPolicy(
        provider.retryPolicy,
        'compression.provider.retryPolicy',
        { enabled: true, maxRetries: 1, retryDelayMs: 0 }
      )
    }
  };
}

/**
 * Work-environment boundary frozen with the Turn. Legacy snapshots predate this field and impose
 * no inherited boundary on child executions.
 */
export function frozenWorkEnvironmentPolicy(document: PlainJsonValue): FrozenWorkEnvironmentBoundaryPolicy | undefined {
  if (!isRecord(document) || document.workEnvironmentPolicy === undefined || document.workEnvironmentPolicy === null) {
    return undefined;
  }
  const policy = document.workEnvironmentPolicy;
  if (!isRecord(policy) || typeof policy.enabled !== 'boolean' || !Array.isArray(policy.allowedWorkEnvironmentIds)) {
    throw new Error('AuthoritySnapshot workEnvironmentPolicy is incomplete.');
  }
  if (policy.defaultWorkEnvironmentId !== null && typeof policy.defaultWorkEnvironmentId !== 'string') {
    throw new Error('AuthoritySnapshot workEnvironmentPolicy.defaultWorkEnvironmentId is invalid.');
  }
  return {
    enabled: policy.enabled,
    allowedWorkEnvironmentIds: policy.allowedWorkEnvironmentIds.map((value) =>
      requireId(value, 'workEnvironmentPolicy.allowedWorkEnvironmentIds')
    ),
    defaultWorkEnvironmentId: policy.defaultWorkEnvironmentId as string | null
  };
}

function normalizeFrozenRetryPolicy(
  value: unknown,
  label: string,
  legacy: FrozenProviderRetryPolicy
): FrozenProviderRetryPolicy {
  if (value === undefined) return legacy;
  if (!isRecord(value) || typeof value.enabled !== 'boolean') {
    throw new Error(`Frozen ${label} must contain enabled and maxRetries.`);
  }
  const maxRetries = nonNegativeSafeInteger(value.maxRetries, `${label}.maxRetries`);
  if (maxRetries > 10) throw new Error(`Frozen ${label}.maxRetries exceeds the reliable limit.`);
  if (value.enabled !== (maxRetries > 0)) {
    throw new Error(`Frozen ${label}.enabled must exactly match whether maxRetries is non-zero.`);
  }
  const retryDelayMs = value.retryDelayMs === undefined
    ? legacy.retryDelayMs
    : nonNegativeSafeInteger(value.retryDelayMs, `${label}.retryDelayMs`);
  if (retryDelayMs > MAX_LLM_RETRY_DELAY_SECONDS * 1_000) {
    throw new Error(`Frozen ${label}.retryDelayMs exceeds the reliable limit.`);
  }
  return { enabled: value.enabled, maxRetries, retryDelayMs };
}

function requireCompressionKind(value: unknown): LlmCompressionConfigRecord['kind'] {
  if (!['disabled', 'openai_responses_compact', 'llm_summary', 'segmented_summary', 'deterministic_summary', 'manual_summary'].includes(String(value))) {
    throw new Error(`Unsupported frozen compression method: ${String(value)}.`);
  }
  return value as LlmCompressionConfigRecord['kind'];
}

function isProviderKind(value: unknown): value is LlmProviderKind {
  return ['openai-compatible', 'openai-responses', 'claude', 'gemini', 'deepseek'].includes(String(value));
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`Frozen ${label} must be positive.`);
  return value as number;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Frozen ${label} must be non-negative.`);
  return value as number;
}

function requireRow(value: unknown, label: string): DomainRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} does not exist.`);
  return value as DomainRow;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
