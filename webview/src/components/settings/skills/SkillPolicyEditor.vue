<script setup lang="ts">
import { computed, ref } from 'vue';
import type {
  SkillDefinitionRecord,
  SkillPolicyScopeKind,
  SkillPolicySourceConfigRecord,
  SkillSource
} from '@shared/protocol';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import { useSkillPolicyStore } from '@webview/stores/useSkillPolicyStore';
import { useToolPolicyStore } from '@webview/stores/useToolPolicyStore';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const props = withDefaults(defineProps<{
  scopeKind: SkillPolicyScopeKind;
  scopeId?: string;
  title?: string;
  description?: string;
  readonly?: boolean;
}>(), {
  title: '技能策略',
  description: '',
  readonly: false
});

interface SkillSourceGroup {
  source: SkillSource;
  label: string;
  hint: string;
  skills: SkillDefinitionRecord[];
}

const SKILL_SOURCES: readonly SkillSource[] = ['agents', 'claude', 'global'];
const SOURCE_META: Record<SkillSource, { label: string; hint: string }> = {
  agents: { label: '.agents 技能', hint: '来自当前项目 .agents/skills/ 目录。' },
  claude: { label: '.claude 技能', hint: '来自当前项目 .claude/skills/ 目录（Claude Code 兼容）。' },
  global: { label: '全局技能', hint: '来自数据根 skills/ 目录，所有项目共享。' }
};

const store = useSkillPolicyStore();
const { loading: skillLoading, text: skillLoadingText } = useSettingsLoadingText('技能配置', () => props.scopeKind, () => props.scopeId);
const scroller = ref<HTMLElement | null>(null);
const refreshing = ref(false);
const expandedSkillIds = ref<string[]>([]);

const skills = computed(() => store.skillDefinitions);
const localResolution = computed(() => store.localPolicyFor(props.scopeKind, props.scopeId));
const effectiveResolution = computed(() => store.effectivePolicyFor(props.scopeKind, props.scopeId));
const effectivePolicy = computed(() => effectiveResolution.value.policy);
const hasLocalOverride = computed(() => props.scopeKind === 'global' || !!localResolution.value.policy);

const groups = computed<SkillSourceGroup[]>(() => SKILL_SOURCES.map((source) => ({
  source,
  label: SOURCE_META[source].label,
  hint: SOURCE_META[source].hint,
  skills: skills.value.filter((skill) => skill.source === source)
})));

const enabledCount = computed(() => skills.value.filter((skill) => isSkillEnabled(skill)).length);
const canRestoreInheritance = computed(() => props.scopeKind !== 'global' && hasLocalOverride.value && !props.readonly);
// Mirrors the backend child bound (childExecutionBoundary.ts): a skill the parent Turn turned off stays off.
// A Plan the user approved to run in a new conversation is the exception: it keeps the executor's own settings.
const childBoundNote = computed(() => {
  const rule = '派出它的对话关掉的技能，这里也用不了。';
  if (props.scopeKind === 'agent') {
    return `这个 Agent 被模型派出作为子 Agent 运行时，${rule}用户在 Plan 卡片上选「新开对话执行」交给它时，按它自己的技能设置运行。`;
  }
  const tools = useToolPolicyStore();
  if (props.scopeKind !== 'conversation' || !tools.isChildConversation(props.scopeId)) return '';
  return tools.childConversationBoundedByParent(props.scopeId)
    ? `这是子 Agent 对话，${rule}`
    : '这是用户批准 Plan 后新开的子 Agent 对话，按执行 Agent 自己的技能设置运行，不受派出它的对话限制。';
});
const sourceLabel = computed(() => {
  if (props.scopeKind === 'global') return '全局默认策略';
  if (hasLocalOverride.value) return '当前范围的单独设置';
  return '继承全局默认策略';
});

function sourceConfig(source: SkillSource): SkillPolicySourceConfigRecord | undefined {
  return effectivePolicy.value?.sourceConfigs?.[source];
}

function isSourceEnabled(source: SkillSource): boolean {
  return sourceConfig(source)?.enabled !== false;
}

function isSkillEnabled(skill: SkillDefinitionRecord): boolean {
  const config = sourceConfig(skill.source);
  if (!config) return true;
  if (config.enabled === false) return false;
  return !(config.disabledSkills ?? []).includes(skill.id);
}

function cloneSourceConfigs(): Partial<Record<SkillSource, SkillPolicySourceConfigRecord>> {
  const result: Partial<Record<SkillSource, SkillPolicySourceConfigRecord>> = {};
  for (const [source, record] of Object.entries(effectivePolicy.value?.sourceConfigs ?? {}) as [SkillSource, SkillPolicySourceConfigRecord | undefined][]) {
    if (!record) continue;
    result[source] = {
      enabled: record.enabled !== false,
      ...(record.disabledSkills?.length ? { disabledSkills: [...record.disabledSkills] } : {})
    };
  }
  return result;
}

