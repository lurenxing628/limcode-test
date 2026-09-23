import { createHash } from 'node:crypto';
import { safeProviderFailureMessage, type CompressionAttemptFailure, type CompressionRecoveryDecision } from '../../shared/compressionExecution';
export type { CompressionAttemptFailure } from '../../shared/compressionExecution';
import type { MessageContent } from '../../shared/protocol';
import type { CompressionExecutionAttempt } from '../../shared/modelCapabilities';
import {
  rebaseAttachmentCatalogState,
  selectAttachmentCatalogStateSegments,
  type AttachmentCatalogState
} from './attachmentCatalog';
import { AttachmentCatalogProjection } from './attachmentCatalogProjection';
import {
  assertAttachmentObservationStateContent,
  attachmentObservationAnalysisProfileSha256,
  completeAttachmentObservationCommits,
  loadAttachmentObservationRequirements
} from './attachmentObservations';
import type { ReliableAgentProviderRegistry } from './agentLoop';
import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { mergeConversationChildHandles, readConversationChildHandles } from './conversationChildHandles';
import {
  ContextCompressionControlPlane,
  compressionBlockIdFor,
  compressionSegmentIdFor,
  type CompressionCommitResult
} from './contextCompression';
import {
  ContextSequenceControlPlane,
  type MaterializedContext,
  type MaterializedContextSegment,
  type StructuralContextRecord
} from './contextSequence';
import { EffectControlPlane } from './effectControlPlane';
import { isExecutionHandoffError } from './executionLeaseFence';
import { frozenCompressionPolicy, frozenContextProfile } from './frozenAuthority';
import { readRequestTurnAuthority } from './requestCompressionSettings';
import {
  evaluateNativeCompressionGuard,
  planNativeCompressionRebase,
  selectBlockingNativePendingCalls,
  type NativeCompressionGuardFacts,
  type NativeCompressionRebasePlan
} from './nativeCompressionGuard';
import { readNativeSteeringInFlight } from './nativeSteering';
import {
  compressionOutputTokens,
  estimateMaterializedContextTokens,
  estimateMessageContentsTokens,
  providerPromptTokens
} from './contextTokenEstimator';
import {
  calculateCalibratedCompressionRooms,
  calculateEffectiveSummaryMaxTokens,
  calculateFullRequestPlanningBudget,
  calibrateEstimatorToProvider,
  calibratedTailBudgetTokens,
  collectStoredNativeConfigurationUpdates,
  projectStoredModelFacingWindow,
  providerTokenCalibration,
  selectContinuousAtomicTail,
  UNCALIBRATED_PROVIDER_TOKENS,
  type AtomicContextGroup,
  type ContextPlanningFailureCode,
  type FullRequestPlanningBudget
} from './modelFacingContextProjection';
import { buildModelHandleCatalog, normalizeModelHandleCatalog, type ModelHandleCatalog } from './modelHandleCatalog';
import {
  ModelRequestPreflightError,
  ModelProviderControlPlane,
  restoredProviderRequestFailure,
  modelRequestIdFor,
  type FullRequestProviderAdapter
} from './modelProviderControlPlane';
import { normalizePlainJson, type PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';

export type CompressionTrigger = 'auto' | 'manual';
export type CompressionTriggerReason = 'manual' | 'configured_threshold';

export interface CompressionToolDefinition {
  name: string;
  description: string;
  parameters: PlainJsonValue;
  source?: PlainJsonValue;
  metadata?: PlainJsonValue;
  defaultConfig?: PlainJsonValue;
}

export interface CoordinateCompressionCommand {
  turnId: string;
  authoritySnapshotId: string;
  settingsSnapshotContentObjectId?: string;
  headRootId: string;
  trigger: CompressionTrigger;
  /** Exact frozen ordinary request planning budget. Required for automatic compression; optional for manual. */
  requestBudget?: FullRequestPlanningBudget;
  /** Exact active-Turn input that may need request-level reinjection after this compression. */
  protectedCurrentInputTokens?: number;
  /** Frozen ordinary tool definitions; Provider-native compaction must use the same tool contract. */
  tools?: readonly CompressionToolDefinition[];
  /** The ordinary preview's exact references, including children allocated before request commit. */
  modelHandleCatalog?: ModelHandleCatalog;
  /** Explicit manual reconstruction of every compressed source, including old text summaries. */
  sourceReplay?: 'immutable_provenance';
  /** Manual callers may freeze an explicit prefix. Automatic text selection uses a continuous token tail. */
  compressSegmentCount?: number;
  title?: string;
}

export type CoordinateCompressionResult =
  | {
      status: 'skipped';
      reason:
        | 'disabled'
        | 'manual_only'
        | 'below_threshold'
        | 'fixed_over_policy'
        | 'finite_tail'
        | 'empty_context'
        | 'non_reducing'
        | 'native_pending_tools'
        | 'native_steering_in_flight';
      estimatedTokens?: number;
      thresholdTokens?: number;
      /** Actionable counts when the skip defers in-flight native work. */
      pendingNativeToolCalls?: number;
      pendingNativeSteeringInputs?: number;
    }
  | {
      status: 'error';
      code: ContextPlanningFailureCode;
      message: string;
      estimatedTokens: number;
      limitTokens: number;
    }
  | {
      status: 'continued_uncompressed';
      reason: 'fallbacks_exhausted_but_request_fits';
      recoveryDecision: CompressionRecoveryDecision;
      attemptedMethods: CompressionExecutionAttempt['methodKind'][];
      failures: CompressionAttemptFailure[];
      estimatedTokens: number;
      limitTokens: number;
    }
  | {
      status: 'compressed';
      trigger: CompressionTrigger;
      triggerReason: CompressionTriggerReason;
      modelRequestId: string;
      sourceRootId: string;
      sourceSegmentCount: number;
      diagnostics?: Array<'native_over_target' | 'fallback_used'>;
      attemptedMethods?: CompressionExecutionAttempt['methodKind'][];
      failures?: CompressionAttemptFailure[];
      recoveryDecision?: CompressionRecoveryDecision;
      /**
       * Explicit full-context rebase for the native path: fresh chain (forceFullReason), observable
       * cache reset, and the effective reasoning re-applied as one fresh configuration_update.
       * Present when the compacted history carried native reasoning facts.
       */
      nativeRebase?: NativeCompressionRebasePlan;
      result: CompressionCommitResult;
    };

/**
 * Durable orchestration around ContextCompressionControlPlane.
 *
 * The compression call is itself a ModelRequest, so Operation/Attempt retry, stream fencing,
 * cancellation, Host handoff and reconnect all use the same authority as ordinary model traffic.
 * Request kind/round metadata lives in the immutable recipe to remain compatible with existing
 * current-epoch databases, whose schema is intentionally non-migrating.
 */
export class ReliableContextCompressionCoordinator {
  private readonly context: ContextSequenceControlPlane;
  private readonly attachmentCatalog: AttachmentCatalogProjection;
  private readonly compression: ContextCompressionControlPlane;
  private readonly effects: EffectControlPlane;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly modelProvider: ModelProviderControlPlane,
    private readonly providers: ReliableAgentProviderRegistry,
    options: { now?: () => string } = {}
  ) {
    this.context = new ContextSequenceControlPlane(database, contentStore, options);
    this.attachmentCatalog = new AttachmentCatalogProjection(database);
    this.compression = new ContextCompressionControlPlane(database, contentStore, options);
    this.effects = new EffectControlPlane(database, contentStore, options);
  }

  public async coordinate(command: CoordinateCompressionCommand): Promise<CoordinateCompressionResult> {
    if (command.sourceReplay !== undefined
      && (command.sourceReplay !== 'immutable_provenance' || command.trigger !== 'manual')) {
      throw new TypeError('Immutable compression source reconstruction is an explicit manual operation.');
    }
    const turnId = requireId(command.turnId, 'turnId');
    const authoritySnapshotId = requireId(command.authoritySnapshotId, 'authoritySnapshotId');
    const settingsSnapshotContentObjectId = command.settingsSnapshotContentObjectId
      ?? await this.modelProvider.freezeRequestSettings(turnId, authoritySnapshotId);
    const frozen = await readRequestTurnAuthority(
      this.database,
      this.contentStore,
      authoritySnapshotId,
      turnId,
      settingsSnapshotContentObjectId
    );
    const policy = frozenCompressionPolicy(frozen.document);
    if (!policy || policy.methodKind === 'disabled') return { status: 'skipped', reason: 'disabled' };
    if (command.trigger === 'auto' && policy.triggerMode !== 'token_threshold') {
      return { status: 'skipped', reason: 'manual_only' };
    }
    if (command.trigger === 'auto' && !command.requestBudget) {
      throw new TypeError('Automatic compression requires the exact frozen ordinary request budget.');
    }

    const attemptedMethods: CompressionExecutionAttempt['methodKind'][] = [];
    const failures: CompressionAttemptFailure[] = [];
    let lastPlanningError: Extract<CoordinateCompressionResult, { status: 'error' }> | undefined;
    const groupId = `compression_group_${createHash('sha256')
      .update(JSON.stringify([turnId, command.headRootId, settingsSnapshotContentObjectId, command.sourceReplay ?? null])).digest('hex')}`;
    const attemptCommand: CoordinateCompressionCommand = { ...command, settingsSnapshotContentObjectId };
    if (command.trigger === 'auto') {
      const evaluated = await this.compression.evaluate(command.headRootId, authoritySnapshotId, settingsSnapshotContentObjectId);
      if (!evaluated.shouldCompress) return {
        status: 'skipped', reason: 'below_threshold', estimatedTokens: evaluated.estimatedTokens,
        thresholdTokens: evaluated.thresholdTokens
      };
    }

    for (let index = 0; index < policy.executionPlan.attempts.length; index += 1) {
      const attempt = policy.executionPlan.attempts[index]!;
      attemptedMethods.push(attempt.methodKind);
      let result: CoordinateCompressionResult;
      try {
        result = await this.coordinateAttempt(attemptCommand, attempt, { groupId, failures: [...failures] });
      } catch (error) {
        if (isExecutionHandoffError(error)) throw error;
        if (!(error instanceof CompressionProviderAttemptError) || !compressionAttemptMayFallback(error)) {
          throw error instanceof CompressionProviderAttemptError ? error.cause : error;
        }
        failures.push(compressionAttemptFailure(attempt.methodKind, error.cause, error.modelRequestId));
        continue;
      }

      if (result.status === 'compressed') {
        const diagnostics = new Set(result.diagnostics ?? []);
        if (failures.length > 0) diagnostics.add('fallback_used');
        return {
          ...result,
          ...(diagnostics.size > 0 ? { diagnostics: [...diagnostics] } : {}),
          attemptedMethods: [...attemptedMethods],
          recoveryDecision: { groupId, outcome: 'compressed', methodKind: attempt.methodKind, failures: [...failures] },
          ...(failures.length > 0 ? { failures: [...failures] } : {})
        };
      }

      if (result.status === 'error') {
        lastPlanningError = result;
        if (compressionPlanningErrorMayFallback(result.code)) {
          failures.push({
            methodKind: attempt.methodKind,
            code: result.code,
            message: result.message
          });
          continue;
        }
        return result;
      }

      if (result.status === 'skipped') {
        const hasFallback = index + 1 < policy.executionPlan.attempts.length;
        if (hasFallback && (result.reason === 'native_pending_tools' || result.reason === 'native_steering_in_flight')) {
          failures.push({
            methodKind: attempt.methodKind,
            code: result.reason,
            message: `Provider 原生压缩暂不可执行：${result.reason}`
          });
          continue;
        }
        if (failures.length > 0) break;
        return result;
      }

      return result;
    }

    if (command.trigger === 'auto' && policy.executionPlan.continueUncompressedIfFits && command.requestBudget) {
      const requestBudget = requireFullRequestPlanningBudget(command.requestBudget, policy.thresholdTokens);
      if (requestBudget.estimatedFullInputTokens <= requestBudget.planningInputCapacityTokens) {
        return {
          status: 'continued_uncompressed',
          reason: 'fallbacks_exhausted_but_request_fits',
          recoveryDecision: {
            groupId, outcome: 'continued_uncompressed', failures: [...failures],
            estimatedTokens: requestBudget.estimatedFullInputTokens,
            limitTokens: requestBudget.planningInputCapacityTokens
          },
          attemptedMethods,
          failures,
          estimatedTokens: requestBudget.estimatedFullInputTokens,
          limitTokens: requestBudget.planningInputCapacityTokens
        };
      }
    }
    // The last planning error alone would hide why the earlier methods failed, for example a
    // segmented summary beyond its leaf budget followed by a fallback that cannot admit the source.
    if (lastPlanningError) {
      return failures.length > 1
        ? { ...lastPlanningError, message: compressionFallbackExhaustedMessage(attemptedMethods, failures) }
        : lastPlanningError;
    }
    throw new Error(compressionFallbackExhaustedMessage(attemptedMethods, failures));
  }

  private async coordinateAttempt(
    command: CoordinateCompressionCommand,
    attempt: CompressionExecutionAttempt,
    recovery: { groupId: string; failures: CompressionAttemptFailure[] }
  ): Promise<CoordinateCompressionResult> {
    const turnId = requireId(command.turnId, 'turnId');
    const authoritySnapshotId = requireId(command.authoritySnapshotId, 'authoritySnapshotId');
    const headRootId = requireId(command.headRootId, 'headRootId');
    const trigger = requireTrigger(command.trigger);
    const settingsSnapshotContentObjectId = command.settingsSnapshotContentObjectId
      ?? await this.modelProvider.freezeRequestSettings(turnId, authoritySnapshotId);
    const frozen = await readRequestTurnAuthority(
      this.database, this.contentStore, authoritySnapshotId, turnId, settingsSnapshotContentObjectId
    );
    const basePolicy = frozenCompressionPolicy(frozen.document);
    if (!basePolicy || basePolicy.methodKind === 'disabled') return { status: 'skipped', reason: 'disabled' };
    if (!basePolicy.executionPlan.attempts.some((candidate) =>
      candidate.methodKind === attempt.methodKind && candidate.nativeKind === attempt.nativeKind
    )) {
      throw new Error(`Compression attempt ${attempt.methodKind} is not part of the frozen execution plan.`);
    }
    const policy = { ...basePolicy, methodKind: attempt.methodKind };
    if (trigger === 'auto' && policy.triggerMode !== 'token_threshold') {
      return { status: 'skipped', reason: 'manual_only' };
    }
    if (trigger === 'auto' && !command.requestBudget) {
      throw new TypeError('Automatic compression requires the exact frozen ordinary request budget.');
    }
    const requestBudget = command.requestBudget
      ? requireFullRequestPlanningBudget(command.requestBudget, policy.thresholdTokens)
      : manualRequestPlanningBudget(frozen.document, policy.thresholdTokens);
    const decision = await this.compression.evaluate(headRootId, authoritySnapshotId, settingsSnapshotContentObjectId);
    if (trigger === 'auto' && !decision.shouldCompress) {
      return {
        status: 'skipped',
        reason: 'below_threshold',
        estimatedTokens: decision.estimatedTokens,
        thresholdTokens: decision.thresholdTokens
      };
    }
    if (trigger === 'auto' && requestBudget.fixedOverPolicy) {
      return {
        status: 'skipped',
        reason: 'fixed_over_policy',
        estimatedTokens: decision.estimatedTokens,
        thresholdTokens: decision.thresholdTokens
      };
    }
    if (requestBudget.fixedTokens > requestBudget.planningInputCapacityTokens) {
      return compressionError(
        'fixed_overhead_infeasible',
        'System instructions, tool schemas and provider framing exceed the compression planning capacity.',
        requestBudget.fixedTokens,
        requestBudget.planningInputCapacityTokens
      );
    }
    const triggerReason: CompressionTriggerReason = trigger === 'manual'
      ? 'manual'
      : 'configured_threshold';
    const protectedCurrentInputTokens = command.protectedCurrentInputTokens === undefined
      ? 0
      : requireNonNegativeTokenCount(command.protectedCurrentInputTokens, 'protectedCurrentInputTokens');
    const currentInputAddendumTokens = Math.max(
      requestBudget.breakdown.currentInputTokens,
      protectedCurrentInputTokens
    );
    const irreducibleAddendaTokens = currentInputAddendumTokens
      + requestBudget.breakdown.runtimeDeliveryTokens
      + requestBudget.breakdown.turnReminderTokens;
    if (currentInputAddendumTokens > requestBudget.planningBodyRoomTokens) {
      return compressionError(
        'current_input_too_large',
        'The exact current Turn input cannot fit in the compression planning body room.',
        currentInputAddendumTokens,
        requestBudget.planningBodyRoomTokens
      );
    }
    if (irreducibleAddendaTokens > requestBudget.planningBodyRoomTokens) {
      return compressionError(
        'compressed_context_too_large',
        'Current input, runtime deliveries and the Turn reminder cannot fit even with empty compressed history.',
        irreducibleAddendaTokens,
        requestBudget.planningBodyRoomTokens
      );
    }
    // Materialize source structure/content only after the level-trigger passes. Below-threshold checks
    // are the common path and should pay for one provider-aligned Context read, not three.
    const [materialized, semanticMaterialized] = await Promise.all([
      this.context.materializeStructure(headRootId),
      this.context.materialize(headRootId)
    ]);
    if (materialized.records.length === 0) return { status: 'skipped', reason: 'empty_context' };
    if (command.sourceReplay && command.compressSegmentCount !== undefined
      && command.compressSegmentCount !== materialized.records.length) {
      throw new TypeError('Immutable compression source reconstruction requires the complete current window.');
    }
    const fullAttachmentCatalogState = await this.attachmentCatalog.projectState(
      frozen.conversationId,
      semanticMaterialized.segments.map((segment) => ({ segmentId: segment.segmentId }))
    );
    const fullAttachmentHandles = await this.modelProvider.ensureAttachmentHandles(
      frozen.conversationId,
      fullAttachmentCatalogState.catalog
    );
    const childHandles = mergeConversationChildHandles(
      await readConversationChildHandles(this.database, this.contentStore, frozen.conversationId),
      normalizeModelHandleCatalog(command.modelHandleCatalog).entries
    );
    const fullModelHandleCatalog = buildModelHandleCatalog(
      semanticMaterialized.segments.map(segment => Buffer.from(segment.content).toString('utf8')),
      [...fullAttachmentHandles.entries, ...childHandles]
    );
    if (
      policy.methodKind === 'provider_native' && attempt.nativeKind === 'openai_responses'
      && command.compressSegmentCount !== undefined
      && command.compressSegmentCount !== materialized.records.length
    ) {
      throw new CompressionProviderAttemptError(attempt.methodKind, Object.assign(
        new Error('OpenAI 原生压缩需要完整窗口；当前手动前缀改用已配置的文本后备方法。'),
        { code: 'NATIVE_FULL_WINDOW_REQUIRED', category: 'capability' }
      ));
    }
    // The level trigger already anchors this Context on a Provider prompt count. Reusing that anchor
    // as the estimator calibration keeps the retained tail sized in the same unit as the threshold
    // that selected it; without it a CJK/code Conversation keeps roughly the ratio's worth of extra
    // real Context after every compression and re-crosses the threshold within minutes.
    const calibration = decision.source === 'provider-observed-delta'
      ? providerTokenCalibration(decision.estimatedTokens, requestBudget.estimatedFullInputTokens)
      : UNCALIBRATED_PROVIDER_TOKENS;
    const rooms = calculateCalibratedCompressionRooms({
      budget: requestBudget,
      calibration,
      irreducibleAddendaTokens,
      ...(policy.config.bodyTargetTokens === undefined
        ? {}
        : { bodyTargetTokens: policy.config.bodyTargetTokens })
    });
    const effectiveSummaryMaxTokens = policy.methodKind === 'provider_native'
      ? undefined
      : calculateEffectiveSummaryMaxTokens(
          policy.config.llmSummary?.targetTokens,
          rooms.calibratedBodyTargetTokens
        );
    const textTailPlan = command.sourceReplay || policy.methodKind === 'provider_native' || command.compressSegmentCount !== undefined
      ? undefined
      : selectCompressionPrefixByTokens(
            materialized.records,
            semanticMaterialized.segments,
            calibratedTailBudgetTokens(rooms, effectiveSummaryMaxTokens ?? 0),
            fullAttachmentCatalogState,
            fullModelHandleCatalog
          );
    const hardContextRoomTokens = rooms.hardContextRoomTokens;
    if (textTailPlan?.newestGroupTokens !== undefined && textTailPlan.newestGroupTokens > hardContextRoomTokens) {
      return compressionError(
        textTailPlan.newestGroupKind === 'tool_exchange' ? 'atomic_group_too_large' : 'finite_tail_too_large',
        'The newest indivisible Context group cannot fit with the frozen request addenda.',
        textTailPlan.newestGroupTokens,
        hardContextRoomTokens
      );
    }
    const requestedSourceSegmentCount = command.sourceReplay ? materialized.records.length : policy.methodKind === 'provider_native'
      ? command.compressSegmentCount ?? materialized.records.length
      : command.compressSegmentCount === undefined
        ? textTailPlan?.sourceSegmentCount ?? 0
        : requirePrefixCount(command.compressSegmentCount, materialized.records.length);
    const plannedSourceSegmentCount = policy.methodKind === 'provider_native' && attempt.nativeKind === 'openai_responses'
      ? requestedSourceSegmentCount
      : closeToolExchangeBoundary(materialized.records, requestedSourceSegmentCount);
    if (plannedSourceSegmentCount <= 0 || plannedSourceSegmentCount > materialized.records.length) {
      return {
        status: 'skipped',
        reason: 'finite_tail',
        estimatedTokens: decision.estimatedTokens,
        thresholdTokens: decision.thresholdTokens
      };
    }
    // Native async calls admitted but not yet delivered, and in-flight steering, must never be
    // silently compacted away: the delayed result/steering message lands at the future tail and
    // would lose its call/logical-request dependency. Defer actionably or shrink the source
    // prefix so the closure stays in the retained tail.
    const nativeGuardFacts = await this.readNativeCompressionGuardFacts(frozen.conversationId);
    const nativeGuard = evaluateNativeCompressionGuard({
      fullWindowRequired: policy.methodKind === 'provider_native' && attempt.nativeKind === 'openai_responses',
      facts: nativeGuardFacts,
      orderedSegmentIds: materialized.records.map((record) => requireId(record.segment.id, 'ContextSegment.id')),
      requestedSourceSegmentCount: plannedSourceSegmentCount
    });
    if (nativeGuard.status === 'defer') {
      return {
        status: 'skipped',
        reason: nativeGuard.reason,
        estimatedTokens: decision.estimatedTokens,
        thresholdTokens: decision.thresholdTokens,
        pendingNativeToolCalls: nativeGuard.pendingToolCalls,
        pendingNativeSteeringInputs: nativeGuard.pendingSteeringInputs
      };
    }
    const sourceSegmentCount = nativeGuard.status === 'protect'
      ? closeToolExchangeBoundary(materialized.records, nativeGuard.sourceSegmentCount)
      : plannedSourceSegmentCount;
    if (command.sourceReplay && sourceSegmentCount !== materialized.records.length) {
      throw Object.assign(new Error('Immutable source reconstruction cannot leave a protected partial window; finish pending work first.'), {
        code: 'MODEL_CONTEXT_REBUILD_PARTIAL'
      });
    }
    if (sourceSegmentCount <= 0) {
      return {
        status: 'skipped',
        reason: 'native_pending_tools',
        estimatedTokens: decision.estimatedTokens,
        thresholdTokens: decision.thresholdTokens,
        pendingNativeToolCalls: nativeGuardFacts.pendingToolCalls.length,
        pendingNativeSteeringInputs: nativeGuardFacts.pendingSteeringInputs
      };
    }
    const sourceSegments = materialized.records.slice(0, sourceSegmentCount);
    const sourceAttachmentCatalogState = await this.attachmentCatalog.projectState(
      frozen.conversationId,
      semanticMaterialized.segments.slice(0, sourceSegmentCount).map((segment) => ({
        segmentId: segment.segmentId
      }))
    );
    const sourceAttachmentHandles = await this.modelProvider.ensureAttachmentHandles(
      frozen.conversationId,
      sourceAttachmentCatalogState.catalog
    );
    const attachmentObservationProfileSha256 = policy.methodKind !== 'provider_native'
      && sourceAttachmentCatalogState.catalog.length > 0
        ? attachmentObservationAnalysisProfileSha256(policy.provider)
        : undefined;
    const attachmentObservationRequirements = attachmentObservationProfileSha256
      ? await loadAttachmentObservationRequirements(
          this.database,
          this.contentStore,
          sourceAttachmentCatalogState.catalog,
          sourceAttachmentHandles,
          attachmentObservationProfileSha256
        )
      : [];
    const sourceHash = hashSource(sourceSegments);
    // OpenAI configuration_update items are transport-only: they leave the compacted window while
    // the effective effort survives in the frozen rebase plan. Anthropic signed compaction blocks
    // do not use this OpenAI-specific rebase contract.
    const nativeRebase = await this.planNativeRebase(turnId, semanticMaterialized, sourceSegmentCount);
    const idempotencyKey = [
      'context-compression', trigger, headRootId, policy.config.id,
      attempt.methodKind, attempt.nativeKind ?? 'text',
      String(sourceSegmentCount), sourceHash,
      ...(command.sourceReplay ? [command.sourceReplay] : []),
      ...(settingsSnapshotContentObjectId ? [settingsSnapshotContentObjectId] : [])
    ].join(':');
    const expectedModelRequestId = modelRequestIdFor(turnId, idempotencyKey);
    const compressionBlockId = compressionBlockIdFor(
      frozen.conversationId,
      headRootId,
      expectedModelRequestId
    );
    let request = await this.optionalDomain('ModelRequest', expectedModelRequestId);
    if (!request) {
      // An explicitly empty current tool list must not resurrect tools from an earlier model round.
      const tools = policy.methodKind !== 'provider_native' ? []
        : command.tools !== undefined ? normalizeCompressionToolDefinitions(command.tools, 'Compression command.tools')
          : await this.readLatestFrozenToolDefinitions(frozen.conversationId);
      const created = await this.modelProvider.createModelRequest({
        turnId,
        contextRootId: headRootId,
        authoritySnapshotId,
        settingsSnapshotContentObjectId,
        recipe: normalizePlainJson({
          kind: 'reliable-context-compression',
          requestKind: trigger === 'auto' ? 'context_compression_pre' : 'context_compression_manual',
          trigger,
          triggerReason,
          triggerTokens: decision.estimatedTokens,
          triggerTokenSource: decision.source,
          configuredThresholdTokens: requestBudget.compressionThresholdTokens,
          requestBreakdown: requestBudget.breakdown,
          sourceRootId: headRootId,
          sourceSegmentCount,
          sourceHash,
          ...(command.sourceReplay ? { sourceReplay: command.sourceReplay } : {}),
          blockId: compressionBlockId,
          compressionConfigId: policy.config.id,
          compressionMethodKind: policy.methodKind,
          compressionPurpose: {
            groupId: recovery.groupId, blockId: compressionBlockId, trigger,
            methodKind: policy.methodKind, priorFailures: recovery.failures
          },
          ...(policy.methodKind === 'provider_native' ? { tools } : {}),
          ...(nativeRebase ? { nativeRebase } : {}),
          attachmentCatalogState: sourceAttachmentCatalogState,
          ...(fullModelHandleCatalog.entries.length > 0
            ? { modelHandleCatalog: fullModelHandleCatalog }
            : {}),
          ...(attachmentObservationProfileSha256
            ? {
                attachmentObservationProfileSha256,
                attachmentObservationRequirements
              }
            : {}),
          ...(effectiveSummaryMaxTokens === undefined ? {} : { effectiveSummaryMaxTokens })
        }, 'Reliable compression recipe'),
        idempotencyKey
      });
      if (created.modelRequestId !== expectedModelRequestId) {
        throw new Error('Compression ModelProvider returned an unexpected stable request identity.');
      }
      request = await this.requireDomain('ModelRequest', expectedModelRequestId);
    } else {
      assertFrozenCompressionModelRequestIdentity(
        request,
        turnId,
        authoritySnapshotId,
        policy.provider.providerConfigId,
        policy.provider.modelId
      );
    }
    if (request.status !== 'terminal') {
      const providerId = requireText(request.provider_id, 'ModelRequest.provider_id');
      const adapter = await this.providers.resolve(providerId);
      assertProviderAdapter(adapter, providerId);
      try {
        await this.modelProvider.dispatch(expectedModelRequestId, adapter, { reconnect: true });
      } catch (error) {
        if (error instanceof ModelRequestPreflightError) {
          // Callers prefix the code themselves; keep it out of the message to avoid repeating it.
          const message = error.message.startsWith(`${error.code}: `)
            ? error.message.slice(error.code.length + 2)
            : error.message;
          return compressionError(error.code, message, error.estimatedTokens, error.limitTokens);
        }
        if (isExecutionHandoffError(error)) throw error;
        throw new CompressionProviderAttemptError(attempt.methodKind, error, expectedModelRequestId);
      }
      request = await this.requireDomain('ModelRequest', expectedModelRequestId);
    }
    if (request.terminal_state !== 'completed') {
      throw new CompressionProviderAttemptError(
        attempt.methodKind,
        request.stream_stats_json && typeof request.stream_stats_json === 'object'
          && !Array.isArray(request.stream_stats_json) && (request.stream_stats_json as Record<string, unknown>).failure !== undefined
          ? restoredProviderRequestFailure((request.stream_stats_json as Record<string, unknown>).failure, String(request.terminal_state))
          : Object.assign(
              new Error(`Compression ModelRequest ${expectedModelRequestId} ended as ${String(request.terminal_state)}.`),
              { terminalState: request.terminal_state, category: 'internal' }
            ),
        expectedModelRequestId
      );
    }
    const completed = await this.modelProvider.completedEvent(expectedModelRequestId);
    const compressionResult = parseCompressionResult(completed.content);
    const summary = compressionResult.contents;
    if (compressionResult.attachmentObservationProfileSha256 !== attachmentObservationProfileSha256) {
      throw new Error('Compression terminal Attachment observation profile conflicts with its frozen recipe.');
    }
    const attachmentObservations = attachmentObservationProfileSha256
      ? completeAttachmentObservationCommits(
          attachmentObservationRequirements,
          compressionResult.attachmentObservations,
          attachmentObservationProfileSha256
        )
      : [];
    if (attachmentObservationProfileSha256) {
      assertAttachmentObservationStateContent(
        summary,
        attachmentObservationRequirements,
        compressionResult.attachmentObservations ?? []
      );
    }
    const tailSegments = semanticMaterialized.segments.slice(sourceSegmentCount);
    const tailAttachmentCatalogState = await this.attachmentCatalog.projectState(
      frozen.conversationId,
      tailSegments.map((segment) => ({
        segmentId: segment.segmentId
      }))
    );
    const summarySegmentId = compressionSegmentIdFor(compressionBlockId);
    const candidateAttachmentCatalogState = rebaseAttachmentCatalogState(
      summarySegmentId,
      sourceAttachmentCatalogState.catalog,
      tailAttachmentCatalogState
    );
    const summaryContextItem = {
      segmentId: summarySegmentId,
      segmentKind: 'compression',
      messageRole: null,
      contentType: 'application/vnd.limcode.compression-contents+json',
      content: JSON.stringify({ kind: 'compression_contents', version: 1, contents: summary })
    };
    const candidateContextItems = [
      summaryContextItem,
      ...tailSegments.map((segment) => ({
        segmentId: segment.segmentId,
        segmentKind: segment.segmentKind,
        messageRole: segment.messageRole,
        contentType: segment.contentObject.content_type,
        content: segment.content.toString('utf8')
      }))
    ];
    const candidateProjection = projectStoredModelFacingWindow(
      candidateContextItems,
      candidateAttachmentCatalogState,
      fullModelHandleCatalog
    );
    const summaryProjectionTokens = projectStoredModelFacingWindow(
      [summaryContextItem],
      { catalog: [], placements: [] },
      fullModelHandleCatalog
    ).tokenCount;
    const providerInputTokens = providerPromptTokens(completed.usage);
    const providerOutputTokens = compressionOutputTokens(completed.usage);
    // The durable replacement may include locally rendered Attachment observation state that is not
    // part of Provider output accounting. Project the complete structured result instead of silently
    // undercounting that model-visible state.
    const summaryEstimatedTokens = estimateMessageContentsTokens(summary);
    const projectedTokens = summaryEstimatedTokens
      + Math.max(0, candidateProjection.tokenCount - summaryProjectionTokens);
    const projectedBodyTokens = calibrateEstimatorToProvider(
      projectedTokens + irreducibleAddendaTokens,
      calibration
    );
    if (projectedBodyTokens > rooms.calibratedPlanningBodyRoomTokens) {
      if (nativeGuardFacts.pendingToolCalls.length > 0) {
        // The protected native tail cannot shrink until the in-flight calls settle; defer the
        // compression instead of failing the Turn on its frozen addenda.
        return {
          status: 'skipped',
          reason: 'native_pending_tools',
          estimatedTokens: decision.estimatedTokens,
          thresholdTokens: decision.thresholdTokens,
          pendingNativeToolCalls: nativeGuardFacts.pendingToolCalls.length,
          pendingNativeSteeringInputs: nativeGuardFacts.pendingSteeringInputs
        };
      }
      return compressionError(
        'compressed_context_too_large',
        'The candidate compressed history plus frozen request addenda still exceeds the compression planning body room.',
        projectedBodyTokens,
        rooms.calibratedPlanningBodyRoomTokens
      );
    }
    const projectedProviderTokens = calibrateEstimatorToProvider(projectedTokens, calibration)
      + rooms.calibratedFixedTokens;
    // Only the Context changes, so compare the Context before and after in the same local estimator
    // unit. The level-trigger estimate is not a like-for-like "before": without a Provider anchor it
    // measures the Context alone, and with one it is Provider-counted, while fixed tokens here are
    // estimated. Under a small threshold the fixed overhead dominates both sides, so mixing units
    // skipped compressions that did shrink the Context.
    const currentContextTokens = estimateMaterializedContextTokens(
      semanticMaterialized.segments,
      fullAttachmentCatalogState,
      fullModelHandleCatalog
    );
    if (trigger === 'auto' && policy.methodKind !== 'provider_native' && projectedTokens >= currentContextTokens) {
      // A large protected tail can cross the threshold while the currently eligible prefix is
      // already compact.  The durable ModelRequest makes this decision exact-replayable for this
      // frozen head; treating it as a level-triggered skip keeps the primary Agent Turn alive and
      // lets a later closed prefix become compressible without an infinite same-head retry loop.
      return {
        status: 'skipped',
        reason: 'non_reducing',
        estimatedTokens: decision.estimatedTokens,
        thresholdTokens: decision.thresholdTokens
      };
    }
    const committed = await this.compression.create({
      conversationId: frozen.conversationId,
      headRootId,
      authoritySnapshotId,
      compressSegmentCount: sourceSegmentCount,
      title: command.title?.trim() || (trigger === 'auto' ? '自动上下文压缩' : '上下文压缩'),
      summary,
      ...(attachmentObservations.length > 0 ? { attachmentObservations } : {}),
      summaryMetadata: {
        trigger,
        triggerReason,
        triggerTokens: decision.estimatedTokens,
        triggerTokenSource: decision.source,
        configuredThresholdTokens: requestBudget.compressionThresholdTokens,
        // Manual compression runs outside any request: there is no full-request size to report.
        ...(command.requestBudget ? {
          requestBreakdown: requestBudget.breakdown,
          estimatedTokensBefore: requestBudget.estimatedFullInputTokens,
          calibratedTokensBefore: calibrateEstimatorToProvider(
            requestBudget.estimatedFullInputTokens,
            calibration
          )
        } : {}),
        contextTokensBefore: currentContextTokens,
        estimatedTokensAfter: projectedTokens,
        providerCalibrationRatio: calibration.ratio,
        calibratedTokensAfter: projectedProviderTokens,
        ...(providerInputTokens === undefined ? {} : { providerInputTokens }),
        ...(providerOutputTokens === undefined ? {} : { providerOutputTokens }),
        methodKind: policy.methodKind,
        estimatedTokens: summaryEstimatedTokens,
        ...(policy.methodKind === 'provider_native'
          ? { nativeBinding: policy.provider }
          : {}),
        ...(nativeRebase
          ? {
              nativeRebase: {
                cacheReset: true as const,
                droppedConfigurationUpdates: nativeRebase.droppedConfigurationUpdates,
                ...(nativeRebase.effectiveReasoning === undefined
                  ? {}
                  : { effectiveEffort: nativeRebase.effectiveReasoning.effort })
              }
            }
          : {})
      },
      projectedEstimatedTokens: projectedTokens,
      idempotencyKey: expectedModelRequestId
    });
    return {
      status: 'compressed',
      trigger,
      triggerReason,
      modelRequestId: expectedModelRequestId,
      sourceRootId: headRootId,
      sourceSegmentCount,
      ...(policy.methodKind === 'provider_native'
        && calibrateEstimatorToProvider(projectedTokens, calibration) > rooms.calibratedBodyTargetTokens
        ? { diagnostics: ['native_over_target' as const] }
        : {}),
      ...(nativeRebase ? { nativeRebase } : {}),
      result: committed
    };
  }

  /** Backend entry for the command router; all root/authority facts are resolved server-side. */
  public async manualCurrentTurn(input: {
    turnId: string;
    compressSegmentCount?: number;
    title?: string;
  }): Promise<CoordinateCompressionResult> {
    const turnId = requireId(input.turnId, 'turnId');
    const turn = await this.requireDomain('Turn', turnId);
    if (turn.status !== 'active') {
      throw new Error(`Manual provider compression requires an active Turn; ${turnId} is ${String(turn.status)}.`);
    }
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').list({ where: { turn_id: turnId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').list({
        where: { conversation_id: conversationId }, limit: 2
      })
    ]);
    const authorities = rows(snapshot.snapshot[0]);
    const heads = rows(snapshot.snapshot[1]);
    if (authorities.length !== 1 || heads.length !== 1) {
      throw new Error(`Manual compression requires one frozen authority and one current head for Turn ${turnId}.`);
    }
    return this.coordinate({
      turnId,
      authoritySnapshotId: requireId(authorities[0].id, 'AuthoritySnapshot.id'),
      headRootId: requireId(heads[0].root_id, 'ConversationContextHeadLink.root_id'),
      trigger: 'manual',
      ...(input.compressSegmentCount === undefined ? {} : { compressSegmentCount: input.compressSegmentCount }),
      ...(input.title?.trim() ? { title: input.title.trim() } : {})
    });
  }

  /**
   * Read-only native guard facts. Pending async work comes from the tool slice's durable
   * admission/delivery domains; in-flight steering comes from the kernel-owned steering reader.
   * Only calls fully closed in the Context are historical; terminal-Turn leftovers with an
   * unsettled result or a missing result occurrence still block.
   */
  private async readNativeCompressionGuardFacts(conversationId: string): Promise<NativeCompressionGuardFacts> {
    const [pendingWork, inFlightSteering] = await Promise.all([
      this.effects.listNativePendingWork({ conversationId }),
      readNativeSteeringInFlight(this.database, conversationId)
    ]);
    const pendingToolCalls = selectBlockingNativePendingCalls(
      pendingWork.map((call) => ({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        turnId: call.turnId,
        ...(call.providerCallId === undefined ? {} : { providerCallId: call.providerCallId }),
        ...(call.callContextSegmentId === undefined ? {} : { callContextSegmentId: call.callContextSegmentId }),
        ...(call.resultContextSegmentId === undefined ? {} : { resultContextSegmentId: call.resultContextSegmentId }),
        settled: call.settled === true,
        delivered: call.delivered === true
      }))
    );
    return { pendingToolCalls, pendingSteeringInputs: inFlightSteering.length };
  }

  /**
   * Builds the explicit native rebase plan for a committed compression. Update facts are scanned
   * from the durable stored window (source slice drops, retained tail survives); the effective
   * effort prefers the kernel-frozen recipe facts so recovery replays the same selection.
   */
  private async planNativeRebase(
    turnId: string,
    semanticMaterialized: MaterializedContext,
    sourceSegmentCount: number
  ): Promise<NativeCompressionRebasePlan | undefined> {
    const storedItems = (segments: MaterializedContextSegment[]) => segments.map((segment) => ({
      segmentId: segment.segmentId,
      segmentKind: segment.segmentKind,
      messageRole: segment.messageRole,
      contentType: segment.contentObject.content_type,
      content: segment.content.toString('utf8')
    }));
    const updates = collectStoredNativeConfigurationUpdates(storedItems(
      semanticMaterialized.segments.slice(0, sourceSegmentCount)
    ));
    const retainedUpdates = collectStoredNativeConfigurationUpdates(storedItems(
      semanticMaterialized.segments.slice(sourceSegmentCount)
    ));
    const frozenNativeReasoning = await this.readLatestFrozenNativeReasoning(turnId);
    return planNativeCompressionRebase({
      nativeEnabled: frozenNativeReasoning !== undefined || updates.length > 0 || retainedUpdates.length > 0,
      updates,
      retainedUpdates,
      ...(frozenNativeReasoning?.effectiveEffort === undefined
        ? {}
        : { frozenEffectiveEffort: frozenNativeReasoning.effectiveEffort })
    });
  }

  /**
   * Manual compression runs in a maintenance Turn and therefore has no ordinary request recipe of
   * its own. Reuse the newest ordinary recipe from the same Conversation so Anthropic on-demand
   * compaction receives the same frozen tool contract as the history it is summarizing. Automatic
   * callers pass the current definitions directly and never enter this lookup.
   */
  private readLatestFrozenToolDefinitions(conversationId: string): Promise<CompressionToolDefinition[]> {
    return readLatestFrozenCompressionTools(this.database, this.contentStore, conversationId);
  }

  /**
   * Reads the kernel-frozen native reasoning facts from the latest ordinary ModelRequest recipe of
   * the Turn. Compression recipes are skipped; an ordinary recipe without nativeReasoning means the
   * Turn is not on the native reasoning path. Update-selected effort is the only value a fresh
   * configuration_update may carry, so it is returned only when frozen updates exist.
   */
  private async readLatestFrozenNativeReasoning(turnId: string): Promise<{ effectiveEffort?: string } | undefined> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ModelRequest').list({
        where: { turn_id: turnId },
        orderBy: { column: 'request_seq', direction: 'desc' },
        limit: 8
      })
    ]);
    for (const request of rows(snapshot.snapshot[0])) {
      const recipeRow = await this.optionalDomain(
        'ContentObject',
        requireId(request.recipe_object_id, 'ModelRequest.recipe_object_id')
      );
      if (!recipeRow) continue;
      const recipe = requireRecord(
        normalizePlainJson(
          JSON.parse((await this.contentStore.read(asContentObjectMetadata(recipeRow))).toString('utf8')),
          'ModelRequest recipe'
        ),
        'ModelRequest recipe'
      );
      if (recipe.kind === 'reliable-context-compression') continue;
      if (recipe.nativeReasoning === undefined) return undefined;
      const nativeReasoning = requireRecord(recipe.nativeReasoning, 'ModelRequest recipe nativeReasoning');
      const updates = Array.isArray(nativeReasoning.updates) ? nativeReasoning.updates : [];
      if (updates.length === 0) return {};
      const direct = typeof nativeReasoning.effectiveEffort === 'string' && nativeReasoning.effectiveEffort.trim()
        ? nativeReasoning.effectiveEffort.trim()
        : undefined;
      const fromUpdates = updates
        .map((update) => {
          if (!update || typeof update !== 'object' || Array.isArray(update) || !('effort' in update)) {
            return undefined;
          }
          return typeof update.effort === 'string' && update.effort.trim() ? update.effort.trim() : undefined;
        })
        .filter((effort): effort is string => effort !== undefined)
        .pop();
      const effectiveEffort = direct ?? fromUpdates;
      return effectiveEffort === undefined ? {} : { effectiveEffort };
    }
    return undefined;
  }

  private async optionalDomain(domain: string, id: string): Promise<DomainRow | undefined> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    if (Array.isArray(row)) throw new Error(`${domain} ${id} lookup returned a list.`);
    return row ?? undefined;
  }

  private async requireDomain(domain: string, id: string): Promise<DomainRow> {
    const row = await this.optionalDomain(domain, id);
    if (!row) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }
}

