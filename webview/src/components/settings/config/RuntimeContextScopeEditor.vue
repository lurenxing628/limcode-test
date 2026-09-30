<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useGuardedSettingsDraft } from '@webview/composables/useGuardedSettingsDraft';
import type { ConfigScopeKind } from '@shared/protocol';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import { useRuntimeContextStore } from '@webview/stores/useRuntimeContextStore';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const props = withDefaults(defineProps<{ scopeKind: ConfigScopeKind; scopeId?: string; title?: string; description?: string }>(), {
  title: '初始上下文',
  description: ''
});

const store = useRuntimeContextStore();
const { loading: runtimeLoading, text: runtimeLoadingText } = useSettingsLoadingText('初始上下文配置', () => props.scopeKind, () => props.scopeId);
const scroller = ref<HTMLTextAreaElement | null>(null);
const local = computed(() => store.localContextFor(props.scopeKind, props.scopeId));
const placeholders = computed(() => store.runtimePlaceholders);

const draftState = useGuardedSettingsDraft(
  () => JSON.stringify([props.scopeKind, props.scopeId ?? '']),
  () => ({ text: local.value.runtimeContext?.template ?? '' })
);
const draft = computed({ get: () => draftState.value.value.text, set: (text: string) => { draftState.value.value = { text }; } });
const draftChangedRemotely = draftState.remoteChanged;
watch(() => store.completedSaveFor(props.scopeKind, props.scopeId), requestId => {
  if (requestId) draftState.confirmSubmitted(requestId);
}, { flush: 'sync' });

function save(): void {
  draft.value = draft.value.trim();
  const requestId = store.setContextForScope(props.scopeKind, props.scopeId, draft.value, `${props.scopeKind} Runtime Context`);
  if (requestId) draftState.markSubmitted(requestId);
}
function clear(): void {
  const requestId = store.clearContextScope(props.scopeKind, props.scopeId);
  if (!requestId) return;
  draft.value = '';
  draftState.markSubmitted(requestId);
}
function insertPlaceholder(token: string): void {
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
  <section class="runtime-editor">
    <header class="runtime-editor-header">
      <div>
        <h3>
          {{ title }}
          <SettingsLoadingInline :show="runtimeLoading" :text="runtimeLoadingText" />
        </h3>
        <p v-if="description">{{ description }}</p>
      </div>
      <span>{{ local.runtimeContext ? '当前范围已配置' : scopeKind === 'global' ? '等待默认模板' : '继承上级模板' }}</span>
    </header>

    <div class="runtime-hint">
      这里编辑的是新任务使用的初始上下文模板。每次开始新任务时都会生成独立内容；已开始的任务不会受后续设置修改影响。
    </div>

    <div class="runtime-shell">
      <div v-if="placeholders.length > 0" class="placeholder-bar" aria-label="可插入的初始变量">
        <button v-for="placeholder in placeholders" :key="placeholder.id" type="button" class="placeholder-chip" @click="insertPlaceholder(placeholder.token)">
          <span>{{ placeholder.token }}</span>
          <small>{{ placeholder.label }}</small>
        </button>
      </div>
      <textarea ref="scroller" v-model="draft" rows="8" placeholder="输入初始上下文模板，例如 Initial time: {{$runtime.timestamp}}"></textarea>
      <AdvancedScrollbar :scroller="scroller" variant="minimal" />
    </div>

    <div class="runtime-actions">
      <button type="button" :disabled="!draft.trim()" @click="save">保存模板</button>
      <button type="button" class="secondary" :disabled="scopeKind === 'global' || !local.runtimeContext" @click="clear">恢复继承</button>
      <span>{{ store.status }}</span>
      <template v-if="draftChangedRemotely">
        <span role="status">已保存内容有更新，当前草稿已保留</span>
        <button type="button" class="secondary" @click="draftState.reset()">读取已保存值</button>
      </template>
    </div>
  </section>
</template>

<style scoped>
.runtime-editor { display: flex; flex-direction: column; gap: var(--space-2); }
.runtime-editor-header { display: flex; justify-content: space-between; gap: var(--space-3); color: var(--vscode-descriptionForeground); }
h3 { margin: 0; color: var(--vscode-foreground); font-size: var(--font-size-md); }
p { margin: 2px 0 0; font-size: var(--font-size-sm); }
.runtime-hint { border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); padding: var(--space-2); color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%); font-size: var(--font-size-sm); }
.runtime-shell { position: relative; min-height: 130px; }
.placeholder-bar { display: flex; flex-wrap: wrap; gap: var(--space-1); margin-bottom: var(--space-2); }
.placeholder-chip { border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%); color: var(--vscode-foreground); display: inline-flex; align-items: center; gap: 6px; padding: 3px 7px; font: inherit; }
.placeholder-chip small { color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); }
.placeholder-chip:hover,
.placeholder-chip:focus-visible { background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 14%)); outline: none; }
textarea { width: 100%; min-height: 130px; box-sizing: border-box; resize: vertical; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: var(--radius-sm); background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: var(--space-2); font: inherit; scrollbar-width: none; }
textarea::-webkit-scrollbar { display: none; }
.runtime-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); }
.runtime-actions button { min-height: 28px; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); color: var(--vscode-foreground); background: transparent; }
.runtime-actions button:hover:not(:disabled),
.runtime-actions button:focus-visible,
.runtime-actions button:active { border-color: var(--vscode-panel-border); background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%)); outline: none; }
.runtime-actions button.secondary { color: var(--vscode-descriptionForeground); }
.runtime-actions button:disabled { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); background: transparent; opacity: 0.55; }
</style>
