<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { IconPlus, IconTrash, IconDeviceFloppy, IconRefresh, IconListDetails } from '@tabler/icons-vue';
import type {
  PlanReviewPolicyRecord,
  PlanReviewPolicyScopeLinkRecord,
  SystemPromptRecord,
  SystemPromptScopeLinkRecord,
  ToolPolicyRecord,
  ToolPolicyScopeLinkRecord,
  WorkflowIconKey,
  WorkflowRecord
} from '@shared/protocol';
import { useWorkflowStore, workflowRecordToPlain } from '@webview/stores/useWorkflowStore';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { bridge, BridgeMessageType } from '@webview/transport';
import AdvancedScrollbar from '../../navigation/AdvancedScrollbar.vue';
import ConfirmPanel from '../../ui/ConfirmPanel.vue';
import InputPanel from '../../ui/InputPanel.vue';
import AgentCollaborationSettings from '../agent/AgentCollaborationSettings.vue';

const workflowStore = useWorkflowStore();
const clientState = useClientStateStore();
const { workflows } = storeToRefs(workflowStore);

const selectedWorkflowId = ref('');
const rawText = ref('');
const rawError = ref('');
const rawStatus = ref('');
const createPanelOpen = ref(false);
const deleteConfirmOpen = ref(false);
const workflowListScroller = ref<HTMLElement | null>(null);

interface WorkflowRawData {
  workflow: WorkflowRecord;
  planReviewPolicyLinks: PlanReviewPolicyScopeLinkRecord[];
  planReviewPolicies: PlanReviewPolicyRecord[];
  toolPolicyLinks: ToolPolicyScopeLinkRecord[];
  toolPolicies: ToolPolicyRecord[];
  systemPromptLinks: SystemPromptScopeLinkRecord[];
  systemPrompts: SystemPromptRecord[];
}

const selectedWorkflow = computed(() => workflows.value.find((workflow) => workflow.id === selectedWorkflowId.value) ?? workflows.value[0]);
const selectedRawData = computed(() => selectedWorkflow.value ? workflowRawDataFor(selectedWorkflow.value) : undefined);
const isDirty = computed(() => selectedRawData.value !== undefined && rawText.value !== stringifyWorkflowRawData(selectedRawData.value));
const canDeleteSelected = computed(() => !!selectedWorkflow.value && selectedWorkflow.value.source === 'user');

watch(
  workflows,
  (items) => {
    if (items.length === 0) {
      selectedWorkflowId.value = '';
      rawText.value = '';
      return;
    }
    if (!items.some((workflow) => workflow.id === selectedWorkflowId.value)) {
      selectedWorkflowId.value = items[0]!.id;
    }
  },
  { immediate: true }
);

watch(
  selectedRawData,
  (workflowData) => {
    rawError.value = '';
    rawStatus.value = '';
    rawText.value = workflowData ? stringifyWorkflowRawData(workflowData) : '';
  },
  { immediate: true }
);

function stringifyWorkflowRawData(data: WorkflowRawData): string {
  return JSON.stringify(data, null, 2);
}

