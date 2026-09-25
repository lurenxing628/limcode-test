import { randomUUID } from 'node:crypto';
import { captureDebug, type DebugCaptureRecorder } from './debugCapture/observer';
import type * as vscode from 'vscode';
import {
  RELIABLE_KERNEL_ACK_MESSAGE,
  RELIABLE_KERNEL_CHANGES_MESSAGE,
  RELIABLE_KERNEL_CLIENT_DIAGNOSTIC_MESSAGE,
  RELIABLE_KERNEL_COLLABORATION_HISTORY_ERROR_MESSAGE,
  RELIABLE_KERNEL_COLLABORATION_HISTORY_REQUEST_MESSAGE,
  RELIABLE_KERNEL_COLLABORATION_HISTORY_RESULT_MESSAGE,
  RELIABLE_KERNEL_DETAIL_ERROR_MESSAGE,
  RELIABLE_KERNEL_DETAIL_REQUEST_MESSAGE,
  RELIABLE_KERNEL_DETAIL_RESULT_MESSAGE,
  RELIABLE_KERNEL_HISTORY_PAGE_ERROR_MESSAGE,
  RELIABLE_KERNEL_HISTORY_PAGE_REQUEST_MESSAGE,
  RELIABLE_KERNEL_HISTORY_PAGE_RESULT_MESSAGE,
  RELIABLE_KERNEL_SNAPSHOT_MESSAGE,
  RELIABLE_KERNEL_SNAPSHOT_REQUEST_MESSAGE,
  RELIABLE_KERNEL_TRANSIENT_ACK_MESSAGE,
  RELIABLE_KERNEL_TRANSIENT_BATCH_MESSAGE,
  RELIABLE_KERNEL_TRANSIENT_SNAPSHOT_MESSAGE,
  RELIABLE_KERNEL_TRANSIENT_SNAPSHOT_REQUEST_MESSAGE,
  type ReliableKernelAckMessage,
  type ReliableKernelClientDiagnosticMessage,
  type ReliableKernelCollaborationHistoryRequestMessage,
  type ReliableKernelDataMessage,
  type ReliableKernelDetailRequestMessage,
  type ReliableKernelHistoryPageRequestMessage,
  type ReliableKernelSnapshotRequestMessage,
  type ReliableKernelTransientAckMessage,
  type ReliableKernelTransientBatchItem,
  type ReliableKernelTransientBatchMessage,
  type ReliableKernelTransientSnapshotMessage,
  type ReliableKernelTransientSnapshotRequestMessage
} from '../../shared/reliableKernelClientFeed';
import { toStructuredClonePlainData } from '../../shared/plainData';
import { normalizePlainJson } from './plainJson';
import {
  BridgeMessageType,
  type BridgeClientId,
  type RuntimeBuildInfoRecord,
  type WebviewClientMeta
} from '../../shared/protocol';
import type { ReliableAgentTransientEvent } from './agentLoop';
import type {
  BoundedClientFeed,
  ClientDetailReader,
  ClientFeedConnection,
  ClientHistoryReader
} from './clientFeed';
import type { ReliableDiagnosticObserver } from './diagnosticJournal';
import {
  ReliableTransientReplayStore,
  type ReliableTransientReplaySnapshot
} from './transientReplay';

interface FeedDataPost {
  sessionId: string;
  messageSeq: string;
  postedAt: number;
  emptyChanges: boolean;
  ackTimer: NodeJS.Timeout;
  plain: unknown;
  resendCount: number;
  diagnostic: ReliableDataDiagnostic;
}

interface PendingTransientEvent {
  event: ReliableAgentTransientEvent;
  fromStreamSeq: string;
}

interface TransientDelivery {
  deliveryId: string;
  sessionId: string;
  navigationGeneration: number;
  postedAt: number;
  ackTimer: NodeJS.Timeout;
  kind: 'batch' | 'snapshot';
  resendCount: number;
}

interface PostedMessageDeliveryObserver {
  onUndelivered(): void;
  onRejected(error: unknown): void;
}

interface FeedClient {
  clientId: BridgeClientId;
  webview: vscode.Webview;
  meta: WebviewClientMeta;
  navigationGeneration: number;
  ready: boolean;
  visible: boolean;
  closed: boolean;
  connection?: Promise<ClientFeedConnection>;
  detailRequests: Set<string>;
  historyRequests: Set<string>;
  recoveryAttempt: number;
  recoveryTimer?: NodeJS.Timeout;
  recoveryWake?: (retry: boolean) => void;
  lastDataPost?: FeedDataPost;
  pendingTransientEvents: PendingTransientEvent[];
  transientToolCallKeys: Set<string>;
  transientRawEventCount: number;
  transientFlushTimer?: NodeJS.Timeout;
  transientFlushInFlight: boolean;
  transientDeliveries: Map<string, TransientDelivery>;
  transientDropDiagnosticKeys: Set<string>;
}

const FEED_ACK_TIMEOUT_MS = 30_000;
const FEED_MAX_FRAME_RESENDS = 1;
const FEED_RECOVERY_MAX_DELAY_MS = 30_000;
const TRANSIENT_BATCH_INTERVAL_MS = 32;
const TRANSIENT_BATCH_MAX_EVENTS = 128;
const TRANSIENT_ACK_TIMEOUT_MS = 2_000;
const TRANSIENT_MAX_SNAPSHOT_RESENDS = 1;
const TRANSIENT_MAX_DROP_DIAGNOSTIC_KEYS = 512;

function isToolCallDeltaTransient(event: ReliableAgentTransientEvent): boolean {
  const content = event.event.content;
  return event.event.kind === 'output_delta'
    && content !== null
    && typeof content === 'object'
    && !Array.isArray(content)
    && content.type === 'tool_call_delta';
}

function toolCallDeltaTransientKeys(event: ReliableAgentTransientEvent): string[] {
  if (!isToolCallDeltaTransient(event)) return [];
  const content = event.event.content as Record<string, unknown>;
  const outputItem = isRecord(content.outputItem) ? content.outputItem : undefined;
  const outputIdentity = typeof outputItem?.id === 'string'
    ? `${outputItem.id}:${String(outputItem.ordinal ?? '')}`
    : '';
  const calls = Array.isArray(content.calls) ? content.calls : [content];
  return calls.flatMap((value, index) => {
    if (!isRecord(value)) return [];
    const callIdentity = optionalIdentityText(value.id)
      ?? optionalIdentityText(value.callId)
      ?? optionalIdentityText(value.streamIndex)
      ?? String(index);
    return [`${transientRequestPrefix(event)}${outputIdentity}\0${callIdentity}`];
  });
}

function transientRequestPrefix(event: ReliableAgentTransientEvent): string {
  return `${event.modelRequestId}\0${event.attemptSeq}\0${event.socketGeneration}\0`;
}

function clearTransientToolCallKeys(client: FeedClient, event: ReliableAgentTransientEvent): void {
  const prefix = transientRequestPrefix(event);
  for (const key of client.transientToolCallKeys) {
    if (key.startsWith(prefix)) client.transientToolCallKeys.delete(key);
  }
}

function coalescePendingToolCallDelta(
  pending: PendingTransientEvent[],
  incoming: ReliableAgentTransientEvent
): boolean {
  if (!isToolCallDeltaTransient(incoming)) return false;
  const previous = pending[pending.length - 1];
  if (!previous || !isToolCallDeltaTransient(previous.event) || !sameTransientStream(previous.event, incoming)) return false;
  const previousSeq = String(previous.event.event.streamSeq);
  const incomingFrom = incoming.fromStreamSeq ?? String(incoming.event.streamSeq);
  if (!/^(?:0|[1-9]\d*)$/.test(previousSeq)
    || !/^(?:0|[1-9]\d*)$/.test(incomingFrom)
    || BigInt(incomingFrom) !== BigInt(previousSeq) + 1n) return false;
  const content = mergeToolCallDeltaContent(previous.event.event.content, incoming.event.content);
  if (!content) return false;
  pending[pending.length - 1] = {
    event: {
      ...incoming,
      event: { ...incoming.event, content: normalizePlainJson(content, 'coalesced tool call delta') }
    },
    fromStreamSeq: previous.fromStreamSeq
  };
  return true;
}

function sameTransientStream(left: ReliableAgentTransientEvent, right: ReliableAgentTransientEvent): boolean {
  return left.conversationId === right.conversationId
    && left.turnId === right.turnId
    && left.modelRequestId === right.modelRequestId
    && left.requestSeq === right.requestSeq
    && left.attemptSeq === right.attemptSeq
    && left.socketGeneration === right.socketGeneration;
}

