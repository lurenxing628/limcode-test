<script setup lang="ts">
import { computed } from 'vue';
import { IconTrash } from '@tabler/icons-vue';
import SettingsDropdown, { type SettingsDropdownOption } from '../SettingsDropdown.vue';
import type { LlmParameterDefinition } from './llmParameterDefinitions';
import LlmSettingHint from './LlmSettingHint.vue';

const props = defineProps<{
  definition: LlmParameterDefinition;
  modelValue: unknown;
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: unknown): void;
  (event: 'remove'): void;
}>();

const numberValue = computed(() => typeof props.modelValue === 'number' && Number.isFinite(props.modelValue) ? String(props.modelValue) : '');
const UNSET = '__unset__';
const booleanValue = computed(() => typeof props.modelValue === 'boolean' ? String(props.modelValue) : UNSET);
const enumValue = computed(() => typeof props.modelValue === 'string' && props.modelValue !== 'not-set' ? props.modelValue : UNSET);
const unsetOption = { value: UNSET, label: '未设置（模型默认）', description: '不发送该参数；与显式关闭不同。' };
const booleanOptions: SettingsDropdownOption[] = [
  unsetOption,
  { value: 'true', label: '是', description: '发送 true' },
  { value: 'false', label: '否', description: '发送 false' }
];
const enumOptions = computed<SettingsDropdownOption[]>(() => {
  const options: SettingsDropdownOption[] = [unsetOption, ...(props.definition.options ?? []).filter(option => option.value !== 'not-set')];
  if (enumValue.value !== UNSET && !options.some(option => option.value === enumValue.value)) {
    options.push({ value: enumValue.value, label: `${enumValue.value}（已保存，当前不支持）`, disabled: true });
  }
  return options;
});

function updateNumber(event: Event): void {
  const raw = (event.target as HTMLInputElement).value.trim();
  if (!raw) {
    emit('update:modelValue', undefined);
    return;
  }
  const value = Number(raw);
  if (Number.isFinite(value)) emit('update:modelValue', value);
}

function updateBoolean(value: string): void {
  emit('update:modelValue', value === UNSET ? undefined : value === 'true');
}

function updateEnum(value: string): void {
  emit('update:modelValue', value === UNSET ? undefined : value);
}
</script>

<template>
  <article class="known-parameter-row" :data-parameter="definition.key">
    <div class="known-parameter-info">
      <LlmSettingHint :text="definition.label" :details="`${definition.description} 请求字段：${definition.displayPath}`" />
    </div>

    <div class="known-parameter-control">
      <input
        v-if="definition.valueType === 'number'"
        :value="numberValue"
        type="number"
        step="any"
        :placeholder="definition.placeholder ?? '未设置（模型默认）'"
        :aria-label="definition.label"
        @input="updateNumber"
      />
      <SettingsDropdown
        v-else-if="definition.valueType === 'boolean'"
        :model-value="booleanValue"
        :options="booleanOptions"
        title="选择是否启用"
        @update:model-value="updateBoolean"
      />
      <SettingsDropdown
        v-else
        :model-value="enumValue"
        :options="enumOptions"
        title="选择等级"
        @update:model-value="updateEnum"
      />
    </div>

    <button type="button" class="known-parameter-remove" :disabled="modelValue === undefined" :aria-label="`清除${definition.label}`" @click="emit('remove')">
      <IconTrash stroke="2" aria-hidden="true" />
    </button>
  </article>
</template>

<style scoped>
.known-parameter-row {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 26px;
  grid-template-areas: 'label remove' 'control control';
  gap: var(--space-1) var(--space-2);
  align-items: center;
  font-size: var(--font-size-sm);
}

.known-parameter-info {
  grid-area: label;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.known-parameter-info :deep(.llm-setting-hint) {
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.known-parameter-control {
  grid-area: control;
  min-width: 0;
}

.known-parameter-control input {
  width: 100%;
  box-sizing: border-box;
  min-height: 30px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  padding: var(--space-2);
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  font: inherit;
}

.known-parameter-control input[type='number'] {
  appearance: textfield;
  -moz-appearance: textfield;
}

.known-parameter-control input[type='number']::-webkit-outer-spin-button,
.known-parameter-control input[type='number']::-webkit-inner-spin-button {
  margin: 0;
  -webkit-appearance: none;
}

.known-parameter-remove {
  grid-area: remove;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--radius-sm);
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.known-parameter-remove:hover:not(:disabled),
.known-parameter-remove:focus-visible {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 14%);
  outline: none;
}

.known-parameter-remove svg {
  width: 14px;
  height: 14px;
}

</style>
