<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ChatModelOverrideRecord, LlmProviderConfigRecord, LlmThinkingLevel, SessionThinkingOverride } from '@shared/protocol';
import { sessionThinkingCapability, sessionThinkingDisplayLabel, validateSessionThinkingOverride } from '@shared/sessionThinking';
import { hasThinkingBodyConflict } from '@shared/sessionThinkingBody';
import { useModelProfileStore } from '@webview/stores/useModelProfileStore';
import SettingsDropdown, { type SettingsDropdownOption } from '@webview/components/settings/global/SettingsDropdown.vue';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';

const props = defineProps<{ conversationId?: string; config?: LlmProviderConfigRecord; model?: string }>();
const store = useModelProfileStore();
const localError = ref('');
// A model's advanced configuration replaces (rather than merges with) channel defaults.
const settings = computed(() => props.config?.modelConfigs.find(item => item.modelId === props.model) ?? props.config);
const capability = computed(() => props.config && props.model
  ? sessionThinkingCapability(props.config.provider, props.model, settings.value?.generationConfig?.maxOutputTokens, settings.value?.generationConfig?.thinkingConfig)
  : undefined);
const pending = computed(() => store.pendingFor('conversation', props.conversationId));
const override = computed(() => store.thinkingFor('conversation', props.conversationId));
const inheritChildren = computed(() => store.childThinkingInheritanceFor('conversation', props.conversationId));
const ready = computed(() => !!props.conversationId && !!props.config && !!props.model);
const busy = computed(() => pending.value?.status === 'saving');
const disabled = computed(() => !ready.value || !capability.value || busy.value);
const defaultLabel = computed(() => {
  if (!props.config || !props.model) return '待读取';
  return `默认 · ${sessionThinkingDisplayLabel(props.config.provider, props.model, settings.value?.generationConfig?.thinkingConfig)}`;
});
const selected = computed(() => {
  const value = override.value;
  if (!value || value.kind !== capability.value?.kind) return 'default';
  const key = 'tokens' in value ? String(value.tokens) : value.value;
  return options.value.some(option => option.value === key) ? key : 'default';
});
const options = computed<SettingsDropdownOption[]>(() => {
  const result: SettingsDropdownOption[] = [{ value: 'default', label: defaultLabel.value }];
  const supported = capability.value;
  if (!supported) return result;
  if ('values' in supported) {
    result.push(...supported.values.map(value => ({ value, label: value === 'none' ? '关闭' : value })));
  } else {
    const values = new Set<number>([1024, 2048, 4096, 8192, 16384, 32768, supported.min, supported.max]);
    if (supported.automatic !== undefined) values.add(supported.automatic);
    if (supported.allowZero) values.add(0);
    if (override.value && 'tokens' in override.value && override.value.kind === supported.kind) values.add(override.value.tokens);
    const maxOutput = settings.value?.generationConfig?.maxOutputTokens;
    for (const tokens of [...values].sort((a, b) => a - b)) {
      if (!(tokens === supported.automatic || (tokens === 0 && supported.allowZero) || (tokens >= supported.min && tokens <= supported.max))) continue;
      if (tokens > 0 && maxOutput !== undefined && tokens >= maxOutput) continue;
      result.push({ value: String(tokens), label: tokens === -1 ? '自动' : tokens === 0 ? '关闭' : String(tokens) });
    }
  }
  return result;
});
const error = computed(() => localError.value || pending.value?.error || store.errorFor('conversation', props.conversationId)
  || store.confirmedFor('conversation', props.conversationId)?.effectiveModelError || '');
watch(() => [props.conversationId, props.config?.id, props.model], () => { localError.value = ''; });
function modelIdentity(): ChatModelOverrideRecord {
  return { providerConfigId: props.config!.id, provider: props.config!.provider, model: props.model! };
}
function save(value: string): void {
  if (disabled.value || !options.value.some(option => option.value === value)) return;
  localError.value = '';
  try {
    let next: SessionThinkingOverride | null = null;
    if (value !== 'default') {
      if (hasThinkingBodyConflict(props.config!.provider, settings.value?.requestBody)) {
        localError.value = '自定义请求体已控制思维参数，请先在渠道设置中调整。';
        return;
      }
      const supported = capability.value!;
      next = 'min' in supported ? { kind: supported.kind, tokens: Number(value) } : { kind: supported.kind, value: value as LlmThinkingLevel };
      next = validateSessionThinkingOverride(next, props.config!.provider, props.model!, settings.value?.generationConfig, settings.value?.requestBody);
    }
    store.setThinkingForScope(props.conversationId!, modelIdentity(), next);
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error);
  }
}
function setInheritance(enabled: boolean): void {
  if (!ready.value || busy.value) return;
  store.setChildThinkingInheritance(props.conversationId!, modelIdentity(), enabled);
}
function retry(): void {
  if (!props.conversationId) return;
  localError.value = '';
  if (pending.value) store.retryPending('conversation', props.conversationId);
  else store.refreshScope('conversation', props.conversationId, { adoptRoot: true });
}
</script>

<template>
  <div class="session-thinking-control">
    <SettingsDropdown
      class="session-thinking-dropdown"
      :model-value="selected"
      :options="options"
      :disabled="disabled"
      title="思维"
      placement="top"
      @update:model-value="save"
    />
    <LcCheckbox class="session-thinking-inherit" size="sm" :model-value="inheritChildren"
      :disabled="!ready || busy" aria-label="子 Agent 继承本对话的思维设置"
      @update:model-value="setInheritance">子继承</LcCheckbox>
    <span v-if="error" class="session-thinking-error" role="status">
      {{ error }} <button type="button" :disabled="store.readingFor('conversation', conversationId)" @click="retry">重试</button>
    </span>
  </div>
</template>

<style scoped>
.session-thinking-control { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.session-thinking-dropdown { min-width: 86px; max-width: 190px; }
.session-thinking-dropdown :deep(.settings-dropdown-button) { min-height: 24px; padding: 2px 6px; font-size: 11px; }
.session-thinking-inherit { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; font-size: 11px; cursor: pointer; }
.session-thinking-error { color: var(--vscode-errorForeground); font-size: 11px; overflow-wrap: anywhere; }
.session-thinking-error button { border: 0; background: none; color: var(--vscode-textLink-foreground); padding: 0; cursor: pointer; font: inherit; }
.session-thinking-error button:disabled { opacity: .5; cursor: default; }
</style>
