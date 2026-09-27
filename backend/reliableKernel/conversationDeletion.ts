import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';
import { collaborationConversationDeletionSteps } from './collaborationDeletion';
import {
  deadLetterDeliveryWakeSteps,
  deadLetterProcessCompletionDispatchSteps,
  failPendingDeliverySteps,
  settleAvailableInboxItemSteps
} from './deliverySettlementSteps';
import { CHILD_TURN_ANSWER_WAIT_OWNER_KIND, LEGACY_ANSWER_BRIDGE_WAIT_OWNER_KIND } from './childExecution';

export interface ConversationDeleteResult {
  deletedConversationIds: string[];
}

/**
 * RuntimeDelivery.failure_reason of a child answer that its receiving parent had not taken in when
 * the user deleted the child Conversation (the parent stays and never receives it). The mirror of
 * `target-gone`, which settles what was addressed to a deleted Conversation.
 */
export const ANSWER_SOURCE_GONE_FAILURE_REASON = 'source-gone';
const TARGET_GONE_FAILURE_REASON = 'target-gone';
const RUNNING_CHILD_STATUSES = new Set(['starting', 'active', 'interrupting']);
const CHILD_FOREGROUND_WAIT_OWNER_KIND = 'child_execution';

/** Work in a deletion scope that must be stopped before the scope is deleted. */
export type ConversationDeletionWorkKind =
  /** An active top-level Turn (or an ExecutionLease still held in the scope). */
  | 'turn'
  /** An active child Agent Turn, or its active-Turn link that has not converged yet. */
  | 'child_turn'
  /** A child Agent that is still starting, running or interrupting. */
  | 'child_execution'
  /** A queued follow-up task of a child Agent. */
  | 'child_continuation'
  /** A parent's wait for a child Agent of the scope (its parent may be outside the scope). */
  | 'parent_wait'
  /** A queued user message (not a child continuation). */
  | 'queued_message'
  /** A background process that still runs. */
  | 'process'
  /**
   * A child answer of the scope that a running Turn outside it (its parent) is taking in right now:
   * the deletion waits for that Turn instead of pulling the answer from under it.
   */
  | 'parent_intake';

export interface ConversationDeletionWorkItem {
  kind: ConversationDeletionWorkKind;
  conversationId: string;
  /** Turn, ChildExecution, TurnIntent, Operation or Process id. */
  id: string;
  /** The child Agent whose subtree interruption stops this work. */
  childExecutionId?: string;
  /** The Host holding the Turn's ExecutionLease. */
  hostBootId?: string;
  /** Latest TurnIntentRevision of a queued message, for its cancellation. */
  revisionSeq?: string;
  /** Tools of the Turn that are still executing. */
  executingTools?: string[];
}

export interface ConversationDeletionInventory {
  conversationId: string;
  /** The deletion scope: the Conversation and its Subagent-origin descendants, descendants first. */
  conversationIds: string[];
  conversationTitles: Record<string, string>;
  /** The requested Conversation's own ChildExecution when it is a child Agent (its parent stays). */
  rootChildExecutionId: string | null;
  /** Every ChildExecution of the scope; `parentChildExecutionId` only when that parent is in the scope. */
  childExecutions: Array<{ id: string; conversationId: string; status: string; parentChildExecutionId: string | null }>;
  work: ConversationDeletionWorkItem[];
}

/** The scope still has live work; the deletion command stops it first (conversationDeleteCommand). */
export class ConversationDeletionBlockedError extends Error {
  public readonly code = 'conversation-deletion-blocked';

  public constructor(message: string) {
    super(message);
    this.name = 'ConversationDeletionBlockedError';
  }
}

