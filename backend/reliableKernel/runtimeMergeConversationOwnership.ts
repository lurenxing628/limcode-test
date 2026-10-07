import type Database from 'better-sqlite3';
import { RUNTIME_DOMAIN_SCHEMA_BY_KEY, RUNTIME_DOMAIN_SCHEMAS } from './schema/domainManifest';

export type RuntimeMergeOwnershipCategory = 'conversation-owned' | 'member-shared' | 'cross-conversation' | 'child-tree' | 'content-derived';
export interface RuntimeMergeOwnershipPath {
  readonly domain: string;
  readonly column: string;
  readonly direction: 'reference' | 'member';
  readonly when?: readonly [column: string, value: string];
}
export interface RuntimeMergeOwnershipRule {
  readonly category: RuntimeMergeOwnershipCategory;
  readonly paths: readonly RuntimeMergeOwnershipPath[];
}

/** Explicit coverage: adding a domain requires choosing its merge ownership, never a default. */
export const RUNTIME_MERGE_CONVERSATION_OWNERSHIP: Readonly<Record<string, RuntimeMergeOwnershipRule>> = {
  ContentObject: { category: 'content-derived', paths: [] },
  Conversation: { category: 'conversation-owned', paths: [{ domain: 'Conversation', column: 'id', direction: 'reference' }] },
  ProjectContext: { category: 'content-derived', paths: [] },
  ConversationProjectLink: { category: 'conversation-owned', paths: [{ domain: 'Conversation', column: 'conversation_id', direction: 'reference' }] },
  ConversationReuseLink: { category: 'conversation-owned', paths: [{ domain: 'Conversation', column: 'conversation_id', direction: 'reference' }] },
  ConversationBranchLink: { category: 'cross-conversation', paths: [{ domain: 'Conversation', column: 'target_conversation_id', direction: 'reference' }, { domain: 'Conversation', column: 'source_conversation_id', direction: 'reference' }] },
  ConversationOriginLink: { category: 'child-tree', paths: [{ domain: 'Conversation', column: 'conversation_id', direction: 'reference' }, { domain: 'Conversation', column: 'source_conversation_id', direction: 'reference' }, { domain: 'Turn', column: 'source_turn_id', direction: 'reference' }, { domain: 'ToolCall', column: 'source_tool_call_id', direction: 'reference' }] },
  AgentConversationLink: { category: 'conversation-owned', paths: [{ domain: 'Conversation', column: 'conversation_id', direction: 'reference' }] },
  Turn: { category: 'conversation-owned', paths: [{ domain: 'Conversation', column: 'conversation_id', direction: 'reference' }] },
  TurnIntent: { category: 'conversation-owned', paths: [{ domain: 'Conversation', column: 'conversation_id', direction: 'reference' }] },
  TurnIntentRevision: { category: 'conversation-owned', paths: [{ domain: 'TurnIntent', column: 'intent_id', direction: 'reference' }] },
  TurnExecutionPresetRevision: { category: 'conversation-owned', paths: [{ domain: 'TurnIntent', column: 'intent_id', direction: 'reference' }] },
  TurnIntentAuthorityRevision: { category: 'conversation-owned', paths: [{ domain: 'TurnIntent', column: 'intent_id', direction: 'reference' }] },
  TurnIntentExecutorLink: { category: 'conversation-owned', paths: [{ domain: 'TurnIntent', column: 'intent_id', direction: 'reference' }] },
  PendingTurnInput: { category: 'conversation-owned', paths: [{ domain: 'Turn', column: 'turn_id', direction: 'reference' }] },
  ExecutionLease: { category: 'conversation-owned', paths: [{ domain: 'Conversation', column: 'conversation_id', direction: 'reference' }] },
  AuthoritySnapshot: { category: 'conversation-owned', paths: [{ domain: 'Turn', column: 'turn_id', direction: 'reference' }] },
  TurnTermination: { category: 'conversation-owned', paths: [{ domain: 'Turn', column: 'turn_id', direction: 'reference' }] },
  TurnExecutorLink: { category: 'conversation-owned', paths: [{ domain: 'Turn', column: 'turn_id', direction: 'reference' }] },
  CommandReceipt: { category: 'conversation-owned', paths: [{ domain: 'Conversation', column: 'conversation_id', direction: 'reference' }, { domain: 'Turn', column: 'turn_id', direction: 'reference' }] },
  Message: { category: 'member-shared', paths: [{ domain: 'MessagePartOfConversation', column: 'message_id', direction: 'member' }, { domain: 'MessageTurnLink', column: 'message_id', direction: 'member' }] },
  MessageRevision: { category: 'member-shared', paths: [{ domain: 'Message', column: 'message_id', direction: 'reference' }] },
  MessageCurrentRevisionLink: { category: 'member-shared', paths: [{ domain: 'Message', column: 'message_id', direction: 'reference' }, { domain: 'MessageRevision', column: 'revision_id', direction: 'reference' }] },
  MessagePartOfConversation: { category: 'conversation-owned', paths: [{ domain: 'Conversation', column: 'conversation_id', direction: 'reference' }] },
  MessageTurnLink: { category: 'conversation-owned', paths: [{ domain: 'Turn', column: 'turn_id', direction: 'reference' }] },
  Attachment: { category: 'content-derived', paths: [] },
  AttachmentLink: { category: 'member-shared', paths: [{ domain: 'MessageRevision', column: 'message_revision_id', direction: 'reference' }] },
  ConversationAttachmentHandleLink: { category: 'conversation-owned', paths: [{ domain: 'Conversation', column: 'conversation_id', direction: 'reference' }] },
  AttachmentObservationLink: { category: 'content-derived', paths: [] },
  InteractionRequest: { category: 'conversation-owned', paths: [{ domain: 'InteractionOwnerLink', column: 'request_id', direction: 'member' }, { domain: 'InteractionToolCallLink', column: 'request_id', direction: 'member' }] },
  InteractionOwnerLink: { category: 'conversation-owned', paths: [{ domain: 'Turn', column: 'turn_id', direction: 'reference' }] },
  InteractionToolCallLink: { category: 'conversation-owned', paths: [{ domain: 'ToolCall', column: 'tool_call_id', direction: 'reference' }] },
  InteractionResponse: { category: 'conversation-owned', paths: [{ domain: 'InteractionRequest', column: 'request_id', direction: 'reference' }] },
  ToolCall: { category: 'conversation-owned', paths: [{ domain: 'Turn', column: 'turn_id', direction: 'reference' }] },
  ToolCallSourceLink: { category: 'conversation-owned', paths: [{ domain: 'ToolCall', column: 'tool_call_id', direction: 'reference' }, { domain: 'ModelRequest', column: 'model_request_id', direction: 'reference' }] },
  ToolCallPolicySnapshot: { category: 'conversation-owned', paths: [{ domain: 'ToolCall', column: 'tool_call_id', direction: 'reference' }] },
  ToolCallEvent: { category: 'conversation-owned', paths: [{ domain: 'ToolCall', column: 'tool_call_id', direction: 'reference' }] },
  ToolExecution: { category: 'conversation-owned', paths: [{ domain: 'ToolCall', column: 'tool_call_id', direction: 'reference' }] },
  Operation: { category: 'conversation-owned', paths: [{ domain: 'ToolCall', column: 'tool_call_id', direction: 'reference' }, { domain: 'ModelRequest', column: 'owner_id', direction: 'reference', when: ["owner_kind", "model_request"] }] },
  Attempt: { category: 'conversation-owned', paths: [{ domain: 'Operation', column: 'operation_id', direction: 'reference' }] },
  OutcomePause: { category: 'conversation-owned', paths: [{ domain: 'Operation', column: 'operation_id', direction: 'reference' }] },
  OperationResolution: { category: 'conversation-owned', paths: [{ domain: 'OutcomePause', column: 'pause_id', direction: 'reference' }] },
  EffectIntent: { category: 'conversation-owned', paths: [{ domain: 'Attempt', column: 'attempt_id', direction: 'reference' }] },
  EffectReceipt: { category: 'conversation-owned', paths: [{ domain: 'Conversation', column: 'conversation_id', direction: 'reference' }] },
  ToolOutcome: { category: 'conversation-owned', paths: [{ domain: 'ToolCall', column: 'tool_call_id', direction: 'reference' }] },
  ToolModelResult: { category: 'conversation-owned', paths: [{ domain: 'ToolCall', column: 'tool_call_id', direction: 'reference' }] },
  ToolResultArtifact: { category: 'conversation-owned', paths: [{ domain: 'ToolCall', column: 'tool_call_id', direction: 'reference' }] },
  FileChangeSet: { category: 'conversation-owned', paths: [{ domain: 'ToolCall', column: 'tool_call_id', direction: 'reference' }] },
  FileChangeSetMember: { category: 'conversation-owned', paths: [{ domain: 'FileChangeSet', column: 'change_set_id', direction: 'reference' }] },
  FileChangeDecision: { category: 'conversation-owned', paths: [{ domain: 'FileChangeSet', column: 'change_set_id', direction: 'reference' }] },
  FileMutationReceipt: { category: 'conversation-owned', paths: [{ domain: 'EffectReceipt', column: 'effect_receipt_id', direction: 'reference' }, { domain: 'FileChangeSet', column: 'change_set_id', direction: 'reference' }] },
  FileMutationReceiptMember: { category: 'conversation-owned', paths: [{ domain: 'FileMutationReceipt', column: 'receipt_id', direction: 'reference' }, { domain: 'FileChangeSetMember', column: 'member_id', direction: 'reference' }] },
  Process: { category: 'conversation-owned', paths: [{ domain: 'ProcessOriginLink', column: 'process_id', direction: 'member' }, { domain: 'ProcessCompletionSourceLink', column: 'process_id', direction: 'member' }] },
  ProcessOriginLink: { category: 'conversation-owned', paths: [{ domain: 'ToolCall', column: 'tool_call_id', direction: 'reference' }] },
  ProcessCompletionSourceLink: { category: 'conversation-owned', paths: [{ domain: 'Conversation', column: 'conversation_id', direction: 'reference' }] },
  ProcessOutputChunk: { category: 'conversation-owned', paths: [{ domain: 'Process', column: 'process_id', direction: 'reference' }] },
  ProcessReceipt: { category: 'conversation-owned', paths: [{ domain: 'Process', column: 'process_id', direction: 'reference' }] },
  ProcessCompletionDispatch: { category: 'conversation-owned', paths: [{ domain: 'ProcessReceipt', column: 'process_receipt_id', direction: 'reference' }] },
  ChildInterruptionProcessCleanup: { category: 'child-tree', paths: [{ domain: 'ChildInterruptionRequest', column: 'interruption_request_id', direction: 'reference' }, { domain: 'Process', column: 'process_id', direction: 'reference' }] },
  ConversationContextHandleState: { category: 'conversation-owned', paths: [{ domain: 'Conversation', column: 'conversation_id', direction: 'reference' }] },
  ContextRootHandleCatalog: { category: 'conversation-owned', paths: [{ domain: 'Conversation', column: 'conversation_id', direction: 'reference' }] },
  ContextSegment: { category: 'member-shared', paths: [{ domain: 'ContextSequenceNode', column: 'segment_id', direction: 'member' }, { domain: 'CompressionBlockSource', column: 'segment_id', direction: 'member' }] },
  ContextSegmentSource: { category: 'member-shared', paths: [{ domain: 'ContextSegment', column: 'segment_id', direction: 'reference' }] },
  ContextSequenceNode: { category: 'member-shared', paths: [{ domain: 'ContextSequenceRoot', column: 'root_node_id', direction: 'member' }, { domain: 'ContextSequenceRoot', column: 'tail_node_id', direction: 'member' }, { domain: 'ContextSequenceNode', column: 'parent_node_id', direction: 'member' }, { domain: 'ContextRootHandleCatalog', column: 'root_node_id', direction: 'member' }, { domain: 'ContextRootHandleCatalog', column: 'tail_node_id', direction: 'member' }] },
  ContextSequenceRoot: { category: 'conversation-owned', paths: [{ domain: 'Conversation', column: 'conversation_id', direction: 'reference' }] },
  ConversationContextHeadLink: { category: 'conversation-owned', paths: [{ domain: 'Conversation', column: 'conversation_id', direction: 'reference' }] },
  ModelContextProjection: { category: 'member-shared', paths: [{ domain: 'ModelRequest', column: 'owner_id', direction: 'reference', when: ["owner_kind", "model_request"] }, { domain: 'CompressionBlock', column: 'owner_id', direction: 'reference', when: ["owner_kind", "compression_block"] }, { domain: 'Conversation', column: 'owner_id', direction: 'reference', when: ["owner_kind", "conversation_handle_catalog"] }, { domain: 'ContextSequenceRoot', column: 'root_id', direction: 'reference' }] },
  ModelRequest: { category: 'conversation-owned', paths: [{ domain: 'Turn', column: 'turn_id', direction: 'reference' }] },
  ModelRequestMessageLink: { category: 'conversation-owned', paths: [{ domain: 'ModelRequest', column: 'model_request_id', direction: 'reference' }] },
  CompressionBlock: { category: 'conversation-owned', paths: [{ domain: 'Conversation', column: 'conversation_id', direction: 'reference' }] },
  CompressionBlockSource: { category: 'member-shared', paths: [{ domain: 'CompressionBlock', column: 'compression_block_id', direction: 'reference' }, { domain: 'ContextSegment', column: 'segment_id', direction: 'reference' }] },
  CompressionBlockObservationLink: { category: 'conversation-owned', paths: [{ domain: 'CompressionBlock', column: 'compression_block_id', direction: 'reference' }] },
  ModelStreamCheckpoint: { category: 'conversation-owned', paths: [{ domain: 'ModelRequest', column: 'model_request_id', direction: 'reference' }] },
  ModelStreamFence: { category: 'conversation-owned', paths: [{ domain: 'ModelRequest', column: 'model_request_id', direction: 'reference' }] },
  TurnFinalOutputFence: { category: 'conversation-owned', paths: [{ domain: 'Turn', column: 'turn_id', direction: 'reference' }, { domain: 'ModelRequest', column: 'model_request_id', direction: 'reference' }] },
  ChildExecution: { category: 'child-tree', paths: [{ domain: 'Conversation', column: 'child_conversation_id', direction: 'reference' }] },
  ChildExecutionParentLink: { category: 'child-tree', paths: [{ domain: 'ChildExecution', column: 'child_execution_id', direction: 'reference' }, { domain: 'ChildExecution', column: 'parent_child_execution_id', direction: 'reference' }, { domain: 'Turn', column: 'parent_turn_id', direction: 'reference' }, { domain: 'ToolCall', column: 'source_tool_call_id', direction: 'reference' }] },
  ChildExecutionTurnLink: { category: 'child-tree', paths: [{ domain: 'ChildExecution', column: 'child_execution_id', direction: 'reference' }, { domain: 'Turn', column: 'turn_id', direction: 'reference' }] },
  ChildExecutionIntentLink: { category: 'child-tree', paths: [{ domain: 'ChildExecution', column: 'child_execution_id', direction: 'reference' }, { domain: 'TurnIntent', column: 'turn_intent_id', direction: 'reference' }] },
  ChildExecutionActiveTurnLink: { category: 'child-tree', paths: [{ domain: 'ChildExecution', column: 'child_execution_id', direction: 'reference' }, { domain: 'Turn', column: 'turn_id', direction: 'reference' }] },
  ChildInterruptionRequest: { category: 'child-tree', paths: [{ domain: 'ChildExecution', column: 'root_child_execution_id', direction: 'reference' }] },
  ChildInterruptionLineageLink: { category: 'child-tree', paths: [{ domain: 'ChildInterruptionRequest', column: 'interruption_request_id', direction: 'reference' }, { domain: 'ChildExecution', column: 'child_execution_id', direction: 'reference' }] },
  ChildInterruptionTurnLink: { category: 'child-tree', paths: [{ domain: 'ChildInterruptionRequest', column: 'interruption_request_id', direction: 'reference' }, { domain: 'ChildExecution', column: 'child_execution_id', direction: 'reference' }, { domain: 'Turn', column: 'turn_id', direction: 'reference' }] },
  ChildInterruptionIntentLink: { category: 'child-tree', paths: [{ domain: 'ChildInterruptionRequest', column: 'interruption_request_id', direction: 'reference' }, { domain: 'ChildExecution', column: 'child_execution_id', direction: 'reference' }, { domain: 'ChildExecutionIntentLink', column: 'child_execution_intent_link_id', direction: 'reference' }] },
  AnswerBridge: { category: 'cross-conversation', paths: [{ domain: 'ChildExecution', column: 'child_execution_id', direction: 'reference' }] },
  AnswerSubmission: { category: 'cross-conversation', paths: [{ domain: 'AnswerBridge', column: 'answer_bridge_id', direction: 'reference' }, { domain: 'Turn', column: 'turn_id', direction: 'reference' }] },
  AnswerPayload: { category: 'cross-conversation', paths: [{ domain: 'AnswerSubmission', column: 'submission_id', direction: 'reference' }] },
  RuntimeInboxItem: { category: 'cross-conversation', paths: [{ domain: 'RuntimeDelivery', column: 'inbox_item_id', direction: 'member' }, { domain: 'CollaborationMessageTargetLink', column: 'inbox_item_id', direction: 'member' }, { domain: 'AnswerSubmission', column: 'source_id', direction: 'reference', when: ["source_kind", "answer_submission"] }, { domain: 'ProcessReceipt', column: 'source_id', direction: 'reference', when: ["source_kind", "process_receipt"] }, { domain: 'CollaborationMessage', column: 'source_id', direction: 'reference', when: ["source_kind", "collaboration_message"] }, { domain: 'ToolModelResult', column: 'source_id', direction: 'reference', when: ["source_kind", "tool_model_result"] }] },
  RuntimeInboxPayloadLink: { category: 'cross-conversation', paths: [{ domain: 'RuntimeInboxItem', column: 'inbox_item_id', direction: 'reference' }] },
  RuntimeDelivery: { category: 'cross-conversation', paths: [{ domain: 'RuntimeInboxItem', column: 'inbox_item_id', direction: 'reference' }, { domain: 'RuntimeDelivery', column: 'retry_of_delivery_id', direction: 'reference' }, { domain: 'Conversation', column: 'target_conversation_id', direction: 'reference' }, { domain: 'Turn', column: 'target_turn_id', direction: 'reference' }] },
  RuntimeDeliveryIntentLink: { category: 'cross-conversation', paths: [{ domain: 'RuntimeDelivery', column: 'delivery_id', direction: 'reference' }, { domain: 'TurnIntent', column: 'turn_intent_id', direction: 'reference' }] },
  RuntimeDeliveryInputLink: { category: 'cross-conversation', paths: [{ domain: 'RuntimeDelivery', column: 'delivery_id', direction: 'reference' }, { domain: 'PendingTurnInput', column: 'pending_turn_input_id', direction: 'reference' }] },
  RuntimeDeliveryWake: { category: 'cross-conversation', paths: [{ domain: 'RuntimeDelivery', column: 'delivery_id', direction: 'reference' }] },
  CollaborationMessage: { category: 'cross-conversation', paths: [{ domain: 'CollaborationMessageSourceLink', column: 'message_id', direction: 'member' }, { domain: 'CollaborationMessageTargetLink', column: 'message_id', direction: 'member' }, { domain: 'CollaborationMessageReplyLink', column: 'message_id', direction: 'member' }, { domain: 'CollaborationMessageReplyLink', column: 'request_message_id', direction: 'member' }] },
  CollaborationMessageSourceLink: { category: 'cross-conversation', paths: [{ domain: 'CollaborationMessage', column: 'message_id', direction: 'reference' }, { domain: 'Conversation', column: 'conversation_id', direction: 'reference' }, { domain: 'Turn', column: 'turn_id', direction: 'reference' }, { domain: 'ToolCall', column: 'tool_call_id', direction: 'reference' }, { domain: 'CollaborationBoardPost', column: 'board_post_id', direction: 'reference' }] },
  CollaborationMessageTargetLink: { category: 'cross-conversation', paths: [{ domain: 'RuntimeInboxItem', column: 'inbox_item_id', direction: 'reference' }, { domain: 'CollaborationMessage', column: 'message_id', direction: 'reference' }, { domain: 'Conversation', column: 'conversation_id', direction: 'reference' }, { domain: 'Turn', column: 'anchor_turn_id', direction: 'reference' }] },
  CollaborationMessagePayloadLink: { category: 'cross-conversation', paths: [{ domain: 'CollaborationMessage', column: 'message_id', direction: 'reference' }] },
  CollaborationMessageReplyLink: { category: 'cross-conversation', paths: [{ domain: 'CollaborationMessage', column: 'request_message_id', direction: 'reference' }, { domain: 'CollaborationMessage', column: 'message_id', direction: 'reference' }] },
  CollaborationBudget: { category: 'cross-conversation', paths: [{ domain: 'Turn', column: 'authority_turn_id', direction: 'reference' }, { domain: 'CollaborationRequest', column: 'budget_id', direction: 'member' }] },
  CollaborationRequest: { category: 'cross-conversation', paths: [{ domain: 'CollaborationBudget', column: 'budget_id', direction: 'reference' }, { domain: 'CollaborationMessage', column: 'message_id', direction: 'reference' }] },
  CollaborationRequestTurnLink: { category: 'cross-conversation', paths: [{ domain: 'CollaborationRequest', column: 'request_id', direction: 'reference' }, { domain: 'Turn', column: 'turn_id', direction: 'reference' }] },
  CollaborationBoardChannel: { category: 'cross-conversation', paths: [{ domain: 'CollaborationBoardChannelScopeLink', column: 'channel_id', direction: 'member' }] },
  CollaborationBoardChannelScopeLink: { category: 'cross-conversation', paths: [{ domain: 'CollaborationBoardChannel', column: 'channel_id', direction: 'reference' }, { domain: 'Conversation', column: 'root_conversation_id', direction: 'reference' }] },
  CollaborationBoardPost: { category: 'cross-conversation', paths: [{ domain: 'CollaborationBoardPostSourceLink', column: 'post_id', direction: 'member' }, { domain: 'CollaborationBoardPostChannelLink', column: 'post_id', direction: 'member' }, { domain: 'CollaborationBoardReplyLink', column: 'post_id', direction: 'member' }] },
  CollaborationBoardPostChannelLink: { category: 'cross-conversation', paths: [{ domain: 'CollaborationBoardPost', column: 'post_id', direction: 'reference' }, { domain: 'CollaborationBoardChannel', column: 'channel_id', direction: 'reference' }] },
  CollaborationBoardPostSourceLink: { category: 'cross-conversation', paths: [{ domain: 'CollaborationBoardPost', column: 'post_id', direction: 'reference' }, { domain: 'Conversation', column: 'conversation_id', direction: 'reference' }, { domain: 'Turn', column: 'source_turn_id', direction: 'reference' }, { domain: 'ToolCall', column: 'source_tool_call_id', direction: 'reference' }] },
  CollaborationBoardReplyLink: { category: 'cross-conversation', paths: [{ domain: 'CollaborationBoardPost', column: 'post_id', direction: 'reference' }, { domain: 'CollaborationBoardPost', column: 'thread_id', direction: 'reference' }] },
  CollaborationBoardSubscriptionLink: { category: 'cross-conversation', paths: [{ domain: 'Conversation', column: 'conversation_id', direction: 'reference' }, { domain: 'CollaborationBoardChannel', column: 'channel_id', direction: 'reference' }, { domain: 'CollaborationBoardPost', column: 'thread_id', direction: 'reference' }] },
  CollaborationBoardCommandReceipt: { category: 'cross-conversation', paths: [{ domain: 'Conversation', column: 'conversation_id', direction: 'reference' }, { domain: 'ToolCall', column: 'source_tool_call_id', direction: 'reference' }] },
  RuntimeDeliveryTimelineLink: { category: 'cross-conversation', paths: [{ domain: 'RuntimeDelivery', column: 'delivery_id', direction: 'reference' }, { domain: 'RuntimeInboxItem', column: 'inbox_item_id', direction: 'reference' }, { domain: 'ContextSequenceRoot', column: 'context_root_id', direction: 'reference' }, { domain: 'ContextSequenceNode', column: 'context_node_id', direction: 'reference' }, { domain: 'Conversation', column: 'conversation_id', direction: 'reference' }] },
  CollaborationSendTimelineLink: { category: 'cross-conversation', paths: [{ domain: 'CollaborationMessage', column: 'message_id', direction: 'reference' }, { domain: 'Conversation', column: 'conversation_id', direction: 'reference' }] },
  TimelineImportProvenance: { category: 'cross-conversation', paths: [{ domain: 'RuntimeDeliveryTimelineLink', column: 'receive_timeline_link_id', direction: 'reference' }, { domain: 'CollaborationSendTimelineLink', column: 'send_timeline_link_id', direction: 'reference' }] },
  RuntimeDeliveryAnswerPresentation: { category: 'cross-conversation', paths: [{ domain: 'RuntimeDelivery', column: 'delivery_id', direction: 'reference' }, { domain: 'RuntimeInboxItem', column: 'inbox_item_id', direction: 'reference' }, { domain: 'Conversation', column: 'conversation_id', direction: 'reference' }, { domain: 'AnswerSubmission', column: 'submission_id', direction: 'reference' }, { domain: 'ChildExecution', column: 'child_execution_id', direction: 'reference' }, { domain: 'Conversation', column: 'child_conversation_id', direction: 'reference' }, { domain: 'AnswerBridge', column: 'answer_bridge_id', direction: 'reference' }, { domain: 'Turn', column: 'source_turn_id', direction: 'reference' }] },
};

