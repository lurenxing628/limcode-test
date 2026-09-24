import type { LlmCompressionConfigRecord, LlmInvocationSettingsSnapshotRecord, LlmProviderKind, LlmUsageMetadataRecord, MessageContent } from '../../../../shared/protocol';

export type { LlmProviderKind };

export interface LlmModelSettings {
  providerConfigId?: string;
  provider?: LlmProviderKind;
  model: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: unknown;
  /**
   * Astra 原生异步声明（per-tool nativeAsync 策略解析结果）。仅在目标 capability.asyncTools
   * 为真时才会编码到线上；其他 provider/模型永远看不到该标记。
   */
  async?: boolean;
}

export interface LlmStartRequest {
  id: string;
  invocationId?: string;
  systemInstruction?: MessageContent;
  contents: MessageContent[];
  tools: ToolSchema[];
  conversationId?: string;
  model?: LlmModelSettings;
  settingsSnapshot?: LlmInvocationSettingsSnapshotRecord;
  /** Process-local reliable dispatch metadata; never persisted as Provider settings. */
  reliableProviderAttempt?: {
    attemptSeq: number;
    maxAttempts: number;
    requestCreatedAt?: number;
  };
  /**
   * Process-local boundary for Responses WebSocket continuation. These contents remain in the
   * ordinary request and are never encoded as transport metadata; the boundary only lets the
   * provider keep append-only continuation state when rebuilt Turn addenda move to the tail.
   */
  openAIResponsesContinuation?: {
    volatileTailContentKinds: Array<'current_turn_input' | 'turn_reminder'>;
    /**
     * 压缩后显式 rebase 等场景要求硬重开链：不带 previous_response_id、发送完整持久化输入、
     * 重置 continuation 基线。仅作为传输决策原因传递，不改变普通请求内容。
     */
    forceFullReason?: string;
  };
  /**
   * 持久化准入的原生异步调用 ID（provider call_id）。仅这些调用允许在 contents 中
   * 保持 pending-without-result；普通未决/孤儿/错配调用仍然失败。缺省 = 无例外。
   */
  nativeAsyncAdmittedCallIds?: readonly string[];
  /**
   * 这个对话已经选定的 Claude 保留思考处理（内核从窗口里模型输出所属请求的持久记录得出）：
   * drop_block 每个请求都带 beta 头与 block_binding；strip_thinking 一直去掉历史思考块、不再放回。
   */
  claudeThinkingBinding?: 'drop_block' | 'strip_thinking';
}

export interface LlmResolveInvocationRequest {
  invocationId: string;
  requestId: string;
  conversationId?: string;
  model?: LlmModelSettings;
}

export interface LlmDryRunOptions {
  /** true 时 curl 中显示 API Key；默认 false。 */
  includeApiKey?: boolean;
}

export interface LlmDryRunResult {
  provider?: LlmProviderKind;
  model?: string;
  providerName?: string;
  url: string;
  method: 'POST';
  stream: boolean;
  headers: Record<string, string>;
  body: unknown;
  bodyText: string;
  curl: string;
  /** 始终隐藏敏感 header 的 curl，用于前端本地显示/隐藏切换，避免重复 dry-run。 */
  maskedCurl: string;
  inputFormat?: string;
  outputFormat?: string;
  generatedAt: number;
  /** curl 中是否隐藏了 API Key 等敏感 header。 */
  maskedSecrets: boolean;
  /** 当前是否能从配置中取到真实 API Key；false 时 dry-run 使用占位 key 生成请求结构。 */
  apiKeyAvailable?: boolean;
}

export const ATTACHMENT_OBSERVATION_PROMPT_REVISION = '2026-09-07';

export interface LlmAttachmentObservation {
  attachmentRef: string;
  summary: string;
  salientFacts: string[];
  uncertainties: string[];
}

export interface LlmAttachmentObservationRequirement {
  attachmentRef: string;
  /** Runtime-only canonical identity used to match one media part; never rendered to the Provider. */
  attachmentId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  cachedObservation?: LlmAttachmentObservation;
}

export interface LlmCompactRequest {
  id: string;
  blockId: string;
  conversationId: string;
  invocationId?: string;
  methodConfigId?: string;
  methodKind?: LlmCompressionConfigRecord['kind'];
  /** Frozen snapshots are supplied only for exact replay/dry-run. */
  methodConfigSnapshot?: LlmCompressionConfigRecord;
  settingsSnapshot?: LlmInvocationSettingsSnapshotRecord;
  /** Resolved native fields from the exact request authority; no model-name guessing during replay. */
  summaryReasoning?: import('../../../../shared/modelCapabilities').ResolvedSummaryReasoning;
  nativeGenerationConfig?: import('../../../../shared/protocol').LlmGenerationConfigRecord;
  nativeRequestBody?: import('../../../../shared/protocol').LlmRequestBodyRecord;
  /** Frozen source-conversation system instructions used by Provider-native compaction. */
  systemInstruction?: MessageContent;
  /** Frozen tool definitions; required by Provider-native compaction to preserve signed thinking. */
  tools?: ToolSchema[];
  contents: MessageContent[];
  /** 分段总结：按回合切分的消息组（仅 segmented_summary 使用）。 */
  segments?: MessageContent[][];
  /** 分段总结：作为“回合1前情”的历史总结内容（逐字保留，不重新总结）。 */
  priorSummaryContents?: MessageContent[];
  sourceHash?: string;
  attachmentObservationProfileSha256?: string;
  attachmentObservationRequirements?: LlmAttachmentObservationRequirement[];
  /** 这个对话已经选定的 Claude 保留思考处理；Claude 原生压缩按它发送历史里的思考块。 */
  claudeThinkingBinding?: 'drop_block' | 'strip_thinking';
}

export interface LlmCompactDryRunCall extends LlmDryRunResult {
  id: string;
  label: string;
  ordinal: number;
}

export interface LlmCompactDryRunResult {
  kind: 'provider_requests' | 'no_provider_call';
  methodKind: LlmCompressionConfigRecord['kind'];
  calls: LlmCompactDryRunCall[];
  note?: string;
  generatedAt: number;
}

export interface LlmCompactResult {
  id?: string;
  object?: string;
  createdAt?: number;
  contents: MessageContent[];
  usageMetadata?: LlmUsageMetadataRecord;
  settingsSnapshot?: LlmInvocationSettingsSnapshotRecord;
  rawResponse?: unknown;
  methodConfig?: LlmCompressionConfigRecord;
  attachmentObservationProfileSha256?: string;
  attachmentObservations?: LlmAttachmentObservation[];
}
