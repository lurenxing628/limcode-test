<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Component } from 'vue';
import { IconCaretUp, IconSearch } from '@tabler/icons-vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';

export interface SettingsDropdownOption {
  value: string;
  label: string;
  /** 仅用于折叠按钮上的紧凑展示；下拉列表仍使用 label / description。 */
  buttonLabel?: string;
  description?: string;
  icon?: Component;
  disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: SettingsDropdownOption[];
    placeholder?: string;
    title?: string;
    disabled?: boolean;
    emptyText?: string;
    noMatchText?: string;
    searchable?: boolean;
    searchPlaceholder?: string;
    maxHeight?: number | string;
    height?: number | string;
    closeSignal?: number | string;
    placement?: 'bottom' | 'top';
  }>(),
  {
    placeholder: '请选择',
    title: '',
    disabled: false,
    emptyText: '暂无可选项',
    noMatchText: '没有匹配的选项',
    searchable: false,
    searchPlaceholder: '筛选...',
    maxHeight: 260,
    height: '',
    placement: 'bottom'
  }
);

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void;
  (event: 'change', option: SettingsDropdownOption): void;
  (event: 'open'): void;
}>();

const root = ref<HTMLElement | null>(null);
const scroller = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const open = ref(false);
const filterText = ref('');

const selectedOption = computed(() => props.options.find((option) => option.value === props.modelValue));
const selectedIcon = computed(() => selectedOption.value?.icon);
const displayLabel = computed(() => selectedOption.value?.buttonLabel ?? selectedOption.value?.label ?? props.placeholder);
const filteredOptions = computed(() => {
  if (!props.searchable) return props.options;
  const keyword = filterText.value.trim().toLowerCase();
  if (!keyword) return props.options;
  return props.options.filter((option) => {
    return option.label.toLowerCase().includes(keyword)
      || option.value.toLowerCase().includes(keyword)
      || (option.description?.toLowerCase().includes(keyword) ?? false);
  });
});
const panelStyle = computed<Record<string, string>>(() => ({
  '--settings-dropdown-panel-max-height': cssLength(props.maxHeight),
  ...(props.height === '' || props.height === undefined ? {} : { '--settings-dropdown-panel-height': cssLength(props.height) })
}));

onMounted(() => {
  document.addEventListener('click', onDocumentClick);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
});

watch(open, (nextOpen) => {
  if (!nextOpen) return;
  if (!props.searchable) return;
  void nextTick(() => searchInput.value?.focus());
});

watch(
  () => props.options,
  () => {
    filterText.value = '';
  }
);

watch(
  () => props.closeSignal,
  () => {
    open.value = false;
  }
);

function toggle(): void {
  if (props.disabled) return;
  if (open.value) {
    open.value = false;
    return;
  }
  open.value = true;
  emit('open');
}

function select(option: SettingsDropdownOption): void {
  if (option.disabled) return;
  if (option.value === props.modelValue) {
    open.value = false;
    filterText.value = '';
    return;
  }
  emit('update:modelValue', option.value);
  emit('change', option);
  open.value = false;
  filterText.value = '';
}

function onDocumentClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (!root.value?.contains(target)) open.value = false;
}

function compactLabel(label: string): string {
  return label.length > 64 ? `${label.slice(0, 61)}...` : label;
}

function cssLength(value: number | string): string {
  if (typeof value === 'number') return `${value}px`;
  return value || '260px';
}
</script>

<template>
  <div ref="root" class="settings-dropdown">
    <button
      type="button"
      class="settings-dropdown-button"
      :class="{ 'is-placeholder': !selectedOption }"
      :disabled="disabled"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click.stop="toggle"
    >
      <span class="settings-dropdown-button-main">
        <component v-if="selectedIcon" :is="selectedIcon" class="settings-dropdown-option-icon" stroke="2" aria-hidden="true" />
        <span class="settings-dropdown-label">{{ displayLabel }}</span>
      </span>
      <IconCaretUp class="settings-dropdown-caret" :class="{ 'is-open': open }" stroke="2" aria-hidden="true" />
    </button>

    <Transition name="lc-dropdown">
      <section
        v-if="open"
        class="project-dropdown settings-dropdown-panel lc-dropdown-panel"
        :class="`placement-${placement}`"
        :style="panelStyle"
        role="listbox"
        @click.stop
      >
        <div ref="scroller" class="settings-dropdown-scroll">
          <div v-if="title" class="project-dropdown-title">{{ title }}</div>
          <label v-if="searchable" class="settings-dropdown-filter" aria-label="筛选选项">
            <IconSearch stroke="2" aria-hidden="true" />
            <input ref="searchInput" v-model="filterText" type="text" :placeholder="searchPlaceholder" />
          </label>
          <div v-if="!options.length" class="project-dropdown-empty">{{ emptyText }}</div>
          <div v-else-if="!filteredOptions.length" class="project-dropdown-empty">{{ noMatchText }}</div>
          <div
            v-for="option in filteredOptions"
            :key="option.value"
            class="settings-dropdown-option-row"
            :class="{ 'has-option-action': !!$slots.optionAction }"
          >
            <button
              type="button"
              class="project-option"
              :class="{ 'is-active': option.value === modelValue, 'has-icon': !!option.icon }"
              :disabled="option.disabled"
              role="option"
              :aria-selected="option.value === modelValue"
              @click="select(option)"
            >
              <component v-if="option.icon" :is="option.icon" class="settings-dropdown-option-icon" stroke="2" aria-hidden="true" />
              <span class="project-option-copy">
                <span class="project-option-name">{{ compactLabel(option.label) }}</span>
                <span v-if="option.description" class="project-option-path">{{ option.description }}</span>
              </span>
            </button>
            <slot name="optionAction" :option="option" :selected="option.value === modelValue" />
          </div>
          <div v-if="$slots.footer" class="settings-dropdown-footer">
            <slot name="footer" />
          </div>
        </div>
        <AdvancedScrollbar :scroller="scroller" variant="minimal" />
      </section>
    </Transition>
    <slot name="panelOverlay" :open="open" />
  </div>