export function isConversationDeletionBlockedError(error: unknown): error is ConversationDeletionBlockedError {
  return error instanceof ConversationDeletionBlockedError
    || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'conversation-deletion-blocked');
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
  childTurnLinks: DomainRow[];
  parentLinks: DomainRow[];
  parentWaits: DomainRow[];
  executingToolCalls: DomainRow[];
  queuedIntents: Array<{ intent: DomainRow; revisionSeq: string }>;
  /** RuntimeDelivery rows addressed to the scope, every state. */
  deliveries: DomainRow[];
  answerBridges: DomainRow[];
  answerSubmissions: DomainRow[];
  answerInboxItems: DomainRow[];
  /** RuntimeDelivery rows of the scope's child answers, every target and state. */
  answerDeliveries: DomainRow[];
  /** Pending answers of the scope addressed to a running Turn outside it (see 'parent_intake'). */
  parentIntakes: DomainRow[];
  outsideTitles: Record<string, string>;
  wakesByDelivery: Map<string, DomainRow[]>;
  processSources: DomainRow[];
  processes: DomainRow[];
  processReceipts: DomainRow[];
  processDispatches: DomainRow[];
}

/**
 * Deletes one Conversation together with only its Subagent-origin descendants.
 *
 * ConversationOriginLink source fields are deliberately soft references, so SQLite cannot infer
 * this graph. The control plane freezes the exact descendant set, rejects live work in that set
 * (the deletion command stops it first: conversationDeleteCommand), settles what is still addressed
 * to or produced by the set, and deletes descendants before the requested root in one writer
 * transaction.
 */
export class ConversationDeletionControlPlane {
  public constructor(private readonly database: RuntimeDatabase) {}

