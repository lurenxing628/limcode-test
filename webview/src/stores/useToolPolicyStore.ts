import { defineStore } from 'pinia';
import type {
  BuiltinToolPolicyRecord,
  ToolConfigRecord,
  ToolConfigValue,
  ToolDefinitionRecord,
  ToolPolicyRecord,
  ToolPolicySourceConfigRecord,
  ToolPolicyPresetKind,
  ToolPolicyScopeKind,
  ToolPolicyScopeLinkRecord,
  ToolPolicyScopeSetPayload,
  ToolPolicyToolConfigRecord
} from '@shared/protocol';
import { CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY, CROSS_CONVERSATION_TOOL_NAMES, READONLY_CROSS_CONVERSATION_TOOL_NAMES, TOOL_POLICY_ALL_MCP_SOURCES } from '@shared/protocol';
import {
  crossConversationSwitchOn,
  crossConversationToolPermitted,
  defaultToolNames,
  isSwitchGrantedTool,
  mcpSourceConfigFor,
  mcpToolIdentity,
  resolveToolPolicyLayers,
  toolAllowedByPolicy,
  toolPolicyScopeLayer,
  type ToolPolicyLayer
} from '@shared/toolPolicyResolution';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';
import { useReliableKernelClientFeedStore } from './useReliableKernelClientFeedStore';
import { DEFAULT_WORKFLOW_OPTION_ID, useWorkflowStore } from './useWorkflowStore';

export const SUB_AGENT_TOOL_NAME = 'run_agent';
export const AGENT_COLLABORATION_CONFIG_KEYS = ['maxChildAgentDepth', 'maxConcurrentAgents', 'maxAutomaticFollowups'] as const;
export type AgentCollaborationConfigKey = typeof AGENT_COLLABORATION_CONFIG_KEYS[number];
export { CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY, CROSS_CONVERSATION_TOOL_NAMES, READONLY_CROSS_CONVERSATION_TOOL_NAMES };

export interface ToolPolicyResolution {
  policy?: ToolPolicyRecord;
  link?: ToolPolicyScopeLinkRecord;
  inheritedFrom?: ToolPolicyScopeKind;
}

/** A resolved view always has a concrete tool list, even when no layer saved one. */
export type EffectiveToolPolicyRecord = ToolPolicyRecord & { allowedTools: string[] };

export interface EffectiveToolPolicyResolution {
  policy: EffectiveToolPolicyRecord;
  link?: ToolPolicyScopeLinkRecord;
  inheritedFrom?: ToolPolicyScopeKind;
}

/** What the cross-conversation switch gives a scope, exactly as the backend decides it. */
export interface CrossConversationState {
  /** The switch as it applies here: this scope's value, else the nearest upper layer's, else off. */
  enabled: boolean;
  /** False when the scope's effective list lacks run_agent: the backend then offers only the read-type tools. */
  sendTools: boolean;
  /** The tools the backend offers here: all five with run_agent, list and read without it, none while off. */
  offered: string[];
}

interface ScopeRef {
  scopeKind: ToolPolicyScopeKind;
  scopeId?: string;
}

/** A stored tool list on a scope's chain that the backend refuses to compile. */
export interface ToolListError {
  scopeKind: ToolPolicyScopeKind;
  scopeId?: string;
  /** True when the invalid list is the scope's own record, which only a reset can repair. */
  own: boolean;
  /** Chinese text for the settings page: what is wrong and where to reset it. */
  text: string;
}

const INVALID_OWN_LIST = '此范围保存的工具列表无效，请先重置此范围的工具列表。';

function scopeIdFor(scopeKind: ToolPolicyScopeKind, scopeId?: string): string | undefined {
  return scopeKind === 'global' ? undefined : scopeId?.trim();
}

function scopeLinkMatches(link: ToolPolicyScopeLinkRecord, scopeKind: ToolPolicyScopeKind, scopeId?: string): boolean {
  return link.role === 'active' && link.scopeKind === scopeKind && scopeIdFor(scopeKind, link.scopeId) === scopeIdFor(scopeKind, scopeId);
}

function latestLink(links: ToolPolicyScopeLinkRecord[]): ToolPolicyScopeLinkRecord | undefined {
  return [...links].sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
}

function policyIdForScope(scopeKind: ToolPolicyScopeKind, scopeId?: string): string {
  return `tool-policy:${scopeKind}:${scopeIdFor(scopeKind, scopeId) ?? 'global'}`;
}

