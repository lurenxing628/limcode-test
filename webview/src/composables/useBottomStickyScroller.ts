import { nextTick, onBeforeUnmount, readonly, ref, watch, type Ref } from 'vue';
import { dispatchUserScrollIntent, USER_SCROLL_INTENT_EVENT, userScrollIntentDetail } from './scrollIntent';

export interface BottomStickyScrollerOptions {
  /** 距离底部多少像素内视为“贴底”。 */
  thresholdPx?: number;
  /** 内容高度变化后继续贴底的时间，用于覆盖折叠/流式动画。 */
  settleMs?: number;
  /** 折叠/展开等显式内容高度交互前，允许稍大的预吸附误差。 */
  interactionThresholdPx?: number;
  /** 用户主动离开底部后，需要回到底部多少像素内才恢复自动吸附。 */
  reattachThresholdPx?: number;
  /** 用户主动上滚后，多少毫秒内禁止“仍在近底”状态自动恢复吸附。 */
  reattachDelayMs?: number;
}

export interface BottomStickyScroller {
  scrollToBottom: () => void;
  scrollToBottomNow: () => void;
  isNearBottom: () => boolean;
  isStickyToBottom: () => boolean;
  stickyToBottom: Readonly<Ref<boolean>>;
}

interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

const DEFAULT_THRESHOLD_PX = 24;
const DEFAULT_INTERACTION_THRESHOLD_PX = 96;
const DEFAULT_REATTACH_THRESHOLD_PX = 1;
const DEFAULT_REATTACH_DELAY_MS = 800;
const DEFAULT_SETTLE_MS = 0;
const TOUCH_END_EVENTS = ['touchend', 'touchcancel', 'pointerup'] as const;

/**
 * 统一管理滚动容器的底部粘滞行为。
 *
 * 只要用户当前贴近底部，后续任何内容高度变化都会保持滚动到底部：
 * - 新消息/流式正文文本增长
 * - 流式思考文本增长
 * - 思考/工具调用等折叠块展开收起
 * - 图片/附件等异步尺寸变化
 *
 * 内容组件不需要单独维护滚动行为，只负责渲染自身内容。
 */
