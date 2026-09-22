import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';
import { collaborationConversationDeletionSteps } from './collaborationDeletion';

export interface ConversationDeleteResult {
  deletedConversationIds: string[];
}

interface ConversationDeletionSnapshot {
  conversations: DomainRow[];
  childExecutions: DomainRow[];
  childOrigins: DomainRow[];
  sourceOrigins: DomainRow[];
  turns: DomainRow[];
  leases: DomainRow[];
  activeChildTurnLinks: DomainRow[];
  pendingIntentLinks: DomainRow[];
  deliveries: DomainRow[];
  processes: DomainRow[];
  processDispatches: DomainRow[];
}

/**
 * Deletes one Conversation together with only its Subagent-origin descendants.
 *
 * ConversationOriginLink source fields are deliberately soft references, so SQLite cannot infer
 * this graph. The control plane freezes the exact descendant set, rejects any live work in that
 * set, and deletes descendants before the requested root in one writer transaction.
 */
export class ConversationDeletionControlPlane {
  public constructor(private readonly database: RuntimeDatabase) {}

  public async delete(conversationIdInput: string): Promise<ConversationDeleteResult | null> {
    const conversationId = requireId(conversationIdInput, 'conversationId');
    const snapshot = await this.readSnapshot(conversationId);
    if (!snapshot) return null;
    const deletionOrder = descendantFirstConversationIds(conversationId, snapshot.childOrigins);
    const collaboration = await collaborationConversationDeletionSteps(this.database, deletionOrder);
    this.assertSafeToDelete(snapshot, collaboration.pendingDeliveryIds);
    const conversationById = new Map(snapshot.conversations.map((row) => [String(row.id), row]));
    const expectedOriginIdsBySource = groupIds(snapshot.sourceOrigins, 'source_conversation_id');
    const expectedChildExecutionIdsByConversation = groupIds(snapshot.childExecutions, 'child_conversation_id');
    const steps: RepositoryTransactionStep[] = [...collaboration.steps];

    for (const targetId of deletionOrder) {
      const conversation = conversationById.get(targetId);
      if (!conversation) throw new Error(`Conversation ${targetId} disappeared from its deletion snapshot.`);
      steps.push(
        DOMAIN_REPOSITORIES.domain('Conversation').assert(targetId, {
          status: conversation.status,
          updated_at: conversation.updated_at
        }),
        DOMAIN_REPOSITORIES.domain('ConversationOriginLink').assertExactIds(
          { source_conversation_id: targetId },
          expectedOriginIdsBySource.get(targetId) ?? []
        ),
        DOMAIN_REPOSITORIES.domain('ChildExecution').assertExactIds(
          { child_conversation_id: targetId },
          expectedChildExecutionIdsByConversation.get(targetId) ?? []
        ),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assertNone({ conversation_id: targetId }),
        DOMAIN_REPOSITORIES.domain('Turn').assertNone({
          conversation_id: targetId,
          status: 'active'
        }),
        DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assertNone({
          target_conversation_id: targetId,
          state: 'pending'
        })
      );
    }
    for (const child of snapshot.childExecutions) {
      const childExecutionId = requireId(child.id, 'ChildExecution.id');
      steps.push(
        DOMAIN_REPOSITORIES.domain('ChildExecution').assert(childExecutionId, {
          child_conversation_id: child.child_conversation_id,
          status: child.status,
          updated_at: child.updated_at
        }),
        DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assertNone({
          child_execution_id: childExecutionId
        }),
        DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').assertNone({
          child_execution_id: childExecutionId,
          state: 'pending'
        })
      );
    }
    steps.push(...deletionOrder.map((targetId) =>
      DOMAIN_REPOSITORIES.domain('Conversation').delete(targetId)
    ));

    const ownershipOrder = [...deletionOrder].sort();
    const deleteOwned = async (index: number): Promise<ConversationDeleteResult> => {
      if (index < ownershipOrder.length) {
        return this.database.conversationOwners.run(ownershipOrder[index], () => deleteOwned(index + 1));
      }
      await this.database.transaction(steps);
      return { deletedConversationIds: deletionOrder };
    };
    return deleteOwned(0);
  }

  private async readSnapshot(rootConversationId: string): Promise<ConversationDeletionSnapshot | null> {
    const [conversations, childExecutions, origins, turns, leases, activeChildTurnLinks] =
      await Promise.all([
        listAllDomainRows(this.database, 'Conversation'),
        listAllDomainRows(this.database, 'ChildExecution'),
        listAllDomainRows(this.database, 'ConversationOriginLink'),
        listAllDomainRows(this.database, 'Turn'),
        listAllDomainRows(this.database, 'ExecutionLease'),
        listAllDomainRows(this.database, 'ChildExecutionActiveTurnLink')
      ]);
    if (!conversations.some((row) => row.id === rootConversationId)) return null;

    const agentChildConversationIds = new Set(childExecutions.map((row) => String(row.child_conversation_id)));
    const agentOrigins = origins.filter((row) =>
      agentChildConversationIds.has(String(row.conversation_id))
      && typeof row.source_conversation_id === 'string'
      && row.source_conversation_id.length > 0
    );
    const targetConversationIds = collectConversationDescendants(rootConversationId, agentOrigins);
    const targetChildExecutions = childExecutions.filter((row) =>
      targetConversationIds.has(String(row.child_conversation_id))
    );
    const targetChildExecutionIds = new Set(targetChildExecutions.map((row) => String(row.id)));
    const targetTurns = turns.filter((row) => targetConversationIds.has(String(row.conversation_id)));
    const targetLeases = leases.filter((row) => targetConversationIds.has(String(row.conversation_id)));
    const targetPendingIntentLinks = (await Promise.all([...targetChildExecutionIds].map((childExecutionId) =>
      listAllDomainRows(this.database, 'ChildExecutionIntentLink', {
        child_execution_id: childExecutionId,
        state: 'pending'
      })
    ))).flat();
    const targetDeliveries = (await Promise.all([...targetConversationIds].map((targetConversationId) =>
      listAllDomainRows(this.database, 'RuntimeDelivery', {
        target_conversation_id: targetConversationId
      })
    ))).flat();
    const targetProcessSources = (await Promise.all([...targetConversationIds].map((targetConversationId) =>
      listAllDomainRows(this.database, 'ProcessCompletionSourceLink', {
        conversation_id: targetConversationId
      })
    ))).flat();
    const processIds = new Set(targetProcessSources.map((row) => String(row.process_id)));
    const processes = processIds.size === 0
      ? []
      : (await Promise.all([...processIds].map((id) => this.maybeGet('Process', id))))
          .filter((row): row is DomainRow => row !== null);
    const processReceipts = (await Promise.all([...processIds].map((processId) =>
      listAllDomainRows(this.database, 'ProcessReceipt', { process_id: processId })
    ))).flat();
    const processDispatches = (await Promise.all(processReceipts.map((receipt) =>
      listAllDomainRows(this.database, 'ProcessCompletionDispatch', {
        process_receipt_id: String(receipt.id)
      })
    ))).flat();

    return {
      conversations: conversations.filter((row) => targetConversationIds.has(String(row.id))),
      childExecutions: targetChildExecutions,
      childOrigins: agentOrigins.filter((row) =>
        targetConversationIds.has(String(row.conversation_id))
        && targetConversationIds.has(String(row.source_conversation_id))
      ),
      sourceOrigins: origins.filter((row) =>
        targetConversationIds.has(String(row.source_conversation_id))
      ),
      turns: targetTurns,
      leases: targetLeases,
      activeChildTurnLinks: activeChildTurnLinks.filter((row) =>
        targetChildExecutionIds.has(String(row.child_execution_id))
      ),
      pendingIntentLinks: targetPendingIntentLinks,
      deliveries: targetDeliveries,
      processes,
      processDispatches
    };
  }

  private assertSafeToDelete(snapshot: ConversationDeletionSnapshot, settledCollaborationDeliveries: ReadonlySet<string>): void {
    if (snapshot.leases.length > 0 || snapshot.turns.some((row) => row.status === 'active')) {
      throw new Error('对话树仍有活动 Turn；请先终止全部主 Agent/Subagent 后再删除。');
    }
    if (snapshot.activeChildTurnLinks.length > 0) {
      throw new Error('对话树仍有尚未收敛的 Subagent Turn；请等待终止完成后再删除。');
    }
    if (snapshot.pendingIntentLinks.length > 0) {
      throw new Error('对话树仍有排队中的 Subagent 后续任务；请先终止后再删除。');
    }
    if (snapshot.childExecutions.some((row) => ['starting', 'active', 'interrupting'].includes(String(row.status)))) {
      throw new Error('对话树仍有活动 Subagent；请先终止后再删除。');
    }
    if (snapshot.deliveries.some((row) => row.state === 'pending' && !settledCollaborationDeliveries.has(String(row.id)))) {
      throw new Error('对话树仍有待接收的后台结果；结果收敛后才能删除。');
    }
    if (snapshot.processes.some((row) => row.status === 'running')) {
      throw new Error('对话树仍有后台进程运行；请先等待完成或终止进程后再删除。');
    }
    if (snapshot.processDispatches.some((row) => row.state === 'pending' || row.state === 'claimed')) {
      throw new Error('对话树的后台进程完成结果仍在投递；请等待投递收敛后再删除。');
    }
  }

  private async maybeGet(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    return row && !Array.isArray(row) ? row : null;
  }
}

