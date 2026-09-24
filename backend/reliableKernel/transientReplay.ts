import { toStructuredClonePlainData, type PlainData } from '../../shared/plainData';
import type {
  ReliableKernelTransientBatchItem,
  ReliableKernelTransientSnapshotMessage
} from '../../shared/reliableKernelClientFeed';
import type { ReliableAgentTransientEvent } from './agentLoop';

const TRANSIENT_REPLAY_MAX_REQUESTS = 256;
const TRANSIENT_TERMINAL_GRACE_MS = 60_000;

type ReplaySlot = ReplayEventSlot | ReplayTextSlot | ReplayToolDeltaSlot;

interface ReplaySlotBase {
  order: number;
  firstStreamSeq: string;
  firstFromStreamSeq: string;
  item: ReliableKernelTransientBatchItem;
}

interface ReplayEventSlot extends ReplaySlotBase {
  kind: 'event';
}

interface ReplayTextSlot extends ReplaySlotBase {
  kind: 'text';
  content: Record<string, PlainData>;
  chunks: string[];
}

interface ReplayToolDeltaSlot extends ReplaySlotBase {
  kind: 'tool-delta';
  content: Record<string, PlainData>;
  call: Record<string, PlainData>;
  chunks: string[];
}

interface ReplayEntry {
  key: string;
  conversationId: string;
  turnId: string;
  modelRequestId: string;
  requestSeq: string;
  providerId: string;
  modelId: string;
  attemptSeq: string;
  socketGeneration: string;
  afterCommitSeq: string;
  headStreamSeq: string;
  observedAt: string;
  updatedAt: number;
  terminal: boolean;
  contiguous: boolean;
  nextOrder: number;
  slots: ReplaySlot[];
  textSlots: Map<string, ReplayTextSlot>;
  progressSlots: Map<string, ReplayEventSlot>;
  toolSlots: Map<string, ReplayToolDeltaSlot>;
}

export interface ReliableTransientReplaySnapshot extends Omit<
  ReliableKernelTransientSnapshotMessage,
  'type' | 'deliveryId' | 'requestId' | 'sessionId' | 'hostBootId' | 'navigationGeneration'
> {}

/**
 * Memory-only cumulative projection used only to heal Webview transport gaps. Durable authority
 * remains ModelRequest/Message. Text and argument fragments stay chunked until a snapshot is sent.
 */
export class ReliableTransientReplayStore {
  private readonly entries = new Map<string, ReplayEntry>();

  public observe(input: ReliableAgentTransientEvent): void {
    const event = cloneTransientEvent(input);
    const incomingKey = replayKey(event);
    for (const [key, existing] of this.entries) {
      if (existing.modelRequestId !== event.modelRequestId) continue;
      const comparison = compareAttemptIdentity(existing, event);
      if (comparison > 0) return;
      if (comparison < 0) this.entries.delete(key);
    }

    let entry = this.entries.get(incomingKey);
    if (!entry) {
      entry = createReplayEntry(incomingKey, event);
      this.entries.set(incomingKey, entry);
    }
    ingestReplayEvent(entry, event);
    this.prune(Date.now());
  }

  public snapshot(input: {
    conversationId: string;
    modelRequestId: string;
    attemptSeq: string;
    socketGeneration: string;
  }): ReliableTransientReplaySnapshot | undefined {
    const entry = this.entries.get(replayIdentityKey(
      input.modelRequestId,
      input.attemptSeq,
      input.socketGeneration
    ));
    if (!entry || !entry.contiguous || entry.conversationId !== input.conversationId) return undefined;
    return materializeReplayEntry(entry);
  }

  public snapshotsForConversation(conversationId: string): ReliableTransientReplaySnapshot[] {
    this.prune(Date.now());
    return [...this.entries.values()]
      .filter((entry) => entry.contiguous && entry.conversationId === conversationId)
      .sort((left, right) => left.updatedAt - right.updatedAt || left.key.localeCompare(right.key))
      .map(materializeReplayEntry);
  }

