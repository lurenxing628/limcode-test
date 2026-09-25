import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import type { RuntimeDatabase } from './runtimeDatabase';
import { isCrossConversationTool } from '../world/modules/tools/definitions/crossConversation';

export interface CollaborationMember {
  conversationId: string;
  childExecutionId: string | null;
  parentConversationId: string | null;
  status: string;
}
export interface CollaborationScope {
  rootConversationId: string;
  rootTurnId: string | null;
  members: CollaborationMember[];
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

/** Derives membership from committed lineage; never accepts caller-supplied team identities. */
export async function readCollaborationScope(database: RuntimeDatabase, conversationId: string): Promise<CollaborationScope> {
  const read = async (domain: string, id: string): Promise<DomainRow> => {
    const value = (await database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)])).snapshot[0] as DomainRow | null;
    if (!value) throw new Error(`${domain} ${id} does not exist.`);
    return value;
  };
  const roots = new Map<string, { conversationId: string; turnId: string | null; steps: RepositoryTransactionStep[] }>();
  const ancestry = async (id: string, seen = new Set<string>()): Promise<{ conversationId: string; turnId: string | null; steps: RepositoryTransactionStep[] }> => {
    const cached = roots.get(id);
    if (cached) return cached;
    if (seen.has(id)) throw new Error('Collaboration lineage is cyclic.');
    seen.add(id);
    const children = await listAllDomainRows(database, 'ChildExecution', { child_conversation_id: id });
    if (children.length > 1) throw new Error('Conversation has multiple ChildExecutions.');
    if (!children.length) {
      await read('Conversation', id);
      const value = { conversationId: id, turnId: null, steps: [DOMAIN_REPOSITORIES.domain('ChildExecution').assertNone({ child_conversation_id: id })] };
      roots.set(id, value); return value;
    }
    const child = children[0];
    const links = await listAllDomainRows(database, 'ChildExecutionParentLink', { child_execution_id: child.id });
    if (links.length !== 1 || typeof links[0].parent_turn_id !== 'string') throw new Error('Collaboration requires complete child parent lineage.');
    const link = links[0];
    const turn = await read('Turn', String(link.parent_turn_id));
    const parent = await ancestry(String(turn.conversation_id), seen);
    if (link.parent_child_execution_id !== null) {
      const parentChild = await read('ChildExecution', String(link.parent_child_execution_id));
      if (parentChild.child_conversation_id !== turn.conversation_id) throw new Error('Collaboration parent child and Turn identities conflict.');
    }
    const value = {
      conversationId: parent.conversationId,
      turnId: parent.turnId ?? String(link.parent_turn_id),
      steps: [...parent.steps,
        DOMAIN_REPOSITORIES.domain('ChildExecution').assert(String(child.id), { child_conversation_id: id, status: child.status }),
        DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').assert(String(link.id), { child_execution_id: child.id, parent_turn_id: link.parent_turn_id, parent_child_execution_id: link.parent_child_execution_id }),
        DOMAIN_REPOSITORIES.domain('Turn').assert(String(turn.id), { conversation_id: turn.conversation_id })]
    };
    roots.set(id, value); return value;
  };
  const root = await ancestry(conversationId);
  const rootConversation = await read('Conversation', root.conversationId);
  const members: CollaborationMember[] = [{ conversationId: root.conversationId, childExecutionId: null, parentConversationId: null, status: String(rootConversation.status) }];
  // Breadth first queries are bounded by the current team, not the application's global registry.
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    const turns = await listAllDomainRows(database, 'Turn', { conversation_id: member.conversationId });
    for (const turn of turns) {
      const links = await listAllDomainRows(database, 'ChildExecutionParentLink', { parent_turn_id: turn.id });
      for (const link of links) {
        const child = await read('ChildExecution', String(link.child_execution_id));
        const childConversationId = String(child.child_conversation_id);
        if (members.some((entry) => entry.conversationId === childConversationId)) throw new Error('Collaboration lineage contains duplicate membership.');
        if (members.length >= 256) throw new Error('Collaboration team exceeds the 256-member bound.');
        const childRoot = await ancestry(childConversationId);
        if (childRoot.conversationId !== root.conversationId) throw new Error('Collaboration child root identity conflicts.');
        members.push({ conversationId: childConversationId, childExecutionId: String(child.id), parentConversationId: member.conversationId, status: String(child.status) });
      }
    }
  }
  const rootTurns = root.turnId ? [] : await listAllDomainRows(database, 'Turn', { conversation_id: root.conversationId });
  rootTurns.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)));
  const rootAnchor = rootTurns.find((turn) => turn.status === 'active') ?? rootTurns[0];
  return { rootConversationId: root.conversationId, rootTurnId: root.turnId ?? (rootAnchor ? String(rootAnchor.id) : null), members, authoritySteps: root.steps };
}
