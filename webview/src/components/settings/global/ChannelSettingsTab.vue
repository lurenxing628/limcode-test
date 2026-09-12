<script setup lang="ts">
import { computed, ref } from 'vue';
import { IconChevronDown, IconCloudDown, IconPencil, IconPlus, IconSearch, IconTrash } from '@tabler/icons-vue';
import {
  type LlmCompressionConfigRecord,
  type LlmGenerationConfigRecord,
  type LlmProviderConfigRecord,
  type LlmProviderHeadersRecord,
  type LlmProviderKind,
  type LlmProviderModelConfigRecord,
  type LlmProviderModelRecord,
  type LlmPromptCacheConfigRecord,
  type LlmRequestBodyRecord
} from '@shared/protocol';
import type { OpenAIResponsesNativeSettings } from '@shared/openAIResponsesNative';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import ConfirmPanel from '@webview/components/ui/ConfirmPanel.vue';
import InputPanel from '@webview/components/ui/InputPanel.vue';
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';
import LlmAdvancedConfigEditor from './LlmAdvancedConfigEditor.vue';
import LlmCompressionSettingsEditor from './LlmCompressionSettingsEditor.vue';
import ModelFetchDialog from './ModelFetchDialog.vue';
import SettingsDropdown, { type SettingsDropdownOption } from './SettingsDropdown.vue';

const settings = useGlobalSettingsStore();
const { loading: channelLoading, text: channelLoadingText } = useSettingsLoadingText('渠道配置', 'global', undefined, {
  globalSettingsSections: ['llm', 'llmProviderConfigs', 'llmCompression', 'llmCompressionConfigs'] as const
});
type SelectableCompressionMethodKind = 'openai_responses_compact' | 'llm_summary' | 'segmented_summary' | 'deterministic_summary';
const createOpen = ref(false);
const createProvider = ref<LlmProviderKind>('openai-compatible');
const renameOpen = ref(false);
const deleteConfirmOpen = ref(false);
const newModelOpen = ref(false);
const newModelName = ref('');
const modelFilter = ref('');
const modelListScroller = ref<HTMLElement | null>(null);
const clearModelsConfirmOpen = ref(false);
const defaultConfigOpen = ref(true);
const modelSpecificGroupOpen = ref(true);
const modelSpecificPanelOpen = ref<Record<string, boolean>>({});
const newModelSpecificModelId = ref('');
const deleteModelConfigConfirmOpen = ref(false);
const deletingModelConfigId = ref('');

const providerOptions: SettingsDropdownOption[] = [
  { value: 'openai-compatible', label: 'OpenAI Compatible' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'claude', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'deepseek', label: 'DeepSeek' }
];

type AdvancedConfigPatch = Partial<Pick<
  LlmProviderConfigRecord,
  'toolCallFormat' | 'openaiResponsesTransport' | 'stream' | 'retryOnError' | 'retryMaxAttempts' | 'retryDelaySeconds' | 'enableMultimodalTools' | 'systemPromptPrefix'
>>;

const activeConfig = computed(() => settings.activeLlmProviderConfig);
const canDeleteActiveConfig = computed(() => !!activeConfig.value && settings.llmProviderConfigs.configs.length > 1);
const activeConfigId = computed({
  get: () => settings.llm.activeProviderConfigId || activeConfig.value?.id || '',
  set: (configId: string) => settings.selectLlmProviderConfig(configId)
});
const configPageOptions = computed<SettingsDropdownOption[]>(() =>
  settings.llmProviderConfigs.configs.map((config) => ({ value: config.id, label: config.name, description: providerLabel(config.provider) }))
);
const activeProviderLabel = computed(() => providerLabel(activeConfig.value?.provider));
const filteredModels = computed<LlmProviderModelRecord[]>(() => {
  const keyword = modelFilter.value.trim().toLowerCase();
  const models = activeConfig.value?.models ?? [];
  if (!keyword) return models;
  return models.filter((model) => {
    return model.id.toLowerCase().includes(keyword) || model.name.toLowerCase().includes(keyword);
  });
});
const contextWindowTokens = computed(() => normalizeTokenCount(activeConfig.value?.contextWindowTokens) ?? 0);

