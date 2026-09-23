import type { MessageContent } from '../../shared/protocol';
import type { AttachmentCatalogState } from './attachmentCatalog';
import { AttachmentCatalogProjection } from './attachmentCatalogProjection';
import { ConversationAttachmentHandleRegistry } from './conversationAttachmentHandles';
import { ContentAddressedStore } from './contentAddressedStore';
import {
  ContextSequenceControlPlane,
  type MaterializedContextSegment
} from './contextSequence';
import type { PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';
import { projectStoredModelFacingWindow } from './modelFacingContextProjection';
import type { ModelHandleCatalog } from './modelHandleCatalog';
import { toolAllowedByPolicy } from '../../shared/toolPolicyResolution';
import {
  canonicalizeCompressionContents,
  estimateJsonTokens,
  estimateMessageContentTokens,
  estimateMessageContentsMediaTokens,
  estimateMessageContentsTokens,
  estimateTextTokens
} from './modelTokenEstimator';

export {
  canonicalizeCompressionContents,
  estimateJsonTokens,
  estimateMessageContentTokens,
  estimateMessageContentsMediaTokens,
  estimateMessageContentsTokens,
  estimateTextTokens
} from './modelTokenEstimator';

const CONTENT_TYPE_MESSAGE = 'application/vnd.limcode.message+json';
const CONTENT_TYPE_TOOL_PAIR = 'application/vnd.limcode.context-tool-pair+json';
const CONTENT_TYPE_COMPRESSION = 'application/vnd.limcode.compression-contents+json';
const MESSAGE_OVERHEAD_TOKENS = 4;
const FUNCTION_OVERHEAD_TOKENS = 4;

export type ReliableContextTokenEstimateSource =
  | 'provider-observed-delta'
  | 'compression-output'
  | 'semantic';

export interface ReliableContextTokenEstimate {
  estimatedTokens: number;
  source: ReliableContextTokenEstimateSource;
  conversationId: string;
  observedPromptTokens?: number;
  observedModelRequestId?: string;
  coveredSegmentCount: number;
}

/**
 * Provider-aligned Context accounting.
 *
 * ContextSequence stores durable replay envelopes. Those bytes are deliberately not the provider
 * token stream: they can contain base64 attachments, duplicate convenience fields and source facts
 * that materialization later drops. This estimator therefore works on the materialized semantic
 * parts and, when possible, anchors the prefix to a provider-observed prompt/total token count.
 */
export class ReliableContextTokenEstimator {
  private readonly context: ContextSequenceControlPlane;
  private readonly attachmentCatalog: AttachmentCatalogProjection;
  private readonly attachmentHandles: ConversationAttachmentHandleRegistry;

  public constructor(
    private readonly database: RuntimeDatabase,
    contentStore: ContentAddressedStore
  ) {
    this.context = new ContextSequenceControlPlane(database, contentStore);
    this.attachmentCatalog = new AttachmentCatalogProjection(database);
    this.attachmentHandles = new ConversationAttachmentHandleRegistry(database);
  }

  public async estimateRoot(rootIdInput: string): Promise<ReliableContextTokenEstimate> {
    const rootId = requireId(rootIdInput, 'rootId');
    const materialized = await this.context.materialize(rootId);
    const conversationId = requireId(materialized.root.conversation_id, 'ContextSequenceRoot.conversation_id');
    const attachmentCatalogState = await this.attachmentCatalog.projectState(
      conversationId,
      materialized.segments.map((segment) => ({
        segmentId: segment.segmentId
      }))
    );
    const modelHandleCatalog = await this.attachmentHandles.ensure(
      conversationId,
      attachmentCatalogState.catalog
    );
    const projectedTokens = estimateMaterializedContextTokens(
      materialized.segments,
      attachmentCatalogState,
      modelHandleCatalog
    );
    const compressed = compressionEstimate(materialized.segments);
    const observed = await this.findObservedPrefix(
      conversationId,
      materialized.segments,
      attachmentCatalogState,
      modelHandleCatalog
    );
    if (observed) return observed;
    return {
      estimatedTokens: projectedTokens,
      source: compressed ? 'compression-output' : 'semantic',
      conversationId,
      coveredSegmentCount: materialized.segments.length
    };
  }

  /** Estimates the exact projected prefix while preserving any full-root Provider usage anchor. */
  public async estimateRootPrefix(rootIdInput: string, segmentCountInput: number): Promise<number> {
    const rootId = requireId(rootIdInput, 'rootId');
    const materialized = await this.context.materialize(rootId);
    const segmentCount = requireSegmentCount(segmentCountInput, materialized.segments.length);
    if (segmentCount === materialized.segments.length) {
      return (await this.estimateRoot(rootId)).estimatedTokens;
    }
    const full = await this.estimateRoot(rootId);
    const prefixSegments = materialized.segments.slice(0, segmentCount);
    const conversationId = requireId(materialized.root.conversation_id, 'ContextSequenceRoot.conversation_id');
    const fullAttachmentState = await this.attachmentCatalog.projectState(
      conversationId,
      materialized.segments.map((segment) => ({
        segmentId: segment.segmentId
      }))
    );
    const prefixAttachmentState = await this.attachmentCatalog.projectState(
      conversationId,
      prefixSegments.map((segment) => ({
        segmentId: segment.segmentId
      }))
    );
    const modelHandleCatalog = await this.attachmentHandles.ensure(
      conversationId,
      fullAttachmentState.catalog
    );
    const fullProjected = estimateMaterializedContextTokens(
      materialized.segments,
      fullAttachmentState,
      modelHandleCatalog
    );
    const prefixProjected = estimateMaterializedContextTokens(
      prefixSegments,
      prefixAttachmentState,
      modelHandleCatalog
    );
    return Math.max(0, full.estimatedTokens - Math.max(0, fullProjected - prefixProjected));
  }

  private async findObservedPrefix(
    conversationId: string,
    current: readonly MaterializedContextSegment[],
    currentAttachmentState: AttachmentCatalogState,
    modelHandleCatalog: ModelHandleCatalog
  ): Promise<ReliableContextTokenEstimate | null> {
    const turns = (await listAllDomainRows(this.database, 'Turn', {
      conversation_id: conversationId
    })).sort(compareRequestsNewestFirst);
    // Query newest Turns lazily. A long Conversation can contain thousands of Turns; fanning out one
    // SQLite request per historical Turn on every compression check would make token accounting the
    // new bottleneck. The current/latest Turn normally resolves the baseline immediately.
    for (const turn of turns) {
      const requests = (await listAllDomainRows(this.database, 'ModelRequest', {
        turn_id: requireId(turn.id, 'Turn.id')
      })).filter((request) =>
        request.status === 'terminal'
        && request.terminal_state === 'completed'
      ).sort(compareRequestsNewestFirst);

      for (const request of requests) {
        const calibration = nativePromptCalibration(request.stream_stats_json);
        // A native logical ModelRequest spans multiple physical responses whose usage_json is
        // cumulative billing; only the FIRST physical response's prompt count calibrates the
        // initial projection root. A native anchor without that count yields no calibration at
        // all rather than an invalid aggregate. Other providers keep the usage_json anchor.
        const input = calibration.native
          ? calibration.promptTokens
          : providerPromptTokens(request.usage_json);
        if (input === undefined) continue;
        const requestId = requireId(request.id, 'ModelRequest.id');
        const related = await this.database.snapshot([
          DOMAIN_REPOSITORIES.domain('ModelRequestMessageLink').list({
            where: { model_request_id: requestId }, limit: 2
          }),
          DOMAIN_REPOSITORIES.domain('ModelContextProjection').list({
            where: { owner_kind: 'model_request', owner_id: requestId }, limit: 2
          })
        ]);
        const links = rows(related.snapshot[0]);
        const projections = rows(related.snapshot[1]);
        // Compression requests never own an assistant Message link. Excluding them is essential:
        // their usage describes the compaction call, not the ordinary model prompt shown to users.
        if (links.length === 0) continue;
        if (links.length !== 1 || projections.length !== 1) return null;
        const projected = await this.context.materialize(requireId(projections[0].root_id, 'ModelContextProjection.root_id'));
        // Conversation Context is linear between explicit compression/edit operations. Once the latest
        // ordinary request is not a prefix, no older ordinary request can be a safer calibration.
        if (!isSegmentPrefix(projected.segments, current)) return null;

        let coveredSegmentCount = projected.segments.length;
        let anchoredTokens = input;
        const outputSegmentId = await this.messageSegmentId(requireId(links[0].message_id, 'ModelRequestMessageLink.message_id'));
        if (outputSegmentId && current[coveredSegmentCount]?.segmentId === outputSegmentId) {
          const total = calibration.native ? undefined : providerTotalTokens(request.usage_json);
          const outputSegment = current[coveredSegmentCount];
          const outputAttachmentState = await this.attachmentCatalog.projectState(conversationId, [{
            segmentId: outputSegment.segmentId
          }]);
          anchoredTokens = total ?? (input + estimateMaterializedContextTokens(
            [outputSegment],
            outputAttachmentState,
            modelHandleCatalog
          ));
          coveredSegmentCount += 1;
        }
        const coveredSegments = current.slice(0, coveredSegmentCount);
        const coveredAttachmentState = await this.attachmentCatalog.projectState(
          conversationId,
          coveredSegments.map((segment) => ({
            segmentId: segment.segmentId
          }))
        );
        const coveredProjected = estimateMaterializedContextTokens(
          coveredSegments,
          coveredAttachmentState,
          modelHandleCatalog
        );
        const currentProjected = estimateMaterializedContextTokens(
          current,
          currentAttachmentState,
          modelHandleCatalog
        );
        const estimatedTokens = anchoredTokens + Math.max(0, currentProjected - coveredProjected);
        return {
          estimatedTokens: safeTokenCount(estimatedTokens, 'provider-observed Context estimate'),
          source: 'provider-observed-delta',
          conversationId,
          observedPromptTokens: input,
          observedModelRequestId: requestId,
          coveredSegmentCount
        };
      }
    }
    return null;
  }

  private async messageSegmentId(messageId: string): Promise<string | null> {
    const revisions = (await listAllDomainRows(this.database, 'MessageRevision', {
      message_id: messageId
    })).sort((left, right) => {
      const leftSeq = nonNegativeBigInt(left.revision_seq);
      const rightSeq = nonNegativeBigInt(right.revision_seq);
      return leftSeq < rightSeq ? -1 : leftSeq > rightSeq ? 1 : 0;
    });
    // ModelRequestMessageLink owns the original provider output Message, not a later user edit.
    const providerRevision = revisions[0];
    if (!providerRevision) return null;
    const sources = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
        where: {
          source_kind: 'message_revision',
          source_id: requireId(providerRevision.id, 'MessageRevision.id')
        },
        limit: 2
      })
    ]);
    const occurrences = rows(sources.snapshot[0]);
    return occurrences.length === 1
      ? requireId(occurrences[0].segment_id, 'ContextSegmentSource.segment_id')
      : null;
  }
}