  public clear(): void {
    this.entries.clear();
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.terminal && now - entry.updatedAt > TRANSIENT_TERMINAL_GRACE_MS) this.entries.delete(key);
    }
    if (this.entries.size <= TRANSIENT_REPLAY_MAX_REQUESTS) return;
    const candidates = [...this.entries.values()].sort((left, right) =>
      Number(!left.terminal) - Number(!right.terminal)
      || left.updatedAt - right.updatedAt
      || left.key.localeCompare(right.key)
    );
    for (const entry of candidates) {
      if (this.entries.size <= TRANSIENT_REPLAY_MAX_REQUESTS) break;
      this.entries.delete(entry.key);
    }
  }
}

function createReplayEntry(key: string, event: ReliableAgentTransientEvent): ReplayEntry {
  return {
    key,
    conversationId: event.conversationId,
    turnId: event.turnId,
    modelRequestId: event.modelRequestId,
    requestSeq: event.requestSeq,
    providerId: event.providerId,
    modelId: event.modelId,
    attemptSeq: event.attemptSeq,
    socketGeneration: event.socketGeneration,
    afterCommitSeq: event.afterCommitSeq,
    headStreamSeq: decimal(event.event.streamSeq),
    observedAt: event.observedAt,
    updatedAt: timestamp(event.observedAt),
    terminal: false,
    contiguous: true,
    nextOrder: 0,
    slots: [],
    textSlots: new Map(),
    progressSlots: new Map(),
    toolSlots: new Map()
  };
}

function ingestReplayEvent(entry: ReplayEntry, event: ReliableAgentTransientEvent): void {
  const streamSeq = decimal(event.event.streamSeq);
  if (BigInt(streamSeq) <= BigInt(entry.headStreamSeq) && entry.slots.length > 0) return;
  const previousHead = entry.slots.length > 0 ? BigInt(entry.headStreamSeq) : 0n;
  if (BigInt(coveredFromStreamSeq(event)) !== previousHead + 1n) entry.contiguous = false;
  entry.headStreamSeq = streamSeq;
  entry.observedAt = event.observedAt;
  entry.updatedAt = timestamp(event.observedAt);
  entry.afterCommitSeq = event.afterCommitSeq;

  if (event.event.kind === 'completed') {
    clearReplaySlots(entry);
    appendEventSlot(entry, event);
    // The completed item carries the full final Provider output and replaces partial fragments.
    entry.contiguous = true;
    entry.terminal = true;
    return;
  }
  if (event.event.kind === 'failed' || event.event.kind === 'cancelled') {
    appendEventSlot(entry, event);
    entry.terminal = true;
    return;
  }

  const content = record(event.event.content);
  const type = typeof content?.type === 'string' ? content.type : undefined;
  if ((type === 'text_delta' || type === 'thought_delta') && typeof content?.text === 'string') {
    ingestTextDelta(entry, event, content);
    return;
  }
  if (content && type === 'thought_progress') {
    ingestThoughtProgress(entry, event, content);
    return;
  }
  if (type === 'tool_call_delta' && Array.isArray(content?.calls)) {
    ingestToolCallDeltas(entry, event, content);
    return;
  }
  appendEventSlot(entry, event);
}

function ingestTextDelta(
  entry: ReplayEntry,
  event: ReliableAgentTransientEvent,
  content: Record<string, PlainData>
): void {
  const type = String(content.type);
  const identity = outputItemIdentity(content.outputItem);
  const last = entry.slots[entry.slots.length - 1];
  const key = identity ? `${type}\0${identity}` : `legacy\0${type}`;
  let slot = entry.textSlots.get(key);
  // Text/thought blocks may interleave. Only adjacent deltas can be collapsed without changing the
  // semantic output-part order exposed by a cumulative replay.
  if (slot && last !== slot) slot = undefined;
  if (!slot) {
    slot = {
      kind: 'text',
      order: entry.nextOrder++,
      firstStreamSeq: decimal(event.event.streamSeq),
      firstFromStreamSeq: coveredFromStreamSeq(event),
      item: toBatchItem(event),
      content: { ...content, text: '' },
      chunks: []
    };
    entry.textSlots.set(key, slot);
    entry.slots.push(slot);
  }
  slot.chunks.push(String(content.text));
  slot.content = { ...slot.content, ...content, text: '' };
  slot.item = { ...toBatchItem(event), fromStreamSeq: slot.firstFromStreamSeq };
}

