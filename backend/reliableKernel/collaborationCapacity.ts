import type { ContentAddressedStore } from './contentAddressedStore';
import { readTurnCollaborationLimits } from './collaborationPolicy';
import { readCollaborationIdentity } from './collaborationScope';
import { DOMAIN_REPOSITORIES, type RepositoryTransactionStep } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';

export class CollaborationCapacityError extends Error {
  public readonly code = 'COLLABORATION_CAPACITY';
  public constructor(public readonly maximum: number) {
    super(`团队同时运行的子 Agent 已达到用户设置的上限 ${maximum}，请等待已有任务完成。`);
    this.name = 'CollaborationCapacityError';
  }
}

export class CollaborationMembershipChangedError extends Error {
  public constructor() {
    super('Collaboration membership changed while reserving execution capacity; retry admission.');
    this.name = 'CollaborationMembershipChangedError';
  }
}

/**
 * Counts live child Turns, including reserved starts. The scalar guard must be committed in
 * the same transaction that creates the new Turn. It re-counts the complete rooted active set
 * under the writer lock; neither historical roster size nor an in-memory semaphore is authority.
 */
export async function prepareCollaborationCapacity(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  conversationId: string,
  sourceTurnId: string
): Promise<RepositoryTransactionStep[]> {
  const scope = await readCollaborationIdentity(database, conversationId);
  const budgetTurnId = conversationId === scope.rootConversationId ? sourceTurnId : scope.rootTurnId;
  if (!budgetTurnId) throw new Error('Agent execution capacity requires a root Turn authority.');
  const limits = await readTurnCollaborationLimits(database, contentStore, budgetTurnId);
  const count = (await database.snapshot([DOMAIN_REPOSITORIES.domain('Turn').collaborationCapacity(scope.rootConversationId)])).snapshot[0];
  if (!count || Array.isArray(count) || typeof count.active_count !== 'bigint') throw new Error('Collaboration capacity count is missing.');
  if (count.active_count >= BigInt(limits.maxConcurrentAgents)) throw new CollaborationCapacityError(limits.maxConcurrentAgents);
  return [...scope.authoritySteps,
    DOMAIN_REPOSITORIES.domain('Turn').assertCollaborationCapacity(scope.rootConversationId, limits.maxConcurrentAgents)];
}
