<script setup lang="ts">
import { computed, ref } from 'vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import { useDataRootPromptStore } from '@webview/stores/useDataRootPromptStore';

const store = useDataRootPromptStore();
store.initialize();

const scroller = ref<HTMLElement | null>(null);
const prompt = computed(() => store.prompt);
const actions = computed<ConfirmPanelAction[]>(() => prompt.value?.actions.map((action) => ({ ...action })) ?? []);
const refreshKey = computed(() => `${prompt.value?.flowId ?? ''}:${store.include.join('|')}`);

function onAction(action: ConfirmPanelAction): void {
  store.answer(action.key);
}
</script>

<template>
  <ConfirmPanel
    :open="!!prompt"
    :title="prompt?.title ?? ''"
    :description="prompt?.description ?? ''"
    :actions="actions"
    :danger="prompt?.danger ?? false"
    test-id="data-root-prompt"
    @action="onAction"
    @cancel="store.answer('cancel')"
  >
    <div v-if="prompt" class="data-root-prompt-scroll-shell">
      <div ref="scroller" class="data-root-prompt-scroll">
        <section v-for="(section, index) in prompt.sections" :key="index" class="data-root-prompt-section">
          <h3 v-if="section.title">{{ section.title }}</h3>
          <ul v-if="section.lines.length">
            <li v-for="(line, lineIndex) in section.lines" :key="lineIndex">{{ line }}</li>
          </ul>
          <div v-for="option in section.options ?? []" :key="option.key" class="data-root-prompt-choice">
            <LcCheckbox
              :model-value="store.include.includes(option.key)"
              size="sm"
              :aria-label="option.label"
              @update:model-value="store.toggle(option.key, $event)"
            >
              <span class="data-root-prompt-option">{{ option.label }}</span>
            </LcCheckbox>
            <span v-if="option.detail" class="data-root-prompt-option-detail">{{ option.detail }}</span>
          </div>
        </section>
        <section v-if="prompt.options?.length" class="data-root-prompt-section" aria-label="可选删除项">
          <div v-for="option in prompt.options" :key="option.key" class="data-root-prompt-choice">
            <LcCheckbox
              :model-value="store.include.includes(option.key)"
              size="sm"
              :aria-label="option.label"
              @update:model-value="store.toggle(option.key, $event)"
            >
              <span class="data-root-prompt-option">{{ option.label }}</span>
            </LcCheckbox>
            <span v-if="option.detail" class="data-root-prompt-option-detail">{{ option.detail }}</span>
          </div>
        </section>
      </div>
      <AdvancedScrollbar :scroller="scroller" :refresh-key="refreshKey" variant="minimal" />
    </div>
  </ConfirmPanel>
</template>

<style scoped>
.data-root-prompt-scroll-shell {
  position: relative;
  min-height: 0;
}

.data-root-prompt-scroll {
  max-height: min(52vh, 420px);
  overflow-y: auto;
  padding-right: 12px;
  scrollbar-width: none;
}

.data-root-prompt-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.data-root-prompt-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-2);
}

.data-root-prompt-section h3 {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: 600;
}

.data-root-prompt-section ul {
  margin: 0;
  padding-left: 1.2em;
}

.data-root-prompt-section li {
  overflow-wrap: anywhere;
  line-height: 1.5;
}

.data-root-prompt-option {
  overflow-wrap: anywhere;
}

.data-root-prompt-choice {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.data-root-prompt-option-detail {
  padding-left: 24px;
  overflow-wrap: anywhere;
  line-height: 1.5;
  color: var(--vscode-descriptionForeground);
}
</style>
