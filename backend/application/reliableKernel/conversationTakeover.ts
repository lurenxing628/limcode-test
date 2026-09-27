import type { ReliableChildAgentCoordinator } from '../../reliableKernel/childAgentCoordinator';
import type { ReliableKernelApplication } from '../../reliableKernel/runtimeApplication';
import type { ReliableConversationRunner } from './ReliableConversationRunner';

/**
 * The per-Conversation recovery a window serving the Conversation runs when it takes it over: a
 * view opened it, its folder arrived in this window, or its active Turn is no longer held by a live
 * Host. Under one ownership hold, work an exited window left dispatched is checked first (Phase D
 * and the other Runtime recoveries), then the child scheduler recovers, then the Conversation
 * runner resumes. A live peer owner makes it fail with ConversationRuntimeOwnerBusyError.
 */
export function recoverServedConversation(input: {
  application: ReliableKernelApplication;
  childAgents: Pick<ReliableChildAgentCoordinator, 'recoverStartup'>;
  conversations: Pick<ReliableConversationRunner, 'recoverStartup'>;
  conversationId: string;
  signal?: AbortSignal;
  /** Post-activation catalogs every Turn reads (skills, rules, workspace configuration). */
  ready?: () => Promise<void>;
}): Promise<void> {
  const { application, conversationId, signal } = input;
  return application.database.conversationOwners.run(conversationId, async () => {
    signal?.throwIfAborted();
    await input.ready?.();
    await application.recoverConversation(conversationId, signal);
    signal?.throwIfAborted();
    await input.childAgents.recoverStartup(signal, conversationId);
    signal?.throwIfAborted();
    await input.conversations.recoverStartup(signal, conversationId);
  });
}
