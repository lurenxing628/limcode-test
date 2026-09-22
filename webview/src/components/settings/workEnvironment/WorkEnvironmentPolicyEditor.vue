<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconCloudDown, IconPlus, IconServer, IconTrash } from '@tabler/icons-vue';
import type { WorkEnvironmentPolicyScopeKind, WorkEnvironmentRecord } from '@shared/protocol';
import {
  canRemoveWorkEnvironment,
  getWorkEnvironmentKindDefinition,
  workEnvironmentDisplayName,
  workEnvironmentDisplayPath,
  workEnvironmentKindLabel
} from '@shared/workEnvironmentCatalog';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import ConfirmPanel from '@webview/components/ui/ConfirmPanel.vue';
import InputPanel from '@webview/components/ui/InputPanel.vue';
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import { useWorkEnvironmentStore } from '@webview/stores/useWorkEnvironmentStore';
import { WORK_ENVIRONMENT_CREATE_ACTIONS, type WorkEnvironmentCreateAction } from './creationActions';
import { workEnvironmentDetailEditorForKind } from './detailEditors';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const props = withDefaults(defineProps<{
  scopeKind: WorkEnvironmentPolicyScopeKind;
  scopeId?: string;
  title?: string;
  description?: string;
  readonly?: boolean;
}>(), {
  title: '工作环境策略',
  description: '',
  readonly: false
});

const store = useWorkEnvironmentStore();
const { loading: workEnvironmentLoading, text: workEnvironmentLoadingText } = useSettingsLoadingText('工作环境配置', () => props.scopeKind, () => props.scopeId);
const scroller = ref<HTMLElement | null>(null);
const activeEnvironmentId = ref('');
const activeCreateAction = ref<WorkEnvironmentCreateAction | undefined>(WORK_ENVIRONMENT_CREATE_ACTIONS[0]);
const createOpen = ref(false);
const deleteConfirmOpen = ref(false);

const resolution = computed(() => store.effectivePolicyFor(props.scopeKind, props.scopeId));
const localResolution = computed(() => store.localPolicyFor(props.scopeKind, props.scopeId));
const effectivePolicy = computed(() => resolution.value.policy);
const hasLocalOverride = computed(() => props.scopeKind === 'global' || !!localResolution.value.policy);
const canRestoreInheritance = computed(() => props.scopeKind !== 'global' && hasLocalOverride.value && !props.readonly);
const environments = computed(() => store.availableEnvironments);
const allowedSet = computed(() => new Set(effectivePolicy.value?.allowedWorkEnvironmentIds ?? environments.value.map((item) => item.id)));
const defaultEnvironmentId = computed(() => effectivePolicy.value?.defaultWorkEnvironmentId ?? '');
const activeEnvironment = computed(() => environments.value.find((item) => item.id === activeEnvironmentId.value) ?? environments.value[0]);
const activeDetailEditor = computed(() => workEnvironmentDetailEditorForKind(activeEnvironment.value?.kind));
const canDeleteActiveEnvironment = computed(() => !props.readonly && canRemoveWorkEnvironment(activeEnvironment.value));
const policyEnabled = computed(() => effectivePolicy.value?.enabled === true);
const sourceLabel = computed(() => {
  if (props.scopeKind === 'global') return '全局默认策略';
  if (hasLocalOverride.value) return '当前范围的单独设置';
  if (resolution.value.inheritedFrom === 'workflow') return '继承当前工作流策略';
  if (resolution.value.inheritedFrom === 'global') return '继承全局默认策略';
  return '默认策略';
});
const enabledCount = computed(() => environments.value.filter((environment) => allowedSet.value.has(environment.id)).length);
const toolSwitchLabel = computed(() => policyEnabled.value ? '切换工具已启用' : '仅作为本地路径边界');

watch(
  () => environments.value.map((item) => item.id).join('|'),
  () => {
    if (activeEnvironmentId.value && environments.value.some((item) => item.id === activeEnvironmentId.value)) return;
    activeEnvironmentId.value = defaultEnvironmentId.value || environments.value[0]?.id || '';
  },
  { immediate: true }
);

