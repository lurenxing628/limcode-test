<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ChatModelOverrideRecord, LlmProviderConfigRecord, LlmThinkingLevel, SessionThinkingOverride } from '@shared/protocol';
import { INACTIVE_SESSION_THINKING_NOTICE, UNSET_THINKING_LABEL, resolveSavedSessionThinkingOverride, sessionThinkingCapability, sessionThinkingDisplayLabel, validateSessionThinkingOverride } from '@shared/sessionThinking';
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
  ? sessionThinkingCapability(props.config.provider, props.model, settings.value?.generationConfig?.maxOutputTokens, settings.value?.generationConfig?.thinkingConfig, props.config)
  : undefined);
const pending = computed(() => store.pendingFor('conversation', props.conversationId));
const override = computed(() => store.thinkingFor('conversation', props.conversationId));
/** 已保存的覆盖在当前模型上是否生效：与请求冻结同一套容错解析（升级改名的强度类 kind 照常生效）。 */
const saved = computed(() => override.value && props.config && props.model
  ? resolveSavedSessionThinkingOverride(override.value, props.config.provider, props.model, settings.value?.generationConfig, settings.value?.requestBody, props.config)
  : undefined);
const inactiveOverride = computed(() => saved.value?.status === 'inactive' ? saved.value : undefined);
const inheritChildren = computed(() => store.childThinkingInheritanceFor('conversation', props.conversationId));
const ready = computed(() => !!props.conversationId && !!props.config && !!props.model);
const busy = computed(() => pending.value?.status === 'saving');
// 没有可选强度时也要能打开：清掉不生效的旧覆盖，或取消面板底部的“子 Agent 也用”。
const disabled = computed(() => !ready.value || busy.value || (!capability.value && !inactiveOverride.value && !inheritChildren.value));
/** What the channel/model configuration itself sends when this conversation does not override it. */
const channelValue = computed(() => props.config && props.model
  ? sessionThinkingDisplayLabel(props.config.provider, props.model, settings.value?.generationConfig?.thinkingConfig, props.config)
  : '');