export function estimateMaterializedContextTokens(
  segments: readonly MaterializedContextSegment[],
  attachmentCatalogState: AttachmentCatalogState | unknown = { catalog: [], placements: [] },
  modelHandleCatalog: ModelHandleCatalog | unknown = { entries: [] }
): number {
  const projected = projectStoredModelFacingWindow(segments.map((segment) => ({
    segmentId: segment.segmentId,
    segmentKind: segment.segmentKind,
    messageRole: segment.messageRole,
    contentType: segment.contentObject.content_type,
    content: segment.content.toString('utf8')
  })), attachmentCatalogState, modelHandleCatalog);
  const compressed = compressionEstimate(segments);
  if (compressed === undefined || segments.length === 0) return projected.tokenCount;
  const projectedCompression = projectStoredModelFacingWindow([{
    segmentId: segments[0].segmentId,
    segmentKind: segments[0].segmentKind,
    messageRole: segments[0].messageRole,
    contentType: segments[0].contentObject.content_type,
    content: segments[0].content.toString('utf8')
  }]).tokenCount;
  return safeTokenCount(
    projected.tokenCount - projectedCompression + compressed,
    'projected Context estimate'
  );
}

export function estimateContextSegmentTokens(segment: Pick<
  MaterializedContextSegment,
  'segmentKind' | 'messageRole' | 'contentObject' | 'content'
>): number {
  const content = segment.content.toString('utf8');
  const contentType = segment.contentObject.content_type;
  if (segment.segmentKind === 'tool_pair' || contentType === CONTENT_TYPE_TOOL_PAIR) {
    return estimateToolPairContentTokens(content);
  }
  if (segment.segmentKind === 'compression' || contentType === CONTENT_TYPE_COMPRESSION) {
    return estimateCompressionEnvelopeTokens(content);
  }
  if (contentType === CONTENT_TYPE_MESSAGE) {
    const message = parseMessageContent(content);
    if (message) return estimateMessageContentTokens(message);
  }
  return estimateTextTokens(contextText(content, contentType));
}