function workflowRawDataFor(workflow: WorkflowRecord): WorkflowRawData {
  const plainWorkflow = workflowRecordToPlain(workflow);
  const planReviewPolicyLinks = clientState.planReviewPolicyScopeLinks
    .filter((link) => link.scopeKind === 'workflow' && link.scopeId === workflow.id)
    .map((link) => ({ ...link }));
  const planReviewPolicyIds = new Set(planReviewPolicyLinks.map((link) => link.planReviewPolicyId));
  const planReviewPolicies = clientState.planReviewPolicies
    .filter((policy) => planReviewPolicyIds.has(policy.id))
    .map((policy) => ({ ...policy, requireForToolRiskLevels: [...policy.requireForToolRiskLevels] }));

  const toolPolicyLinks = clientState.toolPolicyScopeLinks
    .filter((link) => link.scopeKind === 'workflow' && link.scopeId === workflow.id)
    .map((link) => ({ ...link }));
  const toolPolicyIds = new Set(toolPolicyLinks.map((link) => link.toolPolicyId));
  const toolPolicies = clientState.toolPolicies
    .filter((policy) => toolPolicyIds.has(policy.id))
    .map((policy) => clonePlain(policy));

  const systemPromptLinks = clientState.systemPromptScopeLinks
    .filter((link) => link.scopeKind === 'workflow' && link.scopeId === workflow.id)
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((link) => ({ ...link }));
  const systemPromptIds = new Set(systemPromptLinks.map((link) => link.systemPromptId));
  const systemPrompts = clientState.systemPrompts
    .filter((prompt) => systemPromptIds.has(prompt.id))
    .map((prompt) => ({ ...prompt }));

  return {
    workflow: plainWorkflow,
    planReviewPolicyLinks,
    planReviewPolicies,
    toolPolicyLinks,
    toolPolicies,
    systemPromptLinks,
    systemPrompts
  };
}

function selectWorkflow(workflowId: string): void {
  selectedWorkflowId.value = workflowId;
}

function parseWorkflowJson(): WorkflowRawData | undefined {
  rawError.value = '';
  rawStatus.value = '';
  const current = selectedRawData.value;
  if (!current) {
    rawError.value = '请先选择一个工作流。';
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(rawText.value);
  } catch (error) {
    rawError.value = error instanceof Error ? `JSON 解析失败：${error.message}` : 'JSON 解析失败。';
    return undefined;
  }

  if (!isRecord(value)) {
    rawError.value = '工作流高级配置必须是 JSON 对象。';
    return undefined;
  }

  const workflow = parseWorkflowRecord(value.workflow, current.workflow);
  if (!workflow) return undefined;
  const planReviewPolicyLinks = parseArray<PlanReviewPolicyScopeLinkRecord>(value.planReviewPolicyLinks, 'planReviewPolicyLinks');
  const planReviewPolicies = parseArray<PlanReviewPolicyRecord>(value.planReviewPolicies, 'planReviewPolicies');
  const toolPolicyLinks = parseArray<ToolPolicyScopeLinkRecord>(value.toolPolicyLinks, 'toolPolicyLinks');
  const toolPolicies = parseArray<ToolPolicyRecord>(value.toolPolicies, 'toolPolicies');
  const systemPromptLinks = parseArray<SystemPromptScopeLinkRecord>(value.systemPromptLinks, 'systemPromptLinks');
  const systemPrompts = parseArray<SystemPromptRecord>(value.systemPrompts, 'systemPrompts');
  if (!planReviewPolicyLinks || !planReviewPolicies || !toolPolicyLinks || !toolPolicies || !systemPromptLinks || !systemPrompts) return undefined;

  const planPolicy = planReviewPolicies[0];
  if (planPolicy && !isValidPlanReviewPolicy(planPolicy)) return undefined;
  const toolPolicy = toolPolicies[0];
  if (toolPolicy && !isValidToolPolicy(toolPolicy)) return undefined;
  const systemPrompt = systemPrompts[0];
  if (systemPrompt && !isValidSystemPrompt(systemPrompt)) return undefined;

  return {
    workflow,
    planReviewPolicyLinks: planReviewPolicyLinks.map((link) => ({ ...link })),
    planReviewPolicies: planReviewPolicies.map((policy) => clonePlain(policy)),
    toolPolicyLinks: toolPolicyLinks.map((link) => ({ ...link })),
    toolPolicies: toolPolicies.map((policy) => clonePlain(policy)),
    systemPromptLinks: systemPromptLinks.map((link) => ({ ...link })),
    systemPrompts: systemPrompts.map((prompt) => ({ ...prompt }))
  };
}

