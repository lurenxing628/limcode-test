import { singleResponseMeasurementReader } from './singleResponseMeasurement';
import { AGENT_MESSAGE_MAX_TEXT_BYTES } from './collaborationOutputBudget';
import { canonicalAnswerPresentations } from './answerPresentation';
import { readTimelineWindow, canonicalDeliveryTimelineLinks, type TimelineWindow } from './clientTimelineHistory';
import { normalizeCollaborationHistoryCursor, normalizeCollaborationHistoryDirection } from './collaborationHistoryCursor';
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
import {
  RELIABLE_KERNEL_COLLABORATION_TEXT_PREVIEW_MAX_CHARACTERS,
  type ActiveTurnWorkEnvironmentProjection,
  type ChildConversationBoundaryProjection,
  type ReliableKernelCollaborationHistoryCursor
} from '../../shared/reliableKernelClientFeed';
import {
  DEFAULT_CONVERSATION_TITLE,
  GENERATED_CONVERSATION_TITLE_PREFIX,
  displayConversationTitle
} from '../../shared/conversationTitle';
import type { MessageContent } from '../../shared/protocol';
import type { SnapshotBarrier } from './contracts';
import {
  CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE,
  CLIENT_COLLABORATION_SCAN_MAX_ROWS,
  CLIENT_MESSAGE_WINDOW_LIMIT,
  CLIENT_PAGE_MAX_BYTES,
  CLIENT_PAGE_MAX_ROWS,
  CLIENT_TOOL_EVENT_SUMMARY_LIMIT_PER_CALL,
  CLIENT_WINDOW_RECORD_SUMMARY_MAX_BYTES
} from './clientFeedBounds';
import {
  boundClientRecordSummary,
  clientWireBytes,
  settleClientWireResponseBytes
} from './clientWireData';
import { toolArtifactIdentifiesCallInWorker } from './copiedToolIdentity';
import {
  approvedSubmitPlanTaskOperation,
  buildCurrentTurnTaskProjection,
  taskListOperationFromSettledArtifact,
  type CurrentTurnTaskOperationFact
} from './currentTurnTaskProjection';
import type {
  ClientCollaborationHistoryPageInput,
  ClientCollaborationHistoryPageResult,
  ClientKeysetPageInput,
  ClientKeysetPageResult,
  ClientProjectionSnapshot,
  ClientVisibleMessageHistoryPageInput,
  ClientVisibleMessageHistoryPageResult,
  ConversationHistoryProjectionInput,
  ConversationHistoryProjectionResult
} from './databaseWorkerProtocol';
import { answerSubmissionClientOutcome } from './answerSubmissionOutcome';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryMutation } from './repositories';
import { quote, requireNonNegativeIntegerString, requireRuntimeId } from './runtimeSqlRows';
import { prepareCached, prepareUncached } from './runtimeStatementCache';
import { NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE, parseNativeMessageComposition } from './logicalMessageContent';

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
const COLLABORATION_PEER_TITLE_MEMBERSHIP_SCAN_LIMIT = 256;
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

/**
 * The snapshot and commit-change projection must resolve the same source count and anchor.
 * Keep the count block-local rather than grouping the entire Conversation before its LIMIT.
 * CROSS JOIN is intentional: drive the anchor lookup from this block's sources, never from all
 * message_revision entries in context_segment_source. The membership check must remain inside
 * the anchor lookup because a shared segment can have aliases in many Conversations.
 */
const COMPRESSION_BLOCK_SUMMARY_COLUMNS = `
  block.*,
  (
    SELECT COUNT(source.id)
      FROM compression_block_source AS source
     WHERE source.compression_block_id = block.id
  ) AS source_count,
  (
    SELECT revision.message_id
      FROM (
        SELECT segment_id, position, id
          FROM compression_block_source
         WHERE compression_block_id = block.id
         ORDER BY position DESC, id DESC
         LIMIT -1
      ) AS anchor_source
      CROSS JOIN context_segment_source AS segment_source
        ON segment_source.segment_id = anchor_source.segment_id
       AND segment_source.source_kind = 'message_revision'
      CROSS JOIN message_revision AS revision ON revision.id = segment_source.source_id
      CROSS JOIN message_part_of_conversation AS anchor_membership
        ON anchor_membership.message_id = revision.message_id
       AND anchor_membership.conversation_id = block.conversation_id
     LIMIT 1
  ) AS anchor_message_id
`;

export function projectCompressionBlockRecord(database: Database.Database, blockId: string): DomainRow {
  const record = queryPlainRows(database, `
    SELECT ${COMPRESSION_BLOCK_SUMMARY_COLUMNS}
      FROM compression_block AS block
     WHERE block.id = @blockId
     LIMIT 1
  `, { blockId })[0];
  if (!record) throw new Error(`CompressionBlock ${blockId} cannot resolve its bounded summary.`);
  return record;
}

/** The immutable item index remains available after the current revision becomes the final aggregate. */
function messageItemIndexRevisionSql(
  columns: { id: string; messageId: string; revisionSeq: string } = {
    id: 'revision.id',
    messageId: 'revision.message_id',
    revisionSeq: 'revision.revision_seq'
  }
): string {
  return `(CASE
    WHEN content.content_type = '${NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE}' THEN ${columns.id}
    WHEN ${columns.revisionSeq} = 1 THEN NULL
    WHEN NOT EXISTS (
      SELECT 1 FROM model_request_message_link AS output
        JOIN model_request AS request ON request.id = output.model_request_id
       WHERE output.message_id = ${columns.messageId}
         AND request.status = 'terminal'
         AND request.terminal_state NOT IN ('completed', 'native_chain_rebased')
    ) THEN (SELECT item.id FROM message_revision AS item
      JOIN content_object AS item_content ON item_content.id = item.content_object_id
      WHERE item.message_id = ${columns.messageId}
        AND item_content.content_type = '${NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE}'
      ORDER BY item.revision_seq DESC LIMIT 1)
    ELSE NULL
  END)`;
}

function projectLogicalMessageMetadata(database: Database.Database, row: DomainRow,
  content?: ClientProjectionContentAccess): DomainRow {
  if (row.content_type !== NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE) return row;
  if (!content) throw new Error('Native Message projection requires its bounded composition reader.');
  const metadata = prepareCached(database, 'SELECT * FROM content_object WHERE id = ?').get(row.content_object_id) as DomainRow;
  const root = parseNativeMessageComposition(JSON.parse(content.readVerifiedBytes(metadata).toString('utf8')));
  return { ...row, stored_byte_length: row.byte_length, byte_length: BigInt(root.logicalByteLength), native_item_count: root.itemCount };
}

