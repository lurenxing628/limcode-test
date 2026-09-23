<script setup lang="ts">
import { computed, ref } from 'vue';
import type {
  ToolConfigFieldRecord,
  ToolConfigRecord,
  ToolConfigValue,
  ToolDefinitionRecord,
  ToolDomainScope,
  ToolPolicySourceConfigRecord,
  ToolPolicyPresetKind,
  ToolPolicyScopeKind,
  ToolPolicyToolConfigRecord
} from '@shared/protocol';
import { ASK_USER_TOOL_NAME, EDIT_TOOL_NAME, SUBMIT_PLAN_TOOL_NAME, TOOL_POLICY_ALL_MCP_SOURCES } from '@shared/protocol';
import { isSwitchGrantedTool, mcpSourceConfigFor, toolAllowedByPolicy, toolConfigKey } from '@shared/toolPolicyResolution';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import SettingsDropdown, { type SettingsDropdownOption } from '@webview/components/settings/global/SettingsDropdown.vue';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import {
  AGENT_COLLABORATION_CONFIG_KEYS,
  CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY,
  SUB_AGENT_TOOL_NAME,
  cloneSourceConfigs as cloneSourceConfigRecords,
  useToolPolicyStore
} from '@webview/stores/useToolPolicyStore';
import { resolveToolHeaderIcon } from '@webview/components/content/toolDisplay/registry';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const props = withDefaults(defineProps<{
  scopeKind: ToolPolicyScopeKind;
  scopeId?: string;
  title?: string;
  description?: string;
  readonly?: boolean;
}>(), {
  title: '工具策略',
  description: '',
  readonly: false
});

const store = useToolPolicyStore();
const clientState = useClientStateStore();
const { loading: toolLoading, text: toolLoadingText } = useSettingsLoadingText('工具配置', () => props.scopeKind, () => props.scopeId);
const scroller = ref<HTMLElement | null>(null);
const expandedToolNames = ref<string[]>([]);

const tools = computed(() => store.toolDefinitions);
const interactionApprovalTools = computed(() => [SUBMIT_PLAN_TOOL_NAME, ASK_USER_TOOL_NAME].flatMap((toolName) => {
  const tool = tools.value.find((candidate) => candidate.name === toolName);
  const field = tool?.configSchema?.fields.find((candidate) => candidate.key === 'autoApprove');
  return tool && field ? [{ tool, field }] : [];
}));
const builtinTools = computed(() => tools.value.filter((tool) => tool.source?.kind !== 'mcp'));
const mcpTools = computed(() => tools.value.filter((tool) => tool.source?.kind === 'mcp'));
const mcpSourceGroups = computed(() => clientState.mcpToolSources.map((source) => ({
  source,
  tools: mcpTools.value.filter((tool) => tool.source?.sourceId === source.id)
})));
type ToolScopeFilter = 'all' | ToolDomainScope | `mcp:${string}`;
const selectedToolScope = ref<ToolScopeFilter>('all');
const localResolution = computed(() => store.localPolicyFor(props.scopeKind, props.scopeId));
const effectiveResolution = computed(() => store.effectivePolicyFor(props.scopeKind, props.scopeId));
const effectivePolicy = computed(() => effectiveResolution.value.policy);
const hasLocalOverride = computed(() => props.scopeKind === 'global' || !!localResolution.value.policy);
const allowedSet = computed(() => new Set(effectivePolicy.value?.allowedTools ?? []));
const enabledCount = computed(() => tools.value.filter((tool) => isToolEnabled(tool)).length);
const globalPreset = computed<Exclude<ToolPolicyPresetKind, 'inherit'>>(() => store.localPolicyFor('global').policy?.preset === 'yolo' ? 'yolo' : 'custom');
const selectedPreset = computed<ToolPolicyPresetKind>(() => props.scopeKind === 'global' ? globalPreset.value : localResolution.value.policy?.preset ?? 'inherit');
const runtimePreset = computed<Exclude<ToolPolicyPresetKind, 'inherit'>>(() => selectedPreset.value === 'inherit' ? globalPreset.value : selectedPreset.value);
const visibleTools = computed(() => {
  const scope = selectedToolScope.value;
  if (scope === 'all') return tools.value;
  if (scope.startsWith('mcp:')) {
    const sourceId = scope.slice('mcp:'.length);
    return mcpTools.value.filter((tool) => tool.source?.sourceId === sourceId);
  }
  return builtinTools.value.filter((tool) => toolScope(tool) === scope);
});
const visibleEnabledCount = computed(() => visibleTools.value.filter((tool) => isToolEnabled(tool)).length);
/** A stored tool list on this scope's chain that the backend refuses to compile. */
const listError = computed(() => store.toolListErrorFor(props.scopeKind, props.scopeId));
/** A child task's conversation: the cross-conversation tools are never offered there. */
const childConversation = computed(() => props.scopeKind === 'conversation' && store.isChildConversation(props.scopeId));
/** Where the cross-conversation switch lives for this scope. */
const collaborationArea = computed(() => props.scopeKind === 'global' ? '全局设置的「Agent 协作」页' : '当前设置页顶部的「Agent 协作」区域');
const switchGrantedToolNames = computed(() => builtinTools.value.filter((tool) => isSwitchGranted(tool)).map((tool) => tool.name));
/** This scope's own invalid list blocks every edit that would rewrite it; only a reset repairs it. */
const editsBlocked = computed(() => props.readonly || listError.value?.own === true);
/** Any invalid list on the chain blocks tool-list edits, which start from the effective list. */
const listEditsBlocked = computed(() => props.readonly || !!listError.value);
/** What the first list saved here adds beyond the tools shown now (global and workflows only). */
const firstListExtras = computed(() => props.readonly ? [] : store.listSeedExtrasFor(props.scopeKind, props.scopeId));
/** The built-in read-only Agents and workflows above this scope that deny every MCP source not enabled at their own scope. */
const mcpDenyingBuiltinsAbove = computed(() => store.mcpDenyingBuiltinsAbove(props.scopeKind, props.scopeId).map((scope) => store.scopeLabel(scope)));
/** A built-in read-only Agent or workflow denies every MCP source it does not enable itself. */
const mcpSourcesDeniedHere = computed(() => !!store.builtinPolicyFor(props.scopeKind, props.scopeId)?.sourceConfigs?.[TOOL_POLICY_ALL_MCP_SOURCES]);
const canRestoreInheritance = computed(() => props.scopeKind !== 'global' && hasLocalOverride.value && !props.readonly);
const canRestoreDefault = computed(() => {
  if (props.scopeKind !== 'global' || props.readonly) return false;
  return !isUsingToolDefaults.value;
});
/** Global uses the default tool set while it saves no list of its own. */
const isUsingToolDefaults = computed(() => props.scopeKind === 'global' && localResolution.value.policy?.allowedTools === undefined);
const sourceLabel = computed(() => {
  if (props.scopeKind === 'global' && runtimePreset.value === 'yolo') return '全局自动执行预设';
  if (props.scopeKind === 'global') return '全局默认策略';
  if (hasLocalOverride.value) return '当前范围的单独设置';
  if (store.builtinPolicyFor(props.scopeKind, props.scopeId)) {
    return props.scopeKind === 'agent' ? '沿用内置 Agent 的工具列表' : '沿用内置工作流的工具列表';
  }
  return props.scopeKind === 'conversation' ? '继承上层策略（全局、Agent 与工作流）' : '继承全局默认策略';
});
const presetOptions = computed<Array<{ value: ToolPolicyPresetKind; label: string; description: string }>>(() => [
  ...(props.scopeKind === 'global'
    ? []
    : [{
      value: 'inherit' as const,
      label: '继承全局预设',
      description: `当前全局为${globalPreset.value === 'yolo' ? '自动执行模式' : '自定义策略'}；当前范围仍可保留下方逐项工具配置。`
    }]),
  {
    value: 'custom',
    label: '自定义策略',
    description: props.scopeKind === 'global'
      ? '沿用下方已有启用、审批、自动应用和 MCP 来源配置。'
      : '当前范围使用自定义策略，不再继承全局自动执行预设。'
  },
  {
    value: 'yolo',
    label: '自动执行模式（YOLO）',
    description: '已启用的工具会直接运行；写入、编辑和删除文件产生的更改会立即应用，不再打开确认或差异预览页。'
  }
]);
const toolScopeOptions = computed<SettingsDropdownOption[]>(() => [
  { value: 'all', label: '全部领域', description: `${tools.value.length} 个工具` },
  ...TOOL_SCOPE_ORDER.map((scope) => {
    const count = builtinTools.value.filter((tool) => toolScope(tool) === scope).length;
    return { value: scope, label: scopeLabel(scope), description: `${count} 个工具`, disabled: count === 0 };
  }),
  ...mcpSourceGroups.value.map(({ source, tools: sourceTools }) => ({
    value: `mcp:${source.id}`,
    label: `MCP · ${source.name}`,
    description: `${sourceTools.length} 个工具`,
    disabled: sourceTools.length === 0
  }))
]);

