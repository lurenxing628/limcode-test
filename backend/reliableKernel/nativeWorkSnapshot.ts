import type Database from 'better-sqlite3';
import type { DomainRow } from './repositories';
import { prepareCached } from './runtimeStatementCache';
import { requireRuntimeId } from './runtimeSqlRows';
import { TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION, TOOL_CALL_EVENT_KIND_NATIVE_DELIVERY } from './nativeToolFacts';
import {
  NATIVE_STEERING_IN_FLIGHT_STATES,
  type NativePendingToolCall,
  type NativePendingWorkInput,
  type NativeSteeringInFlightEntry
} from './nativeWorkTypes';

/**
 * No event-kind index exists in the published epoch. Discovery still visits this Conversation's
 * ToolCalls and their (tool_call_id,event_seq) event ranges; this is NOT an O(pending) SQL claim.
 * Only native calls enter the fact joins, and only pending/invalid facts cross the worker boundary.
 * CROSS JOIN fixes conversation/selector-first discovery rather than a global event-kind scan.
 * MATERIALIZED prevents downstream joins from repeating admission discovery for each fact row.
 */
const NATIVE_PENDING_SQL = `WITH native_calls AS MATERIALIZED (
  SELECT call.id AS tool_call_id, call.tool_name, call.status, call.turn_id,
    turn_owner.status AS turn_status, COUNT(admission.id) AS admission_count
  FROM turn AS turn_owner
  CROSS JOIN tool_call AS call ON call.turn_id = turn_owner.id
  CROSS JOIN tool_call_event AS admission ON admission.tool_call_id = call.id AND admission.event_kind = @admission_kind
  WHERE turn_owner.conversation_id = @conversation_id AND (@turn_id IS NULL OR turn_owner.id = @turn_id)
  GROUP BY call.id
), facts AS (
  SELECT native.*,
    COUNT(DISTINCT link.id) AS link_count, MIN(link.provider_call_id) AS provider_call_id,
    MIN(link.message_id) AS message_id, MIN(link.model_request_id) AS model_request_id,
    COUNT(DISTINCT result.id) AS result_count, MIN(result.id) AS result_id,
    COUNT(DISTINCT delivery.id) AS delivery_count,
    COUNT(DISTINCT call_source.id) AS call_source_count, MIN(call_source.segment_id) AS call_segment_id,
    COUNT(DISTINCT result_source.id) AS result_source_count, MIN(result_source.segment_id) AS result_segment_id
  FROM native_calls AS native
  LEFT JOIN tool_call_source_link AS link ON link.tool_call_id = native.tool_call_id
  LEFT JOIN tool_model_result AS result ON result.tool_call_id = native.tool_call_id
  LEFT JOIN tool_call_event AS delivery ON delivery.tool_call_id = native.tool_call_id AND delivery.event_kind = @delivery_kind
  LEFT JOIN context_segment_source AS call_source ON call_source.source_kind = 'tool_call' AND call_source.source_id = native.tool_call_id
  LEFT JOIN context_segment_source AS result_source ON result_source.source_kind = 'tool_model_result' AND result_source.source_id = result.id
  GROUP BY native.tool_call_id
)
SELECT * FROM facts WHERE admission_count <> 1 OR link_count <> 1 OR result_count > 1
  OR delivery_count > 1 OR call_source_count > 1 OR result_source_count > 1
  OR result_count = 0 OR call_source_count = 0 OR result_source_count = 0
  OR (@include_undelivered = 1 AND delivery_count = 0)
ORDER BY turn_id, tool_call_id`;

// Preserve a direct Turn primary-key lookup for the frequently used single-Turn delivery pump.
const NATIVE_PENDING_TURN_SQL = NATIVE_PENDING_SQL.replace(
  '(@turn_id IS NULL OR turn_owner.id = @turn_id)', 'turn_owner.id = @turn_id'
);

const NATIVE_STEERING_SQL = `SELECT input.id, input.turn_id, input.state, input.updated_at
  FROM turn AS turn_owner
  CROSS JOIN pending_turn_input AS input ON input.turn_id = turn_owner.id
  WHERE turn_owner.conversation_id = @conversation_id AND input.input_kind = 'native_steer'
    AND input.state IN (SELECT value FROM json_each(@states))
  ORDER BY turn_owner.id, input.id`;

/** Only identities from the current provider window, not every call ever in the Conversation. */
const NATIVE_PROJECTED_ADMISSIONS_SQL = `WITH projected_calls AS MATERIALIZED (
  SELECT DISTINCT call.id AS tool_call_id, call.turn_id
  FROM context_segment_source AS source
  CROSS JOIN tool_call AS call ON source.source_kind = 'tool_call' AND call.id = source.source_id
  CROSS JOIN turn AS turn_owner ON turn_owner.id = call.turn_id
  WHERE source.segment_id IN (SELECT value FROM json_each(@segment_ids))
    AND turn_owner.conversation_id = @conversation_id
)
SELECT projected.tool_call_id, projected.turn_id,
  COUNT(DISTINCT admission.id) AS admission_count,
  COUNT(DISTINCT link.id) AS link_count, MIN(link.provider_call_id) AS provider_call_id,
  COUNT(DISTINCT source.id) AS call_source_count
FROM projected_calls AS projected
CROSS JOIN tool_call_event AS admission ON admission.tool_call_id = projected.tool_call_id AND admission.event_kind = @admission_kind
LEFT JOIN tool_call_source_link AS link ON link.tool_call_id = projected.tool_call_id
LEFT JOIN context_segment_source AS source ON source.source_kind = 'tool_call' AND source.source_id = projected.tool_call_id
GROUP BY projected.tool_call_id`;

