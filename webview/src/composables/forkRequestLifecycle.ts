import type {
  ConversationCommandMetadata,
  ConversationForkPayload,
  ConversationForkResultPayload
} from '@shared/protocol';

/**
 * One fork command the user started from a message. The exact command is kept until the Host
 * confirms its result, so a lost result is replayed instead of creating a second branch.
 */
export interface ForkRequestState {
  actionId: string;
  sourceConversationId: string;
  messageId: string;
  payload: ConversationForkPayload;
  /** Present while one bridge request for this command is in flight. */
  requestId?: string;
  /** Feed session that last carried the command; a new session re-sends unconfirmed commands. */
  sentSessionId?: string;
  /** The Host reported a non-permanent failure; only an explicit click replays the command. */
  failure?: { message: string; failedAt: number };
}

export type ForkRequestRecords = Record<string, ForkRequestState>;

export type ForkClickDecision =
  | { kind: 'send'; requests: ForkRequestRecords; request: ForkRequestState }
  | { kind: 'blocked'; notice: string };

/**
 * Clicking fork on a message re-sends that message's unresolved command for the same revision,
 * lets a different revision replace a failed command, and otherwise starts a new command.
 */
export function decideForkClick(
  requests: Readonly<ForkRequestRecords>,
  input: { sourceConversationId: string; messageId: string; expectedRevisionId: string },
  nextCommand: () => ConversationCommandMetadata
): ForkClickDecision {
  const existing = Object.values(requests).find((request) =>
    request.sourceConversationId === input.sourceConversationId && request.messageId === input.messageId
  );
  if (existing && existing.payload.expectedRevisionId === input.expectedRevisionId) {
    const { failure: _failure, ...request } = existing;
    return { kind: 'send', requests: { ...requests, [request.actionId]: request }, request };
  }
  if (existing && !existing.failure) return { kind: 'blocked', notice: '该消息的其他版本正在创建分支。' };
  const next: ForkRequestRecords = { ...requests };
  if (existing) delete next[existing.actionId];
  const command = nextCommand();
  const request: ForkRequestState = {
    actionId: command.commandId,
    sourceConversationId: input.sourceConversationId,
    messageId: input.messageId,
    payload: {
      sourceConversationId: input.sourceConversationId,
      messageId: input.messageId,
      expectedRevisionId: input.expectedRevisionId,
      command
    }
  };
  next[request.actionId] = request;
  return { kind: 'send', requests: next, request };
}

export function markForkRequestSent(
  request: ForkRequestState,
  requestId: string,
  sessionId: string | undefined
): ForkRequestState {
  const { failure: _failure, ...sent } = request;
  return { ...sent, requestId, ...(sessionId ? { sentSessionId: sessionId } : {}) };
}

/** Only the exact command, source message and revision can resolve a request. */
export function forkResultResolves(
  request: ForkRequestState | undefined,
  payload: ConversationForkResultPayload
): request is ForkRequestState {
  return !!request
    && request.actionId === payload.commandId
    && request.sourceConversationId === payload.sourceConversationId
    && request.messageId === payload.messageId
    && request.payload.expectedRevisionId === payload.expectedRevisionId;
}

export type ForkErrorOutcome =
  | { kind: 'rejected'; requests: ForkRequestRecords; request: ForkRequestState; notice: string }
  | { kind: 'failed'; requests: ForkRequestRecords; request: ForkRequestState; notice: string };

/**
 * A permanent rejection (`fork_rejected`) can never succeed and drops the command. Any other
 * failure may have committed before the error was reported: keep the exact command, mark it
 * failed and wait for the user to replay it explicitly.
 */
export function applyForkRequestError(
  requests: Readonly<ForkRequestRecords>,
  error: { correlationId?: string; code?: string; message?: string },
  now: number
): ForkErrorOutcome | undefined {
  if (!error.correlationId) return undefined;
  const request = Object.values(requests).find((candidate) => candidate.requestId === error.correlationId);
  if (!request) return undefined;
  const next: ForkRequestRecords = { ...requests };
  if (error.code === 'fork_rejected') {
    delete next[request.actionId];
    return {
      kind: 'rejected',
      requests: next,
      request,
      notice: error.message ? `${error.message}（未创建分支。）` : '分支请求被拒绝，未创建分支。'
    };
  }
  const { requestId: _requestId, ...rest } = request;
  const failed: ForkRequestState = {
    ...rest,
    failure: { message: error.message || '分支提交结果未确认。', failedAt: now }
  };
  next[failed.actionId] = failed;
  return {
    kind: 'failed',
    requests: next,
    request: failed,
    notice: error.message
      ? `${error.message}（再次点击将重放同一分支命令。）`
      : '分支提交结果未确认；再次点击将重放同一命令。'
  };
}

/** A new Feed session re-sends unconfirmed commands of the active Conversation, never failed ones. */
export function forkRequestsToReplay(
  requests: Readonly<ForkRequestRecords>,
  conversationId: string,
  sessionId: string
): ForkRequestState[] {
  return Object.values(requests).filter((request) =>
    request.sourceConversationId === conversationId
    && !request.failure
    && request.sentSessionId !== sessionId
  );
}

export function pendingForkMessageIds(requests: Readonly<ForkRequestRecords>, conversationId: string): Set<string> {
  return new Set(Object.values(requests)
    .filter((request) => request.sourceConversationId === conversationId && request.requestId)
    .map((request) => request.messageId));
}

/** Persisted Webview state is untrusted; keep only complete requests keyed by their command. */
export function restoreForkRequests(value: unknown): ForkRequestRecords {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const restored: ForkRequestRecords = {};
  for (const [actionId, candidate] of Object.entries(value as Record<string, unknown>)) {
    const request = validForkRequest(candidate);
    if (request && request.actionId === actionId) restored[actionId] = request;
  }
  return restored;
}

function validForkRequest(value: unknown): ForkRequestState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const request = value as Partial<ForkRequestState>;
  const payload = request.payload;
  const command = payload?.command;
  if (
    !text(request.actionId)
    || !text(request.sourceConversationId)
    || !text(request.messageId)
    || !payload
    || payload.sourceConversationId !== request.sourceConversationId
    || payload.messageId !== request.messageId
    || !text(payload.expectedRevisionId)
    || !command
    || command.commandId !== request.actionId
    || typeof command.expectedVersion !== 'number'
    || typeof command.issuedAt !== 'number'
  ) return undefined;
  const failure = request.failure;
  if (failure !== undefined && (typeof failure?.message !== 'string' || typeof failure.failedAt !== 'number')) {
    return undefined;
  }
  return {
    actionId: request.actionId,
    sourceConversationId: request.sourceConversationId,
    messageId: request.messageId,
    payload: {
      sourceConversationId: payload.sourceConversationId,
      messageId: payload.messageId,
      expectedRevisionId: payload.expectedRevisionId,
      command: { commandId: command.commandId, expectedVersion: command.expectedVersion, issuedAt: command.issuedAt }
    },
    ...(text(request.requestId) ? { requestId: request.requestId } : {}),
    ...(text(request.sentSessionId) ? { sentSessionId: request.sentSessionId } : {}),
    ...(failure ? { failure: { message: failure.message, failedAt: failure.failedAt } } : {})
  };
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
