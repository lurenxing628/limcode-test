import type Database from 'better-sqlite3';
import { createConversationRuntimeWorkProbe } from './conversationRuntimePendingWork';

/**
 * Read-only classification of unfinished work in a data-set snapshot, shared by the merge (main
 * thread) and the snapshot audit worker. Kept free of RuntimeDatabase and the control planes so
 * the worker loads only SQLite and these probes. See runtimeDataSetMergeWork for the handling.
 */
export interface UnfinishedWorkRefusal {
  label: string;
  count: number;
}

export interface FinalizableTurn {
  turnId: string;
  conversationId: string;
  hasLease: boolean;
  terminalStatus: 'cancelled' | 'interrupted';
  modelRequestIds: string[];
  pendingToolCallIds: string[];
}

export interface FinalizableIntent {
  intentId: string;
  conversationId: string;
  expectedRevisionSeq: string;
}

export interface UnfinishedWorkInspection {
  refused: UnfinishedWorkRefusal[];
  turns: FinalizableTurn[];
  intents: FinalizableIntent[];
}

type Probe = readonly [label: string, sql: string];

/** Terminal-state interrupt inputs that the ordinary interrupted terminal transition consumes. */
const CONSUMED_INTERRUPT_KINDS = "('interrupt_request', 'termination_request')";

/** Top-level active Turns that the existing terminal transitions can close on their own. */
const FINALIZABLE_TURN_SQL = `
  turn.status = 'active'
  AND NOT EXISTS(SELECT 1 FROM turn_termination AS termination WHERE termination.turn_id = turn.id)
  AND NOT EXISTS(SELECT 1 FROM child_execution_active_turn_link AS link WHERE link.turn_id = turn.id)
  AND NOT EXISTS(SELECT 1 FROM child_execution_turn_link AS link WHERE link.turn_id = turn.id)
  AND NOT EXISTS(
    SELECT 1 FROM pending_turn_input AS input
     WHERE input.turn_id = turn.id AND input.state = 'pending' AND input.input_kind NOT IN ${CONSUMED_INTERRUPT_KINDS}
  )
  AND NOT EXISTS(
    SELECT 1 FROM tool_call AS tool
     WHERE tool.turn_id = turn.id AND tool.status <> 'terminal'
       AND (tool.status <> 'pending' OR EXISTS(SELECT 1 FROM operation WHERE operation.tool_call_id = tool.id)
         OR EXISTS(SELECT 1 FROM file_change_set AS change WHERE change.tool_call_id = tool.id))
  )`;

const RUNNING_PROCESS_SQL = `
  SELECT COUNT(*) FROM process
   WHERE status NOT IN ('exited', 'cancelled', 'timed_out', 'output_limit_exceeded')`;

/** Output that is not fully registered would be re-read from the source-local process spool. */
const UNREGISTERED_PROCESS_OUTPUT_SQL = `
  SELECT COUNT(*) FROM (
    SELECT process.id
      FROM process
      LEFT JOIN process_output_chunk AS chunk ON chunk.process_id = process.id
     GROUP BY process.id, process.retained_chunks, process.retained_bytes
    HAVING COUNT(chunk.id) <> process.retained_chunks
        OR COALESCE(SUM(chunk.byte_length), 0) <> process.retained_bytes
        OR (process.retained_chunks > 0 AND MIN(chunk.chunk_seq) <> 1)
        OR (process.retained_chunks > 0 AND MAX(chunk.chunk_seq) <> process.retained_chunks)
  )`;

/**
 * Global refusal probes. Each counts work that has no existing terminal transition usable
 * offline. The finalizable forms (closed above) are excluded so that a second inspection after
 * finalization is empty exactly when the source is safe to merge.
 */
