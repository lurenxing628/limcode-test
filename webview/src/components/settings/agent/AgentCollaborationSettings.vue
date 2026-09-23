<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import type { ToolPolicyScopeKind } from '@shared/protocol';
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';
import {
  AGENT_COLLABORATION_CONFIG_KEYS,
  CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY,
  SUB_AGENT_TOOL_NAME,
  useToolPolicyStore,
  type AgentCollaborationConfigKey
} from '@webview/stores/useToolPolicyStore';

const props = withDefaults(defineProps<{
  scopeKind: ToolPolicyScopeKind;
  scopeId?: string;
  title?: string;
  readonly?: boolean;
}>(), { title: 'Agent 协作', readonly: false });

const store = useToolPolicyStore();
const { loading, text: loadingText } = useSettingsLoadingText('Agent 协作配置', () => props.scopeKind, () => props.scopeId);
const tool = computed(() => store.toolDefinitions.find((item) => item.name === SUB_AGENT_TOOL_NAME));
const SCOPE_LABELS: Record<ToolPolicyScopeKind, string> = { global: '全局', agent: 'Agent', conversation: '对话', workflow: '工作流', run: '本次运行' };
const localConfig = computed(() => store.localPolicyFor(props.scopeKind, props.scopeId).policy?.toolConfigs?.[SUB_AGENT_TOOL_NAME]?.config ?? {});
/** Inherited values follow every upper layer (global, the conversation's Agent and workflow). */
function inherited(key: string): { value: unknown; source: string } | undefined {
  const found = store.inheritedToolConfigValue(props.scopeKind, props.scopeId, SUB_AGENT_TOOL_NAME, key);
  return found ? { value: found.value, source: SCOPE_LABELS[found.from] } : undefined;
}
const fields = computed(() => AGENT_COLLABORATION_CONFIG_KEYS.flatMap((key) => {
  const field = tool.value?.configSchema?.fields.find((candidate) => candidate.key === key);
  if (!field) return [];
  const defaultValue = tool.value?.defaultConfig?.[key] ?? field.defaultValue;
  const upper = inherited(key);
  return [{
    key,
    label: key === 'maxChildAgentDepth' ? '最大子 Agent 深度' : field.label,
    description: field.description,
    defaultValue,
    value: localConfig.value[key] ?? upper?.value ?? defaultValue,
    inheritedLabel: `${upper?.source ?? '默认'} ${String(upper?.value ?? defaultValue)}`,
    minimum: key === 'maxConcurrentAgents' ? 1 : 0,
    unit: key === 'maxChildAgentDepth' ? '层' : key === 'maxConcurrentAgents' ? '个' : '次',
    overridden: localConfig.value[key] !== undefined
  }];
}));
const scopeLabel = computed(() => SCOPE_LABELS[props.scopeKind]);
/** A child task only collaborates inside its team; the switch has no effect there. */
const childConversation = computed(() => props.scopeKind === 'conversation' && store.isChildConversation(props.scopeId));
/** A stored tool list on this scope's chain that the backend refuses to compile. */
const listError = computed(() => store.toolListErrorFor(props.scopeKind, props.scopeId));
/** This scope's own invalid list must not be rewritten by a budget or switch edit; only a reset repairs it. */
const canEdit = computed(() => !props.readonly && !!tool.value && !loading.value && (props.scopeKind === 'global' || !!props.scopeId?.trim())
  && listError.value?.own !== true);
const spawnToolEnabled = computed(() => store.effectivePolicyFor(props.scopeKind, props.scopeId).policy?.allowedTools.includes(SUB_AGENT_TOOL_NAME) === true);
const crossConversationField = computed(() => tool.value?.configSchema?.fields.find((field) => field.key === CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY));
const crossConversationOverridden = computed(() => typeof localConfig.value[CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY] === 'boolean');
const crossConversationInherited = computed(() => inherited(CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY));
const crossConversationEnabled = computed(() => (localConfig.value[CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY]
  ?? crossConversationInherited.value?.value ?? crossConversationField.value?.defaultValue) === true);
