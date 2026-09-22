import type Database from 'better-sqlite3';

/**
 * A single reader snapshot decides whether an owner may be released. The result is bounded, not the
 * history being searched: an old background process or an answer-to-delivery gap still retains its
 * conversation. Terminal history and completed foreground processes do not retain an owner.
 */
export function createConversationRuntimeWorkProbe(database: Database.Database): (conversationId: string) => boolean {
  const statement = database.prepare(`
    WITH conversation_turns AS (
      SELECT id FROM turn WHERE conversation_id = @conversationId
    ), relevant_children AS (
      SELECT id FROM child_execution WHERE child_conversation_id = @conversationId
      UNION
      SELECT parent.child_execution_id
        FROM child_execution_parent_link AS parent
        JOIN conversation_turns AS source_turn ON source_turn.id = parent.parent_turn_id
    )
    SELECT CASE
      WHEN EXISTS(SELECT 1 FROM execution_lease WHERE conversation_id = @conversationId) THEN 1
      WHEN EXISTS(SELECT 1 FROM turn WHERE conversation_id = @conversationId AND status = 'active') THEN 1
      WHEN EXISTS(
        SELECT 1 FROM turn_intent
         WHERE conversation_id = @conversationId AND state = 'queued' AND turn_id IS NULL
      ) THEN 1
      WHEN EXISTS(
        SELECT 1 FROM pending_turn_input AS input
          JOIN conversation_turns AS source_turn ON source_turn.id = input.turn_id
         WHERE input.state = 'pending'
      ) THEN 1
      WHEN EXISTS(
        SELECT 1 FROM tool_call AS tool
          JOIN conversation_turns AS source_turn ON source_turn.id = tool.turn_id
         WHERE NOT EXISTS(SELECT 1 FROM tool_model_result AS result WHERE result.tool_call_id = tool.id)
      ) THEN 1
      WHEN EXISTS(
        SELECT 1 FROM operation AS operation_row
          JOIN tool_call AS tool ON tool.id = operation_row.tool_call_id
          JOIN conversation_turns AS source_turn ON source_turn.id = tool.turn_id
         WHERE operation_row.status IN ('pending', 'executing', 'waiting_answer')
      ) THEN 1
      WHEN EXISTS(
        SELECT 1 FROM runtime_delivery AS delivery
          LEFT JOIN runtime_delivery_wake AS wake ON wake.delivery_id = delivery.id
          LEFT JOIN runtime_inbox_item AS inbox ON inbox.id = delivery.inbox_item_id
          LEFT JOIN collaboration_message AS collaboration
            ON inbox.source_kind = 'collaboration_message' AND collaboration.id = inbox.source_id
         WHERE delivery.target_conversation_id = @conversationId
           AND ((delivery.state = 'pending'
             AND NOT (COALESCE(collaboration.mode, '') = 'message' AND delivery.phase = 'next_turn' AND delivery.target_turn_id IS NULL))
             OR wake.state IN ('pending', 'claimed'))
      ) THEN 1
      WHEN EXISTS(
        SELECT 1 FROM relevant_children AS relevant
          JOIN child_execution AS child ON child.id = relevant.id
          LEFT JOIN child_execution_active_turn_link AS active_turn ON active_turn.child_execution_id = child.id
          LEFT JOIN child_execution_intent_link AS intent
            ON intent.child_execution_id = child.id AND intent.state = 'pending'
         WHERE child.status IN ('starting', 'active', 'interrupting')
            OR active_turn.id IS NOT NULL OR intent.id IS NOT NULL
      ) THEN 1
      WHEN EXISTS(
        SELECT 1 FROM relevant_children AS child
          JOIN answer_bridge AS bridge ON bridge.child_execution_id = child.id
          JOIN answer_submission AS submission ON submission.answer_bridge_id = bridge.id
          LEFT JOIN runtime_inbox_item AS item
            ON item.source_kind = 'answer_submission' AND item.source_id = submission.id
         WHERE item.id IS NULL OR item.state = 'available'
      ) THEN 1
      WHEN EXISTS(
        SELECT 1 FROM process_completion_source_link AS source
          JOIN process AS process_row ON process_row.id = source.process_id
          LEFT JOIN process_receipt AS receipt ON receipt.process_id = process_row.id
          LEFT JOIN process_completion_dispatch AS dispatch ON dispatch.process_receipt_id = receipt.id
         WHERE source.conversation_id = @conversationId AND (
           process_row.status = 'running' OR receipt.id IS NULL
           OR dispatch.state IN ('pending', 'claimed')
           OR (dispatch.id IS NULL AND EXISTS(
             SELECT 1 FROM operation AS exit_operation
               JOIN attempt AS exit_attempt ON exit_attempt.operation_id = exit_operation.id
               JOIN effect_intent AS exit_intent ON exit_intent.attempt_id = exit_attempt.id
              WHERE exit_operation.owner_kind = 'process' AND exit_operation.owner_id = process_row.id
                AND exit_operation.tool_call_id IS NULL AND exit_intent.effect_kind = 'process_exit'
           ))
           OR EXISTS(
             SELECT 1 FROM operation AS operation_row
              WHERE operation_row.owner_kind = 'process' AND operation_row.owner_id = process_row.id
                AND operation_row.tool_call_id IS NULL
                AND operation_row.status IN ('pending', 'executing', 'waiting_answer')
           )
           OR process_row.retained_chunks > (
             SELECT COUNT(*) FROM process_output_chunk AS chunk WHERE chunk.process_id = process_row.id
           )
           OR process_row.retained_bytes > (
             SELECT COALESCE(SUM(chunk.byte_length), 0)
               FROM process_output_chunk AS chunk WHERE chunk.process_id = process_row.id
           )
         )
      ) THEN 1
      WHEN EXISTS(
        SELECT 1 FROM process_completion_source_link AS source
          JOIN child_interruption_turn_link AS interruption ON interruption.turn_id = source.source_turn_id
          LEFT JOIN child_interruption_process_cleanup AS cleanup
            ON cleanup.interruption_request_id = interruption.interruption_request_id
           AND cleanup.process_id = source.process_id
         WHERE source.conversation_id = @conversationId
           AND (cleanup.id IS NULL OR cleanup.state IN ('pending', 'stop_requested'))
      ) THEN 1
      ELSE 0 END AS busy
  `).safeIntegers(true);
  return (conversationId) => {
    const row = statement.get({ conversationId }) as { busy: bigint };
    return row.busy === 1n;
  };
}
