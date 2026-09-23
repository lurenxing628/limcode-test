import type { LlmOpenAIResponsesTransport, LlmProviderKind } from './protocol';
import type { OpenAIResponsesNativeCapabilities, OpenAIResponsesNativeSettings } from './openAIResponsesNative';

/** Exact Astra model family. Other gpt-* models must never be inferred as Astra-capable. */
export const ASTRA_MODEL_ID = 'gpt-6-astra';
const ASTRA_DATED_MODEL_PATTERN = /^gpt-6-astra-\d{4}-\d{2}-\d{2}$/;
const OFFICIAL_OPENAI_HOST = 'api.openai.com';

export function isAstraModel(model: string | undefined): boolean {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return false;
  return normalized === ASTRA_MODEL_ID || ASTRA_DATED_MODEL_PATTERN.test(normalized);
}

export type Gpt6ModelVariant = 'astra' | 'sol' | 'luna';

/**
 * GPT-6 family, exact official ids only: https://developers.openai.com/api/docs/guides/latest-model
 * (Using GPT-6: "The GPT-6 model family includes GPT-6 Astra, GPT-6 Sol, and GPT-6 Luna"; model ids
 * `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`). Dated snapshots (-YYYY-MM-DD) count; gateway aliases such as
 * `gpt-6-sol-xhigh` or `[az]gpt-6-luna` never do.
 */
const GPT6_FAMILY_VARIANTS: Readonly<Record<string, Gpt6ModelVariant>> = {
  'gpt-6-astra': 'astra',
  'gpt-6-sol': 'sol',
  'gpt-6-luna': 'luna'
};

/**
 * GPT-5.6 and later official ids. Explicit prompt caching (`prompt_cache_options` and
 * `prompt_cache_breakpoint`) is documented for "GPT-5.6 and later"
 * (https://developers.openai.com/api/docs/guides/prompt-caching#summary-of-model-differences), and the
 * `standard`/`pro` reasoning mode for "GPT-5.6 and GPT-6 models" in the Responses API
 * (https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode).
 */
const OPENAI_GPT56_AND_LATER_MODELS: ReadonlySet<string> = new Set([
  'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'
]);

const DATED_SNAPSHOT_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;

function officialOpenAIModelBaseId(model: string | undefined): string | undefined {
  const normalized = model?.trim().toLowerCase();
  return normalized ? normalized.replace(DATED_SNAPSHOT_SUFFIX, '') : undefined;
}

export function gpt6ModelVariant(model: string | undefined): Gpt6ModelVariant | undefined {
  const base = officialOpenAIModelBaseId(model);
  return base !== undefined && Object.prototype.hasOwnProperty.call(GPT6_FAMILY_VARIANTS, base)
    ? GPT6_FAMILY_VARIANTS[base]
    : undefined;
}

export function isGpt6FamilyModel(model: string | undefined): boolean {
  return gpt6ModelVariant(model) !== undefined;
}

/**
 * GPT-6 Sol and Luna accept `reasoning.effort: "none"`; Astra does not (Using GPT-6 "Limitations";
 * models/gpt-6-sol.md and models/gpt-6-luna.md list none, low, medium (default), high, xhigh, max).
 */
export function isGpt6NoneCapableModel(model: string | undefined): boolean {
  const variant = gpt6ModelVariant(model);
  return variant === 'sol' || variant === 'luna';
}

export function supportsOpenAIExplicitPromptCache(model: string | undefined): boolean {
  const base = officialOpenAIModelBaseId(model);
  return base !== undefined && OPENAI_GPT56_AND_LATER_MODELS.has(base);
}

export function supportsOpenAIReasoningMode(model: string | undefined): boolean {
  const base = officialOpenAIModelBaseId(model);
  return base !== undefined && OPENAI_GPT56_AND_LATER_MODELS.has(base);
}

export type Gpt6ChatCompletionsToolRestriction = 'unsupported' | 'requires_none_effort';

/**
 * Chat Completions tool calling on the GPT-6 family (Using GPT-6 "Update API and model parameters":
 * "GPT-6 Astra supports Chat Completions, but its tool calling requires Responses. GPT-6 Sol and Luna
 * support function calling in Chat Completions only with `reasoning_effort: "none"`"). LimCode never
 * rewrites the effort for this; the settings UI only explains the restriction.
 */
