<script setup lang="ts">
import { onMounted } from 'vue';
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import StreamingIndicatorTail from '@webview/components/content/StreamingIndicatorTail.vue';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const settings = useGlobalSettingsStore();
const { loading: appearanceLoading, text: appearanceLoadingText } = useSettingsLoadingText('外观设置', 'global', undefined, {
  globalSettingsSections: ['appearance'] as const
});

onMounted(() => {
  settings.ensureAppearance();
});
</script>

<template>
  <section class="global-settings-tab-section" aria-label="外观设置">
    <header class="global-settings-section-header">
      <div>
        <h2>
          外观
          <SettingsLoadingInline :show="appearanceLoading" :text="appearanceLoadingText" />
        </h2>
        <p>自定义 LLM 流式输出时的状态提示文字。文字会以波浪动画追加到内容末尾。</p>
      </div>
    </header>

    <div class="appearance-group">
      <h3 class="appearance-group-title">显示</h3>
      <div class="global-settings-field">
        <LcCheckbox
          :model-value="settings.appearance.conciseMode"
          size="sm"
          aria-label="简洁模式"
          @update:model-value="settings.appearance.conciseMode = $event"
        >
          <span class="global-settings-checkbox-label">简洁模式</span>
        </LcCheckbox>
        <small class="appearance-field-hint">工具调用只显示收起的一行，不再边生成边展开参数和结果，点开才看详情。需要你确认或回答的内容仍会展开。</small>
      </div>
    </div>

    <div class="appearance-group">
      <h3 class="appearance-group-title">自定义 LLM 响应文字</h3>

      <label class="global-settings-field">
        <span>整理上下文时</span>
        <input
          v-model="settings.appearance.streamingTextPreparing"
          type="text"
          placeholder="...少女整理中"
        />
        <small class="appearance-field-hint">应用内部正在整理上下文、调度下一轮响应时显示</small>
      </label>

      <label class="global-settings-field">
        <span>等待响应时</span>
        <input
          v-model="settings.appearance.streamingTextWaiting"
          type="text"
          placeholder="...少女等待中"
        />
        <small class="appearance-field-hint">LLM 收到请求后、尚未输出任何内容时显示</small>
      </label>

      <label class="global-settings-field">
        <span>思考中</span>
        <input
          v-model="settings.appearance.streamingTextThinking"
          type="text"
          placeholder="...少女思考中"
        />
        <small class="appearance-field-hint">LLM 正在输出思考内容时显示</small>
      </label>

      <label class="global-settings-field">
        <span>输出正文中</span>
        <input
          v-model="settings.appearance.streamingTextWriting"
          type="text"
          placeholder="...少女编写中"
        />
        <small class="appearance-field-hint">LLM 正在输出正文回复时显示</small>
      </label>

      <label class="global-settings-field">
        <span>执行工具中</span>
        <input
          v-model="settings.appearance.streamingTextToolExecuting"
          type="text"
          placeholder="...少女执行中"
        />
        <small class="appearance-field-hint">LLM 已输出工具调用、工具正在等待或执行时显示</small>
      </label>
    </div>

    <div class="appearance-preview">
      <h3 class="appearance-group-title">预览</h3>
      <div class="appearance-preview-item">
        <span class="appearance-preview-label">整理上下文</span>
        <StreamingIndicatorTail :text="settings.appearance.streamingTextPreparing" variant="preparing" />
      </div>
      <div class="appearance-preview-item">
        <span class="appearance-preview-label">等待响应</span>
        <StreamingIndicatorTail :text="settings.appearance.streamingTextWaiting" variant="waiting" />
      </div>
      <div class="appearance-preview-item">
        <span class="appearance-preview-label">思考中</span>
        <StreamingIndicatorTail :text="settings.appearance.streamingTextThinking" variant="thinking" />
      </div>
      <div class="appearance-preview-item">
        <span class="appearance-preview-label">输出正文</span>
        <StreamingIndicatorTail :text="settings.appearance.streamingTextWriting" variant="writing" />
      </div>
      <div class="appearance-preview-item">
        <span class="appearance-preview-label">执行工具</span>
        <StreamingIndicatorTail :text="settings.appearance.streamingTextToolExecuting" variant="executing" />
      </div>
    </div>

    <div class="global-settings-actions">
      <button type="button" @click="settings.saveAppearance()">保存外观设置</button>
      <button type="button" class="secondary" @click="settings.ensureAppearance()">重新读取</button>
      <span class="global-settings-status">{{ settings.status }}</span>
    </div>
  </section>
</template>

<style scoped>
.appearance-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.appearance-group-title {
  margin: 0 0 var(--space-1);
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--vscode-foreground);
}

.appearance-field-hint {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.appearance-preview {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-foreground) 5%);
}

.appearance-preview-item {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
}

.appearance-preview-label {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  white-space: nowrap;
  min-width: 60px;
}
</style>