type RawRow = Readonly<Record<string, unknown>>;

/** The caller owns the immutable snapshot and must discard this reader when that snapshot closes. */
export function createRuntimeMergeConversationOwnership(source: Database.Database) {
  const statements = new Map<string, Database.Statement>();
  const referencesByTable = new Map<string, Array<{ domain: string; column: string }>>();
  for (const schema of RUNTIME_DOMAIN_SCHEMAS) for (const column of schema.columns) {
    if (!column.references) continue;
    const references = referencesByTable.get(column.references.table) ?? [];
    references.push({ domain: schema.key, column: column.name });
    referencesByTable.set(column.references.table, references);
  }
  const rows = (domain: string, column: string, value: string): Iterable<RawRow> => {
    const schema = RUNTIME_DOMAIN_SCHEMA_BY_KEY.get(domain);
    if (!schema || !schema.columns.some((entry) => entry.name === column)) {
      throw new Error(`Unknown merge ownership path ${domain}.${column}.`);
    }
    const key = `${domain}.${column}`;
    let statement = statements.get(key);
    if (!statement) {
      statement = source.prepare(`SELECT * FROM "${schema.table}" WHERE "${column}" = ?`);
      statements.set(key, statement);
    }
    return statement.iterate(value) as Iterable<RawRow>;
  };

  /** Empty means content-derived (or an internal dataset receipt); undefined means no owner found. */
  const resolve = (domain: string, rawRow: RawRow): ReadonlySet<string> | undefined => {
    const initial = RUNTIME_MERGE_CONVERSATION_OWNERSHIP[domain];
    if (!initial) return undefined;
    if (initial.category === 'content-derived') return new Set();
    if (domain === 'CommandReceipt' && rawRow.conversation_id == null && rawRow.turn_id == null
      && rawRow.source_kind === 'internal'
      && typeof rawRow.source_key === 'string' && rawRow.source_key.startsWith('historical-merge-commit:')) {
      return new Set();
    }
    const owners = new Set<string>();
    const visited = new Map<string, Set<string>>();
    const pending: Array<{ domain: string; row: RawRow }> = [{ domain, row: rawRow }];
    while (pending.length) {
      const current = pending.pop()!;
      const id = current.row.id;
      if (typeof id === 'string') {
        let ids = visited.get(current.domain);
        if (!ids) visited.set(current.domain, ids = new Set());
        if (ids.has(id)) continue;
        ids.add(id);
      }
      if (current.domain === 'Conversation') {
        if (typeof id === 'string' && id.length) owners.add(id);
        continue;
      }
      const rule = RUNTIME_MERGE_CONVERSATION_OWNERSHIP[current.domain];
      for (const edge of rule.paths) {
        if (edge.when && current.row[edge.when[0]] !== edge.when[1]) continue;
        const value = current.row[edge.direction === 'member' ? 'id' : edge.column];
        if (typeof value !== 'string' || !value.length) continue;
        // Soft references deliberately survive deletion. They still identify the conversation
        // implicated by this row, even when there is no Conversation row left in this snapshot.
        if (edge.direction === 'reference' && edge.domain === 'Conversation') {
          owners.add(value);
          continue;
        }
        for (const row of rows(edge.domain, edge.direction === 'member' ? edge.column : 'id', value)) {
          pending.push({ domain: edge.domain, row });
        }
      }
    }
    return owners.size ? owners : undefined;
  };

  /** Child structures are undirected for exclusion: a child never leaves a surviving parent. */
  const expandChildTrees = (conversationIds: ReadonlySet<string>): Set<string> => {
    const result = new Set(conversationIds);
    const pending = [...conversationIds];
    const add = (ids: ReadonlySet<string> | undefined): void => {
      for (const id of ids ?? []) if (!result.has(id)) { result.add(id); pending.push(id); }
    };
    while (pending.length) {
      const id = pending.pop()!;
      for (const column of ['conversation_id', 'source_conversation_id']) {
        for (const row of rows('ConversationOriginLink', column, id)) add(resolve('ConversationOriginLink', row));
      }
      for (const child of rows('ChildExecution', 'child_conversation_id', id)) {
        for (const column of ['child_execution_id', 'parent_child_execution_id']) {
          for (const link of rows('ChildExecutionParentLink', column, String(child.id))) add(resolve('ChildExecutionParentLink', link));
        }
      }
      for (const turn of rows('Turn', 'conversation_id', id)) {
        for (const link of rows('ChildExecutionParentLink', 'parent_turn_id', String(turn.id))) add(resolve('ChildExecutionParentLink', link));
        for (const call of rows('ToolCall', 'turn_id', String(turn.id))) {
          for (const link of rows('ChildExecutionParentLink', 'source_tool_call_id', String(call.id))) add(resolve('ChildExecutionParentLink', link));
        }
      }
    }
    return result;
  };

  /** SQL references, including references through shared Attachment/Observation identities.
   * Recipe CAS edges are supplied separately by runtimeMergeRecipeContentReferences. */
  const resolveContentReferences = (contentObjectIds: ReadonlySet<string>): ReadonlySet<string> | undefined => {
    const result = new Set<string>();
    const pending = [...contentObjectIds].map((id) => ({ domain: 'ContentObject', id }));
    const visited = new Set<string>();
    while (pending.length) {
      const item = pending.pop()!;
      const key = JSON.stringify([item.domain, item.id]);
      if (visited.has(key)) continue;
      visited.add(key);
      const table = RUNTIME_DOMAIN_SCHEMA_BY_KEY.get(item.domain)!.table;
      for (const reference of referencesByTable.get(table) ?? []) {
        for (const row of rows(reference.domain, reference.column, item.id)) {
          if (RUNTIME_MERGE_CONVERSATION_OWNERSHIP[reference.domain].category === 'content-derived') {
            if (typeof row.id === 'string') pending.push({ domain: reference.domain, id: row.id });
          } else {
            const owners = resolve(reference.domain, row);
            if (!owners) return undefined;
            for (const id of owners) result.add(id);
          }
        }
      }
    }
    return result;
  };
  return { resolve, expandChildTrees, resolveContentReferences };
}

