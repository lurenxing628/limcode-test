import { bridge, BridgeMessageType } from '@webview/transport';
import { computed, ref, watchEffect } from 'vue';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useAgentStore } from '@webview/stores/useAgentStore';
import { useModelProfileStore } from '@webview/stores/useModelProfileStore';
import {
  decideInterruptWatchdog,
  decideTurnInputWithdrawal,
  interruptTargetHasSettled,
  type ReliableInterruptPhase
} from '@shared/reliableControlLifecycle';
import { toStructuredClonePlainData } from '@shared/plainData';
import type { NativeSteeringReceipt } from '@shared/openAIResponsesNative';
import { mergeSteeringReceipts, steeringReceiptsByConversationState } from '@webview/composables/steeringReceipts';
import {
  applyForkRequestError,
  decideForkClick,
  forkRequestsToReplay,
  forkResultResolves,
  markForkRequestSent,
  pendingForkMessageIds,
  restoreForkRequests,
  type ForkRequestRecords,
  type ForkRequestState
} from '@webview/composables/forkRequestLifecycle';
import {
  createMessageId,
  type CompressionCommandTarget,
  type CompressionStartPayload,
  type ConversationCommandMetadata,
  type GuidanceControlResultPayload,
  type MessageContent,
  type MessageDeleteFromPayload,
  type MessageEditPayload,
  type MessageRetryFromPayload,
  type MessageRetryTarget,
  type TurnAuthoritySelection,
  type TurnInputResultPayload,
  type TurnSteerResultPayload
} from '@shared/protocol';

let reliableCommandSequence = 0;
const reliableCommandSessionId = globalThis.crypto.randomUUID();
const PERSISTED_CONTROL_KEY = 'reliableConversationControls';
const TURN_INPUT_RETRY_MS = 30_000;
const TURN_INPUT_MAX_AUTOMATIC_RETRIES_PER_GENERATION = 1;
const WITHDRAWN_TURN_INPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const WITHDRAWAL_RECEIPT_REPLAY_MS = 30_000;
const INTERRUPT_WATCHDOG_MS = 8_000;
const INTERRUPT_MAX_AUTOMATIC_RETRIES = 2;
const turnInputRetryTimers = new Map<string, number>();
const withdrawalReceiptReplayTimers = new Map<string, number>();
const interruptWatchdogTimers = new Map<string, number>();

type InterruptPhase = ReliableInterruptPhase;
interface InterruptState {
  conversationId: string;
  turnId: string;
  phase: InterruptPhase;
  command: ConversationCommandMetadata;
  cascadeChildAgents: boolean;
  startedAt: number;
  lastSentAt?: number;
  automaticRetryCount: number;
  requestId?: string;
  sentSessionId?: string;
}

type ConversationActionKind = 'edit' | 'retry' | 'delete' | 'compress';
type ConversationActionPhase = 'waiting_for_idle' | 'requesting_stop' | 'stopping' | 'submitting' | 'running';
type ConversationActionPayload =
  | { type: BridgeMessageType.MessageEdit; payload: MessageEditPayload }
  | { type: BridgeMessageType.MessageRetryFrom; payload: MessageRetryFromPayload }
  | { type: BridgeMessageType.MessageDeleteFrom; payload: MessageDeleteFromPayload }
  | { type: BridgeMessageType.CompressionStart; payload: CompressionStartPayload };

interface ConversationActionInterrupt {
  turnId: string;
  phase: InterruptPhase;
  command: ConversationCommandMetadata;
  startedAt: number;
  lastSentAt?: number;
  automaticRetryCount: number;
  requestId?: string;
  sentSessionId?: string;
}

interface ConversationActionState {
  actionId: string;
  conversationId: string;
  action: ConversationActionKind;
  targetId: string;
  label: string;
  phase: ConversationActionPhase;
  commandPayload: ConversationActionPayload;
  interrupt?: ConversationActionInterrupt;
  requestId?: string;
  sentSessionId?: string;
  submittedAtCommitSeq?: string;
  blockedAtCommitSeq?: string;
  operationTurnId?: string;
}

export interface PendingTurnInputSubmission {
  commandId: string;
  command: ConversationCommandMetadata;
  requestId: string;
  conversationId: string;
  requestType: BridgeMessageType.TurnStart | BridgeMessageType.TurnEnqueue;
  text: string;
  content?: MessageContent;
  authority: TurnAuthoritySelection;
  submittedAt: number;
  lastSentAt?: number;
  sentClientId?: string;
  sentSessionId?: string;
  automaticRetryCount?: number;
  result?: TurnInputResultPayload;
  withdrawnAt?: number;
  withdrawalReceiptReplayRequested?: boolean;
  withdrawalCancelRequested?: boolean;
  withdrawalCommand?: ConversationCommandMetadata;
}

export interface FailedTurnInputSubmission extends PendingTurnInputSubmission {
  failedAt: number;
  message: string;
}

interface PersistedConversationControls {
  interrupt?: InterruptState;
  conversationActions: Record<string, ConversationActionState>;
  forkRequests: ForkRequestRecords;
  pendingTurnInputs: Record<string, PendingTurnInputSubmission>;
  failedTurnInputs: Record<string, FailedTurnInputSubmission>;
}

interface TurnInputAcknowledgement {
  conversationId: string;
}

export interface PendingGuidanceControl {
  commandId: string;
  requestId: string;
  conversationId: string;
  action: GuidanceControlResultPayload['action'];
  intentIds: string[];
  submittedAt: number;
}

interface GuidanceControlFailure {
  conversationId: string;
  message: string;
  failedAt: number;
}

const restored = readPersistedControls();
const interruptState = ref<InterruptState | undefined>(restored.interrupt);
const conversationActionStates = ref<Record<string, ConversationActionState>>(restored.conversationActions);
const forkRequests = ref<ForkRequestRecords>(restored.forkRequests);
const actionNotices = ref<Record<string, string>>({});
const pendingTurnInputSubmissions = ref<Record<string, PendingTurnInputSubmission>>(restored.pendingTurnInputs);
const failedTurnInputSubmissions = ref<Record<string, FailedTurnInputSubmission>>(restored.failedTurnInputs);
const turnInputAcknowledgements = ref<Record<string, TurnInputAcknowledgement>>({});
const pendingGuidanceControls = ref<Record<string, PendingGuidanceControl>>({});
const guidanceControlFailures = ref<Record<string, GuidanceControlFailure>>({});

interface SteeringSubmissionState {
  commandId: string;
  conversationId: string;
  submittedAt: number;
}

interface SteeringSubmissionResult {
  conversationId: string;
  ok: boolean;
}

interface SteeringFailureNotice {
  commandId?: string;
  message: string;
  at: number;
}

/** 转向提交只以 TurnSteerResult 回执为准；本地仅跟踪「正在提交」以便禁用重复提交。 */
const steeringSubmissions = ref<Record<string, SteeringSubmissionState>>({});
const steeringSubmissionResults = ref<Record<string, SteeringSubmissionResult>>({});
const steeringReceiptsByConversation = steeringReceiptsByConversationState();
const steeringFailures = ref<Record<string, SteeringFailureNotice>>({});
const steeringStatusRequested = new Set<string>();

function isPlausibleSteeringReceipt(value: unknown): value is NativeSteeringReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<NativeSteeringReceipt>;
  return typeof record.submissionId === 'string' && !!record.submissionId
    && typeof record.turnId === 'string'
    && typeof record.state === 'string'
    && typeof record.updatedAt === 'number'
    && Number.isFinite(record.updatedAt);
}

bridge.on(BridgeMessageType.TurnInputResult, (message) => {
  const payload = message.payload;
  if (!payload) return;
  const pending = pendingTurnInputSubmissions.value[payload.commandId];
  if (
    !pending
    || pending.requestId !== message.correlationId
    || pending.conversationId !== payload.conversationId
    || pending.requestType !== payload.requestType
  ) return;
  clearTurnInputRetry(payload.commandId);
  clearWithdrawalReceiptReplay(payload.commandId);
  if (payload.status === 'rejected') {
    if (pending.withdrawnAt) {
      removePendingTurnInputSubmission(pending.commandId);
      setActionNotice(pending.conversationId, payload.message || '等待消息未提交，无需继续撤回。');
    } else {
      failTurnInputSubmission(pending, payload.message || '消息发送失败，请重试。');
    }
    return;
  }
  if (pending.withdrawnAt) {
    pendingTurnInputSubmissions.value = {
      ...pendingTurnInputSubmissions.value,
      [payload.commandId]: { ...pending, result: payload }
    };
    persistControls();
    return;
  }
  turnInputAcknowledgements.value = {
    ...turnInputAcknowledgements.value,
    [payload.commandId]: payload
  };
  pendingTurnInputSubmissions.value = {
    ...pendingTurnInputSubmissions.value,
    [payload.commandId]: { ...pending, result: payload }
  };
  persistControls();
  clearTurnInputFailure(payload.commandId);
});

bridge.on(BridgeMessageType.GuidanceControlResult, (message) => {
  const payload = message.payload;
  if (!payload) return;
  const pending = pendingGuidanceControls.value[payload.commandId];
  if (
    !pending
    || pending.requestId !== message.correlationId
    || pending.conversationId !== payload.conversationId
    || pending.action !== payload.action
  ) return;
  const next = { ...pendingGuidanceControls.value };
  delete next[payload.commandId];
  pendingGuidanceControls.value = next;
  if (payload.status === 'rejected') {
    guidanceControlFailures.value = {
      ...guidanceControlFailures.value,
      [payload.conversationId]: {
        conversationId: payload.conversationId,
        message: payload.message || '引导消息操作失败，请刷新后重试。',
        failedAt: Date.now()
      }
    };
    return;
  }
  if (guidanceControlFailures.value[payload.conversationId]) {
    const failures = { ...guidanceControlFailures.value };
    delete failures[payload.conversationId];
    guidanceControlFailures.value = failures;
  }
});

