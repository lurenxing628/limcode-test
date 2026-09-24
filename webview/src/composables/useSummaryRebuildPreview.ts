import { onBeforeUnmount, ref } from 'vue';
import { bridge, BridgeMessageType } from '@webview/transport';
import type { SummaryRebuildPreviewState } from '@webview/components/input/summaryRebuildPreview';

/**
 * Read-only estimate for the rebuild dialog. Only the answer to the latest request is shown; an
 * answer for a dialog that was closed or reopened in the meantime is ignored.
 */
export function useSummaryRebuildPreview() {
  const state = ref<SummaryRebuildPreviewState>();
  let pendingRequestId: string | undefined;

  const stopResult = bridge.on(BridgeMessageType.CompressionRebuildPreviewResult, (message) => {
    if (!pendingRequestId || message.correlationId !== pendingRequestId || !message.payload) return;
    pendingRequestId = undefined;
    state.value = { status: 'loaded', result: message.payload };
  });
  const stopError = bridge.on(BridgeMessageType.Error, (message) => {
    if (!pendingRequestId || message.correlationId !== pendingRequestId) return;
    pendingRequestId = undefined;
    state.value = { status: 'failed', message: message.payload?.message ?? '' };
  });
  onBeforeUnmount(() => {
    stopResult();
    stopError();
  });

  function request(conversationId: string, expectedRootId: string): void {
    state.value = { status: 'loading' };
    pendingRequestId = bridge.request(BridgeMessageType.CompressionRebuildPreviewGet, {
      conversationId: String(conversationId),
      expectedRootId: String(expectedRootId)
    });
  }

  function reset(): void {
    pendingRequestId = undefined;
    state.value = undefined;
  }

  return { state, request, reset };
}