function toggleAllowed(environment: WorkEnvironmentRecord, enabled: boolean): void {
  if (props.readonly) return;
  const next = new Set(allowedSet.value);
  if (enabled) next.add(environment.id);
  else next.delete(environment.id);
  const allowed = [...next];
  const defaultId = allowed.includes(defaultEnvironmentId.value) ? defaultEnvironmentId.value : undefined;
  store.setPolicyForScope(props.scopeKind, props.scopeId, allowed, defaultId, effectivePolicy.value?.name);
}

function setDefault(environment: WorkEnvironmentRecord): void {
  if (props.readonly || !allowedSet.value.has(environment.id)) return;
  store.setPolicyForScope(props.scopeKind, props.scopeId, [...allowedSet.value], environment.id, effectivePolicy.value?.name);
}

function clearDefault(): void {
  if (props.readonly) return;
  store.setPolicyForScope(props.scopeKind, props.scopeId, [...allowedSet.value], undefined, effectivePolicy.value?.name);
}

function restoreInheritance(): void {
  if (!canRestoreInheritance.value) return;
  store.clearPolicyScope(props.scopeKind, props.scopeId);
}

function setPolicyEnabled(enabled: boolean): void {
  if (props.readonly) return;
  const allowed = [...allowedSet.value];
  const defaultId = defaultEnvironmentId.value || undefined;
  store.setPolicyForScope(props.scopeKind, props.scopeId, allowed, defaultId, effectivePolicy.value?.name, enabled);
}

function openCreate(action: WorkEnvironmentCreateAction = WORK_ENVIRONMENT_CREATE_ACTIONS[0]): void {
  if (props.readonly) return;
  activeCreateAction.value = action;
  createOpen.value = true;
}

function confirmCreate(input: string): void {
  createOpen.value = false;
  const action = activeCreateAction.value;
  const text = input.trim();
  if (!action || !text) return;
  const id = store.createEnvironment(action.kind, text);
  if (!id) return;
  activeEnvironmentId.value = id;
  const created = environments.value.find((environment) => environment.id === id);
  toggleAllowed(created ?? { id, kind: action.kind, name: text, available: true, createdAt: Date.now(), updatedAt: Date.now() }, true);
}

function cancelCreate(): void { createOpen.value = false; }

function importFromVscode(): void {
  if (props.readonly) return;
  store.importFromVscode();
}

function openDeleteConfirm(): void {
  if (!canDeleteActiveEnvironment.value) return;
  deleteConfirmOpen.value = true;
}

function confirmDelete(): void {
  const environment = activeEnvironment.value;
  deleteConfirmOpen.value = false;
  if (!environment || !canRemoveWorkEnvironment(environment)) return;
  store.removeEnvironment(environment.id);
  activeEnvironmentId.value = environments.value[0]?.id ?? '';
}

function cancelDelete(): void { deleteConfirmOpen.value = false; }

function updateActiveEnvironment(patch: Partial<WorkEnvironmentRecord>): void {
  const environment = activeEnvironment.value;
  if (!environment || props.readonly) return;
  store.updateEnvironment(environment.id, patch);
}

function environmentPath(environment: WorkEnvironmentRecord): string {
  return workEnvironmentDisplayPath(environment);
}

function environmentName(environment: WorkEnvironmentRecord | undefined): string {
  return workEnvironmentDisplayName(environment);
}

function kindLabel(environment: WorkEnvironmentRecord): string {
  return workEnvironmentKindLabel(environment.kind);
}

function detailNote(environment: WorkEnvironmentRecord): string {
  const definition = getWorkEnvironmentKindDefinition(environment.kind);
  if (definition.systemManaged) return `${definition.label}工作环境由系统自动同步，仅可在这里配置是否允许和默认选择。`;
  if (!activeDetailEditor.value) return `${definition.label}工作环境暂未提供专属编辑器；后续新增 Docker 等环境时，只需要接入对应 kind 的详情编辑组件。`;
  return definition.description;
}


</script>

