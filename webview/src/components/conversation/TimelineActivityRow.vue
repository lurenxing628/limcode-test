<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { IconTool } from '@tabler/icons-vue';
import StreamingIndicatorTail from '@webview/components/content/StreamingIndicatorTail.vue';
import CollapsibleContentBlock from '@webview/components/content/CollapsibleContentBlock.vue';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';

const props = defineProps<{
  activityKind: 'preparing';
  label?: string;
  modelLabel?: string;
  /** 简洁模式：画成和简洁模式消息里的步骤卡同高同样式的一行，内容到达时原地换成步骤卡，不跳动。 */
  concise?: boolean;
}>();

const settings = useGlobalSettingsStore();
const labelText = computed(() => props.label || settings.appearance.streamingTextPreparing);

// 简洁模式这一行只占一行；自动重试时上游报错原文也拼在里面，放不下时允许展开看全文。
const labelElement = ref<HTMLElement>();
const labelTruncated = ref(false);
const detailExpanded = ref(false);
const expandable = computed(() => labelTruncated.value || detailExpanded.value);
let labelObserver: ResizeObserver | undefined;

function measureLabel(): void {
  const element = labelElement.value;
  labelTruncated.value = Boolean(element && element.scrollWidth > element.clientWidth + 1);
}

onMounted(() => {
  measureLabel();
  if (typeof ResizeObserver === 'undefined' || !labelElement.value) return;
  labelObserver = new ResizeObserver(measureLabel);
  labelObserver.observe(labelElement.value);
});
watch(labelText, () => { void nextTick(measureLabel); });
onBeforeUnmount(() => labelObserver?.disconnect());
</script>

<template>
  <article v-if="props.concise" class="timeline-activity-row assistant is-concise" :data-activity-kind="props.activityKind">
    <div class="activity-body">
      <CollapsibleContentBlock v-model:expanded="detailExpanded" :collapsible="expandable" icon-active :aria-label="labelText">
        <template #icon><IconTool stroke="2" /></template>
        <template #summary><span ref="labelElement" class="activity-concise-label lc-shimmer-text">{{ labelText }}</span></template>
        <p class="activity-concise-detail">{{ labelText }}</p>
      </CollapsibleContentBlock>
    </div>
  </article>
  <article v-else class="timeline-activity-row assistant" :data-activity-kind="props.activityKind">
    <div class="activity-container">
      <div class="activity-content-column">
        <header class="activity-header">
          <span class="role-chip assistant">
            <span class="role-dot" aria-hidden="true"></span>
            <span class="activity-role-name">{{ props.modelLabel || 'LLM' }}</span>
          </span>
        </header>
        <div class="activity-body">
          <StreamingIndicatorTail :text="labelText" variant="preparing" />
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.timeline-activity-row {
  position: relative;
  width: 100%;
  --message-floor-padding-block: 10px;
  padding: var(--message-floor-padding-block) var(--conversation-content-padding-right, calc(var(--space-4) + 24px))
    var(--message-floor-padding-block) var(--conversation-content-padding-left, var(--space-4));
  box-sizing: border-box;
  background-color: color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-foreground) 3%);
  transition: background-color var(--lc-message-bg-transition-duration) ease;
}

.timeline-activity-row.is-concise {
  --message-floor-padding-block: 4px;
  /* 上一张步骤卡结束后这行才插进来，淡入避免硬跳；只动透明度和位移，不触发重排。
     随后原地换成同高同文案的步骤卡，那张卡不加动画，否则交接时会闪。 */
  animation: lc-concise-row-enter 0.18s var(--lc-motion-enter-emphasized, ease-out) both;
}

@keyframes lc-concise-row-enter {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .timeline-activity-row.is-concise {
    animation: none;
  }
}

.activity-concise-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-concise-detail {
  margin: 0;
  padding-top: var(--space-2);
  font-size: var(--font-size-sm);
  line-height: 1.6;
  color: var(--vscode-descriptionForeground);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}

.activity-container {
  max-width: 100%;
}

.activity-content-column {
  width: 100%;
  min-width: 0;
}

.activity-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 22px;
  margin-bottom: var(--space-1);
}

.role-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.role-chip.assistant {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.role-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: currentColor;
}

.activity-role-name {
  font-weight: 600;
  font-size: var(--font-size-sm);
  color: currentColor;
}

.activity-body {
  min-height: 1.6em;
  font-size: var(--font-size-md);
  line-height: 1.6;
  color: var(--vscode-foreground);
}
</style>
