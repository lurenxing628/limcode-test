import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';

/** What a waiting parent Turn is told when the user deleted the child Conversation whose answer it was owed. */
export const CHILD_CONVERSATION_DELETED_NOTICE = '子任务对话已被用户删除，它的答复不会再送达。';

/**
 * Content type of the runtime input that replaces such an answer: the child's identity as it was
 * when it was deleted, and the notice. Never the deleted child's answer text.
 */
export const CHILD_ANSWER_SOURCE_DELETED_CONTENT_TYPE = 'application/vnd.limcode.child-answer-source-deleted+json';

/**
 * Transaction steps that give up a result nobody will receive, shared by every "abandon" transition
 * (the deletion transaction with `target-gone` / `source-gone`, a data-root relocation with its own
 * reason code). Each step asserts the row exactly as the caller read it, so a concurrent change fails
 * the whole transaction instead of being overwritten; the caller re-reads and tries again. No new
 * state is introduced: failed, dead_letter and settled are the rows' existing terminal states.
 */

/** A pending RuntimeDelivery becomes failed with `reason`; nothing for a delivery in any other state. */
export function failPendingDeliverySteps(delivery: DomainRow, reason: string, now: string): RepositoryTransactionStep[] {
  if (delivery.state !== 'pending') return [];
  const deliveryId = String(delivery.id);
  return [
    DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(deliveryId, {
      state: 'pending',
      target_conversation_id: delivery.target_conversation_id,
      updated_at: delivery.updated_at
    }),
    DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update(deliveryId, {
      state: 'failed', failure_reason: reason, updated_at: now
    })
  ];
}

/**
 * The delivery's wakes as read (exact id set), each pending or claimed one dead-lettered with
 * `reason`, so no Host delivers it afterwards.
 */
export function deadLetterDeliveryWakeSteps(
  deliveryId: string,
  wakes: readonly DomainRow[],
  reason: string,
  now: string
): RepositoryTransactionStep[] {
  const steps: RepositoryTransactionStep[] = [
    DOMAIN_REPOSITORIES.domain('RuntimeDeliveryWake').assertExactIds(
      { delivery_id: deliveryId }, wakes.map((wake) => String(wake.id)))
  ];
  for (const wake of wakes) {
    if (wake.state !== 'pending' && wake.state !== 'claimed') continue;
    steps.push(DOMAIN_REPOSITORIES.domain('RuntimeDeliveryWake').assert(String(wake.id), {
      state: wake.state, claim_generation: wake.claim_generation, updated_at: wake.updated_at
    }), DOMAIN_REPOSITORIES.domain('RuntimeDeliveryWake').update(String(wake.id), {
      state: 'dead_letter', claim_owner_host_boot_id: null, claim_expires_at: null,
      next_attempt_at: null, last_error: reason, updated_at: now
    }));
  }
  return steps;
}

/** A never-routed (available) RuntimeInboxItem is settled: nothing may route it later. */
export function settleAvailableInboxItemSteps(inbox: DomainRow, now: string): RepositoryTransactionStep[] {
  if (inbox.state !== 'available') return [];
  const inboxId = String(inbox.id);
  return [
    DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').assert(inboxId, { state: 'available', source_id: inbox.source_id }),
    DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').update(inboxId, { state: 'settled', updated_at: now })
  ];
}

/** A pending or claimed ProcessCompletionDispatch is dead-lettered with `reason`; nothing for a finished one. */
export function deadLetterProcessCompletionDispatchSteps(
  dispatch: DomainRow,
  reason: string,
  now: string
): RepositoryTransactionStep[] {
  if (dispatch.state !== 'pending' && dispatch.state !== 'claimed') return [];
  const dispatchId = String(dispatch.id);
  return [
    DOMAIN_REPOSITORIES.domain('ProcessCompletionDispatch').assert(dispatchId, {
      state: dispatch.state, claim_generation: dispatch.claim_generation, updated_at: dispatch.updated_at
    }),
    DOMAIN_REPOSITORIES.domain('ProcessCompletionDispatch').update(dispatchId, {
      state: 'dead_letter', claim_owner_host_boot_id: null, claim_expires_at: null,
      next_attempt_at: null, last_error: reason, updated_at: now
    })
  ];
}

/**
 * A result that was never routed gets its delivery already failed with `reason`, in the same
 * transaction that routes its Inbox item: no Host ever creates a wake for a failed delivery, and
 * recovery finds this delivery instead of routing the result again.
 */
export function abandonedDeliveryInsertSteps(
  inbox: DomainRow,
  delivery: { id: string; targetConversationId: string; phase: string },
  reason: string,
  now: string
): RepositoryTransactionStep[] {
  const inboxId = String(inbox.id);
  return [
    DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').assert(inboxId, { state: 'available', source_id: inbox.source_id }),
    DOMAIN_REPOSITORIES.domain('RuntimeDelivery').insert({
      id: delivery.id,
      inbox_item_id: inboxId,
      target_conversation_id: delivery.targetConversationId,
      target_turn_id: null,
      phase: delivery.phase,
      attempt_seq: 1n,
      retry_of_delivery_id: null,
      state: 'failed',
      failure_reason: reason,
      created_at: now,
      updated_at: now
    }),
    DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').update(inboxId, { state: 'routed', updated_at: now })
  ];
}

/** The reason code a data-root relocation settles the carried results of the old directory with. */
export const DATA_ROOT_RELOCATED_REASON = 'data-root-relocated';

/** A local historical source whose unfinished work the user explicitly agreed to stop before merge. */
export const HISTORICAL_MERGE_SETTLED_REASON = 'historical-merge-settled';

/** What the user reads for a settlement reason code shown next to an undelivered result. */
export function settlementReasonText(reason: string | undefined): string | undefined {
  if (reason === DATA_ROOT_RELOCATED_REASON) return '数据目录已迁移，未送达';
  if (reason === HISTORICAL_MERGE_SETTLED_REASON) return '合并前已中止，未送达';
  return undefined;
}
