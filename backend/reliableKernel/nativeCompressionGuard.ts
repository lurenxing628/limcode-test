import type { NativeConfigurationUpdateFact } from './modelFacingContextProjection';

/**
 * Pending native work that compression must never silently drop. Facts are read-only views over the
 * tool/turn domains owned by the tool and kernel slices; this module only evaluates them.
 */
export interface NativePendingToolCallFact {
  toolCallId: string;
  toolName: string;
  turnId: string;
  providerCallId?: string;
  /** Segment carrying the admitted tool_call occurrence; undefined until the append commits. */
  callContextSegmentId?: string;
  resultContextSegmentId?: string;
  /** ToolModelResult exists. */
  settled: boolean;
  /** native_delivery fact exists (the result already reached the provider chain). */
  delivered: boolean;
}

export interface NativeCompressionGuardFacts {
  /** In-flight pending calls selected by selectBlockingNativePendingCalls. */
  pendingToolCalls: readonly NativePendingToolCallFact[];
  /** In-flight native steering receipts from the kernel-owned steering reader. */
  pendingSteeringInputs: number;
}

/**
 * A pending native call stops blocking compaction only when it is fully closed in the Context:
 * ToolModelResult settled AND its result occurrence appended. Everything else keeps blocking —
 * an unsettled call or a missing result occurrence can still complete later through late effect
 * receipts or the no-lease terminal closure branch, even after its Turn ended, and compacting
 * its call occurrence first would split the exchange irreversibly. A terminal Turn alone never
 * proves closure; a fully closed call never blocks regardless of its delivery receipt.
 */
export function selectBlockingNativePendingCalls(
  pendingToolCalls: readonly NativePendingToolCallFact[]
): NativePendingToolCallFact[] {
  return pendingToolCalls.filter((call) =>
    !(call.settled && call.resultContextSegmentId !== undefined)
  );
}

export interface NativeLogicalRequestBudget {
  /** Exact frozen full-request planning capacity (context window minus output reserve). */
  planningInputCapacityTokens: number;
  /** Frozen user threshold; relevant only if automatic compression is actually enabled. */
  compressionThresholdTokens: number;
  autoCompressionEnabled: boolean;
}

/**
 * A logical native request can contain many physical responses, but each completed response's
 * input_tokens counts only THAT physical prompt. Never add response usages together: their sum is
 * billing, not context occupancy. The headroom is deliberately conservative because the next
 * response may add tool output and model text before the next safe boundary.
 */
export function nativePhysicalResponseBudgetPressure(input: {
  budget: NativeLogicalRequestBudget;
  physicalInputTokens?: number;
  physicalResponseCount: number;
}): boolean {
  const { budget, physicalInputTokens, physicalResponseCount } = input;
  if (!Number.isSafeInteger(budget.planningInputCapacityTokens) || budget.planningInputCapacityTokens < 0
    || !Number.isSafeInteger(budget.compressionThresholdTokens) || budget.compressionThresholdTokens <= 0
    || !Number.isSafeInteger(physicalResponseCount) || physicalResponseCount < 0) {
    throw new TypeError('Native physical response budget contains invalid token counts.');
  }
  if (physicalInputTokens !== undefined
    && (!Number.isSafeInteger(physicalInputTokens) || physicalInputTokens < 0)) {
    throw new TypeError('Native physical response input must be a non-negative safe integer.');
  }
  // An unknown usage is not zero and is never used to assert that another physical create fits.
  if (physicalInputTokens === undefined) return true;
  if (physicalResponseCount >= 8) return true;
  const headroom = Math.min(2048, Math.max(256, Math.ceil(budget.planningInputCapacityTokens / 10)));
  const capacityBoundary = Math.max(0, budget.planningInputCapacityTokens - headroom);
  const boundary = budget.autoCompressionEnabled
    ? Math.min(capacityBoundary, budget.compressionThresholdTokens)
    : capacityBoundary;
  return physicalInputTokens >= boundary;
}

export class NativeSafetyWaitError extends Error {
  public readonly code = 'NATIVE_SAFETY_WAIT';

  public constructor(public readonly toolCallId: string) {
    super(`Native result admission is unverified while tool ${toolCallId} is still running. Preserve the admitted external effect and wait for its durable terminal result before a safe refusal.`);
    this.name = 'NativeSafetyWaitError';
  }
}

export class NativeRequestBudgetError extends Error {
  public readonly code = 'NATIVE_CONTEXT_BUDGET_EXHAUSTED';

  public constructor(observedInputTokens: number, capacityTokens: number) {
    super(`NATIVE_CONTEXT_BUDGET_EXHAUSTED: The latest physical native response used ${observedInputTokens} input tokens near the ${capacityTokens}-token planning capacity, but full-request preflight did not produce a safely sized compacted request. Automatic compression remains under the user's frozen policy; reduce the context or enable automatic compression before continuing.`);
    this.name = 'NativeRequestBudgetError';
  }
}

export type NativeCompressionGuardDecision =
  | { status: 'allow' }
  | {
      status: 'protect';
      /** Shrunk compression source prefix that keeps every pending call/result closure in the tail. */
      sourceSegmentCount: number;
      protectedPendingToolCalls: number;
    }
  | {
      status: 'defer';
      reason: 'native_pending_tools' | 'native_steering_in_flight';
      pendingToolCalls: number;
      pendingSteeringInputs: number;
    };

