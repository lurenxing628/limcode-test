import type { WorldEvent } from '../ecs/types';
import {
  LlmEventType,
  type LlmDeltaPayload,
  type LlmDonePayload,
  type LlmErrorPayload,
  type LlmStreamAggregationMetrics,
  type LlmThoughtDeltaPayload,
  type LlmThoughtProgressPayload
} from '../world/modules/llm/events';
import type { Emit } from './types';

export const LLM_STREAM_EVENT_AGGREGATION_INTERVAL_MS = 32;
const DEFAULT_MAX_BATCH_EVENTS = 24;
const DEFAULT_MAX_BUFFERED_CHARS = 1_024;

export interface LlmStreamEventBatcherOptions {
  intervalMs?: number;
  maxBatchEvents?: number;
  maxBufferedChars?: number;
  now?: () => number;
  onTerminalMetrics?: (metrics: LlmStreamAggregationMetrics) => void;
  onDerived?: (event: WorldEvent, sources: readonly WorldEvent[]) => void;
}

export interface LlmStreamEventBatcher {
  emit: Emit;
  flush(): void;
  dispose(flush?: boolean): void;
  metrics(): LlmStreamAggregationMetrics;
}

interface PendingEvent {
  event: WorldEvent;
  eventCount: number;
  bufferedChars: number;
  queuedAt: number;
}

/**
 * 在 capability 边界按一个很短的时间窗合并相邻同类 delta。
 * 不跨正文/思考/进度/工具/终态边界，终态前同步 flush，因此不会改变语义顺序。
 */
export function createLlmStreamEventBatcher(
  sink: Emit,
  options: LlmStreamEventBatcherOptions = {}
): LlmStreamEventBatcher {
  const intervalMs = Math.max(0, options.intervalMs ?? LLM_STREAM_EVENT_AGGREGATION_INTERVAL_MS);
  const maxBatchEvents = Math.max(1, options.maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS);
  const maxBufferedChars = Math.max(1, options.maxBufferedChars ?? DEFAULT_MAX_BUFFERED_CHARS);
  const now = options.now ?? Date.now;
  let pending: PendingEvent | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let terminal = false;
  let rawDeltaEvents = 0;
  let emittedDeltaEvents = 0;
  let flushCount = 0;
  let observedMaxBatchEvents = 0;
  let observedMaxBufferedChars = 0;
  let maxBufferDelayMs = 0;

  const metrics = (): LlmStreamAggregationMetrics => ({
    intervalMs,
    rawDeltaEvents,
    emittedDeltaEvents,
    mergedDeltaEvents: Math.max(0, rawDeltaEvents - emittedDeltaEvents),
    flushCount,
    maxBatchEvents: observedMaxBatchEvents,
    maxBufferedChars: observedMaxBufferedChars,
    maxBufferDelayMs
  });

  const clearTimer = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const flush = (): void => {
    clearTimer();
    const current = pending;
    pending = undefined;
    if (!current) return;
    maxBufferDelayMs = Math.max(maxBufferDelayMs, Math.max(0, now() - current.queuedAt));
    emittedDeltaEvents += 1;
    flushCount += 1;
    sink(current.event);
  };

  const schedule = (): void => {
    if (timer !== undefined || intervalMs <= 0) {
      if (intervalMs <= 0) flush();
      return;
    }
    timer = setTimeout(flush, intervalMs);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  };

  const queueMergeable = (event: WorldEvent): void => {
    rawDeltaEvents += 1;
    const merged = pending ? mergeAdjacentDeltaEvents(pending.event, event) : undefined;
    if (!pending || !merged) {
      flush();
      const bufferedChars = eventTextLength(event);
      pending = { event, eventCount: 1, bufferedChars, queuedAt: now() };
    } else {
      try { options.onDerived?.(merged, [pending.event, event]); } catch { /* 观察不改变合并结果。 */ }
      pending = {
        ...pending,
        event: merged,
        eventCount: pending.eventCount + 1,
        bufferedChars: pending.bufferedChars + eventTextLength(event)
      };
    }
    observedMaxBatchEvents = Math.max(observedMaxBatchEvents, pending.eventCount);
    observedMaxBufferedChars = Math.max(observedMaxBufferedChars, pending.bufferedChars);
    if (pending.eventCount >= maxBatchEvents || pending.bufferedChars >= maxBufferedChars) flush();
    else schedule();
  };

  const emit: Emit = (event) => {
    if (disposed || terminal) return;
    if (isMergeableDeltaEvent(event)) {
      queueMergeable(event);
      return;
    }

    flush();
    if (event.type === LlmEventType.Done || event.type === LlmEventType.Error) {
      terminal = true;
      const snapshot = metrics();
      const payload = event.payload as LlmDonePayload | LlmErrorPayload;
      sink({ type: LlmEventType.ToolCallPreviewDone, payload: { requestId: payload.requestId, all: true } });
      const completed = { ...event, payload: { ...payload, streamAggregation: snapshot } };
      try { options.onDerived?.(completed, [event]); } catch { /* 观察不改变终态。 */ }
      sink(completed);
      options.onTerminalMetrics?.(snapshot);
      return;
    }
    sink(event);
  };

  return {
    emit,
    flush,
    dispose(flushPending = true) {
      if (disposed) return;
      if (flushPending && !terminal) flush();
      else clearTimer();
      pending = undefined;
      disposed = true;
    },
    metrics
  };
}