const REFUSAL_PROBES: readonly Probe[] = Object.freeze([
  ['进行中的任务（需要人工处理或属于子 Agent）', `
    SELECT COUNT(*) FROM turn WHERE turn.status = 'active' AND NOT (${FINALIZABLE_TURN_SQL})`],
  ['没有对应进行中任务的执行租约', `
    SELECT COUNT(*) FROM execution_lease AS lease
      JOIN turn ON turn.id = lease.turn_id
     WHERE NOT (${FINALIZABLE_TURN_SQL})`],
  ['等待中的子 Agent 任务或续接', `
    SELECT COUNT(*) FROM turn_intent AS intent
     WHERE intent.state = 'queued'
       AND (intent.turn_id IS NOT NULL
         OR EXISTS(SELECT 1 FROM child_execution_intent_link AS link WHERE link.turn_intent_id = intent.id))`],
  ['未处理的任务输入', `
    SELECT COUNT(*) FROM pending_turn_input AS input
      JOIN turn ON turn.id = input.turn_id
     WHERE input.state = 'pending' AND NOT (${FINALIZABLE_TURN_SQL})`],
  ['执行到一半或等待回答/批准的工具调用', `
    SELECT COUNT(*) FROM tool_call AS tool
      JOIN turn ON turn.id = tool.turn_id
     WHERE tool.status <> 'terminal' AND NOT (${FINALIZABLE_TURN_SQL})`],
  ['未完成的工具操作', `
    SELECT COUNT(*) FROM operation
     WHERE operation.status IN ('pending', 'executing', 'waiting_answer')
       AND NOT (operation.owner_kind = 'model_request' AND EXISTS(
         SELECT 1 FROM model_request AS request JOIN turn ON turn.id = request.turn_id
          WHERE request.id = operation.owner_id AND request.status <> 'terminal' AND ${FINALIZABLE_TURN_SQL}))`],
  ['结果未确认的外部操作', `
    SELECT COUNT(*) FROM effect_intent WHERE dispatch_state IN ('pending', 'dispatched')`],
  ['不属于可收尾任务的模型请求', `
    SELECT COUNT(*) FROM model_request AS request
      JOIN turn ON turn.id = request.turn_id
     WHERE request.status <> 'terminal' AND NOT (${FINALIZABLE_TURN_SQL})`],
  ['等待你回答或批准的请求', "SELECT COUNT(*) FROM interaction_request WHERE status = 'pending'"],
  ['等待确认的文件修改', "SELECT COUNT(*) FROM file_change_set WHERE status = 'pending'"],
  ['运行中的子 Agent', `
    SELECT COUNT(*) FROM child_execution AS child
     WHERE child.status IN ('starting', 'active', 'interrupting')
        OR EXISTS(SELECT 1 FROM child_execution_active_turn_link AS link WHERE link.child_execution_id = child.id)
        OR EXISTS(SELECT 1 FROM child_execution_intent_link AS link
                   WHERE link.child_execution_id = child.id AND link.state = 'pending')`],
  // (a) Answer submitted, delivery not yet created: the receiving Runtime would deliver it.
  ['已提交但尚未送达的子 Agent 答案', `
    SELECT COUNT(*) FROM answer_submission AS submission
      LEFT JOIN runtime_inbox_item AS item
        ON item.source_kind = 'answer_submission' AND item.source_id = submission.id
     WHERE item.id IS NULL OR item.state = 'available'`],
  // (b) A completed child task Turn fenced its final output but never submitted its answer.
  ['已完成但答案尚未提交的子 Agent 任务', `
    SELECT COUNT(*) FROM answer_bridge AS bridge
      JOIN child_execution AS child ON child.id = bridge.child_execution_id
      JOIN child_execution_turn_link AS latest ON latest.child_execution_id = child.id
       AND latest.turn_seq = (SELECT MAX(turn_seq) FROM child_execution_turn_link WHERE child_execution_id = child.id)
      JOIN turn ON turn.id = latest.turn_id AND turn.status = 'terminated'
      JOIN turn_termination AS termination ON termination.turn_id = turn.id AND termination.terminal_status = 'completed'
     WHERE bridge.current_submission_id IS NULL AND bridge.status IN ('open', 'submitted')
       AND child.status IN ('active', 'idle')
       AND EXISTS(SELECT 1 FROM turn_final_output_fence AS fence WHERE fence.turn_id = turn.id)
       AND NOT EXISTS(SELECT 1 FROM answer_submission AS submission
                       WHERE submission.answer_bridge_id = bridge.id AND submission.turn_id = turn.id)`],
  // (c) An interrupted child whose cancellation Turn still owes its parent a partial answer.
  ['被中断、仍需生成部分答案的子 Agent', `
    SELECT COUNT(*) FROM answer_bridge AS bridge
     WHERE bridge.status = 'interrupted' AND bridge.current_submission_id IS NULL
       AND EXISTS(
         SELECT 1 FROM child_execution_turn_link AS link
           JOIN turn ON turn.id = link.turn_id AND turn.status = 'terminated'
           JOIN turn_termination AS termination ON termination.turn_id = turn.id
            AND termination.terminal_status IN ('interrupted', 'cancelled')
          WHERE link.child_execution_id = bridge.child_execution_id
            AND EXISTS(SELECT 1 FROM pending_turn_input AS input
                        WHERE input.turn_id = turn.id AND input.input_kind = 'termination_request'))`],
  ['待投递的消息或唤醒', `
    SELECT COUNT(*) FROM runtime_delivery AS delivery
      LEFT JOIN runtime_delivery_wake AS wake ON wake.delivery_id = delivery.id
      LEFT JOIN runtime_inbox_item AS inbox ON inbox.id = delivery.inbox_item_id
      LEFT JOIN collaboration_message AS collaboration
        ON inbox.source_kind = 'collaboration_message' AND collaboration.id = inbox.source_id
     WHERE (delivery.state = 'pending'
         AND NOT (COALESCE(collaboration.mode, '') = 'message' AND delivery.phase = 'next_turn' AND delivery.target_turn_id IS NULL))
        OR wake.state IN ('pending', 'claimed')`],
  ['未处理的协作请求', "SELECT COUNT(*) FROM collaboration_request WHERE state = 'pending'"],
  ['仍在运行或结果未知的后台进程', RUNNING_PROCESS_SQL],
  ['未送达的进程结束通知', "SELECT COUNT(*) FROM process_completion_dispatch WHERE state IN ('pending', 'claimed')"],
  ['进程输出尚未完整登记', UNREGISTERED_PROCESS_OUTPUT_SQL]
]);

