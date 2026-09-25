<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue';
import { IconMessage2, IconPlayerStop, IconRobot, IconX } from '@tabler/icons-vue';
import { BridgeMessageType } from '@shared/protocol';
import { useAgentStore } from '@webview/stores/useAgentStore';
import { useChat } from '@webview/composables/useChat';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { reliableKernelDetailKey } from '@webview/domain/reliableDetailKey';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import HoverTooltipPanel from '@webview/components/ui/HoverTooltipPanel.vue';
import { bridge } from '@webview/transport';
import {
  presentReliableChildTask,
  projectReliableAgentStatus,
  type ReliableChildAgentStatus,
  type ReliableChildTaskPresentation
} from '@webview/domain/reliableAgentStatusProjection';

interface TooltipRow {
  label: string;
  value: string;
}

const reliableConversation = useReliableConversation();
const agentStore = useAgentStore();
const { interruptPhase } = useChat();
const open = ref(false);
const selectedChildId = ref<string>();
const rootRef = ref<HTMLElement | null>(null);
const listScroller = ref<HTMLElement | null>(null);
const detailScroller = ref<HTMLElement | null>(null);
const interruptFeedback = ref<Record<string, {
  requestId: string;
  phase: 'submitting' | 'committed' | 'failed';
  message: string;
}>>({});
const interruptProjectionTimers = new Map<string, ReturnType<typeof setTimeout>>();

const projection = computed(() => projectReliableAgentStatus({
  conversationId: reliableConversation.conversationId.value,
  records: reliableConversation.feed.records,
  agentNames: new Map(agentStore.agents.map((agent) => [agent.id, agent.name]))
}));
const entries = computed(() => projection.value.children);
const selectedEntry = computed(() =>
  entries.value.find((child) => child.id === selectedChildId.value) ?? entries.value[0]
);
const taskPresentations = computed(() => new Map(entries.value.map((child) => [child.id, presentTask(child)])));
const runningCount = computed(() => entries.value.filter((child) => child.group === 'executing').length);
const activeTurn = computed(() => Object.values(reliableConversation.feed.records.Turn ?? {}).find((turn) =>
  turn.conversation_id === reliableConversation.conversationId.value && turn.status === 'active'
));
const activeLease = computed(() => activeTurn.value && Object.values(reliableConversation.feed.records.ExecutionLease ?? {})
  .some((lease) => lease.turn_id === activeTurn.value?.id));
const currentStatus = computed(() => interruptPhase.value
  ? interruptPhase.value === 'stopping' ? '正在停止' : '正在请求停止'
  : activeTurn.value && activeLease.value ? '执行中' : '空闲');
const panelSummary = computed(() => {
  if (entries.value.length === 0) return `${projection.value.currentAgentName} · ${currentStatus.value} · 暂无子 Agent`;
  return runningCount.value > 0
    ? `${projection.value.currentAgentName} · ${currentStatus.value} · ${runningCount.value} 个运行中 / ${entries.value.length} 个子 Agent`
    : `${projection.value.currentAgentName} · ${currentStatus.value} · ${entries.value.length} 个子 Agent`;
});
const listRefreshKey = computed(() => entries.value
  .map((child) => `${child.id}:${child.lifecycle}:${child.updatedAt ?? ''}`)
  .join('|'));
const detailRefreshKey = computed(() => {
  const child = selectedEntry.value;
  if (!child) return 'empty';
  const answer = child.answerSubmissionId
    ? reliableConversation.feed.details[reliableKernelDetailKey('answer-content', child.answerSubmissionId)]
    : undefined;
  return `${child.id}:${child.updatedAt ?? ''}:${answer?.status ?? 'none'}:${answer?.totalBytes ?? 0}`;
});

watch(entries, (nextEntries) => {
  if (nextEntries.length === 0) {
    selectedChildId.value = undefined;
    return;
  }
  if (!selectedChildId.value || !nextEntries.some((child) => child.id === selectedChildId.value)) {
    selectedChildId.value = nextEntries[0].id;
  }
}, { immediate: true });