export function estimateStoredMessageContentTokens(
  content: string | Uint8Array,
  contentType: string
): number {
  const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
  if (contentType === CONTENT_TYPE_MESSAGE) {
    const message = parseMessageContent(text);
    if (message) return estimateMessageContentTokens(message);
  }
  return estimateTextTokens(contextText(text, contentType));
}

export function estimateRequestAuthorityTokens(
  authorityValue: PlainJsonValue,
  recipeValue: PlainJsonValue
): number {
  const authority = asRecord(authorityValue);
  const recipe = asRecord(recipeValue);
  if (!authority || !recipe || recipe.kind === 'reliable-context-compression') return 0;
  let total = 0;
  const systemPrompt = asRecord(authority.systemPrompt);
  const runtimeContext = asRecord(authority.runtimeContext);
  if (typeof systemPrompt?.text === 'string') total += estimateTextTokens(systemPrompt.text.trim());
  if (typeof runtimeContext?.template === 'string') total += estimateTextTokens(runtimeContext.template.trim());

  const policy = asRecord(authority.toolPolicy);
  const allowed = new Set(Array.isArray(policy?.allowedTools)
    ? policy.allowedTools.filter((value): value is string => typeof value === 'string')
    : []);
  const sourceConfigs = asRecord(policy?.sourceConfigs) ?? {};
  const toolConfigs = asRecord(policy?.toolConfigs) ?? {};
  const tools = Array.isArray(recipe.tools) ? recipe.tools : [];
  for (const value of tools) {
    const tool = asRecord(value);
    if (!tool || !providerToolAllowed(tool, { allowedTools: allowed, sourceConfigs, toolConfigs })) continue;
    total += 10;
    if (typeof tool.name === 'string') total += estimateTextTokens(tool.name);
    if (typeof tool.description === 'string') total += estimateTextTokens(tool.description);
    total += estimateJsonTokens(tool.parameters ?? {});
  }
  return safeTokenCount(total, 'request authority token estimate');
}