function collectConversationDescendants(rootId: string, origins: readonly DomainRow[]): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const origin of origins) {
    const parentId = String(origin.source_conversation_id);
    const childId = String(origin.conversation_id);
    const children = childrenByParent.get(parentId) ?? [];
    children.push(childId);
    childrenByParent.set(parentId, children);
  }
  const descendants = new Set<string>([rootId]);
  const pending = [rootId];
  while (pending.length > 0) {
    const parentId = pending.pop()!;
    for (const childId of childrenByParent.get(parentId) ?? []) {
      if (descendants.has(childId)) continue;
      descendants.add(childId);
      pending.push(childId);
    }
  }
  return descendants;
}

function descendantFirstConversationIds(rootId: string, origins: readonly DomainRow[]): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const origin of origins) {
    const parentId = String(origin.source_conversation_id);
    const childId = String(origin.conversation_id);
    const children = childrenByParent.get(parentId) ?? [];
    children.push(childId);
    childrenByParent.set(parentId, children);
  }
  for (const children of childrenByParent.values()) children.sort();
  const result: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (conversationId: string): void => {
    if (visiting.has(conversationId)) throw new Error('Subagent Conversation lineage contains a cycle.');
    if (visited.has(conversationId)) return;
    visiting.add(conversationId);
    for (const childId of childrenByParent.get(conversationId) ?? []) visit(childId);
    visiting.delete(conversationId);
    visited.add(conversationId);
    result.push(conversationId);
  };
  visit(rootId);
  return result;
}

function groupIds(rows: readonly DomainRow[], key: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const scopeId = String(row[key]);
    const ids = result.get(scopeId) ?? [];
    ids.push(String(row.id));
    result.set(scopeId, ids);
  }
  for (const ids of result.values()) ids.sort();
  return result;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} 必须是非空字符串。`);
  return value.trim();
}
