<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { IconAlertCircle, IconX } from '@tabler/icons-vue';
import type { NativeSteeringReceipt } from '@shared/openAIResponsesNative';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useChat } from '@webview/composables/useChat';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import {
  STEERING_DISMISSAL_STATE_KEY,
  nextSteeringSuccessExpiry,
  persistSteeringDismissal,
  readSteeringDismissals,
  steeringReceiptDismissKey,
  type SteeringDismissalState,
  steeringReceiptPresentation,
  steeringReceiptVersion,
  steeringStatusSessionKey,
  visibleSteeringReceipts
} from '@webview/composables/steeringReceipts';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';

const { currentSteeringReceipts, currentSteeringFailure, dismissSteeringFailure } = useChat();
const reliableConversation = useReliableConversation();
const listScroller = ref<HTMLElement | null>(null);
const now = ref(Date.now());
const dismissedReceiptVersions = ref<Record<string, string>>({});
const statusReadError = ref('');
const requestedStatusSessions = new Set<string>();
const pendingStatusCommands = new Map<string, string>();
const statusCommandIds = new Set<string>();
let successTimer: ReturnType<typeof setTimeout> | undefined;

const conversationId = computed(() => reliableConversation.conversationId.value);
const dismissalState: SteeringDismissalState = {
  read: () => bridge.readPersistedState(STEERING_DISMISSAL_STATE_KEY),
  write: (value) => bridge.writePersistedState(STEERING_DISMISSAL_STATE_KEY, value)
};
// Terminal receipts the user closed stay closed after a reload of this view.
watch(conversationId, (id) => {
  if (id) dismissedReceiptVersions.value = { ...dismissedReceiptVersions.value, ...readSteeringDismissals(dismissalState, id) };
}, { immediate: true });
const receipts = computed(() => visibleSteeringReceipts(
  currentSteeringReceipts.value,
  now.value,
  dismissedReceiptVersions.value
).slice(0, 8));
const failure = computed(() => {
  const candidate = currentSteeringFailure.value;
  if (candidate?.commandId && (
    statusCommandIds.has(candidate.commandId)
    || currentSteeringReceipts.value.some((receipt) =>
      receipt.submissionId === candidate.commandId && receipt.state === 'failed')
  )) return undefined;
  return candidate;
});

/** status 仅读取已持久化回执；Host feed session 更新时必须从新 Host 再读一次。 */
function refreshReceipts(): void {
  const id = conversationId.value.trim();
  const sessionId = reliableConversation.feed.sessionId;
  if (!id || !sessionId) return;
  const key = steeringStatusSessionKey(id, sessionId);
  let commandId: string | undefined;
  try {
    commandId = `steering-status-${globalThis.crypto.randomUUID()}`;
    requestedStatusSessions.add(key);
    pendingStatusCommands.set(commandId, key);
    statusCommandIds.add(commandId);
    statusReadError.value = '';
    bridge.request(BridgeMessageType.TurnSteer, {
      action: 'status',
      conversationId: id,
      command: { commandId, expectedVersion: 0, issuedAt: Date.now() }
    }, { requestId: commandId });
  } catch {
    requestedStatusSessions.delete(key);
    if (commandId) {
      pendingStatusCommands.delete(commandId);
      statusCommandIds.delete(commandId);
    }
    statusReadError.value = '回执读取失败';
  }
}

const stopStatusResults = bridge.on(BridgeMessageType.TurnSteerResult, ({ payload }) => {
  const commandId = payload?.commandId;
  if (!commandId) return;
  const statusKey = pendingStatusCommands.get(commandId);
  if (!statusKey) return;
  pendingStatusCommands.delete(commandId);
  const sessionId = reliableConversation.feed.sessionId;
  if (!sessionId || statusKey !== steeringStatusSessionKey(conversationId.value, sessionId)) return;
  statusReadError.value = payload.error
    ? `回执读取失败：${payload.error}`
    : '';
});

watch(
  [conversationId, () => reliableConversation.feed.sessionId],
  ([id, sessionId], previous) => {
    if (previous && id !== previous[0]) statusReadError.value = '';
    if (!id || !sessionId || requestedStatusSessions.has(steeringStatusSessionKey(id, sessionId))) return;
    refreshReceipts();
  },
  { immediate: true }
);

function scheduleSuccessExit(): void {
  if (successTimer !== undefined) clearTimeout(successTimer);
  now.value = Date.now();
  const deadline = nextSteeringSuccessExpiry(
    currentSteeringReceipts.value,
    now.value,
    dismissedReceiptVersions.value
  );
  if (deadline === undefined) return;
  successTimer = setTimeout(() => {
    successTimer = undefined;
    scheduleSuccessExit();
  }, Math.min(Math.max(1, deadline - now.value), 2_147_483_647));
}