export function estimateToolPairContentTokens(content: string): number {
  const pair = parseRecord(content);
  const call = asRecord(pair?.toolCall);
  const result = asRecord(pair?.toolModelResult);
  if (!call) return estimateTextTokens(content);
  if (!result) {
    // A native async call admitted before its delayed result arrives: count the call item only.
    return MESSAGE_OVERHEAD_TOKENS
      + FUNCTION_OVERHEAD_TOKENS
      + estimateTextTokens(typeof call.toolName === 'string' ? call.toolName : '')
      + estimateJsonTokens(parseNestedJson(call.arguments) ?? {});
  }
  const response = parseNestedJson(result.result);
  return MESSAGE_OVERHEAD_TOKENS
    + FUNCTION_OVERHEAD_TOKENS
    + estimateTextTokens(typeof call.toolName === 'string' ? call.toolName : '')
    + estimateJsonTokens(response);
}

function estimateCompressionEnvelopeTokens(content: string): number {
  const envelope = parseRecord(content);
  if (!envelope || envelope.kind !== 'compression_contents' || !Array.isArray(envelope.contents)) {
    return estimateTextTokens(content);
  }
  const stored = optionalTokenCount(envelope.estimatedTokens);
  if (stored !== undefined) return stored;
  const contents = envelope.contents.filter(isMessageContent);
  return estimateMessageContentsTokens(contents);
}

function compressionEstimate(segments: readonly MaterializedContextSegment[]): number | undefined {
  const first = segments[0];
  if (!first || first.segmentKind !== 'compression') return undefined;
  const envelope = parseRecord(first.content.toString('utf8'));
  return optionalTokenCount(envelope?.estimatedTokens);
}

function parseMessageContent(content: string): MessageContent | undefined {
  const parsed = parseRecord(content);
  return parsed && isMessageContent(parsed) ? parsed : undefined;
}

function isMessageContent(value: unknown): value is MessageContent {
  const record = asRecord(value);
  return Boolean(record)
    && (record?.role === 'user' || record?.role === 'model')
    && Array.isArray(record.parts);
}

