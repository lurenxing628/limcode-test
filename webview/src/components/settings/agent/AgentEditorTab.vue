<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconRobot, IconPencil, IconPlus, IconTrash } from '@tabler/icons-vue';
import type { AgentRecord } from '@shared/protocol';
import { CHECKPOINT_FEATURE_ENABLED } from '@shared/featureFlags';
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import SettingsDropdown, { type SettingsDropdownOption } from '@webview/components/settings/global/SettingsDropdown.vue';
import ToolPolicyEditor from '@webview/components/settings/tools/ToolPolicyEditor.vue';
import AgentCollaborationSettings from './AgentCollaborationSettings.vue';
import SkillPolicyEditor from '@webview/components/settings/skills/SkillPolicyEditor.vue';
import WorkEnvironmentPolicyEditor from '@webview/components/settings/workEnvironment/WorkEnvironmentPolicyEditor.vue';
import CheckpointPolicyEditor from '@webview/components/settings/checkpoints/CheckpointPolicyEditor.vue';
import SystemPromptScopeEditor from '@webview/components/settings/config/SystemPromptScopeEditor.vue';
import RuntimeContextScopeEditor from '@webview/components/settings/config/RuntimeContextScopeEditor.vue';
import ModelProfileScopeEditor from '@webview/components/settings/config/ModelProfileScopeEditor.vue';
import InputPanel from '@webview/components/ui/InputPanel.vue';
import { AGENT_DELETE_UNAVAILABLE_MESSAGE, useAgentStore } from '@webview/stores/useAgentStore';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const agentStore = useAgentStore();
const { loading: agentLoading, text: agentLoadingText } = useSettingsLoadingText('Agent 配置');
const activeAgentId = ref('');
const createOpen = ref(false);
const renameOpen = ref(false);
const settingsAgents = computed(() => agentStore.configurableAgents);
const options = computed<SettingsDropdownOption[]>(() => settingsAgents.value.map((agent) => ({ value: agent.id, label: agent.name, description: agent.description || (agent.source === 'builtin' ? `内置 Agent · ${agent.kind}` : `用户 Agent · ${agent.kind}`), icon: IconRobot })));
const activeAgent = computed<AgentRecord | undefined>(() => settingsAgents.value.find((agent) => agent.id === activeAgentId.value));
const canDelete = computed(() => activeAgent.value?.source === 'user');
const deleteTitle = computed(() => canDelete.value ? AGENT_DELETE_UNAVAILABLE_MESSAGE : '内置 Agent 不能删除。');

watch(() => settingsAgents.value.map((agent) => agent.id).join('|'), () => {
  if (activeAgentId.value && settingsAgents.value.some((agent) => agent.id === activeAgentId.value)) return;
  activeAgentId.value = settingsAgents.value.find((agent) => agent.id === 'main')?.id ?? settingsAgents.value[0]?.id ?? '';
}, { immediate: true });

function updateDescription(event: Event): void { if (activeAgent.value) agentStore.updateDescription(activeAgent.value.id, (event.currentTarget as HTMLElement).textContent ?? ''); }
function confirmCreate(name: string): void { createOpen.value = false; agentStore.createAgent(name); }
function confirmRename(name: string): void { const agent = activeAgent.value; renameOpen.value = false; if (agent) agentStore.renameAgent(agent.id, name); }
function explainDeleteRestriction(): void { const agent = activeAgent.value; if (agent) agentStore.deleteAgent(agent.id); }
</script>

