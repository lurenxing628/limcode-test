import type { ReliableChildAgentCoordinator } from '../../reliableKernel/childAgentCoordinator';
import { isCollaborationWakeBudgetExhaustedError } from '../../reliableKernel/collaborationControlPlane';
import type { ProcessCompletionWakeHandler, ProcessCompletionWakeRequest } from '../../reliableKernel/processCompletionDelivery';
import type { ReliableKernelApplication } from '../../reliableKernel/runtimeApplication';
import type { ReliableConversationRunner } from './ReliableConversationRunner';

export interface RuntimeDeliveryWakeDependencies {
  application(): ReliableKernelApplication | undefined;
  conversations(): ReliableConversationRunner | undefined;
  children(): ReliableChildAgentCoordinator | undefined;
  /**
   * The post-activation catalogs (skills, rules, workspace configuration) every Turn and model
   * request reads; a wake right after activation waits for them like a user command does.
   */
  ready?(): Promise<void>;
  notify?(request: ProcessCompletionWakeRequest): void;
}

/** Shared production scheduler: durable input delivery never bypasses Conversation ownership. */
export function createRuntimeDeliveryWakeHandler(dependencies: RuntimeDeliveryWakeDependencies): ProcessCompletionWakeHandler {
  return async request => {
    const application = dependencies.application();
    const runner = dependencies.conversations();
    const children = dependencies.children();
    if (!application || !runner) return { acknowledged: false };
    if (!application.database.conversationOwners.owns(request.conversationId)) return { acknowledged: false };
    await application.database.conversationOwners.assertOwned(request.conversationId);
    if (request.action === 'notify_only') {
      const acknowledged = await application.runtime.deliveries.acknowledgeNotification(request.deliveryId);
      // The committed ACK fences duplicate notifications on wake replay.
      if (acknowledged.changed) dependencies.notify?.(request);
      return { acknowledged: true };
    }
    // Everything below executes the Conversation. A Host that does not serve it leaves the durable
    // delivery pending for the Host that does. A continuation is judged like its admission: by the
    // work environment the new Turn will freeze (its source Turn's when it inherits one), so an idle
    // Conversation whose project moved continues where that work environment is available.
    const eligibility = request.action === 'resume_current_turn'
      ? await application.database.conversationOwners.executionEligibility(request.conversationId)
      : await runner.continuationEligibility(
          request.conversationId,
          request.sourceKind === 'collaboration_message' ? null : request.sourceTurnId
        );
    if (eligibility !== 'eligible') {
      // This Host cannot execute the work it holds the Conversation for: it hands the Conversation
      // back rather than keep it for the pending delivery, so the Host that can run it takes over
      // (and new input there is not blocked). An unknown answer proves nothing and keeps it.
      if (eligibility === 'ineligible') await application.database.conversationOwners.handBack(request.conversationId);
      return { acknowledged: false };
    }
    await dependencies.ready?.();
    if (request.action !== 'resume_current_turn' && application.conversationDeletion.isStopping(request.conversationId)) {
      // This window is stopping the Conversation to delete it: the end of what it stopped opens no
      // Turn. The wake stays pending; the deletion settles it, or it is delivered if the deletion
      // does not complete.
      return { acknowledged: false };
    }
    if (request.action === 'resume_current_turn') {
      if (!request.targetTurnId) return { acknowledged: false };
      // This is a scheduling hint. The loop absorbs committed input at a safe protocol boundary.
      if (!await children?.resume(request.targetTurnId)) runner.resume(request.conversationId, request.targetTurnId);
      const summary = await application.runtime.deliveries.summary(request.deliveryId);
      return { acknowledged: summary.parentHandlingState === 'handled' };
    }
    try {
      if (request.childExecutionId) {
        // Only the child scheduler can establish membership and the next generation's lease.
        if (!children) return { acknowledged: false };
        if (request.sourceTurnId === null) throw new Error('A child runtime delivery requires the child\'s latest Turn.');
        return await children.runtimeDeliveryContinuation({ deliveryId: request.deliveryId,
          childExecutionId: request.childExecutionId, sourceTurnId: request.sourceTurnId });
      }
      // A peer message never borrows the destination's previous Turn authority: the continuation
      // runs under the destination's current settings and may be its very first Turn.
      const continuation = await runner.runtimeContinuation({
        commandId: `runtime-delivery:${request.deliveryId}`, deliveryId: request.deliveryId,
        conversationId: request.conversationId,
        sourceTurnId: request.sourceKind === 'collaboration_message' ? null : request.sourceTurnId
      });
      return { acknowledged: Boolean(continuation.intentId) };
    } catch (error) {
      // A message or reply whose automatic budget is spent opens no Turn: it waits for its
      // target's next Turn.
      if (isCollaborationWakeBudgetExhaustedError(error)) return { acknowledged: true };
      throw error;
    }
  };
}