const TOOL_SCOPE_ORDER: ToolDomainScope[] = ['agent', 'file', 'command', 'conversation', 'workEnvironment', 'task', 'skill', 'general'];

function updateSelectedToolScope(value: string): void {
  selectedToolScope.value = value === 'all' || value.startsWith('mcp:') || TOOL_SCOPE_ORDER.includes(value as ToolDomainScope)
    ? value as ToolScopeFilter
    : 'all';
}

/**
 * Config-only edits keep this scope's own list state: a scope without a saved list stays without
 * one, so adjusting approval or display never freezes the inherited tool list here.
 */
function localAllowedTools(): string[] | undefined {
  return store.ownListFor(props.scopeKind, props.scopeId);
}

function localPolicyName(): string | undefined {
  return localResolution.value.policy?.name;
}

/** The list saved when one tool is switched here; see `listSeedFor` for where it starts. */
function nextAllowed(toolName: string, enabled: boolean): string[] {
  const names = new Set(store.listSeedFor(props.scopeKind, props.scopeId));
  if (enabled) names.add(toolName);
  else names.delete(toolName);
  return tools.value.map((tool) => tool.name).filter((name) => names.has(name));
}

function updatePolicyPreset(value: ToolPolicyPresetKind): void {
  if (editsBlocked.value || selectedPreset.value === value) return;
  if (props.scopeKind === 'global' && value === 'inherit') return;
  store.setPolicyPresetForScope(props.scopeKind, props.scopeId, value);
}

/**
 * The backend's own admission rule over the effective policy: MCP tools follow source settings,
 * and the cross-conversation switch grants its tools to top-level conversations.
 */
function isToolEnabled(tool: ToolDefinitionRecord): boolean {
  if (isSwitchGranted(tool) && childConversation.value) return false;
  return toolAllowedByPolicy({
    allowedTools: allowedSet.value,
    sourceConfigs: effectivePolicy.value?.sourceConfigs,
    toolConfigs: effectivePolicy.value?.toolConfigs
  }, tool);
}

/** A cross-conversation tool: the switch in the Agent 协作 area grants it, not the tool list. */
function isSwitchGranted(tool: ToolDefinitionRecord): boolean {
  return tool.source?.kind !== 'mcp' && isSwitchGrantedTool(tool.name);
}

function isMcpSourceEnabled(sourceId: string): boolean {
  return mcpSourceConfigFor(effectivePolicy.value?.sourceConfigs, sourceId)?.enabled === true;
}

/** An upper layer turns this source off here, so enabling it at this scope would never apply. */
function isMcpSourceBlockedAbove(sourceId: string): boolean {
  return !!store.mcpSourceBlockedAbove(props.scopeKind, props.scopeId, sourceId);
}

/** An upper layer keeps this MCP tool off here, so its box cannot turn it on. */
function isMcpToolBlockedAbove(tool: ToolDefinitionRecord): boolean {
  return store.mcpToolBlockedAbove(props.scopeKind, props.scopeId, tool);
}

/**
 * The server switch turns every tool of the source on or off here, including tools it adds later;
 * the tools disabled one by one stay disabled, and a single-tool allowlist gives way to the whole source.
 */
function toggleMcpSource(sourceId: string, enabled: boolean): void {
  if (editsBlocked.value || (enabled && isMcpSourceBlockedAbove(sourceId))) return;
  const nextConfigs = cloneSourceConfigs();
  const disabledTools = nextConfigs[sourceId]?.disabledTools ?? [];
  nextConfigs[sourceId] = { enabled, ...(disabledTools.length > 0 ? { disabledTools } : {}) };
  store.setPolicyForScope(props.scopeKind, props.scopeId, localAllowedTools(), localPolicyName(), cloneToolConfigs(), nextConfigs);
}

/** One MCP tool follows its source settings: the switch changes that tool alone and never a tool list. */
function toggleMcpSourceTool(tool: ToolDefinitionRecord, enabled: boolean): void {
  if (listEditsBlocked.value || tool.source?.kind !== 'mcp' || enabled === isToolEnabled(tool)) return;
  if (!enabled) collapseToolConfig(tool.name);
  store.setMcpToolEnabledForScope(props.scopeKind, props.scopeId, tool, enabled);
}

/** One tool's box: a built-in tool edits this scope's list; the cross-conversation tools follow their switch only. */
function setToolEnabled(tool: ToolDefinitionRecord, enabled: boolean): void {
  if (tool.source?.kind === 'mcp') {
    toggleMcpSourceTool(tool, enabled);
    return;
  }
  if (isSwitchGranted(tool) || listEditsBlocked.value || enabled === isToolEnabled(tool)) return;
  if (!enabled) collapseToolConfig(tool.name);
  store.setPolicyForScope(props.scopeKind, props.scopeId, nextAllowed(tool.name, enabled), localPolicyName(), cloneToolConfigs(), cloneSourceConfigs());
}

function isToolConfigExpanded(toolName: string): boolean { return expandedToolNames.value.includes(toolName); }

function toggleToolConfig(toolName: string): void {
  expandedToolNames.value = isToolConfigExpanded(toolName)
    ? expandedToolNames.value.filter((name) => name !== toolName)
    : [...expandedToolNames.value, toolName];
}

function collapseToolConfig(toolName: string): void {
  expandedToolNames.value = expandedToolNames.value.filter((name) => name !== toolName);
}

function enableAll(): void {
  if (listEditsBlocked.value) return;
  const names = builtinTools.value.filter((tool) => !isSwitchGranted(tool)).map((tool) => tool.name);
  store.setPolicyForScope(props.scopeKind, props.scopeId, names, localPolicyName(), cloneToolConfigs(), cloneSourceConfigs());
}

