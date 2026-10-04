import { stablePhaseFId } from './phaseFIdentity';
import { DOMAIN_REPOSITORIES, type RepositoryTransactionStep } from './repositories';

export function runtimeDeliveryTimelineStep(input: {
  conversationId: string; deliveryId: string; now: string;
  context?: { pendingTurnInputId: string; inputContentObjectId: string; rootId: string; nodeId: string };
}): RepositoryTransactionStep {
  return DOMAIN_REPOSITORIES.domain('RuntimeDeliveryTimelineLink').insertAtTimelineBoundary({
    id: stablePhaseFId('runtime_delivery_timeline', input.deliveryId),
    conversation_id: input.conversationId, delivery_id: input.deliveryId,
    acceptance_kind: input.context ? 'input' : 'notification',
    pending_turn_input_id: input.context?.pendingTurnInputId ?? null,
    context_root_id: input.context?.rootId ?? null, context_node_id: input.context?.nodeId ?? null,
    created_at: input.now
  }, input.context?.inputContentObjectId);
}

export function collaborationSendTimelineStep(input: {
  conversationId: string; messageId: string; now: string;
}): RepositoryTransactionStep {
  return DOMAIN_REPOSITORIES.domain('CollaborationSendTimelineLink').insertAtTimelineBoundary({
    id: stablePhaseFId('collaboration_send_timeline', input.messageId),
    conversation_id: input.conversationId, message_id: input.messageId, created_at: input.now
  });
}