const hasModels = computed(() => (activeConfig.value?.models.length ?? 0) > 0);
const canClearModels = computed(() => !!activeConfig.value && hasModels.value);
const activeModelConfigs = computed<LlmProviderModelConfigRecord[]>(() => activeConfig.value?.modelConfigs ?? []);
const modelSpecificOptions = computed<SettingsDropdownOption[]>(() => {
  const config = activeConfig.value;
  if (!config) return [];
  const configured = new Set(config.modelConfigs.map((item) => item.modelId));
  return config.models
    .filter((model) => !configured.has(model.id))
    .map((model) => ({ value: model.id, label: model.name, description: model.id }));
});
const selectedNewModelSpecificModelId = computed({
  get: () => {
    const options = modelSpecificOptions.value;
    if (options.some((option) => option.value === newModelSpecificModelId.value)) return newModelSpecificModelId.value;
    return options[0]?.value ?? '';
  },
  set: (modelId: string) => {
    newModelSpecificModelId.value = modelId;
  }
});
const canCreateModelSpecificConfig = computed(() => !!activeConfig.value && !!selectedNewModelSpecificModelId.value);
const deletingModelConfig = computed(() => activeModelConfigs.value.find((config) => config.id === deletingModelConfigId.value));
const deletingModelConfigLabel = computed(() => deletingModelConfig.value ? modelLabel(deletingModelConfig.value.modelId) : '该 LLM');

/** 获取模型弹窗对应配置中已存在的模型 ID，用于在弹窗中标记「已添加」状态。 */
const fetchedDialogExistingModelIds = computed<string[]>(() => {
  const configId = settings.fetchedModelsDialog.configId;
  const config = settings.llmProviderConfigs.configs.find((c) => c.id === configId);
  return config?.models.map((m) => m.id) ?? [];
});

function formatModelTime(value: string | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}


function updateActiveConfigField<K extends keyof LlmProviderConfigRecord>(key: K, value: LlmProviderConfigRecord[K]): void {
  settings.updateActiveLlmProviderConfig({ [key]: value } as Partial<LlmProviderConfigRecord>);
}

function updateDefaultAdvancedPatch(patch: AdvancedConfigPatch): void {
  settings.updateActiveLlmProviderConfig(patch);
}

function updateDefaultContextWindowTokens(value: number | undefined): void {
  settings.updateActiveLlmContextWindowTokens(value);
}

function updateDefaultGenerationConfig(value: LlmGenerationConfigRecord | undefined): void {
  settings.updateActiveLlmGenerationConfig(value);
}

function updateDefaultRequestBody(value: LlmRequestBodyRecord | undefined): void {
  settings.updateActiveLlmRequestBody(value);
}

function updateDefaultPromptCache(value: LlmPromptCacheConfigRecord | undefined): void {
  settings.updateActiveLlmPromptCache(value);
}

function updateDefaultNativeResponses(value: OpenAIResponsesNativeSettings | undefined): void {
  settings.updateActiveLlmNativeResponses(value);
}

function updateDefaultHeaders(value: LlmProviderHeadersRecord | undefined): void {
  settings.updateActiveLlmHeaders(value);
}

function updateModelAdvancedPatch(modelConfigId: string, patch: Partial<LlmProviderModelConfigRecord>): void {
  settings.updateActiveModelConfig(modelConfigId, patch);
}

function updateModelContextWindowTokens(modelConfigId: string, value: number | undefined): void {
  settings.updateActiveModelConfigContextWindowTokens(modelConfigId, value);
}

function updateModelGenerationConfig(modelConfigId: string, value: LlmGenerationConfigRecord | undefined): void {
  settings.updateActiveModelConfigGenerationConfig(modelConfigId, value);
}

function updateModelRequestBody(modelConfigId: string, value: LlmRequestBodyRecord | undefined): void {
  settings.updateActiveModelConfigRequestBody(modelConfigId, value);
}

function updateModelPromptCache(modelConfigId: string, value: LlmPromptCacheConfigRecord | undefined): void {
  settings.updateActiveModelConfigPromptCache(modelConfigId, value);
}

function updateModelNativeResponses(modelConfigId: string, value: OpenAIResponsesNativeSettings | undefined): void {
  settings.updateActiveModelConfigNativeResponses(modelConfigId, value);
}

function updateModelHeaders(modelConfigId: string, value: LlmProviderHeadersRecord | undefined): void {
  settings.updateActiveModelConfigHeaders(modelConfigId, value);
}