function linkIdForScope(scopeKind: ToolPolicyScopeKind, scopeId?: string): string {
  return `tool-policy-scope:${scopeKind}:${scopeIdFor(scopeKind, scopeId) ?? 'global'}`;
}

function defaultPolicyName(scopeKind: ToolPolicyScopeKind): string {
  switch (scopeKind) {
    case 'global': return '全局默认工具策略';
    case 'conversation': return '对话工具策略';
    case 'agent': return 'Agent 工具策略';
    case 'workflow': return '工作流工具策略';
    case 'run': return '运行工具策略';
  }
}

function cloneToolConfigs(toolConfigs: Record<string, ToolPolicyToolConfigRecord> | undefined): Record<string, ToolPolicyToolConfigRecord> | undefined {
  if (!toolConfigs) return undefined;
  const cloned: Record<string, ToolPolicyToolConfigRecord> = {};
  for (const [toolName, record] of Object.entries(toolConfigs)) {
    cloned[toolName] = {
      config: cloneToolConfigRecord(record.config),
      ...(typeof record.autoApproveExecution === 'boolean' ? { autoApproveExecution: record.autoApproveExecution } : {}),
      ...(typeof record.autoApplyChange === 'boolean' ? { autoApplyChange: record.autoApplyChange } : {}),
      ...(typeof record.autoApplyChangeDelaySeconds === 'number' ? { autoApplyChangeDelaySeconds: record.autoApplyChangeDelaySeconds } : {}),
      ...(typeof record.autoSubmitResult === 'boolean' ? { autoSubmitResult: record.autoSubmitResult } : {}),
      ...(typeof record.nativeAsync === 'boolean' ? { nativeAsync: record.nativeAsync } : {}),
      ...(record.display ? { display: { ...record.display } } : {})
    };
  }
  return cloned;
}

/**
 * Plain source settings for a save. A hand-edited entry that is not an object never applied to its
 * source and is dropped, except the all-sources key, which keeps its fail-closed deny.
 */
export function cloneSourceConfigs(sourceConfigs: Record<string, ToolPolicySourceConfigRecord> | undefined): Record<string, ToolPolicySourceConfigRecord> | undefined {
  if (!sourceConfigs) return undefined;
  const cloned: Record<string, ToolPolicySourceConfigRecord> = {};
  for (const [sourceId, record] of Object.entries(sourceConfigs)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      if (sourceId.trim() === TOOL_POLICY_ALL_MCP_SOURCES) cloned[sourceId] = { enabled: false };
      continue;
    }
    cloned[sourceId] = {
      enabled: record.enabled === true,
      ...(record.disabledTools?.length ? { disabledTools: [...record.disabledTools] } : {})
    };
  }
  return cloned;
}

function cloneToolConfigRecord(config: ToolConfigRecord | undefined): ToolConfigRecord {
  const cloned: ToolConfigRecord = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    const next = cloneToolConfigValue(value as ToolConfigValue | undefined);
    if (next !== undefined) cloned[key] = next;
  }
  return cloned;
}

function cloneToolConfigValue(value: ToolConfigValue | undefined): ToolConfigValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map((item) => cloneToolConfigValue(item as ToolConfigValue | undefined) ?? null) as ToolConfigValue;
  }
  if (typeof value === 'object') {
    const cloned: Record<string, ToolConfigValue> = {};
    for (const [key, child] of Object.entries(value as Record<string, ToolConfigValue | undefined>)) {
      const next = cloneToolConfigValue(child);
      if (next !== undefined) cloned[key] = next;
    }
    return cloned;
  }
  return undefined;
}

function uniqueNames(names: readonly string[]): string[] {
  return names.filter((name, index, list) => !!name && list.indexOf(name) === index);
}

function isEmptyRecord(value: object | undefined): boolean {
  return !value || Object.keys(value).length === 0;
}

function plainText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The Agent a Conversation runs with, from its loaded default AgentConversationLink. */
function agentIdForConversation(conversationId: string): string | undefined {
  const links = Object.values(useReliableKernelClientFeedStore().records.AgentConversationLink ?? {});
  const link = links.find((candidate) => plainText(candidate.conversation_id) === conversationId && plainText(candidate.role) === 'default')
    ?? links.find((candidate) => plainText(candidate.conversation_id) === conversationId);
  return plainText(link?.agent_id);
}

function upsertById<T extends { id: string }>(list: T[], record: T): void {
  const index = list.findIndex((candidate) => candidate.id === record.id);
  if (index >= 0) list[index] = record;
  else list.push(record);
}