class CompressionProviderAttemptError extends Error {
  public constructor(
    public readonly methodKind: CompressionExecutionAttempt['methodKind'],
    public readonly cause: unknown,
    public readonly modelRequestId?: string
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'CompressionProviderAttemptError';
  }
}

function compressionAttemptMayFallback(error: CompressionProviderAttemptError): boolean {
  const source = error.cause as { code?: unknown; category?: unknown; name?: unknown; status?: unknown; terminalState?: unknown; retryable?: unknown } | undefined;
  if (source?.code === 'EXECUTION_HANDOFF' || source?.name === 'AbortError'
    || source?.category === 'internal' || source?.category === 'cancelled'
    || source?.status === 401 || source?.status === 403
    || error.cause instanceof TypeError
    || typeof source?.code === 'string' && /^(SQLITE|RUNTIME|MODEL_|CONTENT_)/.test(source.code)) return false;
  const terminalState = typeof source?.terminalState === 'string' ? source.terminalState.toLowerCase() : '';
  const text = `${error.message}\n${terminalState}`.toLowerCase();
  return !(
    terminalState.includes('cancel')
    || terminalState.includes('interrupt')
    || text.includes('aborterror')
    || text.includes('cancelled')
    || text.includes('canceled')
    || text.includes('interrupted')
    || text.includes('execution handoff')
    || /invalid_api_key|authentication_error|permission_denied|insufficient_quota|billing_hard_limit|unauthorized|forbidden/.test(text)
  );
}