function normalizeTokenCount(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}

function modelLabel(modelId: string): string {
  const model = activeConfig.value?.models.find((candidate) => candidate.id === modelId);
  return model?.name?.trim() || modelId;
}

function modelConfigDescription(modelConfig: LlmProviderModelConfigRecord): string {
  return `LLM ID：${modelConfig.modelId} · 使用该 LLM 时完整替代渠道默认配置与上下文压缩`;
}

function modelConfigAsProviderConfig(modelConfig: LlmProviderModelConfigRecord): LlmProviderConfigRecord {
  const base = activeConfig.value;
  const now = Date.now();
  return {
    id: modelConfig.id,
    name: base ? `${base.name} · ${modelLabel(modelConfig.modelId)}` : modelLabel(modelConfig.modelId),
    provider: base?.provider ?? 'openai-compatible',
    baseUrl: base?.baseUrl ?? '',
    model: modelConfig.modelId,
    models: base?.models ?? [],
    apiKey: base?.apiKey ?? '',
    toolCallFormat: modelConfig.toolCallFormat,
    openaiResponsesTransport: modelConfig.openaiResponsesTransport,
    stream: modelConfig.stream,
    retryOnError: modelConfig.retryOnError,
    retryMaxAttempts: modelConfig.retryMaxAttempts,
    retryDelaySeconds: modelConfig.retryDelaySeconds,
    enableMultimodalTools: modelConfig.enableMultimodalTools,
    contextWindowTokens: modelConfig.contextWindowTokens,
    systemPromptPrefix: modelConfig.systemPromptPrefix,
    promptCache: modelConfig.promptCache,
    ...(modelConfig.nativeResponses ? { nativeResponses: { ...modelConfig.nativeResponses } } : {}),
    headers: modelConfig.headers ?? {},
    generationConfig: modelConfig.generationConfig ?? {},
    requestBody: modelConfig.requestBody ?? {},
    modelConfigs: [],
    createdAt: modelConfig.createdAt || now,
    updatedAt: modelConfig.updatedAt || now
  };
}

function isModelConfigOpen(modelConfigId: string): boolean {
  return modelSpecificPanelOpen.value[modelConfigId] ?? true;
}

function toggleModelConfig(modelConfigId: string): void {
  modelSpecificPanelOpen.value = {
    ...modelSpecificPanelOpen.value,
    [modelConfigId]: !isModelConfigOpen(modelConfigId)
  };
}

function createModelSpecificConfig(): void {
  const modelId = selectedNewModelSpecificModelId.value;
  if (!modelId) return;
  const created = settings.createModelConfigForActiveConfig(modelId);
  if (!created) return;
  modelSpecificPanelOpen.value = { ...modelSpecificPanelOpen.value, [created.id]: true };
  newModelSpecificModelId.value = '';
}

function openDeleteModelConfigConfirm(modelConfigId: string): void {
  deletingModelConfigId.value = modelConfigId;
  deleteModelConfigConfirmOpen.value = true;
}

function confirmDeleteModelConfig(): void {
  const id = deletingModelConfigId.value;
  deleteModelConfigConfirmOpen.value = false;
  deletingModelConfigId.value = '';
  if (!id) return;
  settings.deleteModelConfigFromActiveConfig(id);
}

function cancelDeleteModelConfig(): void {
  deleteModelConfigConfirmOpen.value = false;
  deletingModelConfigId.value = '';
}

function providerLabel(provider: LlmProviderKind | undefined): string {
  return providerOptions.find((option) => option.value === provider)?.label ?? '未知渠道';
}

function modelCompressionConfig(modelId: string): LlmCompressionConfigRecord | undefined {
  return settings.compressionConfigForActiveModel(modelId);
}

function updateDefaultCompressionProviderConfigId(providerConfigId: string): void {
  settings.setActiveCompressionProviderConfig(providerConfigId);
}

function updateDefaultCompressionMethodKind(kind: SelectableCompressionMethodKind): void {
  settings.setActiveCompressionMethodKind(kind);
}

function updateDefaultCompressionTrigger(patch: Partial<LlmCompressionConfigRecord['trigger']>): void {
  settings.updateActiveCompressionTrigger(patch);
}