function mergeToolCallDeltaContent(leftInput: unknown, rightInput: unknown): Record<string, unknown> | undefined {
  if (!isRecord(leftInput) || !isRecord(rightInput)) return undefined;
  if (leftInput.type !== 'tool_call_delta' || rightInput.type !== 'tool_call_delta') return undefined;
  if (JSON.stringify(leftInput.outputItem ?? null) !== JSON.stringify(rightInput.outputItem ?? null)) return undefined;
  if (Array.isArray(leftInput.calls) && Array.isArray(rightInput.calls)) {
    return {
      ...leftInput,
      ...rightInput,
      calls: mergeToolCallDeltaRecords(leftInput.calls, rightInput.calls)
    };
  }
  const merged = mergeOneToolCallDelta(leftInput, rightInput);
  return merged ? { ...leftInput, ...rightInput, ...merged } : undefined;
}

function mergeToolCallDeltaRecords(left: unknown[], right: unknown[]): Record<string, unknown>[] {
  const merged = left.filter(isRecord).map((value) => ({ ...value }));
  for (let index = 0; index < right.length; index += 1) {
    const incoming = right[index];
    if (!isRecord(incoming)) continue;
    const identity = toolCallDeltaRecordIdentity(incoming, index);
    const priorIndex = merged.findIndex((candidate, candidateIndex) =>
      toolCallDeltaRecordIdentity(candidate, candidateIndex) === identity
    );
    if (priorIndex < 0) {
      merged.push({ ...incoming });
      continue;
    }
    const next = mergeOneToolCallDelta(merged[priorIndex], incoming);
    if (next) merged[priorIndex] = { ...merged[priorIndex], ...incoming, ...next };
  }
  return merged;
}

function mergeOneToolCallDelta(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): { argumentsDelta: string; replace?: true } | undefined {
  if (typeof left.argumentsDelta !== 'string' || typeof right.argumentsDelta !== 'string') return undefined;
  if (right.replace === true) return { argumentsDelta: right.argumentsDelta, replace: true };
  return {
    argumentsDelta: left.argumentsDelta + right.argumentsDelta,
    ...(left.replace === true ? { replace: true } : {})
  };
}

function toolCallDeltaRecordIdentity(value: Record<string, unknown>, fallbackIndex: number): string {
  return optionalIdentityText(value.id)
    ?? optionalIdentityText(value.callId)
    ?? optionalIdentityText(value.streamIndex)
    ?? String(fallbackIndex);
}

function optionalIdentityText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export type ReliableKernelFeedBridgeErrorHandler = (
  error: unknown,
  context: { clientId: BridgeClientId; operation: 'connect' | 'post' | 'control' }
) => void;

/**
 * VS Code Webview 与 bounded Client Feed 之间的唯一数据通道。
 *
 * 每个 Webview 对应一个内存 Feed session；detach 后立即断开订阅。Bridge 接受有界 Feed
 * 控制、按需详情和绑定当前 Conversation 的历史分页请求，不转发或合成旧 ClientState patch。
 */
export interface ReliableKernelWebviewFeedBridgeOptions {
  ackTimeoutMs?: number;
  maxFrameResends?: number;
  transientAckTimeoutMs?: number;
  maxTransientSnapshotResends?: number;
}

export class ReliableKernelWebviewFeedBridge {
  private debugCapture?: DebugCaptureRecorder;
  public setDebugCapture(recorder: DebugCaptureRecorder): void { this.debugCapture = recorder; }
  private readonly clients = new Map<BridgeClientId, FeedClient>();
  private readonly ackTimeoutMs: number;
  private readonly maxFrameResends: number;
  private readonly transientAckTimeoutMs: number;
  private readonly maxTransientSnapshotResends: number;
  private readonly transientReplay = new ReliableTransientReplayStore();
  private closed = false;

  public constructor(
    private readonly feed: BoundedClientFeed,
    private readonly details: ClientDetailReader,
    private readonly onError: ReliableKernelFeedBridgeErrorHandler = defaultErrorHandler,
    private readonly diagnostics?: ReliableDiagnosticObserver,
    private readonly runtimeBuildInfo?: () => RuntimeBuildInfoRecord,
    private readonly history?: ClientHistoryReader,
    options: ReliableKernelWebviewFeedBridgeOptions = {}
  ) {
    this.ackTimeoutMs = positiveInteger(options.ackTimeoutMs, FEED_ACK_TIMEOUT_MS, 'ackTimeoutMs');
    this.maxFrameResends = nonNegativeInteger(
      options.maxFrameResends,
      FEED_MAX_FRAME_RESENDS,
      'maxFrameResends'
    );
    this.transientAckTimeoutMs = positiveInteger(
      options.transientAckTimeoutMs,
      TRANSIENT_ACK_TIMEOUT_MS,
      'transientAckTimeoutMs'
    );
    this.maxTransientSnapshotResends = nonNegativeInteger(
      options.maxTransientSnapshotResends,
      TRANSIENT_MAX_SNAPSHOT_RESENDS,
      'maxTransientSnapshotResends'
    );
  }

  public attach(
    webview: vscode.Webview,
    meta: WebviewClientMeta = { kind: 'unknown' }
  ): BridgeClientId {
    if (this.closed) throw new Error('ReliableKernelWebviewFeedBridge 已关闭。');
    const clientId = `feed-${randomUUID()}`;
    const client = {} as FeedClient;
    client.clientId = clientId;
    client.webview = webview;
    client.meta = plainMeta(meta);
    client.navigationGeneration = 1;
    client.ready = false;
    client.visible = true;
    client.closed = false;
    client.detailRequests = new Set<string>();
    client.historyRequests = new Set<string>();
    client.pendingTransientEvents = [];
    client.transientToolCallKeys = new Set<string>();
    client.transientRawEventCount = 0;
    client.transientFlushInFlight = false;
    client.transientDeliveries = new Map<string, TransientDelivery>();
    client.transientDropDiagnosticKeys = new Set<string>();
    client.recoveryAttempt = 0;
    this.clients.set(clientId, client);
    this.post(client, {
      id: randomUUID(),
      type: BridgeMessageType.Hello,
      clientId: client.clientId,
      payload: this.helloPayload(client.meta)
    });
    return clientId;
  }

  /** Starts or refreshes the bounded Feed only after the Webview script has declared itself ready. */
  public reconnect(clientId: BridgeClientId, activeConversationId?: string | null): void {
    const client = this.clients.get(clientId);
    if (!client || client.closed) return;
    client.ready = true;
    if (activeConversationId !== undefined) {
      client.meta = plainMeta({ ...client.meta, conversationId: activeConversationId ?? undefined });
    }
    if (!client.visible) return;
    this.reconnectClient(client, activeConversationId, true);
  }

  /**
   * A retained but hidden Webview may be browser-frozen and cannot ACK. Disconnecting it prevents
   * the 30-second watchdog from creating an unbounded snapshot/reconnect loop. Revealing the panel
   * establishes one fresh generation whose snapshot is the sole rendering authority.
   */
  public setVisible(clientId: BridgeClientId, visible: boolean): void {
    const client = this.clients.get(clientId);
    if (!client || client.closed || client.visible === visible) return;
    client.visible = visible;
    if (!visible) {
      this.pauseClient(client);
      return;
    }
    if (client.ready) this.reconnectClient(client, client.meta.conversationId ?? null, true);
  }

  private reconnectClient(
    client: FeedClient,
    activeConversationId: string | null | undefined,
    resetRecoveryBackoff: boolean
  ): void {
    if (client.closed || !client.ready || !client.visible) return;
    const previous = client.connection;
    this.cancelRecoveryTimer(client);
    if (resetRecoveryBackoff) client.recoveryAttempt = 0;
    if (activeConversationId !== undefined) {
      client.meta = plainMeta({ ...client.meta, conversationId: activeConversationId ?? undefined });
    }
    this.clearLastDataPost(client);
    this.clearTransientQueue(client);
    this.clearTransientDeliveries(client);
    client.detailRequests.clear();
    client.historyRequests.clear();
    client.navigationGeneration += 1;
    const navigationGeneration = client.navigationGeneration;
    const connection = this.connect(client, navigationGeneration);
    client.connection = connection;
    void connection.then((active) => {
      if (
        client.closed
        || !client.ready
        || !client.visible
        || client.connection !== connection
        || client.navigationGeneration !== navigationGeneration
      ) return;
      this.replayTransientConversation(client, active, 'connection');
    }, () => undefined);
    void previous?.then((active) => this.feed.disconnect(active.sessionId), () => undefined);
    this.post(client, {
      id: randomUUID(),
      type: BridgeMessageType.Hello,
      clientId: client.clientId,
      payload: this.helloPayload(client.meta)
    });
  }

  private pauseClient(client: FeedClient): void {
    const previous = client.connection;
    this.cancelRecoveryTimer(client);
    this.clearLastDataPost(client);
    this.clearTransientQueue(client);
    this.clearTransientDeliveries(client);
    client.detailRequests.clear();
    client.historyRequests.clear();
    client.navigationGeneration += 1;
    client.connection = undefined;
    void previous?.then((connection) => this.feed.disconnect(connection.sessionId), () => undefined);
  }