function compressionAttemptFailure(
  methodKind: CompressionExecutionAttempt['methodKind'],
  error: unknown,
  modelRequestId?: string
): CompressionAttemptFailure {
  const record = error && typeof error === 'object' && !Array.isArray(error)
    ? error as { code?: unknown; status?: unknown; message?: unknown }
    : undefined;
  return {
    methodKind,
    message: safeProviderFailureMessage(error instanceof Error ? error.message
      : typeof record?.message === 'string' ? record.message : String(error)),
    ...(modelRequestId ? { modelRequestId } : {}),
    ...(typeof record?.code === 'string' ? { code: record.code } : {}),
    ...(typeof record?.status === 'number' && Number.isInteger(record.status)
      ? { status: record.status }
      : {})
  };
}

function compressionPlanningErrorMayFallback(code: ContextPlanningFailureCode): boolean {
  return code === 'compression_request_too_large'
    || code === 'compressed_context_too_large'
    || code === 'finite_tail_too_large'
    || code === 'atomic_group_too_large';
}

function compressionFallbackExhaustedMessage(
  attemptedMethods: readonly CompressionExecutionAttempt['methodKind'][],
  failures: readonly CompressionAttemptFailure[]
): string {
  const attempted = attemptedMethods.length > 0 ? attemptedMethods.join(' → ') : '无可执行方法';
  const detail = failures.length > 0
    ? failures.map((failure) => {
      const code = failure.code && !failure.message.includes(failure.code) ? `${failure.code}: ` : '';
      return `${failure.methodKind}: ${code}${failure.message}`;
    }).join('；')
    : '没有可用的压缩结果。';
  return `上下文压缩后备链已耗尽（${attempted}）：${detail}`;
}