</template>

<style scoped>
.settings-dropdown {
  position: relative;
  min-width: 0;
  width: 100%;
}

button.settings-dropdown-button {
  width: 100%;
  min-width: 0;
  min-height: 30px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  padding: var(--space-2);
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  font: inherit;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 16px;
  gap: var(--space-2);
  align-items: center;
}

.settings-dropdown-button-main {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

button.settings-dropdown-button:hover:not(:disabled),
button.settings-dropdown-button[aria-expanded='true'],
button.settings-dropdown-button:focus-visible,
button.settings-dropdown-button:active {
  border-color: var(--vscode-panel-border, transparent);
  background: color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 14%);
  outline: none;
}

.settings-dropdown-button.is-placeholder {
  color: var(--vscode-descriptionForeground);
}

.settings-dropdown-label {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-align: left;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.settings-dropdown-caret {
  width: 16px;
  height: 16px;
  justify-self: end;
  color: var(--vscode-foreground);
  transform: rotate(180deg);
  transition: transform 0.16s ease;
}

.settings-dropdown-caret.is-open {
  transform: rotate(0deg);
}

.settings-dropdown-panel {
  position: absolute;
  left: 0;
  top: calc(100% + 4px);
  z-index: 30;
  width: 100%;
  max-height: var(--settings-dropdown-panel-max-height, 260px);
  height: var(--settings-dropdown-panel-height, auto);
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: var(--vscode-editor-background);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.22);
}

.settings-dropdown-panel.placement-top {
  top: auto;
  bottom: calc(100% + 4px);
}

.settings-dropdown-scroll {
  max-height: var(--settings-dropdown-panel-max-height, 260px);
  height: var(--settings-dropdown-panel-height, auto);
  overflow-y: auto;
  padding: var(--space-2);
  scrollbar-width: none;
}

.settings-dropdown-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.settings-dropdown-footer {
  margin-top: var(--space-1);
  border-top: 1px solid var(--vscode-panel-border);
  padding-top: var(--space-2);
}

.settings-dropdown-panel .project-dropdown-title {
  margin: 0 0 var(--space-1);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.settings-dropdown-filter {
  min-height: 30px;
  margin-bottom: var(--space-1);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  padding: 0 var(--space-2);
  display: grid;
  grid-template-columns: 15px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: center;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-input-background);
}

.settings-dropdown-filter svg {
  width: 15px;
  height: 15px;
}

.settings-dropdown-filter input {
  width: 100%;
  min-height: 28px;
  border: 0;
  padding: 0;
  color: var(--vscode-input-foreground);
  background: transparent;
  outline: none;
  font: inherit;
}

.settings-dropdown-panel .project-dropdown-empty {
  padding: var(--space-2) 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.settings-dropdown-option-row {
  min-width: 0;
  display: block;
}

.settings-dropdown-option-row.has-option-action {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-1);
  align-items: stretch;
}

.settings-dropdown-panel .project-option {
  width: 100%;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 2px;
  min-height: 0;
  padding: var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: transparent;
  text-align: left;
}

.settings-dropdown-option-icon {
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
  color: currentColor;
}

.project-option-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.settings-dropdown-panel .project-option:not(.has-icon) {
  grid-template-columns: minmax(0, 1fr);
}

.settings-dropdown-panel .project-option:hover:not(:disabled),
.settings-dropdown-panel .project-option.is-active {
  background: var(--vscode-list-hoverBackground, transparent);
  border-color: var(--vscode-panel-border, transparent);
}

.settings-dropdown-panel .project-option:disabled {
  opacity: 0.5;
}

.settings-dropdown-panel .project-option-name {
  min-width: 0;
  overflow: hidden;
  font-size: var(--font-size-sm);
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.settings-dropdown-panel .project-option-path {
  min-width: 0;
  overflow: hidden;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
