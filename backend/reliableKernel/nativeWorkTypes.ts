import type { OpenAIResponsesSteeringState } from '../../shared/openAIResponsesNative';

/** States in which the logical native request is still outstanding for this submission. */
export const NATIVE_STEERING_IN_FLIGHT_STATES: readonly OpenAIResponsesSteeringState[] = Object.freeze([
  'queued',
  'sent',
  'accepted',
  'waiting_for_input',
  'continuing'
]);

/**
 * One durably admitted native ToolCall whose result facts are not fully closed yet.
 * Ordinary unmarked unresolved calls never appear here; they keep failing the regular guards.
 */
export interface NativePendingToolCall {
  toolCallId: string;
  toolName: string;
  turnId: string;
  turnActive: boolean;
  status: string;
  providerCallId: string | undefined;
  /** ToolCallSourceLink.message_id — the assistant Message carrying the call. */
  messageId: string;
  /** ToolCallSourceLink.model_request_id — the request that admitted the call. */
  modelRequestId: string;
  /** The unique ToolModelResult id once the call is settled. */
  toolModelResultId: string | undefined;
  callContextSegmentId: string | undefined;
  resultContextSegmentId: string | undefined;
  /** A unique ToolModelResult exists (the call reached its terminal settlement). */
  settled: boolean;
  /** A native_delivery ToolCallEvent records a server-admitted result delivery. */
  delivered: boolean;
}

export interface NativeSteeringInFlightEntry {
  pendingInputId: string;
  turnId: string;
  state: OpenAIResponsesSteeringState;
  updatedAt: string;
}

export interface NativePendingWorkInput {
  conversationId: string;
  turnId?: string;
  includeUndelivered?: boolean;
}