watch(open, (isOpen) => {
  if (!isOpen) return;
  void nextTick(() => {
    listScroller.value?.scrollTo({ top: 0 });
    detailScroller.value?.scrollTo({ top: 0 });
  });
});

watch(selectedChildId, () => {
  if (!open.value) return;
  void nextTick(() => detailScroller.value?.scrollTo({ top: 0 }));
});

watchEffect(() => {
  if (!open.value) return;
  for (const child of entries.value) {
    reliableConversation.feed.requestDetail('tool-arguments-content', child.sourceToolCallId, { priority: 'expanded' });
  }
  const submissionId = selectedEntry.value?.answerSubmissionId;
  if (submissionId) {
    reliableConversation.feed.requestDetail('answer-content', submissionId, { priority: 'expanded' });
  }
});

watchEffect(() => {
  const childById = new Map(entries.value.map((child) => [child.id, child]));
  for (const childId of Object.keys(interruptFeedback.value)) {
    const child = childById.get(childId);
    if (child && !['interrupting', 'interrupted', 'closed'].includes(child.lifecycle)) continue;
    clearInterruptProjectionTimer(childId);
    const next = { ...interruptFeedback.value };
    delete next[childId];
    interruptFeedback.value = next;
  }
});

const disposeInterruptResult = bridge.on(BridgeMessageType.InteractionResult, (message) => {
  if (message.payload?.requestType !== BridgeMessageType.ToolExecutionCancel) return;
  const pending = Object.entries(interruptFeedback.value)
    .find(([, feedback]) => feedback.requestId === message.correlationId);
  if (!pending) return;
  const [childId, feedback] = pending;
  switch (message.payload.status) {
    case 'committed':
    case 'already_applied':
      setInterruptFeedback(childId, { ...feedback, phase: 'committed', message: '终止已提交，等待状态同步' });
      scheduleInterruptProjectionDeadline(childId);
      return;
    case 'already_satisfied':
    case 'already_resolved':
      setInterruptFeedback(childId, { ...feedback, phase: 'committed', message: '目标已经结束' });
      scheduleInterruptProjectionDeadline(childId);
      return;
    default:
      setInterruptFeedback(childId, {
        ...feedback,
        phase: 'failed',
        message: message.payload.reason?.trim() || '终止未能完成，请重试'
      });
  }
});

const disposeInterruptError = bridge.on(BridgeMessageType.Error, (message) => {
  if (message.payload?.requestType !== BridgeMessageType.ToolExecutionCancel) return;
  const pending = Object.entries(interruptFeedback.value)
    .find(([, feedback]) => feedback.requestId === message.correlationId);
  if (!pending) return;
  const [childId, feedback] = pending;
  clearInterruptProjectionTimer(childId);
  setInterruptFeedback(childId, {
    ...feedback,
    phase: 'failed',
    message: message.payload.message?.trim() || '终止未能提交，请重试'
  });
});

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onDocumentKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  document.removeEventListener('keydown', onDocumentKeydown);
  disposeInterruptResult();
  disposeInterruptError();
  for (const timer of interruptProjectionTimers.values()) clearTimeout(timer);
  interruptProjectionTimers.clear();
});

function toggleOpen(): void {
  open.value = !open.value;
}

function closePanel(): void {
  open.value = false;
}

function selectEntry(child: ReliableChildAgentStatus): void {
  selectedChildId.value = child.id;
}

function openConversationForEntry(child: ReliableChildAgentStatus | undefined): void {
  const conversationId = child?.conversationId.trim();
  if (!conversationId) return;
  const conversation = reliableConversation.feed.records.Conversation?.[conversationId];
  const title = text(conversation?.title);
  bridge.request(BridgeMessageType.ConversationOpen, {
    conversationId,
    ...(title ? { title } : {})
  });
  closePanel();
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const target = event.target;
  if (target instanceof Node && rootRef.value?.contains(target)) return;
  closePanel();
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (open.value && event.key === 'Escape') closePanel();
}