<template>
  <section class="work-environment-policy-editor" :aria-label="title">
    <header class="work-env-header">
      <div class="work-env-title-block">
        <h3>
          {{ title }}
          <SettingsLoadingInline :show="workEnvironmentLoading" :text="workEnvironmentLoadingText" />
        </h3>
        <p v-if="description">{{ description }}</p>
      </div>
      <div class="work-env-summary" aria-live="polite">
        <span>{{ sourceLabel }}</span>
        <span>{{ toolSwitchLabel }}</span>
        <span v-if="!defaultEnvironmentId">未设置默认环境</span>
        <span>{{ enabledCount }} / {{ environments.length }} 已允许</span>
      </div>
    </header>

    <div class="work-env-actions">
      <LcCheckbox
        :model-value="policyEnabled"
        :disabled="readonly"
        @update:model-value="setPolicyEnabled"
      >
        <span>启用工作环境切换工具</span>
      </LcCheckbox>
      <button type="button" :disabled="readonly" @click="importFromVscode">
        <IconCloudDown stroke="2" aria-hidden="true" />
        <span>从 VS Code 导入</span>
      </button>
      <button
        v-for="action in WORK_ENVIRONMENT_CREATE_ACTIONS"
        :key="action.id"
        type="button"
        class="secondary"
        :disabled="readonly"
        @click="openCreate(action)"
      >
        <IconPlus stroke="2" aria-hidden="true" />
        <span>{{ action.label }}</span>
      </button>
      <button type="button" class="secondary" :disabled="readonly || !defaultEnvironmentId" @click="clearDefault">清除默认环境</button>
      <button type="button" class="secondary" :disabled="!canRestoreInheritance" @click="restoreInheritance">恢复继承</button>
      <span class="work-env-status">{{ store.status }}</span>
    </div>

    <div class="work-env-layout">
      <div class="work-env-list-shell">
        <div ref="scroller" class="work-env-list-scroll">
          <div v-if="environments.length === 0" class="work-env-empty">暂无工作环境。可打开 VS Code 工作区，或通过上方导入 / 新建入口添加环境。</div>
          <article
            v-for="environment in environments"
            :key="environment.id"
            class="work-env-item"
            :class="{ 'is-active': environment.id === activeEnvironmentId, 'is-allowed': allowedSet.has(environment.id) }"
          >
            <button type="button" class="work-env-main" @click="activeEnvironmentId = environment.id">
              <span class="work-env-icon" aria-hidden="true"><IconServer stroke="2" /></span>
              <span class="work-env-copy">
                <span class="work-env-name-row">
                  <span class="work-env-name">{{ environmentName(environment) }}</span>
                </span>
                <span class="work-env-meta">
                  <span>{{ kindLabel(environment) }}</span><span v-if="environment.id === defaultEnvironmentId">默认</span>
                </span>
                <span class="work-env-path">{{ environmentPath(environment) }}</span>
              </span>
            </button>
            <div class="work-env-row-actions">
              <LcCheckbox
                :model-value="allowedSet.has(environment.id)"
                :disabled="readonly"
                @update:model-value="toggleAllowed(environment, $event)"
              >
                <span>允许</span>
              </LcCheckbox>
              <button type="button" class="mini-action" :disabled="readonly || !allowedSet.has(environment.id)" @click="setDefault(environment)">设为默认</button>
            </div>
          </article>
        </div>
        <AdvancedScrollbar :scroller="scroller" variant="minimal" />
      </div>

      <section class="work-env-detail" aria-label="工作环境详情">
        <template v-if="activeEnvironment">
          <header class="work-env-detail-header">
            <div>
              <h4>{{ environmentName(activeEnvironment) }}</h4>
              <p>{{ environmentPath(activeEnvironment) }}</p>
            </div>
            <button
              v-if="activeEnvironment && canRemoveWorkEnvironment(activeEnvironment)"
              type="button"
              class="icon-action"
              :disabled="!canDeleteActiveEnvironment"
              aria-label="删除工作环境"
              @click="openDeleteConfirm"
            >
              <IconTrash stroke="2" aria-hidden="true" />
            </button>
          </header>

          <component
            :is="activeDetailEditor"
            v-if="activeDetailEditor"
            :environment="activeEnvironment"
            :readonly="readonly"
            @update="updateActiveEnvironment"
          />

          <p v-else class="work-env-note">{{ detailNote(activeEnvironment) }}</p>

        </template>
        <div v-else class="work-env-empty">请选择一个工作环境。</div>
      </section>
    </div>

    <InputPanel
      :open="createOpen"
      :title="activeCreateAction?.title ?? '新建工作环境'"
      :description="activeCreateAction?.description ?? ''"
      :label="activeCreateAction?.inputLabel ?? '名称'"
      :placeholder="activeCreateAction?.placeholder ?? '输入工作环境名称'"
      :confirm-label="activeCreateAction?.confirmLabel ?? '创建'"
      @confirm="confirmCreate"
      @cancel="cancelCreate"
    />

    <ConfirmPanel
      :open="deleteConfirmOpen"
      title="删除工作环境？"
      :description-html="`将删除「${activeEnvironment ? environmentName(activeEnvironment) : '当前工作环境'}」，使用此环境的会话和默认策略将提示重新选择环境。此操作<strong>无法撤销</strong>。`"
      confirm-label="删除"
      cancel-label="取消"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </section>