function ingestThoughtProgress(
  entry: ReplayEntry,
  event: ReliableAgentTransientEvent,
  content: Record<string, PlainData>
): void {
  const key = outputItemIdentity(content.outputItem) ?? 'legacy';
  const prior = entry.progressSlots.get(key);
  if (prior) {
    prior.item = { ...toBatchItem(event), fromStreamSeq: prior.firstFromStreamSeq };
    return;
  }
  const slot: ReplayEventSlot = {
    kind: 'event',
    order: entry.nextOrder++,
    firstStreamSeq: decimal(event.event.streamSeq),
    firstFromStreamSeq: coveredFromStreamSeq(event),
    item: toBatchItem(event)
  };
  entry.progressSlots.set(key, slot);
  entry.slots.push(slot);
}

function ingestToolCallDeltas(
  entry: ReplayEntry,
  event: ReliableAgentTransientEvent,
  content: Record<string, PlainData>
): void {
  const calls = content.calls as PlainData[];
  const outputIdentity = outputItemIdentity(content.outputItem) ?? 'legacy';
  calls.forEach((value, index) => {
    const call = record(value);
    if (!call || typeof call.argumentsDelta !== 'string') return;
    const callIdentity = text(call.id)
      ?? text(call.callId)
      ?? text(call.streamIndex)
      ?? String(index);
    const key = `${outputIdentity}\0${callIdentity}`;
    let slot = entry.toolSlots.get(key);
    if (!slot) {
      slot = {
        kind: 'tool-delta',
        order: entry.nextOrder++,
        firstStreamSeq: decimal(event.event.streamSeq),
        firstFromStreamSeq: coveredFromStreamSeq(event),
        item: toBatchItem(event),
        content: { ...content, calls: [] },
        call: { ...call, argumentsDelta: '' },
        chunks: []
      };
      entry.toolSlots.set(key, slot);
      entry.slots.push(slot);
    }
    if (call.replace === true) slot.chunks = [call.argumentsDelta];
    else slot.chunks.push(call.argumentsDelta);
    slot.content = { ...slot.content, ...content, calls: [] };
    slot.call = { ...slot.call, ...call, argumentsDelta: '' };
    slot.item = { ...toBatchItem(event), fromStreamSeq: slot.firstFromStreamSeq };
  });
}

function appendEventSlot(entry: ReplayEntry, event: ReliableAgentTransientEvent): void {
  entry.slots.push({
    kind: 'event',
    order: entry.nextOrder++,
    firstStreamSeq: decimal(event.event.streamSeq),
    firstFromStreamSeq: coveredFromStreamSeq(event),
    item: toBatchItem(event)
  });
}

function clearReplaySlots(entry: ReplayEntry): void {
  entry.slots.length = 0;
  entry.textSlots.clear();
  entry.progressSlots.clear();
  entry.toolSlots.clear();
  entry.nextOrder = 0;
}

function materializeReplayEntry(entry: ReplayEntry): ReliableTransientReplaySnapshot {
  return {
    conversationId: entry.conversationId,
    turnId: entry.turnId,
    modelRequestId: entry.modelRequestId,
    requestSeq: entry.requestSeq,
    providerId: entry.providerId,
    modelId: entry.modelId,
    attemptSeq: entry.attemptSeq,
    socketGeneration: entry.socketGeneration,
    afterCommitSeq: entry.afterCommitSeq,
    headStreamSeq: entry.headStreamSeq,
    observedAt: entry.observedAt,
    events: [...entry.slots]
      .sort((left, right) => left.order - right.order)
      .map(materializeSlot)
  };
}

