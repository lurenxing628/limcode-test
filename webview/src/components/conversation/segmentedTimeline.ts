/** A bounded render window keeps even 10,000-floor conversations at roughly constant DOM cost. */
export const TIMELINE_MOUNT_LIMIT = 30;
export const TIMELINE_SEGMENT_STEP = 20;
export const PENDING_TIMELINE_MOUNT_LIMIT = 8;
/** The newest rows hydrate ahead of the rest of the mounted segment. */
export const TIMELINE_FOREGROUND_DETAIL_LIMIT = 8;

export type SegmentedTimelineRow<Message extends { id: string }, Card extends { messageId: string }> =
  | { kind: 'message'; id: string; message: Message }
  | { kind: 'collaboration'; id: string; card: Card };

/**
 * Collaboration envelopes occupy real, independently keyed rows in the same bounded window as
 * Message rows. Their ids and count do not become Message ids, Message floors or detail demands.
 * A Turn group follows its last loaded Message; unlocated cards occupy their own tail rows.
 */
export function composeTimelineRows<Message extends { id: string }, Card extends { messageId: string }>(
  messages: readonly Message[],
  collaboration: { afterMessage: Readonly<Record<string, readonly Card[]>>; unlocated: readonly Card[] }
): Array<SegmentedTimelineRow<Message, Card>> {
  const rows: Array<SegmentedTimelineRow<Message, Card>> = [];
  const appendCard = (card: Card): void => {
    rows.push({ kind: 'collaboration', id: `collaboration:${card.messageId}`, card });
  };
  for (const message of messages) {
    rows.push({ kind: 'message', id: message.id, message });
    for (const card of collaboration.afterMessage[message.id] ?? []) appendCard(card);
  }
  for (const card of collaboration.unlocated) appendCard(card);
  return rows;
}

export interface TimelineDetailDemand {
  critical: string[];
  visible: string[];
  background: string[];
}

/**
 * Detail requests are emitted newest-first. In particular, the last row gets its own critical
 * request before any other mounted body can occupy one of the four transport slots.
 */
export function prioritizedTimelineDetailDemand(messageIds: readonly string[]): TimelineDetailDemand {
  const ids = messageIds.filter((id) => id.length > 0);
  const latest = ids[ids.length - 1];
  if (!latest) return { critical: [], visible: [], background: [] };
  const foregroundStart = Math.max(0, ids.length - TIMELINE_FOREGROUND_DETAIL_LIMIT);
  return {
    critical: [latest],
    visible: ids.slice(foregroundStart, -1).reverse(),
    background: ids.slice(0, foregroundStart).reverse()
  };
}

export function clampTimelineSegmentStart(totalRows: number, requestedStart: number): number {
  if (!Number.isSafeInteger(totalRows) || totalRows < 0) throw new RangeError('totalRows must be non-negative.');
  if (!Number.isSafeInteger(requestedStart)) throw new RangeError('requestedStart must be an integer.');
  return Math.max(0, Math.min(requestedStart, Math.max(0, totalRows - TIMELINE_MOUNT_LIMIT)));
}

export function latestTimelineSegmentStart(totalRows: number): number {
  return clampTimelineSegmentStart(totalRows, totalRows - TIMELINE_MOUNT_LIMIT);
}

export function mountedTimelineRowCount(totalRows: number, pendingRows = 0): number {
  return Math.min(totalRows, TIMELINE_MOUNT_LIMIT) + Math.min(pendingRows, PENDING_TIMELINE_MOUNT_LIMIT);
}

/**
 * The reliable snapshot intentionally contains only the newest bounded message window. Its local
 * array index therefore stops being the transcript floor once a conversation exceeds that window.
 */
export function absoluteTimelineFloor(messageSeq: number, fallbackFloor: number): number {
  if (Number.isFinite(messageSeq) && messageSeq > 0) {
    const projectedFloor = Math.ceil(messageSeq);
    if (Number.isSafeInteger(projectedFloor)) return projectedFloor;
  }
  if (!Number.isSafeInteger(fallbackFloor) || fallbackFloor <= 0) {
    throw new RangeError('fallbackFloor must be a positive integer.');
  }
  return fallbackFloor;
}