bridge.on(BridgeMessageType.TurnInterruptResult, (message) => {
  const payload = message.payload;
  if (!payload) return;

  const pending = interruptState.value;
  if (
    pending?.requestId
    && message.correlationId === pending.requestId
    && payload.turnId === pending.turnId
    && payload.conversationId === pending.conversationId
  ) {
    if (payload.status === 'already_terminal') {
      setInterruptState(undefined);
    } else {
      const next = { ...pending, phase: 'stopping' as const, requestId: undefined };
      setInterruptState(next);
      armStandaloneInterruptWatchdog(next);
    }
    clearActionNotice(payload.conversationId);
  }

  const action = conversationActionStates.value[payload.conversationId];
  if (
    !action?.interrupt?.requestId
    || action.interrupt.requestId !== message.correlationId
    || action.interrupt.turnId !== payload.turnId
  ) return;
  if (payload.status === 'already_terminal') {
    setConversationAction({
      ...action,
      phase: 'waiting_for_idle',
      interrupt: undefined,
      blockedAtCommitSeq: undefined
    });
    clearActionNotice(payload.conversationId);
    return;
  }
  const nextAction: ConversationActionState = {
    ...action,
    phase: 'stopping',
    interrupt: { ...action.interrupt, phase: 'stopping', requestId: undefined }
  };
  setConversationAction(nextAction);
  armActionInterruptWatchdog(nextAction);
  clearActionNotice(payload.conversationId);
});

bridge.on(BridgeMessageType.TurnSteerResult, (message) => {
  const payload = message.payload;
  if (!payload || typeof payload.conversationId !== 'string' || !payload.conversationId) return;
  const conversationId = payload.conversationId;
  if (payload.error) {
    steeringFailures.value = {
      ...steeringFailures.value,
      [conversationId]: {
        ...(payload.commandId ? { commandId: payload.commandId } : {}),
        message: payload.error,
        at: Date.now()
      }
    };
  }
  if (payload.commandId && steeringSubmissions.value[payload.commandId]) {
    const nextSubmissions = { ...steeringSubmissions.value };
    delete nextSubmissions[payload.commandId];
    steeringSubmissions.value = nextSubmissions;
    steeringSubmissionResults.value = {
      ...steeringSubmissionResults.value,
      [payload.commandId]: { conversationId, ok: !payload.error }
    };
  }
  const receipts = Array.isArray(payload.receipts)
    ? payload.receipts.filter(isPlausibleSteeringReceipt)
    : [];
  if (receipts.length === 0) return;
  mergeSteeringReceipts(conversationId, receipts);
});

bridge.on(BridgeMessageType.ConversationActionResult, (message) => {
  const payload = message.payload;
  if (!payload) return;
  const action = conversationActionStates.value[payload.conversationId];
  if (
    !action
    || action.actionId !== payload.commandId
    || action.action !== payload.action
    || action.targetId !== retryTargetId(payload.target)
  ) return;
  if (payload.status === 'busy') {
    setConversationAction({
      ...action,
      phase: 'waiting_for_idle',
      requestId: undefined,
      interrupt: undefined,
      blockedAtCommitSeq: action.submittedAtCommitSeq
    });
    setActionNotice(payload.conversationId, '已有回复正在排队；当前回复停止后将继续此操作。');
    return;
  }
  if (action.action === 'retry' && payload.turnId) {
    setConversationAction({
      ...action,
      phase: 'running',
      requestId: undefined,
      interrupt: undefined,
      operationTurnId: payload.turnId
    });
    clearActionNotice(payload.conversationId);
    return;
  }
  clearConversationAction(payload.conversationId);
  clearActionNotice(payload.conversationId);
});

bridge.on(BridgeMessageType.CompressionCommandResult, (message) => {
  const payload = message.payload;
  if (!payload) return;
  const action = conversationActionStates.value[payload.conversationId];
  if (
    !action
    || action.action !== 'compress'
    || action.actionId !== payload.commandId
    || !sameCompressionTarget(actionCompressionTarget(action), payload.target)
  ) return;
  if (payload.status === 'busy') {
    setConversationAction({
      ...action,
      phase: 'waiting_for_idle',
      requestId: undefined,
      interrupt: undefined,
      blockedAtCommitSeq: action.submittedAtCommitSeq
    });
    setActionNotice(payload.conversationId, '已有回复正在排队；当前回复停止后将继续总结。');
    return;
  }
  if (payload.status === 'in_progress') {
    setConversationAction({
      ...action,
      phase: 'submitting',
      requestId: undefined,
      operationTurnId: payload.turnId
    });
    return;
  }
  clearConversationAction(payload.conversationId);
  if (payload.status === 'rejected') {
    setActionNotice(payload.conversationId, compressionFailureLabel(payload.reasonCode));
  } else {
    clearActionNotice(payload.conversationId);
  }
});

bridge.on(BridgeMessageType.ConversationForkResult, (message) => {
  const payload = message.payload;
  if (!payload) return;
  if (!forkResultResolves(forkRequests.value[payload.commandId], payload)) return;
  // Navigation is a separate shell command. Sending it only after the exact durable fork result
  // makes accepted and replayed forks equally visible without guessing a target Conversation id.
  bridge.request(BridgeMessageType.ConversationOpen, { conversationId: payload.conversationId });
  clearForkRequest(payload.commandId);
});

bridge.on(BridgeMessageType.Error, (message) => {
  const requestType = message.payload?.requestType;
  if (requestType === BridgeMessageType.TurnStart || requestType === BridgeMessageType.TurnEnqueue) {
    const pending = Object.values(pendingTurnInputSubmissions.value).find((candidate) =>
      candidate.requestId === message.correlationId && candidate.requestType === requestType
    );
    if (pending?.withdrawnAt) {
      pendingTurnInputSubmissions.value = {
        ...pendingTurnInputSubmissions.value,
        [pending.commandId]: { ...pending, withdrawalReceiptReplayRequested: true }
      };
      persistControls();
      setActionNotice(
        pending.conversationId,
        message.payload?.message
          ? `${message.payload.message}（撤回状态会自动重查。）`
          : '撤回状态暂未确认，将自动重查。'
      );
      armWithdrawalReceiptReplay(pending.commandId);
      return;
    }
    if (pending) failTurnInputSubmission(
      pending,
      message.payload?.message || '消息提交失败，草稿已恢复。'
    );
    return;
  }
  if (requestType === BridgeMessageType.TurnInterrupt) {
    const pending = interruptState.value;
    if (pending?.requestId && pending.requestId === message.correlationId) {
      setInterruptState(undefined);
      setActionNotice(
        pending.conversationId,
        message.payload?.message || '停止请求失败，可再次点击停止重试。'
      );
    }
    const action = Object.values(conversationActionStates.value).find((candidate) =>
      candidate.interrupt?.requestId === message.correlationId
    );
    if (action) {
      clearConversationAction(action.conversationId);
      setActionNotice(
        action.conversationId,
        message.payload?.message
          ? `${message.payload.message}（请重新执行原操作。）`
          : '停止请求失败；请重新执行原操作。'
      );
    }
    return;
  }

  if (isConversationActionRequestType(requestType)) {
    const action = Object.values(conversationActionStates.value).find((candidate) =>
      candidate.requestId === message.correlationId
    );
    if (!action) return;
    clearConversationAction(action.conversationId);
    setActionNotice(action.conversationId, message.payload?.message || '操作失败，请刷新后重试。');
    return;
  }

  if (requestType === BridgeMessageType.ConversationFork) {
    // A permanent rejection drops the command. Any other failure may still have committed, so the
    // exact command is kept (and persisted) for an explicit replay click, never replayed by itself.
    const outcome = applyForkRequestError(forkRequests.value, {
      correlationId: message.correlationId,
      code: message.payload?.code,
      message: message.payload?.message
    }, Date.now());
    if (!outcome) return;
    replaceForkRequests(outcome.requests);
    setActionNotice(outcome.request.sourceConversationId, outcome.notice);
  }
});

function removePendingTurnInputSubmission(commandId: string): void {
  clearTurnInputRetry(commandId);
  clearWithdrawalReceiptReplay(commandId);
  if (!pendingTurnInputSubmissions.value[commandId]) return;
  const next = { ...pendingTurnInputSubmissions.value };
  delete next[commandId];
  pendingTurnInputSubmissions.value = next;
  const nextAcknowledgements = { ...turnInputAcknowledgements.value };
  delete nextAcknowledgements[commandId];
  turnInputAcknowledgements.value = nextAcknowledgements;
  persistControls();
}

function failTurnInputSubmission(pending: PendingTurnInputSubmission, message: string): void {
  clearTurnInputRetry(pending.commandId);
  clearWithdrawalReceiptReplay(pending.commandId);
  const nextPending = { ...pendingTurnInputSubmissions.value };
  delete nextPending[pending.commandId];
  pendingTurnInputSubmissions.value = nextPending;
  const nextAcknowledgements = { ...turnInputAcknowledgements.value };
  delete nextAcknowledgements[pending.commandId];
  turnInputAcknowledgements.value = nextAcknowledgements;
  failedTurnInputSubmissions.value = {
    ...failedTurnInputSubmissions.value,
    [pending.commandId]: {
      ...pending,
      failedAt: Date.now(),
      message
    }
  };
  persistControls();
  setActionNotice(pending.conversationId, message);
}

function clearTurnInputFailuresForConversation(conversationId: string): void {
  const next = Object.fromEntries(Object.entries(failedTurnInputSubmissions.value)
    .filter(([, failure]) => failure.conversationId !== conversationId));
  if (Object.keys(next).length !== Object.keys(failedTurnInputSubmissions.value).length) {
    failedTurnInputSubmissions.value = next;
    persistControls();
  }
}

function clearTurnInputFailure(commandId: string): void {
  if (!failedTurnInputSubmissions.value[commandId]) return;
  const next = { ...failedTurnInputSubmissions.value };
  delete next[commandId];
  failedTurnInputSubmissions.value = next;
  persistControls();
}

function confirmTurnInputFromDurableReceipt(pending: PendingTurnInputSubmission): void {
  turnInputAcknowledgements.value = {
    ...turnInputAcknowledgements.value,
    [pending.commandId]: { conversationId: pending.conversationId }
  };
  clearTurnInputFailure(pending.commandId);
}

