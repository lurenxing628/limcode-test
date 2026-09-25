import type { MessageContent } from './protocol';

/** Provider-scoped configuration; an explicit enabled value also confirms a relay's support. */
export interface OpenAIResponsesNativeSettings {
  enabled?: boolean;
  asyncTools?: boolean;
  steering?: boolean;
  reasoningUpdates?: boolean;
  multiplexing?: boolean;
}

export type OpenAIResponsesNativeCapabilities = {
  asyncTools: boolean;
  steering: boolean;
  reasoningUpdates: boolean;
  multiplexing: boolean;
  explicitCaching: boolean;
};

export type OpenAIResponsesSteeringState = 'queued' | 'sent' | 'accepted' | 'waiting_for_input' | 'continuing' | 'completed' | 'failed' | 'delivery_unknown';

/**
 * The forward-only steering receipt lifecycle: every durable state change is one of these steps.
 * The Host enforces it on each write; clients read the same table (identical-state writes are
 * idempotent replays and are not listed).
 */
export const NATIVE_STEERING_TRANSITIONS: Readonly<Record<OpenAIResponsesSteeringState, readonly OpenAIResponsesSteeringState[]>> = Object.freeze({
  queued: ['sent', 'failed', 'delivery_unknown'],
  sent: ['accepted', 'waiting_for_input', 'failed', 'delivery_unknown'],
  accepted: ['waiting_for_input', 'continuing', 'completed', 'failed', 'delivery_unknown'],
  waiting_for_input: ['continuing', 'completed', 'failed', 'delivery_unknown'],
  continuing: ['completed', 'delivery_unknown'],
  completed: [],
  failed: [],
  delivery_unknown: []
});

/**
 * Whether a receipt in state `to` can follow one in state `from` after one or more committed steps.
 * A client may miss intermediate states between a live push and a status read, so it accepts any
 * later state of the same lifecycle, and never an earlier one.
 */
export function nativeSteeringStateFollows(from: OpenAIResponsesSteeringState, to: OpenAIResponsesSteeringState): boolean {
  const seen = new Set<OpenAIResponsesSteeringState>();
  const pending = [...(NATIVE_STEERING_TRANSITIONS[from] ?? [])];
  while (pending.length > 0) {
    const state = pending.pop()!;
    if (state === to) return true;
    if (seen.has(state)) continue;
    seen.add(state);
    pending.push(...(NATIVE_STEERING_TRANSITIONS[state] ?? []));
  }
  return false;
}

export type OpenAIResponsesRequiredInput = {
  type: 'function_call_output' | 'custom_tool_call_output' | 'mcp_approval_response';
  callId?: string;
  approvalRequestId?: string;
  name?: string;
};

/** A provider observation. It is not permission to execute a tool or a replacement for durable input. */
export interface OpenAIResponsesNativeEvent {
  type: 'response.created' | 'response.completed' | 'response.incomplete' | 'response.steer.submitted' | 'response.steer.accepted' | 'response.steer.pending' | 'response.steer.failed' | 'response.steer.disconnected';
  responseId: string;
  /** Physical WebSocket connection generation; absent on stateless HTTP/SSE, never fabricated. */
  connectionGeneration?: number;
  previousResponseId?: string;
  streamId?: string;
  /** Decimal per-connection response.create sequence (WS only); identifies the admission stream for native tool-call checkpoints. */
  responseCreateSeq?: string;
  submissionId?: string;
  steerId?: string;
  input?: MessageContent[];
  requiredInput?: OpenAIResponsesRequiredInput[];
  /**
   * response.created 上实际随本次 create 发送的工具结果 provider call_id 列表。
   * 内核据此在 checkpoint 的准入事件上先落结果 Context/投递事实，再处理新模型输出。
   */
  admittedToolResultCallIds?: string[];
  content?: MessageContent;
  reason?: string;
  error?: { code?: string; message: string };
  usage?: Record<string, unknown>;
  /**
   * Frozen native capabilities for this request, attached at the provider boundary to
   * response.created. Computed once from resolved/frozen runtime settings so later global
   * config changes cannot rewrite an in-flight request's native path.
   */
  capabilities?: OpenAIResponsesNativeCapabilities;
}

/**
 * Durable local fact about one steering submission. `responseId` is the latest observed response
 * for the submission; `targetResponseId`/`successorResponseId` keep the original target and the
 * accepted successor distinct so a transition never loses the steer target.
 */
export interface NativeSteeringReceipt {
  submissionId: string;
  conversationId: string;
  turnId: string;
  modelRequestId?: string;
  state: OpenAIResponsesSteeringState;
  /** Latest response observed for this submission (successor once accepted). */
  responseId?: string;
  /** Response the steer was originally submitted against. */
  targetResponseId?: string;
  /** Automatic successor response created by an accepted steer. */
  successorResponseId?: string;
  steerId?: string;
  /** Durable user Message id committed for this submission, once admitted. */
  messageId?: string;
  /** Human-readable status detail (for example a failure reason). */
  message?: string;
  updatedAt: number;
}

export interface OpenAIResponsesSteeringCommand {
  submissionId: string;
  input: MessageContent[];
  previousResponseId?: string;
}

export interface OpenAIResponsesToolOutput {
  type: 'function_call_output' | 'custom_tool_call_output' | 'mcp_approval_response';
  callId?: string;
  output?: string | Array<Record<string, unknown>>;
  approvalRequestId?: string;
  approve?: boolean;
}