/** Only the two contracted recipe edges; arbitrary user/tool JSON is never an ownership source. */
export function runtimeMergeRecipeContentReferences(recipe: unknown): ReadonlySet<string> {
  const result = new Set<string>();
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) return result;
  const row = recipe as Record<string, unknown>;
  for (const [field, column] of [['toolsReference', 'contentObjectId'], ['modelHandleCatalogReference', 'baseContentObjectId']]) {
    const reference = row[field];
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) continue;
    const id = (reference as Record<string, unknown>)[column];
    if (typeof id === 'string' && id.length) result.add(id);
  }
  return result;
}

export interface RuntimeMergeOwnershipEdge {
  readonly fromDomain: string;
  readonly fromId: string;
  readonly toDomain: string;
  readonly toId: string;
}

// Reverse member paths once. A merge's existing row scan can then build its disk index without
// querying the source again or resolving the same context suffix for every node in a long chain.
const MEMBER_PATHS = new Map<string, Array<{ owner: string; column: string }>>();
for (const [owner, rule] of Object.entries(RUNTIME_MERGE_CONVERSATION_OWNERSHIP)) {
  for (const edge of rule.paths) {
    if (edge.direction !== 'member') continue;
    const paths = MEMBER_PATHS.get(edge.domain) ?? [];
    paths.push({ owner, column: edge.column });
    MEMBER_PATHS.set(edge.domain, paths);
  }
}