const crossConversationInheritedLabel = computed(() => {
  const value = crossConversationInherited.value?.value ?? crossConversationField.value?.defaultValue;
  return `${crossConversationInherited.value?.source ?? '默认'}${value === true ? '开启' : '关闭'}`;
});
/** What the switch gives this scope right now, by the backend's own rule. */
const crossConversationState = computed(() => store.crossConversationStateFor(props.scopeKind, props.scopeId));
const crossConversationStateText = computed(() => {
  const state = crossConversationState.value;
  if (!state.enabled) return '当前生效：关闭，不提供跨对话工具。';
  if (!state.sendTools) return `当前生效：已开启，但当前范围的工具列表不含 run_agent，不提供发送、新建和分支对话工具；实际提供：${state.offered.join('、')}。`;
  return `当前生效：已开启，提供 ${state.offered.join('、')}。`;
});
const drafts = reactive<Partial<Record<AgentCollaborationConfigKey, string>>>({});
const errors = reactive<Partial<Record<AgentCollaborationConfigKey, string>>>({});

watch([fields, () => props.scopeKind, () => props.scopeId], () => {
  for (const field of fields.value) {
    drafts[field.key] = String(field.value);
    errors[field.key] = '';
  }
}, { immediate: true });

function saveField(key: AgentCollaborationConfigKey): void {
  if (!canEdit.value) return;
  const field = fields.value.find((item) => item.key === key);
  if (!field) return;
  const text = drafts[key]?.trim() ?? '';
  const value = Number(text);
  if (!text || !Number.isSafeInteger(value) || value < field.minimum) {
    errors[key] = `请输入大于或等于 ${field.minimum} 的整数。`;
    return;
  }
  errors[key] = '';
  store.setAgentCollaborationFieldForScope(props.scopeKind, props.scopeId, key, value);
}

function updateDraft(key: AgentCollaborationConfigKey, event: Event): void {
  drafts[key] = (event.target as HTMLInputElement).value;
}

function restoreField(key: AgentCollaborationConfigKey): void {
  if (!canEdit.value) return;
  store.setAgentCollaborationFieldForScope(props.scopeKind, props.scopeId, key, undefined);
}

function setCrossConversation(value: boolean): void {
  if (!canEdit.value) return;
  store.setCrossConversationCollaborationForScope(props.scopeKind, props.scopeId, value);
}

function restoreCrossConversation(): void {
  if (!canEdit.value) return;
  store.setCrossConversationCollaborationForScope(props.scopeKind, props.scopeId, undefined);
}
</script>

