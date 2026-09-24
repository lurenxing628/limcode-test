import { createHash } from 'node:crypto';
import type {
  CompressionRebuildPreviewOutcome,
  CompressionRebuildSourceEstimate,
  LlmCompressionMethodKind
} from '../../shared/protocol';
import { planCompressionSummaryCalls, SEGMENTED_SUMMARY_LEAF_CALL_LIMIT } from '../capabilities/llmProvider';
import type { LlmCompactRequest } from '../world/modules/llm/contracts';
import { AttachmentCatalogProjection } from './attachmentCatalogProjection';
import {
  attachmentObservationAnalysisProfileSha256,
  loadAttachmentObservationRequirements
} from './attachmentObservations';
import {
  COMPRESSION_SOURCE_REPLAY_LIMITS,
  compressionSourceReplayLimitOf,
  expandTextCompressionSources
} from './compressionSourceReplay';
import type { ContentAddressedStore } from './contentAddressedStore';
import {
  manualRequestPlanningBudget,
  readLatestFrozenCompressionTools,
  type CompressionToolDefinition
} from './contextCompressionCoordinator';
import { ContextSequenceControlPlane } from './contextSequence';
import { ConversationAttachmentHandleRegistry } from './conversationAttachmentHandles';
import { mergeConversationChildHandles, readConversationChildHandles } from './conversationChildHandles';
import { frozenCompressionPolicy } from './frozenAuthority';
import { compactRequestForCompressionPlanning, estimateCompactProjection } from './llmCapabilityProviderAdapter';
import {
  calculateCalibratedCompressionRooms,
  calculateEffectiveSummaryMaxTokens,
  calculateFullRequestPlanningBudget,
  preflightCompressionRequest,
  UNCALIBRATED_PROVIDER_TOKENS
} from './modelFacingContextProjection';
import { buildModelHandleCatalog } from './modelHandleCatalog';
import type { FullProviderContextItem, FullProviderRequest } from './modelProviderControlPlane';
import { estimateMessageContentsTokens } from './modelTokenEstimator';
import { normalizePlainJson, type PlainJsonValue } from './plainJson';
import type { RuntimeDatabase } from './runtimeDatabase';

type ExecutedMethodKind = Exclude<LlmCompressionMethodKind, 'disabled' | 'auto'>;

export interface CompressionRebuildPreviewInput {
  database: RuntimeDatabase;
  contentStore: ContentAddressedStore;
  conversationId: string;
  rootId: string;
  /**
   * Authority of the maintenance Turn the rebuild would admit, with the current request settings
   * applied exactly as the rebuild freezes them.
   */
  authority: PlainJsonValue;
}

export interface CompressionRebuildPreview {
  estimate?: CompressionRebuildSourceEstimate;
  outcome: CompressionRebuildPreviewOutcome;
}

const PREVIEW_REQUEST_ID = 'compression_rebuild_preview';
const PREVIEW_CACHE_LIMIT = 8;

/**
 * One estimate per Context root and frozen settings. The estimate runs on the extension host and a
 * long history takes a noticeable moment; reopening the dialog, or a second panel asking, joins the
 * running computation or reuses its answer instead of starting another one alongside it. A root
 * never changes, so an answer stays right for the same root and authority; a failure is not kept.
 * Closing the dialog needs no cancellation: the Webview ignores an answer it no longer waits for.
 */
export class CompressionRebuildPreviewCache {
  private readonly entries = new Map<string, Promise<CompressionRebuildPreview>>();

  public preview(input: CompressionRebuildPreviewInput): Promise<CompressionRebuildPreview> {
    const key = previewCacheKey(input);
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
    const running = previewCompressionSourceReplay(input);
    this.entries.set(key, running);
    running.catch(() => {
      if (this.entries.get(key) === running) this.entries.delete(key);
    });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= PREVIEW_CACHE_LIMIT) break;
      this.entries.delete(oldest);
    }
    return running;
  }

  public clear(): void {
    this.entries.clear();
  }
}

function previewCacheKey(input: CompressionRebuildPreviewInput): string {
  return createHash('sha256')
    .update(JSON.stringify([input.conversationId, input.rootId, input.authority]))
    .digest('hex');
}

/**
 * Estimates a rebuild from original records before the user confirms it. It walks the same frozen
 * execution plan a manual `immutable_provenance` compression runs: the same source expansion and
 * caps, the same compact projection, the same kernel preflight, and for summaries the same Provider
 * request builders and window checks. It sends nothing and writes nothing. Numbers come from the
 * model-independent estimator and are estimates.
 */
