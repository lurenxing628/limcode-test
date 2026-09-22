/**
 * Bounded client-facing projection over the runtime database: single-record client summaries used
 * by commit change capture, the atomic active-Conversation snapshot, keyset pages, visible Message
 * history pages and the Conversation history list. The database worker keeps IPC dispatch,
 * transaction control, snapshot barriers and the verified CAS cache; every entry point here
 * receives only a SQLite connection for reads plus the bounded verified-content read capability
 * below. Capacity limits, sequence ordering, pruning, atomicity and error paths are unchanged
 * from the original worker implementation.
 */
import type Database from 'better-sqlite3';
import type { ActiveTurnWorkEnvironmentProjection } from '../../shared/reliableKernelClientFeed';
import type { SnapshotBarrier } from './contracts';
import {
  CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE,
  CLIENT_MESSAGE_WINDOW_LIMIT,
  CLIENT_PAGE_MAX_BYTES,
  CLIENT_PAGE_MAX_ROWS,
  CLIENT_TOOL_EVENT_SUMMARY_LIMIT_PER_CALL,
  CLIENT_WINDOW_RECORD_SUMMARY_MAX_BYTES
} from './clientFeedBounds';
import {
  boundClientRecordSummary,
  settleClientWireResponseBytes
} from './clientWireData';
import {
  approvedSubmitPlanTaskOperation,
  buildCurrentTurnTaskProjection,
  taskListOperationFromSettledArtifact,
  type CurrentTurnTaskOperationFact
} from './currentTurnTaskProjection';
import type {
  ClientKeysetPageInput,
  ClientKeysetPageResult,
  ClientProjectionSnapshot,
  ClientVisibleMessageHistoryPageInput,
  ClientVisibleMessageHistoryPageResult,
  ConversationHistoryProjectionInput,
  ConversationHistoryProjectionResult
} from './databaseWorkerProtocol';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { quote, requireNonNegativeIntegerString, requireRuntimeId } from './runtimeSqlRows';

/**
 * Verified CAS content reading owned by the database worker. Client projection receives only this
 * bounded read capability; it never sees the worker binding, CAS root path, or cache.
 */
export interface ClientProjectionContentAccess {
  readVerifiedBytes(metadata: DomainRow): Buffer;
}

const TURN_INTENT_CONTENT_TYPE = 'application/vnd.limcode.turn-intent+json';
const CHILD_ACTIVITY_ARGUMENTS_MAX_BYTES = 64 * 1024;
const CHILD_ACTIVITY_SUMMARY_MAX_CHARACTERS = 180;
const TURN_AUTHORITY_PROJECTION_MAX_BYTES = 16 * 1024 * 1024;

export function projectQueuedTurnIntentRecord(database: Database.Database, intentId: string): DomainRow | null {
  const rows = queryPlainRows(database, `
    SELECT intent.*,
           (
             SELECT CAST(revision.revision_seq AS TEXT)
               FROM turn_intent_revision AS revision
              WHERE revision.intent_id = intent.id
              ORDER BY revision.revision_seq DESC
              LIMIT 1
           ) AS current_revision_seq
      FROM turn_intent AS intent
     WHERE intent.id = @intentId
       AND intent.state = 'queued'
       AND intent.turn_id IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM child_execution_intent_link AS child_link
          WHERE child_link.turn_intent_id = intent.id
       )
     LIMIT 1
  `, { intentId });
  return rows[0] ?? null;
}

export function projectConversationContextStatusRecord(database: Database.Database, headId: string): DomainRow {
  const record = queryPlainRows(database, `
    SELECT head.id,
           head.conversation_id,
           head.root_id,
           root.root_seq,
           root.segment_count,
           root.estimated_tokens,
           root.created_at AS root_created_at,
           head.updated_at
      FROM conversation_context_head_link AS head
      JOIN context_sequence_root AS root ON root.id = head.root_id
     WHERE head.id = @headId
     LIMIT 1
  `, { headId })[0];
  if (!record) throw new Error(`ConversationContextStatus ${headId} cannot resolve its current root.`);
  return record;
}

export function projectConversationCommandReceiptRecord(database: Database.Database, receiptId: string): DomainRow {
  const record = queryPlainRows(database, `
    SELECT id,
           conversation_id,
           source_key AS command_id,
           created_at
      FROM command_receipt
     WHERE id = @receiptId
       AND source_kind = 'command'
       AND conversation_id IS NOT NULL
     LIMIT 1
  `, { receiptId })[0];
  if (!record) {
    throw new Error(`ConversationCommandReceipt ${receiptId} cannot resolve its durable command receipt.`);
  }
  return record;
}

export function projectCompressionBlockRecord(database: Database.Database, blockId: string): DomainRow {
  const record = queryPlainRows(database, `
    SELECT block.*,
           COUNT(source.id) AS source_count,
           (
             SELECT revision.message_id
               FROM compression_block_source AS anchor_source
               JOIN context_segment_source AS segment_source
                 ON segment_source.segment_id = anchor_source.segment_id
                AND segment_source.source_kind = 'message_revision'
               JOIN message_revision AS revision ON revision.id = segment_source.source_id
               JOIN message_part_of_conversation AS anchor_membership
                 ON anchor_membership.message_id = revision.message_id
                AND anchor_membership.conversation_id = block.conversation_id
              WHERE anchor_source.compression_block_id = block.id
              ORDER BY anchor_source.position DESC, anchor_source.id DESC
              LIMIT 1
           ) AS anchor_message_id
      FROM compression_block AS block
      LEFT JOIN compression_block_source AS source ON source.compression_block_id = block.id
     WHERE block.id = @blockId
     GROUP BY block.id
     LIMIT 1
  `, { blockId })[0];
  if (!record) throw new Error(`CompressionBlock ${blockId} cannot resolve its bounded summary.`);
  return record;
}

export function projectMessageWindowRecord(database: Database.Database, messageId: string): DomainRow | null {
  const rows = queryPlainRows(database, `
    SELECT message.id,
           membership.conversation_id,
           membership.message_seq,
           message.created_at,
           message.updated_at,
           message.deleted_at,
           revision.id AS revision_id,
           revision.revision_seq,
           revision.role,
           revision.content_object_id,
           content.content_type,
           content.byte_length
      FROM message
      JOIN message_part_of_conversation AS membership ON membership.message_id = message.id
      JOIN message_current_revision_link AS current_revision ON current_revision.message_id = message.id
      JOIN message_revision AS revision ON revision.id = current_revision.revision_id
      JOIN content_object AS content ON content.id = revision.content_object_id
     WHERE message.id = @messageId
     LIMIT 1
  `, { messageId });
  if (rows.length > 1) throw new Error(`Message ${messageId} has multiple client window projections.`);
  return rows[0] ?? null;
}

/**
 * A retry/edit-and-run Turn deliberately reuses the source Message instead of creating a second
 * input MessageTurnLink. Surface that already-durable TurnIntent relation in the bounded client
 * projection so process-local provider output has an exact timeline anchor before its final model
 * Message exists. Historical/terminal Turns do not need the enrichment.
 */
