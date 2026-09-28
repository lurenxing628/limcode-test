import type Database from 'better-sqlite3';
import { createConversationRuntimeWorkProbe } from './conversationRuntimePendingWork';
import { prepareCached } from './runtimeStatementCache';

/**
 * Unfinished work a data-root relocation carries unchanged into the new directory while the old
 * directory keeps it as well (migration.json#dataRootRelocation: unfinished work is carried
 * unchanged, the old directory's data is never modified). Everything listed here would run a second
 * time once a Host recovers the old directory ("回到旧目录", or another installation still using it):
 * startup recovery resumes Turns, admits queued input, drives child Agents, dispatches approved
 * effects and delivers pending results.
 *
 * Read-only plain SQL over a data-set snapshot, like runtimeDataSetMergeProbes, so it runs in the
 * snapshot audit worker as well as on any thread that has the copy open. The result is plain JSON
 * for the old directory's moved notice; relocatedWorkSettlement closes the listed Conversations'
 * work in an opened Runtime of the old directory before its startup recovery.
 */
export interface RelocatedConversationWork {
  conversationId: string;
  title: string;
  /** Active Turns, top level and child Agent Turns alike. */
  activeTurnIds: string[];
  /** TurnIntents not admitted yet: queued user messages, runtime and child continuations. */
  queuedIntentIds: string[];
  /** Non-terminal ModelRequests (a relocation carries only ones that never started). */
  unfinishedModelRequestIds: string[];
  /** Questions and approvals waiting for the user. */
  pendingInteractionIds: string[];
  /** Child executions spawned by this Conversation's Turns that still run or wait to be driven. */
  childExecutionIds: string[];
  /** Runtime deliveries (process completions, child answers, collaboration messages) and their wakes. */
  pendingDeliveryIds: string[];
  /** Finished background processes whose completion is not delivered yet. */
  pendingProcessCompletionIds: string[];
  /** Child answers to this Conversation whose delivery was never created. */
  undeliveredAnswerIds: string[];
  /** Tool effects not dispatched yet, or dispatched without a Receipt. */
  unreceiptedEffectIds: string[];
  /** The kernel's own pending-work probe sees work that none of the lists above names. */
  otherRuntimeWork: boolean;
}

export interface RelocatedWorkInventory {
  conversations: RelocatedConversationWork[];
}

type WorkList = Exclude<keyof RelocatedConversationWork, 'conversationId' | 'title' | 'otherRuntimeWork'>;

export const RELOCATED_WORK_LISTS: readonly WorkList[] = Object.freeze([
  'activeTurnIds',
  'queuedIntentIds',
  'unfinishedModelRequestIds',
  'pendingInteractionIds',
  'childExecutionIds',
  'pendingDeliveryIds',
  'pendingProcessCompletionIds',
  'undeliveredAnswerIds',
  'unreceiptedEffectIds'
]);

/** Each query yields (id, conversation_id) pairs; the Conversation is where the work shows. */
const WORK_QUERIES: ReadonlyArray<readonly [WorkList, string]> = Object.freeze([
  ['activeTurnIds', "SELECT id, conversation_id FROM turn WHERE status = 'active'"],
  ['queuedIntentIds', "SELECT id, conversation_id FROM turn_intent WHERE state = 'queued' AND turn_id IS NULL"],
  ['unfinishedModelRequestIds', `
    SELECT request.id, turn.conversation_id
      FROM model_request AS request JOIN turn ON turn.id = request.turn_id
     WHERE request.status <> 'terminal'`],
  ['pendingInteractionIds', `
    SELECT request.id, turn.conversation_id
      FROM interaction_request AS request
      JOIN interaction_owner_link AS owner ON owner.request_id = request.id
      JOIN turn ON turn.id = owner.turn_id
     WHERE request.status = 'pending'`],
  ['childExecutionIds', `
    SELECT child.id, parent_turn.conversation_id
      FROM child_execution AS child
      JOIN child_execution_parent_link AS parent ON parent.child_execution_id = child.id
      JOIN turn AS parent_turn ON parent_turn.id = parent.parent_turn_id
     WHERE child.status IN ('starting', 'active', 'interrupting')
        OR EXISTS(SELECT 1 FROM child_execution_active_turn_link AS link WHERE link.child_execution_id = child.id)
        OR EXISTS(SELECT 1 FROM child_execution_intent_link AS link
                   WHERE link.child_execution_id = child.id AND link.state = 'pending')`],
  // The same selection as the kernel's pending-work probe: a plain peer message waiting for the
  // target's next Turn opens nothing by itself unless it has a wake.
  ['pendingDeliveryIds', `
    SELECT delivery.id, delivery.target_conversation_id
      FROM runtime_delivery AS delivery
      LEFT JOIN runtime_delivery_wake AS wake ON wake.delivery_id = delivery.id
      LEFT JOIN runtime_inbox_item AS inbox ON inbox.id = delivery.inbox_item_id
      LEFT JOIN collaboration_message AS collaboration
        ON inbox.source_kind = 'collaboration_message' AND collaboration.id = inbox.source_id
     WHERE (delivery.state = 'pending'
         AND NOT (COALESCE(collaboration.mode, '') = 'message' AND delivery.phase = 'next_turn' AND delivery.target_turn_id IS NULL))
        OR wake.state IN ('pending', 'claimed')`],
  ['pendingProcessCompletionIds', `
    SELECT dispatch.id, source.conversation_id
      FROM process_completion_dispatch AS dispatch
      JOIN process_receipt AS receipt ON receipt.id = dispatch.process_receipt_id
      JOIN process_completion_source_link AS source ON source.process_id = receipt.process_id
     WHERE dispatch.state IN ('pending', 'claimed')`],
  ['undeliveredAnswerIds', `
    SELECT submission.id, parent_turn.conversation_id
      FROM answer_submission AS submission
      JOIN answer_bridge AS bridge ON bridge.id = submission.answer_bridge_id
      JOIN child_execution_parent_link AS parent ON parent.child_execution_id = bridge.child_execution_id
      JOIN turn AS parent_turn ON parent_turn.id = parent.parent_turn_id
      LEFT JOIN runtime_inbox_item AS item
        ON item.source_kind = 'answer_submission' AND item.source_id = submission.id
     WHERE item.id IS NULL OR item.state = 'available'`],
  ['unreceiptedEffectIds', `
    SELECT intent.id, turn.conversation_id
      FROM effect_intent AS intent
      JOIN attempt ON attempt.id = intent.attempt_id
      JOIN operation ON operation.id = attempt.operation_id
      JOIN tool_call ON tool_call.id = operation.tool_call_id
      JOIN turn ON turn.id = tool_call.turn_id
     WHERE intent.dispatch_state IN ('pending', 'dispatched')`]
]);