function disableAll(): void {
  if (listEditsBlocked.value) return;
  expandedToolNames.value = [];
  store.setPolicyForScope(props.scopeKind, props.scopeId, [], localPolicyName(), cloneToolConfigs(), cloneSourceConfigs());
}

/** 恢复继承 resets this scope's tool settings; the Agent 协作 switch and limits keep their own restore buttons. */
function restoreInheritance(): void {
  if (!canRestoreInheritance.value) return;
  store.restoreToolInheritance(props.scopeKind, props.scopeId);
}

/**
 * 继承默认 resets the global tool list only: the saved list is dropped, so the default tool set and
 * the built-in Agent/workflow lists apply again. Per-tool settings (approval, display, the
 * cross-conversation switch and collaboration limits), MCP source settings and the preset stay; a
 * record left with nothing else is removed.
 */
function inheritDefaults(): void {
  if (!canRestoreDefault.value) return;
  store.saveOrDropLocalPolicy('global', undefined, undefined, cloneToolConfigs());
}

function riskLabel(tool: ToolDefinitionRecord): string {
  switch (tool.metadata?.riskLevel) {
    case 'read': return '只读';
    case 'write': return '写入';
    case 'command': return '命令';
    case 'agent': return 'Agent';
    default: return '未分类';
  }
}

function toolScope(tool: ToolDefinitionRecord): ToolDomainScope {
  if (tool.metadata?.scope) return tool.metadata.scope;
  switch (tool.metadata?.category) {
    case 'filesystem': return 'file';
    case 'command': return 'command';
    case 'agent': return 'agent';
    case 'general':
    default: return 'general';
  }
}

function scopeLabel(scope: ToolDomainScope): string {
  switch (scope) {
    case 'agent': return 'Agent';
    case 'file': return '文件';
    case 'command': return '命令';
    case 'conversation': return '对话';
    case 'workEnvironment': return '工作环境';
    case 'task': return '任务';
    case 'skill': return '技能';
    case 'general': return '通用';
  }
}

function executionLabel(tool: ToolDefinitionRecord): string {
  return tool.execution === 'agentRun' ? '由 Agent 执行' : '由系统执行';
}

function toolDescription(tool: ToolDefinitionRecord): string {
  return tool.description || '暂无说明。';
}

function editModeShortLabel(tool: ToolDefinitionRecord): string | undefined {
  if (tool.name !== EDIT_TOOL_NAME) return undefined;
  return '当前编辑方式：按内容片段查找并替换；也支持按行插入和删除。';
}

function toolIcon(tool: ToolDefinitionRecord) {
  return resolveToolHeaderIcon(tool.name);
}

/**
 * Edits start from this scope's own saved configs. The effective view merges upper layers in, and
 * saving it here would freeze those inherited values (for example the global cross-conversation
 * switch) into this scope.
 */
function cloneToolConfigs(): Record<string, ToolPolicyToolConfigRecord> {
  const result: Record<string, ToolPolicyToolConfigRecord> = {};
  for (const [toolName, record] of Object.entries(localResolution.value.policy?.toolConfigs ?? {})) {
    result[toolName] = {
      config: { ...(record.config ?? {}) },
      ...(typeof record.autoApproveExecution === 'boolean' ? { autoApproveExecution: record.autoApproveExecution } : {}),
      ...(typeof record.autoApplyChange === 'boolean' ? { autoApplyChange: record.autoApplyChange } : {}),
      ...(typeof record.autoApplyChangeDelaySeconds === 'number' ? { autoApplyChangeDelaySeconds: record.autoApplyChangeDelaySeconds } : {}),
      ...(typeof record.autoSubmitResult === 'boolean' ? { autoSubmitResult: record.autoSubmitResult } : {}),
      ...(typeof record.nativeAsync === 'boolean' ? { nativeAsync: record.nativeAsync } : {}),
      ...(record.display ? { display: { ...record.display } } : {})
    };
  }
  return result;
}

function cloneSourceConfigs(): Record<string, ToolPolicySourceConfigRecord> {
  return cloneSourceConfigRecords(localResolution.value.policy?.sourceConfigs) ?? {};
}

/**
 * This scope's own config values for one tool; a field edit adds to these only. Per-tool settings
 * are keyed by `toolConfigKey`: an MCP tool by server id and original name, never its display name.
 */
function localConfigForTool(tool: ToolDefinitionRecord): ToolConfigRecord {
  return { ...(localResolution.value.policy?.toolConfigs?.[toolConfigKey(tool)]?.config ?? {}) };
}

function configForTool(tool: ToolDefinitionRecord): ToolConfigRecord {
  return {
    ...(tool.defaultConfig ?? {}),
    ...(effectivePolicy.value?.toolConfigs?.[toolConfigKey(tool)]?.config ?? {})
  };
}

function fieldListText(tool: ToolDefinitionRecord, field: ToolConfigFieldRecord): string {
  const value = configForTool(tool)[field.key];
  if (Array.isArray(value)) return value.map((item) => String(item)).join('\n');
  if (typeof value === 'string') return value;
  return '';
}

function updateStringListField(tool: ToolDefinitionRecord, field: ToolConfigFieldRecord, value: string): void {
  if (editsBlocked.value) return;
  const config = sanitizeConfigForTool(tool, {
    ...localConfigForTool(tool),
    [field.key]: value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean)
  });
  const nextConfigs = cloneToolConfigs();
  nextConfigs[toolConfigKey(tool)] = { ...(nextConfigs[toolConfigKey(tool)] ?? {}), config };
  store.setPolicyForScope(props.scopeKind, props.scopeId, localAllowedTools(), localPolicyName(), nextConfigs, cloneSourceConfigs());
}

function updateScalarField(tool: ToolDefinitionRecord, field: ToolConfigFieldRecord, value: ToolConfigValue): void {
  if (editsBlocked.value) return;
  const config = sanitizeConfigForTool(tool, { ...localConfigForTool(tool), [field.key]: value });
  const nextConfigs = cloneToolConfigs();
  nextConfigs[toolConfigKey(tool)] = { ...(nextConfigs[toolConfigKey(tool)] ?? {}), config };
  store.setPolicyForScope(props.scopeKind, props.scopeId, localAllowedTools(), localPolicyName(), nextConfigs, cloneSourceConfigs());
}

type ToolGateSettingKey = 'autoApproveExecution' | 'autoApplyChange' | 'autoSubmitResult';

function updateGateSetting(tool: ToolDefinitionRecord, key: ToolGateSettingKey, value: boolean): void {
  if (editsBlocked.value) return;
  const nextConfigs = cloneToolConfigs();
  nextConfigs[toolConfigKey(tool)] = {
    ...(nextConfigs[toolConfigKey(tool)] ?? { config: {} }),
    [key]: value
  };
  store.setPolicyForScope(props.scopeKind, props.scopeId, localAllowedTools(), localPolicyName(), nextConfigs, cloneSourceConfigs());
}

function toolGateValue(tool: ToolDefinitionRecord, key: ToolGateSettingKey): boolean {
  const configValue = effectivePolicy.value?.toolConfigs?.[toolConfigKey(tool)]?.[key];
  if (configValue !== undefined) return configValue;
  if (key === 'autoApproveExecution') return tool.metadata?.defaultAutoApproveExecution ?? true;
  if (key === 'autoApplyChange') return tool.metadata?.defaultAutoApplyChange ?? true;
  return tool.metadata?.defaultAutoSubmitResult ?? true;
}