export function projectTurnClientRecord(
  database: Database.Database,
  turnId: string,
  content: ClientProjectionContentAccess
): DomainRow {
  const raw = database.prepare('SELECT * FROM turn WHERE id = ?').get(turnId);
  if (!raw) throw new Error(`Turn ${turnId} does not exist.`);
  const record = DOMAIN_REPOSITORIES.codec('Turn').decode(raw as Record<string, unknown>);
  if (record.status !== 'active') return record;

  const sources = database.prepare(`
    SELECT content.*
      FROM turn_intent AS intent
      JOIN turn_intent_revision AS revision ON revision.intent_id = intent.id
      JOIN content_object AS content ON content.id = revision.content_object_id
     WHERE intent.turn_id = ?
       AND revision.revision_seq = (
         SELECT MAX(latest.revision_seq)
           FROM turn_intent_revision AS latest
          WHERE latest.intent_id = intent.id
       )
     LIMIT 2
  `).all(turnId) as Array<Record<string, unknown>>;
  if (sources.length > 1) throw new Error(`Turn ${turnId} has multiple admitted TurnIntents.`);
  if (sources.length === 0) return record;
  const metadata = DOMAIN_REPOSITORIES.codec('ContentObject').decode(sources[0]);
  if (metadata.content_type !== TURN_INTENT_CONTENT_TYPE) return record;

  const parsed = JSON.parse(
    content.readVerifiedBytes(metadata).toString('utf8')
  ) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Turn ${turnId} has an invalid TurnIntent payload.`);
  }
  const intent = parsed as Record<string, unknown>;
  if (intent.kind !== 'retry') return record;
  const sourceMessageId = typeof intent.sourceMessageId === 'string'
    ? intent.sourceMessageId.trim()
    : '';
  // A retry of a synthetic partial ModelRequest can legitimately have only sourceModelRequestId.
  // It has no visible Message to anchor, so leave that Turn unchanged instead of inventing one.
  if (!sourceMessageId) return record;
  const sourceRevisionId = typeof intent.sourceMessageRevisionId === 'string'
    ? intent.sourceMessageRevisionId.trim()
    : typeof intent.editedMessageRevisionId === 'string'
      ? intent.editedMessageRevisionId.trim()
      : '';
  const membership = database.prepare(`
    SELECT membership.conversation_id
      FROM message_part_of_conversation AS membership
     WHERE membership.message_id = ?
     LIMIT 2
  `).all(sourceMessageId) as Array<{ conversation_id: string }>;
  if (membership.length !== 1 || membership[0]?.conversation_id !== record.conversation_id) {
    throw new Error(`Retry Turn ${turnId} source Message does not belong to its Conversation.`);
  }
  return {
    ...record,
    source_message_id: sourceMessageId,
    ...(sourceRevisionId ? { source_message_revision_id: sourceRevisionId } : {})
  };
}

export function projectAnswerBridgeRecord(database: Database.Database, answerBridgeId: string): DomainRow {
  const rows = queryPlainRows(database, `
    SELECT bridge.*,
           submission.submission_seq AS current_submission_seq,
           submission.turn_id AS current_turn_id,
           submission.interrupted AS current_submission_interrupted,
           submission.created_at AS current_submission_created_at,
           payload.id AS current_payload_id,
           payload.title AS current_title,
           payload.byte_length AS current_byte_length
      FROM answer_bridge AS bridge
      LEFT JOIN answer_submission AS submission ON submission.id = bridge.current_submission_id
      LEFT JOIN answer_payload AS payload ON payload.submission_id = submission.id
     WHERE bridge.id = @answerBridgeId
     LIMIT 1
  `, { answerBridgeId });
  if (rows.length !== 1) throw new Error(`AnswerBridge ${answerBridgeId} does not exist.`);
  return rows[0];
}

/**
 * Small parent-facing view of what one child is doing right now. Child Message/ToolCall rows remain
 * outside the parent feed; this record deliberately contains only a bounded activity sentence.
 */
export function projectChildExecutionActivityRecord(
  database: Database.Database,
  childExecutionId: string,
  content: ClientProjectionContentAccess
): DomainRow | null {
  const owner = queryPlainRows(database, `
    SELECT child.id,
           child.status AS child_status,
           child.updated_at AS child_updated_at,
           active.turn_id,
           turn.status AS turn_status,
           turn.updated_at AS turn_updated_at
      FROM child_execution AS child
      LEFT JOIN child_execution_active_turn_link AS active
        ON active.child_execution_id = child.id
      LEFT JOIN turn ON turn.id = active.turn_id
     WHERE child.id = @childExecutionId
     LIMIT 1
  `, { childExecutionId })[0];
  if (!owner) return null;

  const turnId = typeof owner.turn_id === 'string' && owner.turn_status === 'active'
    ? owner.turn_id
    : undefined;
  const childStatus = String(owner.child_status);
  const base: DomainRow = {
    id: childExecutionId,
    child_execution_id: childExecutionId,
    ...(turnId ? { turn_id: turnId } : {}),
    updated_at: String(owner.turn_updated_at ?? owner.child_updated_at)
  };
  if (childStatus === 'interrupting') {
    return { ...base, kind: 'stopping', summary: '正在终止当前子树' };
  }
  if (!turnId) {
    return {
      ...base,
      kind: childStatus === 'starting' ? 'starting' : 'idle',
      summary: childStatus === 'starting' ? '正在启动' : '当前没有活动回合'
    };
  }

  const tool = queryPlainRows(database, `
    SELECT *
      FROM tool_call
     WHERE turn_id = @turnId
       AND status <> 'terminal'
     ORDER BY call_seq DESC, updated_at DESC, id DESC
     LIMIT 1
  `, { turnId })[0];
  if (tool) {
    return {
      ...base,
      kind: 'tool',
      tool_call_id: String(tool.id),
      tool_name: String(tool.tool_name),
      tool_status: String(tool.status),
      summary: childToolActivitySummary(database, tool, content),
      updated_at: String(tool.updated_at)
    };
  }

  const request = queryPlainRows(database, `
    SELECT *
      FROM model_request
     WHERE turn_id = @turnId
       AND status <> 'terminal'
     ORDER BY request_seq DESC, updated_at DESC, id DESC
     LIMIT 1
  `, { turnId })[0];
  if (request) {
    const status = String(request.status);
    return {
      ...base,
      kind: 'model',
      model_request_id: String(request.id),
      model_request_status: status,
      summary: status === 'pending' ? '正在准备模型请求' : '正在思考并生成下一步',
      updated_at: String(request.updated_at)
    };
  }
  return { ...base, kind: 'preparing', summary: '正在整理结果并准备下一步' };
}

function childToolActivitySummary(
  database: Database.Database,
  tool: Record<string, unknown>,
  content: ClientProjectionContentAccess
): string {
  const toolName = String(tool.tool_name);
  const action = childToolAction(toolName);
  const prefix = tool.status === 'pending' ? `等待${action}` : `正在${action}`;
  const detail = childToolArgumentPreview(database, tool, content);
  return compactChildActivitySummary(detail ? `${prefix} · ${detail}` : prefix);
}

function childToolAction(toolName: string): string {
  switch (toolName) {
    case 'bash':
    case 'shell': return '运行命令';
    case 'read':
    case 'read_file': return '读取文件';
    case 'edit': return '编辑文件';
    case 'write': return '写入文件';
    case 'delete': return '删除文件';
    case 'run_agent': return '调度子 Agent';
    case 'submit_agent_answer': return '提交 Agent 回答';
    case 'read_agent_answer': return '读取 Agent 回答';
    case 'ask_user': return '请求用户输入';
    case 'skills': return '载入技能';
    case 'transfer': return '传输文件';
    case 'switch_work_environment': return '切换工作环境';
    case 'update_task_list': return '更新任务清单';
    default: return `调用 ${toolName}`;
  }
}

function childToolArgumentPreview(
  database: Database.Database,
  tool: Record<string, unknown>,
  content: ClientProjectionContentAccess
): string | undefined {
  try {
    const contentObjectId = String(tool.arguments_object_id);
    const raw = database.prepare('SELECT * FROM content_object WHERE id = ?').get(contentObjectId);
    if (!raw) return undefined;
    const metadata = DOMAIN_REPOSITORIES.codec('ContentObject').decode(raw as Record<string, unknown>);
    if (
      typeof metadata.byte_length !== 'bigint'
      || metadata.byte_length > BigInt(CHILD_ACTIVITY_ARGUMENTS_MAX_BYTES)
    ) return undefined;
    const parsed = JSON.parse(content.readVerifiedBytes(metadata).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const args = parsed as Record<string, unknown>;
    const toolName = String(tool.tool_name);
    if ((toolName === 'bash' || toolName === 'shell') && typeof args.command === 'string') {
      return compactChildActivitySummary(args.command);
    }
    if (toolName === 'run_agent' && typeof args.prompt === 'string') {
      return compactChildActivitySummary(args.prompt);
    }
    if (toolName === 'skills' && typeof args.name === 'string') {
      return compactChildActivitySummary(args.name);
    }
    if (Array.isArray(args.paths)) {
      const paths = args.paths.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
      if (paths.length > 0) {
        return compactChildActivitySummary(`${paths[0]}${paths.length > 1 ? ` +${paths.length - 1}` : ''}`);
      }
    }
    for (const key of ['path', 'query', 'pattern', 'title', 'question', 'explanation', 'summary']) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) return compactChildActivitySummary(value);
    }
  } catch {
    // Activity is a best-effort bounded view. Malformed/large arguments remain available only in
    // the child Conversation and must never make a Runtime transaction or parent feed fail.
  }
  return undefined;
}

function compactChildActivitySummary(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > CHILD_ACTIVITY_SUMMARY_MAX_CHARACTERS
    ? `${normalized.slice(0, CHILD_ACTIVITY_SUMMARY_MAX_CHARACTERS - 1)}…`
    : normalized;
}

export function projectProcessRecord(
  database: Database.Database,
  processId: string,
  content: ClientProjectionContentAccess
): DomainRow {
  const raw = database.prepare('SELECT * FROM process WHERE id = ?').get(processId);
  if (!raw) throw new Error(`Process ${processId} does not exist.`);
  const record = DOMAIN_REPOSITORIES.codec('Process').decode(raw as Record<string, unknown>);
  const source = database.prepare(`
    SELECT arguments.*
      FROM process_origin_link AS origin
      JOIN tool_call AS call ON call.id = origin.tool_call_id
      JOIN content_object AS arguments ON arguments.id = call.arguments_object_id
     WHERE origin.process_id = ?
     LIMIT 2
  `).all(processId) as Array<Record<string, unknown>>;
  if (source.length > 1) throw new Error(`Process ${processId} has multiple argument sources.`);
  let requestedBackground = false;
  let commandPreview: string | null = null;
  let argumentsProjectionState: 'ready' | 'missing' | 'error' = source.length === 1 ? 'ready' : 'missing';
  if (source.length === 1) {
    try {
      const metadata = DOMAIN_REPOSITORIES.codec('ContentObject').decode(source[0]);
      const parsed = JSON.parse(content.readVerifiedBytes(metadata).toString('utf8')) as unknown;
      const argumentsRecord = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined;
      requestedBackground = argumentsRecord?.foregroundWaitMs === 0;
      if (typeof argumentsRecord?.command === 'string' && argumentsRecord.command.length > 0) {
        commandPreview = argumentsRecord.command.length <= 240
          ? argumentsRecord.command
          : `${argumentsRecord.command.slice(0, 239)}…`;
      }
    } catch {
      argumentsProjectionState = 'error';
    }
  }
  const detached = database.prepare(`
    SELECT 1
      FROM operation
      JOIN attempt ON attempt.operation_id = operation.id
      JOIN effect_intent ON effect_intent.attempt_id = attempt.id
     WHERE operation.owner_kind = 'process'
       AND operation.owner_id = ?
       AND effect_intent.effect_kind = 'process_exit'
     LIMIT 1
  `).get(processId);
  return {
    ...record,
    background_kind: requestedBackground ? 'requested' : detached ? 'detached' : null,
    command_arguments_state: argumentsProjectionState,
    command_preview: commandPreview
  };
}

export function deriveCommittedParentHandling(
  delivery: DomainRow,
  inputLink: { handled_at: string | null } | null
): 'unhandled' | 'handled' | 'not_applicable' {
  if (delivery.state === 'pending' || delivery.state === 'failed') return 'unhandled';
  if (delivery.state !== 'consumed') throw new Error(`RuntimeDelivery ${String(delivery.id)} has invalid state.`);
  if (delivery.phase === 'notify_only' && inputLink === null) return 'not_applicable';
  if ((delivery.phase === 'current_turn' || delivery.phase === 'next_turn') && inputLink) {
    return inputLink.handled_at === null ? 'unhandled' : 'handled';
  }
  throw new Error(`Consumed RuntimeDelivery ${String(delivery.id)} has an invalid InputLink combination.`);
}

export function executeClientProjectionSnapshot(
  database: Database.Database,
  activeConversationId: string | null,
  commitSeq: bigint,
  content: ClientProjectionContentAccess
): SnapshotBarrier<ClientProjectionSnapshot> {
  const conversationId = activeConversationId === null ? null : requireRuntimeId(activeConversationId);
  database.exec('BEGIN');
  try {
    const conversations = queryPlainRows(database, `
      SELECT id, title, status, created_at, updated_at
        FROM conversation
       ORDER BY updated_at DESC, id DESC
       LIMIT @limit
    `, { limit: BigInt(CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE) });
    const emptyWindow = {
      conversationId,
      messages: [],
      visibleMessageCount: '0',
      lastMessageSeq: '0',
      projectContexts: [],
      conversationProjectLinks: [],
      conversationReuseLinks: [],
      conversationBranchLinks: [],
      conversationOriginLinks: [],
      agentConversationLinks: [],
      commandReceipts: [],
      queuedTurnIntents: [],
      compressionBlocks: [],
      conversationContextStatuses: [],
      taskList: [],
      currentTaskList: null,
      activeTurnWorkEnvironment: null
    };
    const emptyTurns = {
      turns: [], executionLeases: [], turnTerminations: [], turnExecutorLinks: [], modelRequests: [],
      modelContextProjections: [], modelRequestMessageLinks: []
    };
    const emptyTools = {
      messageTurnLinks: [],
      toolCalls: [], toolCallSourceLinks: [], toolCallPolicySnapshots: [], toolCallEvents: [],
      toolExecutions: [], toolOutcomes: [], toolModelResults: [],
      toolResultArtifacts: [], interactionRequests: [], interactionOwnerLinks: [], interactionToolCallLinks: [],
      interactionResponses: [],
      fileChangeSets: [], fileChangeSetMembers: [], fileChangeDecisions: [], fileMutationReceipts: [],
      fileMutationReceiptMembers: [], processes: [], processOriginLinks: [], processOutputChunks: [],
      processReceipts: []
    };
    const emptySubagents = {
      childExecutions: [], childExecutionParentLinks: [], childExecutionTurnLinks: [],
      childExecutionActiveTurnLinks: [], childTurns: [], childExecutionLeases: [], childTurnTerminations: [], childTurnExecutorLinks: [],
      childExecutionActivities: [],
      answerBridges: [], answerSubmissions: [],
      runtimeInboxItems: [], runtimeDeliveries: [], runtimeDeliveryIntentLinks: []
    };
    if (conversationId === null) {
      database.exec('COMMIT');
      return {
        snapshotCommitSeq: commitSeq.toString(),
        snapshot: {
          navigationSummary: { conversations },
          activeConversationWindow: emptyWindow,
          activeTurnSummary: emptyTurns,
          activeToolAndInteractionSummary: emptyTools,
          subagentDeliverySummary: emptySubagents
        }
      };
    }

    const params = { conversationId, limit: BigInt(CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE) };
    const commandReceipts = queryPlainRows(database, `
      SELECT id,
             conversation_id,
             source_key AS command_id,
             created_at
        FROM command_receipt
       WHERE conversation_id = @conversationId
         AND source_kind = 'command'
       ORDER BY created_at DESC, id DESC
       LIMIT @limit
    `, params);
    const queuedTurnIntents = queryPlainRows(database, `
      SELECT intent.*,
             (
               SELECT CAST(revision.revision_seq AS TEXT)
                 FROM turn_intent_revision AS revision
                WHERE revision.intent_id = intent.id
                ORDER BY revision.revision_seq DESC
                LIMIT 1
             ) AS current_revision_seq
        FROM turn_intent AS intent
       WHERE intent.conversation_id = @conversationId
         AND intent.state = 'queued'
         AND intent.turn_id IS NULL
         AND NOT EXISTS (
           SELECT 1
             FROM child_execution_intent_link AS child_link
            WHERE child_link.turn_intent_id = intent.id
         )
       ORDER BY intent.created_at ASC, intent.id ASC
       LIMIT @limit
    `, params);
    const conversationProjectLinks = queryPlainRows(database, `
      SELECT * FROM conversation_project_link
       WHERE conversation_id = @conversationId
       ORDER BY updated_at DESC, id DESC LIMIT @limit
    `, params);
    const projectContexts = queryByIds(
      database,
      'project_context',
      'id',
      conversationProjectLinks.map((row) => String(row.project_context_id))
    );
    const rawMessageRows = queryPlainRows(database, `
      SELECT m.id,
             membership.conversation_id,
             membership.message_seq,
             m.created_at,
             m.updated_at,
             m.deleted_at,
             revision.id AS revision_id,
             revision.revision_seq,
             revision.role,
             revision.content_object_id,
             content.content_type,
             content.byte_length
        FROM message_part_of_conversation AS membership
        JOIN message AS m ON m.id = membership.message_id
        JOIN message_current_revision_link AS current_revision ON current_revision.message_id = m.id
        JOIN message_revision AS revision ON revision.id = current_revision.revision_id
        JOIN content_object AS content ON content.id = revision.content_object_id
       WHERE membership.conversation_id = @conversationId
         AND m.deleted_at IS NULL
         AND revision.role IN ('user', 'model')
       ORDER BY membership.message_seq DESC, m.id DESC
       LIMIT @messageLimit
    `, { conversationId, messageLimit: BigInt(CLIENT_MESSAGE_WINDOW_LIMIT) }).reverse();
    const messageSummary = database.prepare(`
      SELECT COUNT(CASE WHEN m.deleted_at IS NULL AND revision.role IN ('user', 'model') THEN 1 END) AS visible_message_count,
             COALESCE(MAX(membership.message_seq), 0) AS last_message_seq
        FROM message_part_of_conversation AS membership
        JOIN message AS m ON m.id = membership.message_id
        JOIN message_current_revision_link AS current_revision ON current_revision.message_id = m.id
        JOIN message_revision AS revision ON revision.id = current_revision.revision_id
       WHERE membership.conversation_id = ?
    `).get(conversationId) as { visible_message_count: bigint; last_message_seq: bigint };
    const visibleMessageCount = messageSummary.visible_message_count;
    let visibleFloor = visibleMessageCount - BigInt(rawMessageRows.length);
    let messageRows: Array<Record<string, unknown>> = rawMessageRows.map((row) => {
      visibleFloor += 1n;
      return { ...row, display_seq: visibleFloor };
    });
    const reuseLinks = queryPlainRows(database, `
      SELECT * FROM conversation_reuse_link
       WHERE conversation_id = @conversationId
       ORDER BY created_at DESC, id DESC LIMIT @limit
    `, params);
    const branchLinks = queryPlainRows(database, `
      SELECT * FROM conversation_branch_link
       WHERE target_conversation_id = @conversationId OR source_conversation_id = @conversationId
       ORDER BY created_at DESC, id DESC LIMIT @limit
    `, params);
    const originLinks = queryPlainRows(database, `
      SELECT * FROM conversation_origin_link
       WHERE conversation_id = @conversationId OR source_conversation_id = @conversationId
       ORDER BY created_at DESC, id DESC LIMIT @limit
    `, params);
    const agentConversationLinks = queryPlainRows(database, `
      SELECT * FROM agent_conversation_link
       WHERE conversation_id = @conversationId
       ORDER BY updated_at DESC, id DESC LIMIT @limit
    `, params);
    const compressionBlocks = queryPlainRows(database, `
      SELECT block.*,
             COUNT(source.id) AS source_count,
             (
               SELECT revision.message_id
                 FROM compression_block_source AS anchor_source
                 JOIN context_segment_source AS segment_source
                   ON segment_source.segment_id = anchor_source.segment_id
                  AND segment_source.source_kind = 'message_revision'
                 JOIN message_revision AS revision
                   ON revision.id = segment_source.source_id
                 JOIN message_part_of_conversation AS anchor_membership
                   ON anchor_membership.message_id = revision.message_id
                  AND anchor_membership.conversation_id = block.conversation_id
                WHERE anchor_source.compression_block_id = block.id
                ORDER BY anchor_source.position DESC, anchor_source.id DESC
                LIMIT 1
             ) AS anchor_message_id
        FROM compression_block AS block
        LEFT JOIN compression_block_source AS source
          ON source.compression_block_id = block.id
       WHERE block.conversation_id = @conversationId
       GROUP BY block.id
       ORDER BY block.created_at DESC, block.id DESC
       LIMIT @limit
    `, params).reverse();
    const conversationContextStatuses = queryPlainRows(database, `
      SELECT head.id,
             head.conversation_id,
             head.root_id,
             root.root_seq,
             root.segment_count,
             root.estimated_tokens,
             root.created_at AS root_created_at,
             head.updated_at
        FROM conversation_context_head_link AS head
        JOIN context_sequence_root AS root ON root.id = head.root_id
       WHERE head.conversation_id = @conversationId
       ORDER BY head.updated_at DESC, head.id DESC
       LIMIT 1
    `, params);
    const currentTaskList = projectCurrentTaskList(database, conversationId, content);
    let turns = queryClientRootTurns(database, conversationId)
      .map((turn) => turn.status === 'active'
        ? projectTurnClientRecord(database, String(turn.id), content)
        : turn);
    const activeTurnWorkEnvironment = projectActiveTurnWorkEnvironment(database, conversationId, turns, content);

    // Processes and child executions are independently visible summaries. Their active rows are
    // pinned even after their source Message leaves the normal 200-message suffix. The source
    // ToolCall bundle is added below so these roots never point at a clipped owner.
    let processRows = queryClientProcesses(database, conversationId)
      .map((row) => projectProcessRecord(database, String(row.id), content));
    let processIds = processRows.map((row) => String(row.id));
    let processOriginLinks = queryAllByIds(database, 'process_origin_link', 'process_id', processIds);

    let childExecutions = queryClientChildExecutions(database, conversationId);
    let childIds = childExecutions.map((row) => String(row.id));
    let childParentLinks = queryAllByIds(database, 'child_execution_parent_link', 'child_execution_id', childIds);
    const childIdsSourcedFromActiveConversation = new Set(childExecutions
      .filter((row) => row.child_conversation_id !== conversationId)
      .map((row) => String(row.id)));

    const visibleSourceLinks = queryAllByIds(
      database,
      'tool_call_source_link',
      'message_id',
      messageRows.map((row) => String(row.id))
    );
    const pendingInteractionToolLinks = queryPlainRows(database, `
      SELECT tool_link.*
        FROM interaction_tool_call_link AS tool_link
        JOIN interaction_request AS request ON request.id = tool_link.request_id
        JOIN interaction_owner_link AS owner ON owner.request_id = request.id
        JOIN turn ON turn.id = owner.turn_id
       WHERE turn.conversation_id = @conversationId
         AND request.status = 'pending'
       ORDER BY request.created_at ASC, request.id ASC
    `, { conversationId });
    const nonterminalToolCalls = queryPlainRows(database, `
      SELECT call.*
        FROM tool_call AS call
        JOIN turn ON turn.id = call.turn_id
       WHERE turn.conversation_id = @conversationId
         AND call.status <> 'terminal'
       ORDER BY turn.created_at ASC, call.call_seq ASC, call.id ASC
    `, { conversationId });
    // currentTaskList is a self-contained Conversation projection. Do not pin its historical source
    // ToolCall/Message into the bounded live window; a later settled task refreshes the projection
    // when that source is no longer materialized.
    const toolCalls = mergeRowsById([
      ...nonterminalToolCalls,
      ...queryAllByIds(database, 'tool_call', 'id', [
        ...visibleSourceLinks.map((row) => String(row.tool_call_id)),
        ...processOriginLinks.map((row) => String(row.tool_call_id)),
        ...childParentLinks
          .filter((row) => childIdsSourcedFromActiveConversation.has(String(row.child_execution_id)))
          .map((row) => String(row.source_tool_call_id)),
        ...pendingInteractionToolLinks.map((row) => String(row.tool_call_id))
      ])
    ]).sort(compareToolCallRows);
    const toolCallIds = toolCalls.map((row) => String(row.id));

    // Historical Process/Child summaries are retained only while their source ToolCall is in the
    // visible closure. Running/active roots were already included above and therefore remain pinned
    // even if their source Message is older than the ordinary suffix.
    processOriginLinks = mergeRowsById([
      ...processOriginLinks,
      ...queryAllByIds(database, 'process_origin_link', 'tool_call_id', toolCallIds)
    ]);
    processIds = [...new Set(processOriginLinks.map((row) => String(row.process_id)))];
    processRows = queryAllByIds(database, 'process', 'id', processIds)
      .map((row) => projectProcessRecord(database, String(row.id), content))
      .sort((left, right) => String(right.started_at).localeCompare(String(left.started_at)) || String(right.id).localeCompare(String(left.id)));
    const processReceipts = queryAllByIds(database, 'process_receipt', 'process_id', processIds);

    childParentLinks = mergeRowsById([
      ...childParentLinks,
      ...queryAllByIds(database, 'child_execution_parent_link', 'source_tool_call_id', toolCallIds)
    ]);
    childIds = [...new Set(childParentLinks.map((row) => String(row.child_execution_id)))];
    childExecutions = mergeRowsById([
      ...childExecutions,
      ...queryAllByIds(database, 'child_execution', 'id', childIds)
    ]).sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)) || String(right.id).localeCompare(String(left.id)));
    const childConversationIds = childExecutions.map((row) => String(row.child_conversation_id));
    const toolCallSourceLinks = queryAllByIds(database, 'tool_call_source_link', 'tool_call_id', toolCallIds);

    // Nonterminal/background/child roots may originate before the ordinary Message suffix. Pin
    // their exact visible source Message and recompute its absolute visible display rank.
    messageRows = mergeRowsById([
      ...messageRows,
      ...queryVisibleMessageRowsByIds(
        database,
        conversationId,
        toolCallSourceLinks.map((row) => String(row.message_id))
      )
    ]).sort(compareMessageWindowRows);

    const messageTurnLinks = queryAllByIds(
      database,
      'message_turn_link',
      'message_id',
      messageRows.map((row) => String(row.id))
    );
    const modelRequests = mergeRowsById([
      ...queryConversationModelRequests(database, conversationId, messageRows.map((row) => String(row.id))),
      ...queryAllByIds(
        database,
        'model_request',
        'id',
        toolCallSourceLinks.map((row) => String(row.model_request_id))
      )
    ]).sort(compareModelRequestRows);
    const modelContextProjections = queryAllByIds(
      database,
      'model_context_projection',
      'owner_id',
      modelRequests.map((row) => String(row.id))
    ).filter((row) => row.owner_kind === 'model_request');
    const modelRequestMessageLinks = queryAllByIds(
      database,
      'model_request_message_link',
      'model_request_id',
      modelRequests.map((row) => String(row.id))
    ).filter((row) => messageRows.some((message) => message.id === row.message_id));

    // A retained source bundle owns its Turn even when that Turn is older than the normal Turn
    // summary. This is the reverse closure missing from the old per-type query.
    turns = mergeRowsById([
      ...turns,
      ...queryAllByIds(database, 'turn', 'id', [
        ...toolCalls.map((row) => String(row.turn_id)),
        ...modelRequests.map((row) => String(row.turn_id)),
        ...messageTurnLinks.map((row) => String(row.turn_id))
      ])
    ]).sort(compareTurnRows);
    const turnIds = turns.map((row) => String(row.id));
    const leases = queryAllByIds(database, 'execution_lease', 'turn_id', turnIds);
    const terminations = queryAllByIds(database, 'turn_termination', 'turn_id', turnIds);
    const executorLinks = queryAllByIds(database, 'turn_executor_link', 'turn_id', turnIds);

    const toolCallPolicySnapshots = queryAllByIds(database, 'tool_call_policy_snapshot', 'tool_call_id', toolCallIds);
    const toolCallEvents = queryLatestToolCallEvents(database, toolCallIds);
    const toolExecutions = queryAllByIds(database, 'tool_execution', 'tool_call_id', toolCallIds);
    const toolOutcomes = queryAllByIds(database, 'tool_outcome', 'tool_call_id', toolCallIds);
    const toolModelResults = queryAllByIds(database, 'tool_model_result', 'tool_call_id', toolCallIds);
    const toolResultArtifacts = queryAllByIds(database, 'tool_result_artifact', 'tool_call_id', toolCallIds);
    const fileChangeSets = queryAllByIds(database, 'file_change_set', 'tool_call_id', toolCallIds);
    const fileChangeSetIds = fileChangeSets.map((row) => String(row.id));
    const fileChangeSetMembers = queryAllByIds(database, 'file_change_set_member', 'change_set_id', fileChangeSetIds);
    const fileChangeDecisions = queryAllByIds(database, 'file_change_decision', 'change_set_id', fileChangeSetIds);
    const fileMutationReceipts = queryAllByIds(database, 'file_mutation_receipt', 'change_set_id', fileChangeSetIds);
    const fileMutationReceiptMembers = queryAllByIds(
      database,
      'file_mutation_receipt_member',
      'receipt_id',
      fileMutationReceipts.map((row) => String(row.id))
    );
    const taskListCalls = queryPlainRows(database, `
      SELECT call.*
        FROM tool_call AS call
        JOIN turn ON turn.id = call.turn_id
       WHERE turn.conversation_id = @conversationId
         AND call.tool_name = 'update_task_list'
       ORDER BY turn.created_at DESC, call.call_seq DESC, call.id DESC
       LIMIT @limit
    `, params).reverse();
    const taskListOutcomes = queryAllByIds(
      database,
      'tool_outcome',
      'tool_call_id',
      taskListCalls.map((row) => String(row.id))
    );
    const taskList = taskListCalls
      .map((row) => {
        const outcome = taskListOutcomes.find((candidate) => candidate.tool_call_id === row.id) ?? null;
        return {
          tool_call_id: row.id,
          turn_id: row.turn_id,
          call_seq: row.call_seq,
          state: row.status,
          outcome: outcome?.status ?? null,
          ...taskListProjectionFromOutcome(database, outcome, String(row.id), content)
        };
      });
    const selectedInteractionToolCallLinks = mergeRowsById([
      ...pendingInteractionToolLinks,
      ...queryAllByIds(database, 'interaction_tool_call_link', 'tool_call_id', toolCallIds)
    ]);
    const pendingInteractionRequests = queryPlainRows(database, `
      SELECT request.*
        FROM interaction_request AS request
        JOIN interaction_owner_link AS owner ON owner.request_id = request.id
        JOIN turn ON turn.id = owner.turn_id
       WHERE turn.conversation_id = @conversationId
         AND request.status = 'pending'
       ORDER BY request.created_at ASC, request.id ASC
    `, { conversationId });
    const interactionRequestIds = [...new Set([
      ...selectedInteractionToolCallLinks.map((row) => String(row.request_id)),
      ...pendingInteractionRequests.map((row) => String(row.id))
    ])];
    const interactionRequests = mergeRowsById([
      ...pendingInteractionRequests,
      ...queryAllByIds(database, 'interaction_request', 'id', interactionRequestIds)
    ]);
    const interactionOwnerLinks = queryAllByIds(database, 'interaction_owner_link', 'request_id', interactionRequestIds);
    const allInteractionToolCallLinks = queryAllByIds(database, 'interaction_tool_call_link', 'request_id', interactionRequestIds)
      .filter((row) => toolCallIds.includes(String(row.tool_call_id)));
    const interactionResponses = queryAllByIds(database, 'interaction_response', 'request_id', interactionRequestIds);

    const projectedAgentConversationLinks = [
      ...agentConversationLinks,
      ...queryAllByIds(database, 'agent_conversation_link', 'conversation_id', childConversationIds)
    ].filter((row, index, rows) => rows.findIndex((candidate) => candidate.id === row.id) === index);
    const childActiveLinks = queryAllByIds(database, 'child_execution_active_turn_link', 'child_execution_id', childIds);
    const childTurnLinks = queryLatestChildExecutionTurnLinks(database, childIds);
    const childTurnIds = [...new Set([
      ...childTurnLinks.map((row) => String(row.turn_id)),
      ...childActiveLinks.map((row) => String(row.turn_id))
    ])];
    const childTurns = queryAllByIds(database, 'turn', 'id', childTurnIds);
    const childExecutionLeases = queryAllByIds(database, 'execution_lease', 'turn_id', childTurnIds);
    const childTurnTerminations = queryAllByIds(database, 'turn_termination', 'turn_id', childTurnIds);
    const childTurnExecutorLinks = queryAllByIds(database, 'turn_executor_link', 'turn_id', childTurnIds);
    const childExecutionActivities = childExecutions.flatMap((child) => {
      const activity = projectChildExecutionActivityRecord(database, String(child.id), content);
      return activity ? [activity] : [];
    });
    const answerBridges = queryAllByIds(database, 'answer_bridge', 'child_execution_id', childIds)
      .map((bridge) => projectAnswerBridgeRecord(database, String(bridge.id)));
    const bridgeIds = answerBridges.map((row) => String(row.id));
    const answerSubmissions = queryAllByIds(
      database,
      'answer_submission',
      'id',
      answerBridges.flatMap((row) => row.current_submission_id ? [String(row.current_submission_id)] : [])
    );
    const deliveries = queryClientRuntimeDeliveries(database, conversationId);
    const deliveryIds = deliveries.map((row) => String(row.id));
    const deliveryInputLinks = queryAllByIds(database, 'runtime_delivery_input_link', 'delivery_id', deliveryIds);
    const projectedDeliveries = deliveries.map((delivery) => {
      const matching = deliveryInputLinks.filter((link) => link.delivery_id === delivery.id);
      if (matching.length > 1) throw new Error(`RuntimeDelivery ${String(delivery.id)} has multiple input links.`);
      return {
        ...delivery,
        parent_handling_state: deriveCommittedParentHandling(
          delivery,
          matching[0] ? { handled_at: matching[0].handled_at as string | null } : null
        )
      };
    });
    const inboxIds = deliveries.map((row) => String(row.inbox_item_id));
    const inboxItems = queryAllByIds(database, 'runtime_inbox_item', 'id', inboxIds);
    const queuedTurnIntentIds = new Set(queuedTurnIntents.map((row) => String(row.id)));
    const runtimeDeliveryIntentLinks = queryAllByIds(
      database,
      'runtime_delivery_intent_link',
      'delivery_id',
      deliveryIds
    ).filter((link) => queuedTurnIntentIds.has(String(link.turn_intent_id)));

    // Each Conversation sees only its own bounded communication envelope; message bodies stay in CAS.
    const collaborationMessages = queryPlainRows(database, `
      SELECT message.* FROM collaboration_message AS message
       WHERE EXISTS (SELECT 1 FROM collaboration_message_source_link AS source
          WHERE source.message_id = message.id AND source.conversation_id = @conversationId)
          OR EXISTS (SELECT 1 FROM collaboration_message_target_link AS target
          WHERE target.message_id = message.id AND target.conversation_id = @conversationId)
       ORDER BY message.message_seq DESC, message.id DESC LIMIT 32
    `, { conversationId });
    const collaborationIds = collaborationMessages.map(row => String(row.id));
    const collaborationMessageSourceLinks = queryAllByIds(database, 'collaboration_message_source_link', 'message_id', collaborationIds);
    const collaborationMessageTargetLinks = queryAllByIds(database, 'collaboration_message_target_link', 'message_id', collaborationIds);
    const collaborationMessageReplyLinks = queryAllByIds(database, 'collaboration_message_reply_link', 'message_id', collaborationIds);
    const collaborationRequests = queryAllByIds(database, 'collaboration_request', 'message_id', collaborationIds);
    const collaborationRequestTurnLinks = queryAllByIds(database, 'collaboration_request_turn_link', 'request_id', collaborationRequests.map(row => String(row.id)));
    const conversationCommunicationLinks = queryPlainRows(database, `
      SELECT * FROM conversation_communication_link
       WHERE source_conversation_id = @conversationId OR target_conversation_id = @conversationId
       ORDER BY updated_at DESC, id DESC LIMIT 32
    `, { conversationId });

    const snapshot: ClientProjectionSnapshot = {
      navigationSummary: { conversations },
      activeConversationWindow: {
        conversationId,
        messages: messageRows,
        visibleMessageCount,
        lastMessageSeq: messageSummary.last_message_seq,
        projectContexts,
        conversationProjectLinks,
        conversationReuseLinks: reuseLinks,
        conversationBranchLinks: branchLinks,
        conversationOriginLinks: originLinks,
        agentConversationLinks: projectedAgentConversationLinks,
        commandReceipts,
        queuedTurnIntents,
        compressionBlocks,
        conversationContextStatuses,
        taskList,
        currentTaskList,
        activeTurnWorkEnvironment
      },
      activeTurnSummary: {
        turns,
        executionLeases: leases,
        turnTerminations: terminations,
        turnExecutorLinks: executorLinks,
        modelRequests,
        modelContextProjections,
        modelRequestMessageLinks
      },
      activeToolAndInteractionSummary: {
        messageTurnLinks,
        toolCalls,
        toolCallSourceLinks,
        toolCallPolicySnapshots,
        toolCallEvents,
        toolExecutions,
        toolOutcomes,
        toolModelResults,
        toolResultArtifacts,
        interactionRequests,
        interactionOwnerLinks,
        interactionToolCallLinks: allInteractionToolCallLinks,
        interactionResponses,
        fileChangeSets,
        fileChangeSetMembers,
        fileChangeDecisions,
        fileMutationReceipts,
        fileMutationReceiptMembers,
        processes: processRows,
        processOriginLinks,
        // Output bytes and chunk continuity are materialized through the pageable CAS detail
        // reader. Projecting an arbitrary prefix here would make a 200-row window look complete.
        processOutputChunks: [],
        processReceipts
      },
      subagentDeliverySummary: {
        childExecutions,
        childExecutionParentLinks: childParentLinks,
        childExecutionTurnLinks: childTurnLinks,
        childExecutionActiveTurnLinks: childActiveLinks,
        childTurns,
        childExecutionLeases,
        childTurnTerminations,
        childTurnExecutorLinks,
        childExecutionActivities,
        answerBridges,
        answerSubmissions,
        runtimeInboxItems: inboxItems,
        runtimeDeliveries: projectedDeliveries,
        runtimeDeliveryIntentLinks,
        collaborationMessages,
        collaborationMessageSourceLinks,
        collaborationMessageTargetLinks,
        collaborationMessageReplyLinks,
        collaborationRequests,
        collaborationRequestTurnLinks,
        conversationCommunicationLinks
      }
    };
    database.exec('COMMIT');
    return { snapshotCommitSeq: commitSeq.toString(), snapshot };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/** Only this selected Conversation's active Turn may supply the frozen display value. */
export function projectActiveTurnWorkEnvironment(
  database: Database.Database,
  conversationId: string,
  selectedTurns: readonly DomainRow[],
  content: ClientProjectionContentAccess
): ActiveTurnWorkEnvironmentProjection | null {
  // Reuse the active Conversation's existing bounded roots; do not rescan historical Turns.
  const turns = selectedTurns.filter(turn => turn.conversation_id === conversationId && turn.status === 'active');
  if (turns.length === 0) return null;
  if (turns.length !== 1) throw new Error(`Conversation ${conversationId} has multiple active Turns.`);
  const turnId = requireRuntimeId(turns[0].id);
  const authorities = queryPlainRows(database, `
    SELECT content.*
      FROM authority_snapshot AS authority
      JOIN content_object AS content ON content.id = authority.content_object_id
     WHERE authority.turn_id = @turnId
     ORDER BY authority.created_at DESC, authority.id DESC
     LIMIT 2
  `, { turnId });
  // Absence is unknown, never a request to substitute current editable configuration. The UI
  // distinguishes an active Turn with no projection from a Conversation with no active Turn.
  if (authorities.length === 0) return null;
  if (authorities.length !== 1) throw new Error(`Turn ${turnId} has multiple AuthoritySnapshots.`);
  const metadata = DOMAIN_REPOSITORIES.codec('ContentObject').decode(authorities[0]);
  if (typeof metadata.byte_length !== 'bigint' || metadata.byte_length > BigInt(TURN_AUTHORITY_PROJECTION_MAX_BYTES)) {
    throw new Error(`Turn ${turnId} AuthoritySnapshot exceeds the client projection read bound.`);
  }
  const document: unknown = JSON.parse(content.readVerifiedBytes(metadata).toString('utf8'));
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`Turn ${turnId} AuthoritySnapshot is not an object.`);
  }
  const policy = (document as Record<string, unknown>).workEnvironmentPolicy;
  if (policy === undefined || policy === null) return null;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error(`Turn ${turnId} work-environment policy is invalid.`);
  }
  const fields = policy as Record<string, unknown>;
  if (typeof fields.enabled !== 'boolean' || !Array.isArray(fields.allowedWorkEnvironmentIds)) {
    throw new Error(`Turn ${turnId} work-environment policy is incomplete.`);
  }
  const projection: ActiveTurnWorkEnvironmentProjection = {
    conversationId,
    turnId,
    enabled: fields.enabled,
    defaultWorkEnvironmentId: fields.defaultWorkEnvironmentId === null
      ? null
      : requireRuntimeId(fields.defaultWorkEnvironmentId),
    allowedWorkEnvironmentIds: fields.allowedWorkEnvironmentIds.map(requireRuntimeId)
  };
  // Never truncate a boundary: an oversized or malformed frozen policy is not a different policy.
  if (wireJsonBytes(projection) > CLIENT_PAGE_MAX_BYTES) {
    throw new Error(`Turn ${turnId} work-environment policy exceeds the client projection size bound.`);
  }
  return projection;
}

function taskListProjectionFromOutcome(
  database: Database.Database,
  outcome: Record<string, unknown> | null,
  toolCallId: string,
  content: ClientProjectionContentAccess
): { mode?: string; items: unknown[] | null; detail_on_demand: boolean } {
  if (!outcome || outcome.content_object_id === null) return { items: null, detail_on_demand: false };
  if (outcome.status !== 'succeeded') return { items: null, detail_on_demand: false };
  const contentObjectId = requireRuntimeId(outcome.content_object_id);
  const raw = database.prepare('SELECT * FROM content_object WHERE id = ?').get(contentObjectId);
  if (!raw) throw new Error(`Task-list ToolOutcome ${toolCallId} references missing ContentObject ${contentObjectId}.`);
  const metadata = DOMAIN_REPOSITORIES.codec('ContentObject').decode(raw as Record<string, unknown>);
  if (
    typeof metadata.byte_length !== 'bigint'
    || metadata.byte_length > BigInt(CLIENT_WINDOW_RECORD_SUMMARY_MAX_BYTES * 16)
  ) {
    return { items: null, detail_on_demand: true };
  }
  const bytes = content.readVerifiedBytes(metadata);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Task-list ToolOutcome ${toolCallId} content is not JSON: ${String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Task-list ToolOutcome ${toolCallId} content is not an object.`);
  }
  let operation;
  try {
    operation = taskListOperationFromSettledArtifact(value, toolCallId);
  } catch {
    return { items: null, detail_on_demand: true };
  }
  if (!operation) return { items: null, detail_on_demand: false };
  return {
    mode: operation.mode,
    items: operation.items,
    detail_on_demand: false
  };
}