function assertFrozenCompressionModelRequestIdentity(
  request: DomainRow,
  turnId: string,
  authoritySnapshotId: string,
  providerId: string,
  modelId: string
): void {
  if (request.turn_id !== turnId
    || request.authority_snapshot_id !== authoritySnapshotId
    || request.provider_id !== providerId
    || request.model_id !== modelId) {
    throw new Error('Existing compression ModelRequest conflicts with the frozen request identity.');
  }
}

function selectCompressionPrefixByTokens(
  records: readonly StructuralContextRecord[],
  segments: ReadonlyArray<{
    segmentId: string;
    segmentKind: string;
    messageRole: string | null;
    contentObject: { content_type: string };
    content: Buffer;
  }>,
  tailBudgetTokens: number,
  attachmentCatalogState: AttachmentCatalogState,
  modelHandleCatalog: ModelHandleCatalog
): {
  sourceSegmentCount: number;
  newestGroupTokens?: number;
  newestGroupKind?: AtomicContextGroup<number>['kind'];
} {
  if (records.length !== segments.length) {
    throw new Error('Structural and semantic Context materializations disagree on segment count.');
  }
  const groups: AtomicContextGroup<number>[] = [];
  for (let index = 0; index < records.length;) {
    const start = index;
    const items = [index];
    index += 1;
    if (records[start].segment.segment_kind === 'message') {
      while (index < records.length && records[index].segment.segment_kind === 'tool_pair') {
        items.push(index);
        index += 1;
      }
    }
    const functionResponseCount = items.filter((position) =>
      records[position].segment.segment_kind === 'tool_pair'
    ).length;
    const segmentIds = items.map((position) => segments[position].segmentId);
    const groupAttachmentState = selectAttachmentCatalogStateSegments(
      attachmentCatalogState,
      segmentIds
    );
    groups.push({
      kind: functionResponseCount > 0 ? 'tool_exchange' : 'message',
      items,
      startIndex: start,
      endIndexExclusive: index,
      estimatedTokens: projectStoredModelFacingWindow(items.map((position) => ({
        segmentId: segments[position].segmentId,
        segmentKind: segments[position].segmentKind,
        messageRole: segments[position].messageRole,
        contentType: segments[position].contentObject.content_type,
        content: segments[position].content.toString('utf8')
      })), groupAttachmentState, modelHandleCatalog).tokenCount,
      functionCallCount: functionResponseCount > 0 ? 1 : 0,
      functionResponseCount,
      complete: true
    });
  }
  const selected = selectContinuousAtomicTail(groups, tailBudgetTokens);
  const newest = selected.tailGroups[selected.tailGroups.length - 1];
  return {
    sourceSegmentCount: selected.prefixItems.length,
    ...(newest ? { newestGroupTokens: newest.estimatedTokens, newestGroupKind: newest.kind } : {})
  };
}

