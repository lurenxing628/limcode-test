<script setup lang="ts">
/**
 * 流式状态尾巴组件。
 *
 * 在流式输出时追加到文本末尾，显示自定义状态文字 + 波浪渐变动画 + 闪烁光标。
 * 五种状态使用不同颜色区分：
 *   - preparing：应用内部整理/调度中
 *   - waiting：等待 LLM 响应
 *   - thinking：LLM 思考中
 *   - writing：LLM 输出正文中
 *   - executing：工具排队/执行中
 */
const props = withDefaults(
  defineProps<{
    /** 状态文字内容。 */
    text: string;
    /** 流式阶段。 */
    variant?: 'preparing' | 'waiting' | 'thinking' | 'writing' | 'executing';
  }>(),
  { variant: 'writing' }
);
</script>

<template>
  <span class="streaming-tail" :class="`is-${props.variant}`">
    <span class="streaming-tail-text">{{ props.text }}</span>
    <span class="streaming-tail-cursor"></span>
  </span>
</template>

<style scoped>
.streaming-tail {
  display: inline-flex;
  align-items: baseline;
  gap: 1px;
  margin-left: 2px;
  font-size: inherit;
  line-height: inherit;
  white-space: nowrap;
  vertical-align: baseline;
  animation: lc-block-reveal var(--lc-block-reveal-duration) ease-out both;
}

.streaming-tail-text {
  font-style: italic;
  background: linear-gradient(
    90deg,
    var(--lc-wave-color, var(--vscode-descriptionForeground)) 0%,
    var(--lc-wave-color, var(--vscode-descriptionForeground)) 35%,
    color-mix(in srgb, var(--lc-wave-color, var(--vscode-descriptionForeground)) 30%, transparent) 50%,
    var(--lc-wave-color, var(--vscode-descriptionForeground)) 65%,
    var(--lc-wave-color, var(--vscode-descriptionForeground)) 100%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: lc-streaming-wave var(--lc-streaming-wave-duration) linear infinite;
}

.streaming-tail-cursor {
  display: inline-block;
  width: 4px;
  height: 1em;
  background: var(--lc-wave-color, var(--vscode-descriptionForeground));
  vertical-align: text-bottom;
  animation: lc-streaming-cursor-blink var(--lc-content-cursor-blink-duration) ease-in-out infinite;
}

.streaming-tail.is-preparing {
  --lc-wave-color: var(--lc-streaming-wave-color-preparing);
}

.streaming-tail.is-waiting {
  --lc-wave-color: var(--lc-streaming-wave-color-waiting);
}

.streaming-tail.is-thinking {
  --lc-wave-color: var(--lc-streaming-wave-color-thinking);
}

.streaming-tail.is-writing {
  --lc-wave-color: var(--lc-streaming-wave-color-writing);
}

.streaming-tail.is-executing {
  --lc-wave-color: var(--lc-streaming-wave-color-executing);
}
</style>