export function useBottomStickyScroller(
  scroller: Ref<HTMLElement | null>,
  options: BottomStickyScrollerOptions = {}
): BottomStickyScroller {
  const thresholdPx = options.thresholdPx ?? DEFAULT_THRESHOLD_PX;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const interactionThresholdPx = Math.max(
    thresholdPx,
    options.interactionThresholdPx ?? DEFAULT_INTERACTION_THRESHOLD_PX
  );
  const reattachThresholdPx = Math.max(0, options.reattachThresholdPx ?? DEFAULT_REATTACH_THRESHOLD_PX);
  const reattachDelayMs = Math.max(0, options.reattachDelayMs ?? DEFAULT_REATTACH_DELAY_MS);

  let observedScroller: HTMLElement | null = null;
  let observedContent: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | undefined;
  let mutationObserver: MutationObserver | undefined;
  const stickyToBottom = ref(true);
  let scrollFrame: number | undefined;
  let contentCheckPending = false;
  let stickyUntil = 0;
  let userDetachedFromBottom = false;
  let reattachLockedUntil = 0;
  let lastMetrics: ScrollMetrics | undefined;
  let touchActive = false;

  function distanceFromBottom(metrics: ScrollMetrics): number {
    return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  }

  function metricsForElement(element: HTMLElement): ScrollMetrics {
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight
    };
  }

  function isNearBottomMetrics(metrics: ScrollMetrics, threshold = thresholdPx): boolean {
    return distanceFromBottom(metrics) <= threshold;
  }

  function rememberScrollMetrics(element = scroller.value): void {
    if (!element) return;
    lastMetrics = metricsForElement(element);
  }

  function wasNearBottomBeforeCurrentLayout(threshold = interactionThresholdPx): boolean {
    return lastMetrics !== undefined && isNearBottomMetrics(lastMetrics, threshold);
  }

  function isNearBottomElement(element: HTMLElement, threshold = thresholdPx): boolean {
    return isNearBottomMetrics(metricsForElement(element), threshold);
  }

  function isNearBottom(): boolean {
    const element = scroller.value;
    return !element || isNearBottomElement(element);
  }

  function isStickyToBottom(): boolean {
    return stickyToBottom.value;
  }

  function cancelScrollFrame(): void {
    if (scrollFrame !== undefined) window.cancelAnimationFrame(scrollFrame);
    scrollFrame = undefined;
    contentCheckPending = false;
  }

  function canAutoReattach(): boolean {
    return performance.now() >= reattachLockedUntil;
  }

  function releaseStickyFromUserIntent(): void {
    stickyToBottom.value = false;
    userDetachedFromBottom = true;
    stickyUntil = 0;
    reattachLockedUntil = performance.now() + reattachDelayMs;
    cancelScrollFrame();
    rememberScrollMetrics();
  }

  function scrollToBottomNow(): void {
    stickyToBottom.value = true;
    userDetachedFromBottom = false;
    reattachLockedUntil = 0;

    const element = scroller.value;
    if (element) {
      const target = Math.max(0, element.scrollHeight - element.clientHeight);
      if (Math.abs(element.scrollTop - target) > 1) element.scrollTop = target;
      rememberScrollMetrics(element);
    }
  }

  function scrollToBottom(): void {
    void nextTick(scrollToBottomNow);
  }

  function updateStickyFromUserScroll(): void {
    const element = scroller.value;
    if (!element) {
      stickyToBottom.value = true;
      userDetachedFromBottom = false;
      return;
    }

    const currentMetrics = metricsForElement(element);
    // Touch and pen scrolling produce no wheel event, and remote touch may deliver no touchmove once
    // panning starts. An upward scroll while a finger is down is the user's; without this a swipe up
    // looked like layout drift and was pulled back to the bottom every frame. Downward moves are
    // left alone: following new content also scrolls down while a finger merely rests on the page.
    if (touchActive && lastMetrics && currentMetrics.scrollTop < lastMetrics.scrollTop - 1) {
      dispatchUserScrollIntent(element, { direction: 'toward-start', source: 'touch' });
    }
    if (userDetachedFromBottom) {
      if (canAutoReattach() && isNearBottomMetrics(currentMetrics, reattachThresholdPx)) {
        stickyToBottom.value = true;
        userDetachedFromBottom = false;
        reattachLockedUntil = 0;
      } else {
        stickyToBottom.value = false;
        lastMetrics = currentMetrics;
        return;
      }
    }

    const nearBottom = isNearBottomMetrics(currentMetrics);
    if (nearBottom) {
      stickyToBottom.value = true;
      userDetachedFromBottom = false;
      lastMetrics = currentMetrics;
      return;
    }

    const grewFromPreviousBottom = lastMetrics !== undefined
      && isNearBottomMetrics(lastMetrics, thresholdPx)
      && currentMetrics.scrollHeight > lastMetrics.scrollHeight + 1
      && Math.abs(currentMetrics.scrollTop - lastMetrics.scrollTop) <= 2;
    if (stickyToBottom.value || grewFromPreviousBottom || wasNearBottomBeforeCurrentLayout(thresholdPx)) {
      stickyToBottom.value = true;
      keepStickyDuringContentSettle();
      return;
    }

    stickyToBottom.value = false;
    lastMetrics = currentMetrics;
  }

  function handleWheel(event: WheelEvent): void {
    if (event.deltaY !== 0) dispatchUserScrollIntent(scroller.value, {
      direction: event.deltaY < 0 ? 'toward-start' : 'toward-end', source: 'wheel'
    });
  }

  function handleTouchStart(): void {
    touchActive = true;
  }

  function handlePointerDown(event: PointerEvent): void {
    // pointercancel arrives as soon as the browser takes over panning, so only pointerup ends contact.
    touchActive = event.pointerType !== 'mouse';
  }

  function handleTouchEnd(): void {
    touchActive = false;
  }

  function handleUserScrollIntent(event: Event): void {
    const detail = userScrollIntentDetail(event);
    if (!detail) return;

    if (detail.direction === 'toward-start' || detail.direction === 'jump-start') {
      releaseStickyFromUserIntent();
      return;
    }

    if (detail.direction !== 'jump-end') return;
    stickyToBottom.value = true;
    userDetachedFromBottom = false;
    reattachLockedUntil = 0;
    keepStickyDuringContentSettle();
  }

  function primeStickyFromBottomInteraction(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('[aria-expanded]')) return;

    const element = scroller.value;
    if (!element || !isNearBottomElement(element, interactionThresholdPx)) return;
    if (userDetachedFromBottom && !isNearBottomElement(element, reattachThresholdPx)) return;

    stickyToBottom.value = true;
    userDetachedFromBottom = false;
    scrollToBottomNow();
    keepStickyDuringContentSettle();
  }

  function handleKeyboardInteraction(event: KeyboardEvent): void {
    if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
      dispatchUserScrollIntent(scroller.value, {
        direction: event.key === 'Home' ? 'jump-start' : 'toward-start', source: 'keyboard'
      });
      return;
    }

    if (event.key === 'End') {
      dispatchUserScrollIntent(scroller.value, { direction: 'jump-end', source: 'keyboard' });
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'PageDown') {
      dispatchUserScrollIntent(scroller.value, { direction: 'toward-end', source: 'keyboard' });
      return;
    }

    if (event.key !== 'Enter' && event.key !== ' ') return;
    primeStickyFromBottomInteraction(event);
  }

  function keepStickyDuringContentSettle(): void {
    if (!stickyToBottom.value) return;
    scrollToBottomNow();
    stickyUntil = Math.max(stickyUntil, performance.now() + settleMs);
    scheduleScrollFrame();
  }

  function scheduleScrollFrame(): void {
    if (scrollFrame !== undefined) return;
    scrollFrame = window.requestAnimationFrame(runScrollFrame);
  }

  function runScrollFrame(): void {
    scrollFrame = undefined;
    if (contentCheckPending) {
      contentCheckPending = false;
      refreshObservedContentRoot();
      onContentMayHaveChanged();
    }

    if (stickyToBottom.value) scrollToBottomNow();
  }

  function onContentMayHaveChanged(): void {
    const element = scroller.value;
    if (!element) return;

    if (userDetachedFromBottom) {
      if (canAutoReattach() && isNearBottomElement(element, reattachThresholdPx)) {
        stickyToBottom.value = true;
        userDetachedFromBottom = false;
        reattachLockedUntil = 0;
      } else {
        rememberScrollMetrics(element);
        return;
      }
    }

    const wasSticky = stickyToBottom.value;
    const wasNearBottom = wasNearBottomBeforeCurrentLayout(thresholdPx);
    const nowNearBottom = isNearBottomElement(element);
    stickyToBottom.value = wasSticky || wasNearBottom || nowNearBottom;

    if (stickyToBottom.value) {
      keepStickyDuringContentSettle();
    } else {
      rememberScrollMetrics(element);
    }
  }

  function scheduleContentCheck(): void {
    contentCheckPending = true;
    scheduleScrollFrame();
  }

  function refreshObservedContentRoot(): void {
    if (!resizeObserver || !observedScroller) return;

    const nextContent = observedScroller.firstElementChild instanceof HTMLElement
      ? observedScroller.firstElementChild
      : null;
    if (nextContent === observedContent) return;

    if (observedContent) resizeObserver.unobserve(observedContent);
    observedContent = nextContent;
    if (observedContent) resizeObserver.observe(observedContent);
  }

  function attachScroller(element: HTMLElement | null): void {
    detachScroller();

    if (!element) {
      stickyToBottom.value = true;
      return;
    }

    observedScroller = element;
    // A newly mounted streaming/output pane may already contain enough buffered text to overflow
    // before observers attach. Treat that first mount as tail-following; subsequent user scroll
    // intent still detaches through the normal wheel/keyboard/scroll handlers.
    stickyToBottom.value = true;
    userDetachedFromBottom = false;
    reattachLockedUntil = 0;
    rememberScrollMetrics(element);
    element.addEventListener('scroll', updateStickyFromUserScroll, { passive: true });
    element.addEventListener('wheel', handleWheel, { passive: true });
    element.addEventListener('touchstart', handleTouchStart, { passive: true });
    element.addEventListener('pointerdown', handlePointerDown, { passive: true });
    for (const name of TOUCH_END_EVENTS) element.addEventListener(name, handleTouchEnd, { passive: true });
    element.addEventListener(USER_SCROLL_INTENT_EVENT, handleUserScrollIntent);
    element.addEventListener('pointerdown', primeStickyFromBottomInteraction, { capture: true });
    element.addEventListener('keydown', handleKeyboardInteraction, { capture: true });

    resizeObserver = new ResizeObserver(scheduleContentCheck);
    resizeObserver.observe(element);

    observedContent = element.firstElementChild instanceof HTMLElement ? element.firstElementChild : null;
    if (observedContent) resizeObserver.observe(observedContent);

    mutationObserver = new MutationObserver(scheduleContentCheck);
    mutationObserver.observe(element, {
      childList: true,
      characterData: true,
      subtree: true
    });

    scheduleContentCheck();
  }

  function detachScroller(): void {
    if (observedScroller) {
      observedScroller.removeEventListener('scroll', updateStickyFromUserScroll);
      observedScroller.removeEventListener('wheel', handleWheel);
      observedScroller.removeEventListener('touchstart', handleTouchStart);
      observedScroller.removeEventListener('pointerdown', handlePointerDown);
      for (const name of TOUCH_END_EVENTS) observedScroller.removeEventListener(name, handleTouchEnd);
      observedScroller.removeEventListener(USER_SCROLL_INTENT_EVENT, handleUserScrollIntent);
      observedScroller.removeEventListener('pointerdown', primeStickyFromBottomInteraction, { capture: true });
      observedScroller.removeEventListener('keydown', handleKeyboardInteraction, { capture: true });
    }
    observedScroller = null;
    observedContent = null;
    lastMetrics = undefined;
    touchActive = false;

    resizeObserver?.disconnect();
    resizeObserver = undefined;
    mutationObserver?.disconnect();
    mutationObserver = undefined;

    cancelScrollFrame();
  }

  watch(scroller, attachScroller, { immediate: true, flush: 'post' });
  onBeforeUnmount(detachScroller);

  return {
    scrollToBottom,
    scrollToBottomNow,
    isNearBottom,
    isStickyToBottom,
    stickyToBottom: readonly(stickyToBottom)
  };
}
