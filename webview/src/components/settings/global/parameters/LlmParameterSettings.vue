<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconPlus } from '@tabler/icons-vue';
import type { LlmGenerationConfigRecord, LlmProviderConfigRecord, LlmRequestBodyRecord, LlmThinkingLevel } from '@shared/protocol';
import { anthropicRejectsNonDefaultSampling, resolveProviderModelCapabilities, resolveProviderOpenAICompatibleDialect, thinkingConfigSupported } from '@shared/modelCapabilities';
import { sessionThinkingCapability, sessionThinkingDisplayLabel, validateSessionThinkingOverride } from '@shared/sessionThinking';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import LlmSettingHint from './LlmSettingHint.vue';
import LlmKnownParameterRow from './LlmKnownParameterRow.vue';
import LlmCustomRequestBodyEditor from './LlmCustomRequestBodyEditor.vue';
import {
  parameterDefinitionsForProvider,
  type LlmParameterDefinition
} from './llmParameterDefinitions';

const props = defineProps<{
  config: LlmProviderConfigRecord;
  section?: 'generation' | 'request-body';
}>();

const emit = defineEmits<{
  (event: 'update-generation-config', value: LlmGenerationConfigRecord | undefined): void;
  (event: 'update-request-body', value: LlmRequestBodyRecord | undefined): void;
}>();

const jsonScroller = ref<HTMLTextAreaElement | null>(null);
const viewMode = ref<'parameter' | 'json'>('parameter');
const jsonDraft = ref('{}');
const jsonError = ref('');
const editingJson = ref(false);

const generationConfig = computed<LlmGenerationConfigRecord>(() => props.config.generationConfig ?? {});
const requestBody = computed<LlmRequestBodyRecord>(() => props.config.requestBody ?? {});
const capabilities = computed(() => resolveProviderModelCapabilities(props.config, props.config.model));
const thinkingCapability = computed(() => sessionThinkingCapability(props.config.provider, props.config.model,
  generationConfig.value.maxOutputTokens, generationConfig.value.thinkingConfig, props.config));
const thinkingLabel = computed(() => sessionThinkingDisplayLabel(props.config.provider, props.config.model,
  generationConfig.value.thinkingConfig, props.config));
const supportedDefinitions = computed(() => {
  const thinking = thinkingCapability.value;
  const capability = capabilities.value;
  return parameterDefinitionsForProvider(props.config.provider, props.config.model, capability).filter(definition => {
    if (definition.key === 'topK'
      && props.config.provider === 'claude' && anthropicRejectsNonDefaultSampling(props.config.model)) return false;
    if (definition.path[0] !== 'thinkingConfig') return true;
    if (definition.key === 'thinkingBudget' && thinking?.kind === 'gemini-level') return false;
    if (props.config.provider === 'openai-compatible'
      && resolveProviderOpenAICompatibleDialect(props.config, props.config.model).format === 'omit') return false;
    if (thinking && 'min' in thinking && definition.key === 'thinkingLevel') {
      return capability.reasoning.family === 'anthropic_extended'
        && (capability.reasoning.levels.length > 0 || capability.reasoning.canDisable);
    }
    return Boolean(thinking) || capability.reasoning.family !== 'none' || capability.source === 'unknown';
  }).map(definition => {
    if (definition.key === 'thinkingBudget' && thinking && 'min' in thinking) {
      return { ...definition, description: `预算范围 ${thinking.min}–${thinking.max} Token。${thinking.automatic !== undefined ? ` ${thinking.automatic} 使用自动预算。` : ''}${thinking.allowZero ? ' 0 关闭思考。' : ''}留空使用模型默认。` };
    }
    if (definition.key !== 'thinkingLevel' || !thinking || !('values' in thinking)) return definition;
    return { ...definition, label: '思考强度', options: thinking.values
      .filter(value => definition.options?.some(option => option.value === value))
      .map(value => definition.options!.find(option => option.value === value)!) };
  });
});
// Saved but no-longer-supported fields remain visible for removal; displaying an unset row never writes a value.
const definitions = computed(() => {
  const all = [...parameterDefinitionsForProvider(props.config.provider, props.config.model),
    ...parameterDefinitionsForProvider(props.config.provider)];
  const result = [...supportedDefinitions.value];
  for (const definition of all) {
    if (!result.some(item => item.key === definition.key) && hasPath(generationConfig.value, definition.path)) {
      result.push({ ...definition, label: `${definition.label}（未确认支持）`, options: [], description: '当前模型未确认支持；已保存值保留供检查或清除。' });
    }
  }
  const order = ['maxOutputTokens', 'thinkingLevel', 'thinkingBudget', 'reasoningMode', 'topK', 'includeThoughts'];
  return result.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
});
const hasRequestBody = computed(() => Object.keys(requestBody.value).length > 0);

watch(
  () => props.config.requestBody,
  (value) => {
    if (editingJson.value) return;
    jsonDraft.value = stringifyRequestBody(value ?? {});
    jsonError.value = '';
  },
  { deep: true, immediate: true }
);

function removeKnownParameter(definition: LlmParameterDefinition): void {
  jsonError.value = '';
  const next = cloneGenerationConfig(generationConfig.value);
  deletePath(next, definition.path);
  emitGenerationConfig(next);
}