function presentTask(child: ReliableChildAgentStatus): ReliableChildTaskPresentation {
  const detail = reliableConversation.feed.details[
    reliableKernelDetailKey('tool-arguments-content', child.sourceToolCallId)
  ];
  if (!detail || detail.status === 'loading') return { title: '正在加载任务…', body: '正在加载任务…' };
  if (detail.status === 'error') {
    return { title: '任务加载失败', body: `任务加载失败：${detail.error?.trim() || '未知错误'}` };
  }
  return presentReliableChildTask(detail.text);
}

function taskTitle(child: ReliableChildAgentStatus): string {
  return taskPresentations.value.get(child.id)?.title ?? '正在加载任务…';
}

function taskText(child: ReliableChildAgentStatus): string {
  return taskPresentations.value.get(child.id)?.body ?? '正在加载任务…';
}

function taskPreview(child: ReliableChildAgentStatus): string {
  return truncate(taskText(child).replace(/\s+/g, ' ').trim(), 160);
}

function answerContent(child: ReliableChildAgentStatus): string {
  if (!child.answerBridgeId) return '尚未建立 AnswerBridge。';
  if (!child.answerSubmissionId) {
    return child.group === 'executing'
      ? '子 Agent 仍在运行，尚未提交 Answer。'
      : '该子 Agent 尚未提交 Answer。';
  }
  const detail = reliableConversation.feed.details[
    reliableKernelDetailKey('answer-content', child.answerSubmissionId)
  ];
  if (!detail || detail.status === 'loading') return '正在加载 Answer 正文…';
  if (detail.status === 'error') return `Answer 正文加载失败：${detail.error?.trim() || '未知错误'}`;
  return detail.text || '(Answer 正文为空)';
}

function answerSummary(child: ReliableChildAgentStatus): string {
  if (child.answerTitle) return child.answerTitle;
  if (child.answerSubmissionId) return `已提交${child.answerSubmissionSeq ? ` · #${child.answerSubmissionSeq}` : ''}`;
  return child.answerBridgeStatus ? `AnswerBridge ${statusText(child.answerBridgeStatus)}` : '尚未提交';
}

function deliveryLabel(child: ReliableChildAgentStatus): string | undefined {
  return child.deliveryBadge === 'awaiting_parent'
    ? '等待主 Agent 处理'
    : child.deliveryBadge === 'delivery_failed' ? '回答发送失败' : undefined;
}

function statusTone(child: ReliableChildAgentStatus): 'running' | 'done' | 'warning' | 'error' {
  if (child.deliveryBadge === 'delivery_failed' || child.group === 'attention') return 'error';
  if (child.group === 'executing') return 'running';
  if (child.group === 'finished') return 'done';
  return 'warning';
}

function statusTooltipRows(child: ReliableChildAgentStatus): TooltipRow[] {
  return [
    { label: '子 Agent', value: child.lifecycleLabel },
    ...(child.turnStatus ? [{ label: '回合', value: statusText(child.turnStatus) }] : []),
    ...(child.activitySummary ? [{ label: '当前活动', value: child.activitySummary }] : []),
    ...(child.turnTerminationStatus ? [{ label: '结束', value: statusText(child.turnTerminationStatus) }] : []),
    ...(child.answerBridgeStatus ? [{ label: 'Answer', value: statusText(child.answerBridgeStatus) }] : []),
    ...(child.deliveryState ? [{ label: '发送', value: statusText(child.deliveryState) }] : []),
    ...(child.parentHandlingState ? [{ label: '主 Agent', value: statusText(child.parentHandlingState) }] : [])
  ];
}

function interruptChild(child: ReliableChildAgentStatus): void {
  selectedChildId.value = child.id;
  const current = interruptFeedback.value[child.id];
  if (!child.interruptible || current?.phase === 'submitting' || current?.phase === 'committed') return;
  clearInterruptProjectionTimer(child.id);
  const requestId = bridge.request(BridgeMessageType.ToolExecutionCancel, {
    toolCallId: child.sourceToolCallId,
    conversationId: reliableConversation.conversationId.value,
    reason: '用户从 Agent 运行情况面板请求终止该 Agent 及其启动的所有子 Agent。'
  });
  setInterruptFeedback(child.id, { requestId, phase: 'submitting', message: '正在提交终止请求' });
}