function projectCurrentTaskList(
  database: Database.Database,
  conversationId: string,
  content: ClientProjectionContentAccess
): Record<string, unknown> | null {
  const calls = queryPlainRows(database, `
    SELECT call.id,
           call.turn_id,
           call.call_seq,
           call.tool_name,
           call.arguments_object_id,
           artifact.content_object_id AS artifact_content_object_id,
           source.message_id,
           source.provider_ordinal,
           membership.message_seq
      FROM tool_call AS call
      JOIN turn ON turn.id = call.turn_id
      JOIN tool_result_artifact AS artifact
        ON artifact.tool_call_id = call.id
       AND artifact.role = 'no_effect_result'
      JOIN operation AS task_operation
        ON task_operation.tool_call_id = call.id
       AND task_operation.status = 'succeeded'
      JOIN tool_call_source_link AS source ON source.tool_call_id = call.id
      JOIN message_part_of_conversation AS membership
        ON membership.message_id = source.message_id
       AND membership.conversation_id = turn.conversation_id
      JOIN message ON message.id = membership.message_id
     WHERE turn.conversation_id = @conversationId
       AND message.deleted_at IS NULL
       AND call.tool_name IN ('update_task_list', 'submit_plan')
     ORDER BY membership.message_seq ASC,
              source.provider_ordinal ASC,
              call.call_seq ASC,
              call.id ASC
  `, { conversationId });
  if (calls.length === 0) return null;

  // The task panel is an optional client projection. A pre-hard-cut or malformed artifact must
  // never prevent the bounded Conversation Feed from opening; omit the card without interpreting
  // the old shape. ModelRequest recipe reads remain strict in readCurrentTurnTaskCard().
  try {
    const operations: CurrentTurnTaskOperationFact[] = [];
    for (const call of calls) {
      const toolCallId = String(call.id);
      const artifact = readTaskProjectionJson(
        database,
        call.artifact_content_object_id,
        `Task-list ToolResultArtifact ${toolCallId}`,
        content
      );
      if (call.tool_name === 'update_task_list') {
        const operation = taskListOperationFromSettledArtifact(artifact, toolCallId);
        if (!operation) continue;
        operations.push({
          toolCallId,
          callSeq: String(call.call_seq),
          toolName: 'update_task_list',
          operation,
          sourceTurnId: String(call.turn_id),
          sourceMessageId: String(call.message_id),
          sourceMessageSeq: String(call.message_seq),
          providerOrdinal: String(call.provider_ordinal)
        });
        continue;
      }
      const argumentsValue = readTaskProjectionJson(
        database,
        call.arguments_object_id,
        `submit_plan ToolCall ${toolCallId} arguments`,
        content
      );
      const operation = approvedSubmitPlanTaskOperation({
        argumentsValue,
        resultArtifactValue: artifact,
        toolCallId
      });
      if (!operation) continue;
      operations.push({
        toolCallId,
        callSeq: String(call.call_seq),
        toolName: 'submit_plan',
        operation,
        planApproved: true,
        sourceTurnId: String(call.turn_id),
        sourceMessageId: String(call.message_id),
        sourceMessageSeq: String(call.message_seq),
        providerOrdinal: String(call.provider_ordinal)
      });
    }
    const projection = buildCurrentTurnTaskProjection({
      turnId: String(calls[calls.length - 1].turn_id),
      operations
    });
    if (!projection) return null;
    return {
      conversationId,
      revision: projection.revision,
      operationCount: projection.operationCount,
      sourceToolCallId: projection.sourceToolCallId,
      sourceTurnId: projection.sourceTurnId ?? projection.turnId,
      ...(projection.sourceMessageId ? { sourceMessageId: projection.sourceMessageId } : {}),
      baselineToolCallId: projection.baselineToolCallId,
      items: projection.snapshot.items,
      stats: projection.snapshot.stats,
      ...(projection.snapshot.activeItem ? { activeItem: projection.snapshot.activeItem } : {})
    };
  } catch {
    return null;
  }
}

