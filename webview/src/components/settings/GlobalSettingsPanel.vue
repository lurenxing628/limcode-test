<script setup lang="ts">
import SettingsScopeLayout from './SettingsScopeLayout.vue';
import DataRootPromptPanel from './global/DataRootPromptPanel.vue';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import {
  DEFAULT_GLOBAL_SETTINGS_TAB,
  GLOBAL_SETTINGS_TABS
} from './global/globalSettingsTabs';

const settings = useGlobalSettingsStore();
</script>

<template>
  <div class="global-settings-root">
    <div v-if="settings.hasExternalSettingsChange" class="external-settings-banner" role="status">
      <span>其他窗口也修改了设置，本窗口尚未保存的内容没有被覆盖。</span>
      <span class="external-settings-actions">
        <button type="button" @click="settings.dismissExternalSettingsChange()">保留当前</button>
        <button type="button" @click="settings.applyExternalSettingsChange()">载入外部</button>
      </span>
    </div>
    <SettingsScopeLayout
      :tabs="GLOBAL_SETTINGS_TABS"
      :default-tab="DEFAULT_GLOBAL_SETTINGS_TAB"
      settings-label="全局设置"
    />
    <DataRootPromptPanel />
  </div>
</template>

<style src="./global/settingsTabContent.css"></style>

<style scoped>
.global-settings-root {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.global-settings-root :deep(.settings-panel) {
  flex: 1 1 auto;
}

.external-settings-banner {
  flex: 0 0 auto;
  min-height: 34px;
  padding: var(--space-2);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-foreground) 10%);
}

.external-settings-actions {
  display: inline-flex;
  gap: var(--space-1);
}

.external-settings-actions button {
  padding: 3px var(--space-2);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: transparent;
}

.external-settings-actions button:hover,
.external-settings-actions button:focus-visible {
  background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-foreground) 18%);
  outline: none;
}
</style>