  private helloPayload(meta: WebviewClientMeta): { meta: WebviewClientMeta; runtime?: RuntimeBuildInfoRecord } {
    return {
      meta,
      ...(this.runtimeBuildInfo ? { runtime: this.runtimeBuildInfo() } : {})
    };
  }

  public detach(clientId: BridgeClientId): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    client.closed = true;
    this.cancelRecoveryTimer(client);
    this.clearLastDataPost(client);
    this.clearTransientQueue(client);
    this.clearTransientDeliveries(client);
    client.detailRequests.clear();
    client.historyRequests.clear();
    this.clients.delete(clientId);
    const connection = client.connection;
    if (connection) {
      void connection.then(
        (active) => this.feed.disconnect(active.sessionId),
        () => undefined
      );
    }
  }

  /** Returns true only when the message belongs to the reliable feed control protocol. */
  public async handleControl(clientId: BridgeClientId, message: unknown): Promise<boolean> {
    if (!isRecord(message)) return false;
    if (
      message.type !== RELIABLE_KERNEL_ACK_MESSAGE
      && message.type !== RELIABLE_KERNEL_TRANSIENT_ACK_MESSAGE
      && message.type !== RELIABLE_KERNEL_TRANSIENT_SNAPSHOT_REQUEST_MESSAGE
      && message.type !== RELIABLE_KERNEL_SNAPSHOT_REQUEST_MESSAGE
      && message.type !== RELIABLE_KERNEL_DETAIL_REQUEST_MESSAGE
      && message.type !== RELIABLE_KERNEL_HISTORY_PAGE_REQUEST_MESSAGE
      && message.type !== RELIABLE_KERNEL_COLLABORATION_HISTORY_REQUEST_MESSAGE
      && message.type !== RELIABLE_KERNEL_CLIENT_DIAGNOSTIC_MESSAGE
    ) {
      return false;
    }
    const client = this.clients.get(clientId);
    const connectionPromise = client?.connection;
    if (!client || client.closed || !client.ready || !client.visible || !connectionPromise) return true;
    try {
      const connection = await connectionPromise;
      if (
        client.closed
        || !client.ready
        || !client.visible
        || client.connection !== connectionPromise
      ) return true;
      if (message.type === RELIABLE_KERNEL_ACK_MESSAGE) {
        const ack = normalizeAck(message);
        if (ack.sessionId !== connection.sessionId || ack.hostBootId !== connection.hostBootId) return true;
        const posted = client.lastDataPost;
        this.feed.acknowledge(ack);
        this.observeAck(client, ack, posted);
        return true;
      }
      if (message.type === RELIABLE_KERNEL_TRANSIENT_ACK_MESSAGE) {
        const ack = normalizeTransientAck(message);
        if (
          ack.sessionId !== connection.sessionId
          || ack.hostBootId !== connection.hostBootId
          || (ack.navigationGeneration !== undefined
            && BigInt(ack.navigationGeneration) !== BigInt(client.navigationGeneration))
        ) return true;
        this.observeTransientAck(client, ack);
        return true;
      }
      if (message.type === RELIABLE_KERNEL_TRANSIENT_SNAPSHOT_REQUEST_MESSAGE) {
        const request = normalizeTransientSnapshotRequest(message);
        if (
          request.sessionId !== connection.sessionId
          || request.hostBootId !== connection.hostBootId
          || request.conversationId !== client.meta.conversationId
          || (request.navigationGeneration !== undefined
            && BigInt(request.navigationGeneration) !== BigInt(client.navigationGeneration))
        ) return true;
        const snapshot = this.transientReplay.snapshot(request);
        this.diagnostics?.observe({
          eventKind: snapshot ? 'feed.transient.snapshot_requested' : 'feed.transient.snapshot_unavailable',
          scopeKind: 'model_request',
          scopeId: request.modelRequestId,
          correlationId: request.requestId,
          metadata: {
            conversationId: request.conversationId,
            sessionId: request.sessionId,
            attemptSeq: request.attemptSeq,
            socketGeneration: request.socketGeneration,
            afterStreamSeq: request.afterStreamSeq
          }
        });
        if (snapshot) this.postTransientSnapshot(client, connection, snapshot, request.requestId, 0);
        return true;
      }
      if (message.type === RELIABLE_KERNEL_SNAPSHOT_REQUEST_MESSAGE) {
        const request = normalizeSnapshotRequest(message);
        if (request.sessionId && request.sessionId !== connection.sessionId) return true;
        // Renderer refresh requests cannot retarget a panel behind its retained owner reference.
        // Conversation navigation goes through the host's claim-before-open path instead.
        this.feed.requestSnapshot(
          connection.sessionId,
          client.meta.conversationId ?? null
        );
        return true;
      }
      if (message.type === RELIABLE_KERNEL_CLIENT_DIAGNOSTIC_MESSAGE) {
        const diagnostic = normalizeClientDiagnostic(message);
        if (diagnostic.sessionId !== connection.sessionId) return true;
        this.observeClientDiagnostic(diagnostic);
        return true;
      }
      if (message.type === RELIABLE_KERNEL_COLLABORATION_HISTORY_REQUEST_MESSAGE) {
        const request = normalizeCollaborationHistoryRequest(message);
        if (request.sessionId !== connection.sessionId) return true;
        await this.readCollaborationHistory(client, connection, request);
        return true;
      }
      if (message.type === RELIABLE_KERNEL_HISTORY_PAGE_REQUEST_MESSAGE) {
        const request = normalizeHistoryPageRequest(message);
        if (request.sessionId && request.sessionId !== connection.sessionId) return true;
        await this.readHistoryPage(client, connection, request);
        return true;
      }
      const request = normalizeDetailRequest(message);
      if (request.sessionId && request.sessionId !== connection.sessionId) return true;
      await this.readDetail(client, connection, request);
      return true;
    } catch (error) {
      this.onError(error, { clientId, operation: 'control' });
      return true;
    }
  }

  private async readHistoryPage(
    client: FeedClient,
    connection: ClientFeedConnection,
    request: ReliableKernelHistoryPageRequestMessage
  ): Promise<void> {
    if (client.historyRequests.has(request.requestId)) return;
    if (client.historyRequests.size >= 2) {
      this.post(client, {
        type: RELIABLE_KERNEL_HISTORY_PAGE_ERROR_MESSAGE,
        requestId: request.requestId,
        sessionId: connection.sessionId,
        conversationId: request.conversationId,
        message: '更早消息请求过多，请稍后重试。'
      });
      return;
    }
    if (client.meta.conversationId !== request.conversationId) {
      this.post(client, {
        type: RELIABLE_KERNEL_HISTORY_PAGE_ERROR_MESSAGE,
        requestId: request.requestId,
        sessionId: connection.sessionId,
        conversationId: request.conversationId,
        message: '历史分页请求不属于当前对话。'
      });
      return;
    }
    const navigationGeneration = client.navigationGeneration;
    client.historyRequests.add(request.requestId);
    try {
      if (!this.history) throw new Error('当前 Runtime 未配置历史消息读取器。');
      const page = await this.history.backwardVisibleMessages({
        conversationId: request.conversationId,
        beforeMessageSeq: request.beforeMessageSeq,
        beforeId: request.beforeId,
        limit: request.limit
      });
      if (client.closed || client.navigationGeneration !== navigationGeneration) return;
      this.post(client, {
        type: RELIABLE_KERNEL_HISTORY_PAGE_RESULT_MESSAGE,
        requestId: request.requestId,
        sessionId: connection.sessionId,
        conversationId: request.conversationId,
        page
      });
    } catch (error) {
      if (
        !client.closed
        && client.ready
        && client.visible
        && client.navigationGeneration === navigationGeneration
      ) {
        this.post(client, {
          type: RELIABLE_KERNEL_HISTORY_PAGE_ERROR_MESSAGE,
          requestId: request.requestId,
          sessionId: connection.sessionId,
          conversationId: request.conversationId,
          message: error instanceof Error ? error.message : '读取更早消息失败。'
        });
      }
    } finally {
      client.historyRequests.delete(request.requestId);
    }
  }

  private async readCollaborationHistory(
    client: FeedClient,
    connection: ClientFeedConnection,
    request: ReliableKernelCollaborationHistoryRequestMessage
  ): Promise<void> {
    if (client.historyRequests.has(request.requestId)) return;
    if (client.historyRequests.size >= 2 || client.meta.conversationId !== request.conversationId) {
      this.post(client, {
        type: RELIABLE_KERNEL_COLLABORATION_HISTORY_ERROR_MESSAGE,
        requestId: request.requestId,
        sessionId: connection.sessionId,
        conversationId: request.conversationId,
        message: '协作历史请求过多或不属于当前对话。'
      });
      return;
    }
    const navigationGeneration = client.navigationGeneration;
    const connectionPromise = client.connection;
    client.historyRequests.add(request.requestId);
    try {
      if (!this.history) throw new Error('当前 Runtime 未配置协作历史读取器。');
      const page = await this.history.backwardCollaboration({
        conversationId: request.conversationId,
        ...(request.beforeMessageSeq === undefined ? {} : {
          beforeMessageSeq: request.beforeMessageSeq,
          beforeId: request.beforeId
        }),
        limit: request.limit
      });
      if (client.closed || !client.ready || !client.visible || client.connection !== connectionPromise
        || client.navigationGeneration !== navigationGeneration
        || client.meta.conversationId !== request.conversationId) return;
      this.post(client, {
        type: RELIABLE_KERNEL_COLLABORATION_HISTORY_RESULT_MESSAGE,
        requestId: request.requestId,
        sessionId: connection.sessionId,
        conversationId: request.conversationId,
        page
      });
    } catch (error) {
      if (!client.closed && client.ready && client.visible && client.connection === connectionPromise
        && client.navigationGeneration === navigationGeneration
        && client.meta.conversationId === request.conversationId) {
        this.post(client, {
          type: RELIABLE_KERNEL_COLLABORATION_HISTORY_ERROR_MESSAGE,
          requestId: request.requestId,
          sessionId: connection.sessionId,
          conversationId: request.conversationId,
          message: error instanceof Error ? error.message : '读取协作历史失败。'
        });
      }
    } finally {
      client.historyRequests.delete(request.requestId);
    }
  }

  private async readDetail(
    client: FeedClient,
    connection: ClientFeedConnection,
    request: ReliableKernelDetailRequestMessage
  ): Promise<void> {
    if (client.detailRequests.has(request.requestId)) return;
    if (client.detailRequests.size >= 4) {
      this.post(client, {
        type: RELIABLE_KERNEL_DETAIL_ERROR_MESSAGE,
        requestId: request.requestId,
        sessionId: connection.sessionId,
        message: '按需详情请求过多，请稍后重试。'
      });
      return;
    }
    const navigationGeneration = client.navigationGeneration;
    client.detailRequests.add(request.requestId);
    try {
      const detail = await this.details.read({
        ...request,
        // Every Webview detail lookup is scoped to its current navigation generation. Passing
        // null (rather than omitting the field) makes a navigation-only panel fail closed.
        conversationId: client.meta.conversationId ?? null
      });
      if (
        client.closed
        || !client.ready
        || !client.visible
        || client.navigationGeneration !== navigationGeneration
      ) return;
      this.post(client, {
        type: RELIABLE_KERNEL_DETAIL_RESULT_MESSAGE,
        requestId: request.requestId,
        sessionId: connection.sessionId,
        detail
      });
    } catch (error) {
      if (
        !client.closed
        && client.ready
        && client.visible
        && client.navigationGeneration === navigationGeneration
      ) {
        this.post(client, {
          type: RELIABLE_KERNEL_DETAIL_ERROR_MESSAGE,
          requestId: request.requestId,
          sessionId: connection.sessionId,
          message: error instanceof Error ? error.message : '读取详情失败。'
        });
      }
    } finally {
      client.detailRequests.delete(request.requestId);
    }
  }

  /** Broadcasts a memory-only stream overlay only to panels scoped to the same Conversation. */
  public broadcastTransient(event: ReliableAgentTransientEvent): void {
    if (this.closed) return;
    this.transientReplay.observe(event);
    for (const client of this.clients.values()) {
      if (client.closed || client.meta.conversationId !== event.conversationId) continue;
      const dropReason = !client.ready
        ? 'not_ready'
        : !client.visible
          ? 'hidden'
          : !client.connection
            ? 'not_connected'
            : undefined;
      if (dropReason) {
        this.observeTransientDrop(client, event, dropReason);
        continue;
      }
      const toolDeltaKeys = toolCallDeltaTransientKeys(event);
      const firstToolDelta = toolDeltaKeys.some((key) => !client.transientToolCallKeys.has(key));
      for (const key of toolDeltaKeys) client.transientToolCallKeys.add(key);
      client.transientRawEventCount += 1;
      if (!coalescePendingToolCallDelta(client.pendingTransientEvents, event)) {
        client.pendingTransientEvents.push({
          event,
          fromStreamSeq: event.fromStreamSeq ?? String(event.event.streamSeq)
        });
      }
      const terminal = ['completed', 'failed', 'cancelled'].includes(event.event.kind);
      const itemBoundary = event.event.kind === 'output_item_done';
      // The first delta makes a new call visible immediately. Later fragments of the same call use
      // the short presentation window so a large edit cannot monopolize postMessage/renderer work.
      // Item/terminal boundaries always flush the exact accumulated prefix first.
      if (
        firstToolDelta
        || itemBoundary
        || terminal
        || client.pendingTransientEvents.length >= TRANSIENT_BATCH_MAX_EVENTS
      ) {
        this.flushTransientQueue(client);
        if (terminal) clearTransientToolCallKeys(client, event);
        continue;
      }
      if (client.transientFlushTimer !== undefined) continue;
      client.transientFlushTimer = setTimeout(() => {
        client.transientFlushTimer = undefined;
        this.flushTransientQueue(client);
      }, TRANSIENT_BATCH_INTERVAL_MS);
      client.transientFlushTimer.unref();
    }
  }

  /**
   * Posts a configuration-channel message only to panels currently bound to the given Conversation.
   * The attach/navigation metadata is the single Conversation-binding authority; global broadcasts
   * keep flowing through the facade and never enter this path.
   */
  public postToConversation(conversationId: string, message: Record<string, unknown>): void {
    if (this.closed) return;
    for (const client of this.clients.values()) {
      if (client.closed || client.meta.conversationId !== conversationId) continue;
      this.post(client, message);
    }
  }

  private flushTransientQueue(client: FeedClient): void {
    if (client.transientFlushTimer !== undefined) {
      clearTimeout(client.transientFlushTimer);
      client.transientFlushTimer = undefined;
    }
    if (
      client.closed
      || client.transientFlushInFlight
      || client.pendingTransientEvents.length === 0
    ) return;
    const conversationId = client.meta.conversationId;
    const connectionPromise = client.connection;
    if (!conversationId || !connectionPromise || !client.ready || !client.visible) return;
    client.transientFlushInFlight = true;
    void connectionPromise.then((connection) => {
      if (
        client.closed
        || !client.ready
        || !client.visible
        || client.connection !== connectionPromise
        || client.meta.conversationId !== conversationId
      ) {
        const first = client.pendingTransientEvents[0]?.event;
        if (first) this.observeTransientDrop(client, first, 'generation_changed');
        this.clearTransientQueue(client);
        return;
      }
      const pending = client.pendingTransientEvents.splice(0, TRANSIENT_BATCH_MAX_EVENTS);
      const rawEventCount = client.transientRawEventCount;
      client.transientRawEventCount = 0;
      if (pending.some(({ event }) => event.conversationId !== conversationId)) {
        this.clearTransientQueue(client);
        return;
      }
      const payloads: ReliableKernelTransientBatchItem[] = pending.map(({ event, fromStreamSeq }) => ({
        turnId: event.turnId,
        modelRequestId: event.modelRequestId,
        requestSeq: event.requestSeq,
        providerId: event.providerId,
        modelId: event.modelId,
        attemptSeq: event.attemptSeq,
        socketGeneration: event.socketGeneration,
        afterCommitSeq: event.afterCommitSeq,
        fromStreamSeq,
        observedAt: event.observedAt,
        event: {
          ...event.event,
          streamSeq: String(event.event.streamSeq)
        }
      }));
      this.diagnostics?.observe({
        eventKind: 'feed.transient.flushed',
        scopeKind: 'feed_session',
        scopeId: connection.sessionId,
        metadata: {
          conversationId,
          rawEventCount,
          emittedEventCount: payloads.length,
          toolDeltaEventCount: pending.filter(({ event }) => isToolCallDeltaTransient(event)).length,
          firstStreamSeq: payloads[0]?.fromStreamSeq ?? '0',
          lastStreamSeq: payloads[payloads.length - 1]?.event.streamSeq ?? '0'
        }
      });
      this.postTransientBatch(client, connection, conversationId, payloads);
    }, (error) => {
      if (
        error instanceof FeedConnectionSupersededError
        || client.closed
        || client.connection !== connectionPromise
      ) return;
      this.onError(error, { clientId: client.clientId, operation: 'post' });
    }).finally(() => {
      client.transientFlushInFlight = false;
      if (
        !client.closed
        && client.ready
        && client.visible
        && client.connection
        && client.pendingTransientEvents.length > 0
      ) this.flushTransientQueue(client);
    });
  }

  private postTransientBatch(
    client: FeedClient,
    connection: ClientFeedConnection,
    conversationId: string,
    events: ReliableKernelTransientBatchItem[]
  ): void {
    if (events.length === 0) return;
    const deliveryId = randomUUID();
    this.postTransientEnvelope(client, connection, {
      type: RELIABLE_KERNEL_TRANSIENT_BATCH_MESSAGE,
      deliveryId,
      sessionId: connection.sessionId,
      navigationGeneration: String(client.navigationGeneration),
      hostBootId: connection.hostBootId,
      conversationId,
      events
    }, {
      deliveryId,
      kind: 'batch',
      resendCount: 0
    });
  }

  private postTransientSnapshot(
    client: FeedClient,
    connection: ClientFeedConnection,
    snapshot: ReliableTransientReplaySnapshot,
    requestId: string | undefined,
    resendCount: number
  ): void {
    const deliveryId = randomUUID();
    const message: ReliableKernelTransientSnapshotMessage = {
      type: RELIABLE_KERNEL_TRANSIENT_SNAPSHOT_MESSAGE,
      deliveryId,
      ...(requestId ? { requestId } : {}),
      sessionId: connection.sessionId,
      navigationGeneration: String(client.navigationGeneration),
      hostBootId: connection.hostBootId,
      ...snapshot
    };
    this.postTransientEnvelope(client, connection, message, {
      deliveryId,
      kind: 'snapshot',
      resendCount
    });
  }

  private postTransientEnvelope(
    client: FeedClient,
    connection: ClientFeedConnection,
    message: ReliableKernelTransientBatchMessage | ReliableKernelTransientSnapshotMessage,
    input: Pick<TransientDelivery, 'deliveryId' | 'kind' | 'resendCount'>
  ): void {
    if (
      client.closed
      || !client.ready
      || !client.visible
      || client.meta.conversationId !== message.conversationId
    ) return;
    let plain: unknown;
    try {
      plain = toStructuredClonePlainData(message, 'reliable transient webview message');
    } catch (error) {
      this.onError(error, { clientId: client.clientId, operation: 'post' });
      return;
    }
    const delivery: TransientDelivery = {
      ...input,
      sessionId: connection.sessionId,
      navigationGeneration: client.navigationGeneration,
      postedAt: Date.now(),
      ackTimer: this.armTransientAckTimer(client, input.deliveryId)
    };
    client.transientDeliveries.set(input.deliveryId, delivery);
    for (const item of message.events) {
      captureDebug(this.debugCapture, { conversationId: message.conversationId, modelRequestId: item.modelRequestId, attemptSeq: item.attemptSeq, socketGeneration: item.socketGeneration },
        () => ({ stage: 'feed.send', metadata: { clientId: client.clientId, sessionId: message.sessionId, kind: input.kind, deliveryId: input.deliveryId,
          streamSeq: String(item.event.streamSeq), fromStreamSeq: item.fromStreamSeq ?? String(item.event.streamSeq), resendCount: input.resendCount }, payload: item }));
    }
    this.deliverPostedMessage(client, plain, false, undefined, {
      onUndelivered: () => this.failTransientDelivery(client, delivery, 'post_false'),
      onRejected: (error) => {
        this.onError(error, { clientId: client.clientId, operation: 'post' });
        this.failTransientDelivery(client, delivery, 'post_rejected');
      }
    });
  }

  private armTransientAckTimer(client: FeedClient, deliveryId: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const delivery = client.transientDeliveries.get(deliveryId);
      if (!delivery) return;
      this.failTransientDelivery(client, delivery, 'ack_timeout');
    }, this.transientAckTimeoutMs);
    timer.unref();
    return timer;
  }

  private failTransientDelivery(
    client: FeedClient,
    delivery: TransientDelivery,
    reason: 'post_false' | 'post_rejected' | 'ack_timeout'
  ): void {
    if (client.transientDeliveries.get(delivery.deliveryId) !== delivery) return;
    clearTimeout(delivery.ackTimer);
    client.transientDeliveries.delete(delivery.deliveryId);
    this.diagnostics?.observe({
      eventKind: `feed.transient.${reason}`,
      scopeKind: 'feed_session',
      scopeId: delivery.sessionId,
      correlationId: delivery.deliveryId,
      metadata: {
        ...(client.meta.conversationId ? { conversationId: client.meta.conversationId } : {}),
        deliveryKind: delivery.kind,
        resendCount: delivery.resendCount,
        elapsedMs: Math.max(0, Date.now() - delivery.postedAt)
      }
    });
    if (
      client.closed
      || !client.ready
      || !client.visible
      || delivery.navigationGeneration !== client.navigationGeneration
      || delivery.resendCount >= this.maxTransientSnapshotResends
    ) return;
    const connectionPromise = client.connection;
    const conversationId = client.meta.conversationId;
    if (!connectionPromise || !conversationId) return;
    // One cumulative replay supersedes every unacknowledged transient frame in this generation.
    this.clearTransientDeliveries(client);
    void connectionPromise.then((connection) => {
      if (
        client.closed
        || !client.ready
        || !client.visible
        || client.connection !== connectionPromise
        || client.navigationGeneration !== delivery.navigationGeneration
        || client.meta.conversationId !== conversationId
      ) return;
      const snapshots = this.transientReplay.snapshotsForConversation(conversationId);
      for (const snapshot of snapshots) {
        this.postTransientSnapshot(client, connection, snapshot, undefined, delivery.resendCount + 1);
      }
    }, () => undefined);
  }

  private observeTransientAck(client: FeedClient, ack: ReliableKernelTransientAckMessage): void {
    const delivery = client.transientDeliveries.get(ack.deliveryId);
    if (
      !delivery
      || delivery.sessionId !== ack.sessionId
      || delivery.navigationGeneration !== client.navigationGeneration
    ) return;
    clearTimeout(delivery.ackTimer);
    client.transientDeliveries.delete(ack.deliveryId);
    this.diagnostics?.observe({
      eventKind: 'feed.transient.acked',
      scopeKind: 'feed_session',
      scopeId: ack.sessionId,
      correlationId: ack.deliveryId,
      metadata: {
        ...(client.meta.conversationId ? { conversationId: client.meta.conversationId } : {}),
        deliveryKind: delivery.kind,
        headCount: ack.heads.length,
        elapsedMs: Math.max(0, Date.now() - delivery.postedAt)
      }
    });
  }

  private replayTransientConversation(
    client: FeedClient,
    connection: ClientFeedConnection,
    reason: 'connection'
  ): void {
    const conversationId = client.meta.conversationId;
    if (!conversationId) return;
    const snapshots = this.transientReplay.snapshotsForConversation(conversationId);
    client.transientDropDiagnosticKeys.clear();
    if (snapshots.length === 0) return;
    this.diagnostics?.observe({
      eventKind: 'feed.transient.connection_replay',
      scopeKind: 'feed_session',
      scopeId: connection.sessionId,
      metadata: { conversationId, reason, snapshotCount: snapshots.length }
    });
    for (const snapshot of snapshots) {
      this.postTransientSnapshot(client, connection, snapshot, undefined, 0);
    }
  }

  private observeTransientDrop(
    client: FeedClient,
    event: ReliableAgentTransientEvent,
    reason: 'not_ready' | 'hidden' | 'not_connected' | 'generation_changed'
  ): void {
    const key = `${event.modelRequestId}\0${event.attemptSeq}\0${event.socketGeneration}\0${reason}`;
    if (client.transientDropDiagnosticKeys.has(key)) return;
    client.transientDropDiagnosticKeys.add(key);
    while (client.transientDropDiagnosticKeys.size > TRANSIENT_MAX_DROP_DIAGNOSTIC_KEYS) {
      const oldest = client.transientDropDiagnosticKeys.values().next().value as string | undefined;
      if (!oldest) break;
      client.transientDropDiagnosticKeys.delete(oldest);
    }
    this.diagnostics?.observe({
      eventKind: `feed.transient.dropped.${reason}`,
      scopeKind: 'model_request',
      scopeId: event.modelRequestId,
      correlationId: String(event.event.streamSeq),
      metadata: {
        conversationId: event.conversationId,
        clientId: client.clientId,
        attemptSeq: event.attemptSeq,
        socketGeneration: event.socketGeneration,
        streamSeq: String(event.event.streamSeq),
        navigationGeneration: client.navigationGeneration
      }
    });
  }

  private clearTransientQueue(client: FeedClient): void {
    if (client.transientFlushTimer !== undefined) clearTimeout(client.transientFlushTimer);
    client.transientFlushTimer = undefined;
    client.pendingTransientEvents.length = 0;
    client.transientToolCallKeys.clear();
    client.transientRawEventCount = 0;
  }

  private clearTransientDeliveries(client: FeedClient): void {
    for (const delivery of client.transientDeliveries.values()) clearTimeout(delivery.ackTimer);
    client.transientDeliveries.clear();
  }

  public async setActiveConversation(
    clientId: BridgeClientId,
    activeConversationId: string | null
  ): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client || client.closed) return;
    // Navigation is a transport-generation boundary. Reusing the prior session lets an older
    // snapshot/detail/transient callback race into the newly selected conversation.
    this.reconnect(clientId, activeConversationId);
    const connection = client.connection;
    if (connection) await connection;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const clientId of [...this.clients.keys()]) this.detach(clientId);
    this.transientReplay.clear();
  }

  private async connect(client: FeedClient, navigationGeneration: number): Promise<ClientFeedConnection> {
    while (
      !client.closed
      && client.ready
      && client.visible
      && client.navigationGeneration === navigationGeneration
    ) {
      try {
        const connection = await this.feed.connect({
          activeConversationId: client.meta.conversationId ?? null,
          send: (message) => {
            if (!client.closed && client.navigationGeneration === navigationGeneration) {
              this.post(client, { ...message, navigationGeneration: String(navigationGeneration) });
            }
          },
          onFailure: (error) => {
            if (client.closed || client.navigationGeneration !== navigationGeneration) return;
            this.onError(error, { clientId: client.clientId, operation: 'connect' });
            this.scheduleRecovery(client);
          }
        });
        if (
          client.closed
          || !client.ready
          || !client.visible
          || client.navigationGeneration !== navigationGeneration
        ) {
          this.feed.disconnect(connection.sessionId);
          throw new FeedConnectionSupersededError();
        }
        return connection;
      } catch (error) {
        if (error instanceof FeedConnectionSupersededError) throw error;
        this.onError(error, { clientId: client.clientId, operation: 'connect' });
        if (!await this.waitForConnectRecovery(client, navigationGeneration)) {
          throw new FeedConnectionSupersededError();
        }
      }
    }
    throw new FeedConnectionSupersededError();
  }

  private post(client: FeedClient, message: ReliableKernelDataMessage | Record<string, unknown>): void {
    const requestResponseMessage = message.type === RELIABLE_KERNEL_DETAIL_RESULT_MESSAGE
      || message.type === RELIABLE_KERNEL_DETAIL_ERROR_MESSAGE
      || message.type === RELIABLE_KERNEL_HISTORY_PAGE_RESULT_MESSAGE
      || message.type === RELIABLE_KERNEL_HISTORY_PAGE_ERROR_MESSAGE
      || message.type === RELIABLE_KERNEL_COLLABORATION_HISTORY_RESULT_MESSAGE
      || message.type === RELIABLE_KERNEL_COLLABORATION_HISTORY_ERROR_MESSAGE;
    let plain: unknown;
    try {
      plain = toStructuredClonePlainData(message, 'reliable kernel webview message');
    } catch (error) {
      this.onError(error, { clientId: client.clientId, operation: 'post' });
      if (requestResponseMessage && !client.closed) this.scheduleRecovery(client);
      return;
    }
    const dataMessage = reliableDataDiagnostic(message);
    if (dataMessage) this.beginDataPost(client, plain, dataMessage);
    this.deliverPostedMessage(client, plain, requestResponseMessage, dataMessage);
  }

  private beginDataPost(
    client: FeedClient,
    plain: unknown,
    dataMessage: ReliableDataDiagnostic
  ): void {
    this.clearLastDataPost(client);
    client.lastDataPost = {
      sessionId: dataMessage.sessionId,
      messageSeq: dataMessage.messageSeq,
      postedAt: Date.now(),
      emptyChanges: dataMessage.emptyChanges,
      ackTimer: this.armDataPostAckTimer(client, dataMessage.sessionId, dataMessage.messageSeq),
      plain,
      resendCount: 0,
      diagnostic: dataMessage
    };
    this.observeDataPost(client, dataMessage, plain, false);
  }

  private armDataPostAckTimer(
    client: FeedClient,
    sessionId: string,
    messageSeq: string
  ): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const pending = client.lastDataPost;
      if (
        client.closed
        || !pending
        || pending.sessionId !== sessionId
        || pending.messageSeq !== messageSeq
      ) return;
      this.onError(new Error(`Reliable feed ACK ${messageSeq} timed out.`), {
        clientId: client.clientId,
        operation: 'post'
      });
      this.retryOrSuspendDataPost(client, pending);
    }, this.ackTimeoutMs);
    timer.unref();
    return timer;
  }

  /**
   * A missing ACK is evidence about this Webview renderer, not the durable Feed. Re-send the exact
   * same frame at most once, then suspend until a new Ready generation instead of manufacturing an
   * unbounded sequence of snapshots and sessions for a zombie renderer.
   */
  private retryOrSuspendDataPost(client: FeedClient, pending: FeedDataPost): void {
    if (client.lastDataPost !== pending || client.closed || !client.ready || !client.visible) return;
    if (pending.resendCount >= this.maxFrameResends) {
      client.ready = false;
      this.pauseClient(client);
      return;
    }
    clearTimeout(pending.ackTimer);
    pending.resendCount += 1;
    pending.postedAt = Date.now();
    pending.ackTimer = this.armDataPostAckTimer(client, pending.sessionId, pending.messageSeq);
    this.observeDataPost(client, pending.diagnostic, pending.plain, true);
    this.deliverPostedMessage(client, pending.plain, false, pending.diagnostic);
  }

  private deliverPostedMessage(
    client: FeedClient,
    plain: unknown,
    requestResponseMessage: boolean,
    dataMessage?: ReliableDataDiagnostic,
    deliveryObserver?: PostedMessageDeliveryObserver
  ): void {
    void client.webview.postMessage(plain).then(
      (delivered) => {
        if (delivered !== false) return;
        if (deliveryObserver) {
          deliveryObserver.onUndelivered();
          return;
        }
        if (client.closed) return;
        if (requestResponseMessage) {
          this.onError(new Error('VS Code rejected reliable request-response postMessage delivery.'), {
            clientId: client.clientId,
            operation: 'post'
          });
          this.scheduleRecovery(client);
          return;
        }
        if (!dataMessage) return;
        const pending = client.lastDataPost;
        if (pending?.sessionId !== dataMessage.sessionId || pending.messageSeq !== dataMessage.messageSeq) return;
        this.onError(new Error('VS Code rejected reliable feed postMessage delivery.'), {
          clientId: client.clientId,
          operation: 'post'
        });
        this.retryOrSuspendDataPost(client, pending);
      },
      (error) => {
        if (deliveryObserver) {
          deliveryObserver.onRejected(error);
          return;
        }
        if (dataMessage && !dataMessage.emptyChanges) {
          this.diagnostics?.observe({
            eventKind: 'feed.data.post_failed',
            scopeKind: 'feed_session',
            scopeId: dataMessage.sessionId,
            correlationId: dataMessage.messageSeq,
            metadata: {
              ...(client.meta.conversationId ? { conversationId: client.meta.conversationId } : {}),
              sessionId: dataMessage.sessionId,
              messageSeq: dataMessage.messageSeq,
              errorName: error instanceof Error ? error.name : 'UnknownError'
            }
          });
        }
        this.onError(error, { clientId: client.clientId, operation: 'post' });
        if (requestResponseMessage && !client.closed) {
          this.scheduleRecovery(client);
          return;
        }
        if (dataMessage && !client.closed) {
          const pending = client.lastDataPost;
          if (pending?.sessionId === dataMessage.sessionId && pending.messageSeq === dataMessage.messageSeq) {
            this.retryOrSuspendDataPost(client, pending);
          }
        }
      }
    );
  }

  private observeDataPost(
    client: FeedClient,
    dataMessage: ReliableDataDiagnostic,
    plain: unknown,
    resent: boolean
  ): void {
    if (dataMessage.emptyChanges) return;
    this.diagnostics?.observe({
      eventKind: resent ? 'feed.data.reposted' : 'feed.data.posted',
      scopeKind: 'feed_session',
      scopeId: dataMessage.sessionId,
      correlationId: dataMessage.messageSeq,
      metadata: {
        ...(client.meta.conversationId ? { conversationId: client.meta.conversationId } : {}),
        sessionId: dataMessage.sessionId,
        messageSeq: dataMessage.messageSeq,
        commitSeq: dataMessage.commitSeq,
        kind: dataMessage.kind,
        bytes: wireBytes(plain),
        changeCount: dataMessage.changeCount
      }
    });
  }

  private observeClientDiagnostic(message: ReliableKernelClientDiagnosticMessage): void {
    if (message.eventKind === 'feed-painted') {
      if (!message.messageSeq) return;
      this.diagnostics?.observe({
        eventKind: 'webview.feed.painted',
        scopeKind: 'feed_session',
        scopeId: message.sessionId,
        correlationId: message.messageSeq,
        observedAt: message.observedAt,
        metadata: {
          ...(message.conversationId ? { conversationId: message.conversationId } : {}),
          sessionId: message.sessionId,
          messageSeq: message.messageSeq
        }
      });
      return;
    }
    if (!message.modelRequestId) return;
    const eventKind = message.eventKind === 'transient-painted'
      ? 'webview.transient.painted'
      : message.eventKind === 'transient-gap'
        ? 'webview.transient.gap'
        : message.eventKind === 'transient-snapshot-replayed'
          ? 'webview.transient.snapshot_replayed'
          : 'webview.transient.snapshot_rejected';
    this.diagnostics?.observe({
      eventKind,
      scopeKind: 'model_request',
      scopeId: message.modelRequestId,
      correlationId: message.streamSeq,
      observedAt: message.observedAt,
      metadata: {
        ...(message.conversationId ? { conversationId: message.conversationId } : {}),
        ...(message.turnId ? { turnId: message.turnId } : {}),
        modelRequestId: message.modelRequestId,
        ...(message.attemptSeq ? { attemptSeq: message.attemptSeq } : {}),
        ...(message.socketGeneration ? { socketGeneration: message.socketGeneration } : {}),
        ...(message.streamSeq ? { streamSeq: message.streamSeq } : {})
      }
    });
  }

  private observeAck(
    client: FeedClient,
    ack: ReliableKernelAckMessage,
    posted: FeedClient['lastDataPost'] = client.lastDataPost
  ): void {
    if (!posted || posted.sessionId !== ack.sessionId || posted.messageSeq !== ack.messageSeq) return;
    // acknowledge() may synchronously flush the next durable frame and replace lastDataPost. Clear
    // only the acknowledged timer so diagnostics never erase the newly posted frame's ACK watchdog.
    if (client.lastDataPost === posted) this.clearLastDataPost(client);
    else clearTimeout(posted.ackTimer);
    this.cancelRecoveryTimer(client);
    client.recoveryAttempt = 0;
    if (posted.emptyChanges) return;
    this.diagnostics?.observe({
      eventKind: 'feed.data.acked',
      scopeKind: 'feed_session',
      scopeId: ack.sessionId,
      correlationId: ack.messageSeq,
      metadata: {
        ...(client.meta.conversationId ? { conversationId: client.meta.conversationId } : {}),
        sessionId: ack.sessionId,
        messageSeq: ack.messageSeq,
        elapsedMs: Math.max(0, Date.now() - posted.postedAt)
      }
    });
  }

  private clearLastDataPost(client: FeedClient): void {
    if (client.lastDataPost) clearTimeout(client.lastDataPost.ackTimer);
    client.lastDataPost = undefined;
  }

  private scheduleRecovery(client: FeedClient): void {
    if (client.closed || !client.ready || !client.visible || client.recoveryTimer) return;
    const delay = this.nextRecoveryDelay(client);
    client.recoveryTimer = setTimeout(() => {
      client.recoveryTimer = undefined;
      if (!client.closed && client.ready && client.visible) {
        this.reconnectClient(client, client.meta.conversationId ?? null, false);
      }
    }, delay);
    client.recoveryTimer.unref();
  }

  /**
   * Initial connect and reconnect attempts use the same bounded backoff as ACK/post recovery. The
   * active `connection` promise therefore stays pending across a one-shot transport failure instead
   * of becoming a permanently rejected handle that every later control message would await.
   */
  private waitForConnectRecovery(client: FeedClient, navigationGeneration: number): Promise<boolean> {
    if (
      client.closed
      || !client.ready
      || !client.visible
      || client.navigationGeneration !== navigationGeneration
    ) return Promise.resolve(false);
    // A synchronous post failure can schedule recovery while feed.connect() is still unwinding.
    // Keep the active connection promise as the sole owner of recovery instead of letting that
    // timer replace it after this attempt rejects.
    if (client.recoveryTimer) this.cancelRecoveryTimer(client);
    const delay = this.nextRecoveryDelay(client);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (retry: boolean): void => {
        if (settled) return;
        settled = true;
        if (client.recoveryTimer) clearTimeout(client.recoveryTimer);
        client.recoveryTimer = undefined;
        client.recoveryWake = undefined;
        resolve(
          retry
          && !client.closed
          && client.ready
          && client.visible
          && client.navigationGeneration === navigationGeneration
        );
      };
      client.recoveryWake = finish;
      client.recoveryTimer = setTimeout(() => finish(true), delay);
      client.recoveryTimer.unref();
    });
  }

  private nextRecoveryDelay(client: FeedClient): number {
    const delay = Math.min(FEED_RECOVERY_MAX_DELAY_MS, 1_000 * 2 ** Math.min(client.recoveryAttempt, 5));
    client.recoveryAttempt += 1;
    return delay;
  }

  private cancelRecoveryTimer(client: FeedClient): void {
    if (client.recoveryTimer) clearTimeout(client.recoveryTimer);
    client.recoveryTimer = undefined;
    const wake = client.recoveryWake;
    client.recoveryWake = undefined;
    wake?.(false);
  }
}

