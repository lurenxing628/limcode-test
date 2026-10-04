import { domain, integer, text, type RuntimeDomainSchema } from './types';

const id = () => text('id');
const ref = (name: string, table: string, nullable = false, onDelete: 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'NO ACTION' = 'CASCADE') =>
  text(name, { nullable, references: { table, onDelete } });

export const CONTEXT_DOMAIN_SCHEMAS: readonly RuntimeDomainSchema[] = [
  domain({
    key: 'ConversationContextHandleState', table: 'conversation_context_handle_state', repository: 'ConversationContextHandleStateRepository', codec: 'ConversationContextHandleStateRowCodec',
    mutations: ['insert', 'update'], client: 'none', deletePolicy: 'cascade-with-conversation',
    indexes: ['conversation_id UNIQUE', 'state'],
    columns: [id(), ref('conversation_id', 'conversation'), ref('context_root_id', 'context_sequence_root', true, 'RESTRICT'), text('state'), integer('revision'), integer('provenance_revision'), ref('content_object_id', 'content_object', true, 'RESTRICT'), integer('requires_native_reset'), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'ContextRootHandleCatalog', table: 'context_root_handle_catalog', repository: 'ContextRootHandleCatalogRepository', codec: 'ContextRootHandleCatalogRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-conversation',
    indexes: ['conversation_id,context_root_id,provenance_revision UNIQUE', 'conversation_id,provenance_revision,root_node_id,tail_node_id,tail_segment_count,segment_count', 'context_root_id'],
    columns: [id(), ref('conversation_id', 'conversation'), ref('context_root_id', 'context_sequence_root', false, 'RESTRICT'), integer('provenance_revision'), ref('root_node_id', 'context_sequence_node', true, 'RESTRICT'), ref('tail_node_id', 'context_sequence_node', true, 'RESTRICT'), integer('tail_segment_count'), integer('segment_count'), ref('content_object_id', 'content_object', true, 'RESTRICT'), text('created_at')]
  }),
  domain({
    key: 'ContextSegment', table: 'context_segment', repository: 'ContextSegmentRepository', codec: 'ContextSegmentRowCodec',
    mutations: ['insert'], client: 'detail', deletePolicy: 'dataset-reset-only',
    indexes: ['content_object_id,segment_kind'],
    columns: [id(), ref('content_object_id', 'content_object'), text('segment_kind'), text('created_at')]
  }),
  domain({
    key: 'ContextSegmentSource', table: 'context_segment_source', repository: 'ContextSegmentSourceRepository', codec: 'ContextSegmentSourceRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-segment',
    indexes: ['source_kind,source_id,source_revision UNIQUE', 'segment_id,source_kind'],
    columns: [id(), ref('segment_id', 'context_segment'), text('source_kind'), text('source_id'), integer('source_revision'), text('created_at')]
  }),
  domain({
    key: 'ContextSequenceNode', table: 'context_sequence_node', repository: 'ContextSequenceNodeRepository', codec: 'ContextSequenceNodeRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'dataset-reset-only',
    indexes: [
      'parent_node_id',
      'parent_node_id,segment_id UNIQUE',
      'segment_id UNIQUE WHERE parent_node_id IS NULL'
    ],
    columns: [id(), ref('parent_node_id', 'context_sequence_node', true, 'RESTRICT'), ref('segment_id', 'context_segment', false, 'RESTRICT'), text('created_at')]
  }),
  domain({
    key: 'ContextSequenceRoot', table: 'context_sequence_root', repository: 'ContextSequenceRootRepository', codec: 'ContextSequenceRootRowCodec',
    mutations: ['insert'], client: 'detail', deletePolicy: 'dataset-reset-only',
    indexes: ['conversation_id,root_seq UNIQUE', 'root_node_id'],
    columns: [id(), text('conversation_id'), integer('root_seq'), ref('root_node_id', 'context_sequence_node', true, 'RESTRICT'), ref('tail_node_id', 'context_sequence_node', true, 'RESTRICT'), integer('tail_segment_count'), integer('segment_count'), integer('estimated_tokens'), text('created_at')]
  }),
  domain({
    key: 'ConversationContextHeadLink', table: 'conversation_context_head_link', repository: 'ConversationContextHeadLinkRepository', codec: 'ConversationContextHeadLinkRowCodec',
    mutations: ['insert', 'update', 'delete'], client: 'none', deletePolicy: 'cascade-with-conversation',
    indexes: ['conversation_id UNIQUE', 'root_id'],
    columns: [id(), ref('conversation_id', 'conversation'), ref('root_id', 'context_sequence_root', false, 'RESTRICT'), text('updated_at')]
  }),
  domain({
    key: 'ModelContextProjection', table: 'model_context_projection', repository: 'ModelContextProjectionRepository', codec: 'ModelContextProjectionRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'dataset-reset-only',
    indexes: ['owner_kind,owner_id UNIQUE', 'root_id'],
    columns: [id(), text('owner_kind'), text('owner_id'), text('root_id'), text('purpose'), text('created_at')]
  }),
  domain({
    key: 'ModelRequest', table: 'model_request', repository: 'ModelRequestRepository', codec: 'ModelRequestRowCodec',
    mutations: ['insert', 'update'], client: 'summary', deletePolicy: 'cascade-with-turn',
    indexes: ['turn_id,request_seq UNIQUE', 'status'],
    columns: [id(), ref('turn_id', 'turn'), integer('request_seq'), text('status'), text('terminal_state', { nullable: true }), text('provider_id'), text('model_id'), integer('context_window_tokens'), integer('compression_threshold_tokens'), integer('estimated_context_tokens'), text('authority_snapshot_id'), ref('settings_snapshot_object_id', 'content_object', true, 'RESTRICT'), ref('recipe_object_id', 'content_object'), text('usage_json', { nullable: true, json: true }), text('stream_stats_json', { nullable: true, json: true }), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'ModelRequestMessageLink', table: 'model_request_message_link', repository: 'ModelRequestMessageLinkRepository', codec: 'ModelRequestMessageLinkRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'cascade-with-model-request',
    indexes: ['model_request_id UNIQUE', 'message_id UNIQUE'],
    columns: [id(), ref('model_request_id', 'model_request'), ref('message_id', 'message'), text('created_at')]
  }),
  domain({
    key: 'CompressionBlock', table: 'compression_block', repository: 'CompressionBlockRepository', codec: 'CompressionBlockRowCodec',
    mutations: ['insert', 'update'], client: 'detail', deletePolicy: 'cascade-with-conversation',
    indexes: ['conversation_id,created_at', 'status'],
    columns: [id(), ref('conversation_id', 'conversation'), text('status'), text('authority_snapshot_id'), ref('title_object_id', 'content_object'), ref('summary_object_id', 'content_object'), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'CompressionBlockSource', table: 'compression_block_source', repository: 'CompressionBlockSourceRepository', codec: 'CompressionBlockSourceRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-conversation',
    indexes: ['compression_block_id,segment_id,position UNIQUE'],
    columns: [id(), ref('compression_block_id', 'compression_block'), ref('segment_id', 'context_segment', false, 'RESTRICT'), integer('position'), text('created_at')]
  }),
  domain({
    key: 'CompressionBlockObservationLink', table: 'compression_block_observation_link', repository: 'CompressionBlockObservationLinkRepository', codec: 'CompressionBlockObservationLinkRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-compression-block',
    indexes: ['compression_block_id,position UNIQUE', 'compression_block_id,observation_id UNIQUE', 'observation_id'],
    columns: [id(), ref('compression_block_id', 'compression_block'), ref('observation_id', 'attachment_observation_link', false, 'RESTRICT'), integer('position'), text('created_at')]
  }),
  domain({
    key: 'ModelStreamCheckpoint', table: 'model_stream_checkpoint', repository: 'ModelStreamCheckpointRepository', codec: 'ModelStreamCheckpointRowCodec',
    mutations: ['insert', 'delete'], client: 'none', deletePolicy: 'cascade-with-model-request',
    indexes: ['model_request_id,attempt_seq,socket_generation,stream_seq UNIQUE'],
    columns: [id(), ref('model_request_id', 'model_request'), integer('attempt_seq'), integer('socket_generation'), integer('stream_seq'), text('checkpoint_kind'), ref('content_object_id', 'content_object'), text('created_at')]
  }),
  domain({
    key: 'ModelStreamFence', table: 'model_stream_fence', repository: 'ModelStreamFenceRepository', codec: 'ModelStreamFenceRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-model-request',
    indexes: ['model_request_id UNIQUE'],
    columns: [id(), ref('model_request_id', 'model_request'), integer('attempt_seq'), integer('socket_generation'), integer('terminal_stream_seq'), text('outcome'), text('created_at')]
  }),
  domain({
    key: 'TurnFinalOutputFence', table: 'turn_final_output_fence', repository: 'TurnFinalOutputFenceRepository', codec: 'TurnFinalOutputFenceRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-turn',
    indexes: ['turn_id UNIQUE', 'model_request_id UNIQUE'],
    columns: [id(), ref('turn_id', 'turn'), ref('model_request_id', 'model_request'), text('created_at')]
  }),
  domain({
    key: 'ChildExecution', table: 'child_execution', repository: 'ChildExecutionRepository', codec: 'ChildExecutionRowCodec',
    mutations: ['insert', 'update'], client: 'summary', deletePolicy: 'cascade-with-child-conversation',
    indexes: ['child_conversation_id UNIQUE', 'status'],
    columns: [id(), ref('child_conversation_id', 'conversation'), text('status'), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'ChildExecutionParentLink', table: 'child_execution_parent_link', repository: 'ChildExecutionParentLinkRepository', codec: 'ChildExecutionParentLinkRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'cascade-with-child-execution',
    indexes: ['child_execution_id UNIQUE', 'source_tool_call_id UNIQUE', 'parent_child_execution_id', 'parent_turn_id'],
    columns: [id(), ref('child_execution_id', 'child_execution'), text('source_tool_call_id'), ref('parent_child_execution_id', 'child_execution', true, 'CASCADE'), text('parent_turn_id', { nullable: true }), text('created_at')]
  }),
  domain({
    key: 'ChildExecutionTurnLink', table: 'child_execution_turn_link', repository: 'ChildExecutionTurnLinkRepository', codec: 'ChildExecutionTurnLinkRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'cascade-with-child-execution',
    indexes: ['child_execution_id,turn_seq UNIQUE', 'turn_id UNIQUE'],
    columns: [id(), ref('child_execution_id', 'child_execution'), integer('turn_seq'), ref('turn_id', 'turn'), text('created_at')]
  }),
  domain({
    key: 'ChildExecutionIntentLink', table: 'child_execution_intent_link', repository: 'ChildExecutionIntentLinkRepository', codec: 'ChildExecutionIntentLinkRowCodec',
    mutations: ['insert', 'update'], client: 'none', deletePolicy: 'cascade-with-child-execution',
    indexes: ['child_execution_id,intent_seq UNIQUE', 'turn_intent_id UNIQUE', 'state'],
    columns: [id(), ref('child_execution_id', 'child_execution'), integer('intent_seq'), ref('turn_intent_id', 'turn_intent'), text('state'), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'ChildExecutionActiveTurnLink', table: 'child_execution_active_turn_link', repository: 'ChildExecutionActiveTurnLinkRepository', codec: 'ChildExecutionActiveTurnLinkRowCodec',
    mutations: ['insert', 'update', 'delete'], client: 'summary', deletePolicy: 'cascade-with-child-execution',
    indexes: ['child_execution_id UNIQUE', 'turn_id UNIQUE'],
    columns: [id(), ref('child_execution_id', 'child_execution'), ref('turn_id', 'turn'), text('updated_at')]
  }),
  domain({
    key: 'ChildInterruptionRequest', table: 'child_interruption_request', repository: 'ChildInterruptionRequestRepository', codec: 'ChildInterruptionRequestRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-child-execution',
    indexes: ['source_kind,source_key UNIQUE', 'root_child_execution_id'],
    columns: [id(), ref('root_child_execution_id', 'child_execution'), text('source_kind'), text('source_key'), text('reason'), text('created_at')]
  }),
  domain({
    key: 'ChildInterruptionLineageLink', table: 'child_interruption_lineage_link', repository: 'ChildInterruptionLineageLinkRepository', codec: 'ChildInterruptionLineageLinkRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-child-interruption',
    indexes: ['interruption_request_id,child_execution_id UNIQUE', 'child_execution_id'],
    columns: [id(), ref('interruption_request_id', 'child_interruption_request'), ref('child_execution_id', 'child_execution'), text('created_at')]
  }),
  domain({
    key: 'ChildInterruptionTurnLink', table: 'child_interruption_turn_link', repository: 'ChildInterruptionTurnLinkRepository', codec: 'ChildInterruptionTurnLinkRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-child-interruption',
    indexes: ['interruption_request_id,turn_id UNIQUE', 'child_execution_id', 'turn_id'],
    columns: [id(), ref('interruption_request_id', 'child_interruption_request'), ref('child_execution_id', 'child_execution'), ref('turn_id', 'turn'), text('pending_turn_input_id'), text('created_at')]
  }),
  domain({
    key: 'ChildInterruptionIntentLink', table: 'child_interruption_intent_link', repository: 'ChildInterruptionIntentLinkRepository', codec: 'ChildInterruptionIntentLinkRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-child-interruption',
    indexes: ['interruption_request_id,child_execution_intent_link_id UNIQUE', 'child_execution_id'],
    columns: [id(), ref('interruption_request_id', 'child_interruption_request'), ref('child_execution_id', 'child_execution'), ref('child_execution_intent_link_id', 'child_execution_intent_link'), text('created_at')]
  }),
  domain({
    key: 'AnswerBridge', table: 'answer_bridge', repository: 'AnswerBridgeRepository', codec: 'AnswerBridgeRowCodec',
    mutations: ['insert', 'update'], client: 'summary', deletePolicy: 'cascade-with-child-execution',
    indexes: ['child_execution_id UNIQUE', 'current_submission_id'],
    columns: [id(), ref('child_execution_id', 'child_execution'), text('current_submission_id', { nullable: true }), text('status'), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'AnswerSubmission', table: 'answer_submission', repository: 'AnswerSubmissionRepository', codec: 'AnswerSubmissionRowCodec',
    mutations: ['insert'], client: 'detail', deletePolicy: 'cascade-with-answer-bridge',
    indexes: ['answer_bridge_id,submission_seq UNIQUE'],
    columns: [id(), ref('answer_bridge_id', 'answer_bridge'), integer('submission_seq'), ref('turn_id', 'turn'), integer('interrupted'), text('created_at')]
  }),
  domain({
    key: 'AnswerPayload', table: 'answer_payload', repository: 'AnswerPayloadRepository', codec: 'AnswerPayloadRowCodec',
    mutations: ['insert'], client: 'detail', deletePolicy: 'cascade-with-answer-bridge',
    indexes: ['submission_id UNIQUE'],
    columns: [id(), ref('submission_id', 'answer_submission'), text('title', { nullable: true }), ref('content_object_id', 'content_object'), integer('byte_length'), text('created_at')]
  }),
  domain({
    key: 'RuntimeInboxItem', table: 'runtime_inbox_item', repository: 'RuntimeInboxRepository', codec: 'RuntimeInboxItemRowCodec',
    mutations: ['insert', 'update'], client: 'summary', deletePolicy: 'dataset-reset-only',
    indexes: ['dedupe_key UNIQUE', 'source_kind,source_id', 'state,created_at'],
    columns: [id(), text('dedupe_key'), text('source_kind'), text('source_id'), text('state'), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'RuntimeInboxPayloadLink', table: 'runtime_inbox_payload_link', repository: 'RuntimeInboxPayloadLinkRepository', codec: 'RuntimeInboxPayloadLinkRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-inbox-item',
    indexes: ['inbox_item_id UNIQUE', 'content_object_id'],
    columns: [id(), ref('inbox_item_id', 'runtime_inbox_item'), ref('content_object_id', 'content_object', false, 'RESTRICT'), text('created_at')]
  }),
  domain({
    key: 'RuntimeDelivery', table: 'runtime_delivery', repository: 'RuntimeDeliveryRepository', codec: 'RuntimeDeliveryRowCodec',
    mutations: ['insert', 'update'], client: 'summary', deletePolicy: 'cascade-with-inbox-item',
    indexes: ['inbox_item_id,target_conversation_id,attempt_seq UNIQUE', 'retry_of_delivery_id', 'target_conversation_id,state,created_at', 'target_conversation_id,state,created_at,id', 'target_conversation_id,created_at,id'],
    columns: [id(), ref('inbox_item_id', 'runtime_inbox_item'), text('target_conversation_id'), text('target_turn_id', { nullable: true }), text('phase'), integer('attempt_seq'), ref('retry_of_delivery_id', 'runtime_delivery', true, 'RESTRICT'), text('state'), text('failure_reason', { nullable: true }), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'RuntimeDeliveryIntentLink', table: 'runtime_delivery_intent_link', repository: 'RuntimeDeliveryIntentLinkRepository', codec: 'RuntimeDeliveryIntentLinkRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'cascade-with-delivery',
    indexes: ['delivery_id UNIQUE', 'turn_intent_id UNIQUE'],
    columns: [id(), ref('delivery_id', 'runtime_delivery'), ref('turn_intent_id', 'turn_intent'), text('created_at')]
  }),
  domain({
    key: 'RuntimeDeliveryInputLink', table: 'runtime_delivery_input_link', repository: 'RuntimeDeliveryInputLinkRepository', codec: 'RuntimeDeliveryInputLinkRowCodec',
    mutations: ['insert', 'update'], client: 'none', deletePolicy: 'cascade-with-delivery',
    indexes: ['delivery_id UNIQUE', 'pending_turn_input_id UNIQUE', 'handled_at'],
    columns: [id(), ref('delivery_id', 'runtime_delivery'), text('pending_turn_input_id'), text('handled_at', { nullable: true }), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'RuntimeDeliveryWake', table: 'runtime_delivery_wake', repository: 'RuntimeDeliveryWakeRepository', codec: 'RuntimeDeliveryWakeRowCodec',
    mutations: ['insert', 'update'], client: 'none', deletePolicy: 'cascade-with-delivery',
    indexes: ['delivery_id UNIQUE', 'state,next_attempt_at', 'claim_owner_host_boot_id,claim_expires_at'],
    columns: [
      id(), ref('delivery_id', 'runtime_delivery'), text('state'),
      text('claim_owner_host_boot_id', { nullable: true }), integer('claim_generation', { defaultSql: '0' }),
      text('claim_expires_at', { nullable: true }), integer('attempt_count', { defaultSql: '0' }),
      integer('failure_count', { defaultSql: '0' }), text('next_attempt_at', { nullable: true }),
      text('last_error', { nullable: true }), text('acknowledged_at', { nullable: true }),
      text('created_at'), text('updated_at')
    ]
  })
];