function materializeSlot(slot: ReplaySlot): ReliableKernelTransientBatchItem {
  if (slot.kind === 'event') return cloneBatchItem(slot.item, slot.firstFromStreamSeq);
  if (slot.kind === 'text') {
    return cloneBatchItem({
      ...slot.item,
      event: {
        ...slot.item.event,
        streamSeq: slot.firstStreamSeq,
        content: { ...slot.content, text: slot.chunks.join('') }
      }
    }, slot.firstFromStreamSeq);
  }
  return cloneBatchItem({
    ...slot.item,
    event: {
      ...slot.item.event,
      streamSeq: slot.firstStreamSeq,
      content: {
        ...slot.content,
        calls: [{ ...slot.call, argumentsDelta: slot.chunks.join('') }]
      }
    }
  }, slot.firstFromStreamSeq);
}

function toBatchItem(event: ReliableAgentTransientEvent): ReliableKernelTransientBatchItem {
  return cloneBatchItem({
    turnId: event.turnId,
    modelRequestId: event.modelRequestId,
    requestSeq: event.requestSeq,
    providerId: event.providerId,
    modelId: event.modelId,
    attemptSeq: event.attemptSeq,
    socketGeneration: event.socketGeneration,
    afterCommitSeq: event.afterCommitSeq,
    fromStreamSeq: coveredFromStreamSeq(event),
    observedAt: event.observedAt,
    event: {
      kind: event.event.kind,
      streamSeq: decimal(event.event.streamSeq),
      content: toStructuredClonePlainData(event.event.content, 'transient replay content'),
      ...(event.event.usage === undefined
        ? {}
        : { usage: toStructuredClonePlainData(event.event.usage, 'transient replay usage') }),
      ...(event.event.timing ? { timing: { ...event.event.timing } } : {})
    }
  }, coveredFromStreamSeq(event));
}

function coveredFromStreamSeq(event: ReliableAgentTransientEvent): string {
  return decimal(event.fromStreamSeq ?? event.event.streamSeq);
}

function cloneBatchItem(
  item: ReliableKernelTransientBatchItem,
  fromStreamSeq: string
): ReliableKernelTransientBatchItem {
  return toStructuredClonePlainData({
    ...item,
    fromStreamSeq,
    event: { ...item.event, streamSeq: item.event.streamSeq }
  }, 'transient replay item') as unknown as ReliableKernelTransientBatchItem;
}

function cloneTransientEvent(input: ReliableAgentTransientEvent): ReliableAgentTransientEvent {
  return {
    ...input,
    event: {
      ...input.event,
      streamSeq: decimal(input.event.streamSeq),
      content: toStructuredClonePlainData(input.event.content, 'transient event content') as never,
      ...(input.event.usage === undefined
        ? {}
        : { usage: toStructuredClonePlainData(input.event.usage, 'transient event usage') as never }),
      ...(input.event.timing ? { timing: { ...input.event.timing } } : {})
    }
  };
}

function replayKey(event: ReliableAgentTransientEvent): string {
  return replayIdentityKey(event.modelRequestId, event.attemptSeq, event.socketGeneration);
}

function replayIdentityKey(modelRequestId: string, attemptSeq: string, socketGeneration: string): string {
  return `${modelRequestId}\0${attemptSeq}\0${socketGeneration}`;
}

function compareAttemptIdentity(
  existing: Pick<ReplayEntry, 'attemptSeq' | 'socketGeneration'>,
  incoming: Pick<ReliableAgentTransientEvent, 'attemptSeq' | 'socketGeneration'>
): number {
  const attempt = BigInt(existing.attemptSeq) - BigInt(incoming.attemptSeq);
  if (attempt !== 0n) return attempt > 0n ? 1 : -1;
  const socket = BigInt(existing.socketGeneration) - BigInt(incoming.socketGeneration);
  return socket === 0n ? 0 : socket > 0n ? 1 : -1;
}

function outputItemIdentity(value: PlainData | undefined): string | undefined {
  const item = record(value);
  const id = text(item?.id);
  const ordinal = item?.ordinal;
  if (!id || (typeof ordinal !== 'number' && typeof ordinal !== 'string')) return undefined;
  return `${id}\0${String(ordinal)}`;
}

function record(value: unknown): Record<string, PlainData> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, PlainData>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function decimal(value: string | bigint): string {
  const result = String(value);
  if (!/^(?:0|[1-9]\d*)$/.test(result)) throw new TypeError('Transient stream sequence must be decimal.');
  return result;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
