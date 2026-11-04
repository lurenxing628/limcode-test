<script setup lang="ts">
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import WorkEnvironmentPolicyEditor from '@webview/components/settings/workEnvironment/WorkEnvironmentPolicyEditor.vue';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const { loading: workEnvironmentLoading, text: workEnvironmentLoadingText } = useSettingsLoadingText('工作环境配置', 'global');
</script>

<template>
  <section class="global-settings-tab-section" aria-label="工作环境配置">
    <header class="global-settings-section-header">
      <div>
        <h2>
          工作环境
          <SettingsLoadingInline :show="workEnvironmentLoading" :text="workEnvironmentLoadingText" />
        </h2>
        <p>已打开的本地目录默认自动允许，切换项目不需要逐个授权；服务器环境仍按允许列表设置。子 Agent 继承派出它的主 Agent 的工作目录和范围。</p>
      </div>
    </header>

    <WorkEnvironmentPolicyEditor
      scope-kind="global"
      title="全局默认工作环境策略"
      description="自动允许仅覆盖当前窗口已打开的本地目录，关闭后可手动限制允许列表。输入框可手动选择允许目录；启用切换工具后向模型提供相应工具。‘允许使用项目外路径’工具开关优先级最高，开启后不再受这些根目录限制。"
    />
  </section>
</template>