export const useToolPolicyStore = defineStore('toolPolicy', {
  state: () => ({}),
  getters: {
    toolDefinitions(): ToolDefinitionRecord[] {
      const clientState = useClientStateStore();
      return [...clientState.toolDefinitions].sort((left, right) => left.name.localeCompare(right.name));
    },
    toolDefinitionByName(): Map<string, ToolDefinitionRecord> {
      const clientState = useClientStateStore();
      return new Map(clientState.toolDefinitions.map((tool) => [tool.name, tool]));
    }
  },
  actions: {
    setAgentCollaborationFieldForScope(scopeKind: ToolPolicyScopeKind, scopeId: string | undefined, key: AgentCollaborationConfigKey, value: number | undefined): void {
      if (!AGENT_COLLABORATION_CONFIG_KEYS.includes(key)) throw new TypeError('未知的 Agent 协作配置项。');
      const minimum = key === 'maxConcurrentAgents' ? 1 : 0;
      if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
        throw new TypeError(`Agent 协作配置必须是大于或等于 ${minimum} 的整数。`);
      }
      this.setRunAgentConfigValueForScope(scopeKind, scopeId, key, value);
    },
    /**
     * Stores the cross-conversation switch in this scope's run_agent config and nothing else. The
     * switch is the grant: the backend offers the five tools from the frozen switch (only listing
     * and reading while the effective list lacks run_agent), so no tool list changes.
     */
    setCrossConversationCollaborationForScope(scopeKind: ToolPolicyScopeKind, scopeId: string | undefined, value: boolean | undefined): void {
      if (value !== undefined && typeof value !== 'boolean') throw new TypeError('跨对话协作开关必须是布尔值。');
      this.setRunAgentConfigValueForScope(scopeKind, scopeId, CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY, value);
    },
    /**
     * Sets or removes one key of this scope's run_agent config (a collaboration limit or the
     * cross-conversation switch). It never freezes unrelated inherited tool configuration or a tool
     * list, and removing the last override drops a record left with nothing of its own.
     */
    setRunAgentConfigValueForScope(scopeKind: ToolPolicyScopeKind, scopeId: string | undefined, key: string, value: number | boolean | undefined): void {
      if (scopeKind !== 'global' && !scopeId?.trim()) return;
      const definition = this.toolDefinitions.find((tool) => tool.name === SUB_AGENT_TOOL_NAME);
      if (!definition?.configSchema?.fields.some((field) => field.key === key)) return;
      const local = this.localPolicyFor(scopeKind, scopeId).policy;
      if (value === undefined && local?.toolConfigs?.[SUB_AGENT_TOOL_NAME]?.config?.[key] === undefined) return;
      const ownList = this.ownListFor(scopeKind, scopeId);
      const configs = cloneToolConfigs(local?.toolConfigs) ?? {};
      const entry = configs[SUB_AGENT_TOOL_NAME] ?? { config: {} };
      if (value === undefined) delete entry.config[key];
      else entry.config[key] = value;
      if (Object.keys(entry.config).length === 0 && Object.keys(entry).length === 1) delete configs[SUB_AGENT_TOOL_NAME];
      else configs[SUB_AGENT_TOOL_NAME] = entry;
      this.saveOrDropLocalPolicy(scopeKind, scopeId, ownList, configs);
    },
    /**
     * Saves this scope's record with the given list and configs, keeping its name, preset and
     * source settings. A record left with nothing of its own is removed instead of kept empty.
     */
    saveOrDropLocalPolicy(
      scopeKind: ToolPolicyScopeKind,
      scopeId: string | undefined,
      allowedTools: string[] | undefined,
      toolConfigs: Record<string, ToolPolicyToolConfigRecord>
    ): void {
      const local = this.localPolicyFor(scopeKind, scopeId).policy;
      const ownPreset = local?.preset !== undefined && !(scopeKind !== 'global' && local.preset === 'inherit');
      if (!allowedTools && isEmptyRecord(toolConfigs) && isEmptyRecord(local?.sourceConfigs) && !ownPreset) {
        if (local) this.dropLocalPolicy(scopeKind, scopeId);
        return;
      }
      this.setPolicyForScope(scopeKind, scopeId, allowedTools, local?.name, toolConfigs, cloneSourceConfigs(local?.sourceConfigs), local?.preset);
    },
    /**
     * 恢复继承 in the tool settings of a non-global scope: drops this scope's tool list, per-tool
     * settings, MCP source settings and preset. What the Agent 协作 area sets here (the
     * cross-conversation switch and the collaboration limits) stays, since that area restores each
     * of them on its own. A record left with nothing else is removed.
     */
    restoreToolInheritance(scopeKind: ToolPolicyScopeKind, scopeId?: string): void {
      if (scopeKind === 'global') return;
      const local = this.localPolicyFor(scopeKind, scopeId).policy;
      if (!local) return;
      const collaboration: ToolConfigRecord = {};
      const saved = cloneToolConfigRecord(local.toolConfigs?.[SUB_AGENT_TOOL_NAME]?.config);
      for (const key of [...AGENT_COLLABORATION_CONFIG_KEYS, CROSS_CONVERSATION_COLLABORATION_CONFIG_KEY]) {
        if (saved[key] !== undefined) collaboration[key] = saved[key];
      }
      if (Object.keys(collaboration).length === 0) {
        this.dropLocalPolicy(scopeKind, scopeId);
        return;
      }
      this.setPolicyForScope(scopeKind, scopeId, undefined, local.name, { [SUB_AGENT_TOOL_NAME]: { config: collaboration } }, {}, 'inherit');
    },
    localPolicyFor(scopeKind: ToolPolicyScopeKind, scopeId?: string): ToolPolicyResolution {
      const clientState = useClientStateStore();
      const link = latestLink(clientState.toolPolicyScopeLinks.filter((candidate) => scopeLinkMatches(candidate, scopeKind, scopeId)));
      const policy = clientState.toolPolicies.find((candidate) => candidate.id === link?.toolPolicyId);
      return { ...(policy ? { policy } : {}), ...(link ? { link } : {}) };
    },
    /**
     * This scope's own saved list, for edits that keep it. A stored value the backend refuses to
     * compile is never rewritten by such an edit: it throws until the record is reset.
     */
    ownListFor(scopeKind: ToolPolicyScopeKind, scopeId?: string): string[] | undefined {
      const saved: unknown = this.localPolicyFor(scopeKind, scopeId).policy?.allowedTools;
      if (saved === undefined) return undefined;
      if (!Array.isArray(saved) || saved.some((name) => typeof name !== 'string')) throw new TypeError(INVALID_OWN_LIST);
      return [...saved];
    },
    /**
     * The first stored list on this scope's chain (upper layers, then the scope itself) that the
     * backend refuses to compile. Every Turn on that chain fails until the record is reset, so the
     * settings page reports it and blocks tool-list edits instead of showing an empty list.
     */
    toolListErrorFor(scopeKind: ToolPolicyScopeKind, scopeId?: string): ToolListError | undefined {
      const own = { scopeKind, scopeId: scopeIdFor(scopeKind, scopeId) };
      for (const scope of [...this.upperScopesFor(scopeKind, scopeId), own]) {
        const layer = this.layerFor(scope);
        if (!layer) continue;
        try {
          resolveToolPolicyLayers([layer], []);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (scope === own) {
            const reset = scopeKind === 'global' ? '「继承默认」' : '「恢复继承」';
            return { ...scope, own: true, text: `此范围保存的工具列表无效：${detail}使用它的对话都无法开始。重置前不能在这里修改工具设置，请在此范围的工具设置里用${reset}重置工具列表。` };
          }
          const label = this.scopeLabel(scope);
          return { ...scope, own: false, text: `${label}保存的工具列表无效：${detail}此范围的对话都无法开始。重置前不能在这里修改工具开关，请到${label}的工具设置里重置。` };
        }
      }
      return undefined;
    },
    /** How the settings page names a scope in notes. */
    scopeLabel(scope: ScopeRef): string {
      const clientState = useClientStateStore();
      const id = scopeIdFor(scope.scopeKind, scope.scopeId);
      switch (scope.scopeKind) {
        case 'global': return '全局';
        case 'agent': return `Agent「${clientState.agents.find((agent) => agent.id === id)?.name ?? id}」`;
        case 'workflow': return `工作流「${clientState.workflows.find((workflow) => workflow.id === id)?.name ?? id}」`;
        case 'conversation': return '当前对话';
        case 'run': return '本次运行';
      }
    },
    /** The built-in list an Agent or workflow narrows to while its scope saves no list. */
    builtinPolicyFor(scopeKind: ToolPolicyScopeKind, scopeId?: string): BuiltinToolPolicyRecord | undefined {
      if (scopeKind !== 'agent' && scopeKind !== 'workflow') return undefined;
      const id = scopeIdFor(scopeKind, scopeId);
      return useClientStateStore().builtinToolPolicies.find((record) => record.scopeKind === scopeKind && record.scopeId === id);
    },
    /** One settings layer exactly as the backend compiles it (see `toolPolicyScopeLayer`). */
    layerFor(scope: ScopeRef): ToolPolicyLayer | undefined {
      const saved = this.localPolicyFor(scope.scopeKind, scope.scopeId).policy;
      const builtin = this.builtinPolicyFor(scope.scopeKind, scope.scopeId);
      return toolPolicyScopeLayer(scope.scopeKind, saved, builtin);
    },
    /** Upper layers of a scope, low to high: a Conversation also inherits its Agent and workflow. */
    upperScopesFor(scopeKind: ToolPolicyScopeKind, scopeId?: string): ScopeRef[] {
      if (scopeKind === 'global') return [];
      const upper: ScopeRef[] = [{ scopeKind: 'global' }];
      const conversationId = scopeKind === 'conversation' ? scopeIdFor(scopeKind, scopeId) : undefined;
      if (conversationId) {
        const agentId = agentIdForConversation(conversationId);
        if (agentId) upper.push({ scopeKind: 'agent', scopeId: agentId });
        const workflowId = useWorkflowStore().activeWorkflowIdForConversation(conversationId);
        if (workflowId && workflowId !== DEFAULT_WORKFLOW_OPTION_ID) upper.push({ scopeKind: 'workflow', scopeId: workflowId });
      }
      return upper;
    },
    /**
     * The backend's resolution of these layers. A stored list the backend refuses to compile shows
     * no tool enabled rather than breaking the settings view; `toolListErrorFor` reports it.
     */
    resolveScopes(scopes: readonly ScopeRef[]): ReturnType<typeof resolveToolPolicyLayers> {
      const clientState = useClientStateStore();
      const layers = scopes.flatMap((scope) => {
        const layer = this.layerFor(scope);
        return layer ? [layer] : [];
      });
      try {
        return resolveToolPolicyLayers(layers, defaultToolNames(clientState.toolDefinitions));
      } catch {
        return { id: null, allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} };
      }
    },
    effectivePolicyFor(scopeKind: ToolPolicyScopeKind, scopeId?: string): EffectiveToolPolicyResolution {
      const local = this.localPolicyFor(scopeKind, scopeId);
      const globalLayer = this.layerFor({ scopeKind: 'global' });
      const resolved = this.resolveScopes([...this.upperScopesFor(scopeKind, scopeId), { scopeKind, scopeId }]);
      const globalName = this.localPolicyFor('global').policy?.name ?? defaultPolicyName('global');
      return {
        policy: {
          id: resolved.id ?? globalLayer?.policy.id ?? policyIdForScope('global'),
          name: local.policy?.name ?? globalName,
          allowedTools: resolved.allowedTools,
          preset: resolved.preset,
          toolConfigs: resolved.toolConfigs,
          sourceConfigs: resolved.sourceConfigs
        },
        ...(local.link ? { link: local.link } : {}),
        ...(!local.policy ? { inheritedFrom: 'global' as const } : {})
      };
    },
    /**
     * What a tool-list edit at this scope starts from. A saved list is kept as it is, including
     * entries an upper layer blocks for now. A scope without a list starts from what the backend
     * allows there today, so creating the first list removes only what the user turns off.
     *
     * Global and a workflow bound every Agent, so they also keep the tools each Agent gets there
     * from the default tool set or a built-in Agent list: transfer and switch_work_environment on
     * the main Agent. Agents without a list of their own gain those two as a result (both stay
     * behind the work-environment policy, which is off by default). Nothing else comes from other
     * Agents: the tools a user ticked on them stay theirs. MCP tools never join a list; their source
     * settings alone admit them.
     */
    listSeedFor(scopeKind: ToolPolicyScopeKind, scopeId?: string): string[] {
      const listError = this.toolListErrorFor(scopeKind, scopeId);
      if (listError) throw new TypeError(listError.text);
      const saved = this.ownListFor(scopeKind, scopeId);
      if (saved) return saved;
      const names = new Set(this.effectivePolicyFor(scopeKind, scopeId).policy.allowedTools);
      if (scopeKind === 'global' || scopeKind === 'workflow') {
        const clientState = useClientStateStore();
        const builtinAgentLists = clientState.builtinToolPolicies.filter((record) => record.scopeKind === 'agent');
        const builtinToolNames = new Set(clientState.toolDefinitions.filter((tool) => tool.source?.kind !== 'mcp').map((tool) => tool.name));
        const carried = new Set([...defaultToolNames(clientState.toolDefinitions), ...builtinAgentLists.flatMap((record) => record.allowedTools)]);
        const agentIds = uniqueNames([
          ...builtinAgentLists.map((record) => record.scopeId),
          ...clientState.toolPolicyScopeLinks
            .filter((link) => link.role === 'active' && link.scopeKind === 'agent')
            .map((link) => link.scopeId?.trim() ?? '')
        ]);
        const workflow: ScopeRef[] = scopeKind === 'workflow' ? [{ scopeKind, scopeId }] : [];
        for (const agentId of agentIds) {
          for (const name of this.resolveScopes([{ scopeKind: 'global' }, { scopeKind: 'agent', scopeId: agentId }, ...workflow]).allowedTools) {
            if (builtinToolNames.has(name) && carried.has(name)) names.add(name);
          }
        }
      }
      return [...names];
    },
    /** The tools the first list saved at this scope adds beyond what the scope shows today. */
    listSeedExtrasFor(scopeKind: ToolPolicyScopeKind, scopeId?: string): string[] {
      if (this.localPolicyFor(scopeKind, scopeId).policy?.allowedTools !== undefined || this.toolListErrorFor(scopeKind, scopeId)) return [];
      const shown = new Set(this.effectivePolicyFor(scopeKind, scopeId).policy.allowedTools);
      return this.listSeedFor(scopeKind, scopeId).filter((name) => !shown.has(name)).sort();
    },
    /** What this scope inherits before its own record applies; global inherits only tool defaults. */
    inheritedPolicyFor(scopeKind: ToolPolicyScopeKind, scopeId?: string): ReturnType<typeof resolveToolPolicyLayers> {
      return this.resolveScopes(this.upperScopesFor(scopeKind, scopeId));
    },
    /** The value one run_agent-style config key inherits here, and the nearest upper layer that set it. */
    inheritedToolConfigValue(scopeKind: ToolPolicyScopeKind, scopeId: string | undefined, toolName: string, key: string): { value: ToolConfigValue; from: ToolPolicyScopeKind } | undefined {
      for (const scope of [...this.upperScopesFor(scopeKind, scopeId)].reverse()) {
        const value = this.layerFor(scope)?.policy.toolConfigs?.[toolName]?.config?.[key];
        if (value !== undefined) return { value: value as ToolConfigValue, from: scope.scopeKind };
      }
      return undefined;
    },
    /**
     * The upper layer that turns one MCP source off for this scope (an all-sources deny counts),
     * or undefined. Source denies are monotone, so enabling the source here would never apply.
     */
    mcpSourceBlockedAbove(scopeKind: ToolPolicyScopeKind, scopeId: string | undefined, sourceId: string): ScopeRef | undefined {
      const upper = this.upperScopesFor(scopeKind, scopeId);
      for (let count = 1; count <= upper.length; count += 1) {
        if (mcpSourceConfigFor(this.resolveScopes(upper.slice(0, count)).sourceConfigs, sourceId)?.enabled === false) return upper[count - 1];
      }
      return undefined;
    },
    /** Whether an upper layer keeps one MCP tool off here: its source is off above or the tool is disabled above. */
    mcpToolBlockedAbove(scopeKind: ToolPolicyScopeKind, scopeId: string | undefined, tool: ToolDefinitionRecord): boolean {
      const identity = mcpToolIdentity(tool);
      if (!identity) return tool.source?.kind === 'mcp';
      if (this.mcpSourceBlockedAbove(scopeKind, scopeId, identity.sourceId)) return true;
      return (mcpSourceConfigFor(this.inheritedPolicyFor(scopeKind, scopeId).sourceConfigs, identity.sourceId)?.disabledTools ?? []).includes(identity.toolName);
    },
    /**
     * The built-in read-only Agents and workflows above this scope whose all-sources deny is in the
     * inherited source settings: only their own scope can opt an MCP source in for this scope.
     */
    mcpDenyingBuiltinsAbove(scopeKind: ToolPolicyScopeKind, scopeId?: string): ScopeRef[] {
      if (this.inheritedPolicyFor(scopeKind, scopeId).sourceConfigs[TOOL_POLICY_ALL_MCP_SOURCES]?.enabled !== false) return [];
      return this.upperScopesFor(scopeKind, scopeId)
        .filter((scope) => !!this.builtinPolicyFor(scope.scopeKind, scope.scopeId)?.sourceConfigs?.[TOOL_POLICY_ALL_MCP_SOURCES]);
    },
    /**
     * Turns exactly one MCP tool on or off at this scope through its source settings, never through
     * a tool list: the source's other tools keep what they show now. The scope's entry for the
     * source is written out so that it no longer depends on the list, and tools an upper layer
     * already disables are left to that layer. A tool an upper layer keeps off is not changed.
     */
    setMcpToolEnabledForScope(scopeKind: ToolPolicyScopeKind, scopeId: string | undefined, tool: ToolDefinitionRecord, enabled: boolean): void {
      if (scopeKind !== 'global' && !scopeId?.trim()) return;
      const identity = mcpToolIdentity(tool);
      if (!identity) return;
      const { sourceId } = identity;
      const listError = this.toolListErrorFor(scopeKind, scopeId);
      if (listError) throw new TypeError(listError.text);
      if (enabled && this.mcpToolBlockedAbove(scopeKind, scopeId, tool)) return;
      const local = this.localPolicyFor(scopeKind, scopeId).policy;
      const ownList = this.ownListFor(scopeKind, scopeId);
      const effective = this.effectivePolicyFor(scopeKind, scopeId).policy;
      const inheritedDisabled = mcpSourceConfigFor(this.inheritedPolicyFor(scopeKind, scopeId).sourceConfigs, sourceId)?.disabledTools ?? [];
      const sourceTools = this.toolDefinitions.flatMap((candidate) => {
        const candidateIdentity = mcpToolIdentity(candidate);
        return candidateIdentity?.sourceId === sourceId ? [{ candidate, name: candidateIdentity.toolName }] : [];
      });
      const on = new Set(sourceTools.filter(({ candidate }) => toolAllowedByPolicy(effective, candidate)).map(({ name }) => name));
      if (enabled) on.add(identity.toolName);
      else on.delete(identity.toolName);
      const disabledTools = sourceTools.map(({ name }) => name).filter((name) => !on.has(name) && !inheritedDisabled.includes(name));
      const sourceConfigs = cloneSourceConfigs(local?.sourceConfigs) ?? {};
      sourceConfigs[sourceId] = { enabled: true, ...(disabledTools.length > 0 ? { disabledTools } : {}) };
      this.setPolicyForScope(scopeKind, scopeId, ownList, local?.name, cloneToolConfigs(local?.toolConfigs), sourceConfigs);
    },
    /** A child task's conversation: cross-conversation tools are never offered there. */
    isChildConversation(conversationId: string | undefined): boolean {
      const id = conversationId?.trim();
      if (!id) return false;
      return Object.values(useReliableKernelClientFeedStore().records.ChildExecution ?? {})
        .some((child) => plainText(child.child_conversation_id) === id);
    },
    /**
     * The backend's own rule over this scope's effective settings: the switch grants the tools to
     * top-level conversations, and send, create and fork also need run_agent in the effective list.
     */
    crossConversationStateFor(scopeKind: ToolPolicyScopeKind, scopeId?: string): CrossConversationState {
      const policy = this.effectivePolicyFor(scopeKind, scopeId).policy;
      const enabled = crossConversationSwitchOn(policy.toolConfigs);
      const known = new Set(useClientStateStore().toolDefinitions.map((tool) => tool.name));
      const child = scopeKind === 'conversation' && this.isChildConversation(scopeId);
      return {
        enabled,
        sendTools: policy.allowedTools.includes(SUB_AGENT_TOOL_NAME),
        offered: enabled && !child
          ? CROSS_CONVERSATION_TOOL_NAMES.filter((name) => known.has(name) && crossConversationToolPermitted(policy.allowedTools, name))
          : []
      };
    },
    /**
     * Saves one scope's record. `allowedTools` undefined saves a record without a list. A list never
     * holds the cross-conversation tools (the switch grants them) or MCP tools (their source
     * settings alone admit them); the backend ignores those names in lists, so a save drops them.
     */
    setPolicyForScope(
      scopeKind: ToolPolicyScopeKind,
      scopeId: string | undefined,
      allowedTools: string[] | undefined,
      name?: string,
      toolConfigs?: Record<string, ToolPolicyToolConfigRecord>,
      sourceConfigs?: Record<string, ToolPolicySourceConfigRecord>,
      preset?: ToolPolicyPresetKind
    ): void {
      const clientState = useClientStateStore();
      const validNames = new Set(clientState.toolDefinitions.filter((tool) => tool.source?.kind !== 'mcp').map((tool) => tool.name));
      const sanitized = allowedTools
        ?.map((tool) => tool.trim())
        .filter((tool, index, list) => !!tool && validNames.has(tool) && !isSwitchGrantedTool(tool) && list.indexOf(tool) === index);

      const plainToolConfigs = cloneToolConfigs(toolConfigs);
      const plainSourceConfigs = cloneSourceConfigs(sourceConfigs);
      this.applyOptimisticPolicyScopeSet(scopeKind, scopeId, sanitized, name, plainToolConfigs, plainSourceConfigs, preset);

      const payload: ToolPolicyScopeSetPayload = {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {}),
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(sanitized ? { allowedTools: sanitized } : {}),
        ...(preset !== undefined ? { preset } : {}),
        ...(plainToolConfigs !== undefined ? { toolConfigs: plainToolConfigs } : {}),
        ...(plainSourceConfigs !== undefined ? { sourceConfigs: plainSourceConfigs } : {})
      };
      bridge.request(BridgeMessageType.ToolPolicyScopeSet, payload);
    },
    clearPolicyScope(scopeKind: ToolPolicyScopeKind, scopeId?: string): void {
      if (scopeKind === 'global') return;
      this.dropLocalPolicy(scopeKind, scopeId);
    },
    dropLocalPolicy(scopeKind: ToolPolicyScopeKind, scopeId?: string): void {
      const clientState = useClientStateStore();
      clientState.toolPolicyScopeLinks = clientState.toolPolicyScopeLinks.filter((link) => !scopeLinkMatches(link, scopeKind, scopeId));
      bridge.request(BridgeMessageType.ToolPolicyScopeClear, {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {})
      });
    },
    /** A preset change keeps this scope's own list and configs; it never copies inherited ones down. */
    setPolicyPresetForScope(scopeKind: ToolPolicyScopeKind, scopeId: string | undefined, preset: ToolPolicyPresetKind): void {
      const local = this.localPolicyFor(scopeKind, scopeId).policy;
      this.setPolicyForScope(
        scopeKind,
        scopeId,
        this.ownListFor(scopeKind, scopeId),
        local?.name,
        cloneToolConfigs(local?.toolConfigs) ?? {},
        cloneSourceConfigs(local?.sourceConfigs) ?? {},
        preset
      );
    },
    applyOptimisticPolicyScopeSet(
      scopeKind: ToolPolicyScopeKind,
      scopeId: string | undefined,
      allowedTools: string[] | undefined,
      name?: string,
      toolConfigs?: Record<string, ToolPolicyToolConfigRecord>,
      sourceConfigs?: Record<string, ToolPolicySourceConfigRecord>,
      preset?: ToolPolicyPresetKind
    ): void {
      const clientState = useClientStateStore();
      const normalizedScopeId = scopeIdFor(scopeKind, scopeId);
      const existingLink = latestLink(clientState.toolPolicyScopeLinks.filter((candidate) => scopeLinkMatches(candidate, scopeKind, normalizedScopeId)));
      const existingPolicy = clientState.toolPolicies.find((policy) => policy.id === existingLink?.toolPolicyId);
      const policyId = existingLink?.toolPolicyId ?? policyIdForScope(scopeKind, normalizedScopeId);
      const now = Date.now();
      const nextPolicy: ToolPolicyRecord = {
        id: policyId,
        name: name?.trim() || existingPolicy?.name || defaultPolicyName(scopeKind),
        ...(allowedTools ? { allowedTools: [...allowedTools] } : {}),
        ...(preset !== undefined || existingPolicy?.preset !== undefined ? { preset: preset ?? existingPolicy?.preset } : {}),
        ...(toolConfigs !== undefined
          ? { toolConfigs: cloneToolConfigs(toolConfigs) ?? {} }
          : existingPolicy?.toolConfigs
            ? { toolConfigs: cloneToolConfigs(existingPolicy.toolConfigs) ?? {} }
            : {}),
        ...(sourceConfigs !== undefined
          ? { sourceConfigs: cloneSourceConfigs(sourceConfigs) ?? {} }
          : existingPolicy?.sourceConfigs
            ? { sourceConfigs: cloneSourceConfigs(existingPolicy.sourceConfigs) ?? {} }
            : {})
      };
      upsertById(clientState.toolPolicies, nextPolicy);

      const nextLink: ToolPolicyScopeLinkRecord = {
        id: existingLink?.id ?? linkIdForScope(scopeKind, normalizedScopeId),
        scopeKind,
        ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}),
        toolPolicyId: policyId,
        role: 'active',
        createdAt: existingLink?.createdAt ?? now,
        updatedAt: now
      };
      upsertById(clientState.toolPolicyScopeLinks, nextLink);
    }
  }
});