function updateDefaultCompressionMaxDurationMinutes(value: number): void {
  settings.setActiveCompressionMaxDurationMinutes(value);
}

function updateDefaultCompressionBodyTargetTokens(value: number): void {
  settings.setActiveCompressionBodyTargetTokens(value);
}

function updateModelCompressionProviderConfigId(modelId: string, providerConfigId: string): void {
  settings.setModelCompressionProviderConfig(modelId, providerConfigId);
}

function updateModelCompressionMethodKind(modelId: string, kind: SelectableCompressionMethodKind): void {
  settings.setModelCompressionMethodKind(modelId, kind);
}

function updateModelCompressionTrigger(modelId: string, patch: Partial<LlmCompressionConfigRecord['trigger']>): void {
  settings.updateModelCompressionTrigger(modelId, patch);
}

function updateModelCompressionMaxDurationMinutes(modelId: string, value: number): void {
  settings.setModelCompressionMaxDurationMinutes(modelId, value);
}

function updateModelCompressionBodyTargetTokens(modelId: string, value: number): void {
  settings.setModelCompressionBodyTargetTokens(modelId, value);
}

function openCreate(): void {
  createProvider.value = 'openai-compatible';
  createOpen.value = true;
}

function confirmCreate(name: string): void {
  createOpen.value = false;
  settings.createLlmProviderConfig(name, createProvider.value);
}

function cancelCreate(): void {
  createOpen.value = false;
}

function updateCreateProvider(value: string): void {
  createProvider.value = value as LlmProviderKind;
}

function openNewModel(): void {
  newModelName.value = '';
  newModelOpen.value = true;
}

function confirmNewModel(modelId: string): void {
  newModelOpen.value = false;
  settings.addModelToActiveConfig(modelId, newModelName.value);
  newModelName.value = '';
}

function cancelNewModel(): void {
  newModelOpen.value = false;
  newModelName.value = '';
}

function updateNewModelName(event: Event): void {
  newModelName.value = (event.target as HTMLInputElement).value;
}

function openClearModelsConfirm(): void {
  if (!canClearModels.value) return;
  clearModelsConfirmOpen.value = true;
}

function confirmClearModels(): void {
  clearModelsConfirmOpen.value = false;
  settings.clearModelsFromActiveConfig();
}

function cancelClearModels(): void {
  clearModelsConfirmOpen.value = false;
}

function removeModel(modelId: string): void {
  settings.removeModelFromActiveConfig(modelId);
}

function openRename(): void {
  if (!activeConfig.value) return;
  renameOpen.value = true;
}

function confirmRename(name: string): void {
  const config = activeConfig.value;
  renameOpen.value = false;
  if (!config) return;
  settings.renameLlmProviderConfig(config.id, name);
}

function cancelRename(): void {
  renameOpen.value = false;
}

function openDeleteConfirm(): void {
  if (!canDeleteActiveConfig.value) return;
  deleteConfirmOpen.value = true;
}

function confirmDelete(): void {
  const config = activeConfig.value;
  deleteConfirmOpen.value = false;
  if (!config) return;
  settings.deleteLlmProviderConfig(config.id);
}

function addFetchedModels(models: LlmProviderModelRecord[]): void {
  settings.addFetchedModelsToConfig(models);
}

function cancelDelete(): void {
  deleteConfirmOpen.value = false;
}
</script>