export function projectMessageWindowRecord(database: Database.Database, messageId: string,
  content?: ClientProjectionContentAccess): DomainRow | null {
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
           content.byte_length,
           ${messageItemIndexRevisionSql()} AS item_index_revision_id
      FROM message
      JOIN message_part_of_conversation AS membership ON membership.message_id = message.id
      JOIN message_current_revision_link AS current_revision ON current_revision.message_id = message.id
      JOIN message_revision AS revision ON revision.id = current_revision.revision_id
      JOIN content_object AS content ON content.id = revision.content_object_id
     WHERE message.id = @messageId AND message.deleted_at IS NULL
     LIMIT 1
  `, { messageId });
  if (rows.length > 1) throw new Error(`Message ${messageId} has multiple client window projections.`);
  return rows[0] ? projectLogicalMessageMetadata(database, rows[0], content) : null;
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
  const raw = prepareCached(database, 'SELECT * FROM turn WHERE id = ?').get(turnId);
  if (!raw) throw new Error(`Turn ${turnId} does not exist.`);
  const record = DOMAIN_REPOSITORIES.codec('Turn').decode(raw as Record<string, unknown>);
  if (record.status !== 'active') return record;
  // Ordinary Turns already have timeline anchors, including a batch with multiple input links.
  // Only retry/edit-and-run Turns without a new input need the unique intent-source enrichment.
  if (prepareCached(database, `
    SELECT 1 FROM message_turn_link WHERE turn_id = ? AND role = 'input' LIMIT 1
  `).get(turnId)) return record;

  const sources = prepareCached(database, `
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
  const membership = prepareCached(database, `
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

/** Client AnswerSubmission records: the committed row plus its derived `outcome`. */
export function projectAnswerSubmissionRecords(
  database: Database.Database,
  submissionIds: readonly string[]
): DomainRow[] {
  const submissions = queryAllByIds(database, 'answer_submission', 'id', submissionIds);
  const childByBridge = new Map(queryAllByIds(database, 'answer_bridge', 'id',
    submissions.map((row) => String(row.answer_bridge_id))).map((bridge) => [String(bridge.id), String(bridge.child_execution_id)]));
  return submissions.map((submission) => {
    const childExecutionId = childByBridge.get(String(submission.answer_bridge_id));
    if (!childExecutionId) throw new Error(`AnswerSubmission ${String(submission.id)} has no AnswerBridge.`);
    return { ...submission, outcome: answerSubmissionClientOutcome(submission, childExecutionId) };
  });
}

export function projectAnswerSubmissionRecord(database: Database.Database, submissionId: string): DomainRow {
  const [record] = projectAnswerSubmissionRecords(database, [submissionId]);
  if (!record) throw new Error(`AnswerSubmission ${submissionId} does not exist.`);
  return record;
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
    const raw = prepareCached(database, 'SELECT * FROM content_object WHERE id = ?').get(contentObjectId);
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
      const skills = Array.isArray(args.skills)
        ? args.skills.filter((name): name is string => typeof name === 'string' && Boolean(name.trim()))
        : [];
      return compactChildActivitySummary(skills.length > 0 ? `技能 ${skills.join(', ')} · ${args.prompt}` : args.prompt);
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
  const raw = prepareCached(database, 'SELECT * FROM process WHERE id = ?').get(processId);
  if (!raw) throw new Error(`Process ${processId} does not exist.`);
  const record = DOMAIN_REPOSITORIES.codec('Process').decode(raw as Record<string, unknown>);
  const source = prepareCached(database, `
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
  const detached = prepareCached(database, `
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

const PEER_TITLE_CONTENT_MAX_BYTES = 256_000n;

/** Bounded envelope preview; the full body stays in CAS behind the explicit message read path. */
export function projectCollaborationMessageRecord(
  database: Database.Database,
  messageId: string,
  content: ClientProjectionContentAccess
): DomainRow {
  const raw = prepareCached(database, 'SELECT * FROM collaboration_message WHERE id = ?').get(messageId);
  if (!raw) throw new Error(`CollaborationMessage ${messageId} does not exist.`);
  const record = DOMAIN_REPOSITORIES.codec('CollaborationMessage').decode(raw as Record<string, unknown>);
  const payloads = prepareCached(database, `
    SELECT payload.*
      FROM collaboration_message_payload_link AS link
      JOIN content_object AS payload ON payload.id = link.content_object_id
     WHERE link.message_id = ?
     LIMIT 2
  `).all(messageId) as Array<Record<string, unknown>>;
  if (payloads.length !== 1) throw new Error(`CollaborationMessage ${messageId} requires exactly one payload.`);
  const metadata = DOMAIN_REPOSITORIES.codec('ContentObject').decode(payloads[0]);
  if (metadata.content_type !== 'text/vnd.limcode.collaboration-message' || typeof metadata.byte_length !== 'bigint' || metadata.byte_length > BigInt(AGENT_MESSAGE_MAX_TEXT_BYTES)) {
    throw new Error(`CollaborationMessage ${messageId} payload violates its content contract.`);
  }
  const normalized = content.readVerifiedBytes(metadata).toString('utf8').replace(/\s+/g, ' ').trim();
  const characters = Array.from(normalized);
  const limit = RELIABLE_KERNEL_COLLABORATION_TEXT_PREVIEW_MAX_CHARACTERS;
  return {
    ...record,
    text_preview: characters.length <= limit ? normalized : `${characters.slice(0, limit - 1).join('')}…`
  };
}

/**
 * The other Conversations named by the selected Conversation's collaboration links. A peer that is
 * gone from the Runtime is marked deleted; a live one carries the title the sidebar shows (its
 * first user message when the stored title is a placeholder). Title lookups never fail the
 * snapshot: an unreadable first message just keeps the stored title.
 */
function projectCollaborationPeerConversations(
  database: Database.Database,
  activeConversationId: string,
  peerIds: readonly string[],
  content: ClientProjectionContentAccess
): Array<Record<string, unknown>> {
  const ids = [...new Set(peerIds)].filter((id) => id && id !== activeConversationId).sort();
  if (ids.length === 0) return [];
  const rows = new Map(queryAllByIds(database, 'conversation', 'id', ids).map((row) => [String(row.id), row]));
  const firstUserText = new Map<string, MessageContent>();
  const placeholderIds = [...rows.values()]
    .filter((row) => displayConversationTitle({ id: String(row.id), title: String(row.title) }) === DEFAULT_CONVERSATION_TITLE
      || String(row.title).startsWith(GENERATED_CONVERSATION_TITLE_PREFIX))
    .map((row) => String(row.id));
  for (const first of queryFirstUserRevisionsForCollaborationPeers(database, placeholderIds)) {
    const title = readFirstUserTitleContent(database, String(first.revision_id), content);
    if (title) firstUserText.set(String(first.conversation_id), title);
  }
  return ids.map((id) => {
    const row = rows.get(id);
    if (!row) return { id, title: null, status: 'deleted', display_title: null };
    const first = firstUserText.get(id);
    return {
      id,
      title: row.title,
      status: row.status,
      display_title: displayConversationTitle({
        id,
        title: String(row.title),
        ...(first ? { messages: [{ role: 'user' as const, content: first }] } : {})
      })
    };
  });
}

function queryFirstUserRevisionsForCollaborationPeers(
  database: Database.Database,
  conversationIds: readonly string[]
): Array<Record<string, unknown>> {
  if (conversationIds.length === 0) return [];
  // The peer title is optional presentation, not a reason to replay a very long conversation.
  // The epoch-5 membership index orders by (conversation_id,message_seq); MATERIALIZED prevents
  // the user-role filter from widening the read past the first 256 immutable memberships.
  const statement = prepareCached(database, `
    WITH earliest AS MATERIALIZED (
      SELECT message_id, message_seq
        FROM message_part_of_conversation INDEXED BY ux_message_part_of_conversation_01
       WHERE conversation_id = @conversationId
       ORDER BY message_seq ASC
       LIMIT @limit
    )
    SELECT @conversationId AS conversation_id, revision.id AS revision_id
      FROM earliest AS membership
      JOIN message ON message.id = membership.message_id
      JOIN message_current_revision_link AS current ON current.message_id = message.id
      JOIN message_revision AS revision ON revision.id = current.revision_id
     WHERE message.deleted_at IS NULL AND revision.role = 'user'
     ORDER BY membership.message_seq ASC
     LIMIT 1
  `);
  return conversationIds.flatMap((conversationId) => {
    const first = statement.get({ conversationId, limit: BigInt(COLLABORATION_PEER_TITLE_MEMBERSHIP_SCAN_LIMIT) });
    return first ? [first as Record<string, unknown>] : [];
  });
}

function readFirstUserTitleContent(
  database: Database.Database,
  revisionId: string,
  content: ClientProjectionContentAccess
): MessageContent | undefined {
  try {
    const revision = prepareCached(database, 'SELECT content_object_id FROM message_revision WHERE id = ?').get(revisionId) as { content_object_id?: unknown } | undefined;
    const raw = revision ? prepareCached(database, 'SELECT * FROM content_object WHERE id = ?').get(String(revision.content_object_id)) : undefined;
    if (!raw) return undefined;
    const metadata = DOMAIN_REPOSITORIES.codec('ContentObject').decode(raw as Record<string, unknown>);
    if (typeof metadata.byte_length !== 'bigint' || metadata.byte_length > PEER_TITLE_CONTENT_MAX_BYTES) return undefined;
    const text = content.readVerifiedBytes(metadata).toString('utf8');
    const contentType = String(metadata.content_type).toLowerCase();
    if (contentType.startsWith('text/plain')) return { role: 'user', parts: [{ text }] };
    const value: unknown = JSON.parse(text);
    const parts = value && typeof value === 'object' && !Array.isArray(value) ? (value as { parts?: unknown }).parts : undefined;
    return Array.isArray(parts) ? { role: 'user', parts: parts as MessageContent['parts'] } : undefined;
  } catch {
    return undefined;
  }
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
  content: ClientProjectionContentAccess,
  messageCountCache?: ConversationHistoryMessageCounts
): SnapshotBarrier<ClientProjectionSnapshot> {
  const conversationId = activeConversationId === null ? null : requireRuntimeId(activeConversationId);
  database.exec('BEGIN');
  try {
    const beforeDataVersion = messageCountCache?.dataVersion();
    const conversations = queryPlainRows(database, `
      SELECT id, title, status, created_at, updated_at
        FROM conversation
       ORDER BY updated_at DESC, id DESC
       LIMIT @limit
    `, { limit: BigInt(CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE) });
    const counts = messageCountCache?.synchronizeSnapshot(beforeDataVersion!, messageCountCache.dataVersion())
      ? messageCountCache
      : undefined;
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
      activeTurnWorkEnvironment: null,
      childConversationBoundary: null
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
      runtimeInboxItems: [], runtimeDeliveries: [], runtimeDeliveryIntentLinks: [], runtimeDeliveryTimelineLinks: [], collaborationSendTimelineLinks: [], runtimeDeliveryAnswerPresentations: [],
      collaborationMessages: [], collaborationMessageSourceLinks: [], collaborationMessageTargetLinks: [],
      collaborationMessageReplyLinks: [], collaborationRequests: [], collaborationRequestTurnLinks: [],
      collaborationPeerConversations: []
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
             content.byte_length,
           ${messageItemIndexRevisionSql()} AS item_index_revision_id
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
    const messageSummary = counts
      ? counts.readConversationSummary(database, conversationId)
      : readUncachedConversationMessageSummary(database, conversationId);
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
    // Materialize the bounded block window before expanding its sources. An outer LIMIT after
    // GROUP BY still counts (and can resolve anchors for) every historical block in the Conversation.
    const compressionBlocks = queryPlainRows(database, `
      WITH window_blocks AS MATERIALIZED (
        SELECT * FROM compression_block
         WHERE conversation_id = @conversationId
         ORDER BY created_at DESC, id DESC
         LIMIT @limit
      )
      SELECT ${COMPRESSION_BLOCK_SUMMARY_COLUMNS}
        FROM window_blocks AS block
       ORDER BY block.created_at DESC, block.id DESC
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
    // One read per frozen AuthoritySnapshot: a child's active Turn is also its latest Turn.
    const authorityDocuments: TurnAuthorityDocuments = new Map();
    const activeTurnWorkEnvironment = projectActiveTurnWorkEnvironment(database, conversationId, turns, content, authorityDocuments);
    const childConversationBoundary = projectChildConversationBoundary(database, conversationId, content, authorityDocuments);

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
    const materializedMessageIds = new Set(messageRows.map((row) => String(row.id)));
    messageRows = mergeRowsById([
      ...messageRows,
      ...queryVisibleMessageRowsByIds(
        database,
        conversationId,
        toolCallSourceLinks.map((row) => String(row.message_id)).filter((id) => !materializedMessageIds.has(id))
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
    const modelContextProjections = queryModelContextProjectionsByRequestIds(
      database,
      modelRequests.map((row) => String(row.id))
    );
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
          ...taskListProjectionFromOutcome(database, outcome, row, content)
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
    const childAnswerBridges = queryAllByIds(database, 'answer_bridge', 'child_execution_id', childIds)
      .map((bridge) => projectAnswerBridgeRecord(database, String(bridge.id)));
    // Collaboration cards sit at the Turns this snapshot loads, so the selection follows those
    // Turns instead of a fixed count of the newest messages.
    const timelineWindow = readTimelineWindow(database, conversationId, CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE);
    const timelineRecords = buildTimelineExchangeRecords(database, conversationId, timelineWindow, content,
      queryClientRuntimeDeliveries(database, conversationId).map(row => String(row.id)));
    const collaborationMessages = mergeRowsById([
      ...queryCollaborationMessagesForTurns(database, conversationId, turnIds)
        .map((row) => projectCollaborationMessageRecord(database, String(row.id), content)),
      ...(timelineRecords.CollaborationMessage ?? [])
    ]);
    const collaborationIds = collaborationMessages.map(row => String(row.id));
    const collaborationMessageSourceLinks = queryAllByIds(database, 'collaboration_message_source_link', 'message_id', collaborationIds);
    const collaborationMessageTargetLinks = queryAllByIds(database, 'collaboration_message_target_link', 'message_id', collaborationIds);
    // Each card carries its own delivery: an incoming one is placed by it (it may be older than the
    // newest deliveries) and an outgoing one shows whether the peer received it.
    const deliveries = mergeRowsById([
      ...(timelineRecords.RuntimeDelivery ?? []),
      ...queryClientRuntimeDeliveries(database, conversationId),
      ...queryAllByIds(database, 'runtime_delivery', 'inbox_item_id', collaborationMessageTargetLinks
        .map((link) => String(link.inbox_item_id)))
        .filter((delivery) => collaborationMessageTargetLinks.some((link) =>
          link.inbox_item_id === delivery.inbox_item_id && link.conversation_id === delivery.target_conversation_id))
    ]);
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
    // A child's bridge is reused by every Turn it answers, so its current submission is only the
    // newest answer. Each projected answer delivery keeps its own submission, bridge and child, or
    // the card of an earlier answer would vanish from every reloaded view.
    const answerSubmissions = projectAnswerSubmissionRecords(database, [
      ...childAnswerBridges.flatMap((row) => row.current_submission_id ? [String(row.current_submission_id)] : []),
      ...inboxItems.flatMap((row) => row.source_kind === 'answer_submission' ? [String(row.source_id)] : [])
    ]);
    const projectedBridgeIds = new Set(childAnswerBridges.map((row) => String(row.id)));
    const answerBridges = [
      ...childAnswerBridges,
      ...[...new Set(answerSubmissions.map((row) => String(row.answer_bridge_id)))]
        .filter((id) => !projectedBridgeIds.has(id))
        .map((id) => projectAnswerBridgeRecord(database, id))
    ];
    const projectedChildIds = new Set(childExecutions.map((row) => String(row.id)));
    const answeringChildren = queryAllByIds(database, 'child_execution', 'id', answerBridges
      .map((row) => String(row.child_execution_id))
      .filter((id) => !projectedChildIds.has(id)));
    const queuedTurnIntentIds = new Set(queuedTurnIntents.map((row) => String(row.id)));
    const runtimeDeliveryIntentLinks = queryAllByIds(
      database,
      'runtime_delivery_intent_link',
      'delivery_id',
      deliveryIds
    ).filter((link) => queuedTurnIntentIds.has(String(link.turn_intent_id)));

    const collaborationMessageReplyLinks = queryAllByIds(database, 'collaboration_message_reply_link', 'message_id', collaborationIds);
    const collaborationRequests = queryAllByIds(database, 'collaboration_request', 'message_id', collaborationIds);
    const collaborationRequestTurnLinks = queryAllByIds(database, 'collaboration_request_turn_link', 'request_id', collaborationRequests.map(row => String(row.id)));
    // Peers are named by their own set: the bounded navigation list holds only the newest
    // Conversations (child tasks included), so an idle peer is usually not in it.
    const collaborationPeerConversations = projectCollaborationPeerConversations(database, conversationId, [
      ...collaborationMessageSourceLinks.map(row => String(row.conversation_id)),
      ...collaborationMessageTargetLinks.map(row => String(row.conversation_id)),
      ...answeringChildren.map(row => String(row.child_conversation_id)),
      ...childExecutions.map(row => String(row.child_conversation_id))
    ], content);

    const snapshot: ClientProjectionSnapshot = {
      navigationSummary: { conversations },
      activeConversationWindow: {
        conversationId,
        messages: messageRows.map(row => projectLogicalMessageMetadata(database, row, content)),
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
        activeTurnWorkEnvironment,
        childConversationBoundary
      },
      activeTurnSummary: {
        turns,
        executionLeases: leases,
        turnTerminations: terminations,
        turnExecutorLinks: executorLinks,
        modelRequests: singleResponseMeasurementReader(database, content).project(modelRequests),
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
        childExecutions: [...childExecutions, ...answeringChildren],
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
        runtimeDeliveryTimelineLinks: timelineRecords.RuntimeDeliveryTimelineLink ?? [],
        collaborationSendTimelineLinks: timelineWindow.sends,
        runtimeDeliveryAnswerPresentations: timelineRecords.RuntimeDeliveryAnswerPresentation ?? [],
        collaborationMessages,
        collaborationMessageSourceLinks,
        collaborationMessageTargetLinks,
        collaborationMessageReplyLinks,
        collaborationRequests,
        collaborationRequestTurnLinks,
        collaborationPeerConversations
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
  content: ClientProjectionContentAccess,
  documents?: TurnAuthorityDocuments
): ActiveTurnWorkEnvironmentProjection | null {
  // Reuse the active Conversation's existing bounded roots; do not rescan historical Turns.
  const turns = selectedTurns.filter(turn => turn.conversation_id === conversationId && turn.status === 'active');
  if (turns.length === 0) return null;
  if (turns.length !== 1) throw new Error(`Conversation ${conversationId} has multiple active Turns.`);
  const turnId = requireRuntimeId(turns[0].id);
  // Absence is unknown, never a request to substitute current editable configuration. The UI
  // distinguishes an active Turn with no projection from a Conversation with no active Turn.
  const document = readTurnAuthorityDocument(database, turnId, content, documents);
  const policy = document && frozenWorkEnvironmentProjection(turnId, document);
  if (!policy) return null;
  const projection: ActiveTurnWorkEnvironmentProjection = { conversationId, ...policy };
  // Never truncate a boundary: an oversized or malformed frozen policy is not a different policy.
  if (wireJsonBytes(projection) > CLIENT_PAGE_MAX_BYTES) {
    throw new Error(`Turn ${turnId} work-environment policy exceeds the client projection size bound.`);
  }
  return projection;
}

/** The same frozen display fields as a snapshot, without reading the message/tool window. */
export function projectConversationExecutionBoundaryRecord(
  database: Database.Database,
  conversationId: string,
  content: ClientProjectionContentAccess
): DomainRow {
  const turns = queryPlainRows(database,
    'SELECT * FROM turn WHERE conversation_id = @conversationId AND status = \'active\' LIMIT 2',
    { conversationId });
  const documents: TurnAuthorityDocuments = new Map();
  return {
    id: conversationId,
    conversation_id: conversationId,
    activeTurnWorkEnvironment: projectActiveTurnWorkEnvironment(database, conversationId, turns, content, documents),
    childConversationBoundary: projectChildConversationBoundary(database, conversationId, content, documents)
  };
}

export function projectConversationTaskListRecord(
  database: Database.Database,
  conversationId: string,
  content: ClientProjectionContentAccess
): DomainRow {
  return {
    id: conversationId,
    conversation_id: conversationId,
    currentTaskList: projectCurrentTaskList(database, conversationId, content)
  };
}

/**
 * The bound a Turn the user starts in this child conversation will inherit: the tool and skill
 * bound frozen by the child's first Turn and the work environments of its latest Turn. Null for a
 * conversation that is not a child execution.
 */
export function projectChildConversationBoundary(
  database: Database.Database,
  conversationId: string,
  content: ClientProjectionContentAccess,
  documents?: TurnAuthorityDocuments
): ChildConversationBoundaryProjection | null {
  const children = queryPlainRows(database, `
    SELECT id FROM child_execution WHERE child_conversation_id = @conversationId LIMIT 2
  `, { conversationId });
  if (children.length === 0) return null;
  if (children.length !== 1) throw new Error(`Conversation ${conversationId} has multiple ChildExecutions.`);
  const childExecutionId = requireRuntimeId(children[0].id);
  const turnAt = (direction: 'ASC' | 'DESC') => queryPlainRows(database, `
    SELECT turn_id FROM child_execution_turn_link
     WHERE child_execution_id = @childExecutionId
     ORDER BY turn_seq ${direction}
     LIMIT 1
  `, { childExecutionId })[0];
  const first = turnAt('ASC');
  const latest = turnAt('DESC');
  // A reserved child may not have admitted its first Turn yet; there is no frozen boundary to show.
  if (!first || !latest) return null;
  const firstTurnId = requireRuntimeId(first.turn_id);
  const latestTurnId = requireRuntimeId(latest.turn_id);
  const firstDocument = readTurnAuthorityDocument(database, firstTurnId, content, documents);
  const latestDocument = readTurnAuthorityDocument(database, latestTurnId, content, documents);
  const toolPolicy = firstDocument?.toolPolicy;
  const projection: ChildConversationBoundaryProjection = {
    conversationId,
    childExecutionId,
    boundedByParent: !!toolPolicy && typeof toolPolicy === 'object' && !Array.isArray(toolPolicy)
      && (toolPolicy as Record<string, unknown>).inherited !== undefined,
    workEnvironment: latestDocument ? frozenWorkEnvironmentProjection(latestTurnId, latestDocument) : null
  };
  if (wireJsonBytes(projection) > CLIENT_PAGE_MAX_BYTES) {
    throw new Error(`ChildExecution ${childExecutionId} boundary exceeds the client projection size bound.`);
  }
  return projection;
}

type TurnAuthorityDocuments = Map<string, Record<string, unknown> | null>;

/** One Turn's frozen AuthoritySnapshot document, read within the projection bound; null when none. */
function readTurnAuthorityDocument(
  database: Database.Database,
  turnId: string,
  content: ClientProjectionContentAccess,
  documents?: TurnAuthorityDocuments
): Record<string, unknown> | null {
  if (documents?.has(turnId)) return documents.get(turnId)!;
  const document = readTurnAuthorityDocumentUncached(database, turnId, content);
  documents?.set(turnId, document);
  return document;
}

function readTurnAuthorityDocumentUncached(
  database: Database.Database,
  turnId: string,
  content: ClientProjectionContentAccess
): Record<string, unknown> | null {
  const authorities = queryPlainRows(database, `
    SELECT content.*
      FROM authority_snapshot AS authority
      JOIN content_object AS content ON content.id = authority.content_object_id
     WHERE authority.turn_id = @turnId
     ORDER BY authority.created_at DESC, authority.id DESC
     LIMIT 2
  `, { turnId });
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
  return document as Record<string, unknown>;
}

function frozenWorkEnvironmentProjection(
  turnId: string,
  document: Record<string, unknown>
): Omit<ActiveTurnWorkEnvironmentProjection, 'conversationId'> | null {
  const policy = document.workEnvironmentPolicy;
  if (policy === undefined || policy === null) return null;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error(`Turn ${turnId} work-environment policy is invalid.`);
  }
  const fields = policy as Record<string, unknown>;
  if (typeof fields.enabled !== 'boolean' || !Array.isArray(fields.allowedWorkEnvironmentIds)) {
    throw new Error(`Turn ${turnId} work-environment policy is incomplete.`);
  }
  return {
    turnId,
    enabled: fields.enabled,
    defaultWorkEnvironmentId: fields.defaultWorkEnvironmentId === null
      ? null
      : requireRuntimeId(fields.defaultWorkEnvironmentId),
    allowedWorkEnvironmentIds: fields.allowedWorkEnvironmentIds.map(requireRuntimeId)
  };
}

function taskListProjectionFromOutcome(
  database: Database.Database,
  outcome: Record<string, unknown> | null,
  call: Record<string, unknown>,
  content: ClientProjectionContentAccess
): { mode?: string; items: unknown[] | null; detail_on_demand: boolean } {
  const toolCallId = String(call.id);
  if (!outcome || outcome.content_object_id === null) return { items: null, detail_on_demand: false };
  if (outcome.status !== 'succeeded') return { items: null, detail_on_demand: false };
  const contentObjectId = requireRuntimeId(outcome.content_object_id);
  const raw = prepareCached(database, 'SELECT * FROM content_object WHERE id = ?').get(contentObjectId);
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
    operation = taskListOperationFromSettledArtifact(taskArtifactForCall(database, value, call), toolCallId);
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

/**
 * A fork copies a ToolCall under a new id while its result content still names the original call;
 * the copied identity rule (same immutable tool segment, same call_seq) resolves it to this call.
 */
function taskArtifactForCall(
  database: Database.Database,
  value: unknown,
  call: Record<string, unknown>
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const artifact = value as Record<string, unknown>;
  const toolCallId = String(call.id);
  return artifact.toolCallId !== toolCallId && toolArtifactIdentifiesCallInWorker(database, artifact.toolCallId, call)
    ? { ...artifact, toolCallId }
    : value;
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
      JOIN tool_call_source_link AS source ON source.tool_call_id = call.id
      JOIN message_part_of_conversation AS membership
        ON membership.message_id = source.message_id
       AND membership.conversation_id = turn.conversation_id
      JOIN message ON message.id = membership.message_id
     WHERE turn.conversation_id = @conversationId
       AND message.deleted_at IS NULL
       AND call.tool_name IN ('update_task_list', 'submit_plan')
       -- Settled by this call's own Operation, or, for a fork's copied ToolCall (which carries its
       -- ToolOutcome but not the source's execution Operations), by that copied outcome.
       AND (
         EXISTS (
           SELECT 1 FROM operation AS task_operation INDEXED BY ix_operation_02
            WHERE task_operation.tool_call_id = call.id AND task_operation.status = 'succeeded'
         )
         OR EXISTS (
           SELECT 1 FROM tool_outcome AS task_outcome
            WHERE task_outcome.tool_call_id = call.id AND task_outcome.status = 'succeeded'
         )
       )
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
    // Updates before the latest eligible `rewrite` baseline are ignored by buildCurrentTurnTaskProjection;
    // walk newest-to-oldest and stop at that baseline instead of reading all historical task artifacts.
    const reverseOperations: CurrentTurnTaskOperationFact[] = [];
    for (let index = calls.length - 1; index >= 0; index -= 1) {
      const call = calls[index]!;
      const toolCallId = String(call.id);
      const artifact = taskArtifactForCall(database, readTaskProjectionJson(
        database,
        call.artifact_content_object_id,
        `Task-list ToolResultArtifact ${toolCallId}`,
        content
      ), call);
      if (call.tool_name === 'update_task_list') {
        const operation = taskListOperationFromSettledArtifact(artifact, toolCallId);
        if (!operation) continue;
        reverseOperations.push({
          toolCallId,
          callSeq: String(call.call_seq),
          toolName: 'update_task_list',
          operation,
          sourceTurnId: String(call.turn_id),
          sourceMessageId: String(call.message_id),
          sourceMessageSeq: String(call.message_seq),
          providerOrdinal: String(call.provider_ordinal)
        });
        if (operation.mode === 'rewrite') break;
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
      reverseOperations.push({
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
      if (operation.mode === 'rewrite') break;
    }
    const operations = reverseOperations.reverse();
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
  const raw = prepareCached(database, 'SELECT * FROM content_object WHERE id = ?').get(contentObjectId);
  if (!raw) throw new Error(`${label} references missing ContentObject ${contentObjectId}.`);
  const metadata = DOMAIN_REPOSITORIES.codec('ContentObject').decode(raw as Record<string, unknown>);
  const bytes = content.readVerifiedBytes(metadata);
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`${label} content is not JSON: ${String(error)}`);
  }
}

/**
 * Pages with at most this many rows before them are addressed by page number: every read partitions
 * the current order exactly, so a refresh never hides a boundary row or repeats a neighbour's rows.
 * Deeper pages are addressed by their (updated_at, id) boundary instead, keeping each read bounded.
 */
export const CONVERSATION_HISTORY_EXACT_OFFSET_ROWS = 10_000;

/**
 * Reads one sidebar history page against current facts. The requested page number is clamped to
 * the current last page inside the same read transaction, so a page emptied by deletions resolves
 * to the nearest existing page in one bounded read instead of a client-driven retry loop.
 */
interface CachedConversationMessageCount {
  count: bigint;
  throughSeq?: bigint;
  dirtyAfterSeq?: boolean;
}

/** Worker-local counts; status writes never discard already counted message history. */
export class ConversationHistoryMessageCounts {
  private readonly counts = new Map<string, CachedConversationMessageCount>();
  private externalVersion: bigint | undefined;

  public constructor(private readonly writer: Database.Database) {}

  public dataVersion(): bigint { return BigInt(this.writer.pragma('data_version', { simple: true }) as number | bigint); }

  public synchronizeSnapshot(before: bigint, after: bigint): boolean {
    if (before !== after || this.externalVersion !== after) this.clear();
    this.externalVersion = before === after ? after : undefined;
    return before === after;
  }

  public clear(): void { this.counts.clear(); }

  /** Generic writer boundary also covers imported rows; rollback only costs a fresh count. */
  public beforeMutation(mutation: RepositoryMutation): void {
    if (this.counts.size === 0) return;
    if (mutation.domain === 'Conversation' && mutation.kind === 'insert') {
      this.counts.delete(String(mutation.row.id));
    } else if (mutation.domain === 'Conversation' && mutation.kind === 'delete') {
      this.counts.delete(mutation.id);
    } else if (mutation.domain === 'MessagePartOfConversation' && mutation.kind === 'insert') {
      const conversationId = String(mutation.row.conversation_id);
      const entry = this.counts.get(conversationId);
      if (!entry) return;
      const rawSeq = mutation.row.message_seq;
      if (
        rawSeq !== undefined
        && rawSeq !== null
        && entry.throughSeq !== undefined
        && entry.throughSeq > 0n
        && BigInt(String(rawSeq)) > entry.throughSeq
      ) {
        entry.dirtyAfterSeq = true;
      } else {
        this.counts.delete(conversationId);
      }
    } else if (mutation.domain === 'MessagePartOfConversation') {
      this.clear();
    } else if (mutation.domain === 'Message' && mutation.kind === 'delete') {
      this.clear();
    } else {
      let messageId: unknown;
      if (mutation.domain === 'Message' && mutation.kind === 'update' && 'deleted_at' in mutation.patch) {
        messageId = mutation.id;
      } else if (mutation.domain === 'MessageCurrentRevisionLink' && mutation.kind === 'insert') {
        messageId = mutation.row.message_id;
      } else if (mutation.domain === 'MessageCurrentRevisionLink' && mutation.kind === 'update'
        && 'revision_id' in mutation.patch) {
        if ('message_id' in mutation.patch) { this.clear(); return; }
        const row = prepareCached(this.writer, `
          SELECT current.message_id, previous.role AS old_role, next.role AS next_role
            FROM message_current_revision_link AS current
            JOIN message_revision AS previous ON previous.id = current.revision_id
            JOIN message_revision AS next ON next.id = ?
           WHERE current.id = ?
        `).get(mutation.patch.revision_id, mutation.id) as DomainRow | undefined;
        // Edits and native streaming revisions normally retain the same visible message count.
        if (row && ['user', 'model'].includes(String(row.old_role)) === ['user', 'model'].includes(String(row.next_role))) return;
        messageId = row?.message_id;
      }
      if (typeof messageId === 'string') {
        const membership = prepareCached(this.writer, 'SELECT conversation_id, message_seq FROM message_part_of_conversation WHERE message_id = ?')
          .get(messageId) as DomainRow | undefined;
        if (membership) {
          const conversationId = String(membership.conversation_id);
          const entry = this.counts.get(conversationId);
          if (entry) {
            if (entry.throughSeq !== undefined && entry.throughSeq > 0n && BigInt(String(membership.message_seq)) > entry.throughSeq) {
              entry.dirtyAfterSeq = true;
            } else {
              this.counts.delete(conversationId);
            }
          }
        }
      }
    }
  }

  public get(id: string): bigint | undefined {
    const entry = this.counts.get(id);
    if (!entry || entry.dirtyAfterSeq) return undefined;
    this.counts.delete(id);
    this.counts.set(id, entry);
    return entry.count;
  }

  public set(id: string, count: bigint, throughSeq?: bigint): void {
    this.counts.delete(id);
    this.counts.set(id, { count, ...(throughSeq !== undefined ? { throughSeq } : {}) });
    if (this.counts.size > 512) this.counts.delete(this.counts.keys().next().value!);
  }

  public resolveCount(database: Database.Database, id: string): bigint | undefined {
    const entry = this.counts.get(id);
    if (!entry) return undefined;
    if (!entry.dirtyAfterSeq) {
      this.counts.delete(id);
      this.counts.set(id, entry);
      return entry.count;
    }
    if (entry.throughSeq === undefined) {
      this.counts.delete(id);
      return undefined;
    }
    return this.readConversationSummary(database, id).visible_message_count;
  }

  public readConversationSummary(
    database: Database.Database,
    conversationId: string
  ): { visible_message_count: bigint; last_message_seq: bigint } {
    const entry = this.counts.get(conversationId);
    const maxRow = prepareCached(database, `
      SELECT COALESCE(MAX(membership.message_seq), 0) AS last_message_seq
        FROM message_part_of_conversation AS membership
       WHERE membership.conversation_id = ?
    `).get(conversationId) as { last_message_seq: bigint };
    const lastMessageSeq = BigInt(String(maxRow.last_message_seq));
    if (entry && entry.throughSeq !== undefined) {
      if (!entry.dirtyAfterSeq && entry.throughSeq === lastMessageSeq) {
        this.counts.delete(conversationId);
        this.counts.set(conversationId, entry);
        return { visible_message_count: entry.count, last_message_seq: lastMessageSeq };
      }
      if (lastMessageSeq >= entry.throughSeq) {
        const deltaRow = lastMessageSeq === entry.throughSeq
          ? { delta_count: 0n }
          : prepareCached(database, `
              SELECT COUNT(1) AS delta_count
                FROM message_part_of_conversation AS membership
                JOIN message AS m ON m.id = membership.message_id
                JOIN message_current_revision_link AS current_revision ON current_revision.message_id = m.id
                JOIN message_revision AS revision ON revision.id = current_revision.revision_id
               WHERE membership.conversation_id = ?
                 AND membership.message_seq > ?
                 AND membership.message_seq <= ?
                 AND m.deleted_at IS NULL
                 AND revision.role IN ('user', 'model')
            `).get(conversationId, entry.throughSeq, lastMessageSeq) as { delta_count: bigint };
        const nextCount = entry.count + BigInt(String(deltaRow.delta_count));
        this.set(conversationId, nextCount, lastMessageSeq);
        return { visible_message_count: nextCount, last_message_seq: lastMessageSeq };
      }
    }
    const fresh = readUncachedConversationMessageSummary(database, conversationId);
    this.set(conversationId, fresh.visible_message_count, fresh.last_message_seq);
    return fresh;
  }
}

function readUncachedConversationMessageSummary(
  database: Database.Database,
  conversationId: string
): { visible_message_count: bigint; last_message_seq: bigint } {
  return prepareCached(database, `
    SELECT COUNT(CASE WHEN m.deleted_at IS NULL AND revision.role IN ('user', 'model') THEN 1 END) AS visible_message_count,
           COALESCE(MAX(membership.message_seq), 0) AS last_message_seq
      FROM message_part_of_conversation AS membership
      JOIN message AS m ON m.id = membership.message_id
      JOIN message_current_revision_link AS current_revision ON current_revision.message_id = m.id
      JOIN message_revision AS revision ON revision.id = current_revision.revision_id
     WHERE membership.conversation_id = ?
  `).get(conversationId) as { visible_message_count: bigint; last_message_seq: bigint };
}

export function executeConversationHistoryProjection(
  database: Database.Database,
  input: ConversationHistoryProjectionInput,
  messageCountCache?: ConversationHistoryMessageCounts
): ConversationHistoryProjectionResult {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > CLIENT_PAGE_MAX_ROWS) {
    throw new RangeError(`Conversation history page limit must be from 1 to ${CLIENT_PAGE_MAX_ROWS}.`);
  }
  if (!Number.isSafeInteger(input.pageIndex) || input.pageIndex < 0) {
    throw new RangeError('Conversation history pageIndex must be a non-negative integer.');
  }
  if (input.boundary && (
    !['from', 'after', 'before'].includes(input.boundary.kind)
    || typeof input.boundary.updatedAt !== 'string' || !input.boundary.updatedAt
    || typeof input.boundary.id !== 'string' || !input.boundary.id
  )) {
    throw new TypeError('Conversation history page boundary is malformed.');
  }
  if (input.scopeKind === 'project' && !input.projectFolderUri?.trim()) {
    throw new TypeError('Project conversation history requires projectFolderUri.');
  }
  const scope = conversationHistoryScopeSql(input, 'conversation');
  database.exec('BEGIN');
  try {
    const before = messageCountCache?.dataVersion();
    const totalQuery = conversationHistoryTotalQuery(input);
    const totalRow = prepareCached(database, totalQuery.sql).get(totalQuery.params) as { total: bigint };
    // The total query establishes the reader snapshot. Local writes invalidate at their mutation
    // boundary; the writer's data_version changes only for commits from other connections.
    const counts = messageCountCache?.synchronizeSnapshot(before!, messageCountCache.dataVersion())
      ? messageCountCache : undefined;
    const page = conversationHistoryPageSeed(database, scope, input, Number(totalRow.total));
    const { seedRows, hasMore } = page;
    const seedIds = seedRows.map((row) => String(row.id));
    if (seedIds.length === 0) {
      database.exec('COMMIT');
      return {
        pageIndex: page.pageIndex,
        seedRows: [], conversations: [], origins: [], turns: [], leases: [], agentLinks: [],
        messageSummaries: [], previewTargets: [], titleTargets: [], childExecutions: [], activeChildTurnLinks: [],
        answerBridges: [], inboxItems: [], deliveries: [], deliveryWakes: [], deliveryInputLinks: [],
        projectContexts: [], conversationProjectLinks: [], total: Number(totalRow.total), hasMore: false
      };
    }
    const seedParameters = Object.fromEntries(seedIds.map((id, index) => [`seed${index}`, id]));
    const seedValues = seedIds.map((_id, index) => `(@seed${index})`).join(',');
    const conversations = queryIdListRows(database, `
      WITH seed(id) AS (
        VALUES ${seedValues}
      ), page_conversation(id) AS (
        SELECT id FROM seed
        UNION
        SELECT origin.source_conversation_id
          FROM conversation_origin_link AS origin
          JOIN seed ON seed.id = origin.conversation_id
         WHERE origin.source_conversation_id IS NOT NULL
           AND origin.source_tool_call_id IS NOT NULL
      )
      SELECT conversation.id, conversation.title, conversation.status,
             conversation.created_at, conversation.updated_at
        FROM page_conversation
        CROSS JOIN conversation ON conversation.id = page_conversation.id
       ORDER BY conversation.updated_at DESC, conversation.id DESC
    `, seedParameters, { count: seedIds.length });
    const conversationIds = conversations.map((row) => String(row.id));
    const origins = queryAllByIds(database, 'conversation_origin_link', 'conversation_id', conversationIds)
      .filter((row) => row.source_conversation_id === null || conversationIds.includes(String(row.source_conversation_id)));
    const agentLinks = queryAllByIds(database, 'agent_conversation_link', 'conversation_id', conversationIds);
    const conversationProjectLinks = queryAllByIds(database, 'conversation_project_link', 'conversation_id', conversationIds);
    const projectContexts = queryAllByIds(
      database,
      'project_context',
      'id',
      conversationProjectLinks.map((row) => String(row.project_context_id))
    );
    const availableCounts = new Map<string, bigint>();
    for (const id of conversationIds) {
      const count = counts?.resolveCount(database, id);
      if (count !== undefined) availableCounts.set(id, count);
    }
    const missingCounts = conversationIds.filter(id => !availableCounts.has(id));
    const freshSummaries = missingCounts.length > 0 ? queryConversationMessageSummaries(database, missingCounts) : [];
    const freshById = new Map(freshSummaries.map(row => [
      String(row.conversation_id),
      {
        count: BigInt(String(row.message_count)),
        lastSeq: row.last_message_seq !== undefined ? BigInt(String(row.last_message_seq)) : undefined
      }
    ]));
    const maxSeqForEmpty = counts && missingCounts.some(id => !freshById.has(id))
      ? queryConversationLastMessageSeqs(database, missingCounts.filter(id => !freshById.has(id)))
      : new Map<string, bigint>();
    for (const id of missingCounts) {
      const fresh = freshById.get(id);
      const count = fresh?.count ?? 0n;
      const throughSeq = fresh?.lastSeq ?? maxSeqForEmpty.get(id) ?? 0n;
      availableCounts.set(id, count);
      counts?.set(id, count, throughSeq);
    }
    const messageSummaries = counts ? conversationIds.flatMap(id => {
      const count = availableCounts.get(id)!;
      return count > 0n ? [{ conversation_id: id, message_count: count }] : [];
    }) : freshSummaries.map(({ conversation_id, message_count }) => ({ conversation_id, message_count }));
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
    const inboxItems = queryAnswerSubmissionInboxItems(database, submissionIds);
    const deliveries = queryAllByIds(database, 'runtime_delivery', 'inbox_item_id', inboxItems.map((row) => String(row.id)));
    const deliveryIds = deliveries.map((row) => String(row.id));
    const deliveryWakes = queryAllByIds(database, 'runtime_delivery_wake', 'delivery_id', deliveryIds);
    const deliveryInputLinks = queryAllByIds(database, 'runtime_delivery_input_link', 'delivery_id', deliveryIds);
    // Sidebar status needs active Turns and exact child/delivery references, never every historical
    // Turn in each conversation. Keep referenced terminal targets so unhandled answers still fail.
    const turns = mergeRowsById([
      ...queryConversationIdChunks(database, conversationIds, (placeholders) => `
        SELECT * FROM turn INDEXED BY ix_turn_02
         WHERE conversation_id IN (${placeholders})
           AND status >= 'active' AND status <= 'active'
         ORDER BY id ASC
      `),
      ...queryAllByIds(database, 'turn', 'id', [
        ...activeChildTurnLinks.map((row) => String(row.turn_id)),
        ...deliveries.flatMap((row) => row.target_turn_id === null ? [] : [String(row.target_turn_id)])
      ]).filter((row) => conversationIds.includes(String(row.conversation_id)))
    ]).sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const leases = queryAllByIds(database, 'execution_lease', 'turn_id', turns.map((row) => String(row.id)));
    database.exec('COMMIT');
    return {
      pageIndex: page.pageIndex,
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

const HISTORY_SEED_COLUMNS = `conversation.id, conversation.title, conversation.status,
             conversation.created_at, conversation.updated_at`;
const HISTORY_ORDER_DESC = 'ORDER BY conversation.updated_at DESC, conversation.id DESC';
const HISTORY_ORDER_ASC = 'ORDER BY conversation.updated_at ASC, conversation.id ASC';

function conversationHistoryPageSeed(
  database: Database.Database,
  scope: { sql: string; params: Record<string, string> },
  input: ConversationHistoryProjectionInput,
  total: number
): { pageIndex: number; seedRows: DomainRow[]; hasMore: boolean } {
  const limit = input.limit;
  const lastPageIndex = total === 0 ? 0 : Math.floor((total - 1) / limit);
  const read = (sql: string, params: Record<string, string | bigint>): DomainRow[] =>
    queryPlainRows(database, `SELECT ${HISTORY_SEED_COLUMNS} FROM conversation WHERE ${scope.sql} ${sql}`, {
      ...scope.params,
      ...params
    });
  const numbered = (pageIndex: number) => ({
    pageIndex,
    seedRows: read(`${HISTORY_ORDER_DESC} LIMIT @limit OFFSET @offset`, {
      limit: BigInt(limit),
      offset: BigInt(pageIndex * limit)
    }),
    hasMore: pageIndex < lastPageIndex
  });
  // The oldest page is read upward from the end of the order, so it stays exact at any depth.
  const last = () => ({
    pageIndex: lastPageIndex,
    seedRows: read(`${HISTORY_ORDER_ASC} LIMIT @limit`, {
      limit: BigInt(total - lastPageIndex * limit)
    }).reverse(),
    hasMore: false
  });
  const requested = Math.min(input.pageIndex, lastPageIndex);
  if (requested * limit <= CONVERSATION_HISTORY_EXACT_OFFSET_ROWS) return numbered(requested);
  if (requested === lastPageIndex) return last();
  const exactWindowPageIndex = Math.floor(CONVERSATION_HISTORY_EXACT_OFFSET_ROWS / limit);
  const boundary = input.boundary;
  if (!boundary) return numbered(exactWindowPageIndex);
  const key = { boundaryUpdatedAt: boundary.updatedAt, boundaryId: boundary.id, limit: BigInt(limit) };
  if (boundary.kind === 'before') {
    const rows = read(`AND (conversation.updated_at > @boundaryUpdatedAt
           OR (conversation.updated_at = @boundaryUpdatedAt AND conversation.id > @boundaryId))
         ${HISTORY_ORDER_ASC} LIMIT @limit`, key).reverse();
    // Fewer than a page above the boundary means the order shrank to the first page.
    return rows.length === limit ? { pageIndex: requested, seedRows: rows, hasMore: true } : numbered(0);
  }
  const comparison = boundary.kind === 'from' ? '<=' : '<';
  const rows = read(`AND (conversation.updated_at < @boundaryUpdatedAt
         OR (conversation.updated_at = @boundaryUpdatedAt AND conversation.id ${comparison} @boundaryId))
       ${HISTORY_ORDER_DESC} LIMIT @limit`, key);
  return rows.length === limit ? { pageIndex: requested, seedRows: rows, hasMore: requested < lastPageIndex } : last();
}

function conversationHistoryScopeSql(
  input: Pick<ConversationHistoryProjectionInput, 'scopeKind' | 'projectFolderUri'>,
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

/**
 * Project totals start from the unique ProjectContext URI and count its primary links through the
 * project link index. ConversationProjectLink is unique per Conversation and cascades with it, so
 * this equals the scoped Conversation count without probing every Conversation in the data set.
 */
export function conversationHistoryTotalQuery(
  input: Pick<ConversationHistoryProjectionInput, 'scopeKind' | 'projectFolderUri'>
): { sql: string; params: Record<string, string> } {
  if (input.scopeKind !== 'project') {
    const scope = conversationHistoryScopeSql(input, 'conversation');
    return { sql: `SELECT COUNT(*) AS total FROM conversation WHERE ${scope.sql}`, params: scope.params };
  }
  return {
    sql: `SELECT COUNT(*) AS total
            FROM project_context AS scope_project
            JOIN conversation_project_link AS scope_link
              ON scope_link.project_context_id = scope_project.id
           WHERE scope_project.uri = @projectFolderUri
             AND scope_link.role = 'primary'`,
    params: { projectFolderUri: input.projectFolderUri!.trim() }
  };
}

export function executeClientKeysetPage(
  database: Database.Database,
  input: ClientKeysetPageInput,
  content?: ClientProjectionContentAccess
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
               content.byte_length,
           ${messageItemIndexRevisionSql()} AS item_index_revision_id
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
    for (const rawCandidate of boundedCandidates) {
      const candidate = input.query === 'message' ? projectLogicalMessageMetadata(database, rawCandidate, content) : rawCandidate;
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
  const backwards = input.beforeMessageSeq !== undefined;
  if (backwards === (input.afterMessageSeq !== undefined)
    || (backwards ? input.afterId !== undefined : input.beforeId !== undefined)) {
    throw new TypeError('Message history requires exactly one before or after keyset cursor.');
  }
  const cursorSeq = requireNonNegativeIntegerString(backwards ? input.beforeMessageSeq : input.afterMessageSeq, 'messageSeq');
  const cursorId = requireRuntimeId(backwards ? input.beforeId : input.afterId);
  const operator = backwards ? '<' : '>';
  const order = backwards ? 'DESC' : 'ASC';
  database.exec('BEGIN');
  try {
    // Select the bounded candidate range first. Visible floors are counted in this same snapshot.
    const candidates = queryPlainRows(database, `
      WITH page AS MATERIALIZED (
        SELECT message.id, membership.conversation_id, membership.message_seq,
               message.created_at, message.updated_at, message.deleted_at,
               revision.id AS revision_id, revision.revision_seq, revision.role,
               revision.content_object_id, content.content_type, content.byte_length,
           ${messageItemIndexRevisionSql()} AS item_index_revision_id
          FROM message_part_of_conversation AS membership
          JOIN message ON message.id = membership.message_id
          JOIN message_current_revision_link AS current_revision ON current_revision.message_id = message.id
          JOIN message_revision AS revision ON revision.id = current_revision.revision_id
          JOIN content_object AS content ON content.id = revision.content_object_id
         WHERE membership.conversation_id = @conversationId
           AND membership.message_seq ${operator}= @cursorSeq
           AND (membership.message_seq ${operator} @cursorSeq OR message.id ${operator} @cursorId)
           AND message.deleted_at IS NULL AND revision.role IN ('user', 'model')
         ORDER BY membership.message_seq ${order}, membership.message_id ${order}
         LIMIT @limit
      )
      SELECT page.*,
             (SELECT COUNT(*) FROM message_part_of_conversation AS older
                JOIN message ON message.id = older.message_id
                JOIN message_current_revision_link AS current_revision ON current_revision.message_id = message.id
                JOIN message_revision AS revision ON revision.id = current_revision.revision_id
               WHERE older.conversation_id = @conversationId
                 AND (older.message_seq, older.message_id) <
                     (SELECT message_seq, id FROM page ORDER BY message_seq, id LIMIT 1)
                 AND message.deleted_at IS NULL AND revision.role IN ('user', 'model'))
             + ROW_NUMBER() OVER (ORDER BY page.message_seq, page.id) AS display_seq
        FROM page ORDER BY page.message_seq ${order}, page.id ${order}
    `, { conversationId, cursorSeq: BigInt(cursorSeq), cursorId, limit: BigInt(input.limit + 1) });

    if (candidates.length === 0) {
      const empty: ClientVisibleMessageHistoryPageResult = {
        records: {}, hasMoreBefore: false, hasMoreAfter: false, responseBytes: 0
      };
      settleClientWireResponseBytes(empty);
      database.exec('COMMIT');
      return empty;
    }
    const laterThanBackwardPage = backwards && Boolean(prepareCached(database, `
      SELECT 1 FROM message_part_of_conversation AS membership
        JOIN message ON message.id = membership.message_id
        JOIN message_current_revision_link AS current_revision ON current_revision.message_id = message.id
        JOIN message_revision AS revision ON revision.id = current_revision.revision_id
       WHERE membership.conversation_id = @conversationId
         AND (membership.message_seq, membership.message_id) > (@messageSeq, @messageId)
         AND message.deleted_at IS NULL AND revision.role IN ('user', 'model') LIMIT 1
    `).get({ conversationId, messageSeq: candidates[0].message_seq, messageId: candidates[0].id }));
    const maximumCount = Math.min(input.limit, candidates.length);
    const facts = new Map<string, DomainRow[]>();
    const wireRows = new Map<string, Map<string, DomainRow>>();
    const materialize = (count: number): ClientVisibleMessageHistoryPageResult => {
      const messages = candidates.slice(0, count);
      if (backwards) messages.reverse();
      const oldest = messages[0], newest = messages[messages.length - 1];
      const rawRecords = buildClientVisibleMessageHistoryRecords(database, messages, content, facts);
      const records: Record<string, DomainRow[]> = {};
      for (const [domain, rows] of Object.entries(rawRecords)) {
        let cached = wireRows.get(domain);
        if (!cached) wireRows.set(domain, cached = new Map());
        records[domain] = rows.map(row => {
          const id = String(row.id);
          let bounded = cached!.get(id);
          if (!bounded) cached!.set(id, bounded = boundClientRecordSummary(row, domain));
          return bounded;
        });
      }
      const result: ClientVisibleMessageHistoryPageResult = {
        records,
        nextBeforeMessageSeq: String(oldest.message_seq), nextBeforeId: String(oldest.id),
        nextAfterMessageSeq: String(newest.message_seq), nextAfterId: String(newest.id),
        hasMoreBefore: BigInt(String(oldest.display_seq)) > 1n,
        hasMoreAfter: backwards ? laterThanBackwardPage : candidates.length > count,
        responseBytes: 0
      };
      settleClientWireResponseBytes(result);
      return result;
    };
    // The common case materializes exactly once. Oversized pages select a smaller closure from
    // those same facts and already-bounded wire rows; no repeated SQL or body projection.
    const full = materialize(maximumCount);
    let selected = full.responseBytes <= CLIENT_PAGE_MAX_BYTES ? full : undefined;
    if (!selected) {
      let lower = 1, upper = maximumCount - 1;
      while (lower <= upper) {
        const count = Math.floor((lower + upper) / 2);
        const candidate = materialize(count);
        if (candidate.responseBytes <= CLIENT_PAGE_MAX_BYTES) { selected = candidate; lower = count + 1; }
        else upper = count - 1;
      }
    }
    if (!selected) throw new Error('A single visible Message history summary exceeds maxPageBytes.');
    database.exec('COMMIT');
    return selected;
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

/** Materialize every dependency for a bounded, independently keyed set of accepted exchanges. */
function buildTimelineExchangeRecords(
  database: Database.Database,
  conversationId: string,
  window: Pick<TimelineWindow, 'receives' | 'sends'>,
  content: ClientProjectionContentAccess,
  extraDeliveryIds: readonly string[] = []
): Record<string, DomainRow[]> {
  const records: Record<string, DomainRow[]> = {};
  const include = (domain: string, rows: readonly DomainRow[]): void => {
    if (rows.length) records[domain] = mergeRowsById(rows).map(row => boundClientRecordSummary(row, domain));
  };
  const canonicalReceives = canonicalDeliveryTimelineLinks(database, conversationId, window.receives.map(row => String(row.inbox_item_id)));
  include('RuntimeDeliveryTimelineLink', canonicalReceives);
  include('CollaborationSendTimelineLink', window.sends);
  const deliveryIds = [...new Set([...canonicalReceives.map(row => String(row.delivery_id)), ...extraDeliveryIds])];
  let deliveries = queryAllByIds(database, 'runtime_delivery', 'id', deliveryIds);
  const extraCanonical = canonicalDeliveryTimelineLinks(database, conversationId, deliveries
    .filter(row => row.target_conversation_id === conversationId).map(row => String(row.inbox_item_id)));
  include('RuntimeDeliveryTimelineLink', [...canonicalReceives, ...extraCanonical]);
  deliveries = mergeRowsById([...deliveries, ...queryAllByIds(database, 'runtime_delivery', 'id', extraCanonical.map(row => String(row.delivery_id)))]);
  const presentations = canonicalAnswerPresentations(database, conversationId, deliveries
    .filter(row => row.target_conversation_id === conversationId).map(row => String(row.inbox_item_id)));
  include('RuntimeDeliveryAnswerPresentation', presentations);
  deliveries = mergeRowsById([...deliveries, ...queryAllByIds(database, 'runtime_delivery', 'id', presentations.map(row => String(row.delivery_id)))]);
  const inboxes = queryAllByIds(database, 'runtime_inbox_item', 'id', deliveries.map(row => String(row.inbox_item_id)));
  const messageIds = [...new Set([
    ...window.sends.map(row => String(row.message_id)),
    ...inboxes.filter(row => row.source_kind === 'collaboration_message').map(row => String(row.source_id))
  ])];
  const sources = queryAllByIds(database, 'collaboration_message_source_link', 'message_id', messageIds);
  const targets = queryAllByIds(database, 'collaboration_message_target_link', 'message_id', messageIds);
  const latest = prepareCached(database, `SELECT * FROM runtime_delivery
    WHERE inbox_item_id = ? AND target_conversation_id = ? ORDER BY attempt_seq DESC LIMIT 1`);
  deliveries = mergeRowsById([...deliveries, ...targets.flatMap(target => {
    const row = latest.get(target.inbox_item_id, target.conversation_id) as DomainRow | undefined;
    return row ? [row] : [];
  })]);
  const allInboxes = mergeRowsById([...inboxes,
    ...queryAllByIds(database, 'runtime_inbox_item', 'id', deliveries.map(row => String(row.inbox_item_id)))]);
  include('RuntimeDelivery', deliveries.map(delivery => {
    const links = queryPlainRows(database, 'SELECT handled_at FROM runtime_delivery_input_link WHERE delivery_id = @id LIMIT 2', { id: String(delivery.id) });
    if (links.length > 1) throw new Error('Timeline delivery has multiple input links.');
    return { ...delivery, parent_handling_state: deriveCommittedParentHandling(delivery,
      links[0] ? { handled_at: links[0].handled_at as string | null } : null) };
  }));
  include('RuntimeInboxItem', allInboxes);
  include('CollaborationMessage', messageIds.map(id => projectCollaborationMessageRecord(database, id, content)));
  include('CollaborationMessageSourceLink', sources);
  include('CollaborationMessageTargetLink', targets);
  const answerIds = allInboxes.filter(row => row.source_kind === 'answer_submission').map(row => String(row.source_id));
  const answers = projectAnswerSubmissionRecords(database, answerIds);
  const bridges = queryAllByIds(database, 'answer_bridge', 'id', answers.map(row => String(row.answer_bridge_id)))
    .map(row => projectAnswerBridgeRecord(database, String(row.id)));
  const children = queryAllByIds(database, 'child_execution', 'id', bridges.map(row => String(row.child_execution_id)));
  include('AnswerSubmission', answers);
  include('AnswerBridge', bridges);
  include('ChildExecution', children);
  include('ChildExecutionParentLink', queryAllByIds(database, 'child_execution_parent_link', 'child_execution_id', children.map(row => String(row.id))));
  const turnIds = [...new Set([...sources.map(row => row.turn_id), ...deliveries.map(row => row.target_turn_id)]
    .filter((id): id is string => typeof id === 'string' && id.length > 0))];
  include('Turn', queryAllByIds(database, 'turn', 'id', turnIds).filter(row => row.conversation_id === conversationId));
  include('CollaborationPeerConversation', projectCollaborationPeerConversations(database, conversationId,
    [...sources.map(row => String(row.conversation_id)), ...targets.map(row => String(row.conversation_id)),
      ...children.map(row => String(row.child_conversation_id)),
      ...presentations.flatMap(row => typeof row.child_conversation_id === 'string' ? [row.child_conversation_id] : [])], content));
  return records;
}

/**
 * Positioned exchanges, then message/answer inventory with no invented transcript coordinates.
 * Each lane has an independent bounded keyset cursor; the inventory order is never presentation
 * chronology. Even a child answer with no following ModelRequest remains pageable here.
 */
export function executeClientCollaborationHistoryPage(
  database: Database.Database, input: ClientCollaborationHistoryPageInput, content: ClientProjectionContentAccess
): ClientCollaborationHistoryPageResult {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > CLIENT_PAGE_MAX_ROWS) throw new RangeError('Invalid exchange history limit.');
  const conversationId = requireRuntimeId(input.conversationId);
  const normalizedCursor = normalizeCollaborationHistoryCursor(input.cursor);
  const direction = normalizeCollaborationHistoryDirection(input.direction, normalizedCursor);
  const before = direction === 'before';
  const cursor: ReliableKernelCollaborationHistoryCursor = normalizedCursor ?? (before ? { kind: 'exchange' } : { kind: 'answer' });
  if (cursor.kind === 'message') {
    return executeCollaborationMessageInventoryPage(database, { conversationId, limit: input.limit, direction, cursor }, content);
  }
  database.exec('BEGIN');
  try {
    let page: ClientCollaborationHistoryPageResult;
    if (cursor.kind === 'exchange') {
      const sequence = before ? cursor.beforeExchangeSeq : cursor.afterExchangeSeq;
      const window = readTimelineWindow(database, conversationId, input.limit, sequence === undefined ? undefined : BigInt(sequence), direction);
      const ordered = [...window.receives.map(row => ({ kind: 'receive', row })), ...window.sends.map(row => ({ kind: 'send', row }))]
        .sort((a, b) => compareRuntimeRowInteger(b.row.exchange_seq, a.row.exchange_seq) * (before ? 1 : -1));
      const oppositeEdge = ordered[0]?.row;
      const oppositeExists = (oppositeEdge !== undefined || sequence !== undefined)
        && ['runtime_delivery_timeline_link', 'collaboration_send_timeline_link'].some(table => queryPlainRows(database, `
          SELECT id FROM ${table} WHERE conversation_id = @conversationId
            ${oppositeEdge ? `AND exchange_seq ${before ? '>' : '<'} @sequence` : ''} LIMIT 1
        `, { conversationId, ...(oppositeEdge ? { sequence: BigInt(String(oppositeEdge.exchange_seq)) } : {}) }).length > 0);
      let count = ordered.length;
      for (;;) {
        const selected = ordered.slice(0, count);
        const hasMore = window.hasMore || count < ordered.length;
        const oldest = selected[before ? selected.length - 1 : 0]?.row;
        const newest = selected[before ? 0 : selected.length - 1]?.row;
        page = collaborationHistoryPage(cursor.kind, direction, {
          records: buildTimelineExchangeRecords(database, conversationId, {
            receives: selected.filter(item => item.kind === 'receive').map(item => item.row),
            sends: selected.filter(item => item.kind === 'send').map(item => item.row)
          }, content),
          nextBeforeCursor: { kind: 'exchange', ...(oldest ? { beforeExchangeSeq: String(oldest.exchange_seq) } : {}) },
          nextAfterCursor: { kind: 'exchange', ...(newest ? { afterExchangeSeq: String(newest.exchange_seq) } : {}) },
          hasMoreBefore: before ? hasMore : oppositeExists,
          hasMoreAfter: before ? oppositeExists : hasMore,
          scanProgress: false, scannedRows: ordered.length
        });
        settleClientWireResponseBytes(page);
        if (page.responseBytes <= CLIENT_PAGE_MAX_BYTES) break;
        if (count <= 1) throw new Error('A single exchange history item exceeds the wire bound.');
        count = Math.max(1, Math.floor(count / 2));
      }
    } else {
      // One exact indexed suffix is materialized before the Inbox join. Empty non-answer
      // windows advance their last inspected delivery key without scanning other Conversations.
      const boundaryCreatedAt = before ? cursor.beforeCreatedAt : cursor.afterCreatedAt;
      const boundaryId = before ? cursor.beforeId : cursor.afterId;
      const candidates = queryPlainRows(database, `
        SELECT * FROM runtime_delivery WHERE target_conversation_id = @conversationId
          ${boundaryCreatedAt === undefined ? '' : `AND (created_at, id) ${before ? '<' : '>'} (@boundaryCreatedAt, @boundaryId)`}
         ORDER BY created_at ${before ? 'DESC' : 'ASC'}, id ${before ? 'DESC' : 'ASC'} LIMIT @limit
      `, { conversationId, limit: BigInt(CLIENT_COLLABORATION_SCAN_MAX_ROWS),
        ...(boundaryCreatedAt === undefined ? {} : { boundaryCreatedAt, boundaryId: boundaryId! }) });
      const inboxes = new Map(queryAllByIds(database, 'runtime_inbox_item', 'id', candidates.map(row => String(row.inbox_item_id))).map(row => [String(row.id), row]));
      const answers = candidates.filter(row => inboxes.get(String(row.inbox_item_id))?.source_kind === 'answer_submission');
      const oppositeEdge = answers[0] ?? candidates[0];
      const oppositeExists = (oppositeEdge !== undefined || boundaryCreatedAt !== undefined) && queryPlainRows(database, `
        SELECT id FROM runtime_delivery WHERE target_conversation_id = @conversationId
          ${oppositeEdge ? `AND (created_at, id) ${before ? '>' : '<'} (@createdAt, @id)` : ''} LIMIT 1
      `, { conversationId, ...(oppositeEdge ? { createdAt: String(oppositeEdge.created_at), id: String(oppositeEdge.id) } : {}) }).length > 0;
      const inspectedEdge = candidates[candidates.length - 1];
      const beyondScan = candidates.length === CLIENT_COLLABORATION_SCAN_MAX_ROWS && inspectedEdge && queryPlainRows(database, `
        SELECT id FROM runtime_delivery WHERE target_conversation_id = @conversationId
          AND (created_at, id) ${before ? '<' : '>'} (@createdAt, @id) LIMIT 1
      `, { conversationId, createdAt: String(inspectedEdge.created_at), id: String(inspectedEdge.id) }).length > 0;
      let count = Math.min(input.limit, answers.length);
      for (;;) {
        const selected = answers.slice(0, count);
        const clipped = count < answers.length;
        const continuedEdge = clipped ? selected[selected.length - 1] : inspectedEdge;
        const oldest = before ? continuedEdge : oppositeEdge;
        const newest = before ? oppositeEdge : continuedEdge;
        const hasMore = clipped || Boolean(beyondScan);
        page = collaborationHistoryPage(cursor.kind, direction, {
          records: buildTimelineExchangeRecords(database, conversationId, { receives: [], sends: [] }, content, selected.map(row => String(row.id))),
          nextBeforeCursor: { kind: 'answer', ...(oldest ? { beforeCreatedAt: String(oldest.created_at), beforeId: String(oldest.id) } : {}) },
          nextAfterCursor: { kind: 'answer', ...(newest ? { afterCreatedAt: String(newest.created_at), afterId: String(newest.id) } : {}) },
          hasMoreBefore: before ? hasMore : oppositeExists,
          hasMoreAfter: before ? oppositeExists : hasMore,
          scanProgress: selected.length === 0 && hasMore, scannedRows: candidates.length
        });
        const selectedIds = new Set(selected.map(row => String(row.id)));
        page.records.RuntimeDelivery = (page.records.RuntimeDelivery ?? []).map(row => selectedIds.has(String(row.id))
          ? { ...row, history_inventory_item: true } : row);
        settleClientWireResponseBytes(page);
        if (page.responseBytes <= CLIENT_PAGE_MAX_BYTES) break;
        if (count <= 1) throw new Error('A single historical answer exceeds the wire bound.');
        count = Math.max(1, Math.floor(count / 2));
      }
    }
    database.exec('COMMIT');
    return page;
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

/** Source transitions are reversible; no transcript time or Message floor is invented. */
function collaborationHistoryPage(kind: ReliableKernelCollaborationHistoryCursor['kind'], direction: 'before' | 'after',
  value: Omit<ClientCollaborationHistoryPageResult, 'nextCursor' | 'hasMore' | 'responseBytes'>): ClientCollaborationHistoryPageResult {
  let { nextBeforeCursor, nextAfterCursor, hasMoreBefore, hasMoreAfter } = value;
  const transitionBefore = !hasMoreBefore && kind !== 'answer';
  const transitionAfter = !hasMoreAfter && kind !== 'exchange';
  if (transitionBefore) { nextBeforeCursor = { kind: kind === 'exchange' ? 'message' : 'answer' }; hasMoreBefore = true; }
  if (transitionAfter) { nextAfterCursor = { kind: kind === 'answer' ? 'message' : 'exchange' }; hasMoreAfter = true; }
  const hasMore = direction === 'before' ? hasMoreBefore : hasMoreAfter;
  const nextCursor = direction === 'before' ? nextBeforeCursor : nextAfterCursor;
  return { ...value, nextBeforeCursor, nextAfterCursor, hasMoreBefore, hasMoreAfter,
    ...(hasMore && nextCursor ? { nextCursor } : {}), hasMore,
    scanProgress: value.scanProgress || (direction === 'before' ? transitionBefore : transitionAfter), responseBytes: 0 };
}

/**
 * Read collaboration envelopes by their own immutable sequence. Message membership (including an
 * empty transcript) is irrelevant. Select only ids connected to this Conversation by an explicit
 * source/target link, then materialize every card dependency in the same SQLite read transaction.
 */
function executeCollaborationMessageInventoryPage(
  database: Database.Database,
  input: { conversationId: string; limit: number; direction: 'before' | 'after'; cursor: Extract<ReliableKernelCollaborationHistoryCursor, { kind: 'message' }> },
  content: ClientProjectionContentAccess
): ClientCollaborationHistoryPageResult {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > CLIENT_PAGE_MAX_ROWS) {
    throw new RangeError(`Collaboration history page limit must be from 1 to ${CLIENT_PAGE_MAX_ROWS}.`);
  }
  const conversationId = requireRuntimeId(input.conversationId);
  const before = input.direction === 'before';
  const boundaryMessageSeq = before ? input.cursor.beforeMessageSeq : input.cursor.afterMessageSeq;
  const boundaryId = before ? input.cursor.beforeId : input.cursor.afterId;
  database.exec('BEGIN');
  try {
    // The epoch-5 Source/Target links index conversation_id with created_at, not message_seq.
    // Sorting all links for every page is unbounded. Inspect one fixed global-sequence window
    // instead; a page without any match advances with the last INSPECTED key, never a guessed time.
    // The unique message_seq makes id a cursor identity check, not a second ordering pass.
    if (boundaryMessageSeq !== undefined) {
      const anchor = queryPlainRows(database, `
        SELECT id FROM collaboration_message INDEXED BY ux_collaboration_message_02
         WHERE message_seq = @boundaryMessageSeq LIMIT 1
      `, { boundaryMessageSeq: BigInt(boundaryMessageSeq) })[0];
      if (anchor?.id !== boundaryId) throw new Error('Collaboration history cursor does not identify its durable sequence.');
    }
    const scanned = queryPlainRows(database, `
      WITH bounded AS MATERIALIZED (
        SELECT message.id, message.message_seq
          FROM collaboration_message AS message INDEXED BY ux_collaboration_message_02
         ${boundaryMessageSeq === undefined ? '' : `WHERE message.message_seq ${before ? '<' : '>'} @boundaryMessageSeq`}
         ORDER BY message.message_seq ${before ? 'DESC' : 'ASC'}
         LIMIT @scanLimit
      )
      SELECT bounded.id, bounded.message_seq,
             CASE WHEN EXISTS (
               SELECT 1 FROM collaboration_message_source_link AS source
                WHERE source.message_id = bounded.id AND source.conversation_id = @conversationId
             ) OR EXISTS (
               SELECT 1 FROM collaboration_message_target_link AS target
                WHERE target.message_id = bounded.id AND target.conversation_id = @conversationId
             ) THEN 1 ELSE 0 END AS in_scope
        FROM bounded
       ORDER BY bounded.message_seq ${before ? 'DESC' : 'ASC'}
    `, {
      conversationId,
      scanLimit: BigInt(CLIENT_COLLABORATION_SCAN_MAX_ROWS),
      ...(boundaryMessageSeq === undefined ? {} : { boundaryMessageSeq: BigInt(boundaryMessageSeq) })
    });
    const lastInspected = scanned[scanned.length - 1];
    const furtherGlobalExists = scanned.length === CLIENT_COLLABORATION_SCAN_MAX_ROWS && lastInspected
      ? queryPlainRows(database, `
          SELECT id FROM collaboration_message INDEXED BY ux_collaboration_message_02
           WHERE message_seq ${before ? '<' : '>'} @lastInspectedSeq LIMIT 1
        `, { lastInspectedSeq: BigInt(String(lastInspected.message_seq)) }).length > 0
      : false;
    const matches = scanned.filter((row) => row.in_scope === 1n || row.in_scope === 1);
    const candidates = matches.slice(0, input.limit + 1);
    const oppositeEdge = candidates[0] ?? scanned[0];
    const oppositeExists = (oppositeEdge !== undefined || boundaryMessageSeq !== undefined) && queryPlainRows(database, `
      SELECT id FROM collaboration_message INDEXED BY ux_collaboration_message_02
       ${oppositeEdge ? `WHERE message_seq ${before ? '>' : '<'} @oppositeSeq` : ''} LIMIT 1
    `, oppositeEdge ? { oppositeSeq: BigInt(String(oppositeEdge.message_seq)) } : {}).length > 0;
    const pageEdges = (continuedEdge: Record<string, unknown> | undefined, hasMore: boolean) => {
      const oldest = before ? continuedEdge : oppositeEdge;
      const newest = before ? oppositeEdge : continuedEdge;
      return {
        nextBeforeCursor: { kind: 'message' as const, ...(oldest ? { beforeMessageSeq: String(oldest.message_seq), beforeId: String(oldest.id) } : {}) },
        nextAfterCursor: { kind: 'message' as const, ...(newest ? { afterMessageSeq: String(newest.message_seq), afterId: String(newest.id) } : {}) },
        hasMoreBefore: before ? hasMore : oppositeExists,
        hasMoreAfter: before ? oppositeExists : hasMore
      };
    };
    if (candidates.length === 0) {
      const empty = collaborationHistoryPage('message', input.direction, {
        records: {}, ...pageEdges(lastInspected, furtherGlobalExists), scanProgress: furtherGlobalExists, scannedRows: scanned.length
      });
      settleClientWireResponseBytes(empty);
      database.exec('COMMIT');
      return empty;
    }
    // Each envelope's CAS preview and each peer's title are read once for this page; trimming the
    // page under the byte cap only reselects them.
    const projectedMessages = new Map<string, DomainRow>();
    const projectMessage = (id: string): DomainRow => {
      let record = projectedMessages.get(id);
      if (!record) {
        record = projectCollaborationMessageRecord(database, id, content);
        projectedMessages.set(id, record);
      }
      return record;
    };
    let projectedPeers: Map<string, Record<string, unknown>> | undefined;
    const projectPeers = (peerIds: readonly string[]): Array<Record<string, unknown>> => {
      if (!projectedPeers) {
        const allIds = candidates.map((row) => String(row.id));
        const allLinks = [
          ...queryAllByIds(database, 'collaboration_message_source_link', 'message_id', allIds),
          ...queryAllByIds(database, 'collaboration_message_target_link', 'message_id', allIds)
        ];
        projectedPeers = new Map(projectCollaborationPeerConversations(database, conversationId,
          allLinks.map((row) => String(row.conversation_id)), content).map((row) => [String(row.id), row]));
      }
      const peers = projectedPeers;
      return [...new Set(peerIds)].filter((id) => id && id !== conversationId).sort()
        .flatMap((id) => peers.has(id) ? [peers.get(id)!] : []);
    };
    const materialize = (count: number): ClientCollaborationHistoryPageResult => {
      const selected = candidates.slice(0, count);
      const ids = selected.map((row) => String(row.id));
      const records: Record<string, DomainRow[]> = {};
      const include = (domain: string, rows: readonly Record<string, unknown>[]): void => {
        if (rows.length > 0) records[domain] = mergeRowsById(rows).map((row) => {
          const bounded = boundClientRecordSummary(row, domain);
          if (clientWireBytes(bounded) > CLIENT_WINDOW_RECORD_SUMMARY_MAX_BYTES) {
            throw new Error(`Collaboration history ${domain} record exceeds summary byte limit.`);
          }
          return bounded;
        });
      };
      include('CollaborationMessage', (before ? [...ids].reverse() : ids).map(projectMessage));
      const sources = queryAllByIds(database, 'collaboration_message_source_link', 'message_id', ids);
      const targets = queryAllByIds(database, 'collaboration_message_target_link', 'message_id', ids);
      if (sources.length !== ids.length || targets.length !== ids.length) {
        throw new Error('Collaboration history requires exactly one source and target link per message.');
      }
      include('CollaborationMessageSourceLink', sources);
      include('CollaborationMessageTargetLink', targets);
      const messageParameters: Record<string, string | bigint> = {};
      const messagePlaceholders = ids.map((id, index) => {
        messageParameters[`message${index}`] = id;
        return `@message${index}`;
      });
      const deliveries = queryIdListRows(database, `
        SELECT delivery.* FROM collaboration_message_target_link AS target
        JOIN runtime_delivery AS delivery ON delivery.id = (
          SELECT newest.id FROM runtime_delivery AS newest
           WHERE newest.inbox_item_id = target.inbox_item_id
             AND newest.target_conversation_id = target.conversation_id
           ORDER BY newest.attempt_seq DESC LIMIT 1
        )
       WHERE target.message_id IN (${messagePlaceholders.join(',')})
      `, messageParameters, { count: messagePlaceholders.length });
      include('RuntimeDelivery', deliveries);
      const turnIds = [...new Set([
        ...sources.map((row) => row.turn_id),
        ...deliveries.map((row) => row.target_turn_id)
      ].filter((id): id is string => typeof id === 'string' && id.length > 0))];
      include('Turn', queryAllByIds(database, 'turn', 'id', turnIds)
        .filter((turn) => turn.conversation_id === conversationId));
      include('CollaborationPeerConversation', projectPeers([
        ...sources.map((row) => String(row.conversation_id)),
        ...targets.map((row) => String(row.conversation_id))
      ]));
      const continued = selected[selected.length - 1];
      // If the byte cap shortened a page, resume at its oldest OUTPUT row: newer matches in the
      // inspected window must never be skipped. Only a completely materialized underfull page can
      // advance across an inspected stretch of unrelated Conversations (including a zero-row page).
      const progress = count === candidates.length && candidates.length < input.limit && furtherGlobalExists;
      const page = collaborationHistoryPage('message', input.direction, {
        records, ...pageEdges(progress ? lastInspected : continued, matches.length > count || furtherGlobalExists),
        scanProgress: progress, scannedRows: scanned.length
      });
      settleClientWireResponseBytes(page);
      return page;
    };
    // The whole candidate page usually fits: try it first, and only search a shorter prefix when
    // the byte cap is actually crossed.
    const maximumCount = Math.min(input.limit, candidates.length);
    const full = materialize(maximumCount);
    let page: ClientCollaborationHistoryPageResult | undefined = full.responseBytes <= CLIENT_PAGE_MAX_BYTES ? full : undefined;
    let low = 1;
    let high = page ? 0 : maximumCount - 1;
    while (low <= high) {
      const count = Math.floor((low + high) / 2);
      const candidate = materialize(count);
      if (candidate.responseBytes <= CLIENT_PAGE_MAX_BYTES) {
        page = candidate;
        low = count + 1;
      } else {
        high = count - 1;
      }
    }
    if (!page) {
      throw new Error('A single collaboration history summary exceeds maxPageBytes.');
    }
    database.exec('COMMIT');
    return page;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

const HISTORY_TABLE_DOMAINS = new Map(DOMAIN_REPOSITORIES.all().map(repository => [repository.schema.table, repository.schema.key]));

function buildClientVisibleMessageHistoryRecords(
  database: Database.Database,
  messages: readonly Record<string, unknown>[],
  content: ClientProjectionContentAccess,
  facts: Map<string, DomainRow[]>
): Record<string, DomainRow[]> {
  const records: Record<string, DomainRow[]> = {};
  const include = (domain: string, rows: readonly Record<string, unknown>[]): void => {
    const unique = mergeRowsById(rows);
    if (!facts.has(domain)) facts.set(domain, unique);
    if (unique.length > 0) records[domain] = unique;
  };
  const cachedRows = (domain: string, column: string, ids: readonly string[], read: () => DomainRow[]): DomainRow[] => {
    const cached = facts.get(domain);
    if (!cached) return read();
    const selected = new Set(ids);
    return cached.filter(row => selected.has(String(row[column])));
  };
  const readRows = (_database: Database.Database, table: string, column: string, ids: readonly string[]): DomainRow[] =>
    cachedRows(HISTORY_TABLE_DOMAINS.get(table)!, column, ids, () => queryAllByIds(database, table, column, ids));
  const messageIds = messages.map((row) => String(row.id));
  include('Message', cachedRows('Message', 'id', messageIds,
    () => messages.map(row => projectLogicalMessageMetadata(database, row, content))));

  const messageTurnLinks = readRows(database, 'message_turn_link', 'message_id', messageIds);
  const requestMessageLinks = readRows(database, 'model_request_message_link', 'message_id', messageIds);
  const sourceLinks = readRows(database, 'tool_call_source_link', 'message_id', messageIds);
  include('MessageTurnLink', messageTurnLinks);
  include('ModelRequestMessageLink', requestMessageLinks);
  include('ToolCallSourceLink', sourceLinks);

  const requestIds = [...new Set([
    ...requestMessageLinks.map((row) => String(row.model_request_id)),
    ...sourceLinks.map((row) => String(row.model_request_id))
  ])];
  const modelRequests = readRows(database, 'model_request', 'id', requestIds)
    .sort(compareModelRequestRows);
  include('ModelRequest', facts.has('ModelRequest') ? modelRequests : singleResponseMeasurementReader(database, content).project(modelRequests));
  include('ModelContextProjection', cachedRows(
    'ModelContextProjection',
    'owner_id',
    requestIds,
    () => queryModelContextProjectionsByRequestIds(database, requestIds)
  ));

  const toolCallIds = [...new Set(sourceLinks.map((row) => String(row.tool_call_id)))];
  const toolCalls = readRows(database, 'tool_call', 'id', toolCallIds)
    .sort(compareToolCallRows);
  include('ToolCall', toolCalls);
  include('ToolCallPolicySnapshot', readRows(database, 'tool_call_policy_snapshot', 'tool_call_id', toolCallIds));
  include('ToolCallEvent', cachedRows('ToolCallEvent', 'tool_call_id', toolCallIds, () => queryLatestToolCallEvents(database, toolCallIds)));
  include('ToolExecution', readRows(database, 'tool_execution', 'tool_call_id', toolCallIds));
  include('ToolOutcome', readRows(database, 'tool_outcome', 'tool_call_id', toolCallIds));
  include('ToolModelResult', readRows(database, 'tool_model_result', 'tool_call_id', toolCallIds));
  include('ToolResultArtifact', readRows(database, 'tool_result_artifact', 'tool_call_id', toolCallIds));

  const interactionToolLinks = readRows(database, 'interaction_tool_call_link', 'tool_call_id', toolCallIds);
  const interactionRequestIds = [...new Set(interactionToolLinks.map((row) => String(row.request_id)))];
  const interactionRequests = readRows(database, 'interaction_request', 'id', interactionRequestIds);
  const interactionOwnerLinks = readRows(database, 'interaction_owner_link', 'request_id', interactionRequestIds);
  include('InteractionToolCallLink', interactionToolLinks);
  include('InteractionRequest', interactionRequests);
  include('InteractionOwnerLink', interactionOwnerLinks);
  include('InteractionResponse', readRows(database, 'interaction_response', 'request_id', interactionRequestIds));

  const fileChangeSets = readRows(database, 'file_change_set', 'tool_call_id', toolCallIds);
  const fileChangeSetIds = fileChangeSets.map((row) => String(row.id));
  const fileMutationReceipts = readRows(database, 'file_mutation_receipt', 'change_set_id', fileChangeSetIds);
  include('FileChangeSet', fileChangeSets);
  include('FileChangeSetMember', readRows(database, 'file_change_set_member', 'change_set_id', fileChangeSetIds));
  include('FileChangeDecision', readRows(database, 'file_change_decision', 'change_set_id', fileChangeSetIds));
  include('FileMutationReceipt', fileMutationReceipts);
  include('FileMutationReceiptMember', readRows(
    database,
    'file_mutation_receipt_member',
    'receipt_id',
    fileMutationReceipts.map((row) => String(row.id))
  ));

  const processOriginLinks = readRows(database, 'process_origin_link', 'tool_call_id', toolCallIds);
  const processIds = [...new Set(processOriginLinks.map((row) => String(row.process_id)))];
  const processes = readRows(database, 'process', 'id', processIds)
    .map((row) => facts.has('Process') ? row : projectProcessRecord(database, String(row.id), content));
  include('ProcessOriginLink', processOriginLinks);
  include('Process', processes);
  include('ProcessReceipt', readRows(database, 'process_receipt', 'process_id', processIds));

  const childParentLinks = readRows(database, 'child_execution_parent_link', 'source_tool_call_id', toolCallIds);
  const childExecutionIds = [...new Set(childParentLinks.map((row) => String(row.child_execution_id)))];
  const childExecutions = readRows(database, 'child_execution', 'id', childExecutionIds);
  const childActiveLinks = readRows(database, 'child_execution_active_turn_link', 'child_execution_id', childExecutionIds);
  const childTurnLinks = cachedRows('ChildExecutionTurnLink', 'child_execution_id', childExecutionIds, () => queryLatestChildExecutionTurnLinks(database, childExecutionIds));
  const childTurnIds = [...new Set([
    ...childActiveLinks.map((row) => String(row.turn_id)),
    ...childTurnLinks.map((row) => String(row.turn_id))
  ])];
  include('ChildExecutionParentLink', childParentLinks);
  include('ChildExecution', childExecutions);
  include('ChildExecutionActiveTurnLink', childActiveLinks);
  include('ChildExecutionTurnLink', childTurnLinks);
  include('AgentConversationLink', readRows(
    database,
    'agent_conversation_link',
    'conversation_id',
    childExecutions.map((row) => String(row.child_conversation_id))
  ));

  const answerBridges = readRows(database, 'answer_bridge', 'child_execution_id', childExecutionIds)
    .map((row) => facts.has('AnswerBridge') ? row : projectAnswerBridgeRecord(database, String(row.id)));
  include('AnswerBridge', answerBridges);
  const answerIds = answerBridges.flatMap(row => row.current_submission_id ? [String(row.current_submission_id)] : []);
  include('AnswerSubmission', cachedRows('AnswerSubmission', 'id', answerIds,
    () => projectAnswerSubmissionRecords(database, answerIds)));

  const rootTurnIds = [
    ...messageTurnLinks.map((row) => String(row.turn_id)),
    ...modelRequests.map((row) => String(row.turn_id)),
    ...toolCalls.map((row) => String(row.turn_id)),
    ...interactionOwnerLinks.map((row) => String(row.turn_id)),
    ...childParentLinks.flatMap((row) => row.parent_turn_id ? [String(row.parent_turn_id)] : [])
  ];
  const turnIds = [...new Set([...rootTurnIds, ...childTurnIds])];
  const turns = readRows(database, 'turn', 'id', turnIds)
    .map((row) => !facts.has('Turn') && row.status === 'active' ? projectTurnClientRecord(database, String(row.id), content) : row)
    .sort(compareTurnRows);
  include('Turn', turns);
  include('ExecutionLease', readRows(database, 'execution_lease', 'turn_id', turnIds));
  include('TurnTermination', readRows(database, 'turn_termination', 'turn_id', turnIds));
  include('TurnExecutorLink', readRows(database, 'turn_executor_link', 'turn_id', turnIds));
  return records;
}

/** Fixed SQL text: reuses the connection's prepared Statement. */
function queryPlainRows(
  database: Pick<Database.Database, 'prepare'>,
  sql: string,
  parameters: Record<string, string | bigint | null> = {}
): Array<Record<string, unknown>> {
  return prepareCached(database, sql).all(parameters) as Array<Record<string, unknown>>;
}

/**
 * SQL text that embeds one placeholder per id, so each list length is a different text. At one
 * call site a single id (or none) and a full chunk always give the same text and reuse the
 * connection's prepared Statement; any other length (a trailing partial chunk) is prepared for
 * this call only and never enters the bounded statement cache.
 */
function queryIdListRows(
  database: Pick<Database.Database, 'prepare'>,
  sql: string,
  parameters: Record<string, string | bigint | null>,
  ids: { count: number; chunkSize?: number }
): Array<Record<string, unknown>> {
  const fixedText = ids.count <= 1 || ids.count === ids.chunkSize;
  return (fixedText ? prepareCached(database, sql) : prepareUncached(database, sql))
    .all(parameters) as Array<Record<string, unknown>>;
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
      FROM process INDEXED BY ix_process_01
      CROSS JOIN process_origin_link AS origin ON origin.process_id = process.id
      CROSS JOIN tool_call ON tool_call.id = origin.tool_call_id
      CROSS JOIN turn ON turn.id = tool_call.turn_id
     WHERE process.status = 'running'
       AND turn.conversation_id = @conversationId
     ORDER BY process.started_at DESC, process.id DESC
  `, { conversationId });
}

function queryClientChildExecutions(
  database: Database.Database,
  conversationId: string
): Array<Record<string, unknown>> {
  return queryPlainRows(database, `
    WITH matched_child_ids(id) AS (
      SELECT child.id
        FROM child_execution AS child
       WHERE child.child_conversation_id = @conversationId
      UNION
      SELECT child.id
        FROM turn AS source_turn
        CROSS JOIN tool_call AS source_call ON source_call.turn_id = source_turn.id
        CROSS JOIN child_execution_parent_link AS parent_link ON parent_link.source_tool_call_id = source_call.id
        CROSS JOIN child_execution AS child ON child.id = parent_link.child_execution_id
       WHERE source_turn.conversation_id = @conversationId
         AND child.status NOT IN ('closed', 'needs_human')
    )
    SELECT child.*
      FROM matched_child_ids
      CROSS JOIN child_execution AS child ON child.id = matched_child_ids.id
     WHERE EXISTS (
       SELECT 1 FROM child_execution_parent_link AS parent_link
        WHERE parent_link.child_execution_id = child.id
     )
     ORDER BY child.created_at DESC, child.id DESC
  `, { conversationId });
}

/**
 * The selected Conversation's own collaboration envelopes (message bodies stay in CAS): every
 * message it sent from, or had delivered into, one of the loaded Turns, plus incoming messages
 * still waiting for a Turn or failed before reaching one. Bounded by durable sequence. The
 * candidates come from this Conversation's source/target link indexes, so the cost follows its own
 * traffic rather than every message in the Runtime.
 */
export function queryCollaborationMessagesForTurns(
  database: Pick<Database.Database, 'prepare'>,
  conversationId: string,
  loadedTurnIds: readonly string[]
): Array<Record<string, unknown>> {
  const parameters: Record<string, string | bigint> = { conversationId, limit: BigInt(CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE) };
  const turnIds = [...new Set(loadedTurnIds)];
  const turnList = turnIds.map((id, index) => {
    parameters[`turn${index}`] = id;
    return `@turn${index}`;
  }).join(',');
  const inLoadedTurns = (column: string) => turnList ? `${column} IN (${turnList})` : '0';
  return queryIdListRows(database, `
    SELECT message.*
      FROM collaboration_message AS message
     WHERE message.id IN (
             SELECT source.message_id
               FROM collaboration_message_source_link AS source
              WHERE source.conversation_id = @conversationId
                AND ${inLoadedTurns('source.turn_id')}
             UNION
             SELECT target.message_id
               FROM collaboration_message_target_link AS target
               JOIN runtime_delivery AS delivery
                 ON delivery.inbox_item_id = target.inbox_item_id
                AND delivery.target_conversation_id = @conversationId
              WHERE target.conversation_id = @conversationId
                AND (delivery.state IN ('pending', 'failed') OR ${inLoadedTurns('delivery.target_turn_id')})
           )
     ORDER BY message.message_seq DESC, message.id DESC
     LIMIT @limit
  `, parameters, { count: turnIds.length });
}

function queryClientRuntimeDeliveries(
  database: Database.Database,
  conversationId: string
): Array<Record<string, unknown>> {
  // Materialize bounded indexed state suffixes before combining them. Pending/failed attention
  // remains represented without gathering every historical failed attempt into the live snapshot.
  const byState = ['pending', 'failed', 'consumed'].map(state => queryPlainRows(database, `
    SELECT * FROM runtime_delivery WHERE target_conversation_id = @conversationId AND state = @state
     ORDER BY created_at DESC, id DESC LIMIT @limit
  `, { conversationId, state, limit: BigInt(CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE) }));
  const recent = byState.flat().sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))
    || String(right.id).localeCompare(String(left.id)));
  return mergeRowsById([...byState[0].slice(0, 3), ...byState[1].slice(0, 3), ...recent])
    .slice(0, CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE);
}

function queryVisibleMessageRowsByIds(
  database: Database.Database,
  conversationId: string,
  messageIds: readonly string[]
): Array<Record<string, unknown>> {
  const unique = [...new Set(messageIds)];
  const rows: Array<Record<string, unknown>> = [];
  const chunkSize = 350;
  for (let offset = 0; offset < unique.length; offset += chunkSize) {
    const chunk = unique.slice(offset, offset + chunkSize);
    if (chunk.length === 0) continue;
    const parameters: Record<string, string | bigint> = { conversationId };
    const placeholders = chunk.map((id, index) => {
      parameters[`message${index}`] = id;
      return `@message${index}`;
    });
    rows.push(...queryIdListRows(database, `
      WITH ranked_visible AS (
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
               ROW_NUMBER() OVER (
                 ORDER BY membership.message_seq ASC, message.id ASC
               ) AS display_seq
          FROM message_part_of_conversation AS membership
          JOIN message ON message.id = membership.message_id
          JOIN message_current_revision_link AS current_revision ON current_revision.message_id = message.id
          JOIN message_revision AS revision ON revision.id = current_revision.revision_id
         WHERE membership.conversation_id = @conversationId
           AND membership.message_seq <= (
             SELECT MAX(message_seq) FROM message_part_of_conversation
              WHERE conversation_id = @conversationId AND message_id IN (${placeholders.join(',')})
           )
           AND message.deleted_at IS NULL
           AND revision.role IN ('user', 'model')
      )
      SELECT ranked.id,
             ranked.conversation_id,
             ranked.message_seq,
             ranked.created_at,
             ranked.updated_at,
             ranked.deleted_at,
             ranked.revision_id,
             ranked.revision_seq,
             ranked.role,
             ranked.content_object_id,
             content.content_type,
             content.byte_length,
             ${messageItemIndexRevisionSql({
               id: 'ranked.revision_id',
               messageId: 'ranked.id',
               revisionSeq: 'ranked.revision_seq'
             })} AS item_index_revision_id,
             ranked.display_seq
        FROM ranked_visible AS ranked
        JOIN content_object AS content ON content.id = ranked.content_object_id
       WHERE ranked.id IN (${placeholders.join(',')})
       ORDER BY ranked.message_seq ASC, ranked.id ASC
    `, parameters, { count: chunk.length, chunkSize }));
  }
  return mergeRowsById(rows);
}

function queryLatestToolCallEvents(
  database: Database.Database,
  toolCallIds: readonly string[]
): Array<Record<string, unknown>> {
  const unique = [...new Set(toolCallIds)];
  const rows: Array<Record<string, unknown>> = [];
  const chunkSize = 350;
  for (let offset = 0; offset < unique.length; offset += chunkSize) {
    const chunk = unique.slice(offset, offset + chunkSize);
    if (chunk.length === 0) continue;
    const parameters: Record<string, string | bigint> = {
      eventLimit: BigInt(CLIENT_TOOL_EVENT_SUMMARY_LIMIT_PER_CALL)
    };
    const placeholders = chunk.map((id, index) => {
      parameters[`tool${index}`] = id;
      return `@tool${index}`;
    });
    rows.push(...queryIdListRows(database, `
      SELECT event.*
        FROM tool_call AS call
        JOIN tool_call_event AS event ON event.id IN (
          SELECT recent.id FROM tool_call_event AS recent
           WHERE recent.tool_call_id = call.id
           ORDER BY recent.event_seq DESC, recent.id DESC
           LIMIT @eventLimit
        )
       WHERE call.id IN (${placeholders.join(',')})
       ORDER BY event.tool_call_id ASC, event.event_seq ASC, event.id ASC
    `, parameters, { count: chunk.length, chunkSize }));
  }
  return rows;
}

function queryLatestChildExecutionTurnLinks(
  database: Database.Database,
  childExecutionIds: readonly string[]
): Array<Record<string, unknown>> {
  const unique = [...new Set(childExecutionIds)];
  const rows: Array<Record<string, unknown>> = [];
  const chunkSize = 350;
  for (let offset = 0; offset < unique.length; offset += chunkSize) {
    const chunk = unique.slice(offset, offset + chunkSize);
    if (chunk.length === 0) continue;
    const parameters: Record<string, string | bigint> = {};
    const placeholders = chunk.map((id, index) => {
      parameters[`child${index}`] = id;
      return `@child${index}`;
    });
    rows.push(...queryIdListRows(database, `
      SELECT link.id, link.child_execution_id, link.turn_seq, link.turn_id, link.created_at
        FROM child_execution AS child
        JOIN child_execution_turn_link AS link ON link.id = (
          SELECT recent.id FROM child_execution_turn_link AS recent
           WHERE recent.child_execution_id = child.id
           ORDER BY recent.turn_seq DESC, recent.id DESC
           LIMIT 1
        )
       WHERE child.id IN (${placeholders.join(',')})
       ORDER BY link.child_execution_id ASC, link.turn_seq ASC, link.id ASC
    `, parameters, { count: chunk.length, chunkSize }));
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
  return queryIdListRows(database, `
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
  `, parameters, { count: unique.length });
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
  const chunkSize = 400;
  for (let offset = 0; offset < unique.length; offset += chunkSize) {
    const chunk = unique.slice(offset, offset + chunkSize);
    const parameters: Record<string, string | bigint> = {};
    const placeholders = chunk.map((id, index) => {
      parameters[`id${index}`] = id;
      return `@id${index}`;
    });
    rows.push(...queryIdListRows(database, `
      SELECT * FROM ${quote(table)}
       WHERE ${quote(column)} IN (${placeholders.join(',')})
       ORDER BY id ASC
    `, parameters, { count: chunk.length, chunkSize }));
  }
  return rows;
}

function queryModelContextProjectionsByRequestIds(
  database: Database.Database,
  requestIds: readonly string[]
): Array<Record<string, unknown>> {
  const unique = [...new Set(requestIds)];
  const rows: Array<Record<string, unknown>> = [];
  const chunkSize = 400;
  for (let offset = 0; offset < unique.length; offset += chunkSize) {
    const chunk = unique.slice(offset, offset + chunkSize);
    const parameters: Record<string, string | bigint> = {};
    const placeholders = chunk.map((id, index) => {
      parameters[`id${index}`] = id;
      return `@id${index}`;
    });
    rows.push(...queryIdListRows(database, `
      SELECT * FROM model_context_projection
       WHERE owner_kind = 'model_request'
         AND owner_id IN (${placeholders.join(',')})
       ORDER BY id ASC
    `, parameters, { count: chunk.length, chunkSize }));
  }
  return rows;
}

function queryAnswerSubmissionInboxItems(
  database: Database.Database,
  submissionIds: readonly string[]
): Array<Record<string, unknown>> {
  const unique = [...new Set(submissionIds)];
  const rows: Array<Record<string, unknown>> = [];
  const chunkSize = 400;
  for (let offset = 0; offset < unique.length; offset += chunkSize) {
    const chunk = unique.slice(offset, offset + chunkSize);
    const parameters: Record<string, string | bigint> = {};
    const placeholders = chunk.map((id, index) => {
      parameters[`id${index}`] = id;
      return `@id${index}`;
    });
    rows.push(...queryIdListRows(database, `
      SELECT * FROM runtime_inbox_item
       WHERE source_kind = 'answer_submission'
         AND source_id IN (${placeholders.join(',')})
       ORDER BY id ASC
    `, parameters, { count: chunk.length, chunkSize }));
  }
  return rows;
}

function queryConversationLastMessageSeqs(
  database: Database.Database,
  conversationIds: readonly string[]
): Map<string, bigint> {
  if (conversationIds.length === 0) return new Map();
  const rows = queryConversationIdChunks(database, conversationIds, (placeholders) => `
    SELECT membership.conversation_id, COALESCE(MAX(membership.message_seq), 0) AS last_message_seq
      FROM message_part_of_conversation AS membership
     WHERE membership.conversation_id IN (${placeholders})
     GROUP BY membership.conversation_id
  `);
  return new Map(rows.map((row) => [String(row.conversation_id), BigInt(String(row.last_message_seq))]));
}

function queryConversationMessageSummaries(
  database: Database.Database,
  conversationIds: readonly string[]
): Array<Record<string, unknown>> {
  return queryConversationIdChunks(database, conversationIds, (placeholders) => `
    SELECT membership.conversation_id,
           COUNT(*) AS message_count,
           COALESCE(MAX(membership.message_seq), 0) AS last_message_seq
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
    SELECT conversation.id AS conversation_id, revision.id AS revision_id
      FROM conversation
      JOIN message_revision AS revision ON revision.id = (
        SELECT current.revision_id
          FROM message_part_of_conversation AS membership
          JOIN message ON message.id = membership.message_id
          JOIN message_current_revision_link AS current ON current.message_id = message.id
          JOIN message_revision AS candidate ON candidate.id = current.revision_id
         WHERE membership.conversation_id = conversation.id
           AND message.deleted_at IS NULL
           AND candidate.role = 'user'
         ORDER BY membership.message_seq ASC, membership.message_id ASC
         LIMIT 1
      )
     WHERE conversation.id IN (${placeholders})
  `);
}

function queryLatestVisibleRevisions(
  database: Database.Database,
  conversationIds: readonly string[]
): Array<Record<string, unknown>> {
  return queryConversationIdChunks(database, conversationIds, (placeholders) => `
    SELECT conversation.id AS conversation_id, revision.id AS revision_id
      FROM conversation
      JOIN message_revision AS revision ON revision.id = (
        SELECT current.revision_id
          FROM message_part_of_conversation AS membership
          JOIN message ON message.id = membership.message_id
          JOIN message_current_revision_link AS current ON current.message_id = message.id
          JOIN message_revision AS candidate ON candidate.id = current.revision_id
         WHERE membership.conversation_id = conversation.id
           AND message.deleted_at IS NULL
           AND candidate.role IN ('user', 'model')
         ORDER BY membership.message_seq DESC, membership.message_id DESC
         LIMIT 1
      )
     WHERE conversation.id IN (${placeholders})
  `);
}

function queryConversationIdChunks(
  database: Database.Database,
  conversationIds: readonly string[],
  sql: (placeholders: string) => string
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const unique = [...new Set(conversationIds)];
  const chunkSize = 400;
  for (let offset = 0; offset < unique.length; offset += chunkSize) {
    const chunk = unique.slice(offset, offset + chunkSize);
    const parameters: Record<string, string | bigint> = {};
    const placeholders = chunk.map((id, index) => {
      parameters[`conversation${index}`] = id;
      return `@conversation${index}`;
    }).join(',');
    rows.push(...queryIdListRows(database, sql(placeholders), parameters, { count: chunk.length, chunkSize }));
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
  const visibleLinkUnion = visiblePlaceholders.length > 0
    ? `UNION
       SELECT visible_link.model_request_id AS id
         FROM model_request_message_link AS visible_link
        WHERE visible_link.message_id IN (${visiblePlaceholders.join(',')})`
    : '';
  return queryIdListRows(database, `
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
    ), selected_request_ids(id) AS (
      SELECT id FROM independent_request_tail
      ${visibleLinkUnion}
    )
    SELECT request.*
      FROM selected_request_ids
      CROSS JOIN model_request AS request ON request.id = selected_request_ids.id
      CROSS JOIN turn AS owner_turn ON owner_turn.id = request.turn_id
     WHERE owner_turn.conversation_id = @conversationId
     ORDER BY owner_turn.created_at DESC, request.request_seq DESC, request.id DESC
  `, parameters, { count: visiblePlaceholders.length }).reverse();
}

function wireJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, (_key, nested) =>
    typeof nested === 'bigint' ? nested.toString() : nested
  ), 'utf8');
}
