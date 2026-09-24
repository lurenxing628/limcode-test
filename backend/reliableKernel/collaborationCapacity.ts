import type { ContentAddressedStore } from './contentAddressedStore';
import { readTurnCollaborationLimits } from './collaborationPolicy';
import { readCollaborationScope } from './collaborationScope';
import { DOMAIN_REPOSITORIES, type RepositoryTransactionStep } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
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
 * Counts live child Turns, including reserved starts. The returned guards must be committed in
 * the same transaction that creates the new Turn. Exact membership and active-Turn sets fence
 * competing starts on other hosts; an in-memory semaphore is never the execution authority.
 */
export async function prepareCollaborationCapacity(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  conversationId: string,
  sourceTurnId: string
): Promise<RepositoryTransactionStep[]> {
  const scope = await readCollaborationScope(database, conversationId);
  const budgetTurnId = conversationId === scope.rootConversationId ? sourceTurnId : scope.rootTurnId;
  if (!budgetTurnId) throw new Error('Agent execution capacity requires a root Turn authority.');
  const limits = await readTurnCollaborationLimits(database, contentStore, budgetTurnId);
  const steps = [...scope.authoritySteps];
  const knownChildren = new Set(scope.members.flatMap(member => member.childExecutionId ? [member.childExecutionId] : []));
  let activeChildren = 0;
  for (const member of scope.members) {
    const turns = await listAllDomainRows(database, 'Turn', { conversation_id: member.conversationId });
    steps.push(DOMAIN_REPOSITORIES.domain('Turn').assertExactIds(
      { conversation_id: member.conversationId }, turns.map(turn => String(turn.id))
    ));
    for (const turn of turns) {
      const edges = await listAllDomainRows(database, 'ChildExecutionParentLink', { parent_turn_id: turn.id });
      if (edges.some(edge => !knownChildren.has(String(edge.child_execution_id)))) {
        throw new CollaborationMembershipChangedError();
      }
      steps.push(DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').assertExactIds(
        { parent_turn_id: turn.id }, edges.map(edge => String(edge.id))
      ));
    }
    if (!member.childExecutionId) continue;
    const active = turns.filter(turn => turn.status === 'active');
    if (active.length > 1) throw new Error('A child Conversation has multiple active Turns.');
    activeChildren += active.length;
    steps.push(DOMAIN_REPOSITORIES.domain('Turn').assertExactIds(
      { conversation_id: member.conversationId, status: 'active' }, active.map(turn => String(turn.id))
    ));
  }
  if (activeChildren >= limits.maxConcurrentAgents) throw new CollaborationCapacityError(limits.maxConcurrentAgents);
  return steps;
}
