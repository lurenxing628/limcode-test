import type { RELOCATED_WORK_LISTS } from './relocatedWorkInventory';

export interface RelocatedWorkSettlementCounts {
  /** Top-level Turns stopped (recorded as interrupted; an orphan one as cancelled). */
  turnsStopped: number;
  /** Child Agent Turns stopped through their subtree. */
  childTurnsStopped: number;
  /** Child executions interrupted, each with its whole subtree. */
  childExecutionsInterrupted: number;
  /** Background child Agents of a completed parent Turn, stopped like from their own panel (they go idle). */
  backgroundChildrenStopped: number;
  /** Queued user messages cancelled. */
  queuedMessagesCancelled: number;
  /** Pending child continuations cancelled with their subtree. */
  childContinuationsCancelled: number;
  /** Questions and approvals that waited for the user, cancelled with their Turn. */
  interactionsCancelled: number;
  /** Model requests that never started, closed with their Turn. */
  modelRequestsClosed: number;
  /** Tool effects not dispatched yet, cancelled with their Turn. */
  effectsCancelled: number;
  /** Tool effects dispatched by a window that is gone, closed as outcome_unknown. */
  effectsClosedAsUnknown: number;
  /** Results already addressed to a stopped Turn, kept in its history instead of continuing it. */
  deliveriesTakenIn: number;
  /** Queued continuations that are not ordinary user messages (a retry, a runtime continuation), cancelled. */
  queuedIntentsCancelled: number;
  /** Pending results (a child answer, a process completion, a collaboration message) failed as not delivered here. */
  deliveriesAbandoned: number;
  /** Child answers nobody routed yet, given an already failed delivery. */
  answersAbandoned: number;
  /** Finished background processes whose completion notice is dead-lettered instead of delivered. */
  processCompletionsAbandoned: number;
}

export type RelocatedWorkUnsettledKind =
  /** A Turn the stop path does not close here (child spawn or cancel in flight, inconsistent facts). */
  | 'needs_human'
  /** Settling this item threw; `detail` has the error. */
  | 'failed'
  /**
   * Still new executable work after the policy's round limit (each round's settlement created
   * more, for example requesters told that nobody will answer): not settled further this time.
   */
  | 'rounds_exhausted';

/**
 * What an item is: the inventory list its id belongs to (`pendingProcessCompletionIds` holds dispatch
 * ids), `otherRuntimeWork` (the pending-work probe; id: the Conversation) or `round` (a whole round).
 */
export type RelocatedWorkItemList = (typeof RELOCATED_WORK_LISTS)[number] | 'otherRuntimeWork' | 'round';

export interface RelocatedWorkItem {
  conversationId: string;
  id: string;
  list: RelocatedWorkItemList;
}

export interface RelocatedWorkUnsettled extends RelocatedWorkItem {
  kind: RelocatedWorkUnsettledKind;
  detail: string;
}

export interface RelocatedWorkSettlementResult {
  reason: string;
  counts: RelocatedWorkSettlementCounts;
  /** Work a live Host executes or holds: a Turn has its durable stop request, the rest is left to that Host. */
  live: RelocatedWorkItem[];
  unsettled: RelocatedWorkUnsettled[];
  /** Settlement rounds run: settling can create new work (see run), taken again up to the limit. */
  rounds: number;
}

/** Historical merging reuses the same stop transitions and result shape as relocation. */
export type HistoricalWorkSettlementResult = RelocatedWorkSettlementResult;