/**
 * Every Conversation of the data set with work a Host would resume or execute on its own, listed
 * with that work. The kernel's pending-work probe is the final authority, so a Conversation it sees
 * as busy is listed even when none of the named lists applies (`otherRuntimeWork`). Fixed SQL
 * through the connection's statement cache (a connection without one prepares fresh); run it in one
 * read transaction for a single snapshot.
 */
export function inventoryRelocatedWork(source: Database.Database): RelocatedWorkInventory {
  const byConversation = new Map<string, Map<WorkList, Set<string>>>();
  const lists = (conversationId: string): Map<WorkList, Set<string>> => {
    let entry = byConversation.get(conversationId);
    if (!entry) {
      entry = new Map(RELOCATED_WORK_LISTS.map((list) => [list, new Set<string>()]));
      byConversation.set(conversationId, entry);
    }
    return entry;
  };
  for (const [list, sql] of WORK_QUERIES) {
    for (const row of prepareCached(source, sql, { rows: 'raw' }).iterate() as IterableIterator<[unknown, unknown]>) {
      lists(String(row[1])).get(list)!.add(String(row[0]));
    }
  }
  const busy = createConversationRuntimeWorkProbe(source, { cached: true });
  const conversations: RelocatedConversationWork[] = [];
  const titles = prepareCached(source, 'SELECT id, title FROM conversation ORDER BY id', { rows: 'raw' })
    .iterate() as IterableIterator<[string, string]>;
  for (const [conversationId, title] of titles) {
    const named = byConversation.get(conversationId);
    const hasNamedWork = named !== undefined && [...named.values()].some((ids) => ids.size > 0);
    const otherRuntimeWork = !hasNamedWork && busy(conversationId);
    if (!hasNamedWork && !otherRuntimeWork) continue;
    const entry = named ?? lists(conversationId);
    conversations.push({
      conversationId,
      title,
      ...Object.fromEntries(RELOCATED_WORK_LISTS.map((list) => [list, [...entry.get(list)!].sort()])) as Record<WorkList, string[]>,
      otherRuntimeWork
    });
  }
  return { conversations };
}

/** Reads an inventory back from JSON (the moved notice); anything else is rejected. */
export function parseRelocatedWorkInventory(value: unknown): RelocatedWorkInventory {
  const record = value as { conversations?: unknown } | null;
  if (!record || typeof record !== 'object' || !Array.isArray(record.conversations)) {
    throw new TypeError('迁走工作清单格式不正确：缺少 conversations。');
  }
  const seen = new Set<string>();
  const conversations = record.conversations.map((item, index): RelocatedConversationWork => {
    const entry = item as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object') throw new TypeError(`迁走工作清单第 ${index + 1} 项不是对象。`);
    const conversationId = entry.conversationId;
    if (typeof conversationId !== 'string' || conversationId.length === 0 || seen.has(conversationId)) {
      throw new TypeError(`迁走工作清单第 ${index + 1} 项的对话 ID 缺失或重复。`);
    }
    seen.add(conversationId);
    if (typeof entry.title !== 'string' || typeof entry.otherRuntimeWork !== 'boolean') {
      throw new TypeError(`迁走工作清单中对话 ${conversationId} 的标题或 otherRuntimeWork 不正确。`);
    }
    const parsed = { conversationId, title: entry.title, otherRuntimeWork: entry.otherRuntimeWork } as RelocatedConversationWork;
    for (const list of RELOCATED_WORK_LISTS) {
      const ids = entry[list];
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
        throw new TypeError(`迁走工作清单中对话 ${conversationId} 的 ${list} 不正确。`);
      }
      parsed[list] = [...ids as string[]];
    }
    return parsed;
  });
  return { conversations };
}

/** How much work the inventory lists, per kind, for the prompt that offers the settlement. */
export function countRelocatedWork(inventory: RelocatedWorkInventory): Record<WorkList, number> & { conversations: number } {
  const counts = Object.fromEntries(RELOCATED_WORK_LISTS.map((list) => [list, 0])) as Record<WorkList, number>;
  for (const conversation of inventory.conversations) {
    for (const list of RELOCATED_WORK_LISTS) counts[list] += conversation[list].length;
  }
  return { ...counts, conversations: inventory.conversations.length };
}