class FeedConnectionSupersededError extends Error {
  public constructor() {
    super('Reliable feed connection attempt was superseded.');
    this.name = 'FeedConnectionSupersededError';
  }
}

interface ReliableDataDiagnostic {
  kind: 'snapshot' | 'changes';
  sessionId: string;
  messageSeq: string;
  commitSeq: string;
  changeCount: number;
  emptyChanges: boolean;
}

function reliableDataDiagnostic(message: unknown): ReliableDataDiagnostic | undefined {
  if (!isRecord(message)) return undefined;
  if (message.type === RELIABLE_KERNEL_SNAPSHOT_MESSAGE) {
    if (
      typeof message.sessionId !== 'string'
      || typeof message.messageSeq !== 'string'
      || typeof message.snapshotCommitSeq !== 'string'
    ) return undefined;
    return {
      kind: 'snapshot',
      sessionId: message.sessionId,
      messageSeq: message.messageSeq,
      commitSeq: message.snapshotCommitSeq,
      changeCount: 0,
      emptyChanges: false
    };
  }
  if (message.type !== RELIABLE_KERNEL_CHANGES_MESSAGE) return undefined;
  if (
    typeof message.sessionId !== 'string'
    || typeof message.messageSeq !== 'string'
    || typeof message.commitSeq !== 'string'
    || !Array.isArray(message.changes)
  ) return undefined;
  return {
    kind: 'changes',
    sessionId: message.sessionId,
    messageSeq: message.messageSeq,
    commitSeq: message.commitSeq,
    changeCount: message.changes.length,
    emptyChanges: message.changes.length === 0
  };
}

function wireBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

function normalizeAck(message: Record<string, unknown>): ReliableKernelAckMessage {
  return {
    type: RELIABLE_KERNEL_ACK_MESSAGE,
    sessionId: requireText(message.sessionId, 'ack.sessionId'),
    hostBootId: requireText(message.hostBootId, 'ack.hostBootId'),
    messageSeq: requireDecimal(message.messageSeq, 'ack.messageSeq')
  };
}

function normalizeTransientAck(message: Record<string, unknown>): ReliableKernelTransientAckMessage {
  if (!Array.isArray(message.heads) || message.heads.length > 256) {
    throw new TypeError('transient ack.heads is invalid.');
  }
  return {
    type: RELIABLE_KERNEL_TRANSIENT_ACK_MESSAGE,
    deliveryId: requireText(message.deliveryId, 'transient ack.deliveryId'),
    sessionId: requireText(message.sessionId, 'transient ack.sessionId'),
    hostBootId: requireText(message.hostBootId, 'transient ack.hostBootId'),
    ...(message.navigationGeneration === undefined
      ? {}
      : { navigationGeneration: requireDecimal(message.navigationGeneration, 'transient ack.navigationGeneration') }),
    heads: message.heads.map((value, index) => {
      if (!isRecord(value)) throw new TypeError(`transient ack.heads[${index}] is invalid.`);
      return {
        modelRequestId: requireText(value.modelRequestId, `transient ack.heads[${index}].modelRequestId`),
        attemptSeq: requireDecimal(value.attemptSeq, `transient ack.heads[${index}].attemptSeq`),
        socketGeneration: requireDecimal(value.socketGeneration, `transient ack.heads[${index}].socketGeneration`),
        streamSeq: requireDecimal(value.streamSeq, `transient ack.heads[${index}].streamSeq`)
      };
    })
  };
}