const defaultLabel = computed(() => props.config && props.model ? `跟随渠道设置：${channelValue.value}` : '正在读取渠道设置');
const LEVEL_NAMES: Record<string, string> = {
  none: '关闭思考', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高'
};
const INACTIVE_VALUE = 'saved-inactive';
const selected = computed(() => {
  if (inactiveOverride.value) return INACTIVE_VALUE;
  const value = saved.value?.status === 'applied' ? saved.value.override : undefined;
  if (!value || value.kind !== capability.value?.kind) return 'default';
  const key = 'tokens' in value ? String(value.tokens) : value.value;
  return options.value.some(option => option.value === key) ? key : 'default';
});
function savedValueLabel(): string {
  const value = override.value;
  if (!value) return '';
  if ('tokens' in value) return value.tokens === -1 ? '自动预算' : value.tokens === 0 ? '关闭思考' : `${value.tokens} tokens`;
  return LEVEL_NAMES[value.value] ?? value.value;
}
const options = computed<SettingsDropdownOption[]>(() => {
  const result: SettingsDropdownOption[] = [{
    value: 'default',
    label: defaultLabel.value,
    buttonLabel: channelValue.value && channelValue.value !== UNSET_THINKING_LABEL ? `思考：跟随渠道（${channelValue.value}）` : '思考：跟随渠道',
    description: '使用渠道或模型高级配置里的设置'
  }];
  if (inactiveOverride.value) {
    // 单独列出不生效的旧覆盖：再选“跟随渠道”时值确实改变，才会真正清掉它。
    result.push({
      value: INACTIVE_VALUE,
      label: `已保存：${savedValueLabel()}（当前不生效）`,
      buttonLabel: `思考：已保存的${savedValueLabel()}不生效`,
      description: `${inactiveOverride.value.reason}选择“跟随渠道”即可清除。`,
      disabled: true
    });
  }
  const supported = capability.value;
  if (!supported) return result;
  if ('values' in supported) {
    result.push(...supported.values.map(value => {
      const name = LEVEL_NAMES[value] ?? value;
      return {
        value,
        label: value === 'none' ? name : `${name}（${value}）`,
        buttonLabel: `思考：${value === 'none' ? '关闭' : name}`
      };
    }));
  } else {
    const values = new Set<number>([1024, 2048, 4096, 8192, 16384, 32768, supported.min, supported.max]);
    if (supported.automatic !== undefined) values.add(supported.automatic);
    if (supported.allowZero) values.add(0);
    if (override.value && 'tokens' in override.value && override.value.kind === supported.kind) values.add(override.value.tokens);
    const maxOutput = settings.value?.generationConfig?.maxOutputTokens;
    for (const tokens of [...values].sort((a, b) => a - b)) {
      if (!(tokens === supported.automatic || (tokens === 0 && supported.allowZero) || (tokens >= supported.min && tokens <= supported.max))) continue;
      if (tokens > 0 && maxOutput !== undefined && tokens >= maxOutput) continue;
      const label = tokens === -1 ? '自动预算' : tokens === 0 ? '关闭思考' : `思考预算 ${tokens} tokens`;
      result.push({
        value: String(tokens),
        label,
        buttonLabel: tokens === -1 ? '思考：自动预算' : tokens === 0 ? '思考：关闭' : `思考：${tokens} tokens`
      });
    }
  }
  return result;
});
/** The button shows the chosen strength, plus a short marker when child Agents follow it (not for the channel default). */
const displayOptions = computed(() => inheritChildren.value
  ? options.value.map(option => option.value === 'default' || option.value === INACTIVE_VALUE
    ? option
    : { ...option, buttonLabel: `${option.buttonLabel ?? option.label} · 含子 Agent` })
  : options.value);
const hint = computed(() => [
  '这个对话使用的思考强度，下一次请求开始生效，不影响其他对话。',
  `“跟随渠道”即渠道或模型高级配置里的值，当前是：${channelValue.value || '读取中'}。`,
  ...(inactiveOverride.value ? [inactiveOverride.value.reason || INACTIVE_SESSION_THINKING_NOTICE] : []),
  inheritChildren.value ? '这个对话派出的子 Agent 也使用这里的选择。' : '子 Agent 按它自己的 Agent 设置。'
].join('\n'));
/** 面板至少 280px 宽；靠近窗口右边时向左移，窗口太窄时贴住左边距。 */
function panelOffset(left: number, width: number, viewport: number): number {
  const panelWidth = Math.min(Math.max(width, 280), viewport - 16);
  return Math.max(8 - left, Math.min(0, viewport - 8 - (left + panelWidth)));
}
const panelLeft = ref(0);
const root = ref<HTMLElement | null>(null);
function alignPanel(): void {
  const dropdown = root.value?.querySelector('.session-thinking-dropdown');
  if (!dropdown || typeof window === 'undefined') return;
  const rect = dropdown.getBoundingClientRect();
  panelLeft.value = panelOffset(rect.left, rect.width, window.innerWidth);
}
const error = computed(() => localError.value || pending.value?.error || store.errorFor('conversation', props.conversationId)
  || store.confirmedFor('conversation', props.conversationId)?.effectiveModelError || '');
