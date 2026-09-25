import type { PlainData } from '../../shared/plainData';
import { parseNativeResponseMetrics } from './nativeResponseMetrics';

type RecordData = Record<string, PlainData>;

const REQUEST_FIELDS = [
  'id', 'turn_id', 'request_seq', 'status', 'terminal_state', 'provider_id', 'model_id',
  'context_window_tokens', 'compression_threshold_tokens', 'estimated_context_tokens',
  'authority_snapshot_id', 'settings_snapshot_object_id', 'recipe_object_id', 'created_at', 'updated_at'
];
const USAGE_FIELDS = [
  'promptTokenCount', 'candidatesTokenCount', 'totalTokenCount', 'thoughtsTokenCount',
  'cachedContentTokenCount', 'cacheCreationInputTokenCount', 'cacheCreationInputTokensDetails',
  'nativeChainBilling', 'nativeChainUsageIncomplete', 'nativeChainUsageDetailsIncomplete',
  // These are also understood by the shared footer usage reader. Keep observations, not estimates
  // derived from another request, a Turn's ordering, or message text.
  'prompt_tokens', 'input_tokens', 'inputTokens', 'completion_tokens', 'output_tokens', 'outputTokens',
  'total_tokens', 'totalTokens', 'reasoning_tokens', 'cached_content_token_count', 'cached_tokens',
  'estimated', 'tokenEstimator', 'attachmentTokenEstimate'
];
const STREAM_FIELDS = [
  'attemptSeq', 'socketGeneration', 'retryReason', 'retryMaxAttempts', 'retryDelayMs', 'retryNotBeforeAt',
  'providerStartedAt', 'firstOutputAt', 'completedAt', 'streamOutputDurationMs',
  'lastStreamSeq', 'lastStreamEventAt', 'thinkingSelection', 'claudeThinkingBinding',
  'nativeCapabilities', 'nativeInitialPromptTokenCount', 'nativeLatestResponseUsage'
];

/**
 * ModelRequest is structured measurement/state, not a text preview. SQLite window reads carry JSON
 * strings and committed changes carry objects: normalize both before sizing and never ellipsize
 * their JSON or discard usage/timing when a native response's bounded metrics exceed 2 KiB.
 * Large provider diagnostics/failure bodies are not window data. The native metric parser retains
 * the first response, exact aggregate counters and at most eight recent physical responses.
 */
export function projectModelRequestSummary(record: RecordData): RecordData {
  const summary = pick(record, REQUEST_FIELDS);
  if (record.usage_json !== undefined) {
    const usage = jsonRecord(record.usage_json, 'ModelRequest.usage_json');
    summary.usage_json = usage === null ? null : pick(usage, USAGE_FIELDS);
  }
  if (record.stream_stats_json !== undefined) {
    const stats = jsonRecord(record.stream_stats_json, 'ModelRequest.stream_stats_json');
    if (stats === null) {
      summary.stream_stats_json = null;
    } else {
      const projected = pick(stats, STREAM_FIELDS);
      if (stats.nativeResponseMetrics !== undefined) {
        projected.nativeResponseMetrics = parseNativeResponseMetrics(stats.nativeResponseMetrics) as unknown as PlainData;
      }
      summary.stream_stats_json = projected;
    }
  }
  return summary;
}

function jsonRecord(value: PlainData, label: string): RecordData | null {
  const decoded: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (decoded === null) return null;
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new TypeError(`${label} must be a JSON object or null.`);
  }
  return decoded as RecordData;
}

function pick(record: RecordData, fields: readonly string[]): RecordData {
  return Object.fromEntries(fields.flatMap(key => record[key] === undefined ? [] : [[key, record[key]]]));
}
