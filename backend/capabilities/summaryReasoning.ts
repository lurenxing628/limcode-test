import type {
  LlmCompressionConfigRecord, LlmGenerationConfigRecord, LlmProviderConfigRecord, LlmRequestBodyRecord,
  LlmRequestBodyJsonValue
} from '../../shared/protocol';
import { assertSummaryReasoningPlan, resolveProviderModelCapabilities, resolveSummaryReasoning,
  type ResolvedSummaryReasoning } from '../../shared/modelCapabilities';
import type { LlmCompactRequest } from '../world/modules/llm/contracts';

export function frozenSummaryReasoning(
  request: LlmCompactRequest, method: LlmCompressionConfigRecord, settings: LlmProviderConfigRecord
): ResolvedSummaryReasoning {
  const plan = request.summaryReasoning ?? resolveSummaryReasoning({
    mode: method.llmSummary?.reasoning?.mode
      ?? (method.llmSummary?.generationConfig?.thinkingConfig ? 'explicit' : 'provider_default'),
    methodGenerationConfig: method.llmSummary?.generationConfig,
    inheritedGenerationConfig: settings.generationConfig,
    capabilities: resolveProviderModelCapabilities(settings, settings.model)
  });
  assertSummaryReasoningPlan(plan);
  return plan;
}

/** RequestBody is applied *after* the SDK encoder. Remove purpose-inappropriate overrides before
 * applying the frozen plan, otherwise a raw chat reasoning_effort can resurrect the original bug. */
export function summaryRequestBody(
  configured: LlmRequestBodyRecord | undefined, plan: ResolvedSummaryReasoning
): LlmRequestBodyRecord {
  const body: LlmRequestBodyRecord = configured ? JSON.parse(JSON.stringify(configured)) : {};
  for (const key of ['reasoning', 'reasoning_effort', 'thinking', 'context_management', 'compaction',
    'previous_response_id', 'stream_id', 'tools', 'tool_choice', 'parallel_tool_calls', 'instructions',
    'messages', 'input', 'contents', 'system', 'systemInstruction', 'model', 'stream',
    'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'temperature', 'top_p', 'top_k',
    'stop', 'stop_sequences', 'response_format', 'text', 'enable_thinking']) delete body[key];
  if (record(body.output_config)) {
    delete body.output_config.effort;
    delete body.output_config.format;
    delete body.output_config.task_budget;
    if (!Object.keys(body.output_config).length) delete body.output_config;
  }
  if (record(body.generationConfig)) {
    for (const key of ['thinkingConfig', 'maxOutputTokens', 'responseMimeType', 'responseSchema',
      'temperature', 'topP', 'topK', 'stopSequences']) delete body.generationConfig[key];
    if (!Object.keys(body.generationConfig).length) delete body.generationConfig;
  }
  for (const outer of [body, record(body.extra_body) ? body.extra_body : undefined]) {
    if (outer && record(outer.google)) {
      delete outer.google.thinking_config;
      if (!Object.keys(outer.google).length) delete outer.google;
    }
  }
  if (record(body.extra_body) && !Object.keys(body.extra_body).length) delete body.extra_body;
  return merge(body, plan.requestBody ?? {});
}

/** The native fields above are authoritative. The dependency must not infer adaptive thinking or
 * add summary='detailed' from a generic level a second time. Sampling remains explicit per method. */
export function summaryGenerationWithoutThinking(config: LlmGenerationConfigRecord | undefined): LlmGenerationConfigRecord | undefined {
  if (!config) return undefined;
  const next = { ...config };
  delete next.thinkingConfig;
  return Object.keys(next).length ? next : undefined;
}

function record(value: unknown): value is LlmRequestBodyRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function merge(base: LlmRequestBodyRecord, patch: LlmRequestBodyRecord): LlmRequestBodyRecord {
  const output = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    output[key] = record(value) && record(output[key]) ? merge(output[key] as LlmRequestBodyRecord, value) : value as LlmRequestBodyJsonValue;
  }
  return output;
}