/**
 * Tool definitions of the latest ordinary ModelRequest of a Conversation, which Provider-native
 * compaction must resend unchanged. Read-only.
 */
export async function readLatestFrozenCompressionTools(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  conversationIdInput: string
): Promise<CompressionToolDefinition[]> {
  const conversationId = requireId(conversationIdInput, 'conversationId');
  const turns = (await listAllDomainRows(database, 'Turn', { conversation_id: conversationId }))
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))
      || String(right.id).localeCompare(String(left.id)));
  for (const turn of turns) {
    const turnId = requireId(turn.id, 'Turn.id');
    const requests = (await listAllDomainRows(database, 'ModelRequest', { turn_id: turnId }))
      .sort((left, right) => compareBigIntDescending(left.request_seq, right.request_seq)
        || String(right.id).localeCompare(String(left.id)));
    for (const request of requests) {
      const recipeRead = await database.snapshot([DOMAIN_REPOSITORIES.domain('ContentObject').get(
        requireId(request.recipe_object_id, 'ModelRequest.recipe_object_id')
      )]);
      const recipeRow = recipeRead.snapshot[0];
      if (Array.isArray(recipeRow)) throw new Error('ContentObject lookup returned a list.');
      if (!recipeRow) continue;
      const recipe = requireRecord(
        normalizePlainJson(
          JSON.parse((await contentStore.read(asContentObjectMetadata(recipeRow))).toString('utf8')),
          'ModelRequest recipe'
        ),
        'ModelRequest recipe'
      );
      if (recipe.kind !== 'reliable-agent-turn') continue;
      return normalizeCompressionToolDefinitions(recipe.tools, 'ModelRequest recipe.tools');
    }
  }
  return [];
}