function saveRawWorkflow(): void {
  const parsed = parseWorkflowJson();
  if (!parsed) return;
  const previous = selectedRawData.value;
  workflowStore.saveWorkflowRaw(parsed.workflow);
  saveWorkflowPlanReviewPolicy(parsed, previous);
  saveWorkflowToolPolicy(parsed, previous);
  saveWorkflowSystemPrompt(parsed, previous);
  rawStatus.value = '已提交保存工作流及关联策略。';
}

function resetRawWorkflow(): void {
  rawError.value = '';
  rawStatus.value = '';
  if (selectedRawData.value) rawText.value = stringifyWorkflowRawData(selectedRawData.value);
}

function parseWorkflowRecord(value: unknown, current: WorkflowRecord): WorkflowRecord | undefined {
  if (!isRecord(value)) {
    rawError.value = '工作流（workflow）必须是 JSON 对象。';
    return undefined;
  }
  const record = value as Partial<WorkflowRecord>;
  if (record.id !== current.id) {
    rawError.value = '暂不支持修改工作流 ID（workflow.id）。';
    return undefined;
  }
  if (record.source !== current.source) {
    rawError.value = '暂不支持修改工作流来源（workflow.source）。';
    return undefined;
  }
  if (typeof record.name !== 'string' || !record.name.trim()) {
    rawError.value = '工作流名称（workflow.name）不能为空。';
    return undefined;
  }
  if (record.description !== undefined && typeof record.description !== 'string') {
    rawError.value = '工作流说明（workflow.description）必须是文本或省略。';
    return undefined;
  }
  if (record.icon !== undefined && record.icon !== 'list-details') {
    rawError.value = '工作流图标（workflow.icon）当前只支持 "list-details"。';
    return undefined;
  }
  if (typeof record.createdAt !== 'number' || typeof record.updatedAt !== 'number') {
    rawError.value = '工作流的创建和更新时间必须是数字。';
    return undefined;
  }
  return {
    id: current.id,
    name: record.name,
    ...(record.description?.trim() ? { description: record.description } : {}),
    source: current.source,
    ...(record.icon ? { icon: record.icon as WorkflowIconKey } : {}),
    createdAt: current.createdAt,
    updatedAt: current.updatedAt
  };
}

function parseArray<T>(value: unknown, label: string): T[] | undefined {
  if (!Array.isArray(value)) {
    rawError.value = `${label} 必须是数组。`;
    return undefined;
  }
  return value as T[];
}

function isValidPlanReviewPolicy(policy: PlanReviewPolicyRecord): boolean {
  if (typeof policy.id !== 'string' || !policy.id.trim()) return setRawError('planReviewPolicies[0].id 必须是非空字符串。');
  if (policy.mode !== 'off' && policy.mode !== 'before_mutation') return setRawError('planReviewPolicies[0].mode 只能是 off 或 before_mutation。');
  if (typeof policy.allowReadonlyBeforeApproval !== 'boolean') return setRawError('planReviewPolicies[0].allowReadonlyBeforeApproval 必须是 boolean。');
  if (!Array.isArray(policy.requireForToolRiskLevels) || !policy.requireForToolRiskLevels.every((level) => level === 'write' || level === 'command' || level === 'agent')) {
    return setRawError('planReviewPolicies[0].requireForToolRiskLevels 只能包含 write / command / agent。');
  }
  return true;
}

function isValidToolPolicy(policy: ToolPolicyRecord): boolean {
  if (typeof policy.id !== 'string' || !policy.id.trim()) return setRawError('toolPolicies[0].id 必须是非空字符串。');
  if (typeof policy.name !== 'string' || !policy.name.trim()) return setRawError('toolPolicies[0].name 必须是非空字符串。');
  if (!Array.isArray(policy.allowedTools) || !policy.allowedTools.every((tool) => typeof tool === 'string' && tool.trim())) {
    return setRawError('toolPolicies[0].allowedTools 必须是非空字符串数组。');
  }
  if (policy.preset !== undefined && policy.preset !== 'inherit' && policy.preset !== 'custom' && policy.preset !== 'yolo') {
    return setRawError('toolPolicies[0].preset 只能是 inherit / custom / yolo。');
  }
  return true;
}