function readTaskProjectionJson(
  database: Database.Database,
  contentObjectIdValue: unknown,
  label: string,
  content: ClientProjectionContentAccess
): unknown {
  const contentObjectId = requireRuntimeId(contentObjectIdValue);
  const raw = database.prepare('SELECT * FROM content_object WHERE id = ?').get(contentObjectId);
  if (!raw) throw new Error(`${label} references missing ContentObject ${contentObjectId}.`);
  const metadata = DOMAIN_REPOSITORIES.codec('ContentObject').decode(raw as Record<string, unknown>);
  const bytes = content.readVerifiedBytes(metadata);
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`${label} content is not JSON: ${String(error)}`);
  }
}

export function executeConversationHistoryProjection(
  database: Database.Database,
  input: ConversationHistoryProjectionInput,
  commitSeq: bigint
): ConversationHistoryProjectionResult {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > CLIENT_PAGE_MAX_ROWS) {
    throw new RangeError(`Conversation history page limit must be from 1 to ${CLIENT_PAGE_MAX_ROWS}.`);
  }
  if ((input.afterUpdatedAt === undefined) !== (input.afterId === undefined)) {
    throw new TypeError('Conversation history cursor requires both afterUpdatedAt and afterId.');
  }
  if (input.scopeKind === 'project' && !input.projectFolderUri?.trim()) {
    throw new TypeError('Project conversation history requires projectFolderUri.');
  }
  const dataVersion = BigInt(database.pragma('data_version', { simple: true }) as number | bigint);
  const snapshotCommitSeq = `${commitSeq.toString()}:${dataVersion.toString()}`;
  const cursorReset = input.expectedCommitSeq !== undefined && input.expectedCommitSeq !== snapshotCommitSeq;
  const useCursor = !cursorReset && input.afterUpdatedAt !== undefined;
  const scope = conversationHistoryScopeSql(input, 'conversation');
  const cursorSql = useCursor
    ? `AND (conversation.updated_at < @afterUpdatedAt
         OR (conversation.updated_at = @afterUpdatedAt AND conversation.id < @afterId))`
    : '';
  database.exec('BEGIN');
  try {
    const seedCandidates = queryPlainRows(database, `
      SELECT conversation.id, conversation.title, conversation.status,
             conversation.created_at, conversation.updated_at
        FROM conversation
       WHERE ${scope.sql}
             ${cursorSql}
       ORDER BY conversation.updated_at DESC, conversation.id DESC
       LIMIT @seedLimit
    `, {
      ...scope.params,
      ...(useCursor ? { afterUpdatedAt: input.afterUpdatedAt!, afterId: input.afterId! } : {}),
      seedLimit: BigInt(input.limit + 1)
    });
    const hasMore = seedCandidates.length > input.limit;
    const seedRows = seedCandidates.slice(0, input.limit);
    const totalRow = database.prepare(`
      SELECT COUNT(*) AS total FROM conversation WHERE ${scope.sql}
    `).get(scope.params) as { total: bigint };
    const seedIds = seedRows.map((row) => String(row.id));
    if (seedIds.length === 0) {
      database.exec('COMMIT');
      return {
        snapshotCommitSeq,
        cursorReset,
        seedRows: [], conversations: [], origins: [], turns: [], leases: [], agentLinks: [],
        messageSummaries: [], previewTargets: [], titleTargets: [], childExecutions: [], activeChildTurnLinks: [],
        answerBridges: [], inboxItems: [], deliveries: [], deliveryWakes: [], deliveryInputLinks: [],
        projectContexts: [], conversationProjectLinks: [], total: Number(totalRow.total), hasMore: false
      };
    }
    const seedParameters = Object.fromEntries(seedIds.map((id, index) => [`seed${index}`, id]));
    const seedValues = seedIds.map((_id, index) => `(@seed${index})`).join(',');
    const conversations = queryPlainRows(database, `
      WITH seed(id) AS (
        VALUES ${seedValues}
      ), page_conversation(id) AS (
        SELECT id FROM seed
        UNION
        SELECT origin.source_conversation_id
          FROM conversation_origin_link AS origin
          JOIN seed ON seed.id = origin.conversation_id
         WHERE origin.source_conversation_id IS NOT NULL
      )
      SELECT conversation.id, conversation.title, conversation.status,
             conversation.created_at, conversation.updated_at
        FROM conversation
        JOIN page_conversation ON page_conversation.id = conversation.id
       ORDER BY conversation.updated_at DESC, conversation.id DESC
    `, seedParameters);
    const conversationIds = conversations.map((row) => String(row.id));
    const origins = queryAllByIds(database, 'conversation_origin_link', 'conversation_id', conversationIds)
      .filter((row) => row.source_conversation_id === null || conversationIds.includes(String(row.source_conversation_id)));
    const turns = queryAllByIds(database, 'turn', 'conversation_id', conversationIds);
    const turnIds = turns.map((row) => String(row.id));
    const leases = queryAllByIds(database, 'execution_lease', 'turn_id', turnIds);
    const agentLinks = queryAllByIds(database, 'agent_conversation_link', 'conversation_id', conversationIds);
    const conversationProjectLinks = queryAllByIds(database, 'conversation_project_link', 'conversation_id', conversationIds);
    const projectContexts = queryAllByIds(
      database,
      'project_context',
      'id',
      conversationProjectLinks.map((row) => String(row.project_context_id))
    );
    const messageSummaries = queryConversationMessageSummaries(database, conversationIds);
    const latestVisible = queryLatestVisibleRevisions(database, conversationIds);
    const firstUser = queryFirstUserRevisions(database, conversationIds);
    const targetRevisionIds = [...new Set([
      ...latestVisible.map((row) => String(row.revision_id)),
      ...firstUser.map((row) => String(row.revision_id))
    ])];
    const revisions = queryAllByIds(database, 'message_revision', 'id', targetRevisionIds);
    const revisionById = new Map(revisions.map((row) => [String(row.id), row]));
    const contents = queryAllByIds(database, 'content_object', 'id', revisions.map((row) => String(row.content_object_id)));
    const contentById = new Map(contents.map((row) => [String(row.id), row]));
    const projectionTargets = (rows: Array<Record<string, unknown>>) => rows.flatMap((row) => {
      const revisionId = String(row.revision_id);
      const revision = revisionById.get(revisionId);
      const content = revision ? contentById.get(String(revision.content_object_id)) : undefined;
      return content ? [{ conversationId: String(row.conversation_id), revisionId, content }] : [];
    });
    const previewTargets = projectionTargets(latestVisible);
    const titleTargets = projectionTargets(firstUser);
    const childExecutions = queryAllByIds(database, 'child_execution', 'child_conversation_id', conversationIds);
    const childIds = childExecutions.map((row) => String(row.id));
    const activeChildTurnLinks = queryAllByIds(database, 'child_execution_active_turn_link', 'child_execution_id', childIds);
    const answerBridges = queryAllByIds(database, 'answer_bridge', 'child_execution_id', childIds);
    const submissionIds = answerBridges.flatMap((row) => row.current_submission_id === null
      ? []
      : [String(row.current_submission_id)]);
    const inboxItems = queryAllByIds(database, 'runtime_inbox_item', 'source_id', submissionIds)
      .filter((row) => row.source_kind === 'answer_submission');
    const deliveries = queryAllByIds(database, 'runtime_delivery', 'inbox_item_id', inboxItems.map((row) => String(row.id)));
    const deliveryIds = deliveries.map((row) => String(row.id));
    const deliveryWakes = queryAllByIds(database, 'runtime_delivery_wake', 'delivery_id', deliveryIds);
    const deliveryInputLinks = queryAllByIds(database, 'runtime_delivery_input_link', 'delivery_id', deliveryIds);
    database.exec('COMMIT');
    return {
      snapshotCommitSeq,
      cursorReset,
      seedRows,
      conversations,
      origins,
      turns,
      leases,
      agentLinks,
      messageSummaries,
      previewTargets,
      titleTargets,
      childExecutions,
      activeChildTurnLinks,
      answerBridges,
      inboxItems,
      deliveries,
      deliveryWakes,
      deliveryInputLinks,
      projectContexts,
      conversationProjectLinks,
      total: Number(totalRow.total),
      hasMore
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function conversationHistoryScopeSql(
  input: ConversationHistoryProjectionInput,
  alias: string
): { sql: string; params: Record<string, string> } {
  if (input.scopeKind === 'all') return { sql: '1 = 1', params: {} };
  if (input.scopeKind === 'unbound') {
    return {
      sql: `NOT EXISTS (
        SELECT 1 FROM conversation_project_link AS scope_link
         WHERE scope_link.conversation_id = ${alias}.id AND scope_link.role = 'primary'
      )`,
      params: {}
    };
  }
  return {
    sql: `EXISTS (
      SELECT 1
        FROM conversation_project_link AS scope_link
        JOIN project_context AS scope_project ON scope_project.id = scope_link.project_context_id
       WHERE scope_link.conversation_id = ${alias}.id
         AND scope_link.role = 'primary'
         AND scope_project.uri = @projectFolderUri
    )`,
    params: { projectFolderUri: input.projectFolderUri!.trim() }
  };
}

export function executeClientKeysetPage(
  database: Database.Database,
  input: ClientKeysetPageInput
): ClientKeysetPageResult {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > CLIENT_PAGE_MAX_ROWS) {
    throw new RangeError(`Client keyset page limit must be from 1 to ${CLIENT_PAGE_MAX_ROWS}.`);
  }
  if ((input.afterSortKey === undefined) !== (input.afterId === undefined)) {
    throw new TypeError('Client keyset cursor requires both afterSortKey and afterId.');
  }
  const afterId = input.afterId === undefined ? undefined : requireRuntimeId(input.afterId);
  database.exec('BEGIN');
  try {
    let candidates: Array<Record<string, unknown>>;
    let sortKey: (row: Record<string, unknown>) => string;
    if (input.query === 'conversation') {
      if (input.sortId !== 'created_at+id') throw new TypeError('Conversation keyset sortId must be created_at+id.');
      const afterSortKey = input.afterSortKey;
      candidates = queryPlainRows(database, `
        SELECT id, title, status, created_at, updated_at
          FROM conversation
         ${afterSortKey === undefined ? '' : 'WHERE created_at > @afterSortKey OR (created_at = @afterSortKey AND id > @afterId)'}
         ORDER BY created_at ASC, id ASC
         LIMIT @limit
      `, {
        ...(afterSortKey === undefined ? {} : { afterSortKey, afterId: afterId! }),
        limit: BigInt(input.limit + 1)
      });
      sortKey = (row) => String(row.created_at);
    } else if (input.query === 'message') {
      if (input.sortId !== 'message_seq') throw new TypeError('Message keyset sortId must be message_seq.');
      const conversationId = requireRuntimeId(input.conversationId);
      const afterSortKey = input.afterSortKey === undefined
        ? undefined
        : requireNonNegativeIntegerString(input.afterSortKey, 'afterSortKey');
      candidates = queryPlainRows(database, `
        SELECT message.id,
               membership.conversation_id,
               membership.message_seq,
               message.created_at,
               message.updated_at,
               message.deleted_at,
               revision.id AS revision_id,
               revision.revision_seq,
               revision.role,
               revision.content_object_id,
               content.content_type,
               content.byte_length
          FROM message_part_of_conversation AS membership
          JOIN message ON message.id = membership.message_id
          JOIN message_current_revision_link AS current_revision ON current_revision.message_id = message.id
          JOIN message_revision AS revision ON revision.id = current_revision.revision_id
          JOIN content_object AS content ON content.id = revision.content_object_id
         WHERE membership.conversation_id = @conversationId
           ${afterSortKey === undefined ? '' : 'AND (membership.message_seq > @afterSortKey OR (membership.message_seq = @afterSortKey AND message.id > @afterId))'}
         ORDER BY membership.message_seq ASC, message.id ASC
         LIMIT @limit
      `, {
        conversationId,
        ...(afterSortKey === undefined ? {} : { afterSortKey: BigInt(afterSortKey), afterId: afterId! }),
        limit: BigInt(input.limit + 1)
      });
      sortKey = (row) => String(row.message_seq);
    } else {
      throw new TypeError(`Unsupported client keyset query: ${String(input.query)}.`);
    }

    let hasMore = candidates.length > input.limit;
    const boundedCandidates = candidates.slice(0, input.limit);
    const rows: Array<Record<string, unknown>> = [];
    for (const candidate of boundedCandidates) {
      const tentative = [...rows, candidate];
      const last = tentative[tentative.length - 1];
      const responseProbe = {
        rows: tentative,
        nextSortKey: sortKey(last),
        nextId: String(last.id),
        hasMore: true
      };
      if (wireJsonBytes(responseProbe) > CLIENT_PAGE_MAX_BYTES) {
        hasMore = true;
        break;
      }
      rows.push(candidate);
    }
    if (rows.length === 0 && boundedCandidates.length > 0) {
      throw new Error('A single client keyset summary exceeds maxPageBytes.');
    }
    const last = rows[rows.length - 1];
    const result: ClientKeysetPageResult = {
      rows,
      ...(last ? { nextSortKey: sortKey(last), nextId: String(last.id) } : {}),
      hasMore: hasMore || rows.length < boundedCandidates.length,
      responseBytes: 0
    };
    result.responseBytes = wireJsonBytes(result);
    if (result.responseBytes > CLIENT_PAGE_MAX_BYTES) throw new Error('Client keyset response exceeds maxPageBytes.');
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Reads the visible timeline strictly before one durable Message membership cursor. The page is
 * self-contained for rendering: Message bodies remain in CAS detail authority, while the bounded
 * causal summaries needed to associate Turns, model requests, tools, interactions and effects are
 * returned beside the Message anchors.
 */
export function executeClientVisibleMessageHistoryPage(
  database: Database.Database,
  input: ClientVisibleMessageHistoryPageInput,
  content: ClientProjectionContentAccess
): ClientVisibleMessageHistoryPageResult {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > CLIENT_PAGE_MAX_ROWS) {
    throw new RangeError(`Visible Message history page limit must be from 1 to ${CLIENT_PAGE_MAX_ROWS}.`);
  }
  const conversationId = requireRuntimeId(input.conversationId);
  const beforeMessageSeq = requireNonNegativeIntegerString(input.beforeMessageSeq, 'beforeMessageSeq');
  if (beforeMessageSeq === '0') throw new RangeError('beforeMessageSeq must be positive.');
  const beforeId = requireRuntimeId(input.beforeId);

  database.exec('BEGIN');
  try {
    const candidates = queryPlainRows(database, `
      WITH visible_messages AS (
        SELECT message.id,
               membership.conversation_id,
               membership.message_seq,
               message.created_at,
               message.updated_at,
               message.deleted_at,
               revision.id AS revision_id,
               revision.revision_seq,
               revision.role,
               revision.content_object_id,
               content.content_type,
               content.byte_length,
               ROW_NUMBER() OVER (
                 ORDER BY membership.message_seq ASC, message.id ASC
               ) AS display_seq
          FROM message_part_of_conversation AS membership
          JOIN message ON message.id = membership.message_id
          JOIN message_current_revision_link AS current_revision
            ON current_revision.message_id = message.id
          JOIN message_revision AS revision ON revision.id = current_revision.revision_id
          JOIN content_object AS content ON content.id = revision.content_object_id
         WHERE membership.conversation_id = @conversationId
           AND message.deleted_at IS NULL
           AND revision.role IN ('user', 'model')
      )
      SELECT *
        FROM visible_messages
       WHERE message_seq < @beforeMessageSeq
          OR (message_seq = @beforeMessageSeq AND id < @beforeId)
       ORDER BY message_seq DESC, id DESC
       LIMIT @limit
    `, {
      conversationId,
      beforeMessageSeq: BigInt(beforeMessageSeq),
      beforeId,
      limit: BigInt(input.limit + 1)
    });

    if (candidates.length === 0) {
      const empty: ClientVisibleMessageHistoryPageResult = {
        records: {},
        hasMore: false,
        responseBytes: 0
      };
      settleClientWireResponseBytes(empty);
      database.exec('COMMIT');
      return empty;
    }

    const maximumCount = Math.min(input.limit, candidates.length);
    const materialize = (count: number): ClientVisibleMessageHistoryPageResult => {
      const messages = candidates.slice(0, count).reverse();
      const oldest = messages[0];
      const rawRecords = buildClientVisibleMessageHistoryRecords(database, messages, content);
      const result: ClientVisibleMessageHistoryPageResult = {
        records: Object.fromEntries(Object.entries(rawRecords).map(([domain, rows]) => [
          domain,
          rows.map((row) => boundClientRecordSummary(row))
        ])),
        nextBeforeMessageSeq: String(oldest.message_seq),
        nextBeforeId: String(oldest.id),
        hasMore: candidates.length > count,
        responseBytes: 0
      };
      settleClientWireResponseBytes(result);
      return result;
    };

    // Causal closure size varies by Message, so choose the largest anchor prefix that still fits
    // one bounded response. Reducing count drops the oldest/farthest anchors, preserving keyset
    // continuity from the caller's cursor.
    let lower = 1;
    let upper = maximumCount;
    let selected: ClientVisibleMessageHistoryPageResult | undefined;
    while (lower <= upper) {
      const count = Math.floor((lower + upper) / 2);
      const candidate = materialize(count);
      if (candidate.responseBytes <= CLIENT_PAGE_MAX_BYTES) {
        selected = candidate;
        lower = count + 1;
      } else {
        upper = count - 1;
      }
    }
    if (!selected) throw new Error('A single visible Message history summary exceeds maxPageBytes.');
    if (selected.responseBytes > CLIENT_PAGE_MAX_BYTES) {
      throw new Error('Visible Message history response exceeds maxPageBytes.');
    }
    database.exec('COMMIT');
    return selected;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function buildClientVisibleMessageHistoryRecords(
  database: Database.Database,
  messages: readonly Record<string, unknown>[],
  content: ClientProjectionContentAccess
): Record<string, DomainRow[]> {
  const records: Record<string, DomainRow[]> = {};
  const include = (domain: string, rows: readonly Record<string, unknown>[]): void => {
    const unique = mergeRowsById(rows);
    if (unique.length > 0) records[domain] = unique;
  };
  const messageIds = messages.map((row) => String(row.id));
  include('Message', messages);

  const messageTurnLinks = queryAllByIds(database, 'message_turn_link', 'message_id', messageIds);
  const requestMessageLinks = queryAllByIds(database, 'model_request_message_link', 'message_id', messageIds);
  const sourceLinks = queryAllByIds(database, 'tool_call_source_link', 'message_id', messageIds);
  include('MessageTurnLink', messageTurnLinks);
  include('ModelRequestMessageLink', requestMessageLinks);
  include('ToolCallSourceLink', sourceLinks);

  const requestIds = [...new Set([
    ...requestMessageLinks.map((row) => String(row.model_request_id)),
    ...sourceLinks.map((row) => String(row.model_request_id))
  ])];
  const modelRequests = queryAllByIds(database, 'model_request', 'id', requestIds)
    .sort(compareModelRequestRows);
  include('ModelRequest', modelRequests);
  include('ModelContextProjection', queryAllByIds(
    database,
    'model_context_projection',
    'owner_id',
    requestIds
  ).filter((row) => row.owner_kind === 'model_request'));

  const toolCallIds = [...new Set(sourceLinks.map((row) => String(row.tool_call_id)))];
  const toolCalls = queryAllByIds(database, 'tool_call', 'id', toolCallIds)
    .sort(compareToolCallRows);
  include('ToolCall', toolCalls);
  include('ToolCallPolicySnapshot', queryAllByIds(database, 'tool_call_policy_snapshot', 'tool_call_id', toolCallIds));
  include('ToolCallEvent', queryLatestToolCallEvents(database, toolCallIds));
  include('ToolExecution', queryAllByIds(database, 'tool_execution', 'tool_call_id', toolCallIds));
  include('ToolOutcome', queryAllByIds(database, 'tool_outcome', 'tool_call_id', toolCallIds));
  include('ToolModelResult', queryAllByIds(database, 'tool_model_result', 'tool_call_id', toolCallIds));
  include('ToolResultArtifact', queryAllByIds(database, 'tool_result_artifact', 'tool_call_id', toolCallIds));

  const interactionToolLinks = queryAllByIds(database, 'interaction_tool_call_link', 'tool_call_id', toolCallIds);
  const interactionRequestIds = [...new Set(interactionToolLinks.map((row) => String(row.request_id)))];
  const interactionRequests = queryAllByIds(database, 'interaction_request', 'id', interactionRequestIds);
  const interactionOwnerLinks = queryAllByIds(database, 'interaction_owner_link', 'request_id', interactionRequestIds);
  include('InteractionToolCallLink', interactionToolLinks);
  include('InteractionRequest', interactionRequests);
  include('InteractionOwnerLink', interactionOwnerLinks);
  include('InteractionResponse', queryAllByIds(database, 'interaction_response', 'request_id', interactionRequestIds));

  const fileChangeSets = queryAllByIds(database, 'file_change_set', 'tool_call_id', toolCallIds);
  const fileChangeSetIds = fileChangeSets.map((row) => String(row.id));
  const fileMutationReceipts = queryAllByIds(database, 'file_mutation_receipt', 'change_set_id', fileChangeSetIds);
  include('FileChangeSet', fileChangeSets);
  include('FileChangeSetMember', queryAllByIds(database, 'file_change_set_member', 'change_set_id', fileChangeSetIds));
  include('FileChangeDecision', queryAllByIds(database, 'file_change_decision', 'change_set_id', fileChangeSetIds));
  include('FileMutationReceipt', fileMutationReceipts);
  include('FileMutationReceiptMember', queryAllByIds(
    database,
    'file_mutation_receipt_member',
    'receipt_id',
    fileMutationReceipts.map((row) => String(row.id))
  ));

  const processOriginLinks = queryAllByIds(database, 'process_origin_link', 'tool_call_id', toolCallIds);
  const processIds = [...new Set(processOriginLinks.map((row) => String(row.process_id)))];
  const processes = queryAllByIds(database, 'process', 'id', processIds)
    .map((row) => projectProcessRecord(database, String(row.id), content));
  include('ProcessOriginLink', processOriginLinks);
  include('Process', processes);
  include('ProcessReceipt', queryAllByIds(database, 'process_receipt', 'process_id', processIds));

  const childParentLinks = queryAllByIds(database, 'child_execution_parent_link', 'source_tool_call_id', toolCallIds);
  const childExecutionIds = [...new Set(childParentLinks.map((row) => String(row.child_execution_id)))];
  const childExecutions = queryAllByIds(database, 'child_execution', 'id', childExecutionIds);
  const childActiveLinks = queryAllByIds(database, 'child_execution_active_turn_link', 'child_execution_id', childExecutionIds);
  const childTurnLinks = queryLatestChildExecutionTurnLinks(database, childExecutionIds);
  const childTurnIds = [...new Set([
    ...childActiveLinks.map((row) => String(row.turn_id)),
    ...childTurnLinks.map((row) => String(row.turn_id))
  ])];
  include('ChildExecutionParentLink', childParentLinks);
  include('ChildExecution', childExecutions);
  include('ChildExecutionActiveTurnLink', childActiveLinks);
  include('ChildExecutionTurnLink', childTurnLinks);
  include('AgentConversationLink', queryAllByIds(
    database,
    'agent_conversation_link',
    'conversation_id',
    childExecutions.map((row) => String(row.child_conversation_id))
  ));

  const answerBridges = queryAllByIds(database, 'answer_bridge', 'child_execution_id', childExecutionIds)
    .map((row) => projectAnswerBridgeRecord(database, String(row.id)));
  include('AnswerBridge', answerBridges);
  include('AnswerSubmission', queryAllByIds(
    database,
    'answer_submission',
    'id',
    answerBridges.flatMap((row) => row.current_submission_id ? [String(row.current_submission_id)] : [])
  ));

  const rootTurnIds = [
    ...messageTurnLinks.map((row) => String(row.turn_id)),
    ...modelRequests.map((row) => String(row.turn_id)),
    ...toolCalls.map((row) => String(row.turn_id)),
    ...interactionOwnerLinks.map((row) => String(row.turn_id)),
    ...childParentLinks.flatMap((row) => row.parent_turn_id ? [String(row.parent_turn_id)] : [])
  ];
  const turnIds = [...new Set([...rootTurnIds, ...childTurnIds])];
  const turns = queryAllByIds(database, 'turn', 'id', turnIds)
    .map((row) => row.status === 'active' ? projectTurnClientRecord(database, String(row.id), content) : row)
    .sort(compareTurnRows);
  include('Turn', turns);
  include('ExecutionLease', queryAllByIds(database, 'execution_lease', 'turn_id', turnIds));
  include('TurnTermination', queryAllByIds(database, 'turn_termination', 'turn_id', turnIds));
  include('TurnExecutorLink', queryAllByIds(database, 'turn_executor_link', 'turn_id', turnIds));
  return records;
}

function queryPlainRows(
  database: Database.Database,
  sql: string,
  parameters: Record<string, string | bigint> = {}
): Array<Record<string, unknown>> {
  return database.prepare(sql).all(parameters) as Array<Record<string, unknown>>;
}

function mergeRowsById(rows: readonly Record<string, unknown>[]): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows) byId.set(String(row.id), row);
  return [...byId.values()];
}

function compareRuntimeRowInteger(left: unknown, right: unknown): number {
  const leftValue = typeof left === 'bigint' ? left : BigInt(String(left ?? 0));
  const rightValue = typeof right === 'bigint' ? right : BigInt(String(right ?? 0));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function compareMessageWindowRows(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return compareRuntimeRowInteger(left.message_seq, right.message_seq)
    || String(left.id).localeCompare(String(right.id));
}

function compareTurnRows(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return String(left.created_at).localeCompare(String(right.created_at))
    || String(left.id).localeCompare(String(right.id));
}

function compareModelRequestRows(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return String(left.created_at).localeCompare(String(right.created_at))
    || compareRuntimeRowInteger(left.request_seq, right.request_seq)
    || String(left.id).localeCompare(String(right.id));
}

function compareToolCallRows(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return String(left.created_at).localeCompare(String(right.created_at))
    || compareRuntimeRowInteger(left.call_seq, right.call_seq)
    || String(left.id).localeCompare(String(right.id));
}

function queryClientRootTurns(
  database: Database.Database,
  conversationId: string
): Array<Record<string, unknown>> {
  return queryPlainRows(database, `
    WITH recent_turns AS (
      SELECT id
        FROM turn
       WHERE conversation_id = @conversationId
       ORDER BY created_at DESC, id DESC
       LIMIT @limit
    )
    SELECT turn.*
      FROM turn
     WHERE turn.conversation_id = @conversationId
       AND (turn.status = 'active' OR turn.id IN (SELECT id FROM recent_turns))
     ORDER BY turn.created_at ASC, turn.id ASC
  `, { conversationId, limit: BigInt(CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE) });
}

function queryClientProcesses(
  database: Database.Database,
  conversationId: string
): Array<Record<string, unknown>> {
  return queryPlainRows(database, `
    SELECT process.*
      FROM process
      JOIN process_origin_link AS origin ON origin.process_id = process.id
      JOIN tool_call ON tool_call.id = origin.tool_call_id
      JOIN turn ON turn.id = tool_call.turn_id
     WHERE turn.conversation_id = @conversationId
       AND process.status = 'running'
     ORDER BY process.started_at DESC, process.id DESC
  `, { conversationId });
}

function queryClientChildExecutions(
  database: Database.Database,
  conversationId: string
): Array<Record<string, unknown>> {
  return queryPlainRows(database, `
    SELECT DISTINCT child.*
      FROM child_execution AS child
      JOIN child_execution_parent_link AS parent_link
        ON parent_link.child_execution_id = child.id
      LEFT JOIN tool_call AS source_call ON source_call.id = parent_link.source_tool_call_id
      LEFT JOIN turn AS source_turn ON source_turn.id = source_call.turn_id
     WHERE child.child_conversation_id = @conversationId
        OR (
          source_turn.conversation_id = @conversationId
          AND child.status NOT IN ('closed', 'needs_human')
        )
     ORDER BY child.created_at DESC, child.id DESC
  `, { conversationId });
}

function queryClientRuntimeDeliveries(
  database: Database.Database,
  conversationId: string
): Array<Record<string, unknown>> {
  return queryPlainRows(database, `
    WITH recent_deliveries AS (
      SELECT id
        FROM runtime_delivery
       WHERE target_conversation_id = @conversationId
       ORDER BY created_at DESC, id DESC
       LIMIT @limit
    )
    SELECT delivery.*
      FROM runtime_delivery AS delivery
     WHERE delivery.target_conversation_id = @conversationId
       AND (
         delivery.state IN ('pending', 'failed')
         OR EXISTS (
           SELECT 1
             FROM runtime_delivery_input_link AS input_link
            WHERE input_link.delivery_id = delivery.id
              AND input_link.handled_at IS NULL
         )
         OR delivery.id IN (SELECT id FROM recent_deliveries)
       )
     ORDER BY delivery.created_at DESC, delivery.id DESC
  `, { conversationId, limit: BigInt(CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE) });
}

function queryVisibleMessageRowsByIds(
  database: Database.Database,
  conversationId: string,
  messageIds: readonly string[]
): Array<Record<string, unknown>> {
  const unique = [...new Set(messageIds)];
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < unique.length; offset += 350) {
    const chunk = unique.slice(offset, offset + 350);
    if (chunk.length === 0) continue;
    const parameters: Record<string, string | bigint> = { conversationId };
    const placeholders = chunk.map((id, index) => {
      parameters[`message${index}`] = id;
      return `@message${index}`;
    });
    rows.push(...queryPlainRows(database, `
      WITH visible_messages AS (
        SELECT message.id,
               membership.conversation_id,
               membership.message_seq,
               message.created_at,
               message.updated_at,
               message.deleted_at,
               revision.id AS revision_id,
               revision.revision_seq,
               revision.role,
               revision.content_object_id,
               content.content_type,
               content.byte_length,
               ROW_NUMBER() OVER (
                 ORDER BY membership.message_seq ASC, message.id ASC
               ) AS display_seq
          FROM message_part_of_conversation AS membership
          JOIN message ON message.id = membership.message_id
          JOIN message_current_revision_link AS current_revision ON current_revision.message_id = message.id
          JOIN message_revision AS revision ON revision.id = current_revision.revision_id
          JOIN content_object AS content ON content.id = revision.content_object_id
         WHERE membership.conversation_id = @conversationId
           AND message.deleted_at IS NULL
           AND revision.role IN ('user', 'model')
      )
      SELECT *
        FROM visible_messages
       WHERE id IN (${placeholders.join(',')})
       ORDER BY message_seq ASC, id ASC
    `, parameters));
  }
  return mergeRowsById(rows);
}

function queryLatestToolCallEvents(
  database: Database.Database,
  toolCallIds: readonly string[]
): Array<Record<string, unknown>> {
  const unique = [...new Set(toolCallIds)];
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < unique.length; offset += 350) {
    const chunk = unique.slice(offset, offset + 350);
    if (chunk.length === 0) continue;
    const parameters: Record<string, string | bigint> = {
      eventLimit: BigInt(CLIENT_TOOL_EVENT_SUMMARY_LIMIT_PER_CALL)
    };
    const placeholders = chunk.map((id, index) => {
      parameters[`tool${index}`] = id;
      return `@tool${index}`;
    });
    rows.push(...queryPlainRows(database, `
      SELECT *
        FROM (
          SELECT event.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY event.tool_call_id
                   ORDER BY event.event_seq DESC, event.id DESC
                 ) AS client_tail_ordinal
            FROM tool_call_event AS event
           WHERE event.tool_call_id IN (${placeholders.join(',')})
        )
       WHERE client_tail_ordinal <= @eventLimit
       ORDER BY tool_call_id ASC, event_seq ASC, id ASC
    `, parameters).map(({ client_tail_ordinal: _ordinal, ...row }) => row));
  }
  return rows;
}

function queryLatestChildExecutionTurnLinks(
  database: Database.Database,
  childExecutionIds: readonly string[]
): Array<Record<string, unknown>> {
  const unique = [...new Set(childExecutionIds)];
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < unique.length; offset += 350) {
    const chunk = unique.slice(offset, offset + 350);
    if (chunk.length === 0) continue;
    const parameters: Record<string, string | bigint> = {};
    const placeholders = chunk.map((id, index) => {
      parameters[`child${index}`] = id;
      return `@child${index}`;
    });
    rows.push(...queryPlainRows(database, `
      SELECT id, child_execution_id, turn_seq, turn_id, created_at
        FROM (
          SELECT link.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY link.child_execution_id
                   ORDER BY link.turn_seq DESC, link.id DESC
                 ) AS client_ordinal
            FROM child_execution_turn_link AS link
           WHERE link.child_execution_id IN (${placeholders.join(',')})
        )
       WHERE client_ordinal = 1
       ORDER BY child_execution_id ASC, turn_seq ASC, id ASC
    `, parameters));
  }
  return rows;
}