function reconcileTurnInputSubmissions(records: Record<string, Record<string, Record<string, unknown>>>): void {
  let changed = false;
  const next = { ...pendingTurnInputSubmissions.value };
  for (const pending of Object.values(next)) {
    const observation = turnInputDurableObservation(records, pending);
    if (pending.withdrawnAt) {
      const updated = reconcileWithdrawnTurnInput(records, pending, observation.durableReceiptObserved);
      if (updated === null) {
        clearTurnInputRetry(pending.commandId);
        clearWithdrawalReceiptReplay(pending.commandId);
        delete next[pending.commandId];
        changed = true;
      } else if (updated !== pending) {
        next[pending.commandId] = updated;
        changed = true;
      }
      continue;
    }
    if (!observation.observed) continue;
    if (observation.durableReceiptObserved) confirmTurnInputFromDurableReceipt(pending);
    clearTurnInputRetry(pending.commandId);
    delete next[pending.commandId];
    changed = true;
  }
  if (changed) {
    pendingTurnInputSubmissions.value = next;
    // Durable Feed observation retires only the retransmission record. The direct ACK remains a
    // one-shot UI handoff until Composer clears its draft and explicitly dismisses it; deleting the
    // ACK here can race Vue's batched watcher and leave the input permanently disabled.
    persistControls();
  }
}

function reconcileWithdrawnTurnInput(
  records: Record<string, Record<string, Record<string, unknown>>>,
  pending: PendingTurnInputSubmission,
  durableReceiptObserved: boolean
): PendingTurnInputSubmission | null {
  const result = pending.result;
  const intentRow = result?.intentId ? records.TurnIntent?.[result.intentId] : undefined;
  const decision = decideTurnInputWithdrawal({
    durableReceiptObserved,
    receiptReplayRequested: pending.withdrawalReceiptReplayRequested === true,
    ...(result ? {
      result: {
        admitted: result.admitted,
        ...(result.intentId ? { intentId: result.intentId } : {}),
        ...(result.turnId ? { turnId: result.turnId } : {})
      }
    } : {}),
    ...(intentRow ? {
      intent: {
        state: String(intentRow.state ?? ''),
        ...(typeof intentRow.current_revision_seq === 'string'
          ? { currentRevisionSeq: intentRow.current_revision_seq }
          : {})
      }
    } : {}),
    cancelRequested: pending.withdrawalCancelRequested === true
  });

  if (decision.kind === 'replay_receipt') {
    const updated: PendingTurnInputSubmission = {
      ...pending,
      withdrawalReceiptReplayRequested: true
    };
    queueMicrotask(() => replayWithdrawnTurnInputReceipt(updated));
    return updated;
  }
  if (decision.kind === 'cancel_intent') {
    const command = pending.withdrawalCommand ?? nextReliableCommandMetadata();
    const updated: PendingTurnInputSubmission = {
      ...pending,
      withdrawalCommand: command,
      withdrawalCancelRequested: true
    };
    queueMicrotask(() => submitWithdrawnGuidanceCancel(
      updated,
      decision.intentId,
      decision.expectedRevisionSeq,
      command
    ));
    return updated;
  }
  if (decision.kind === 'already_started') {
    setActionNotice(
      pending.conversationId,
      '这条消息已开始执行，无法再从等待队列撤回；如需终止，请使用输入框旁的停止按钮。'
    );
    return null;
  }
  if (decision.kind === 'settled') {
    clearActionNotice(pending.conversationId);
    return null;
  }
  if (
    decision.kind === 'wait'
    && durableReceiptObserved
    && pending.withdrawalReceiptReplayRequested
    && !pending.result
  ) armWithdrawalReceiptReplay(pending.commandId);
  return pending;
}

function replayWithdrawnTurnInputReceipt(submission: PendingTurnInputSubmission): void {
  postTurnInputSubmission(
    submission,
    bridge.currentClientId(),
    undefined,
    { withdrawalReceiptReplay: true }
  );
  const current = pendingTurnInputSubmissions.value[submission.commandId];
  if (current?.withdrawnAt && current.withdrawalReceiptReplayRequested && !current.result) {
    armWithdrawalReceiptReplay(current.commandId);
  }
}

function submitWithdrawnGuidanceCancel(
  pending: PendingTurnInputSubmission,
  intentId: string,
  expectedRevisionSeq: string,
  command: ConversationCommandMetadata
): void {
  const requestId = command.commandId;
  beginGuidanceControl({
    commandId: command.commandId,
    requestId,
    conversationId: pending.conversationId,
    action: 'cancel',
    intentIds: [intentId],
    submittedAt: Date.now()
  });
  try {
    bridge.request(BridgeMessageType.GuidanceCancel, {
      conversationId: pending.conversationId,
      intentId,
      expectedRevisionSeq,
      command
    }, { requestId });
  } catch (error) {
    failGuidanceControl(command.commandId, pending.conversationId, error);
  }
}

function reconcileGuidanceControls(
  records: Record<string, Record<string, Record<string, unknown>>>
): void {
  const durableCommandIds = new Set(Object.values(records.ConversationCommandReceipt ?? {})
    .flatMap((receipt) => typeof receipt.command_id === 'string' ? [receipt.command_id] : []));
  const next = { ...pendingGuidanceControls.value };
  let changed = false;
  for (const control of Object.values(next)) {
    if (!durableCommandIds.has(control.commandId)) continue;
    delete next[control.commandId];
    changed = true;
  }
  if (changed) pendingGuidanceControls.value = next;
}

function turnInputDurableObservation(
  records: Record<string, Record<string, Record<string, unknown>>>,
  pending: PendingTurnInputSubmission
): { observed: boolean; durableReceiptObserved: boolean } {
  const result = pending.result;
  const durableReceiptObserved = Object.values(records.ConversationCommandReceipt ?? {}).some((receipt) =>
    receipt.command_id === pending.commandId
    && receipt.conversation_id === pending.conversationId
  );
  const resultProjectionObserved = Boolean(result && (result.admitted
    ? result.turnId && records.Turn?.[result.turnId]
    : result.intentId && records.TurnIntent?.[result.intentId]));
  return {
    observed: durableReceiptObserved || resultProjectionObserved,
    durableReceiptObserved
  };
}

function replayTurnInputSubmissions(clientId: string, sessionId?: string): void {
  for (const submission of Object.values(pendingTurnInputSubmissions.value)) {
    if (submission.result || submission.withdrawnAt) continue;
    if (
      submission.sentClientId === clientId
      && (sessionId === undefined || submission.sentSessionId === sessionId)
    ) continue;
    postTurnInputSubmission(submission, clientId, sessionId);
  }
}

function postTurnInputSubmission(
  submission: PendingTurnInputSubmission,
  clientId = bridge.currentClientId(),
  sessionId?: string,
  options: {
    automaticRetry?: boolean;
    resetRetryBudget?: boolean;
    withdrawalReceiptReplay?: boolean;
  } = {}
): void {
  const current = pendingTurnInputSubmissions.value[submission.commandId];
  if (
    !current
    || current.result
    || (current.withdrawnAt && !options.withdrawalReceiptReplay)
  ) return;
  const sameGeneration = current.sentClientId === clientId
    && current.sentSessionId === sessionId;
  const automaticRetryCount = options.automaticRetry
    ? (current.automaticRetryCount ?? 0) + 1
    : options.resetRetryBudget || !sameGeneration
      ? 0
      : current.automaticRetryCount ?? 0;
  const base: PendingTurnInputSubmission = { ...current };
  delete base.sentClientId;
  delete base.sentSessionId;
  const next: PendingTurnInputSubmission = {
    ...base,
    lastSentAt: Date.now(),
    ...(clientId ? { sentClientId: clientId } : {}),
    ...(sessionId ? { sentSessionId: sessionId } : {}),
    automaticRetryCount
  };
  pendingTurnInputSubmissions.value = {
    ...pendingTurnInputSubmissions.value,
    [next.commandId]: next
  };
  persistControls();
  if (!options.withdrawalReceiptReplay && automaticRetryCount < TURN_INPUT_MAX_AUTOMATIC_RETRIES_PER_GENERATION) {
    armTurnInputRetry(next.commandId);
  } else {
    clearTurnInputRetry(next.commandId);
  }
  try {
    bridge.request(next.requestType, {
      conversationId: next.conversationId,
      text: next.text,
      ...(next.content?.parts?.length ? { content: next.content } : {}),
      ...(next.authority.agentId?.trim() ? { agentId: next.authority.agentId.trim() } : {}),
      ...(next.authority.model ? { model: next.authority.model } : {}),
      command: { ...next.command }
    }, { requestId: next.requestId });
  } catch (error) {
    if (next.withdrawnAt) {
      pendingTurnInputSubmissions.value = {
        ...pendingTurnInputSubmissions.value,
        [next.commandId]: { ...next, withdrawalReceiptReplayRequested: true }
      };
      persistControls();
      setActionNotice(
        next.conversationId,
        error instanceof Error ? error.message : '撤回状态暂未确认，将自动重查。'
      );
      armWithdrawalReceiptReplay(next.commandId);
      return;
    }
    failTurnInputSubmission(
      next,
      error instanceof Error ? error.message : '消息提交失败，草稿已保留。'
    );
  }
}

function armTurnInputRetry(commandId: string): void {
  clearTurnInputRetry(commandId);
  turnInputRetryTimers.set(commandId, window.setTimeout(() => {
    turnInputRetryTimers.delete(commandId);
    const pending = pendingTurnInputSubmissions.value[commandId];
    if (pending && !pending.result && !pending.withdrawnAt) {
      postTurnInputSubmission(
        pending,
        pending.sentClientId,
        pending.sentSessionId,
        { automaticRetry: true }
      );
    }
  }, TURN_INPUT_RETRY_MS));
}

function clearTurnInputRetry(commandId: string): void {
  const timer = turnInputRetryTimers.get(commandId);
  if (timer !== undefined) window.clearTimeout(timer);
  turnInputRetryTimers.delete(commandId);
}