  public async delete(conversationIdInput: string): Promise<ConversationDeleteResult | null> {
    const conversationId = requireId(conversationIdInput, 'conversationId');
    const snapshot = await this.readSnapshot(conversationId);
    if (!snapshot) return null;
    this.assertSafeToDelete(snapshot);
    const deletionOrder = descendantFirstConversationIds(conversationId, snapshot.childOrigins);
    const collaboration = await collaborationConversationDeletionSteps(this.database, deletionOrder);
    const conversationById = new Map(snapshot.conversations.map((row) => [String(row.id), row]));
    const expectedOriginIdsBySource = groupIds(snapshot.sourceOrigins, 'source_conversation_id');
    const expectedChildExecutionIdsByConversation = groupIds(snapshot.childExecutions, 'child_conversation_id');
    const steps: RepositoryTransactionStep[] = [
      ...collaboration.steps,
      ...settlementSteps(snapshot, collaboration.pendingDeliveryIds, new Date().toISOString())
    ];

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
        }),
        DOMAIN_REPOSITORIES.domain('Operation').assertNone({
          owner_kind: CHILD_FOREGROUND_WAIT_OWNER_KIND,
          owner_id: childExecutionId,
          status: 'waiting_answer'
        })
      );
    }
    for (const link of snapshot.childTurnLinks) {
      steps.push(DOMAIN_REPOSITORIES.domain('Operation').assertNone({
        owner_kind: CHILD_TURN_ANSWER_WAIT_OWNER_KIND,
        owner_id: String(link.turn_id),
        status: 'waiting_answer'
      }));
    }
    for (const bridge of snapshot.answerBridges) {
      steps.push(DOMAIN_REPOSITORIES.domain('Operation').assertNone({
        owner_kind: LEGACY_ANSWER_BRIDGE_WAIT_OWNER_KIND,
        owner_id: String(bridge.id),
        status: 'waiting_answer'
      }));
    }
    for (const process of snapshot.processes) {
      const processId = requireId(process.id, 'Process.id');
      steps.push(
        DOMAIN_REPOSITORIES.domain('Process').assert(processId, { status: process.status }),
        DOMAIN_REPOSITORIES.domain('ProcessReceipt').assertExactIds(
          { process_id: processId },
          snapshot.processReceipts.filter((row) => row.process_id === processId).map((row) => String(row.id))
        )
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

  /**
   * The deletion scope and the live work in it, read-only. The deletion command stops this work
   * first (conversationDeleteCommand) and deletes once nothing is left; null when the Conversation
   * does not exist.
   */
  public async inspect(conversationIdInput: string): Promise<ConversationDeletionInventory | null> {
    const conversationId = requireId(conversationIdInput, 'conversationId');
    const snapshot = await this.readSnapshot(conversationId);
    if (!snapshot) return null;
    const scopeChildIds = new Set(snapshot.childExecutions.map((row) => String(row.id)));
    const childByConversation = new Map(snapshot.childExecutions.map((row) => [String(row.child_conversation_id), String(row.id)]));
    const childByTurn = new Map(snapshot.childTurnLinks.map((row) => [String(row.turn_id), String(row.child_execution_id)]));
    const conversationOfChild = new Map(snapshot.childExecutions.map((row) => [String(row.id), String(row.child_conversation_id)]));
    const leaseByTurn = new Map(snapshot.leases.map((row) => [String(row.turn_id), row]));
    const toolsByTurn = new Map<string, string[]>();
    for (const call of snapshot.executingToolCalls) {
      const tools = toolsByTurn.get(String(call.turn_id)) ?? [];
      tools.push(String(call.tool_name));
      toolsByTurn.set(String(call.turn_id), tools);
    }
    const work: ConversationDeletionWorkItem[] = [];
    const turnWork = (turnId: string, conversationIdOfTurn: string): void => {
      const childExecutionId = childByTurn.get(turnId);
      const lease = leaseByTurn.get(turnId);
      const tools = toolsByTurn.get(turnId);
      work.push({
        kind: childExecutionId ? 'child_turn' : 'turn',
        conversationId: conversationIdOfTurn,
        id: turnId,
        ...(childExecutionId ? { childExecutionId } : {}),
        ...(lease ? { hostBootId: String(lease.host_boot_id) } : {}),
        ...(tools ? { executingTools: tools.sort() } : {})
      });
    };
    const activeTurnIds = new Set<string>();
    for (const turn of snapshot.turns) {
      if (turn.status !== 'active') continue;
      activeTurnIds.add(String(turn.id));
      turnWork(String(turn.id), String(turn.conversation_id));
    }
    for (const lease of snapshot.leases) {
      if (!activeTurnIds.has(String(lease.turn_id))) turnWork(String(lease.turn_id), String(lease.conversation_id));
    }
    for (const link of snapshot.activeChildTurnLinks) {
      if (activeTurnIds.has(String(link.turn_id))) continue;
      const childExecutionId = String(link.child_execution_id);
      work.push({ kind: 'child_turn', conversationId: conversationOfChild.get(childExecutionId)!, id: String(link.turn_id), childExecutionId });
    }
    for (const child of snapshot.childExecutions) {
      if (!RUNNING_CHILD_STATUSES.has(String(child.status))) continue;
      work.push({ kind: 'child_execution', conversationId: String(child.child_conversation_id), id: String(child.id), childExecutionId: String(child.id) });
    }
    for (const link of snapshot.pendingIntentLinks) {
      const childExecutionId = String(link.child_execution_id);
      work.push({ kind: 'child_continuation', conversationId: conversationOfChild.get(childExecutionId)!, id: String(link.turn_intent_id), childExecutionId });
    }
    for (const wait of snapshot.parentWaits) {
      const childExecutionId = wait.owner_kind === CHILD_FOREGROUND_WAIT_OWNER_KIND
        ? String(wait.owner_id)
        : wait.owner_kind === CHILD_TURN_ANSWER_WAIT_OWNER_KIND
          ? childByTurn.get(String(wait.owner_id))
          : snapshot.answerBridges.find((bridge) => bridge.id === wait.owner_id)?.child_execution_id as string | undefined;
      if (!childExecutionId || !scopeChildIds.has(childExecutionId)) continue;
      work.push({ kind: 'parent_wait', conversationId: conversationOfChild.get(childExecutionId)!, id: String(wait.id), childExecutionId });
    }
    for (const queued of snapshot.queuedIntents) {
      work.push({ kind: 'queued_message', conversationId: String(queued.intent.conversation_id), id: String(queued.intent.id), revisionSeq: queued.revisionSeq });
    }
    for (const process of snapshot.processes) {
      if (process.status !== 'running') continue;
      const source = snapshot.processSources.find((row) => row.process_id === process.id);
      work.push({ kind: 'process', conversationId: String(source?.conversation_id), id: String(process.id) });
    }
    for (const delivery of snapshot.parentIntakes) {
      work.push({ kind: 'parent_intake', conversationId: String(delivery.target_conversation_id), id: String(delivery.id) });
    }
    const parentOf = new Map(snapshot.parentLinks.map((row) => [String(row.child_execution_id), row.parent_child_execution_id === null ? null : String(row.parent_child_execution_id)]));
    return {
      conversationId,
      conversationIds: descendantFirstConversationIds(conversationId, snapshot.childOrigins),
      conversationTitles: {
        ...snapshot.outsideTitles,
        ...Object.fromEntries(snapshot.conversations.map((row) => [String(row.id), typeof row.title === 'string' ? row.title : '']))
      },
      rootChildExecutionId: childByConversation.get(conversationId) ?? null,
      childExecutions: snapshot.childExecutions.map((row) => {
        const parent = parentOf.get(String(row.id)) ?? null;
        return {
          id: String(row.id),
          conversationId: String(row.child_conversation_id),
          status: String(row.status),
          parentChildExecutionId: parent !== null && scopeChildIds.has(parent) ? parent : null
        };
      }),
      work
    };
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
    const perChild = (domain: string, extra: Record<string, unknown> = {}) => Promise.all([...targetChildExecutionIds]
      .map((childExecutionId) => listAllDomainRows(this.database, domain, { child_execution_id: childExecutionId, ...extra })))
      .then((rows) => rows.flat());
    const perConversation = (domain: string, key: string, extra: Record<string, unknown> = {}) =>
      Promise.all([...targetConversationIds].map((targetConversationId) =>
        listAllDomainRows(this.database, domain, { [key]: targetConversationId, ...extra })))
        .then((rows) => rows.flat());
    const [targetPendingIntentLinks, childTurnLinks, parentLinks, answerBridges, targetDeliveries, targetProcessSources, queued] =
      await Promise.all([
        perChild('ChildExecutionIntentLink', { state: 'pending' }),
        perChild('ChildExecutionTurnLink'),
        perChild('ChildExecutionParentLink'),
        perChild('AnswerBridge'),
        perConversation('RuntimeDelivery', 'target_conversation_id'),
        perConversation('ProcessCompletionSourceLink', 'conversation_id'),
        perConversation('TurnIntent', 'conversation_id', { state: 'queued' })
      ]);
    const activeTurnIds = targetTurns.filter((row) => row.status === 'active').map((row) => String(row.id));
    const [parentWaits, executingToolCalls, queuedIntents, answerSubmissions] = await Promise.all([
      Promise.all([
        ...[...targetChildExecutionIds].map((ownerId) => listAllDomainRows(this.database, 'Operation', {
          owner_kind: CHILD_FOREGROUND_WAIT_OWNER_KIND, owner_id: ownerId, status: 'waiting_answer'
        })),
        ...childTurnLinks.map((link) => listAllDomainRows(this.database, 'Operation', {
          owner_kind: CHILD_TURN_ANSWER_WAIT_OWNER_KIND, owner_id: String(link.turn_id), status: 'waiting_answer'
        })),
        ...answerBridges.map((bridge) => listAllDomainRows(this.database, 'Operation', {
          owner_kind: LEGACY_ANSWER_BRIDGE_WAIT_OWNER_KIND, owner_id: String(bridge.id), status: 'waiting_answer'
        }))
      ]).then((rows) => rows.flat()),
      Promise.all(activeTurnIds.map((turnId) => listAllDomainRows(this.database, 'ToolCall', { turn_id: turnId, status: 'executing' })))
        .then((rows) => rows.flat()),
      this.queuedMessages(queued.filter((intent) => intent.turn_id === null)),
      Promise.all(answerBridges.map((bridge) => listAllDomainRows(this.database, 'AnswerSubmission', { answer_bridge_id: String(bridge.id) })))
        .then((rows) => rows.flat())
    ]);
    const answerInboxItems = (await Promise.all(answerSubmissions.map((submission) => listAllDomainRows(this.database, 'RuntimeInboxItem', {
      source_kind: 'answer_submission', source_id: String(submission.id)
    })))).flat();
    const answerDeliveries = (await Promise.all(answerInboxItems.map((inbox) =>
      listAllDomainRows(this.database, 'RuntimeDelivery', { inbox_item_id: String(inbox.id) })))).flat();
    const activeTurnIdSet = new Set(turns.filter((row) => row.status === 'active').map((row) => String(row.id)));
    const parentIntakes = answerDeliveries.filter((row) => row.state === 'pending'
      && typeof row.target_turn_id === 'string'
      && !targetConversationIds.has(String(row.target_conversation_id))
      && activeTurnIdSet.has(row.target_turn_id));
    const outsideTitles = Object.fromEntries(conversations
      .filter((row) => parentIntakes.some((delivery) => delivery.target_conversation_id === row.id))
      .map((row) => [String(row.id), typeof row.title === 'string' ? row.title : '']));
    const pendingDeliveryIds = [...new Set([...targetDeliveries, ...answerDeliveries]
      .filter((row) => row.state === 'pending').map((row) => String(row.id)))];
    const wakesByDelivery = new Map(await Promise.all(pendingDeliveryIds.map(async (deliveryId) =>
      [deliveryId, await listAllDomainRows(this.database, 'RuntimeDeliveryWake', { delivery_id: deliveryId })] as const)));
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
      childTurnLinks,
      parentLinks,
      parentWaits,
      executingToolCalls,
      queuedIntents,
      deliveries: targetDeliveries,
      answerBridges,
      answerSubmissions,
      answerInboxItems,
      answerDeliveries,
      parentIntakes,
      outsideTitles,
      wakesByDelivery,
      processSources: targetProcessSources,
      processes,
      processReceipts,
      processDispatches
    };
  }

  /** Queued user messages with the revision their cancellation expects; child continuations excluded. */
  private async queuedMessages(intents: DomainRow[]): Promise<Array<{ intent: DomainRow; revisionSeq: string }>> {
    const result: Array<{ intent: DomainRow; revisionSeq: string }> = [];
    for (const intent of intents) {
      const intentId = String(intent.id);
      if ((await listAllDomainRows(this.database, 'ChildExecutionIntentLink', { turn_intent_id: intentId })).length > 0) continue;
      const revisions = await listAllDomainRows(this.database, 'TurnIntentRevision', { intent_id: intentId });
      const revisionSeq = revisions.reduce((maximum, revision) => {
        const seq = BigInt(revision.revision_seq as bigint);
        return seq > maximum ? seq : maximum;
      }, 0n);
      result.push({ intent, revisionSeq: revisionSeq.toString() });
    }
    return result;
  }

  /**
   * The final guard of the deletion transaction's snapshot. Pending results are not live work: they
   * are settled in the transaction (settlementSteps). Everything here is stopped by the deletion
   * command before it deletes.
   */
  private assertSafeToDelete(snapshot: ConversationDeletionSnapshot): void {
    if (snapshot.leases.length > 0 || snapshot.turns.some((row) => row.status === 'active')) {
      throw new ConversationDeletionBlockedError('对话树仍有活动 Turn，需要先停止。');
    }
    if (snapshot.activeChildTurnLinks.length > 0) {
      throw new ConversationDeletionBlockedError('对话树仍有尚未收敛的 Subagent Turn，需要等停止完成。');
    }
    if (snapshot.pendingIntentLinks.length > 0) {
      throw new ConversationDeletionBlockedError('对话树仍有排队中的 Subagent 后续任务，需要先停止。');
    }
    if (snapshot.childExecutions.some((row) => RUNNING_CHILD_STATUSES.has(String(row.status)))) {
      throw new ConversationDeletionBlockedError('对话树仍有活动 Subagent，需要先停止。');
    }
    if (snapshot.parentWaits.length > 0) {
      throw new ConversationDeletionBlockedError('父对话仍在等待这个对话树里的 Subagent，需要先取消等待。');
    }
    if (snapshot.processes.some((row) => row.status === 'running')) {
      throw new ConversationDeletionBlockedError('对话树仍有后台进程运行，需要先终止进程。');
    }
    if (snapshot.parentIntakes.length > 0) {
      throw new ConversationDeletionBlockedError('父对话正在接收这个对话树里 Subagent 的答复，需要等它接收完。');
    }
  }

  private async maybeGet(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    return row && !Array.isArray(row) ? row : null;
  }
}