function queryByIds(
  database: Database.Database,
  table: string,
  column: string,
  ids: readonly string[]
): Array<Record<string, unknown>> {
  if (!/^[a-z][a-z0-9_]*$/.test(table) || !/^[a-z][a-z0-9_]*$/.test(column)) {
    throw new Error('Fixed client projection contains an unsafe identifier.');
  }
  const unique = [...new Set(ids)].slice(0, CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE);
  if (unique.length === 0) return [];
  const parameters: Record<string, string | bigint> = {
    limit: BigInt(CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE)
  };
  const placeholders = unique.map((id, index) => {
    parameters[`id${index}`] = id;
    return `@id${index}`;
  });
  const parentPriority = unique
    .map((_id, index) => `WHEN @id${index} THEN ${index}`)
    .join(' ');
  return queryPlainRows(database, `
    SELECT ${quote(table)}.*
      FROM ${quote(table)}
     WHERE ${quote(column)} IN (${placeholders.join(',')})
     ORDER BY (
       CASE ${quote(column)} ${parentPriority} ELSE ${unique.length} END
       + (ROW_NUMBER() OVER (
           PARTITION BY ${quote(column)}
           ORDER BY id DESC
         ) - 1) * 8
     ) ASC,
     id DESC
     LIMIT @limit
  `, parameters);
}