</template>

<style scoped>
.work-environment-policy-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.work-env-header,
.work-env-actions,
.work-env-row-actions,
.work-env-detail-header {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.work-env-header,
.work-env-detail-header {
  justify-content: space-between;
  align-items: flex-start;
}

.work-env-title-block h3,
.work-env-detail-header h4 {
  margin: 0;
  font-size: var(--font-size-md);
}

.work-env-title-block p,
.work-env-detail-header p,
.work-env-status,
.work-env-note {
  margin: var(--space-1) 0 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}

.work-env-summary {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.work-env-summary span {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 2px var(--space-2);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.work-env-actions {
  flex-wrap: wrap;
}

.work-env-actions > button,
.mini-action,
.icon-action {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: transparent;
  box-shadow: none;
  font: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.work-env-actions > button {
  min-height: 30px;
  padding: 0 var(--space-2);
  font-size: var(--font-size-sm);
}

.mini-action {
  min-height: 24px;
  padding: 0 var(--space-2);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.icon-action {
  width: 28px;
  height: 28px;
  min-width: 28px;
  min-height: 28px;
  padding: 0;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
}

.work-env-actions > button:hover:not(:disabled),
.work-env-actions > button:focus-visible,
.mini-action:hover:not(:disabled),
.mini-action:focus-visible,
.icon-action:hover:not(:disabled),
.icon-action:focus-visible {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border);
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.work-env-actions > button:disabled,
.mini-action:disabled,
.icon-action:disabled {
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  background: transparent;
  opacity: 0.55;
  cursor: default;
}

.work-env-layout {
  min-height: 360px;
  display: grid;
  grid-template-columns: minmax(220px, 0.9fr) minmax(0, 1.2fr);
  gap: var(--space-3);
}

.work-env-list-shell {
  position: relative;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.work-env-list-scroll {
  max-height: 420px;
  overflow-y: auto;
  padding: var(--space-2);
  scrollbar-width: none;
}

.work-env-list-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.work-env-item {
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-2);
  align-items: center;
}

.work-env-item:hover,
.work-env-item.is-active {
  border-color: var(--vscode-panel-border);
  background: var(--vscode-list-hoverBackground, transparent);
}

.work-env-main {
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: var(--space-2);
  text-align: left;
}

.work-env-main:hover:not(:disabled),
.work-env-main:focus-visible {
  background: transparent;
  outline: none;
}

.work-env-icon {
  width: 24px;
  height: 24px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
}

.work-env-icon svg {
  width: 15px;
  height: 15px;
}

.work-env-copy,
.work-env-name-row {
  min-width: 0;
}

.work-env-copy {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.work-env-name-row {
  display: block;
}

.work-env-meta {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 2px var(--space-2);
  color: color-mix(in srgb, var(--vscode-descriptionForeground) 84%, transparent);
  font-size: var(--font-size-xs);
  line-height: 1.25;
}

.work-env-name,
.work-env-path {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.work-env-name {
  font-weight: 600;
}

.work-env-path {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.work-env-detail {
  min-width: 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
}


.work-env-empty {
  padding: var(--space-3);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

@media (max-width: 820px) {
  .work-env-layout {
    grid-template-columns: 1fr;
  }
}
</style>