function showInterruptAction(child: ReliableChildAgentStatus): boolean {
  return child.interruptible
    || child.lifecycle === 'interrupting'
    || Boolean(interruptFeedback.value[child.id]);
}

function interruptButtonLabel(child: ReliableChildAgentStatus): string {
  const feedback = interruptFeedback.value[child.id];
  if (child.lifecycle === 'interrupting' || feedback?.phase === 'committed') return '正在终止';
  if (feedback?.phase === 'submitting') return '正在提交';
  return feedback?.phase === 'failed' ? '重试终止' : '终止';
}

function interruptButtonDisabled(child: ReliableChildAgentStatus): boolean {
  const phase = interruptFeedback.value[child.id]?.phase;
  return !child.interruptible || phase === 'submitting' || phase === 'committed';
}

function setInterruptFeedback(
  childId: string,
  feedback: { requestId: string; phase: 'submitting' | 'committed' | 'failed'; message: string }
): void {
  interruptFeedback.value = { ...interruptFeedback.value, [childId]: feedback };
}

function scheduleInterruptProjectionDeadline(childId: string): void {
  clearInterruptProjectionTimer(childId);
  interruptProjectionTimers.set(childId, setTimeout(() => {
    interruptProjectionTimers.delete(childId);
    const feedback = interruptFeedback.value[childId];
    if (!feedback || feedback.phase !== 'committed') return;
    setInterruptFeedback(childId, {
      ...feedback,
      phase: 'failed',
      message: '终止已提交，但状态尚未同步；可重试或重载窗口'
    });
  }, 30_000));
}

function clearInterruptProjectionTimer(childId: string): void {
  const timer = interruptProjectionTimers.get(childId);
  if (timer) clearTimeout(timer);
  interruptProjectionTimers.delete(childId);
}

function formatTime(value: string | undefined): string {
  if (!value) return '-';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(timestamp);
}