/** History-page closure is already scope-bounded; do not apply the client-feed global row cap. */
function queryAllByIds(
  database: Database.Database,
  table: string,
  column: string,
  ids: readonly string[]
): Array<Record<string, unknown>> {
  if (!/^[a-z][a-z0-9_]*$/.test(table) || !/^[a-z][a-z0-9_]*$/.test(column)) {
    throw new Error('Conversation history projection contains an unsafe identifier.');
  }
  const unique = [...new Set(ids)];
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < unique.length; offset += 400) {
    const chunk = unique.slice(offset, offset + 400);
    const parameters: Record<string, string | bigint> = {};
    const placeholders = chunk.map((id, index) => {
      parameters[`id${index}`] = id;
      return `@id${index}`;
    });
    rows.push(...queryPlainRows(database, `
      SELECT * FROM ${quote(table)}
       WHERE ${quote(column)} IN (${placeholders.join(',')})
       ORDER BY id ASC
    `, parameters));
  }
  return rows;
}

function queryConversationMessageSummaries(
  database: Database.Database,
  conversationIds: readonly string[]
): Array<Record<string, unknown>> {
  return queryConversationIdChunks(database, conversationIds, (placeholders) => `
    SELECT membership.conversation_id, COUNT(*) AS message_count
      FROM message_part_of_conversation AS membership
      JOIN message ON message.id = membership.message_id
      JOIN message_current_revision_link AS current ON current.message_id = message.id
      JOIN message_revision AS revision ON revision.id = current.revision_id
     WHERE membership.conversation_id IN (${placeholders})
       AND message.deleted_at IS NULL
       AND revision.role IN ('user', 'model')
     GROUP BY membership.conversation_id
  `);
}