watch(() => [props.conversationId, props.config?.id, props.model], () => { localError.value = ''; });
function modelIdentity(): ChatModelOverrideRecord {
  return { providerConfigId: props.config!.id, provider: props.config!.provider, model: props.model! };
}
function save(value: string): void {
  if (disabled.value || value === INACTIVE_VALUE || !options.value.some(option => option.value === value)) return;
  localError.value = '';
  try {
    let next: SessionThinkingOverride | null = null;
    if (value !== 'default') {
      if (hasThinkingBodyConflict(props.config!.provider, settings.value?.requestBody)) {
        localError.value = '自定义请求体已控制思维参数，请先在渠道设置中调整。';
        return;
      }
      const supported = capability.value;
      if (!supported) return;
      next = 'min' in supported ? { kind: supported.kind, tokens: Number(value) } : { kind: supported.kind, value: value as LlmThinkingLevel };
      next = validateSessionThinkingOverride(next, props.config!.provider, props.model!, settings.value?.generationConfig, settings.value?.requestBody, props.config);
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
  <div ref="root" class="session-thinking-control" :title="hint" :style="{ '--session-thinking-panel-left': `${panelLeft}px` }">
    <SettingsDropdown
      class="session-thinking-dropdown"
      :model-value="selected"
      :options="displayOptions"
      :disabled="disabled"
      title="这个对话的思考强度（下一次请求生效）"
      placement="top"
      :max-height="320"
      @open="alignPanel"
      @update:model-value="save"
    >
      <template #footer>
        <LcCheckbox class="session-thinking-inherit" size="sm" :model-value="inheritChildren"
          :disabled="!ready || busy || (!capability && !inheritChildren)" aria-label="这个对话派出的子 Agent 也使用这里的思考强度"
          @update:model-value="setInheritance">派出的子 Agent 也用这个思考强度</LcCheckbox>
        <p class="session-thinking-inherit-hint">不勾选时，子 Agent 按它自己的 Agent 设置。</p>
      </template>
    </SettingsDropdown>
    <span v-if="error" class="session-thinking-error" role="status" :title="error">
      <span class="session-thinking-error-text">{{ error }}</span>
      <button type="button" :disabled="store.readingFor('conversation', conversationId)" @click="retry">重试</button>
    </span>
  </div>
</template>

<style scoped>
.session-thinking-control { display: inline-flex; align-items: center; flex-wrap: nowrap; gap: 6px; min-width: 0; max-width: 100%; }
/* Sized by its label (up to 260px) so the chosen strength stays readable; longer labels end with an ellipsis. */
.session-thinking-dropdown { width: max-content; max-width: min(260px, 100%); min-width: 96px; --lc-dropdown-transform-origin: bottom left; --lc-dropdown-offset-y: 4px; }
/* Same quiet look as the neighbouring Agent / channel / directory selectors in the composer. */
.session-thinking-dropdown :deep(button.settings-dropdown-button) {
  min-height: 24px; padding: 2px 6px; border-color: transparent; background: transparent;
  color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm);
}
.session-thinking-dropdown :deep(button.settings-dropdown-button:hover:not(:disabled)),
.session-thinking-dropdown :deep(button.settings-dropdown-button[aria-expanded='true']),
.session-thinking-dropdown :deep(button.settings-dropdown-button:focus-visible) {
  color: var(--vscode-foreground); border-color: var(--vscode-panel-border, transparent);
  background: var(--vscode-list-hoverBackground, transparent);
}
/* At least 280px wide, never wider than the window; alignPanel() shifts it left near the right edge. */
.session-thinking-dropdown :deep(.settings-dropdown-panel) { width: max(100%, 280px); max-width: calc(100vw - 16px); left: var(--session-thinking-panel-left, 0px); }
.session-thinking-inherit { display: inline-flex; align-items: center; gap: 6px; white-space: normal; font-size: var(--font-size-sm); cursor: pointer; }
.session-thinking-inherit-hint { margin: 4px 0 0 22px; color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); white-space: normal; }
.session-thinking-error { display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 220px; color: var(--vscode-errorForeground); font-size: 11px; }
.session-thinking-error-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-thinking-error button { flex: 0 0 auto; border: 0; background: none; color: var(--vscode-textLink-foreground); padding: 0; cursor: pointer; font: inherit; }
.session-thinking-error button:disabled { opacity: .5; cursor: default; }
</style>