export async function previewCompressionSourceReplay(
  input: CompressionRebuildPreviewInput
): Promise<CompressionRebuildPreview> {
  const { database, contentStore } = input;
  const conversationId = requireText(input.conversationId, 'conversationId');
  const rootId = requireText(input.rootId, 'rootId');
  const policy = frozenCompressionPolicy(input.authority);
  if (!policy || policy.executionPlan.attempts.length === 0) {
    return { outcome: { kind: 'blocked', reason: 'compression_disabled' } };
  }

  const materialized = await new ContextSequenceControlPlane(database, contentStore).materialize(rootId);
  if (materialized.root.conversation_id !== conversationId) {
    throw new Error('重建预估的上下文不属于当前对话。');
  }
  if (materialized.segments.length === 0) throw new Error('当前上下文为空，无法重建摘要。');
  const segmentTexts = materialized.segments.map((segment) =>
    decodeUtf8Exact(segment.content, `ContextSegment ${segment.segmentId}`));
  const context: FullProviderContextItem[] = materialized.segments.map((segment, index) => ({
    segmentId: segment.segmentId,
    segmentKind: segment.segmentKind,
    messageRole: segment.messageRole,
    ...(segment.modelSource ? { modelSource: segment.modelSource } : {}),
    contentType: segment.contentObject.content_type,
    content: segmentTexts[index]!
  }));
  const summaryCount = context.filter((item) => item.segmentKind === 'compression').length;

  let sourceContext: FullProviderContextItem[];
  try {
    sourceContext = await expandTextCompressionSources(database, contentStore, conversationId, context, {
      sourceReplay: 'immutable_provenance'
    });
  } catch (error) {
    const limit = compressionSourceReplayLimitOf(error);
    if (!limit) throw error;
    return { outcome: {
      kind: 'blocked',
      reason: 'replay_limit_exceeded',
      replayLimit: { kind: limit, value: COMPRESSION_SOURCE_REPLAY_LIMITS[limit] }
    } };
  }

  // Handles and observations as the coordinator freezes them, read without allocating anything.
  const attachmentCatalogState = await new AttachmentCatalogProjection(database).projectState(
    conversationId,
    materialized.segments.map((segment) => ({ segmentId: segment.segmentId }))
  );
  const attachmentHandles = await new ConversationAttachmentHandleRegistry(database).peek(
    conversationId,
    attachmentCatalogState.catalog
  );
  const modelHandleCatalog = buildModelHandleCatalog(segmentTexts, [
    ...attachmentHandles.entries,
    ...mergeConversationChildHandles(await readConversationChildHandles(database, contentStore, conversationId))
  ]);
  const observationProfile = attachmentCatalogState.catalog.length > 0
    ? attachmentObservationAnalysisProfileSha256(policy.provider)
    : undefined;
  const observationRequirements = observationProfile
    ? await loadAttachmentObservationRequirements(
        database,
        contentStore,
        attachmentCatalogState.catalog,
        attachmentHandles,
        observationProfile
      )
    : [];
  const attachmentRequests = observationRequirements.filter((requirement) => !requirement.cachedObservation).length;
  const rooms = calculateCalibratedCompressionRooms({
    budget: manualRequestPlanningBudget(input.authority, policy.thresholdTokens),
    calibration: UNCALIBRATED_PROVIDER_TOKENS,
    irreducibleAddendaTokens: 0,
    ...(policy.config.bodyTargetTokens === undefined ? {} : { bodyTargetTokens: policy.config.bodyTargetTokens })
  });
  const effectiveSummaryMaxTokens = calculateEffectiveSummaryMaxTokens(
    policy.config.llmSummary?.targetTokens,
    rooms.calibratedBodyTargetTokens
  );

  const buildCompact = (methodKind: ExecutedMethodKind, tools?: readonly CompressionToolDefinition[]): LlmCompactRequest => {
    const text = methodKind !== 'provider_native';
    const recipe = normalizePlainJson({
      kind: 'reliable-context-compression',
      requestKind: 'context_compression_manual',
      trigger: 'manual',
      triggerReason: 'manual',
      sourceRootId: rootId,
      sourceSegmentCount: context.length,
      sourceReplay: 'immutable_provenance',
      blockId: PREVIEW_REQUEST_ID,
      compressionConfigId: policy.config.id,
      compressionMethodKind: methodKind,
      ...(methodKind === 'provider_native' ? { tools: (tools ?? []) as unknown as PlainJsonValue } : {}),
      attachmentCatalogState: attachmentCatalogState as unknown as PlainJsonValue,
      ...(modelHandleCatalog.entries.length > 0 ? { modelHandleCatalog: modelHandleCatalog as unknown as PlainJsonValue } : {}),
      ...(text && observationProfile ? {
        attachmentObservationProfileSha256: observationProfile,
        attachmentObservationRequirements: observationRequirements as unknown as PlainJsonValue
      } : {}),
      ...(text ? { effectiveSummaryMaxTokens } : {})
    }, 'Compression rebuild preview recipe');
    const request: FullProviderRequest = {
      kind: 'full-model-request',
      modelRequestId: PREVIEW_REQUEST_ID,
      conversationId,
      attemptSeq: '1',
      socketGeneration: '1',
      providerId: policy.provider.providerConfigId,
      modelId: policy.provider.modelId,
      authoritySnapshot: input.authority,
      recipe,
      context,
      compressionSourceContext: sourceContext,
      attachmentCatalogState
    };
    return compactRequestForCompressionPlanning(request);
  };
  // Text methods read the same Context the same way; only the method differs. Building the compact
  // request walks the whole history, so it is built once and the other text methods reuse it.
  let textCompact: LlmCompactRequest | undefined;
  const compactFor = (methodKind: Exclude<ExecutedMethodKind, 'provider_native'>): LlmCompactRequest => {
    textCompact ??= buildCompact('segmented_summary');
    if (methodKind === 'segmented_summary') return textCompact;
    const { segments: _segments, ...single } = textCompact;
    return {
      ...single,
      methodKind,
      methodConfigSnapshot: { ...textCompact.methodConfigSnapshot!, kind: methodKind }
    };
  };
  // The kernel preflight every compression ModelRequest passes before dispatch.
  const admitted = (compact: LlmCompactRequest): boolean => preflightCompressionRequest({
    contextWindowTokens: policy.provider.contextWindowTokens,
    maxOutputTokens: policy.provider.maxOutputTokens,
    compressionThresholdTokens: policy.provider.contextWindowTokens,
    breakdown: compact.methodKind === 'segmented_summary' ? estimateCompactProjection(compact) : textSourceProjection
  }).status === 'ready';
  const summaryWindow = { contextWindowTokens: policy.provider.contextWindowTokens };

  const textSource = compactFor('llm_summary');
  // Single-call methods send the whole source; its projection is measured once for all of them.
  const textSourceProjection = estimateCompactProjection(textSource);
  const estimate: CompressionRebuildSourceEstimate = {
    sourceTokens: estimateMessageContentsTokens([...(textSource.priorSummaryContents ?? []), ...textSource.contents]),
    summaryCount,
    contextWindowTokens: policy.provider.contextWindowTokens,
    inputCapacityTokens: calculateFullRequestPlanningBudget({
      contextWindowTokens: policy.provider.contextWindowTokens,
      maxOutputTokens: policy.provider.maxOutputTokens,
      compressionThresholdTokens: policy.provider.contextWindowTokens,
      breakdown: textSourceProjection
    }).planningInputCapacityTokens
  };
  const ready = (
    methodKind: ExecutedMethodKind,
    summaryRequests: number,
    mergeRequests: number,
    attachments: number
  ): CompressionRebuildPreview => ({
    estimate,
    outcome: {
      kind: 'ready',
      methodKind,
      providerRequests: summaryRequests + mergeRequests + attachments,
      summaryRequests,
      mergeRequests,
      attachmentRequests: attachments
    }
  });

  // First method of the frozen plan expected to succeed, in the order the coordinator tries them.
  let segmentedBlock: 'leaf_budget_exceeded' | 'request_too_large' | undefined;
  let singleCallTooLarge = false;
  for (const attempt of policy.executionPlan.attempts) {
    const methodKind = attempt.methodKind;
    if (methodKind === 'provider_native') {
      const tools = await readLatestFrozenCompressionTools(database, contentStore, conversationId);
      const native = buildCompact(methodKind, tools);
      const nativeAdmitted = preflightCompressionRequest({
        contextWindowTokens: policy.provider.contextWindowTokens,
        maxOutputTokens: policy.provider.maxOutputTokens,
        compressionThresholdTokens: policy.provider.contextWindowTokens,
        breakdown: estimateCompactProjection(native)
      }).status === 'ready';
      if (nativeAdmitted) return ready(methodKind, 1, 0, 0);
      singleCallTooLarge = true;
      continue;
    }
    if (methodKind === 'deterministic_summary' || methodKind === 'manual_summary') {
      if (admitted(compactFor(methodKind))) return ready(methodKind, 0, 0, 0);
      singleCallTooLarge = true;
      continue;
    }
    const compact = methodKind === 'llm_summary' ? textSource : compactFor(methodKind);
    if (!admitted(compact)) {
      if (methodKind === 'segmented_summary') segmentedBlock = 'request_too_large';
      else singleCallTooLarge = true;
      continue;
    }
    try {
      const plan = planCompressionSummaryCalls(compact, summaryWindow);
      return ready(methodKind, plan.summaryCalls, plan.mergeCalls, attachmentRequests);
    } catch (error) {
      const code = summarySizeErrorCode(error);
      if (!code) throw error;
      if (methodKind === 'segmented_summary') {
        segmentedBlock = code === 'compression_source_too_large' ? 'leaf_budget_exceeded' : 'request_too_large';
      } else {
        singleCallTooLarge = true;
      }
    }
  }
  const reason = segmentedBlock ?? (singleCallTooLarge ? 'no_chunking_method' : 'request_too_large');
  return {
    estimate,
    outcome: {
      kind: 'blocked',
      reason,
      ...(reason === 'leaf_budget_exceeded' ? { leafRequestLimit: SEGMENTED_SUMMARY_LEAF_CALL_LIMIT } : {})
    }
  };
}

function summarySizeErrorCode(error: unknown): 'compression_source_too_large' | 'compression_request_too_large' | undefined {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('compression_source_too_large')) return 'compression_source_too_large';
  if (message.startsWith('compression_request_too_large')) return 'compression_request_too_large';
  return undefined;
}

function decodeUtf8Exact(bytes: Buffer, label: string): string {
  const value = bytes.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(bytes)) throw new Error(`${label} is not valid UTF-8.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}
