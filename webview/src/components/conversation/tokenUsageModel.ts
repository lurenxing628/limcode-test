import type {
  LlmUsageMetadataRecord,
  MessageRecord,
  MsgRole,
  MessageMaterializationStatus
} from '@shared/protocol';

const hasOwn = Object.prototype.hasOwnProperty;

const TOTAL_TOKEN_KEYS = ['totalTokenCount', 'total_tokens', 'totalTokens'] as const;
const INPUT_TOKEN_KEYS = ['promptTokenCount', 'prompt_tokens', 'input_tokens', 'inputTokens'] as const;
const OUTPUT_TOKEN_KEYS = ['candidatesTokenCount', 'completion_tokens', 'output_tokens', 'outputTokens'] as const;
const REASONING_TOKEN_KEYS = ['thoughtsTokenCount', 'reasoning_tokens'] as const;
const CACHED_TOKEN_KEYS = ['cachedContentTokenCount', 'cached_content_token_count', 'cached_tokens'] as const;

export interface NormalizedTokenUsage {
  total?: number;
  input?: number;
  /** 模型输出 token，优先按 total - input 计算，因此会包含思考/推理 token。 */
  output?: number;
  reasoning?: number;
  cached?: number;
  attachmentTokens?: number;
  /** Native logical-chain usage is billing across physical responses, never one prompt size. */
  nativeChainBilling?: boolean;
  totalEstimated?: boolean;
  sourceEstimated?: boolean;
}

export type TokenUsageEntryKind = 'system' | 'message';

export interface TokenUsageMessageEntry {
  id: string;
  kind: TokenUsageEntryKind;
  index: number;
  messageId?: string;
  messageSeq?: number;
  label?: string;
  role?: MsgRole;
  status?: MessageMaterializationStatus;
  createdAt?: number;
  total: number;
  input?: number;
  output?: number;
  reasoning?: number;
  tool?: number;
  cached?: number;
  attachmentTokens?: number;
  totalEstimated: boolean;
  sourceEstimated: boolean;
  fixedRatio?: boolean;
  ratio: number;
}

export interface NativePhysicalContextUsage {
  responseId: string;
  inputTokens?: number;
  /** Only a complete provider-wire frontier covering this exact current root is precise. */
  exact: boolean;
}

/** Read the latest raw physical response, never the logical ModelRequest's sum of bills. */
export function nativePhysicalContextUsage(
  streamStats: unknown,
  currentRootId: string | undefined
): NativePhysicalContextUsage | undefined {
  const stats = asUsageRecord(streamStats);
  const latest = asUsageRecord(stats?.nativeLatestResponseUsage);
  const responseId = typeof latest?.responseId === 'string' ? latest.responseId.trim() : '';
  if (!responseId) return undefined;
  const inputTokens = typeof latest?.inputTokens === 'number' && Number.isSafeInteger(latest.inputTokens)
    && latest.inputTokens >= 0 ? latest.inputTokens : undefined;
  const boundedCount = typeof latest?.physicalResponseCount === 'number'
    && Number.isSafeInteger(latest.physicalResponseCount)
    && latest.physicalResponseCount >= 1 && latest.physicalResponseCount <= 8;
  const exact = boundedCount && inputTokens !== undefined
    && latest?.contextCovered === true
    && typeof currentRootId === 'string' && currentRootId.length > 0
    && latest?.contextRootId === currentRootId
    && latest?.attemptSeq === stats?.attemptSeq
    && latest?.socketGeneration === stats?.socketGeneration;
  return { responseId, ...(inputTokens === undefined ? {} : { inputTokens }), exact };
}

function asUsageRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try { return asUsageRecord(JSON.parse(value) as unknown); } catch { return undefined; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** A frozen request's estimate is usable only for the very same current Context root. */
export function currentRootEstimatedTokens(
  currentRootId: string | undefined,
  currentRootEstimate: unknown,
  requestRootId: string | undefined,
  requestEstimate: unknown
): number | undefined {
  if (!currentRootId) return undefined;
  return normalizeTokenNumber(currentRootEstimate)
    ?? (requestRootId === currentRootId ? normalizeTokenNumber(requestEstimate) : undefined);
}

export function buildTokenUsageMessages(messages: MessageRecord[]): TokenUsageMessageEntry[] {
  const sortedMessages = [...messages].sort((left, right) => left.seq - right.seq || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const normalEntries: Array<Omit<TokenUsageMessageEntry, 'ratio'>> = [];
  let firstModelUsage: { usage: NormalizedTokenUsage; floorNumber: number } | undefined;
  let nativeBeforeFirstModelUsage = false;
  let userInputBeforeFirstModel = 0;
  let previousModelInput: number | undefined;
  let userInputSincePreviousModel = 0;

  sortedMessages.forEach((message, index) => {
    const floorNumber = index + 1;
    const usage = message.usageMetadata ? normalizeTokenUsage(message.usageMetadata) : undefined;
    if (!usage) return;

    if (message.role === 'model' && usage.nativeChainBilling === true && firstModelUsage === undefined) {
      nativeBeforeFirstModelUsage = true;
    }
    if (message.role === 'model' && usage.nativeChainBilling !== true
      && usage.total !== undefined && firstModelUsage === undefined) {
      firstModelUsage = { usage, floorNumber };
    }

    const userInput = message.role === 'user' ? usage.input ?? usage.total ?? 0 : 0;
    if (firstModelUsage === undefined) userInputBeforeFirstModel += userInput;

    let tool: number | undefined;
    if (message.role === 'model') {
      if (usage.nativeChainBilling === true) {
        // A chain total is neither one prompt nor a tool delta. Break the ordinary-provider
        // baseline here, so a later request cannot compare its input to an older native bill.
        previousModelInput = undefined;
      } else {
        tool = toolTokensFromInputDelta(usage.input, previousModelInput, userInputSincePreviousModel);
        if (usage.input !== undefined) previousModelInput = usage.input;
      }
      userInputSincePreviousModel = 0;
    } else {
      userInputSincePreviousModel += userInput;
    }

    const entry = messageUsageEntry(message, floorNumber, usage, tool);
    if (entry) normalEntries.push(entry);
  });

  const maxNormalTotal = Math.max(0, ...normalEntries.map((entry) => entry.total));
  const systemEntry = nativeBeforeFirstModelUsage
    ? undefined : buildSystemPromptEntry(firstModelUsage, userInputBeforeFirstModel);
  const entries = systemEntry ? [systemEntry, ...normalEntries] : normalEntries;

  return entries.map((entry) => ({
    ...entry,
    ratio: entry.fixedRatio ? 1 : maxNormalTotal > 0 ? entry.total / maxNormalTotal : 0
  }));
}

export function normalizeTokenUsage(usage: LlmUsageMetadataRecord): NormalizedTokenUsage {
  const input = usageNumber(usage, INPUT_TOKEN_KEYS);
  const rawOutput = usageNumber(usage, OUTPUT_TOKEN_KEYS);
  const reasoning = usageNumber(usage, REASONING_TOKEN_KEYS);
  const cached = usageNumber(usage, CACHED_TOKEN_KEYS);
  const explicitTotal = usageNumber(usage, TOTAL_TOKEN_KEYS);
  const attachmentTokens = normalizeTokenNumber(usage.attachmentTokenEstimate);
  const output = outputTokensIncludingReasoning(input, rawOutput, reasoning, explicitTotal, usage.nativeChainBilling === true);
  const fallbackTotal = explicitTotal === undefined ? sumDefined([input, output]) : undefined;
  const sourceEstimated = usage.estimated === true || usage.tokenEstimator === 'tokenx';

  return {
    ...(explicitTotal !== undefined ? { total: explicitTotal } : fallbackTotal !== undefined ? { total: fallbackTotal, totalEstimated: true } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(cached !== undefined ? { cached } : {}),
    ...(attachmentTokens !== undefined && attachmentTokens > 0 ? { attachmentTokens } : {}),
    ...(usage.nativeChainBilling === true ? { nativeChainBilling: true } : {}),
    ...(sourceEstimated ? { sourceEstimated: true } : {})
  };
}

function outputTokensIncludingReasoning(
  input: number | undefined,
  rawOutput: number | undefined,
  reasoning: number | undefined,
  total: number | undefined,
  nativeChainBilling: boolean
): number | undefined {
  // A native physical output_tokens count already includes reasoning, and that count remains
  // authoritative even when a raw total is absent or inconsistent. Reasoning alone is only a
  // subset of native output: it cannot prove a complete output bill.
  if (nativeChainBilling && rawOutput !== undefined) return rawOutput;
  if (total !== undefined && input !== undefined) {
    return Math.max(0, total - input);
  }
  // Non-native Gemini-style candidates exclude thinking unless the Provider supplied a total.
  return nativeChainBilling ? undefined : sumDefined([rawOutput, reasoning]);
}

export function formatTokenNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function formatCompactTokenNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${formatScaledNumber(value, 1_000_000_000)}b`;
  if (abs >= 1_000_000) return `${formatScaledNumber(value, 1_000_000)}m`;
  if (abs >= 1_000) return `${formatScaledNumber(value, 1_000)}k`;
  return formatTokenNumber(value);
}

export function formatFloorNumber(index: number): string {
  return String(index).padStart(2, '0');
}

function messageUsageEntry(message: MessageRecord, floorNumber: number, usage: NormalizedTokenUsage, tool: number | undefined): Omit<TokenUsageMessageEntry, 'ratio'> | undefined {
  const total = totalForMessage(message.role, usage, tool);
  if (total === undefined || total <= 0) return undefined;

  const usageParts = usagePartsForMessage(message.role, usage, tool);
  return {
    id: message.id,
    kind: 'message',
    index: floorNumber,
    messageId: message.id,
    messageSeq: message.seq,
    role: message.role,
    status: message.status,
    createdAt: message.createdAt,
    total,
    ...(usageParts.input !== undefined ? { input: usageParts.input } : {}),
    ...(usageParts.output !== undefined ? { output: usageParts.output } : {}),
    ...(usageParts.reasoning !== undefined ? { reasoning: usageParts.reasoning } : {}),
    ...(usageParts.tool !== undefined ? { tool: usageParts.tool } : {}),
    ...(usage.attachmentTokens !== undefined ? { attachmentTokens: usage.attachmentTokens } : {}),
    totalEstimated: usage.totalEstimated === true,
    sourceEstimated: usage.sourceEstimated === true
  };
}

function totalForMessage(role: MsgRole, usage: NormalizedTokenUsage, tool: number | undefined): number | undefined {
  if (role === 'user') return usage.input ?? usage.total;
  const outputWithReasoning = usage.output ?? (usage.nativeChainBilling === true ? undefined : usage.reasoning);
  return sumDefined([outputWithReasoning, tool]) ?? nonInputFromTotal(usage)
    ?? (usage.nativeChainBilling === true ? undefined : usage.total);
}

function usagePartsForMessage(role: MsgRole, usage: NormalizedTokenUsage, tool: number | undefined): Pick<TokenUsageMessageEntry, 'input' | 'output' | 'reasoning' | 'tool'> {
  if (role === 'user') return { ...(usage.input !== undefined ? { input: usage.input } : {}) };
  return {
    ...(usage.output !== undefined ? { output: usage.output } : {}),
    ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
    ...(tool !== undefined ? { tool } : {})
  };
}

function toolTokensFromInputDelta(
  currentInput: number | undefined,
  previousModelInput: number | undefined,
  userInputSincePreviousModel: number
): number | undefined {
  if (currentInput === undefined || previousModelInput === undefined) return undefined;
  return Math.max(0, currentInput - previousModelInput - userInputSincePreviousModel);
}

function nonInputFromTotal(usage: NormalizedTokenUsage): number | undefined {
  if (usage.total === undefined || usage.input === undefined) return undefined;
  return Math.max(0, usage.total - usage.input);
}

function buildSystemPromptEntry(
  firstModelUsage: { usage: NormalizedTokenUsage; floorNumber: number } | undefined,
  userInputBeforeFirstModel: number
): Omit<TokenUsageMessageEntry, 'ratio'> | undefined {
  if (!firstModelUsage?.usage.total || firstModelUsage.usage.nativeChainBilling === true) return undefined;
  const total = Math.max(0, firstModelUsage.usage.total - userInputBeforeFirstModel);
  if (total <= 0) return undefined;
  return {
    id: 'system-prompt-floor-0',
    kind: 'system',
    index: 0,
    total,
    input: total,
    totalEstimated: firstModelUsage.usage.totalEstimated === true,
    sourceEstimated: firstModelUsage.usage.sourceEstimated === true,
    fixedRatio: true
  };
}

function usageNumber(usage: LlmUsageMetadataRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    if (!hasOwn.call(usage, key)) continue;
    const numeric = normalizeTokenNumber(usage[key]);
    if (numeric !== undefined) return numeric;
  }
  return undefined;
}

function normalizeTokenNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(trimmed)) return undefined;
  const numeric = Number(trimmed);
  return Number.isSafeInteger(numeric) ? numeric : undefined;
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  let hasValue = false;
  let total = 0;
  for (const value of values) {
    if (value === undefined) continue;
    hasValue = true;
    total += value;
  }
  return hasValue ? total : undefined;
}

function formatScaledNumber(value: number, scale: number): string {
  return (value / scale).toFixed(1).replace(/\.0$/, '');
}