function queryFirstUserRevisions(
  database: Database.Database,
  conversationIds: readonly string[]
): Array<Record<string, unknown>> {
  return queryConversationIdChunks(database, conversationIds, (placeholders) => `
    SELECT conversation_id, revision_id
      FROM (
        SELECT membership.conversation_id,
               revision.id AS revision_id,
               ROW_NUMBER() OVER (
                 PARTITION BY membership.conversation_id
                 ORDER BY membership.message_seq ASC, membership.message_id ASC
               ) AS ordinal
          FROM message_part_of_conversation AS membership
          JOIN message ON message.id = membership.message_id
          JOIN message_current_revision_link AS current ON current.message_id = message.id
          JOIN message_revision AS revision ON revision.id = current.revision_id
         WHERE membership.conversation_id IN (${placeholders})
           AND message.deleted_at IS NULL
           AND revision.role = 'user'
      )
     WHERE ordinal = 1
  `);
}

function queryLatestVisibleRevisions(
  database: Database.Database,
  conversationIds: readonly string[]
): Array<Record<string, unknown>> {
  return queryConversationIdChunks(database, conversationIds, (placeholders) => `
    SELECT conversation_id, revision_id
      FROM (
        SELECT membership.conversation_id,
               revision.id AS revision_id,
               ROW_NUMBER() OVER (
                 PARTITION BY membership.conversation_id
                 ORDER BY membership.message_seq DESC, membership.message_id DESC
               ) AS ordinal
          FROM message_part_of_conversation AS membership
          JOIN message ON message.id = membership.message_id
          JOIN message_current_revision_link AS current ON current.message_id = message.id
          JOIN message_revision AS revision ON revision.id = current.revision_id
         WHERE membership.conversation_id IN (${placeholders})
           AND message.deleted_at IS NULL
           AND revision.role IN ('user', 'model')
      )
     WHERE ordinal = 1
  `);
}