export function gpt6ChatCompletionsToolRestriction(
  provider: LlmProviderKind | undefined,
  model: string | undefined
): Gpt6ChatCompletionsToolRestriction | undefined {
  if (provider !== 'openai-compatible') return undefined;
  const variant = gpt6ModelVariant(model);
  if (variant === 'astra') return 'unsupported';
  return variant ? 'requires_none_effort' : undefined;
}

/** The official OpenAI channel supports GPT-6 native features; any other channel needs an explicit enabled setting. */
export function isOfficialOpenAIChannel(baseUrl: string | undefined): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return true;
  try {
    return new URL(trimmed).host === OFFICIAL_OPENAI_HOST;
  } catch {
    return false;
  }
}

export function normalizeOpenAIResponsesNativeSettings(value: unknown): OpenAIResponsesNativeSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const normalized: OpenAIResponsesNativeSettings = {};
  if (typeof record.enabled === 'boolean') normalized.enabled = record.enabled;
  if (typeof record.asyncTools === 'boolean') normalized.asyncTools = record.asyncTools;
  if (typeof record.steering === 'boolean') normalized.steering = record.steering;
  if (typeof record.reasoningUpdates === 'boolean') normalized.reasoningUpdates = record.reasoningUpdates;
  if (typeof record.multiplexing === 'boolean') normalized.multiplexing = record.multiplexing;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export interface OpenAIResponsesNativeCapabilityInput {
  provider?: LlmProviderKind;
  model?: string;
  baseUrl?: string;
  transport?: LlmOpenAIResponsesTransport;
  nativeResponses?: OpenAIResponsesNativeSettings;
  /** Configured `reasoning.mode`; `pro` disables configuration updates (standard mode only). */
  reasoningMode?: string;
}

const NO_NATIVE_CAPABILITIES: OpenAIResponsesNativeCapabilities = {
  asyncTools: false,
  steering: false,
  reasoningUpdates: false,
  multiplexing: false,
  explicitCaching: false
};

/**
 * Exact native capability gate. Every flag requires provider `openai-responses`, an exact GPT-6
 * family model (Astra, Sol or Luna, see `gpt6ModelVariant`) and either the official OpenAI channel
 * or an explicit `enabled` value (which confirms a relay's support). Feature subflags default to
 * available once native is enabled; an explicit `false` disables one feature. Async tools and
 * reasoning updates are transport-independent: over HTTP/SSE early admission proofs and delayed
 * results ride stateless full-history continuation (store=false, no fabricated connection identity).
 * Steering and multiplexing are WebSocket-only because they ride a shared physical connection.
 *
 * Documentation basis per feature:
 * - Async tools: Using GPT-6 "What's new" lists async tool calling as a GPT-6 feature ("GPT-6 can
 *   continue reasoning ... while your application runs a tool"), while guides/async-tool-calling
 *   "Compatibility" says "Async tool calling is supported by GPT-6 Astra and later models". The two
 *   statements are read together as the whole GPT-6 family (Sol and Luna are GPT-6 models released
 *   with Astra), so async tools are offered for Sol and Luna as well.
 * - Steering: guides/steering "available with the GPT-6 model family over a WebSocket connection".
 * - Reasoning updates (`configuration_update`): guides/reasoning "Change reasoning mid-conversation":
 *   "supported by the GPT-6 model family in standard, single-agent mode". `reasoning.mode: "pro"`
 *   therefore disables them.
 * - Multiplexing (`stream_id`): guides/websocket-mode has no model restriction.
 * - Explicit caching: guides/prompt-caching, "GPT-5.6 and later".
 */
export function openAIResponsesNativeCapabilities(
  input: OpenAIResponsesNativeCapabilityInput
): OpenAIResponsesNativeCapabilities {
  if (input.provider !== 'openai-responses' || !isGpt6FamilyModel(input.model)) return { ...NO_NATIVE_CAPABILITIES };
  const settings = normalizeOpenAIResponsesNativeSettings(input.nativeResponses);
  if (settings?.enabled === false) return { ...NO_NATIVE_CAPABILITIES };
  if (settings?.enabled !== true && !isOfficialOpenAIChannel(input.baseUrl)) return { ...NO_NATIVE_CAPABILITIES };
  const websocket = input.transport === 'websocket';
  return {
    asyncTools: settings?.asyncTools !== false,
    steering: websocket && settings?.steering !== false,
    reasoningUpdates: input.reasoningMode !== 'pro' && settings?.reasoningUpdates !== false,
    multiplexing: websocket && settings?.multiplexing !== false,
    explicitCaching: supportsOpenAIExplicitPromptCache(input.model)
  };
}