/** Budget of the maintenance Turn a manual compression runs in; it has no ordinary request of its own. */
export function manualRequestPlanningBudget(
  document: PlainJsonValue,
  thresholdTokens: number
): FullRequestPlanningBudget {
  const profile = frozenContextProfile(document);
  return calculateFullRequestPlanningBudget({
    contextWindowTokens: profile.contextWindowTokens,
    compressionThresholdTokens: thresholdTokens,
    breakdown: emptyRequestBreakdown()
  });
}

function emptyRequestBreakdown(): FullRequestPlanningBudget['breakdown'] {
  return {
    systemTokens: 0,
    toolSchemaTokens: 0,
    providerFramingTokens: 0,
    contextTokens: 0,
    currentInputTokens: 0,
    runtimeDeliveryTokens: 0,
    turnReminderTokens: 0,
    mediaTokens: 0,
    fixedTokens: 0,
    bodyTokens: 0,
    fullTokens: 0
  };
}

function requireFullRequestPlanningBudget(
  value: FullRequestPlanningBudget,
  expectedThresholdTokens: number
): FullRequestPlanningBudget {
  if (!value || typeof value !== 'object') throw new TypeError('requestBudget must be an object.');
  const integerFields: Array<keyof FullRequestPlanningBudget> = [
    'contextWindowTokens',
    'compressionThresholdTokens',
    'outputReserveTokens',
    'planningInputCapacityTokens',
    'fixedTokens',
    'bodyTokens',
    'estimatedFullInputTokens',
    'planningBodyRoomTokens',
    'policyBodyRoomTokens',
    'effectiveBodyTargetTokens'
  ];
  for (const field of integerFields) {
    const candidate = value[field];
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
      throw new TypeError(`requestBudget.${field} must be a non-negative safe integer.`);
    }
  }
  if (value.compressionThresholdTokens !== expectedThresholdTokens) {
    throw new Error('requestBudget compression threshold does not match frozen compression authority.');
  }
  if (value.estimatedFullInputTokens !== value.fixedTokens + value.bodyTokens) {
    throw new Error('requestBudget full input total is inconsistent.');
  }
  if (typeof value.fixedOverPolicy !== 'boolean') {
    throw new TypeError('requestBudget.fixedOverPolicy must be boolean.');
  }
  return value;
}

