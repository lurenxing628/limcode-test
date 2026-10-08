import type Database from 'better-sqlite3';
import { prepareCached } from './runtimeStatementCache';
import { requireRuntimeId } from './runtimeSqlRows';

export interface SelectedContextAuthoritySourceInput {
  conversationId: string;
  /** Omitted for the current head; supplied only for an exact immutable historical root. */
  contextRootId?: string;
  /** Only the child's own driver Turns may provide authority when this scope is supplied. */
  childExecutionId?: string;
}

export interface SelectedContextAuthoritySource {
  contextRootId: string | null;
  /** The observed ConversationContextHeadLink id, retained even when no source exists. */
  contextHeadId: string | null;
  isChildConversation: boolean;
  source?: {
    authoritySnapshotId: string;
    contentObjectId: string;
    sourceTurnId: string;
  };
}

interface ContextNode {
  id: string;
  parent_node_id: string | null;
  segment_id: string;
  segment_kind: string;
  content_object_id: string;
}

interface SourceTurn {
  source_turn_id: string | null;
  authority_snapshot_id: string | null;
  invalid_source: bigint;
}

const CHILD_SCOPE = `(@childExecutionId IS NULL OR owner.id IS NULL OR EXISTS (
  SELECT 1 FROM child_execution_turn_link AS child
   WHERE child.turn_id = owner.id AND child.child_execution_id = @childExecutionId
))`;

/**
 * The caller owns one fenced reader transaction. Walk only the selected parent chain, newest
 * first, and stop at the first exact authority. No historical Turn order or CAS body scan is used.
 * Shared fork segments resolve through this Conversation's source objects; a child's copied
 * parent history is excluded by its explicit driver membership when that scope is requested.
 */
export function readSelectedContextAuthoritySource(
  database: Database.Database,
  input: SelectedContextAuthoritySourceInput
): SelectedContextAuthoritySource {
  const conversationId = requireRuntimeId(input.conversationId);
  const childExecutionId = input.childExecutionId === undefined ? null : requireRuntimeId(input.childExecutionId);
  const childConversations = prepareCached(database, 'SELECT id FROM child_execution WHERE child_conversation_id = ? LIMIT 2')
    .all(conversationId) as Array<{ id: string }>;
  if (childConversations.length > 1) throw new Error('Selected Context Conversation has ambiguous ChildExecution facts.');
  if (childExecutionId !== null && childConversations[0]?.id !== childExecutionId) {
    throw new Error('Selected Context child scope does not belong to its Conversation.');
  }
  const head = prepareCached(database, 'SELECT id, root_id FROM conversation_context_head_link WHERE conversation_id = ?')
    .get(conversationId) as { id: string; root_id: string } | undefined;
  const contextRootId = input.contextRootId === undefined
    ? head ? requireRuntimeId(head.root_id) : null
    : requireRuntimeId(input.contextRootId);
  const result: SelectedContextAuthoritySource = {
    contextRootId, contextHeadId: head ? requireRuntimeId(head.id) : null,
    isChildConversation: childConversations.length === 1
  };
  if (contextRootId === null) return result;
  const root = prepareCached(database, `SELECT conversation_id, root_node_id, tail_node_id,
    tail_segment_count, segment_count FROM context_sequence_root WHERE id = ?`)
    .get(contextRootId) as {
      conversation_id: string; root_node_id: string | null; tail_node_id: string | null;
      tail_segment_count: bigint; segment_count: bigint;
    } | undefined;
  if (!root || root.conversation_id !== conversationId) {
    throw new Error(`Selected ContextSequenceRoot ${contextRootId} does not belong to Conversation ${conversationId}.`);
  }
  const segmentCount = count(root.segment_count, 'ContextSequenceRoot.segment_count');
  const tailCount = count(root.tail_segment_count, 'ContextSequenceRoot.tail_segment_count');
  if (root.root_node_id === null) {
    if (root.tail_node_id !== null || tailCount !== 0 || segmentCount !== 0) {
      throw new Error(`Selected ContextSequenceRoot ${contextRootId} has an invalid empty shape.`);
    }
    return result;
  }
  const rootNode = readNode(database, requireRuntimeId(root.root_node_id));
  const parameters = { conversationId, childExecutionId };
  const visit = (start: ContextNode, length: number, completeChain = true): SelectedContextAuthoritySource['source'] | undefined => {
    if (length === 0) throw new Error(`Selected ContextSequenceRoot ${contextRootId} has an invalid chain count.`);
    let node = start;
    for (let remaining = length; remaining > 0; remaining -= 1) {
      if ((remaining > 1 && node.parent_node_id === null)
        || (completeChain && remaining === 1 && node.parent_node_id !== null)) {
        throw new Error(`Selected ContextSequenceRoot ${contextRootId} parent chain/count mismatch.`);
      }
      const source = sourceForNode(database, node, parameters);
      if (source) return source;
      if (remaining > 1) node = readNode(database, requireRuntimeId(node.parent_node_id));
    }
    return undefined;
  };
  let source: SelectedContextAuthoritySource['source'];
  if (rootNode.segment_kind === 'compression') {
    if (rootNode.parent_node_id !== null || (tailCount === 0) !== (root.tail_node_id === null)
      || segmentCount !== tailCount + 1) {
      throw new Error(`Selected compression ContextSequenceRoot ${contextRootId} has an invalid summary/tail shape.`);
    }
    source = root.tail_node_id === null ? undefined : visit(readNode(database, requireRuntimeId(root.tail_node_id)), tailCount, false);
    source ??= sourceForNode(database, rootNode, parameters);
  } else {
    if (root.tail_node_id !== null || tailCount !== 0) {
      throw new Error(`Selected ordinary ContextSequenceRoot ${contextRootId} must not carry a compression tail.`);
    }
    source = visit(rootNode, segmentCount);
  }
  return source ? { ...result, source } : result;
}