function isValidSystemPrompt(prompt: SystemPromptRecord): boolean {
  if (typeof prompt.id !== 'string' || !prompt.id.trim()) return setRawError('systemPrompts[0].id 必须是非空字符串。');
  if (typeof prompt.name !== 'string' || !prompt.name.trim()) return setRawError('systemPrompts[0].name 必须是非空字符串。');
  if (typeof prompt.text !== 'string' || !prompt.text.trim()) return setRawError('systemPrompts[0].text 必须是非空字符串。');
  return true;
}

function saveWorkflowPlanReviewPolicy(parsed: WorkflowRawData, previous: WorkflowRawData | undefined): void {
  const policy = parsed.planReviewPolicies[0];
  if (policy) {
    bridge.request(BridgeMessageType.PlanReviewPolicyScopeSet, {
      scopeKind: 'workflow',
      scopeId: parsed.workflow.id,
      mode: policy.mode,
      allowReadonlyBeforeApproval: policy.allowReadonlyBeforeApproval,
      requireForToolRiskLevels: [...policy.requireForToolRiskLevels]
    });
    return;
  }
  if ((previous?.planReviewPolicyLinks.length ?? 0) > 0) {
    bridge.request(BridgeMessageType.PlanReviewPolicyScopeClear, { scopeKind: 'workflow', scopeId: parsed.workflow.id });
  }
}

function saveWorkflowToolPolicy(parsed: WorkflowRawData, previous: WorkflowRawData | undefined): void {
  const policy = parsed.toolPolicies[0];
  if (policy) {
    bridge.request(BridgeMessageType.ToolPolicyScopeSet, {
      scopeKind: 'workflow',
      scopeId: parsed.workflow.id,
      name: policy.name,
      allowedTools: [...policy.allowedTools],
      ...(policy.preset ? { preset: policy.preset } : {}),
      ...(policy.toolConfigs ? { toolConfigs: clonePlain(policy.toolConfigs) } : {}),
      ...(policy.sourceConfigs ? { sourceConfigs: clonePlain(policy.sourceConfigs) } : {})
    });
    return;
  }
  if ((previous?.toolPolicyLinks.length ?? 0) > 0) {
    bridge.request(BridgeMessageType.ToolPolicyScopeClear, { scopeKind: 'workflow', scopeId: parsed.workflow.id });
  }
}

function saveWorkflowSystemPrompt(parsed: WorkflowRawData, previous: WorkflowRawData | undefined): void {
  const prompt = parsed.systemPrompts[0];
  const link = parsed.systemPromptLinks.find((item) => item.systemPromptId === prompt?.id) ?? parsed.systemPromptLinks[0];
  if (prompt) {
    bridge.request(BridgeMessageType.SystemPromptScopeSet, {
      scopeKind: 'workflow',
      scopeId: parsed.workflow.id,
      name: prompt.name,
      text: prompt.text,
      ...(link?.order !== undefined ? { order: link.order } : {})
    });
    return;
  }
  if ((previous?.systemPromptLinks.length ?? 0) > 0) {
    bridge.request(BridgeMessageType.SystemPromptScopeClear, { scopeKind: 'workflow', scopeId: parsed.workflow.id });
  }
}

