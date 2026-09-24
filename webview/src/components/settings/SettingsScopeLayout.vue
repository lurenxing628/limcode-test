<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Component, ComponentPublicInstance } from 'vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import SettingsLoadingInline from './SettingsLoadingInline.vue';

export interface SettingsScopeTabDefinition<TKey extends string = string> {
  key: TKey;
  label: string;
  description: string;
  icon: Component;
  component: Component;
  loading?: () => boolean;
  loadingText?: () => string;
}

const props = defineProps<{
  tabs: readonly SettingsScopeTabDefinition[];
  defaultTab: string;
  settingsLabel: string;
}>();

const activeTab = ref(props.defaultTab);
const contentScroller = ref<HTMLElement | null>(null);
const tabsContainer = ref<HTMLElement | null>(null);
const scrollbarFading = ref(false);
const tabElements = new Map<string, HTMLElement>();
const activeTabMarkerStyle = ref({
  width: '0px',
  height: '0px',
  opacity: '0',
  transform: 'translate3d(0px, 0px, 0)'
});
let tabsResizeObserver: ResizeObserver | null = null;

const activeTabComponent = computed(() =>
  props.tabs.find((tab) => tab.key === activeTab.value)?.component ?? props.tabs[0]?.component
);

watch(
  () => props.defaultTab,
  (nextDefault) => {
    if (!props.tabs.some((tab) => tab.key === activeTab.value)) activeTab.value = nextDefault;
  }
);

function setActiveTab(tabKey: string): void {
  if (activeTab.value === tabKey) return;
  activeTab.value = tabKey;
}

function setTabElement(tabKey: string, element: Element | ComponentPublicInstance | null): void {
  const currentElement = tabElements.get(tabKey);
  if (currentElement && currentElement !== element) {
    tabsResizeObserver?.unobserve(currentElement);
    tabElements.delete(tabKey);
  }

  if (!(element instanceof HTMLElement)) return;

  tabElements.set(tabKey, element);
  tabsResizeObserver?.observe(element);
}

function updateActiveTabMarker(): void {
  const containerElement = tabsContainer.value;
  const activeElement = tabElements.get(activeTab.value);

  if (!containerElement || !activeElement) {
    activeTabMarkerStyle.value = {
      width: '0px',
      height: '0px',
      opacity: '0',
      transform: 'translate3d(0px, 0px, 0)'
    };
    return;
  }

  activeTabMarkerStyle.value = {
    width: `${activeElement.offsetWidth}px`,
    height: `${activeElement.offsetHeight}px`,
    opacity: '1',
    transform: `translate3d(${activeElement.offsetLeft}px, ${activeElement.offsetTop}px, 0)`
  };
}

watch(activeTab, () => {
  void nextTick(updateActiveTabMarker);
});

onMounted(() => {
  tabsResizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateActiveTabMarker);
  if (tabsContainer.value) tabsResizeObserver?.observe(tabsContainer.value);
  for (const element of tabElements.values()) tabsResizeObserver?.observe(element);
  window.addEventListener('resize', updateActiveTabMarker);
  void nextTick(updateActiveTabMarker);
});

onBeforeUnmount(() => {
  tabsResizeObserver?.disconnect();
  window.removeEventListener('resize', updateActiveTabMarker);
});
</script>

<template>
  <section class="settings-panel" :aria-label="settingsLabel">
    <div class="settings-tabs-shell">
    <aside ref="tabsContainer" class="settings-tabs" :aria-label="`${settingsLabel}页签`">
      <span class="settings-tab-active-marker" :style="activeTabMarkerStyle" aria-hidden="true"></span>
      <button
        v-for="tab in tabs"
        :key="tab.key"
        :ref="(element) => setTabElement(tab.key, element)"
        type="button"
        class="settings-tab"
        :class="{ 'is-active': activeTab === tab.key }"
        :aria-pressed="activeTab === tab.key"
        @click="setActiveTab(tab.key)"
      >
        <component :is="tab.icon" class="tab-icon" stroke="2" aria-hidden="true" />
        <span class="tab-text">
          <span class="tab-label-line">
            <span class="tab-label">{{ tab.label }}</span>
            <SettingsLoadingInline
              :show="tab.loading?.() === true"
              :text="tab.loadingText?.() ?? '正在加载...'"
            />
          </span>
          <span class="tab-description">{{ tab.description }}</span>
        </span>
      </button>
    </aside>
    <AdvancedScrollbar class="settings-tabs-scrollbar" :scroller="tabsContainer" variant="minimal" orientation="horizontal" />
    </div>

    <div class="settings-content-shell">
      <div ref="contentScroller" class="settings-content">
        <Transition
          name="settings-content-switch"
          mode="out-in"
          @before-leave="() => (scrollbarFading = true)"
          @after-enter="() => (scrollbarFading = false)"
        >
          <component v-if="activeTabComponent" :is="activeTabComponent" :key="activeTab" />
        </Transition>
      </div>

      <div class="settings-scrollbar-wrapper" :class="{ 'is-fading': scrollbarFading }">
        <AdvancedScrollbar :scroller="contentScroller" :refresh-key="activeTab" show-edge-buttons />
      </div>
    </div>
  </section>