function normalizeTransientSnapshotRequest(
  message: Record<string, unknown>
): ReliableKernelTransientSnapshotRequestMessage {
  return {
    type: RELIABLE_KERNEL_TRANSIENT_SNAPSHOT_REQUEST_MESSAGE,
    requestId: requireText(message.requestId, 'transient snapshot request.requestId'),
    sessionId: requireText(message.sessionId, 'transient snapshot request.sessionId'),
    hostBootId: requireText(message.hostBootId, 'transient snapshot request.hostBootId'),
    ...(message.navigationGeneration === undefined
      ? {}
      : { navigationGeneration: requireDecimal(message.navigationGeneration, 'transient snapshot request.navigationGeneration') }),
    conversationId: requireText(message.conversationId, 'transient snapshot request.conversationId'),
    modelRequestId: requireText(message.modelRequestId, 'transient snapshot request.modelRequestId'),
    attemptSeq: requireDecimal(message.attemptSeq, 'transient snapshot request.attemptSeq'),
    socketGeneration: requireDecimal(message.socketGeneration, 'transient snapshot request.socketGeneration'),
    afterStreamSeq: requireDecimal(message.afterStreamSeq, 'transient snapshot request.afterStreamSeq')
  };
}

function normalizeClientDiagnostic(message: Record<string, unknown>): ReliableKernelClientDiagnosticMessage {
  const eventKind = message.eventKind;
  if (![
    'feed-painted',
    'transient-painted',
    'transient-gap',
    'transient-snapshot-replayed',
    'transient-snapshot-rejected'
  ].includes(String(eventKind))) {
    throw new TypeError('client diagnostic.eventKind is invalid.');
  }
  const observedAt = requireText(message.observedAt, 'client diagnostic.observedAt');
  if (!Number.isFinite(Date.parse(observedAt))) throw new TypeError('client diagnostic.observedAt is invalid.');
  return {
    type: RELIABLE_KERNEL_CLIENT_DIAGNOSTIC_MESSAGE,
    sessionId: requireText(message.sessionId, 'client diagnostic.sessionId'),
    eventKind: eventKind as ReliableKernelClientDiagnosticMessage['eventKind'],
    observedAt: new Date(Date.parse(observedAt)).toISOString(),
    ...(message.conversationId === undefined ? {} : { conversationId: requireText(message.conversationId, 'client diagnostic.conversationId') }),
    ...(message.turnId === undefined ? {} : { turnId: requireText(message.turnId, 'client diagnostic.turnId') }),
    ...(message.messageSeq === undefined ? {} : { messageSeq: requireDecimal(message.messageSeq, 'client diagnostic.messageSeq') }),
    ...(message.modelRequestId === undefined ? {} : { modelRequestId: requireText(message.modelRequestId, 'client diagnostic.modelRequestId') }),
    ...(message.streamSeq === undefined ? {} : { streamSeq: requireDecimal(message.streamSeq, 'client diagnostic.streamSeq') }),
    ...(message.attemptSeq === undefined ? {} : { attemptSeq: requireDecimal(message.attemptSeq, 'client diagnostic.attemptSeq') }),
    ...(message.socketGeneration === undefined ? {} : { socketGeneration: requireDecimal(message.socketGeneration, 'client diagnostic.socketGeneration') })
  };
}