/** 原生异步与执行审批、结果回传、调度预设相互独立；只有显式开启才生效。 */
function nativeAsyncValue(tool: ToolDefinitionRecord): boolean {
  return effectivePolicy.value?.toolConfigs?.[toolConfigKey(tool)]?.nativeAsync === true;
}

function updateNativeAsync(tool: ToolDefinitionRecord, value: boolean): void {
  if (editsBlocked.value) return;
  const nextConfigs = cloneToolConfigs();
  nextConfigs[toolConfigKey(tool)] = {
    ...(nextConfigs[toolConfigKey(tool)] ?? { config: {} }),
    nativeAsync: value
  };
  store.setPolicyForScope(props.scopeKind, props.scopeId, localAllowedTools(), localPolicyName(), nextConfigs, cloneSourceConfigs());
}

function supportsChangeApply(tool: ToolDefinitionRecord): boolean {
  return tool.metadata?.supportsChangeApply === true;
}

function supportsDiffPreview(tool: ToolDefinitionRecord): boolean {
  return tool.metadata?.supportsDiffPreview === true;
}

function updateAutoApplyChangeDelay(tool: ToolDefinitionRecord, value: number): void {
  if (editsBlocked.value || !supportsChangeApply(tool)) return;
  const nextConfigs = cloneToolConfigs();
  nextConfigs[toolConfigKey(tool)] = {
    ...(nextConfigs[toolConfigKey(tool)] ?? { config: {} }),
    autoApplyChangeDelaySeconds: Math.min(600, Math.max(0, Math.floor(value)))
  };
  store.setPolicyForScope(props.scopeKind, props.scopeId, localAllowedTools(), localPolicyName(), nextConfigs, cloneSourceConfigs());
}

function autoApplyChangeDelayValue(tool: ToolDefinitionRecord): number {
  const value = effectivePolicy.value?.toolConfigs?.[toolConfigKey(tool)]?.autoApplyChangeDelaySeconds;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.min(600, Math.max(0, Math.floor(value)));
  const defaultValue = tool.metadata?.defaultAutoApplyChangeDelaySeconds;
  return typeof defaultValue === 'number' && Number.isFinite(defaultValue)
    ? Math.min(600, Math.max(0, Math.floor(defaultValue)))
    : 3;
}

function updateDisplayAutoExpand(tool: ToolDefinitionRecord, value: boolean): void {
  if (editsBlocked.value) return;
  const nextConfigs = cloneToolConfigs();
  nextConfigs[toolConfigKey(tool)] = {
    ...(nextConfigs[toolConfigKey(tool)] ?? { config: {} }),
    display: { ...(nextConfigs[toolConfigKey(tool)]?.display ?? {}), autoExpand: value }
  };
  store.setPolicyForScope(props.scopeKind, props.scopeId, localAllowedTools(), localPolicyName(), nextConfigs, cloneSourceConfigs());
}

function displayAutoExpandValue(tool: ToolDefinitionRecord): boolean {
  const display = effectivePolicy.value?.toolConfigs?.[toolConfigKey(tool)]?.display;
  if (display?.autoExpand !== undefined) return display.autoExpand;
  return tool.metadata?.defaultAutoExpand === true;
}

function updateDisplayAutoOpenDiffPreview(tool: ToolDefinitionRecord, value: boolean): void {
  if (editsBlocked.value || !supportsDiffPreview(tool)) return;
  const nextConfigs = cloneToolConfigs();
  nextConfigs[toolConfigKey(tool)] = {
    ...(nextConfigs[toolConfigKey(tool)] ?? { config: {} }),
    display: { ...(nextConfigs[toolConfigKey(tool)]?.display ?? {}), autoOpenDiffPreview: value }
  };
  store.setPolicyForScope(props.scopeKind, props.scopeId, localAllowedTools(), localPolicyName(), nextConfigs, cloneSourceConfigs());
}

function displayAutoOpenDiffPreviewValue(tool: ToolDefinitionRecord): boolean {
  if (!supportsDiffPreview(tool)) return false;
  const display = effectivePolicy.value?.toolConfigs?.[toolConfigKey(tool)]?.display;
  if (display?.autoOpenDiffPreview !== undefined) return display.autoOpenDiffPreview;
  return tool.metadata?.defaultAutoOpenDiffPreview === true;
}

function sanitizeConfigForTool(tool: ToolDefinitionRecord, config: ToolConfigRecord): ToolConfigRecord {
  const allowedKeys = new Set((tool.configSchema?.fields ?? []).map((field) => field.key));
  if (allowedKeys.size === 0) return {};
  const result: ToolConfigRecord = {};
  for (const [key, value] of Object.entries(config)) {
    if (allowedKeys.has(key)) result[key] = value;
  }
  return result;
}

function supportsInlineField(field: ToolConfigFieldRecord): boolean {
  return field.type === 'stringList' || field.type === 'globList' || field.type === 'string' || field.type === 'number' || field.type === 'boolean' || field.type === 'enum';
}

function inlineFields(tool: ToolDefinitionRecord): ToolConfigFieldRecord[] {
  return (tool.configSchema?.fields ?? []).filter((field) => supportsInlineField(field)
    && !(tool.name === SUB_AGENT_TOOL_NAME && (field.key === CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY
      || AGENT_COLLABORATION_CONFIG_KEYS.some((key) => key === field.key))));
}

function enumOptions(field: ToolConfigFieldRecord): SettingsDropdownOption[] {
  return (field.options ?? []).map((option) => ({ value: String(option.value), label: option.label, description: option.description }));
}

function enumValue(tool: ToolDefinitionRecord, field: ToolConfigFieldRecord): string {
  const value = configForTool(tool)[field.key] ?? field.defaultValue ?? field.options?.[0]?.value ?? '';
  return String(value);
}

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
}

function inputNumber(event: Event): number {
  const value = Number((event.target as HTMLInputElement).value);
  return Number.isFinite(value) ? value : 0;
}

</script>