/** Caller holds one fenced reader transaction for the whole operation. Never reads CAS. */
export function readNativePendingWork(database: Database.Database, input: NativePendingWorkInput): NativePendingToolCall[] {
  const conversationId = requireRuntimeId(input.conversationId);
  const turnId = input.turnId === undefined ? null : requireRuntimeId(input.turnId);
  if (turnId !== null) {
    const turn = prepareCached(database, 'SELECT conversation_id FROM turn WHERE id = ?').get(turnId) as DomainRow | undefined;
    if (!turn) throw new Error(`Turn ${turnId} does not exist.`);
    if (turn.conversation_id !== conversationId) throw new Error(`Turn ${turnId} belongs to another Conversation.`);
  }
  const pending: NativePendingToolCall[] = [];
  for (const raw of prepareCached(database, turnId === null ? NATIVE_PENDING_SQL : NATIVE_PENDING_TURN_SQL).iterate({
    conversation_id: conversationId, turn_id: turnId,
    admission_kind: TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION, delivery_kind: TOOL_CALL_EVENT_KIND_NATIVE_DELIVERY,
    include_undelivered: input.includeUndelivered === true ? 1 : 0
  })) {
    const row = raw as DomainRow;
    const toolCallId = requireRuntimeId(row.tool_call_id);
    validateAdmission(row, toolCallId);
    if (count(row.result_count) > 1) throw new Error(`ToolCall ${toolCallId} has multiple ToolModelResult rows.`);
    if (count(row.delivery_count) > 1) throw new Error(`ToolCall ${toolCallId} has multiple native delivery events.`);
    if (count(row.call_source_count) > 1) throw new Error(`ToolCall ${toolCallId} has multiple Context occurrences.`);
    if (count(row.result_source_count) > 1) throw new Error(`ToolModelResult ${String(row.result_id)} has multiple Context occurrences.`);
    pending.push({
      toolCallId, toolName: text(row.tool_name, 'ToolCall.tool_name'),
      turnId: requireRuntimeId(row.turn_id), turnActive: row.turn_status === 'active',
      status: text(row.status, 'ToolCall.status'),
      providerCallId: text(row.provider_call_id, 'Native ToolCallSourceLink.provider_call_id'),
      messageId: requireRuntimeId(row.message_id), modelRequestId: requireRuntimeId(row.model_request_id),
      toolModelResultId: optionalId(row.result_id), callContextSegmentId: optionalId(row.call_segment_id),
      resultContextSegmentId: optionalId(row.result_segment_id),
      settled: count(row.result_count) === 1, delivered: count(row.delivery_count) === 1
    });
  }
  return pending;
}

export function readNativeSteeringInFlightSnapshot(
  database: Database.Database, conversationId: string
): NativeSteeringInFlightEntry[] {
  const rows = prepareCached(database, NATIVE_STEERING_SQL).iterate({
    conversation_id: requireRuntimeId(conversationId), states: JSON.stringify(NATIVE_STEERING_IN_FLIGHT_STATES)
  });
  return Array.from(rows, raw => {
    const row = raw as DomainRow;
    return {
      pendingInputId: requireRuntimeId(row.id), turnId: requireRuntimeId(row.turn_id),
      state: row.state as NativeSteeringInFlightEntry['state'], updatedAt: String(row.updated_at)
    };
  });
}

export function readNativeAdmittedProviderCallIds(
  database: Database.Database, conversationId: string, segmentIds: readonly string[]
): string[] {
  requireRuntimeId(conversationId);
  if (!Array.isArray(segmentIds)) throw new TypeError('segmentIds must be an array.');
  const ids = [...new Set(segmentIds.map(requireRuntimeId))];
  const calls = new Map<string, { turnId: string; providerCallId: string }>();
  // The selectors already exist in the provider window. Keep each SQL selector bounded while all
  // chunks observe the same worker read transaction (no per-Turn or per-call IPC).
  for (let offset = 0; offset < ids.length; offset += 200) {
    for (const raw of prepareCached(database, NATIVE_PROJECTED_ADMISSIONS_SQL).iterate({
      conversation_id: conversationId, segment_ids: JSON.stringify(ids.slice(offset, offset + 200)),
      admission_kind: TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION
    })) {
      const row = raw as DomainRow;
      const toolCallId = requireRuntimeId(row.tool_call_id);
      validateAdmission(row, toolCallId);
      if (count(row.call_source_count) !== 1) throw new Error(`ToolCall ${toolCallId} has multiple Context occurrences.`);
      calls.set(toolCallId, {
        turnId: requireRuntimeId(row.turn_id), providerCallId: text(row.provider_call_id, 'Native ToolCallSourceLink.provider_call_id')
      });
    }
  }
  // Preserve the former Turn-id/ToolCall-id order, including duplicate provider ids of different requests.
  return [...calls.entries()].sort(([leftId, left], [rightId, right]) =>
    compare(left.turnId, right.turnId) || compare(leftId, rightId)).map(([, call]) => call.providerCallId);
}

function validateAdmission(row: DomainRow, toolCallId: string): void {
  if (count(row.admission_count) !== 1) throw new Error(`ToolCall ${toolCallId} has multiple native admission events.`);
  if (count(row.link_count) !== 1) throw new Error(`Native ToolCall ${toolCallId} lacks its unique ToolCallSourceLink.`);
}
function count(value: unknown): number {
  if (typeof value !== 'bigint' && typeof value !== 'number') throw new TypeError('Native fact count must be an integer.');
  return Number(value);
}
function optionalId(value: unknown): string | undefined { return value === null ? undefined : requireRuntimeId(value); }
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
