<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconPlus } from '@tabler/icons-vue';
import type { LlmGenerationConfigRecord, LlmProviderConfigRecord, LlmRequestBodyRecord } from '@shared/protocol';
import { resolveProviderModelCapabilities, thinkingConfigSupported } from '@shared/modelCapabilities';
import LlmKnownParameterRow from './LlmKnownParameterRow.vue';
import LlmCustomRequestBodyEditor from './LlmCustomRequestBodyEditor.vue';
import LlmParameterAddPanel, { type LlmParameterAddOption } from './LlmParameterAddPanel.vue';
import {
  labelForProvider,
  parameterDefinitionsForProvider,
  type LlmParameterDefinition
} from './llmParameterDefinitions';

const props = defineProps<{
  config: LlmProviderConfigRecord;
}>();

const emit = defineEmits<{
  (event: 'update-generation-config', value: LlmGenerationConfigRecord | undefined): void;
  (event: 'update-request-body', value: LlmRequestBodyRecord | undefined): void;
}>();

const addPanelOpen = ref(false);
const viewMode = ref<'parameter' | 'json'>('parameter');
const jsonDraft = ref('{}');
const jsonError = ref('');
const editingJson = ref(false);

const providerLabel = computed(() => labelForProvider(props.config.provider));
const generationConfig = computed<LlmGenerationConfigRecord>(() => props.config.generationConfig ?? {});
const requestBody = computed<LlmRequestBodyRecord>(() => props.config.requestBody ?? {});
const capabilities = computed(() => resolveProviderModelCapabilities(props.config, props.config.model));
const supportedDefinitions = computed(() => parameterDefinitionsForProvider(props.config.provider, props.config.model, capabilities.value));
const definitions = computed(() => parameterDefinitionsForProvider(props.config.provider, props.config.model).map((definition) =>
  supportedDefinitions.value.find((supported) => supported.key === definition.key) ?? {
    ...definition, description: `${definition.description} 当前模型未确认支持；已保存值保留供检查或移除。`
  }));
const activeDefinitions = computed(() => definitions.value.filter((definition) => hasPath(generationConfig.value, definition.path)));
const availableDefinitions = computed<LlmParameterAddOption[]>(() => supportedDefinitions.value.filter((definition) => !hasPath(generationConfig.value, definition.path)).map(withMutualExclusionState));
const hasRequestBody = computed(() => Object.keys(requestBody.value).length > 0);
const hasAnyParameter = computed(() => activeDefinitions.value.length > 0 || hasRequestBody.value);

watch(
  () => props.config.requestBody,
  (value) => {
    if (editingJson.value) return;
    jsonDraft.value = stringifyRequestBody(value ?? {});
    jsonError.value = '';
  },
  { deep: true, immediate: true }
);

function addKnownParameter(key: string): void {
  const definition = definitions.value.find((candidate) => candidate.key === key);
  if (!definition) return;
  if (isThinkingMutuallyExcluded(definition)) return;
  updateKnownValue(definition, definition.defaultValue);
}

function removeKnownParameter(definition: LlmParameterDefinition): void {
  const next = cloneGenerationConfig(generationConfig.value);
  deletePath(next, definition.path);
  emitGenerationConfig(next);
}

function updateKnownValue(definition: LlmParameterDefinition, value: unknown): void {
  const next = cloneGenerationConfig(generationConfig.value);
  if (value === undefined || value === '') deletePath(next, definition.path);
  else setPath(next, definition.path, value);
  if (next.thinkingConfig && capabilities.value.source !== 'unknown' && capabilities.value.reasoning.family !== 'none'
    && !thinkingConfigSupported(next.thinkingConfig, capabilities.value.reasoning)) {
    jsonError.value = '当前模型不支持该思考配置，请先移除冲突的预算或强度。';
    return;
  }
  jsonError.value = '';
  emitGenerationConfig(next);
}

function addCustomRequestBodyParameter(): void {
  const next = cloneRequestBody(requestBody.value);
  next[uniqueKey('custom_param', Object.keys(next))] = '';
  emit('update-request-body', next);
}

function updateRequestBody(value: LlmRequestBodyRecord): void {
  emit('update-request-body', value);
  if (!editingJson.value) jsonDraft.value = stringifyRequestBody(value);
}

function onJsonInput(event: Event): void {
  editingJson.value = true;
  jsonDraft.value = (event.target as HTMLTextAreaElement).value;
  const parsed = parseRequestBodyJson(jsonDraft.value);
  if (!parsed.ok) {
    jsonError.value = parsed.error;
    return;
  }
  jsonError.value = '';
  emit('update-request-body', parsed.value);
}

function onJsonBlur(): void {
  editingJson.value = false;
  const parsed = parseRequestBodyJson(jsonDraft.value);
  if (!parsed.ok) return;
  jsonDraft.value = stringifyRequestBody(parsed.value);
}