<template>
  <section class="tool-policy-editor" :aria-label="title">
    <header class="tool-policy-header">
      <div class="tool-policy-title-block">
        <h3>
          {{ title }}
          <SettingsLoadingInline :show="toolLoading" :text="toolLoadingText" />
        </h3>
        <p v-if="description">{{ description }}</p>
      </div>
      <div class="tool-policy-summary" aria-live="polite">
        <span>{{ sourceLabel }}</span>
        <span>{{ enabledCount }} / {{ tools.length }} 已启用</span>
        <span v-if="selectedToolScope !== 'all'">当前显示 {{ visibleEnabledCount }} / {{ visibleTools.length }} 已启用</span>
      </div>
    </header>

    <p v-if="listError" class="tool-policy-error" role="alert">{{ listError.text }}</p>

    <section v-if="interactionApprovalTools.length > 0" class="tool-policy-preset-section interaction-auto-approval" aria-label="无人值守审批">
      <div class="tool-policy-preset-heading">
        <span>无人值守审批 · Ask / Plan</span>
        <small>默认关闭。开启后允许 LLM 无人值守地继续任务，请按需分别启用。</small>
      </div>
      <div class="interaction-auto-approval-options">
        <LcCheckbox
          v-for="{ tool, field } in interactionApprovalTools"
          :key="tool.name"
          :model-value="configForTool(tool)[field.key] === true"
          :disabled="editsBlocked"
          :aria-label="field.label"
          @update:model-value="updateScalarField(tool, field, $event)"
        >
          <span class="preset-card-copy">
            <strong>{{ field.label }}</strong>
            <small>{{ field.description }}</small>
          </span>
        </LcCheckbox>
      </div>
      <p class="interaction-auto-approval-hint">对后续新回合生效，已经等待的问题或计划请手动处理一次。不会启用被禁用的工具，也不改变命令执行、文件修改等其它审批设置。</p>
    </section>

    <section class="tool-policy-preset-section" aria-label="工具策略预设">
      <div class="tool-policy-preset-heading">
        <span>工具策略预设</span>
        <small>预设只改变工具的执行方式，不会覆盖下方已有的逐工具配置；非全局层级可选择继承全局预设。</small>
      </div>
      <div class="tool-policy-preset-options" role="radiogroup" aria-label="选择工具策略预设">
        <button
          v-for="option in presetOptions"
          :key="option.value"
          type="button"
          role="radio"
          class="tool-policy-preset-card"
          :class="{ 'is-selected': selectedPreset === option.value }"
          :aria-checked="selectedPreset === option.value"
          :disabled="editsBlocked"
          @click="updatePolicyPreset(option.value)"
        >
          <span class="preset-card-indicator" aria-hidden="true"></span>
          <span class="preset-card-copy">
            <strong>{{ option.label }}</strong>
            <small>{{ option.description }}</small>
          </span>
        </button>
      </div>
    </section>

    <div class="tool-policy-actions">
      <div class="tool-policy-filter">
        <span>工具分类</span>
        <SettingsDropdown
          :model-value="selectedToolScope"
          :options="toolScopeOptions"
          title="筛选工具分类"
          @update:model-value="updateSelectedToolScope"
        />
      </div>
      <button type="button" :disabled="listEditsBlocked || tools.length === 0" @click="enableAll">启用全部</button>
      <button type="button" class="secondary" :disabled="listEditsBlocked || tools.length === 0" @click="disableAll">禁用全部</button>
      <button v-if="canRestoreDefault || isUsingToolDefaults" type="button" class="secondary" :disabled="!canRestoreDefault" @click="inheritDefaults">继承默认</button>
      <button v-else type="button" class="secondary" :disabled="!canRestoreInheritance" @click="restoreInheritance">恢复继承</button>
    </div>

    <p v-if="switchGrantedToolNames.length > 0" class="tool-policy-note">{{ switchGrantedToolNames.join('、') }} 由{{ collaborationArea }}里的「跨对话协作」开关控制，不受这里的工具开关和工具列表影响。</p>
    <p v-if="firstListExtras.length > 0" class="tool-policy-note">这里还没有单独保存工具列表。第一次改下方的工具开关会保存一份列表，并带上内置 Agent 列表里的 {{ firstListExtras.join('、') }}，以免这些 Agent 失去它们；没有自己列表的自定义 Agent 也会因此得到 {{ firstListExtras.join('、') }}。工作环境相关工具仍受工作环境策略限制，默认关闭。</p>

    <section v-if="mcpSourceGroups.length > 0" class="mcp-source-section" aria-label="MCP 工具来源">
      <div class="mcp-source-heading">
        <span>MCP 服务</span>
        <small>勾选服务会开启它的全部工具（包括以后新增的工具，单独停用的除外）；只勾选单个工具时只开启这些工具，服务以后新增的工具不会自动开启。关闭服务会停用它的全部工具；展开单个工具后仍可调整执行确认与显示。</small>
        <small v-if="mcpSourcesDeniedHere">内置只读 Agent 和工作流默认不使用 MCP 工具，其它范围开启的服务不会带到这里；需要时在这里单独开启对应服务。</small>
        <small v-if="mcpDenyingBuiltinsAbove.length > 0">此对话使用的内置只读{{ mcpDenyingBuiltinsAbove.join('和') }}不使用其它范围开启的 MCP 服务，在这里开启不会生效；需要时到该 Agent 或工作流的工具设置里开启对应服务。</small>
        <small v-else-if="mcpSourceGroups.some((group) => isMcpSourceBlockedAbove(group.source.id) || group.tools.some(isMcpToolBlockedAbove))">不可勾选的服务或工具已被上层关闭，在这里开启不会生效。</small>
      </div>
      <div class="mcp-source-list">
        <article v-for="group in mcpSourceGroups" :key="group.source.id" class="mcp-source-item">
          <div class="mcp-source-row">
            <LcCheckbox
              class="mcp-source-toggle"
              :model-value="isMcpSourceEnabled(group.source.id)"
              :aria-label="`MCP 服务 ${group.source.name}`"
              :disabled="editsBlocked || group.source.status !== 'connected' || group.tools.length === 0 || isMcpSourceBlockedAbove(group.source.id)"
              @update:model-value="toggleMcpSource(group.source.id, $event)"
            >
              <span class="mcp-source-copy">
                <span class="mcp-source-name">{{ group.source.name }}</span>
                <span class="mcp-source-meta">{{ group.source.transportKind }} · {{ group.source.status }} · {{ group.source.toolCount }} 个工具</span>
              </span>
            </LcCheckbox>
          </div>
          <p v-if="group.source.lastError" class="mcp-source-error">{{ group.source.lastError }}</p>
          <div v-if="group.tools.length > 0" class="mcp-source-tools">
            <LcCheckbox
              v-for="tool in group.tools"
              :key="tool.name"
              class="mcp-tool-chip"
              :model-value="isToolEnabled(tool)"
              :disabled="listEditsBlocked || !isMcpSourceEnabled(group.source.id) || isMcpToolBlockedAbove(tool)"
              @update:model-value="toggleMcpSourceTool(tool, $event)"
            >
              <span>{{ tool.source?.originalToolName ?? tool.name }}</span>
            </LcCheckbox>
          </div>
        </article>
      </div>
    </section>

    <div class="tool-list-shell">
      <div ref="scroller" class="tool-list-scroll">
        <div v-if="tools.length === 0" class="tool-list-empty">正在加载工具定义…</div>
        <div v-else-if="visibleTools.length === 0" class="tool-list-empty">当前分类没有可配置的工具。</div>
        <template v-else>
          <article v-for="tool in visibleTools" :key="tool.name" class="tool-item" :class="{ 'is-enabled': isToolEnabled(tool) }">
            <div class="tool-item-header">
              <div class="tool-enable-cell">
                <LcCheckbox
                  class="tool-enable-toggle"
                  size="sm"
                  :model-value="isToolEnabled(tool)"
                  :disabled="listEditsBlocked || isMcpToolBlockedAbove(tool) || isSwitchGranted(tool)"
                  :aria-label="isSwitchGranted(tool) ? `工具 ${tool.name} 由跨对话协作开关控制` : `${isToolEnabled(tool) ? '禁用' : '启用'}工具 ${tool.name}`"
                  @update:model-value="setToolEnabled(tool, $event)"
                />
              </div>

              <button
                type="button"
                class="tool-config-header"
                :aria-expanded="isToolConfigExpanded(tool.name)"
                :aria-controls="`tool-config-${tool.name}`"
                @click="toggleToolConfig(tool.name)"
              >
                <span class="tool-icon" aria-hidden="true">
                  <component :is="toolIcon(tool)" :stroke="2" />
                </span>
                <span class="tool-main">
                  <span class="tool-name-row">
                    <span class="tool-name">{{ tool.name }}</span>
                    <span class="tool-pill">{{ scopeLabel(toolScope(tool)) }}</span>
                    <span class="tool-pill">{{ executionLabel(tool) }}</span>
                    <span class="tool-pill">{{ riskLabel(tool) }}</span>
                    <span v-if="isSwitchGranted(tool)" class="tool-pill">跨对话协作开关</span>
                  </span>
                </span>
                <span class="tool-config-toggle">
                  <span>{{ isToolConfigExpanded(tool.name) ? '收起' : '配置' }}</span>
                  <span class="tool-config-toggle-caret" :class="{ 'is-expanded': isToolConfigExpanded(tool.name) }" aria-hidden="true"></span>
                </span>
              </button>
            </div>

            <div
              :id="`tool-config-${tool.name}`"
              class="tool-config-collapse"
              :class="{ 'is-expanded': isToolConfigExpanded(tool.name) }"
            >
              <div class="tool-config-collapse-frame">
                <div class="tool-config-panel">
                  <div class="tool-config-group tool-definition-details">
                    <div class="tool-config-group-heading">
                      <span class="tool-config-group-title">工具说明</span>
                      <small>由工具定义提供，展开后查看完整说明。</small>
                    </div>
                    <p class="tool-definition-description">{{ toolDescription(tool) }}</p>
                    <p v-if="tool.name === SUB_AGENT_TOOL_NAME" class="tool-definition-mode-note">子 Agent 深度、团队预算和跨对话协作开关已移至{{ collaborationArea }}。</p>
                    <p v-if="isSwitchGranted(tool)" class="tool-definition-mode-note">此工具由{{ collaborationArea }}里的「跨对话协作」开关提供：开关开启时提供（工具列表不含 run_agent 时只提供列出和读取对话），这里不能单独启用或停用；可以在下方改为执行前确认。</p>
                    <p v-if="editModeShortLabel(tool)" class="tool-definition-mode-note">{{ editModeShortLabel(tool) }}</p>
                  </div>

                  <template v-if="isToolEnabled(tool) || isSwitchGranted(tool)">
                    <div class="tool-config-group tool-config-permissions">
                      <div class="tool-config-group-heading">
                        <span class="tool-config-group-title">权限与显示</span>
                        <small>控制执行确认、结果回传，以及聊天区工具卡片的默认展示行为。</small>
                      </div>
                      <div class="tool-permission-options">
                        <LcCheckbox
                          class="tool-permission-card"
                          :class="{ 'is-enabled': toolGateValue(tool, 'autoApproveExecution') }"
                          :model-value="toolGateValue(tool, 'autoApproveExecution')"
                          :disabled="editsBlocked"
                          @update:model-value="updateGateSetting(tool, 'autoApproveExecution', $event)"
                        >
                          <span class="permission-copy">
                            <span class="permission-title">自动批准执行</span>
                            <span class="permission-desc">开启时工具请求会直接进入执行；关闭时先询问用户。</span>
                          </span>
                        </LcCheckbox>
                        <LcCheckbox
                          v-if="supportsChangeApply(tool)"
                          class="tool-permission-card"
                          :class="{ 'is-enabled': toolGateValue(tool, 'autoApplyChange') }"
                          :model-value="toolGateValue(tool, 'autoApplyChange')"
                          :disabled="editsBlocked"
                          @update:model-value="updateGateSetting(tool, 'autoApplyChange', $event)"
                        >
                          <span class="permission-copy">
                            <span class="permission-title">自动应用更改</span>
                            <span class="permission-desc">开启后，工具进入待应用阶段时按下方延迟自动应用。</span>
                          </span>
                        </LcCheckbox>
                        <LcCheckbox
                          v-if="supportsDiffPreview(tool)"
                          class="tool-permission-card"
                          :class="{ 'is-enabled': displayAutoOpenDiffPreviewValue(tool) }"
                          :model-value="displayAutoOpenDiffPreviewValue(tool)"
                          :disabled="editsBlocked"
                          @update:model-value="updateDisplayAutoOpenDiffPreview(tool, $event)"
                        >
                          <span class="permission-copy">
                            <span class="permission-title">自动打开差异预览</span>
                            <span class="permission-desc">工具生成可预览的修改提案时，自动触发聊天卡片里的“查看差异”。</span>
                          </span>
                        </LcCheckbox>
                        <LcCheckbox
                          class="tool-permission-card"
                          :class="{ 'is-enabled': toolGateValue(tool, 'autoSubmitResult') }"
                          :model-value="toolGateValue(tool, 'autoSubmitResult')"
                          :disabled="editsBlocked"
                          @update:model-value="updateGateSetting(tool, 'autoSubmitResult', $event)"
                        >
                          <span class="permission-copy">
                            <span class="permission-title">自动回传结果</span>
                            <span class="permission-desc">开启时工具结果自动发送给 LLM；关闭时先询问是否发送。</span>
                          </span>
                        </LcCheckbox>
                        <LcCheckbox
                          class="tool-permission-card"
                          :class="{ 'is-enabled': nativeAsyncValue(tool) }"
                          :model-value="nativeAsyncValue(tool)"
                          :disabled="editsBlocked"
                          @update:model-value="updateNativeAsync(tool, $event)"
                        >
                          <span class="permission-copy">
                            <span class="permission-title">原生异步执行</span>
                            <span class="permission-desc">仅在 Astra 原生渠道开启「原生异步工具」后生效：该工具可异步执行，结果稍后按原始调用回传；不改变上方的执行审批与调度设置。</span>
                          </span>
                        </LcCheckbox>
                        <LcCheckbox
                          class="tool-permission-card"
                          :class="{ 'is-enabled': displayAutoExpandValue(tool) }"
                          :model-value="displayAutoExpandValue(tool)"
                          :disabled="editsBlocked"
                          @update:model-value="updateDisplayAutoExpand(tool, $event)"
                        >
                          <span class="permission-copy">
                            <span class="permission-title">自动展开内容</span>
                            <span class="permission-desc">开启时聊天里的该工具调用会默认展开内容面板；用户仍可手动收起。</span>
                          </span>
                        </LcCheckbox>
                      </div>
                      <label
                        v-if="supportsChangeApply(tool) && toolGateValue(tool, 'autoApplyChange')"
                        class="tool-delay-field"
                      >
                        <span class="tool-delay-copy">
                          <span class="permission-title">自动应用延迟</span>
                          <span class="permission-desc">填 0 表示直接应用；默认 3 秒。</span>
                        </span>
                        <span class="tool-delay-input">
                          <input
                            type="number"
                            min="0"
                            max="600"
                            step="1"
                            :value="autoApplyChangeDelayValue(tool)"
                            :readonly="editsBlocked"
                            @change="updateAutoApplyChangeDelay(tool, inputNumber($event))"
                          />
                          <span>秒</span>
                        </span>
                      </label>
                    </div>

                  <div v-if="inlineFields(tool).length" class="tool-config-group tool-specific-config">
                    <div class="tool-config-group-heading">
                      <span class="tool-config-group-title">工具配置</span>
                      <small>这些配置由工具定义提供，并随当前层级的策略保存。</small>
                    </div>
                    <div class="tool-config-fields">
                      <label v-for="field in inlineFields(tool)" :key="field.key" class="tool-config-field">
                        <span>{{ field.label }}</span>
                        <textarea
                          v-if="field.type === 'stringList' || field.type === 'globList'"
                          :value="fieldListText(tool, field)"
                          :placeholder="field.placeholder"
                          :readonly="editsBlocked"
                          rows="3"
                          @change="updateStringListField(tool, field, inputValue($event))"
                        ></textarea>
                        <input
                          v-else-if="field.type === 'number'"
                          :value="configForTool(tool)[field.key] ?? field.defaultValue ?? 0"
                          :readonly="editsBlocked"
                          type="number"
                          @change="updateScalarField(tool, field, inputNumber($event))"
                        />
                        <LcCheckbox
                          v-else-if="field.type === 'boolean'"
                          class="tool-config-inline-checkbox"
                          :model-value="Boolean(configForTool(tool)[field.key] ?? field.defaultValue)"
                          :disabled="editsBlocked"
                          :aria-label="field.label"
                          @update:model-value="updateScalarField(tool, field, $event)"
                        />
                        <SettingsDropdown
                          v-else-if="field.type === 'enum'"
                          :model-value="enumValue(tool, field)"
                          :options="enumOptions(field)"
                          :title="field.label"
                          :disabled="editsBlocked"
                          @update:model-value="updateScalarField(tool, field, $event)"
                        />
                        <input
                          v-else
                          :value="String(configForTool(tool)[field.key] ?? field.defaultValue ?? '')"
                          :readonly="editsBlocked"
                          type="text"
                          @change="updateScalarField(tool, field, inputValue($event))"
                        />
                        <small v-if="field.description">{{ field.description }}</small>
                      </label>
                    </div>
                  </div>
                  </template>
                  <p v-else class="tool-config-disabled-note">
                    启用此工具后，可在这里配置执行权限和工具参数。
                  </p>

                </div>
              </div>
            </div>
          </article>
        </template>
      </div>
      <AdvancedScrollbar :scroller="scroller" variant="minimal" />
    </div>
  </section>