function readNode(database: Database.Database, nodeId: string): ContextNode {
  const node = prepareCached(database, `SELECT node.id, node.parent_node_id, node.segment_id,
    segment.segment_kind, segment.content_object_id
    FROM context_sequence_node AS node JOIN context_segment AS segment ON segment.id = node.segment_id
    WHERE node.id = ?`).get(nodeId) as ContextNode | undefined;
  if (!node) throw new Error(`Selected ContextSequenceNode ${nodeId} does not exist or has no segment.`);
  return node;
}

function sourceForNode(
  database: Database.Database,
  node: ContextNode,
  scope: { conversationId: string; childExecutionId: string | null }
): SelectedContextAuthoritySource['source'] | undefined {
  if (node.segment_kind === 'system') return undefined;
  const parameters = { ...scope, segmentId: node.segment_id, contentObjectId: node.content_object_id };
  const sourceKinds = node.segment_kind === 'message' ? ['message_revision']
    : node.segment_kind === 'tool_pair' ? ['tool_call', 'tool_model_result']
      : node.segment_kind === 'compression' ? ['compression_block'] : ['runtime_context'];
  // Each excluded range uses (segment_id,source_kind); valid shared segments need no full
  // provenance scan merely to prove that an unsupported source kind is absent.
  const excludedRanges = [`source_kind < '${sourceKinds[0]}'`,
    ...sourceKinds.slice(1).map((kind, index) => `source_kind > '${sourceKinds[index]}' AND source_kind < '${kind}'`),
    `source_kind > '${sourceKinds[sourceKinds.length - 1]}'`];
  const invalidShape = prepareCached(database, `SELECT 1 WHERE
    NOT EXISTS (SELECT 1 FROM context_segment_source WHERE segment_id = @segmentId)
    OR ${excludedRanges.map(range => `EXISTS (SELECT 1 FROM context_segment_source
      WHERE segment_id = @segmentId AND ${range})`).join(' OR ')}`).get({ segmentId: node.segment_id });
  if (invalidShape) throw new Error(`Selected ContextSegment ${node.segment_id} has incomplete source facts.`);
  let sql: string;
  if (node.segment_kind === 'message') {
    sql = `SELECT DISTINCT owner.id AS source_turn_id, revision.id AS source_identity, NULL AS authority_snapshot_id,
      CASE WHEN revision.revision_seq <> source.source_revision OR revision.content_object_id <> @contentObjectId
        OR (link.turn_id IS NOT NULL AND owner.id IS NULL) THEN 1 ELSE 0 END AS invalid_source
      FROM context_segment_source AS source
      JOIN message_revision AS revision ON revision.id = source.source_id
      JOIN message_part_of_conversation AS membership ON membership.message_id = revision.message_id
      LEFT JOIN message_turn_link AS link ON link.message_id = revision.message_id
      LEFT JOIN turn AS owner ON owner.id = link.turn_id AND owner.conversation_id = @conversationId
      WHERE source.segment_id = @segmentId AND source.source_kind = 'message_revision'
        AND membership.conversation_id = @conversationId
        AND (link.turn_id IS NOT NULL OR revision.revision_seq <> source.source_revision
          OR revision.content_object_id <> @contentObjectId)
        AND ${CHILD_SCOPE} LIMIT 2`;
  } else if (node.segment_kind === 'tool_pair') {
    sql = `SELECT DISTINCT owner.id AS source_turn_id, call.id AS source_identity, NULL AS authority_snapshot_id,
      CASE WHEN call.call_seq <> source.source_revision THEN 1 ELSE 0 END AS invalid_source
      FROM context_segment_source AS source
      LEFT JOIN tool_model_result AS model_result
        ON source.source_kind = 'tool_model_result' AND model_result.id = source.source_id
      JOIN tool_call AS call ON call.id = CASE source.source_kind
        WHEN 'tool_call' THEN source.source_id WHEN 'tool_model_result' THEN model_result.tool_call_id END
      JOIN turn AS owner ON owner.id = call.turn_id
      WHERE source.segment_id = @segmentId AND source.source_kind IN ('tool_call', 'tool_model_result')
        AND owner.conversation_id = @conversationId AND ${CHILD_SCOPE} LIMIT 2`;
  } else if (node.segment_kind === 'compression') {
    sql = `SELECT DISTINCT owner.id AS source_turn_id, block.authority_snapshot_id,
      block.id AS block_id,
      CASE WHEN source.source_revision <> 0 OR block.summary_object_id <> @contentObjectId
        OR authority.id IS NULL OR owner.id IS NULL THEN 1 ELSE 0 END AS invalid_source
      FROM context_segment_source AS source
      JOIN compression_block AS block ON block.id = source.source_id AND block.conversation_id = @conversationId
      LEFT JOIN authority_snapshot AS authority ON authority.id = block.authority_snapshot_id
      LEFT JOIN turn AS owner ON owner.id = authority.turn_id AND owner.conversation_id = @conversationId
      WHERE source.segment_id = @segmentId AND source.source_kind = 'compression_block' AND ${CHILD_SCOPE} LIMIT 2`;
  } else if (node.segment_kind === 'runtime_context') {
    sql = `SELECT DISTINCT owner.id AS source_turn_id, input.id AS source_identity, NULL AS authority_snapshot_id,
      CASE WHEN source.source_revision <> 0 THEN 1 ELSE 0 END AS invalid_source
      FROM context_segment_source AS source JOIN pending_turn_input AS input ON input.id = source.source_id
      JOIN turn AS owner ON owner.id = input.turn_id
      WHERE source.segment_id = @segmentId AND source.source_kind = 'runtime_context'
        AND owner.conversation_id = @conversationId AND ${CHILD_SCOPE} LIMIT 2`;
  } else {
    throw new Error(`Selected ContextSegment ${node.segment_id} has an invalid segment kind.`);
  }
  const turns = prepareCached(database, sql).all(parameters) as SourceTurn[];
  if (turns.length === 0) {
    if (node.segment_kind === 'compression' && !prepareCached(database, `SELECT 1
      FROM context_segment_source AS source JOIN compression_block AS block ON block.id = source.source_id
      WHERE source.segment_id = @segmentId AND source.source_kind = 'compression_block'
        AND block.conversation_id = @conversationId LIMIT 1`).get(parameters)) {
      throw new Error(`Selected compression ContextSegment ${node.segment_id} has no block owned by its Conversation.`);
    }
    return undefined;
  }
  if (turns.length !== 1 || turns[0].invalid_source !== 0n) {
    throw new Error(`Selected ContextSegment ${node.segment_id} has no unique valid authority source.`);
  }
  const turn = turns[0];
  const sourceTurnId = requireRuntimeId(turn.source_turn_id);
  const snapshots = turn.authority_snapshot_id === null
    ? prepareCached(database, 'SELECT id, content_object_id FROM authority_snapshot WHERE turn_id = ? LIMIT 2')
      .all(sourceTurnId)
    : prepareCached(database, 'SELECT id, content_object_id FROM authority_snapshot WHERE id = ? AND turn_id = ? LIMIT 2')
      .all(turn.authority_snapshot_id, sourceTurnId);
  if (snapshots.length !== 1) throw new Error(`Selected Context source Turn ${sourceTurnId} has incomplete frozen authority facts.`);
  const authority = snapshots[0] as { id: string; content_object_id: string };
  return { authoritySnapshotId: requireRuntimeId(authority.id), contentObjectId: requireRuntimeId(authority.content_object_id), sourceTurnId };
}

function count(value: unknown, label: string): number {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${label} must be a non-negative safe SQLite INTEGER.`);
  }
  return Number(value);
}