/**
 * Settles, in the deletion transaction, what is still addressed to the scope or produced by it, the
 * way the collaboration exception does (collaborationDeletion):
 * - a pending RuntimeDelivery addressed to a deleted Conversation fails with `target-gone`;
 * - a pending child answer of the scope addressed to a parent outside it (only the child is deleted)
 *   fails with `source-gone`, and its Inbox item, if it was never routed, is settled;
 * - their unfinished wakes, and the unfinished completion dispatches of the scope's processes, are
 *   dead-lettered, so no Host delivers them afterwards.
 * Exact-id asserts make a result that appears concurrently fail the transaction instead of
 * surviving the deletion.
 */
function settlementSteps(
  snapshot: ConversationDeletionSnapshot,
  settledCollaborationDeliveries: ReadonlySet<string>,
  now: string
): RepositoryTransactionStep[] {
  const steps: RepositoryTransactionStep[] = [];
  const settled = new Set(settledCollaborationDeliveries);
  const scope = new Set(snapshot.conversations.map((row) => String(row.id)));
  const intakes = new Set(snapshot.parentIntakes.map((row) => String(row.id)));
  const failDelivery = (delivery: DomainRow, reason: string): void => {
    const deliveryId = requireId(delivery.id, 'RuntimeDelivery.id');
    if (delivery.state !== 'pending' || settled.has(deliveryId) || intakes.has(deliveryId)) return;
    settled.add(deliveryId);
    steps.push(
      ...failPendingDeliverySteps(delivery, reason, now),
      ...deadLetterDeliveryWakeSteps(deliveryId, snapshot.wakesByDelivery.get(deliveryId) ?? [], reason, now)
    );
  };
  for (const delivery of snapshot.deliveries) failDelivery(delivery, TARGET_GONE_FAILURE_REASON);
  for (const submission of snapshot.answerSubmissions) {
    const submissionId = requireId(submission.id, 'AnswerSubmission.id');
    const inboxItems = snapshot.answerInboxItems.filter((row) => row.source_id === submissionId);
    steps.push(DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').assertExactIds(
      { source_kind: 'answer_submission', source_id: submissionId }, inboxItems.map((row) => String(row.id))));
    for (const inbox of inboxItems) {
      const inboxId = requireId(inbox.id, 'RuntimeInboxItem.id');
      const deliveries = snapshot.answerDeliveries.filter((row) => row.inbox_item_id === inboxId);
      steps.push(DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assertExactIds(
        { inbox_item_id: inboxId }, deliveries.map((row) => String(row.id))));
      for (const delivery of deliveries) {
        failDelivery(delivery, scope.has(String(delivery.target_conversation_id))
          ? TARGET_GONE_FAILURE_REASON
          : ANSWER_SOURCE_GONE_FAILURE_REASON);
      }
      // A never-routed answer loses its AnswerSubmission with the child: nothing may route it later.
      steps.push(...settleAvailableInboxItemSteps(inbox, now));
    }
  }
  for (const receipt of snapshot.processReceipts) {
    const receiptId = requireId(receipt.id, 'ProcessReceipt.id');
    const dispatches = snapshot.processDispatches.filter((row) => row.process_receipt_id === receiptId);
    steps.push(DOMAIN_REPOSITORIES.domain('ProcessCompletionDispatch').assertExactIds(
      { process_receipt_id: receiptId }, dispatches.map((row) => String(row.id))));
    for (const dispatch of dispatches) {
      steps.push(...deadLetterProcessCompletionDispatchSteps(dispatch, TARGET_GONE_FAILURE_REASON, now));
    }
  }
  for (const inboxId of new Set(snapshot.answerDeliveries.map((row) => String(row.inbox_item_id)))) {
    steps.push(DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assertNone({ inbox_item_id: inboxId, state: 'pending' }));
  }
  return steps;
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