</template>

<style scoped>
.tool-policy-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.tool-policy-header {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: flex-start;
  flex-wrap: wrap;
}

.tool-policy-title-block h3 {
  margin: 0;
  font-size: var(--font-size-md);
}

.tool-policy-title-block p {
  margin: var(--space-1) 0 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}

.tool-policy-summary {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.tool-policy-summary span {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 2px var(--space-2);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.tool-policy-preset-section {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
}

.tool-policy-preset-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tool-policy-preset-heading span {
  font-weight: 650;
}

.tool-policy-preset-heading small {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.45;
}

.tool-policy-preset-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

.interaction-auto-approval {
  border-inline-start: 3px solid var(--vscode-descriptionForeground);
}

.interaction-auto-approval-options {
  display: grid;
  gap: var(--space-3);
  padding-block: var(--space-1);
}

.tool-policy-error {
  margin: 0;
  border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  color: var(--vscode-errorForeground);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}

.interaction-auto-approval-hint,
.tool-policy-note {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

.tool-policy-preset-card {
  min-width: 0;
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 88%, transparent);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: flex-start;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font: inherit;
  text-align: left;
}

.tool-policy-preset-card:hover:not(:disabled),
.tool-policy-preset-card:focus-visible {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.tool-policy-preset-card.is-selected {
  border-color: color-mix(in srgb, var(--vscode-panel-border) 60%, var(--vscode-foreground) 40%);
  background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-foreground) 10%);
}

.preset-card-indicator {
  width: 10px;
  height: 10px;
  margin-top: 4px;
  border: 1px solid var(--vscode-descriptionForeground);
  border-radius: 50%;
}

.tool-policy-preset-card.is-selected .preset-card-indicator {
  border-color: var(--vscode-foreground);
  background: var(--vscode-foreground);
}

.preset-card-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.preset-card-copy small {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.45;
}

.tool-policy-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  align-items: center;
}

