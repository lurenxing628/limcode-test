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
 *
 * The hint for other failures only says a click retries: clicking the message's fork button
 * replays the same command for an unchanged message (reusing a fork that did commit) and starts
 * a new one for edited content, so it never contradicts the reason the Host gave. A request the
 * user did not click in this Webview session (replayed after a reload) says so.
 */
export function applyForkRequestError(
  requests: Readonly<ForkRequestRecords>,
  error: { correlationId?: string; code?: string; message?: string },
  now: number,
  clickedThisSession: ReadonlySet<string>
): ForkErrorOutcome | undefined {
  if (!error.correlationId) return undefined;
  const request = Object.values(requests).find((candidate) => candidate.requestId === error.correlationId);
  if (!request) return undefined;
  const earlier = clickedThisSession.has(request.actionId) ? '' : '之前的分支请求';
  const next: ForkRequestRecords = { ...requests };
  if (error.code === 'fork_rejected') {
    delete next[request.actionId];
    return {
      kind: 'rejected',
      requests: next,
      request,
      notice: `${earlier}未创建分支${error.message ? `：${error.message}` : '。'}`
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
      ? `${earlier ? `${earlier}：` : ''}${error.message}（分支结果尚未确认，可再次点击分支按钮重试。）`
      : `${earlier ? `${earlier}的` : ''}分支结果尚未确认，可再次点击分支按钮重试。`
  };
}

/** A confirmed fork the user did not open right away, offered on its source conversation. */
export interface ForkReadyNotice {
  sourceConversationId: string;
  conversationId: string;
  /** The result belongs to a command replayed after the Webview reloaded, not to a click now. */
  replayed: boolean;
}

export type ForkResultNavigation = { kind: 'open' } | { kind: 'notice'; notice: ForkReadyNotice };

/**
 * A notice is offered only while this view holds the fork's ConversationBranchLink from its source.
 * The link is deleted with the fork, so a deleted fork is never offered, whether its deletion reaches
 * the view as a Conversation remove or as a fresh snapshot.
 */
export function forkReadyNoticeLinked(
  notice: ForkReadyNotice,
  branchLinks: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined
): boolean {
  return Object.values(branchLinks ?? {}).some((link) =>
    link.target_conversation_id === notice.conversationId
    && link.source_conversation_id === notice.sourceConversationId
  );
}

/**
 * Opening the fork answers a click: only a command clicked in this Webview session, while the user
 * still looks at its source, navigates. A result replayed after a reload (possibly days later) or
 * arriving after the user moved on leaves the view where it is and offers the fork on the source
 * conversation instead. The command is still replayed and resolved, so a committed fork is never
 * duplicated by a later click.
 */
export function forkResultNavigation(
  request: ForkRequestState,
  payload: ConversationForkResultPayload,
  view: { clickedThisSession: boolean; activeConversationId: string }
): ForkResultNavigation {
  if (view.clickedThisSession && view.activeConversationId === request.sourceConversationId) return { kind: 'open' };
  return {
    kind: 'notice',
    notice: {
      sourceConversationId: request.sourceConversationId,
      conversationId: payload.conversationId,
      replayed: !view.clickedThisSession
    }
  };
}

/**
 * Forks copy completed turns only: a message of the running turn, one still streaming, one without
 * a committed revision or one whose fork is already in flight cannot start another fork.
 */
export function messageForkBlocked(
  message: { id: string; status?: string },
  state: {
    activeTurnId: string;
    pendingMessageIds: ReadonlySet<string>;
    revisionIdByMessageId: Readonly<Record<string, string>>;
    turnIdByMessageId: Readonly<Record<string, string>>;
  }
): boolean {
  return state.pendingMessageIds.has(message.id)
    || !state.revisionIdByMessageId[message.id]
    || message.status === 'streaming'
    || (state.activeTurnId !== '' && state.turnIdByMessageId[message.id] === state.activeTurnId);
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