function setRawError(message: string): false {
  rawError.value = message;
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function openCreatePanel(): void {
  createPanelOpen.value = true;
}

function confirmCreateWorkflow(name: string): void {
  createPanelOpen.value = false;
  workflowStore.createWorkflow(name);
}

function openDeleteConfirm(): void {
  if (!canDeleteSelected.value) return;
  deleteConfirmOpen.value = true;
}

function confirmDeleteWorkflow(): void {
  const workflow = selectedWorkflow.value;
  deleteConfirmOpen.value = false;
  if (!workflow) return;
  workflowStore.deleteWorkflow(workflow.id);
}
</script>

<template>
  <section class="workflow-editor-tab settings-tab-content">
    <header class="workflow-editor-head">
      <div>
        <p class="settings-kicker">工作流</p>
        <h2>工作流编辑</h2>
        <p>当前提供高级 JSON 编辑，可配置工作流及其提示词、工具权限和 Plan 审查策略。</p>
      </div>
      <button type="button" class="workflow-action-button" @click="openCreatePanel">
        <IconPlus :size="15" stroke="2.2" />
        <span>新建工作流</span>
      </button>
    </header>

    <div class="workflow-editor-layout">
      <aside class="workflow-list-panel" aria-label="工作流列表">
        <div class="workflow-list-title">工作流</div>
        <div ref="workflowListScroller" class="workflow-list-scroll">
          <button
            v-for="workflow in workflows"
            :key="workflow.id"
            type="button"
            class="workflow-list-item"
            :class="{ active: workflow.id === selectedWorkflow?.id }"
            @click="selectWorkflow(workflow.id)"
          >
            <span class="workflow-list-item-icon" aria-hidden="true"><IconListDetails :size="15" stroke="2.1" /></span>
            <span class="workflow-list-item-main">
              <span class="workflow-list-item-name">{{ workflow.name }}</span>
              <span class="workflow-list-item-id">{{ workflow.id }}</span>
            </span>
            <span class="workflow-source-pill">{{ workflow.source === 'builtin' ? '内置' : '用户' }}</span>
          </button>
        </div>
        <AdvancedScrollbar :scroller="workflowListScroller" variant="minimal" />
      </aside>

      <main class="workflow-raw-panel">
        <template v-if="selectedWorkflow">
          <div class="workflow-raw-head">
            <div>
              <div class="workflow-raw-title">{{ selectedWorkflow.name }}</div>
              <div class="workflow-raw-subtitle">{{ selectedWorkflow.id }} · {{ selectedWorkflow.source === 'builtin' ? '内置工作流' : '用户工作流' }}</div>
            </div>
            <div class="workflow-raw-actions">
              <button type="button" class="workflow-secondary-button" :disabled="!isDirty" @click="resetRawWorkflow">
                <IconRefresh :size="15" stroke="2.2" />
                <span>重置</span>
              </button>
              <button type="button" class="workflow-primary-button" :disabled="!isDirty" @click="saveRawWorkflow">
                <IconDeviceFloppy :size="15" stroke="2.2" />
                <span>保存</span>
              </button>
              <button type="button" class="workflow-danger-button" :disabled="!canDeleteSelected" @click="openDeleteConfirm">
                <IconTrash :size="15" stroke="2.2" />
                <span>删除</span>
              </button>
            </div>
          </div>

          <AgentCollaborationSettings scope-kind="workflow" :scope-id="selectedWorkflow.id" title="工作流 Agent 协作" :readonly="isDirty" />
          <p v-if="isDirty" class="workflow-help">先保存或重置下方 JSON 修改，再调整 Agent 协作设置。</p>

          <textarea
            v-model="rawText"
            class="workflow-json-editor"
            spellcheck="false"
            aria-label="工作流高级 JSON 配置"
          ></textarea>
          <p v-if="rawError" class="workflow-error">{{ rawError }}</p>
          <p v-else-if="rawStatus || workflowStore.status" class="workflow-status">{{ rawStatus || workflowStore.status }}</p>
          <p v-else class="workflow-help">可编辑工作流的名称、说明和图标，以及首组 Plan 审查策略、工具权限和系统提示词；ID、关联信息和时间由系统维护。</p>
        </template>
        <div v-else class="workflow-empty">暂无工作流。</div>
      </main>
    </div>

    <InputPanel
      :open="createPanelOpen"
      title="新建工作流"
      description="创建后会出现在工作流列表中，可继续编辑高级 JSON 配置。"
      label="工作流名称"
      placeholder="例如：Plan"
      confirm-label="创建"
      @confirm="confirmCreateWorkflow"
      @cancel="createPanelOpen = false"
    />

    <ConfirmPanel
      :open="deleteConfirmOpen"
      title="删除工作流"
      :description="`确定删除工作流「${selectedWorkflow?.name ?? ''}」吗？这个操作不会保留旧兼容。`"
      danger
      confirm-label="删除"
      @confirm="confirmDeleteWorkflow"
      @cancel="deleteConfirmOpen = false"
    />
  </section>
</template>

<style scoped>
.workflow-editor-tab {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.workflow-editor-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.workflow-editor-head h2 {
  margin: 2px 0 4px;
  font-size: 17px;
  font-weight: 650;
  color: var(--vscode-foreground);
}

.workflow-editor-head p {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  line-height: 1.6;
}

.workflow-editor-layout {
  display: grid;
  grid-template-columns: minmax(210px, 260px) minmax(0, 1fr);
  gap: 12px;
  min-height: 430px;
}

.workflow-list-panel,
.workflow-raw-panel {
  position: relative;
  border: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
  background: var(--vscode-editor-background);
}

.workflow-list-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.workflow-list-title {
  padding: 10px 12px 8px;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: .04em;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
  border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
}

.workflow-list-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  scrollbar-width: none;
  padding: 6px;
}

.workflow-list-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.workflow-list-item {
  width: 100%;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--vscode-foreground);
  text-align: left;
  padding: 8px;
  cursor: pointer;
}

