import type {
  InlineDataPart,
  LlmProviderConfigRecord,
  LlmProviderKind
} from '../../shared/protocol';
import {
  createLlmProviderCapability,
  probeLlmProviderNativeCompaction,
  type LlmProviderOptions,
  type LlmProviderTransportTrace
} from '../capabilities/llmProvider';
import type { ReliableAgentProviderRegistry } from './agentLoop';
import { LlmCapabilityFullRequestAdapter } from './llmCapabilityProviderAdapter';
import type { FullRequestProviderAdapter } from './modelProviderControlPlane';
import type { DebugCaptureRecorder } from './debugCapture/observer';

export interface ReliableLlmProviderRegistryOptions {
  debugCapture?: DebugCaptureRecorder;
  loadProviderConfig(providerConfigId: string): Promise<LlmProviderConfigRecord>;
  proxy?: () => string | undefined | Promise<string | undefined>;
  headers?: LlmProviderOptions['headers'];
  onTransportTrace?: (trace: LlmProviderTransportTrace) => void;
  resolveAttachment?: (input: {
    attachmentId?: string;
    sourcePath?: string;
    mimeType?: string;
    name?: string;
  }) => Promise<InlineDataPart | undefined>;
}

/**
 * Product Provider registry backed by the existing stateless LLM capability.
 *
 * Provider/model identity always comes from the frozen ModelRequest. Capability-local retries are
 * disabled because ModelProviderControlPlane owns the visible, durable, frozen-policy retry contract.
 */
export class ReliableLlmProviderRegistry implements ReliableAgentProviderRegistry {
  private readonly adapters = new Map<string, FullRequestProviderAdapter>();
  private readonly capability;
  private disposed = false;

  public constructor(private readonly options: ReliableLlmProviderRegistryOptions) {
    this.capability = createLlmProviderCapability({
      debugCapture: options.debugCapture,
      settings: async (request) => {
        const frozen = request && 'model' in request ? request.model : undefined;
        const snapshot = request && 'settingsSnapshot' in request ? request.settingsSnapshot : undefined;
        const providerConfigId = requireId(
          frozen?.providerConfigId || snapshot?.providerConfigId,
          'Frozen providerConfigId'
        );
        const modelId = requireId(frozen?.model || snapshot?.modelId, 'Frozen modelId');
        const config = await this.options.loadProviderConfig(providerConfigId);
        if (config.id !== providerConfigId) {
          throw new Error(`Provider settings authority returned ${config.id} for frozen id ${providerConfigId}.`);
        }
        return applyFrozenModelProviderConfig(
          config,
          modelId,
          frozen?.provider ?? snapshot?.provider,
          snapshot?.systemPromptPrefix
        );
      },
      ...(this.options.proxy ? { proxy: this.options.proxy } : {}),
      ...(this.options.headers ? {
        headers: typeof this.options.headers === 'function' ? this.options.headers : { ...this.options.headers }
      } : {}),
      ...(this.options.onTransportTrace ? { onTransportTrace: this.options.onTransportTrace } : {}),
      ...(this.options.resolveAttachment ? { resolveAttachment: this.options.resolveAttachment } : {})
    });
  }

  public resolve(providerIdInput: string): FullRequestProviderAdapter {
    this.requireOpen();
    const providerId = requireId(providerIdInput, 'providerId');
    const existing = this.adapters.get(providerId);
    if (existing) return existing;
    const adapter = new LlmCapabilityFullRequestAdapter(
      providerId,
      this.capability,
      this.options.debugCapture,
      this.options.resolveAttachment
    );
    this.adapters.set(providerId, adapter);
    return adapter;
  }

  public listModels(config: LlmProviderConfigRecord) {
    this.requireOpen();
    return this.capability.listModels(config);
  }

  private readonly nativeProbes = new Map<string, ReturnType<typeof probeLlmProviderNativeCompaction>>();

