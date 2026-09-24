import type { LlmProviderConfigRecord, LlmProviderModelRecord, LlmThinkingLevel } from '../../shared/protocol';
import { resolveProviderModelCapabilities, type ModelCapabilitySnapshot } from '../../shared/modelCapabilities';

const ANTHROPIC_COMPACTION_BETA = 'compact-2026-09-04';
const MAX_CATALOG_PAGES = 20;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

/** Only invoked by an explicit model catalog refresh, never during admission/retry/recovery. */
export async function discoverAnthropicModels(
  settings: LlmProviderConfigRecord,
  transport: typeof fetch,
  headers: Record<string, string> = {},
  signal: AbortSignal = AbortSignal.timeout(30_000)
): Promise<LlmProviderModelRecord[]> {
  const base = settings.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const url = new URL(`${base}/v1/models`);
  const result: LlmProviderModelRecord[] = [];
  const seen = new Set<string>();
  const requestHeaders: Record<string, string> = {
    'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01', ...headers
  };
  const betaKey = Object.keys(requestHeaders).find((key) => key.toLowerCase() === 'anthropic-beta') ?? 'anthropic-beta';
  requestHeaders[betaKey] = [...new Set([...(requestHeaders[betaKey] ?? '').split(',').filter(Boolean), ANTHROPIC_COMPACTION_BETA])].join(',');
  for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
    url.searchParams.set('limit', '100');
    const response = await transport(url.toString(), { headers: requestHeaders, signal, redirect: 'error' });
    if (!response.ok) throw Object.assign(new Error(`模型能力目录请求失败（HTTP ${response.status}）。`), { status: response.status });
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_CATALOG_BYTES) throw new Error('模型能力目录响应超过大小上限。');
    const body: unknown = JSON.parse(text);
    if (!record(body) || !Array.isArray(body.data)) throw new Error('模型能力目录缺少 data 数组。');
    const observedAt = new Date().toISOString();
    for (const item of body.data) {
      if (!record(item) || typeof item.id !== 'string' || !item.id.trim()) throw new Error('模型能力目录包含无效模型 ID。');
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const baseline = resolveProviderModelCapabilities({ ...settings, models: [] }, item.id);
      const capabilities = parseAnthropicCapabilities(item.capabilities, baseline, observedAt);
      result.push({
        id: item.id, name: typeof item.display_name === 'string' ? item.display_name : item.id,
        ...(typeof item.created_at === 'string' ? { createdAt: item.created_at } : {}),
        ...(capabilities ? { capabilitySnapshot: capabilities } : {})
      });
    }
    if (body.has_more !== true) return result;
    if (typeof body.last_id !== 'string' || !body.last_id || body.last_id === url.searchParams.get('after_id')) {
      throw new Error('模型能力目录分页游标无效，未将部分列表伪装为完整列表。');
    }
    url.searchParams.set('after_id', body.last_id);
  }
  throw new Error('模型能力目录超过分页上限，未将部分列表伪装为完整列表。');
}

/** API fields outrank static entries. Threshold compact_20260112 does not prove signed on-demand support. */
export function parseAnthropicCapabilities(
  value: unknown, baseline: ModelCapabilitySnapshot, verifiedAt: string
): ModelCapabilitySnapshot | undefined {
  if (!record(value)) return undefined;
  const thinking = record(value.thinking) ? value.thinking : undefined;
  const types = record(thinking?.types) ? thinking.types : {};
  const adaptive = support(types.adaptive);
  const enabled = support(types.enabled);
  const effort = record(value.effort) ? value.effort : {};
  const levels = (['low', 'medium', 'high', 'xhigh', 'max'] as LlmThinkingLevel[])
    .filter((level) => effort.supported === true && support(effort[level]));
  const compaction = record(value.compaction) ? value.compaction : undefined;
  const native = compaction?.supported === true && support(compaction.summarize);
  return {
    ...baseline, source: 'provider_api', verifiedAt,
    reasoning: {
      ...baseline.reasoning,
      family: thinking?.supported === true
        ? adaptive && enabled ? 'anthropic_hybrid' : adaptive ? 'anthropic_adaptive'
          : enabled ? 'anthropic_extended' : 'none'
        : levels.length ? 'anthropic_extended' : 'none',
      levels, supportsBudget: enabled,
      // The API does not expose disable support. Do not infer it from adaptive/enabled.
      canDisable: baseline.reasoning.canDisable,
      ...(enabled ? { minBudgetTokens: 1024 } : {})
    },
    nativeCompaction: {
      ...(native ? { kind: 'anthropic_messages' as const } : {}),
      availability: native ? 'verified' : compaction ? 'unsupported' : 'unknown',
      reason: native ? 'Models API 已确认 compaction.summarize；signed block 按需压缩可用。'
        : compaction ? 'Models API 表明该模型不支持 signed block 按需压缩。'
          : 'Models API 未提供按需 compaction 能力；不把 threshold compaction 当作同一能力。'
    }
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function support(value: unknown): boolean { return record(value) && value.supported === true; }