/**
 * Read-only classification on a source snapshot. The kernel's own per-Conversation pending-work
 * probe is applied to every Conversation as the final authority: anything it still sees after the
 * named probes counts as refused, so the merge never admits work the receiving Runtime would pick up.
 */
export function inspectUnfinishedWork(source: Database.Database): UnfinishedWorkInspection {
  const refused: UnfinishedWorkRefusal[] = [];
  for (const [label, sql] of REFUSAL_PROBES) {
    const count = Number(source.prepare(sql).pluck().get() as bigint | number);
    if (count > 0) refused.push({ label, count });
  }
  const turns = (source.prepare(`
    SELECT turn.id AS turn_id, turn.conversation_id AS conversation_id,
           EXISTS(SELECT 1 FROM execution_lease AS lease WHERE lease.turn_id = turn.id) AS has_lease,
           EXISTS(SELECT 1 FROM pending_turn_input AS input
                   WHERE input.turn_id = turn.id AND input.state = 'pending') AS has_interrupt
      FROM turn WHERE turn.status = 'active' AND ${FINALIZABLE_TURN_SQL}
     ORDER BY turn.id
  `).all() as Array<{ turn_id: string; conversation_id: string; has_lease: bigint | number; has_interrupt: bigint | number }>)
    .map((row): FinalizableTurn => ({
      turnId: row.turn_id,
      conversationId: row.conversation_id,
      hasLease: Number(row.has_lease) === 1,
      terminalStatus: Number(row.has_interrupt) === 1 ? 'interrupted' : 'cancelled',
      modelRequestIds: source.prepare(
        "SELECT id FROM model_request WHERE turn_id = ? AND status <> 'terminal' ORDER BY request_seq"
      ).pluck().all(row.turn_id) as string[],
      pendingToolCallIds: source.prepare(
        "SELECT id FROM tool_call WHERE turn_id = ? AND status = 'pending' ORDER BY call_seq"
      ).pluck().all(row.turn_id) as string[]
    }));
  const intents = (source.prepare(`
    SELECT intent.id AS intent_id, intent.conversation_id AS conversation_id,
           (SELECT MAX(revision.revision_seq) FROM turn_intent_revision AS revision WHERE revision.intent_id = intent.id) AS revision_seq
      FROM turn_intent AS intent
     WHERE intent.state = 'queued' AND intent.turn_id IS NULL
       AND NOT EXISTS(SELECT 1 FROM child_execution_intent_link AS link WHERE link.turn_intent_id = intent.id)
     ORDER BY intent.created_at, intent.id
  `).all() as Array<{ intent_id: string; conversation_id: string; revision_seq: bigint | number | null }>)
    .map((row): FinalizableIntent => ({
      intentId: row.intent_id,
      conversationId: row.conversation_id,
      expectedRevisionSeq: String(row.revision_seq ?? 0)
    }));
  const finalizedConversations = new Set([...turns, ...intents].map((item) => item.conversationId));
  if (refused.length === 0) {
    const busy = createConversationRuntimeWorkProbe(source);
    let remaining = 0;
    for (const id of source.prepare('SELECT id FROM conversation ORDER BY id').pluck().iterate() as IterableIterator<string>) {
      if (!finalizedConversations.has(id) && busy(id)) remaining += 1;
    }
    if (remaining > 0) refused.push({ label: '其它未结束的对话工作', count: remaining });
  }
  return { refused, turns, intents };
}

export function describeUnfinishedWork(refused: readonly UnfinishedWorkRefusal[]): string {
  return refused.map((item) => `${item.label}×${item.count}`).join('、');
}

export function hasFinalizableWork(inspection: UnfinishedWorkInspection): boolean {
  return inspection.turns.length > 0 || inspection.intents.length > 0;
}

/** What a data-root migration cannot carry as ordinary rows (the source's own recovery closes it). */
export interface CarriedWorkRefusals {
  /** ModelRequests that were receiving a reply: the stream itself is not a Repository row. */
  streamingModelRequests: number;
  /** Background processes still running (or unknown), and output still being registered from the
   *  source-local process spool: both depend on files beside the source database. */
  runningProcesses: number;
}

export function inspectCarriedWork(source: Database.Database): CarriedWorkRefusals {
  const count = (sql: string): number => Number(source.prepare(sql).pluck().get() as bigint | number);
  return {
    streamingModelRequests: count("SELECT COUNT(*) FROM model_request WHERE status NOT IN ('prepared', 'terminal')"),
    runningProcesses: count(RUNNING_PROCESS_SQL) + count(UNREGISTERED_PROCESS_OUTPUT_SQL)
  };
}