<template>
  <section class="global-settings-tab-section" aria-label="渠道设置">
    <header class="global-settings-section-header">
      <div>
        <div class="channel-title-row">
          <h2>渠道</h2>
          <SettingsLoadingInline
            :show="channelLoading"
            :text="channelLoadingText"
          />
        </div>
        <p>配置全局范围内可复用的 LLM 渠道。后续 Agent、Workflow 或其他对象可通过关系数据复用这些配置。</p>
      </div>
    </header>

    <div class="channel-content-shell">
      <div class="channel-content" :aria-busy="channelLoading">
        <div class="channel-config-picker">
      <label class="global-settings-field channel-config-select">
        <span>配置页</span>
        <SettingsDropdown
          v-model="activeConfigId"
          :options="configPageOptions"
          title="切换配置页"
          empty-text="暂无渠道配置。"
          searchable
          search-placeholder="筛选配置页…"
        />
      </label>

      <div class="channel-config-actions" aria-label="渠道配置页操作">
        <button type="button" class="icon-action" aria-label="新建配置页" @click="openCreate">
          <IconPlus stroke="2" aria-hidden="true" />
        </button>
        <button type="button" class="icon-action" aria-label="重命名配置页" :disabled="!activeConfig" @click="openRename">
          <IconPencil stroke="2" aria-hidden="true" />
        </button>
        <button type="button" class="icon-action" aria-label="删除配置页" :disabled="!canDeleteActiveConfig" @click="openDeleteConfirm">
          <IconTrash stroke="2" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div v-if="activeConfig" class="global-settings-grid">
      <label class="global-settings-field global-settings-field-wide">
        <span>渠道类型</span>
        <input :value="activeProviderLabel" type="text" readonly />
      </label>

      <label class="global-settings-field global-settings-field-wide">
        <span>接口地址（Base URL）</span>
        <input :value="activeConfig.baseUrl" type="text" placeholder="https://api.openai.com/v1" @input="updateActiveConfigField('baseUrl', inputValue($event))" />
      </label>

      <label class="global-settings-field global-settings-api-key-field global-settings-field-wide">
        <span>API 密钥</span>
        <input :value="activeConfig.apiKey" type="text" placeholder="sk-..." autocomplete="off" spellcheck="false" @input="updateActiveConfigField('apiKey', inputValue($event))" />
      </label>

      <section class="model-manager global-settings-field-wide" aria-label="LLM 列表">
        <header class="model-manager-header">
          <label>LLM 列表</label>
          <div class="model-manager-actions">
            <button type="button" class="model-manager-button" @click="openNewModel">
              <IconPlus stroke="2" aria-hidden="true" />
              <span>新建 LLM</span>
            </button>
            <button type="button" class="model-manager-button" @click="settings.requestModelsForActiveConfig()">
              <IconCloudDown stroke="2" aria-hidden="true" />
              <span>获取 LLM</span>
            </button>
            <button type="button" class="model-manager-button" :disabled="!canClearModels" @click="openClearModelsConfirm">
              <IconTrash stroke="2" aria-hidden="true" />
              <span>清除全部</span>
            </button>
          </div>
        </header>

        <div class="model-list-container">
          <label class="model-filter-box" aria-label="筛选 LLM">
            <IconSearch stroke="2" aria-hidden="true" />
            <input v-model="modelFilter" type="text" placeholder="筛选 LLM…" />
          </label>

          <div class="model-list-shell">
            <div ref="modelListScroller" class="model-list-scroll">
              <div class="model-list">
                <div v-if="!hasModels" class="model-list-empty">暂无 LLM，请新建 LLM。</div>
                <div v-else-if="!filteredModels.length" class="model-list-empty">没有匹配的 LLM。</div>
                <div
                  v-for="model in filteredModels"
                  :key="model.id"
                  class="model-item"
                  :class="{ enabled: model.id === activeConfig.model, 'has-model-config': activeModelConfigs.some((config) => config.modelId === model.id) }"
                  role="button"
                  tabindex="0"
                  @click="settings.selectActiveConfigModel(model.id)"
                  @keydown.enter.prevent="settings.selectActiveConfigModel(model.id)"
                  @keydown.space.prevent="settings.selectActiveConfigModel(model.id)"
                >
                  <span class="model-status" aria-hidden="true"></span>
                  <span class="model-info">
                    <span class="model-name">{{ model.name }}</span>
                    <span class="model-id">ID: {{ model.id }}</span>
                    <span v-if="model.createdAt" class="model-time">时间：{{ formatModelTime(model.createdAt) }}</span>
                    <span v-if="activeModelConfigs.some((config) => config.modelId === model.id)" class="model-time">已设置 LLM 专属配置</span>
                  </span>
                  <button
                    type="button"
                    class="model-remove-btn"
                    aria-label="移除 LLM"
                    @click.stop="removeModel(model.id)"
                    @keydown.enter.stop.prevent="removeModel(model.id)"
                    @keydown.space.stop.prevent="removeModel(model.id)"
                  ><IconTrash stroke="2" aria-hidden="true" /></button>
                </div>
              </div>
            </div>
            <AdvancedScrollbar :scroller="modelListScroller" variant="minimal" />
          </div>
        </div>
      </section>

      <section class="channel-config-groups global-settings-field-wide" aria-label="LLM 配置分组">
        <article class="settings-collapse-panel">
          <header class="settings-collapse-head">
            <button type="button" class="settings-collapse-toggle" :aria-expanded="defaultConfigOpen" @click="defaultConfigOpen = !defaultConfigOpen">
              <IconChevronDown class="settings-collapse-caret" :class="{ collapsed: !defaultConfigOpen }" stroke="2" aria-hidden="true" />
              <span class="settings-collapse-title-wrap">
                <span class="settings-collapse-title">渠道默认配置</span>
                <span class="settings-collapse-desc">当前渠道的默认高级配置与上下文压缩；未设置 LLM 专属配置时使用这里。</span>
              </span>
            </button>
          </header>
          <div v-if="defaultConfigOpen" class="settings-collapse-body">
            <LlmAdvancedConfigEditor
              :config="activeConfig"
              @update-field="updateDefaultAdvancedPatch"
              @update-context-window-tokens="updateDefaultContextWindowTokens"
              @update-generation-config="updateDefaultGenerationConfig"
              @update-request-body="updateDefaultRequestBody"
              @update-prompt-cache="updateDefaultPromptCache"
              @update-native-responses="updateDefaultNativeResponses"
              @update-headers="updateDefaultHeaders"
            />
            <LlmCompressionSettingsEditor
              class="advanced-compression-editor"
              :config="settings.activeCompressionConfig"
              :current-provider-config="activeConfig"
              :provider-configs="settings.llmProviderConfigs.configs"
              :context-window-tokens="contextWindowTokens"
              @update-provider-config-id="updateDefaultCompressionProviderConfigId"
              @update-method-kind="updateDefaultCompressionMethodKind"
              @update-trigger="updateDefaultCompressionTrigger"
              @update-max-duration-minutes="updateDefaultCompressionMaxDurationMinutes"
              @update-body-target-tokens="updateDefaultCompressionBodyTargetTokens"
            />
          </div>
        </article>

        <article class="settings-collapse-panel model-specific-group-panel">
          <header class="settings-collapse-head">
            <button type="button" class="settings-collapse-toggle" :aria-expanded="modelSpecificGroupOpen" @click="modelSpecificGroupOpen = !modelSpecificGroupOpen">
              <IconChevronDown class="settings-collapse-caret" :class="{ collapsed: !modelSpecificGroupOpen }" stroke="2" aria-hidden="true" />
              <span class="settings-collapse-title-wrap">
                <span class="settings-collapse-title">LLM 专属配置</span>
                <span class="settings-collapse-desc">为某个 LLM 创建独立配置；使用该 LLM 时会完整替代渠道默认配置和上下文压缩设置。</span>
              </span>
            </button>
          </header>

          <div v-if="modelSpecificGroupOpen" class="settings-collapse-body model-specific-body">
            <div class="model-specific-create-row">
              <label class="global-settings-field model-specific-select-field">
                <span>选择 LLM</span>
                <SettingsDropdown
                  v-model="selectedNewModelSpecificModelId"
                  :options="modelSpecificOptions"
                  title="选择要创建专属配置的 LLM"
                  empty-text="当前 LLM 列表没有可创建专属配置的 LLM。"
                  searchable
                  search-placeholder="筛选 LLM…"
                  placement="top"
                />
              </label>
              <button type="button" class="model-manager-button model-specific-create-button" :disabled="!canCreateModelSpecificConfig" @click="createModelSpecificConfig">
                <IconPlus stroke="2" aria-hidden="true" />
                <span>创建 LLM 配置</span>
              </button>
            </div>

            <p class="model-specific-note">
              LLM 专属配置是完整配置副本：前置系统提示词、请求头、请求体、重试、多模态、上下文窗口、提示词缓存与上下文压缩都会替代默认配置；空前置提示词表示不注入，空请求头或请求体表示不使用默认值。
            </p>

            <div v-if="!activeModelConfigs.length" class="model-specific-empty">暂无 LLM 专属配置。</div>

            <article v-for="modelConfig in activeModelConfigs" :key="modelConfig.id" class="settings-collapse-panel model-config-panel">
              <header class="settings-collapse-head model-config-head">
                <button type="button" class="settings-collapse-toggle" :aria-expanded="isModelConfigOpen(modelConfig.id)" @click="toggleModelConfig(modelConfig.id)">
                  <IconChevronDown class="settings-collapse-caret" :class="{ collapsed: !isModelConfigOpen(modelConfig.id) }" stroke="2" aria-hidden="true" />
                  <span class="settings-collapse-title-wrap">
                    <span class="settings-collapse-title">{{ modelLabel(modelConfig.modelId) }}</span>
                    <span class="settings-collapse-desc">{{ modelConfigDescription(modelConfig) }}</span>
                  </span>
                </button>
                <button type="button" class="icon-action model-config-delete" aria-label="删除 LLM 专属配置" @click="openDeleteModelConfigConfirm(modelConfig.id)">
                  <IconTrash stroke="2" aria-hidden="true" />
                </button>
              </header>

              <div v-if="isModelConfigOpen(modelConfig.id)" class="settings-collapse-body model-config-body">
                <LlmAdvancedConfigEditor
                  :config="modelConfigAsProviderConfig(modelConfig)"
                  @update-field="updateModelAdvancedPatch(modelConfig.id, $event)"
                  @update-context-window-tokens="updateModelContextWindowTokens(modelConfig.id, $event)"
                  @update-generation-config="updateModelGenerationConfig(modelConfig.id, $event)"
                  @update-request-body="updateModelRequestBody(modelConfig.id, $event)"
                  @update-prompt-cache="updateModelPromptCache(modelConfig.id, $event)"
                  @update-native-responses="updateModelNativeResponses(modelConfig.id, $event)"
                  @update-headers="updateModelHeaders(modelConfig.id, $event)"
                />
                <LlmCompressionSettingsEditor
                  class="advanced-compression-editor"
                  :config="modelCompressionConfig(modelConfig.modelId)"
                  :current-provider-config="modelConfigAsProviderConfig(modelConfig)"
                  :provider-configs="settings.llmProviderConfigs.configs"
                  :context-window-tokens="normalizeTokenCount(modelConfig.contextWindowTokens) ?? 0"
                  @update-provider-config-id="updateModelCompressionProviderConfigId(modelConfig.modelId, $event)"
                  @update-method-kind="updateModelCompressionMethodKind(modelConfig.modelId, $event)"
                  @update-trigger="updateModelCompressionTrigger(modelConfig.modelId, $event)"
                  @update-max-duration-minutes="updateModelCompressionMaxDurationMinutes(modelConfig.modelId, $event)"
                  @update-body-target-tokens="updateModelCompressionBodyTargetTokens(modelConfig.modelId, $event)"
                />
              </div>
            </article>
          </div>
        </article>
      </section>
    </div>



    <div v-else class="global-settings-empty">暂无渠道配置，请新建一个配置页。</div>

    <div class="global-settings-actions">
      <button type="button" class="secondary" @click="settings.requestAll()">重新读取</button>
      <span class="global-settings-status">{{ settings.status || '渠道配置会自动保存' }}</span>
    </div>

    <div class="global-settings-path-list" aria-label="渠道配置路径信息">
      <p class="global-settings-path">
        当前配置选择：<code>{{ settings.filePaths.llm || '正在获取当前渠道配置路径…' }}</code>
      </p>
      <p class="global-settings-path">
        渠道配置页：<code>{{ settings.filePaths.llmProviderConfigs || '正在获取模型渠道配置路径…' }}</code>
      </p>
    </div>
      </div>
    </div>

    <InputPanel
      :open="createOpen"
      title="新建配置页"
      label="配置页名称"
      initial-value="新渠道配置"
      placeholder="输入配置页名称"
      confirm-label="新建"
      @confirm="confirmCreate"
      @cancel="cancelCreate"
    >
      <label class="global-settings-field create-channel-provider-field">
        <span>渠道类型</span>
        <SettingsDropdown :model-value="createProvider" :options="providerOptions" title="选择渠道类型" @update:model-value="updateCreateProvider" />
      </label>
    </InputPanel>

    <InputPanel
      :open="newModelOpen"
      title="新建 LLM"
      label="LLM ID"
      initial-value=""
      placeholder="输入 LLM ID"
      confirm-label="添加 LLM"
      @confirm="confirmNewModel"
      @cancel="cancelNewModel"
    >
      <label class="global-settings-field create-model-name-field">
        <span>LLM 名称（可选）</span>
        <input :value="newModelName" type="text" placeholder="不填则与 LLM ID 相同" @input="updateNewModelName" />
      </label>
    </InputPanel>


    <InputPanel
      :open="renameOpen"
      title="重命名配置页"
      label="配置页名称"
      :initial-value="activeConfig?.name ?? ''"
      placeholder="输入配置页名称"
      confirm-label="保存名称"
      @confirm="confirmRename"
      @cancel="cancelRename"
    />

    <ConfirmPanel
      :open="clearModelsConfirmOpen"
      title="清除全部 LLM？"
      description-html="将清除当前配置页下的所有 LLM，并取消当前使用的 LLM，此操作<strong>无法撤销</strong>。"
      confirm-label="清除全部"
      cancel-label="取消"
      @confirm="confirmClearModels"
      @cancel="cancelClearModels"
    />


    <ConfirmPanel
      :open="deleteConfirmOpen"
      title="删除配置页？"
      :description-html="`将删除「${activeConfig?.name ?? '当前配置'}」这个渠道配置页，此操作<strong>无法撤销</strong>。`"
      confirm-label="删除"
      cancel-label="取消"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />

    <ConfirmPanel
      :open="deleteModelConfigConfirmOpen"
      title="删除 LLM 专属配置？"
      :description-html="`将删除「${deletingModelConfigLabel}」的 LLM 专属配置。删除后该 LLM 会重新使用渠道默认配置，此操作<strong>无法撤销</strong>。`"
      confirm-label="删除"
      cancel-label="取消"
      @confirm="confirmDeleteModelConfig"
      @cancel="cancelDeleteModelConfig"
    />

    <ModelFetchDialog
      :open="settings.fetchedModelsDialog.open"
      :loading="settings.fetchedModelsDialog.loading"
      :models="settings.fetchedModelsDialog.models"
      :existing-model-ids="fetchedDialogExistingModelIds"
      @add="addFetchedModels"
      @close="settings.closeFetchedModelsDialog()"
    />
  </section>
