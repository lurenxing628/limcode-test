import { dispatchUserScrollIntent } from '@webview/composables/scrollIntent';

export interface ScrollAnchor {
  anchorId: string;
  offsetTop: number;
  /** Feedback controls stay fully visible; timeline rows keep their exact reading offset. */
  alignment?: 'nearest';
}

/** Capture a visible message, not a previous request's pending history id. */
export function captureScrollAnchor(options: {
  scroller: HTMLElement | null;
  visibleRows: readonly { id: string }[];
}): ScrollAnchor | null {
  const { scroller, visibleRows } = options;
  if (!scroller) return null;
  const viewport = scroller.getBoundingClientRect();
  const ids = new Set(visibleRows.map(row => row.id));
  for (const row of scroller.querySelectorAll<HTMLElement>('[data-timeline-row-key]')) {
    const id = row.dataset.timelineRowKey;
    if (!id || !ids.has(id)) continue;
    const rect = row.getBoundingClientRect();
    if (rect.bottom > viewport.top && rect.top < viewport.bottom) {
      return { anchorId: id, offsetTop: rect.top - viewport.top };
    }
  }
  return null;
}

export function releaseStickyFromUserScroll(scroller: HTMLElement | null): void {
  if (scroller) dispatchUserScrollIntent(scroller, { direction: 'toward-start', source: 'scrollAnchor' });
}

/** Call after Vue has patched the new history window. Native browser anchoring is respected. */
export function restoreScrollAfterHistoryLoad(options: {
  scroller: HTMLElement | null;
  anchor: ScrollAnchor | null;
}): boolean {
  const { scroller, anchor } = options;
  if (!scroller || !anchor) return false;
  const row = [...scroller.querySelectorAll<HTMLElement>('[data-timeline-row-key], [data-scroll-anchor-key]')]
    .find(candidate => (candidate.dataset.timelineRowKey ?? candidate.dataset.scrollAnchorKey) === anchor.anchorId);
  if (!row) return false;
  const viewport = scroller.getBoundingClientRect();
  const bounds = row.getBoundingClientRect();
  const delta = anchor.alignment === 'nearest'
    ? bounds.height > viewport.height || bounds.top < viewport.top
      ? bounds.top - viewport.top
      : Math.max(0, bounds.bottom - viewport.bottom)
    : bounds.top - viewport.top - anchor.offsetTop;
  const target = Math.max(0, Math.min(
    scroller.scrollTop + delta,
    scroller.scrollHeight - scroller.clientHeight
  ));
  if (Math.abs(scroller.scrollTop - target) > 1) scroller.scrollTop = target;
  return true;
}