function byteLengthLabel(value: string | undefined): string {
  if (!value || !/^\d+$/.test(value)) return '-';
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes)) return `${value} B`;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KiB`;
}

function statusText(value: string): string {
  const labels: Record<string, string> = {
    starting: '启动中',
    active: '运行中',
    idle: '可继续',
    stopping: '正在停止',
    interrupting: '正在终止',
    interrupted: '已终止',
    closed: '已结束',
    terminated: '已结束',
    needs_human: '需要处理',
    pending: '等待中',
    delivering: '正在发送',
    consumed: '已接收',
    handled: '已处理',
    unhandled: '待处理',
    not_applicable: '无需处理',
    failed: '失败',
    completed: '已完成',
    cancelled: '已取消',
    outcome_unknown: '结果未知',
    open: '已建立',
    submitted: '已提交'
  };
  return labels[value] ?? value;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
</script>

<template>
  <div ref="rootRef" class="agent-run-root" data-testid="reliable-agent-status-panel">
    <button
      type="button"
      class="agent-run-trigger"
      :class="{ 'is-active': open, 'has-running': runningCount > 0 }"
      :aria-label="`子 Agent 面板，${panelSummary}`"
      :aria-expanded="open"
      @click.stop="toggleOpen"
    >
      <IconRobot class="agent-run-trigger-icon" stroke="2" aria-hidden="true" />
      <span v-if="entries.length" class="agent-run-count">{{ entries.length }}</span>
    </button>

    <section v-if="open" class="agent-run-panel" role="dialog" aria-label="子 Agent 面板">
      <header class="agent-run-header">
        <div class="agent-run-title">
          <span>子 Agent</span>
          <span>{{ panelSummary }}</span>
        </div>
        <div class="agent-run-header-actions">
          <button
            v-if="selectedEntry && showInterruptAction(selectedEntry)"
            type="button"
            class="agent-run-action-button"
            :disabled="selectedEntry ? interruptButtonDisabled(selectedEntry) : true"
            :aria-label="selectedEntry ? `${interruptButtonLabel(selectedEntry)} ${taskTitle(selectedEntry)}` : '终止子 Agent'"
            @click.stop="selectedEntry && interruptChild(selectedEntry)"
          >
            <IconPlayerStop aria-hidden="true" />
            <span>{{ selectedEntry ? interruptButtonLabel(selectedEntry) : '终止' }}</span>
          </button>
          <button type="button" class="agent-run-close" aria-label="关闭子 Agent 面板" @click="closePanel">
            <IconX stroke="2" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div v-if="entries.length" class="agent-run-body">
        <div class="agent-run-list-shell">
          <div ref="listScroller" class="agent-run-list">
            <div
              v-for="child in entries"
              :key="child.id"
              class="agent-run-item"
              :class="{
                'is-selected': selectedEntry?.id === child.id,
                'has-stop-action': showInterruptAction(child)
              }"
            >
              <button
                type="button"
                class="agent-run-item-select"
                :aria-label="`查看 ${taskTitle(child)} 的运行详情`"
                @click="selectEntry(child)"
              >
                <span class="agent-run-target">{{ taskTitle(child) }}</span>
                <span class="agent-run-item-meta">
                  <span class="agent-run-status" :class="`is-${statusTone(child)}`">{{ child.lifecycleLabel }}</span>
                  <span class="agent-run-agent">{{ child.agentName }}</span>
                  <span class="agent-run-time">{{ formatTime(child.createdAt) }}</span>
                </span>
                <span v-if="child.activitySummary" class="agent-run-activity">{{ child.activitySummary }}</span>
                <span class="agent-run-preview">{{ taskPreview(child) }}</span>
                <span v-if="deliveryLabel(child)" class="agent-run-answer-line" :class="{ 'is-error': child.deliveryBadge === 'delivery_failed' }">
                  {{ deliveryLabel(child) }}
                </span>
              </button>
              <button
                v-if="showInterruptAction(child)"
                type="button"
                class="agent-run-item-stop"
                :disabled="interruptButtonDisabled(child)"
                :aria-label="`${interruptButtonLabel(child)} ${taskTitle(child)} 对话及其下级子 Agent；不影响其他同级子 Agent`"
                @click.stop="interruptChild(child)"
              >
                <IconPlayerStop aria-hidden="true" />
                <span>{{ interruptButtonLabel(child) }}</span>
              </button>
            </div>
          </div>
          <AdvancedScrollbar :scroller="listScroller" :refresh-key="listRefreshKey" variant="minimal" />
        </div>

        <article v-if="selectedEntry" class="agent-run-detail">
          <header class="agent-run-detail-header">
            <span class="agent-run-detail-main">
              <HoverTooltipPanel
                class="agent-run-status"
                :class="`is-${statusTone(selectedEntry)}`"
                :aria-label="`子 Agent 状态：${selectedEntry.lifecycleLabel}`"
                panel-title="可靠运行状态"
                :rows="statusTooltipRows(selectedEntry)"
                role="status"
                aria-live="polite"
                aria-atomic="true"
                tabindex="0"
              >
                <span>{{ selectedEntry.lifecycleLabel }}</span>
              </HoverTooltipPanel>
              <span class="agent-run-detail-name">{{ taskTitle(selectedEntry) }}</span>
            </span>
            <button
              type="button"
              class="agent-run-open-conversation"
              :aria-label="`打开 ${taskTitle(selectedEntry)} 的对话`"
              @click="openConversationForEntry(selectedEntry)"
            >
              <IconMessage2 stroke="2" aria-hidden="true" />
              <span>打开对话</span>
            </button>
          </header>

          <div class="agent-run-detail-scroll-shell">
            <div ref="detailScroller" class="agent-run-detail-scroll">
              <section class="agent-run-detail-section">
                <h3>运行状态</h3>
                <dl class="agent-run-param-grid">
                  <dt>Agent</dt><dd>{{ selectedEntry.agentName }}</dd>
                  <dt>子 Agent</dt><dd>{{ selectedEntry.lifecycleLabel }} ({{ selectedEntry.lifecycle }})</dd>
                  <dt>当前回合</dt><dd>{{ selectedEntry.turnStatus ? `${statusText(selectedEntry.turnStatus)} (${selectedEntry.turnStatus})` : '-' }}</dd>
                  <dt>当前活动</dt><dd>{{ selectedEntry.activitySummary || statusText(selectedEntry.activityKind || 'idle') }}</dd>
                  <dt>回合结束</dt><dd>{{ selectedEntry.turnTerminationStatus ? `${statusText(selectedEntry.turnTerminationStatus)} (${selectedEntry.turnTerminationStatus})` : '-' }}</dd>
                  <dt>Answer</dt><dd>{{ selectedEntry.answerBridgeStatus ? `${statusText(selectedEntry.answerBridgeStatus)} (${selectedEntry.answerBridgeStatus})` : '-' }}</dd>
                  <dt>回答发送</dt><dd>{{ selectedEntry.deliveryState ? `${statusText(selectedEntry.deliveryState)} (${selectedEntry.deliveryState})` : '-' }}</dd>
                  <dt>主 Agent 处理</dt><dd>{{ selectedEntry.parentHandlingState ? `${statusText(selectedEntry.parentHandlingState)} (${selectedEntry.parentHandlingState})` : '-' }}</dd>
                  <dt>开始</dt><dd>{{ formatTime(selectedEntry.createdAt) }}</dd>
                  <dt>更新</dt><dd>{{ formatTime(selectedEntry.updatedAt) }}</dd>
                </dl>
                <p v-if="selectedEntry.turnTerminationReason" class="agent-run-state-note">{{ selectedEntry.turnTerminationReason }}</p>
                <p v-if="selectedEntry.deliveryFailureReason" class="agent-run-state-note is-error">{{ selectedEntry.deliveryFailureReason }}</p>
                <p v-if="interruptFeedback[selectedEntry.id]" class="agent-run-state-note" :class="{ 'is-error': interruptFeedback[selectedEntry.id].phase === 'failed' }" role="status">
                  {{ interruptFeedback[selectedEntry.id].message }}
                </p>
              </section>

              <section class="agent-run-detail-section">
                <h3>任务</h3>
                <pre>{{ taskText(selectedEntry) }}</pre>
              </section>

              <section class="agent-run-detail-section">
                <h3>Answer</h3>
                <p class="agent-run-answer-summary">{{ answerSummary(selectedEntry) }}</p>
                <dl class="agent-run-param-grid agent-run-answer-grid">
                  <dt>提交时间</dt><dd>{{ formatTime(selectedEntry.answerSubmittedAt) }}</dd>
                  <dt>正文大小</dt><dd>{{ byteLengthLabel(selectedEntry.answerByteLength) }}</dd>
                  <dt>中断提交</dt><dd>{{ selectedEntry.answerSubmissionInterrupted === undefined ? '-' : selectedEntry.answerSubmissionInterrupted ? '是' : '否' }}</dd>
                </dl>
                <pre class="agent-run-answer-content">{{ answerContent(selectedEntry) }}</pre>
              </section>
            </div>
            <AdvancedScrollbar :scroller="detailScroller" :refresh-key="detailRefreshKey" variant="minimal" />
          </div>
        </article>
      </div>

      <div v-else class="agent-run-empty">暂无子 Agent。</div>
    </section>
  </div>
</template>

<style scoped>
.agent-run-root {
  position: relative;
  flex: 0 0 auto;
}

.agent-run-trigger {
  position: relative;
  width: 28px;
  height: 28px;
  min-width: 28px;
  min-height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.agent-run-trigger:hover,
.agent-run-trigger:focus-visible,
.agent-run-trigger.is-active {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border, transparent);
  background: var(--vscode-list-hoverBackground, transparent);
  outline: none;
}

.agent-run-trigger.has-running .agent-run-trigger-icon {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.agent-run-trigger-icon { width: 16px; height: 16px; }

.agent-run-count {
  position: absolute;
  right: -2px;
  bottom: -2px;
  min-width: 13px;
  height: 13px;
  padding: 0 3px;
  border: 1px solid var(--vscode-editor-background);
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 68%, var(--vscode-editor-background) 32%);
  font-size: 9px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.agent-run-panel {
  position: absolute;
  right: calc(100% + 8px);
  bottom: 0;
  z-index: 40;
  width: min(760px, calc(100vw - 58px));
  height: min(430px, calc(100vh - 120px));
  min-height: 260px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.34);
  overflow: hidden;
}

.agent-run-header {
  min-height: 38px;
  padding: 7px 8px 7px 10px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.agent-run-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: var(--font-size-sm);
  line-height: 1.25;
}

.agent-run-title span:first-child { font-weight: 600; }
.agent-run-title span:last-child { color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); }
.agent-run-header-actions { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px; }

.agent-run-action-button {
  height: 24px;
  min-height: 24px;
  padding: 0 8px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  font-size: var(--font-size-xs);
  line-height: 1;
}

.agent-run-action-button svg { width: 13px; height: 13px; }
.agent-run-action-button:not(:disabled):hover,
.agent-run-action-button:not(:disabled):focus-visible {
  color: var(--vscode-errorForeground, #f48771);
  border-color: currentColor;
  background: color-mix(in srgb, currentColor 8%, var(--vscode-editor-background) 92%);
  outline: none;
}
.agent-run-action-button:disabled { opacity: .62; cursor: default; }

.agent-run-close {
  width: 24px;
  height: 24px;
  min-width: 24px;
  min-height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.agent-run-close:hover,
.agent-run-close:focus-visible { color: var(--vscode-foreground); border-color: var(--vscode-panel-border, transparent); background: var(--vscode-list-hoverBackground, transparent); outline: none; }
.agent-run-close :deep(svg) { width: 16px; height: 16px; }

.agent-run-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(190px, 0.42fr) minmax(260px, 0.58fr);
}

.agent-run-list-shell,
.agent-run-detail-scroll-shell { position: relative; min-height: 0; }

.agent-run-list {
  height: 100%;
  min-height: 0;
  padding: 6px;
  border-right: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  scrollbar-width: none;
}

.agent-run-list::-webkit-scrollbar,
.agent-run-detail-scroll::-webkit-scrollbar { width: 0; height: 0; display: none; }

.agent-run-item {
  position: relative;
  width: 100%;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.agent-run-item:hover,
.agent-run-item:focus-within,
.agent-run-item.is-selected {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border, transparent);
  background: var(--vscode-list-hoverBackground, transparent);
  outline: none;
}

.agent-run-item-select {
  width: 100%;
  min-width: 0;
  padding: 7px 8px;
  border: 0;
  border-radius: inherit;
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: inherit;
  background: transparent;
  text-align: left;
}

/* The row highlight lives on .agent-run-item; keep the global button hover fill off the row. */
.agent-run-item-select:hover:not(:disabled) { background: transparent; }
.agent-run-item-select:focus-visible { outline: none; }
/* Only the title line shares its row with the absolutely placed stop button. */
.agent-run-item.has-stop-action .agent-run-target { padding-right: 70px; }

.agent-run-item-stop {
  position: absolute;
  top: 7px;
  right: 7px;
  z-index: 1;
  min-height: 22px;
  padding: 2px 5px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-foreground) 10%);
  font-size: 10px;
  line-height: 1;
}

.agent-run-item-stop svg { width: 12px; height: 12px; }
.agent-run-item-stop:not(:disabled):hover,
.agent-run-item-stop:not(:disabled):focus-visible {
  color: var(--vscode-errorForeground, #f48771);
  border-color: currentColor;
  background: color-mix(in srgb, currentColor 8%, var(--vscode-editor-background) 92%);
  outline: none;
}
.agent-run-item-stop:disabled { opacity: .62; cursor: default; }
.agent-run-item-meta {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.agent-run-status {
  flex: 0 0 auto;
  min-width: 48px;
  padding: 1px 5px;
  border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  font-size: 10px;
  line-height: 1.35;
  text-align: center;
}

.agent-run-status.is-running { color: var(--vscode-editorWarning-foreground, #cca700); }
.agent-run-status.is-done { color: var(--vscode-testing-iconPassed, #73c991); }
.agent-run-status.is-warning { color: var(--vscode-editorWarning-foreground, #cca700); }
.agent-run-status.is-error { color: var(--vscode-errorForeground, #f48771); }
.agent-run-status:focus-visible { outline: 1px solid var(--vscode-focusBorder, currentColor); outline-offset: 1px; }

.agent-run-target,
.agent-run-agent,
.agent-run-activity,
.agent-run-answer-line { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-run-target { color: var(--vscode-foreground); font-weight: 500; }
.agent-run-agent { flex: 1 1 auto; }
.agent-run-time { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.agent-run-activity { color: var(--vscode-foreground); font-size: var(--font-size-sm); }
.agent-run-preview {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
  font-size: var(--font-size-sm);
  line-height: 1.4;
}
.agent-run-answer-line { color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); }
.agent-run-answer-line.is-error { color: var(--vscode-errorForeground, #f48771); }

.agent-run-detail { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.agent-run-detail-header { min-height: 36px; padding: 7px 10px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18)); display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.agent-run-detail-main { min-width: 0; display: inline-flex; align-items: center; gap: 8px; }
.agent-run-detail-name { min-width: 0; color: var(--vscode-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-size-sm); font-weight: 500; }

.agent-run-open-conversation {
  flex: 0 0 auto;
  min-height: 24px;
  padding: 3px 8px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font-size: var(--font-size-xs);
  line-height: 1.2;
}

.agent-run-open-conversation:hover,
.agent-run-open-conversation:focus-visible { color: var(--vscode-foreground); border-color: color-mix(in srgb, var(--vscode-foreground) 28%, transparent); background: var(--vscode-list-hoverBackground, transparent); outline: none; }
.agent-run-open-conversation :deep(svg) { width: 14px; height: 14px; }
.agent-run-detail-scroll-shell { flex: 1; }
.agent-run-detail-scroll { height: 100%; padding: 10px; overflow-y: auto; scrollbar-width: none; }
.agent-run-detail-section { margin-bottom: 14px; }
.agent-run-detail-section h3 { margin: 0 0 6px; color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }

.agent-run-detail-section pre {
  margin: 0;
  max-height: 188px;
  padding: 8px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.24));
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-family-mono);
  font-size: var(--font-size-xs);
  line-height: 1.45;
}

.agent-run-param-grid { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 10px; margin: 0; color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); }
.agent-run-param-grid dt { color: var(--vscode-descriptionForeground); }
.agent-run-param-grid dd { min-width: 0; margin: 0; color: var(--vscode-foreground); overflow-wrap: anywhere; font-family: var(--font-family-mono); }
.agent-run-answer-grid { margin-bottom: 8px; }
.agent-run-answer-summary { margin: 0 0 6px; color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); }
.agent-run-state-note { margin: 7px 0 0; color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); line-height: 1.4; }
.agent-run-state-note.is-error { color: var(--vscode-errorForeground, #f48771); }
.agent-run-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); }

/* Side by side, a narrow panel leaves the list too little width to read titles; stack it instead. */
@media (max-width: 620px) {
  .agent-run-panel { width: min(760px, calc(100vw - 112px)); height: min(560px, calc(100vh - 120px)); }
  .agent-run-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 2fr) minmax(0, 3fr); }
  .agent-run-list { border-right: 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.22)); }
  .agent-run-item.has-stop-action .agent-run-target { padding-right: 26px; }
  .agent-run-item-stop { width: 22px; padding-inline: 0; }
  .agent-run-item-stop span { display: none; }
}
</style>