function formatJson(): void {
  const parsed = parseRequestBodyJson(jsonDraft.value);
  if (!parsed.ok) {
    jsonError.value = parsed.error;
    return;
  }
  jsonError.value = '';
  jsonDraft.value = stringifyRequestBody(parsed.value);
  emit('update-request-body', parsed.value);
}

function clearJson(): void {
  editingJson.value = false;
  jsonError.value = '';
  jsonDraft.value = '{}';
  emit('update-request-body', undefined);
}

function stringifyRequestBody(value: LlmRequestBodyRecord): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function withMutualExclusionState(definition: LlmParameterDefinition): LlmParameterAddOption {
  if (!isThinkingParameter(definition)) return definition;
  const activeThinking = activeDefinitions.value.find((candidate) => isThinkingParameter(candidate));
  if (!activeThinking || activeThinking.key === definition.key) return definition;
  return {
    ...definition,
    disabled: true,
    disabledReason: `${activeThinking.label} 已启用；思考预算和思考强度只能保留一个，请先移除 ${activeThinking.label}。`
  };
}

function isThinkingMutuallyExcluded(definition: LlmParameterDefinition): boolean {
  if (!isThinkingParameter(definition)) return false;
  return activeDefinitions.value.some((candidate) => isThinkingParameter(candidate) && candidate.key !== definition.key);
}

function isThinkingParameter(definition: LlmParameterDefinition): boolean {
  if (props.config.provider === 'claude' && capabilities.value.reasoning.family === 'anthropic_extended') return false;
  return definition.key === 'thinkingBudget' || definition.key === 'thinkingLevel';
}

function parseRequestBodyJson(text: string): { ok: true; value: LlmRequestBodyRecord } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(text.trim() || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '底层请求体（requestBody）必须是一个 JSON 对象。' };
    }
    return { ok: true, value: parsed as LlmRequestBodyRecord };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'JSON 格式无效。' };
  }
}

function emitGenerationConfig(value: LlmGenerationConfigRecord): void {
  const cleaned = cleanupGenerationConfig(value);
  emit('update-generation-config', Object.keys(cleaned).length > 0 ? cleaned : undefined);
}

function getPathValue(source: LlmGenerationConfigRecord, path: string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function hasPath(source: LlmGenerationConfigRecord, path: string[]): boolean {
  return getPathValue(source, path) !== undefined;
}

function setPath(target: LlmGenerationConfigRecord, path: string[], value: unknown): void {
  if (path.length === 1) {
    (target as Record<string, unknown>)[path[0]] = value;
    return;
  }
  if (path[0] !== 'thinkingConfig') return;
  target.thinkingConfig = { ...(target.thinkingConfig ?? {}) };
  (target.thinkingConfig as Record<string, unknown>)[path[1]] = value;
}

function deletePath(target: LlmGenerationConfigRecord, path: string[]): void {
  if (path.length === 1) {
    delete (target as Record<string, unknown>)[path[0]];
    return;
  }
  if (path[0] !== 'thinkingConfig' || !target.thinkingConfig) return;
  delete (target.thinkingConfig as Record<string, unknown>)[path[1]];
  if (Object.keys(target.thinkingConfig).length === 0) delete target.thinkingConfig;
}

function cleanupGenerationConfig(value: LlmGenerationConfigRecord): LlmGenerationConfigRecord {
  const next = cloneGenerationConfig(value);
  if (next.thinkingConfig && Object.keys(next.thinkingConfig).length === 0) delete next.thinkingConfig;
  return next;
}

function cloneGenerationConfig(value: LlmGenerationConfigRecord): LlmGenerationConfigRecord {
  return {
    ...(value.temperature !== undefined ? { temperature: value.temperature } : {}),
    ...(value.topP !== undefined ? { topP: value.topP } : {}),
    ...(value.topK !== undefined ? { topK: value.topK } : {}),
    ...(value.maxOutputTokens !== undefined ? { maxOutputTokens: value.maxOutputTokens } : {}),
    ...(value.thinkingConfig ? { thinkingConfig: { ...value.thinkingConfig } } : {})
  };
}

function cloneRequestBody(value: LlmRequestBodyRecord): LlmRequestBodyRecord {
  return JSON.parse(JSON.stringify(value)) as LlmRequestBodyRecord;
}

function uniqueKey(base: string, existingKeys: string[]): string {
  const existing = new Set(existingKeys);
  if (!existing.has(base)) return base;
  let index = 2;
  while (existing.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}
</script>

<template>
  <section class="llm-parameter-settings" aria-label="渠道参数配置">
    <header class="llm-parameter-header">
      <div>
        <label>自定义请求参数</label>
        <p>参数视图用于管理常用参数和自定义覆盖；JSON 视图可直接编辑底层请求体（requestBody）。</p>
      </div>
      <div class="llm-parameter-header-actions">
        <button v-if="viewMode === 'parameter'" type="button" class="llm-parameter-add" @click="addPanelOpen = true">
          <IconPlus stroke="2" aria-hidden="true" />
          <span>添加参数</span>
        </button>
        <div class="llm-parameter-segment" role="tablist" aria-label="参数配置视图">
          <button type="button" :class="{ active: viewMode === 'parameter' }" @click="viewMode = 'parameter'">参数视图</button>
          <button type="button" :class="{ active: viewMode === 'json' }" @click="viewMode = 'json'">JSON 视图</button>
        </div>
      </div>
    </header>

    <div v-if="viewMode === 'parameter'" class="llm-parameter-list">
      <div class="llm-parameter-list-meta">
        <strong>{{ providerLabel }}</strong>
        <span>自定义参数会写入底层请求体，并覆盖渠道自动生成的同名字段。</span>
      </div>

      <div v-if="!hasAnyParameter" class="llm-parameter-empty">暂无参数，点击“添加参数”选择。</div>

      <LlmKnownParameterRow
        v-for="definition in activeDefinitions"
        :key="definition.key"
        :definition="definition"
        :model-value="getPathValue(generationConfig, definition.path)"
        @update:model-value="updateKnownValue(definition, $event)"
        @remove="removeKnownParameter(definition)"
      />

      <LlmCustomRequestBodyEditor v-if="hasRequestBody" :model-value="requestBody" @update:model-value="updateRequestBody" />
    </div>

    <div v-else class="llm-json-view">
      <div class="llm-json-toolbar">
        <div>
          <strong>底层请求体 JSON（requestBody）</strong>
          <p>这里设置当前渠道额外发送的请求字段。它们会覆盖同名默认字段，但不包含消息、工具和系统提示词。</p>
        </div>
        <div class="llm-json-actions">
          <button type="button" @click="formatJson">格式化</button>
          <button type="button" @click="clearJson">清空</button>
        </div>
      </div>
      <textarea
        class="llm-json-editor"
        :class="{ invalid: !!jsonError }"
        :value="jsonDraft"
        spellcheck="false"
        @input="onJsonInput"
        @blur="onJsonBlur"
      ></textarea>
      <p v-if="jsonError" class="llm-json-error">{{ jsonError }}</p>
      <p v-else class="llm-json-hint">JSON 有效时会保存到当前配置的底层请求体（requestBody）。</p>
    </div>

    <LlmParameterAddPanel
      :open="addPanelOpen"
      :definitions="availableDefinitions"
      :provider-label="providerLabel"
      @add-known="addKnownParameter"
      @add-custom="addCustomRequestBodyParameter"
      @close="addPanelOpen = false"
    />
  </section>
</template>

<style scoped>
.llm-parameter-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.llm-parameter-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-2);
}

