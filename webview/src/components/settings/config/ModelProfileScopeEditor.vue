<script setup lang="ts">
import { computed, watch } from 'vue';
import { useGuardedSettingsDraft } from '@webview/composables/useGuardedSettingsDraft';
import type { ConfigScopeKind } from '@shared/protocol';
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import SettingsDropdown, { type SettingsDropdownOption } from '@webview/components/settings/global/SettingsDropdown.vue';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import ModelProfileSaveStatus from '@webview/components/input/ModelProfileSaveStatus.vue';
import { useModelProfileStore } from '@webview/stores/useModelProfileStore';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const INHERIT_GLOBAL_MODEL_ID = '__inherit_global_model__';

const props = withDefaults(defineProps<{ scopeKind: ConfigScopeKind; scopeId?: string; title?: string; description?: string }>(), {
  title: 'LLM 配置',
  description: ''
});

const globalSettings = useGlobalSettingsStore();
const store = useModelProfileStore();
watch(() => [props.scopeKind, props.scopeId], (_value, _old, onCleanup) => onCleanup(store.activateScope(props.scopeKind, props.scopeId)), { immediate: true });
const { loading: modelLoading, text: modelLoadingText } = useSettingsLoadingText('LLM 配置', () => props.scopeKind, () => props.scopeId, {
  globalSettingsSections: ['llm', 'llmProviderConfigs'] as const
});
const local = computed(() => store.localProfileFor(props.scopeKind, props.scopeId));
const draftState = useGuardedSettingsDraft(
  () => JSON.stringify([props.scopeKind, props.scopeId ?? '']),
  () => {
    const profile = store.confirmedFor(props.scopeKind, props.scopeId)?.profile;
    if (!profile || profile.inheritModel) return { providerConfigId: INHERIT_GLOBAL_MODEL_ID, model: '' };
    const configId = profile.providerConfigId
      ?? globalSettings.llmProviderConfigs.configs.find(config => config.provider === profile.provider)?.id
      ?? globalSettings.activeLlmProviderConfig?.id ?? globalSettings.llmProviderConfigs.configs[0]?.id ?? '';
    const config = globalSettings.llmProviderConfigs.configs.find(item => item.id === configId);
    return { providerConfigId: configId, model: profile.model ?? config?.model ?? '' };
  }
);
const providerConfigId = computed({ get: () => draftState.value.value.providerConfigId,
  set: (value: string) => { draftState.value.value = { ...draftState.value.value, providerConfigId: value }; } });
const model = computed({ get: () => draftState.value.value.model,
  set: (value: string) => { draftState.value.value = { ...draftState.value.value, model: value }; } });
const draftChangedRemotely = draftState.remoteChanged;
const isInheritSelected = computed(() => providerConfigId.value === INHERIT_GLOBAL_MODEL_ID);
const inheritedModelText = computed(() => {
  const config = globalSettings.activeLlmProviderConfig;
  return config?.model ? `${config.name} · ${config.model}` : '使用全局/对话当前渠道与 LLM';
});
const options = computed<SettingsDropdownOption[]>(() => [
  {
    value: INHERIT_GLOBAL_MODEL_ID,
    label: '继承全局',
    description: inheritedModelText.value
  },
  ...globalSettings.llmProviderConfigs.configs.map((config) => ({
    value: config.id,
    label: config.name,
    description: config.model || config.provider
  }))
]);
const activeConfig = computed(() => globalSettings.llmProviderConfigs.configs.find((config) => config.id === providerConfigId.value));
const selectedProviderConfigId = computed({
  get: () => providerConfigId.value,
  set: (value: string) => {
    providerConfigId.value = value || INHERIT_GLOBAL_MODEL_ID;
    if (providerConfigId.value === INHERIT_GLOBAL_MODEL_ID) {
      model.value = '';
      if (local.value.profile) {
        draftState.markSubmitted();
        store.clearProfileScope(props.scopeKind, props.scopeId);
      }
      return;
    }
    const config = globalSettings.llmProviderConfigs.configs.find((item) => item.id === providerConfigId.value);
    if (config && (!model.value.trim() || model.value === globalSettings.activeLlmProviderConfig?.model)) model.value = config.model;
  }
});


function save(): void {
  if (isInheritSelected.value) {
    draftState.markSubmitted();
    store.clearProfileScope(props.scopeKind, props.scopeId);
    return;
  }
  const config = activeConfig.value;
  model.value = model.value.trim();
  draftState.markSubmitted();
  store.setProfileForScope(props.scopeKind, props.scopeId, { providerConfigId: providerConfigId.value, provider: config?.provider, model: model.value.trim(), name: `${props.scopeKind} Model Profile` });
}
</script>

<template>
  <section class="model-profile-editor">
    <header class="model-profile-header">
      <div>
        <h3>
          {{ title }}
          <SettingsLoadingInline :show="modelLoading" :text="modelLoadingText" />
        </h3>
        <p v-if="description">{{ description }}</p>
      </div>
       <span>{{ local.profile ? '当前范围已配置' : '继承全局' }}</span>
    </header>
    <div class="model-profile-grid">
      <label>
        <span>LLM 来源</span>
        <SettingsDropdown v-model="selectedProviderConfigId" :options="options" title="选择 LLM 来源" searchable search-placeholder="筛选 LLM 来源…" />
      </label>
      <label>
        <span>LLM</span>
        <input v-model="model" type="text" :disabled="isInheritSelected" :placeholder="isInheritSelected ? inheritedModelText : '例如 deepseek-v4-flash'" />
      </label>
    </div>
    <template v-if="draftChangedRemotely">
      <span role="status">已保存内容有更新，当前草稿已保留</span>
      <button type="button" @click="draftState.reset()">读取已保存值</button>
    </template>
    <ModelProfileSaveStatus :scope-kind="scopeKind" :scope-id="scopeId" />
    <div class="model-profile-actions">
      <button v-if="!isInheritSelected" type="button" :disabled="!model.trim()" @click="save">保存 LLM 配置</button>
      <span v-else>当前将继承全局/对话的 LLM 配置。</span>
      <span>{{ store.status }}</span>
    </div>
  </section>
</template>

<style scoped>
.model-profile-editor { display: flex; flex-direction: column; gap: var(--space-2); }
.model-profile-header { display: flex; justify-content: space-between; gap: var(--space-3); color: var(--vscode-descriptionForeground); }
h3 { margin: 0; color: var(--vscode-foreground); font-size: var(--font-size-md); }
p { margin: 2px 0 0; font-size: var(--font-size-sm); }
.model-profile-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-3); }
label { min-width: 0; display: flex; flex-direction: column; gap: var(--space-1); color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); }
input { width: 100%; box-sizing: border-box; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: var(--radius-sm); background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: var(--space-2); font: inherit; }
input:disabled { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); opacity: 0.75; }
.model-profile-actions { display: flex; align-items: center; gap: var(--space-2); color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); }
.model-profile-actions button {
  min-height: 28px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: transparent;
}
.model-profile-actions button:hover:not(:disabled),
.model-profile-actions button:focus-visible,
.model-profile-actions button:active {
  border-color: var(--vscode-panel-border);
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}
.model-profile-actions button:disabled {
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  background: transparent;
  opacity: 0.55;
}
</style>