<template>
  <section class="global-settings-tab-section agent-editor" aria-label="Agent 编辑">
    <header class="global-settings-section-header">
      <div>
        <h2>
          Agent
          <SettingsLoadingInline :show="agentLoading" :text="agentLoadingText" />
        </h2>
        <p>Agent 决定角色和能力，包括角色提示词、能力上限和默认 LLM；工作流决定本次任务的执行方式，可叠加规划、审查和只读等策略。</p>
      </div>
    </header>

    <div class="agent-picker-row">
      <label class="global-settings-field agent-picker">
        <span>Agent</span>
        <SettingsDropdown v-model="activeAgentId" :options="options" title="切换 Agent" searchable search-placeholder="筛选 Agent..." />
      </label>
      <div class="agent-actions">
        <button type="button" class="icon-action" aria-label="新建 Agent" @click="createOpen = true"><IconPlus stroke="2" /></button>
        <button type="button" class="icon-action" aria-label="重命名 Agent" :disabled="!activeAgent" @click="renameOpen = true"><IconPencil stroke="2" /></button>
        <button type="button" class="icon-action" :aria-label="deleteTitle" :title="deleteTitle" :disabled="!canDelete" @click="explainDeleteRestriction"><IconTrash stroke="2" /></button>
      </div>
    </div>

    <div v-if="activeAgent" class="agent-summary-card">
      <span class="agent-icon"><IconRobot stroke="2" /></span>
      <span class="agent-main">
        <span class="agent-title">{{ activeAgent.name }}</span>
        <span class="agent-desc">{{ activeAgent.description || '暂无描述。' }}</span>
      </span>
      <span class="agent-pill">{{ activeAgent.source === 'builtin' ? '内置' : '用户' }}</span>
    </div>

    <AgentCollaborationSettings v-if="activeAgent" scope-kind="agent" :scope-id="activeAgent.id" title="Agent 协作" />

    <label v-if="activeAgent" class="global-settings-field global-settings-field-wide">
      <span>Agent 描述</span>
      <div class="agent-description" contenteditable="plaintext-only" data-placeholder="描述这个 Agent 的用途" @blur="updateDescription">{{ activeAgent.description ?? '' }}</div>
    </label>

    <SystemPromptScopeEditor v-if="activeAgent" scope-kind="agent" :scope-id="activeAgent.id" title="Agent 角色提示词" description="按全局 → Agent → 工作流 → 对话 → 本次运行的顺序拼接。这里定义这个 Agent 的角色。" />
    <RuntimeContextScopeEditor v-if="activeAgent" scope-kind="agent" :scope-id="activeAgent.id" title="Agent 初始上下文模板" description="用于生成 Agent 的初始上下文；变量只在生成或刷新时替换一次。" />
    <ModelProfileScopeEditor v-if="activeAgent" scope-kind="agent" :scope-id="activeAgent.id" title="Agent 默认 LLM" description="当对话、工作流或本次运行没有单独设置时使用。" />
    <ToolPolicyEditor v-if="activeAgent" scope-kind="agent" :scope-id="activeAgent.id" title="Agent 工具能力上限" description="Agent 的工具策略决定能力上限；工作流、对话和本次运行只能继续收窄，不能扩大。" />
    <SkillPolicyEditor v-if="activeAgent" scope-kind="agent" :scope-id="activeAgent.id" title="Agent 技能策略" description="限制这个 Agent 可使用的技能；未配置时继承全局技能策略。" />
    <WorkEnvironmentPolicyEditor v-if="activeAgent" scope-kind="agent" :scope-id="activeAgent.id" title="Agent 工作环境策略" description="限制这个 Agent 可使用的工作环境。" />
    <CheckpointPolicyEditor v-if="CHECKPOINT_FEATURE_ENABLED && activeAgent" scope-kind="agent" :scope-id="activeAgent.id" title="Agent 存档点策略" description="限制这个 Agent 创建存档点的时机和内部仓库的文件过滤规则。" />

    <p class="global-settings-status">{{ agentStore.status }}</p>

    <InputPanel :open="createOpen" title="新建 Agent" description="输入 Agent 名称。创建后可配置提示词、LLM 和工具能力。" label="Agent 名称" placeholder="例如：Docs Agent" confirm-label="创建" @confirm="confirmCreate" @cancel="createOpen = false" />
    <InputPanel :open="renameOpen" title="重命名 Agent" label="Agent 名称" :initial-value="activeAgent?.name ?? ''" confirm-label="保存" @confirm="confirmRename" @cancel="renameOpen = false" />
  </section>
</template>

<style scoped>
.agent-editor { display: flex; flex-direction: column; gap: var(--space-4); }
.agent-picker-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2); align-items: end; }
.agent-actions { display: flex; gap: var(--space-1); }
.agent-summary-card { border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); padding: var(--space-3); display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: var(--space-2); align-items: center; background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%); }
.agent-icon { width: 28px; height: 28px; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); display: inline-flex; align-items: center; justify-content: center; }
.agent-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.agent-title { font-weight: 600; }
.agent-desc { color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.agent-pill { border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); padding: 2px var(--space-2); color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); }
.agent-description { min-height: 56px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: var(--radius-sm); padding: var(--space-2); background: var(--vscode-input-background); color: var(--vscode-input-foreground); outline: none; white-space: pre-wrap; }
</style>