function armWithdrawalReceiptReplay(commandId: string): void {
  if (withdrawalReceiptReplayTimers.has(commandId)) return;
  withdrawalReceiptReplayTimers.set(commandId, window.setTimeout(() => {
    withdrawalReceiptReplayTimers.delete(commandId);
    const pending = pendingTurnInputSubmissions.value[commandId];
    if (!pending?.withdrawnAt || !pending.withdrawalReceiptReplayRequested || pending.result) return;
    replayWithdrawnTurnInputReceipt(pending);
  }, WITHDRAWAL_RECEIPT_REPLAY_MS));
}

function clearWithdrawalReceiptReplay(commandId: string): void {
  const timer = withdrawalReceiptReplayTimers.get(commandId);
  if (timer !== undefined) window.clearTimeout(timer);
  withdrawalReceiptReplayTimers.delete(commandId);
}

function setInterruptState(next: InterruptState | undefined): void {
  const previous = interruptState.value;
  if (
    previous
    && (!next || next.conversationId !== previous.conversationId || next.turnId !== previous.turnId)
  ) clearInterruptWatchdog('standalone', previous.conversationId, previous.turnId);
  interruptState.value = next;
  persistControls();
}

function setConversationAction(action: ConversationActionState): void {
  const previous = conversationActionStates.value[action.conversationId];
  if (
    previous?.interrupt
    && (
      !action.interrupt
      || action.interrupt.turnId !== previous.interrupt.turnId
      || action.interrupt.command.commandId !== previous.interrupt.command.commandId
    )
  ) clearInterruptWatchdog('action', action.conversationId, previous.interrupt.turnId);
  conversationActionStates.value = {
    ...conversationActionStates.value,
    [action.conversationId]: action
  };
  persistControls();
}

function clearConversationAction(conversationId: string): void {
  const current = conversationActionStates.value[conversationId];
  if (!current) return;
  if (current.interrupt) clearInterruptWatchdog('action', conversationId, current.interrupt.turnId);
  const next = { ...conversationActionStates.value };
  delete next[conversationId];
  conversationActionStates.value = next;
  persistControls();
}

function setForkRequest(request: ForkRequestState): void {
  replaceForkRequests({ ...forkRequests.value, [request.actionId]: request });
}

function replaceForkRequests(requests: ForkRequestRecords): void {
  forkRequests.value = requests;
  persistControls();
}

function clearForkRequest(actionId: string): void {
  if (!forkRequests.value[actionId]) return;
  const next = { ...forkRequests.value };
  delete next[actionId];
  forkRequests.value = next;
  persistControls();
}

function setActionNotice(conversationId: string, notice: string): void {
  actionNotices.value = { ...actionNotices.value, [conversationId]: notice };
}

function clearActionNotice(conversationId: string): void {
  if (!actionNotices.value[conversationId]) return;
  const next = { ...actionNotices.value };
  delete next[conversationId];
  actionNotices.value = next;
}

function interruptWatchdogKey(
  kind: 'standalone' | 'action',
  conversationId: string,
  turnId: string
): string {
  return `${kind}:${conversationId}:${turnId}`;
}

function hasInterruptWatchdog(
  kind: 'standalone' | 'action',
  conversationId: string,
  turnId: string
): boolean {
  return interruptWatchdogTimers.has(interruptWatchdogKey(kind, conversationId, turnId));
}

function clearInterruptWatchdog(
  kind: 'standalone' | 'action',
  conversationId: string,
  turnId: string
): void {
  const key = interruptWatchdogKey(kind, conversationId, turnId);
  const timer = interruptWatchdogTimers.get(key);
  if (timer !== undefined) window.clearTimeout(timer);
  interruptWatchdogTimers.delete(key);
}

function armStandaloneInterruptWatchdog(state: InterruptState): void {
  const key = interruptWatchdogKey('standalone', state.conversationId, state.turnId);
  clearInterruptWatchdog('standalone', state.conversationId, state.turnId);
  interruptWatchdogTimers.set(key, window.setTimeout(() => {
    interruptWatchdogTimers.delete(key);
    const current = interruptState.value;
    if (
      !current
      || current.conversationId !== state.conversationId
      || current.turnId !== state.turnId
      || current.command.commandId !== state.command.commandId
    ) return;
    requestInterruptResync(current.conversationId);
    const decision = decideInterruptWatchdog({
      settled: false,
      phase: current.phase,
      automaticRetryCount: current.automaticRetryCount,
      maxAutomaticRetries: INTERRUPT_MAX_AUTOMATIC_RETRIES
    });
    if (decision.kind === 'retry') {
      const requestId = createMessageId();
      const next: InterruptState = {
        ...current,
        phase: 'stopping',
        requestId,
        lastSentAt: Date.now(),
        automaticRetryCount: decision.nextAutomaticRetryCount
      };
      setInterruptState(next);
      armStandaloneInterruptWatchdog(next);
      try {
        bridge.request(BridgeMessageType.TurnInterrupt, {
          conversationId: current.conversationId,
          turnId: current.turnId,
          leaseEpoch: 0,
          command: current.command,
          ...(current.cascadeChildAgents ? { cascadeChildAgents: true } : {})
        }, { requestId });
      } catch (error) {
        setActionNotice(
          current.conversationId,
          error instanceof Error
            ? `${error.message}（停止命令已保存，将自动重试。）`
            : '停止请求暂时无法投递；命令已保存，将自动重试。'
        );
      }
      return;
    }
    if (decision.kind === 'failed') {
      setInterruptState(undefined);
      setActionNotice(
        current.conversationId,
        '停止请求已保存，但状态尚未收敛；已解除锁定，可再次停止或刷新对话。'
      );
    }
  }, INTERRUPT_WATCHDOG_MS));
}

function armActionInterruptWatchdog(action: ConversationActionState): void {
  const currentInterrupt = action.interrupt;
  if (!currentInterrupt) return;
  const key = interruptWatchdogKey('action', action.conversationId, currentInterrupt.turnId);
  clearInterruptWatchdog('action', action.conversationId, currentInterrupt.turnId);
  interruptWatchdogTimers.set(key, window.setTimeout(() => {
    interruptWatchdogTimers.delete(key);
    const currentAction = conversationActionStates.value[action.conversationId];
    const current = currentAction?.interrupt;
    if (
      !currentAction
      || !current
      || current.turnId !== currentInterrupt.turnId
      || current.command.commandId !== currentInterrupt.command.commandId
    ) return;
    requestInterruptResync(currentAction.conversationId);
    const decision = decideInterruptWatchdog({
      settled: false,
      phase: current.phase,
      automaticRetryCount: current.automaticRetryCount,
      maxAutomaticRetries: INTERRUPT_MAX_AUTOMATIC_RETRIES
    });
    if (decision.kind === 'retry') {
      const requestId = createMessageId();
      const nextAction: ConversationActionState = {
        ...currentAction,
        phase: 'stopping',
        interrupt: {
          ...current,
          phase: 'stopping',
          requestId,
          lastSentAt: Date.now(),
          automaticRetryCount: decision.nextAutomaticRetryCount
        }
      };
      setConversationAction(nextAction);
      armActionInterruptWatchdog(nextAction);
      try {
        bridge.request(BridgeMessageType.TurnInterrupt, {
          conversationId: currentAction.conversationId,
          turnId: current.turnId,
          leaseEpoch: 0,
          command: current.command
        }, { requestId });
      } catch (error) {
        setActionNotice(
          currentAction.conversationId,
          error instanceof Error
            ? `${error.message}（停止命令已保存，将自动重试。）`
            : '停止请求暂时无法投递；原操作仍会自动恢复。'
        );
      }
      return;
    }
    if (decision.kind === 'failed') {
      clearConversationAction(currentAction.conversationId);
      setActionNotice(
        currentAction.conversationId,
        '旧回复的停止状态尚未收敛；原操作已解除锁定，请重试或刷新对话。'
      );
    }
  }, INTERRUPT_WATCHDOG_MS));
}

function requestInterruptResync(conversationId: string): void {
  try {
    bridge.request(BridgeMessageType.ClientResync, { conversationId });
  } catch {
    // The fixed-id interrupt replay remains the recovery authority even if this best-effort resync
    // cannot be posted during a transport handoff.
  }
}

function beginGuidanceControl(control: PendingGuidanceControl): void {
  pendingGuidanceControls.value = {
    ...pendingGuidanceControls.value,
    [control.commandId]: control
  };
  if (guidanceControlFailures.value[control.conversationId]) {
    const failures = { ...guidanceControlFailures.value };
    delete failures[control.conversationId];
    guidanceControlFailures.value = failures;
  }
}

function failGuidanceControl(commandId: string, conversationId: string, error: unknown): void {
  const pending = { ...pendingGuidanceControls.value };
  delete pending[commandId];
  pendingGuidanceControls.value = pending;
  guidanceControlFailures.value = {
    ...guidanceControlFailures.value,
    [conversationId]: {
      conversationId,
      message: error instanceof Error ? error.message : '引导消息操作失败，请重试。',
      failedAt: Date.now()
    }
  };
}

function nextReliableCommandMetadata(): ConversationCommandMetadata {
  reliableCommandSequence += 1;
  const issuedAt = Date.now();
  return {
    commandId: `reliable-command-${reliableCommandSessionId}-${reliableCommandSequence.toString(36)}`,
    expectedVersion: 0,
    issuedAt
  };
}