  public verifyNativeCompaction(config: LlmProviderConfigRecord) {
    this.requireOpen();
    const key = JSON.stringify([config.id, config.baseUrl, config.model, config.openaiResponsesTransport, config.updatedAt]);
    const pending = this.nativeProbes.get(key);
    if (pending) return pending;
    const task = probeLlmProviderNativeCompaction(config, { ...this.options, settings: async () => config })
      .finally(() => { if (this.nativeProbes.get(key) === task) this.nativeProbes.delete(key); });
    this.nativeProbes.set(key, task);
    return task;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.adapters.clear();
    this.capability.dispose();
  }

  private requireOpen(): void {
    if (this.disposed) throw new Error('ReliableLlmProviderRegistry is disposed.');
  }
}

/** Applies the exact frozen model and its complete per-model settings without mutating config data. */
export function applyFrozenModelProviderConfig(
  config: LlmProviderConfigRecord,
  modelIdInput: string,
  providerOverride?: LlmProviderKind,
  frozenSystemPromptPrefix?: string
): LlmProviderConfigRecord {
  const modelId = requireId(modelIdInput, 'modelId');
  const known = config.model.trim() === modelId
    || config.models.some((candidate) => candidate.id.trim() === modelId)
    || config.modelConfigs.some((candidate) => candidate.modelId.trim() === modelId);
  if (!known) throw new Error(`Provider ${config.id} does not contain frozen model ${modelId}.`);

  const modelConfig = config.modelConfigs.find((candidate) => candidate.modelId.trim() === modelId);
  const resolved: LlmProviderConfigRecord = {
    ...config,
    ...(providerOverride ? { provider: providerOverride } : {}),
    model: modelId,
    systemPromptPrefix: frozenSystemPromptPrefix
      ?? modelConfig?.systemPromptPrefix
      ?? config.systemPromptPrefix,
    ...(modelConfig ? {
      toolCallFormat: modelConfig.toolCallFormat,
      openaiResponsesTransport: modelConfig.openaiResponsesTransport,
      stream: modelConfig.stream,
      enableMultimodalTools: modelConfig.enableMultimodalTools,
      ...(modelConfig.contextWindowTokens === undefined
        ? { contextWindowTokens: undefined }
        : { contextWindowTokens: modelConfig.contextWindowTokens }),
      ...(modelConfig.promptCache === undefined ? { promptCache: undefined } : { promptCache: modelConfig.promptCache }),
      ...(modelConfig.headers === undefined ? { headers: undefined } : { headers: { ...modelConfig.headers } }),
      ...(modelConfig.generationConfig === undefined
        ? { generationConfig: undefined }
        : { generationConfig: { ...modelConfig.generationConfig } }),
      ...(modelConfig.requestBody === undefined
        ? { requestBody: undefined }
        : { requestBody: { ...modelConfig.requestBody } }),
      // nativeResponses 遵循与其他高级配置一致的模型级整体替代语义。
      ...(modelConfig.nativeResponses === undefined
        ? { nativeResponses: undefined }
        : { nativeResponses: { ...modelConfig.nativeResponses } })
    } : {}),
    // Reliable retry identity lives in ModelRequest/Attempt; the capability must not retry invisibly.
    retryOnError: false,
    retryMaxAttempts: 0
  };

  if (modelConfig?.contextWindowTokens === undefined && modelConfig) delete resolved.contextWindowTokens;
  if (modelConfig?.promptCache === undefined && modelConfig) delete resolved.promptCache;
  if (modelConfig?.headers === undefined && modelConfig) delete resolved.headers;
  if (modelConfig?.generationConfig === undefined && modelConfig) delete resolved.generationConfig;
  if (modelConfig?.requestBody === undefined && modelConfig) delete resolved.requestBody;
  if (modelConfig?.nativeResponses === undefined && modelConfig) delete resolved.nativeResponses;
  return resolved;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}