.llm-parameter-header label {
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.llm-parameter-header p,
.llm-json-toolbar p,
.llm-json-hint,
.llm-json-error {
  margin: 2px 0 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.45;
}

.llm-parameter-header-actions,
.llm-json-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  justify-content: flex-end;
}

.llm-parameter-segment {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 2px;
  display: inline-flex;
  gap: 2px;
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
}

.llm-parameter-segment button {
  min-height: 26px;
  border: 1px solid transparent;
  border-radius: calc(var(--radius-sm) - 2px);
  padding: 0 var(--space-2);
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font-size: var(--font-size-xs);
}

.llm-parameter-segment button:hover:not(:disabled),
.llm-parameter-segment button:focus-visible,
.llm-parameter-segment button.active {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border);
  background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-foreground) 18%);
  outline: none;
}

.llm-parameter-add,
.llm-json-actions button {
  min-height: 28px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-2);
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--vscode-foreground);
  background: transparent;
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.llm-parameter-add:hover:not(:disabled),
.llm-parameter-add:focus-visible,
.llm-json-actions button:hover:not(:disabled),
.llm-json-actions button:focus-visible {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.llm-parameter-add svg {
  width: 14px;
  height: 14px;
}

.llm-parameter-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.llm-parameter-list-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.llm-parameter-list-meta strong {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.llm-parameter-empty {
  border: 1px dashed var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.llm-json-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.llm-json-toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-2);
}

.llm-json-toolbar strong {
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
}

.llm-json-editor {
  width: 100%;
  min-height: 220px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  font: 12px/1.5 var(--vscode-editor-font-family, monospace);
  resize: vertical;
  outline: none;
}

.llm-json-editor:focus {
  border-color: var(--vscode-panel-border);
  background: color-mix(in srgb, var(--vscode-input-background) 94%, var(--vscode-foreground) 6%);
}

.llm-json-editor.invalid {
  border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
}

.llm-json-error {
  color: var(--vscode-errorForeground);
}

@media (max-width: 720px) {
  .llm-parameter-header,
  .llm-json-toolbar {
    flex-direction: column;
  }

  .llm-parameter-header-actions,
  .llm-json-actions {
    justify-content: flex-start;
  }
}
</style>
