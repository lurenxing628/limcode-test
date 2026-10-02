import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';
import { isCrossConversationTool } from '../world/modules/tools/definitions/crossConversation';

export interface CollaborationMember {
  conversationId: string;
  childExecutionId: string | null;
  parentConversationId: string | null;
  status: string;
}
export interface CollaborationIdentity {
  rootConversationId: string;
  rootTurnId: string | null;
  member: CollaborationMember;
  authoritySteps: RepositoryTransactionStep[];
}

/**
 * A followup that a cross-conversation tool sent to another team: a tool send between two distinct
 * top-level Conversations. While the sender exists, its committed ToolCall names the tool that sent
 * it, so deleting a team child target never turns the task into a peer task. A deleted sender takes
 * its ToolCall along; the committed lineage then classifies it: a team followup always has a child
 * task on at least one side, and the cross-conversation tools never originate from or address a
 * child task. The deleted sender has no ChildExecution left and counts as top-level, so its task
 * waits for a Turn of its own like any peer task.
 *
 * Such a followup starts exactly one Turn of its own in the target: no other Turn (a user Turn,
 * another peer's continuation, a process or child continuation) consumes it, and while any Turn
 * runs it keeps waiting. Only such a Turn spends the task's own budget, and only such a task that
 * cannot be answered sends its requester a failure reply; team followups keep their original rules.
 */
export async function isCrossConversationFollowup(database: RuntimeDatabase, messageId: string): Promise<boolean> {
  return isCrossConversationSend(database, messageId, 'followup');
}

/**
 * A tool send between two distinct top-level Conversations by a cross-conversation tool, in the
 * given mode. Classified exactly as isCrossConversationFollowup classifies followups.
 */
export async function isCrossConversationSend(database: RuntimeDatabase, messageId: string, mode: 'message' | 'followup'): Promise<boolean> {
  const read = await database.snapshot([
    DOMAIN_REPOSITORIES.domain('CollaborationMessage').get(messageId),
    DOMAIN_REPOSITORIES.domain('CollaborationMessageSourceLink').list({ where: { message_id: messageId }, limit: 2 }),
    DOMAIN_REPOSITORIES.domain('CollaborationMessageTargetLink').list({ where: { message_id: messageId }, limit: 2 })
  ]);
  const message = read.snapshot[0] as DomainRow | null;
  const sources = read.snapshot[1] as DomainRow[];
  const targets = read.snapshot[2] as DomainRow[];
  if (!message || message.mode !== mode || sources.length !== 1 || targets.length !== 1 || sources[0].source_kind !== 'tool') return false;
  const toolCall = typeof sources[0].tool_call_id === 'string'
    ? (await database.snapshot([DOMAIN_REPOSITORIES.domain('ToolCall').get(sources[0].tool_call_id)])).snapshot[0] as DomainRow | null
    : null;
  if (toolCall) return isCrossConversationTool(String(toolCall.tool_name));
  const sourceConversationId = String(sources[0].conversation_id);
  const targetConversationId = String(targets[0].conversation_id);
  if (sourceConversationId === targetConversationId) return false;
  const children = await database.snapshot([
    DOMAIN_REPOSITORIES.domain('ChildExecution').list({ where: { child_conversation_id: sourceConversationId }, limit: 1 }),
    DOMAIN_REPOSITORIES.domain('ChildExecution').list({ where: { child_conversation_id: targetConversationId }, limit: 1 })
  ]);
  return children.snapshot.every((rows) => Array.isArray(rows) && rows.length === 0);
}

/**
 * Resolves one member through immutable creation ancestry. Historical siblings never participate
 * in authorization or select a new root Turn authority for an existing child.
 */
export async function readCollaborationIdentity(database: RuntimeDatabase, conversationId: string): Promise<CollaborationIdentity> {
  const read = async (domain: string, id: string): Promise<DomainRow> => {
    const value = (await database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)])).snapshot[0] as DomainRow | null;
    if (!value) throw new Error(`${domain} ${id} does not exist.`);
    return value;
  };
  const list = async (domain: string, where: DomainRow): Promise<DomainRow[]> =>
    (await database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({ where, limit: 2 })])).snapshot[0] as DomainRow[];
  const conversation = await read('Conversation', conversationId);
  const steps: RepositoryTransactionStep[] = [];
  const seen = new Set<string>();
  let cursor = conversationId;
  let rootTurnId: string | null = null;
  let member: CollaborationMember | undefined;
  for (;;) {
    if (seen.has(cursor)) throw new Error('Collaboration lineage is cyclic.');
    seen.add(cursor);
    const children = await list('ChildExecution', { child_conversation_id: cursor });
    if (children.length > 1) throw new Error('Conversation has multiple ChildExecutions.');
    if (children.length === 0) {
      await read('Conversation', cursor);
      steps.push(DOMAIN_REPOSITORIES.domain('ChildExecution').assertNone({ child_conversation_id: cursor }));
      member ??= { conversationId, childExecutionId: null, parentConversationId: null, status: String(conversation.status) };
      break;
    }
    const child = children[0];
    const links = await list('ChildExecutionParentLink', { child_execution_id: child.id });
    if (links.length !== 1 || typeof links[0].parent_turn_id !== 'string') throw new Error('Collaboration requires complete child parent lineage.');
    const link = links[0];
    const parentTurn = await read('Turn', String(link.parent_turn_id));
    if (link.parent_child_execution_id !== null) {
      const parentChild = await read('ChildExecution', String(link.parent_child_execution_id));
      if (parentChild.child_conversation_id !== parentTurn.conversation_id) throw new Error('Collaboration parent child and Turn identities conflict.');
    }
    member ??= { conversationId, childExecutionId: String(child.id), parentConversationId: String(parentTurn.conversation_id), status: String(child.status) };
    steps.push(DOMAIN_REPOSITORIES.domain('ChildExecution').assert(String(child.id), { child_conversation_id: cursor, status: child.status }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').assert(String(link.id), { child_execution_id: child.id, parent_turn_id: link.parent_turn_id, parent_child_execution_id: link.parent_child_execution_id }),
      DOMAIN_REPOSITORIES.domain('Turn').assert(String(parentTurn.id), { conversation_id: parentTurn.conversation_id }));
    rootTurnId = String(parentTurn.id);
    cursor = String(parentTurn.conversation_id);
  }
  if (rootTurnId === null) {
    const latest = async (where: DomainRow) => (await database.snapshot([DOMAIN_REPOSITORIES.domain('Turn').list({
      where, orderBy: { column: 'created_at', direction: 'desc' }, limit: 1
    })])).snapshot[0] as DomainRow[];
    const active = await latest({ conversation_id: cursor, status: 'active' });
    const anchor = active[0] ?? (await latest({ conversation_id: cursor }))[0];
    rootTurnId = anchor ? String(anchor.id) : null;
  }
  return { rootConversationId: cursor, rootTurnId, member, authoritySteps: steps };
}
