<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { ConfigScopeKind } from '@shared/protocol';
import { DEFAULT_INTEGRATED_SYSTEM_PROMPT } from '@shared/defaultSystemPrompt';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import { useSystemPromptStore } from '@webview/stores/useSystemPromptStore';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const props = withDefaults(defineProps<{ scopeKind: ConfigScopeKind; scopeId?: string; title?: string; description?: string }>(), {
  title: '系统提示词',
  description: ''
});

const store = useSystemPromptStore();
const { loading: promptLoading, text: promptLoadingText } = useSettingsLoadingText('提示词配置', () => props.scopeKind, () => props.scopeId);
const scroller = ref<HTMLTextAreaElement | null>(null);
const defaultScroller = ref<HTMLTextAreaElement | null>(null);
const builtInGlobalPrompt = DEFAULT_INTEGRATED_SYSTEM_PROMPT;
const draft = ref('');
const inheritMode = ref(false);
const currentScopeKey = ref('');
const local = computed(() => store.localPromptFor(props.scopeKind, props.scopeId));
const resolution = computed(() => store.promptResolutionFor(props.scopeKind, props.scopeId));
const placeholders = computed(() => store.systemPlaceholders);
const isInherited = computed(() => props.scopeKind !== 'global' && inheritMode.value && !local.value.prompt);
const canRestoreScope = computed(() => props.scopeKind === 'global' ? !!local.value.link || !!local.value.prompt : !isInherited.value);
const restoreButtonLabel = computed(() => props.scopeKind === 'global' ? '恢复默认' : '恢复继承');
const canSave = computed(() => !isInherited.value && draft.value.trim().length > 0);
const statusLabel = computed(() => {
  if (props.scopeKind === 'global') {
    if (local.value.prompt?.text.trim()) return '全局已配置';
    if (local.value.link || local.value.prompt) return '全局覆盖为空';
    return '使用内置默认';
  }
  if (local.value.prompt) return '当前范围已配置';
  return resolution.value.inheritedText ? '继承上级 / 内置' : '继承中（上级未配置）';
});
const inheritedStatusText = computed(() => resolution.value.inheritedText
  ? '当前显示继承得到的提示词；不会保存到当前范围。'
  : '当前继承上级配置；上级暂未提供提示词。'
);
const promptPlaceholder = computed(() => isInherited.value
  ? '上级或内置提示词暂未配置；点击“自定义提示词”可为当前范围追加内容。'
  : '输入当前范围要追加的系统提示词…'
);

watch(() => [props.scopeKind, props.scopeId, local.value.prompt?.id, local.value.prompt?.text, resolution.value.inheritedText], () => {
  const nextScopeKey = `${props.scopeKind}:${props.scopeId ?? ''}`;
  const scopeChanged = currentScopeKey.value !== nextScopeKey;
  currentScopeKey.value = nextScopeKey;

  if (props.scopeKind === 'global') {
    inheritMode.value = false;
    draft.value = local.value.prompt?.text ?? '';
    return;
  }
  if (local.value.prompt) {
    inheritMode.value = false;
    draft.value = local.value.prompt.text;
    return;
  }
  if (scopeChanged || inheritMode.value) {
    inheritMode.value = true;
    draft.value = resolution.value.inheritedText;
  }
}, { immediate: true });

function onInput(event: Event): void {
  if (isInherited.value) return;
  draft.value = (event.target as HTMLTextAreaElement | null)?.value ?? '';
}

function save(): void {
  if (!canSave.value) return;
  store.setPromptForScope(props.scopeKind, props.scopeId, draft.value, `${props.scopeKind} System Prompt`);
}

function clear(): void {
  store.clearPromptScope(props.scopeKind, props.scopeId);
  if (props.scopeKind === 'global') {
    draft.value = '';
    return;
  }
  inheritMode.value = true;
  draft.value = resolution.value.inheritedText;
}

function startCustom(): void {
  if (props.scopeKind === 'global') return;
  inheritMode.value = false;
  draft.value = local.value.prompt?.text ?? resolution.value.inheritedText;
  void nextTick(() => scroller.value?.focus());
}

function insertPlaceholder(token: string): void {
  if (isInherited.value) return;
  const textarea = scroller.value;
  if (!textarea) {
    draft.value += token;
    return;
  }
  const start = textarea.selectionStart ?? draft.value.length;
  const end = textarea.selectionEnd ?? start;
  draft.value = `${draft.value.slice(0, start)}${token}${draft.value.slice(end)}`;
  void nextTick(() => {
    textarea.focus();
    const nextPosition = start + token.length;
    textarea.setSelectionRange(nextPosition, nextPosition);
  });
}
</script>

