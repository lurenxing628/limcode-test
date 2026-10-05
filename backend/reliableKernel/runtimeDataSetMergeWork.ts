import { randomUUID } from 'node:crypto';
import { ContentAddressedStore } from './contentAddressedStore';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';
import { createReliableKernelRuntimeServices } from './runtimeServices';
import { TurnControlPlane, type TurnAuthorityCompiler } from './turnControlPlane';
import type { RootAuthority } from './rootAuthority';
import type { UnfinishedWorkInspection } from './runtimeDataSetMergeProbes';

export {
  describeUnfinishedWork, hasFinalizableWork, inspectCarriedWork, inspectUnfinishedWork,
  type CarriedWorkRefusals, type FinalizableIntent, type FinalizableTurn, type UnfinishedWorkInspection,
  type UnfinishedWorkRefusal
} from './runtimeDataSetMergeProbes';

/**
 * Unfinished work in a data set that is about to be merged. A merged data set must never make the
 * receiving Runtime resume, deliver, reconcile or ask about anything: the maintainer-approved rule
 * is to close such work before the merge with the kernel's existing terminal transitions, and to
 * refuse the source when no existing transition closes a state without inventing new semantics.
 *
 * | State                                              | Handling before merge                            |
 * |----------------------------------------------------|--------------------------------------------------|
 * | active Turn, no lease, no input                    | TurnControlPlane.finalizeRecovery → cancelled     |
 * | active Turn with ExecutionLease                    | TurnControlPlane.terminal → cancelled (releases) |
 * | + pending interrupt/termination request            | TurnControlPlane.terminal → interrupted (consumed) |
 * | its non-terminal ModelRequest                      | cancelCurrentModelRequest (turn-interrupt-requested) |
 * | its pending ToolCall with no Operation             | EffectControlPlane.settleWithoutEffect → cancelled |
 * | queued non-child TurnIntent (input/continuation/retry/runtime continuation) | TurnControlPlane.cancelQueuedIntent |
 * | everything below                                   | refused, with the reason and what the user can do |
 */
/**
 * Reason of a Turn closed before merging a data set last used in an earlier version (one opened and
 * switched away from in this version is kept, see KEPT_MERGE_FINALIZATION_REASON): it was interrupted
 * there, which says nothing about how (an upgrade, a switch, a closed window).
 */
export const MERGE_FINALIZATION_REASON = '在旧版本里中断，合并前收尾。';
/** Reason of a Turn closed before merging a data set the user switched away from in this version. */
export const KEPT_MERGE_FINALIZATION_REASON = '合并前收尾。';

/**
 * Closes the finalizable work of an offline source with the existing control-plane transitions,
 * Turns with `reason`. Call inside the source's maintenance claim, after a verified source backup;
 * the source registers a short-lived Host for the duration. No Turn is started and no provider is
 * contacted. Afterwards, also when a transition failed, `onCounted` gets how many of the Turns and
 * intents in `count` the source has closed (not how many were planned).
 */
export async function finalizeUnfinishedWork(
  authority: RootAuthority,
  inspection: UnfinishedWorkInspection,
  options: {
    reason: string;
    count: { turnIds: readonly string[]; intentIds: readonly string[] };
    onCounted(closed: { turns: number; intents: number }): void;
  }
): Promise<void> {
  const database = await RuntimeDatabase.open(authority, { hostBootId: `merge-finalize-${randomUUID()}` });
  try {
    const contentStore = ContentAddressedStore.forDatabase(authority, database);
    const authorityCompiler: TurnAuthorityCompiler = {
      compile: async () => { throw new Error('Merge finalization never starts a Turn.'); }
    };
    const runtime = createReliableKernelRuntimeServices(database, contentStore, { authorityCompiler });
    const turns = new TurnControlPlane(database, contentStore, {
      authorityCompiler,
      prepareNextTurnDeliverySteps: (conversationId, turnId, now, startingDeliveryId) =>
        runtime.deliveries.prepareNextTurnDeliverySteps(conversationId, turnId, now, startingDeliveryId),
      prepareTerminalDeliverySteps: (turnId, now) => runtime.deliveries.prepareTerminalDeliverySteps(turnId, now),
      prepareRuntimeContinuationSteps: (deliveryId) => runtime.collaboration.prepareWakeContinuationSteps(deliveryId)
    });
    for (const intent of inspection.intents) {
      await turns.cancelQueuedIntent({
        source: { kind: 'internal', key: `historical-merge-finalize:intent:${intent.intentId}` },
        conversationId: intent.conversationId,
        intentId: intent.intentId,
        expectedRevisionSeq: intent.expectedRevisionSeq
      });
    }
    for (const turn of inspection.turns) {
      for (const modelRequestId of turn.modelRequestIds) {
        await database.cancelCurrentModelRequest({
          modelRequestId,
          terminalState: 'turn-interrupt-requested',
          now: new Date().toISOString()
        });
      }
      for (const toolCallId of turn.pendingToolCallIds) {
        await runtime.effects.settleWithoutEffect({
          source: { kind: 'internal', key: `historical-merge-finalize:tool:${toolCallId}` },
          toolCallId,
          status: 'cancelled',
          detail: { reason: 'turn_termination_requested' }
        });
      }
      const command = {
        source: { kind: 'recovery' as const, key: `historical-merge-finalize:turn:${turn.turnId}` },
        turnId: turn.turnId,
        terminalStatus: turn.terminalStatus,
        reason: options.reason
      };
      const facts = await turns.recoveryFacts(turn.turnId);
      if (facts.judgment === 'finalize' && turn.terminalStatus === 'cancelled') await turns.finalizeRecovery(command);
      else await turns.terminal(command);
    }
  } finally {
    await countClosed(database, options.count).then(options.onCounted, () => undefined);
    await database.close();
  }
}

/** How many of these Turns are no longer active and of these intents no longer queued. */
async function countClosed(
  database: RuntimeDatabase,
  count: { turnIds: readonly string[]; intentIds: readonly string[] }
): Promise<{ turns: number; intents: number }> {
  const closed = async (domain: string, ids: readonly string[], open: (row: DomainRow) => boolean): Promise<number> => {
    let total = 0;
    for (let start = 0; start < ids.length; start += 250) {
      const rows = (await database.snapshot(ids.slice(start, start + 250).map((id) => DOMAIN_REPOSITORIES.domain(domain).get(id)))).snapshot;
      total += (rows as Array<DomainRow | null>).filter((row) => row !== null && !open(row)).length;
    }
    return total;
  };
  return {
    turns: await closed('Turn', count.turnIds, (row) => row.status === 'active'),
    intents: await closed('TurnIntent', count.intentIds, (row) => row.state === 'queued')
  };
}