</template>

<style scoped>
.channel-config-groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.settings-collapse-panel {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-foreground) 5%);
  overflow: hidden;
}

.settings-collapse-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: stretch;
  border-bottom: 1px solid transparent;
}

.settings-collapse-toggle {
  min-width: 0;
  border: 0;
  padding: var(--space-3);
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: start;
  color: var(--vscode-foreground);
  background: transparent;
  text-align: left;
}

.settings-collapse-toggle:hover,
.settings-collapse-toggle:focus-visible,
.model-config-delete:hover,
.model-config-delete:focus-visible {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.settings-collapse-caret {
  width: 16px;
  height: 16px;
  margin-top: 1px;
  transition: transform 0.16s ease;
}

.settings-collapse-caret.collapsed {
  transform: rotate(-90deg);
}

.settings-collapse-title-wrap {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.settings-collapse-title {
  font-size: var(--font-size-sm);
  font-weight: 650;
  line-height: 1.35;
}

.settings-collapse-desc,
.model-specific-note {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.45;
}

.settings-collapse-body {
  padding: var(--space-3);
  border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent);
}

.model-specific-group-panel {
  overflow: visible;
}

.model-specific-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.model-specific-create-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-2);
  align-items: end;
}

.model-specific-create-button {
  min-height: 30px;
  margin-bottom: 0;
}

.model-specific-note {
  margin: 0;
}

.model-specific-empty {
  border: 1px dashed var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.model-config-panel {
  background: color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-foreground) 3%);
}

.model-config-head {
  grid-template-columns: minmax(0, 1fr) 34px;
}

.model-config-delete {
  align-self: stretch;
  width: 34px;
  height: auto;
  border-left: 1px solid color-mix(in srgb, var(--vscode-panel-border) 68%, transparent);
  border-radius: 0;
}

.model-config-body {
  background: color-mix(in srgb, var(--vscode-editor-background) 98%, var(--vscode-foreground) 2%);
}

.model-item.has-model-config .model-status {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-foreground) 22%, transparent);
}

.advanced-compression-editor {
  margin-top: var(--space-3);
}

@media (max-width: 720px) {
  .model-specific-create-row {
    grid-template-columns: 1fr;
  }

  .model-specific-create-button {
    justify-self: start;
  }
}
</style>
