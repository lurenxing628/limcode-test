import type { RuntimeCommitResult } from '../../reliableKernel/contracts';
import { DOMAIN_REPOSITORIES } from '../../reliableKernel/repositories';
import type { RuntimeDatabase } from '../../reliableKernel/runtimeDatabase';
import type { TaskCompletedPayload } from '../../../shared/protocol';

// These are final model answers. Queued-input handoffs and maintenance also end Turns, but are
// not task completion. Only local commits notify, so a peer window never plays a second sound.
const FINAL_ANSWER_REASONS = new Set([
  'model_completed_without_tool_calls', 'model_completed_with_open_tasks', 'native_logical_request_completed'
]);

export async function completedMainTasks(
  database: RuntimeDatabase,
  commit: RuntimeCommitResult
): Promise<TaskCompletedPayload[]> {
  if (commit.observedExternal) return [];
  const completed: TaskCompletedPayload[] = [];
  for (const change of commit.changes) {
    const record = change.record;
    if (change.domain !== 'TurnTermination' || change.kind !== 'upsert'
      || record?.terminal_status !== 'completed' || !FINAL_ANSWER_REASONS.has(String(record.reason))) continue;
    const turnId = String(record.turn_id);
    const turn = commit.changes.find(item => item.domain === 'Turn' && item.id === turnId)?.record;
    if (!turn || typeof turn.conversation_id !== 'string') continue;
    const childLinks = await database.snapshot([
      DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').list({ where: { turn_id: turnId }, limit: 1 })
    ]);
    if ((childLinks.snapshot[0] as unknown[]).length > 0) continue;
    completed.push({ turnId, conversationId: turn.conversation_id });
  }
  return completed;
}
