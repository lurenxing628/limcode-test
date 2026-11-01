import { onBeforeUnmount, watch, type Ref } from 'vue';

const SWAP_HEIGHT_DURATION_MS = 180;

/**
 * 同一位置把一块内容换成高度不同的另一块（例如工具参数预览换成一行工具卡）时，
 * 让外壳高度从旧值过渡到新值，而不是一帧之内跳变。每次切换只读两次高度、跑一次 CSS 过渡，
 * 过渡结束即清掉内联样式；用户开启“减少动态效果”时直接跳到新高度。
 */
export function useSwapHeightTransition(target: Ref<HTMLElement | null>, swapKey: () => unknown): void {
  let fromHeight = 0;
  let cleanup: (() => void) | undefined;

  watch(swapKey, () => {
    cleanup?.();
    fromHeight = target.value?.offsetHeight ?? 0;
  }, { flush: 'pre' });

  watch(swapKey, () => {
    const element = target.value;
    if (!element || fromHeight <= 0 || prefersReducedMotion()) return;
    const toHeight = element.offsetHeight;
    if (Math.abs(toHeight - fromHeight) < 2) return;
    element.style.height = `${fromHeight}px`;
    element.style.overflow = 'hidden';
    void element.offsetHeight;
    element.style.transition = `height ${SWAP_HEIGHT_DURATION_MS}ms ease`;
    element.style.height = `${toHeight}px`;
    const timer = window.setTimeout(finish, SWAP_HEIGHT_DURATION_MS + 60);
    element.addEventListener('transitionend', finish);
    function finish(event?: Event): void {
      if (event && event.target !== element) return;
      window.clearTimeout(timer);
      element!.removeEventListener('transitionend', finish);
      element!.style.height = '';
      element!.style.overflow = '';
      element!.style.transition = '';
      cleanup = undefined;
    }
    cleanup = finish;
  }, { flush: 'post' });

  onBeforeUnmount(() => cleanup?.());
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
