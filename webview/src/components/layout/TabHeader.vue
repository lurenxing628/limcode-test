<script setup lang="ts">
import { computed } from 'vue';
import { displayConversationTitle, hasExplicitConversationTitle } from '@shared/conversationTitle';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useSessionStore } from '@webview/stores/useSessionStore';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import HoverTooltipPanel from '@webview/components/ui/HoverTooltipPanel.vue';

const clientState = useClientStateStore();
const session = useSessionStore();
const reliableConversation = useReliableConversation();
const conversationId = reliableConversation.conversationId;
const records = computed(() => reliableConversation.feed.records);
const conversation = computed(() => {
  const id = conversationId.value;
  return id ? records.value.Conversation?.[id] : undefined;
});
const activeTurn = computed(() => Object.values(records.value.Turn ?? {}).find((turn) =>
  turn.conversation_id === conversationId.value && turn.status === 'active'
));
const activeTurnId = computed(() => typeof activeTurn.value?.id === 'string' ? activeTurn.value.id : '');
const activeToolCalls = computed(() => Object.values(records.value.ToolCall ?? {})
  .filter((call) => call.turn_id === activeTurnId.value && call.status !== 'terminal')
  .sort(compareCreatedAt));
const pendingInteractions = computed(() => {
  const requestIds = new Set(Object.values(records.value.InteractionOwnerLink ?? {})
    .filter((link) => link.turn_id === activeTurnId.value)
    .map((link) => link.request_id));
  return Object.values(records.value.InteractionRequest ?? {})
    .filter((request) => requestIds.has(request.id) && request.status === 'pending');
});
const latestModelRequest = computed(() => Object.values(records.value.ModelRequest ?? {})
  .filter((request) => request.turn_id === activeTurnId.value)
  .sort((left, right) => integer(right.request_seq) - integer(left.request_seq))[0]);
const title = computed(() => {
  const id = conversationId.value;
  if (!id) return '正在初始化对话…';
  const rawTitle = typeof conversation.value?.title === 'string' ? conversation.value.title : undefined;
  if (hasExplicitConversationTitle(rawTitle, id)) {
    return displayConversationTitle({
      id,
      title: rawTitle,
      fallbackTitle: session.conversationTitle
    });
  }
  const messages = reliableConversation.projection.value.messages;
  // The client feed keeps only a bounded tail. A tail-local "first" user message is not the
  // conversation's canonical first user message, so defer to the Host projection unless seq=1 is present.
  const includesConversationStart = messages.length === 0 || messages.some((message) => message.seq === 1);
  return displayConversationTitle({
    id,
    title: rawTitle,
    messages: includesConversationStart ? messages : undefined,
    fallbackTitle: session.conversationTitle
  });
});
const agentName = computed(() => {
  const link = Object.values(records.value.AgentConversationLink ?? {}).find((candidate) =>
    candidate.conversation_id === conversationId.value && candidate.role === 'default'
  ) ?? Object.values(records.value.AgentConversationLink ?? {}).find((candidate) =>
    candidate.conversation_id === conversationId.value
  );
  return clientState.agents.find((agent) => agent.id === link?.agent_id)?.name ?? '当前 Agent';
});
const statusLabel = computed(() => {
  if (!activeTurn.value) return '空闲';
  if (pendingInteractions.value.length > 0) return '等待你的操作';
  if (activeToolCalls.value.length > 0) return '正在执行工具';
  if (latestModelRequest.value?.status === 'retrying') return 'LLM 正在重试';
  if (latestModelRequest.value?.status === 'streaming') return 'LLM 正在回复';
  if (latestModelRequest.value?.status === 'prepared' || latestModelRequest.value?.status === 'pending') return '正在连接 LLM';
  return '正在处理';
});
const statusClass = computed(() => activeTurn.value ? 'is-active' : 'is-idle');
const statusRows = computed(() => {
  if (!activeTurn.value) return [{ label: '状态', value: '当前没有正在执行的任务' }];
  const rows: Array<{ label: string; value: string; nested?: boolean }> = [
    { label: '状态', value: statusLabel.value },
    { label: 'Agent', value: agentName.value }
  ];
  for (const [index, tool] of activeToolCalls.value.slice(0, 2).entries()) {
    rows.push({
      label: activeToolCalls.value.length > 1 ? `正在执行 ${index + 1}` : '正在执行',
      value: typeof tool.tool_name === 'string' ? tool.tool_name : String(tool.id),
      nested: true
    });
  }
  if (pendingInteractions.value.length > 0) {
    rows.push({ label: '待处理', value: `${pendingInteractions.value.length} 项`, nested: true });
  }
  return rows;
});

function compareCreatedAt(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return timestamp(left.created_at) - timestamp(right.created_at)
    || String(left.id).localeCompare(String(right.id));
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function integer(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return 0;
}
</script>

<template>
  <header class="tab-header">
    <span class="tab-title">{{ title }}</span>
    <HoverTooltipPanel
      class="turn-status-tooltip"
      panel-title="当前任务"
      :rows="statusRows"
      :delay-ms="180"
    >
      <button
        type="button"
        class="turn-status"
        :class="statusClass"
        :aria-label="`当前状态：${statusLabel}`"
      >
        <span class="turn-status-dot" aria-hidden="true"></span>
        <span>{{ statusLabel }}</span>
      </button>
    </HoverTooltipPanel>
  </header>
</template>

<style scoped>
.tab-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 38px;
  padding: 0 var(--space-3);
  border-bottom: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editor-background);
}

.tab-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.turn-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 3px 8px;
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 78%, transparent);
  border-radius: 4px;
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: default;
}

.turn-status:hover,
.turn-status:focus-visible {
  color: var(--vscode-foreground);
  border-color: color-mix(in srgb, var(--vscode-foreground) 30%, var(--vscode-panel-border));
  outline: none;
}

.turn-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--vscode-descriptionForeground);
}

.turn-status.is-active .turn-status-dot {
  background: var(--vscode-testing-iconPassed, #73c991);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 16%, transparent);
}
</style>
