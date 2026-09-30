import {
  BridgeMessageType,
  createMessageId,
  type BridgeChannel,
  type BridgeClientId,
  type BridgeScope,
  type ExtensionToWebviewMessage,
  type WebviewClientMeta,
  type WebviewToExtensionMessage
} from '@shared/protocol';
import { toStructuredClonePlainData } from '@shared/plainData';
import type { HostApi } from '../platform/hostApi';
import { channelForType } from './channels';

type ExtensionMessageListener<T extends ExtensionToWebviewMessage = ExtensionToWebviewMessage> = (
  message: T
) => void;

interface BridgePersistedState {
  meta?: WebviewClientMeta;
}

/**
 * IDE 无关的协议桥。
 *
 * 只依赖 HostApi 收发原始消息，自身负责：内存 session 捕获/附带、按类型选通道、
 * request/on/onAny/ready 等协议级能力。不直接接触任何具体 IDE API。
 */
export class WebviewBridge {
  private readonly listeners = new Map<string, Set<ExtensionMessageListener>>();
  /** Extension Host session identity is memory-only and is never restored after Webview reload. */
  private sessionId: BridgeClientId | undefined;

  public constructor(private readonly host: HostApi) {
    this.host.onMessage((raw) => {
      const message = raw as ExtensionToWebviewMessage;
      this.captureTransportState(message);
      this.emit(message);
    });
  }

  public post(message: WebviewToExtensionMessage): void {
    this.postRaw({ ...message, clientId: this.sessionId });
  }

  /** Candidate bounded feed control messages use the same recursively plain bridge boundary. */
  public postRaw(message: unknown): void {
    this.host.postMessage(toStructuredClonePlainData(message, 'bridge message'));
  }

  public request<TType extends WebviewToExtensionMessage['type']>(
    type: TType,
    payload?: Extract<WebviewToExtensionMessage, { type: TType }>['payload'],
    options: { channel?: BridgeChannel; scope?: BridgeScope; correlationId?: string; requestId?: string } = {}
  ): string {
    const id = options.requestId?.trim() || createMessageId();

    this.post({
      id,
      type,
      channel: options.channel ?? channelForType(type),
      scope: options.scope,
      correlationId: options.correlationId,
      payload
    } as Extract<WebviewToExtensionMessage, { type: TType }>);

    return id;
  }

  public currentClientId(): BridgeClientId | undefined {
    return this.sessionId;
  }

  public readPersistedState<T>(key: string): T | undefined {
    const state = this.host.getState<Record<string, unknown>>() ?? {};
    return state[key] as T | undefined;
  }

  public writePersistedState<T>(key: string, value: T): void {
    const state = this.host.getState<Record<string, unknown>>() ?? {};
    this.host.setState({ ...state, [key]: value });
  }

  public ready(settingsActivitySessionId?: string): string {
    return this.request(BridgeMessageType.Ready, settingsActivitySessionId ? { settingsActivitySessionId } : undefined, { channel: 'control' });
  }

  public on<TType extends ExtensionToWebviewMessage['type']>(
    type: TType,
    listener: (message: Extract<ExtensionToWebviewMessage, { type: TType }>) => void
  ): () => void {
    const bucket = this.listeners.get(type) ?? new Set<ExtensionMessageListener>();
    bucket.add(listener as ExtensionMessageListener);
    this.listeners.set(type, bucket);

    return () => {
      bucket.delete(listener as ExtensionMessageListener);
    };
  }

  public onAny(listener: ExtensionMessageListener): () => void {
    const bucket = this.listeners.get('*') ?? new Set<ExtensionMessageListener>();
    bucket.add(listener);
    this.listeners.set('*', bucket);

    return () => {
      bucket.delete(listener);
    };
  }

  private captureTransportState(message: ExtensionToWebviewMessage): void {
    const currentState = this.host.getState<BridgePersistedState>() ?? {};
    const nextState: BridgePersistedState = { ...currentState };
    let changed = false;

    if (message.clientId && message.clientId !== this.sessionId) {
      this.sessionId = message.clientId;
    }

    const meta = message.type === BridgeMessageType.Hello ? message.payload?.meta : undefined;
    if (meta && !sameMeta(currentState.meta, meta)) {
      nextState.meta = meta;
      changed = true;
    }

    if (changed) {
      this.host.setState<BridgePersistedState>(nextState);
    }
  }

  private emit(message: ExtensionToWebviewMessage): void {
    this.listeners.get(message.type)?.forEach((listener) => listener(message));
    this.listeners.get('*')?.forEach((listener) => listener(message));
  }
}

function sameMeta(left: WebviewClientMeta | undefined, right: WebviewClientMeta): boolean {
  return left?.kind === right.kind &&
    left?.panelId === right.panelId &&
    left?.title === right.title &&
    left?.conversationId === right.conversationId &&
    left?.toolCallId === right.toolCallId &&
    left?.planProposalId === right.planProposalId;
}
