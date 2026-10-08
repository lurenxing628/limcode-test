<script setup lang="ts">
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import RuntimeContextScopeEditor from '@webview/components/settings/config/RuntimeContextScopeEditor.vue';
import SystemPromptScopeEditor from '@webview/components/settings/config/SystemPromptScopeEditor.vue';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const { loading: promptLoading, text: promptLoadingText } = useSettingsLoadingText('提示词配置', 'global');
</script>

<template>
  <section class="global-settings-tab-section" aria-label="提示词配置">
    <header class="global-settings-section-header">
      <div>
        <h2>
          提示词
          <SettingsLoadingInline :show="promptLoading" :text="promptLoadingText" />
        </h2>
        <p>系统提示词用于保持行为一致；初始上下文用于载入时间、工作环境等变量，默认不会在每次请求时自动刷新。</p>
      </div>
    </header>

    <SystemPromptScopeEditor
      scope-kind="global"
      title="全局系统提示词"
      description="所有 Agent、工作流和对话都会继承这里的规则。可插入 Agent、工作流等稳定占位符。"
    />

    <RuntimeContextScopeEditor
      scope-kind="global"
      title="全局初始上下文模板"
      description="用于生成新对话初始上下文的默认模板。时间、工作环境等变量在首次启动时生成，之后保持不变。"
    />
  </section>
</template>