function commit(nextConfigs: Partial<Record<SkillSource, SkillPolicySourceConfigRecord>>): void {
  store.setPolicyForScope(props.scopeKind, props.scopeId, nextConfigs, effectivePolicy.value?.name);
}

function toggleSource(source: SkillSource, enabled: boolean): void {
  if (props.readonly) return;
  const nextConfigs = cloneSourceConfigs();
  const current = nextConfigs[source];
  nextConfigs[source] = {
    enabled,
    ...(current?.disabledSkills?.length ? { disabledSkills: [...current.disabledSkills] } : {})
  };
  commit(nextConfigs);
}

function toggleSkill(skill: SkillDefinitionRecord, enabled: boolean): void {
  if (props.readonly) return;
  const nextConfigs = cloneSourceConfigs();
  const current = nextConfigs[skill.source] ?? { enabled: true };
  const disabled = new Set(current.disabledSkills ?? []);
  if (enabled) disabled.delete(skill.id);
  else disabled.add(skill.id);
  nextConfigs[skill.source] = {
    enabled: current.enabled !== false,
    ...(disabled.size > 0 ? { disabledSkills: [...disabled] } : {})
  };
  commit(nextConfigs);
}

function allSourceConfigs(enabled: boolean): Partial<Record<SkillSource, SkillPolicySourceConfigRecord>> {
  return Object.fromEntries(SKILL_SOURCES.map((source) => [source, { enabled }])) as Partial<Record<SkillSource, SkillPolicySourceConfigRecord>>;
}

function enableAll(): void {
  if (props.readonly) return;
  commit(allSourceConfigs(true));
}

function disableAll(): void {
  if (props.readonly) return;
  commit(allSourceConfigs(false));
}

function restoreInheritance(): void {
  if (!canRestoreInheritance.value) return;
  store.clearPolicyScope(props.scopeKind, props.scopeId);
}

function refreshCatalog(): void {
  if (refreshing.value) return;
  refreshing.value = true;
  store.refreshCatalog();
  // 刷新后目录通过 clientState patch 回流，这里给一个短暂的按钮反馈即可。
  window.setTimeout(() => { refreshing.value = false; }, 1200);
}

function isSkillExpanded(id: string): boolean {
  return expandedSkillIds.value.includes(id);
}

function toggleSkillExpanded(id: string): void {
  expandedSkillIds.value = isSkillExpanded(id)
    ? expandedSkillIds.value.filter((candidate) => candidate !== id)
    : [...expandedSkillIds.value, id];
}
</script>

<template>
  <section class="skill-policy-editor" :aria-label="title">
    <header class="skill-policy-header">
      <div class="skill-policy-title-block">
        <h3>
          {{ title }}
          <SettingsLoadingInline :show="skillLoading" :text="skillLoadingText" />
        </h3>
        <p v-if="description">{{ description }}</p>
      </div>
      <div class="skill-policy-summary" aria-live="polite">
        <span>{{ sourceLabel }}</span>
        <span>{{ enabledCount }} / {{ skills.length }} 已启用</span>
      </div>
    </header>

    <p v-if="childBoundNote" class="skill-policy-note">{{ childBoundNote }}</p>

    <div class="skill-policy-actions">
      <button type="button" class="secondary" :disabled="refreshing" @click="refreshCatalog">{{ refreshing ? '刷新中…' : '刷新技能' }}</button>
      <button type="button" :disabled="readonly || skills.length === 0" @click="enableAll">启用全部</button>
      <button type="button" class="secondary" :disabled="readonly || skills.length === 0" @click="disableAll">禁用全部</button>
      <button v-if="scopeKind !== 'global'" type="button" class="secondary" :disabled="!canRestoreInheritance" @click="restoreInheritance">恢复继承</button>
    </div>

    <div class="skill-list-shell">
      <div ref="scroller" class="skill-list-scroll">
        <div v-if="skills.length === 0" class="skill-list-empty">
          未发现技能。将 SKILL.md 放入项目 .agents/skills/&lt;名称&gt;/、.claude/skills/&lt;名称&gt;/ 或数据根 skills/&lt;名称&gt;/ 后会自动出现。
        </div>
        <template v-else>
          <section v-for="group in groups" :key="group.source" class="skill-source-group" aria-label="技能来源分组">
            <div class="skill-source-heading">
              <LcCheckbox
                class="skill-source-toggle"
                :model-value="isSourceEnabled(group.source)"
                :disabled="readonly || group.skills.length === 0"
                @update:model-value="toggleSource(group.source, $event)"
              >
                <span class="skill-source-copy">
                  <span class="skill-source-name">{{ group.label }}</span>
                  <span class="skill-source-meta">{{ group.hint }} · {{ group.skills.length }} 个技能</span>
                </span>
              </LcCheckbox>
            </div>

            <div v-if="group.skills.length > 0" class="skill-source-items" :class="{ 'is-source-disabled': !isSourceEnabled(group.source) }">
              <article
                v-for="skill in group.skills"
                :key="skill.id"
                class="skill-item"
                :class="{ 'is-expanded': isSkillExpanded(skill.id) }"
              >
                <LcCheckbox
                  class="skill-item-toggle"
                  :model-value="isSkillEnabled(skill)"
                  :disabled="readonly || !isSourceEnabled(group.source)"
                  :aria-label="`启用技能 ${skill.name}`"
                  @update:model-value="toggleSkill(skill, $event)"
                />
                <button
                  type="button"
                  class="skill-item-main"
                  :aria-expanded="isSkillExpanded(skill.id)"
                  @click="toggleSkillExpanded(skill.id)"
                >
                  <span class="skill-copy" :class="{ 'is-clamped': !isSkillExpanded(skill.id) }">
                    <span class="skill-name">{{ skill.name }}</span>
                    <span v-if="skill.description" class="skill-desc">{{ skill.description }}</span>
                    <span v-else class="skill-desc is-empty">无描述</span>
                  </span>
                  <span class="skill-item-caret" :class="{ 'is-expanded': isSkillExpanded(skill.id) }" aria-hidden="true"></span>
                </button>
              </article>
            </div>
            <p v-else class="skill-source-empty">该来源暂无技能。</p>
          </section>
        </template>
      </div>
      <AdvancedScrollbar :scroller="scroller" variant="minimal" />
    </div>
  </section>