function normalizeSnapshotRequest(message: Record<string, unknown>): ReliableKernelSnapshotRequestMessage {
  return {
    type: RELIABLE_KERNEL_SNAPSHOT_REQUEST_MESSAGE,
    ...(message.sessionId === undefined ? {} : { sessionId: requireText(message.sessionId, 'snapshotRequest.sessionId') }),
    ...(message.activeConversationId === undefined
      ? {}
      : { activeConversationId: requireText(message.activeConversationId, 'snapshotRequest.activeConversationId') })
  };
}

function normalizeDetailRequest(message: Record<string, unknown>): ReliableKernelDetailRequestMessage {
  const kind = message.kind;
  if (![
    'message-content',
    'turn-intent-preview',
    'tool-arguments-content',
    'tool-result-content',
    'tool-event-content',
    'interaction-prompt',
    'file-change-base-content',
    'file-change-content',
    'file-change-diff',
    'process-output',
    'process-stdout',
    'process-stderr',
    'context-projection-detail',
    'model-request-purpose',
    'compression-presentation',
    'compression-content',
    'compression-title',
    'answer-content'
  ].includes(String(kind))) throw new TypeError('detail.kind is invalid.');
  if (!Number.isSafeInteger(message.offset) || (message.offset as number) < 0) {
    throw new TypeError('detail.offset must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(message.maxBytes) || (message.maxBytes as number) <= 0 || (message.maxBytes as number) > 2_097_152) {
    throw new TypeError('detail.maxBytes must be from 1 to 2097152.');
  }
  if (
    message.expectedTotalBytes !== undefined
    && (!Number.isSafeInteger(message.expectedTotalBytes) || (message.expectedTotalBytes as number) < 0)
  ) throw new TypeError('detail.expectedTotalBytes must be a non-negative integer.');
  return {
    type: RELIABLE_KERNEL_DETAIL_REQUEST_MESSAGE,
    requestId: requireText(message.requestId, 'detail.requestId'),
    ...(message.sessionId === undefined ? {} : { sessionId: requireText(message.sessionId, 'detail.sessionId') }),
    kind: kind as ReliableKernelDetailRequestMessage['kind'],
    recordId: requireText(message.recordId, 'detail.recordId'),
    offset: message.offset as number,
    maxBytes: message.maxBytes as number,
    ...(message.expectedTotalBytes === undefined
      ? {}
      : { expectedTotalBytes: message.expectedTotalBytes as number })
  };
}

function normalizeCollaborationHistoryRequest(
  message: Record<string, unknown>
): ReliableKernelCollaborationHistoryRequestMessage {
  if ((message.beforeMessageSeq === undefined) !== (message.beforeId === undefined)) {
    throw new TypeError('collaborationHistory cursor requires both sequence and id.');
  }
  const beforeMessageSeq = message.beforeMessageSeq === undefined ? undefined
    : requireDecimal(message.beforeMessageSeq, 'collaborationHistory.beforeMessageSeq');
  if (beforeMessageSeq === '0') throw new TypeError('collaborationHistory.beforeMessageSeq must be positive.');
  if (!Number.isSafeInteger(message.limit) || (message.limit as number) < 1 || (message.limit as number) > 200) {
    throw new TypeError('collaborationHistory.limit must be from 1 to 200.');
  }
  return {
    type: RELIABLE_KERNEL_COLLABORATION_HISTORY_REQUEST_MESSAGE,
    requestId: requireText(message.requestId, 'collaborationHistory.requestId'),
    sessionId: requireText(message.sessionId, 'collaborationHistory.sessionId'),
    conversationId: requireText(message.conversationId, 'collaborationHistory.conversationId'),
    ...(beforeMessageSeq === undefined ? {} : {
      beforeMessageSeq,
      beforeId: requireText(message.beforeId, 'collaborationHistory.beforeId')
    }),
    limit: message.limit as number
  };
}

function normalizeHistoryPageRequest(
  message: Record<string, unknown>
): ReliableKernelHistoryPageRequestMessage {
  const beforeMessageSeq = requireDecimal(
    message.beforeMessageSeq,
    'historyPage.beforeMessageSeq'
  );
  if (beforeMessageSeq === '0') {
    throw new TypeError('historyPage.beforeMessageSeq must be positive.');
  }
  if (
    !Number.isSafeInteger(message.limit)
    || (message.limit as number) <= 0
    || (message.limit as number) > 200
  ) {
    throw new TypeError('historyPage.limit must be from 1 to 200.');
  }
  return {
    type: RELIABLE_KERNEL_HISTORY_PAGE_REQUEST_MESSAGE,
    requestId: requireText(message.requestId, 'historyPage.requestId'),
    ...(message.sessionId === undefined
      ? {}
      : { sessionId: requireText(message.sessionId, 'historyPage.sessionId') }),
    conversationId: requireText(message.conversationId, 'historyPage.conversationId'),
    beforeMessageSeq,
    beforeId: requireText(message.beforeId, 'historyPage.beforeId'),
    limit: message.limit as number
  };
}

function plainMeta(meta: WebviewClientMeta): WebviewClientMeta {
  return toStructuredClonePlainData({
    kind: meta.kind,
    ...(meta.panelId ? { panelId: meta.panelId } : {}),
    ...(meta.title ? { title: meta.title } : {}),
    ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
    ...(meta.toolCallId ? { toolCallId: meta.toolCallId } : {}),
    ...(meta.planProposalId ? { planProposalId: meta.planProposalId } : {})
  }, 'webview meta') as unknown as WebviewClientMeta;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function requireDecimal(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (!/^(?:0|[1-9]\d*)$/.test(text)) throw new TypeError(`${label} must be a decimal integer string.`);
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer.`);
  return value;
}

function defaultErrorHandler(error: unknown, context: { clientId: BridgeClientId; operation: string }): void {
  console.error(`[LimCode] Reliable client feed ${context.operation} failed for ${context.clientId}.`, error);
}