export function* runtimeMergeOwnershipEdges(domain: string, row: RawRow): IterableIterator<RuntimeMergeOwnershipEdge> {
  const id = row.id;
  if (typeof id !== 'string') return;
  for (const edge of RUNTIME_MERGE_CONVERSATION_OWNERSHIP[domain]?.paths ?? []) {
    if (edge.direction !== 'reference' || (edge.when && row[edge.when[0]] !== edge.when[1])) continue;
    const target = row[edge.column];
    if (typeof target === 'string' && target.length) yield { fromDomain: domain, fromId: id, toDomain: edge.domain, toId: target };
  }
  for (const edge of MEMBER_PATHS.get(domain) ?? []) {
    const owner = row[edge.column];
    if (typeof owner === 'string' && owner.length) yield { fromDomain: edge.owner, fromId: owner, toDomain: domain, toId: id };
  }
}

/** All SQL CAS references are taken from the schema once, including Attachment/Observation rows. */
export const RUNTIME_MERGE_CONTENT_REFERENCE_COLUMNS: ReadonlyMap<string, readonly string[]> = new Map(
  RUNTIME_DOMAIN_SCHEMAS.map((schema) => [schema.key,
    schema.columns.filter((column) => column.references?.table === 'content_object').map((column) => column.name)])
);

/** Shared identity references connect content users without treating a content conflict as owned. */
export function* runtimeMergeContentIdentityEdges(domain: string, row: RawRow): IterableIterator<RuntimeMergeOwnershipEdge> {
  if (typeof row.id !== 'string') return;
  for (const edge of CONTENT_IDENTITY_PATHS.get(domain) ?? []) {
    const id = row[edge.column];
    if (typeof id === 'string' && id.length) yield { fromDomain: domain, fromId: row.id, toDomain: edge.domain, toId: id };
  }
}

const CONTENT_IDENTITY_PATHS = new Map(RUNTIME_DOMAIN_SCHEMAS.map((schema) => [schema.key,
  schema.columns.flatMap((column) => {
    const owner = column.references && RUNTIME_DOMAIN_SCHEMAS.find((entry) => entry.table === column.references!.table);
    return owner && ['Attachment', 'AttachmentObservationLink'].includes(owner.key) ? [{ domain: owner.key, column: column.name }] : [];
  })]));