watch([conversationId, currentSteeringReceipts], scheduleSuccessExit, { immediate: true });
onBeforeUnmount(() => {
  if (successTimer !== undefined) clearTimeout(successTimer);
  stopStatusResults();
  pendingStatusCommands.clear();
});

function presentation(receipt: NativeSteeringReceipt) {
  return steeringReceiptPresentation(receipt, currentSteeringReceipts.value);
}

function receiptDetail(receipt: NativeSteeringReceipt): string {
  return receipt.state === 'failed' ? receipt.message?.trim() || '' : '';
}

function dismissReceipt(receipt: NativeSteeringReceipt): void {
  dismissedReceiptVersions.value = {
    ...dismissedReceiptVersions.value,
    [steeringReceiptDismissKey(receipt)]: steeringReceiptVersion(receipt)
  };
  persistSteeringDismissal(dismissalState, receipt);
}

function formatTime(value: number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';
}
</script>

<template>
  <section v-if="receipts.length > 0 || failure || statusReadError" class="steering-status" aria-label="转向回执状态">
    <div class="steering-status-title">转向回执</div>

    <div v-if="failure" class="steering-status-error" role="alert">
      <IconAlertCircle :size="14" stroke="2" aria-hidden="true" />
      <span>{{ failure.message }}</span>
      <button type="button" aria-label="关闭转向失败提示" @click="dismissSteeringFailure">
        <IconX :size="13" stroke="2" aria-hidden="true" />
      </button>
    </div>

    <div v-if="statusReadError" class="steering-status-error" role="alert">
      <IconAlertCircle :size="14" stroke="2" aria-hidden="true" />
      <span>{{ statusReadError }}</span>
      <button type="button" class="steering-status-action" @click="refreshReceipts">重试</button>
      <button type="button" aria-label="关闭回执读取失败提示" @click="statusReadError = ''">
        <IconX :size="13" stroke="2" aria-hidden="true" />
      </button>
    </div>

    <div v-if="receipts.length > 0" class="steering-status-list-shell">
      <ol ref="listScroller" class="steering-status-list">
        <li
          v-for="receipt in receipts"
          :key="receipt.submissionId"
          class="steering-status-item"
          :class="`is-${receipt.state}`"
        >
          <span class="steering-state-chip">{{ presentation(receipt).label }}</span>
          <span v-if="receiptDetail(receipt)" class="steering-state-detail">{{ receiptDetail(receipt) }}</span>
          <span class="steering-state-time">{{ formatTime(receipt.updatedAt) }}</span>
          <button
            v-if="presentation(receipt).dismissible"
            type="button"
            class="steering-item-close"
            :aria-label="`关闭${presentation(receipt).label}提示`"
            @click="dismissReceipt(receipt)"
          >
            <IconX :size="13" stroke="2" aria-hidden="true" />
          </button>
        </li>
      </ol>
      <AdvancedScrollbar :scroller="listScroller" :refresh-key="receipts.length" variant="minimal" />
    </div>
  </section>
</template>

<style scoped>
.steering-status {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  background: var(--vscode-sideBar-background, transparent);
}

.steering-status-title {
  font-size: var(--font-size-xs);
  color: var(--vscode-foreground);
}

.steering-status-error {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.steering-status-error { color: var(--vscode-errorForeground); }

.steering-status-error span { flex: 1 1 auto; }

.steering-status button {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  padding: 1px 3px;
  cursor: pointer;
}

.steering-status button:hover,
.steering-status button:focus-visible {
  border-color: var(--vscode-panel-border);
  background: var(--vscode-list-hoverBackground);
}

.steering-status-action { text-decoration: underline; }

.steering-status-list-shell {
  position: relative;
  max-height: 132px;
  overflow: hidden;
}

.steering-status-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  max-height: 132px;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
  scrollbar-width: none;
}

.steering-status-list::-webkit-scrollbar { display: none; }

.steering-status-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--vscode-descriptionForeground);
}

.steering-state-chip {
  flex: 0 0 auto;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-1);
  color: var(--vscode-foreground);
  line-height: 1.6;
}

.steering-status-item.is-failed .steering-state-chip,
.steering-status-item.is-delivery_unknown .steering-state-chip {
  color: var(--vscode-errorForeground);
}

.steering-state-detail {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.steering-state-time { flex: 0 0 auto; }
</style>