/** Conversation commands are admitted only through the reliable Turn/Message control planes. */
export function useChat() {
  const reliableConversation = useReliableConversation();
  const clientState = useClientStateStore();
  const globalSettings = useGlobalSettingsStore();
  const agentStore = useAgentStore();
  const modelProfileStore = useModelProfileStore();
  const currentConversationAction = computed(() =>
    conversationActionStates.value[reliableConversation.conversationId.value]
  );
  const currentStandaloneInterrupt = computed(() => {
    const pending = interruptState.value;
    const conversationId = reliableConversation.conversationId.value;
    return pending?.conversationId === conversationId && activeTurnId(conversationId) === pending.turnId
      ? pending
      : undefined;
  });
  const currentActionInterrupt = computed(() => currentConversationAction.value?.interrupt);
  const currentInterruptPhase = computed<InterruptPhase | undefined>(() =>
    currentActionInterrupt.value?.phase ?? currentStandaloneInterrupt.value?.phase
  );
  const interruptPending = computed(() => currentInterruptPhase.value !== undefined);
  const conversationActionPending = computed(() => Boolean(currentConversationAction.value));
  const conversationActionLabel = computed(() => currentConversationAction.value?.label);
  const compressionPending = computed(() => currentConversationAction.value?.action === 'compress');
  const conversationActionNotice = computed(() => actionNotices.value[reliableConversation.conversationId.value]);
  const reliableRecords = computed(() =>
    reliableConversation.feed.records as unknown as Record<string, Record<string, Record<string, unknown>>>
  );
  const currentPendingTurnInputs = computed(() => Object.values(pendingTurnInputSubmissions.value)
    .filter((submission) =>
      submission.conversationId === reliableConversation.conversationId.value
      && !submission.withdrawnAt
      && !turnInputDurableObservation(reliableRecords.value, submission).observed
    )
    .sort((left, right) => left.submittedAt - right.submittedAt || left.commandId.localeCompare(right.commandId)));
  const currentTurnInputAcknowledgements = computed(() => {
    const conversationId = reliableConversation.conversationId.value;
    const acknowledgements: Record<string, TurnInputAcknowledgement> = Object.fromEntries(
      Object.entries(turnInputAcknowledgements.value).filter(([, result]) =>
        result.conversationId === conversationId
      )
    );
    // The direct control ACK may be lost during a Webview/Extension Host reconnect. Durable Feed
    // facts are equally authoritative and must release the composer without waiting for a later
    // side-effect watcher pass.
    for (const pending of Object.values(pendingTurnInputSubmissions.value)) {
      if (
        pending.conversationId === conversationId
        && !pending.withdrawnAt
        && turnInputDurableObservation(reliableRecords.value, pending).observed
      ) acknowledgements[pending.commandId] = { conversationId };
    }
    return acknowledgements;
  });
  const currentTurnInputFailure = computed(() => Object.values(failedTurnInputSubmissions.value)
    .filter((submission) => submission.conversationId === reliableConversation.conversationId.value)
    .sort((left, right) => right.failedAt - left.failedAt || right.commandId.localeCompare(left.commandId))[0]);
  const currentPendingGuidanceControls = computed(() => Object.values(pendingGuidanceControls.value)
    .filter((control) => control.conversationId === reliableConversation.conversationId.value));
  const currentGuidanceControlFailure = computed(() =>
    guidanceControlFailures.value[reliableConversation.conversationId.value]
  );
  /** 当前对话的转向回执，按最近更新排序；状态原样来自后端回执，不在本地推断。 */
  const currentSteeringReceipts = computed(() => {
    const receipts = steeringReceiptsByConversation.value[reliableConversation.conversationId.value] ?? {};
    return Object.values(receipts).sort((left, right) =>
      right.updatedAt - left.updatedAt || right.submissionId.localeCompare(left.submissionId)
    );
  });
  const currentSteeringFailure = computed(() => steeringFailures.value[reliableConversation.conversationId.value]);
  const currentSteeringSubmitting = computed(() => Object.values(steeringSubmissions.value)
    .some((submission) => submission.conversationId === reliableConversation.conversationId.value));
  const steeringSubmissionResultsById = computed(() => steeringSubmissionResults.value);
  const forkPendingTargetIds = computed(() =>
    pendingForkMessageIds(forkRequests.value, reliableConversation.conversationId.value));

  watchEffect(() => {
    const sessionId = reliableConversation.feed.sessionId;
    const clientId = bridge.currentClientId();
    if (sessionId) {
      const records = reliableConversation.feed.records as unknown as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      reconcileTurnInputSubmissions(records);
      reconcileGuidanceControls(records);
    }
    if (clientId) replayTurnInputSubmissions(clientId, sessionId ?? undefined);
    if (!sessionId) return;
    reconcileStandaloneInterrupt();
    reconcileConversationAction();
    replayForkRequestsForSession(sessionId);
  });

  function activeConversationId(): string {
    return reliableConversation.conversationId.value;
  }

  function activeTurnId(conversationId: string): string | undefined {
    const turn = Object.values(reliableConversation.feed.records.Turn ?? {}).find((candidate) =>
      candidate.conversation_id === conversationId && candidate.status === 'active'
    );
    return typeof turn?.id === 'string' ? turn.id : undefined;
  }

  function activeLeaseGeneration(turnId: string): number | undefined {
    const lease = Object.values(reliableConversation.feed.records.ExecutionLease ?? {}).find((candidate) =>
      candidate.turn_id === turnId
    );
    const raw = lease?.generation;
    const generation = typeof raw === 'string' && /^\d+$/.test(raw)
      ? Number(raw)
      : typeof raw === 'number' ? raw : Number.NaN;
    return Number.isSafeInteger(generation) && generation > 0 ? generation : undefined;
  }

  function sendMessage(
    text: string,
    content?: MessageContent,
    authority: TurnAuthoritySelection = {}
  ): PendingTurnInputSubmission | undefined {
    const conversationId = activeConversationId();
    const trimmed = text.trim();
    if ((!trimmed && !content?.parts?.length) || !conversationId) return undefined;
    clearTurnInputFailuresForConversation(conversationId);
    clearActionNotice(conversationId);
    const command = nextReliableCommandMetadata();
    const requestType = activeTurnId(conversationId)
      ? BridgeMessageType.TurnEnqueue
      : BridgeMessageType.TurnStart;
    const frozenContent = content
      ? toStructuredClonePlainData(content, 'turn input content') as unknown as MessageContent
      : undefined;
    const frozenAuthority = toStructuredClonePlainData(
      authority,
      'turn input authority'
    ) as unknown as TurnAuthoritySelection;
    const requestId = command.commandId;
    const submission: PendingTurnInputSubmission = {
      commandId: command.commandId,
      command,
      requestId,
      conversationId,
      requestType,
      text: trimmed,
      ...(frozenContent ? { content: frozenContent } : {}),
      authority: frozenAuthority,
      submittedAt: Date.now()
    };
    // Register the optimistic/restore authority before posting. A synchronous test bridge or a
    // future in-process transport must not be able to return the ACK before correlation exists.
    pendingTurnInputSubmissions.value = {
      ...pendingTurnInputSubmissions.value,
      [submission.commandId]: submission
    };
    persistControls();
    postTurnInputSubmission(
      submission,
      bridge.currentClientId(),
      reliableConversation.feed.sessionId ?? undefined
    );
    return submission;
  }

  function retryTurnInputSubmission(commandId: string): boolean {
    const pending = pendingTurnInputSubmissions.value[commandId];
    if (!pending || pending.result || pending.withdrawnAt) return false;
    postTurnInputSubmission(
      pending,
      bridge.currentClientId(),
      reliableConversation.feed.sessionId ?? undefined,
      { resetRetryBudget: true }
    );
    return true;
  }

  function withdrawTurnInputSubmission(commandId: string): boolean {
    const pending = pendingTurnInputSubmissions.value[commandId];
    if (!pending || pending.withdrawnAt) return false;
    const isQueuedInput = pending.requestType === BridgeMessageType.TurnEnqueue
      || pending.result?.admitted === false;
    if (!isQueuedInput || pending.result?.admitted === true) {
      setActionNotice(
        pending.conversationId,
        '这条消息已经开始执行，无法从等待队列撤回。'
      );
      return false;
    }
    clearTurnInputRetry(commandId);
    const nextAcknowledgements = { ...turnInputAcknowledgements.value };
    delete nextAcknowledgements[commandId];
    turnInputAcknowledgements.value = nextAcknowledgements;
    pendingTurnInputSubmissions.value = {
      ...pendingTurnInputSubmissions.value,
      [commandId]: {
        ...pending,
        withdrawnAt: Date.now(),
        withdrawalReceiptReplayRequested: false,
        withdrawalCancelRequested: false,
        withdrawalCommand: nextReliableCommandMetadata()
      }
    };
    clearActionNotice(pending.conversationId);
    persistControls();
    reconcileTurnInputSubmissions(reliableRecords.value);
    return true;
  }

  function editMessage(
    conversationId: string,
    messageId: string,
    text: string,
    options: {
      expectedRevisionId: string;
      content?: MessageContent;
      runAfterEdit?: boolean;
      deleteFollowing?: boolean;
    } & TurnAuthoritySelection
  ): boolean {
    const trimmed = text.trim();
    const content = options.content ? structuredClone(options.content) : undefined;
    const expectedRevisionId = options.expectedRevisionId.trim();
    if (!conversationId || !messageId || (!trimmed && !content?.parts.length) || !expectedRevisionId) return false;
    const command = nextReliableCommandMetadata();
    return requestConversationAction({
      actionId: command.commandId,
      conversationId,
      action: 'edit',
      targetId: messageId,
      label: '正在停止后编辑',
      phase: 'waiting_for_idle',
      commandPayload: {
        type: BridgeMessageType.MessageEdit,
        payload: {
          conversationId,
          messageId,
          expectedRevisionId,
          text: trimmed,
          ...(content?.parts.length ? { content } : {}),
          ...(options.runAfterEdit ? { runAfterEdit: true } : {}),
          ...(options.deleteFollowing ? { deleteFollowing: true } : {}),
          ...(options.agentId?.trim() ? { agentId: options.agentId.trim() } : {}),
          ...(options.model ? { model: { ...options.model } } : {}),
          command
        }
      }
    });
  }

  function retryMessageFrom(
    conversationId: string,
    target: MessageRetryTarget,
    authority: TurnAuthoritySelection = currentAuthoritySelection(),
    expectedRevisionId?: string,
    displayNumber?: number
  ): boolean {
    const targetId = retryTargetId(target);
    const revisionId = expectedRevisionId?.trim();
    if (!conversationId || !targetId || (target.kind === 'message' && !revisionId)) return false;
    const command = nextReliableCommandMetadata();
    const common = {
      conversationId,
      ...(authority.agentId?.trim() ? { agentId: authority.agentId.trim() } : {}),
      ...(authority.model ? { model: { ...authority.model } } : {}),
      command
    };
    const payload: MessageRetryFromPayload = target.kind === 'message'
      ? { ...common, target: { kind: 'message', messageId: targetId }, expectedRevisionId: revisionId! }
      : { ...common, target: { kind: 'model_request', modelRequestId: targetId } };
    return requestConversationAction({
      actionId: command.commandId,
      conversationId,
      action: 'retry',
      targetId,
      label: Number.isSafeInteger(displayNumber) && displayNumber! > 0
        ? `正在从第 ${displayNumber} 条消息重新生成回复`
        : '正在重新生成回复',
      phase: 'waiting_for_idle',
      commandPayload: { type: BridgeMessageType.MessageRetryFrom, payload }
    });
  }

  function currentAuthoritySelection(): TurnAuthoritySelection {
    const conversationId = clientState.currentConversationId;
    const agentId = agentStore.activeAgentForConversation(conversationId)?.id.trim() ?? '';
    const localProfile = conversationId
      ? modelProfileStore.localProfileFor('conversation', conversationId).profile
      : undefined;
    const profile = localProfile?.inheritModel ? undefined : localProfile;
    // Only a conversation-local selection is an explicit next-Turn override. Falling back to the
    // global dropdown here would hide Agent/Workflow profiles, especially after opening a child
    // conversation whose stable inherited selection has not reached this Webview snapshot yet.
    const providerConfigId = profile?.providerConfigId?.trim() ?? '';
    const config = globalSettings.llmProviderConfigs.configs.find((candidate) => candidate.id === providerConfigId);
    const profileModel = profile?.providerConfigId?.trim() === config?.id ? profile?.model.trim() ?? '' : '';
    const model = profileModel && config && modelExists(config, profileModel)
      ? profileModel
      : config?.model.trim() ?? '';
    return {
      ...(agentId ? { agentId } : {}),
      ...(config && model
        ? { model: { providerConfigId: config.id, provider: config.provider, model } }
        : {})
    };
  }

  function deleteMessagesFrom(conversationId: string, messageId: string): boolean {
    if (!conversationId || !messageId) return false;
    const command = nextReliableCommandMetadata();
    return requestConversationAction({
      actionId: command.commandId,
      conversationId,
      action: 'delete',
      targetId: messageId,
      label: '正在停止后删除',
      phase: 'waiting_for_idle',
      commandPayload: {
        type: BridgeMessageType.MessageDeleteFrom,
        payload: { conversationId, messageId, command }
      }
    });
  }

  function forkConversationFrom(
    sourceConversationId: string,
    messageId: string,
    expectedRevisionId: string
  ): boolean {
    const revisionId = expectedRevisionId.trim();
    if (!sourceConversationId || !messageId || !revisionId) return false;
    const decision = decideForkClick(
      forkRequests.value,
      { sourceConversationId, messageId, expectedRevisionId: revisionId },
      nextReliableCommandMetadata
    );
    if (decision.kind === 'blocked') {
      setActionNotice(sourceConversationId, decision.notice);
      return false;
    }
    replaceForkRequests(decision.requests);
    clearActionNotice(sourceConversationId);
    sendForkRequest(decision.request);
    return true;
  }

  function compressContext(
    conversationId: string,
    target: { kind: 'current_head' } | { kind: 'through_message'; messageId: string },
    options: { sourceReplay?: CompressionStartPayload['sourceReplay'] } = {}
  ): boolean {
    if (options.sourceReplay !== undefined
      && (options.sourceReplay !== 'immutable_provenance' || target.kind !== 'current_head')) return false;
    const frozenTarget = freezeCompressionTarget(conversationId, target);
    if (!conversationId || !frozenTarget) return false;
    const targetId = frozenTarget.kind === 'through_message' ? frozenTarget.messageId : frozenTarget.expectedRootId;
    const command = nextReliableCommandMetadata();
    return requestConversationAction({
      actionId: command.commandId,
      conversationId,
      action: 'compress',
      targetId,
      label: options.sourceReplay ? '正在从原始记录重建摘要' : '正在停止后总结',
      phase: 'waiting_for_idle',
      commandPayload: {
        type: BridgeMessageType.CompressionStart,
        payload: {
          conversationId, target: frozenTarget, command,
          ...(options.sourceReplay ? { sourceReplay: options.sourceReplay } : {})
        }
      }
    });
  }

  function freezeCompressionTarget(
    conversationId: string,
    target: { kind: 'current_head' } | { kind: 'through_message'; messageId: string }
  ): CompressionCommandTarget | undefined {
    if (target.kind === 'through_message') {
      const messageId = target.messageId.trim();
      const expectedRevisionId = reliableConversation.projection.value.messageRevisionIdByMessageId[messageId]?.trim();
      return messageId && expectedRevisionId
        ? { kind: 'through_message', messageId, expectedRevisionId }
        : undefined;
    }
    const status = Object.values(reliableConversation.feed.records.ConversationContextStatus ?? {})
      .find((candidate) => candidate.conversation_id === conversationId);
    const expectedRootId = typeof status?.root_id === 'string' ? status.root_id.trim() : '';
    return expectedRootId ? { kind: 'current_head', expectedRootId } : undefined;
  }

  function requestConversationAction(next: ConversationActionState): boolean {
    const existing = conversationActionStates.value[next.conversationId];
    if (existing) {
      if (!sameConversationActionSemantics(existing, next)) {
        setActionNotice(
          next.conversationId,
          `“${existing.label.replace(/^正在/, '')}”仍在处理中；原操作完成前不会丢弃或替换它。`
        );
        return false;
      }
      clearActionNotice(next.conversationId);
      reconcileConversationAction(true);
      return true;
    }
    setConversationAction(next);
    clearActionNotice(next.conversationId);
    reconcileConversationAction(true);
    return true;
  }

  function reconcileConversationAction(force = false): void {
    const conversationId = reliableConversation.conversationId.value;
    let action = conversationActionStates.value[conversationId];
    if (!action) return;

    if (action.phase === 'running') {
      if (
        action.operationTurnId
        && interruptTargetHasSettled(reliableConversation.feed.records, action.operationTurnId)
      ) {
        clearConversationAction(conversationId);
        clearActionNotice(conversationId);
      }
      return;
    }

    if (action.phase === 'submitting') {
      const sessionChanged = action.sentSessionId !== reliableConversation.feed.sessionId;
      const operationSettled = action.operationTurnId
        && interruptTargetHasSettled(reliableConversation.feed.records, action.operationTurnId);
      if (sessionChanged || operationSettled || force) {
        submitConversationAction(action);
      }
      return;
    }

    if (action.interrupt) {
      const currentTurnId = activeTurnId(conversationId);
      const settled = interruptTargetHasSettled(reliableConversation.feed.records, action.interrupt.turnId)
        // A successor can only acquire the Conversation's unique lease after the prior Turn is
        // terminal. This durable successor fact also prevents an old ACK from blocking the queued
        // Turn which the history action must stop next.
        || Boolean(currentTurnId && currentTurnId !== action.interrupt.turnId);
      if (!settled) {
        const sessionChanged = action.interrupt.sentSessionId !== reliableConversation.feed.sessionId;
        if (force || sessionChanged) {
          requestActionInterrupt(action, action.interrupt.turnId, action.interrupt.command);
        } else if (!hasInterruptWatchdog('action', conversationId, action.interrupt.turnId)) {
          armActionInterruptWatchdog(action);
        }
        return;
      }
      action = { ...action, phase: 'waiting_for_idle', interrupt: undefined };
      setConversationAction(action);
    }

    const activeTurn = activeTurnId(conversationId);
    if (activeTurn) {
      requestActionInterrupt(action, activeTurn);
      return;
    }
    const frontier = reliableConversation.feed.lastCommitSeq ?? undefined;
    if (!force && action.blockedAtCommitSeq && action.blockedAtCommitSeq === frontier) return;
    submitConversationAction(action);
  }

  function requestActionInterrupt(
    action: ConversationActionState,
    turnId: string,
    frozenCommand?: ConversationCommandMetadata
  ): void {
    const command = frozenCommand ?? nextReliableCommandMetadata();
    const previous = action.interrupt?.turnId === turnId
      && action.interrupt.command.commandId === command.commandId
      ? action.interrupt
      : undefined;
    const requestId = createMessageId();
    const nextAction: ConversationActionState = {
      ...action,
      phase: 'requesting_stop',
      blockedAtCommitSeq: undefined,
      interrupt: {
        turnId,
        phase: 'requesting',
        command,
        requestId,
        startedAt: previous?.startedAt ?? Date.now(),
        lastSentAt: Date.now(),
        automaticRetryCount: previous?.automaticRetryCount ?? 0,
        ...(reliableConversation.feed.sessionId ? { sentSessionId: reliableConversation.feed.sessionId } : {})
      }
    };
    // Persist the exact command and correlation before posting. This keeps a synchronous transport
    // failure or Webview reload from erasing the user's stop intent.
    setConversationAction(nextAction);
    armActionInterruptWatchdog(nextAction);
    try {
      bridge.request(BridgeMessageType.TurnInterrupt, {
        conversationId: action.conversationId,
        turnId,
        leaseEpoch: activeLeaseGeneration(turnId) ?? 0,
        command
      }, { requestId });
    } catch (error) {
      setActionNotice(
        action.conversationId,
        error instanceof Error
          ? `${error.message}（停止命令已保存，将自动重试。）`
          : '停止请求暂时无法投递；原操作仍会自动恢复。'
      );
    }
  }

  function submitConversationAction(action: ConversationActionState): void {
    const requestId = requestActionPayload(action.commandPayload);
    setConversationAction({
      ...action,
      phase: 'submitting',
      interrupt: undefined,
      requestId,
      ...(reliableConversation.feed.sessionId ? { sentSessionId: reliableConversation.feed.sessionId } : {}),
      operationTurnId: undefined,
      submittedAtCommitSeq: reliableConversation.feed.lastCommitSeq ?? undefined,
      blockedAtCommitSeq: undefined
    });
  }

  function requestActionPayload(command: ConversationActionPayload): string {
    switch (command.type) {
      case BridgeMessageType.MessageEdit:
        return bridge.request(command.type, command.payload);
      case BridgeMessageType.MessageRetryFrom:
        return bridge.request(command.type, command.payload);
      case BridgeMessageType.MessageDeleteFrom:
        return bridge.request(command.type, command.payload);
      case BridgeMessageType.CompressionStart:
        return bridge.request(command.type, toStructuredClonePlainData(
          command.payload, 'compression command'
        ) as unknown as CompressionStartPayload);
    }
  }

  function reconcileStandaloneInterrupt(): void {
    const pending = interruptState.value;
    if (!pending || pending.conversationId !== reliableConversation.conversationId.value) return;
    const currentTurnId = activeTurnId(pending.conversationId);
    if (
      interruptTargetHasSettled(reliableConversation.feed.records, pending.turnId)
      || Boolean(currentTurnId && currentTurnId !== pending.turnId)
    ) {
      setInterruptState(undefined);
      return;
    }
    if (pending.sentSessionId !== reliableConversation.feed.sessionId) {
      sendStandaloneInterrupt(pending);
    } else if (!hasInterruptWatchdog('standalone', pending.conversationId, pending.turnId)) {
      armStandaloneInterruptWatchdog(pending);
    }
  }

  function interruptCurrentConversation(cascadeChildAgents = false): boolean {
    const conversationId = activeConversationId();
    const turnId = activeTurnId(conversationId);
    if (!conversationId || !turnId) return false;

    const action = conversationActionStates.value[conversationId];
    if (action?.interrupt?.turnId === turnId) {
      if (action.interrupt.phase === 'stopping') return false;
      clearActionNotice(conversationId);
      requestActionInterrupt(action, turnId, action.interrupt.command);
      return true;
    }

    const pending = interruptState.value;
    if (pending?.conversationId === conversationId && pending.turnId === turnId) {
      if (pending.phase === 'stopping') return false;
      sendStandaloneInterrupt(pending);
      return true;
    }
    const next: InterruptState = {
      conversationId,
      turnId,
      phase: 'requesting',
      command: nextReliableCommandMetadata(),
      cascadeChildAgents,
      startedAt: Date.now(),
      automaticRetryCount: 0
    };
    sendStandaloneInterrupt(next);
    return true;
  }

  function sendStandaloneInterrupt(pending: InterruptState): void {
    const requestId = createMessageId();
    const next: InterruptState = {
      ...pending,
      phase: 'requesting',
      requestId,
      lastSentAt: Date.now(),
      ...(reliableConversation.feed.sessionId ? { sentSessionId: reliableConversation.feed.sessionId } : {})
    };
    // Persist before transport dispatch so a thrown postMessage cannot leave the composer locked
    // without a replayable stop command.
    setInterruptState(next);
    armStandaloneInterruptWatchdog(next);
    try {
      bridge.request(BridgeMessageType.TurnInterrupt, {
        conversationId: pending.conversationId,
        turnId: pending.turnId,
        leaseEpoch: activeLeaseGeneration(pending.turnId) ?? 0,
        command: pending.command,
        ...(pending.cascadeChildAgents ? { cascadeChildAgents: true } : {})
      }, { requestId });
    } catch (error) {
      setActionNotice(
        pending.conversationId,
        error instanceof Error
          ? `${error.message}（停止命令已保存，将自动重试。）`
          : '停止请求暂时无法投递；命令已保存，将自动重试。'
      );
    }
  }

  /**
   * 原生回合内转向：把一条用户消息立即提交给进行中的原生请求。
   * 可用性由调用方按进行中原生请求的冻结能力判断；这里只对当前活动 Turn 失败关闭。
   */
  function steerCurrentTurn(text: string, content?: MessageContent): { commandId: string } | undefined {
    const conversationId = activeConversationId();
    const turnId = activeTurnId(conversationId);
    const trimmed = text.trim();
    if (!conversationId || !turnId) return undefined;
    if (!trimmed && !content?.parts?.length) return undefined;
    const frozenContent = toStructuredClonePlainData(
      content?.parts?.length ? content : { role: 'user', parts: [{ text: trimmed }] },
      'steer content'
    ) as unknown as MessageContent;
    if (frozenContent.parts.length === 0) return undefined;
    const command = nextReliableCommandMetadata();
    const submission: SteeringSubmissionState = {
      commandId: command.commandId,
      conversationId,
      submittedAt: Date.now()
    };
    steeringSubmissions.value = { ...steeringSubmissions.value, [command.commandId]: submission };
    try {
      bridge.request(BridgeMessageType.TurnSteer, {
        action: 'submit',
        conversationId,
        turnId,
        leaseEpoch: activeLeaseGeneration(turnId) ?? 0,
        content: frozenContent,
        command
      }, { requestId: command.commandId });
    } catch (error) {
      const nextSubmissions = { ...steeringSubmissions.value };
      delete nextSubmissions[command.commandId];
      steeringSubmissions.value = nextSubmissions;
      steeringSubmissionResults.value = {
        ...steeringSubmissionResults.value,
        [command.commandId]: { conversationId, ok: false }
      };
      steeringFailures.value = {
        ...steeringFailures.value,
        [conversationId]: {
          commandId: command.commandId,
          message: error instanceof Error ? error.message : '转向请求暂时无法投递。',
          at: Date.now()
        }
      };
      return undefined;
    }
    return { commandId: command.commandId };
  }

  /** 重新读取当前对话已持久化的转向回执（每个 Webview 会话每个对话最多主动读一次）。 */
  function ensureSteeringReceipts(conversationId: string): void {
    const id = conversationId.trim();
    if (!id || steeringStatusRequested.has(id)) return;
    steeringStatusRequested.add(id);
    try {
      bridge.request(BridgeMessageType.TurnSteer, {
        action: 'status',
        conversationId: id,
        command: nextReliableCommandMetadata()
      });
    } catch {
      steeringStatusRequested.delete(id);
    }
  }

  function dismissSteeringFailure(): void {
    const conversationId = activeConversationId();
    if (!steeringFailures.value[conversationId]) return;
    const next = { ...steeringFailures.value };
    delete next[conversationId];
    steeringFailures.value = next;
  }

  function dismissSteeringSubmissionResult(commandId: string): void {
    if (!steeringSubmissionResults.value[commandId]) return;
    const next = { ...steeringSubmissionResults.value };
    delete next[commandId];
    steeringSubmissionResults.value = next;
  }

  function sendForkRequest(request: ForkRequestState): void {
    const requestId = bridge.request(BridgeMessageType.ConversationFork, request.payload);
    setForkRequest(markForkRequestSent(request, requestId, reliableConversation.feed.sessionId ?? undefined));
  }

  function replayForkRequestsForSession(sessionId: string): void {
    for (const request of forkRequestsToReplay(forkRequests.value, reliableConversation.conversationId.value, sessionId)) {
      sendForkRequest(request);
    }
  }

  function editGuidance(intentId: string, expectedRevisionSeq: string, text: string): boolean {
    const conversationId = activeConversationId();
    if (!conversationId || !intentId || !expectedRevisionSeq) return false;
    const command = nextReliableCommandMetadata();
    const requestId = command.commandId;
    beginGuidanceControl({
      commandId: command.commandId,
      requestId,
      conversationId,
      action: 'edit',
      intentIds: [intentId],
      submittedAt: Date.now()
    });
    try {
      bridge.request(BridgeMessageType.GuidanceEdit, {
        conversationId,
        intentId,
        expectedRevisionSeq,
        text,
        command
      }, { requestId });
      return true;
    } catch (error) {
      failGuidanceControl(command.commandId, conversationId, error);
      return false;
    }
  }

  function cancelGuidance(intentId: string, expectedRevisionSeq: string): boolean {
    const conversationId = activeConversationId();
    if (!conversationId || !intentId || !expectedRevisionSeq) return false;
    const command = nextReliableCommandMetadata();
    const requestId = command.commandId;
    beginGuidanceControl({
      commandId: command.commandId,
      requestId,
      conversationId,
      action: 'cancel',
      intentIds: [intentId],
      submittedAt: Date.now()
    });
    try {
      bridge.request(BridgeMessageType.GuidanceCancel, {
        conversationId,
        intentId,
        expectedRevisionSeq,
        command
      }, { requestId });
      return true;
    } catch (error) {
      failGuidanceControl(command.commandId, conversationId, error);
      return false;
    }
  }

  function setGuidancePaused(intentId: string, expectedRevisionSeq: string, paused: boolean): boolean {
    const conversationId = activeConversationId();
    if (!conversationId || !intentId || !expectedRevisionSeq) return false;
    const command = nextReliableCommandMetadata();
    const requestId = command.commandId;
    beginGuidanceControl({
      commandId: command.commandId,
      requestId,
      conversationId,
      action: 'hold',
      intentIds: [intentId],
      submittedAt: Date.now()
    });
    try {
      bridge.request(BridgeMessageType.GuidanceHold, {
        conversationId,
        intentId,
        expectedRevisionSeq,
        hold: paused ? 'paused' : 'none',
        command
      }, { requestId });
      return true;
    } catch (error) {
      failGuidanceControl(command.commandId, conversationId, error);
      return false;
    }
  }

  function reorderGuidance(items: Array<{ intentId: string; expectedRevisionSeq: string }>): boolean {
    const conversationId = activeConversationId();
    if (!conversationId || items.length === 0) return false;
    const command = nextReliableCommandMetadata();
    const requestId = command.commandId;
    beginGuidanceControl({
      commandId: command.commandId,
      requestId,
      conversationId,
      action: 'reorder',
      intentIds: items.map((item) => item.intentId),
      submittedAt: Date.now()
    });
    try {
      bridge.request(BridgeMessageType.GuidanceReorder, {
        conversationId,
        items,
        command
      }, { requestId });
      return true;
    } catch (error) {
      failGuidanceControl(command.commandId, conversationId, error);
      return false;
    }
  }

  function dismissGuidanceControlFailure(): void {
    const conversationId = activeConversationId();
    if (!guidanceControlFailures.value[conversationId]) return;
    const next = { ...guidanceControlFailures.value };
    delete next[conversationId];
    guidanceControlFailures.value = next;
  }

  function dismissTurnInputAcknowledgement(commandId: string): void {
    if (!turnInputAcknowledgements.value[commandId]) return;
    const next = { ...turnInputAcknowledgements.value };
    delete next[commandId];
    turnInputAcknowledgements.value = next;
  }

  function dismissTurnInputFailure(commandId: string): void {
    clearTurnInputFailure(commandId);
  }

  return {
    sendMessage,
    editMessage,
    retryMessageFrom,
    currentAuthoritySelection,
    deleteMessagesFrom,
    forkConversationFrom,
    compressContext,
    interruptCurrentConversation,
    interruptPending,
    interruptPhase: currentInterruptPhase,
    compressionPending,
    conversationAction: currentConversationAction,
    conversationActionPending,
    conversationActionLabel,
    conversationActionNotice,
    currentPendingTurnInputs,
    currentTurnInputAcknowledgements,
    currentTurnInputFailure,
    dismissTurnInputAcknowledgement,
    dismissTurnInputFailure,
    retryTurnInputSubmission,
    withdrawTurnInputSubmission,
    editGuidance,
    cancelGuidance,
    setGuidancePaused,
    reorderGuidance,
    currentPendingGuidanceControls,
    currentGuidanceControlFailure,
    dismissGuidanceControlFailure,
    forkPendingTargetIds,
    steerCurrentTurn,
    ensureSteeringReceipts,
    currentSteeringReceipts,
    currentSteeringFailure,
    dismissSteeringFailure,
    currentSteeringSubmitting,
    steeringSubmissionResultsById,
    dismissSteeringSubmissionResult
  };
}