.tool-policy-filter {
  min-width: 220px;
  display: grid;
  grid-template-columns: auto minmax(150px, 1fr);
  gap: var(--space-2);
  align-items: center;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.tool-policy-filter :deep(.settings-dropdown) {
  min-width: 150px;
}

.tool-policy-actions button {
  min-height: 28px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-2);
  color: var(--vscode-foreground);
  background: transparent;
  font: inherit;
}

.tool-policy-actions button:hover:not(:disabled),
.tool-policy-actions button:focus-visible {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.tool-policy-actions button:disabled {
  opacity: 0.45;
}

.mcp-source-section {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
}

.mcp-source-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mcp-source-heading span {
  font-weight: 650;
}

.mcp-source-heading small,
.mcp-source-meta,
.mcp-source-error {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.4;
}

.mcp-source-list {
  display: grid;
  gap: var(--space-2);
}

.mcp-source-item {
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 88%, transparent);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  background: transparent;
}

.mcp-source-toggle {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: flex-start;
}

.mcp-source-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mcp-source-name {
  font-weight: 600;
}

.mcp-source-error {
  margin: 0;
  color: var(--vscode-errorForeground);
}

.mcp-source-tools {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.mcp-tool-chip {
  min-height: 24px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 2px var(--space-2);
  display: inline-grid;
  grid-template-columns: 14px auto;
  gap: var(--space-1);
  align-items: center;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font-size: var(--font-size-xs);
}

.mcp-tool-chip:hover:not(:disabled),
.mcp-tool-chip:focus-visible {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
}

.tool-list-shell {
  position: relative;
  min-height: 220px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
}

.tool-list-scroll {
  max-height: 520px;
  overflow-y: auto;
  scrollbar-width: none;
}

.tool-list-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.tool-list-empty {
  padding: var(--space-3);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.tool-item {
  border-bottom: 1px solid var(--vscode-panel-border);
  background: transparent;
}

.tool-item:last-child {
  border-bottom: 0;
}

.tool-item.is-enabled {
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
}

.tool-item-header {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  align-items: stretch;
  min-height: 56px;
}

.tool-enable-cell {
  min-height: 56px;
  border-right: 1px solid var(--vscode-panel-border);
  display: flex;
  align-items: stretch;
  justify-content: stretch;
}

.tool-enable-cell :deep(.tool-enable-toggle.lc-checkbox-control) {
  width: 100%;
  min-height: 56px;
  border-radius: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.tool-enable-cell :deep(.tool-enable-toggle.lc-checkbox-control:not(:disabled):not(.is-readonly):hover),
.tool-enable-cell :deep(.tool-enable-toggle.lc-checkbox-control:focus-visible) {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  outline: none;
}

.tool-enable-cell :deep(.tool-enable-toggle.lc-checkbox-control:focus-visible) {
  box-shadow: inset 0 0 0 1px var(--vscode-focusBorder, var(--vscode-descriptionForeground));
}

.tool-enable-toggle :deep(.lc-checkbox-box) {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border-color: var(--vscode-descriptionForeground);
  background: transparent;
}

.tool-enable-toggle :deep(.lc-checkbox-icon) {
  display: none;
}

.tool-enable-toggle.is-checked :deep(.lc-checkbox-box) {
  border-color: var(--vscode-foreground);
  background: var(--vscode-foreground);
}

.tool-config-header {
  width: 100%;
  min-width: 0;
  min-height: 56px;
  border: 0;
  border-radius: 0;
  padding: 0;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  gap: var(--space-2);
  align-items: stretch;
  color: var(--vscode-foreground);
  background: transparent;
  text-align: left;
  font: inherit;
  appearance: none;
  -webkit-appearance: none;
}

.tool-config-header:hover,
.tool-config-header:focus-visible,
.tool-config-header:active {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.tool-config-header:focus-visible {
  box-shadow: inset 0 0 0 1px var(--vscode-focusBorder, var(--vscode-descriptionForeground));
}

.tool-config-toggle {
  min-width: 72px;
  min-height: 0;
  border-left: 1px solid var(--vscode-panel-border);
  padding: 0 var(--space-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  color: var(--vscode-descriptionForeground);
  font: inherit;
}

.tool-config-header:hover .tool-config-toggle,
.tool-config-header:focus-visible .tool-config-toggle,
.tool-config-header:active .tool-config-toggle {
  color: var(--vscode-foreground);
}

.tool-config-toggle-caret {
  width: 7px;
  height: 7px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: translateY(-1px) rotate(45deg);
  transition: transform 0.18s ease;
}

.tool-config-toggle-caret.is-expanded {
  transform: translateY(1px) rotate(225deg);
}

.tool-config-collapse {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  background: transparent;
  transition: grid-template-rows 0.22s ease, opacity 0.16s ease;
}

.tool-config-collapse.is-expanded {
  border-top: 1px solid var(--vscode-input-border, var(--vscode-descriptionForeground));
  grid-template-rows: 1fr;
  opacity: 1;
  background: transparent;
}

.tool-config-collapse-frame {
  min-height: 0;
  overflow: hidden;
}

.tool-config-collapse.is-expanded,
.tool-config-collapse.is-expanded .tool-config-collapse-frame,
.tool-config-collapse.is-expanded .tool-config-panel,
.tool-config-collapse.is-expanded .tool-specific-config,
.tool-config-collapse.is-expanded .tool-config-fields,
.tool-config-collapse.is-expanded .tool-config-field {
  overflow: visible;
}

.tool-config-collapse.is-expanded .tool-config-field {
  position: relative;
  z-index: 3;
}

.tool-icon {
  width: 24px;
  height: 24px;
  margin-left: var(--space-3);
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  align-self: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
}

.tool-icon svg {
  width: 16px;
  height: 16px;
}

.tool-item.is-enabled .tool-icon {
  color: var(--vscode-foreground);
}

.tool-main {
  min-width: 0;
  padding: var(--space-2) 0;
  display: flex;
  flex-direction: column;
  align-self: center;
  gap: 4px;
}

.tool-name-row {
  min-width: 0;
  display: flex;
  gap: var(--space-1);
  align-items: center;
  flex-wrap: wrap;
}

.tool-name {
  font-family: var(--vscode-editor-font-family, monospace);
  font-weight: 600;
}

.tool-pill {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 1px var(--space-1);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}


.tool-config-group {
  min-width: 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  background: color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-foreground) 3%);
}

.tool-config-group-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tool-config-group-title {
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.tool-config-group-heading small {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.4;
}

.tool-definition-description,
.tool-definition-mode-note,
.tool-config-disabled-note {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  line-height: 1.55;
}

.tool-definition-mode-note {
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
  font-size: var(--font-size-xs);
}

.tool-config-disabled-note {
  border: 1px dashed var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  background: color-mix(in srgb, var(--vscode-editor-background) 98%, var(--vscode-foreground) 2%);
}


.tool-permission-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

.tool-permission-card {

  min-width: 0;
  min-height: 62px;
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 88%, transparent);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: flex-start;
  background: var(--vscode-editor-background);
  color: inherit;
  appearance: none;
  -webkit-appearance: none;
}

.tool-permission-card.is-enabled {
  border-color: color-mix(in srgb, var(--vscode-panel-border) 70%, var(--vscode-foreground) 30%);
  background: color-mix(in srgb, var(--vscode-editor-background) 91%, var(--vscode-foreground) 9%);
}

.tool-permission-card:hover:not(:disabled),
.tool-permission-card:focus-visible,
.tool-permission-card:active:not(:disabled) {
  color: inherit;
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%)) !important;
}

.tool-permission-card.is-enabled:hover:not(:disabled),
.tool-permission-card.is-enabled:focus-visible,
.tool-permission-card.is-enabled:active:not(:disabled) {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%)) !important;
}