</template>

<style scoped>
.settings-panel {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: 196px minmax(0, 1fr);
  border: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editor-background);
}

.settings-tabs-shell {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.settings-tabs-scrollbar {
  display: none;
}

.settings-tabs {
  position: relative;
  min-width: 0;
  height: 100%;
  padding: var(--space-2);
  border-right: 1px solid var(--vscode-panel-border);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.settings-tab-active-marker {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  box-shadow: inset 3px 0 0 var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 84%, var(--vscode-foreground) 16%);
  pointer-events: none;
  transition:
    transform 0.22s cubic-bezier(0.2, 0, 0, 1),
    width 0.22s cubic-bezier(0.2, 0, 0, 1),
    height 0.22s cubic-bezier(0.2, 0, 0, 1),
    opacity 0.12s ease;
  will-change: transform, width, height;
}

.settings-tab {
  position: relative;
  z-index: 1;
  width: 100%;
  min-height: 56px;
  padding: var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: center;
  color: var(--vscode-foreground);
  background: transparent;
  text-align: left;
  transition:
    border-color 0.16s ease,
    background 0.16s ease;
}

.settings-tab:hover:not(:disabled),
.settings-tab:focus-visible {
  border-color: var(--vscode-panel-border);
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.settings-tab.is-active,
.settings-tab.is-active:hover:not(:disabled),
.settings-tab.is-active:focus-visible {
  border-color: transparent;
  background: transparent;
}

.tab-icon {
  width: 18px;
  height: 18px;
  color: var(--vscode-foreground);
}

.tab-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tab-label {
  font-weight: 600;
  line-height: 1.3;
}

.tab-label-line {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.tab-label-line :deep(.settings-loading-inline) {
  min-width: 0;
  max-width: 96px;
  margin-left: 0;
  padding-inline: var(--space-1);
}

.tab-label-line :deep(.settings-loading-inline > span:last-child) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-description {
  overflow: hidden;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-content-shell {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.settings-content {
  position: relative;
  height: 100%;
  overflow-y: auto;
  padding: var(--space-4) calc(var(--space-4) + 28px) var(--space-4) var(--space-4);
  scrollbar-width: none;
}

.settings-content::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.settings-scrollbar-wrapper {
  transition: opacity 0.16s ease;
}

.settings-scrollbar-wrapper.is-fading {
  opacity: 0;
}

.settings-content-switch-enter-active,
.settings-content-switch-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.18s cubic-bezier(0.2, 0, 0, 1);
}

.settings-content-switch-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.settings-content-switch-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.settings-content-switch-enter-to,
.settings-content-switch-leave-from {
  opacity: 1;
  transform: translateY(0);
}

@media (max-width: 720px) {
  .settings-panel {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
  }

  .settings-tabs {
    border-right: 0;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-direction: row;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .settings-tabs::-webkit-scrollbar {
    display: none;
  }

  .settings-tabs-scrollbar {
    display: flex;
  }

  .settings-tab-active-marker {
    box-shadow: inset 0 -2px 0 var(--vscode-foreground);
  }

  .settings-tab {
    flex: 0 0 auto;
    width: auto;
    min-height: 44px;
    grid-template-columns: 18px max-content;
  }

  .tab-label {
    white-space: nowrap;
  }

  .tab-description {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .settings-tab-active-marker,
  .settings-tab,
  .settings-scrollbar-wrapper,
  .settings-content-switch-enter-active,
  .settings-content-switch-leave-active {
    transition-duration: 1ms;
  }

  .settings-content-switch-enter-from,
  .settings-content-switch-leave-to {
    transform: none;
  }
}
</style>