function readPersistedControls(): PersistedConversationControls {
  const value = bridge.readPersistedState<PersistedConversationControls>(PERSISTED_CONTROL_KEY);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyPersistedControls();
  const interrupt = validInterruptState(value.interrupt);
  return {
    ...(interrupt ? { interrupt } : {}),
    conversationActions: validConversationActionRecords(value.conversationActions),
    forkRequests: restoreForkRequests(value.forkRequests),
    pendingTurnInputs: validTurnInputRecords(value.pendingTurnInputs),
    failedTurnInputs: validFailedTurnInputRecords(value.failedTurnInputs)
  };
}

function emptyPersistedControls(): PersistedConversationControls {
  return {
    conversationActions: {},
    forkRequests: {},
    pendingTurnInputs: {},
    failedTurnInputs: {}
  };
}

function plainRecord<T>(value: Record<string, T> | undefined): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function validInterruptState(value: InterruptState | undefined): InterruptState | undefined {
  if (
    !value
    || typeof value !== 'object'
    || typeof value.conversationId !== 'string'
    || typeof value.turnId !== 'string'
    || !validInterruptPhase(value.phase)
    || !validConversationCommand(value.command)
    || typeof value.cascadeChildAgents !== 'boolean'
    || !validTimestamp(value.startedAt)
    || !validAutomaticRetryCount(value.automaticRetryCount)
    || !validOptionalTimestamp(value.lastSentAt)
    || !validOptionalText(value.requestId)
    || !validOptionalText(value.sentSessionId)
  ) return undefined;
  return value;
}