function compressionError(
  code: ContextPlanningFailureCode,
  message: string,
  estimatedTokens: number,
  limitTokens: number
): Extract<CoordinateCompressionResult, { status: 'error' }> {
  return { status: 'error', code, message, estimatedTokens, limitTokens };
}

function closeToolExchangeBoundary(records: readonly StructuralContextRecord[], requestedCount: number): number {
  let count = requestedCount;
  // A tool_pair carries the response to the function call frozen in the immediately preceding
  // model Message. If the requested cut lands between them, move the whole exchange into tail.
  while (count > 0 && records[count]?.segment.segment_kind === 'tool_pair') count -= 1;
  return count;
}

interface ParsedCompressionResult {
  contents: MessageContent[];
  attachmentObservationProfileSha256?: string;
  attachmentObservations?: PlainJsonValue[];
}

function parseCompressionResult(value: PlainJsonValue): ParsedCompressionResult {
  const record = requireRecord(value, 'Compression terminal content');
  if (record.type !== 'compression_result' || !Array.isArray(record.contents) || record.contents.length === 0) {
    throw new TypeError('Compression terminal checkpoint does not contain MessageContent[].');
  }
  const contents = record.contents.map((entry, index) => {
    const content = requireRecord(entry, `Compression terminal content[${index}]`);
    if ((content.role !== 'user' && content.role !== 'model') || !Array.isArray(content.parts)) {
      throw new TypeError(`Compression terminal MessageContent ${index} is invalid.`);
    }
    return content as unknown as MessageContent;
  });
  const rawProfile = record.attachmentObservationProfileSha256;
  const rawObservations = record.attachmentObservations;
  if ((rawProfile === undefined) !== (rawObservations === undefined)) {
    throw new TypeError('Compression terminal Attachment observation contract is incomplete.');
  }
  const attachmentObservationProfileSha256 = rawProfile === undefined
    ? undefined
    : requireSha256(rawProfile, 'Compression terminal attachmentObservationProfileSha256');
  const attachmentObservations = rawObservations === undefined
    ? undefined
    : Array.isArray(rawObservations)
      ? rawObservations
      : (() => { throw new TypeError('Compression terminal attachmentObservations must be an array.'); })();
  return {
    contents,
    ...(attachmentObservationProfileSha256 ? { attachmentObservationProfileSha256, attachmentObservations } : {})
  };
}

