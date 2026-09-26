CREATE INDEX "ix_agent_conversation_link_02" ON "agent_conversation_link" (agent_id);
CREATE INDEX "ix_answer_bridge_02" ON "answer_bridge" (current_submission_id);
CREATE INDEX "ix_attachment_02" ON "attachment" (sha256);
CREATE INDEX "ix_attachment_observation_link_02" ON "attachment_observation_link" (content_object_id);
CREATE INDEX "ix_attempt_02" ON "attempt" (status);
CREATE INDEX "ix_authority_snapshot_01" ON "authority_snapshot" (turn_id,created_at);
CREATE INDEX "ix_child_execution_02" ON "child_execution" (status);
CREATE INDEX "ix_child_execution_intent_link_03" ON "child_execution_intent_link" (state);
CREATE INDEX "ix_child_execution_parent_link_03" ON "child_execution_parent_link" (parent_child_execution_id);
CREATE INDEX "ix_child_execution_parent_link_04" ON "child_execution_parent_link" (parent_turn_id);
CREATE INDEX "ix_child_interruption_intent_link_02" ON "child_interruption_intent_link" (child_execution_id);
CREATE INDEX "ix_child_interruption_lineage_link_02" ON "child_interruption_lineage_link" (child_execution_id);
CREATE INDEX "ix_child_interruption_process_cleanup_02" ON "child_interruption_process_cleanup" (state,updated_at);
CREATE INDEX "ix_child_interruption_process_cleanup_03" ON "child_interruption_process_cleanup" (process_id);
CREATE INDEX "ix_child_interruption_request_02" ON "child_interruption_request" (root_child_execution_id);
CREATE INDEX "ix_child_interruption_turn_link_02" ON "child_interruption_turn_link" (child_execution_id);
CREATE INDEX "ix_child_interruption_turn_link_03" ON "child_interruption_turn_link" (turn_id);
CREATE INDEX "ix_collaboration_board_channel_01" ON "collaboration_board_channel" (name);
CREATE INDEX "ix_collaboration_board_command_receipt_03" ON "collaboration_board_command_receipt" (conversation_id);
CREATE INDEX "ix_collaboration_board_post_01" ON "collaboration_board_post" (created_at);
CREATE INDEX "ix_collaboration_board_post_source_link_04" ON "collaboration_board_post_source_link" (conversation_id);
CREATE INDEX "ix_collaboration_board_subscription_link_03" ON "collaboration_board_subscription_link" (channel_id,active);
CREATE INDEX "ix_collaboration_board_subscription_link_04" ON "collaboration_board_subscription_link" (thread_id,active);
CREATE INDEX "ix_collaboration_budget_02" ON "collaboration_budget" (authority_turn_id);
CREATE INDEX "ix_collaboration_message_03" ON "collaboration_message" (created_at,id);
CREATE INDEX "ix_collaboration_message_payload_link_02" ON "collaboration_message_payload_link" (content_object_id);
CREATE INDEX "ix_collaboration_message_reply_link_02" ON "collaboration_message_reply_link" (request_message_id);
CREATE INDEX "ix_collaboration_message_source_link_02" ON "collaboration_message_source_link" (conversation_id,created_at);
CREATE INDEX "ix_collaboration_message_target_link_02" ON "collaboration_message_target_link" (conversation_id,created_at);
CREATE INDEX "ix_collaboration_request_02" ON "collaboration_request" (budget_id,automatic);
CREATE INDEX "ix_collaboration_request_03" ON "collaboration_request" (state,created_at);
CREATE INDEX "ix_collaboration_request_turn_link_02" ON "collaboration_request_turn_link" (turn_id);
CREATE INDEX "ix_command_receipt_02" ON "command_receipt" (conversation_id,created_at);
CREATE INDEX "ix_compression_block_01" ON "compression_block" (conversation_id,created_at);
CREATE INDEX "ix_compression_block_02" ON "compression_block" (status);
CREATE INDEX "ix_compression_block_observation_link_03" ON "compression_block_observation_link" (observation_id);
CREATE INDEX "ix_context_segment_01" ON "context_segment" (content_object_id,segment_kind);
CREATE INDEX "ix_context_segment_source_02" ON "context_segment_source" (segment_id,source_kind);
CREATE INDEX "ix_context_sequence_node_01" ON "context_sequence_node" (parent_node_id);
CREATE INDEX "ix_context_sequence_root_02" ON "context_sequence_root" (root_node_id);
CREATE INDEX "ix_conversation_01" ON "conversation" (updated_at,id);
CREATE INDEX "ix_conversation_branch_link_02" ON "conversation_branch_link" (source_conversation_id,created_at);
CREATE INDEX "ix_conversation_context_head_link_02" ON "conversation_context_head_link" (root_id);
CREATE INDEX "ix_conversation_origin_link_02" ON "conversation_origin_link" (source_conversation_id);
CREATE INDEX "ix_conversation_origin_link_03" ON "conversation_origin_link" (source_turn_id);
CREATE INDEX "ix_conversation_origin_link_04" ON "conversation_origin_link" (source_tool_call_id);
CREATE INDEX "ix_conversation_project_link_02" ON "conversation_project_link" (project_context_id,conversation_id);
CREATE INDEX "ix_conversation_reuse_link_02" ON "conversation_reuse_link" (conversation_id);
CREATE INDEX "ix_conversation_reuse_link_03" ON "conversation_reuse_link" (agent_id);
CREATE INDEX "ix_effect_intent_02" ON "effect_intent" (dispatch_state);
CREATE INDEX "ix_effect_receipt_02" ON "effect_receipt" (effect_kind,received_at);
CREATE INDEX "ix_file_change_set_02" ON "file_change_set" (status);
CREATE INDEX "ix_file_change_set_member_02" ON "file_change_set_member" (change_set_id,target_path);
CREATE INDEX "ix_interaction_owner_link_02" ON "interaction_owner_link" (turn_id);
CREATE INDEX "ix_interaction_request_01" ON "interaction_request" (status,created_at);
CREATE INDEX "ix_interaction_tool_call_link_02" ON "interaction_tool_call_link" (tool_call_id);
CREATE INDEX "ix_message_01" ON "message" (created_at,id);
CREATE INDEX "ix_message_turn_link_02" ON "message_turn_link" (message_id);
CREATE INDEX "ix_model_context_projection_02" ON "model_context_projection" (root_id);
CREATE INDEX "ix_model_request_02" ON "model_request" (status);
CREATE INDEX "ix_operation_02" ON "operation" (tool_call_id);
CREATE INDEX "ix_operation_03" ON "operation" (status);
CREATE INDEX "ix_outcome_pause_01" ON "outcome_pause" (operation_id);
CREATE INDEX "ix_process_01" ON "process" (status,started_at);
CREATE INDEX "ix_process_completion_dispatch_02" ON "process_completion_dispatch" (state,next_attempt_at);
CREATE INDEX "ix_process_completion_dispatch_03" ON "process_completion_dispatch" (claim_owner_host_boot_id,claim_expires_at);
CREATE INDEX "ix_process_completion_source_link_02" ON "process_completion_source_link" (conversation_id,created_at);
CREATE INDEX "ix_process_completion_source_link_03" ON "process_completion_source_link" (source_turn_id);
CREATE INDEX "ix_process_completion_source_link_04" ON "process_completion_source_link" (source_tool_call_id);
CREATE INDEX "ix_process_origin_link_02" ON "process_origin_link" (tool_call_id);
CREATE INDEX "ix_project_context_02" ON "project_context" (updated_at,id);
CREATE INDEX "ix_runtime_delivery_02" ON "runtime_delivery" (retry_of_delivery_id);
CREATE INDEX "ix_runtime_delivery_03" ON "runtime_delivery" (target_conversation_id,state,created_at);
CREATE INDEX "ix_runtime_delivery_input_link_03" ON "runtime_delivery_input_link" (handled_at);
CREATE INDEX "ix_runtime_delivery_wake_02" ON "runtime_delivery_wake" (state,next_attempt_at);
CREATE INDEX "ix_runtime_delivery_wake_03" ON "runtime_delivery_wake" (claim_owner_host_boot_id,claim_expires_at);
CREATE INDEX "ix_runtime_inbox_item_02" ON "runtime_inbox_item" (source_kind,source_id);
CREATE INDEX "ix_runtime_inbox_item_03" ON "runtime_inbox_item" (state,created_at);
CREATE INDEX "ix_runtime_inbox_payload_link_02" ON "runtime_inbox_payload_link" (content_object_id);
CREATE INDEX "ix_tool_call_02" ON "tool_call" (status);
CREATE INDEX "ix_tool_call_policy_snapshot_02" ON "tool_call_policy_snapshot" (scheduling_mode,created_at);
CREATE INDEX "ix_tool_call_source_link_05" ON "tool_call_source_link" (message_id);
CREATE INDEX "ix_tool_execution_02" ON "tool_execution" (status);
CREATE INDEX "ix_turn_01" ON "turn" (conversation_id,created_at,id);
CREATE INDEX "ix_turn_02" ON "turn" (status);
CREATE INDEX "ix_turn_executor_link_02" ON "turn_executor_link" (agent_id);
CREATE INDEX "ix_turn_intent_01" ON "turn_intent" (turn_id);
CREATE INDEX "ix_turn_intent_executor_link_02" ON "turn_intent_executor_link" (agent_id);
CREATE UNIQUE INDEX "ux_agent_conversation_link_01" ON "agent_conversation_link" (conversation_id,role);
CREATE UNIQUE INDEX "ux_answer_bridge_01" ON "answer_bridge" (child_execution_id);
CREATE UNIQUE INDEX "ux_answer_payload_01" ON "answer_payload" (submission_id);
CREATE UNIQUE INDEX "ux_answer_submission_01" ON "answer_submission" (answer_bridge_id,submission_seq);
CREATE UNIQUE INDEX "ux_attachment_01" ON "attachment" (id);
CREATE UNIQUE INDEX "ux_attachment_link_01" ON "attachment_link" (message_revision_id,attachment_id,position);
CREATE UNIQUE INDEX "ux_attachment_observation_link_01" ON "attachment_observation_link" (attachment_id,analysis_profile_sha256);
CREATE UNIQUE INDEX "ux_attempt_01" ON "attempt" (operation_id,attempt_seq);
CREATE UNIQUE INDEX "ux_child_execution_01" ON "child_execution" (child_conversation_id);
CREATE UNIQUE INDEX "ux_child_execution_active_turn_link_01" ON "child_execution_active_turn_link" (child_execution_id);
CREATE UNIQUE INDEX "ux_child_execution_active_turn_link_02" ON "child_execution_active_turn_link" (turn_id);
CREATE UNIQUE INDEX "ux_child_execution_intent_link_01" ON "child_execution_intent_link" (child_execution_id,intent_seq);
CREATE UNIQUE INDEX "ux_child_execution_intent_link_02" ON "child_execution_intent_link" (turn_intent_id);
CREATE UNIQUE INDEX "ux_child_execution_parent_link_01" ON "child_execution_parent_link" (child_execution_id);
CREATE UNIQUE INDEX "ux_child_execution_parent_link_02" ON "child_execution_parent_link" (source_tool_call_id);
CREATE UNIQUE INDEX "ux_child_execution_turn_link_01" ON "child_execution_turn_link" (child_execution_id,turn_seq);
CREATE UNIQUE INDEX "ux_child_execution_turn_link_02" ON "child_execution_turn_link" (turn_id);
CREATE UNIQUE INDEX "ux_child_interruption_intent_link_01" ON "child_interruption_intent_link" (interruption_request_id,child_execution_intent_link_id);
CREATE UNIQUE INDEX "ux_child_interruption_lineage_link_01" ON "child_interruption_lineage_link" (interruption_request_id,child_execution_id);
CREATE UNIQUE INDEX "ux_child_interruption_process_cleanup_01" ON "child_interruption_process_cleanup" (interruption_request_id,process_id);
CREATE UNIQUE INDEX "ux_child_interruption_request_01" ON "child_interruption_request" (source_kind,source_key);
CREATE UNIQUE INDEX "ux_child_interruption_turn_link_01" ON "child_interruption_turn_link" (interruption_request_id,turn_id);
CREATE UNIQUE INDEX "ux_collaboration_board_channel_scope_link_01" ON "collaboration_board_channel_scope_link" (channel_id);
CREATE UNIQUE INDEX "ux_collaboration_board_channel_scope_link_02" ON "collaboration_board_channel_scope_link" (root_conversation_id,channel_id);
CREATE UNIQUE INDEX "ux_collaboration_board_command_receipt_01" ON "collaboration_board_command_receipt" (source_kind,source_key);
CREATE UNIQUE INDEX "ux_collaboration_board_command_receipt_02" ON "collaboration_board_command_receipt" (source_tool_call_id);
CREATE UNIQUE INDEX "ux_collaboration_board_post_channel_link_01" ON "collaboration_board_post_channel_link" (post_id);
CREATE UNIQUE INDEX "ux_collaboration_board_post_channel_link_02" ON "collaboration_board_post_channel_link" (channel_id,post_id);
CREATE UNIQUE INDEX "ux_collaboration_board_post_source_link_01" ON "collaboration_board_post_source_link" (post_id);
CREATE UNIQUE INDEX "ux_collaboration_board_post_source_link_02" ON "collaboration_board_post_source_link" (source_kind,source_key);
CREATE UNIQUE INDEX "ux_collaboration_board_post_source_link_03" ON "collaboration_board_post_source_link" (source_tool_call_id);
CREATE UNIQUE INDEX "ux_collaboration_board_reply_link_01" ON "collaboration_board_reply_link" (post_id);
CREATE UNIQUE INDEX "ux_collaboration_board_reply_link_02" ON "collaboration_board_reply_link" (thread_id,post_id);
CREATE UNIQUE INDEX "ux_collaboration_board_subscription_link_01" ON "collaboration_board_subscription_link" (conversation_id,channel_id) WHERE channel_id IS NOT NULL;
CREATE UNIQUE INDEX "ux_collaboration_board_subscription_link_02" ON "collaboration_board_subscription_link" (conversation_id,thread_id) WHERE thread_id IS NOT NULL;
CREATE UNIQUE INDEX "ux_collaboration_budget_01" ON "collaboration_budget" (origin_kind,origin_key);
CREATE UNIQUE INDEX "ux_collaboration_message_01" ON "collaboration_message" (dedupe_key);
CREATE UNIQUE INDEX "ux_collaboration_message_02" ON "collaboration_message" (message_seq);
CREATE UNIQUE INDEX "ux_collaboration_message_payload_link_01" ON "collaboration_message_payload_link" (message_id);
CREATE UNIQUE INDEX "ux_collaboration_message_reply_link_01" ON "collaboration_message_reply_link" (message_id);
CREATE UNIQUE INDEX "ux_collaboration_message_source_link_01" ON "collaboration_message_source_link" (message_id);
CREATE UNIQUE INDEX "ux_collaboration_message_source_link_03" ON "collaboration_message_source_link" (source_kind,source_key);
CREATE UNIQUE INDEX "ux_collaboration_message_target_link_01" ON "collaboration_message_target_link" (message_id);
CREATE UNIQUE INDEX "ux_collaboration_message_target_link_03" ON "collaboration_message_target_link" (inbox_item_id);
CREATE UNIQUE INDEX "ux_collaboration_request_01" ON "collaboration_request" (message_id);
CREATE UNIQUE INDEX "ux_collaboration_request_turn_link_01" ON "collaboration_request_turn_link" (request_id);
CREATE UNIQUE INDEX "ux_command_receipt_01" ON "command_receipt" (source_kind,source_key);
CREATE UNIQUE INDEX "ux_compression_block_observation_link_01" ON "compression_block_observation_link" (compression_block_id,position);
CREATE UNIQUE INDEX "ux_compression_block_observation_link_02" ON "compression_block_observation_link" (compression_block_id,observation_id);
CREATE UNIQUE INDEX "ux_compression_block_source_01" ON "compression_block_source" (compression_block_id,segment_id,position);
CREATE UNIQUE INDEX "ux_content_object_01" ON "content_object" (content_type,sha256,byte_length);
CREATE UNIQUE INDEX "ux_context_segment_source_01" ON "context_segment_source" (source_kind,source_id,source_revision);
CREATE UNIQUE INDEX "ux_context_sequence_node_02" ON "context_sequence_node" (parent_node_id,segment_id);
CREATE UNIQUE INDEX "ux_context_sequence_node_03" ON "context_sequence_node" (segment_id) WHERE parent_node_id IS NULL;
CREATE UNIQUE INDEX "ux_context_sequence_root_01" ON "context_sequence_root" (conversation_id,root_seq);
CREATE UNIQUE INDEX "ux_conversation_attachment_handle_link_01" ON "conversation_attachment_handle_link" (conversation_id,attachment_id);
CREATE UNIQUE INDEX "ux_conversation_attachment_handle_link_02" ON "conversation_attachment_handle_link" (conversation_id,handle_seq);
CREATE UNIQUE INDEX "ux_conversation_branch_link_01" ON "conversation_branch_link" (target_conversation_id);
CREATE UNIQUE INDEX "ux_conversation_context_head_link_01" ON "conversation_context_head_link" (conversation_id);
CREATE UNIQUE INDEX "ux_conversation_origin_link_01" ON "conversation_origin_link" (conversation_id);
CREATE UNIQUE INDEX "ux_conversation_project_link_01" ON "conversation_project_link" (conversation_id);
CREATE UNIQUE INDEX "ux_conversation_reuse_link_01" ON "conversation_reuse_link" (reuse_key);
CREATE UNIQUE INDEX "ux_effect_intent_01" ON "effect_intent" (attempt_id);
CREATE UNIQUE INDEX "ux_effect_receipt_01" ON "effect_receipt" (attempt_id);
CREATE UNIQUE INDEX "ux_execution_lease_01" ON "execution_lease" (conversation_id);
CREATE UNIQUE INDEX "ux_execution_lease_02" ON "execution_lease" (turn_id);
CREATE UNIQUE INDEX "ux_file_change_decision_01" ON "file_change_decision" (change_set_id);
CREATE UNIQUE INDEX "ux_file_change_set_01" ON "file_change_set" (tool_call_id);
CREATE UNIQUE INDEX "ux_file_change_set_member_01" ON "file_change_set_member" (change_set_id,member_seq);
CREATE UNIQUE INDEX "ux_file_mutation_receipt_01" ON "file_mutation_receipt" (effect_receipt_id);
CREATE UNIQUE INDEX "ux_file_mutation_receipt_02" ON "file_mutation_receipt" (change_set_id);
CREATE UNIQUE INDEX "ux_file_mutation_receipt_member_01" ON "file_mutation_receipt_member" (receipt_id,member_id);
CREATE UNIQUE INDEX "ux_interaction_owner_link_01" ON "interaction_owner_link" (request_id);
CREATE UNIQUE INDEX "ux_interaction_response_01" ON "interaction_response" (request_id);
CREATE UNIQUE INDEX "ux_interaction_tool_call_link_01" ON "interaction_tool_call_link" (request_id);
CREATE UNIQUE INDEX "ux_message_current_revision_link_01" ON "message_current_revision_link" (message_id);
CREATE UNIQUE INDEX "ux_message_current_revision_link_02" ON "message_current_revision_link" (revision_id);
CREATE UNIQUE INDEX "ux_message_part_of_conversation_01" ON "message_part_of_conversation" (conversation_id,message_seq);
CREATE UNIQUE INDEX "ux_message_part_of_conversation_02" ON "message_part_of_conversation" (message_id);
CREATE UNIQUE INDEX "ux_message_revision_01" ON "message_revision" (message_id,revision_seq);
CREATE UNIQUE INDEX "ux_message_turn_link_01" ON "message_turn_link" (turn_id,message_id,role);
CREATE UNIQUE INDEX "ux_model_context_projection_01" ON "model_context_projection" (owner_kind,owner_id);
CREATE UNIQUE INDEX "ux_model_request_01" ON "model_request" (turn_id,request_seq);
CREATE UNIQUE INDEX "ux_model_request_message_link_01" ON "model_request_message_link" (model_request_id);
CREATE UNIQUE INDEX "ux_model_request_message_link_02" ON "model_request_message_link" (message_id);
CREATE UNIQUE INDEX "ux_model_stream_checkpoint_01" ON "model_stream_checkpoint" (model_request_id,attempt_seq,socket_generation,stream_seq);
CREATE UNIQUE INDEX "ux_model_stream_fence_01" ON "model_stream_fence" (model_request_id);
CREATE UNIQUE INDEX "ux_operation_01" ON "operation" (owner_kind,owner_id,operation_seq);
CREATE UNIQUE INDEX "ux_operation_resolution_01" ON "operation_resolution" (pause_id);
CREATE UNIQUE INDEX "ux_pending_turn_input_01" ON "pending_turn_input" (turn_id,position);
CREATE UNIQUE INDEX "ux_pending_turn_input_02" ON "pending_turn_input" (turn_id,input_kind) WHERE state = 'pending' AND input_kind = 'interrupt_request';
CREATE UNIQUE INDEX "ux_process_completion_dispatch_01" ON "process_completion_dispatch" (process_receipt_id);
CREATE UNIQUE INDEX "ux_process_completion_source_link_01" ON "process_completion_source_link" (process_id);
CREATE UNIQUE INDEX "ux_process_origin_link_01" ON "process_origin_link" (process_id);
CREATE UNIQUE INDEX "ux_process_output_chunk_01" ON "process_output_chunk" (process_id,chunk_seq);
CREATE UNIQUE INDEX "ux_process_receipt_01" ON "process_receipt" (process_id);
CREATE UNIQUE INDEX "ux_project_context_01" ON "project_context" (uri);
CREATE UNIQUE INDEX "ux_runtime_delivery_01" ON "runtime_delivery" (inbox_item_id,target_conversation_id,attempt_seq);
CREATE UNIQUE INDEX "ux_runtime_delivery_input_link_01" ON "runtime_delivery_input_link" (delivery_id);
CREATE UNIQUE INDEX "ux_runtime_delivery_input_link_02" ON "runtime_delivery_input_link" (pending_turn_input_id);
CREATE UNIQUE INDEX "ux_runtime_delivery_intent_link_01" ON "runtime_delivery_intent_link" (delivery_id);
CREATE UNIQUE INDEX "ux_runtime_delivery_intent_link_02" ON "runtime_delivery_intent_link" (turn_intent_id);
CREATE UNIQUE INDEX "ux_runtime_delivery_wake_01" ON "runtime_delivery_wake" (delivery_id);
CREATE UNIQUE INDEX "ux_runtime_inbox_item_01" ON "runtime_inbox_item" (dedupe_key);
CREATE UNIQUE INDEX "ux_runtime_inbox_payload_link_01" ON "runtime_inbox_payload_link" (inbox_item_id);
CREATE UNIQUE INDEX "ux_tool_call_01" ON "tool_call" (turn_id,call_seq);
CREATE UNIQUE INDEX "ux_tool_call_event_01" ON "tool_call_event" (tool_call_id,event_seq);
CREATE UNIQUE INDEX "ux_tool_call_policy_snapshot_01" ON "tool_call_policy_snapshot" (tool_call_id);
CREATE UNIQUE INDEX "ux_tool_call_source_link_01" ON "tool_call_source_link" (tool_call_id);
CREATE UNIQUE INDEX "ux_tool_call_source_link_02" ON "tool_call_source_link" (model_request_id,provider_ordinal);
CREATE UNIQUE INDEX "ux_tool_call_source_link_03" ON "tool_call_source_link" (model_request_id,provider_call_id) WHERE provider_call_id IS NOT NULL;
CREATE UNIQUE INDEX "ux_tool_call_source_link_04" ON "tool_call_source_link" (batch_id,batch_ordinal);
CREATE UNIQUE INDEX "ux_tool_execution_01" ON "tool_execution" (tool_call_id);
CREATE UNIQUE INDEX "ux_tool_model_result_01" ON "tool_model_result" (tool_call_id);
CREATE UNIQUE INDEX "ux_tool_model_result_02" ON "tool_model_result" (message_revision_id);
CREATE UNIQUE INDEX "ux_tool_outcome_01" ON "tool_outcome" (tool_call_id);
CREATE UNIQUE INDEX "ux_tool_result_artifact_01" ON "tool_result_artifact" (tool_call_id,role);
CREATE UNIQUE INDEX "ux_turn_execution_preset_revision_01" ON "turn_execution_preset_revision" (intent_id,revision_seq);
CREATE UNIQUE INDEX "ux_turn_executor_link_01" ON "turn_executor_link" (turn_id);
CREATE UNIQUE INDEX "ux_turn_final_output_fence_01" ON "turn_final_output_fence" (turn_id);
CREATE UNIQUE INDEX "ux_turn_final_output_fence_02" ON "turn_final_output_fence" (model_request_id);
CREATE UNIQUE INDEX "ux_turn_intent_authority_revision_01" ON "turn_intent_authority_revision" (intent_id,revision_seq);
CREATE UNIQUE INDEX "ux_turn_intent_executor_link_01" ON "turn_intent_executor_link" (intent_id);
CREATE UNIQUE INDEX "ux_turn_intent_revision_01" ON "turn_intent_revision" (intent_id,revision_seq);
CREATE UNIQUE INDEX "ux_turn_termination_01" ON "turn_termination" (turn_id);
CREATE TABLE "agent_conversation_link" (
  "id" TEXT PRIMARY KEY,
  "conversation_id" TEXT NOT NULL REFERENCES "conversation" ("id") ON DELETE CASCADE,
  "agent_id" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "answer_bridge" (
  "id" TEXT PRIMARY KEY,
  "child_execution_id" TEXT NOT NULL REFERENCES "child_execution" ("id") ON DELETE CASCADE,
  "current_submission_id" TEXT,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "answer_payload" (
  "id" TEXT PRIMARY KEY,
  "submission_id" TEXT NOT NULL REFERENCES "answer_submission" ("id") ON DELETE CASCADE,
  "title" TEXT,
  "content_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE CASCADE,
  "byte_length" INTEGER NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "answer_submission" (
  "id" TEXT PRIMARY KEY,
  "answer_bridge_id" TEXT NOT NULL REFERENCES "answer_bridge" ("id") ON DELETE CASCADE,
  "submission_seq" INTEGER NOT NULL,
  "turn_id" TEXT NOT NULL REFERENCES "turn" ("id") ON DELETE CASCADE,
  "interrupted" INTEGER NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "attachment" (
  "id" TEXT PRIMARY KEY,
  "sha256" TEXT NOT NULL,
  "byte_length" INTEGER NOT NULL,
  "mime_type" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "storage_mode" TEXT NOT NULL,
  "content_object_id" TEXT REFERENCES "content_object" ("id") ON DELETE RESTRICT,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "attachment_link" (
  "id" TEXT PRIMARY KEY,
  "message_revision_id" TEXT NOT NULL REFERENCES "message_revision" ("id") ON DELETE CASCADE,
  "attachment_id" TEXT NOT NULL REFERENCES "attachment" ("id") ON DELETE RESTRICT,
  "position" INTEGER NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "attachment_observation_link" (
  "id" TEXT PRIMARY KEY,
  "attachment_id" TEXT NOT NULL REFERENCES "attachment" ("id") ON DELETE RESTRICT,
  "analysis_profile_sha256" TEXT NOT NULL,
  "content_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE RESTRICT,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "attempt" (
  "id" TEXT PRIMARY KEY,
  "operation_id" TEXT NOT NULL REFERENCES "operation" ("id") ON DELETE CASCADE,
  "attempt_seq" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "completed_at" TEXT
);
CREATE TABLE "authority_snapshot" (
  "id" TEXT PRIMARY KEY,
  "turn_id" TEXT NOT NULL REFERENCES "turn" ("id") ON DELETE CASCADE,
  "content_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "child_execution" (
  "id" TEXT PRIMARY KEY,
  "child_conversation_id" TEXT NOT NULL REFERENCES "conversation" ("id") ON DELETE CASCADE,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "child_execution_active_turn_link" (
  "id" TEXT PRIMARY KEY,
  "child_execution_id" TEXT NOT NULL REFERENCES "child_execution" ("id") ON DELETE CASCADE,
  "turn_id" TEXT NOT NULL REFERENCES "turn" ("id") ON DELETE CASCADE,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "child_execution_intent_link" (
  "id" TEXT PRIMARY KEY,
  "child_execution_id" TEXT NOT NULL REFERENCES "child_execution" ("id") ON DELETE CASCADE,
  "intent_seq" INTEGER NOT NULL,
  "turn_intent_id" TEXT NOT NULL REFERENCES "turn_intent" ("id") ON DELETE CASCADE,
  "state" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "child_execution_parent_link" (
  "id" TEXT PRIMARY KEY,
  "child_execution_id" TEXT NOT NULL REFERENCES "child_execution" ("id") ON DELETE CASCADE,
  "source_tool_call_id" TEXT NOT NULL,
  "parent_child_execution_id" TEXT REFERENCES "child_execution" ("id") ON DELETE CASCADE,
  "parent_turn_id" TEXT,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "child_execution_turn_link" (
  "id" TEXT PRIMARY KEY,
  "child_execution_id" TEXT NOT NULL REFERENCES "child_execution" ("id") ON DELETE CASCADE,
  "turn_seq" INTEGER NOT NULL,
  "turn_id" TEXT NOT NULL REFERENCES "turn" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "child_interruption_intent_link" (
  "id" TEXT PRIMARY KEY,
  "interruption_request_id" TEXT NOT NULL REFERENCES "child_interruption_request" ("id") ON DELETE CASCADE,
  "child_execution_id" TEXT NOT NULL REFERENCES "child_execution" ("id") ON DELETE CASCADE,
  "child_execution_intent_link_id" TEXT NOT NULL REFERENCES "child_execution_intent_link" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "child_interruption_lineage_link" (
  "id" TEXT PRIMARY KEY,
  "interruption_request_id" TEXT NOT NULL REFERENCES "child_interruption_request" ("id") ON DELETE CASCADE,
  "child_execution_id" TEXT NOT NULL REFERENCES "child_execution" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "child_interruption_process_cleanup" (
  "id" TEXT PRIMARY KEY,
  "interruption_request_id" TEXT NOT NULL REFERENCES "child_interruption_request" ("id") ON DELETE CASCADE,
  "process_id" TEXT NOT NULL REFERENCES "process" ("id") ON DELETE CASCADE,
  "state" TEXT NOT NULL,
  "last_status" TEXT,
  "last_error" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "child_interruption_request" (
  "id" TEXT PRIMARY KEY,
  "root_child_execution_id" TEXT NOT NULL REFERENCES "child_execution" ("id") ON DELETE CASCADE,
  "source_kind" TEXT NOT NULL,
  "source_key" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "child_interruption_turn_link" (
  "id" TEXT PRIMARY KEY,
  "interruption_request_id" TEXT NOT NULL REFERENCES "child_interruption_request" ("id") ON DELETE CASCADE,
  "child_execution_id" TEXT NOT NULL REFERENCES "child_execution" ("id") ON DELETE CASCADE,
  "turn_id" TEXT NOT NULL REFERENCES "turn" ("id") ON DELETE CASCADE,
  "pending_turn_input_id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "collaboration_board_channel" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "collaboration_board_channel_scope_link" (
  "id" TEXT PRIMARY KEY,
  "channel_id" TEXT NOT NULL REFERENCES "collaboration_board_channel" ("id") ON DELETE CASCADE,
  "root_conversation_id" TEXT NOT NULL REFERENCES "conversation" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "collaboration_board_command_receipt" (
  "id" TEXT PRIMARY KEY,
  "source_kind" TEXT NOT NULL,
  "source_key" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL REFERENCES "conversation" ("id") ON DELETE CASCADE,
  "source_tool_call_id" TEXT REFERENCES "tool_call" ("id") ON DELETE CASCADE,
  "operation" TEXT NOT NULL,
  "request_digest" TEXT NOT NULL,
  "result_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE RESTRICT,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "collaboration_board_post" (
  "id" TEXT PRIMARY KEY,
  "content_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE RESTRICT,
  "character_count" INTEGER NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "collaboration_board_post_channel_link" (
  "id" TEXT PRIMARY KEY,
  "post_id" TEXT NOT NULL REFERENCES "collaboration_board_post" ("id") ON DELETE CASCADE,
  "channel_id" TEXT NOT NULL REFERENCES "collaboration_board_channel" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "collaboration_board_post_source_link" (
  "id" TEXT PRIMARY KEY,
  "post_id" TEXT NOT NULL REFERENCES "collaboration_board_post" ("id") ON DELETE CASCADE,
  "source_kind" TEXT NOT NULL,
  "source_key" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL REFERENCES "conversation" ("id") ON DELETE CASCADE,
  "source_turn_id" TEXT REFERENCES "turn" ("id") ON DELETE CASCADE,
  "source_tool_call_id" TEXT REFERENCES "tool_call" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "collaboration_board_reply_link" (
  "id" TEXT PRIMARY KEY,
  "post_id" TEXT NOT NULL REFERENCES "collaboration_board_post" ("id") ON DELETE CASCADE,
  "thread_id" TEXT NOT NULL REFERENCES "collaboration_board_post" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "collaboration_board_subscription_link" (
  "id" TEXT PRIMARY KEY,
  "conversation_id" TEXT NOT NULL REFERENCES "conversation" ("id") ON DELETE CASCADE,
  "channel_id" TEXT REFERENCES "collaboration_board_channel" ("id") ON DELETE CASCADE,
  "thread_id" TEXT REFERENCES "collaboration_board_post" ("id") ON DELETE CASCADE,
  "active" INTEGER NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "collaboration_budget" (
  "id" TEXT PRIMARY KEY,
  "origin_kind" TEXT NOT NULL,
  "origin_key" TEXT NOT NULL,
  "authority_turn_id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "collaboration_message" (
  "id" TEXT PRIMARY KEY,
  "dedupe_key" TEXT NOT NULL,
  "message_seq" INTEGER NOT NULL,
  "mode" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "collaboration_message_payload_link" (
  "id" TEXT PRIMARY KEY,
  "message_id" TEXT NOT NULL REFERENCES "collaboration_message" ("id") ON DELETE CASCADE,
  "content_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE RESTRICT,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "collaboration_message_reply_link" (
  "id" TEXT PRIMARY KEY,
  "message_id" TEXT NOT NULL REFERENCES "collaboration_message" ("id") ON DELETE CASCADE,
  "request_message_id" TEXT NOT NULL REFERENCES "collaboration_message" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "collaboration_message_source_link" (
  "id" TEXT PRIMARY KEY,
  "message_id" TEXT NOT NULL REFERENCES "collaboration_message" ("id") ON DELETE CASCADE,
  "conversation_id" TEXT NOT NULL,
  "source_kind" TEXT NOT NULL,
  "source_key" TEXT NOT NULL,
  "turn_id" TEXT,
  "tool_call_id" TEXT,
  "board_post_id" TEXT,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "collaboration_message_target_link" (
  "id" TEXT PRIMARY KEY,
  "message_id" TEXT NOT NULL REFERENCES "collaboration_message" ("id") ON DELETE CASCADE,
  "conversation_id" TEXT NOT NULL,
  "inbox_item_id" TEXT NOT NULL REFERENCES "runtime_inbox_item" ("id") ON DELETE CASCADE,
  "anchor_turn_id" TEXT,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "collaboration_request" (
  "id" TEXT PRIMARY KEY,
  "message_id" TEXT NOT NULL REFERENCES "collaboration_message" ("id") ON DELETE CASCADE,
  "budget_id" TEXT NOT NULL REFERENCES "collaboration_budget" ("id") ON DELETE CASCADE,
  "automatic" INTEGER NOT NULL,
  "state" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "collaboration_request_turn_link" (
  "id" TEXT PRIMARY KEY,
  "request_id" TEXT NOT NULL REFERENCES "collaboration_request" ("id") ON DELETE CASCADE,
  "turn_id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "command_receipt" (
  "id" TEXT PRIMARY KEY,
  "source_kind" TEXT NOT NULL,
  "source_key" TEXT NOT NULL,
  "conversation_id" TEXT,
  "turn_id" TEXT,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "compression_block" (
  "id" TEXT PRIMARY KEY,
  "conversation_id" TEXT NOT NULL REFERENCES "conversation" ("id") ON DELETE CASCADE,
  "status" TEXT NOT NULL,
  "authority_snapshot_id" TEXT NOT NULL,
  "title_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE CASCADE,
  "summary_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "compression_block_observation_link" (
  "id" TEXT PRIMARY KEY,
  "compression_block_id" TEXT NOT NULL REFERENCES "compression_block" ("id") ON DELETE CASCADE,
  "observation_id" TEXT NOT NULL REFERENCES "attachment_observation_link" ("id") ON DELETE RESTRICT,
  "position" INTEGER NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "compression_block_source" (
  "id" TEXT PRIMARY KEY,
  "compression_block_id" TEXT NOT NULL REFERENCES "compression_block" ("id") ON DELETE CASCADE,
  "segment_id" TEXT NOT NULL REFERENCES "context_segment" ("id") ON DELETE RESTRICT,
  "position" INTEGER NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "content_object" (
  "id" TEXT PRIMARY KEY,
  "content_type" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "byte_length" INTEGER NOT NULL,
  "storage_key" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "context_segment" (
  "id" TEXT PRIMARY KEY,
  "content_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE CASCADE,
  "segment_kind" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "context_segment_source" (
  "id" TEXT PRIMARY KEY,
  "segment_id" TEXT NOT NULL REFERENCES "context_segment" ("id") ON DELETE CASCADE,
  "source_kind" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "source_revision" INTEGER NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "context_sequence_node" (
  "id" TEXT PRIMARY KEY,
  "parent_node_id" TEXT REFERENCES "context_sequence_node" ("id") ON DELETE RESTRICT,
  "segment_id" TEXT NOT NULL REFERENCES "context_segment" ("id") ON DELETE RESTRICT,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "context_sequence_root" (
  "id" TEXT PRIMARY KEY,
  "conversation_id" TEXT NOT NULL,
  "root_seq" INTEGER NOT NULL,
  "root_node_id" TEXT REFERENCES "context_sequence_node" ("id") ON DELETE RESTRICT,
  "tail_node_id" TEXT REFERENCES "context_sequence_node" ("id") ON DELETE RESTRICT,
  "tail_segment_count" INTEGER NOT NULL,
  "segment_count" INTEGER NOT NULL,
  "estimated_tokens" INTEGER NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "conversation" (
  "id" TEXT PRIMARY KEY,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "conversation_attachment_handle_link" (
  "id" TEXT PRIMARY KEY,
  "conversation_id" TEXT NOT NULL REFERENCES "conversation" ("id") ON DELETE CASCADE,
  "attachment_id" TEXT NOT NULL REFERENCES "attachment" ("id") ON DELETE RESTRICT,
  "handle_seq" INTEGER NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "conversation_branch_link" (
  "id" TEXT PRIMARY KEY,
  "target_conversation_id" TEXT NOT NULL REFERENCES "conversation" ("id") ON DELETE CASCADE,
  "source_conversation_id" TEXT NOT NULL,
  "source_message_revision_id" TEXT,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "conversation_context_head_link" (
  "id" TEXT PRIMARY KEY,
  "conversation_id" TEXT NOT NULL REFERENCES "conversation" ("id") ON DELETE CASCADE,
  "root_id" TEXT NOT NULL REFERENCES "context_sequence_root" ("id") ON DELETE RESTRICT,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "conversation_origin_link" (
  "id" TEXT PRIMARY KEY,
  "conversation_id" TEXT NOT NULL REFERENCES "conversation" ("id") ON DELETE CASCADE,
  "source_conversation_id" TEXT,
  "source_turn_id" TEXT,
  "source_tool_call_id" TEXT,
  "source_message_revision_id" TEXT,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "conversation_project_link" (
  "id" TEXT PRIMARY KEY,
  "conversation_id" TEXT NOT NULL REFERENCES "conversation" ("id") ON DELETE CASCADE,
  "project_context_id" TEXT NOT NULL REFERENCES "project_context" ("id") ON DELETE RESTRICT,
  "role" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "conversation_reuse_link" (
  "id" TEXT PRIMARY KEY,
  "reuse_key" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL REFERENCES "conversation" ("id") ON DELETE CASCADE,
  "agent_id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "effect_intent" (
  "id" TEXT PRIMARY KEY,
  "attempt_id" TEXT NOT NULL,
  "effect_kind" TEXT NOT NULL,
  "dispatch_state" TEXT NOT NULL,
  "request_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "effect_receipt" (
  "id" TEXT PRIMARY KEY,
  "attempt_id" TEXT NOT NULL,
  "effect_kind" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "response_object_id" TEXT REFERENCES "content_object" ("id") ON DELETE RESTRICT,
  "conversation_id" TEXT,
  "tool_call_id" TEXT,
  "operation_id" TEXT,
  "received_at" TEXT NOT NULL
);
CREATE TABLE "execution_lease" (
  "id" TEXT PRIMARY KEY,
  "conversation_id" TEXT NOT NULL REFERENCES "conversation" ("id") ON DELETE CASCADE,
  "turn_id" TEXT NOT NULL REFERENCES "turn" ("id") ON DELETE CASCADE,
  "owner_id" TEXT NOT NULL,
  "host_boot_id" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "acquired_at" TEXT NOT NULL,
  "expires_at" TEXT NOT NULL
);
CREATE TABLE "file_change_decision" (
  "id" TEXT PRIMARY KEY,
  "change_set_id" TEXT NOT NULL REFERENCES "file_change_set" ("id") ON DELETE CASCADE,
  "decision" TEXT NOT NULL,
  "decided_at" TEXT NOT NULL
);
CREATE TABLE "file_change_set" (
  "id" TEXT PRIMARY KEY,
  "tool_call_id" TEXT NOT NULL REFERENCES "tool_call" ("id") ON DELETE CASCADE,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "file_change_set_member" (
  "id" TEXT PRIMARY KEY,
  "change_set_id" TEXT NOT NULL REFERENCES "file_change_set" ("id") ON DELETE CASCADE,
  "member_seq" INTEGER NOT NULL,
  "operation" TEXT NOT NULL,
  "work_environment_id" TEXT NOT NULL,
  "target_path" TEXT NOT NULL,
  "base_digest" TEXT,
  "base_content_object_id" TEXT REFERENCES "content_object" ("id") ON DELETE RESTRICT,
  "target_content_object_id" TEXT REFERENCES "content_object" ("id") ON DELETE RESTRICT,
  "target_digest" TEXT,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "file_mutation_receipt" (
  "id" TEXT PRIMARY KEY,
  "effect_receipt_id" TEXT NOT NULL,
  "change_set_id" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "file_mutation_receipt_member" (
  "id" TEXT PRIMARY KEY,
  "receipt_id" TEXT NOT NULL REFERENCES "file_mutation_receipt" ("id") ON DELETE CASCADE,
  "member_id" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "actual_digest" TEXT,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "interaction_owner_link" (
  "id" TEXT PRIMARY KEY,
  "request_id" TEXT NOT NULL REFERENCES "interaction_request" ("id") ON DELETE CASCADE,
  "turn_id" TEXT NOT NULL REFERENCES "turn" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "interaction_request" (
  "id" TEXT PRIMARY KEY,
  "request_kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "prompt_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "interaction_response" (
  "id" TEXT PRIMARY KEY,
  "request_id" TEXT NOT NULL REFERENCES "interaction_request" ("id") ON DELETE CASCADE,
  "content_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "interaction_tool_call_link" (
  "id" TEXT PRIMARY KEY,
  "request_id" TEXT NOT NULL REFERENCES "interaction_request" ("id") ON DELETE CASCADE,
  "tool_call_id" TEXT NOT NULL REFERENCES "tool_call" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "message" (
  "id" TEXT PRIMARY KEY,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "deleted_at" TEXT
);
CREATE TABLE "message_current_revision_link" (
  "id" TEXT PRIMARY KEY,
  "message_id" TEXT NOT NULL REFERENCES "message" ("id") ON DELETE CASCADE,
  "revision_id" TEXT NOT NULL REFERENCES "message_revision" ("id") ON DELETE CASCADE,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "message_part_of_conversation" (
  "id" TEXT PRIMARY KEY,
  "conversation_id" TEXT NOT NULL REFERENCES "conversation" ("id") ON DELETE CASCADE,
  "message_id" TEXT NOT NULL REFERENCES "message" ("id") ON DELETE CASCADE,
  "message_seq" INTEGER NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "message_revision" (
  "id" TEXT PRIMARY KEY,
  "message_id" TEXT NOT NULL REFERENCES "message" ("id") ON DELETE CASCADE,
  "revision_seq" INTEGER NOT NULL,
  "role" TEXT NOT NULL,
  "content_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "message_turn_link" (
  "id" TEXT PRIMARY KEY,
  "turn_id" TEXT NOT NULL REFERENCES "turn" ("id") ON DELETE CASCADE,
  "message_id" TEXT NOT NULL REFERENCES "message" ("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "model_context_projection" (
  "id" TEXT PRIMARY KEY,
  "owner_kind" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "root_id" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "model_request" (
  "id" TEXT PRIMARY KEY,
  "turn_id" TEXT NOT NULL REFERENCES "turn" ("id") ON DELETE CASCADE,
  "request_seq" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "terminal_state" TEXT,
  "provider_id" TEXT NOT NULL,
  "model_id" TEXT NOT NULL,
  "context_window_tokens" INTEGER NOT NULL,
  "compression_threshold_tokens" INTEGER NOT NULL,
  "estimated_context_tokens" INTEGER NOT NULL,
  "authority_snapshot_id" TEXT NOT NULL,
  "settings_snapshot_object_id" TEXT REFERENCES "content_object" ("id") ON DELETE RESTRICT,
  "recipe_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE CASCADE,
  "usage_json" TEXT,
  "stream_stats_json" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "model_request_message_link" (
  "id" TEXT PRIMARY KEY,
  "model_request_id" TEXT NOT NULL REFERENCES "model_request" ("id") ON DELETE CASCADE,
  "message_id" TEXT NOT NULL REFERENCES "message" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "model_stream_checkpoint" (
  "id" TEXT PRIMARY KEY,
  "model_request_id" TEXT NOT NULL REFERENCES "model_request" ("id") ON DELETE CASCADE,
  "attempt_seq" INTEGER NOT NULL,
  "socket_generation" INTEGER NOT NULL,
  "stream_seq" INTEGER NOT NULL,
  "checkpoint_kind" TEXT NOT NULL,
  "content_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "model_stream_fence" (
  "id" TEXT PRIMARY KEY,
  "model_request_id" TEXT NOT NULL REFERENCES "model_request" ("id") ON DELETE CASCADE,
  "attempt_seq" INTEGER NOT NULL,
  "socket_generation" INTEGER NOT NULL,
  "terminal_stream_seq" INTEGER NOT NULL,
  "outcome" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "operation" (
  "id" TEXT PRIMARY KEY,
  "owner_kind" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "operation_seq" INTEGER NOT NULL,
  "tool_call_id" TEXT REFERENCES "tool_call" ("id") ON DELETE SET NULL,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "operation_resolution" (
  "id" TEXT PRIMARY KEY,
  "pause_id" TEXT NOT NULL REFERENCES "outcome_pause" ("id") ON DELETE CASCADE,
  "resolution_kind" TEXT NOT NULL,
  "content_object_id" TEXT REFERENCES "content_object" ("id") ON DELETE RESTRICT,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "outcome_pause" (
  "id" TEXT PRIMARY KEY,
  "operation_id" TEXT NOT NULL REFERENCES "operation" ("id") ON DELETE CASCADE,
  "status" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "pending_turn_input" (
  "id" TEXT PRIMARY KEY,
  "turn_id" TEXT NOT NULL REFERENCES "turn" ("id") ON DELETE CASCADE,
  "position" INTEGER NOT NULL,
  "input_kind" TEXT NOT NULL,
  "content_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE CASCADE,
  "state" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "process" (
  "id" TEXT PRIMARY KEY,
  "status" TEXT NOT NULL,
  "wrapper_nonce" TEXT NOT NULL,
  "wrapper_pid" INTEGER NOT NULL,
  "child_pid" INTEGER,
  "process_group_id" INTEGER,
  "start_fingerprint" TEXT NOT NULL,
  "command_digest" TEXT NOT NULL,
  "spool_locator" TEXT NOT NULL,
  "retained_bytes" INTEGER NOT NULL DEFAULT 0,
  "retained_chunks" INTEGER NOT NULL DEFAULT 0,
  "dropped_bytes" INTEGER NOT NULL DEFAULT 0,
  "truncated" INTEGER NOT NULL DEFAULT 0,
  "started_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "completed_at" TEXT
);
CREATE TABLE "process_completion_dispatch" (
  "id" TEXT PRIMARY KEY,
  "process_receipt_id" TEXT NOT NULL REFERENCES "process_receipt" ("id") ON DELETE CASCADE,
  "state" TEXT NOT NULL,
  "claim_owner_host_boot_id" TEXT,
  "claim_generation" INTEGER NOT NULL DEFAULT 0,
  "claim_expires_at" TEXT,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "failure_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TEXT,
  "last_error" TEXT,
  "completed_at" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "process_completion_source_link" (
  "id" TEXT PRIMARY KEY,
  "process_id" TEXT NOT NULL REFERENCES "process" ("id") ON DELETE CASCADE,
  "conversation_id" TEXT NOT NULL,
  "source_turn_id" TEXT NOT NULL,
  "source_tool_call_id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "process_origin_link" (
  "id" TEXT PRIMARY KEY,
  "process_id" TEXT NOT NULL REFERENCES "process" ("id") ON DELETE CASCADE,
  "tool_call_id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "process_output_chunk" (
  "id" TEXT PRIMARY KEY,
  "process_id" TEXT NOT NULL REFERENCES "process" ("id") ON DELETE CASCADE,
  "chunk_seq" INTEGER NOT NULL,
  "stream_kind" TEXT NOT NULL,
  "content_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE CASCADE,
  "byte_length" INTEGER NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "process_receipt" (
  "id" TEXT PRIMARY KEY,
  "process_id" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "exit_code" INTEGER,
  "exit_signal" TEXT,
  "wrapper_nonce" TEXT NOT NULL,
  "start_fingerprint" TEXT NOT NULL,
  "received_at" TEXT NOT NULL
);
CREATE TABLE "project_context" (
  "id" TEXT PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "uri" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE root_binding (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    data_root_path TEXT NOT NULL,
    database_path TEXT NOT NULL,
    cas_root_path TEXT NOT NULL,
    root_pointer_path TEXT NOT NULL,
    root_pending_path TEXT NOT NULL,
    runtime_epoch_path TEXT NOT NULL,
    data_set_id TEXT NOT NULL,
    root_instance_id TEXT NOT NULL,
    root_generation INTEGER NOT NULL CHECK (root_generation > 0),
    pointer_revision INTEGER NOT NULL CHECK (pointer_revision > 0),
    runtime_kernel_epoch INTEGER NOT NULL CHECK (runtime_kernel_epoch > 0)
  );
CREATE TABLE "runtime_delivery" (
  "id" TEXT PRIMARY KEY,
  "inbox_item_id" TEXT NOT NULL REFERENCES "runtime_inbox_item" ("id") ON DELETE CASCADE,
  "target_conversation_id" TEXT NOT NULL,
  "target_turn_id" TEXT,
  "phase" TEXT NOT NULL,
  "attempt_seq" INTEGER NOT NULL,
  "retry_of_delivery_id" TEXT REFERENCES "runtime_delivery" ("id") ON DELETE RESTRICT,
  "state" TEXT NOT NULL,
  "failure_reason" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "runtime_delivery_input_link" (
  "id" TEXT PRIMARY KEY,
  "delivery_id" TEXT NOT NULL REFERENCES "runtime_delivery" ("id") ON DELETE CASCADE,
  "pending_turn_input_id" TEXT NOT NULL,
  "handled_at" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "runtime_delivery_intent_link" (
  "id" TEXT PRIMARY KEY,
  "delivery_id" TEXT NOT NULL REFERENCES "runtime_delivery" ("id") ON DELETE CASCADE,
  "turn_intent_id" TEXT NOT NULL REFERENCES "turn_intent" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "runtime_delivery_wake" (
  "id" TEXT PRIMARY KEY,
  "delivery_id" TEXT NOT NULL REFERENCES "runtime_delivery" ("id") ON DELETE CASCADE,
  "state" TEXT NOT NULL,
  "claim_owner_host_boot_id" TEXT,
  "claim_generation" INTEGER NOT NULL DEFAULT 0,
  "claim_expires_at" TEXT,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "failure_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TEXT,
  "last_error" TEXT,
  "acknowledged_at" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "runtime_inbox_item" (
  "id" TEXT PRIMARY KEY,
  "dedupe_key" TEXT NOT NULL,
  "source_kind" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "runtime_inbox_payload_link" (
  "id" TEXT PRIMARY KEY,
  "inbox_item_id" TEXT NOT NULL REFERENCES "runtime_inbox_item" ("id") ON DELETE CASCADE,
  "content_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE RESTRICT,
  "created_at" TEXT NOT NULL
);
CREATE TABLE schema_manifest (
    domain_key TEXT PRIMARY KEY,
    table_name TEXT NOT NULL UNIQUE,
    schema_owner TEXT NOT NULL,
    repository_name TEXT NOT NULL UNIQUE,
    codec_name TEXT NOT NULL UNIQUE,
    mutations_json TEXT NOT NULL,
    client_mapping TEXT NOT NULL,
    delete_policy TEXT NOT NULL,
    reset_policy TEXT NOT NULL,
    indexes_json TEXT NOT NULL,
    schema_digest TEXT NOT NULL,
    runtime_kernel_epoch INTEGER NOT NULL
  );
CREATE TABLE "tool_call" (
  "id" TEXT PRIMARY KEY,
  "turn_id" TEXT NOT NULL REFERENCES "turn" ("id") ON DELETE CASCADE,
  "call_seq" INTEGER NOT NULL,
  "tool_name" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "arguments_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "tool_call_event" (
  "id" TEXT PRIMARY KEY,
  "tool_call_id" TEXT NOT NULL REFERENCES "tool_call" ("id") ON DELETE CASCADE,
  "event_seq" INTEGER NOT NULL,
  "event_kind" TEXT NOT NULL,
  "content_object_id" TEXT REFERENCES "content_object" ("id") ON DELETE RESTRICT,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "tool_call_policy_snapshot" (
  "id" TEXT PRIMARY KEY,
  "tool_call_id" TEXT NOT NULL REFERENCES "tool_call" ("id") ON DELETE CASCADE,
  "summary" TEXT,
  "display_auto_expand" INTEGER NOT NULL,
  "display_auto_open_diff" INTEGER NOT NULL,
  "execution_gate" TEXT NOT NULL,
  "change_apply_mode" TEXT NOT NULL,
  "change_apply_delay_seconds" INTEGER NOT NULL,
  "auto_submit_result" INTEGER NOT NULL,
  "scheduling_mode" TEXT NOT NULL,
  "scheduling_reason" TEXT,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "tool_call_source_link" (
  "id" TEXT PRIMARY KEY,
  "tool_call_id" TEXT NOT NULL REFERENCES "tool_call" ("id") ON DELETE CASCADE,
  "model_request_id" TEXT NOT NULL REFERENCES "model_request" ("id") ON DELETE CASCADE,
  "message_id" TEXT NOT NULL REFERENCES "message" ("id") ON DELETE CASCADE,
  "provider_call_id" TEXT,
  "provider_ordinal" INTEGER NOT NULL,
  "batch_id" TEXT NOT NULL,
  "batch_ordinal" INTEGER NOT NULL,
  "thought_signature" TEXT,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "tool_execution" (
  "id" TEXT PRIMARY KEY,
  "tool_call_id" TEXT NOT NULL REFERENCES "tool_call" ("id") ON DELETE CASCADE,
  "status" TEXT NOT NULL,
  "wait_deadline_at" TEXT,
  "started_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "completed_at" TEXT
);
CREATE TABLE "tool_model_result" (
  "id" TEXT PRIMARY KEY,
  "tool_call_id" TEXT NOT NULL REFERENCES "tool_call" ("id") ON DELETE CASCADE,
  "message_revision_id" TEXT NOT NULL REFERENCES "message_revision" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "tool_outcome" (
  "id" TEXT PRIMARY KEY,
  "tool_call_id" TEXT NOT NULL REFERENCES "tool_call" ("id") ON DELETE CASCADE,
  "status" TEXT NOT NULL,
  "content_object_id" TEXT REFERENCES "content_object" ("id") ON DELETE RESTRICT,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "tool_result_artifact" (
  "id" TEXT PRIMARY KEY,
  "tool_call_id" TEXT NOT NULL REFERENCES "tool_call" ("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL,
  "content_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "turn" (
  "id" TEXT PRIMARY KEY,
  "conversation_id" TEXT NOT NULL REFERENCES "conversation" ("id") ON DELETE CASCADE,
  "status" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "terminal_at" TEXT
);
CREATE TABLE "turn_execution_preset_revision" (
  "id" TEXT PRIMARY KEY,
  "intent_id" TEXT NOT NULL REFERENCES "turn_intent" ("id") ON DELETE CASCADE,
  "revision_seq" INTEGER NOT NULL,
  "preset_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "turn_executor_link" (
  "id" TEXT PRIMARY KEY,
  "turn_id" TEXT NOT NULL REFERENCES "turn" ("id") ON DELETE CASCADE,
  "agent_id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "turn_final_output_fence" (
  "id" TEXT PRIMARY KEY,
  "turn_id" TEXT NOT NULL REFERENCES "turn" ("id") ON DELETE CASCADE,
  "model_request_id" TEXT NOT NULL REFERENCES "model_request" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "turn_intent" (
  "id" TEXT PRIMARY KEY,
  "conversation_id" TEXT NOT NULL REFERENCES "conversation" ("id") ON DELETE CASCADE,
  "turn_id" TEXT REFERENCES "turn" ("id") ON DELETE SET NULL,
  "state" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE TABLE "turn_intent_authority_revision" (
  "id" TEXT PRIMARY KEY,
  "intent_id" TEXT NOT NULL REFERENCES "turn_intent" ("id") ON DELETE CASCADE,
  "revision_seq" INTEGER NOT NULL,
  "authority_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "turn_intent_executor_link" (
  "id" TEXT PRIMARY KEY,
  "intent_id" TEXT NOT NULL REFERENCES "turn_intent" ("id") ON DELETE CASCADE,
  "agent_id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "turn_intent_revision" (
  "id" TEXT PRIMARY KEY,
  "intent_id" TEXT NOT NULL REFERENCES "turn_intent" ("id") ON DELETE CASCADE,
  "revision_seq" INTEGER NOT NULL,
  "content_object_id" TEXT NOT NULL REFERENCES "content_object" ("id") ON DELETE CASCADE,
  "created_at" TEXT NOT NULL
);
CREATE TABLE "turn_termination" (
  "id" TEXT PRIMARY KEY,
  "turn_id" TEXT NOT NULL REFERENCES "turn" ("id") ON DELETE CASCADE,
  "terminal_status" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE TRIGGER delete_interaction_request_with_turn
BEFORE DELETE ON turn
BEGIN
  DELETE FROM interaction_request
   WHERE id IN (
     SELECT request_id
       FROM interaction_owner_link
      WHERE turn_id = OLD.id
   );
END;
CREATE TRIGGER prevent_runtime_delivery_after_final_output_fence
BEFORE INSERT ON pending_turn_input
WHEN NEW.input_kind = 'runtime_delivery'
 AND EXISTS (
   SELECT 1
     FROM turn_final_output_fence
    WHERE turn_id = NEW.turn_id
 )
BEGIN
  SELECT RAISE(ABORT, 'runtime delivery crossed final-output fence');
END;