/**
 * Compaction guard for native async work. A pending call's result is delivered later at the tail,
 * so a compression prefix that contains the call occurrence would split the exchange and lose the
 * call/result identity. Full-window native compact cannot protect a prefix at all and must defer.
 */
export function evaluateNativeCompressionGuard(input: {
  /** provider_native requires the complete model-visible window. */
  fullWindowRequired: boolean;
  facts: NativeCompressionGuardFacts;
  orderedSegmentIds: readonly string[];
  requestedSourceSegmentCount: number;
}): NativeCompressionGuardDecision {
  const pendingToolCalls = input.facts.pendingToolCalls.length;
  const pendingSteeringInputs = input.facts.pendingSteeringInputs;
  if (pendingSteeringInputs > 0) {
    // An in-flight steering still owes the Context its message and may continue the logical
    // native request; compressing now would force a fresh chain across that continuation.
    return { status: 'defer', reason: 'native_steering_in_flight', pendingToolCalls, pendingSteeringInputs };
  }
  if (pendingToolCalls === 0) return { status: 'allow' };
  if (input.fullWindowRequired) {
    return { status: 'defer', reason: 'native_pending_tools', pendingToolCalls, pendingSteeringInputs };
  }
  const positions = new Map(input.orderedSegmentIds.map((segmentId, index) => [segmentId, index]));
  let oldestPendingIndex = Number.POSITIVE_INFINITY;
  for (const call of input.facts.pendingToolCalls) {
    const segmentId = call.callContextSegmentId ?? call.resultContextSegmentId;
    if (!segmentId) {
      // Admitted but not appended yet: its position cannot be proven. Defer conservatively.
      return { status: 'defer', reason: 'native_pending_tools', pendingToolCalls, pendingSteeringInputs };
    }
    const index = positions.get(segmentId);
    if (index === undefined) {
      // Not in this frozen window: this prefix cannot split it, and its delayed result always
      // lands after the new head. A head change mid-read fails the commit head assertion instead.
      continue;
    }
    if (index < oldestPendingIndex) oldestPendingIndex = index;
  }
  if (oldestPendingIndex === Number.POSITIVE_INFINITY) return { status: 'allow' };
  const sourceSegmentCount = Math.min(input.requestedSourceSegmentCount, oldestPendingIndex);
  if (sourceSegmentCount <= 0) {
    return { status: 'defer', reason: 'native_pending_tools', pendingToolCalls, pendingSteeringInputs };
  }
  if (sourceSegmentCount === input.requestedSourceSegmentCount) return { status: 'allow' };
  return { status: 'protect', sourceSegmentCount, protectedPendingToolCalls: pendingToolCalls };
}

/**
 * Explicit full-context rebase after a compaction on the native path. The cache/continuation chain
 * is connection-local and never an authority, so it may be reset here; the reset stays observable
 * through the kernel native_control checkpoint and the returned plan. Transport-only update history
 * is dropped from the compacted window while the effective reasoning effort is preserved and
 * re-applied as one fresh configuration_update before the next user message (no adjacent updates).
 */
export interface NativeCompressionRebasePlan {
  kind: 'native_full_rebase';
  /** Value for the transport stream option continuation.forceFullReason. */
  forceFullReason: 'compression';
  cacheReset: true;
  /** configuration_update items excluded from the compacted window, in chronological count. */
  droppedConfigurationUpdates: number;
  effectiveReasoning?: { effort: string };
  /** Fresh update to place before the next user message; present only when updates were in use. */
  freshConfigurationUpdate?: { effort: string };
}

export function planNativeCompressionRebase(input: {
  nativeEnabled: boolean;
  /** configuration_update items dropped from the compacted window, in chronological order. */
  updates: readonly NativeConfigurationUpdateFact[];
  /** configuration_update items still present in the retained tail, in chronological order. */
  retainedUpdates?: readonly NativeConfigurationUpdateFact[];
  /** Effective effort frozen in the latest ordinary request recipe, when one exists. */
  frozenEffectiveEffort?: string;
}): NativeCompressionRebasePlan | undefined {
  if (!input.nativeEnabled) return undefined;
  const retainedUpdates = input.retainedUpdates ?? [];
  let effectiveEffort = input.frozenEffectiveEffort;
  if (effectiveEffort === undefined) {
    for (const update of [...input.updates, ...retainedUpdates]) {
      if (update.effort !== undefined) effectiveEffort = update.effort;
    }
  }
  // A fresh update is required only when the retained tail no longer carries the selection;
  // emitting one beside a surviving tail update would create the rejected adjacent pair.
  const freshConfigurationUpdate = retainedUpdates.length === 0 && effectiveEffort !== undefined
    ? { effort: effectiveEffort }
    : undefined;
  return {
    kind: 'native_full_rebase',
    forceFullReason: 'compression',
    cacheReset: true,
    droppedConfigurationUpdates: input.updates.length,
    ...(effectiveEffort === undefined ? {} : { effectiveReasoning: { effort: effectiveEffort } }),
    ...(freshConfigurationUpdate ? { freshConfigurationUpdate } : {})
  };
}
