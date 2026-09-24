<script setup lang="ts">
import { computed } from 'vue';
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import { useConversationSettingsStore } from '@webview/stores/useConversationSettingsStore';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';
import ToolPolicyEditor from '@webview/components/settings/tools/ToolPolicyEditor.vue';
import AgentCollaborationSettings from '@webview/components/settings/agent/AgentCollaborationSettings.vue';
import SkillPolicyEditor from '@webview/components/settings/skills/SkillPolicyEditor.vue';
import WorkEnvironmentPolicyEditor from '@webview/components/settings/workEnvironment/WorkEnvironmentPolicyEditor.vue';
import CheckpointPolicyEditor from '@webview/components/settings/checkpoints/CheckpointPolicyEditor.vue';
import CheckpointListPanel from '@webview/components/settings/checkpoints/CheckpointListPanel.vue';
import SystemPromptScopeEditor from '@webview/components/settings/config/SystemPromptScopeEditor.vue';
import RuntimeContextScopeEditor from '@webview/components/settings/config/RuntimeContextScopeEditor.vue';
import { CHECKPOINT_FEATURE_ENABLED } from '@shared/featureFlags';

const settings = useConversationSettingsStore();

const hasConversation = computed(() => !!settings.common.conversationId);
const { loading: conversationLoading, text: conversationLoadingText } = useSettingsLoadingText('对话配置', 'conversation', () => settings.common.conversationId);
const showConversationLoading = computed(() => hasConversation.value && conversationLoading.value);

function reload(): void {
  settings.request(settings.common.conversationId);
}
</script>

<template>
  <section class="conversation-settings">
    <h2>
      对话设置
      <SettingsLoadingInline :show="showConversationLoading" :text="conversationLoadingText" />
    </h2>
    <label class="field">
      <span>对话名称</span>
      <input v-model="settings.common.name" type="text" placeholder="输入对话名称" />
    </label>
    <div class="settings-actions">
      <button type="button" :disabled="!hasConversation" @click="settings.save()">保存对话设置</button>
      <button type="button" class="secondary" :disabled="!hasConversation" @click="reload">重新读取</button>
      <span class="settings-status">{{ settings.status }}</span>
    </div>
    <p class="settings-note">
      对话名称会直接保存；LLM 设置由单独的配置管理。
    </p>

    <AgentCollaborationSettings
      v-if="hasConversation"
      scope-kind="conversation"
      :scope-id="settings.common.conversationId"
      title="对话 Agent 协作"
    />

    <SystemPromptScopeEditor
      v-if="hasConversation"
      scope-kind="conversation"
      :scope-id="settings.common.conversationId"
      title="对话系统提示词"
      description="仅影响当前对话，会在全局、Agent 和工作流的系统提示词之后追加。"
    />

    <RuntimeContextScopeEditor
      v-if="hasConversation"
      scope-kind="conversation"
      :scope-id="settings.common.conversationId"
      title="对话初始上下文模板"
      description="用于生成当前对话的初始上下文；可以手动刷新，刷新内容不会写入聊天记录。"
    />

    <WorkEnvironmentPolicyEditor
      v-if="hasConversation"
      scope-kind="conversation"
      :scope-id="settings.common.conversationId"
      title="对话工作环境策略"
      description="默认继承全局工作环境策略；修改任一工作环境后会为当前对话创建独立覆盖。"
    />

    <ToolPolicyEditor
      v-if="hasConversation"
      scope-kind="conversation"
      :scope-id="settings.common.conversationId"
      title="对话工具策略"
      description="默认继承全局工具策略；修改任一工具后会为当前对话创建独立覆盖。"
    />

    <SkillPolicyEditor
      v-if="hasConversation"
      scope-kind="conversation"
      :scope-id="settings.common.conversationId"
      title="对话技能策略"
      description="默认继承全局技能策略；修改任一技能开关后会为当前对话创建独立覆盖。"
    />

    <CheckpointPolicyEditor
      v-if="CHECKPOINT_FEATURE_ENABLED && hasConversation"
      scope-kind="conversation"
      :scope-id="settings.common.conversationId"
      title="对话存档点策略"
      description="默认继承全局存档点策略；修改后只影响当前对话。"
    />

    <CheckpointListPanel
      v-if="CHECKPOINT_FEATURE_ENABLED && hasConversation"
      :conversation-id="settings.common.conversationId"
    />
  </section>
</template>

<style scoped>
.conversation-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

h2 {
  margin: 0;
  font-size: var(--font-size-md);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.field input {
  width: 100%;
  border-radius: var(--radius-md);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  padding: var(--space-2);
}

.settings-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.settings-status,
.settings-note {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  margin: 0;
}
</style>
