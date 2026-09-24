<script setup lang="ts">
import { ref, watch } from 'vue';
import type { LlmGenerationConfigRecord, LlmSummaryReasoningMode } from '@shared/protocol';
import { resolveSummaryReasoning, assertSummaryReasoningPlan, type ModelCapabilitySnapshot } from '@shared/modelCapabilities';
import { resolveSummaryOutputBudget } from '@shared/summaryOutputBudget';
const props = defineProps<{ value?: LlmGenerationConfigRecord; capabilities?: ModelCapabilitySnapshot; mode: LlmSummaryReasoningMode; targetTokens?: number }>();
const emit = defineEmits<{ (event: 'update', value: LlmGenerationConfigRecord | undefined): void }>();
const draft = ref('{}'); const error = ref(''); const editing = ref(false);
watch(() => props.value, (value) => {
  if (!editing.value) draft.value = JSON.stringify(value ?? {}, null, 2);
}, { immediate: true, deep: true });
function apply(): void {
  try {
    const raw: unknown = JSON.parse(draft.value || '{}');
    if (!record(raw)) throw new Error('摘要参数必须是 JSON 对象。');
    const keys = ['temperature', 'topP', 'topK', 'maxOutputTokens', 'thinkingConfig'];
    if (Object.keys(raw).some((key) => !keys.includes(key))) throw new Error('存在未知摘要参数；这里只接受 generationConfig，不接受整个渠道配置。');
    for (const key of keys.filter((key) => key !== 'thinkingConfig')) {
      if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]))) throw new Error(`${key} 必须是有限数值。`);
    }
    if (raw.thinkingConfig !== undefined) {
      if (!record(raw.thinkingConfig)) throw new Error('thinkingConfig 必须是对象。');
      const thinking = raw.thinkingConfig;
      if (Object.keys(thinking).some((key) => !['includeThoughts', 'thinkingBudget', 'thinkingLevel', 'reasoningMode'].includes(key))) throw new Error('存在未知思考参数。');
      if (thinking.includeThoughts !== undefined && typeof thinking.includeThoughts !== 'boolean') throw new Error('includeThoughts 必须是布尔值。');
      if (thinking.thinkingBudget !== undefined && !Number.isSafeInteger(thinking.thinkingBudget)) throw new Error('thinkingBudget 必须是整数。');
      if (thinking.thinkingLevel !== undefined && !['not-set', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(thinking.thinkingLevel))) throw new Error('thinkingLevel 无效。');
      if (thinking.reasoningMode !== undefined && !['standard', 'pro'].includes(String(thinking.reasoningMode))) throw new Error('reasoningMode 无效。');
    }
    const value = raw as LlmGenerationConfigRecord;
    resolveSummaryOutputBudget(props.targetTokens, value);
    if (props.capabilities) assertSummaryReasoningPlan(resolveSummaryReasoning({ capabilities: props.capabilities, mode: props.mode, methodGenerationConfig: value }));
    error.value = ''; editing.value = false;
    draft.value = JSON.stringify(raw, null, 2);
    emit('update', Object.keys(raw).length ? value : undefined);
  } catch (caught) { error.value = caught instanceof Error ? caught.message : '摘要参数无效。'; }
}
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
</script>
<template>
  <details class="summary-generation-editor" :open="mode === 'explicit'">
    <summary>高级摘要参数</summary>
    <p>仅用于摘要请求。思考参数需选择“显式配置”才使用；Provider 默认不会继承聊天中的推理或采样覆盖。</p>
    <textarea v-model="draft" aria-label="摘要 generationConfig JSON" rows="7" spellcheck="false" @input="editing = true" />
    <p v-if="error" role="alert" class="summary-parameter-error">{{ error }}</p>
    <button type="button" @click="apply">应用摘要参数</button>
  </details>
</template>
<style scoped>
.summary-generation-editor { min-width: 0; border-top: 1px solid var(--vscode-panel-border); padding-top: var(--space-2); }
summary { cursor: pointer; font-size: var(--font-size-sm); }
p { color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); line-height: 1.5; }
textarea { box-sizing: border-box; width: 100%; resize: vertical; font-family: var(--vscode-editor-font-family); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: var(--space-2); }
.summary-parameter-error { color: var(--vscode-errorForeground); }
button { margin-top: var(--space-2); padding: var(--space-1) var(--space-3); color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-panel-border); cursor: pointer; }
</style>