function updateKnownValue(definition: LlmParameterDefinition, value: unknown): void {
  const next = cloneGenerationConfig(generationConfig.value);
  if (value === undefined || value === '') deletePath(next, definition.path);
  else setPath(next, definition.path, value);
  if (value !== undefined && value !== '') {
    try {
      const otherThinkingKey = definition.key === 'thinkingLevel' ? 'thinkingBudget'
        : definition.key === 'thinkingBudget' ? 'thinkingLevel' : undefined;
      if (otherThinkingKey && generationConfig.value.thinkingConfig?.[otherThinkingKey] !== undefined
        && !(props.config.provider === 'claude' && capabilities.value.reasoning.family === 'anthropic_extended')) {
        throw new Error('思考预算和强度只能保留一个，请先清除另一项。');
      }
      if (definition.key === 'maxOutputTokens' && !(Number.isSafeInteger(value) && (value as number) > 0)) {
        throw new Error('最大输出 Token 必须是正整数。');
      }
      const budget = next.thinkingConfig?.thinkingBudget, maximum = next.maxOutputTokens;
      // Claude 要求 budget_tokens 小于 max_tokens，否则请求被拒；其它渠道不做此限制。
      if (props.config.provider === 'claude' && typeof budget === 'number' && budget > 0 && maximum !== undefined && budget >= maximum) {
        throw new Error('思考预算必须小于最大输出 Token；请先调高最大输出或降低思考预算。');
      }
      const thinking = thinkingCapability.value;
      if (definition.key === 'thinkingLevel' && thinking && 'values' in thinking && !thinking.values.includes(value as LlmThinkingLevel)) {
        throw new Error('当前模型不支持该思考强度。');
      }
      if (definition.key === 'thinkingBudget' && thinking && 'min' in thinking) {
        validateSessionThinkingOverride({ kind: thinking.kind, tokens: value as number }, props.config.provider,
          props.config.model, next, props.config.requestBody, props.config);
      }
      if (next.thinkingConfig && capabilities.value.source !== 'unknown' && capabilities.value.reasoning.family !== 'none'
        && !thinkingConfigSupported(next.thinkingConfig, capabilities.value.reasoning)) {
        throw new Error('当前模型不支持该思考配置，请先清除冲突的预算或强度。');
      }
    } catch (error) {
      jsonError.value = error instanceof Error ? error.message : '参数无效';
      return;
    }
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
  const parsed = parseRequestBodyJson(jsonDraft.value);
  if (!parsed.ok) return;
  editingJson.value = false;
  jsonDraft.value = stringifyRequestBody(parsed.value);
}

function resetJsonDraft(): void {
  editingJson.value = false;
  jsonError.value = '';
  jsonDraft.value = stringifyRequestBody(requestBody.value);
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
  <section v-if="section !== 'request-body'" class="llm-generation-settings" aria-label="生成参数">
    <div class="global-settings-grid">
      <slot name="before-generation-fields" />
      <LlmKnownParameterRow v-for="definition in definitions" :key="definition.key"
        :definition="definition" :model-value="getPathValue(generationConfig, definition.path)"
        @update:model-value="updateKnownValue(definition, $event)" @remove="removeKnownParameter(definition)" />
    </div>
    <LlmSettingHint :text="`思考：${thinkingLabel}`" details="未设置时不发送覆盖参数，由模型决定；关闭会发送明确的关闭设置。未知兼容端点的手工参数未经验证。" />
    <p v-if="jsonError" class="llm-json-error" role="alert">{{ jsonError }}</p>
  </section>
  <section v-else class="llm-parameter-settings" aria-label="自定义请求体">
    <header class="llm-parameter-header">
      <div>
        <label>Request Body JSON</label>
        <LlmSettingHint text="覆盖同名请求字段。" details="仅编辑底层 requestBody；常用生成参数在上方设置，不在此重复编辑。" />
      </div>
      <div class="llm-parameter-header-actions">
        <button v-if="viewMode === 'parameter'" type="button" class="llm-parameter-add" @click="addCustomRequestBodyParameter">
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
      <div v-if="!hasRequestBody" class="llm-parameter-empty">未设置自定义请求体。</div>

      <LlmCustomRequestBodyEditor v-if="hasRequestBody" :model-value="requestBody" @update:model-value="updateRequestBody" />
    </div>

    <div v-else class="llm-json-view">
      <div class="llm-json-toolbar">
        <div>
          <strong>底层请求体 JSON（requestBody）</strong>
          <p>这里设置当前渠道额外发送的请求字段。它们会覆盖同名默认字段，但不包含消息、工具和系统提示词。</p>
        </div>
        <div class="llm-json-actions">
          <button v-if="jsonError" type="button" @click="resetJsonDraft">恢复当前配置</button>
          <button type="button" @click="formatJson">格式化</button>
          <button type="button" @click="clearJson">清空</button>
        </div>
      </div>
      <div class="llm-json-shell">
      <textarea
        ref="jsonScroller"
        aria-label="Request Body JSON"
        class="llm-json-editor"
        :class="{ invalid: !!jsonError }"
        :value="jsonDraft"
        spellcheck="false"
        @input="onJsonInput"
        @blur="onJsonBlur"
      ></textarea>
      <AdvancedScrollbar :scroller="jsonScroller" variant="minimal" />
      </div>
      <p v-if="jsonError" class="llm-json-error">{{ jsonError }}</p>
      <p v-else class="llm-json-hint">JSON 有效时会保存到当前配置的底层请求体（requestBody）。</p>
    </div>

  </section>
</template>

<style scoped>
.llm-generation-settings { display: grid; gap: var(--space-2); min-width: 0; }
.llm-json-shell { position: relative; }
.llm-json-editor { scrollbar-width: none; }
.llm-json-editor::-webkit-scrollbar { display: none; }
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