function contextText(content: string, contentType: string): string {
  if (contentType === 'application/json' || contentType.endsWith('+json')) {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (typeof parsed === 'string') return parsed;
      const record = asRecord(parsed);
      if (typeof record?.text === 'string') return record.text;
      if (typeof record?.summary === 'string') return record.summary;
    } catch {
      return content;
    }
  }
  return content;
}

function providerToolAllowed(
  tool: Record<string, unknown>,
  policy: { allowedTools: ReadonlySet<string>; sourceConfigs: Record<string, unknown>; toolConfigs: Record<string, unknown> }
): boolean {
  const source = asRecord(tool.source);
  return toolAllowedByPolicy(policy, {
    name: typeof tool.name === 'string' ? tool.name : '',
    ...(source ? { source } : {})
  });
}

function isSegmentPrefix(
  prefix: readonly MaterializedContextSegment[],
  complete: readonly MaterializedContextSegment[]
): boolean {
  return prefix.length <= complete.length && prefix.every((segment, index) =>
    segment.segmentId === complete[index]?.segmentId
  );
}

function compareRequestsNewestFirst(left: DomainRow, right: DomainRow): number {
  const leftTime = timestamp(left.updated_at) || timestamp(left.created_at);
  const rightTime = timestamp(right.updated_at) || timestamp(right.created_at);
  if (leftTime !== rightTime) return rightTime - leftTime;
  const leftSeq = nonNegativeBigInt(left.request_seq);
  const rightSeq = nonNegativeBigInt(right.request_seq);
  return leftSeq < rightSeq ? 1 : leftSeq > rightSeq ? -1 : 0;
}

export function providerPromptTokens(value: unknown): number | undefined {
  const usage = usageRecord(value);
  return firstTokenCount(usage, ['promptTokenCount', 'prompt_tokens', 'input_tokens', 'inputTokens']);
}

export function providerTotalTokens(value: unknown): number | undefined {
  const usage = usageRecord(value);
  const explicit = firstTokenCount(usage, ['totalTokenCount', 'total_tokens', 'totalTokens']);
  if (explicit !== undefined) return explicit;
  const input = firstTokenCount(usage, ['promptTokenCount', 'prompt_tokens', 'input_tokens', 'inputTokens']);
  const output = firstTokenCount(usage, ['candidatesTokenCount', 'completion_tokens', 'output_tokens', 'outputTokens']);
  return input !== undefined && output !== undefined ? input + output : undefined;
}

export function compressionOutputTokens(value: unknown): number | undefined {
  const usage = usageRecord(value);
  return firstTokenCount(usage, ['candidatesTokenCount', 'completion_tokens', 'output_tokens', 'outputTokens']);
}

/**
 * Detects a native logical ModelRequest anchor from its persisted stream stats. A native chain
 * spans multiple physical responses, so the terminal usage_json is cumulative billing that must
 * never calibrate the initial ModelContextProjection root: the FIRST physical response's actual
 * usage.input_tokens is the only valid anchor, and a marked native anchor without it yields no
 * calibration (the caller skips the request instead of falling back to the aggregate).
 */
export function nativePromptCalibration(streamStats: unknown): { native: boolean; promptTokens?: number } {
  const stats = typeof streamStats === 'string' ? parseRecord(streamStats) : asRecord(streamStats);
  if (!stats || (stats.nativeCapabilities === undefined && stats.nativeInitialPromptTokenCount === undefined)) {
    return { native: false };
  }
  const initial = stats.nativeInitialPromptTokenCount;
  return {
    native: true,
    ...(typeof initial === 'number' && Number.isSafeInteger(initial) && initial >= 0
      ? { promptTokens: initial }
      : {})
  };
}

function usageRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

function firstTokenCount(value: Record<string, unknown> | undefined, keys: readonly string[]): number | undefined {
  if (!value) return undefined;
  for (const key of keys) {
    const parsed = optionalTokenCount(value[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function parseNestedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseRecord(content: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(content) as unknown);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalTokenCount(value: unknown): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function safeTokenCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} is outside the safe integer range.`);
  return value;
}

function requireSegmentCount(value: number, total: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > total) {
    throw new RangeError(`segmentCount must be from 1 to ${Math.max(1, total)}.`);
  }
  return value;
}

function rows(value: unknown): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError('Repository list result must be an array.');
  return value as DomainRow[];
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonNegativeBigInt(value: unknown): bigint {
  return typeof value === 'bigint' && value >= 0n ? value : 0n;
}