<template>
  <section class="agent-collaboration-settings" :aria-label="title">
    <header class="collaboration-heading">
      <h3>{{ title }} <SettingsLoadingInline :show="loading" :text="loadingText" /></h3>
      <span class="collaboration-source">{{ scopeLabel }}设置</span>
    </header>
    <p v-if="scopeKind === 'global'">设置子 Agent 的默认深度和团队预算。Agent、工作流和对话可按各自范围单独配置。</p>
    <p v-else>仅调整当前{{ scopeLabel }}的协作设置；未单独设置的项执行时继承上层策略，下方显示继承来源和值。</p>
    <p v-if="listError" class="collaboration-note collaboration-error" role="alert">{{ listError.text }}</p>
    <p v-if="crossConversationField && childConversation" class="collaboration-note">子 Agent 对话只在所属团队内协作，不提供跨对话工具，因此这里不显示跨对话协作开关。</p>
    <div v-else-if="crossConversationField" class="collaboration-field">
      <div class="collaboration-field-row">
        <LcCheckbox
          :model-value="crossConversationEnabled"
          :disabled="!canEdit"
          :aria-label="crossConversationField.label"
          @update:model-value="setCrossConversation"
        >{{ crossConversationField.label }}</LcCheckbox>
        <div class="collaboration-field-actions">
          <span>{{ crossConversationOverridden ? (scopeKind === 'global' ? '全局默认' : '本层单独设置') : (scopeKind === 'global' ? '系统默认' : `继承上层 · ${crossConversationInheritedLabel}`) }}</span>
          <button type="button" :disabled="!canEdit || !crossConversationOverridden" :aria-label="`${crossConversationField.label}：${scopeKind === 'global' ? '恢复默认' : '恢复继承'}`" @click="restoreCrossConversation">{{ scopeKind === 'global' ? '恢复默认 关闭' : '恢复继承' }}</button>
        </div>
      </div>
      <p>{{ crossConversationField.description }}</p>
      <p>开启后提供列出、读取、发送、新建和分支对话五个工具，仅顶层对话可用，不能寻址子 Agent 对话。发送类工具默认自动执行，可在工具设置中逐个改为执行前确认。目标对话正在运行时，消息排队到它本轮结束后再投递。</p>
      <p>开关就是授权：开启后直接提供这些工具，不写入工具列表，也不受工具列表影响；工具设置里不能单独停用其中某个工具，只能逐个改为执行前确认。工具列表不含 run_agent 时只提供列出和读取对话。</p>
      <p v-if="!listError" class="collaboration-note collaboration-cross-state">{{ crossConversationStateText }}</p>
    </div>
    <div v-for="field in fields" :key="field.key" class="collaboration-field">
      <div class="collaboration-field-row">
        <label class="collaboration-number-field">
          <span>{{ field.label }}</span>
          <span class="collaboration-number-input">
            <input
              :value="drafts[field.key]"
              type="number"
              :min="field.minimum"
              step="1"
              :max="Number.MAX_SAFE_INTEGER"
              :disabled="!canEdit"
              :aria-invalid="!!errors[field.key]"
              :aria-label="field.label"
              @input="updateDraft(field.key, $event)"
              @change="saveField(field.key)"
            />
            <span>{{ field.unit }}</span>
          </span>
        </label>
        <div class="collaboration-field-actions">
          <span>{{ field.overridden ? (scopeKind === 'global' ? '全局默认' : '本层单独设置') : (scopeKind === 'global' ? '系统默认' : `继承上层 · ${field.inheritedLabel}`) }}</span>
          <button type="button" :disabled="!canEdit || !field.overridden" :aria-label="`${field.label}：${scopeKind === 'global' ? '恢复默认' : '恢复继承'}`" @click="restoreField(field.key)">{{ scopeKind === 'global' ? `恢复默认 ${field.defaultValue}` : '恢复继承' }}</button>
        </div>
      </div>
      <p v-if="errors[field.key]" class="collaboration-error" role="alert">{{ errors[field.key] }}</p>
      <ul v-if="field.key === 'maxChildAgentDepth'" class="collaboration-depth-guide">
        <li><strong>0</strong>：不创建新的子 Agent。</li>
        <li><strong>1（默认）</strong>：主对话可创建子 Agent，子 Agent 不能继续创建下一层。</li>
        <li><strong>2 及以上</strong>：允许继续分派到相应层级；主对话从第 0 层算起。</li>
      </ul>
      <p v-else>{{ field.description }}</p>
    </div>
    <p class="collaboration-note">这些上限由用户设置，模型不能通过调用参数提高上限。深度调整影响后续新建子 Agent，不中断已有任务；查看、通信、等待和继续已有任务不增加深度。</p>
    <p v-if="tool && !listError && !spawnToolEnabled" class="collaboration-note">当前范围的工具策略已禁用 run_agent；调整协作设置不会自动启用工具。</p>
  </section>
</template>

<style scoped>
.agent-collaboration-settings { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-3); border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); }
.collaboration-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-2); }
h3, p { margin: 0; }
h3 { font-size: var(--font-size-sm); }
p, .collaboration-source, .collaboration-depth-guide, .collaboration-field-actions { color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); line-height: 1.6; }
.collaboration-source { padding: 1px var(--space-2); border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); }
.collaboration-field { display: flex; flex-direction: column; gap: var(--space-2); padding-top: var(--space-3); border-top: 1px solid var(--vscode-panel-border); }
.collaboration-field-row { display: flex; align-items: end; justify-content: space-between; flex-wrap: wrap; gap: var(--space-3); }
.collaboration-number-field { display: flex; flex-direction: column; gap: var(--space-2); font-size: var(--font-size-sm); }
.collaboration-number-input, .collaboration-field-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); }
.collaboration-number-input input { width: 96px; padding: var(--space-2); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: var(--radius-sm); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; }
button { padding: var(--space-2); border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); background: transparent; color: var(--vscode-foreground); font: inherit; font-size: var(--font-size-sm); cursor: pointer; }
button:hover:not(:disabled), button:focus-visible, input:focus-visible { outline: 1px solid color-mix(in srgb, var(--vscode-foreground) 45%, transparent); outline-offset: 1px; background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%); }
button:disabled, input:disabled { opacity: .55; cursor: not-allowed; }
.collaboration-depth-guide { margin: 0; padding-left: 20px; }
.collaboration-depth-guide strong { color: var(--vscode-foreground); }
.collaboration-error { color: var(--vscode-errorForeground); }
</style>