.tool-permission-card:focus-visible {
  outline: 1px solid var(--vscode-panel-border);
  outline-offset: 2px;
}

.tool-permission-card :deep(.lc-checkbox-box) {
  margin-top: 2px;
}

.tool-config-inline-checkbox {
  width: max-content;
}

.permission-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.permission-title {
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.permission-desc {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.4;
}

.tool-delay-field {
  margin-top: var(--space-2);
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 88%, transparent);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-2);
  align-items: center;
  background: var(--vscode-editor-background);
}

.tool-delay-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tool-delay-input {
  min-width: max-content;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.tool-delay-input input {
  width: 64px;
  min-height: 28px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  padding: 0 var(--space-2);
  color: var(--vscode-input-foreground, var(--vscode-foreground));
  background: var(--vscode-input-background, var(--vscode-editor-background));
  font: inherit;
  font-variant-numeric: tabular-nums;
  appearance: textfield;
  -moz-appearance: textfield;
}

.tool-delay-input input::-webkit-outer-spin-button,
.tool-delay-input input::-webkit-inner-spin-button {
  margin: 0;
  appearance: none;
  -webkit-appearance: none;
}

.tool-delay-input input:focus {
  border-color: color-mix(in srgb, var(--vscode-panel-border) 70%, var(--vscode-foreground) 30%);
  outline: none;
}

.tool-config-checkbox {
  display: inline-flex;
  align-items: center;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-config-panel {
  padding: calc(var(--space-3) + 2px) var(--space-3) var(--space-3) calc(var(--space-3) + 60px);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  transform: translateY(-4px);
  transition: transform 0.18s ease;
}

.tool-config-collapse.is-expanded .tool-config-panel {
  transform: translateY(0);
}

.tool-config-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(220px, 1fr));
  gap: var(--space-4);
}

.tool-config-field {
  min-width: 0;
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 88%, transparent);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  background: var(--vscode-editor-background);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.tool-config-field > span {
  color: var(--vscode-foreground);
  font-weight: 600;
}

.tool-config-field textarea,
.tool-config-field input[type='text'],
.tool-config-field input[type='number'] {
  width: 100%;
  min-height: 30px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  font: inherit;
}

.tool-config-field textarea {
  resize: vertical;
  min-height: 72px;
  font-family: var(--vscode-editor-font-family, monospace);
}

.tool-config-field small {
  color: var(--vscode-descriptionForeground);
  line-height: 1.4;
}

@media (max-width: 720px) {
  .tool-policy-preset-options {
    grid-template-columns: 1fr;
  }

  .tool-permission-options,
  .tool-config-fields {
    grid-template-columns: 1fr;
  }

  .tool-config-panel {
    padding-left: var(--space-3);
  }

  .tool-config-toggle {
    min-width: 64px;
    padding: 0 var(--space-2);
  }
}
</style>