function validConversationActionRecords(
  value: Record<string, ConversationActionState> | undefined
): Record<string, ConversationActionState> {
  return Object.fromEntries(Object.entries(plainRecord(value)).filter(([conversationId, action]) =>
    typeof action?.actionId === 'string'
    && typeof action?.conversationId === 'string'
    && action.conversationId === conversationId
    && (action.action === 'edit' || action.action === 'retry' || action.action === 'delete' || action.action === 'compress')
    && (
      action.phase === 'waiting_for_idle'
      || action.phase === 'requesting_stop'
      || action.phase === 'stopping'
      || action.phase === 'submitting'
      || action.phase === 'running'
    )
    && typeof action.targetId === 'string'
    && typeof action.label === 'string'
    && validConversationActionPayload(action.commandPayload)
    && (action.interrupt === undefined || validConversationActionInterrupt(action.interrupt))
    && validOptionalText(action.requestId)
    && validOptionalText(action.sentSessionId)
    && validOptionalText(action.submittedAtCommitSeq)
    && validOptionalText(action.blockedAtCommitSeq)
    && validOptionalText(action.operationTurnId)
  ));
}

function validConversationActionInterrupt(value: ConversationActionInterrupt): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.turnId === 'string'
    && validInterruptPhase(value.phase)
    && validConversationCommand(value.command)
    && validTimestamp(value.startedAt)
    && validAutomaticRetryCount(value.automaticRetryCount)
    && validOptionalTimestamp(value.lastSentAt)
    && validOptionalText(value.requestId)
    && validOptionalText(value.sentSessionId)
  );
}

