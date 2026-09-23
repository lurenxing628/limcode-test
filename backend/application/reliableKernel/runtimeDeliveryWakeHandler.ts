import type { ReliableChildAgentCoordinator } from '../../reliableKernel/childAgentCoordinator';
import { isCollaborationReplyBudgetExhaustedError } from '../../reliableKernel/collaborationControlPlane';
import type { ProcessCompletionWakeHandler, ProcessCompletionWakeRequest } from '../../reliableKernel/processCompletionDelivery';
import type { ReliableKernelApplication } from '../../reliableKernel/runtimeApplication';
import type { ReliableConversationRunner } from './ReliableConversationRunner';

export interface RuntimeDeliveryWakeDependencies {
  application(): ReliableKernelApplication | undefined;
  conversations(): ReliableConversationRunner | undefined;
  children(): ReliableChildAgentCoordinator | undefined;
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
    if (request.action === 'resume_current_turn') {
      if (!request.targetTurnId) return { acknowledged: false };
      // This is a scheduling hint. The loop absorbs committed input at a safe protocol boundary.
      if (!await children?.resume(request.targetTurnId)) runner.resume(request.conversationId, request.targetTurnId);
      const summary = await application.runtime.deliveries.summary(request.deliveryId);
      return { acknowledged: summary.parentHandlingState === 'handled' };
    }
    if (request.childExecutionId) {
      // Only the child scheduler can establish membership and the next generation's lease.
      if (!children) return { acknowledged: false };
      if (request.sourceTurnId === null) throw new Error('A child runtime delivery requires the child\'s latest Turn.');
      return children.runtimeDeliveryContinuation({ deliveryId: request.deliveryId,
        childExecutionId: request.childExecutionId, sourceTurnId: request.sourceTurnId });
    }
    // A peer message never borrows the destination's previous Turn authority: the continuation
    // runs under the destination's current settings and may be its very first Turn.
    try {
      const continuation = await runner.runtimeContinuation({
        commandId: `runtime-delivery:${request.deliveryId}`, deliveryId: request.deliveryId,
        conversationId: request.conversationId,
        sourceTurnId: request.sourceKind === 'collaboration_message' ? null : request.sourceTurnId
      });
      return { acknowledged: Boolean(continuation.intentId) };
    } catch (error) {
      // A reply whose task budget is spent starts no Turn: it waits for the requester's next Turn.
      if (isCollaborationReplyBudgetExhaustedError(error)) return { acknowledged: true };
      throw error;
    }
  };
}