function normalizeCompressionToolDefinitions(
  value: unknown,
  label: string
): CompressionToolDefinition[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value.map((entry, index) => {
    const normalized = normalizePlainJson(entry, `${label}[${index}]`);
    const record = requireRecord(normalized, `${label}[${index}]`);
    const description = typeof record.description === 'string' ? record.description : '';
    const parameters = normalizePlainJson(record.parameters ?? {}, `${label}[${index}].parameters`);
    return {
      name: requireText(record.name, `${label}[${index}].name`),
      description,
      parameters,
      ...(record.source === undefined
        ? {}
        : { source: normalizePlainJson(record.source, `${label}[${index}].source`) }),
      ...(record.metadata === undefined
        ? {}
        : { metadata: normalizePlainJson(record.metadata, `${label}[${index}].metadata`) }),
      ...(record.defaultConfig === undefined
        ? {}
        : { defaultConfig: normalizePlainJson(record.defaultConfig, `${label}[${index}].defaultConfig`) })
    };
  });
}

function compareBigIntDescending(left: unknown, right: unknown): number {
  const leftValue = BigInt(String(left ?? 0));
  const rightValue = BigInt(String(right ?? 0));
  return leftValue > rightValue ? -1 : leftValue < rightValue ? 1 : 0;
}

function hashSource(records: readonly StructuralContextRecord[]): string {
  return createHash('sha256').update(JSON.stringify(records.map((record) => ({
    segmentId: record.segment.id,
    contentObjectId: record.segment.content_object_id,
    segmentKind: record.segment.segment_kind
  })))).digest('hex');
}

function assertProviderAdapter(adapter: FullRequestProviderAdapter, providerId: string): void {
  if (!adapter || adapter.providerId !== providerId || typeof adapter.sendFullRequest !== 'function') {
    throw new Error(`Provider registry returned an invalid adapter for ${providerId}.`);
  }
}

function requirePrefixCount(value: number, total: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > total) {
    throw new RangeError(`Compression prefix must be from 1 to ${Math.max(1, total)}.`);
  }
  return value;
}

function requireNonNegativeTokenCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requireRecord(value: PlainJsonValue, label: string): { [key: string]: PlainJsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function asContentObjectMetadata(row: DomainRow): ContentObjectMetadata {
  return row as ContentObjectMetadata;
}

function requireSha256(value: unknown, label: string): string {
  const text = requireText(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new TypeError(`${label} must be a SHA-256 hex digest.`);
  return text;
}

function requireTrigger(value: unknown): CompressionTrigger {
  if (value !== 'auto' && value !== 'manual') throw new TypeError('Compression trigger must be auto or manual.');
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function rows(value: DomainRow | DomainRow[] | null): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError('Repository list did not return rows.');
  return value;
}