function validConversationActionPayload(value: ConversationActionPayload | undefined): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && isConversationActionRequestType(value.type)
    && value.payload
    && typeof value.payload === 'object'
    && validConversationCommand(value.payload.command)
  );
}

function validConversationCommand(value: ConversationCommandMetadata | undefined): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.commandId === 'string'
    && value.commandId.length > 0
    && Number.isSafeInteger(value.expectedVersion)
    && value.expectedVersion >= 0
    && validTimestamp(value.issuedAt)
  );
}

function validInterruptPhase(value: string | undefined): value is InterruptPhase {
  return value === 'requesting' || value === 'stopping';
}

function validTimestamp(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validOptionalTimestamp(value: number | undefined): boolean {
  return value === undefined || validTimestamp(value);
}

function validAutomaticRetryCount(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0;
}

function validOptionalText(value: string | undefined): boolean {
  return value === undefined || typeof value === 'string';
}

function validTurnInputRecords(
  value: Record<string, PendingTurnInputSubmission> | undefined
): Record<string, PendingTurnInputSubmission> {
  const withdrawnCutoff = Date.now() - WITHDRAWN_TURN_INPUT_RETENTION_MS;
  return Object.fromEntries(Object.entries(plainRecord(value)).filter(([, submission]) =>
    typeof submission?.commandId === 'string'
    && typeof submission?.requestId === 'string'
    && typeof submission?.conversationId === 'string'
    && typeof submission?.text === 'string'
    && typeof submission?.submittedAt === 'number'
    && (submission?.requestType === BridgeMessageType.TurnStart || submission?.requestType === BridgeMessageType.TurnEnqueue)
    && typeof submission?.command?.commandId === 'string'
    && submission.command.commandId === submission.commandId
    && (
      submission.withdrawnAt === undefined
      || (typeof submission.withdrawnAt === 'number' && submission.withdrawnAt >= withdrawnCutoff)
    )
  ));
}

function validFailedTurnInputRecords(
  value: Record<string, FailedTurnInputSubmission> | undefined
): Record<string, FailedTurnInputSubmission> {
  return Object.fromEntries(Object.entries(validTurnInputRecords(value)).filter(([, submission]) =>
    typeof (submission as FailedTurnInputSubmission).failedAt === 'number'
    && typeof (submission as FailedTurnInputSubmission).message === 'string'
  )) as Record<string, FailedTurnInputSubmission>;
}

function persistControls(): void {
  bridge.writePersistedState(
    PERSISTED_CONTROL_KEY,
    toStructuredClonePlainData({
      ...(interruptState.value ? { interrupt: interruptState.value } : {}),
      conversationActions: conversationActionStates.value,
      forkRequests: forkRequests.value,
      pendingTurnInputs: pendingTurnInputSubmissions.value,
      failedTurnInputs: failedTurnInputSubmissions.value
    }, 'reliable conversation controls') as unknown as PersistedConversationControls
  );
}

function sameConversationActionSemantics(
  left: ConversationActionState,
  right: ConversationActionState
): boolean {
  return left.action === right.action
    && left.targetId === right.targetId
    && JSON.stringify(withoutCommand(left.commandPayload)) === JSON.stringify(withoutCommand(right.commandPayload));
}

function withoutCommand(command: ConversationActionPayload): unknown {
  const { command: _command, ...payload } = command.payload;
  return { type: command.type, payload };
}

function retryTargetId(target: MessageRetryTarget): string {
  return target.kind === 'message' ? target.messageId.trim() : target.modelRequestId.trim();
}

function actionCompressionTarget(action: ConversationActionState): CompressionCommandTarget | undefined {
  return action.commandPayload.type === BridgeMessageType.CompressionStart
    ? action.commandPayload.payload.target
    : undefined;
}

function sameCompressionTarget(
  left: CompressionCommandTarget | undefined,
  right: CompressionCommandTarget
): boolean {
  if (!left || left.kind !== right.kind) return false;
  return left.kind === 'current_head'
    ? left.expectedRootId === (right as Extract<CompressionCommandTarget, { kind: 'current_head' }>).expectedRootId
    : left.messageId === (right as Extract<CompressionCommandTarget, { kind: 'through_message' }>).messageId
      && left.expectedRevisionId === (right as Extract<CompressionCommandTarget, { kind: 'through_message' }>).expectedRevisionId;
}

function isConversationActionRequestType(value: string | undefined): boolean {
  return value === BridgeMessageType.MessageEdit
    || value === BridgeMessageType.MessageRetryFrom
    || value === BridgeMessageType.MessageDeleteFrom
    || value === BridgeMessageType.CompressionStart;
}

function compressionFailureLabel(reasonCode: string | undefined): string {
  return reasonCode ? `上下文总结未执行：${reasonCode}` : '上下文总结未执行。';
}

function modelExists(
  config: { model?: string; models: Array<{ id: string }> },
  modelId: string
): boolean {
  const id = modelId.trim();
  return !!id && (config.model?.trim() === id || config.models.some((model) => model.id === id));
}