.workflow-list-item:hover,
.workflow-list-item.active {
  background: var(--vscode-list-hoverBackground);
  border-color: var(--vscode-sideBar-border, var(--vscode-panel-border));
}

.workflow-list-item-icon,
.workflow-source-pill {
  color: var(--vscode-descriptionForeground);
}

.workflow-list-item-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.workflow-list-item-name,
.workflow-list-item-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workflow-list-item-name {
  font-size: 12px;
  font-weight: 600;
}

.workflow-list-item-id {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.workflow-source-pill {
  border: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
  padding: 1px 5px;
  font-size: 10px;
}

.workflow-raw-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 12px;
  gap: 10px;
}

.workflow-raw-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.workflow-raw-title {
  font-size: 14px;
  font-weight: 650;
  color: var(--vscode-foreground);
}

.workflow-raw-subtitle {
  margin-top: 2px;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}

.workflow-raw-actions,
.workflow-action-button,
.workflow-secondary-button,
.workflow-primary-button,
.workflow-danger-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.workflow-raw-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.workflow-action-button,
.workflow-secondary-button,
.workflow-primary-button,
.workflow-danger-button {
  border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  padding: 5px 8px;
  font-size: 12px;
  cursor: pointer;
}

.workflow-action-button:hover,
.workflow-secondary-button:hover,
.workflow-primary-button:hover,
.workflow-danger-button:hover:not(:disabled) {
  background: var(--vscode-list-hoverBackground);
}

.workflow-primary-button {
  border-color: var(--vscode-focusBorder);
}

.workflow-danger-button {
  color: var(--vscode-errorForeground);
}

.workflow-action-button:disabled,
.workflow-secondary-button:disabled,
.workflow-primary-button:disabled,
.workflow-danger-button:disabled {
  opacity: .55;
  cursor: not-allowed;
}

.workflow-json-editor {
  flex: 1;
  min-height: 330px;
  width: 100%;
  resize: vertical;
  box-sizing: border-box;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  padding: 10px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
  line-height: 1.55;
  outline: none;
}

.workflow-json-editor:focus {
  border-color: var(--vscode-focusBorder);
}

.workflow-error,
.workflow-status,
.workflow-help,
.workflow-empty {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}

.workflow-error {
  color: var(--vscode-errorForeground);
}

.workflow-status,
.workflow-help,
.workflow-empty {
  color: var(--vscode-descriptionForeground);
}

@media (max-width: 780px) {
  .workflow-editor-layout {
    grid-template-columns: 1fr;
  }
}
</style>
