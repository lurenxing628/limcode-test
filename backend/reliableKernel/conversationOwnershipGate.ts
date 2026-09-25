import {
  isConversationRuntimeOwnerBusyError,
  isConversationRuntimeOwnerClaimError
} from './ConversationRuntimeOwnerManager';
import type { RuntimeDatabase } from './runtimeDatabase';

/**
 * How a background scan may obtain conversation ownership:
 * - `claim`: explicit startup/recovery may claim unowned work (fail closed for live/unknown peers);
 * - `owned`: recurring convergence only touches conversations this host already owns.
 */
export type ConversationOwnershipAcquisition = 'claim' | 'owned';

export type ConversationOwnershipRunResult<T> =
  | { ran: true; value: T }
  | { ran: false };

/**
 * Per-pass ownership eligibility for level-triggered background scans. A scan never settles or
 * dispatches another live owner's mutable execution: foreign conversations are skipped, their
 * durable rows stay pending, and the actual owner's own scans converge them. Unknown or malformed
 * ownership fails closed the same way; elapsed time alone never makes a conversation claimable.
 */
export class ConversationOwnershipGate {
  private readonly decisions = new Map<string, Promise<boolean>>();
  private readonly claimed = new Set<string>();

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly acquisition: ConversationOwnershipAcquisition
  ) { }

  /** True only when this host owns the conversation (already, or freshly claimed in `claim` mode). */
  public check(conversationId: string): Promise<boolean> {
    const existing = this.decisions.get(conversationId);
    if (existing) return existing;
    const pending = this.resolve(conversationId);
    this.decisions.set(conversationId, pending);
    return pending;
  }

  /**
   * Runs one mutation under an ownership activity pin. Returns `ran: false` when another live or
   * unknown owner holds the conversation; all other errors propagate after the pin is released.
   */
  public async run<T>(
    conversationId: string,
    operation: () => Promise<T>
  ): Promise<ConversationOwnershipRunResult<T>> {
    if (!await this.check(conversationId)) return { ran: false };
    try {
      return { ran: true, value: await this.database.conversationOwners.run(conversationId, operation) };
    } catch (error) {
      if (isConversationRuntimeOwnerBusyError(error)) return { ran: false };
      throw error;
    }
  }

  /**
   * Best-effort idle release of only the conversations this gate claimed during the pass.
   * Activity pins and the pending-work probe veto each release; passive views do not.
   */
  public async releaseClaimed(): Promise<void> {
    const claimed = [...this.claimed];
    this.claimed.clear();
    for (const conversationId of claimed) {
      try {
        await this.database.conversationOwners.releaseIfIdle(conversationId);
      } catch (error) {
        console.warn('[reliable-kernel] Conversation ownership idle release failed.', conversationId, error);
      }
    }
  }

  private async resolve(conversationId: string): Promise<boolean> {
    const owners = this.database.conversationOwners;
    if (owners.owns(conversationId)) return true;
    if (this.acquisition === 'owned') return false;
    try {
      const claimed = await owners.tryClaim(conversationId);
      if (claimed) this.claimed.add(conversationId);
      return claimed;
    } catch (error) {
      if (isConversationRuntimeOwnerBusyError(error)) return false;
      // Malformed or unavailable ownership records fail closed: the conversation is treated as
      // owned elsewhere and its durable work remains pending for a host that can prove takeover.
      // The actual error is surfaced through the standard recovery diagnostic path instead of
      // being counted as a per-row failure.
      console.warn(
        '[reliable-kernel] Conversation ownership claim failed closed.',
        conversationId,
        isConversationRuntimeOwnerClaimError(error) ? error.code : error
      );
      return false;
    }
  }
}