</template>

<style scoped>
.skill-policy-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.skill-policy-header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: flex-start;
  flex-wrap: wrap;
}

.skill-policy-title-block h3 {
  margin: 0;
  font-size: var(--font-size-md);
}

.skill-policy-title-block p {
  margin: var(--space-1) 0 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}

.skill-policy-note {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

.skill-policy-summary {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.skill-policy-summary span {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 2px var(--space-2);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.skill-policy-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  align-items: center;
}

.skill-policy-actions button {
  min-height: 28px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-2);
  color: var(--vscode-foreground);
  background: transparent;
  font: inherit;
}

.skill-policy-actions button:hover:not(:disabled),
.skill-policy-actions button:focus-visible {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.skill-policy-actions button:disabled {
  opacity: 0.45;
}

.skill-list-shell {
  position: relative;
  min-height: 200px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
}

.skill-list-scroll {
  max-height: 520px;
  overflow-y: auto;
  scrollbar-width: none;
}

.skill-list-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.skill-list-empty {
  padding: var(--space-3);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}

.skill-source-group {
  border-bottom: 1px solid var(--vscode-panel-border);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.skill-source-group:last-child {
  border-bottom: 0;
}

.skill-source-toggle {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: flex-start;
}

.skill-source-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.skill-source-name {
  font-weight: 650;
}

.skill-source-meta {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.4;
}

.skill-source-items {
  display: grid;
  gap: var(--space-1);
  padding-left: calc(16px + var(--space-2));
}

.skill-source-items.is-source-disabled {
  opacity: 0.55;
}

.skill-item {
  min-height: 40px;
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 88%, transparent);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: flex-start;
  background: var(--vscode-editor-background);
}

.skill-item-toggle {
  margin-top: 1px;
}

.skill-item-main {
  min-width: 0;
  border: 0;
  padding: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 14px;
  gap: var(--space-2);
  align-items: start;
  color: inherit;
  background: transparent;
  text-align: left;
  font: inherit;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
}

.skill-item-main:hover,
.skill-item-main:focus,
.skill-item-main:active {
  background: transparent;
  color: inherit;
  outline: none;
}

.skill-item-main:focus-visible {
  outline: 1px solid var(--vscode-panel-border);
  outline-offset: 2px;
}

.skill-item:hover {
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
}

.skill-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.skill-name {
  font-family: var(--vscode-editor-font-family, monospace);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.skill-desc {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.skill-desc.is-empty {
  font-style: italic;
  opacity: 0.7;
}

/* 收起态：名称与描述各自单行，超出末尾省略。 */
.skill-copy.is-clamped .skill-name,
.skill-copy.is-clamped .skill-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-item-caret {
  width: 7px;
  height: 7px;
  margin-top: 5px;
  border-right: 1.5px solid var(--vscode-descriptionForeground);
  border-bottom: 1.5px solid var(--vscode-descriptionForeground);
  transform: rotate(45deg);
  transition: transform 0.18s ease;
}

.skill-item-caret.is-expanded {
  transform: translateY(2px) rotate(225deg);
}

.skill-source-empty {
  margin: 0;
  padding-left: calc(16px + var(--space-2));
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}
</style>