function isMergeableDeltaEvent(event: WorldEvent): boolean {
  return event.type === LlmEventType.Delta
    || event.type === LlmEventType.ThoughtDelta
    || event.type === LlmEventType.ThoughtProgress;
}

function mergeAdjacentDeltaEvents(previous: WorldEvent, next: WorldEvent): WorldEvent | undefined {
  if (previous.type !== next.type) return undefined;
  const previousPayload = previous.payload as LlmDeltaPayload | LlmThoughtDeltaPayload | LlmThoughtProgressPayload;
  const nextPayload = next.payload as LlmDeltaPayload | LlmThoughtDeltaPayload | LlmThoughtProgressPayload;
  if (!sameStreamIdentity(previousPayload, nextPayload)) return undefined;

  if (previous.type === LlmEventType.Delta) {
    // 带签名的文字就是收到签名的那个 part，既不并入前面的文字，也不吸收后面的文字。
    if ((previousPayload as LlmDeltaPayload).thoughtSignature || (nextPayload as LlmDeltaPayload).thoughtSignature) {
      return undefined;
    }
    return {
      ...next,
      payload: {
        ...(previousPayload as LlmDeltaPayload),
        ...(nextPayload as LlmDeltaPayload),
        text: (previousPayload as LlmDeltaPayload).text + (nextPayload as LlmDeltaPayload).text
      }
    };
  }

  if (previous.type === LlmEventType.ThoughtDelta) {
    const left = previousPayload as LlmThoughtDeltaPayload;
    const right = nextPayload as LlmThoughtDeltaPayload;
    if (left.thoughtSignature !== right.thoughtSignature) return undefined;
    return {
      ...next,
      payload: {
        ...left,
        ...right,
        text: left.text + right.text,
        ...(left.thoughtElapsedMs !== undefined || right.thoughtElapsedMs !== undefined
          ? { thoughtElapsedMs: Math.max(left.thoughtElapsedMs ?? 0, right.thoughtElapsedMs ?? 0) }
          : {})
      }
    };
  }

  const left = previousPayload as LlmThoughtProgressPayload;
  const right = nextPayload as LlmThoughtProgressPayload;
  if (left.thoughtSignature !== right.thoughtSignature) return undefined;
  return { ...next, payload: { ...left, ...right, thoughtElapsedMs: Math.max(left.thoughtElapsedMs, right.thoughtElapsedMs) } };
}

function sameStreamIdentity(
  left: LlmDeltaPayload | LlmThoughtDeltaPayload | LlmThoughtProgressPayload,
  right: LlmDeltaPayload | LlmThoughtDeltaPayload | LlmThoughtProgressPayload
): boolean {
  return left.requestId === right.requestId
    && left.attemptId === right.attemptId
    && left.generation === right.generation
    && outputItemIdentity(left) === outputItemIdentity(right)
    && left.streamSeq === undefined
    && right.streamSeq === undefined;
}

function outputItemIdentity(value: { outputItem?: unknown }): string {
  const outputItem = value.outputItem;
  if (!outputItem || typeof outputItem !== 'object' || Array.isArray(outputItem)) return '';
  const id = (outputItem as { id?: unknown }).id;
  return typeof id === 'string' ? id : '';
}

function eventTextLength(event: WorldEvent): number {
  const payload = event.payload as Partial<LlmDeltaPayload | LlmThoughtDeltaPayload>;
  return typeof payload.text === 'string' ? payload.text.length : 0;
}