function queryConversationIdChunks(
  database: Database.Database,
  conversationIds: readonly string[],
  sql: (placeholders: string) => string
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const unique = [...new Set(conversationIds)];
  for (let offset = 0; offset < unique.length; offset += 400) {
    const chunk = unique.slice(offset, offset + 400);
    const parameters: Record<string, string | bigint> = {};
    const placeholders = chunk.map((id, index) => {
      parameters[`conversation${index}`] = id;
      return `@conversation${index}`;
    }).join(',');
    rows.push(...queryPlainRows(database, sql(placeholders), parameters));
  }
  return rows;
}

function queryConversationModelRequests(
  database: Database.Database,
  conversationId: string,
  visibleMessageIds: readonly string[]
): Array<Record<string, unknown>> {
  const parameters: Record<string, string | bigint> = {
    conversationId
  };
  const visiblePlaceholders = [...new Set(visibleMessageIds)].map((messageId, index) => {
    parameters[`visibleMessage${index}`] = messageId;
    return `@visibleMessage${index}`;
  });
  const visibleLinkClause = visiblePlaceholders.length > 0
    ? `OR EXISTS (
         SELECT 1
           FROM model_request_message_link AS visible_link
          WHERE visible_link.model_request_id = request.id
            AND visible_link.message_id IN (${visiblePlaceholders.join(',')})
       )`
    : '';
  return queryPlainRows(database, `
    WITH independent_request_tail AS (
      SELECT request.id
        FROM model_request AS request
        JOIN turn AS owner_turn ON owner_turn.id = request.turn_id
       WHERE owner_turn.conversation_id = @conversationId
         AND (
           request.status <> 'terminal'
           OR NOT EXISTS (
             SELECT 1
               FROM model_request_message_link AS any_link
              WHERE any_link.model_request_id = request.id
           )
         )
       ORDER BY owner_turn.created_at DESC, request.request_seq DESC, request.id DESC
       LIMIT ${CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE}
    )
    SELECT request.*
      FROM model_request AS request
      JOIN turn AS owner_turn ON owner_turn.id = request.turn_id
     WHERE owner_turn.conversation_id = @conversationId
       AND (
         request.id IN (SELECT id FROM independent_request_tail)
         ${visibleLinkClause}
       )
     ORDER BY owner_turn.created_at DESC, request.request_seq DESC, request.id DESC
  `, parameters).reverse();
}

function wireJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, (_key, nested) =>
    typeof nested === 'bigint' ? nested.toString() : nested
  ), 'utf8');
}