<template>
  <section class="scope-editor">
    <header class="scope-editor-header">
      <div>
        <h3>
          {{ title }}
          <SettingsLoadingInline :show="promptLoading" :text="promptLoadingText" />
        </h3>
        <p v-if="description">{{ description }}</p>
      </div>
      <span>{{ statusLabel }}</span>
    </header>
    <div class="prompt-shell" :class="{ 'is-inherited': isInherited }">
      <div v-if="placeholders.length > 0" class="placeholder-bar" aria-label="可插入的系统提示词变量">
        <button v-for="placeholder in placeholders" :key="placeholder.id" type="button" class="placeholder-chip" :disabled="isInherited" @click="insertPlaceholder(placeholder.token)">
          <span>{{ placeholder.token }}</span>
          <small>{{ placeholder.label }}</small>
        </button>
      </div>
      <textarea ref="scroller" :value="draft" :readonly="isInherited" rows="8" :placeholder="promptPlaceholder" @input="onInput"></textarea>
      <AdvancedScrollbar :scroller="scroller" variant="minimal" />
    </div>
    <div v-if="scopeKind === 'global'" class="builtin-prompt-shell">
      <span>内置默认提示词 · {{ local.prompt ? '已被上方的自定义提示词取代' : '当前生效' }}</span>
      <div class="prompt-shell is-inherited">
        <textarea ref="defaultScroller" :value="builtInGlobalPrompt" readonly rows="6" aria-label="内置默认系统提示词"></textarea>
        <AdvancedScrollbar :scroller="defaultScroller" variant="minimal" />
      </div>
    </div>
    <div class="scope-editor-actions">
      <button v-if="isInherited" type="button" @click="startCustom">自定义提示词</button>
      <button v-else type="button" :disabled="!canSave" @click="save">保存提示词</button>
      <button type="button" class="secondary" :disabled="!canRestoreScope" @click="clear">{{ restoreButtonLabel }}</button>
      <span v-if="isInherited">{{ inheritedStatusText }}</span>
      <span v-else>{{ store.status }}</span>
    </div>
  </section>
</template>

<style scoped>
.scope-editor { display: flex; flex-direction: column; gap: var(--space-2); }
.scope-editor-header { display: flex; justify-content: space-between; gap: var(--space-3); color: var(--vscode-descriptionForeground); }
h3 { margin: 0; color: var(--vscode-foreground); font-size: var(--font-size-md); }
p { margin: 2px 0 0; font-size: var(--font-size-sm); }
.prompt-shell { position: relative; min-height: 130px; }
.prompt-shell.is-inherited textarea { color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-input-background) 92%, var(--vscode-foreground) 8%); }
.placeholder-bar { display: flex; flex-wrap: wrap; gap: var(--space-1); margin-bottom: var(--space-2); }
.placeholder-chip { border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%); color: var(--vscode-foreground); display: inline-flex; align-items: center; gap: 6px; padding: 3px 7px; font: inherit; }
.placeholder-chip small { color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); }
.placeholder-chip:hover:not(:disabled),
.placeholder-chip:focus-visible:not(:disabled) { background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 14%)); outline: none; }
.placeholder-chip:disabled { opacity: 0.55; }
textarea { width: 100%; min-height: 130px; box-sizing: border-box; resize: vertical; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: var(--radius-sm); background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: var(--space-2); font: inherit; scrollbar-width: none; }
textarea:read-only { cursor: text; }
textarea::-webkit-scrollbar { display: none; }
.builtin-prompt-shell { display: flex; flex-direction: column; gap: var(--space-1); color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); }
.builtin-prompt-shell .prompt-shell { min-height: 110px; }
.builtin-prompt-shell textarea { min-height: 110px; }
.scope-editor-actions { display: flex; align-items: center; gap: var(--space-2); color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); flex-wrap: wrap; }
.scope-editor-actions button {
  min-height: 28px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: transparent;
}
.scope-editor-actions button:hover:not(:disabled),
.scope-editor-actions button:focus-visible,
.scope-editor-actions button:active {
  border-color: var(--vscode-panel-border);
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}
.scope-editor-actions button.secondary {
  color: var(--vscode-descriptionForeground);
}
.scope-editor-actions button:disabled {
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  background: transparent;
  opacity: 0.55;
}
</style>
